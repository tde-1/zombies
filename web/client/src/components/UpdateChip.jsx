import { bridge, useUpdateStatus, chipPhase, clampPct } from './launcherBridge'
import { DlBar } from './MapDownload'

// ── The update chip, top right (B, 2026-09-22, launcher 0.2.11) ────────────────────────
//
// "The launcher should detect updates, show it top right, and say Update now / Restart
// now / Update later." Before this the only way to an update was the account menu, and
// the night B could not click the nav he could not reach it at all.
//
//   Update 0.2.11   [Update now]  Later       the launch-time check found it
//   Updating  ━━━━━━━━━━━━  37%                 Update now pressed
//   Update 0.2.11 ready  [Restart now]  Later  downloaded
//
// "Later" hides it until the launcher next starts; the launcher holds that (updatecheck.js
// `later`), so a reload or the fallback page does not bring it back. The launcher's own
// fallback page (launcher/src/renderer/placeholder.html) draws the same chip, so an update
// is reachable when the site is not. A browser never sees any of this.
export default function UpdateChip() {
  const u = useUpdateStatus()
  const phase = chipPhase(u)
  if (!phase) return null
  const enw = bridge()
  const v = (u && (u.downloaded || u.available)) || ''
  const now = () => enw.updateNow().catch(() => {})
  const later = () => enw.updateLater().catch(() => {})
  const restart = () => enw.restartAndUpdate().catch(() => {})

  if (phase === 'downloading') {
    return (
      <div className="upd-chip" role="status" aria-live="polite">
        <DlBar pct={clampPct(u.percent)} label="Updating" className="upd-bar" />
      </div>
    )
  }
  return (
    <div className="upd-chip" role="status" aria-live="polite" title={u.message || ''}>
      <span className="upd-label">
        {phase === 'ready' ? <>Update <b>{v}</b> ready</> : phase === 'failed' ? 'Update failed' : <>Update <b>{v}</b></>}
      </span>
      {phase === 'ready'
        ? <button type="button" className="upd-btn" onClick={restart}>Restart now</button>
        : <button type="button" className="upd-btn" onClick={now}>{phase === 'failed' ? 'Retry' : 'Update now'}</button>}
      <button type="button" className="upd-later" onClick={later}>Later</button>
    </div>
  )
}
