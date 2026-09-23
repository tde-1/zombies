'use strict'

// Lane R4 (replay.md §13): the replay viewer's follow-target reducer (client/src/replay3d/
// spectate.js) -- who the camera follows in a co-op replay, and how.
//
//   node test/replay-spectate.js
//
// spectate.js is ESM with no three.js and no DOM, imported straight into node the way
// replay-fx.js imports fx.js. The co-op track case builds the 4-player fixture
// (fixtures/coop-events.js) through the real track builder.

const path = require('path')
const url = require('url')
const { buildTrack } = require('../server/routes/replay')
const { coopEvents } = require('./fixtures/coop-events.js')

let pass = 0
let fail = 0
const out = []
async function check(name, fn) {
  try { await fn(); pass++; out.push(['ok  ', name]) } catch (e) { fail++; out.push(['FAIL', `${name} — ${e.message}`]) }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const same = (a, b, what) => eq(JSON.stringify(a), JSON.stringify(b), what)

const P = (slot, alive = true) => ({ slot, name: `P${slot}`, alive })
const FOUR = [P(0), P(1), P(2), P(3)]

async function main() {
  const S = await import(url.pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'replay3d', 'spectate.js')).href)
  const run = (s, ...acts) => acts.reduce((st, a) => S.spectate(st, a), s)

  await check('init: the first player, third person (today\'s default)', () => {
    same(S.initSpectate({ players: [P(2), P(0)] }), { focus: 2, mode: 'follow', view: 'follow' })
    same(S.initSpectate(null), { focus: 0, mode: 'follow', view: 'follow' })
  })

  await check('select: clicking a row changes who; from free cam it starts following the last view', () => {
    const s0 = S.initSpectate({ players: FOUR })
    same(run(s0, { type: 'select', slot: 2 }), { focus: 2, mode: 'follow', view: 'follow' })
    const fp = run(s0, { type: 'mode', mode: 'eyes' }, { type: 'free' }, { type: 'select', slot: 3, players: FOUR })
    same(fp, { focus: 3, mode: 'eyes', view: 'eyes' }, 'free -> click -> first person again')
    const s1 = run(s0, { type: 'select', slot: 9, players: FOUR })
    eq(s1, s0, 'an unknown slot is ignored (same object)')
    eq(run(s0, { type: 'select', slot: 0 }), s0, 'clicking the followed row is a no-op')
  })

  await check('number keys 1-4 pick panel rows in co-op; 1/2/3 stay camera modes in solo', () => {
    same(S.keyAction('Digit1', { coop: true, mode: 'follow' }), { type: 'index', n: 0 })
    same(S.keyAction('Numpad4', { coop: true, mode: 'follow' }), { type: 'index', n: 3 })
    eq(S.keyAction('Digit5', { coop: true, mode: 'follow' }), null)
    same(S.keyAction('Digit1', { coop: false, mode: 'follow' }), { type: 'mode', mode: 'eyes' })
    same(S.keyAction('Digit2', { coop: false, mode: 'eyes' }), { type: 'mode', mode: 'follow' })
    same(S.keyAction('Digit3', { coop: false, mode: 'eyes' }), { type: 'mode', mode: 'free' })
    eq(S.keyAction('Digit4', { coop: false, mode: 'eyes' }), null)
    const s = run(S.initSpectate({ players: FOUR }), { type: 'index', n: 2, players: FOUR })
    eq(s.focus, 2)
    eq(run(s, { type: 'index', n: 3, players: [P(0), P(1)] }), s, 'no 4th player in a 2-player game')
  })

  await check('cycle: Q/E and [ ] wrap in panel order, both ways', () => {
    let s = S.initSpectate({ players: FOUR })
    const seen = []
    for (let k = 0; k < 5; k++) { s = S.spectate(s, { type: 'cycle', dir: 1, players: FOUR }); seen.push(s.focus) }
    same(seen, [1, 2, 3, 0, 1])
    s = S.spectate(s, { type: 'cycle', dir: -1, players: FOUR })
    s = S.spectate(s, { type: 'cycle', dir: -1, players: FOUR })
    eq(s.focus, 3, 'back past 0 wraps to 3')
    same(S.keyAction('KeyE', { coop: true, mode: 'eyes' }), { type: 'cycle', dir: 1 })
    same(S.keyAction('BracketLeft', { coop: true, mode: 'free' }), { type: 'cycle', dir: -1 })
  })

  await check('cycle skips downed players while anybody else is up, and falls back when nobody is', () => {
    const ps = [P(0), P(1, false), P(2), P(3, false)]
    let s = S.initSpectate({ players: ps })
    s = S.spectate(s, { type: 'cycle', dir: 1, players: ps }); eq(s.focus, 2)
    s = S.spectate(s, { type: 'cycle', dir: 1, players: ps }); eq(s.focus, 0)
    const allDown = [P(0), P(1, false), P(2, false)]
    s = S.spectate(S.initSpectate({ players: allDown }), { type: 'cycle', dir: 1, players: allDown.map((p) => ({ ...p, alive: false })) })
    eq(s.focus, 1, 'everybody down: the next one anyway')
    // a number key still reaches a downed player on purpose
    eq(run(S.initSpectate({ players: ps }), { type: 'index', n: 1, players: ps }).focus, 1)
  })

  await check('F toggles first/third person, and from free cam goes back to the last one', () => {
    let s = S.initSpectate({ players: FOUR })
    s = S.spectate(s, { type: 'toggle-view' }); same(s, { focus: 0, mode: 'eyes', view: 'eyes' })
    s = S.spectate(s, { type: 'toggle-view' }); same(s, { focus: 0, mode: 'follow', view: 'follow' })
    s = run(s, { type: 'toggle-view' }, { type: 'free' })
    same(s, { focus: 0, mode: 'free', view: 'eyes' })
    same(S.spectate(s, { type: 'toggle-view' }), { focus: 0, mode: 'eyes', view: 'eyes' })
    same(S.keyAction('KeyF', { coop: false, mode: 'follow' }), { type: 'toggle-view' })
  })

  await check('Esc lets go to free cam; in free cam Q/E are the fly keys, not a cycle', () => {
    same(S.keyAction('Escape', { coop: true, mode: 'follow' }), { type: 'free' })
    eq(S.keyAction('Escape', { coop: true, mode: 'free' }), null, 'nothing to do: let the page have it')
    eq(S.keyAction('KeyQ', { coop: true, mode: 'free' }), null)
    eq(S.keyAction('KeyE', { coop: true, mode: 'free' }), null)
    eq(S.keyAction('KeyE', { coop: false, mode: 'follow' }), null, 'solo: nobody to cycle to')
    eq(S.keyAction('KeyW', { coop: true, mode: 'follow' }), null)
    const s = run(S.initSpectate({ players: FOUR }), { type: 'select', slot: 3 }, { type: 'free' })
    same(s, { focus: 3, mode: 'free', view: 'follow' }, 'focus kept for the way back')
    same(S.spectate(s, { type: 'cycle', dir: 1, players: FOUR }), { focus: 0, mode: 'follow', view: 'follow' }, '] from free cam: next player, following')
  })

  await check('the top rail\'s buttons set the mode and remember the view', () => {
    let s = S.initSpectate({ players: FOUR })
    s = S.spectate(s, { type: 'mode', mode: 'eyes' }); same(s, { focus: 0, mode: 'eyes', view: 'eyes' })
    s = S.spectate(s, { type: 'mode', mode: 'free' }); same(s, { focus: 0, mode: 'free', view: 'eyes' })
    eq(S.spectate(s, { type: 'mode', mode: 'bogus' }), s)
  })

  await check('downed: the camera stays on him, the prompt offers the next player who is up', () => {
    const ps = [P(0), P(1, false), P(2, false), P(3)]
    same(S.downPrompt(ps, 1, 'follow'), { slot: 1, name: 'P1', next: { slot: 3, name: 'P3' } })
    same(S.downPrompt(ps, 2, 'eyes'), { slot: 2, name: 'P2', next: { slot: 3, name: 'P3' } })
    eq(S.downPrompt(ps, 0, 'follow'), null, 'he is up')
    eq(S.downPrompt(ps, 1, 'free'), null, 'free cam: nobody is followed')
    eq(S.downPrompt([P(0, false)], 0, 'follow'), null, 'solo keeps today\'s view')
    same(S.downPrompt([P(0, false), P(1, false)], 0, 'follow'), { slot: 0, name: 'P0', next: null }, 'nobody up: no offer')
    // being down does not move the camera on its own
    const s = run(S.initSpectate({ players: ps }), { type: 'select', slot: 1 })
    eq(s.focus, 1)
    const t = S.spectate(s, { type: 'next-alive', players: ps })
    same(t, { focus: 3, mode: 'follow', view: 'follow' })
    eq(S.spectate(s, { type: 'next-alive', players: [P(0, false), P(1, false)] }), s, 'nobody up: stays')
  })

  await check('the panel header: who, and how, or free cam; nothing in solo', () => {
    same(S.followLabel(FOUR, { focus: 2, mode: 'eyes' }), { free: false, text: 'P2', view: 'First person' })
    same(S.followLabel(FOUR, { focus: 2, mode: 'follow' }), { free: false, text: 'P2', view: 'Third person' })
    eq(S.followLabel(FOUR, { focus: 2, mode: 'free' }).text, 'Free cam')
    eq(S.followLabel([P(0)], { focus: 0, mode: 'follow' }), null)
  })

  await check('the follow target persists across a seek or a pause (nothing time-shaped in the state)', () => {
    const s = run(S.initSpectate({ players: FOUR }), { type: 'select', slot: 2 }, { type: 'toggle-view' })
    // the viewer's seek / play / pause never dispatch; an unknown action is the identity
    eq(S.spectate(s, { type: 'seek', t: 12 }), s)
    eq(S.spectate(s, { type: 'pause' }), s)
    same(Object.keys(s).sort(), ['focus', 'mode', 'view'])
  })

  await check('the co-op fixture: 4 players through the real track builder, slot 2 down then up, slot 3 down to the end', () => {
    const track = buildTrack('x.enwr', { readHeader: () => ({ header: { match_id: 'm_f0f0f0f2', map: 'nazi_zombie_prototype' } }), readEvents: () => coopEvents() }, 20)
    eq(track.players.length, 4)
    const at = (slot, ms) => {
      const p = track.players.find((q) => q.slot === slot)
      // the fixture snaps every 50 ms from t0, and the track is asked for at 20 Hz
      const k = Math.max(0, Math.min(track.ticks - 1, Math.round((ms - (track.t0_ms || 0)) / track.tick_ms)))
      return { slot, name: p.name, alive: p.alive[k] === 1 }
    }
    const list = (ms) => [0, 1, 2, 3].map((s) => at(s, ms))
    eq(S.downPrompt(list(3000), 2, 'follow'), null, 'slot 2 up at 3 s')
    same(S.downPrompt(list(8000), 2, 'follow'), { slot: 2, name: 'Fixture Three', next: { slot: 3, name: 'Fixture Four' } })
    eq(S.downPrompt(list(13000), 2, 'follow'), null, 'revived at 12 s')
    same(S.downPrompt(list(17000), 3, 'eyes').next, { slot: 0, name: 'Fixture One' })
  })

  for (const [s, n] of out) console.log(`${s} ${n}`)
  console.log(`\nreplay-spectate: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
