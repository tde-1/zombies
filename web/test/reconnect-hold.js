'use strict'
// Disconnect -> pause -> reconnect, the site's half (2026-09-24; host lib/referee.js drop hold,
// web.md "2026-09-24 cloud: disconnect pause + reconnect"):
//
//   * the box's live-frame POST is answered with who QUIT each posted match on purpose, so the
//     box never holds a game for a quit (seats.quittersFor, POST /api/gs/live `quit`);
//   * the live frame keeps the referee's `away` list, and live.hold() turns it into what the
//     rail's server card shows (`hold` on GET /api/party and GET /api/launcher/play);
//   * the card's words (client/src/holdLabel.js);
//   * a rejoin does not void an ENW-Verified record (B 2026-09-24: flag it, decide later).
//
//   node test/reconnect-hold.js
//
// A throwaway database and one Express app on 127.0.0.1; nothing else.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { pathToFileURL } = require('node:url')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-reconnect-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')
process.env.ZM_STEAM_AVATARS = 'off'

const express = require('express')
const boxes = require('../server/lib/boxes')
const seats = require('../server/lib/seats')
const live = require('../server/lib/live')
const records = require('../server/lib/records')

let pass = 0, fail = 0
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok    ${name}`) } catch (e) { fail++; console.log(`FAIL  ${name} — ${e.message}`) }
}
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }

const P1 = '76561198000000001'
const P2 = '76561198000000002'
const frame = (players, extra = {}) => ({ phase: 'live', players: players.map(([steamid, connected]) => ({ steamid, connected, name: steamid.slice(-2) })), ...extra })

async function main() {
  const { holdLabel, clock } = await import(pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'holdLabel.js')).href)

  await check('seats.quittersFor: only a quit on purpose, and a restarted run finds its lease', () => {
    const m = 'm_rc1'
    seats.observe(m, frame([[P1, true], [P2, true]]))
    eq(seats.quittersFor(m), [], 'nobody quit yet')
    seats.observe(m, frame([[P1, true], [P2, false]]))
    eq(seats.quittersFor(m), [], 'a drop (crash, Alt+F4) is not a quit')
    seats.quit(P2, m)
    eq(seats.quittersFor(m), [P2])
    eq(seats.quittersFor(`${m}.r1`), [P2], 'the run id `<lease>.r1` is the same lease')
    eq(seats.quittersFor('m_other'), [])
  })

  await check('live frames keep who the game is paused for, bounded', () => {
    const ok = live.push('box', { match_id: 'm_rc2', state: frame([[P1, true], [P2, false]], {
      paused: true,
      away: [{ name: 'P2name-that-is-far-too-long-to-keep-around', steamid: P2, slot: 1, left_ms: 170_000, returning: false, extra: 'x' }],
    }) })
    truthy(ok)
    const f = live.get('m_rc2')
    eq(f.state.away.length, 1)
    eq(f.state.away[0].name.length, 32, 'names are clamped')
    eq(f.state.away[0].left_ms, 170_000)
    eq(f.state.away[0].extra, undefined, 'nothing unknown is kept')
    eq(live.get('m_rc_none'), null)
  })

  await check('live.hold: who, how long (aged by the frame), and whether it is the viewer', () => {
    const f = live.get('m_rc2')
    f.at -= 10_000   // the frame is ten seconds old
    const h = live.hold('m_rc2', P1)
    eq(h.paused, true)
    eq(h.away[0].you, false)
    truthy(h.away[0].left_ms <= 160_000 && h.away[0].left_ms > 150_000, `left_ms aged: ${h.away[0].left_ms}`)
    eq(live.hold('m_rc2', P2).away[0].you, true, 'the one who dropped sees it is them')
    eq(live.hold('m_rc2.r1', P1).away.length, 1, 'a restarted run id resolves to the lease')
    live.push('box', { match_id: 'm_rc3', state: frame([[P1, true]]) })
    eq(live.hold('m_rc3', P1), null, 'nobody away, no hold')
  })

  await check('the server card\'s words', () => {
    eq(clock(170_000), '2:50'); eq(clock(0), '0:00'); eq(clock(59_001), '1:00')
    eq(holdLabel(null), null)
    eq(holdLabel({ paused: true, away: [] }), null)
    eq(holdLabel({ paused: true, away: [{ name: 'Bex', left_ms: 161_000 }] }), 'Bex disconnected · paused, waiting to reconnect (2:41)')
    eq(holdLabel({ paused: true, away: [{ name: 'A', left_ms: 90_000 }, { name: 'B', left_ms: 30_000 }] }), '2 players disconnected · paused, waiting to reconnect (0:30)')
    eq(holdLabel({ paused: true, away: [{ name: 'Bex', left_ms: 100_000, returning: true }] }), 'Paused · Bex is loading back in')
    eq(holdLabel({ paused: true, away: [{ name: 'Me', left_ms: 125_000, you: true }] }), 'Paused for you · 2:05 to rejoin')
    eq(holdLabel({ paused: true, away: [{ name: 'Me', left_ms: 125_000, you: true, returning: true }] }), 'Paused for you · loading back in')
    // The box could not freeze (ENW_NO_PAUSE): never say paused.
    eq(holdLabel({ paused: false, away: [{ name: 'Bex', left_ms: 161_000 }] }), 'Bex disconnected · waiting to reconnect (2:41)')
    eq(holdLabel({ paused: false, away: [{ name: 'Me', left_ms: 125_000, you: true }] }), 'Your place is kept · 2:05 to rejoin')
    eq(holdLabel({ paused: false, away: [{ name: 'Bex', left_ms: 1, returning: true }] }), 'Bex is loading back in')
  })

  // B 2026-09-24: "put a rejoin flag on the database and decide later" -- no rejoin voids a
  // record for now; games.rejoined holds it (test/party-carryover.js checks the column).
  await check('ENW-Verified: no rejoin voids the record (yet): rejoined, resumed, rejoined_while_down', () => {
    const base = { mode: 'verified', flags: ['crash_pause', 'rejoined'] }
    eq(records.PROFILES['ENW-Verified'].check(base), [], 'a plain rejoin')
    eq(records.PROFILES['ENW-Verified'].check({ ...base, flags: [...base.flags, 'resumed'] }), [], 'resumed')
    eq(records.PROFILES['ENW-Verified'].check({ ...base, flags: [...base.flags, 'rejoined_while_down'] }), [], 'while down')
  })

  // ---- the route --------------------------------------------------------------------
  boxes.create({ name: 'rc-box', matchKey: 'rc-secret', maxInstances: 4 })
  const app = express()
  app.use('/api/gs', require('../server/routes/gameserver').router())
  const srv = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${srv.address().port}/api/gs`
  const post = (p, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const r = http.request(base + p, { method: 'POST', agent: false, headers: { 'x-match-secret': 'rc-secret', 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let t = ''
      res.on('data', (c) => { t += c })
      res.on('end', () => { let j = null; try { j = JSON.parse(t) } catch {} resolve({ status: res.statusCode, body: j }) })
    })
    r.on('error', reject)
    r.write(data)
    r.end()
  })

  await check('POST /api/gs/live answers with who quit each posted match, and only then', async () => {
    const r1 = await post('/live', { instances: [{ instance: 'inst-01', match_id: 'm_rc4', state: frame([[P1, true], [P2, true]]) }] })
    eq(r1.status, 200)
    eq(r1.body.quit, undefined, 'nobody quit: no `quit` at all')
    seats.quit(P2, 'm_rc4')
    await new Promise((r) => setTimeout(r, live.MIN_FRAME_MS + 10))
    const r2 = await post('/live', { instances: [{ instance: 'inst-01', match_id: 'm_rc4', state: frame([[P1, true], [P2, false]]) }, { instance: 'inst-02', match_id: 'm_rc5', state: frame([[P1, true]]) }] })
    eq(r2.body.quit, { m_rc4: [P2] }, 'named for its own match only')
  })

  srv.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
