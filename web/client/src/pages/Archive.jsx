import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, ago, num } from '../api'
import { Section, Empty, Loading, Stat, Health } from '../components/Bits'
import EnwWord from '../components/Enw'

// The Archive page (99 §4.8, 13 §3): every original, including maps marked "not playable
// on ENW". It is a LIST, not a wall of cards — two thousand cards is a scrolling exercise,
// and what a visitor wants here is to search for one map and find out whether it still
// exists anywhere. Every number on it is counted by the server.

const PAGE = 60

export default function Archive() {
  const [sp, setSp] = useSearchParams()
  const [meta, setMeta] = useState(null)
  const [list, setList] = useState(null)
  const [busy, setBusy] = useState(false)

  const q = sp.get('q') || ''
  const sort = sp.get('sort') || 'name'

  useEffect(() => { api.get('/api/archive').then(setMeta).catch(() => {}) }, [])

  useEffect(() => {
    setBusy(true)
    const qs = new URLSearchParams({ archive: '1', sort, limit: String(PAGE) })
    if (q) qs.set('q', q)
    api.get(`/api/maps?${qs}`).then((j) => { setList({ ...j, offset: 0 }); setBusy(false) }).catch(() => setBusy(false))
  }, [q, sort])

  const more = async () => {
    if (!list) return
    setBusy(true)
    const qs = new URLSearchParams({ archive: '1', sort, limit: String(PAGE), offset: String(list.maps.length) })
    if (q) qs.set('q', q)
    const j = await api.get(`/api/maps?${qs}`).catch(() => null)
    if (j) setList((cur) => ({ ...j, maps: [...cur.maps, ...j.maps] }))
    setBusy(false)
  }

  const set = (k, v) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }) }
  const s = meta && meta.stats

  return (
    <div className="page wide">
      <div className="row" style={{ marginBottom: 14 }}><h1>The archive</h1></div>
      {s && (
        <div className="stats" style={{ marginBottom: 18 }}>
          <Stat label="Catalogued" value={s.catalogued} />
          <Stat label="Playable here" value={s.playable} />
          <Stat label="Originals held" value={s.originals_held} />
          <Stat label="Download links" value={s.links} />
          <Stat label="Links alive" value={s.links_alive} tone="good" />
          <Stat label="Links dead" value={s.links_dead} tone="hot" />
          {s.links_unchecked > 0 && <Stat label="Still checking" value={s.links_unchecked} />}
        </div>
      )}

      {meta && meta.hosts && meta.hosts.length > 0 && (
        <Section title="Where the links point">
          <div className="listing">
            <table className="data">
              <thead><tr><th>Host</th><th className="num">Links</th><th className="num">Alive</th><th className="num">Dead</th></tr></thead>
              <tbody>
                {meta.hosts.map((h) => (
                  <tr key={h.site}>
                    <td className="mono tiny">{h.site}</td>
                    <td className="num">{num(h.n)}</td>
                    <td className="num good">{num(h.alive)}</td>
                    <td className="num hot">{num(h.dead)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {meta && meta.broken.length > 0 && (
        <Section title={<>Not playable on <EnwWord /></>}>
          <div className="listing">
            {meta.broken.map((m) => (
              <Link className="maprow" key={m.key} to={`/m/${m.key}`}>
                <div className="name"><b>{m.title}</b><span>{m.key}</span></div>
                <span /><span /><Health health={m.health} />
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section title="Everything" right={list ? <span className="tiny num">{num(list.total)} maps</span> : null}>
        <div className="bar">
          <input type="search" value={q} placeholder="Search every map" onChange={(e) => set('q', e.target.value)} />
          <select value={sort} onChange={(e) => set('sort', e.target.value)}>
            <option value="name">Name</option>
            <option value="oldest">Release date</option>
            <option value="newest">Newest</option>
            <option value="popular">Popularity</option>
          </select>
        </div>

        {!list ? <div className="listing"><Loading /></div>
          : list.maps.length === 0 ? <div className="listing"><Empty>Nothing matches.</Empty></div>
            : (
              <>
                <div className="listing">
                  {list.maps.map((m) => (
                    <Link className="maprow" key={m.key} to={`/m/${m.key}`}>
                      <div className="name">
                        <b>{m.title}</b>
                        <span>{m.author || 'author unknown'}{m.year ? ` · ${m.year}` : ''}</span>
                      </div>
                      <div className="row" style={{ gap: 5 }}>
                        {/* EE: the map has one (its tags), or we hold the steps for it (lib/guides.js). */}
                        {(m.has_ee || m.ee_guide) && (
                          <span className="tag gold" title={m.ee_guide ? 'Easter egg steps on the map page' : 'Has an Easter egg'}>EE</span>
                        )}
                        {m.has_buyable && <span className="tag hot">BE</span>}
                      </div>
                      <Health health={m.health} />
                      <span className="tiny num" style={{ minWidth: 68, textAlign: 'right' }}>
                        {m.added_at ? ago(m.added_at) : ''}
                      </span>
                    </Link>
                  ))}
                </div>
                {list.maps.length < list.total && (
                  <button className="btn" style={{ marginTop: 12 }} onClick={more} disabled={busy}>
                    {busy ? 'Loading' : `Show more (${num(list.total - list.maps.length)} left)`}
                  </button>
                )}
              </>
            )}
      </Section>

    </div>
  )
}
