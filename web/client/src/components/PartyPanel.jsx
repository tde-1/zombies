import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useSession } from '../session'
import { socket } from '../socket'
import { Avatar } from './Bits'
import { usePlayGate } from './playGate'

// The party, at the top of the left column on home. Movement's PartyPanel, with the things
// zombies has that Movement does not: the map DOWNLOAD per member, and Verified/Custom
// where Movement has a game mode.
//
// It replaced the party rail (`components/PartyRail.jsx`, deleted). The rail was a third
// region of the page that survived navigation, which is right on Movement — where the rail
// is the only place the party lives — and wrong here, where B put the party and the map
// pool in the same column and made home the page you play from. What the rail carried that
// this does not is the global chat panel; that is noted in `docs/kickstart/web.md` as
// needing a home rather than quietly dropped.
//
// The flow underneath is unchanged (13 §4b, `lib/parties.js`): the leader picks the map and
// presses Start, everybody gets a Ready prompt, and when all are ready the server boots. If
// somebody is not ready, THE LEADER DECIDES. The download gate is one more thing that can
// make Start wait, and it has the same override for the same reason.

export default function PartyPanel({ party, launch, onChange, selected }) {
  const { me, approved, refresh } = useSession()
  const { guard } = usePlayGate()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // Progress arrives two ways and both are needed: in the party payload on every poll (so a
  // page opened mid-download is right immediately) and over the socket (so a bar moves
  // between polls). The socket copy is held here and merged over the payload's.
  const [live, setLive] = useState(null)

  useEffect(() => {
    if (!party) { setLive(null); return undefined }
    const on = (msg) => { if (msg && msg.party_id === party.id) setLive(msg.progress || {}) }
    socket.on('party-progress', on)
    return () => socket.off('party-progress', on)
  }, [party && party.id])

  const act = useCallback(async (path, body) => {
    setBusy(true); setErr(null)
    try { await api.post(path, body || {}); await onChange(); refresh() }
    catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }, [onChange, refresh])

  // THE PLAY GATE (B, 2026-09-22). The actions that put somebody into a game — Start, Ready,
  // Go, and both "Start anyway" overrides — cannot do that from a browser tab, so in one they
  // go to /download carrying the party instead. The actions that only ARRANGE a party — make
  // one, set the mode, invite, leave — are unchanged: they work perfectly well from a phone
  // on the bus, and gating them would be telling somebody to install an app to press Leave.
  const play = useCallback(async (path, body) => {
    if (guard({ party: party && party.id, map: party && party.map && party.map.key, then: '/' })) return
    await act(path, body)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guard, party, act])


  if (!party) {
    return (
      <section className="ppanel">
        <div className="section-label" style={{ marginBottom: 8 }}>Party</div>
        <button className="btn accent" style={{ width: '100%' }} disabled={busy || !approved}
                onClick={() => act('/api/party/create')}>
          {approved ? 'Start a party' : 'On the waiting list'}
        </button>
        {!approved && <p className="tiny" style={{ marginTop: 8, marginBottom: 0 }}>Browsing does not need approval. Playing does.</p>}
        {err && <p className="tiny hot" style={{ marginTop: 8, marginBottom: 0 }}>{err}</p>}
      </section>
    )
  }

  const meRow = party.members.find((m) => m.steam_id === (me && me.steam_id))
  const canStart = !!party.map && party.is_leader && party.installs_ok
  const waitingOn = party.installs_pending || []

  return (
    <section className="ppanel">
      <div className="spread">
        <span className="section-label">Party</span>
        <span className="pcode">{party.code}</span>
      </div>

      <div style={{ marginBottom: 10 }}>
        {party.members.map((m) => (
          <div className="pmember" key={m.steam_id}>
            <Avatar user={m} size="sm" />
            <div className="who">
              <b>{m.name}{m.steam_id === party.leader ? ' ·' : ''}</b>
              <Download p={(live && live[m.steam_id]) || m.progress} />
            </div>
            <span className={`dot ${m.ready ? 'ready' : ''}`} title={m.ready ? 'ready' : 'not ready'} />
          </div>
        ))}
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
        <Mode party={party} onSet={(v) => act('/api/party/mode', { mode: v })} />
        <Vis party={party} onSet={(v) => act('/api/party/visibility', { visibility: v })} />
      </div>

      {party.state === 'forming' && (
        <>
          <button className="btn primary big" style={{ width: '100%' }}
                  disabled={busy || !party.map || !party.is_leader || !party.installs_ok}
                  onClick={() => play('/api/party/ready-check')}>
            {!party.map ? 'Pick a map' : !party.is_leader ? 'The leader starts' : canStart ? 'Start' : 'Waiting for the map'}
          </button>
          {/* The override, and only when there is something to override. "Start anyway" on a
              party where nobody is downloading would be a second Start button. */}
          {party.is_leader && waitingOn.length > 0 && (
            <button className="btn ghost small" style={{ width: '100%', marginTop: 6 }} disabled={busy}
                    title="They will have to finish the download before they can join"
                    onClick={() => play('/api/party/ready-check', { force: true })}>
              Start anyway
            </button>
          )}
        </>
      )}

      {party.state === 'ready-check' && (
        <div className="stack">
          {meRow && !meRow.ready && (
            <button className="btn accent big" style={{ width: '100%' }} disabled={busy}
                    onClick={() => play('/api/party/ready', { ready: true })}>Ready</button>
          )}
          {party.is_leader && (
            <>
              <button className="btn primary" style={{ width: '100%' }} disabled={busy || !party.all_ready}
                      onClick={() => play('/api/party/launch')}>
                {party.all_ready ? 'Go' : 'Waiting for the others'}
              </button>
              {!party.all_ready && (
                <button className="btn ghost small" style={{ width: '100%' }} disabled={busy}
                        title="Late joiners earn nothing from this game"
                        onClick={() => play('/api/party/launch', { force: true })}>Start anyway</button>
              )}
              <button className="btn ghost small" style={{ width: '100%' }} disabled={busy}
                      onClick={() => act('/api/party/cancel')}>Cancel</button>
            </>
          )}
        </div>
      )}

      {(party.state === 'launching' || party.state === 'in-game') && (
        <div className="card" style={{ padding: 10 }}>
          <div className="section-label">{party.state === 'launching' ? 'Reserving server' : 'In game'}</div>
          {launch && launch.connect
            ? <code className="tiny">{launch.connect}</code>
            : <div className="tiny">{launch && launch.match_id}</div>}
        </div>
      )}

      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <Invite party={party} onError={setErr} />
        <button className="btn small ghost" disabled={busy} onClick={() => act('/api/party/leave')}>Leave</button>
      </div>

      {/* The staged map, restated only when it is NOT the one the page is showing. On home
          the map page beside this panel is already the answer, and repeating its name here
          is the kind of clutter B asked to be rid of. */}
      {party.map && selected !== party.map.key && (
        <p className="tiny" style={{ margin: '8px 0 0' }}>Staged: {party.map.title}</p>
      )}
      {err && <p className="tiny hot" style={{ margin: '8px 0 0' }}>{err}</p>}
    </section>
  )
}

// One member's copy of the map. Nothing is drawn for a member whose launcher has never
// said anything: an empty bar is a claim that a download has started and stalled, which is
// a different and much more alarming thing than no news.
function Download({ p }) {
  if (!p) return null
  if (p.state === 'installed') return <span className="dlstate installed">have the map</span>
  if (p.state === 'failed') return (
    <>
      <span className="dlstate failed">{p.error || 'install failed'}</span>
      <div className="dlbar failed"><i style={{ width: '100%' }} /></div>
    </>
  )
  const pct = p.pct == null ? null : p.pct
  return (
    <>
      <span className="dlstate">{pct == null ? 'downloading' : `downloading ${pct}%`}</span>
      <div className="dlbar"><i style={{ width: `${pct == null ? 6 : pct}%` }} /></div>
    </>
  )
}

// Invite by SteamID. Movement invites out of a friends list; this site does not have one
// worth drawing yet (`lib/enw.js` is the seam and it is stubbed), so it asks for the id and
// says so, rather than showing an empty friends list that looks broken.
function Invite({ party, onError }) {
  const [open, setOpen] = useState(false)
  const [sid, setSid] = useState('')
  const send = async () => {
    const id = sid.trim()
    if (!/^\d{17}$/.test(id)) { onError('that is not a SteamID64'); return }
    try { await api.post('/api/party/invite', { steam_id: id }); setSid(''); setOpen(false) }
    catch (e) { onError(e.message) }
  }
  if (party.full) return <span className="tiny">Lobby full</span>
  if (!open) return <button className="btn small ghost" onClick={() => setOpen(true)}>Invite</button>
  return (
    <span className="row" style={{ gap: 5, flex: 1 }}>
      <input type="text" value={sid} placeholder="SteamID64" onChange={(e) => setSid(e.target.value)} />
      <button className="btn small" onClick={send}>Send</button>
    </span>
  )
}

function Mode({ party, onSet }) {
  return (
    <div className="seg">
      {[['verified', 'Verified'], ['custom', 'Custom']].map(([k, label]) => (
        <button key={k} className={party.mode === k ? 'on' : ''} disabled={!party.is_leader}
                onClick={() => onSet(k)}>{label}</button>
      ))}
    </div>
  )
}

function Vis({ party, onSet }) {
  return (
    <select value={party.visibility} disabled={!party.is_leader} style={{ width: 'auto', marginLeft: 'auto' }}
            onChange={(e) => onSet(e.target.value)}>
      <option value="private">Private</option>
      <option value="friends">Friends</option>
      <option value="public">Public</option>
    </select>
  )
}
