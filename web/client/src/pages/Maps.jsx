import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, num } from '../api'
import { useSession } from '../session'
import { Empty, Loading } from '../components/Bits'
import MapCard from '../components/MapCard'
import MapListRow from '../components/MapListRow'
import MapRow from '../components/MapRow'
import ModeViewSwitch from '../components/ModeViewSwitch'
import PlaylistCover from '../components/PlaylistCover'
import { hoverAmbience, endHoverAmbience } from '../ambience'

// THE MAPS PAGE — Movement's mode home and Movement's pool, at one address (B, 2026-09-23).
//
// CARDS is `movement-client/src/pages/ModeHome.jsx` (MapsHome below). LIST is its pool page,
// `pages/Hub.jsx` + `components/MapList.jsx`, with the records deck's `.rdk-bar`. The view is
// the ONLY thing this page remembers — a filter is what you are doing right now, and a pool
// that opened already narrowed to something you asked for last week is the site answering a
// question nobody had asked.
//
// **The art is in the list.** Movement shows the map in its list — a plate flush to the row's
// left edge — and a list of two thousand names with no pictures is a spreadsheet.
//
// ── What a map entry SAYS ────────────────────────────────────────────────────────────────
// Name, then the bsp name as a subtitle, then the author, then the release date — and
// nothing else. `data/mapText.js` owns it for the card, the row and the search hit together.
// The finish words are GONE from both views; they are filters on the bar now.
//
// ── The filters ──────────────────────────────────────────────────────────────────────────
// OR within a group, AND across groups, an empty group constrains nothing — Movement's rule,
// enforced server-side (`lib/maps.js`). Every one of them is in the URL, so a filtered view
// is a link somebody can paste, which is the whole reason this page exists beside home.
//
// And Movement's other rule, which is the one that keeps the bar honest: **a group is drawn
// only where the pool actually splits on it.** Nothing here is tagged Hard yet, so there is
// no Difficulty group — three chips that each empty the page say less than no chips.

// ── Two views (B, 2026-09-23) ────────────────────────────────────────────────────────────
// CARDS is the default: Movement's mode home (`pages/ModeHome.jsx`) — card rows, the
// playlists, and "View all maps" at the foot. LIST is the whole pool with the bar, replacing
// everything. The switch top right is Movement's `ModeViewSwitch`.
//
// The switch SAVES the choice (localStorage, Movement's `gn_map_sort_v1` key pattern) and the
// next visit opens on it. A URL states a view WITHOUT saving it: `?view=list` / `?view=cards`
// win once, and so does any filter in the URL (a search link from the top bar, a tag on a map
// page) — a filter is a question only the list answers. "View all maps" is such a link, so
// Back returns to the cards. Movement itself has no saved view: its pool dropped `?view=` when
// it went down to one drawing (Hub.jsx, 2026-08-19); the saving is B's, not a port.
//
// The old top strip — the collection rows (New maps, Vanilla, High production) stacked above
// the list — is gone from this page (B, 2026-09-23). Home still draws them.
const VIEW_KEY = 'zm_maps_view_v1'
const readView = () => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards' } catch { return 'cards' } }

// Every filter this page writes, so "am I filtering" and "clear all" are one list rather
// than two that drift.
const PARAMS = ['q', 'finish', 'size', 'difficulty', 'style', 'tag', 'author', 'year', 'progress', 'source', 'server', 'records']

const SORTS = [
  ['popular', 'Popularity'],
  ['rating', 'Rating'],
  ['newest', 'Newest'],
  ['oldest', 'Release date'],
  ['name', 'Name'],
]

export default function Maps() {
  const [sp, setSp] = useSearchParams()
  const { signedIn } = useSession()
  const [list, setList] = useState(null)
  const [stored, setStored] = useState(readView)
  const scroller = useRef(null)

  const urlView = sp.get('view')
  const q = sp.get('q') || ''
  const archive = sp.get('archive') === '1'
  const filtering = PARAMS.some((k) => sp.get(k))
  const view = urlView === 'cards' || urlView === 'list' ? urlView : (filtering || archive ? 'list' : stored)

  // A change of view starts at the top of the page, the way a page change does.
  useEffect(() => { window.scrollTo(0, 0) }, [view])

  useEffect(() => {
    if (view !== 'list') return
    const qs = new URLSearchParams()
    for (const k of [...PARAMS, 'sort', 'archive', 'limit']) {
      const v = sp.get(k)
      if (v) qs.set(k, v)
    }
    api.get(`/api/maps?${qs}`).then(setList).catch(() => {})
  }, [sp, signedIn, view])

  const set = (k, v) => {
    const next = new URLSearchParams(sp)
    if (v) next.set(k, v); else next.delete(k)
    setSp(next, { replace: true })
  }
  // The switch: saved, and the URL goes back to plain /maps. Cards drops the filters with it
  // — they are the list's, and a filter left in the URL would put the list straight back.
  const pickView = (v) => {
    setStored(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* private browsing */ }
    const next = new URLSearchParams(v === 'cards' ? {} : sp)
    next.delete('view')
    setSp(next, { replace: true })
  }


  // One chip group, one URL param, comma-separated. Ticking is a toggle because that is what
  // "OR within the group" means as a gesture.
  const toggle = (k, slug) => {
    const cur = new Set((sp.get(k) || '').split(',').filter(Boolean))
    if (cur.has(slug)) cur.delete(slug); else cur.add(slug)
    set(k, [...cur].join(','))
  }
  const has = (k, slug) => (sp.get(k) || '').split(',').includes(slug)

  // Delegated hover: one listener on the container rather than two per row. With two thousand
  // rows that is the difference between a list and a stress test, and crossing the hairline
  // between two rows does not flash the page back to neutral because the leave belongs to
  // the container. (Movement, MapList.jsx — "see docs/RECORDS-REDESIGN.md §10.7".)
  const byKey = useMemo(() => {
    const m = new Map()
    for (const x of (list && list.maps) || []) m.set(x.key, x)
    return m
  }, [list])
  const over = (e) => {
    const row = e.target.closest && e.target.closest('[data-key]')
    if (!row) return
    const m = byKey.get(row.dataset.key)
    if (m) hoverAmbience(m)
  }

  if (view === 'cards') return <MapsHome onView={pickView} onAll={() => setSp({ view: 'list' })} signedIn={signedIn} />
  if (!list) return <div className="page wide"><Loading /></div>

  const tags = (list.filters && list.filters.tags) || []
  const ofKind = (kind) => tags.filter((t) => t.kind === kind)
  const loose = tags.filter((t) => !['size', 'difficulty', 'style', 'finish'].includes(t.kind))

  return (
    <div className="page wide">
      <section className="map-browser">
        <div className="mk-head">
          <h2 className="mk-title">{archive ? 'The archive' : 'All maps'}</h2>
          <span className="mk-count num">{num(list.total)}</span>
          <ModeViewSwitch current="list" onGo={pickView} />
        </div>

        <div className="rdk-bar">
          <input className="rdk-search" type="search" value={q} placeholder={`Search ${num(list.total)} maps…`}
                 aria-label="Search maps" onChange={(e) => set('q', e.target.value)} />

          {/* FINISH. Exclusive rather than a set: a map is one of these three, and letting
              you ask for two would be asking for the whole pool the long way round. This is
              also where "Buyable Ending · Easter Egg · Round 20" went when it came off every
              card and every row. */}
          <div className="rdk-seg" role="group" aria-label="How it finishes">
            {[['', 'Any finish'], ['ee', 'Easter Egg'], ['buyable', 'Buyable Ending'], ['survival', 'Round-based']].map(([k, label]) => (
              <button key={k || 'any'} className={(sp.get('finish') || '') === k ? 'on' : ''}
                      onClick={() => set('finish', k)}>{label}</button>
            ))}
          </div>

          <ChipGroup label="Size" param="size" options={ofKind('size')} has={has} toggle={toggle} />
          <ChipGroup label="Difficulty" param="difficulty" options={ofKind('difficulty')} has={has} toggle={toggle} />
          <ChipGroup label="Style" param="style" options={ofKind('style')} has={has} toggle={toggle} />

          {/* STOCK vs CUSTOM. Four maps against two thousand, so it is a segment rather than
              two chips: the interesting reading is "only the four" or "everything else". */}
          <div className="rdk-seg" role="group" aria-label="Where the map came from">
            {[['', 'All'], ['stock', 'Stock'], ['custom', 'Custom']].map(([k, label]) => (
              <button key={k || 'any'} className={(sp.get('source') || '') === k ? 'on' : ''}
                      onClick={() => set('source', k)}>{label}</button>
            ))}
          </div>

          {/* Playable on OUR boxes. Narrower than "in this list": a `custom-only` map is a
              real map a real person can run at home, it is just not one we will referee. */}
          <button className={'rdk-chip txt' + (sp.get('server') === '1' ? ' on' : '')}
                  aria-pressed={sp.get('server') === '1'}
                  onClick={() => set('server', sp.get('server') === '1' ? '' : '1')}>Playable</button>

          <button className={'rdk-chip txt' + (sp.get('records') === '1' ? ' on' : '')}
                  aria-pressed={sp.get('records') === '1'}
                  onClick={() => set('records', sp.get('records') === '1' ? '' : '1')}>Has records</button>

          {/* Author, year and the long tail of tags are SELECTS and not chips, for the reason
              Movement gives for not drawing a 900-entry facet list: an author dropdown with
              nine hundred names in it is not a filter, it is a scrolling exercise — and nine
              hundred chips is the same exercise with more pixels. */}
          <select className="rdk-select" value={sp.get('author') || ''} onChange={(e) => set('author', e.target.value)} aria-label="Author">
            <option value="">Any author</option>
            {(list.filters.authors || []).map((a) => <option key={a.name} value={a.name}>{a.name} ({a.maps})</option>)}
          </select>

          <select className="rdk-select" value={sp.get('year') || ''} onChange={(e) => set('year', e.target.value)} aria-label="Year">
            <option value="">Any year</option>
            {(list.filters.years || []).map((y) => <option key={y.year} value={y.year}>{y.year} ({y.maps})</option>)}
          </select>

          {loose.length > 0 && (
            <select className="rdk-select" value={sp.get('tag') || ''} onChange={(e) => set('tag', e.target.value)} aria-label="Tag">
              <option value="">Any tag</option>
              {loose.map((t) => <option key={t.slug} value={t.slug}>{t.label} ({t.maps})</option>)}
            </select>
          )}

          {/* Signed out there is no progress to filter on, so both options would claim the
              whole pool or none of it. Absent rather than disabled: the sign-in that fixes it
              is in the corner of every page. */}
          {signedIn && (
            <select className="rdk-select" value={sp.get('progress') || ''} onChange={(e) => set('progress', e.target.value)} aria-label="Your progress">
              <option value="">Any progress</option>
              <option value="unplayed">Not played</option>
              <option value="played">Played</option>
              <option value="beaten">Beaten</option>
              <option value="ee">Easter egg done</option>
            </select>
          )}

          <select className="rdk-select" value={sp.get('sort') || 'popular'} onChange={(e) => set('sort', e.target.value)} aria-label="Sort">
            {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>

          <button className={'rdk-chip txt' + (archive ? ' on' : '')}
                  aria-pressed={archive}
                  onClick={() => set('archive', archive ? '' : '1')}>Include broken</button>

          {/* One button rather than a chip per tick: every filter on this bar states itself
              by being lit, so the only thing left to offer is the way back to the whole pool. */}
          {filtering && <button className="rdk-chip txt" onClick={() => setSp(new URLSearchParams(archive ? { archive: '1' } : {}))}>Clear all</button>}

          <span className="rdk-bar-n">
            <b>{num(list.maps.length)}</b> of {num(list.total)} maps
          </span>
        </div>

        {list.maps.length === 0 ? <div className="listing"><Empty>No maps match.</Empty></div>
          : (
            <div className="mlist-wrap" ref={scroller} onMouseOver={over} onMouseLeave={endHoverAmbience}>
              {list.maps.map((m) => <MapListRow key={m.key} map={m} archive={archive} />)}
            </div>
          )}

        {/* The archive paginates — 2,284 rows is 1.1 MB of JSON and a tab that janks — so it
            says how far in you are and offers the rest rather than pretending this is all. */}
        {list.maps.length < list.total && (
          <div className="mk-more">
            <button className="btn ghost" onClick={() => set('limit', String(Math.min(500, list.maps.length + 60)))}>
              Show more ({num(list.total - list.maps.length)} left)
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

// ── CARDS: the mode home — and, since 4ebad8f, the site's front door ──────────────────
// Movement's `ModeHome.jsx`, with the rows zombies has the data for:
//
//   the lead rows  the first LEAD live curated playlists (web/tools/seed-playlists.js: the
//                  best-known maps, stock mixed with the community's biggest). The first one
//                  is drawn with larger cards.
//   Your maps      signed in only, AFTER the lead rows: a returning player's own row is
//                  useful, but not what the page should open on.
//   the rest       every other live curated playlist, in sort order.
//   All playlists  covers — Movement: the playlists themselves first, the index at the end.
//   View all maps  Movement's `.mode-browse` button; it opens the list.
//
// ~~Popular~~ (by plays) is gone (B, 2026-09-24): a few hundred beta plays ranked the page by
// who happened to test what. The order is the playlists' now.
//
// Every row is real or absent, Movement's rule: a row with nothing in it does not render.
const ROW_N = 12
const LEAD = 3

function MapsHome({ onView, onAll, signedIn }) {
  const nav = useNavigate()
  const [total, setTotal] = useState(null)
  const [yours, setYours] = useState(null)
  const [lists, setLists] = useState(null)

  useEffect(() => {
    let dead = false
    api.get('/api/maps?limit=1').then((d) => { if (!dead) setTotal((d && d.total) || 0) }).catch(() => {})
    api.get('/api/playlists')
      .then((d) => { if (!dead) setLists((d && d.playlists) || []) })
      .catch(() => { if (!dead) setLists([]) })
    if (signedIn) api.get(`/api/maps?progress=played&limit=${ROW_N}`).then((d) => { if (!dead) setYours(d) }).catch(() => {})
    else setYours(null)
    return () => { dead = true }
  }, [signedIn])

  const withMaps = (lists || []).filter((pl) => pl.maps && pl.maps.length)
  const curated = withMaps.filter((pl) => pl.kind !== 'creator')

  const row = (pl, i) => (
    <MapRow key={pl.id} title={pl.name} count={pl.map_count} className={i === 0 ? 'lead' : undefined}
            blurb={pl.progress ? `${pl.progress.done} / ${pl.progress.total} beaten` : null}
            onOpen={() => nav(`/playlists/${pl.slug}`)}>
      {pl.maps.map((m) => <MapCard key={m.key} map={m} />)}
    </MapRow>
  )

  return (
    <div className="page wide">
      <div className="mk-head">
        <h2 className="mk-title">Maps</h2>
        {total > 0 && <span className="mk-count num">{num(total)}</span>}
        <ModeViewSwitch current="cards" onGo={onView} />
      </div>

      {!lists ? <Loading /> : (
        <>
          {curated.slice(0, LEAD).map(row)}

          {signedIn && yours && (yours.maps.length > 0 ? (
            <MapRow title="Your maps" count={yours.total}>
              {yours.maps.map((m) => <MapCard key={m.key} map={m} />)}
            </MapRow>
          ) : (
            <MapRow title="Your maps">
              <div className="mhb-none">Play something and it lands here.</div>
            </MapRow>
          ))}

          {curated.slice(LEAD).map((pl, i) => row(pl, i + LEAD))}

          {withMaps.length > 0 && (
            <MapRow title="All playlists" count={withMaps.length}>
              {withMaps.map((pl) => <PlaylistCover key={pl.id} playlist={pl} />)}
            </MapRow>
          )}

          <div className="mode-browse">
            <button className="btn mode-browse-btn" onClick={onAll}>View all maps</button>
          </div>
        </>
      )}
    </div>
  )
}

// A group of chips writing one comma-separated URL param. It draws only where the pool
// actually splits on it: one option would be a control that changes nothing, and none would
// be a control that empties the page.
function ChipGroup({ label, param, options, has, toggle }) {
  if (!options || options.length < 2) return null
  return (
    <div className="rdk-chips" role="group" aria-label={label}>
      {options.map((t) => (
        <button key={t.slug} className={'rdk-chip txt' + (has(param, t.slug) ? ' on' : '')}
                aria-pressed={has(param, t.slug)}
                onClick={() => toggle(param, t.slug)}>{t.label}</button>
      ))}
    </div>
  )
}
