import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useSession } from '../session'
import { Loading } from '../components/Bits'
import { AdminHost, useAct } from './admin/kit'
import Now from './admin/Now'
import Log from './admin/Log'
import People, { PersonSheet } from './admin/People'
import Reports from './admin/Reports'
import Chat from './admin/Chat'
import Records from './admin/Records'
import Games from './admin/Games'
import Maps from './admin/Maps'
import Playlists from './admin/Playlists'
import Rows from './admin/Rows'
import Guides from './admin/Guides'
import Badges from './admin/Badges'
import Boxes from './admin/Boxes'
import Release from './admin/Release'
import Issues from './admin/Issues'
import './admin/admin.css'

// The operator console (2026-09-23, web.md "admin: parity with Movement and beyond").
//
// Movement's shape: a header, a pill tab bar with counts, a to-do strip, then panels; every
// piece of state in the URL (?tab=, ?user=) so a link lands on the same view. Ours groups the
// tabs (Operate · People · Content · Log) because it has twice as many, and adds the
// Zombies-only pages: Boxes, Games, Release, Playlists, Rows, Guides.

const TABS = [
  ['Operate', [['now', 'Now'], ['boxes', 'Boxes', 'admin'], ['games', 'Games'], ['issues', 'Issues'], ['release', 'Release', 'admin']]],
  ['People', [['people', 'People'], ['reports', 'Reports'], ['chat', 'Chat'], ['records', 'Records']]],
  ['Content', [['maps', 'Maps'], ['playlists', 'Playlists'], ['rows', 'Rows'], ['guides', 'Guides'], ['badges', 'Badges']]],
  ['', [['log', 'Log']]],
]
// Old ?tab= names from the previous console.
const ALIASES = { overview: 'now', waitlist: 'people', users: 'people' }

export default function Admin() {
  const { isMod, isAdmin, me } = useSession()
  if (!me) return <div className="page"><h1>Sign in required</h1></div>
  if (!isMod) return <div className="page"><h1>Staff only</h1></div>
  return <AdminHost><Console isAdmin={isAdmin} /></AdminHost>
}

function Console({ isAdmin }) {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab') || 'now'
  const tab = ALIASES[raw] || raw
  const user = params.get('user')
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  const act = useAct()

  const load = useCallback(() => api.get('/api/admin').then(setD).catch((e) => setErr(e.message)), [])
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])

  const go = useCallback((t, extra = {}) => {
    const p = new URLSearchParams()
    p.set('tab', t)
    for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') p.set(k, v)
    setParams(p)
  }, [setParams])
  const openUser = useCallback((sid) => { const p = new URLSearchParams(params); if (sid) p.set('user', sid); else p.delete('user'); setParams(p) }, [params, setParams])

  if (err) return <div className="page"><h1>{err}</h1></div>
  if (!d) return <div className="page"><Loading /></div>

  const c = d.counts
  const badge = {
    people: c.waiting, reports: c.new, boxes: d.key_warnings.length,
    games: c.flagged_7d, issues: (c.incidents_p1 || 0) + (c.incidents_p2 || 0), playlists: c.playlists === 0 ? '!' : 0,
  }
  const todo = [
    c.waiting > 0 && ['people', `${c.waiting} at the door`, 'warn', { filter: 'waiting' }],
    c.new > 0 && ['reports', `${c.new} ${c.new === 1 ? 'report' : 'reports'} open`, 'warn'],
    ...d.key_warnings.map((b) => ['boxes', `${b.name}: replay key changed`, 'bad']),
    c.playlists === 0 && ['playlists', 'No live playlists: /maps shows Popular only', 'warn'],
    c.flagged_7d > 0 && ['games', `${c.flagged_7d} flagged ${c.flagged_7d === 1 ? 'result' : 'results'} this week`, '', { flag: 'any' }],
    (c.incidents_p1 > 0 || c.incidents_p2 > 0) && ['issues',
      `${[c.incidents_p1 > 0 && `${c.incidents_p1} P1`, c.incidents_p2 > 0 && `${c.incidents_p2} P2`].filter(Boolean).join(', ')} to review`,
      c.incidents_p1 > 0 ? 'bad' : 'warn', { severity: '1,2', reviewed: '0' }],
    c.boxes > 0 && c.boxes_online < c.boxes && ['boxes', `${c.boxes - c.boxes_online} of ${c.boxes} boxes offline`, ''],
  ].filter(Boolean)

  const page = { d, reload: load, go, openUser, isAdmin, params }
  return (
    <div className="page wide adm">
      <header className="adm-head">
        <div>
          <div className="section-label">ENW Zombies · Operator console</div>
          <h1>Administration</h1>
        </div>
        <div className="adm-head-facts">
          <span><b>{c.live_leases}</b> live {c.live_leases === 1 ? 'game' : 'games'}</span>
          <span><b>{d.presence.online}</b> online</span>
          <span><b>{c.boxes_online}</b>/{c.boxes} boxes</span>
          {d.release && d.release.version && <span>launcher <b>{d.release.version}</b></span>}
        </div>
      </header>

      <nav className="adm-tabs" aria-label="Admin sections">
        {TABS.map(([group, items]) => (
          <div className="adm-tabgroup" key={group || 'end'}>
            {group && <span className="adm-tabgroup-label">{group}</span>}
            {items.filter(([, , need]) => need !== 'admin' || isAdmin).map(([k, label]) => (
              <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => go(k)} aria-current={tab === k ? 'page' : undefined}>
                {label}{badge[k] ? <b className={badge[k] === '!' ? 'warn' : ''}>{badge[k]}</b> : null}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {todo.length > 0 && (
        <div className="adm-todo">
          {todo.map(([t, label, tone, extra], i) => <button key={i} type="button" className={`adm-todo-item ${tone}`} onClick={() => go(t, extra)}>{label}</button>)}
        </div>
      )}

      {d.key_warnings.length > 0 && (
        <div className="adm-alert bad">
          {d.key_warnings.map((b) => (
            <div key={b.id} className="adm-spread">
              <span><b>{b.name}</b> presents replay key <code>{b.key.pending}</code>; <code>{b.key.pinned}</code> is pinned. Replays are stored unpinned until settled.</span>
              {isAdmin && (
                <span className="adm-row">
                  <button className="btn small accent" onClick={async () => { await act(() => api.post(`/api/admin/boxes/${b.id}/key/accept`), 'Key accepted'); load() }}>Accept</button>
                  <button className="btn small ghost" onClick={async () => { await act(() => api.post(`/api/admin/boxes/${b.id}/key/reject`), 'Key rejected'); load() }}>Reject</button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="adm-body">
        {tab === 'now' && <Now {...page} />}
        {tab === 'log' && <Log {...page} />}
        {tab === 'people' && <People {...page} />}
        {tab === 'reports' && <Reports {...page} />}
        {tab === 'chat' && <Chat {...page} />}
        {tab === 'records' && <Records {...page} />}
        {tab === 'games' && <Games {...page} />}
        {tab === 'issues' && <Issues {...page} />}
        {tab === 'maps' && <Maps {...page} />}
        {tab === 'playlists' && <Playlists {...page} />}
        {tab === 'rows' && <Rows {...page} />}
        {tab === 'guides' && <Guides {...page} />}
        {tab === 'badges' && <Badges {...page} />}
        {tab === 'boxes' && isAdmin && <Boxes {...page} />}
        {tab === 'release' && isAdmin && <Release {...page} />}
      </div>

      {user && <PersonSheet who={user} isAdmin={isAdmin} onClose={() => openUser(null)} onChange={load} />}
    </div>
  )
}
