import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ago, clock, num } from '../api'
import { useSession } from '../session'
import { Section, Empty, Loading, PlayerLink } from '../components/Bits'

// The mod tools at launch (99 §4.9): the reports queue, infractions and bans, and record
// review WITH THE REPLAY. Plus the operator surfaces: the boxes and their key pins, leasing
// a game by hand, and the map of the week.
//
// The loudest thing on this page is a box whose replay-signing key changed, because that is
// the one condition under which a perfectly valid-looking replay is not evidence.

const TABS = ['overview', 'reports', 'records', 'boxes', 'waitlist']

export default function Admin() {
  const { isMod, isAdmin } = useSession()
  const [tab, setTab] = useState('overview')
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)

  const load = useCallback(() => { api.get('/api/admin').then(setD).catch((e) => setErr(e.message)) }, [])
  useEffect(() => { load() }, [load])

  if (!isMod) return <div className="page"><h1>Moderators only</h1></div>
  if (err) return <div className="page"><h1>{err}</h1></div>
  if (!d) return <div className="page"><Loading /></div>

  return (
    <div className="page wide">
      <div className="seg" style={{ marginBottom: 14 }}>
        {TABS.map((t) => <button key={t} type="button" className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
      </div>

      {d.key_warnings.length > 0 && (
        <div className="card warn" style={{ marginBottom: 18 }}>
          <div className="section-label">Replay key changed</div>
          {d.key_warnings.map((b) => (
            <p key={b.id}>
              <b>{b.name}</b> is presenting key <code>{b.key.pending}</code> but <code>{b.key.pinned}</code> is pinned.
              Every replay it posts is stored unpinned and is not record-grade evidence until this is settled.
              {isAdmin && (
                <span className="row" style={{ gap: 6, marginTop: 6 }}>
                  <button className="btn small primary" onClick={async () => { await api.post(`/api/admin/boxes/${b.id}/key/accept`); load() }}>Accept the new key</button>
                  <button className="btn small ghost" onClick={async () => { await api.post(`/api/admin/boxes/${b.id}/key/reject`); load() }}>Reject</button>
                </span>
              )}
            </p>
          ))}
        </div>
      )}

      {tab === 'overview' && <Overview d={d} onChange={load} isAdmin={isAdmin} />}
      {tab === 'reports' && <Reports onChange={load} />}
      {tab === 'records' && <RecordReview />}
      {tab === 'boxes' && <Boxes d={d} onChange={load} isAdmin={isAdmin} />}
      {tab === 'waitlist' && <Waitlist onChange={load} />}
    </div>
  )
}

function Overview({ d, onChange, isAdmin }) {
  return (
    <>
      <div className="stats" style={{ marginBottom: 20 }}>
        <div className="stat"><span>Open reports</span><b className="num">{d.counts.new}</b></div>
        <div className="stat"><span>Active bans</span><b className="num">{d.counts.bans}</b></div>
        <div className="stat"><span>Players</span><b className="num">{num(d.counts.users)}</b></div>
        <div className="stat"><span>Waiting</span><b className="num">{d.counts.waiting}</b></div>
        <div className="stat"><span>Maps</span><b className="num">{d.counts.maps}</b></div>
        <div className="stat"><span>Games</span><b className="num">{num(d.counts.games)}</b></div>
        <div className="stat"><span>Online</span><b className="num">{d.presence.online}</b></div>
        <div className="stat"><span>In game</span><b className="num">{d.presence.in_game}</b></div>
      </div>

      <Section title="ENW link">
        <div className="card">
          <p className="sub" style={{ margin: 0 }}>{d.enw.note}</p>
          <p className="tiny">Base: {d.enw.base || 'not set'} · token: {d.enw.has_token ? 'set' : 'not set'}</p>
        </div>
      </Section>

      {isAdmin && <LeaseForm onChange={onChange} />}

      <Section title="Activity">
        <div className="card">
          <table className="data">
            <tbody>
              {d.recent_activity.map((a) => (
                <tr key={a.id}>
                  <td className="tiny">{ago(a.logged_at)}</td>
                  <td>{a.event}</td>
                  <td className="tiny mono">{a.metadata}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  )
}

function LeaseForm({ onChange }) {
  const [map, setMap] = useState('nazi_zombie_prototype')
  const [box, setBox] = useState('box-a')
  const [mode, setMode] = useState('verified')
  const [out, setOut] = useState(null)
  const go = async () => {
    try { setOut(await api.post('/api/admin/lease', { map, box, mode })) } catch (e) { setOut({ error: e.message }) }
    onChange()
  }
  return (
    <Section title="Lease a game by hand">
      <div className="card row wrap">
        <input type="text" value={map} onChange={(e) => setMap(e.target.value)} style={{ maxWidth: 260 }} />
        <input type="text" value={box} onChange={(e) => setBox(e.target.value)} style={{ maxWidth: 140 }} />
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: 'auto' }}>
          <option value="verified">Verified</option><option value="custom">Custom</option>
        </select>
        <button className="btn primary" onClick={go}>Lease</button>
      </div>
      {out && <pre className="block" style={{ marginTop: 8 }}>{JSON.stringify(out.error ? out : { ok: out.ok, box: out.box, match_id: out.match_id, nonce: out.nonce }, null, 1)}</pre>}
    </Section>
  )
}

function Reports({ onChange }) {
  const [d, setD] = useState(null)
  const load = useCallback(() => api.get('/api/admin/reports').then(setD).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  if (!d) return <Loading />
  return (
    <Section title="Reports">
      {d.reports.length === 0 ? <Empty>Nothing waiting.</Empty> : d.reports.map((r) => (
        <div className="card" key={r.id} style={{ marginBottom: 10 }}>
          <div className="spread">
            <div>
              <div className="mono tiny">{r.kind} · {ago(r.at)}</div>
              <div>Reported by <PlayerLink user={r.reporter} avatar={false} />{r.reported && <> about <PlayerLink user={r.reported} avatar={false} /></>}</div>
              {r.reason && <p className="sub">{r.reason}</p>}
              {r.detail && <p className="tiny">{r.detail}</p>}
              {r.context && <pre className="block">{r.context.body}</pre>}
            </div>
            <div className="stack">
              <button className="btn small" onClick={async () => { await api.post(`/api/admin/reports/${r.id}/resolve`, { status: 'closed' }); load(); onChange() }}>Close</button>
              {r.reported && <BanControls who={r.reported} onDone={() => { load(); onChange() }} />}
            </div>
          </div>
        </div>
      ))}
    </Section>
  )
}

function BanControls({ who, onDone }) {
  const [kind, setKind] = useState('griefing')
  return (
    <div className="row" style={{ gap: 5 }}>
      <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}>
        <option value="cheating">Cheating</option>
        <option value="chat">Chat abuse</option>
        <option value="afk-farming">AFK farming</option>
        <option value="griefing">Griefing</option>
      </select>
      <button className="btn small ghost" onClick={async () => { await api.post(`/api/admin/player/${who.steam_id}/infract`, { kind }); onDone() }}>Infraction</button>
      <button className="btn small primary" title={kind === 'griefing' ? 'A public-play ban: they keep playing with friends' : kind === 'cheating' ? 'Wipes their records and map badges' : ''}
        onClick={async () => { await api.post(`/api/admin/player/${who.steam_id}/ban`, { kind }); onDone() }}>
        {kind === 'griefing' ? 'Public-play ban' : 'Ban'}
      </button>
    </div>
  )
}

const GRADE_LABEL = {
  signed: "signed by the box's pinned key",
  unpinned: 'UNPINNED KEY',
  'unknown-key': 'key unknown',
  recovered: 'recovered after a crash',
  none: 'no replay',
}

function RecordReview() {
  const [d, setD] = useState(null)
  const [checked, setChecked] = useState({})
  const [busy, setBusy] = useState(null)
  const load = useCallback(() => api.get('/api/admin/records/review').then(setD).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  if (!d) return <Loading />

  const verify = async (id) => {
    setBusy(id)
    try {
      const out = await api.post(`/api/admin/records/${id}/verify`)
      setChecked((c) => ({ ...c, [id]: out }))
    } catch (e) {
      setChecked((c) => ({ ...c, [id]: { ok: false, error: e.message } }))
    } finally { setBusy(null) }
  }

  return (
    <Section title="Record review">
      {d.records.length === 0 ? <Empty>No records yet.</Empty> : (
        <div className="card">
          <table className="data">
            <thead><tr><th>Map</th><th>Category</th><th>Players</th><th className="num">Result</th><th>Rules</th><th>Replay</th><th></th></tr></thead>
            <tbody>
              {d.records.map((r) => {
                const c = checked[r.id]
                return (
                  <tr key={r.id}>
                    <td><Link to={`/m/${r.map_key}`}>{r.map_key.replace('nazi_zombie_', '')}</Link></td>
                    <td className="tiny">{r.category} · {r.player_count === 1 ? 'solo' : `${r.player_count}p`} · {r.profile}</td>
                    <td className="tiny">{r.players.map((p) => p.name).join(', ')}</td>
                    <td className="num">{r.round ? `R${r.round}` : clock(r.value_ms)}</td>
                    <td className="tiny">{r.profile_ok ? 'ok' : <span className="hot" title={r.profile_note}>mismatch</span>}</td>
                    <td className="tiny" style={{ maxWidth: 260 }}>
                      {!r.replay ? '—' : (
                        <>
                          <span className={r.replay.ok ? '' : 'hot'} title={r.replay.reason}>{GRADE_LABEL[r.replay.grade] || r.replay.grade}</span>
                          {/* The verification is a real re-read of the file against the
                              box's pinned key, not a re-statement of what we stored. */}
                          {c && (
                            <div className={c.ok ? 'good' : 'hot'} style={{ marginTop: 4 }}>
                              {c.verdict || c.error}
                              {c.errors && c.errors.length > 0 && <div className="tiny">{c.errors.join('; ')}</div>}
                              {c.ok && <div className="tiny">{c.chunks} chunks, {num(c.events)} events</div>}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {r.replay && r.replay.available && (
                          <button className="btn small ghost" disabled={busy === r.id} onClick={() => verify(r.id)}>
                            {busy === r.id ? '…' : 'Verify'}
                          </button>
                        )}
                        <button className="btn small ghost" onClick={async () => { await api.post(`/api/admin/records/${r.id}/void`); load() }}>Void</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="tiny" style={{ marginTop: 8 }}>
            Verify re-reads every chunk from disk, rehashes the chain and checks the footer signature
            <b> against the key pinned for that box</b>. A replay signed by any other key fails here however
            valid it is on its own terms.
          </p>
        </div>
      )}
    </Section>
  )
}

function Boxes({ d, onChange, isAdmin }) {
  return (
    <Section title="Game boxes">
      {d.boxes.map((b) => (
        <div className="card" key={b.id} style={{ marginBottom: 10 }}>
          <div className="spread">
            <div>
              <h3>{b.name} {b.online ? <span className="chip on">online</span> : <span className="chip">offline</span>}</h3>
              <p className="tiny">{b.note} · {b.region} · last poll {b.last_poll ? ago(b.last_poll) : 'never'} · state {b.last_state || '—'}</p>
              <p className="tiny">
                Replay key: {b.key.pinned ? <code>{b.key.pinned}</code> : <span className="hot">none pinned — its replays are not record-grade evidence</span>}
                {b.key.pending && <span className="hot"> · pending <code>{b.key.pending}</code></span>}
              </p>
            </div>
            {isAdmin && (
              <button className="btn small ghost" onClick={async () => { await api.post(`/api/admin/boxes/${b.id}/enabled`, { enabled: !b.enabled }); onChange() }}>
                {b.enabled ? 'Disable' : 'Enable'}
              </button>
            )}
          </div>
          {b.status && b.status.instances && b.status.instances.length > 0 && (
            <table className="data" style={{ marginTop: 8 }}>
              <thead><tr><th>Instance</th><th>Match</th><th>State</th><th className="num">Cores</th><th className="num">RSS</th></tr></thead>
              <tbody>
                {b.status.instances.map((i) => (
                  <tr key={i.id}>
                    <td>{i.id}</td><td className="mono tiny">{i.match_id || '—'}</td><td>{i.state}</td>
                    <td className="num">{i.usage ? i.usage.cores_avg.toFixed(3) : '—'}</td>
                    <td className="num">{i.usage ? `${Math.round(i.usage.rss_bytes / 1048576)} MiB` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </Section>
  )
}

function Waitlist({ onChange }) {
  const [d, setD] = useState(null)
  const load = useCallback(() => api.get('/api/admin/waitlist').then(setD).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  if (!d) return <Loading />
  return (
    <Section title="Waiting list">
      {d.users.length === 0 ? <Empty>Nobody waiting.</Empty> : (
        <div className="card">
          <table className="data">
            <tbody>
              {d.users.map((u) => (
                <tr key={u.steam_id}>
                  <td><PlayerLink user={u} /></td>
                  <td className="tiny">{ago(u.created_at)}</td>
                  <td><button className="btn small accent" onClick={async () => { await api.post(`/api/admin/player/${u.steam_id}/approve`); load(); onChange() }}>Approve</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
