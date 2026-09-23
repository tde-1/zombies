// Getting the player's attention when the launcher is not in front (lane SOC, 2026-09-23).
//
// B: "Update instantly in the launcher -- we have the tray icon. If ENW Zombies is minimised,
// it should flash the taskbar and make a noise. Same if you get a private message or party
// chat while not focused."
//
// WHERE THE EVENT COMES FROM. The wrapped site's own socket (web client attention.js): the
// page hears an invite, a DM or a party line the moment it is sent, whether the window is
// visible or not, and calls `window.enw.attention(ev)`. Nothing here polls the site.
//
// WHAT THIS DECIDES (and only this; main.js owns the Electron objects):
//
//   window in front (visible, not minimised, focused)   nothing: the site's own toast shows it
//   a game is running                                   nothing: the in-game overlay shows it,
//                                                       and a taskbar flash or a chime over a
//                                                       game is exactly the double-notify B
//                                                       said not to do (and focusguard.js's
//                                                       reason: never disturb a running game)
//   otherwise                                           unread +1 (tray dot + taskbar overlay),
//                                                       flashFrame(true) until focused, ONE
//                                                       chime per burst (setting on), a Windows
//                                                       toast for an invite (with Accept), and
//                                                       for a DM / party line only while the
//                                                       window is hidden in the tray (no taskbar
//                                                       button there to flash), once per burst
//
// A burst: a signal within BURST_MS of the previous one is the same burst, so a party
// chatting away is one chime, not ten; a long conversation still chimes every MAX_QUIET_MS.
// Your own lines never reach here (the page drops them) and are refused again below.

export const BURST_MS = 4000
export const MAX_QUIET_MS = 30_000
const KINDS = new Set(['invite', 'dm', 'party'])

export function inFront(w) {
  try {
    if (!w || (w.isDestroyed && w.isDestroyed())) return false
    return !!(w.isVisible() && !w.isMinimized() && w.isFocused())
  } catch { return false }
}

// Closed to the tray: hidden and not minimised (a minimised window may report visible or
// not depending on the platform; either way it has a taskbar button).
export function onlyInTray(w) {
  try {
    if (!w || (w.isDestroyed && w.isDestroyed())) return true
    return !w.isVisible() && !w.isMinimized()
  } catch { return true }
}

export function makeAttention({
  win = () => null,
  gameRunning = () => false,
  soundOn = () => true,
  streamer = () => false,
  chime = () => {},
  toast = () => {},
  badge = () => {},
  now = () => Date.now(),
  log = () => {},
} = {}) {
  let unread = 0
  let lastSignal = -Infinity
  let lastChime = -Infinity
  const seen = []                      // recent event ids, so a double delivery is one signal

  function signal(ev = {}) {
    const kind = String(ev.kind || '')
    if (!KINDS.has(kind)) return { skipped: 'unknown kind' }
    if (ev.self) return { skipped: 'own message' }
    const id = ev.id ? String(ev.id) : null
    if (id) {
      if (seen.includes(id)) return { skipped: 'duplicate' }
      seen.push(id); if (seen.length > 200) seen.shift()
    }
    const w = win()
    if (inFront(w)) return { skipped: 'focused' }
    if (gameRunning()) return { skipped: 'in game' }

    const t = now()
    const newBurst = t - lastSignal >= BURST_MS || t - lastChime >= MAX_QUIET_MS
    lastSignal = t

    unread = Math.min(99, unread + 1)
    try { badge(unread) } catch (e) { log(`badge failed: ${e.message}`) }

    // In the tray (hidden, not minimised) there is no taskbar button to flash.
    const inTray = onlyInTray(w)
    let flashed = false
    try { if (w && !inTray) { w.flashFrame(true); flashed = true } } catch (e) { log(`flash failed: ${e.message}`) }

    let chimed = false
    if (newBurst) {
      lastChime = t
      if (soundOn()) { try { chime(); chimed = true } catch (e) { log(`chime failed: ${e.message}`) } }
    }

    // Streamer mode (settings.js) hides who is inviting and what they said.
    const hide = !!streamer()
    let toasted = false
    if (kind === 'invite' || (inTray && newBurst)) {
      const title = hide ? (kind === 'invite' ? 'You have a party invite' : 'New message') : String(ev.title || 'ENW Zombies').slice(0, 80)
      const body = hide ? 'Open ENW Zombies to see it.' : String(ev.body || '').slice(0, 160)
      try {
        toast({ kind, title, body, invite_id: kind === 'invite' ? Number(ev.invite_id) || null : null, party_id: ev.party_id || null })
        toasted = true
      } catch (e) { log(`toast failed: ${e.message}`) }
    }
    log(`${kind} while not in front: unread ${unread}${flashed ? ', flashed' : ''}${chimed ? ', chimed' : ''}${toasted ? ', toast' : ''}`)
    return { flashed, chimed, toasted, unread }
  }

  // The window came to the front: everything has been seen.
  function focused() {
    const w = win()
    try { if (w) w.flashFrame(false) } catch {}
    if (unread) { unread = 0; try { badge(0) } catch {} }
  }

  return { signal, focused, get unread() { return unread } }
}

// A small red dot drawn onto an image's bitmap (BGRA on Windows, RGBA elsewhere; red is
// red in both only if we write both orders the same, so the dot is written per platform).
// Pure over a Buffer so the test can check it without Electron.
export function dotBitmap(buf, width, height, { bgra = process.platform === 'win32' } = {}) {
  const out = Buffer.from(buf)
  const r = Math.max(2, Math.round(Math.min(width, height) * 0.22))
  const cx = width - r - 1
  const cy = r + 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d > r + 0.5) continue
      const i = (y * width + x) * 4
      const edge = d > r - 0.8
      const R = edge ? 255 : 225, G = edge ? 255 : 55, B = edge ? 255 : 45
      if (bgra) { out[i] = B; out[i + 1] = G; out[i + 2] = R } else { out[i] = R; out[i + 1] = G; out[i + 2] = B }
      out[i + 3] = 255
    }
  }
  return out
}

// The Windows toast for an invite: Accept is a protocol activation of our own scheme
// (deeplink.js `enw-zombies://invite/<id>`), which reaches the running launcher through its
// single-instance hand-off; the toast body opens the launcher. Silent, because the chime is
// ours and follows the Notification sound setting. Everything interpolated is escaped.
const esc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])

export function toastXml({ kind, title, body, invite_id: inviteId }) {
  const actions = kind === 'invite' && Number.isInteger(inviteId) && inviteId > 0
    ? `<actions><action content="Accept" activationType="protocol" arguments="enw-zombies://invite/${inviteId}"/>`
      + '<action content="Dismiss" activationType="system" arguments="dismiss"/></actions>'
    : ''
  return '<toast launch="enw-zombies://open" activationType="protocol">'
    + `<visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual>`
    + actions
    + '<audio silent="true"/></toast>'
}
