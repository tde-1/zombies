import { useEffect, useState } from 'react'
import { bridge, hasWindowControls } from './launcherBridge'

// Minimise / maximise-restore / close for the frameless launcher window, drawn into the
// site's own nav bar (B, 2026-09-22: "nothing launcher-specific above the site"). Only
// inside the launcher, where the preload bridge carries `enw.win`; a browser tab gets
// nothing. Glyphs are Windows' own shapes at the site's stroke weight; close goes the
// site's one red on hover, the others take the nav links' panel wash.
export default function WindowControls() {
  const [max, setMax] = useState(false)
  useEffect(() => {
    if (!hasWindowControls()) return undefined
    const w = bridge().win
    let live = true
    w.isMaximized().then((m) => live && setMax(!!m)).catch(() => {})
    const off = w.onState ? w.onState((s) => live && setMax(!!(s && s.maximized))) : null
    return () => { live = false; try { off && off() } catch { /* gone */ } }
  }, [])
  if (!hasWindowControls()) return null
  const w = bridge().win
  return (
    <div className="wc" role="group" aria-label="Window">
      <button type="button" className="wc-btn" onClick={() => w.minimize()} aria-label="Minimise" title="Minimise">
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button type="button" className="wc-btn" onClick={() => w.maximize().then((m) => setMax(!!m)).catch(() => {})}
              aria-label={max ? 'Restore' : 'Maximise'} title={max ? 'Restore' : 'Maximise'}>
        {max
          ? <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          : <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>}
      </button>
      <button type="button" className="wc-btn wc-close" onClick={() => w.close()} aria-label="Close" title="Close">
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
    </div>
  )
}
