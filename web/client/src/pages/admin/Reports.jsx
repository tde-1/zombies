import { useState } from 'react'
import { api } from '../../api'
import { Panel, Chips, Empty, when, useLoad, useAct } from './kit'

// Reports: Movement's ReportsPanel. Status chips, one card per report, a note, and three
// answers: Looking at it / Done / Dismiss. The person reported opens their sheet, where the
// ban and infraction controls are.
const STATUSES = [['new', 'Open'], ['looking', 'Looking at it'], ['closed', 'Done'], ['dismissed', 'Dismissed']]

export default function Reports({ openUser, reload }) {
  const [status, setStatus] = useState('new')
  const r = useLoad(() => api.get(`/api/admin/reports?status=${status}`), [status])
  const counts = (r.data && r.data.counts) || {}
  return (
    <Panel title="Reports">
      <Chips value={status} onChange={setStatus} options={STATUSES.map(([k, l]) => [k, l, counts[k] || 0])} />
      {!r.data ? <Empty>Loading…</Empty> : r.data.reports.length === 0 ? <Empty>Nothing here.</Empty> : (
        <div className="adm-cards">
          {r.data.reports.map((x) => <Report key={x.id} x={x} openUser={openUser} onDone={() => { r.reload(); reload() }} />)}
        </div>
      )}
    </Panel>
  )
}

function Report({ x, openUser, onDone }) {
  const [note, setNote] = useState(x.note || '')
  const act = useAct()
  const set = async (status) => { if (await act(() => api.post(`/api/admin/reports/${x.id}/resolve`, { status, note: note || null }), 'Saved')) onDone() }
  return (
    <div className="adm-card">
      <div className="adm-spread">
        <span className="tag">{x.kind}</span>
        <span className="faint">{when(x.at)}{x.handled_by ? ` · ${x.handled_by.name}` : ''}</span>
      </div>
      <p>
        <button type="button" className="linkish" onClick={() => openUser(x.reporter.steam_id)}>{x.reporter ? x.reporter.name : '?'}</button>
        {x.reported && <> about <button type="button" className="linkish hot" onClick={() => openUser(x.reported.steam_id)}>{x.reported.name}</button></>}
      </p>
      {x.reason && <p><b>{x.reason}</b></p>}
      {x.detail && <p className="adm-sub">{x.detail}</p>}
      {x.context && <blockquote className="adm-quote">{x.context.body}</blockquote>}
      <div className="adm-form">
        <input className="grow" type="text" value={note} placeholder="Note" onChange={(e) => setNote(e.target.value)} />
        {x.status !== 'looking' && <button type="button" className="btn small ghost" onClick={() => set('looking')}>Looking at it</button>}
        <button type="button" className="btn small accent" onClick={() => set('closed')}>Done</button>
        <button type="button" className="btn small ghost" onClick={() => set('dismissed')}>Dismiss</button>
      </div>
    </div>
  )
}
