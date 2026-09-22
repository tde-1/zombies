import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useRail } from '../rail'
import { mapHue, prettyTitle } from '../data/mapText'
import { bridge, useUpdateStatus, useLauncherStatus, useInstalledMaps, fmtSize, clampPct } from './launcherBridge'
import { DlBar } from './MapDownload'

// /settings → ENW, inside the launcher only (launcher 0.2.11). Two boxes:
//
//   Launcher   the version line and the update button, with the nav chip's phases:
//              Check for updates → Update 0.2.11 [Update now] → Updating [bar] 37% →
//              [Restart now]. The wording comes from the launcher (updatecheck.js).
//
//   Installed maps  B: "a list of maps you have installed with a picture, the name of the
//              map, the title, and how many gigabytes it is. You can select them and
//              uninstall/remove them. Sort by size. In a little box." Only maps ENW
//              installed, under %LOCALAPPDATA%\ENWZombies (launcher library.installedList);
//              the player's own World at War mods are never listed, so never removable.

export function LauncherUpdateBox() {
  const enw = bridge()
  const u = useUpdateStatus()
  const st = useLauncherStatus()
  const [checking, setChecking] = useState(false)
  if (!enw || !enw.updateNow) return null
  const version = (st && st.status && st.status.appVersion) || (u && u.current) || '?'
  const phase = u ? u.phase : 'idle'
  const check = async () => {
    setChecking(true)
    try { await enw.checkForUpdates() } catch { /* the status line says why */ }
    setChecking(false)
  }
  let action = null
  if (phase === 'ready' && u.canInstall !== false) {
    action = <button type="button" className="btn small accent" onClick={() => enw.restartAndUpdate().catch(() => {})}>Restart now</button>
  } else if (phase === 'downloading') {
    action = <div className="dlrow slim"><DlBar pct={clampPct(u.percent)} label="Updating" /></div>
  } else if (u && u.available && phase !== 'checking') {
    action = <button type="button" className="btn small accent" onClick={() => enw.updateNow().catch(() => {})}>{phase === 'available' ? 'Update now' : 'Retry'}</button>
  } else {
    action = (
      <button type="button" className="btn small" onClick={check} disabled={checking || phase === 'checking'}>
        {checking || phase === 'checking' ? 'Checking…' : 'Check for updates'}
      </button>
    )
  }
  const line = u && u.message && phase !== 'downloading' ? u.message : ''
  // Drawn as one of EnwSection's little sections (Gaff's shape, web-settings-2).
  return (
    <div className="set-group">
      <div className="set-section"><span>update</span></div>
      <div className="set-item">
        <div className="set-row">
          <span className="set-label">launcher {version}</span>
          {action}
        </div>
        {line && <div className={'set-hint' + (phase === 'failed' || phase === 'unreachable' ? ' hot' : '')}>{line}</div>}
      </div>
    </div>
  )
}

export function InstalledMapsBox() {
  const { supported, list, remove } = useInstalledMaps()
  const R = useRail()
  const [sel, setSel] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [extra, setExtra] = useState({}) // key -> {title, art} for maps the rail's pool lacks

  const keys = useMemo(() => (list || []).map((m) => m.bsp), [list])
  useEffect(() => {
    // Drop selections for maps that are gone.
    setSel((s) => new Set([...s].filter((k) => keys.includes(k))))
    const pool = R && R.poolByKey
    const missing = keys.filter((k) => !(pool && pool.get(k)) && !extra[k])
    if (!missing.length) return
    let live = true
    Promise.all(missing.map((k) => api.get(`/api/maps/${encodeURIComponent(k)}`).then((j) => [k, j.map]).catch(() => [k, null])))
      .then((pairs) => { if (live) setExtra((e) => { const n = { ...e }; for (const [k, m] of pairs) n[k] = m || { title: null, art: null }; return n }) })
    return () => { live = false }
  }, [keys.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!supported) return null
  const toggle = (k) => setSel((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const total = (list || []).reduce((n, m) => n + (m.bytes || 0), 0)
  const selBytes = (list || []).filter((m) => sel.has(m.bsp)).reduce((n, m) => n + (m.bytes || 0), 0)
  const allOn = list && list.length > 0 && sel.size === list.length

  const doRemove = async () => {
    const ks = [...sel]
    if (!ks.length) return
    const names = ks.map((k) => titleOf(k)).join(', ')
    if (!window.confirm(`Remove ${ks.length === 1 ? names : `${ks.length} maps (${names})`}? ${fmtSize(selBytes)} is freed. You can download ${ks.length === 1 ? 'it' : 'them'} again.`)) return
    setBusy(true); setNote('')
    try {
      const out = await remove(ks)
      const bad = (out || []).filter((r) => !r.ok)
      setNote(bad.length ? `Not removed: ${bad.map((r) => `${titleOf(r.bsp)} (${r.why || 'could not'})`).join(', ')}` : `Removed ${ks.length === 1 ? names : `${ks.length} maps`}.`)
      setSel(new Set())
    } catch (e) { setNote(e.message) }
    setBusy(false)
  }

  function infoOf(k) {
    const p = R && R.poolByKey && R.poolByKey.get(k)
    return p || extra[k] || null
  }
  function titleOf(k) {
    const row = (list || []).find((m) => m.bsp === k)
    const i = infoOf(k)
    return prettyTitle((i && i.title) || (row && row.title) || k, k)
  }

  // One of EnwSection's little sections; the list itself is the "little box" B asked for.
  return (
    <div className="set-group">
      <div className="set-section">
        <span>installed maps</span>
        <span className="imaps-total mono">{list ? `${list.length} · ${fmtSize(total)}` : '…'}</span>
      </div>
      {!list ? <div className="set-hint">reading the map folder…</div>
        : list.length === 0 ? <div className="set-hint">no maps downloaded yet. a map's Download button puts one here.</div>
          : (
            <div className="lbox">
              <div className="imaps" role="listbox" aria-multiselectable="true" aria-label="Installed maps">
                {list.map((m) => {
                  const i = infoOf(m.bsp)
                  const on = sel.has(m.bsp)
                  return (
                    <label key={m.bsp} className={'imap' + (on ? ' on' : '')} role="option" aria-selected={on}>
                      <input type="checkbox" checked={on} onChange={() => toggle(m.bsp)} disabled={busy || m.installing} />
                      <span className="imap-art" style={{ '--h': String(mapHue(m.bsp)) }}>
                        {i && i.art ? <img src={i.art} alt="" loading="lazy" decoding="async" /> : <span>{String(m.bsp).replace(/^nazi_zombie_/, '').slice(0, 3)}</span>}
                      </span>
                      <span className="imap-text">
                        <Link to={`/m/${encodeURIComponent(m.bsp)}`} className="imap-title" onClick={(e) => e.stopPropagation()}>{titleOf(m.bsp)}</Link>
                        <span className="imap-key mono">{m.bsp}</span>
                      </span>
                      <span className="imap-size mono">{m.installing ? <DlBar pct={null} /> : fmtSize(m.bytes)}</span>
                    </label>
                  )
                })}
              </div>
              <div className="lbox-row">
                <button type="button" className="btn small ghost" disabled={busy}
                        onClick={() => setSel(allOn ? new Set() : new Set(list.filter((m) => !m.installing).map((m) => m.bsp)))}>
                  {allOn ? 'Select none' : 'Select all'}
                </button>
                <button type="button" className="btn small danger" disabled={busy || sel.size === 0} onClick={doRemove}>
                  {busy ? 'Removing…' : sel.size ? `Remove ${sel.size} · ${fmtSize(selBytes)}` : 'Remove'}
                </button>
                {note && <span className="tiny muted">{note}</span>}
              </div>
            </div>
          )}
    </div>
  )
}
