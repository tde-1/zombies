#!/usr/bin/env node
// Mock website — stands in for zombies.enw.gg while it does not exist.
//
// It exists to prove the SHAPE of the relationship, which is copied straight from ENW's
// CS:GO matchmaker (`server/routes/gameserver.js`, `/api/gs/*`):
//
//   THE GAME BOXES POLL THE SITE. THE SITE NEVER CONNECTS OUT.
//
// That one rule is why the CS fleet works behind NAT with no inbound firewall rules, no
// RCON reachable from the web box, and no push channel to go stale. Zombies copies it.
//
// Auth is the same too: a per-box shared secret in `x-match-secret`. Nothing here talks
// to, or holds any credential for, ENW/CS production.
//
//   node mock-site/site.js --port 8080
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeLog, parseArgs, id as makeId, canonical } from '../lib/util.js'
import * as keys from '../lib/keys.js'
import { issue } from '../lib/tokens.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const a = parseArgs(process.argv.slice(2))
const PORT = Number(a.port || process.env.ENW_SITE_PORT || 8080)
const log = makeLog('mock-site')

const SECRETS = new Map()      // match_key -> box name
for (const s of String(a.keys || process.env.ENW_SITE_KEYS || 'box-a:devkey-a,box-b:devkey-b').split(',')) {
  const [name, key] = s.split(':')
  SECRETS.set(key, name)
}

// The site's invite-token signing key. Boxes get the PUBLIC half over /api/gs/keys.
const siteKey = keys.loadOrCreate(path.join(a['key-dir'] || path.join(__dirname, '.dev-keys'), 'site-invite.json'))
// A key that is NOT the site's, used only to mint deliberately-forged tokens for the
// refusal demo. Nothing real ever signs with it.
const forgerKey = keys.loadOrCreate(path.join(a['key-dir'] || path.join(__dirname, '.dev-keys'), 'forger-demo.json'))
log.info(`invite key ${siteKey.keyId}`)

const state = {
  boxes: new Map(),            // name -> { name, lastPoll, lastStatus, instances }
  assignments: new Map(),      // box name -> assignment | null
  games: [],                   // posted results
  chat: [],                    // the ring
  chatSeq: 0,
  waiters: [],                 // long-poll waiters
  sse: new Set(),              // browser listeners
  tokens: [],
}

const CHAT_RING = 500

function pushChat(ev) {
  const e = { id: ++state.chatSeq, at: Date.now(), ...ev }
  state.chat.push(e)
  while (state.chat.length > CHAT_RING) state.chat.shift()
  // Wake every box waiting on the drain, and every browser on the SSE stream.
  const ws = state.waiters.splice(0)
  for (const w of ws) w(e)
  for (const res of state.sse) { try { res.write(`data: ${JSON.stringify(e)}\n\n`) } catch { /* client gone */ } }
  log.info(`chat #${e.id} [${e.origin || 'web'}] ${e.from}: ${e.text}`)
  return e
}

function box(req) {
  const key = req.headers['x-match-secret']
  const name = SECRETS.get(String(key || ''))
  if (!name) return null
  let b = state.boxes.get(name)
  if (!b) { b = { name, firstSeen: Date.now(), polls: 0, instances: [] }; state.boxes.set(name, b) }
  b.lastPoll = Date.now()
  b.polls++
  return b
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (d) => { b += d; if (b.length > 1 << 20) { b = ''; req.destroy() } })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } })
  })
}

function assignmentNonce(x) {
  // Same trick as the CS site: the box caches the nonce and only reconfigures when it
  // changes, so a poll every few seconds costs nothing.
  return crypto.createHash('sha1').update(canonical(x)).digest('hex').slice(0, 12)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname

  // ---- the pull protocol (box -> site) ---------------------------------------
  if (p.startsWith('/api/gs/')) {
    const b = box(req)
    if (!b) return json(res, 401, { error: 'bad or missing x-match-secret' })

    if (p === '/api/gs/assignment' && req.method === 'GET') {
      const asg = state.assignments.get(b.name)
      if (!asg) return json(res, 200, { status: 'idle', nonce: 'idle' })
      return json(res, 200, { status: 'leased', ...asg })
    }

    if (p === '/api/gs/keys' && req.method === 'GET') {
      return json(res, 200, { invite_pub: siteKey.pub, key_id: siteKey.keyId, alg: 'ed25519' })
    }

    if (p === '/api/gs/status' && req.method === 'POST') {
      const body = await readBody(req)
      b.lastStatus = { ...body, at: Date.now() }
      b.instances = body.instances || b.instances
      log.info(`${b.name} status=${body.state} match=${body.match_id || '-'} instances=${(body.instances || []).length}`)
      if (body.state === 'ready' || body.state === 'live') {
        const asg = state.assignments.get(b.name)
        if (asg) asg.acked = body.state
      }
      return json(res, 200, { ok: true })
    }

    if (p === '/api/gs/result' && req.method === 'POST') {
      const body = await readBody(req)
      const g = { received_at: new Date().toISOString(), box: b.name, ...body }
      state.games.push(g)
      log.info(`RESULT ${g.summary?.map} round ${g.summary?.rounds} finish=${g.summary?.finish?.kind || 'none'} replay=${g.replay?.file || '-'} (${g.replay?.size || 0} bytes)`)
      // The lease is over.
      if (state.assignments.get(b.name)?.match_id === body.summary?.match_id) state.assignments.delete(b.name)
      return json(res, 200, { ok: true, stored: state.games.length })
    }

    // Cross-server chat drain — long-poll, exactly like /api/gs/chat-feed on the CS site.
    if (p === '/api/gs/chat-feed' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0)
      const wait = Math.min(25, Number(url.searchParams.get('wait') || 0))
      const pending = () => state.chat.filter((e) => e.id > since && e.origin !== b.name)
      const now = pending()
      if (now.length || !wait || !since) {
        return json(res, 200, { ok: true, enabled: true, latest: state.chatSeq, events: now })
      }
      let done = false
      const finish = () => { if (done) return; done = true; json(res, 200, { ok: true, enabled: true, latest: state.chatSeq, events: pending() }) }
      const to = setTimeout(finish, wait * 1000)
      state.waiters.push(() => { clearTimeout(to); setImmediate(finish) })
      req.on('close', () => { done = true; clearTimeout(to) })
      return
    }

    if (p === '/api/gs/chat' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body.text) return json(res, 400, { error: 'no text' })
      pushChat({ kind: 'chat', from: body.from || 'player', steamid: body.steamid || null, text: String(body.text).slice(0, 300), origin: b.name, map: body.map || null, instance: body.instance || null })
      return json(res, 200, { ok: true, latest: state.chatSeq })
    }

    return json(res, 404, { error: 'no such gs route' })
  }

  // ---- the site's own faces (browser / demo driver) ---------------------------
  if (p === '/api/site/chat/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(`data: ${JSON.stringify({ kind: 'backlog', events: state.chat.slice(-40) })}\n\n`)
    state.sse.add(res)
    req.on('close', () => state.sse.delete(res))
    return
  }

  if (p === '/api/site/chat' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body.text) return json(res, 400, { error: 'no text' })
    // origin 'web' is nobody's box, so EVERY box picks it up on its next drain.
    pushChat({ kind: 'chat', from: body.from || 'web', text: String(body.text).slice(0, 300), origin: 'web' })
    return json(res, 200, { ok: true })
  }

  if (p === '/admin/lease' && req.method === 'POST') {
    const body = await readBody(req)
    const boxName = body.box || [...SECRETS.values()][0]
    const matchId = body.match_id || makeId('m', 4)
    const players = (body.players || []).map((x, i) => (typeof x === 'string' ? { steamid: x, name: `P${i + 1}` } : x))
    const asg = {
      match_id: matchId,
      map: body.map || 'nazi_zombie_asylum',
      fs_game: body.fs_game || null,
      mode: body.mode || 'verified',
      settings: body.settings || {},
      players,
      whitelist: players.map((x) => x.steamid),
      vip: !!body.vip,
      kind: body.kind || 'sim',
      sim: body.sim || {},
      issued_at: new Date().toISOString(),
    }
    // Every whitelisted player gets an invite token bound to (steamid, match).
    // `bad: 'forge' | 'expire' | 'other_match' | 'none'` mints a deliberately invalid one
    // so the refusal path can be demonstrated, not just asserted about.
    asg.tokens = {}
    for (const x of players) {
      if (x.bad === 'none') continue
      if (x.bad === 'forge') { asg.tokens[x.steamid] = issue(forgerKey.privateKey, { steamid: x.steamid, matchId, name: x.name }); continue }
      if (x.bad === 'expire') { asg.tokens[x.steamid] = issue(siteKey.privateKey, { steamid: x.steamid, matchId, name: x.name, ttlMs: 1000, now: Date.now() - 600_000 }); continue }
      if (x.bad === 'other_match') { asg.tokens[x.steamid] = issue(siteKey.privateKey, { steamid: x.steamid, matchId: 'm_some_other_lobby', name: x.name }); continue }
      asg.tokens[x.steamid] = issue(siteKey.privateKey, { steamid: x.steamid, matchId, name: x.name, keyId: siteKey.keyId })
    }
    asg.nonce = assignmentNonce({ ...asg, tokens: undefined, issued_at: undefined })
    state.assignments.set(boxName, asg)
    log.info(`leased ${matchId} (${asg.map}, ${players.length}p) to ${boxName}`)
    return json(res, 200, { ok: true, box: boxName, assignment: asg })
  }

  if (p === '/admin/token' && req.method === 'POST') {
    const body = await readBody(req)
    const t = issue(siteKey.privateKey, {
      steamid: body.steamid || '76561190000000000',
      matchId: body.match_id || 'm_unknown',
      ttlMs: Number(body.ttl_ms ?? 300000),
      keyId: siteKey.keyId,
    })
    state.tokens.push({ at: Date.now(), ...body, token: t })
    return json(res, 200, { ok: true, token: t })
  }

  if (p === '/admin/clear-lease' && req.method === 'POST') {
    const body = await readBody(req)
    state.assignments.delete(body.box || [...SECRETS.values()][0])
    return json(res, 200, { ok: true })
  }

  if (p === '/admin/state') {
    return json(res, 200, {
      boxes: [...state.boxes.values()],
      assignments: Object.fromEntries(state.assignments),
      games: state.games,
      chat: state.chat.slice(-50),
      invite_key: siteKey.keyId,
    })
  }

  if (p === '/' || p === '/index.html') {
    const f = path.join(__dirname, 'web.html')
    const body = fs.readFileSync(f)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length })
    return res.end(body)
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  log.info(`mock site on http://127.0.0.1:${PORT}  (box keys: ${[...SECRETS.entries()].map(([k, v]) => `${v}=${k}`).join(' ')})`)
})
