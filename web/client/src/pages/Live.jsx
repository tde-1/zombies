import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, dur, num } from '../api'
import { socket } from '../socket'
import { Section, Empty, Loading, Stat, PlayerLink } from '../components/Bits'
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
  if (!meta) return <div className="page"><Loading /></div>

  if (!frame && meta.ended) {
    return (
      <div className="page">
        <div className="card">
          <div className="section-label">Finished</div>
          <h1>{meta.ended.map_title} · round {meta.ended.rounds}</h1>
          <Link className="btn primary" to={`/game/${meta.ended.match_id}`} style={{ marginTop: 12 }}>The full breakdown</Link>
        </div>
      </div>
    )
  }
  if (!frame) {
    return (
      <div className="page">
        <div className="card">
          <div className="section-label">{meta.state}</div>
          <h1>Nothing to watch yet</h1>
          <p className="sub" style={{ margin: 0 }}>
            {meta.state === 'leased' || meta.state === 'ready' ? 'The map is loading.' : 'No frames from this game.'}
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
            <div className="mono tiny">Live · {s.mode}{frame.box ? ` · ${frame.box}` : ''}</div>
            <h1>{meta.map ? <Link to={`/m/${meta.map.key}`}>{meta.map.title}</Link> : s.map_name || s.map}</h1>
            <div className="row wrap" style={{ gap: 7, marginTop: 8 }}>
              <span className="chip on">Round {s.round}</span>
              <span className="chip">{connected.length}/4 playing</span>
              <span className="chip">{s.zombies_alive} zombies</span>
              <span className="chip">{dur(s.elapsed_ms)}</span>
              {s.paused && <span className="tag hot">Paused{s.pause_reason ? `: ${s.pause_reason}` : ''}</span>}
              {s.cap_left_ms != null && s.cap_left_ms < 3600_000 && <span className="tag hot">{dur(s.cap_left_ms)} to the cap</span>}
              {s.cap_ms == null && <span className="tag gold">Uncapped</span>}
              {s.flags.map((f) => <span className="tag hot" key={f}>{f.replace(/_/g, ' ')}</span>)}
            </div>
          </div>
          <div className="stack" style={{ alignItems: 'flex-end' }}>
            <span className={`tiny ${stale ? 'hot' : ''}`}>
              {stale ? 'no frames' : `frame ${num(frame.seq)}`}
            </span>
            <button className={`btn small ${trails ? 'on' : 'ghost'}`} onClick={() => setTrails((t) => !t)}>Trails</button>
          </div>
        </div>
      </div>

      <div className="grid c2" style={{ alignItems: 'start' }}>
        <div>
          <TopDown frame={frame} trails={trails} />
        </div>

        <div>
          <Section title="Players">
            <div className="listing">
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

          <Section title="Progress">
            <div className="card">
              {s.finish && <p style={{ margin: '0 0 8px' }}><span className="tag gold">{s.finish.label || s.finish.kind}</span></p>}
              {Object.keys(labels).length === 0 && s.signals.length === 0
                ? <Empty>No manifest signals.</Empty>
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
                <Stat label="Frame p50" value={s.perf.frame_ms_p50 != null ? `${s.perf.frame_ms_p50} ms` : null} />
                <Stat label="Frame p99" value={s.perf.frame_ms_p99 != null ? `${s.perf.frame_ms_p99} ms` : null} />
                {s.perf.cpu_pct != null && <Stat label="CPU" value={`${s.perf.cpu_pct}%`} />}
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
  if (!d) return <div className="page"><Loading /></div>
  return (
    <div className="page">
      <Section title="Live games" right={<span className="tiny num">{rows.length}</span>}>
        {rows.length === 0 ? <Empty>Nothing to watch.</Empty> : (
          <div className="listing">
            {rows.map((g) => (
              <Link className="maprow" key={g.match_id} to={`/live/${g.match_id}`}>
                <div className="name">
                  <b>{g.map_title}</b>
                  <span>{g.players.map((p) => p.name).join(', ')}</span>
                </div>
                <span className="chip on">Round {g.round}</span>
                <span className="tag">{g.player_count}/4</span>
                <span className="tiny num">{dur(g.elapsed_ms)}{g.paused ? ' · paused' : ''}</span>
              </Link>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
