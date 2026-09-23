import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, clock, num } from '../../api'
import { Panel, Table, Empty, when, useLoad, useAct, useAdmin } from './kit'

// Records: every standing record with its replay's grade. Verify re-reads the file and
// checks it against the key pinned for that box; Void takes the record off its board.
const GRADE = { signed: 'signed, pinned key', unpinned: 'UNPINNED KEY', 'unknown-key': 'key unknown', recovered: 'recovered after a crash', none: 'no replay' }

export default function Records() {
  const r = useLoad(() => api.get('/api/admin/records/review'), [])
  const [checked, setChecked] = useState({})
  const [busy, setBusy] = useState(null)
  const act = useAct()
  const { confirm } = useAdmin()
  if (r.err) return <Panel title="Records"><Empty>{r.err}</Empty></Panel>
  if (!r.data) return <Panel title="Records"><Empty>Loading…</Empty></Panel>

  const verify = async (x) => {
    setBusy(x.id)
    try { const out = await api.post(`/api/admin/records/${x.id}/verify`); setChecked((c) => ({ ...c, [x.id]: out })) } catch (e) { setChecked((c) => ({ ...c, [x.id]: { ok: false, error: e.message } })) }
    setBusy(null)
  }
  const voidIt = async (x) => {
    const ok = await confirm({ title: `Void this record on ${x.map_key}?`, lines: [`${x.category} · ${x.player_count === 1 ? 'solo' : `${x.player_count}p`} · ${x.round ? `round ${x.round}` : clock(x.value_ms)}`, 'It comes off the board. The game stays.'], reason: 'optional', danger: true, label: 'Void' })
    if (ok && await act(() => api.post(`/api/admin/records/${x.id}/void`, { note: ok.reason }), 'Voided')) r.reload()
  }

  return (
    <Panel title="Records" sub="Verify re-reads every chunk and checks the footer against the box's pinned key.">
      <Table rows={r.data.records} search={(x) => `${x.map_key} ${x.category} ${x.players.map((p) => p.name).join(' ')} ${x.match_id || ''}`} searchPlaceholder="Map, category, player"
        empty="No records yet."
        columns={[
          { key: 'map_key', label: 'Map', sort: true, render: (x) => <Link to={`/m/${x.map_key}`}>{x.map_key.replace('nazi_zombie_', '')}</Link> },
          { key: 'category', label: 'Board', sort: true, render: (x) => <span className="faint">{x.category} · {x.player_count === 1 ? 'solo' : `${x.player_count}p`} · {x.profile}</span> },
          { key: 'players', label: 'Players', render: (x) => x.players.map((p) => p.name).join(', ') },
          { key: 'value', label: 'Result', num: true, sort: (x) => x.round || x.value_ms, render: (x) => (x.round ? `R${x.round}` : clock(x.value_ms)) },
          { key: 'profile_ok', label: 'Rules', sort: true, render: (x) => (x.profile_ok ? 'ok' : <span className="hot" title={x.profile_note}>mismatch</span>) },
          { key: 'replay', label: 'Replay', sort: (x) => (x.replay ? x.replay.grade : 'none'), render: (x) => {
            const c = checked[x.id]
            return (
              <>
                {!x.replay ? <span className="faint">—</span> : <span className={x.replay.ok ? '' : 'hot'} title={x.replay.reason}>{GRADE[x.replay.grade] || x.replay.grade}</span>}
                {c && <div className={c.ok ? 'good' : 'hot'}>{c.verdict || c.error}{c.ok ? ` · ${c.chunks} chunks, ${num(c.events)} events` : ''}</div>}
              </>
            )
          } },
          { key: 'at', label: 'Set', sort: true, render: (x) => when(x.at) },
          { key: 'act', label: '', render: (x) => (
            <span className="adm-row">
              {x.match_id && <Link className="btn small ghost" to={`/replay/${x.match_id}`}>Watch</Link>}
              {x.replay && x.replay.available && <button type="button" className="btn small ghost" disabled={busy === x.id} onClick={() => verify(x)}>{busy === x.id ? '…' : 'Verify'}</button>}
              <button type="button" className="btn small ghost" onClick={() => voidIt(x)}>Void</button>
            </span>
          ) },
        ]} />
    </Panel>
  )
}
