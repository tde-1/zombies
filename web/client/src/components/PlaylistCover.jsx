import { Link } from 'react-router-dom'
import { mapHue } from '../data/mapText'

// A playlist as one card: a mosaic of its first four maps, the name, how many maps it holds.
// COPIED FROM MOVEMENT, `movement-client/src/components/PlaylistCover.jsx` (classes and CSS
// verbatim). Two changes: the tiles are our maps' own thumbs (Movement builds a banner from a
// key), and it is a Link to /playlists/<slug> rather than a button with a navigate.
// `done` is Movement's green left edge — every map in it beaten.
export default function PlaylistCover({ playlist }) {
  const maps = (playlist.maps || []).slice(0, 4)
  const hue = maps.length ? mapHue(maps[0].key) : 40
  const n = playlist.map_count != null ? playlist.map_count : (playlist.maps || []).length
  const done = playlist.progress && playlist.progress.total > 0 && playlist.progress.done >= playlist.progress.total
  return (
    <Link className={'pl-cover' + (done ? ' done' : '')} style={{ '--h': String(hue) }} to={`/playlists/${playlist.slug}`}>
      <span className={'pl-mosaic n' + maps.length}>
        {maps.map((m) => (
          <span className="pl-tile" key={m.key}>
            {(m.thumb || m.art) ? <img src={m.thumb || m.art} alt="" loading="lazy" /> : null}
          </span>
        ))}
      </span>
      <span className="pl-cap">
        <span className="pl-name">{playlist.name}</span>
        <span className="pl-sub">
          {n} map{n === 1 ? '' : 's'}
          {playlist.blurb ? ` · ${playlist.blurb}` : ''}
        </span>
      </span>
    </Link>
  )
}
