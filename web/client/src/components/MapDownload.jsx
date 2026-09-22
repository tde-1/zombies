import { usePlayGate } from './playGate'
import { useMapInstall, clampPct } from './launcherBridge'

// ── Download, separate from Play (B, 2026-09-22, launcher 0.2.11) ──────────────────────
//
// "On the map page, a Download button separate from Play. It just downloads, so you can
// play later without downloading while waiting in the party. Concise wording, like
// Movement." Three words and a bar: Download → Downloading [bar] 37% → Downloaded.
//
// It is the launcher's install path (the same `installMap` → `ensureMapInstalled` Play
// uses, so a Download and a later Play share one download and never race). In a browser
// there is nothing to download INTO, so the button goes to /download carrying the map,
// exactly as Play does (components/playGate.js).

// The slim bar B asked for: "a bar in the downloading thing next to the percentage, before
// the percentage". Used by the rail's party rows, the map page, the server card and the
// installed-maps box, so a download looks the same wherever it shows. `pct` null means
// "started, size not known yet" and the bar runs indeterminate.
export function DlBar({ pct, label = null, className = '' }) {
  const known = pct != null
  const v = known ? clampPct(pct) : 0
  return (
    <span className={'dlbar ' + className} role="progressbar" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={known ? v : undefined} aria-label={label || 'Download progress'}>
      {label && <span className="dlbar-label">{label}</span>}
      <span className={'dlbar-track' + (known ? '' : ' indeterminate')}><i style={known ? { width: `${v}%` } : undefined} /></span>
      <span className="dlbar-pct">{known ? `${v}%` : '…'}</span>
    </span>
  )
}

// The map page's button, beside Play. Same height as the page's other big buttons; while it
// runs it becomes a row the height of the rail's online-player rows with the bar in it.
export function DownloadButton({ mapKey, then = null }) {
  const { guard } = usePlayGate()
  const d = useMapInstall(mapKey)

  if (d.phase === 'browser') {
    return (
      <button className="btn big" onClick={() => guard({ map: mapKey, then: then || `/m/${mapKey}` })}>
        Download
      </button>
    )
  }
  if (d.phase === 'downloading') {
    return <div className="dlrow"><DlBar pct={d.pct} label="Downloading" /></div>
  }
  if (d.phase === 'installed') {
    return (
      <button className="btn big dl-done" disabled title={d.stock ? 'Ships with World at War' : 'On this PC. Remove it in Settings → ENW.'}>
        <CheckMark /> Downloaded
      </button>
    )
  }
  return (
    <span className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
      <button className="btn big" onClick={d.download} disabled={d.phase === 'unknown' || d.phase === 'theirs'}
              title={d.phase === 'theirs' ? 'A copy that ENW did not install is already in its folder' : 'Download now, play later'}>
        {d.phase === 'failed' ? 'Retry download' : 'Download'}
      </button>
      {d.phase === 'failed' && d.error && <span className="tiny hot dl-err">{d.error}</span>}
    </span>
  )
}

// The rail's server card, small: a line under the map name. Nothing in a browser (the
// card's Play already goes to /download there) and nothing before a map is picked.
export function CardDownload({ mapKey }) {
  const d = useMapInstall(mapKey)
  if (!mapKey || !d.supported || d.phase === 'unknown') return null
  if (d.phase === 'downloading') return <div className="prail-dl"><DlBar pct={d.pct} /></div>
  if (d.phase === 'installed') return <div className="prail-dl done"><CheckMark /> Downloaded</div>
  if (d.phase === 'theirs') return null
  return (
    <div className="prail-dl">
      <button className="prail-dl-btn" onClick={d.download} title={d.error || 'Download now, play later'}>
        {d.phase === 'failed' ? 'Retry download' : 'Download'}
      </button>
    </div>
  )
}

export function CheckMark() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" className="dl-check">
      <path d="M2 6.5l2.6 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
