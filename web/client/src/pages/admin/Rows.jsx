import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { Panel, Empty, useLoad, useAct, useAdmin } from './kit'
import { MapPicker } from './Playlists'

// Rows: the shelves on the home page (collections). A query row (New maps) picks itself; a
// hand-picked row (Vanilla, High production) is its maps, in order. A row that resolves to
// no maps is not drawn.
export default function Rows({ isAdmin }) {
  const c = useLoad(() => api.get('/api/admin/collections'), [])
  const act = useAct()
  const { confirm } = useAdmin()
  if (!c.data) return <Panel title="Home rows"><Empty>{c.err || 'Loading…'}</Empty></Panel>
  const rows = c.data.collections
  const run = async (fn, ok) => { if (await act(fn, ok)) c.reload() }
  const del = async (r) => {
    const ok = await confirm({ title: `Delete the ${r.name} row?`, lines: ['It leaves the home page. The maps stay.'], type: r.slug, danger: true, label: 'Delete' })
    if (ok) run(() => api.del(`/api/admin/collections/${r.id}`), 'Deleted')
  }
  return (
    <Panel title="Home rows" sub="The shelves on the home page, top to bottom." right={isAdmin && <NewRow auto={c.data.auto} onDone={c.reload} />}>
      {rows.length === 0 ? <Empty>No rows.</Empty> : rows.map((r, i) => (
        <div key={r.id} className="adm-card">
          <div className="adm-spread">
            <span><b>{r.name}</b> <span className="faint">/{r.slug} · {r.kind === 'auto' ? `query: ${r.auto}` : 'hand-picked'} · {r.resolved} showing</span> <span className={`tag ${r.state === 'live' ? 'good' : ''}`}>{r.state}</span></span>
            {isAdmin && (
              <span className="adm-row tight">
                <button type="button" className="btn small ghost" disabled={i === 0} onClick={() => run(() => api.post(`/api/admin/collections/${r.id}`, { sort_order: Number(rows[i - 1].sort_order) - 1 }))} aria-label="Up">▲</button>
                <button type="button" className="btn small ghost" disabled={i === rows.length - 1} onClick={() => run(() => api.post(`/api/admin/collections/${r.id}`, { sort_order: Number(rows[i + 1].sort_order) + 1 }))} aria-label="Down">▼</button>
                <button type="button" className="btn small ghost" onClick={() => run(() => api.post(`/api/admin/collections/${r.id}`, { state: r.state === 'live' ? 'hidden' : 'live' }), r.state === 'live' ? 'Hidden' : 'Shown')}>{r.state === 'live' ? 'Hide' : 'Show'}</button>
                <button type="button" className="btn small ghost" onClick={() => del(r)}>Delete</button>
              </span>
            )}
          </div>
          {r.kind === 'manual' && (
            <>
              <div className="adm-chipsline">
                {r.keys.length === 0 && <span className="faint">No maps yet.</span>}
                {r.keys.map((k) => (
                  <span key={k} className="tag">
                    <Link to={`/m/${k}`}>{k}</Link>
                    {isAdmin && <button type="button" className="linkish" title={`Remove ${k}`} onClick={() => run(() => api.del(`/api/admin/collections/${r.id}/maps/${encodeURIComponent(k)}`), 'Removed')}> ×</button>}
                  </span>
                ))}
              </div>
              {isAdmin && <MapPicker have={new Set(r.keys)} onPick={(m) => run(() => api.post(`/api/admin/collections/${r.id}/maps`, { map_key: m.key }), `Added ${m.title}`)} />}
            </>
          )}
        </div>
      ))}
    </Panel>
  )
}

function NewRow({ auto, onDone }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('manual')
  const [query, setQuery] = useState((auto && auto[0]) || 'newest')
  const act = useAct()
  if (!open) return <button type="button" className="btn small accent" onClick={() => setOpen(true)}>New row</button>
  const go = async () => {
    const out = await act(() => api.post('/api/admin/collections', { slug: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: name.trim(), kind, auto: kind === 'auto' ? query : null }), 'Created')
    if (out) { setName(''); setOpen(false); onDone() }
  }
  return (
    <span className="adm-row">
      <input type="text" value={name} placeholder="Row name" autoFocus onChange={(e) => setName(e.target.value)} />
      <select value={kind} onChange={(e) => setKind(e.target.value)}><option value="manual">hand-picked</option><option value="auto">a query</option></select>
      {kind === 'auto' && <select value={query} onChange={(e) => setQuery(e.target.value)}>{(auto || []).map((a) => <option key={a} value={a}>{a}</option>)}</select>}
      <button type="button" className="btn small accent" disabled={!name.trim()} onClick={go}>Create</button>
      <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  )
}
