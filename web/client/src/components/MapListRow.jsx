import { Link, useLocation } from 'react-router-dom'
import { prettyTitle, bspOf, releasedOf, mapHue } from '../data/mapText'
import { Health, NotPlayable } from './Bits'

// The list view's row, and it IS the map's page entry (B, 2026-09-22): one row per map,
// carrying the same four things a card carries, in the same order, with the ART shown here
// too — "show the map image in both views like Movement does".
//
// Movement's list view is its records deck at `density="pick"`: a small art plate flush to
// the row's left edge, the name in the body face, the quiet facts under it, and the row is
// the control. That is what this is; the columns are ours, because the questions are.
//
// No finish chips. See MapCard.jsx and data/mapText.js — those three are filters now.
//
// The hover preview is DELEGATED by the caller, one listener on the list rather than two per
// row: with two thousand rows that is the difference between a list and a stress test, and
// crossing the hairline between rows does not flash the page back to neutral because the
// leave belongs to the container. `data-key` is how the container finds the map.

export default function MapListRow({ map, archive = false }) {
  const title = prettyTitle(map.title, map.key)
  const released = releasedOf(map)
  const p = map.progress
  // Where the map page's back control returns to (components/BackButton.jsx).
  const loc = useLocation()
  return (
    <Link
      to={`/m/${map.key}`}
      state={{ back: loc.pathname + loc.search }}
      className="mlrow"
      data-key={map.key}
      style={{ '--h': String(mapHue(map.key)) }}
    >
      <span className="mlrow-art">
        {(map.thumb || map.art)
          ? <img src={(map.thumb || map.art)} alt="" loading="lazy" />
          : <span>{(map.key || '').replace(/^nazi_zombie_/, '').slice(0, 8)}</span>}
      </span>
      <span className="mlrow-name">
        <b>{title}</b>
        <span className="mlrow-bsp">{bspOf(map)}</span>
      </span>
      <span className="mlrow-by">{map.author || '—'}</span>
      <span className="mlrow-when num">{released || '—'}</span>
      <span className="mlrow-marks">
        {/* The archive view is the only one that can hold a broken map, so it is the only
            one that prints health. Everywhere else every row would say the same word.
            ~~And a "Our servers" chip.~~ Cut before it shipped: it was true of twelve of
            nineteen rows and would have been the finish chips again under another name —
            a label printed on most of a list is furniture, and it is already a filter. */}
        {archive && <Health health={map.health} />}
        {p && p.beaten ? <span className="tag good">Beaten</span> : null}
        <NotPlayable map={map} />
      </span>
      {/* The two numbers, and only the ones that exist. Built as a list and joined rather
          than concatenated with a separator in front of the second: a map with plays and no
          rating printed a leading "· 5", which reads as a broken template. */}
      <span className="mlrow-n num">
        {[map.rating != null ? `${map.rating}%` : null, map.plays ? `${map.plays} played` : null]
          .filter(Boolean).join(' · ') || ''}
      </span>
    </Link>
  )
}
