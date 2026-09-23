import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { Panel, Table, Search, Chips, Empty, when, stamp, useLoad } from './kit'

// Games: every result the referee posted, filterable by its flags (result_mismatch,
// instance_retired, frames_only, ...). A flag is the referee saying "this may not be what it
// looks like". Open one to read the summary the box sent, verbatim.
export default function Games({ params, openUser }) {
  const [flag, setFlag] = useState(params.get('flag') || '')
  const [q, setQ] = useState(params.get('q') || '')
  const [mode, setMode] = useState('')
  const [pg, setPg] = useState(1)
  const [open, setOpen] = useState(null)
  const g = useLoad(() => api.get(`/api/admin/games?${new URLSearchParams({ flag, q, mode, page: pg, size: 40 })}`), [flag, q, mode, pg])
  const flags = (g.data && g.data.flags) || []
  return (
    <>
      <Panel title="Games" sub="Results as the referee posted them.">
        <Chips value={flag} onChange={(f) => { setFlag(f); setPg(1) }} options={[['', 'All'], ['any', 'Any flag'], ...flags.map((f) => [f.flag, f.flag, f.c])]} />
        <Table total={g.data ? g.data.total : 0} page={pg} onPage={setPg} pageSize={40} rows={g.data ? g.data.games : []}
          empty={g.data ? 'No games.' : 'Loading…'}
          toolbar={(
            <>
              <Search value={q} onChange={(x) => { setQ(x); setPg(1) }} placeholder="Match, map, box or player" />
              <select value={mode} onChange={(e) => { setMode(e.target.value); setPg(1) }}><option value="">Any mode</option><option value="verified">Verified</option><option value="custom">Custom</option><option value="local">Local</option></select>
            </>
          )}
          onRow={(x) => setOpen(x.id)}
          columns={[
            { key: 'ended_at', label: 'Ended', render: (x) => <span title={stamp(x.ended_at)}>{when(x.ended_at || x.received_at)}</span> },
            { key: 'map', label: 'Map', render: (x) => x.map_title || x.map_key },
            { key: 'mode', label: 'Mode', render: (x) => <span className="faint">{x.mode}{x.self_reported ? ' · self-reported' : ''}</span> },
            { key: 'players', label: 'Players', render: (x) => x.players.map((p, i) => <span key={p.steam_id}>{i ? ', ' : ''}<button type="button" className="linkish" onClick={(e) => { e.stopPropagation(); openUser(p.steam_id) }}>{p.name}</button></span>) },
            { key: 'rounds', label: 'Round', num: true },
            { key: 'box', label: 'Box', render: (x) => <span className="faint">{x.box || '—'}{x.instance ? `/${x.instance}` : ''}</span> },
            { key: 'flags', label: 'Flags', render: (x) => (x.flags.length ? x.flags.map((f) => <span key={f} className="tag hot">{f}</span>) : <span className="faint">—</span>) },
            { key: 'evidence', label: 'Evidence', render: (x) => (x.records_eligible ? <span className="tag good">record-eligible</span> : x.key_pinned === false ? <span className="tag hot">unpinned</span> : <span className="faint">—</span>) },
            { key: 'end_reason', label: 'End', render: (x) => <span className="faint">{x.end_reason || '—'}</span> },
          ]} />
      </Panel>
      {open && <GameSheet id={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function GameSheet({ id, onClose }) {
  const g = useLoad(() => api.get(`/api/admin/games/${id}`), [id])
  const x = g.data && g.data.game
  return (
    <div className="adm-sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside className="adm-sheet wide" role="dialog" aria-label="Game">
        <button type="button" className="adm-x" onClick={onClose} aria-label="Close">×</button>
        {!x ? <Empty>{g.err || 'Loading…'}</Empty> : (
          <>
            <h2>{x.map_key} <span className="faint">{x.match_id}</span></h2>
            <div className="adm-row">
              <Link className="btn small ghost" to={`/game/${x.id}`}>Game page</Link>
              <Link className="btn small ghost" to={`/replay/${x.match_id}`}>Replay</Link>
            </div>
            <dl className="adm-dl">
              <dt>Flags</dt><dd>{(x.flags || []).join(', ') || '—'}</dd>
              <dt>End</dt><dd>{x.end_reason || '—'}</dd>
              <dt>Box</dt><dd>{x.box}{x.instance ? ` / ${x.instance}` : ''}</dd>
              <dt>Received</dt><dd>{stamp(x.received_at)}</dd>
              <dt>DLL build</dt><dd className="mono">{(x.summary && x.summary.hashes && x.summary.hashes.dll_build) || '—'}</dd>
              <dt>Game exe</dt><dd className="mono">{(x.summary && x.summary.hashes && x.summary.hashes.exe_sha256) || '—'}</dd>
            </dl>
            <h3 className="adm-h3">Summary, as the box sent it</h3>
            <pre className="adm-pre">{JSON.stringify(x.summary, null, 2)}</pre>
          </>
        )}
      </aside>
    </div>
  )
}
