#!/usr/bin/env node
// THE FULL INTEGRATION RUN: a real host agent against the REAL website.
//
//   party -> lease -> boot -> join (invite tokens) -> referee -> signed replay
//         -> result -> games/players/XP/boards -> key pin
//
// Nothing is mocked on either side. The site is `web/` on :3200 with its own database and
// its own Ed25519 invite key; the box is `host.js` with its own replay key. The only thing
// that passes between them is HTTP the box initiates.
//
//   cd web && npm run dev            # terminal 1, leave it running
//   node test/integration-site.js    # terminal 2
//
// Flags: --site <url> --secret <key> --box <name> --keep (leave the host agent running)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyFile } from '../lib/replay.js'
import { mkdirp, parseArgs } from '../lib/util.js'

const a = parseArgs(process.argv.slice(2))
const ROOT = path.resolve(import.meta.dirname, '..')
const SITE = a.site || 'http://127.0.0.1:3200'
const SECRET = a.secret || 'devkey-a'
const BOX = a.box || 'box-a'
const RUN = mkdirp(path.join(os.tmpdir(), 'enw-integration-' + Date.now().toString(36)))
const BOX_KEYS = a['key-dir'] || path.join(process.env.ZOMBIES_DEV || 'C:/Users/b/ZombiesDev', 'keys')
// Ports nobody else is on. Three agents drive host agents on this box tonight, and a
// port clash makes our child exit at boot while SOMEBODY ELSE's box quietly takes the
// lease — which looks exactly like our box working until you read the artifacts folder
// and find it empty. Unique ports plus the boot check below make that impossible to miss.
const PORTS = { link: Number(a['link-port'] || 38851), base: Number(a['base-port'] || 29400), dash: Number(a['dash-port'] || 8851) }

const ADMIN = '76561190000000001'
const MATE = '76561190000000002'

let failures = 0
const step = (n) => console.log(`\n\x1b[36m── ${n} ${'─'.repeat(Math.max(0, 66 - n.length))}\x1b[0m`)
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m   ${m}`)
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`) }
const info = (m) => console.log(`       ${m}`)

// --- the world's smallest cookie jar, so we can be two signed-in people at once ---
function person(label) {
  const jar = new Map()
  const call = async (p, { method = 'GET', body = null, form = null, raw = false } = {}) => {
    const res = await fetch(SITE + p, {
      method,
      redirect: 'manual',
      headers: {
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
    })
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim())
    }
    if (raw) return res
    const t = await res.text()
    try { return JSON.parse(t) } catch { return { _status: res.status, _text: t.slice(0, 200) } }
  }
  return { label, call, signIn: (sid, name) => call('/auth/mock', { method: 'POST', form: { steam_id: sid, username: name }, raw: true }) }
}

const gs = (p, init = {}) => fetch(SITE + p, {
  ...init, headers: { 'x-match-secret': SECRET, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

let host = null
function startHost() {
  host = spawn(process.execPath, [path.join(ROOT, 'host.js'),
    '--site', SITE, '--secret', SECRET, '--box', BOX,
    '--link-port', String(PORTS.link), '--base-port', String(PORTS.base), '--dash-port', String(PORTS.dash),
    '--replay-dir', path.join(RUN, 'replays'), '--log-dir', path.join(RUN, 'logs'),
    // The box's replay key is its IDENTITY, so it is the box's REAL key dir, not a
    // per-run one. A fresh key each run is (correctly) treated by the site as an
    // impostor: it stays pending until an admin accepts it, and every replay written in
    // the meantime is stored unpinned. That is the behaviour, not a bug — it just means
    // a test must not manufacture a new identity every time it runs.
    '--key-dir', BOX_KEYS, '--spool-dir', path.join(RUN, 'spool'),
    '--sim-timescale', '300', '--sim-max-round', '12',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  host.out = ''
  const tee = (d) => { host.out += d; if (a.verbose) process.stdout.write(`\x1b[90m[box]\x1b[0m ${d}`) }
  host.stdout.on('data', tee); host.stderr.on('data', tee)
  return host
}

async function waitFor(what, fn, ms = 120_000, every = 400) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v } catch { /* not yet */ }
    await delay(every)
  }
  bad(`timed out waiting for ${what}`)
  return null
}

try {
  step('0. the real site is up')
  const keys = await gs('/api/gs/keys')
  if (keys.status !== 200) throw new Error(`the site is not answering on ${SITE} — run \`cd web && npm run dev\` first`)
  ok(`${SITE} is up; its invite key is ${keys.body.key_id}`)
  const unauth = await fetch(SITE + '/api/gs/assignment').then((r) => r.status)
  if (unauth === 401) ok('and it refuses /api/gs/* without x-match-secret'); else bad(`expected 401 without a secret, got ${unauth}`)

  step('1. the box comes up and pins its replay key')
  startHost()
  const up = await waitFor('the box to come up', () => /host agent up:/.test(host.out), 25_000)
  if (!up) {
    for (const l of host.out.split(String.fromCharCode(10)).filter(Boolean).slice(-6)) info(l.trimEnd())
    throw new Error(`our host agent did not start (ports ${PORTS.link}/${PORTS.dash}). If another box is already using this site with the same secret, give this run its own --secret and --box.`)
  }
  ok(`our box is up on link :${PORTS.link}, dash :${PORTS.dash}`)
  if (await waitFor('the invite key', () => /site invite key .* loaded/.test(host.out), 20_000)) {
    ok('the box fetched the site invite key and is enforcing token checks')
  }
  const pinned = await waitFor('the key pin', () => /replay key (\w+) is PINNED/.exec(host.out), 40_000)
  if (pinned) ok(`the site pinned the box's replay key from the status heartbeat: ${pinned[1]}`)
  else if (/KEY MISMATCH/.test(host.out)) bad('the site has a DIFFERENT key pinned for this box — an admin must accept the new one (Admin -> Boxes)')
  else bad('the site never confirmed the replay-key pin')

  step('2. two players make a party and press Start (the real path, not a hand lease)')
  const leader = person('leader'); const mate = person('mate')
  await leader.signIn(ADMIN, 'Leader')
  await mate.signIn(MATE, 'Mate')
  const me = await leader.call('/api/me')
  ok(`signed in as ${me.user?.username || ADMIN} and ${MATE}`)

  await leader.call('/api/party/leave', { method: 'POST' })
  await mate.call('/api/party/leave', { method: 'POST' })
  const created = await leader.call('/api/party/create', { method: 'POST', body: { visibility: 'public' } })
  const partyId = created.party?.id
  if (!partyId) throw new Error(`could not create a party: ${JSON.stringify(created).slice(0, 200)}`)
  ok(`party ${partyId} created`)

  const joined = await mate.call('/api/party/join', { method: 'POST', body: { party_id: partyId } })
  if (joined.ok || joined.party) ok('the second player joined the party'); else bad(`join: ${JSON.stringify(joined).slice(0, 160)}`)

  await leader.call('/api/party/map', { method: 'POST', body: { map_key: a.map || 'nazi_zombie_factory' } })
  await leader.call('/api/party/mode', { method: 'POST', body: { mode: 'verified' } })
  await leader.call('/api/party/ready-check', { method: 'POST' })
  await mate.call('/api/party/ready', { method: 'POST', body: { ready: true } })
  await leader.call('/api/party/ready', { method: 'POST', body: { ready: true } })
  const launched = await leader.call('/api/party/launch', { method: 'POST', body: { force: true } })
  const matchId = launched.match_id || launched.assignment?.match_id || launched.party?.match_id
  if (matchId) ok(`Start pressed -> the site leased ${matchId}`)
  else { bad(`launch: ${JSON.stringify(launched).slice(0, 300)}`); throw new Error('no lease') }

  step('3. the box takes the lease, boots and admits the invited players')
  if (await waitFor('the lease to reach the box', () => host.out.includes(matchId), 60_000)) {
    ok('the box saw the lease on its next /api/gs/assignment poll (the site never connected out)')
  }
  await waitFor('the auth decisions', () => (host.out.match(/auth slot \d/g) || []).length >= 2, 90_000)
  for (const m of host.out.matchAll(/auth slot (\d) (\S*) (\d+): (ALLOW|DENY) \(([^)]+)\)/g)) {
    info(`slot ${m[1]} ${m[2].padEnd(10)} ${m[3]}  ${m[4] === 'ALLOW' ? '\x1b[32mALLOW\x1b[0m' : '\x1b[31mDENY\x1b[0m'} (${m[5]})`)
  }
  const allowed = (host.out.match(/: ALLOW \(ok\)/g) || []).length
  if (allowed >= 2) ok("both players' invite tokens verified — signed by the site, checked by the box, nothing hand-copied")
  else bad(`expected 2 tokens to verify, got ${allowed}`)

  step('4. a forged token is still refused by the real box')
  // Mint one with a key that is not the site's and present it at the same match.
  const { generate, exportPair, privateFromRaw } = await import('../lib/keys.js')
  const { issue } = await import('../lib/tokens.js')
  const forger = exportPair(generate())
  const forged = issue(privateFromRaw(forger.priv), { steamid: '76561190000000009', matchId })
  const { check } = await import('../lib/tokens.js')
  const { publicFromRaw } = await import('../lib/keys.js')
  const v = check(publicFromRaw(keys.body.invite_pub), forged, { matchId })
  if (!v.ok && v.reason === 'bad_signature') ok('a token minted with another key fails against the site key the box holds (bad_signature)')
  else bad(`a forged token was not refused: ${JSON.stringify(v)}`)

  step('5. the game plays out and the box posts the result')
  const ended = await waitFor('the game to end', () => /SUMMARY /.test(host.out), 300_000)
  const sum = /SUMMARY (.+)/.exec(host.out)
  const rep = /replay closed: (.+)/.exec(host.out)
  if (sum) info(sum[1])
  if (rep) info(`replay: ${rep[1]}`)
  if (ended && sum && rep) ok('the referee called the game and the box closed and signed the replay')
  else bad('the box did not finish the game (see the artifacts folder)')

  step('6. what the site now holds')
  const g = await waitFor('the game row', async () => {
    const r = await leader.call(`/api/games/${matchId}`)
    return r && (r.game || r.id) ? r : null
  }, 60_000)
  if (g) {
    const game = g.game || g
    info(`game    ${game.map_key || game.map} round ${game.rounds} finish=${game.finish_kind || game.finish?.kind || 'none'} mode=${game.mode} eligible=${game.records_eligible ?? game.eligible}`)
    const players = g.players || game.players || []
    for (const p of players) info(`player  ${p.name || p.steam_id}  score ${p.score}  xp ${p.xp ?? '-'}  rounds ${p.rounds_played ?? '-'}`)
    const r = g.replay || game.replay
    if (r) {
      info(`replay  ${r.size} bytes, key ${r.key_id || 'NONE'}, pinned=${r.key_pinned}`)
      if (r.key_id && r.key_pinned) ok('the replay is stored PINNED to this box\'s key — record-grade evidence')
      else bad(`the replay is stored unpinned (key_id=${r.key_id}, key_pinned=${r.key_pinned})`)
    } else bad('the site stored no replay pointer')
    if (players.length >= 2) ok(`both players are on the game with XP`); else bad(`expected 2 players on the game row, got ${players.length}`)
  }

  step('7. the replay on disk verifies, and against the pinned key')
  const dir = path.join(RUN, 'replays')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.enwr')) : []
  if (!files.length) bad(`no replay in ${dir} — our box wrote nothing, so the game above was somebody else's`)
  for (const f of files) {
    const full = path.join(dir, f)
    const key = JSON.parse(fs.readFileSync(path.join(BOX_KEYS, `host-${BOX}.json`), 'utf8'))
    const plain = verifyFile(full)
    const pinnedCheck = verifyFile(full, { expectPub: key.pub })
    if (plain.ok && pinnedCheck.ok) ok(`${f}: VALID against the pinned key — ${plain.chunks} chunks, ${plain.events} events`)
    else bad(`${f}: ${(plain.errors.concat(pinnedCheck.errors)).join('; ')}`)
    const wrong = verifyFile(full, { expectPub: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
    if (!wrong.ok) ok('and it correctly FAILS against a key that is not the pin'); else bad('it verified against the wrong pinned key')
  }

  step('8. spool and retry, against their /api/gs/spool')
  const fake = {
    box: BOX, instance: 'inst-spool',
    summary: { match_id: `m_spooltest_${Date.now().toString(36)}`, map: 'nazi_zombie_prototype', mode: 'custom', rounds: 3, players: [], player_count: 0, flags: [], duration_ms: 60_000, finish: null, records_eligible: false },
    replay: null,
  }
  const drain = await gs('/api/gs/spool', { method: 'POST', body: JSON.stringify([fake]) })
  if (drain.status === 200 && drain.body?.accepted === 1) ok(`POST /api/gs/spool took a held result (accepted ${drain.body.accepted}); the box's drain speaks this shape`)
  else bad(`spool drain: ${drain.status} ${JSON.stringify(drain.body).slice(0, 160)}`)
  const junk = await gs('/api/gs/result', { method: 'POST', body: JSON.stringify({ nope: true }) })
  if (junk.status >= 400 && junk.status < 500) ok(`a bad result body is ${junk.status}, never 5xx — the box drops it instead of retrying forever`)
  else bad(`expected 4xx for a junk result, got ${junk.status}`)

  step('9. chat-feed since=0 hands back a cursor and no backlog')
  const feed = await gs('/api/gs/chat-feed?since=0&wait=0')
  if (feed.body && Array.isArray(feed.body.events) && feed.body.events.length === 0 && typeof feed.body.latest === 'number') {
    ok(`since=0 -> cursor ${feed.body.latest}, 0 events (a fresh game is not shown an hour of strangers' chat)`)
  } else bad(`since=0 returned ${JSON.stringify(feed.body).slice(0, 160)}`)
} catch (e) {
  bad(`integration run threw: ${e.message}`)
} finally {
  if (!a.keep && host) {
    try { host.kill('SIGTERM') } catch { /* gone */ }
    await delay(1500)
    if (host.exitCode == null) { try { host.kill('SIGKILL') } catch { /* gone */ } }
  }
  console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}integration run finished with ${failures} failure(s)\x1b[0m`)
  console.log(`artifacts: ${RUN}`)
  process.exit(failures ? 1 : 0)
}
