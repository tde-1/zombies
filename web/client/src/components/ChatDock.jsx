import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { socket, onChat } from '../socket'
import { mergeLines, lastId } from '../chatLines'
import { useSession } from '../session'

// ── Cross-server chat, on every page ──────────────────────────────────────────
//
// One global channel across every ENW Zombies game — the ring in
// `server/lib/chatNetwork.js` that the boxes already drain over
// `/api/gs/chat-feed`. A line typed here reaches every live game; a line typed in
// a game reaches here. The system lines ("<handle> just went down on round 30 on
// Verrückt") are in the same channel and come from `server/lib/chatSystem.js`.
//
// ── Why a dock and not a page ─────────────────────────────────────────────────
//
// `web.md` §10i and §11j have had the same open item since the party rail came off:
// the chat is real and has no page. A PAGE was the wrong answer to it. Chat is the
// thing you keep half an eye on while doing something else, and a page is the one
// place you cannot be while you are browsing maps. So it is a dock, above the
// router (it survives navigation, which is what the rail actually bought), pinned
// to the bottom-right corner and **collapsed by default** — the launcher wraps this
// site and B had just approved a map browser with no third region in it, so the
// resting state of this has to be a tab, not a column.
//
// ── Ported, not approximated ──────────────────────────────────────────────────
//
// The console itself is Movement's `movement-client/src/components/admin/
// ChatConsole.jsx` — the opaque black log, the `csc-*` line grammar, the caret
// input that sends on Enter, the character count, and the scroll rule that pins to
// the bottom ONLY while the reader is already there. Its own comment is the reason
// and it is still true here: being yanked back down mid-read is the worst thing a
// live transcript can do. What changed on the way over is the game's nouns: no
// team colours (there are no sides in zombies), no `*DEAD*` marker, no per-mode
// channel chips (there is one room), and the map tag is the zombies map.
//
// ── What is deliberately NOT here ─────────────────────────────────────────────
//
// No per-map rooms. One global channel is what tonight asked for and what the ring holds.
//
// ── Party chat and DMs (lane SOC, 2026-09-23) ─────────────────────────────────
//
// The launcher now flashes and chimes on a DM or a party line (attention.js), so the site
// has to be able to show one and answer it. They are the in-game overlay's private ring
// (server lib/gameChat.js, `chat_private`), not a second system: `/api/chat/private` for
// the backlog and sending, `chat-private` on the socket for live lines. Drawn in the same
// log, tagged [party] / [dm], and a separate id space (their own table), so they are
// merged separately and interleaved by time. Who you are talking to is the chip row over
// the input: All games / Party / a DM, which clicking a name on a private line picks.

const CAP = 200          // lines kept in the browser; the server ring keeps 500
const MAX = 200          // matches chatNetwork.MAX_LEN's spirit; the server caps at 300

const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')

/** A private line (party or DM): the same grammar, a tag saying which. */
function PrivateLine({ e, me, onPick }) {
  const mine = me && String(e.steamid) === String(me)
  const tag = e.channel === 'dm' ? (mine ? `dm → ${e.to_name || 'them'}` : 'dm') : 'party'
  const other = mine ? (e.channel === 'dm' ? { sid: e.to, name: e.to_name } : null) : { sid: e.steamid, name: e.from }
  return (
    <div className={'csc-line is-private is-' + e.channel}>
      <span className="csc-time">{clock(e.at)}</span>
      <span className="csc-tag">[{tag}]</span>
      {other && other.sid && onPick
        ? <button type="button" className="csc-name csc-pick" title={`Message ${other.name || 'them'}`}
                  onClick={() => onPick({ channel: 'dm', to: String(other.sid), name: other.name })}>{e.from || 'unknown'}</button>
        : <span className="csc-name">{e.from || 'unknown'}</span>}
      <span className="csc-sep">:</span>
      <span className="csc-msg">{e.text}</span>
    </div>
  )
}

/** One line. Two kinds: something a person typed, and a sentence the site composed. */
export function ChatLine({ e }) {
  if (e.kind === 'system') {
    return (
      <div className="csc-line is-note">
        <span className="csc-time">{clock(e.at)}</span>
        <span className="csc-note">{e.text}</span>
      </div>
    )
  }
  return (
    <div className="csc-line">
      <span className="csc-time">{clock(e.at)}</span>
      {/* Movement's plugin prints `[net]` for a line that belongs to no map, and a
          line typed on the website is exactly that case. Printing the same thing
          rather than a blank is what keeps the site and the game one conversation. */}
      <span className="csc-tag">[{e.map || 'net'}]</span>
      <span className="csc-name">{e.from || 'unknown'}</span>
      <span className="csc-sep">:</span>
      <span className="csc-msg">{e.text}</span>
    </div>
  )
}

export default function ChatDock() {
  const { signedIn, me } = useSession()
  const meId = me ? me.steam_id : null
  // `#chat` on any URL opens the dock. It is the closest thing to the PAGE that
  // `web.md` §10i has been asking for and a better answer than one: a link somebody
  // pastes lands them on a real page of the site with the conversation open beside it,
  // rather than on a page that is only the conversation.
  const [open, setOpen] = useState(() => {
    try {
      if (window.location.hash === '#chat') return true
      return localStorage.getItem('zm.chat.open') === '1'
    } catch { return window.location.hash === '#chat' }
  })
  const [lines, setLines] = useState([])
  const [text, setText] = useState('')
  const [state, setState] = useState('loading')   // loading | ready | offline
  const [unread, setUnread] = useState(0)
  const [busy, setBusy] = useState(false)
  const [priv, setPriv] = useState([])                     // party + DM lines (chat_private)
  const [target, setTarget] = useState({ channel: 'global' })
  const [sayErr, setSayErr] = useState(null)

  const logRef = useRef(null)
  const pinned = useRef(true)
  const openRef = useRef(open)
  openRef.current = open
  // The ids on screen, for the unread count and the catch-up cursor. Kept in step with
  // `lines` by the merge itself, so it is never a second truth that can drift.
  const held = useRef([])

  // EVERY source goes through one merge keyed on the ring's id (chatLines.js): the
  // backlog, the socket, and the catch-up after a reconnect. The old fill RESET the list,
  // so a live line that landed before the backlog answered was dropped, and a reconnect
  // never caught up at all (web.md, 2026-09-23 chat dedupe).
  const append = useCallback((incoming, { live = false } = {}) => {
    const have = new Set(held.current.map((l) => Number(l.id)))
    const fresh = (incoming || []).filter((e) => e && e.id != null && !have.has(Number(e.id)))
    if (!fresh.length) return
    held.current = mergeLines(held.current, fresh, CAP)
    setLines(held.current)
    if (live && !openRef.current) setUnread((n) => Math.min(99, n + fresh.length))
  }, [])

  // The fill. The ring is on the server and the socket only carries what happens
  // NEXT, so a dock opened mid-conversation has to ask for the backlog once.
  useEffect(() => {
    let dead = false
    api.get('/api/chat?limit=60')
      .then((d) => { if (dead) return; append(d.chat || []); setState('ready') })
      .catch(() => { if (!dead) setState('offline') })
    return () => { dead = true }
  }, [append])

  // Live. The same socket event the boxes' lines land on — `chatNetwork.setEmitter`
  // in `server/index.js` — so a line from a game and a line from a browser arrive by
  // one path and cannot get out of order with each other.
  useEffect(() => onChat((line) => append([line], { live: true })), [append])

  // A reconnect (the site restarting, the launcher's reload, a laptop waking) asks only
  // for what it missed: `?since=` the newest id held. The merge drops anything the socket
  // also delivers.
  useEffect(() => {
    const onConnect = () => {
      const since = lastId(held.current)
      if (!since) return
      api.get(`/api/chat?since=${since}&limit=200`).then((d) => append(d.chat || [], { live: true })).catch(() => {})
    }
    socket.on('connect', onConnect)
    return () => socket.off('connect', onConnect)
  }, [append])

  // Party lines and DMs: the backlog once signed in, then live; a reconnect refetches the tail.
  const appendPriv = useCallback((incoming, { live = false } = {}) => {
    const fresh = (incoming || []).filter((l) => l && (l.channel === 'party' || l.channel === 'dm'))
    if (!fresh.length) return
    setPriv((prev) => mergeLines(prev, fresh, CAP))
    if (live && !openRef.current) {
      const others = fresh.filter((l) => String(l.steamid) !== String(meId))
      if (others.length) setUnread((n) => Math.min(99, n + others.length))
    }
  }, [meId])
  useEffect(() => {
    if (!signedIn) { setPriv([]); return undefined }
    const fill = () => api.get('/api/chat/private').then((d) => appendPriv(d.lines || [])).catch(() => {})
    fill()
    const onLine = (l) => appendPriv([l], { live: true })
    socket.on('chat-private', onLine)
    socket.on('connect', fill)
    return () => { socket.off('chat-private', onLine); socket.off('connect', fill) }
  }, [signedIn, appendPriv])

  const shown = priv.length
    ? [...lines.map((l) => ({ k: `g${l.id}`, at: l.at || 0, l })), ...priv.map((l) => ({ k: `p${l.id}`, at: l.at || 0, l, p: true }))]
        .sort((a, b) => a.at - b.at)
    : null

  // Pin to the bottom only while the reader is already there (Movement's rule).
  const onScroll = () => {
    const el = logRef.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }
  useEffect(() => {
    const el = logRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [lines, priv, open])

  useEffect(() => {
    try { localStorage.setItem('zm.chat.open', open ? '1' : '0') } catch { /* private window */ }
    if (open) setUnread(0)
  }, [open])

  const send = (ev) => {
    ev.preventDefault()
    const t = text.trim()
    if (!t || busy || !signedIn) return
    setBusy(true)
    setSayErr(null)
    if (target.channel !== 'global') {
      // Party / DM: the POST, whose line comes back on `chat-private` like everybody's.
      api.post('/api/chat/private', { channel: target.channel, to: target.to || null, text: t })
        .then(() => setText(''))
        .catch((e) => setSayErr(e.message || 'Not sent'))
        .finally(() => setBusy(false))
      return
    }
    // Over the socket, not the POST route: the server pushes the line back to every
    // browser including this one, so echoing it here would draw it twice.
    try { socket.emit('chat', t); setText('') } finally { setBusy(false) }
  }

  return (
    <div className={'chatdock' + (open ? ' is-open' : '')}>
      <button className="chatdock-tab" onClick={() => setOpen((o) => !o)}
              aria-expanded={open} aria-controls="chatdock-body">
        <span className="chatdock-tab-label">Chat</span>
        {!open && unread > 0 && <span className="chatdock-unread">{unread}</span>}
        <span className="chatdock-chev" aria-hidden="true">{open ? '▾' : '▴'}</span>
      </button>

      {open && (
        <div className="chatdock-body" id="chatdock-body">
          <div className="csc">
            <div className="csc-log" ref={logRef} onScroll={onScroll}>
              {shown
                ? shown.map((x) => (x.p ? <PrivateLine e={x.l} key={x.k} me={meId} onPick={setTarget} /> : <ChatLine e={x.l} key={x.k} />))
                : lines.length
                ? lines.map((l) => <ChatLine e={l} key={l.id} />)
                : <div className="csc-empty">
                    {state === 'loading' ? 'Loading…' : state === 'offline' ? 'Chat is offline.' : 'Nothing said yet.'}
                  </div>}
            </div>
            {signedIn && (
              <div className="csc-to" role="group" aria-label="Send to">
                <button type="button" className={'csc-to-chip' + (target.channel === 'global' ? ' on' : '')} onClick={() => setTarget({ channel: 'global' })}>All games</button>
                <button type="button" className={'csc-to-chip' + (target.channel === 'party' ? ' on' : '')} onClick={() => setTarget({ channel: 'party' })}>Party</button>
                {target.channel === 'dm' && (
                  <button type="button" className="csc-to-chip on" title="Back to all games" onClick={() => setTarget({ channel: 'global' })}>@{target.name || 'player'} ×</button>
                )}
                {sayErr && <span className="csc-to-err" role="status">{sayErr}</span>}
              </div>
            )}
            {signedIn ? (
              <form className="csc-say" onSubmit={send}>
                <span className="csc-say-caret" aria-hidden="true">&gt;</span>
                {/* Enter sends, EXPLICITLY. A form with a submit button submits on Enter
                    by itself and this one did not: home binds the keyboard for the map
                    rows (`MapRow.jsx`) and the dock floats over every page, so a key
                    pressed in here is a key some other component is also listening for.
                    Measured against the live bundle before it was written this way —
                    Send worked, Enter silently did nothing, which is the failure a chat
                    box must never have. `stopPropagation` is the other half: a line you
                    just sent must not also page the map list behind the panel. */}
                <input type="text" value={text} maxLength={MAX} disabled={busy}
                       placeholder={target.channel === 'party' ? 'Message your party' : target.channel === 'dm' ? `Message ${target.name || 'them'}` : 'Message every game'}
                       onChange={(e) => setText(e.target.value)}
                       onKeyDown={(e) => {
                         e.stopPropagation()
                         if (e.key === 'Enter') { e.preventDefault(); send(e) }
                       }} />
                <span className="csc-say-count tnum">{MAX - text.length}</span>
                <button className="btn btn-sm btn-accent" type="submit" disabled={busy || !text.trim()}>Send</button>
              </form>
            ) : (
              <div className="csc-say-hint">Sign in to chat.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
