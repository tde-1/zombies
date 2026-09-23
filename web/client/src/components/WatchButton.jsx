import { Link } from 'react-router-dom'
import './watch.css'

// Watch — ENW Movement's button beside a record row (movement-client/src/replay3d/
// WatchButton.jsx, `btn btn-sm r3d-watch`). One click opens the replay viewer.
//
// Movement opens its viewer as a modal and pushes /watch/... into the address bar. Ours
// is already a route of its own (/replay/:matchId, replay.md §7a) and stays one, so the
// button is a link straight to it: one click, no game page in between, and the address
// is the shareable link Movement's right-click "Copy link" gives (the browser's own
// right-click does that here).
//
// Renders nothing when the row has no replay, as Movement's does.
export default function WatchButton({ matchId, replay = true, className = '', label }) {
  if (!matchId || !replay) return null
  return (
    <Link className={'btn btn-sm r3d-watch' + (className ? ' ' + className : '')}
          to={`/replay/${encodeURIComponent(matchId)}`}
          title={label ? `Watch: ${label}` : 'Watch'}
          onClick={(e) => e.stopPropagation()}>
      Watch
    </Link>
  )
}
