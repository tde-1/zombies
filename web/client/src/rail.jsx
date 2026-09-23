import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from './api'
import { useSession } from './session'
import { socket } from './socket'
import { usePlayGate } from './components/playGate'
import InviteToasts from './components/InviteToasts'

// THE RAIL'S STATE — Movement's `party.jsx`, with zombies' nouns.
//
// One provider above the router, because the rail it feeds sits above the router too (B,
// 2026-09-22: "the leftmost stuck thing"), and so does every page that stages a map into it.
// It holds four things:
//
//   the party     `/api/party`, polled. A party is a ROW here (lib/parties.js) rather than
//                 Movement's client-side squad, so the server is the truth the moment one
//                 exists and the rail only ever draws what the server said.
//   the stage     what you have picked BEFORE a party exists: map, Verified/Custom and who
//                 may join. Movement keeps this in localStorage and so do we — it is one
//                 viewer's intention, and a party is made from it the moment it is needed
//                 (Play, or the first invite), carrying all three across.
//   the roster    `/api/party/online` — who is about, worked out for THIS reader on the
//                 server (lib/roster.js), including whether their lobby is joinable.
//   the pool      the map list, once, for the card's art. Home reads
//                 it from here rather than fetching the same list a second time.
//
// Every action that would put somebody into a GAME — Play, Ready, Go, Join a
// lobby, Accept an invite — goes through the play gate (components/playGate.js) exactly as
// the old party panel's did: in a plain browser it goes to /download carrying the party or
// the map, inside the launcher it carries on. Arranging a party (staging a map, the two
// toggles, inviting, leaving) is not gated, because none of it needs the game.

const Ctx = createContext(null)
const STAGE_KEY = 'zm.rail.stage'
const MODES = ['verified', 'custom']
const VISIBILITY = ['private', 'friends', 'public']

function readStage() {
  try {
    const s = JSON.parse(window.localStorage.getItem(STAGE_KEY) || 'null') || {}
    return {
      map_key: typeof s.map_key === 'string' ? s.map_key : null,
      mode: MODES.includes(s.mode) ? s.mode : 'verified',
      visibility: VISIBILITY.includes(s.visibility) ? s.visibility : 'friends',
    }
  } catch { return { map_key: null, mode: 'verified', visibility: 'friends' } }
}

export function RailProvider({ children }) {
  const { me, signedIn, approved, refresh } = useSession()
  const { guard } = usePlayGate()
  const [party, setParty] = useState(null)
  const [launch, setLaunch] = useState(null)
  // Set when this player crashed out of a game that is still up (lib/seats.js): the server
  // card offers Resume for the site's ten-minute window.
  const [resumable, setResumable] = useState(null)
  const [invites, setInvites] = useState([])
  const [online, setOnline] = useState({ scope: 'online', players: [] })
  const [stage, setStageState] = useState(readStage)
  const [pool, setPool] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [live, setLive] = useState(null)     // download progress pushed over the socket
  const errTimer = useRef(null)

  const say = useCallback((msg) => {
    setErr(msg || null)
    clearTimeout(errTimer.current)
    if (msg) errTimer.current = setTimeout(() => setErr(null), 6000)
  }, [])

  // THE RED LINE IS ONLY EVER AN ANSWER TO A CLICK (B, 2026-09-22 late: "get rid of that
  // error message if it says that for no reason"). `say` is called from `run` and from
  // stageMap, and both are only reached from a button. It used to outlive the page it was
  // said on for six seconds, so a refusal from the map page sat under the card of the next
  // page as if that page had caused it; it is cleared on every navigation now.
  const loc = useLocation()
  useEffect(() => { say(null) }, [loc.pathname, say])

  const setStage = useCallback((patch) => {
    setStageState((s) => {
      const next = { ...s, ...patch }
      try { window.localStorage.setItem(STAGE_KEY, JSON.stringify(next)) } catch { /* this tab only */ }
      return next
    })
  }, [])

  // ── loads ────────────────────────────────────────────────────────────────
  useEffect(() => {
    api.get('/api/maps?sort=popular').then((j) => setPool(j.maps || [])).catch(() => setPool([]))
  }, [signedIn])

  const loadParty = useCallback(async () => {
    if (!signedIn) { setParty(null); setLaunch(null); setResumable(null); setInvites([]); return null }
    try {
      const j = await api.get('/api/party')
      setParty(j.party); setLaunch(j.launch); setResumable(j.resume || null); setInvites(j.invites || [])
      return j.party
    } catch { return null }
  }, [signedIn])

  const loadOnline = useCallback(async () => {
    if (!signedIn) { setOnline({ scope: 'online', players: [] }); return }
    try { setOnline(await api.get('/api/party/online')) } catch { /* keep the last list */ }
  }, [signedIn])

  useEffect(() => { loadParty(); loadOnline() }, [loadParty, loadOnline])
  useEffect(() => {
    if (!signedIn) return undefined
    // Poll rather than push, the old panel's reasoning: the party changes when somebody else
    // clicks Ready, and a three-second poll of one small row is cheaper to get right than a
    // per-party room. The online list moves slower and is polled slower.
    const a = setInterval(loadParty, 3000)
    const b = setInterval(loadOnline, 10000)
    return () => { clearInterval(a); clearInterval(b) }
  }, [signedIn, loadParty, loadOnline])

  // PUSH on top of the poll: Movement's party.jsx listens for these three and refreshes at
  // once, so an invite, an accept or a decline shows in the rail without waiting for the
  // next tick. The toasts (components/InviteToasts.jsx) listen to the same events.
  useEffect(() => {
    if (!signedIn) return undefined
    const on = () => { loadParty(); loadOnline() }
    const evs = ['party_updated', 'invite_received', 'invite_withdrawn']
    for (const e of evs) socket.on(e, on)
    return () => { for (const e of evs) socket.off(e, on) }
  }, [signedIn, loadParty, loadOnline])

  useEffect(() => {
    if (!party) { setLive(null); return undefined }
    const on = (msg) => { if (msg && msg.party_id === party.id) setLive(msg.progress || {}) }
    socket.on('party-progress', on)
    return () => socket.off('party-progress', on)
  }, [party && party.id])

  const poolByKey = useMemo(() => {
    const m = new Map()
    for (const x of pool || []) m.set(x.key, x)
    return m
  }, [pool])

  // ── what the card shows ─────────────────────────────────────────────────
  // With a party, the party's values; without one, the stage. `canEdit` is who may move
  // them: the leader of a party still forming, or anybody with no party at all.
  const editable = !party || (party.is_leader && party.state === 'forming')
  const mapKey = party ? (party.map && party.map.key) : stage.map_key
  const map = party
    ? (party.map ? { ...(poolByKey.get(party.map.key) || {}), ...party.map } : null)
    : (stage.map_key ? poolByKey.get(stage.map_key) || null : null)
  const mode = party ? party.mode : stage.mode
  const visibility = party ? party.visibility : stage.visibility

  // ── actions ─────────────────────────────────────────────────────────────
  const run = useCallback(async (fn) => {
    setBusy(true); say(null)
    try { const out = await fn(); await loadParty(); return out }
    catch (e) { say(e.message); return null }
    finally { setBusy(false) }
  }, [loadParty, say])

  const stageMap = useCallback(async (key) => {
    if (!key) return
    if (!party) { setStage({ map_key: key }); return }
    if (!editable) {
      say(!party.is_leader ? 'The leader picks the map'
        : (party.state === 'ready-check' ? 'Cancel the ready check to change the map' : 'End the game to change the map'))
      return
    }
    if (party.map && party.map.key === key) return
    await run(() => api.post('/api/party/map', { map_key: key }))
  }, [party, editable, setStage, run, say])

  const setMode = useCallback((v) => {
    if (!party) { setStage({ mode: v }); return }
    if (!party.is_leader) return
    run(() => api.post('/api/party/mode', { mode: v }))
  }, [party, setStage, run])

  const setVisibility = useCallback((v) => {
    if (!party) { setStage({ visibility: v }); return }
    if (!party.is_leader) return
    run(() => api.post('/api/party/visibility', { visibility: v }))
  }, [party, setStage, run])

  const invite = useCallback(async (target) => {
    const body = { ...target, stage: { map_key: stage.map_key, mode: stage.mode, visibility: stage.visibility } }
    const out = await run(() => api.post('/api/party/invite', body))
    if (out) loadOnline()
    return out
  }, [stage, run, loadOnline])

  const cancelInvite = useCallback((id) => run(() => api.post(`/api/party/invites/${id}/cancel`)), [run])
  const kick = useCallback((sid) => run(() => api.post('/api/party/kick', { steam_id: sid })), [run])
  const leave = useCallback(() => run(async () => { await api.post('/api/party/leave'); refresh() }), [run, refresh])

  const decline = useCallback((id) => run(() => api.post(`/api/party/invites/${id}/decline`)), [run])
  // Accepting an invite and joining somebody's lobby are both "going to play with them", so
  // both take the gate — B's own list says accepting an invite is one of the gated actions.
  const joinParty = useCallback((partyId) => {
    if (guard({ party: partyId, then: '/' })) return null
    return run(async () => { await api.post('/api/party/join', { party_id: partyId }); loadOnline() })
  }, [guard, run, loadOnline])
  // Movement's accept: by the INVITE, so an expired or withdrawn one says so by name.
  const acceptInvite = useCallback((inviteId, partyId) => {
    if (guard({ party: partyId, then: '/' })) return null
    return run(async () => { await api.post(`/api/party/invites/${inviteId}/accept`); loadOnline(); return true })
  }, [guard, run, loadOnline])
  // The invite link (lib/parties.js link): made from the stage if there is no party yet.
  const shareLink = useCallback(async () => {
    const body = { stage: { map_key: stage.map_key, mode: stage.mode, visibility: stage.visibility } }
    const out = await run(() => api.post('/api/party/link', body))
    return out && out.code ? `${window.location.origin}${out.path}` : null
  }, [stage, run])
  const joinByLink = useCallback((code) => {
    // In a browser: /download, whose "Open in launcher" is enw-zombies://party/<code>.
    if (guard({ party: code, then: `/party/${code}` })) return null
    return run(async () => { await api.post(`/api/party/link/${encodeURIComponent(code)}/join`); loadOnline(); return true })
  }, [guard, run, loadOnline])

  // PLAY. The one primary action on the card, and the flow underneath is the party's
  // (13 §4b), unchanged: a ready check, then the launch. What the rail adds is that you do
  // not have to make a party first — Play makes one from the stage — and that a party of one
  // does not stop at a ready check nobody else is in: its leader is ready by pressing Play,
  // so it goes straight on to the launch.
  //
  // `mapKey` lets a map page's own Play say which map — Movement's map page "Spin up" is the
  // rail's launch with that page's map staged first, and so is ours.
  //
  // A map no box will run (`on_server: false`, lib/serverNotes.js) is never sent: its Play is
  // disabled with the reason on hover, so the server's refusal is not the way anybody learns.
  // And a party of one whose launch is refused goes back to Play rather than sitting in a
  // ready check with nobody else in it.
  const play = useCallback(async ({ mapKey: want = null } = {}) => {
    const key = want || mapKey
    if (!key) return
    const m = poolByKey.get(key) || (party && party.map && party.map.key === key ? party.map : null)
    if (m && m.on_server === false) return
    if (guard({ party: party && party.id, map: key, then: '/' })) return
    await run(async () => {
      if (!party) {
        await api.post('/api/party/create', { mode: stage.mode, visibility: stage.visibility, mapKey: key })
        setStage({ map_key: key })
      } else if (!party.map || party.map.key !== key) {
        if (!party.is_leader) throw new Error('The leader picks the map')
        if (party.state !== 'forming') throw new Error(party.state === 'ready-check' ? 'Cancel the ready check to change the map' : 'End the game to change the map')
        await api.post('/api/party/map', { map_key: key })
      }
      const r = await api.post('/api/party/ready-check', {})
      if (r && r.party && r.party.all_ready) {
        try { await api.post('/api/party/launch') } catch (e) {
          if (r.party.members.length === 1) { try { await api.post('/api/party/cancel') } catch { /* keep the error that matters */ } }
          throw e
        }
      }
    })
  }, [mapKey, poolByKey, party, stage, setStage, guard, run])

  const ready = useCallback(() => {
    if (guard({ party: party && party.id, map: mapKey, then: '/' })) return
    run(() => api.post('/api/party/ready', { ready: true }))
  }, [guard, party, mapKey, run])

  const go = useCallback(() => {
    if (guard({ party: party && party.id, map: mapKey, then: '/' })) return
    run(() => api.post('/api/party/launch', {}))
  }, [guard, party, mapKey, run])

  const cancel = useCallback(() => run(() => api.post('/api/party/cancel')), [run])

  // Back into the game this player crashed out of. The site hands out a fresh token and
  // puts the phase back to `in-game`; the launcher's party watcher does the launch once
  // `window.enw.resumeMatch` has lifted its once-per-match gate for it.
  const resume = useCallback(() => run(async () => {
    const id = resumable && resumable.match_id
    await api.post('/api/party/resume', { match_id: id })
    // Inside the launcher: its follow gate launches each match once (followgate.js), so
    // tell it this second launch of the same match is the player's own ask.
    try { if (window.enw && window.enw.resumeMatch) await window.enw.resumeMatch(id) } catch { /* outside the launcher */ }
    await loadParty()
  }), [run, resumable, loadParty])

  // End a game this player is not in (crashed out, or left it running): the server is
  // cancelled and the party goes back to forming, so the leader can pick again.
  const endGame = useCallback(() => run(async () => {
    const id = (resumable && resumable.match_id) || (party && party.match_id)
    await api.post('/api/party/quit', { match_id: id })
    await loadParty()
  }), [run, resumable, party, loadParty])

  // The server card's ×: close the party's game for everybody and KEEP the party (B
  // 2026-09-23: "should close the server, not leave the party"). lib/seats.js `end`.
  const closeServer = useCallback(() => run(async () => {
    const id = (resumable && resumable.match_id) || (party && party.match_id)
    await api.post('/api/party/end', { match_id: id })
    await loadParty()
  }), [run, resumable, party, loadParty])

  const value = useMemo(() => ({
    me, signedIn, approved, endGame, closeServer,
    party, launch, invites, online, pool, poolByKey, live,
    stage, map, mapKey, mode, visibility, editable,
    busy, err, say,
    stageMap, setMode, setVisibility, invite, cancelInvite, kick, leave,
    decline, joinParty, acceptInvite, shareLink, joinByLink, play, ready, go, cancel, resumable, resume,
    refreshParty: loadParty, refreshOnline: loadOnline,
  }), [me, signedIn, approved, party, launch, invites, online, pool, poolByKey, live, stage, map, mapKey,
    mode, visibility, editable, busy, err, say, stageMap, setMode, setVisibility, invite, cancelInvite, kick,
    leave, decline, joinParty, acceptInvite, shareLink, joinByLink, play, ready, go, cancel, resumable, resume,
    endGame, closeServer, loadParty, loadOnline])

  // The invite toasts and the /party/<code> card sit here, above the router with the rail's
  // state, so they show on every page including the replay viewer (which hides the rail).
  return <Ctx.Provider value={value}>{children}<InviteToasts R={value} /></Ctx.Provider>
}

export const useRail = () => useContext(Ctx)
