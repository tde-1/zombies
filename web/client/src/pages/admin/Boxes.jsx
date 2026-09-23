import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { Panel, Empty, when, mb, useLoad, useAct, useAdmin } from './kit'

// Boxes: every host agent, its slots, and the games on them. Read from what the agent
// already sends (its 10 s heartbeat, the leases it polls, the referee's live frames); the
// site never dials a box. Retire and Restart are lease changes the agent picks up on its next
// poll (host.md §13.2). Neither goes through while a player is connected without a confirm
// that names them: the server refuses (409) until the request names exactly who.

const SEAT = { connected: ['in game', 'good'], left: ['left', 'hot'], quit: ['quit', ''], never: ['not joined', ''] }
const dur = (ms) => { if (!ms) return '—'; const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m` }

export default function Boxes({ go, openUser, reload }) {
  const b = useLoad(() => api.get('/api/admin/boxes/live'), [])
  useEffect(() => { const t = setInterval(b.reload, 5000); return () => clearInterval(t) }, [b.reload])
  if (!b.data) return <Panel title="Boxes"><Empty>{b.err || 'Loading…'}</Empty></Panel>
  if (!b.data.boxes.length) return <Panel title="Boxes"><Empty>No boxes. Register one with web/tools/register-box.js.</Empty></Panel>
  return b.data.boxes.map((x) => <Box key={x.id} x={x} go={go} openUser={openUser} onDone={() => { b.reload(); reload() }} />)
}

function Box({ x, go, openUser, onDone }) {
  const act = useAct()
  const { confirm } = useAdmin()
  const [edit, setEdit] = useState(false)
  const [addr, setAddr] = useState(x.address || '')
  const [max, setMax] = useState(x.capacity.configured_max || 1)
  const [reserve, setReserve] = useState(x.capacity.configured_reserve == null ? '' : String(x.capacity.configured_reserve))

  const toggle = async () => {
    const ok = await confirm({ title: `${x.enabled ? 'Disable' : 'Enable'} ${x.name}?`, lines: [x.enabled && 'No new leases, and its games cannot post results.'], danger: x.enabled, label: x.enabled ? 'Disable' : 'Enable' })
    if (ok && await act(() => api.post(`/api/admin/boxes/${x.id}/enabled`, { enabled: !x.enabled }), 'Saved')) onDone()
  }
  const saveEdit = async () => {
    const a = await act(() => api.post(`/api/admin/boxes/${encodeURIComponent(x.name)}/address`, { address: addr.trim() }))
    const c = a && await act(() => api.post(`/api/admin/boxes/${encodeURIComponent(x.name)}/capacity`, { max_instances: Number(max), reserve: reserve === '' ? null : Number(reserve) }), 'Saved')
    if (c) { setEdit(false); onDone() }
  }

  // The guarded lease actions: ask once, and if the server says somebody is in, show who and
  // ask again with exactly them.
  const leaseAct = async (l, what) => {
    const verb = what === 'retire' ? 'Retire' : 'Restart'
    const first = await confirm({
      title: `${verb} ${l.map}?`,
      lines: [
        `${l.match_id} on ${x.name}${l.instance ? ` · slot ${l.instance.id}` : ''}.`,
        what === 'retire' ? 'The box stops this game on its next poll.' : 'The same players relaunch into a fresh game.',
        l.in_game === 0 && l.seats_known && 'Nobody is connected.',
      ],
      danger: true, label: verb,
    })
    if (!first) return
    let res
    try { res = await api.post(`/api/admin/leases/${l.match_id}/${what}`, {}) } catch (e) {
      if (e.status !== 409 || !e.body || !e.body.needs_confirm) return act(() => Promise.reject(e))
      const again = await confirm({
        title: `${e.body.players.length === 1 ? 'Somebody is' : `${e.body.players.length} people are`} in this game`,
        lines: [e.body.unknown ? 'Not known who is connected. Leased into it:' : `${verb} ends it for:`],
        people: e.body.players,
        type: 'end it', danger: true, label: `${verb} anyway`,
      })
      if (!again) return
      res = await act(() => api.post(`/api/admin/leases/${l.match_id}/${what}`, { confirm: e.body.confirm }))
      if (!res) return
    }
    act(async () => res, what === 'retire' ? 'Retired' : `Restarted as ${res.match_id}`)
    onDone()
  }

  const h = x.host || {}
  return (
    <Panel className="adm-box"
      title={<span>{x.name} <span className={`tag ${x.online ? 'good' : 'hot'}`}>{x.online ? 'online' : 'offline'}</span>{!x.enabled && <span className="tag hot">disabled</span>}</span>}
      sub={[x.region, x.note, `polled ${when(x.last_poll)}`, h.cpu && `${h.cpu}${h.cores ? ` · ${h.cores} cores` : ''}`].filter(Boolean).join(' · ')}
      right={(
        <span className="adm-row">
          <button type="button" className="btn small ghost" onClick={() => setEdit(!edit)}>{edit ? 'Close' : 'Settings'}</button>
          <button type="button" className="btn small ghost" onClick={toggle}>{x.enabled ? 'Disable' : 'Enable'}</button>
        </span>
      )}>
      <div className="adm-facts">
        <span><b>{x.leases.length}</b>/{x.capacity.max} slots leased</span>
        <span><b>{x.capacity.reserve}</b> kept for agents</span>
        <span>protocol <b>v{x.capacity.protocol}</b></span>
        {x.mem && (
          <span title={`MemAvailable at the last heartbeat. Below the floor the box refuses agent boots and a player's boot evicts agent games.${x.mem.total_bytes ? ` Total ${mb(x.mem.total_bytes)}.` : ''}`}>
            RAM free <b className={x.mem.floor_bytes && x.mem.available_bytes < x.mem.floor_bytes ? 'hot' : ''}>{mb(x.mem.available_bytes)}</b>
            {x.mem.floor_bytes ? <span className="faint"> · floor {mb(x.mem.floor_bytes)}</span> : null}
          </span>
        )}
        {x.boot_queue && x.boot_queue.queued && x.boot_queue.queued.length > 0 && <span><b>{x.boot_queue.queued.length}</b> boot{x.boot_queue.queued.length === 1 ? '' : 's'} queued</span>}
        {x.incidents > 0 && <span title={x.last_incident ? JSON.stringify(x.last_incident) : ''}><b className="hot">{x.incidents}</b> incident{x.incidents === 1 ? '' : 's'}{x.last_incident ? <span className="faint"> · last {x.last_incident.kind}</span> : null}</span>}
        <span>connect <b className="mono">{x.address || 'not set'}</b></span>
        <span>replay key {x.key.pinned ? <b className="mono">{x.key.pinned}</b> : <b className="hot">none pinned</b>}{x.key.pending && <b className="hot"> · pending {x.key.pending}</b>}</span>
        <span>DLL build {x.build && x.build.dll_build ? <b className="mono">{x.build.dll_build}</b> : <b className="faint">not heard</b>} <button type="button" className="linkish" onClick={() => go('release')}>Release</button></span>
      </div>

      {edit && (
        <div className="adm-form">
          <label>Connect address<input type="text" value={addr} placeholder="host or IP, no port" onChange={(e) => setAddr(e.target.value)} /></label>
          <label>Max games<input type="number" min={1} max={16} value={max} onChange={(e) => setMax(e.target.value)} /></label>
          <label>Agent reserve<input type="number" min={0} max={16} value={reserve} placeholder="default" onChange={(e) => setReserve(e.target.value)} /></label>
          <button type="button" className="btn small accent" onClick={saveEdit}>Save</button>
        </div>
      )}

      {x.leases.length === 0 ? <Empty>No games leased.</Empty> : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead><tr><th>Game</th><th>Players</th><th>Lease</th><th>Slot</th><th className="num">CPU</th><th className="num">RAM</th><th className="num">Up</th><th /></tr></thead>
            <tbody>
              {x.leases.map((l) => (
                <tr key={l.match_id} className={l.in_game ? 'adm-live' : ''}>
                  <td><b>{l.map}</b><div className="mono faint">{l.match_id}</div></td>
                  <td>
                    {l.players.map((p) => (
                      <div key={p.steam_id} className="adm-seat">
                        <button type="button" className="linkish" onClick={() => openUser(p.steam_id)}>{p.name}</button>
                        {!l.seats_known && l.state === 'live' && p.seat === 'never'
                          ? <span className="tag" title="No live frames since the site started">unknown</span>
                          : <span className={`tag ${SEAT[p.seat] ? SEAT[p.seat][1] : ''}`}>{SEAT[p.seat] ? SEAT[p.seat][0] : p.seat}</span>}
                      </div>
                    ))}
                  </td>
                  <td><span className="tag">{l.state}</span> <span className="faint">{l.mode}{l.agent ? ' · agent' : ''}{l.party_id ? ` · party ${l.party_id}` : ''}</span><div className="faint">{when(l.issued_at)}</div></td>
                  <td>{l.instance ? <><b>{l.instance.id}</b> <span className="faint">:{l.instance.port} · {l.instance.phase || l.instance.state}{l.instance.map_loaded ? '' : ' · loading'}</span></> : <span className="faint">not started</span>}</td>
                  <td className="num">{l.instance && l.instance.usage ? l.instance.usage.cores_avg.toFixed(2) : '—'}</td>
                  <td className="num">{l.instance && l.instance.usage ? mb(l.instance.usage.rss_bytes) : '—'}</td>
                  <td className="num">{l.instance ? dur(l.instance.uptime_ms) : '—'}</td>
                  <td>
                    <span className="adm-row tight">
                      <Link className="btn small ghost" to={`/live/${l.match_id}`}>Watch</Link>
                      <button type="button" className="btn small ghost" onClick={() => leaseAct(l, 'restart')}>Restart</button>
                      <button type="button" className="btn small ghost" onClick={() => leaseAct(l, 'retire')}>Retire</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {x.spare.length > 0 && (
        <p className="adm-sub">Other slots: {x.spare.map((s) => `${s.id} (${s.warm ? 'warm' : s.phase || s.state})`).join(', ')}</p>
      )}
    </Panel>
  )
}
