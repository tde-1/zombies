#!/usr/bin/env node
// THE FULL INTEGRATION RUN: a real host agent against the REAL website.
//
//   party -> lease -> boot -> join (invite tokens) -> referee -> GAME OVER
//         -> signed replay -> result -> games/players/XP/boards -> key pin
//         -> the instance is disposed of (warm or torn down) -> the box is idle again
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
import { verifyFile, readFooter } from '../lib/replay.js'
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
    // GAME OVER, end to end. The simulator now survives its own game over exactly as a
    // real dedicated server does since `no_save_reload.cpp` (dedi.md §12.3): it reports
    // the result, sends `match_end` and sits there idle. `--after-game end` is the
    // default and is stated anyway, because this run is the proof of it.
    '--after-game', 'end', '--games-per-instance', '5', '--sim-games', '3',
    // One extra client joins the lobby with a token that is not a token, so a box that is
    // ENFORCING has something to refuse. Their row still reaches the result — with no
    // account on it, which is the whole of the identity rule (referee.md §13.2).
    '--sim-gatecrash',
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

  // The beta gate is real: `requireApproved` refuses anybody with `approved=0`, and on a
  // FRESH database only the first account to sign in is approved (it is made admin by
  // `routes/auth.js`). So a second player could not join a party, and this harness failed
  // four checks in a row against a site that was working correctly — it had only ever been
  // run against a database somebody had already curated by hand.
  //
  // The leader is that first account, so it is a mod and can approve the mate. Idempotent,
  // and best-effort: on a site where the leader is NOT a mod this says so and carries on
  // rather than pretending the party failed for some other reason.
  const appr = await leader.call(`/api/admin/player/${MATE}/approve`, { method: 'POST', body: { approved: true } })
  if (appr && appr.ok) info(`approved ${MATE} off the beta waiting list (the leader is the site's first account, so it is admin)`)
  else info(`could not approve ${MATE}: ${JSON.stringify(appr).slice(0, 120)} — if the join below fails, that is why`)

  await leader.call('/api/party/leave', { method: 'POST' })
  await mate.call('/api/party/leave', { method: 'POST' })
  const created = await leader.call('/api/party/create', { method: 'POST', body: { visibility: 'public' } })
  const partyId = created.party?.id
  if (!partyId) throw new Error(`could not create a party: ${JSON.stringify(created).slice(0, 200)}`)
  ok(`party ${partyId} created`)

  const joined = await mate.call('/api/party/join', { method: 'POST', body: { party_id: partyId } })
  if (joined.ok || joined.party) ok('the second player joined the party'); else bad(`join: ${JSON.stringify(joined).slice(0, 160)}`)

  const pressStart = async () => {
    await leader.call('/api/party/map', { method: 'POST', body: { map_key: a.map || 'nazi_zombie_factory' } })
    await leader.call('/api/party/mode', { method: 'POST', body: { mode: 'verified' } })
    await leader.call('/api/party/ready-check', { method: 'POST' })
    await mate.call('/api/party/ready', { method: 'POST', body: { ready: true } })
    await leader.call('/api/party/ready', { method: 'POST', body: { ready: true } })
    const r = await leader.call('/api/party/launch', { method: 'POST', body: { force: true } })
    return { id: r.match_id || r.assignment?.match_id || r.party?.match_id, raw: r }
  }
  const first = await pressStart()
  const launched = first.raw
  const matchId = first.id
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

  step('5a. identity: an account reaches the result only when somebody checked it')
  // The two invited players presented tokens the SITE signed and the BOX verified, so they
  // are `verified` and carry steamids. The gatecrasher presented a token that is not one,
  // was refused, and its row must reach the result with NO account on it.
  const gate = /auth slot \d+ Gatecrasher \S*: DENY \(([^)]+)\) -> identity (\w+)/.exec(host.out)
  if (gate) ok(`the gatecrasher was refused (${gate[1]}) and its identity is "${gate[2]}"`)
  else bad('the gatecrasher was not refused — a box with a site key must not admit a token it cannot verify')
  const verified = (host.out.match(/-> identity verified/g) || []).length
  if (verified >= 2) ok(`both invited players came through as identity=verified (${verified})`)
  else bad(`expected 2 verified identities, got ${verified}`)

  step('5b. game over: the result, then the instance is disposed of and the box is idle')
  // 1. the game's OWN result reached the referee (the enriched game_over of referee.md
  //    §10.2) — this is the line the whole contract rests on.
  if (/match_end: the game process says it is idle/.test(host.out)) {
    ok('the box saw `match_end` and knows the game process is still alive and idle')
  } else bad('the box never logged a match_end — it cannot have known the instance was free')

  // 2. it picked ONE of the two dispositions. Never neither (referee.md §10.3 step 4).
  const disp = /disposition: (REUSE|TERMINATE) — (.+)/.exec(host.out)
  if (disp) ok(`disposition: ${disp[1]} (${disp[2].trim()})`)
  else bad('the box chose neither disposition — the instance is left holding a port and a map for ever')

  // 3. and it carried it out. `end` -> the referee map_restarts and re-announces
  //    map_loaded -> the instance is warm and can take the next lease.
  if (disp && disp[1] === 'REUSE') {
    if (/instance \S+ is WARM:/.test(host.out)) ok('`end` was accepted, the map came back, and the instance is WARM for the next lease')
    else bad('the box chose REUSE and the instance never reported warm')
  } else if (disp) {
    if (/retiring instance/.test(host.out)) ok('the instance was torn down, as chosen')
    else bad('the box chose TERMINATE and nothing was retired')
  }

  // 4. the ORDER, which is the part that cannot be got wrong: the replay is closed and
  //    the result is posted BEFORE anything touches the instance. An `end` that lands
  //    first destroys the evidence of a game the host had not finished writing down.
  const iReplay = host.out.indexOf('replay closed:')
  const iDisp = host.out.indexOf('disposition:')
  if (iReplay >= 0 && iDisp > iReplay) ok('the replay was closed and signed BEFORE the instance was disposed of')
  else bad(`out of order: replay closed at ${iReplay}, disposition at ${iDisp}`)

  // 5. the site agrees the lease is over and the box is free.
  const asgAfter = await waitFor('the assignment to close', async () => {
    const r = await gs('/api/gs/assignment')
    return r.body && r.body.status !== 'leased' ? r.body : null
  }, 30_000)
  if (asgAfter) ok(`the site's assignment for this box is now "${asgAfter.status}" — the result closed the lease`)
  else bad('the site still has this box leased after the result was posted')

  const idle = await waitFor('the box to report idle', async () => {
    const r = await leader.call('/api/admin/boxes')
    const b = (r.boxes || []).find((x) => x.name === BOX)
    return b && b.last_state === 'idle' ? b : null
  }, 30_000)
  if (idle) ok(`boxes.list() shows ${BOX} online=${idle.online} last_state=${idle.last_state} — free for the next lease`)
  else bad(`boxes.list() never showed ${BOX} idle again; a box that stays "live" after a game is leasable but looks busy for ever`)

  step('5c. a SECOND lease goes to the warm instance, with its own match id')
  // `end` carried no `match` on the reuse above — there was no next lease and a stale id
  // refuses every token with `wrong_match`. The game reads its lease id from ENW_MATCH
  // ONCE at process start, so this second lease has to be told to it in a second `end`
  // before the map_restart (game-link-v0 `end`.`match`, referee.md §13.4).
  const instBefore = (host.out.match(/start (sim|game) port/g) || []).length
  const second = await pressStart()
  const match2 = second.id
  if (match2 && match2 !== matchId) ok(`Start pressed again -> the site leased ${match2}`)
  else { bad(`second launch: ${JSON.stringify(second.raw).slice(0, 240)}`); throw new Error('no second lease') }

  const handed = await waitFor('the warm instance to take the second lease',
    () => new RegExp(`lease ${match2} handed to WARM instance (\\S+)`).exec(host.out), 60_000)
  if (handed) ok(`${handed[1]} took it WARM — no process start, no map load`)
  else bad('the second lease did not go to the warm instance')

  if (new RegExp(`warm instance rebound to lease ${match2}`).test(host.out)) {
    ok('the box told the game its new match id in a second `end` before the map_restart')
  } else bad('the box never sent the new match id — every invite token the site just minted would be `wrong_match`')

  const secondEnded = await waitFor('the second game to finish', () => (host.out.match(/SUMMARY /g) || []).length >= 2, 300_000)
  if (secondEnded) ok('the second game played out on the same process and was refereed to the end')

  const instAfter = (host.out.match(/start (sim|game) port/g) || []).length
  if (instAfter === instBefore) ok(`still ${instAfter} process start(s) for two games — the instance really was reused`)
  else bad(`the box started ${instAfter - instBefore} extra process(es); the warm instance was not reused`)

  const g2 = await waitFor('the second game row', async () => {
    const r = await leader.call(`/api/games/${match2}`)
    return r && (r.game || r.id) ? r : null
  }, 60_000)
  if (g2) ok(`the site holds a second game row for ${match2}`); else bad(`no game row for ${match2}`)

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
    // The game's OWN final word, carried into the stored summary rather than re-folded
    // out of the stream (referee.md §10.3 step 2).
    const stored = (() => { try { return JSON.parse(game.summary_json || 'null') } catch { return null } })() || g.summary || null
    if (stored && stored.reported && Array.isArray(stored.reported.players)) {
      info(`reported  round ${stored.reported.round} reason=${stored.reported.reason} ${stored.reported.players.length} player row(s), ${stored.reported.points_total} point(s), ${stored.reported.downs_total} down(s)`)
      ok("the stored result carries the game's own enriched game_over, not only our fold of the stream")
    } else info('the stored game row does not expose summary_json to this caller — checked on the box side instead')
    if (stored && stored.match_end && stored.match_end.server_alive) ok('...and the match_end that said the instance was free')

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
  const byMatch = new Set()
  for (const f of files) {
    const full = path.join(dir, f)
    byMatch.add(f.replace(/\.enwr$/, ''))
    const key = JSON.parse(fs.readFileSync(path.join(BOX_KEYS, `host-${BOX}.json`), 'utf8'))
    const plain = verifyFile(full)
    const pinnedCheck = verifyFile(full, { expectPub: key.pub })
    if (plain.ok && pinnedCheck.ok) ok(`${f}: VALID against the pinned key — ${plain.chunks} chunks, ${plain.events} events`)
    else bad(`${f}: ${(plain.errors.concat(pinnedCheck.errors)).join('; ')}`)
    const wrong = verifyFile(full, { expectPub: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
    if (!wrong.ok) ok('and it correctly FAILS against a key that is not the pin'); else bad('it verified against the wrong pinned key')
  }
  // TWO replays, one per lease, from ONE game process — and the second one's signed
  // container names the second match, which is the thing `end`.`match` exists to make true.
  if (byMatch.has(matchId) && byMatch.has(match2)) {
    ok(`two signed replays from one process: ${matchId} and ${match2}, each naming its own lease`)
  } else bad(`expected a signed replay per lease; got [${[...byMatch].join(', ')}]`)

  // THE IDENTITY ROWS, read out of the SIGNED FOOTER rather than the site's API — the
  // footer is the summary the box posted, inside the evidence, covered by the signature.
  // `/api/games/:id` does not hand `summary_json` back to a caller, and this is a better
  // place to check it from in any case.
  const rep1 = path.join(dir, `${matchId}.enwr`)
  const footerSummary = fs.existsSync(rep1) ? (readFooter(rep1).footer || {}).summary : null
  if (footerSummary && Array.isArray(footerSummary.players)) {
    for (const pl of footerSummary.players) info(`identity ${String(pl.identity).padEnd(9)} ${String(pl.name).padEnd(12)} steamid=${pl.steamid || '-'} claimed=${pl.claimed_steamid || '-'}`)
    const ver = footerSummary.players.filter((x) => x.identity === 'verified')
    const unver = footerSummary.players.filter((x) => x.identity !== 'verified')
    if (ver.length >= 2 && ver.every((x) => x.steamid)) ok('every VERIFIED row carries its steamid into the signed, posted result')
    else bad(`expected 2 verified rows with steamids, got ${ver.length}`)
    if (unver.length && unver.every((x) => !x.steamid)) ok(`and the ${unver.length} unverified row(s) carry NO steamid — attendance, not an account`)
    else if (!unver.length) bad('the refused gatecrasher never reached the result at all; a refusal must still be recorded')
    else bad('an unverified row carried a steamid into the result')
  } else bad(`could not read the summary out of ${matchId}.enwr`)

  // ...and the site agreed: no account, so no player row, so nothing credited.
  const seated = await leader.call(`/api/games/${matchId}`)
  const rows = seated.players || seated.game?.players || []
  if (rows.length === 2) ok('the site seated exactly the 2 verified players — the refused row earned nothing')
  else bad(`expected 2 seated players at the site, got ${rows.length}`)

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
