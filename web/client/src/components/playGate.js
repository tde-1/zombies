import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../session'

// THE PLAY GATE (B, 2026-09-22).
//
// "Any action that would put a player into a game — Play, Play Local, Start, Join / Find a
// game, accepting an invite — when done in a NORMAL BROWSER must take the user to /download
// instead, with the map/party context preserved."
//
// Nothing in a browser tab can start World at War. Before this, every one of those buttons
// was a request that either failed on the server or succeeded into a party the person had no
// way to join, and the site never said the one thing that was actually wrong: you need the
// launcher. The gate says it, and it says it about the map you were looking at.
//
// ── How we know we are inside the launcher ─────────────────────────────────────────────
// Two signals, and both are needed:
//
//   `window.enw`          the preload bridge. It is the one that can actually LAUNCH
//                         something, so it is the one that decides. Client-side only.
//   `me.launcher`         the server's reading of the `X-ENW-Launcher` header the wrapped
//                         view stamps on every request (`server/routes/me.js`). True before
//                         any client JS has run, which is what a first-paint decision needs.
//
// Either is enough to stand down. They can disagree honestly — a launcher whose preload
// failed still sends the header, and a dev page opened straight in Electron has the bridge
// and no header — and in both of those the person HAS the launcher, which is the question
// the gate is asking.
//
// ── The deep link ──────────────────────────────────────────────────────────────────────
// The launcher registers **`enw-zombies`** (hyphenated) and implements exactly two routes —
// `docs/protocol/launcher-v0.md` §7, which the launcher lane wrote and shipped on the same
// day. Both of the ones this page needs already exist, so nothing here is waiting on
// anybody:
//
//   enw-zombies://map/<bsp key>    selects the map and shows its card. It deliberately does
//                                  NOT auto-play and does NOT auto-install: the player
//                                  presses Play, in the app, having seen what they are
//                                  about to download.
//   enw-zombies://party/<id>       opens /party/<id> in the wrapped view and lets the SITE
//                                  decide whether this player may join.
//
// **Not `enwzombies://` and not `.../play/<key>`.** The unhyphenated scheme is §3's older
// spelling — still parsed by the launcher, explicitly not the one to build against — and
// `play/` is a route of that older form which §7 does not carry. Sending either would work
// on a launcher built from today's source and fail on one installed from the NSIS package,
// because `build.protocols` registers the hyphenated scheme and only that.

export const PROTOCOL = 'enw-zombies'

/**
 * `enw-zombies://map/<key>` or `enw-zombies://party/<id>`, and the bare scheme for neither.
 *
 * The party wins when both are present: somebody turned away from a party's Start button
 * wants the party, and the map is only how the page names it.
 */
export function deepLink(intent) {
  if (!intent) return `${PROTOCOL}://`
  if (intent.party) return `${PROTOCOL}://party/${encodeURIComponent(intent.party)}`
  if (intent.map) return `${PROTOCOL}://map/${encodeURIComponent(intent.map)}`
  return `${PROTOCOL}://`
}

/**
 * Where /download should send this person, as a query string. The map or party is carried
 * so the page can say "install the launcher to play Clinic of Evil" rather than "install the
 * launcher", and so its own "Open in launcher" button has something to open.
 *
 * `then` is a SITE PATH and is only ever built here, from values the caller already holds —
 * nothing a URL handed us reaches it, and the page refuses anything that is not a path
 * beginning with a single `/` (see Download.jsx).
 */
export function downloadHref(intent = {}) {
  const qs = new URLSearchParams()
  if (intent.map) qs.set('map', intent.map)
  if (intent.party) qs.set('party', String(intent.party))
  if (intent.then) qs.set('then', intent.then)
  if (intent.label) qs.set('label', intent.label)
  const s = qs.toString()
  return `/download${s ? `?${s}` : ''}`
}

/**
 * `const { inLauncher, guard } = usePlayGate()`
 *
 * `guard(intent)` returns TRUE when it has taken the person to /download — the caller must
 * then do nothing else. It returns FALSE inside the launcher, and the caller carries on
 * exactly as it did before. That shape is deliberate: every call site reads
 * `if (guard(...)) return`, which is one line and impossible to half-apply.
 */
export function usePlayGate() {
  const { session } = useSession()
  const nav = useNavigate()
  const inLauncher = (typeof window !== 'undefined' && !!window.enw) || !!(session && session.launcher)
  const guard = useCallback((intent = {}) => {
    if (inLauncher) return false
    nav(downloadHref(intent))
    return true
  }, [inLauncher, nav])
  return { inLauncher, guard }
}
