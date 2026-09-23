import { useEffect, useState } from 'react'
import { api } from '../../api'
import { Panel, Search, Chips, Empty, when, stamp, useAct } from './kit'

// Chat: the global channel (web + every game), newest first, removed lines included on
// request. Remove is reversible, so it asks nothing; Restore puts a line back. Party lines
// and DMs are private and are not here.
export default function Chat({ openUser }) {
  const [q, setQ] = useState('')
  const [origin, setOrigin] = useState('')
  const [view, setView] = useState('all')
  const [d, setD] = useState(null)
  const [lines, setLines] = useState(null)
  const act = useAct()
  const qs = (before) => new URLSearchParams({ q, origin, ...(view === 'removed' ? { removed: '1' } : {}), ...(view === 'system' ? { kind: 'system' } : {}), ...(before ? { before } : {}) }).toString()
  const load = () => api.get(`/api/admin/chat?${qs()}`).then((x) => { setD(x); setLines(x.lines) }).catch(() => setLines([]))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLines(null); load() }, [q, origin, view])
  const more = async () => { const x = await api.get(`/api/admin/chat?${qs(d.next)}`); setD(x); setLines((l) => [...l, ...x.lines]) }
  const flip = async (l) => {
    const to = l.removed ? 'restore' : 'remove'
    if (await act(() => api.post(`/api/admin/chat/${l.id}/${to}`), l.removed ? 'Restored' : 'Removed')) setLines((ls) => ls.map((x) => (x.id === l.id ? { ...x, removed: !l.removed } : x)))
  }
  return (
    <Panel title="Chat" sub="The global channel: the site and every game.">
      <Chips value={view} onChange={setView} options={[['all', 'All'], ['removed', 'Removed'], ['system', 'System lines']]} />
      <div className="adm-toolbar">
        <Search value={q} onChange={setQ} placeholder="Text, name or SteamID64" />
        <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
          <option value="">Everywhere</option>
          {((d && d.origins) || []).map((o) => <option key={o.origin || 'x'} value={o.origin || ''}>{o.origin || '—'} ({o.c})</option>)}
        </select>
      </div>
      {!lines ? <Empty>Loading…</Empty> : lines.length === 0 ? <Empty>No lines.</Empty> : (
        <div className="adm-chat">
          {lines.map((l) => (
            <div key={l.id} className={`adm-chatline ${l.removed ? 'removed' : ''} ${l.kind === 'system' ? 'system' : ''}`}>
              <span className="faint" title={stamp(l.at)}>{when(l.at)}</span>
              <span className="adm-chat-origin">[{l.origin === 'web' ? 'web' : (l.map || l.origin || 'net')}]</span>
              <span className="adm-chat-from">{l.steam_id ? <button type="button" className="linkish" onClick={() => openUser(l.steam_id)}>{l.from}</button> : l.from}</span>
              <span className="adm-chat-text">{l.text}</span>
              <button type="button" className="btn small ghost" onClick={() => flip(l)}>{l.removed ? 'Restore' : 'Remove'}</button>
            </div>
          ))}
        </div>
      )}
      {d && d.more && <div className="adm-pager"><button type="button" className="btn small ghost" onClick={more}>Load older</button></div>}
    </Panel>
  )
}
