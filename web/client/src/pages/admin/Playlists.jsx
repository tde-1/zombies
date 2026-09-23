import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { Panel, Empty, when, useLoad, useAct, useAdmin } from './kit'

// Playlists: the editor. Each live playlist is a row on /maps (cards view) and a cover under
// "All playlists"; the order here is the order there. New playlists start hidden: build,
// then Publish.
const STATE_TAG = { live: 'good', hidden: '', scheduled: 'gold' }

export default function Playlists({ isAdmin, reload }) {
  const l = useLoad(() => api.get('/api/admin/playlists'), [])
  const [sel, setSel] = useState(null)
  const act = useAct()
  const list = (l.data && l.data.playlists) || []
  useEffect(() => { if (!sel && list.length) setSel(list[0].id) }, [list, sel])
  const cur = list.find((p) => p.id === sel)
  const refresh = () => { l.reload(); reload() }

  const move = async (p, dir) => {
    const i = list.findIndex((x) => x.id === p.id)
    const j = i + dir
    if (j < 0 || j >= list.length) return
    const order = [...list]; [order[i], order[j]] = [order[j], order[i]]
    // Rewrite every sort_order so the order is exact, whatever it was before.
    for (let k = 0; k < order.length; k++) if (order[k].sort_order !== (k + 1) * 10) await api.put(`/api/admin/playlists/${order[k].id}`, { sort_order: (k + 1) * 10 }).catch(() => {})
    refresh()
  }
  const publish = async (p) => { if (await act(() => api.put(`/api/admin/playlists/${p.id}`, { state: p.state === 'live' ? 'hidden' : 'live' }), p.state === 'live' ? 'Unpublished' : 'Published')) refresh() }

  return (
    <div className="adm-split">
      <Panel title="Playlists" right={<NewPlaylist onDone={(id) => { refresh(); setSel(id) }} />} className="adm-split-left">
        {!l.data ? <Empty>Loading…</Empty> : list.length === 0 ? (
          <Empty>No playlists. /maps shows Popular only until one is live.</Empty>
        ) : (
          <ol className="adm-pl-list">
            {list.map((p, i) => (
              <li key={p.id} className={p.id === sel ? 'on' : ''}>
                <button type="button" className="adm-pl-pick" onClick={() => setSel(p.id)}>
                  <b>{p.name}</b>
                  <span className="faint">/{p.slug} · {p.maps.length} maps</span>
                </button>
                <span className={`tag ${STATE_TAG[p.state] || ''}`}>{p.state}</span>
                <span className="adm-row tight">
                  <button type="button" className="btn small ghost" disabled={i === 0} onClick={() => move(p, -1)} aria-label="Up">▲</button>
                  <button type="button" className="btn small ghost" disabled={i === list.length - 1} onClick={() => move(p, 1)} aria-label="Down">▼</button>
                  <button type="button" className={`btn small ${p.state === 'live' ? 'ghost' : 'accent'}`} onClick={() => publish(p)}>{p.state === 'live' ? 'Unpublish' : 'Publish'}</button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Panel>
      <div className="adm-split-right">
        {cur ? <Editor key={cur.id} p={cur} isAdmin={isAdmin} onDone={refresh} onGone={() => { setSel(null); refresh() }} /> : <Panel title="Edit"><Empty>Pick a playlist.</Empty></Panel>}
      </div>
    </div>
  )
}

function NewPlaylist({ onDone }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const act = useAct()
  if (!open) return <button type="button" className="btn small accent" onClick={() => setOpen(true)}>New</button>
  const go = async () => {
    const out = await act(() => api.post('/api/admin/playlists', { name: name.trim() }), 'Created')
    if (out && out.playlist) { setName(''); setOpen(false); onDone(out.playlist.id) }
  }
  return (
    <span className="adm-row">
      <input type="text" value={name} placeholder="Name" autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) go() }} />
      <button type="button" className="btn small accent" disabled={!name.trim()} onClick={go}>Create</button>
      <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  )
}

function Editor({ p, isAdmin, onDone, onGone }) {
  const [name, setName] = useState(p.name)
  const [blurb, setBlurb] = useState(p.blurb || '')
  const [state, setState] = useState(p.state)
  const [liveFrom, setLiveFrom] = useState(p.live_from ? new Date(p.live_from).toISOString().slice(0, 16) : '')
  const [items, setItems] = useState(p.maps)
  const [drag, setDrag] = useState(null)
  const act = useAct()
  const { confirm } = useAdmin()
  const curated = p.kind !== 'creator'
  const dirty = name !== p.name || blurb !== (p.blurb || '') || state !== p.state || items.map((m) => m.key).join() !== p.maps.map((m) => m.key).join() ||
    (state === 'scheduled' && liveFrom !== (p.live_from ? new Date(p.live_from).toISOString().slice(0, 16) : ''))

  const moveTo = (from, to) => setItems((xs) => { const a = [...xs]; const [x] = a.splice(from, 1); a.splice(to, 0, x); return a })
  const add = (m) => setItems((xs) => (xs.some((x) => x.key === m.key) ? xs : [...xs, m]))
  const save = async () => {
    const body = { name: name.trim(), blurb: blurb.trim() || null, state, ...(curated ? { maps: items.map((m) => m.key) } : {}) }
    if (state === 'scheduled') body.live_from = liveFrom ? new Date(liveFrom + 'Z').getTime() : null
    if (await act(() => api.put(`/api/admin/playlists/${p.id}`, body), 'Saved')) onDone()
  }
  const del = async () => {
    const ok = await confirm({ title: `Delete ${p.name}?`, lines: ['The playlist and its order go. The maps stay.'], type: p.slug, danger: true, label: 'Delete' })
    if (ok && await act(() => api.del(`/api/admin/playlists/${p.id}`), 'Deleted')) onGone()
  }
  const bad = items.filter((m) => m.missing || m.hidden || m.health === 'broken' || !m.server)

  return (
    <Panel title={p.name} sub={`/${p.slug}${p.updated_at ? ` · edited ${when(p.updated_at)}` : ''}`}
      right={<span className="adm-row">{p.state === 'live' && <Link className="btn small ghost" to={`/playlists/${p.slug}`}>View</Link>}{isAdmin && <button type="button" className="btn small ghost" onClick={del}>Delete</button>}</span>}>
      <div className="adm-form">
        <label className="grow">Name<input type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        <label>State<select value={state} onChange={(e) => setState(e.target.value)}><option value="hidden">hidden</option><option value="live">live</option><option value="scheduled">scheduled</option></select></label>
        {state === 'scheduled' && <label>Live from (UTC)<input type="datetime-local" value={liveFrom} onChange={(e) => setLiveFrom(e.target.value)} /></label>}
      </div>
      <div className="adm-form"><label className="grow">Blurb<input type="text" value={blurb} maxLength={140} placeholder="One line" onChange={(e) => setBlurb(e.target.value)} /></label></div>

      <h3 className="adm-h3">Maps <span className="faint">{items.length}</span></h3>
      {!curated && <p className="adm-sub">Every map by {p.creator}, automatically.</p>}
      {bad.length > 0 && <p className="adm-sub hot">{bad.length} {bad.length === 1 ? 'map does' : 'maps do'} not run on our box or {bad.length === 1 ? 'is' : 'are'} hidden: players see them greyed or not at all.</p>}
      {items.length === 0 ? <Empty>No maps yet. Add some below.</Empty> : (
        <ol className="adm-pl-maps">
          {items.map((m, i) => (
            <li key={m.key} draggable={curated}
                className={`${drag === i ? 'dragging' : ''} ${m.missing || m.hidden || m.health === 'broken' ? 'bad' : ''}`}
                onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)}
                onDragOver={(e) => { e.preventDefault(); if (drag != null && drag !== i) { moveTo(drag, i); setDrag(i) } }}>
              <span className="adm-grip" aria-hidden="true">⋮⋮</span>
              <span className="adm-pl-n">{i + 1}</span>
              <span className="grow"><b>{m.title}</b> <span className="mono faint">{m.key}</span></span>
              {m.missing && <span className="tag hot">no such map</span>}
              {m.hidden && <span className="tag hot">hidden</span>}
              {m.health === 'broken' && <span className="tag hot">broken</span>}
              {!m.missing && m.health !== 'broken' && !m.server && <span className="tag">not on our box</span>}
              {m.server === 'box' && <span className="tag gold">New</span>}
              {curated && (
                <span className="adm-row tight">
                  <button type="button" className="btn small ghost" disabled={i === 0} onClick={() => moveTo(i, i - 1)} aria-label="Up">▲</button>
                  <button type="button" className="btn small ghost" disabled={i === items.length - 1} onClick={() => moveTo(i, i + 1)} aria-label="Down">▼</button>
                  <button type="button" className="btn small ghost" onClick={() => setItems((xs) => xs.filter((x) => x.key !== m.key))} aria-label={`Remove ${m.title}`}>×</button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {curated && <MapPicker onPick={add} have={new Set(items.map((m) => m.key))} />}
      <div className="adm-savebar">
        <span className="faint">{dirty ? 'Unsaved changes' : 'Saved'}</span>
        <button type="button" className="btn small ghost" disabled={!dirty} onClick={() => { setName(p.name); setBlurb(p.blurb || ''); setState(p.state); setItems(p.maps) }}>Revert</button>
        <button type="button" className="btn small accent" disabled={!dirty || !name.trim()} onClick={save}>Save</button>
      </div>
    </Panel>
  )
}

// Search the catalogue (maps that are on the site) and add with a click or Enter.
export function MapPicker({ onPick, have }) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState([])
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return }
    const t = setTimeout(() => api.get(`/api/admin/maps?${new URLSearchParams({ q: q.trim(), size: 12, sort: 'plays', dir: 'desc' })}`).then((d) => setRes(d.maps)).catch(() => setRes([])), 200)
    return () => clearTimeout(t)
  }, [q])
  return (
    <div className="adm-picker">
      <input type="search" value={q} placeholder="Add a map: title, key or author" onChange={(e) => setQ(e.target.value)}
             onKeyDown={(e) => { if (e.key === 'Enter' && res[0]) { onPick(pick(res[0])); setQ('') } }} />
      {res.length > 0 && (
        <ul className="adm-picker-list">
          {res.map((m) => (
            <li key={m.key}>
              <button type="button" disabled={have.has(m.key)} onClick={() => { onPick(pick(m)); setQ('') }}>
                <b>{m.title}</b> <span className="mono faint">{m.key}</span>
                <span className="faint"> · {m.health}{m.server ? ` · ${m.server === 'proven' ? 'proven' : 'new'} on our box` : ''}{m.hidden ? ' · hidden' : ''}</span>
                {have.has(m.key) && <span className="tag">added</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
const pick = (m) => ({ key: m.key, title: m.title, health: m.health, hidden: m.hidden, missing: false, server: m.server })
