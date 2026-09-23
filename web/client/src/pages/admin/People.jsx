import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { Avatar } from '../../components/Bits'
import { Panel, Fold, Table, Search, Empty, when, stamp, useLoad, useAct, useAdmin } from './kit'
import { LogRows } from './Log'

// People: Movement's PeopleTab. "At the door" (the beta gate: who has signed in with Steam
// and is not approved), then everyone, searchable, with a sheet per person.

const FILTERS = [['all', 'Everyone'], ['waiting', 'At the door'], ['approved', 'Approved'], ['staff', 'Staff'], ['banned', 'Banned'], ['nameless', 'No ENW name']]

export default function People({ params, go, openUser, reload }) {
  const filter = params.get('filter') || 'all'
  const [q, setQ] = useState('')
  const [pg, setPg] = useState(1)
  const [sort, setSort] = useState({ key: 'seen', dir: 'desc' })
  const list = useLoad(() => api.get(`/api/admin/users?${new URLSearchParams({ q, filter, page: pg, size: 50, sort: sort.key, dir: sort.dir })}`), [q, filter, pg, sort.key, sort.dir])
  const reloadAll = () => { list.reload(); reload() }

  return (
    <>
      <Door onDone={reloadAll} openUser={openUser} />
      <Panel title="Everyone">
        <Table
          total={list.data ? list.data.total : 0} page={pg} onPage={setPg} pageSize={50}
          sort={sort} onSort={(s) => { setSort(s); setPg(1) }}
          rows={list.data ? list.data.users : []} rowKey="steam_id"
          onRow={(u) => openUser(u.steam_id)}
          empty={list.data ? 'Nobody matches.' : 'Loading…'}
          toolbar={(
            <>
              <Search value={q} onChange={(x) => { setQ(x); setPg(1) }} placeholder="ENW name, persona or SteamID64" />
              <select value={filter} onChange={(e) => { go('people', { filter: e.target.value }); setPg(1) }}>
                {FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </>
          )}
          columns={[
            { key: 'name', label: 'Player', sort: true, render: (u) => <span className="adm-who"><Avatar user={u} size="sm" /><b>{u.name}</b>{u.online && <span className="adm-dot on" title="online" />}</span> },
            { key: 'steam_id', label: 'SteamID64', render: (u) => <span className="mono faint">{u.steam_id}</span> },
            { key: 'holds', label: 'Holds', render: (u) => <Holds u={u} /> },
            { key: 'games', label: 'Games', num: true, sort: true },
            { key: 'level', label: 'Level', num: true, sort: true, render: (u) => `${u.prestige ? `P${u.prestige} ` : ''}${u.level}` },
            { key: 'created', label: 'Joined', sort: true, render: (u) => when(u.created_at) },
            { key: 'seen', label: 'Seen', sort: true, render: (u) => when(u.last_seen) },
          ]}
        />
      </Panel>
      <BansFold openUser={openUser} onDone={reloadAll} />
    </>
  )
}

export function Holds({ u }) {
  return (
    <span className="adm-holds">
      {u.admin && <span className="tag gold">Admin</span>}
      {u.mod && !u.admin && <span className="tag good">Mod</span>}
      {u.archivist && <span className="tag">Archivist</span>}
      {u.vip && <span className="tag gold">VIP</span>}
      {!u.approved && <span className="tag hot">At the door</span>}
      {!u.enw_name && <span className="tag hot">No name</span>}
      {u.bans > 0 && <span className="tag hot">Banned</span>}
    </span>
  )
}

// The beta gate. Approve the selected, or paste SteamID64s (one per line) for people who
// have not signed in yet: the row is created and approved, as tools/approve.js did.
function Door({ onDone, openUser }) {
  const w = useLoad(() => api.get('/api/admin/waitlist'), [])
  const [sel, setSel] = useState(new Set())
  const [paste, setPaste] = useState('')
  const act = useAct()
  const { confirm } = useAdmin()
  const rows = (w.data && w.data.users) || []
  const toggle = (sid) => setSel((s) => { const n = new Set(s); if (n.has(sid)) n.delete(sid); else n.add(sid); return n })
  const approve = async (ids) => {
    if (!ids.length) return
    const ok = await confirm({ title: `Approve ${ids.length}?`, lines: ['They can play from their next launch.'], label: 'Approve' })
    if (!ok) return
    if (await act(() => api.post('/api/admin/approve', { steam_ids: ids }), `Approved ${ids.length}`)) { setSel(new Set()); setPaste(''); w.reload(); onDone() }
  }
  const pasted = paste.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  return (
    <Panel title="At the door" sub="Signed in with Steam, not approved to play." right={<span className="tag">{rows.length}</span>}>
      {rows.length === 0 ? <Empty>Nobody waiting.</Empty> : (
        <>
          <div className="adm-door">
            {rows.map((u) => (
              <label key={u.steam_id} className={`adm-door-row ${sel.has(u.steam_id) ? 'on' : ''}`}>
                <input type="checkbox" checked={sel.has(u.steam_id)} onChange={() => toggle(u.steam_id)} />
                <Avatar user={u} size="sm" />
                <b>{u.enw_name || <span className="faint">no name yet</span>}</b>
                <span className="mono faint">{u.steam_id}</span>
                <span className="faint">{when(u.created_at)}</span>
                <button type="button" className="btn small ghost" onClick={(e) => { e.preventDefault(); openUser(u.steam_id) }}>Open</button>
              </label>
            ))}
          </div>
          <div className="adm-row">
            <button type="button" className="btn small ghost" onClick={() => setSel(sel.size === rows.length ? new Set() : new Set(rows.map((u) => u.steam_id)))}>{sel.size === rows.length ? 'Select none' : 'Select all'}</button>
            <button type="button" className="btn small accent" disabled={!sel.size} onClick={() => approve([...sel])}>Approve {sel.size || ''}</button>
          </div>
        </>
      )}
      <div className="adm-form" style={{ marginTop: 12 }}>
        <label className="grow">Approve by SteamID64<textarea rows={2} value={paste} placeholder="7656119…  one per line" onChange={(e) => setPaste(e.target.value)} /></label>
        <button type="button" className="btn small" disabled={!pasted.length} onClick={() => approve(pasted)}>Approve {pasted.length || ''}</button>
      </div>
    </Panel>
  )
}

function BansFold({ openUser, onDone }) {
  const b = useLoad(() => api.get('/api/admin/bans'), [])
  const act = useAct()
  const { confirm } = useAdmin()
  const rows = (b.data && b.data.bans) || []
  const lift = async (x) => {
    const ok = await confirm({ title: `Lift ban on ${x.player ? x.player.name : x.steam_id}?`, lines: [x.cheating && 'A cheating wipe is not undone.'], label: 'Lift' })
    if (ok && await act(() => api.post(`/api/admin/ban/${x.id}/lift`), 'Ban lifted')) { b.reload(); onDone() }
  }
  return (
    <Fold title="Active bans" tag={rows.length}>
      <Table rows={rows} search={(x) => `${x.player ? x.player.name : ''} ${x.steam_id} ${x.reason || ''}`} empty="No active bans."
        columns={[
          { key: 'who', label: 'Player', sort: (x) => (x.player ? x.player.name : x.steam_id), render: (x) => <button type="button" className="linkish" onClick={() => openUser(x.steam_id)}>{x.player ? x.player.name : x.steam_id}</button> },
          { key: 'scope', label: 'Scope', sort: true, render: (x) => <span className={`tag ${x.scope === 'site' ? 'hot' : ''}`}>{x.scope === 'public' ? 'public play' : 'site'}{x.cheating ? ' · cheating' : ''}</span> },
          { key: 'reason', label: 'Reason', render: (x) => x.reason || <span className="faint">—</span> },
          { key: 'by', label: 'By', render: (x) => (x.by ? x.by.name : '—') },
          { key: 'created_at', label: 'When', sort: true, render: (x) => when(x.created_at) },
          { key: 'expires_at', label: 'Ends', sort: true, render: (x) => (x.expires_at ? stamp(x.expires_at) : 'never') },
          { key: 'act', label: '', render: (x) => <button type="button" className="btn small ghost" onClick={() => lift(x)}>Lift</button> },
        ]} />
    </Fold>
  )
}

// ---- the person sheet -------------------------------------------------------------------
const KINDS = [['cheating', 'Cheating'], ['chat', 'Chat abuse'], ['afk-farming', 'AFK farming'], ['griefing', 'Griefing'], ['other', 'Other']]
const DURATIONS = [['', 'Permanent'], [7, 'A week'], [30, 'A month']]

export function PersonSheet({ who, isAdmin, onClose, onChange }) {
  const s = useLoad(() => api.get(`/api/admin/player/${encodeURIComponent(who)}`), [who])
  const act = useAct()
  const { confirm } = useAdmin()
  const [kind, setKind] = useState('griefing')
  const [days, setDays] = useState('')
  const [rename, setRename] = useState('')
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !document.querySelector('.adm-scrim')) onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const done = () => { s.reload(); onChange() }

  const body = () => {
    if (s.err) return <Empty>{s.err}</Empty>
    if (!s.data) return <Empty>Loading…</Empty>
    const { player: p, bans, infractions, games, activity, badges } = s.data
    const sid = p.steam_id
    const activeBans = bans.filter((b) => b.active && (!b.expires_at || b.expires_at > Date.now()))
    const role = async (k, v) => {
      const ok = await confirm({ title: `${v ? 'Make' : 'Remove'} ${k}: ${p.name}?`, label: v ? 'Grant' : 'Remove', danger: !v })
      if (ok && await act(() => api.post(`/api/admin/player/${sid}/role`, { [k]: v }), 'Saved')) done()
    }
    const approve = async (v) => {
      const ok = await confirm({ title: v ? `Approve ${p.name}?` : `Take back ${p.name}'s approval?`, lines: [!v && 'They go back to the door and cannot start a game.'], label: v ? 'Approve' : 'Take back', danger: !v })
      if (ok && await act(() => api.post(`/api/admin/player/${sid}/approve`, { approved: v }), 'Saved')) done()
    }
    const ban = async () => {
      const scope = kind === 'griefing' ? 'public' : 'site'
      const ok = await confirm({
        title: `${scope === 'public' ? 'Public-play ban' : 'Ban'} ${p.name}?`,
        lines: [
          scope === 'public' ? 'They keep playing with friends; no public lobbies or quick join.' : 'They cannot sign in or play.',
          kind === 'cheating' && 'Cheating wipes their records and map badges. Lifting the ban does not bring them back.',
          days ? `Ends in ${days} days.` : 'Permanent.',
        ],
        reason: 'optional', danger: true, label: 'Ban', type: kind === 'cheating' ? p.name : undefined,
      })
      if (!ok) return
      const expires = days ? Date.now() + Number(days) * 86400_000 : null
      if (await act(() => api.post(`/api/admin/player/${sid}/ban`, { kind, reason: ok.reason, expires_at: expires }), 'Banned')) done()
    }
    const infract = async () => {
      const ok = await confirm({ title: `Infraction on ${p.name}: ${kind}?`, lines: ['A note on their record. Nothing else happens.'], reason: 'optional', label: 'Add' })
      if (ok && await act(() => api.post(`/api/admin/player/${sid}/infract`, { kind, note: ok.reason }), 'Added')) done()
    }
    const lift = async (b) => {
      const ok = await confirm({ title: 'Lift this ban?', lines: [b.cheating && 'A cheating wipe is not undone.'], label: 'Lift' })
      if (ok && await act(() => api.post(`/api/admin/ban/${b.id}/lift`), 'Lifted')) done()
    }
    const doRename = async () => {
      const ok = await confirm({ title: `Rename ${p.name} to ${rename}?`, lines: ['The only rename there is. Their next game token carries it.'], label: 'Rename' })
      if (ok && await act(() => api.post(`/api/admin/player/${sid}/username`, { username: rename }), 'Renamed')) { setRename(''); done() }
    }

    return (
      <>
        <div className="adm-sheet-id">
          <Avatar user={p} size="lg" />
          <div>
            <h2>{p.name} {p.online && <span className="adm-dot on" title="online" />}</h2>
            <div className="mono faint">{sid}</div>
            <div className="adm-row"><Holds u={{ ...p, bans: activeBans.length }} /></div>
            <div className="adm-row">
              <Link className="btn small ghost" to={`/id/${encodeURIComponent(p.enw_name || sid)}`}>Profile</Link>
              <a className="btn small ghost" href={`https://steamcommunity.com/profiles/${sid}`} target="_blank" rel="noreferrer noopener">Steam</a>
            </div>
          </div>
        </div>
        <dl className="adm-dl">
          <dt>Persona</dt><dd>{p.persona || '—'}</dd>
          <dt>Joined</dt><dd>{stamp(p.created_at)}</dd>
          <dt>Seen</dt><dd>{when(p.last_seen)}</dd>
          <dt>Where</dt><dd>{p.where && p.where.state ? `${p.where.state}${p.where.map_key ? ` · ${p.where.map_key}` : ''}` : '—'}</dd>
          <dt>Level</dt><dd>{p.prestige ? `P${p.prestige} ` : ''}{p.level} · {p.xp} XP</dd>
        </dl>

        <h3 className="adm-h3">Standing</h3>
        <div className="adm-standing">
          <Toggle label="Approved to play" on={p.approved} onFlip={approve} />
          {isAdmin && <Toggle label="Moderator" on={p.mod} onFlip={(v) => role('mod', v)} />}
          {isAdmin && <Toggle label="Admin" on={p.admin} onFlip={(v) => role('admin', v)} />}
          {isAdmin && <Toggle label="Archivist" on={p.archivist} onFlip={(v) => role('archivist', v)} />}
          {isAdmin && <Toggle label="VIP (local)" on={p.vip} onFlip={(v) => role('vip', v)} />}
        </div>
        {isAdmin && (
          <div className="adm-form">
            <label className="grow">ENW name<input type="text" value={rename} placeholder={p.enw_name || 'none yet'} onChange={(e) => setRename(e.target.value)} /></label>
            <button type="button" className="btn small" disabled={!rename.trim()} onClick={doRename}>Rename</button>
          </div>
        )}

        <h3 className="adm-h3">Bans and warnings</h3>
        <div className="adm-form">
          <label>Kind<select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>For<select value={days} onChange={(e) => setDays(e.target.value)}>{DURATIONS.map(([k, l]) => <option key={l} value={k}>{l}</option>)}</select></label>
          <button type="button" className="btn small ghost" onClick={infract}>Infraction</button>
          <button type="button" className="btn small primary" onClick={ban}>{kind === 'griefing' ? 'Public-play ban' : 'Ban'}</button>
        </div>
        {bans.length + infractions.length === 0 ? <p className="adm-sub">Clean record.</p> : (
          <ul className="adm-list">
            {bans.map((b) => (
              <li key={`b${b.id}`}>
                <span className={`tag ${b.active ? 'hot' : ''}`}>{b.active ? 'ban' : 'lifted'}</span> {b.scope}{b.cheating ? ' · cheating' : ''} · {when(b.created_at)}{b.reason ? ` · ${b.reason}` : ''}
                {b.active && <button type="button" className="btn small ghost" onClick={() => lift(b)}>Lift</button>}
              </li>
            ))}
            {infractions.map((x) => <li key={`i${x.id}`}><span className="tag">infraction</span> {x.kind} · {when(x.created_at)}{x.note ? ` · ${x.note}` : ''}</li>)}
          </ul>
        )}

        <h3 className="adm-h3">Games</h3>
        {games.length === 0 ? <p className="adm-sub">None.</p> : (
          <ul className="adm-list">
            {games.slice(0, 10).map((g) => <li key={g.id}><Link to={`/game/${g.id}`}>{g.map_title || g.map_key}</Link> · R{g.rounds} · {g.mode} · {when(g.ended_at)}</li>)}
          </ul>
        )}
        {badges && badges.length > 0 && (<><h3 className="adm-h3">Badges</h3><p className="adm-sub">{badges.map((b) => b.name).join(', ')}</p></>)}

        <h3 className="adm-h3">Log</h3>
        <LogRows rows={activity} openUser={() => {}} compact />
      </>
    )
  }

  return (
    <div className="adm-sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside className="adm-sheet" role="dialog" aria-label="Person">
        <button type="button" className="adm-x" onClick={onClose} aria-label="Close">×</button>
        {body()}
      </aside>
    </div>
  )
}

function Toggle({ label, on, onFlip }) {
  return (
    <button type="button" className={`adm-toggle ${on ? 'on' : ''}`} onClick={() => onFlip(!on)} aria-pressed={!!on}>
      <span className="adm-toggle-knob" />{label}
    </button>
  )
}
