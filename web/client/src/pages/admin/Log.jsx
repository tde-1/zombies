import { useEffect, useState } from 'react'
import { api } from '../../api'
import { Panel, Chips, Search, Empty, when, stamp } from './kit'

// The Log: Movement's LogPanel over `activity_log`. Lanes, a search, who, a time window,
// Load older. Every admin write lands here with the actor (lib/adminLog.js).

const LANES = [['', 'Everything'], ['boxes', 'Boxes'], ['people', 'People'], ['moderation', 'Moderation'], ['records', 'Records'], ['content', 'Content'], ['other', 'Other']]

// Short sentences for the common events. Anything else prints its name and its fields.
const SAY = {
  'user.approve': (m) => `approved ${list(m.steam_ids || [m.steam_id])}`,
  'user.unapprove': (m) => `took back approval: ${list(m.steam_ids || [m.steam_id])}`,
  'user.role': (m) => `roles for ${m.steam_id}: ${Object.entries(m).filter(([k]) => k !== 'steam_id').map(([k, v]) => `${v ? '+' : '-'}${k}`).join(' ')}`,
  'ban.add': (m) => `banned ${m.steam_id} (${m.scope}${m.cheating ? ', cheating' : ''})`,
  'ban.remove': (m) => `lifted ban #${m.id}`,
  'infraction.add': (m) => `infraction on ${m.steam_id}: ${m.kind}`,
  'report.resolve': (m) => `report #${m.id} → ${m.status}`,
  'chat.remove': (m) => `removed chat line #${m.id}`,
  'chat.restore': (m) => `restored chat line #${m.id}`,
  'record.void': (m) => `voided record #${m.id}`,
  'record.verify': (m) => `verified record #${m.id}: ${m.ok ? 'ok' : 'failed'}`,
  'map.edit': (m) => `${m.map}: ${Object.entries(m.changed || {}).map(([k, v]) => `${k} ${fmt(v.from)} → ${fmt(v.to)}`).join(', ')}`,
  'week.set': (m) => `map of the week: ${m.map}`,
  'playlist.create': (m) => `playlist /${m.slug} created${m.maps ? `, ${m.maps} maps` : ''}`,
  'playlist.update': (m) => `playlist /${m.slug || m.id} edited${m.state ? ` (${m.state})` : ''}`,
  'playlist.delete': (m) => `playlist /${m.slug} deleted`,
  'lease.retire': (m) => `retired ${m.match_id}${m.kicked && m.kicked.length ? `, ${m.kicked.length} in game` : ''}`,
  'lease.restart': (m) => `restarted ${m.from} as ${m.to}`,
  'assignment.lease': (m) => `lease ${m.match_id} on ${m.box}: ${m.map}${m.agent ? ' (agent)' : ''}`,
  'assignment.cancel': (m) => `lease ${m.match_id} cancelled`,
  'assignment.supersede': (m) => `lease ${m.match_id} superseded: ${m.why}`,
  'assignment.ghost': (m) => `lease ${m.match_id} closed: ${m.why}`,
  'box.dll': (m) => `${m.box} DLL noted ${String(m.sha256).slice(0, 8)}`,
  'box.capacity': (m) => `${m.box} capacity${m.max_instances != null ? ` max ${m.max_instances}` : ''}${m.reserve !== undefined ? ` reserve ${m.reserve ?? 'default'}` : ''}`,
  'box.key.changed': (m) => `replay key changed: ${m.was} → ${m.now}`,
  'box.key.accepted': (m) => `${m.box} key accepted: ${m.key_id}`,
  'box.key.rejected': (m) => `${m.box} key rejected`,
  'admin.action': (m) => `${m.method} ${m.path}`,
}
const list = (a) => (a || []).filter(Boolean).join(', ')
const fmt = (v) => (v == null || v === '' ? '∅' : String(v))
function say(r) {
  const m = r.meta && typeof r.meta === 'object' ? r.meta : {}
  try { if (SAY[r.event]) return SAY[r.event](m) } catch { /* fall through */ }
  const bits = Object.entries(m).slice(0, 4).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
  return bits.join(' · ')
}
const subjectOf = (r) => (r.meta && (r.meta.steam_id || (Array.isArray(r.meta.steam_ids) && r.meta.steam_ids.length === 1 && r.meta.steam_ids[0]))) || null

export function LogRows({ rows, openUser, compact }) {
  if (!rows.length) return <Empty>Nothing logged.</Empty>
  return (
    <div className={`adm-log ${compact ? 'compact' : ''}`}>
      {rows.map((r) => {
        const subj = subjectOf(r)
        return (
          <div key={r.id} className={`adm-logrow lane-${r.lane}`}>
            <span className="adm-log-when" title={stamp(r.at)}>{when(r.at)}</span>
            <span className="adm-log-who">
              {r.who ? <button type="button" className="linkish" onClick={() => openUser(r.who.steam_id)}>{r.who.name}</button> : <span className="faint">{r.actor || 'site'}</span>}
            </span>
            <span className="adm-log-what"><code>{r.event}</code> {say(r)}</span>
            {!compact && <span className="adm-log-act">{subj && <button type="button" className="btn small ghost" onClick={() => openUser(subj)}>Person</button>}</span>}
          </div>
        )
      })}
    </div>
  )
}

export default function Log({ openUser }) {
  const [lane, setLane] = useState('')
  const [q, setQ] = useState('')
  const [actor, setActor] = useState('')
  const [win, setWin] = useState('all')
  const [rows, setRows] = useState(null)
  const [next, setNext] = useState(null)
  const [counts, setCounts] = useState(null)
  const [err, setErr] = useState(null)

  const qs = (before) => new URLSearchParams({ lane, q, actor, window: win, limit: '60', ...(before ? { before } : {}) }).toString()
  useEffect(() => {
    setRows(null)
    api.get(`/api/admin/log?${qs()}`).then((d) => { setRows(d.rows); setNext(d.next) }).catch((e) => setErr(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane, q, actor, win])
  useEffect(() => { api.get(`/api/admin/log/counts?window=${win === 'all' ? 'all' : win}`).then((d) => setCounts(d.counts)).catch(() => {}) }, [win])
  const more = async () => { const d = await api.get(`/api/admin/log?${qs(next)}`); setRows((r) => [...r, ...d.rows]); setNext(d.next) }

  return (
    <Panel title="Log" sub="Every staff action, every lease, every box event.">
      <Chips value={lane} onChange={setLane} options={LANES.map(([k, l]) => [k, l, counts ? counts[k || 'all'] : null])} />
      <div className="adm-toolbar">
        <Search value={q} onChange={setQ} placeholder="Search events, ids, SteamIDs" />
        <select value={actor} onChange={(e) => setActor(e.target.value)}><option value="">Everyone</option><option value="people">Staff and players</option><option value="auto">Automatic</option></select>
        <select value={win} onChange={(e) => setWin(e.target.value)}><option value="today">Today</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="all">All time</option></select>
      </div>
      {err ? <Empty>{err}</Empty> : !rows ? <Empty>Loading…</Empty> : <LogRows rows={rows} openUser={openUser} />}
      {next && <div className="adm-pager"><button type="button" className="btn small ghost" onClick={more}>Load older</button></div>}
    </Panel>
  )
}
