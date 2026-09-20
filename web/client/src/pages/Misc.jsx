import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ago, dur, num } from '../api'
import { Section, Empty, PlayerLink } from '../components/Bits'
import MapCard from '../components/MapCard'

// The smaller pages: a creator's page, one game's full breakdown, and the 404.

export function Creator() {
  const { name } = useParams()
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => { api.get(`/api/creators/${encodeURIComponent(name)}`).then(setD).catch((e) => setErr(e.message)) }, [name])
  if (err) return <div className="page"><h1>{err}</h1></div>
  if (!d) return <div className="page"><p className="sub">Loading.</p></div>
  return (
    <div className="page wide">
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="eyebrow">Creator</div>
        <h1>{d.creator.name}</h1>
        <p className="sub">{d.maps.length} map{d.maps.length === 1 ? '' : 's'} · {num(d.plays)} games played</p>
        {d.creator.claimed_by
          ? <p className="tiny">Claimed by <PlayerLink user={d.creator.claimed_by} avatar={false} />.</p>
          : <p className="tiny">Unclaimed. A creator proves who they are to staff and gets the Map Maker badge.</p>}
      </div>
      <Section title="Maps">
        <div className="grid c4">{d.maps.map((m) => <MapCard key={m.key} map={m} />)}</div>
      </Section>
    </div>
  )
}

// The post-match breakdown (13 §2c): the result card, per-player stats, and what it counted
// for. The round-by-round timeline is not here — it lives in the replay, and the site stores
// a pointer to the replay rather than the events.
export function Game() {
  const { id } = useParams()
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => { api.get(`/api/games/${encodeURIComponent(id)}`).then((j) => setD(j.game)).catch((e) => setErr(e.message)) }, [id])
  if (err) return <div className="page"><h1>{err}</h1></div>
  if (!d) return <div className="page"><p className="sub">Loading.</p></div>
  return (
    <div className="page">
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="eyebrow">{d.mode} · {d.match_id}</div>
        <h1><Link to={`/m/${d.map_key}`}>{d.map_title}</Link></h1>
        <div className="row wrap" style={{ gap: 7, marginTop: 8 }}>
          <span className="chip">Round {d.rounds}</span>
          {d.finish && <span className="chip ee">{d.finish.label}</span>}
          <span className="chip">{d.player_count === 1 ? 'Solo' : `${d.player_count} players`}</span>
          <span className="chip">{dur(d.duration_ms)} in game</span>
          <span className="chip">{dur(d.duration_rta_ms)} RTA</span>
          {d.paused_ms > 0 && <span className="chip">{dur(d.paused_ms)} paused</span>}
          {d.flags.map((f) => <span className="chip be" key={f}>{f.replace(/_/g, ' ')}</span>)}
          {!d.records_eligible && <span className="chip be">no records from this game</span>}
        </div>
        {d.fingerprint && <p className="tiny" style={{ marginTop: 8 }}>Run fingerprint <code>ENW-{d.fingerprint}</code> · finished {ago(d.ended_at)} on {d.box}</p>}
      </div>

      <Section title="Players">
        <div className="card">
          <table className="data">
            <thead>
              <tr><th>Player</th><th className="num">Score</th><th className="num">Kills</th><th className="num">Headshots</th>
                <th className="num">Downs</th><th className="num">Revives</th><th className="num">Rounds</th><th className="num">XP</th></tr>
            </thead>
            <tbody>
              {d.players.map((p) => (
                <tr key={p.steam_id}>
                  <td><PlayerLink user={p} />{p.late && <span className="chip be" style={{ marginLeft: 6 }}>late</span>}</td>
                  <td className="num">{num(p.score)}</td><td className="num">{num(p.kills)}</td><td className="num">{num(p.headshots)}</td>
                  <td className="num">{p.downs}</td><td className="num">{p.revives}</td><td className="num">{p.rounds_played}</td>
                  <td className="num">{num(p.xp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {d.replay && (
        <Section title="Replay">
          <div className="card">
            <p className="sub" style={{ margin: 0 }}>
              {Math.round(d.replay.size / 1048576 * 100) / 100} MB · {num(d.replay.chunks)} chunks · {num(d.replay.events)} events
            </p>
            <p className="tiny">
              Signed by key <code>{d.replay.key_id || 'unknown'}</code>.{' '}
              {d.replay.key_pinned
                ? 'That key is the one pinned for this box, so the replay is record-grade evidence.'
                : 'That key is NOT the one pinned for this box, so the file proves only that nothing changed since it was signed.'}
              {d.replay.recovered && ' Recovered after a host crash: good enough for a badge, not for a record.'}
            </p>
            <p className="tiny">Downloading your own replays needs the launcher; the 3D viewer is a VIP perk and is not built.</p>
          </div>
        </Section>
      )}
    </div>
  )
}

export function NotFound() {
  return (
    <div className="page">
      <h1>That page doesn&rsquo;t exist</h1>
      <p className="sub">A dead link says so rather than dumping you on the home page as if you&rsquo;d asked for it.</p>
      <Link className="btn" to="/">Back to the home page</Link>
    </div>
  )
}

export function Archive() {
  const [d, setD] = useState(null)
  useEffect(() => { api.get('/api/maps?archive=1&sort=name').then(setD).catch(() => {}) }, [])
  if (!d) return <div className="page"><p className="sub">Loading.</p></div>
  const broken = d.maps.filter((m) => m.health === 'broken')
  return (
    <div className="page wide">
      <Section title="The archive" sub={`${d.total} maps, including the ones that do not run on our servers.`}>
        <p className="sub" style={{ maxWidth: 620 }}>
          Originals are kept exactly as they were released: the file, its hash, where it came from and when.
          Playable packs and our overlays sit beside them and never replace them.
        </p>
        {broken.length > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: 18 }}>Not playable on ENW</div>
            <div className="card flat">
              {broken.map((m) => (
                <Link className="maprow" key={m.key} to={`/m/${m.key}`}>
                  <div className="name"><b>{m.title}</b><span>{m.key}</span></div>
                  <span /><span /><span className="tiny">broken</span>
                </Link>
              ))}
            </div>
          </>
        )}
        <div className="grid c4" style={{ marginTop: 18 }}>{d.maps.map((m) => <MapCard key={m.key} map={m} />)}</div>
      </Section>
    </div>
  )
}

export function Empty404() { return <Empty>Nothing here.</Empty> }
