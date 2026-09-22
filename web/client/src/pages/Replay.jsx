// /replay/:matchId -- the 3D replay page.
//
// It is its own route rather than a modal over the game page because a replay link is
// a thing people paste (13 §2d makes the same argument for /m/<map>), and because the
// viewer wants the whole viewport: three.js at a device pixel ratio of 2 inside a
// 700px card is most of the cost of a full screen for none of the picture.
//
// The viewer chunk carries three.js, so it is lazy: a visitor who never opens a replay
// never downloads a renderer. Same rule App.jsx already applies to the admin console.
import { lazy, Suspense, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../api'

const ReplayViewer = lazy(() => import('../replay3d/ReplayViewer.jsx'))

// Exported map geometry, served from a git-ignored ZombiesDev path by
// web/server/routes/replay.js. A stock map is a game asset and never enters the repo.
//
// `?v=<built_at>` is the cache key. The .glb is 38 MB and is served `immutable` for a
// year, which is right for a file that only changes when somebody re-exports the map —
// and wrong the moment somebody does, because the URL would not have changed. The
// sidecar's `built_at` comes down with the track (`map_export`), so a re-export is a new
// URL for every browser at once and there is no stale-bytes window to reason about.
const q = (v) => (v ? `?v=${encodeURIComponent(v)}` : '')
const mapUrl = (bsp, v) => `/mapdata/${encodeURIComponent(bsp)}/${encodeURIComponent(bsp)}.glb${q(v)}`
const metaUrl = (bsp, v) => `/mapdata/${encodeURIComponent(bsp)}/${encodeURIComponent(bsp)}.meta.json${q(v)}`

export default function Replay() {
  const { matchId } = useParams()
  const [track, setTrack] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let dead = false
    setTrack(null)
    setErr(null)
    api.get(`/api/replay/${encodeURIComponent(matchId)}/track?hz=10`)
      .then((t) => !dead && setTrack(t))
      .catch((e) => !dead && setErr(e.message))
    return () => { dead = true }
  }, [matchId])

  if (err) {
    return (
      <div className="page">
        <h1>That replay can&rsquo;t be played</h1>
        <p className="sub">{err}</p>
        <Link className="btn" to={`/game/${encodeURIComponent(matchId)}`} style={{ marginTop: 16 }}>Back to the game</Link>
      </div>
    )
  }

  return (
    // Fixed under the nav rather than a negative-margin escape from .page's padding:
    // the margin trick has to know the padding, and it was wrong by 16px on the left
    // the first time. 100dvh, not 100vh -- on a phone the browser chrome eats the
    // bottom of a 100vh element and takes the control bar with it.
    <div style={{ position: 'fixed', left: 0, right: 0, top: 56, bottom: 0 }}>
      <Suspense fallback={<div className="r3d" />}>
        {track && (() => {
          // A map with no export is not an error: the actors, the timeline, the rounds
          // and the scores are all in the track, and they are most of what a replay is
          // for. The viewer is told there is no geometry rather than being left to find
          // out by failing to fetch it.
          const ex = track.map_export || {}
          const v = ex.built_at || null
          return (
            <ReplayViewer
              track={track}
              mapUrl={ex.glb === false ? null : mapUrl(track.map, v)}
              metaUrl={ex.glb === false ? null : metaUrl(track.map, v)}
              title={track.map_name}
            />
          )
        })()}
      </Suspense>
    </div>
  )
}
