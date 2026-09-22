import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useSession } from '../session'
import { toLauncherPatch, fromLauncher, newer } from '../data/wawSettings'
import { chipPhase, clampPct, fmtSize, bySizeDesc } from './launcherFormat'

export { chipPhase, clampPct, fmtSize }

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

// ── 0.2.11: updates, map downloads, installed maps ─────────────────────────────────────
//
// B: "The launcher should detect updates, show it top right, and say Update now / Restart
// now / Update later"; "a Download button separate from Play"; "a list of maps you have
// installed ... sort by size". All three are the launcher's to do (it holds the files and
// the updater); the site draws them through the bridge. An older launcher that lacks a
// call gets nothing drawn rather than a button that throws.

// The update checker's state (launcher/src/main/updatecheck.js), pushed, never polled.
export function useUpdateStatus() {
  const [u, setU] = useState(null)
  useEffect(() => {
    const enw = bridge()
    if (!enw || !enw.updateStatus || !enw.updateNow) return undefined
    let live = true
    enw.updateStatus().then((s) => { if (live) setU(s) }).catch(() => {})
    const off = enw.onUpdateStatus ? enw.onUpdateStatus((s) => { if (live) setU(s) }) : null
    return () => { live = false; try { off && off() } catch { /* gone */ } }
  }, [])
  return u
}

// One map's install state for a Download button. `supported` is false outside the
// launcher (or on one too old for `mapState`), and the button then goes to /download.
export function useMapInstall(key) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const enw = bridge()
  const supported = !!(enw && enw.mapState && enw.installMap)
  useEffect(() => {
    if (!supported || !key) { setSt(null); return undefined }
    let live = true
    const read = () => enw.mapState(key).then((s) => { if (live) setSt(s) }).catch(() => {})
    read()
    const offs = []
    if (enw.onMapProgress) {
      offs.push(enw.onMapProgress((p) => {
        if (!live || !p || p.bsp !== key) return
        const total = p.total || 0
        const done = p.done ?? p.bytes ?? 0
        setSt((s) => ({ ...(s || { bsp: key }), installing: true, done, total, pct: total ? Math.floor((done / total) * 100) : 0, error: null }))
      }))
    }
    if (enw.onMapState) offs.push(enw.onMapState((s) => { if (live && s && s.bsp === key) read() }))
    return () => { live = false; offs.forEach((off) => { try { off && off() } catch { /* gone */ } }) }
  }, [key, supported]) // eslint-disable-line react-hooks/exhaustive-deps

  const download = async () => {
    if (!supported || !key) return
    setBusy(true)
    setSt((s) => ({ ...(s || { bsp: key }), installing: true, pct: (s && s.pct) || 0, error: null }))
    try {
      const r = await enw.installMap(key)
      if (r && r.skipped && !r.already) setSt((s) => ({ ...(s || {}), installing: false, error: r.skipped }))
    } catch (e) {
      setSt((s) => ({ ...(s || {}), installing: false, error: String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }))
    }
    setBusy(false)
    try { setSt(await enw.mapState(key)) } catch { /* keep what we have */ }
  }

  const phase = !supported ? 'browser'
    : !st ? 'unknown'
      : st.installed ? 'installed'
        : (st.installing || busy) ? 'downloading'
          : st.theirs ? 'theirs'
            : st.error ? 'failed' : 'absent'
  return { supported, phase, pct: st && st.pct != null ? clampPct(st.pct) : null, error: st && st.error, stock: !!(st && st.stock), download }
}

// Settings → Installed maps: the launcher's list (largest first), refreshed when a map
// is installed or removed anywhere.
export function useInstalledMaps() {
  const enw = bridge()
  const supported = !!(enw && enw.installedMaps && enw.removeMaps)
  const [list, setList] = useState(null)
  const read = useCallback(() => {
    if (!supported) return
    enw.installedMaps().then((r) => setList(bySizeDesc((r && r.maps) || []))).catch(() => setList([]))
  }, [supported]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!supported) return undefined
    read()
    const off = enw.onMapState ? enw.onMapState(() => read()) : null
    return () => { try { off && off() } catch { /* gone */ } }
  }, [supported, read]) // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async (keys) => {
    const out = await enw.removeMaps(keys)
    read()
    return out
  }
  return { supported, list, remove, refresh: read }
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
  // After "Later" the chip is gone until the next launch; the menu keeps the way back.
  const updateAvailable = !!(u && u.available && !updateReady && u.phase !== 'downloading')
  return {
    updateAvailable,
    client: installed ? 'ENW client installed' : 'ENW client not installed',
    installed: !!installed,
    version,
    update,
    updateReady,
  }
}

// The Settings page's `game` object lives in two places - the account on the site and the
// launcher's own settings file, which is what the launch reads - and the newer one wins.
// The launcher's is newer after a game in which the player changed something in the
// game's own menus (the post-exit read-back); the site's after an edit on /settings in a
// browser. This runs on every signed-in load inside the launcher, and again whenever the
// launcher says its settings changed, so neither copy is stale at the next Play.
export function GameSettingsSync() {
  const { signedIn, session, refresh } = useSession()
  const siteGame = (session && session.user && session.user.settings && session.user.settings.game) || null
  const stamp = siteGame ? Number(siteGame.updatedAt) || 0 : 0
  useEffect(() => {
    const enw = bridge()
    if (!signedIn || !enw || !enw.getSettings || !enw.setSettings) return undefined
    let live = true
    const sync = async () => {
      try {
        const L = await enw.getSettings()
        const who = newer(siteGame || { updatedAt: 0 }, L)
        if (!live || who === 'same') return
        if (who === 'site' && siteGame) await enw.setSettings(toLauncherPatch(siteGame))
        else if (who === 'launcher') {
          const g = { ...(siteGame || {}), ...fromLauncher(L), waw: { ...((siteGame && siteGame.waw) || {}), ...((L && L.waw) || {}) }, wawBinds: { ...((siteGame && siteGame.wawBinds) || {}), ...((L && L.wawBinds) || {}) } }
          await api.put('/api/me/settings', { game: g })
          refresh()
        }
      } catch { /* an older launcher, or signed out mid-way: the next load tries again */ }
    }
    sync()
    const off = enw.onSettings ? enw.onSettings(() => sync()) : null
    return () => { live = false; try { off && off() } catch { /* gone */ } }
  }, [signedIn, stamp]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}
