import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { Section, Empty } from '../components/Bits'
import MapCard from '../components/MapCard'

// Playlists, "exactly the same as Movement's" (13 §3): rows on the Maps page, completion
// badges through the existing reward_badge machinery. Two kinds — staff-curated, and one
// AUTOMATIC per creator, which has no member rows and resolves from the author field, so a
// newly imported map joins its creator's list without anybody editing anything.

export default function Playlists() {
  const [d, setD] = useState(null)
  useEffect(() => { api.get('/api/playlists').then(setD).catch(() => {}) }, [])
  if (!d) return <div className="page"><p className="sub">Loading.</p></div>

  const curated = d.playlists.filter((p) => p.kind !== 'creator')
  const creators = d.playlists.filter((p) => p.kind === 'creator')

  return (
    <div className="page wide">
      <Section title="Playlists" sub="Finish every map in a list to earn its badge.">
        {curated.length === 0 ? <Empty>None yet.</Empty> : (
          <div className="grid c3">{curated.map((p) => <Row key={p.id} p={p} />)}</div>
        )}
      </Section>
      <Section title="By creator" sub="One per creator, kept up to date automatically.">
        {creators.length === 0 ? <Empty>None yet.</Empty> : (
          <div className="grid c3">{creators.map((p) => <Row key={p.id} p={p} />)}</div>
        )}
      </Section>
    </div>
  )
}

function Row({ p }) {
  return (
    <Link className="card" to={`/playlists/${p.slug}`}>
      <h3>{p.name}</h3>
      <p className="sub" style={{ margin: '4px 0 8px' }}>{p.blurb || `${p.map_count} maps`}</p>
      <div className="row wrap" style={{ gap: 5 }}>
        {p.maps.slice(0, 6).map((m) => <span className="chip" key={m.key}>{m.title}</span>)}
        {p.map_count > 6 && <span className="chip">+{p.map_count - 6}</span>}
      </div>
      {p.progress && (
        <div style={{ marginTop: 10 }}>
          <span className="bar"><i style={{ width: `${Math.round((p.progress.done / Math.max(1, p.progress.total)) * 100)}%` }} /></span>
          <span className="tiny">{p.progress.done} / {p.progress.total} beaten</span>
        </div>
      )}
      {p.reward_badge && <div className="tiny" style={{ marginTop: 6 }}>Badge: {p.reward_badge.name}</div>}
    </Link>
  )
}

export function PlaylistPage() {
  const { slug } = useParams()
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => { api.get(`/api/playlists/${slug}`).then(setD).catch((e) => setErr(e.message)) }, [slug])
  if (err) return <div className="page"><h1>{err}</h1></div>
  if (!d) return <div className="page"><p className="sub">Loading.</p></div>
  const p = d.playlist
  return (
    <div className="page wide">
      <Section title={p.name} sub={p.blurb || ''}>
        {p.progress && <p className="tiny">{p.progress.done} of {p.progress.total} beaten.</p>}
        <div className="grid c4">{p.maps.map((m) => <MapCard key={m.key} map={m} />)}</div>
      </Section>
    </div>
  )
}
