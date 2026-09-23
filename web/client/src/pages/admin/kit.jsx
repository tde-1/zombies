import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

// The admin console's shared pieces (2026-09-23). Movement's vocabulary, scoped under
// `.adm-*` (admin.css): Panel / Fold / Stat / Empty, a table with search, sort and paging,
// a confirm dialog (Movement's mapstaff ConfirmDialog, used here for every destructive
// action instead of window.confirm), and toasts.

// ---- panels ------------------------------------------------------------------------
export function Panel({ title, sub, right, children, className = '' }) {
  return (
    <section className={`adm-panel ${className}`}>
      {(title || right) && (
        <div className="adm-panel-head">
          <div>{title && <h2>{title}</h2>}{sub && <p className="adm-sub">{sub}</p>}</div>
          {right && <div className="adm-panel-right">{right}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Fold({ title, tag, children, open = false }) {
  return (
    <details className="adm-panel adm-fold" open={open}>
      <summary className="adm-panel-head"><div><h2>{title}</h2></div><div className="adm-row">{tag != null && <span className="tag">{tag}</span>}<span className="adm-caret">▾</span></div></summary>
      <div className="adm-fold-body">{children}</div>
    </details>
  )
}

export function Stat({ label, value, tone, onClick }) {
  const El = onClick ? 'button' : 'div'
  return <El type={onClick ? 'button' : undefined} className={`adm-stat ${tone || ''}`} onClick={onClick}><b>{value}</b><span>{label}</span></El>
}

export const Empty = ({ children }) => <div className="adm-empty">{children}</div>

export function Chips({ value, onChange, options }) {
  return (
    <div className="adm-chips">
      {options.map(([k, label, n]) => (
        <button key={k} type="button" className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {label}{n != null && <b>{n}</b>}
        </button>
      ))}
    </div>
  )
}

export function Search({ value, onChange, placeholder = 'Search', delay = 250 }) {
  const [v, setV] = useState(value || '')
  const t = useRef(null)
  useEffect(() => { setV(value || '') }, [value])
  return (
    <input className="adm-search" type="search" value={v} placeholder={placeholder}
           onChange={(e) => { const x = e.target.value; setV(x); clearTimeout(t.current); t.current = setTimeout(() => onChange(x), delay) }} />
  )
}

// ---- the table -----------------------------------------------------------------------
// columns: [{ key, label, sort: true | (row) => value, num, render: (row) => node, className }]
//
// Client mode (default): `rows` is everything; search, sort and paging happen here.
// Server mode (`total` given): `rows` is one page; `page`, `onPage`, `sort`, `onSort` are
// the caller's, and the caller refetches.
export function Table({ columns, rows, rowKey = 'id', search, searchPlaceholder, pageSize = 25, empty = 'Nothing here.',
  total, page, onPage, sort: sortIn, onSort, toolbar, rowClass, onRow }) {
  const server = total != null
  const [q, setQ] = useState('')
  const [sortL, setSortL] = useState(null)
  const [pageL, setPageL] = useState(1)
  const sort = server ? sortIn : sortL

  const filtered = useMemo(() => {
    if (server || !q || !search) return rows
    const s = q.toLowerCase()
    return rows.filter((r) => search(r).toLowerCase().includes(s))
  }, [rows, q, search, server])

  const sorted = useMemo(() => {
    if (server || !sort) return filtered
    const col = columns.find((c) => c.key === sort.key)
    if (!col) return filtered
    const get = typeof col.sort === 'function' ? col.sort : (r) => r[col.key]
    const out = [...filtered].sort((a, b) => {
      const x = get(a); const y = get(b)
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })
    })
    return sort.dir === 'desc' ? out.reverse() : out
  }, [filtered, sort, columns, server])

  const count = server ? total : sorted.length
  const pages = Math.max(1, Math.ceil(count / pageSize))
  const cur = Math.min(server ? page || 1 : pageL, pages)
  const shown = server ? rows : sorted.slice((cur - 1) * pageSize, cur * pageSize)
  const go = (p) => (server ? onPage && onPage(p) : setPageL(p))

  const clickSort = (c) => {
    if (!c.sort) return
    const next = !sort || sort.key !== c.key ? { key: c.key, dir: c.num ? 'desc' : 'asc' } : { key: c.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
    if (server) { onSort && onSort(next) } else { setSortL(next); setPageL(1) }
  }

  return (
    <div className="adm-table-box">
      {(search || toolbar) && (
        <div className="adm-toolbar">
          {search && !server && <Search value={q} onChange={(x) => { setQ(x); setPageL(1) }} placeholder={searchPlaceholder} delay={0} />}
          {toolbar}
          <span className="adm-count">{count.toLocaleString()} {count === 1 ? 'row' : 'rows'}</span>
        </div>
      )}
      {shown.length === 0 ? <Empty>{empty}</Empty> : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className={`${c.num ? 'num' : ''} ${c.sort ? 'sortable' : ''} ${c.className || ''}`}
                      aria-sort={sort && sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                      onClick={() => clickSort(c)}>
                    {c.label}{sort && sort.key === c.key && <span className="adm-sort">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={typeof rowKey === 'function' ? rowKey(r) : (r[rowKey] ?? i)} className={rowClass ? rowClass(r) : ''}
                    onClick={onRow ? () => onRow(r) : undefined} style={onRow ? { cursor: 'pointer' } : undefined}>
                  {columns.map((c) => <td key={c.key} className={`${c.num ? 'num' : ''} ${c.className || ''}`}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="adm-pager">
          <button type="button" className="btn small ghost" disabled={cur <= 1} onClick={() => go(cur - 1)}>Prev</button>
          <span>{cur} / {pages}</span>
          <button type="button" className="btn small ghost" disabled={cur >= pages} onClick={() => go(cur + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}

// ---- confirm + toast ------------------------------------------------------------------
const Ctx = createContext(null)

export function AdminHost({ children }) {
  const [dlg, setDlg] = useState(null)
  const [toasts, setToasts] = useState([])
  const confirm = useCallback((o) => new Promise((resolve) => setDlg({ ...o, resolve })), [])
  const toast = useCallback((msg, tone = 'good') => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, msg, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 6000 : 3000)
  }, [])
  const api = useMemo(() => ({ confirm, toast }), [confirm, toast])
  return (
    <Ctx.Provider value={api}>
      {children}
      {dlg && <ConfirmDialog {...dlg} onDone={(v) => { dlg.resolve(v); setDlg(null) }} />}
      <div className="adm-toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`adm-toast ${t.tone}`}>{t.msg}</div>)}
      </div>
    </Ctx.Provider>
  )
}

export const useAdmin = () => useContext(Ctx)

// { title, lines: [string|falsy], people: [{name, steam_id}], label, danger, reason: 'optional'|'required', type: 'text to type' }
function ConfirmDialog({ title, lines = [], people, label = 'Confirm', danger, reason, type, onDone }) {
  const [text, setText] = useState('')
  const [typed, setTyped] = useState('')
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onDone(false) }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onDone])
  const blocked = (reason === 'required' && !text.trim()) || (type && typed.trim() !== type)
  return (
    <div className="adm-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false) }}>
      <div className="adm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="adm-modal-head"><h3>{title}</h3><button type="button" className="adm-x" onClick={() => onDone(false)} aria-label="Close">×</button></div>
        <div className="adm-modal-body">
          {lines.filter(Boolean).map((l, i) => <p key={i}>{l}</p>)}
          {people && people.length > 0 && (
            <ul className="adm-people">
              {people.map((p) => <li key={p.steam_id}><b>{p.name}</b> <span className="mono faint">{p.steam_id}</span></li>)}
            </ul>
          )}
          {reason && <textarea className="adm-reason" rows={2} maxLength={300} placeholder={reason === 'required' ? 'Reason (required)' : 'Reason (optional)'} value={text} onChange={(e) => setText(e.target.value)} />}
          {type && <label className="adm-type">Type <b>{type}</b> to confirm<input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus /></label>}
        </div>
        <div className="adm-modal-foot">
          <button type="button" className="btn small ghost" onClick={() => onDone(false)}>Cancel</button>
          <button type="button" className={`btn small ${danger ? 'primary' : 'accent'}`} disabled={blocked} onClick={() => onDone({ reason: text.trim() || null })} autoFocus={!type}>{label}</button>
        </div>
      </div>
    </div>
  )
}

// ---- small helpers ----------------------------------------------------------------------
export function when(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`
  return d.toISOString().slice(0, 10)
}
export const stamp = (ts) => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—')
export const short = (s, n = 10) => (s ? String(s).slice(0, n) : '—')
export const mb = (b) => (b ? `${Math.round(b / 1048576)} MiB` : '—')

/** Load a JSON endpoint; `reload()` refetches. */
export function useLoad(fn, deps) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    let live = true
    setErr(null)
    fn().then((d) => { if (live) setData(d) }).catch((e) => { if (live) setErr(e.message) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n])
  return { data, err, reload: () => setN((x) => x + 1), setData }
}

/** Run an action with a toast; returns the result or null. */
export function useAct() {
  const { toast } = useAdmin()
  return useCallback(async (fn, ok) => {
    try { const out = await fn(); if (ok) toast(ok); return out || true } catch (e) { toast(e.message, 'bad'); return null }
  }, [toast])
}
