#!/usr/bin/env node
// Idle-server auto-close, the decision (lib/idle.js; esc-menu.md §13).
//   node test/idle.js
import { neverJoined, CLOSED_TEXT } from '../lib/idle.js'

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`\x1b[32m ok  \x1b[0m ${name}`) }
  catch (e) { fail++; console.log(`\x1b[31mFAIL \x1b[0m ${name}\n        ${e.message}`) }
}
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || ''}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const MIN = 60_000
const base = { now: 100 * MIN, readyAt: 100 * MIN - 5 * MIN, admitted: false, connected: 0, hold: false, readyMs: 5 * MIN }

t('m_5a28dcbe: ready 5 min, nobody ever joined -> closed, no_players / never_joined', () => {
  const d = neverJoined(base)
  eq([d.reason, d.rule], ['no_players', 'never_joined'])
})
t('4 min 59 s after ready: not yet', () => eq(neverJoined({ ...base, now: base.now - 1000 }), null))
t('not ready yet (booting, loading the map, a map pull): the clock has not started', () => eq(neverJoined({ ...base, readyAt: null }), null))
t('somebody was admitted this run: never this rule (the referee\'s "all gone" close is the other half)', () => eq(neverJoined({ ...base, admitted: true }), null))
t('a player connected (joining, not yet admitted): never', () => eq(neverJoined({ ...base, connected: 1 }), null))
t('the site says a join is in progress (a download, a Resume): held', () => eq(neverJoined({ ...base, hold: true }), null))
t('a finished run is not closed twice', () => eq(neverJoined({ ...base, finished: true }), null))
t('--idle-ready-ms 0 turns it off', () => eq(neverJoined({ ...base, readyMs: 0 }), null))
t('configurable: 2 min', () => eq(neverJoined({ ...base, readyMs: 2 * MIN, readyAt: base.now - 2 * MIN })?.rule, 'never_joined'))
t('the launcher text is terse', () => eq([CLOSED_TEXT.never_joined, CLOSED_TEXT.all_gone], ['Server closed: nobody joined.', 'Server closed: everyone left.']))

console.log(`\nidle: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
