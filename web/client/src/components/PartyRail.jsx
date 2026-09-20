import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useSession } from '../session'
import { onChat } from '../socket'
import { Avatar } from './Bits'

// The party rail — Movement's, with "mode" now meaning Verified / Custom (05).
//
// The corner IS the selected map + Play (13 §2): the map's art, your party, and the big
// Play / Join button. Pick a different map anywhere on the site and this updates, because
// picking a map is a party action, not a page action.
//
// The ready check is B's flow verbatim (13 §4b): leader presses Start → everyone gets a
// Ready prompt → when all are ready the server boots. If somebody is not ready, THE LEADER
// DECIDES — "Start anyway" is a button, not a timeout.

export default function PartyRail() {
  const { signedIn, me, approved, refresh } = useSession()
  const [party, setParty] = useState(null)
  const [launch, setLaunch] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [chat, setChat] = useState([])
  const [text, setText] = useState('')
  const lines = useRef(null)

  const load = useCallback(async () => {
    if (!signedIn) return
    try {
      const j = await api.get('/api/party')
      setParty(j.party)
      setLaunch(j.launch)
    } catch { /* signed out mid-poll */ }
  }, [signedIn])

  useEffect(() => { load() }, [load])
  // Poll rather than push: the party changes when somebody else clicks Ready, and a 3-second
  // poll of one small row is cheaper to get right than a per-party socket room.
  useEffect(() => {
    if (!signedIn) return undefined
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [signedIn, load])

  useEffect(() => { api.get('/api/chat').then((j) => setChat(j.chat)).catch(() => {}) }, [])
  useEffect(() => onChat((line) => setChat((c) => [...c.slice(-120), line])), [])
  useEffect(() => { if (lines.current) lines.current.scrollTop = lines.current.scrollHeight }, [chat])

  const act = async (path, body) => {
    setBusy(true); setErr(null)
    try { await api.post(path, body || {}); await load(); refresh() } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const send = async (e) => {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    setText('')
    try { await api.post('/api/chat', { text: t }) } catch (e2) { setErr(e2.message) }
  }

  if (!signedIn) {
    return (
      <aside className="prail">
        <div className="top">
          <div className="art">Sign in to pick a map and play with friends.</div>
          <p className="tiny">The whole site is browsable without an account. Playing needs one.</p>
        </div>
        <ChatPanel chat={chat} lines={lines} disabled />
      </aside>
    )
  }

  return (
    <aside className="prail">
      <div className="top">
        <div className="art">
          {party && party.map
            ? <div><b>{party.map.title}</b><div className="tiny">{party.map.key}</div></div>
            : <span>No map selected — pick one from <Link to="/maps">Maps</Link>.</span>}
        </div>

        {!party && (
          <button className="btn accent" style={{ width: '100%' }} disabled={busy || !approved} onClick={() => act('/api/party/create')}>
            {approved ? 'Start a party' : 'Your account is on the waiting list'}
          </button>
        )}

        {party && (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <Mode party={party} onSet={(m) => act('/api/party/mode', { mode: m })} />
              <Vis party={party} onSet={(v) => act('/api/party/visibility', { visibility: v })} />
            </div>

            {launch && launch.state === 'ready' && launch.connect ? (
              <div className="card" style={{ padding: 10, marginBottom: 8 }}>
                <div className="eyebrow" style={{ margin: 0 }}>Ready</div>
                <div className="tiny">Launch World at War and connect to</div>
                <code>{launch.connect}</code>
                {/* The token is the player's own and is never shown to anybody else: the
                    launcher reads it from this same endpoint and passes it in userinfo. */}
                <div className="tiny" style={{ marginTop: 6 }}>Your invite token is held for the launcher.</div>
              </div>
            ) : null}

            {party.state === 'forming' && (
              <button className="btn primary big" style={{ width: '100%' }} disabled={busy || !party.map || !party.is_leader}
                onClick={() => act('/api/party/ready-check')}>
                {party.map ? 'Start' : 'Pick a map first'}
              </button>
            )}

            {party.state === 'ready-check' && (
              <div className="stack">
                {!party.members.find((m) => m.steam_id === me.steam_id && m.ready) && (
                  <button className="btn accent big" style={{ width: '100%' }} disabled={busy} onClick={() => act('/api/party/ready', { ready: true })}>
                    Ready
                  </button>
                )}
                {party.is_leader && (
                  <>
                    <button className="btn primary" style={{ width: '100%' }} disabled={busy || !party.all_ready}
                      onClick={() => act('/api/party/launch')}>
                      {party.all_ready ? 'Everyone ready — go' : 'Waiting for the others'}
                    </button>
                    {!party.all_ready && (
                      <button className="btn ghost small" style={{ width: '100%' }} disabled={busy}
                        onClick={() => act('/api/party/launch', { force: true })}>
                        Start anyway — the rest can late-join and earn nothing from it
                      </button>
                    )}
                    <button className="btn ghost small" style={{ width: '100%' }} disabled={busy} onClick={() => act('/api/party/cancel')}>Cancel</button>
                  </>
                )}
              </div>
            )}

            {(party.state === 'launching' || party.state === 'in-game') && (
              <div className="card" style={{ padding: 10 }}>
                <div className="eyebrow" style={{ margin: 0 }}>{party.state === 'launching' ? 'Reserving server' : 'In game'}</div>
                <div className="tiny">{launch && launch.match_id}</div>
              </div>
            )}

            {err && <p className="tiny hot" style={{ marginTop: 8 }}>{err}</p>}
          </>
        )}
      </div>

      {party && (
        <div className="members">
          <div className="eyebrow">Party {party.code}</div>
          {party.members.map((m) => (
            <div className="member" key={m.steam_id}>
              <span className={`dot ${m.ready ? 'ready' : ''}`} />
              <Avatar user={m} />
              <span style={{ flex: 1 }}>{m.name}</span>
              {m.steam_id === party.leader && <span className="tiny">leader</span>}
            </div>
          ))}
          <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => act('/api/party/leave')}>Leave</button>
        </div>
      )}

      <ChatPanel chat={chat} lines={lines} text={text} setText={setText} send={send} />
    </aside>
  )
}

function ChatPanel({ chat, lines, text, setText, send, disabled }) {
  return (
    <div className="chat">
      <div className="eyebrow" style={{ padding: '10px 14px 0', margin: 0 }}>Global</div>
      <div className="lines" ref={lines}>
        {chat.length === 0 && <div className="tiny">Nobody has said anything yet.</div>}
        {chat.map((l) => (
          <div className="line" key={l.id}>
            <b>{l.from}</b>{l.map ? <span className="tiny"> ({l.map.replace('nazi_zombie_', '')})</span> : null}: {l.text}
          </div>
        ))}
      </div>
      {!disabled && (
        <form onSubmit={send}>
          <input type="text" value={text} placeholder="Say something" onChange={(e) => setText(e.target.value)} maxLength={300} />
          <button className="btn small" type="submit">Send</button>
        </form>
      )}
    </div>
  )
}

function Mode({ party, onSet }) {
  return (
    <div className="row" style={{ gap: 4 }}>
      {['verified', 'custom'].map((m) => (
        <button key={m} className={`btn small ${party.mode === m ? 'on' : 'ghost'}`} disabled={!party.is_leader} onClick={() => onSet(m)}>
          {m === 'verified' ? 'Verified' : 'Custom'}
        </button>
      ))}
    </div>
  )
}

function Vis({ party, onSet }) {
  return (
    <select value={party.visibility} disabled={!party.is_leader} onChange={(e) => onSet(e.target.value)} style={{ width: 'auto', marginLeft: 'auto' }}>
      <option value="private">Private</option>
      <option value="friends">Friends</option>
      <option value="public">Public</option>
    </select>
  )
}
