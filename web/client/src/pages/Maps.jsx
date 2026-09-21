import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, num } from '../api'
import { useSession } from '../session'
import { Section, Empty, Loading, FinishChips, Health } from '../components/Bits'
import MapCard from '../components/MapCard'

// Maps = Movement's mode home (13 §3): featured, map of the week, new maps, playlists, then
// the full list with a map count.
//
// The four filters B named are all here and all in the URL, so a filtered view is a link
// somebody can paste: has Easter egg / has buyable ending · author / year / version ·
// popularity / rating / newest · your progress. Search is the server's ranking: name
// (including the nazi_zombie_ alias) > author > tags > description.

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

  if (!list) return <div className="page"><Loading /></div>

  const filtering = ['q', 'finish', 'author', 'year', 'tag', 'progress'].some((k) => sp.get(k))

  return (
    <div className="page wide">
      {!filtering && home && (
        <>
          {home.week && (
            <Section title="Map of the week">
              <MapCard map={home.week.map} big />
            </Section>
          )}

          {home.favourites.length > 0 && (
            <Section title="Your favourites">
              <div className="grid c4">{home.favourites.slice(0, 4).map((m) => <MapCard key={m.key} map={m} />)}</div>
            </Section>
          )}

          <Section title="New">
            <div className="grid c4">{home.newest.slice(0, 4).map((m) => <MapCard key={m.key} map={m} />)}</div>
          </Section>

          {home.playlists.length > 0 && (
            <Section title="Playlists" right={<Link className="btn small ghost" to="/playlists">All</Link>}>
              <div className="grid c3">
                {home.playlists.slice(0, 6).map((p) => (
                  <Link className="card" key={p.id} to={`/playlists/${p.slug}`}>
                    <div className="spread" style={{ marginBottom: 8 }}>
                      <h3>{p.name}</h3>
                      <span className="tiny num">{p.progress ? `${p.progress.done} / ${p.progress.total}` : `${p.map_count}`}</span>
                    </div>
                    <div className="row wrap" style={{ gap: 5 }}>
                      {p.maps.slice(0, 5).map((m) => <span className="tag" key={m.key}>{m.title}</span>)}
                      {p.map_count > 5 && <span className="tag">+{p.map_count - 5}</span>}
                    </div>
                  </Link>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      <Section
        title={archive ? 'The archive' : 'All maps'}
        right={(
          <div className="row" style={{ gap: 10 }}>
            <span className="tiny num">{num(list.total)} map{list.total === 1 ? '' : 's'}</span>
            <div className="seg">
              <button className={view === 'rows' ? 'on' : ''} onClick={() => setView('rows')}>List</button>
              <button className={view === 'cards' ? 'on' : ''} onClick={() => setView('cards')}>Cards</button>
            </div>
          </div>
        )}
      >
        <div className="bar">
          <input type="search" value={q} placeholder="Search maps" onChange={(e) => set('q', e.target.value)} />

          <select value={sp.get('finish') || ''} onChange={(e) => set('finish', e.target.value)}>
            <option value="">Any finish</option>
            <option value="ee">Easter egg</option>
            <option value="buyable">Buyable ending</option>
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
              <option value="">Any progress</option>
              <option value="unplayed">Not played</option>
              <option value="played">Played</option>
              <option value="beaten">Beaten</option>
              <option value="ee">Easter egg done</option>
            </select>
          )}

          <select value={sp.get('sort') || 'popular'} onChange={(e) => set('sort', e.target.value)}>
            <option value="popular">Popularity</option>
            <option value="rating">Rating</option>
            <option value="newest">Newest</option>
            <option value="oldest">Release date</option>
            <option value="name">Name</option>
          </select>

          <button className={`btn small ${archive ? 'on' : 'ghost'}`} onClick={() => set('archive', archive ? '' : '1')}>
            Include broken
          </button>

          {filtering && <button className="btn small ghost" onClick={() => setSp(new URLSearchParams())}>Clear</button>}
        </div>

        {list.maps.length === 0 ? <div className="listing"><Empty>No map matches.</Empty></div>
          : view === 'cards' ? <div className="grid c4" style={{ marginTop: 12 }}>{list.maps.map((m) => <MapCard key={m.key} map={m} />)}</div>
            : (
              <div className="listing">
                {list.maps.map((m) => (
                  <Link className="maprow" key={m.key} to={`/m/${m.key}`}>
                    <div className="name">
                      <b>{m.title}</b>
                      <span>{m.key}{m.author ? ` · ${m.author}` : ''}{m.year ? ` · ${m.year}` : ''}</span>
                    </div>
                    <div className="row" style={{ gap: 5 }}><FinishChips map={m} /></div>
                    <div className="row" style={{ gap: 5 }}>
                      {archive && <Health health={m.health} />}
                      {m.progress && m.progress.beaten && <span className="tag good">Beaten</span>}
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
