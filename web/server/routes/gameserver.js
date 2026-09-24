'use strict'

// `/api/gs/*` — THE PULL PROTOCOL. The game boxes poll the site; the site never connects out.
//
// This is the real version of `infra/host-agent/mock-site/site.js`, and the contract is that
// file plus `infra/host-agent/lib/siteclient.js`. A host agent pointed at this server with
// `--site http://127.0.0.1:3200 --secret devkey-a --box box-a` must work with no change on
// its side, so every route name, header, query parameter and response key below is theirs,
// not ours:
//
//   GET  /api/gs/assignment[?v=2]        what should this box be running?  (nonce-cached;
//                                        v=2 lists every live lease, see lib/assignments.js)
//   GET  /api/gs/keys                    the site's invite-token public key
//   POST /api/gs/status                  booting / ready / live / idle heartbeat
//   POST /api/gs/result                  the summary + where the replay went
//   GET  /api/gs/chat-feed?since=&wait=  long-poll drain of the global chat ring
//   POST /api/gs/chat                    a player said something in one of our games
//   POST /api/gs/event                   something HAPPENED in one of our games, and the
//                                        site turns it into a system line in that same
//                                        channel (ours, not the mock's — lib/chatSystem.js)
//
// Two routes are OURS, added because the site needs something the mock did not have:
//
//   POST /api/gs/key                     the box offers its replay-signing PUBLIC key for
//                                        pinning. See lib/boxes.js for why this exists:
//                                        a signed replay proves integrity, not authorship.
//   POST /api/gs/spool                   a batch of results a box held while we were down
//                                        (the coordinator's Q-host-2 answer: spool and
//                                        retry). Same body as /result, in an array.
//   GET  /api/gs/map-files/:bsp          a map's files with size and sha256 - the public
//                                        /api/maps/<bsp>/files answer, here because the
//                                        closed-beta gate lets a box reach /api/gs only.
//                                        The box's map cache pulls them from the bucket.
//   GET  /api/gs/popular-maps            the most-played maps lately (read-only), for the
//                                        box's idle-time prefetch.
//
// The site ALSO reads `pub`/`key_id` out of the status and result bodies, because the host
// agent already has them in hand and sending them costs it one line. Until it does, a box
// pins on its first POST /api/gs/key and everything else works unpinned-but-flagged.
//
// AUTH is the per-box shared secret in `x-match-secret`, timing-safe compared. There is no
// other authentication on these routes and there must not be: a box behind NAT with no
// inbound rules and no reachable RCON is the whole point of the shape.

const express = require('express')
const boxes = require('../lib/boxes')
const assignments = require('../lib/assignments')
const results = require('../lib/results')
const chat = require('../lib/chatNetwork')
const chatSystem = require('../lib/chatSystem')
const presence = require('../lib/presence')
const live = require('../lib/live')
const siteKeys = require('../lib/siteKeys')
const seats = require('../lib/seats')
const mapfiles = require('../lib/mapfiles')
const { db, now } = require('../db/database')

function router() {
  const r = express.Router()
  // A result post carries the whole referee summary. 2 MB is generous for JSON that is
  // normally ~20 KB and small enough that a broken box cannot exhaust us.
  r.use(express.json({ limit: '2mb' }))

  // Every /api/gs route authenticates the same way, so it happens once.
  r.use((req, res, next) => {
    const box = boxes.authenticate(req)
    if (!box) return res.status(401).json({ error: 'bad or missing x-match-secret' })
    req.box = box
    next()
  })

  // ---- assignment ------------------------------------------------------------------
  r.get('/assignment', (req, res) => {
    boxes.touch(req.box)
    // `?v=2`: every live lease on the box (lib/assignments.js forBox). No `v` is an old
    // host agent, which gets the newest lease alone and a capacity of one.
    const v = Number(req.query.v || 1) || 1
    assignments.notePoll(req.box, v)
    res.json(assignments.forBox(req.box, { v }))
  })

  // ---- the box's map cache (infra/host-agent/lib/mapcache.js) ------------------------
  r.get('/map-files/:bsp', (req, res) => {
    res.json(mapfiles.forMap(String(req.params.bsp)))
  })
  r.get('/popular-maps', (req, res) => {
    res.json({ ok: true, days: Number(req.query.days) || 30, maps: assignments.popular({ days: req.query.days, limit: req.query.limit }) })
  })

  // ---- keys ------------------------------------------------------------------------
  // The box asks for the site's INVITE-TOKEN public key so it can verify joins. It holds
  // only the public half, which is what makes a stolen box unable to mint a join.
  r.get('/keys', (req, res) => {
    const k = siteKeys.site()
    res.json({ invite_pub: k.pub, key_id: k.keyId, alg: 'ed25519' })
  })

  // ---- the box's own replay key ------------------------------------------------------
  r.post('/key', (req, res) => {
    const { pub, key_id: keyId } = req.body || {}
    if (!pub && !keyId) return res.status(400).json({ error: 'send pub and key_id' })
    const r2 = boxes.offerKey(req.box, pub || null, keyId || null)
    res.json({ ok: true, ...r2 })
  })

  // ---- live frames ---------------------------------------------------------------
  // The web live view (99 §4.4). One POST per game per frame, or a batch of them, at
  // whatever rate the box likes — the site downsamples and never stores them (lib/live.js
  // says why). The body is the referee's own `state()`, unreshaped.
  //
  //   { instances: [ { instance, match_id, state } ] }        the batch form
  //   { instance, match_id, state }                           one game
  r.post('/live', (req, res) => {
    const body = req.body || {}
    const items = Array.isArray(body.instances) ? body.instances : [body]
    let taken = 0
    const quit = {}
    const cont = {}
    for (const it of items.slice(0, 16)) {
      // Who is connected to which match (lib/seats.js): what keeps the launcher from
      // relaunching a player who is already in, or who has just left, a game.
      try { if (it && it.match_id) seats.observe(it.match_id, it.state) } catch (e) { console.warn('[gs] seats:', e.message) }
      // [reconnect] and who quit it on purpose, so the box never holds the game for a quit
      // (host lib/referee.js markQuit). Only when there is somebody to name.
      try {
        const q = it && it.match_id ? seats.quittersFor(it.match_id) : []
        if (q.length) quit[String(it.match_id)] = q
      } catch (e) { console.warn('[gs] quitters:', e.message) }
      if (live.push(req.box.name, it)) taken++
      // The party host pressed Continue without (lib/seats.js continueWithout): handed over once.
      try {
        const c = it && it.match_id ? seats.takeContinue(it.match_id) : null
        if (c) cont[String(it.match_id)] = c
      } catch (e) { console.warn('[gs] continue:', e.message) }
    }
    res.json({ ok: true, taken, of: items.length, min_frame_ms: live.MIN_FRAME_MS, ...(Object.keys(quit).length ? { quit } : {}), ...(Object.keys(cont).length ? { continue: cont } : {}) })
  })

  // ---- status ------------------------------------------------------------------------
  r.post('/status', (req, res) => {
    const body = req.body || {}
    boxes.recordStatus(req.box, body)
    // If the heartbeat carries the box's key, pin it here — one fewer request for the box
    // to make, and the earliest possible moment we can know it.
    let key = null
    if (body.pub || body.key_id) key = boxes.offerKey(req.box, body.pub || null, body.key_id || null)
    if (body.state && body.match_id) assignments.ack(req.box, body.state, body.match_id, body.error || null, { rule: typeof body.rule === 'string' ? body.rule.slice(0, 32) : null })

    // Presence: the box roster beats the lobby seat (11 §9). Everything the box says is in
    // a game is in a game, whatever the site's parties table thinks.
    try { markRoster(req.box, body) } catch (e) { console.warn('[gs] presence:', e.message) }
    // A lease everybody left ten minutes ago (and nobody resumed) is over (lib/seats.js).
    try { seats.sweep() } catch (e) { console.warn('[gs] seats sweep:', e.message) }

    res.json({
      ok: true,
      // Told on every heartbeat rather than only on the key post, so a box whose key stopped
      // matching finds out within seconds instead of at the end of a game.
      key_pinned: key ? key.pinned : !!(req.box.replay_key_id && !req.box.pending_key_id),
      pinned_key_id: req.box.replay_key_id || null,
      ...(key && key.changed ? { warning: 'this box presented a different replay key; results are stored unpinned until an admin confirms it' } : {}),
    })
  })

  // ---- result --------------------------------------------------------------------
  r.post('/result', (req, res) => {
    const out = safeIngest(req.body, req.box)
    res.status(out.ok ? 200 : 400).json(out)
  })

  // A spool drain: everything the box held while the site was unreachable, in one POST.
  // The box may delete its spool for every entry we return `ok` for.
  r.post('/spool', (req, res) => {
    const items = Array.isArray(req.body) ? req.body : (req.body && req.body.results) || []
    const out = items.slice(0, 200).map((item) => {
      const one = safeIngest(item, req.box)
      return { match_id: (item && item.summary && item.summary.match_id) || null, ok: !!one.ok, error: one.error || null }
    })
    res.json({ ok: true, accepted: out.filter((x) => x.ok).length, results: out })
  })

  // ---- cross-server chat ----------------------------------------------------------
  // The long-poll drain. `since` is the box's cursor; `wait` is how long it will hold the
  // connection open waiting for something new. A box never receives its own lines back.
  r.get('/chat-feed', async (req, res) => {
    const since = Number(req.query.since || 0)
    const wait = Math.min(25, Number(req.query.wait || 0))
    // `since=0` means "I have just started — tell me where the ring is now". It returns the
    // cursor and NO events, deliberately differing from mock-site/site.js, which returns the
    // whole ring: the host agent injects everything this route hands it straight into every
    // live game, so replaying an hour of other people's chat at a player who just connected
    // is the wrong answer. Backlog belongs on the website, which reads the ring directly.
    if (!since) return res.json({ ok: true, enabled: true, latest: chat.latest(), events: [] })
    const pending = () => chat.since(since, { excludeOrigin: req.box.name })
    const first = pending()
    if (first.length || !wait || !since) {
      return res.json({ ok: true, enabled: true, latest: chat.latest(), events: first })
    }
    let done = false
    const finish = () => { if (done) return; done = true; res.json({ ok: true, enabled: true, latest: chat.latest(), events: pending() }) }
    req.on('close', () => { done = true })
    await chat.wait(wait, req.box.name)
    finish()
  })

  // ---- system lines ---------------------------------------------------------------
  // The box sends the FACT; the site writes the sentence. It has to be this way round:
  // the handle a line carries is the site's user for a `verified` identity and the
  // in-game name otherwise, and only the site holds the user table. It also means the
  // worst a broken box can put in the global channel is a wrong name, rather than a
  // sentence of its choosing. Dedupe and the per-match rate limit are in chatSystem.
  r.post('/event', (req, res) => {
    const line = chatSystem.record(req.box.name, req.body || {})
    res.json({ ok: true, line: line || null, latest: chat.latest() })
  })

  r.post('/chat', (req, res) => {
    const b = req.body || {}
    if (!b.text) return res.status(400).json({ error: 'no text' })
    chat.push({
      from: b.from || 'player', text: b.text, steamId: b.steamid || null,
      origin: req.box.name, mapKey: b.map || null, instance: b.instance || null,
    })
    res.json({ ok: true, latest: chat.latest() })
  })

  // ---- telemetry (docs/kickstart/telemetry.md) -------------------------------------
  // The box's log bundle: an instance's logs when it ends, the daily journal. The raw
  // .tar.gz body (express.json above ignores application/gzip), the same ingest as a
  // launcher's, filed under the box's name. The box holds no bucket keys; the site does.
  r.post('/telemetry', async (req, res) => {
    try {
      const out = await require('../lib/telemetry/ingest').receive(req, { who: { box: req.box.name }, source: 'box' })
      if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v)
      res.status(out.status).json(out.body)
    } catch (e) {
      console.error(`[gs] telemetry from ${req.box.name} failed: ${e.stack || e.message}`)
      if (!res.headersSent) res.status(500).json({ error: 'the site could not store that bundle; keep it and try again' })
    }
  })

  return r
}

function safeIngest(body, box) {
  try {
    const payload = { ...(body || {}), box: (body && body.box) || box.name }
    if (payload.replay && !payload.replay.key_id && payload.key_id) payload.replay.key_id = payload.key_id
    // `requireVerifiedIdentity` is ON for every box post (referee lane, 2026-09-22): a
    // `players[]` row that is not `identity:"verified"` is attendance and is awarded
    // nothing. See lib/results.js, the IDENTITY block, for why `claimed` is the dangerous
    // one and why an absent field fails closed.
    const out = results.ingest(payload, { requireVerifiedIdentity: true })
    if (out.ok) {
      const s = body.summary || {}
      console.log(`[gs] result ${s.map} round ${s.rounds} finish=${(s.finish && s.finish.kind) || 'none'} ` +
        `from ${box.name}${out.repeat ? ' (repeat)' : ''}${out.awarded && out.awarded.length ? ` — ${out.awarded.length} badge(s)` : ''}`)
      // The game is over, so nobody is in it any more and there is nothing live to watch.
      // Presence is cleared for EVERY slot that named an account, verified or not: they
      // are not in the game any more whatever their row was worth, and leaving somebody
      // marked in-game is a bug about where they are, not about what they earned.
      for (const p of s.players || []) if (p.steamid) presence.clearGame(p.steamid)
      if (out.unverified && out.unverified.length) {
        console.log(`[gs]   ${out.unverified.length} player row(s) not verified — attendance only: ` +
          out.unverified.map((u) => `${u.name || 'slot ' + u.slot}=${u.identity}`).join(', '))
      }
      live.drop(s.match_id)
    }
    return out
  } catch (e) {
    // Never 500 a box: it will retry forever and the log fills with the same error. Record
    // it where an admin will see it and tell the box the truth.
    console.error('[gs] result ingest failed:', e.message)
    db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('result.failed', ?, ?, ?)")
      .run(box.name, JSON.stringify({ error: e.message, match_id: body && body.summary && body.summary.match_id }), now())
    return { ok: false, error: 'the site could not store that result; it has been logged' }
  }
}

// A status heartbeat that carries `instances[].game` (the referee's `state()`) is ALSO a
// live frame. This is deliberate: it means the host agent can light up the live view by
// changing one line — `reportStatus()` sending `this.state().instances` instead of
// `this.instances.list().map(i => i.info())` — without adding a call to /api/gs/live at
// all. Both paths land in the same store.
function markRoster(box, body) {
  for (const inst of body.instances || []) {
    const g = inst.game
    if (!g || !g.players) continue
    const matchId = g.match || inst.match_id
    for (const p of g.players) {
      if (!p.steamid || !p.connected) continue
      presence.markInGame(p.steamid, { matchId, mapKey: g.map, box: box.name })
    }
    if (matchId) { seats.observe(matchId, g); live.push(box.name, { instance: inst.id || g.instance, match_id: matchId, state: g }) }
  }
}

module.exports = { router }
