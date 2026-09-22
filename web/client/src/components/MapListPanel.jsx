import { useEffect, useMemo, useRef, useState } from 'react'
import { hoverAmbience, endHoverAmbience } from '../ambience'
import { NotPlayable } from './Bits'

// The map pool as a scrolling list, under the party panel. Movement's map browser list,
// at its pick density: a small art plate flush to the row's left edge, the map's name in
// the body face, the author and year under it, and the row IS the control — click anywhere
// on it to open the map.
//
// Two things it takes from Movement that are easy to leave out and expensive to re-derive:
//
//   the SEARCH is the only filter here. Movement's browser has tiers, types, lengths and a
//   run/not-run segment; the four filters this site has already live on /maps and are all
//   in the URL there. A second copy of them in a 302px column would be a second place to
//   learn them, and B asked for uncluttered.
//
//   the HOVER PREVIEW is delegated, one listener on the scroller rather than two per row.
//   With two thousand rows that is the difference between a list and a stress test, and
//   crossing the hairline between two rows does not flash the page back to neutral because
//   the leave belongs to the container. `ambience.js` does the rest: a hover during a
//   scroll is banked and not painted, which is what stops a flick of the wheel queueing
//   dozens of image fetches.

export default function MapListPanel({ maps, selected, onPick }) {
  const [q, setQ] = useState('')
  const scroller = useRef(null)

  // Client-side, because the whole playable pool is already here and a keystroke that costs
  // a round trip reads as lag in a list this size. The ranking is the server's shape: the
  // key and its `nazi_zombie_` alias first, then the title, then the author.
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return maps
    const score = (m) => {
      const key = (m.key || '').toLowerCase()
      const alias = key.replace('nazi_zombie_', '')
      const title = (m.title || '').toLowerCase()
      const author = (m.author || '').toLowerCase()
      if (key.startsWith(s) || alias.startsWith(s)) return 0
      if (title.startsWith(s)) return 1
      if (key.includes(s) || title.includes(s)) return 2
      if (author.includes(s)) return 3
      return -1
    }
    return maps.map((m) => [score(m), m]).filter(([n]) => n >= 0)
      .sort((a, b) => a[0] - b[0]).map(([, m]) => m)
  }, [maps, q])

  // The map that is open should be visible in the list it was not necessarily picked from —
  // a deep link, or the party's staged map. Only on a change of selection, and never while
  // the pointer is working: scrolling the list out from under somebody is worse than a row
  // they have to find.
  useEffect(() => {
    const el = scroller.current && scroller.current.querySelector('.mrow.on')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const byKey = useMemo(() => {
    const m = new Map()
    for (const x of maps) m.set(x.key, x)
    return m
  }, [maps])

  // Delegated hover: find the row under the pointer and hand its map to the ambience.
  const over = (e) => {
    const row = e.target.closest && e.target.closest('.mrow')
    if (!row) return
    const m = byKey.get(row.dataset.key)
    if (m) hoverAmbience(m)
  }

  return (
    <section className="mlist">
      <div className="msearch">
        <input type="search" value={q} placeholder={`Search ${maps.length} maps`}
               aria-label="Search maps" onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mscroll" ref={scroller} onMouseOver={over} onMouseLeave={endHoverAmbience}>
        {shown.length === 0 && <p className="tiny" style={{ padding: '10px 12px' }}>No map matches.</p>}
        {shown.map((m) => (
          <button type="button" key={m.key} data-key={m.key}
                  className={`mrow${m.key === selected ? ' on' : ''}`}
                  onClick={() => onPick(m)}>
            <span className="plate">
              {m.art ? <img src={m.thumb || m.art} alt="" loading="lazy" /> : <span>{(m.key || '').replace('nazi_zombie_', '').slice(0, 6)}</span>}
            </span>
            <span className="name">
              <b>{m.title}</b>
              <span>{[m.author, m.year].filter(Boolean).join(' · ') || m.key}</span>
            </span>
            {/* One mark, and only when it is true: a map you have beaten. Anything more on a
                40px row at this width is ellipsis. */}
            {m.on_server === false ? <NotPlayable map={m} />
              : m.progress && m.progress.beaten ? <span className="tag good">✓</span> : <span />}
          </button>
        ))}
      </div>
      <div className="mlist-foot">
        <span className="tiny num">{shown.length === maps.length ? `${maps.length} maps` : `${shown.length} of ${maps.length}`}</span>
      </div>
    </section>
  )
}
