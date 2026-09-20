import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, ago, num } from '../api'
import { Section, Empty, Health } from '../components/Bits'

// The Archive page (99 §4.8, 13 §3): "the story, plus every original, including maps marked
// 'not playable on ENW'".
//
// This is the only page that shows the whole crawl — 2,000-odd maps most of which nobody
// has fetched, let alone booted. So it is a LIST, not a wall of cards: two thousand cards
// is not a browse experience, it is a scrolling exercise, and the thing a visitor actually
// wants here is to search for one map and find out whether it still exists anywhere.
//
// The numbers are all counted by the server. None of them is typed into this file, because
// a number typed into a page is a number that goes stale the week after it is written.

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
      <Section title="The archive">
        <p className="sub" style={{ maxWidth: 680 }}>
          Every World at War custom zombies map we can find a trace of, whether or not it can still
          be downloaded and whether or not it runs on our servers. Originals are kept exactly as they
          were released: the file, its hash, where it came from and when. Playable packs and our
          overlays sit beside them and never replace them.
        </p>
        {s && (
          <div className="stats" style={{ marginTop: 14 }}>
            <div className="stat"><span>Catalogued</span><b className="num">{num(s.catalogued)}</b></div>
            <div className="stat"><span>Playable here</span><b className="num">{num(s.playable)}</b></div>
            <div className="stat"><span>Originals held</span><b className="num">{num(s.originals_held)}</b></div>
            <div className="stat"><span>Download links</span><b className="num">{num(s.links)}</b></div>
            <div className="stat"><span>Links alive</span><b className="num good">{num(s.links_alive)}</b></div>
            <div className="stat"><span>Links dead</span><b className="num hot">{num(s.links_dead)}</b></div>
            {s.links_unchecked > 0 && <div className="stat"><span>Still checking</span><b className="num">{num(s.links_unchecked)}</b></div>}
          </div>
        )}
        {s && s.links_dead > 0 && (
          <p className="tiny" style={{ marginTop: 8 }}>
            {Math.round((s.links_dead / Math.max(1, s.links_dead + s.links_alive)) * 100)}% of the links
            we have been able to check are already dead. That is the reason this exists.
          </p>
        )}
      </Section>

      {meta && meta.hosts && meta.hosts.length > 0 && (
        <Section title="Where the links point" sub="What the archive currently rests on">
          <div className="card">
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
        <Section title="Not playable on ENW" sub="Catalogued and kept, but they do not run on our servers">
          <div className="card flat">
            {meta.broken.map((m) => (
              <Link className="maprow" key={m.key} to={`/m/${m.key}`}>
                <div className="name"><b>{m.title}</b><span>{m.key}</span></div>
                <span /><span /><Health health={m.health} />
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section title="Everything" sub={list ? `${num(list.total)} maps` : ''}>
        <div className="filters">
          <input type="search" value={q} placeholder="Search every map we know about"
            onChange={(e) => set('q', e.target.value)} />
          <select value={sort} onChange={(e) => set('sort', e.target.value)}>
            <option value="name">Name</option>
            <option value="oldest">Release date</option>
            <option value="newest">Newest rescued</option>
            <option value="popular">Popularity</option>
          </select>
        </div>

        {!list ? <p className="sub">Loading.</p>
          : list.maps.length === 0 ? <Empty>Nothing matches that. The crawl covers ZWR, callofdutyrepo, UGX, ZombieModding, ModDB and archive.org.</Empty>
            : (
              <>
                <div className="card flat">
                  {list.maps.map((m) => (
                    <Link className="maprow" key={m.key} to={`/m/${m.key}`}>
                      <div className="name">
                        <b>{m.title}</b>
                        <span>{m.author || 'author unknown'}{m.year ? ` · ${m.year}` : ''}</span>
                      </div>
                      <div className="row" style={{ gap: 5 }}>
                        {m.has_ee && <span className="chip ee">EE</span>}
                        {m.has_buyable && <span className="chip be">BE</span>}
                      </div>
                      <Health health={m.health} />
                      <span className="tiny" style={{ minWidth: 68, textAlign: 'right' }}>
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

      <p className="tiny" style={{ paddingBottom: 30 }}>
        A map listed here with no download link is a map we know existed and cannot currently find.
        If you have a copy, that is exactly what this page is for.
      </p>
    </div>
  )
}
