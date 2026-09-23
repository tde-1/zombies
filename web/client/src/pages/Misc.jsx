import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ago, dur, num } from '../api'
import { Section, Empty, Loading, Untracked, PlayerLink, Lockup } from '../components/Bits'
import MapCard from '../components/MapCard'

// The smaller pages: a creator's page, one game's full breakdown, and the 404.

export function Creator() {
  const { name } = useParams()
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => { api.get(`/api/creators/${encodeURIComponent(name)}`).then(setD).catch((e) => setErr(e.message)) }, [name])
  if (err) return <div className="page"><h1>{err}</h1></div>
  if (!d) return <div className="page"><Loading /></div>
  return (
    <div className="page wide">
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="section-label">Creator</div>
        <h1>{d.creator.name}</h1>
        <p className="sub">{d.maps.length} map{d.maps.length === 1 ? '' : 's'} · {num(d.plays)} games played</p>
        {d.creator.claimed_by
          ? <p className="tiny">Claimed by <PlayerLink user={d.creator.claimed_by} avatar={false} />.</p>
          : <p className="tiny">Unclaimed.</p>}
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
  if (!d) return <div className="page"><Loading /></div>
  return (
    <div className="page">
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="mono tiny">{d.mode} · {d.match_id}</div>
        <h1><Link to={`/m/${d.map_key}`}>{d.map_title}</Link></h1>
        <div className="row wrap" style={{ gap: 7, marginTop: 8 }}>
          <span className="chip">Round {d.rounds}</span>
          {d.finish && <span className="tag gold">{d.finish.label}</span>}
          <span className="chip">{d.player_count === 1 ? 'Solo' : `${d.player_count} players`}</span>
          <span className="chip">{dur(d.duration_ms)} in game</span>
          <span className="chip">{dur(d.duration_rta_ms)} RTA</span>
          {(d.mode === 'local' || d.self_reported) && <Untracked />}
          {d.paused_ms > 0 && <span className="chip">{dur(d.paused_ms)} paused</span>}
          {d.flags.map((f) => <span className="tag hot" key={f}>{f.replace(/_/g, ' ')}</span>)}
          {!d.records_eligible && <span className="tag hot">No records</span>}
        </div>
        {/* 13 §4: a Local game ran on the player's own PC with the console available.
            The Untracked tag in the chip row above says that once; it does not need a
            paragraph as well. */}
        {d.fingerprint && (
          <p className="tiny" style={{ marginTop: 8 }}>
            Run fingerprint <code>ENW-{d.fingerprint}</code> · finished {ago(d.ended_at)}
            {/* A local game has no box — it ran on the player's own PC — so it says that
                rather than trailing an "on" with nothing after it. */}
            {d.box ? ` on ${d.box}` : d.mode === 'local' ? ' on the player’s own PC' : ''}
          </p>
        )}
      </div>

      <Section title="Players">
        <div className="listing">
          <table className="data">
            <thead>
              <tr><th>Player</th><th className="num">Score</th><th className="num">Kills</th><th className="num">Headshots</th>
                <th className="num">Downs</th><th className="num">Revives</th><th className="num">Rounds</th><th className="num">XP</th></tr>
            </thead>
            <tbody>
              {d.players.map((p) => (
                <tr key={p.steam_id}>
                  <td><PlayerLink user={p} />{p.late && <span className="tag" style={{ marginLeft: 6 }}>late</span>}</td>
                  <td className="num">{num(p.score)}</td><td className="num">{num(p.kills)}</td><td className="num">{num(p.headshots)}</td>
                  <td className="num">{p.downs}</td><td className="num">{p.revives}</td><td className="num">{p.rounds_played}</td>
                  <td className="num">{num(p.xp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {d.replay && <Replay matchId={d.match_id} />}
    </div>
  )
}

// The replay block. Everything here is public except the bytes: 99 §4.7 rests records on
// a signed replay, so the pointer, the key and the verdict have to be checkable by anyone,
// including somebody who thinks the record is fake. That is the point of them.
function Replay({ matchId }) {
  const [r, setR] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => { api.get(`/api/replays/${encodeURIComponent(matchId)}`).then((j) => setR(j.replay)).catch((e) => setErr(e.message)) }, [matchId])
  if (err || !r) return null
  return (
    <Section title="Replay">
      <div className={`card ${r.ok ? '' : 'warn'}`}>
        <p className="sub" style={{ margin: 0 }}>
          {Math.round((r.size / 1048576) * 100) / 100} MB · {num(r.chunks)} chunks · {num(r.events)} events
          {r.mb_per_hour ? ` · ${r.mb_per_hour} MB per game-hour` : ''}
        </p>
        <p className="tiny" style={{ marginTop: 6 }}>
          <b className={r.ok ? 'good' : 'hot'}>{r.reason}</b>
        </p>
        <pre className="block">{r.verify_command}</pre>
        <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
          {/* Watching needs neither the download entitlement nor the file itself: the
              track is decoded server-side and only positions cross the wire. A replay
              that failed to verify is still watchable and still says so above. */}
          <Link className="btn small" to={`/replay/${encodeURIComponent(matchId)}`}>Watch in 3D</Link>
          {r.can_download
            ? <a className="btn small ghost" href={`/api/replays/${encodeURIComponent(matchId)}/download`}>Download ({r.download_reason})</a>
            : null}
        </div>
        {!r.can_download && <p className="tiny">{r.download_reason}</p>}
        {!r.available && <p className="tiny">Not downloadable yet.</p>}
      </div>
    </Section>
  )
}

export function NotFound() {
  return (
    <div className="page">
      <Link to="/" aria-label="ENW home" style={{ display: 'inline-block', margin: '8px 0 18px' }}><Lockup h={30} /></Link>
      <h1>Page not found</h1>
      <Link className="btn" to="/" style={{ marginTop: 16 }}>Home</Link>
    </div>
  )
}

export function Empty404() { return <Empty>Nothing here.</Empty> }
