import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, num } from '../../api'
import { Panel, Table, Search, Chips, when, useLoad, useAct, useAdmin } from './kit'

// Maps: the catalogue, with the two flags that decide what players see. `hidden` takes a map
// off every list; `health` = broken takes it off Maps and refuses a lease for it (lib/
// assignments.js). "On our box" is the measured list (lib/maps.js), read-only here: only a
// five-gate run changes it.
const HEALTH = ['verified', 'playable', 'custom-only', 'broken', 'catalogued']
const SERVER = { proven: ['Proven', 'good'], box: ['New', 'gold'] }

export default function Maps() {
  const [health, setHealth] = useState('')
  const [hidden, setHidden] = useState(false)
  const [q, setQ] = useState('')
  const [pg, setPg] = useState(1)
  const [sort, setSort] = useState({ key: 'title', dir: 'asc' })
  const m = useLoad(() => api.get(`/api/admin/maps?${new URLSearchParams({ q, health, hidden: hidden ? '1' : '', page: pg, size: 50, sort: sort.key, dir: sort.dir })}`), [q, health, hidden, pg, sort.key, sort.dir])
  const act = useAct()
  const { confirm } = useAdmin()
  const counts = (m.data && m.data.counts) || {}

  const save = async (x, patch, ok) => { if (await act(() => api.post(`/api/admin/maps/${encodeURIComponent(x.key)}`, patch), ok)) m.reload() }
  const setHealthOf = async (x, h) => {
    if (h === x.health) return
    if (h === 'broken') {
      const ok = await confirm({ title: `Mark ${x.title} broken?`, lines: ['It leaves Maps and nobody can start it on our servers.'], danger: true, label: 'Mark broken' })
      if (!ok) return m.reload()
    }
    save(x, { health: h }, `${x.title}: ${h}`)
  }
  const hide = async (x) => {
    if (!x.hidden) {
      const ok = await confirm({ title: `Hide ${x.title}?`, lines: ['It leaves every list, row and search. Its page and records stay.', x.playlists.length && `It is in: ${x.playlists.join(', ')}.`], label: 'Hide' })
      if (!ok) return
    }
    save(x, { hidden: !x.hidden }, x.hidden ? 'Shown' : 'Hidden')
  }
  const week = async (x) => {
    const ok = await confirm({ title: `Map of the week: ${x.title}?`, reason: 'optional', label: 'Set' })
    if (ok && await act(() => api.post('/api/admin/map-of-week', { map_key: x.key, note: ok.reason }), 'Map of the week set')) m.reload()
  }

  return (
    <>
      {m.data && (
        <Panel title="Map of the week" right={m.data.week ? <Link className="btn small ghost" to={`/m/${m.data.week.map.key}`}>Open</Link> : null}>
          {m.data.week ? <p><b>{m.data.week.map.title}</b>{m.data.week.note ? ` · ${m.data.week.note}` : ''} <span className="faint">· {m.data.week.runs ? m.data.week.runs.length : 0} runs this week</span></p> : <p className="adm-sub">None this week. Set one from a row below.</p>}
        </Panel>
      )}
      <Panel title="Catalogue">
        <Chips value={health} onChange={(h) => { setHealth(h); setPg(1) }} options={[['', 'On the site', null], ...HEALTH.map((h) => [h, h, counts[h] || 0]), ['all', 'Everything', null]]} />
        <Table total={m.data ? m.data.total : 0} page={pg} onPage={setPg} pageSize={50} sort={sort} onSort={(s) => { setSort(s); setPg(1) }}
          rows={m.data ? m.data.maps : []} rowKey="key" empty={m.data ? 'No maps match.' : 'Loading…'}
          rowClass={(x) => (x.hidden ? 'adm-dim' : '')}
          toolbar={(
            <>
              <Search value={q} onChange={(x) => { setQ(x); setPg(1) }} placeholder="Title, key or author" />
              <label className="adm-check"><input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); setPg(1) }} /> Hidden only ({counts.hidden || 0})</label>
            </>
          )}
          columns={[
            { key: 'title', label: 'Map', sort: true, render: (x) => <span><Link to={`/m/${x.key}`}><b>{x.title}</b></Link><div className="mono faint">{x.key}</div></span> },
            { key: 'author', label: 'Author', render: (x) => <span className="faint">{x.author || '—'}{x.year ? ` · ${x.year}` : ''}</span> },
            { key: 'health', label: 'Health', sort: true, render: (x) => (
              <select className={`adm-health h-${x.health}`} value={x.health} onChange={(e) => setHealthOf(x, e.target.value)}>
                {HEALTH.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            ) },
            { key: 'server', label: 'Our box', render: (x) => (x.server ? <span className={`tag ${SERVER[x.server][1]}`}>{SERVER[x.server][0]}</span> : <span className="faint">—</span>) },
            { key: 'in', label: 'In', render: (x) => <span className="faint">{[...x.rows, ...x.playlists].join(', ') || '—'}{x.guides ? ` · ${x.guides} guide${x.guides > 1 ? 's' : ''}` : ''}</span> },
            { key: 'plays', label: 'Plays', num: true, sort: true, render: (x) => num(x.plays) },
            { key: 'added', label: 'Added', sort: true, render: (x) => when(x.added_at) },
            { key: 'act', label: '', render: (x) => (
              <span className="adm-row">
                <button type="button" className="btn small ghost" onClick={() => hide(x)}>{x.hidden ? 'Show' : 'Hide'}</button>
                <button type="button" className="btn small ghost" onClick={() => week(x)}>Week</button>
              </span>
            ) },
          ]} />
      </Panel>
    </>
  )
}
