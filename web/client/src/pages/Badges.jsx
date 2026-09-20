import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api, ago } from '../api'
import { Section, Empty, Hex, PlayerLink } from '../components/Bits'

// The badges directory (Movement's /badges), with the four kinds of 05 grouped and each
// one's `obtain` line shown. Movement's note applies: a directory where half the rows say
// nothing about how the badge is got is a directory you cannot read, so every badge carries
// one sentence, staff badges included.

const GROUPS = [
  ['map', 'Map badges', 'One per map, earned by its main finish: Easter Egg, else Buyable Ending, else Round N. Other finishes are ticks on the same badge.'],
  ['record', 'Record badges', 'Held, not earned. Gold while you hold a record on that map; it moves when the record does.'],
  ['achievement', 'Achievements', 'Rules the site checks. Never hand-awarded, and never taken back.'],
  ['staff', 'Staff', 'Awarded by staff.'],
]

export default function Badges() {
  const [d, setD] = useState(null)
  useEffect(() => { api.get('/api/badges').then(setD).catch(() => {}) }, [])
  if (!d) return <div className="page"><p className="sub">Loading.</p></div>
  const held = new Set(d.held)

  return (
    <div className="page wide">
      {GROUPS.map(([kind, title, sub]) => {
        const rows = d.badges.filter((b) => b.kind === kind)
        if (!rows.length) return null
        return (
          <Section key={kind} title={title} sub={sub}>
            <div className="grid c4">
              {rows.map((b) => {
                const p = d.progress[b.slug]
                return (
                  <Link className="card row" key={b.id} to={`/badges/${b.slug}`} style={{ gap: 12, alignItems: 'flex-start' }}>
                    <Hex badge={b} size={52} gold={kind === 'record' && held.has(b.id)} locked={!held.has(b.id)} />
                    <div style={{ minWidth: 0 }}>
                      <h3>{b.name}</h3>
                      <p className="tiny" style={{ margin: '3px 0' }}>{b.obtain}</p>
                      <div className="tiny">{b.holders} {b.holders === 1 ? 'holder' : 'holders'}</div>
                      {p && !held.has(b.id) && (
                        <div style={{ marginTop: 5 }}>
                          <span className="bar"><i style={{ width: `${Math.round((p.current / p.target) * 100)}%` }} /></span>
                          <span className="tiny">{p.current} / {p.target}</span>
                        </div>
                      )}
                    </div>
                  </Link>
                )
              })}
            </div>
          </Section>
        )
      })}
    </div>
  )
}

export function BadgePage() {
  const { slug } = useParams()
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => { api.get(`/api/badges/${slug}`).then(setD).catch((e) => setErr(e.message)) }, [slug])
  if (err) return <div className="page"><h1>{err}</h1></div>
  if (!d) return <div className="page"><p className="sub">Loading.</p></div>
  const b = d.badge
  return (
    <div className="page">
      <div className="card row" style={{ gap: 18, marginBottom: 20 }}>
        <Hex badge={b} size={86} gold={b.kind === 'record'} />
        <div>
          <div className="eyebrow">{b.kind}</div>
          <h1>{b.name}</h1>
          <p className="sub">{b.description}</p>
          <p className="tiny">{b.obtain}</p>
          {b.map_key && <Link className="chip" to={`/m/${b.map_key}`}>{b.map_key}</Link>}
        </div>
      </div>
      <Section title={`${d.holders.length} ${d.holders.length === 1 ? 'holder' : 'holders'}`}>
        {d.holders.length === 0 ? <Empty>Nobody holds this yet.</Empty> : (
          <div className="card">
            <table className="data">
              <tbody>
                {d.holders.map((h) => (
                  <tr key={h.steam_id}>
                    <td><PlayerLink user={h} /></td>
                    <td className="tiny">{h.solo ? 'solo' : ''}</td>
                    <td className="tiny">{(h.ticks || []).join(' · ')}</td>
                    <td className="tiny">{ago(h.awarded_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}
