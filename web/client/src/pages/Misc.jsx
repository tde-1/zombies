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
        {/* 13 §4: a Local game ran on the player's own PC with the console available.
            Saying so on the game itself, not only in a tooltip, is the difference between
            a history and a scoreboard. */}
        {(d.mode === 'local' || d.self_reported) && (
          <p className="tiny hot" style={{ marginTop: 8 }}>
            {d.mode === 'local' ? 'Local game' : 'Self-reported'} — untracked. It earns no badge,
            no record and no XP, and its replay is not record evidence. Tracking needs our servers.
          </p>
        )}
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
        <p className="tiny">
          Check it yourself — the signature is over the whole chain, and the key is the one this site
          pinned for that box, not the one the file claims:
        </p>
        <pre className="block">{r.verify_command}</pre>
        {r.can_download
          ? <a className="btn small" href={`/api/replays/${encodeURIComponent(matchId)}/download`}>Download ({r.download_reason})</a>
          : <p className="tiny">{r.download_reason}</p>}
        {!r.available && <p className="tiny">The file is on the game box; there is no object store yet.</p>}
      </div>
    </Section>
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

export function Empty404() { return <Empty>Nothing here.</Empty> }
