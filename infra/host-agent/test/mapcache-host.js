#!/usr/bin/env node
// THE MAP CACHE, end to end on the box's side (2026-09-23, lib/mapcache.js + host.js).
//
// A real host agent (simulated games, no WaW) with ENW_MAP_CACHE=on against a stand-in
// site and a FAKE BUCKET on loopback. It proves the host half:
//
//   1. a lease for a map not in mods/ is `preparing` (posted, with bytes progress) and is
//      listed in the heartbeat's instances with its match id WHILE it downloads - which is
//      what keeps the site's 90 s ghost reaper off it - and boots only once installed;
//   2. a lease whose map cannot be pulled (sha mismatch) is reported `failed` and is never
//      booted, and nothing half-pulled is left in mods/.
//
//   node test/mapcache-host.js [--verbose]        (~30 s: the pull is slowed on purpose
//                                                 so it outlives one 10 s heartbeat)
import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdirp, parseArgs } from '../lib/util.js'

const a = parseArgs(process.argv.slice(2))
const ROOT = path.resolve(import.meta.dirname, '..')
const RUN = mkdirp(path.join(os.tmpdir(), 'enw-mapcache-host-' + Date.now().toString(36)))
const MODS = mkdirp(path.join(RUN, 'waw-en', 'mods'))
const PORTS = { site: 38931, bucket: 38932, link: 38933, base: 29700 }

let failures = 0
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m   ${m}`)
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`) }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

// ---- the fake bucket: slow on purpose (13 pieces, 1 s apart) ---------------------------
const FF = Buffer.alloc(13 * 1000, 7)
const objects = new Map([
  ['/mods/slow_map/mod.ff', FF],
  ['/mods/broken_map/mod.ff', Buffer.alloc(100, 1)],     // the list says something else
])
const bucket = http.createServer(async (req, res) => {
  const body = objects.get(decodeURIComponent(req.url))
  if (!body) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-length': body.length })
  for (let i = 0; i < body.length; i += 1000) { res.write(body.subarray(i, i + 1000)); await delay(body.length > 1000 ? 1000 : 0) }
  res.end()
})
await new Promise((r) => bucket.listen(PORTS.bucket, '127.0.0.1', r))

// ---- the stand-in site -----------------------------------------------------------------
const FILES = {
  slow_map: { bsp: 'slow_map', stock: false, files: [{ path: 'mod.ff', size: FF.length, sha256: sha(FF) }] },
  broken_map: { bsp: 'broken_map', stock: false, files: [{ path: 'mod.ff', size: 100, sha256: sha(Buffer.alloc(100, 2)) }] },
}
const lease = (id, map) => ({
  status: 'leased', match_id: id, map, fs_game: `mods/${map}`, mode: 'custom', settings: {}, kind: 'game',
  players: [{ steamid: '76561198000000001', name: 'P1' }], whitelist: ['76561198000000001'], tokens: {}, vip: false,
  manifest: null, nonce: `n_${id}`, sim: { timescale: 1, max_round: 50 },
})
let leases = []
const posts = []          // every /api/gs/status body
const site = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const send = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/api/gs/assignment') return send({ v: 2, status: leases.length ? 'leased' : 'idle', nonce: leases.map((l) => l.nonce).join('+') || 'idle', assignments: leases })
    if (u.pathname === '/api/gs/status') { try { posts.push(JSON.parse(body || '{}')) } catch { /* ignore */ } return send({ ok: true }) }
    if (u.pathname.startsWith('/api/gs/map-files/')) {
      const f = FILES[decodeURIComponent(u.pathname.split('/').pop())]
      return f ? send(f) : send({ files: [] })
    }
    if (u.pathname === '/api/gs/popular-maps') return send({ ok: true, maps: [] })
    if (u.pathname === '/api/gs/chat-feed') return setTimeout(() => send({ ok: true, latest: 1, events: [] }), 1000)
    if (u.pathname === '/api/gs/keys') return send({ error: 'no key in this test' }, 404)
    return send({ ok: true })
  })
})
await new Promise((r) => site.listen(PORTS.site, '127.0.0.1', r))

// ---- the host agent ---------------------------------------------------------------------
const host = spawn(process.execPath, [path.join(ROOT, 'host.js'),
  '--site', `http://127.0.0.1:${PORTS.site}`, '--secret', 'x', '--box', 'mapcache-test',
  '--link-port', String(PORTS.link), '--base-port', String(PORTS.base), '--dash', 'off',
  '--max-instances', '2', '--replay-dir', path.join(RUN, 'replays'), '--log-dir', path.join(RUN, 'logs'),
  '--key-dir', path.join(RUN, 'keys'), '--spool-dir', path.join(RUN, 'spool'),
], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, ENW_MAP_CACHE: 'on', ENW_MODS_DIR: MODS, ENW_MAP_BUCKET_URL: `http://127.0.0.1:${PORTS.bucket}`, ENW_MODS_MIN_FREE_GB: '0', ENW_MAP_PREFETCH_TOP: '0' },
})
let out = ''
const tee = (d) => { out += d; if (a.verbose) process.stdout.write(`\x1b[90m[box]\x1b[0m ${d}`) }
host.stdout.on('data', tee); host.stderr.on('data', tee)

async function until(what, fn, ms = 40_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = fn(); if (v) return v; await delay(250) }
  bad(`timed out: ${what}`); return null
}
const running = (id) => posts.some((p) => (p.instances || []).some((i) => i.match_id === id && i.state === 'running'))

try {
  await until('the host agent to start', () => /map cache ON/.test(out) && /host agent up/.test(out), 20_000) && ok('map cache ON at start')

  console.log('\n── 1. a lease for a map that is not on the box')
  leases = [lease('m_pull', 'slow_map')]
  const first = await until('a preparing post', () => posts.find((p) => p.state === 'preparing' && p.match_id === 'm_pull'))
  if (first) ok(`posted state=preparing for m_pull (${first.preparing?.phase})`)
  const hb = await until('a heartbeat listing the preparing lease', () => posts.find((p) => (p.instances || []).some((i) => i.match_id === 'm_pull' && i.state === 'preparing')), 20_000)
  if (hb) {
    const e = hb.instances.find((i) => i.match_id === 'm_pull')
    ok(`the heartbeat lists m_pull while it downloads (id ${e.id}, port ${e.port}, ${e.preparing?.bytes_done}/${e.preparing?.bytes_total} bytes)`)
    e.port == null ? ok('no port while preparing: the site hands out no connect string') : bad('a port while preparing')
  }
  const prog = posts.filter((p) => p.state === 'preparing' && p.preparing?.phase === 'downloading')
  prog.some((p) => p.preparing.bytes_total === FF.length && p.preparing.bytes_done > 0 && p.preparing.bytes_done < FF.length)
    ? ok(`progress posted mid-download (${prog.length} post(s), e.g. ${prog[prog.length - 1].preparing.percent}%)`)
    : bad(`no mid-download progress in ${prog.length} post(s)`)
  running('m_pull') ? bad('booted before the map was installed') : ok('not booted while downloading')
  await until('m_pull to boot', () => running('m_pull'), 40_000) && ok('booted once the map was installed')
  fs.existsSync(path.join(MODS, 'slow_map', 'mod.ff')) && fs.statSync(path.join(MODS, 'slow_map', 'mod.ff')).size === FF.length
    ? ok('mods/slow_map/mod.ff installed whole') : bad('the map is not installed')

  console.log('\n── 2. a lease whose map cannot be pulled')
  leases = [lease('m_pull', 'slow_map'), lease('m_bad', 'broken_map')]
  const failed = await until('a failed post', () => posts.find((p) => p.state === 'failed' && p.match_id === 'm_bad'))
  if (failed) ok(`posted state=failed: ${failed.error}`)
  await delay(1500)
  running('m_bad') ? bad('the broken lease was booted') : ok('the broken lease was never booted')
  fs.existsSync(path.join(MODS, 'broken_map')) ? bad('a half map is visible in mods/') : ok('nothing half-pulled in mods/')
} finally {
  leases = []
  await delay(500)
  host.kill('SIGINT')
  await new Promise((r) => { const t = setTimeout(() => { host.kill(); r() }, 15_000); host.on('exit', () => { clearTimeout(t); r() }) })
  site.close(); bucket.close()
}
console.log(failures ? `\n\x1b[31mFAIL\x1b[0m mapcache-host: ${failures} failure(s) (${RUN})` : `\n\x1b[32mPASS\x1b[0m mapcache-host (${RUN})`)
process.exit(failures ? 1 : 0)
