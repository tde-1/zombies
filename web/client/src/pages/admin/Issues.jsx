import { useEffect, useState } from 'react'
import { api } from '../../api'
import { Panel, Table, Search, Chips, Empty, when, stamp, short, useLoad, useAct, useAdmin } from './kit'

// Issues (lane T1 telemetry, docs/kickstart/telemetry.md): every bundle the launchers, the
// boxes and the site sent, flagged on arrival. The table is server-side (filters, sort,
// paging); a row opens the sheet with the hits, their log lines, the files, the bundle, the AI
// brief, and the review (reviewed, the next-session bug line, a note).

const SEV = { 1: ['P1', 'crash / hang', 'hot'], 2: ['P2', 'error', 'gold'], 3: ['P3', 'warning', ''], 4: ['P4', 'info', 'faint'] }
const UPLOAD = { uploaded: 'in the bucket', pending: 'uploading', local: 'on the site only', failed: 'upload failed' }

// `at` may be epoch ms or an ISO string.
const ms = (t) => (t == null || t === '' ? null : typeof t === 'number' ? t : Date.parse(t) || null)
export function bytes(b) {
  if (b == null) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`
  return `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`
}
const whoOf = (x) => (x.who ? x.who.name || x.who.steam_id : x.box || '—')

export function Sev({ s }) {
  const [label, title, tone] = SEV[s] || ['P?', 'unknown', '']
  return <span className={`tag adm-sev ${tone}`} title={title}>{label}</span>
}

export default function Issues({ params, go, openUser, isAdmin, reload }) {
  const p0 = (k, d = '') => params.get(k) ?? d
  const [sev, setSev] = useState(() => p0('severity').split(',').filter((x) => SEV[x]))
  const [flag, setFlag] = useState(p0('flag'))
  const [kind, setKind] = useState(p0('kind'))
  const [who, setWho] = useState(p0('who'))
  const [version, setVersion] = useState(p0('version'))
  const [map, setMap] = useState(p0('map'))
  const [reviewed, setReviewed] = useState(p0('reviewed', '0'))
  const [q, setQ] = useState(p0('q'))
  const [sort, setSort] = useState({ key: 'at', dir: 'desc' })
  const [pg, setPg] = useState(1)
  const [open, setOpen] = useState(p0('incident') || null)
  const act = useAct()
  const { toast } = useAdmin()

  const qs = new URLSearchParams({ severity: sev.join(','), flag, kind, who, version, map, reviewed, q, sort: sort.key, dir: sort.dir, page: pg, size: 50 })
  for (const [k, v] of [...qs.entries()]) if (v === '') qs.delete(k)
  const g = useLoad(() => api.get(`/api/admin/incidents?${qs}`), [qs.toString()])
  const rules = useLoad(() => api.get('/api/admin/incidents/rules'), [])
  const ruleText = Object.fromEntries(((rules.data && rules.data.rules) || []).map((r) => [r.id, r.description]))

  const f = (g.data && g.data.facets) || {}
  const un = (g.data && g.data.unreviewed) || {}
  const set = (fn) => (v) => { fn(v); setPg(1) }
  const toggleSev = (s) => { setSev((a) => (a.includes(s) ? a.filter((x) => x !== s) : [...a, s].sort())); setPg(1) }
  // A select whose current value is not in this page's facets still shows it.
  const opts = (list, cur, key, label) => {
    const o = (list || []).map((x) => [String(x[key]), label(x), x.c])
    if (cur && !o.some(([k]) => k === cur)) o.unshift([cur, cur, null])
    return o.map(([k, l, c]) => <option key={k} value={k}>{l}{c != null ? ` (${c})` : ''}</option>)
  }
  const digest = async () => {
    const r = await act(() => api.post('/api/admin/incidents/digest'))
    if (r && r.ok) toast(`Digest: ${r.count ?? 0} ${r.count === 1 ? 'issue' : 'issues'}${r.key ? ` · ${r.key}` : ''}`)
  }

  return (
    <>
      <Panel title="Issues" sub={`Crashes, errors and logs, flagged on arrival.${un.p1 || un.p2 ? ` Unreviewed: ${un.p1 || 0} P1, ${un.p2 || 0} P2.` : ''}`}
        right={isAdmin && <button type="button" className="btn small ghost" onClick={digest}>Build digest</button>}>
        <div className="adm-spread">
          <div className="adm-chips">
            {[1, 2, 3, 4].map((s) => (
              <button key={s} type="button" className={sev.includes(String(s)) ? 'on' : ''} title={SEV[s][1]} onClick={() => toggleSev(String(s))}>
                {SEV[s][0]} <span className="faint">{SEV[s][1]}</span>
              </button>
            ))}
          </div>
          <Chips value={reviewed} onChange={set(setReviewed)} options={[['0', 'Unreviewed'], ['1', 'Reviewed'], ['', 'All']]} />
        </div>
        {(f.flags || []).length > 0 && (
          <div className="adm-chips">
            <button type="button" className={flag === '' ? 'on' : ''} onClick={() => set(setFlag)('')}>Any flag</button>
            {f.flags.map((x) => (
              <button key={x.flag} type="button" className={flag === x.flag ? 'on' : ''} title={ruleText[x.flag] || x.label}
                      onClick={() => set(setFlag)(flag === x.flag ? '' : x.flag)}>
                {x.label || x.flag}<b>{x.c}</b>
              </button>
            ))}
          </div>
        )}
        <Table total={g.data ? g.data.total : 0} page={pg} onPage={setPg} pageSize={50} rows={g.data ? g.data.rows : []}
          sort={sort} onSort={(s) => { setSort(s); setPg(1) }}
          empty={g.err ? g.err : g.data ? 'No issues.' : 'Loading…'}
          rowClass={(x) => (x.reviewed && reviewed === '' ? 'adm-dim' : '')}
          toolbar={(
            <>
              <Search value={q} onChange={set(setQ)} placeholder="Summary, id, match, person" />
              <select value={kind} onChange={(e) => set(setKind)(e.target.value)}><option value="">Any kind</option>{opts(f.kinds, kind, 'kind', (x) => x.kind)}</select>
              <select value={who} onChange={(e) => set(setWho)(e.target.value)}><option value="">Anyone</option>{opts(f.people, who, 'who', (x) => x.name || x.who)}</select>
              <select value={version} onChange={(e) => set(setVersion)(e.target.value)}><option value="">Any version</option>{opts(f.versions, version, 'v', (x) => x.v)}</select>
              <select value={map} onChange={(e) => set(setMap)(e.target.value)}><option value="">Any map</option>{opts(f.maps, map, 'map', (x) => x.map)}</select>
            </>
          )}
          onRow={(x) => setOpen(x.id)}
          columns={[
            { key: 'at', label: 'Time', sort: true, render: (x) => <span title={stamp(ms(x.at))}>{when(ms(x.at))}</span> },
            { key: 'who', label: 'Who', sort: true, render: (x) => (x.who ? x.who.name || x.who.steam_id : <span className="faint">{x.box || '—'}</span>) },
            { key: 'kind', label: 'Kind', sort: true, render: (x) => <span className="faint" title={x.reason || ''}>{x.kind}</span> },
            { key: 'map_key', label: 'Map', render: (x) => x.map_key || <span className="faint">—</span> },
            { key: 'launcher_version', label: 'Version', render: (x) => <span className="faint">{x.launcher_version || '—'}</span> },
            { key: 'severity', label: 'Sev', sort: true, render: (x) => <Sev s={x.severity} /> },
            { key: 'flags', label: 'Flags', render: (x) => ((x.flags || []).length ? x.flags.map((fl) => <span key={fl} className="tag">{fl}</span>) : <span className="faint">—</span>) },
            { key: 'size', label: 'Size', sort: true, num: true, render: (x) => bytes(x.size) },
          ]} />
      </Panel>
      {open && <IssueSheet id={open} go={go} openUser={openUser} onClose={() => setOpen(null)} onChange={() => { g.reload(); reload() }} />}
    </>
  )
}

function IssueSheet({ id, go, openUser, onClose, onChange }) {
  const s = useLoad(() => api.get(`/api/admin/incidents/${encodeURIComponent(id)}`), [id])
  useEffect(() => {
    // Another sheet on top (a person) takes the Esc first.
    const k = (e) => { if (e.key === 'Escape' && !document.querySelector('.adm-scrim') && document.querySelectorAll('.adm-sheet-scrim').length < 2) onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const x = s.data && s.data.incident
  return (
    <div className="adm-sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside className="adm-sheet wide" role="dialog" aria-label="Issue">
        <button type="button" className="adm-x" onClick={onClose} aria-label="Close">×</button>
        {!x ? <Empty>{s.err || 'Loading…'}</Empty> : (
          <IssueBody x={x} go={go} openUser={openUser}
                     onSaved={(inc) => { s.setData((d) => ({ ...d, incident: { ...d.incident, ...inc } })); onChange() }} />
        )}
      </aside>
    </div>
  )
}

function IssueBody({ x, go, openUser, onSaved }) {
  const act = useAct()
  const [bug, setBug] = useState(x.bug || '')
  const [note, setNote] = useState(x.note || '')
  const [copied, setCopied] = useState('')
  const hits = Object.entries(x.hits || {}).sort(([, a], [, b]) => (a.severity || 9) - (b.severity || 9))
  const files = x.files || []
  const base = `/api/admin/incidents/${encodeURIComponent(x.id)}`

  const review = async (reviewed) => {
    const r = await act(() => api.post(`${base}/review`, { reviewed, bug: bug.trim() || null, note: note.trim() || null }), reviewed === x.reviewed ? 'Saved' : reviewed ? 'Reviewed' : 'Reopened')
    if (r && r.incident) onSaved(r.incident)
    else if (r) onSaved({ reviewed, bug: bug.trim() || null, note: note.trim() || null })
  }
  const copyBrief = async () => {
    try {
      const res = await fetch(`${base}/brief`, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      await navigator.clipboard.writeText(await res.text())
      setCopied('Copied')
    } catch (e) { setCopied(`Not copied: ${e.message}`) }
    setTimeout(() => setCopied(''), 2000)
  }

  return (
    <>
      <h2><Sev s={x.severity} /> {x.kind}{x.reason ? <span className="faint">{x.reason}</span> : null}</h2>
      <p className="adm-sub">{whoOf(x)} · <span title={stamp(ms(x.at))}>{when(ms(x.at))}</span>{x.reviewed ? ` · reviewed${x.reviewed_by ? ` by ${x.reviewed_by.name || x.reviewed_by}` : ''}${x.reviewed_at ? ` ${when(ms(x.reviewed_at))}` : ''}` : ''}</p>
      {x.summary && <p className="adm-issue-summary">{x.summary}</p>}

      <div className="adm-row">
        <a className="btn small ghost" href={`${base}/bundle`}>Download bundle</a>
        <button type="button" className="btn small ghost" onClick={copyBrief}>{copied || 'Copy AI brief'}</button>
        <button type="button" className={`btn small ${x.reviewed ? 'ghost' : 'accent'}`} onClick={() => review(!x.reviewed)}>{x.reviewed ? 'Reopen' : 'Mark reviewed'}</button>
      </div>

      <div className="adm-form">
        <label className="grow">Bug line for next session<input type="text" value={bug} maxLength={300} placeholder="One line, or empty" onChange={(e) => setBug(e.target.value)} /></label>
        <label className="grow">Note<input type="text" value={note} maxLength={1000} placeholder="Note" onChange={(e) => setNote(e.target.value)} /></label>
        <button type="button" className="btn small ghost" disabled={bug === (x.bug || '') && note === (x.note || '')} onClick={() => review(!!x.reviewed)}>Save</button>
      </div>

      <dl className="adm-dl">
        <dt>Who</dt><dd>{x.who ? <button type="button" className="linkish" onClick={() => openUser(x.who.steam_id)}>{x.who.name || x.who.steam_id}</button> : <span className="faint">{x.box ? 'a box' : '—'}</span>}</dd>
        <dt>When</dt><dd>{stamp(ms(x.at))}{x.received_at ? <span className="faint"> · received {stamp(ms(x.received_at))}</span> : null}</dd>
        <dt>Kind</dt><dd>{x.kind}{x.reason ? ` / ${x.reason}` : ''}</dd>
        <dt>Launcher</dt><dd>{x.launcher_version || '—'}</dd>
        <dt>DLL</dt><dd className="mono" title={x.dll_sha || ''}>{short(x.dll_sha, 8)}</dd>
        <dt>Map</dt><dd>{x.map_key || '—'}</dd>
        <dt>Match</dt><dd>{x.match_id ? <button type="button" className="linkish mono" onClick={() => go('games', { q: x.match_id })}>{x.match_id}</button> : '—'}</dd>
        <dt>Box</dt><dd>{x.box || '—'}</dd>
        <dt>Size</dt><dd>{bytes(x.size)}</dd>
        <dt>Upload</dt><dd className={x.upload_state === 'failed' ? 'hot' : ''}>{UPLOAD[x.upload_state] || x.upload_state || '—'}</dd>
        <dt>Id</dt><dd className="mono">{x.id}</dd>
      </dl>

      <h3 className="adm-h3">Flags</h3>
      {hits.length === 0 ? <Empty>{(x.flags || []).length ? x.flags.join(', ') : 'No flags.'}</Empty> : hits.map(([k, h]) => (
        <details key={k} className="adm-hit" open={hits.length === 1}>
          <summary>
            <Sev s={h.severity} /> <b>{h.label || k}</b> <span className="faint">× {h.count ?? 0}</span>
            {h.detail && <span className="adm-sub"> {h.detail}</span>}
          </summary>
          {(h.excerpts || []).length === 0 ? <Empty>No excerpts.</Empty> : h.excerpts.map((e, i) => (
            <div key={i} className="adm-excerpt">
              <div className="faint mono">{e.file || '?'}{e.line != null ? `:${e.line}` : ''}</div>
              <pre className="adm-pre">{(e.lines || []).join('\n')}</pre>
            </div>
          ))}
        </details>
      ))}

      <h3 className="adm-h3">Files</h3>
      {files.length === 0 ? <Empty>No files.</Empty> : (
        <ul className="adm-list">
          {files.map((fl) => (
            <li key={fl.name}>
              <span className="mono">{fl.name}</span>
              <span className="faint">{bytes(fl.size)}</span>
              {fl.binary && <span className="tag">binary</span>}
              {fl.truncated && <span className="tag gold">truncated</span>}
              {fl.scrubbed && <span className="tag">scrubbed</span>}
            </li>
          ))}
        </ul>
      )}

      {x.manifest && (
        <details className="adm-hit">
          <summary><b>Manifest</b></summary>
          <pre className="adm-pre">{JSON.stringify(x.manifest, null, 2)}</pre>
        </details>
      )}
    </>
  )
}
