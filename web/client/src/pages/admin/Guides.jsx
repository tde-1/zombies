import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { Panel, Table, Chips, Empty, when, useLoad, useAct, useAdmin } from './kit'

// Guides: the Easter egg / power / song steps the archive found, weakest first. The score
// is the extractor's and shows only here. Hide is reversible; Delete leaves a tombstone the
// next import respects.
export default function Guides() {
  const [state, setState] = useState('')
  const [open, setOpen] = useState(null)
  const g = useLoad(() => api.get(`/api/admin/guides${state ? `?state=${state}` : ''}`), [state])
  const act = useAct()
  const { confirm } = useAdmin()
  if (!g.data) return <Panel title="Guides"><Empty>{g.err || 'Loading…'}</Empty></Panel>
  const c = g.data.counts
  const set = async (x, to) => {
    if (to === 'deleted') {
      const ok = await confirm({ title: `Delete "${x.title}"?`, lines: [`${x.map_title || x.map_key} · ${x.tab}`, 'The next import will not bring it back.'], danger: true, label: 'Delete' })
      if (!ok) return
    }
    if (await act(() => api.post(`/api/admin/guides/${x.id}`, { state: to }), to === 'live' ? 'Shown' : to === 'hidden' ? 'Hidden' : 'Deleted')) g.reload()
  }
  return (
    <Panel title="Guides" sub={`${c.live} live on ${c.maps} maps.`}>
      <Chips value={state} onChange={setState} options={[['', 'Live + hidden'], ['live', 'Live', c.live], ['hidden', 'Hidden', c.hidden], ['deleted', 'Deleted', c.deleted]]} />
      <Table rows={g.data.guides} search={(x) => `${x.map_title || ''} ${x.map_key} ${x.title} ${x.source.author || ''}`} searchPlaceholder="Map, title, author"
        empty="No guides. Run archive/easter_eggs.py, then npm run import:guides."
        columns={[
          { key: 'confidence', label: 'Score', num: true, sort: true, render: (x) => <span className={`tag ${x.confidence_label === 'high' ? 'good' : x.confidence_label === 'low' ? 'hot' : ''}`}>{x.confidence.toFixed(2)}</span> },
          { key: 'map', label: 'Map', sort: (x) => x.map_title || x.map_key, render: (x) => <Link to={`/m/${x.map_key}`}>{x.map_title || x.map_key}</Link> },
          { key: 'title', label: 'Guide', sort: true, render: (x) => (
            <>
              <button type="button" className="linkish" onClick={() => setOpen(open === x.id ? null : x.id)}>{x.tab}: {x.title} ({x.steps.filter((s) => !s.head).length} steps)</button>
              {open === x.id && <ol className="adm-steps">{x.steps.map((s, i) => <li key={i} className={s.head ? 'head' : ''}>{s.label ? `${s.label}. ` : ''}{s.text}</li>)}</ol>}
            </>
          ) },
          { key: 'source', label: 'Source', render: (x) => <span className="faint">{x.source.url ? <a href={x.source.url} target="_blank" rel="noreferrer noopener">{x.source.site || 'link'}</a> : (x.source.site || '—')}{x.source.author ? ` · ${x.source.author}` : ''}</span> },
          { key: 'state', label: 'State', sort: true, render: (x) => <span className="faint">{x.state}{x.staff_at ? ` ${when(x.staff_at)}` : ''}</span> },
          { key: 'act', label: '', render: (x) => (
            <span className="adm-row tight">
              {x.state === 'live' && <button type="button" className="btn small ghost" onClick={() => set(x, 'hidden')}>Hide</button>}
              {x.state === 'hidden' && <button type="button" className="btn small ghost" onClick={() => set(x, 'live')}>Show</button>}
              {x.state !== 'deleted' && <button type="button" className="btn small ghost" onClick={() => set(x, 'deleted')}>Delete</button>}
            </span>
          ) },
        ]} />
    </Panel>
  )
}
