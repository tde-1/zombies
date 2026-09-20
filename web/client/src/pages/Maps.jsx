import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, num } from '../api'
import { useSession } from '../session'
import { Section, Empty, FinishChips, Health } from '../components/Bits'
import MapCard from '../components/MapCard'

// Maps = Movement's mode home (13 §3): featured, map of the week, new maps, playlists, then
// the full list with a map count.
//
// The filters are the four B named, all present and all in the URL so a filtered view is a
// link somebody can paste:
//   has Easter egg / has buyable ending · author / year / version · popularity / rating /
//   newest · your progress
//
// Search is the smart one: the server ranks name (including the nazi_zombie_ alias) > author
// > tags > description.

export default function Maps() {
  const [sp, setSp] = useSearchParams()
  const { signedIn } = useSession()
  const [home, setHome] = useState(null)
  const [list, setList] = useState(null)
  const [view, setView] = useState('rows')

  const q = sp.get('q') || ''
  const archive = sp.get('archive') === '1'

  useEffect(() => { api.get('/api/maps/home').then(setHome).catch(() => {}) }, [signedIn])

  useEffect(() => {
    const qs = new URLSearchParams()
    for (const k of ['q', 'finish', 'author', 'year', 'tag', 'progress', 'sort', 'archive']) {
      const v = sp.get(k)
      if (v) qs.set(k, v)
    }
    api.get(`/api/maps?${qs}`).then(setList).catch(() => {})
  }, [sp, signedIn])

  const set = (k, v) => {
    const next = new URLSearchParams(sp)
    if (v) next.set(k, v); else next.delete(k)
    setSp(next, { replace: true })
  }

  if (!list) return <div className="page"><p className="sub">Loading.</p></div>

  const filtering = ['q', 'finish', 'author', 'year', 'tag', 'progress'].some((k) => sp.get(k))

  return (
    <div className="page wide">
      {!filtering && home && (
        <>
          {home.week && (
            <Section title="Map of the week" sub={home.week.note || ''}>
              <MapCard map={home.week.map} big />
            </Section>
          )}

          {home.favourites.length > 0 && (
            <Section title="Your favourites">
              <div className="grid c4">{home.favourites.slice(0, 4).map((m) => <MapCard key={m.key} map={m} />)}</div>
            </Section>
          )}

          <Section title="New" sub="Most recently added to the archive">
            <div className="grid c4">{home.newest.slice(0, 4).map((m) => <MapCard key={m.key} map={m} />)}</div>
          </Section>

          {home.playlists.length > 0 && (
            <Section title="Playlists" right={<Link className="btn small ghost" to="/playlists">All</Link>}>
              <div className="grid c3">
                {home.playlists.slice(0, 6).map((p) => (
                  <Link className="card" key={p.id} to={`/playlists/${p.slug}`}>
                    <h3>{p.name}</h3>
                    <p className="sub" style={{ margin: '4px 0 8px' }}>{p.blurb || `${p.map_count} map${p.map_count === 1 ? '' : 's'}`}</p>
                    <div className="row wrap" style={{ gap: 5 }}>
                      {p.maps.slice(0, 5).map((m) => <span className="chip" key={m.key}>{m.title}</span>)}
                      {p.map_count > 5 && <span className="chip">+{p.map_count - 5}</span>}
                    </div>
                    {p.progress && <div className="tiny" style={{ marginTop: 8 }}>{p.progress.done} / {p.progress.total} beaten</div>}
                  </Link>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      <Section
        title={archive ? 'The archive' : 'All maps'}
        sub={`${num(list.total)} map${list.total === 1 ? '' : 's'}`}
        right={(
          <div className="row" style={{ gap: 6 }}>
            <button className={`btn small ${view === 'rows' ? 'on' : 'ghost'}`} onClick={() => setView('rows')}>List</button>
            <button className={`btn small ${view === 'cards' ? 'on' : 'ghost'}`} onClick={() => setView('cards')}>Cards</button>
          </div>
        )}
      >
        <div className="filters">
          <input type="search" value={q} placeholder="Map name, author, tag, or anything in the readme"
            onChange={(e) => set('q', e.target.value)} />

          <select value={sp.get('finish') || ''} onChange={(e) => set('finish', e.target.value)}>
            <option value="">Any finish</option>
            <option value="ee">Has Easter egg</option>
            <option value="buyable">Has buyable ending</option>
            <option value="survival">Survival only</option>
          </select>

          <select value={sp.get('author') || ''} onChange={(e) => set('author', e.target.value)}>
            <option value="">Any author</option>
            {list.filters.authors.map((a) => <option key={a.name} value={a.name}>{a.name} ({a.maps})</option>)}
          </select>

          <select value={sp.get('year') || ''} onChange={(e) => set('year', e.target.value)}>
            <option value="">Any year</option>
            {list.filters.years.map((y) => <option key={y.year} value={y.year}>{y.year} ({y.maps})</option>)}
          </select>

          <select value={sp.get('tag') || ''} onChange={(e) => set('tag', e.target.value)}>
            <option value="">Any tag</option>
            {list.filters.tags.map((t) => <option key={t.slug} value={t.slug}>{t.label} ({t.maps})</option>)}
          </select>

          {signedIn && (
            <select value={sp.get('progress') || ''} onChange={(e) => set('progress', e.target.value)}>
              <option value="">Your progress</option>
              <option value="unplayed">Not played</option>
              <option value="played">Played</option>
              <option value="beaten">Beaten</option>
              <option value="ee">Easter egg done</option>
            </select>
          )}

          <select value={sp.get('sort') || 'popular'} onChange={(e) => set('sort', e.target.value)}>
            <option value="popular">Popularity</option>
            <option value="rating">Rating</option>
            <option value="newest">Newest rescued</option>
            <option value="oldest">Release date</option>
            <option value="name">Name</option>
          </select>

          <button className={`btn small ${archive ? 'on' : 'ghost'}`} onClick={() => set('archive', archive ? '' : '1')}
            title="Maps that do not run on our servers are hidden from this list and live on the archive view">
            Include broken
          </button>

          {filtering && <button className="btn small ghost" onClick={() => setSp(new URLSearchParams())}>Clear</button>}
        </div>

        {list.maps.length === 0 ? <Empty>No map matches that.</Empty>
          : view === 'cards' ? <div className="grid c4">{list.maps.map((m) => <MapCard key={m.key} map={m} />)}</div>
            : (
              <div className="card flat">
                {list.maps.map((m) => (
                  <Link className="maprow" key={m.key} to={`/m/${m.key}`}>
                    <div className="name">
                      <b>{m.title}</b>
                      <span>{m.key}{m.author ? ` · ${m.author}` : ''}{m.year ? ` · ${m.year}` : ''}</span>
                    </div>
                    <div className="row" style={{ gap: 5 }}><FinishChips map={m} /></div>
                    <div className="row" style={{ gap: 5 }}>
                      {archive && <Health health={m.health} />}
                      {m.progress && m.progress.beaten && <span className="chip on">Beaten</span>}
                    </div>
                    <span className="tiny num" style={{ minWidth: 70, textAlign: 'right' }}>
                      {m.rating != null ? `${m.rating}%` : ''} {m.plays ? `· ${m.plays}` : ''}
                    </span>
                  </Link>
                ))}
              </div>
            )}
      </Section>
    </div>
  )
}
