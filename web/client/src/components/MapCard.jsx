import { Link, useLocation } from 'react-router-dom'
import { prettyTitle, bspOf, releasedOf, mapHue } from '../data/mapText'
import { hoverAmbience, endHoverAmbience } from '../ambience'
import { NotPlayable } from './Bits'

// One map, as a card. Movement's `components/MapCard.jsx`, copied — the frame, the 2/1 art
// plate, the `--h` wash and the caption row — with zombies' nouns in the caption.
//
// WHAT IT SAYS, in B's order (2026-09-22): the NAME first, the bsp name as the subtitle,
// then the author, then the release date. `data/mapText.js` owns all four so the card, the
// list row and the search hit cannot drift apart.
//
// WHAT IT NO LONGER SAYS: the finish chips. "Buyable Ending · Easter Egg · Round 20" used to
// ride under every card; it is gone from here and from the list, and those three are filters
// on the bar instead. A label that is true of a quarter of the archive and printed under all
// of it is not information, it is furniture.
//
// ~~The art slot falls back to the engine-name stem rather than a placeholder image: 04 says
// community screenshots come first and we measure the gaps later, so a map with no art
// should look like a map with no art, not like a broken image.~~ Superseded 2026-09-22, B:
// "make sure every map has an image". Every map now has one (tools/maps/map_art.py): the
// scraped cover, else the map's own loading screen, else WaW's, else a generated card that
// says NO SCREENSHOT ON FILE on its face — so it still reads as a map with no art, which was
// the point of the old rule. The card takes the 400px `thumb`; the stem fallback stays for
// a row the script has not reached yet. `--h` is the map's own holding hue, and the
// generated card is drawn in the same hue, so the two agree.

export default function MapCard({ map, big = false, flag = null }) {
  // Where the map page's back control returns to (components/BackButton.jsx).
  const loc = useLocation()
  if (!map) return null
  const title = prettyTitle(map.title, map.key)
  const released = releasedOf(map)
  const p = map.progress
  return (
    <Link
      to={`/m/${map.key}`}
      state={{ back: loc.pathname + loc.search }}
      className="map-card"
      style={{ '--h': String(mapHue(map.key)) }}
      title={title}
      // Delegating would be better and is not available here: a card can be anywhere (a row,
      // a grid, a rail), so there is no one container to hang the listener on. The rows that
      // matter for cost — the 302px pool list — delegate; see MapListPanel.jsx.
      onMouseEnter={() => hoverAmbience(map)}
      onMouseLeave={endHoverAmbience}
    >
      <span className="map-art" style={big ? { paddingTop: '42.85%' } : undefined}>
        {(map.thumb || map.art)
          ? <img src={(map.thumb || map.art)} alt="" loading="lazy" />
          : <span className="map-art-stem">{(map.key || '').replace(/^nazi_zombie_/, '')}</span>}
        {flag && <span className={'map-flag' + (flag === 'New' ? ' new' : '')}>{flag}</span>}
        {/* The one mark that earns its place on the picture, and only when it is true. */}
        {p && p.beaten ? <span className="map-flag done">Beaten</span> : null}
        {/* The Easter egg steps are on the map page (lib/guides.js). */}
        {map.ee_guide ? <span className="map-flag ee" title="Easter egg steps on the map page">EE</span> : null}
        <NotPlayable map={map} flag />
      </span>
      <span className="map-cap">
        <span className="map-name">{title}</span>
        <span className="map-bsp">{bspOf(map)}</span>
        <span className="map-by">
          {map.author || 'author unknown'}
          {released ? <span className="map-when">{released}</span> : null}
        </span>
      </span>
    </Link>
  )
}
