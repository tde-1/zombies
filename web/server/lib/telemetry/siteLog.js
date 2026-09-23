'use strict'

// The site's own log and its own incidents (docs/kickstart/telemetry.md §8).
//
// Before this, the site's stdout went nowhere: keepalive.ps1 starts `node server/index.js`
// in a hidden window, so every console line was lost the moment it was printed. Now:
//
//   * every console.log/info/warn/error line is ALSO appended to
//     <data>/logs/site-<yyyy-mm-dd>.log (UTC day), buffered and flushed once a second;
//   * console.error, an uncaught exception, a 5xx answer, a refused Play (the lease was
//     not made) become incidents of kind `site`, coalesced per fingerprint for 6 h;
//   * the nightly job (jobs.js) bundles yesterday's file into the bucket.
//
// Cost: one string push per console line and one async append per second. Nothing on the
// request path except a `finish` listener that compares a status code.

const fs = require('node:fs')
const path = require('node:path')
const util = require('node:util')
const { DATA_DIR } = require('../../db/database')

const LOG_DIR = process.env.ZM_SITE_LOG_DIR || path.join(DATA_DIR, 'logs')
const RING = 400
const ring = []
let buf = []
let installed = false
let inRecord = false

const dayFile = (d = new Date()) => path.join(LOG_DIR, `site-${d.toISOString().slice(0, 10)}.log`)

function push (level, args) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${util.format(...args)}`
  ring.push(line)
  if (ring.length > RING) ring.splice(0, ring.length - RING)
  buf.push(line)
  return line
}

function flushSync () {
  if (!buf.length) return
  const out = buf.join('\n') + '\n'
  buf = []
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(dayFile(), out) } catch {}
}
function flush () {
  if (!buf.length) return
  const out = buf.join('\n') + '\n'
  buf = []
  fs.mkdir(LOG_DIR, { recursive: true }, () => fs.appendFile(dayFile(), out, () => {}))
}

// Numbers, ids and hex out of a message, so "lease m_1a2b failed" and "lease m_3c4d failed"
// are one incident with a count.
const fingerprintOf = (s) => String(s).replace(/\b(m_|l_)?[0-9a-f]{6,}\b/gi, '#').replace(/\d+/g, '#').slice(0, 300)

function record (reason, notes, extra = {}) {
  if (inRecord) return null
  inRecord = true
  try {
    return require('./incidents').recordSite({ reason, fingerprint: extra.fingerprint || `${reason}:${fingerprintOf(notes)}`, notes, lines: ring.slice(-120), route: extra.route || null })
  } catch (e) {
    // Never let the recorder take the site down; say so on the real stderr only.
    try { process.stderr.write(`[telemetry] could not record a site incident: ${e.message}\n`) } catch {}
    return null
  } finally { inRecord = false }
}

function install () {
  if (installed) return
  installed = true
  for (const [name, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const orig = console[name].bind(console)
    console[name] = (...args) => {
      orig(...args)
      try {
        const line = push(level, args)
        if (level === 'error' && !inRecord) record('site_error', line.slice(30))
      } catch {}
    }
  }
  const t = setInterval(flush, 1000)
  t.unref?.()
  // Observe, do not handle: Node's default (log and exit, then the keepalive restarts us)
  // is unchanged. The monitor runs before the exit, and everything it calls is synchronous.
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    try {
      push('fatal', [`${origin}: ${err && err.stack ? err.stack : err}`])
      record('uncaught', `${origin}: ${err && err.stack ? err.stack : err}`)
      flushSync()
    } catch {}
  })
  process.on('exit', flushSync)
}

const routeOf = (req) => {
  const p = (req.baseUrl || '') + (req.route && req.route.path ? req.route.path : req.path)
  return `${req.method} ${String(p).replace(/\/[0-9a-f]{16,}\b/gi, '/:id').replace(/\/\d+\b/g, '/:n').replace(/\/7656119\d{10}\b/g, '/:steamid')}`
}

// Express: 5xx answers, and a refused Play (POST /api/launcher/play that did not lease).
function middleware () {
  return (req, res, next) => {
    if (req.method === 'POST' && req.path === '/api/launcher/play') {
      // Keep the refusal's own words (the route answers { error } written for a player).
      const json = res.json.bind(res)
      res.json = (b) => { if (res.statusCode >= 400 && b && b.error) res.locals.enwError = String(b.error).slice(0, 300); return json(b) }
    }
    res.on('finish', () => {
      try {
        const s = res.statusCode
        if (s >= 500) record('site_5xx', `${routeOf(req)} answered ${s}${res.locals.enwError ? `: ${res.locals.enwError}` : ''}`, { route: routeOf(req), fingerprint: `5xx:${routeOf(req)}:${s}` })
        else if (s >= 400 && s !== 401 && req.method === 'POST' && req.originalUrl.split('?')[0] === '/api/launcher/play') {
          const who = req.me ? req.me.steam_id : 'signed out'
          push('warn', [`[play] refused ${s} for ${who}: ${res.locals.enwError || ''}`])
          record('lease_refused', `Play refused (${s}) for ${who}: ${res.locals.enwError || 'see the lines'}`, { route: 'POST /api/launcher/play', fingerprint: `play:${s}:${fingerprintOf(res.locals.enwError || '')}` })
        }
      } catch {}
    })
    next()
  }
}

// Express error handler (last in the chain): record it, answer 500 as JSON.
function errorHandler () {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const msg = `${routeOf(req)}: ${err && err.stack ? err.stack : err}`
    push('error', [msg])
    res.locals.enwError = String(err && err.message || err).slice(0, 300)
    if (res.headersSent) return
    res.status(err && err.status && err.status < 600 ? err.status : 500).json({ error: 'something went wrong on the site; it has been logged' })
  }
}

module.exports = { install, middleware, errorHandler, record, flushSync, dayFile, LOG_DIR, ring: () => ring.slice(), fingerprintOf }
