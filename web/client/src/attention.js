import { useEffect } from 'react'
import { socket } from './socket'
import { toAttention } from './attentionEvents'

// GETTING THE PLAYER'S ATTENTION FROM THE LAUNCHER (lane SOC, 2026-09-23).
//
// B: "If ENW Zombies is minimised, it should flash the taskbar and make a noise. Same if you
// get a private message or party chat while not focused."
//
// The site already hears everything first: inside the launcher this page IS the launcher's
// connection to the site (its socket.io socket), so an invite or a DM reaches it the moment
// it is sent, window visible or not. What the page cannot know is whether its window is
// minimised, in the tray or behind the game, and it cannot flash a taskbar or show a
// Windows toast. So it hands the event to the launcher (`window.enw.attention`, preload)
// and the launcher decides (launcher/src/main/attention.js): focused = nothing, a game
// running = nothing (the in-game overlay already shows it), otherwise flash + one chime per
// burst + a toast with Accept for an invite, and the tray's unread dot.
//
// In a plain browser there is no `window.enw` and this does nothing: the site's own toasts
// (InviteToasts.jsx) are the whole of it there.
//
// Never for your own lines, never for system notices (attentionEvents.js, pure, so
// web/test/friends.js runs it under node).

/** Mounted once, by the rail's provider, for the signed-in player. */
export function useLauncherAttention(meId) {
  useEffect(() => {
    const bridge = typeof window !== 'undefined' && window.enw && typeof window.enw.attention === 'function'
      ? window.enw.attention : null
    if (!bridge || !meId) return undefined
    const make = (event) => (payload) => {
      const ev = toAttention(event, payload, meId)
      if (ev) Promise.resolve(bridge(ev)).catch(() => { /* an older launcher: no attention handler */ })
    }
    const onInvite = make('invite_received')
    const onLine = make('chat-private')
    socket.on('invite_received', onInvite)
    socket.on('chat-private', onLine)
    return () => { socket.off('invite_received', onInvite); socket.off('chat-private', onLine) }
  }, [meId])
}
