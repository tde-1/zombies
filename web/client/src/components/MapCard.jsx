import { Link } from 'react-router-dom'
import { FinishChips } from './Bits'

// One map, as a card. The art slot falls back to the engine name rather than a placeholder
// image: 04 says community screenshots come first and we measure the gaps later, so a map
// with no art should look like a map with no art, not like a broken image.

export default function MapCard({ map, big = false }) {
  const p = map.progress
  return (
    <Link to={`/m/${map.key}`} className="mapcard">
      <div className="art" style={big ? { aspectRatio: '21 / 9' } : undefined}>
        {map.art ? <img src={map.art} alt="" /> : <span>{map.key.replace('nazi_zombie_', '')}</span>}
      </div>
      <h3>{map.title}</h3>
      <div className="meta">
        {map.author && <span>{map.author}</span>}
        {map.year ? <span>{map.year}</span> : null}
        {map.rating != null && <span>{map.rating}%</span>}
        {map.plays ? <span>{map.plays} played</span> : null}
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <FinishChips map={map} />
        {p && p.beaten && <span className="chip on">Beaten</span>}
        {p && !p.beaten && p.played && <span className="chip">Played</span>}
      </div>
    </Link>
  )
}
