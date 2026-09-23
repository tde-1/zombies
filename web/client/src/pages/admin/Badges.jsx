import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { Panel, Table, Empty, useLoad, useAct, useAdmin } from './kit'

// Badges: every badge and how many hold it. Staff badges are handed out here; achievement,
// map and record badges are earned and cannot be.
export default function Badges({ isAdmin, openUser }) {
  const b = useLoad(() => api.get('/api/admin/badges'), [])
  const [open, setOpen] = useState(null)
  if (!b.data) return <Panel title="Badges"><Empty>{b.err || 'Loading…'}</Empty></Panel>
  const cur = b.data.badges.find((x) => x.id === open)
  return (
    <>
      <Panel title="Badges" right={isAdmin && <NewBadge onDone={b.reload} />}>
        <Table rows={b.data.badges} search={(x) => `${x.name} ${x.slug} ${x.kind} ${x.map_key || ''}`} searchPlaceholder="Badge, kind, map"
          onRow={(x) => setOpen(x.id)}
          columns={[
            { key: 'name', label: 'Badge', sort: true, render: (x) => <span><b>{x.name}</b> <span className="mono faint">/{x.slug}</span></span> },
            { key: 'kind', label: 'Kind', sort: true, render: (x) => <span className={`tag ${x.kind === 'staff' ? 'gold' : ''}`}>{x.kind}</span> },
            { key: 'map_key', label: 'Map', render: (x) => x.map_key || <span className="faint">—</span> },
            { key: 'holders', label: 'Holders', num: true, sort: true },
            { key: 'retired', label: '', render: (x) => (x.retired ? <span className="tag">retired</span> : null) },
          ]} />
      </Panel>
      {cur && <Holders badge={cur} isAdmin={isAdmin} openUser={openUser} onClose={() => setOpen(null)} onDone={b.reload} />}
    </>
  )
}

function Holders({ badge, isAdmin, openUser, onClose, onDone }) {
  const h = useLoad(() => api.get(`/api/admin/badges/${badge.id}/holders`), [badge.id])
  const [who, setWho] = useState('')
  const act = useAct()
  const { confirm } = useAdmin()
  const staff = badge.kind === 'staff'
  const award = async () => { if (await act(() => api.post(`/api/admin/badges/${badge.id}/award`, { steam_id: who.trim() }), 'Awarded')) { setWho(''); h.reload(); onDone() } }
  const revoke = async (p) => {
    const ok = await confirm({ title: `Take ${badge.name} from ${p.name}?`, danger: true, label: 'Revoke' })
    if (ok && await act(() => api.post(`/api/admin/badges/${badge.id}/revoke`, { steam_id: p.steam_id }), 'Revoked')) { h.reload(); onDone() }
  }
  const rows = (h.data && h.data.holders) || []
  return (
    <Panel title={badge.name} sub={badge.description || badge.obtain || null} right={<span className="adm-row"><Link className="btn small ghost" to={`/badges/${badge.slug}`}>Page</Link><button type="button" className="btn small ghost" onClick={onClose}>Close</button></span>}>
      {isAdmin && staff && (
        <div className="adm-form">
          <label className="grow">Award to (ENW name or SteamID64)<input type="text" value={who} onChange={(e) => setWho(e.target.value)} /></label>
          <button type="button" className="btn small accent" disabled={!who.trim()} onClick={award}>Award</button>
        </div>
      )}
      {!staff && <p className="adm-sub">Earned, not awarded.</p>}
      {rows.length === 0 ? <Empty>Nobody holds it.</Empty> : (
        <ul className="adm-list">
          {rows.map((x) => {
            const p = x.player || x
            return (
              <li key={p.steam_id}>
                <button type="button" className="linkish" onClick={() => openUser(p.steam_id)}>{p.name || p.steam_id}</button>
                {isAdmin && staff && <button type="button" className="btn small ghost" onClick={() => revoke(p)}>Revoke</button>}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function NewBadge({ onDone }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const act = useAct()
  if (!open) return <button type="button" className="btn small accent" onClick={() => setOpen(true)}>New staff badge</button>
  const go = async () => { if (await act(() => api.post('/api/admin/badges', { name: name.trim(), description: desc.trim() || null }), 'Created')) { setName(''); setDesc(''); setOpen(false); onDone() } }
  return (
    <span className="adm-row">
      <input type="text" value={name} placeholder="Name" autoFocus onChange={(e) => setName(e.target.value)} />
      <input type="text" value={desc} placeholder="What it means" onChange={(e) => setDesc(e.target.value)} />
      <button type="button" className="btn small accent" disabled={!name.trim()} onClick={go}>Create</button>
      <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  )
}
