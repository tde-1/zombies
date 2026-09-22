// The boot screen: black, the ENW mark, and either a spinner or a real progress bar.
//
// It is what a replay surface shows while it has nothing to show — until the replay, the map
// geometry and the sky have all resolved. Three surfaces draw it now (the viewer, the modal's
// lazy-import fallback, and the map page's Route card), so it is one component and one set of
// styles (.r3d-boot, theme.css) rather than three that drift.
//
// `state` is 'on' | 'out' | 'off': 'out' fades it (the caller drops it a frame later), 'off'
// draws nothing. `progress` is 0..1 while a measurable download is running — the map glb is
// most of the wait and a spinner says nothing about it — and null when it is not measurable.

import enwMark from './enw-mark.png'

export default function Boot({ state = 'on', progress = null, className = '' }) {
  if (state === 'off') return null
  return (
    <div className={'r3d-boot' + (state === 'out' ? ' out' : '') + (className ? ' ' + className : '')} aria-hidden="true">
      <img className="r3d-boot-mark" src={enwMark} alt="" width={74} height={36} />
      {progress == null
        ? <span className="r3d-boot-spin" />
        : <span className="r3d-boot-bar"><span className="r3d-boot-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></span>}
    </div>
  )
}
