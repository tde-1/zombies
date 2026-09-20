'use strict'

// ENW Zombies — the website. Express + better-sqlite3 + socket.io + a React/Vite client,
// the same stack and the same shapes as ENW Movement (`CSGO-Matchmaker/server/index.js`).
//
//   npm install && npm run seed -- --demo && npm run dev     # http://127.0.0.1:3200
//
// One process serves three things:
//   /api/gs/*        the pull protocol the game boxes speak (routes/gameserver.js)
//   /api/*           the site's own API
//   everything else  the built client, or a plain page saying how to build it
//
// Bound to 127.0.0.1 by default. Nothing here reaches the internet: no ENW call unless
// ZM_ENW_BASE is set, no Steam call unless STEAM_API_KEY is set, no cloud anything.

const path = require('path')
const fs = require('fs')
const http = require('http')
const express = require('express')
const session = require('express-session')
const { Server: IO } = require('socket.io')

const { db } = require('./db/database')
const authRoutes = require('./routes/auth')
const { attach } = require('./middleware/auth')
const presence = require('./lib/presence')
const chat = require('./lib/chatNetwork')
const live = require('./lib/live')
const { SqliteStore } = require('./lib/sessionStore')
const achievements = require('./lib/achievements')
const mapRecords = require('./lib/mapRecords')
const users = require('./lib/users')

const PORT = Number(process.env.PORT || process.env.ZM_PORT || 3200)
const HOST = process.env.ZM_HOST || '127.0.0.1'
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist')

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)

// The session secret is generated and persisted on first boot when nothing is configured.
// A random-per-restart secret would log everybody out on every `node --watch` reload, which
// makes local work miserable; a hard-coded one in the repo would be worse.
const secret = (() => {
  if (process.env.ZM_SESSION_SECRET) return process.env.ZM_SESSION_SECRET
  const f = path.join(process.env.ZM_DATA_DIR || path.join(__dirname, '..', 'data'), 'session-secret')
  try { return fs.readFileSync(f, 'utf8') } catch { /* first boot */ }
  const s = require('crypto').randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, s)
  return s
})()

const sessionMw = session({
  name: 'zm.sid',
  secret,
  // Sessions live in SQLite, not in memory: the default MemoryStore signs everybody out on
  // every restart, which makes `node --watch` unusable and makes a redeploy look like an
  // outage. It also cannot work behind more than one process.
  store: new SqliteStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400_000, secure: process.env.NODE_ENV === 'production' },
})
// The closed-beta front door. Off unless ZM_SITE_PASSWORD is set; exempts /api/gs
// (game boxes carry their own secret and cannot type a password) and /healthz.
app.use(require('./middleware/gate').gate())
app.use(sessionMw)
app.use(express.json({ limit: '256kb' }))
app.use(attach)

// ---- routes -----------------------------------------------------------------------
// The pull protocol first and outside everything else: it has its own auth (the per-box
// shared secret), its own body limit, and no session.
app.use('/api/gs', require('./routes/gameserver').router())

app.use('/auth', authRoutes.router())
app.use('/api/me', require('./routes/me').router())
app.use('/api/maps', require('./routes/maps').router())
app.use('/api/players', require('./routes/players').router())
app.use('/api/launcher', require('./routes/launcher').router())
app.use('/api/admin', require('./routes/admin').router())
app.use('/api', require('./routes/site').router())

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    maps: require('./lib/maps').count(),
    games: db.prepare('SELECT COUNT(*) c FROM games').get().c,
    boxes: require('./lib/boxes').list().map((b) => ({ name: b.name, online: b.online, key_pinned: !!b.key.pinned })),
    auth: authRoutes.effectiveMode(),
    enw: require('./lib/enw').status(),
  })
})

// ---- the client -------------------------------------------------------------------
// The launcher's update feed: `latest.yml`, the installer and its blockmap, dropped in
// web/public/updates. It lives here so a launcher can self-update with no bucket and no
// release server; point ZM_UPDATE_FEED at object storage instead when there is one.
// No cache — an update nobody can see because a proxy held the old latest.yml is the
// failure mode this whole feature exists to avoid.
const UPDATES_DIR = path.join(__dirname, '..', 'public', 'updates')
app.use('/updates', express.static(UPDATES_DIR, {
  index: false,
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
}))

if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }))
  // Every non-API path is the React router's. A dead URL is the client's 404, not the
  // server's, so a shared link never silently lands on the home page.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next()
    res.sendFile(path.join(CLIENT_DIST, 'index.html'))
  })
} else {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next()
    res.status(200).type('html').send(`<!doctype html><meta charset="utf-8"><title>ENW Zombies</title>
<style>body{background:#11120e;color:#e4dfd1;font:15px/1.6 system-ui,sans-serif;padding:48px;max-width:640px;margin:0 auto}
code{background:#1a1c15;padding:2px 6px;border-radius:5px;color:#e4dfd1}h1{font-size:16px;letter-spacing:.08em;text-transform:uppercase;color:#9a9684}
a{color:#b0342c}</style>
<h1>ENW Zombies</h1>
<p>The API is up on this port. The client has not been built yet:</p>
<p><code>cd web &amp;&amp; npm run build</code></p>
<p>Or run the Vite dev server beside it: <code>npm run client</code> (port 5173, proxies /api here).</p>
<p><a href="/api/health">/api/health</a> &middot; <a href="/auth/mock">sign in (dev)</a></p>`)
  })
}

// ---- server + sockets ---------------------------------------------------------------
const server = http.createServer(app)
const io = new IO(server, { path: '/socket.io', cors: { origin: false } })

// Share the express session with socket.io so a socket knows who it is without a second
// auth path. Movement does the same; a separate socket token is one more thing to get wrong.
io.engine.use(sessionMw)

io.on('connection', (socket) => {
  const sid = socket.request.session && socket.request.session.steam_id
  if (sid) {
    presence.connected(sid, socket.id)
    socket.join(`user:${sid}`)
    io.emit('presence', presence.stats())
  }
  socket.on('heartbeat', () => { if (sid) presence.heartbeat(sid) })

  // The live view subscribes per game rather than receiving every frame of every game.
  // At 4 Hz with a handful of concurrent games the difference is the whole cost of the
  // feature, and the visibility check has to happen once at join rather than per frame.
  socket.on('watch', (matchId, ack) => {
    const id = String(matchId || '')
    if (!id) return
    const may = live.canWatch(id, sid)
    if (!may.ok) { if (typeof ack === 'function') ack({ ok: false, error: may.reason }); return }
    socket.join(`live:${id}`)
    const f = live.get(id)
    if (f) socket.emit('live', f)
    if (typeof ack === 'function') ack({ ok: true })
  })
  socket.on('unwatch', (matchId) => socket.leave(`live:${String(matchId || '')}`))
  socket.on('chat', (text) => {
    if (!sid || !text) return
    const u = users.byId(sid)
    if (!u) return
    chat.push({ from: users.pub(u).name, text: String(text), steamId: sid, origin: 'web' })
  })
  socket.on('disconnect', () => {
    if (!sid) return
    presence.disconnected(sid, socket.id)
    io.emit('presence', presence.stats())
  })
})

// The chat ring pushes to the browsers; the boxes drain it over the long poll.
chat.setEmitter((line) => io.emit('chat', line))
// A live frame goes only to the room watching that game.
live.setEmitter((matchId, frame) => io.to(`live:${matchId}`).emit('live', frame))

achievements.startJobs()
mapRecords.startJobs()

server.listen(PORT, HOST, () => {
  const b = require('./lib/boxes').list()
  console.log(`ENW Zombies on http://${HOST}:${PORT}`)
  console.log(`  sign-in     ${authRoutes.effectiveMode()}${authRoutes.effectiveMode() === 'mock' ? '  (http://' + HOST + ':' + PORT + '/auth/mock)' : ''}`)
  console.log(`  ENW link    ${require('./lib/enw').status().note}`)
  console.log(`  maps        ${require('./lib/maps').count()}`)
  console.log(`  invite key  ${require('./lib/siteKeys').site().keyId}`)
  console.log(`  boxes       ${b.length ? b.map((x) => `${x.name}${x.key.pinned ? ' (key ' + x.key.pinned + ')' : ' (no key pinned)'}`).join(', ') : 'none'}`)
  if (!fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) console.log('  client      not built — run `npm run build`')
})

module.exports = { app, server, io }
