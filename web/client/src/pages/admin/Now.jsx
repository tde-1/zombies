import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, num } from '../../api'
import { Panel, Stat, Empty, when, useAct, useLoad, useAdmin } from './kit'
import { LogRows } from './Log'

// Now: the numbers, the boxes at a glance, the latest of the log, and the two operator
// buttons (lease by hand, sweep).
export default function Now({ d, go, isAdmin, openUser, reload }) {
  const c = d.counts
  const log = useLoad(() => api.get('/api/admin/log?limit=12'), [d])
  return (
    <div className="adm-grid-2">
      <div className="adm-col">
        <div className="adm-stats">
          <Stat label="Live games" value={c.live_leases} onClick={isAdmin ? () => go('boxes') : undefined} />
          <Stat label="Online" value={d.presence.online} />
          <Stat label="In game" value={d.presence.in_game} />
          <Stat label="At the door" value={c.waiting} tone={c.waiting ? 'warn' : ''} onClick={() => go('people', { filter: 'waiting' })} />
          <Stat label="Open reports" value={c.new} tone={c.new ? 'warn' : ''} onClick={() => go('reports')} />
          <Stat label="Active bans" value={c.bans} onClick={() => go('people', { filter: 'banned' })} />
          <Stat label="Players" value={num(c.users)} onClick={() => go('people')} />
          <Stat label="Maps" value={c.maps} onClick={() => go('maps')} />
          <Stat label="Live playlists" value={c.playlists} tone={c.playlists ? '' : 'warn'} onClick={() => go('playlists')} />
          <Stat label="Games" value={num(c.games)} onClick={() => go('games')} />
          <Stat label="Flagged, 7d" value={c.flagged_7d} tone={c.flagged_7d ? 'warn' : ''} onClick={() => go('games', { flag: 'any' })} />
          <Stat label="Records" value={num(c.records)} onClick={() => go('records')} />
        </div>

        <Panel title="Boxes" right={isAdmin && <button className="btn small ghost" onClick={() => go('boxes')}>Open</button>}>
          {d.boxes.length === 0 ? <Empty>No boxes registered.</Empty> : (
            <div className="adm-boxstrip">
              {d.boxes.map((b) => {
                const inst = (b.status && b.status.instances) || []
                return (
                  <div key={b.id} className={`adm-boxchip ${b.online ? 'on' : ''} ${b.enabled ? '' : 'off'}`}>
                    <b>{b.name}</b>
                    <span>{b.online ? 'online' : 'offline'}{b.enabled ? '' : ' · disabled'}</span>
                    <span className="faint">{inst.filter((i) => i.leased).length} leased · {inst.filter((i) => i.warm).length} warm · polled {when(b.last_poll)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </Panel>

        {isAdmin && <LeaseForm onDone={reload} />}
      </div>

      <div className="adm-col">
        <Panel title="Latest" right={<button className="btn small ghost" onClick={() => go('log')}>Full log</button>}>
          {log.data ? <LogRows rows={log.data.rows} openUser={openUser} compact /> : <Empty>Loading…</Empty>}
        </Panel>
        <Panel title="Site">
          <dl className="adm-dl">
            <dt>ENW link</dt><dd>{d.enw.base ? `${d.enw.base} · token ${d.enw.has_token ? 'set' : 'not set'}` : 'not set'}</dd>
            <dt>Achievement sweep</dt><dd>{d.sweeps.achievements && d.sweeps.achievements.at ? `${when(d.sweeps.achievements.at)} · ${d.sweeps.achievements.awarded} awarded` : 'not yet'}</dd>
          </dl>
          <div className="adm-row">
            {isAdmin && <SweepButton onDone={reload} />}
            <Link className="btn small ghost" to="/playlists">Playlists page</Link>
            <Link className="btn small ghost" to="/custom">Custom games</Link>
            <Link className="btn small ghost" to="/archive">Archive</Link>
          </div>
        </Panel>
      </div>
    </div>
  )
}

function SweepButton({ onDone }) {
  const act = useAct()
  const [busy, setBusy] = useState(false)
  return (
    <button className="btn small ghost" disabled={busy} onClick={async () => { setBusy(true); await act(() => api.post('/api/admin/sweep'), 'Swept'); setBusy(false); onDone() }}>
      {busy ? 'Sweeping…' : 'Run badge + record sweep'}
    </button>
  )
}

// The same lease() the party rail calls. An operator lease is an agent lease by default:
// it may use the reserve, and a real player's Play takes its slot back.
function LeaseForm({ onDone }) {
  const [map, setMap] = useState('nazi_zombie_prototype')
  const [box, setBox] = useState('')
  const [mode, setMode] = useState('verified')
  const [out, setOut] = useState(null)
  const { toast } = useAdmin()
  const go = async () => {
    try {
      const r = await api.post('/api/admin/lease', { map, box: box || undefined, mode })
      setOut(r); toast(`Leased ${r.match_id} on ${r.box}`)
    } catch (e) { setOut(null); toast(e.message, 'bad') }
    onDone()
  }
  return (
    <Panel title="Lease a game" sub="A test lease for you alone. Agent lease: it yields to a player.">
      <div className="adm-form">
        <label>Map key<input type="text" value={map} onChange={(e) => setMap(e.target.value)} /></label>
        <label>Box<input type="text" value={box} placeholder="any" onChange={(e) => setBox(e.target.value)} /></label>
        <label>Mode<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="verified">Verified</option><option value="custom">Custom</option></select></label>
        <button className="btn small accent" onClick={go} disabled={!map.trim()}>Lease</button>
      </div>
      {out && <p className="adm-sub">Match <code>{out.match_id}</code> on <b>{out.box}</b>.</p>}
    </Panel>
  )
}
