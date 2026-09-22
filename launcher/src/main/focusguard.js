// Never steal focus from a running game.
//
// EVIDENCE: B reports mouse clicks disappearing mid-game. In the Q3 lineage — and WaW
// is one — a focus flap makes the engine deactivate the mouse and throw away the
// button events that arrive around it. B played WINDOWED (the borderless bug this
// pass also fixes), so the Electron launcher window sits on the same desktop as the
// game and a `show()` + `focus()` from this process lands straight on top of it.
//
// Three places could do that WHILE A GAME IS RUNNING and none of them is the player
// asking: a deep link (follow-the-leader and party invites arrive exactly while he is
// in a game), the Steam sign-in callback, and a second launch of the app forwarding
// its argv. All three now go through the raiser below.
//
// The tray menu and the tray click are deliberately NOT routed through it: those are
// the player at the keyboard, asking for the window, and they are correct as they are.
//
// The raise is DEFERRED, not dropped — the window comes up once the game is gone, so a
// party invite that arrived mid-game is still in front of the player afterwards.

export function makeWindowRaiser({ win = () => null, busy = () => false, log = () => {} } = {}) {
  let pending = null

  function raise(why = 'no reason given') {
    const w = win()
    if (busy()) {
      pending = why
      log(`not raising the window for ${why}: a game is running and taking focus from World at War loses mouse clicks — it will come up when the game ends`)
      return { raised: false, deferred: true, why }
    }
    if (!w) return { raised: false, deferred: false, why, reason: 'no window' }
    w.show?.()
    w.focus?.()
    return { raised: true, deferred: false, why }
  }

  // Called when the flow ends (and from clear()). Idempotent: the second call has
  // nothing pending and does nothing.
  function flush() {
    if (!pending) return { raised: false, why: null }
    const why = pending
    pending = null
    const w = win()
    if (!w) return { raised: false, why, reason: 'no window' }
    w.show?.()
    w.focus?.()
    log(`the game has ended; raising the window now for ${why}`)
    return { raised: true, why }
  }

  return { raise, flush, get pending() { return pending } }
}
