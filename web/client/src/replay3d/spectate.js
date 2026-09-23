// Lane R4 (replay.md §13): who the replay camera follows, and how. A pure reducer -- no
// three.js, no DOM, no React -- so web/test/replay-spectate.js imports it straight into node.
//
// State: { focus, mode, view }
//   focus  the slot being watched (the HUD, crosshair, hit marker, blood and first-person gun
//          are all his; ReplayViewer reads it through focusRef as before)
//   mode   'eyes' | 'follow' | 'free' -- the camera mode scene.js is in
//   view   the last following mode ('eyes' | 'follow'), so leaving free cam (a click on a player,
//          F, a number key, a cycle) goes back to how you were watching
//
// Nothing here knows about time, so a seek or a pause can never change it: the follow target
// persists across both by construction.
//
// The pattern is Movement's RoutePlayer (CSGO-Matchmaker movement-client/src/replay3d): a list
// you click to pick, a key to cycle, Escape to let go. Movement has one runner per replay, so the
// multi-player parts (number keys, alive-first cycling, the down prompt) are new.

export const FOLLOW_VIEWS = ['eyes', 'follow']
export const MODES = ['eyes', 'follow', 'free']

export function initSpectate(track) {
  const p = track && Array.isArray(track.players) && track.players[0]
  return { focus: p ? p.slot : 0, mode: 'follow', view: 'follow' }
}

// Co-op is more than one player in the recording. A solo replay keeps the viewer's old keys
// (1/2/3 = first person / third person / free cam).
export const isCoop = (players) => Array.isArray(players) && players.length > 1

// "Up" is `up` when the viewer has worked it out (the snapshot's alive AND no open `down` event,
// see downSpans), else the snapshot's `alive`.
const aliveOf = (p) => !!(p && (p.up !== undefined ? p.up : p.alive))

// Down windows per player from the feed events: a `down` opens one, a `revive` of him or his next
// `player_spawn` closes it; a `bleedout` leaves it open (he is out until he spawns again). This
// is on top of the snapshot's `alive`, because whether the DLL reports a player in last stand as
// not alive is unproven (replay.md §9.6: the track does not say downed vs dead).
// Returns Map slot -> [[fromMs, toMs|Infinity], ...].
export function downSpans(events) {
  const out = new Map()
  const open = new Map()
  for (const e of Array.isArray(events) ? events : []) {
    if (e == null || !Number.isFinite(e.slot) || !Number.isFinite(e.ms)) continue
    if (e.t === 'down') {
      if (!open.has(e.slot)) open.set(e.slot, e.ms)
    } else if (e.t === 'revive' || e.t === 'player_spawn') {
      if (open.has(e.slot)) {
        if (!out.has(e.slot)) out.set(e.slot, [])
        out.get(e.slot).push([open.get(e.slot), e.ms])
        open.delete(e.slot)
      }
    }
  }
  for (const [slot, from] of open) {
    if (!out.has(slot)) out.set(slot, [])
    out.get(slot).push([from, Infinity])
  }
  return out
}

export function isDownAt(spans, slot, ms) {
  const s = spans && spans.get(slot)
  if (!s) return false
  for (const [a, b] of s) if (ms >= a && ms < b) return true
  return false
}

// The next player after `focus` in `dir` (+1 / -1), wrapping, in panel order. Alive players
// first: a downed one is skipped while anybody else is up. With nobody else up, the next one
// regardless. Returns null when there is no other player.
export function nextPlayer(players, focus, dir = 1, aliveOnly = false) {
  if (!Array.isArray(players) || !players.length) return null
  const n = players.length
  let at = players.findIndex((p) => p.slot === focus)
  if (at < 0) at = dir > 0 ? -1 : 0
  const step = dir < 0 ? -1 : 1
  let fallback = null
  for (let k = 1; k <= n; k++) {
    const p = players[(((at + step * k) % n) + n) % n]
    if (p.slot === focus) continue
    if (aliveOf(p)) return p
    if (!fallback) fallback = p
  }
  return aliveOnly ? null : fallback
}

const following = (s) => (s.mode === 'free' ? s.view : s.mode)

export function spectate(state, action) {
  const s = state || { focus: 0, mode: 'follow', view: 'follow' }
  if (!action) return s
  switch (action.type) {
    // A click (or tap) on a panel row. From free cam it starts following, the "click to
    // follow" half of the ask; while following it only changes who.
    case 'select': {
      const { slot, players } = action
      if (Array.isArray(players) && !players.some((p) => p.slot === slot)) return s
      const mode = following(s)
      if (slot === s.focus && mode === s.mode) return s
      return { ...s, focus: slot, mode }
    }
    // Number keys 1-4 in co-op: the nth row of the panel.
    case 'index': {
      const p = Array.isArray(action.players) ? action.players[action.n] : null
      if (!p) return s
      return spectate(s, { type: 'select', slot: p.slot })
    }
    // Q/E, [ and ]: the next / previous player, alive first.
    case 'cycle': {
      const p = nextPlayer(action.players, s.focus, action.dir)
      if (!p) return s.mode === 'free' ? { ...s, mode: s.view } : s
      return { ...s, focus: p.slot, mode: following(s) }
    }
    // The down prompt's button: the next player who is up, or nothing.
    case 'next-alive': {
      const p = nextPlayer(action.players, s.focus, 1, true)
      if (!p) return s
      return { ...s, focus: p.slot, mode: following(s) }
    }
    // F: first person <-> third person. From free cam, back to the last of the two.
    case 'toggle-view': {
      if (s.mode === 'free') return { ...s, mode: s.view }
      const mode = s.mode === 'eyes' ? 'follow' : 'eyes'
      return { ...s, mode, view: mode }
    }
    // Escape: free cam, keeping who and how, for the way back.
    case 'free':
      return s.mode === 'free' ? s : { ...s, mode: 'free' }
    // The top rail's three buttons, and the solo keys.
    case 'mode': {
      if (!MODES.includes(action.mode) || action.mode === s.mode) return s
      return { ...s, mode: action.mode, view: action.mode === 'free' ? s.view : action.mode }
    }
    default:
      return s
  }
}

// Keyboard -> action (or null: not ours). `coop` changes what the digits mean; Q/E cycle only
// while following, because in free cam they are scene.js's fly down / up (Movement's keys).
export function keyAction(code, { coop, mode }) {
  const d = /^(?:Digit|Numpad)([1-9])$/.exec(code)
  if (d) {
    const n = Number(d[1])
    if (coop) return n <= 4 ? { type: 'index', n: n - 1 } : null
    if (/^Digit/.test(code) && n <= 3) return { type: 'mode', mode: MODES[n - 1] }
    return null
  }
  switch (code) {
    case 'KeyF': return { type: 'toggle-view' }
    case 'Escape': return mode === 'free' ? null : { type: 'free' }
    case 'BracketLeft': return coop ? { type: 'cycle', dir: -1 } : null
    case 'BracketRight': return coop ? { type: 'cycle', dir: 1 } : null
    case 'KeyQ': return coop && mode !== 'free' ? { type: 'cycle', dir: -1 } : null
    case 'KeyE': return coop && mode !== 'free' ? { type: 'cycle', dir: 1 } : null
    default: return null
  }
}

// The followed player is down: the camera stays on him, the viewer marks it, and offers the next
// player who is up. Co-op only (solo keeps today's view), never in free cam. `next` is null when
// nobody else is up (the prompt then only says he is down).
export function downPrompt(players, focus, mode) {
  if (!isCoop(players) || mode === 'free') return null
  const p = players.find((q) => q.slot === focus)
  if (!p || aliveOf(p)) return null
  const n = nextPlayer(players, focus, 1, true)
  return { slot: p.slot, name: p.name, next: n ? { slot: n.slot, name: n.name } : null }
}

// What the panel's header line says (co-op only).
export function followLabel(players, s) {
  if (!isCoop(players)) return null
  if (s.mode === 'free') return { free: true, text: 'Free cam', hint: 'Click a player to follow' }
  const p = players.find((q) => q.slot === s.focus)
  return { free: false, text: p ? p.name : `slot ${s.focus}`, view: s.mode === 'eyes' ? 'First person' : 'Third person' }
}
