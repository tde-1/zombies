#!/usr/bin/env node
// Discord Rich Presence (src/main/discord.js; launcher.md "Discord rich presence").
//
// The state table is checked payload by payload. The IPC client is driven against a fake
// Discord: a real named pipe speaking Discord's framing (8-byte header, JSON body), so the
// handshake, SET_ACTIVITY, the clear, ping/pong, "Discord is not running" and "Discord
// started later" all go over a real socket.
//
//   node test/discord-presence.js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'enw-discord-test-'))
process.env.ENW_ROOT = path.join(TMP, 'enwroot')
process.env.ENW_DEV_ROOT = path.join(TMP, 'nodevbox')
process.env.ENW_NO_DISPLAY_PROBE = '1'

const D = await import('../src/main/discord.js')
const settings = await import('../src/main/settings.js')
const site = await import('../../web/client/src/data/wawSettings.js')

let pass = 0
let fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`) } catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.stack?.split('\n').slice(0, 3).join('\n         ')}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 3000, what = 'condition') {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(10) }
  throw new Error(`timed out waiting for ${what}`)
}

const SITE = 'https://zombies.enw.gg'
const ART = '/media/maps/nazi_zombie_sumpf.webp?v=abc123'
const CLIENT = '1420000000000000001'
const party = (n, extra = {}) => ({ id: 7, mode: 'custom', members: Array.from({ length: n }, (_, i) => ({ steam_id: `x${i}` })), ...extra })
const poll = (o = {}) => ({ state: 'idle', party: null, map: null, match: null, ...o })
const sumpf = { key: 'nazi_zombie_sumpf', title: 'SHI NO NUMA', art: ART }
const game = (o = {}) => ({ map: 'nazi_zombie_sumpf', title: null, mode: 'custom', matchId: 'm_1', startedAt: 1_758_600_000_000, ...o })
const LOGO_ONLY = { large_image: 'enw', large_text: 'ENW Zombies' }
const THUMB = 'https://zombies.enw.gg/media/maps/nazi_zombie_sumpf.thumb.webp?v=abc123'

console.log('\nDiscord presence: the state table')

await test('menus: "Browsing maps", ENW logo, nothing else', () => {
  const want = { details: 'Browsing maps', assets: LOGO_ONLY, instance: false }
  assert.deepEqual(D.presenceFor({ play: null, siteUrl: SITE }), want)
  assert.deepEqual(D.presenceFor({ play: poll(), siteUrl: SITE }), want)
  assert.deepEqual(D.presenceFor({ play: { signedOut: true }, siteUrl: SITE }), want)
  assert.deepEqual(D.presenceFor({ play: poll({ party: party(1), map: sumpf }), siteUrl: SITE }), want, 'a party of one is just you in the menus')
})

await test('party lobby: "In a party", the staged map, Discord party size n of 4', () => {
  assert.deepEqual(D.presenceFor({ play: poll({ party: party(3), map: sumpf }), siteUrl: SITE }),
    { details: 'In a party', state: 'Shi No Numa', party: { size: [3, 4] }, assets: LOGO_ONLY, instance: false })
  assert.deepEqual(D.presenceFor({ play: poll({ party: party(2) }), siteUrl: SITE }).state, 'In the lobby')
})

await test('in game, solo: map name, "Solo", then "Solo · Round 7"; map picture large, ENW mark small; elapsed from game start', () => {
  const p = poll({ state: 'playing', party: party(1), map: sumpf, match: { match_id: 'm_1', mode: 'custom' } })
  assert.deepEqual(D.presenceFor({ game: game(), play: p, siteUrl: SITE }), {
    details: 'Shi No Numa', state: 'Solo', timestamps: { start: 1_758_600_000_000 },
    assets: { large_image: THUMB, large_text: 'Shi No Numa', small_image: 'enw', small_text: 'ENW Zombies' }, instance: false,
  })
  p.match.round = 7
  assert.equal(D.presenceFor({ game: game(), play: p, siteUrl: SITE }).state, 'Solo · Round 7')
})

await test('in game, party: "Round 12 (3 of 4)" via Discord party size; "In game" before the round is known', () => {
  const p = poll({ state: 'playing', party: party(3), map: sumpf, match: { match_id: 'm_1', mode: 'custom' } })
  const a = D.presenceFor({ game: game(), play: p, siteUrl: SITE })
  assert.equal(a.state, 'In game'); assert.deepEqual(a.party, { size: [3, 4] })
  p.match.round = 12
  const b = D.presenceFor({ game: game(), play: p, siteUrl: SITE })
  assert.equal(b.state, 'Round 12'); assert.deepEqual(b.party, { size: [3, 4] }); assert.equal(b.details, 'Shi No Numa')
  for (const n of [2, 4]) assert.deepEqual(D.presenceFor({ game: game(), play: { ...p, party: party(n) }, siteUrl: SITE }).party, { size: [n, 4] })
})

await test('loading: "Loading", no timer until the game process starts', () => {
  const a = D.presenceFor({ game: game({ startedAt: null, matchId: null }), play: poll({ map: sumpf }), siteUrl: SITE })
  assert.equal(a.state, 'Loading'); assert.equal(a.timestamps, undefined); assert.equal(a.details, 'Shi No Numa')
})

await test('Verified shows as the small image text; with no picture, on the large text', () => {
  const p = poll({ state: 'playing', party: party(1, { mode: 'verified' }), map: sumpf, match: { match_id: 'm_1', mode: 'verified' } })
  assert.equal(D.presenceFor({ game: game({ mode: 'verified' }), play: p, siteUrl: SITE }).assets.small_text, 'Verified')
  assert.deepEqual(D.presenceFor({ game: game({ mode: 'verified' }), play: p, siteUrl: 'http://127.0.0.1:3200' }).assets,
    { large_image: 'enw', large_text: 'ENW Zombies · Verified' })
})

await test('a stale poll (another match) lends neither party size nor round; Play Local uses its own round', () => {
  const p = poll({ state: 'playing', party: party(4), map: sumpf, match: { match_id: 'm_OLD', round: 30 } })
  const a = D.presenceFor({ game: game(), play: p, siteUrl: SITE })
  assert.equal(a.state, 'Solo'); assert.equal(a.party, undefined)
  const l = D.presenceFor({ game: game({ mode: 'local', matchId: 'l_1' }), play: null, localRound: 5, siteUrl: SITE })
  assert.equal(l.state, 'Solo · Round 5')
  assert.deepEqual(l.assets, LOGO_ONLY, 'no site map record, no picture: the logo')
})

await test('only allowed fields: no ids, names, addresses, secrets or buttons anywhere in any payload', () => {
  const p = poll({ state: 'playing', party: party(3, { code: 'ABCD' }), map: sumpf, match: { match_id: 'm_1', round: 3, token: 'SECRET', connect: '1.2.3.4:28961' } })
  for (const a of [D.presenceFor({ game: game(), play: p, siteUrl: SITE }), D.presenceFor({ play: p, siteUrl: SITE })]) {
    const s = JSON.stringify(a)
    for (const bad of ['SECRET', '1.2.3.4', 'ABCD', 'm_1', 'x0', 'steam', 'secrets', 'buttons', '"id"']) assert.ok(!s.includes(bad), `${bad} leaked: ${s}`)
    for (const k of Object.keys(a)) assert.ok(['details', 'state', 'party', 'timestamps', 'assets', 'instance'].includes(k), k)
  }
})

await test('setting off -> no activity at all', () => {
  assert.equal(D.presenceFor({ enabled: false, game: game(), play: null, siteUrl: SITE }), null)
})

await test('names: an all-caps title is title-cased, a cased one is kept, no title falls back to the bsp; 128-char cap', () => {
  assert.equal(D.mapName('SHI NO NUMA', 'x'), 'Shi No Numa')
  assert.equal(D.mapName('UGX Requiem', 'x'), 'UGX Requiem')
  assert.equal(D.mapName('', 'nazi_zombie_der_riese'), 'Der Riese')
  assert.equal(D.presenceFor({ game: game({ title: 'x'.repeat(300) }), siteUrl: SITE }).details.length, 128)
})

await test('map picture: the https thumb beside the catalogue art; http site or odd art -> none', () => {
  assert.equal(D.mapImage(SITE, ART), THUMB)
  assert.equal(D.mapImage(SITE + '/', '/media/maps/a_b.webp'), 'https://zombies.enw.gg/media/maps/a_b.thumb.webp')
  assert.equal(D.mapImage('http://127.0.0.1:3200', ART), null)
  assert.equal(D.mapImage(SITE, null), null)
  assert.equal(D.mapImage(SITE, '/etc/passwd'), null)
})

console.log('\nDiscord presence: the pipe')

await test('framing: encode/decode round trip, partial frames wait for the rest', () => {
  const a = D.encode(1, { cmd: 'X', n: 1 }); const b = D.encode(3, { p: 2 })
  const both = Buffer.concat([a, b])
  const r1 = D.decode(both.subarray(0, a.length + 5))
  assert.equal(r1.frames.length, 1); assert.deepEqual(r1.frames[0], { op: 1, data: { cmd: 'X', n: 1 } }); assert.equal(r1.rest.length, 5)
  const r2 = D.decode(Buffer.concat([r1.rest, both.subarray(a.length + 5)]))
  assert.deepEqual(r2.frames, [{ op: 3, data: { p: 2 } }])
  assert.equal(D.validClientId('abc'), null); assert.equal(D.validClientId(CLIENT), CLIENT)
})

// A fake Discord on a real named pipe. `frames` is everything the launcher sent.
function fakeDiscord(pipe, { refuse = false } = {}) {
  const f = { frames: [], sockets: [], connections: 0 }
  f.server = net.createServer((s) => {
    f.connections++
    f.sockets.push(s)
    let buf = Buffer.alloc(0)
    s.on('error', () => {})
    s.on('data', (d) => {
      const r = D.decode(Buffer.concat([buf, d])); buf = r.rest
      for (const fr of r.frames) {
        f.frames.push(fr)
        if (fr.op === 0) {
          if (refuse) { s.write(D.encode(2, { code: 4000, message: 'Invalid Client ID' })); s.end() } else s.write(D.encode(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }))
        }
      }
    })
  })
  f.listen = () => new Promise((r) => f.server.listen(pipe, r))
  f.close = () => new Promise((r) => { for (const s of f.sockets) s.destroy(); f.server.close(() => r()) })
  f.sets = () => f.frames.filter((x) => x.op === 1 && x.data?.cmd === 'SET_ACTIVITY')
  return f
}
const pipeName = () => {
  const tag = crypto.randomBytes(4).toString('hex')
  return process.platform === 'win32' ? (i) => `\\\\?\\pipe\\enw-test-discord-${tag}-${i}` : (i) => path.join(TMP, `d-${tag}-${i}`)
}

await test('handshake with the client id, then SET_ACTIVITY with our pid; the same activity is not resent', async () => {
  const pipe = pipeName(); const f = fakeDiscord(pipe(0)); await f.listen()
  const p = new D.Presence({ clientId: CLIENT, pipe, pipes: 2, minGapMs: 0, pid: 4242 })
  try {
    const act = D.presenceFor({ play: null })
    p.update(act)
    await until(() => f.sets().length === 1, 3000, 'SET_ACTIVITY')
    assert.deepEqual(f.frames[0], { op: 0, data: { v: 1, client_id: CLIENT } })
    assert.deepEqual(f.sets()[0].data.args, { pid: 4242, activity: act })
    assert.ok(f.sets()[0].data.nonce)
    p.update({ ...act }); await sleep(80)
    assert.equal(f.sets().length, 1, 'deduplicated')
    assert.equal(p.status().connected, true)
  } finally { p.stop(); await f.close() }
})

await test('menus -> party -> game -> round -> game exit: each transition sends exactly the new payload (throttle coalesces)', async () => {
  const pipe = pipeName(); const f = fakeDiscord(pipe(0)); await f.listen()
  const p = new D.Presence({ clientId: CLIENT, pipe, pipes: 1, minGapMs: 60 })
  try {
    const seq = [
      D.presenceFor({ play: poll() }),
      D.presenceFor({ play: poll({ party: party(2), map: sumpf }) }),
      D.presenceFor({ game: game(), play: poll({ state: 'playing', party: party(2), map: sumpf, match: { match_id: 'm_1' } }), siteUrl: SITE }),
      D.presenceFor({ game: game(), play: poll({ state: 'playing', party: party(2), map: sumpf, match: { match_id: 'm_1', round: 2 } }), siteUrl: SITE }),
      D.presenceFor({ play: poll({ party: party(2), map: sumpf }) }),
    ]
    for (const a of seq) { p.update(a); await until(() => f.sets().length && JSON.stringify(f.sets().at(-1).data.args.activity) === JSON.stringify(a), 3000, a.details + ' ' + (a.state || '')) }
    assert.deepEqual(f.sets().map((x) => [x.data.args.activity.details, x.data.args.activity.state || '']),
      [['Browsing maps', ''], ['In a party', 'Shi No Numa'], ['Shi No Numa', 'In game'], ['Shi No Numa', 'Round 2'], ['In a party', 'Shi No Numa']])
    // a burst inside the gap sends only the last one
    const before = f.sets().length
    p.update(seq[2]); p.update(seq[3]); p.update(seq[0])
    await until(() => f.sets().length > before, 3000, 'coalesced send'); await sleep(150)
    assert.equal(f.sets().length, before + 1); assert.equal(f.sets().at(-1).data.args.activity.details, 'Browsing maps')
  } finally { p.stop(); await f.close() }
})

await test('setting off: presence cleared at once (SET_ACTIVITY with no activity), pipe closed, no reconnect; on again reconnects', async () => {
  const pipe = pipeName(); const f = fakeDiscord(pipe(0)); await f.listen()
  const p = new D.Presence({ clientId: CLIENT, pipe, pipes: 1, minGapMs: 10_000, backoff: [20, 40] })
  try {
    p.update(D.presenceFor({ play: null }))
    await until(() => f.sets().length === 1, 3000, 'first set')
    p.setEnabled(false)
    await until(() => f.sets().length === 2, 3000, 'the clear (not held back by the 10 s throttle)')
    assert.deepEqual(Object.keys(f.sets()[1].data.args), ['pid'])
    await sleep(200)
    assert.equal(f.connections, 1, 'no reconnect while off'); assert.equal(p.status().connected, false)
    p.update(D.presenceFor({ play: null }))
    await sleep(60); assert.equal(f.connections, 1, 'update while off does not connect')
    p.setEnabled(true)
    await until(() => f.connections === 2 && p.status().connected, 3000, 'reconnect')
  } finally { p.stop(); await f.close() }
})

await test('launcher quit: stop() clears and closes, and never reconnects', async () => {
  const pipe = pipeName(); const f = fakeDiscord(pipe(0)); await f.listen()
  const p = new D.Presence({ clientId: CLIENT, pipe, pipes: 1, minGapMs: 0, backoff: [20, 40] })
  try {
    p.update(D.presenceFor({ game: game(), siteUrl: SITE }))
    await until(() => f.sets().length === 1, 3000, 'set')
    p.stop()
    await until(() => f.sets().length === 2, 3000, 'clear on stop')
    assert.equal(f.sets()[1].data.args.activity, undefined)
    await sleep(200); assert.equal(f.connections, 1)
    p.update(D.presenceFor({ play: null })); p.setEnabled(true); await sleep(100); assert.equal(f.connections, 1)
  } finally { p.stop(); await f.close() }
})

await test('Discord absent: silent no-op, retries back off (doubling, capped), and Discord starting later is picked up', async () => {
  const pipe = pipeName()
  const lines = []
  const p = new D.Presence({ clientId: CLIENT, pipe, pipes: 3, minGapMs: 0, backoff: [30, 120], log: (m) => lines.push(m) })
  try {
    p.update(D.presenceFor({ play: null }))       // must not throw with no Discord
    const times = []
    let last = p.status().attempt
    const t0 = Date.now()
    while (Date.now() - t0 < 700) { const a = p.status().attempt; if (a !== last) { times.push(Date.now()); last = a } await sleep(5) }
    const gaps = times.slice(1).map((t, i) => t - times[i])
    assert.ok(gaps.length >= 3, `retried ${gaps.length + 1} times`)
    // 30, 60, 120, 120, ... (the first change may land before the loop starts)
    assert.ok(gaps[0] < 100, `first gap short: ${gaps}`)
    assert.ok(gaps.some((g) => g >= 45 && g < 100), `a ~60 ms gap (doubling): ${gaps}`)
    assert.ok(gaps.slice(-2).every((g) => g >= 100 && g < 260), `capped at 120 ms: ${gaps}`)
    assert.equal(lines.filter((l) => /not running/.test(l)).length >= 1, true)
    assert.ok(lines.length < 12, `log is not spammed: ${lines.length} lines`)
    // Discord starts, on the SECOND pipe (pipe 0 taken by something else is normal)
    const f = fakeDiscord(pipe(1)); await f.listen()
    try {
      await until(() => f.sets().length === 1, 2000, 'picked up after Discord started')
      assert.equal(p.status().attempt, 0, 'backoff reset once connected')
      // Discord quits: back to retrying, then it comes back and gets the current activity again
      await f.close()
      await until(() => !p.status().connected, 2000, 'noticed Discord quit')
      const g = fakeDiscord(pipe(0)); await g.listen()
      try { await until(() => g.sets().length === 1, 2000, 'resent after Discord came back') } finally { await g.close() }
    } finally { await f.close().catch(() => {}) }
  } finally { p.stop() }
})

await test('no application id: never touches a pipe; an invalid id refused by Discord waits the longest', async () => {
  const pipe = pipeName(); const f = fakeDiscord(pipe(0)); await f.listen()
  const lines = []
  const p = new D.Presence({ clientId: '', pipe, pipes: 1, minGapMs: 0, backoff: [20, 5000], log: (m) => lines.push(m) })
  try {
    p.update(D.presenceFor({ play: null })); await sleep(100)
    assert.equal(f.connections, 0); assert.match(lines.join('\n'), /no Discord application id/)
  } finally { p.stop(); await f.close() }
  const pipe2 = pipeName(); const r = fakeDiscord(pipe2(0), { refuse: true }); await r.listen()
  const q = new D.Presence({ clientId: CLIENT, pipe: pipe2, pipes: 1, minGapMs: 0, backoff: [20, 5000], log: (m) => lines.push(m) })
  try {
    await until(() => r.connections === 1 && q.status().retrying, 2000, 'refused')
    await sleep(300)
    assert.equal(r.connections, 1, 'did not hammer Discord after "Invalid Client ID"')
    assert.match(q.status().lastError, /Invalid Client ID/)
  } finally { q.stop(); await r.close() }
})

await test('ping -> pong with the same payload', async () => {
  const pipe = pipeName(); const f = fakeDiscord(pipe(0)); await f.listen()
  const p = new D.Presence({ clientId: CLIENT, pipe, pipes: 1 })
  try {
    await until(() => p.status().connected, 3000, 'connected')
    f.sockets[0].write(D.encode(3, { hello: 1 }))
    await until(() => f.frames.some((x) => x.op === 4), 3000, 'pong')
    assert.deepEqual(f.frames.find((x) => x.op === 4).data, { hello: 1 })
  } finally { p.stop(); await f.close() }
})

console.log('\nDiscord presence: the setting and the wiring')

await test('setting: on by default, one switch in the shared schema, persisted, carried from the site to the launcher', () => {
  assert.equal(settings.DEFAULT_SETTINGS.discordPresence, true)
  assert.equal(settings.get().discordPresence, true)
  const it = site.ALL.find((i) => i.id === 'discordPresence')
  assert.deepEqual([it.kind, it.to, it.def, it.section], ['toggle', 'key:discordPresence', true, 'enw'])
  assert.equal(site.ALL.filter((i) => /discord/i.test(i.id)).length, 1, 'one switch')
  assert.ok(site.LAUNCHER_KEYS.includes('discordPresence'))
  const patch = site.toLauncherPatch({ ...site.allDefaults(), discordPresence: false })
  assert.equal(patch.discordPresence, false)
  settings.set(patch, '76561190000000001')
  assert.equal(settings.get('76561190000000001').discordPresence, false)
  assert.equal(site.fromLauncher(settings.get('76561190000000001')).discordPresence, false)
  assert.ok(settings.GAME_KEYS.includes('discordPresence'), 'a launcher-side toggle makes its copy the newer one')
})

await test('main.js: presence created after the window, fed by the poll and the flow, honoured on setSettings, cleared on quit; launch path untouched', () => {
  const main = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  assert.match(main, /await createWindow\(\)\r?\n\s+createTray\(\)[\s\S]{0,400}new Presence\(/)
  assert.match(main, /handle\('setSettings', \(patch\) => \{ const s = settings\.set\(patch\); push\('settings', s\); refreshPresence\(\); return s \}\)/)
  assert.match(main, /w\.on\('poll', \(p\) => \{ try \{ onPlay\(p\) \} catch \(e\) \{[^\n]{0,80}\} refreshPresence\(\) \}\)/)
  assert.match(main, /flow\.on\('launched', \(\) => \{ state\.gameStartedAt = Date\.now\(\); refreshPresence\(\) \}\)/)
  assert.match(main, /app\.on\('before-quit'[\s\S]{0,700}state\.presence\?\.stop\(\)/)
  assert.match(main, /function refreshPresence\(\) \{\r?\n\s+try \{/)
  const boot = String(fs.readFileSync(new URL('../src/main/bootflow.js', import.meta.url)))
  assert.doesNotMatch(boot, /discord|presence/i, 'the boot flow knows nothing about Discord')
  const launch = String(fs.readFileSync(new URL('../src/main/launch.js', import.meta.url)))
  assert.doesNotMatch(launch, /discord/i)
})

await test('site: /hello names the application id from ZM_DISCORD_CLIENT_ID, /play carries the round, the map card is past the gate', () => {
  const r = String(fs.readFileSync(new URL('../../web/server/routes/launcher.js', import.meta.url)))
  assert.match(r, /discord_client_id: .*ZM_DISCORD_CLIENT_ID/)
  assert.match(r, /round: \(\(\) => \{ const f = live\.get\(launch\.match_id\)/)
  const gate = String(fs.readFileSync(new URL('../../web/server/middleware/gate.js', import.meta.url)))
  const re = /\^\\\/media\\\/maps\\\/\[a-z0-9_-\]\+\(\\\.thumb\)\?\\\.webp\$/
  assert.match(gate, re)
  const exempt = new RegExp(gate.match(re)[0])
  assert.ok(exempt.test('/media/maps/nazi_zombie_sumpf.thumb.webp'))
  assert.ok(!exempt.test('/media/maps/x.loadscreen.webp') && !exempt.test('/media/avatars/x.webp') && !exempt.test('/media/maps/../x.webp'))
})

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
