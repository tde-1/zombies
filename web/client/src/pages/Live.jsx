import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, dur, num } from '../api'
import { socket } from '../socket'
import { Section, Empty, PlayerLink } from '../components/Bits'
import TopDown from '../components/TopDown'

// The web live view (99 §4.4, 13 §4b): round, players, points, downs, and a top-down view
// of where everybody is. **It uses no game slot** — that is the whole point of it existing
// as a web page rather than as in-game spectating, which on a four-slot engine costs a
// player their seat.
//
// Frames arrive over the socket, one room per game, at whatever rate the box sends (the
// site caps it at ~4.5 Hz). The initial frame comes with the join, so the page is populated
// before the second frame arrives rather than showing an empty canvas for 250 ms.

export default function Live() {
  const { matchId } = useParams()
  const [meta, setMeta] = useState(null)
  const [frame, setFrame] = useState(null)
  const [err, setErr] = useState(null)
  const [trails, setTrails] = useState(true)

  const load = useCallback(() => {
    api.get(`/api/live/${encodeURIComponent(matchId)}`)
      .then((j) => { setMeta(j); if (j.frame) setFrame(j.frame) })
      .catch((e) => setErr(e.message))
  }, [matchId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    let live = true
    socket.emit('watch', matchId, (r) => { if (live && r && !r.ok) setErr(r.error) })
    const on = (f) => { if (String(f.match_id) === String(matchId)) setFrame(f) }
    socket.on('live', on)
    return () => { live = false; socket.emit('unwatch', matchId); socket.off('live', on) }
  }, [matchId])

  // A game that stops sending frames has ended, crashed, or the box has gone. Re-ask the
  // server rather than guessing which — it knows whether a result landed.
  useEffect(() => {
    if (!frame) return undefined
    const t = setInterval(() => { if (Date.now() - frame.at > 20_000) load() }, 5000)
    return () => clearInterval(t)
  }, [frame, load])

  if (err) return <div className="page"><h1>{err}</h1><Link className="btn" to="/">Home</Link></div>
  if (!meta) return <div className="page"><p className="sub">Loading.</p></div>

  if (!frame && meta.ended) {
    return (
      <div className="page">
        <div className="card">
          <div className="eyebrow">This game has finished</div>
          <h1>{meta.ended.map_title} — round {meta.ended.rounds}</h1>
          <Link className="btn primary" to={`/game/${meta.ended.match_id}`}>The full breakdown</Link>
        </div>
      </div>
    )
  }
  if (!frame) {
    return (
      <div className="page">
        <div className="card">
          <div className="eyebrow">{meta.state}</div>
          <h1>Nothing to watch yet</h1>
          <p className="sub">
            {meta.state === 'leased' || meta.state === 'ready'
              ? 'The server has been reserved and is loading the map. This page fills in the moment the game starts.'
              : 'No box is sending frames for this game.'}
          </p>
        </div>
      </div>
    )
  }

  const s = frame.state
  const labels = meta.signal_labels || {}
  const connected = s.players.filter((p) => p.connected)
  const stale = Date.now() - frame.at > 6000

  return (
    <div className="page wide">
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="eyebrow">Live · {s.mode}{frame.box ? ` · ${frame.box}` : ''}</div>
            <h1>{meta.map ? <Link to={`/m/${meta.map.key}`}>{meta.map.title}</Link> : s.map_name || s.map}</h1>
            <div className="row wrap" style={{ gap: 7, marginTop: 8 }}>
              <span className="chip on">Round {s.round}</span>
              <span className="chip">{connected.length}/4 playing</span>
              <span className="chip">{s.zombies_alive} zombies</span>
              <span className="chip">{dur(s.elapsed_ms)}</span>
              {s.paused && <span className="chip be">Paused{s.pause_reason ? ` — ${s.pause_reason}` : ''}</span>}
              {s.cap_left_ms != null && s.cap_left_ms < 3600_000 && <span className="chip be">{dur(s.cap_left_ms)} to the cap</span>}
              {s.cap_ms == null && <span className="chip vip">Uncapped (VIP)</span>}
              {s.flags.map((f) => <span className="chip be" key={f}>{f.replace(/_/g, ' ')}</span>)}
            </div>
          </div>
          <div className="stack" style={{ alignItems: 'flex-end' }}>
            <span className={`tiny ${stale ? 'hot' : ''}`}>
              {stale ? 'no frame for a few seconds' : `frame ${num(frame.seq)}`}
            </span>
            <button className={`btn small ${trails ? 'on' : 'ghost'}`} onClick={() => setTrails((t) => !t)}>Trails</button>
          </div>
        </div>
      </div>

      <div className="grid c2" style={{ alignItems: 'start' }}>
        <div>
          <TopDown frame={frame} trails={trails} />
          <p className="tiny" style={{ marginTop: 6 }}>
            Positions as the server sees them: players at 20 Hz and zombies at 10 Hz on the box,
            downsampled to about four frames a second here. Watching costs no game slot.
          </p>
        </div>

        <div>
          <Section title="Players">
            <div className="card">
              <table className="data">
                <thead><tr><th>Player</th><th className="num">Points</th><th className="num">Health</th><th className="num">Downs</th><th>State</th></tr></thead>
                <tbody>
                  {s.players.map((p) => (
                    <tr key={p.slot}>
                      <td>
                        <span className="row" style={{ gap: 6 }}>
                          <i style={{ width: 9, height: 9, borderRadius: 2, background: PLAYER_COLOURS[p.slot % 4], display: 'inline-block' }} />
                          {p.steamid ? <PlayerLink user={{ steam_id: p.steamid, name: p.name }} avatar={false} /> : p.name}
                        </span>
                      </td>
                      <td className="num">{num(p.score)}</td>
                      <td className="num">{p.alive ? p.health : '—'}</td>
                      <td className="num">{p.downs}</td>
                      <td className="tiny">
                        {!p.connected ? <span className="hot">disconnected</span>
                          : p.down ? <span className="hot">down</span>
                            : p.afk_warned ? <span className="hot">idle</span>
                              : p.late ? 'late join' : p.weapon || 'alive'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Progress" sub="What the referee has seen on this map so far">
            <div className="card">
              {s.finish && <p><span className="chip ee">{s.finish.label || s.finish.kind}</span> done.</p>}
              {Object.keys(labels).length === 0 && s.signals.length === 0
                ? <Empty>This map has no manifest signals, so there is nothing to tick off but the round.</Empty>
                : (
                  <div className="row wrap" style={{ gap: 6 }}>
                    {Object.entries(labels).map(([id, label]) => (
                      <span className={`chip ${s.signals.includes(id) ? 'on' : ''}`} key={id}>{label}</span>
                    ))}
                    {/* A signal the manifest did not name still shows, under its raw id —
                        better a stranger's id than silence about something that fired. */}
                    {s.signals.filter((x) => !labels[x]).map((x) => <span className="chip on" key={x}>{x}</span>)}
                  </div>
                )}
            </div>
          </Section>

          {s.perf && (
            <Section title="Server">
              <div className="stats">
                <div className="stat"><span>Frame p50</span><b className="num">{s.perf.frame_ms_p50 ?? '—'} ms</b></div>
                <div className="stat"><span>Frame p99</span><b className="num">{s.perf.frame_ms_p99 ?? '—'} ms</b></div>
                {s.perf.cpu_pct != null && <div className="stat"><span>CPU</span><b className="num">{s.perf.cpu_pct}%</b></div>}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

export const PLAYER_COLOURS = ['#e4dfd1', '#7b7e58', '#b0342c', '#c9a94a']

// The list of games you can watch right now.
export function LiveList() {
  const [d, setD] = useState(null)
  useEffect(() => {
    const load = () => api.get('/api/live').then(setD).catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])
  const rows = useMemo(() => (d ? d.watchable : []), [d])
  if (!d) return <div className="page"><p className="sub">Loading.</p></div>
  return (
    <div className="page">
      <Section title="Live games" sub="Watching uses no game slot.">
        {rows.length === 0 ? <Empty>Nothing is running that you can watch. Private and friends-only lobbies are not listed.</Empty> : (
          <div className="card flat">
            {rows.map((g) => (
              <Link className="maprow" key={g.match_id} to={`/live/${g.match_id}`}>
                <div className="name">
                  <b>{g.map_title}</b>
                  <span>{g.players.map((p) => p.name).join(', ')}</span>
                </div>
                <span className="chip on">Round {g.round}</span>
                <span className="chip">{g.player_count}/4</span>
                <span className="tiny">{dur(g.elapsed_ms)}{g.paused ? ' · paused' : ''}</span>
              </Link>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
