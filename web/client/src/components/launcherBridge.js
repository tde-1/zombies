import { useEffect, useState } from 'react'

// THE LAUNCHER'S OWN BAR IS GONE (B, 2026-09-22). The launcher window is frameless and the
// site IS its chrome: this nav bar is the title bar (drag region), and the three window
// buttons sit at its right. Everything the old green strip did that still matters lives on
// the site now - Settings and the client / update status in the account menu, sign-in
// through the launcher's own Steam round trip, reload on Ctrl+R / F5 (main process).
//
// `window.enw` is the preload bridge (launcher/src/preload/preload.cjs). The window
// controls need `window.enw.win`; the header-only signal (`me.launcher`) cannot minimise
// anything, so it is not enough to draw them. In a plain browser none of this renders.

export const bridge = () => (typeof window !== 'undefined' && window.enw) || null
export const hasWindowControls = () => !!(bridge() && bridge().win)

// Tag <html> once so the CSS can turn the nav into a drag region only inside the launcher.
if (hasWindowControls()) {
  try { document.documentElement.classList.add('in-launcher') } catch { /* no DOM */ }
}

// Launcher status for the account menu: is the ENW client installed, which launcher
// version, and where the update check is. Null outside the launcher.
export function useLauncherStatus() {
  const [st, setSt] = useState(null)
  useEffect(() => {
    const enw = bridge()
    if (!enw || !enw.status) return undefined
    let live = true
    const read = async () => {
      let status = null
      let update = null
      try { status = await enw.status() } catch { /* older launcher */ }
      try { update = enw.updateStatus ? await enw.updateStatus() : null } catch { /* no feed yet */ }
      if (live) setSt({ status, update })
    }
    read()
    const offs = []
    if (enw.onUpdateStatus) offs.push(enw.onUpdateStatus((u) => live && setSt((s) => ({ ...(s || {}), update: u }))))
    if (enw.onSettings) offs.push(enw.onSettings(read))
    if (enw.onSite) offs.push(enw.onSite(read))
    return () => { live = false; offs.forEach((off) => { try { off && off() } catch { /* gone */ } }) }
  }, [])
  return st
}

// One line for the menu, in the launcher's plain voice.
export function describeLauncher(st) {
  if (!st) return null
  const s = st.status || {}
  const installed = s.setup?.installed
  const version = s.appVersion || null
  const u = st.update || null
  // updatecheck.js's own phases and its own sentence (`describe`), so the words match
  // what the launcher's Settings screen says.
  let update = null
  if (u && u.phase && u.phase !== 'idle') update = u.message || u.phase
  const updateReady = !!(u && u.phase === 'ready' && u.canInstall !== false)
  return {
    client: installed ? 'ENW client installed' : 'ENW client not installed',
    installed: !!installed,
    version,
    update,
    updateReady,
  }
}
