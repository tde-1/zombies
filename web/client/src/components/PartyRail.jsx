import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useRail } from '../rail'
import { useSession } from '../session'
import { prettyTitle, mapHue } from '../data/mapText'
import { NotPlayable } from './Bits'
import EnwWord from './Enw'
import { DlBar, CardDownload } from './MapDownload'

// ── The party rail ─────────────────────────────────────────────────────────
//
// A PORT of Movement's `movement-client/src/components/PartyRail.jsx` (B, 2026-09-22: "the
// leftmost stuck thing that has all online players, your current party, and your map in the
// bottom left with the Play button ... just like ENW Movement"). The structure, the class
// names and the reasoning are Movement's; what changed on the way over is listed here once
// rather than scattered through the file:
//
//   * NO GAME + MODE BAR at the top. Movement's first card is the CS:GO / CS:Source and
//     surf / bhop / KZ picker (GameModePicker.jsx). Zombies is one game, and its only "mode"
//     is Verified / Custom, which is a lobby option and sits where Movement's Global/Local
//     chat segment sits, directly over the server card. So the rail opens on the party.
//   * THE SERVER CARD OPENS THE MAP'S PAGE, Movement's flow exactly (B, 2026-09-22 late:
//     "when you click the map on the bottom left it should take you to the map page, and
//     there should be a back button that takes you back to the map list"). Picking a map
//     from home's list or /maps stages it on the card. ~~The card opened a map picker sheet
//     (MapPicker.jsx)~~ — deleted, with its CSS, the "Change map" chip and the picker's foot.
//   * PLAY is the party flow (lib/parties.js): a ready check, then the launch, through the
//     play gate. The launcher connects you, so the card carries no connect address
//     (~~Movement's copy field~~, removed 2026-09-22 late) and no "Start anyway": the leader
//     removes a member who is holding the party up with the × on their row.
//   * THE ONLINE ROWS JOIN A LOBBY rather than copying a server address: a Zombies lobby is
//     a party that has not launched yet, so "join" is joining the party.
//   * No collapsed mini rail. Below 1080px the rail stacks above the page instead.

export default function PartyRail() {
  const R = useRail()
  if (!R) return null
  return (
    <aside className="prail">
      <div className="prail-body">
        {!R.signedIn ? (
          <div className="rblock">
            <div className="rlabel">Your party</div>
            <div className="rail-signin">Sign in to build a party.</div>
          </div>
        ) : (
          <Roster R={R} />
        )}
        {R.signedIn && R.invites.length > 0 && <Invites R={R} />}
        {R.signedIn && <OnlineBlock R={R} />}
      </div>

      <div className="prail-foot">
        {R.signedIn && (
          <div className="prail-lobbyopts">
            <ModeSeg R={R} />
            <Visibility R={R} />
          </div>
        )}
        <ServerCard R={R} />
        {R.err && <div className="prail-err" role="status">{R.err}</div>}
      </div>
    </aside>
  )
}

const nameOf = (u) => (u && (u.name || u.enw_name || u.username)) || 'someone'
const profilePath = (u) => `/id/${encodeURIComponent((u && (u.enw_name || u.name)) || (u && u.steam_id) || '')}`

// Movement's Avatar: the Steam picture, or the initial when there is none or it fails.
function Avatar({ user, extra = '' }) {
  const [failed, setFailed] = useState(false)
  const url = user && user.avatar
  return (
    <span className={'avatar ' + extra}>
      {url && !failed
        ? <img className="pcard-img" src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : String(nameOf(user)).slice(0, 1).toUpperCase()}
    </span>
  )
}

// ── roster — you, your party, and who has been asked ─────────────────────
function Roster({ R }) {
  const [showAll, setShowAll] = useState(false)
  const CAP = 5
  const p = R.party
  const leader = p ? p.leader : R.me && R.me.steam_id
  const progressOf = (sid, m) => (R.live && R.live[sid]) || (m && m.progress) || null

  const rows = p
    ? [
        ...p.members.map((m) => ({
          id: m.steam_id, user: m, host: m.steam_id === leader,
          role: roleOf(m, p, progressOf(m.steam_id, m)),
          onRemove: p.is_leader && m.steam_id !== leader ? () => R.kick(m.steam_id) : null,
        })),
        ...(p.invited || []).map((u) => ({
          id: 'inv-' + u.invite_id, user: u, role: 'invited',
          onRemove: () => R.cancelInvite(u.invite_id), removeLabel: 'Cancel invite',
        })),
      ]
    : [{ id: 'me', user: R.me, host: true, role: 'host' }]

  const shown = showAll ? rows : rows.slice(0, CAP)
  const hidden = rows.length - shown.length
  return (
    <div className="rblock">
      <div className="rlabel">
        <span>{p && p.members.length > 1 ? 'Party' : 'Your party'} · {p ? p.members.length : 1}</span>
        <span className="rlabel-acts">
          {(!p || !p.full) && R.approved && <CopyInviteLink R={R} />}
          {/* Leaving the party lives here, in the party block (B 2026-09-23), not on the card. */}
          {p && p.members.length > 1 && (
            <button className="rlabel-code rlabel-leave" disabled={R.busy} title="Leave party"
                    onClick={() => { if (window.confirm('Leave this party?')) R.leave() }}>Leave</button>
          )}
        </span>
      </div>
      {shown.map((r) => (
        <PlayerCard key={r.id} user={r.user} role={r.role} host={r.host} onRemove={r.onRemove} removeLabel={r.removeLabel} />
      ))}
      {hidden > 0 && <button className="roster-more" onClick={() => setShowAll(true)}>+ {hidden} more</button>}
      {showAll && rows.length > CAP && <button className="roster-more" onClick={() => setShowAll(false)}>show fewer</button>}
      {(!p || !p.full) && R.approved && <InviteBox R={R} />}
    </div>
  )
}

// A member's second line. The download wins while there is one, because it is the thing
// that decides whether Play can go; then the ready state during a ready check; then the role.
function roleOf(m, p, prog) {
  if (prog && prog.state === 'failed') return 'download failed'
  // ~~`downloading ${pct}%` as text~~ — launcher 0.2.12: an object, drawn as bar + % by PlayerCard.
  if (prog && prog.state === 'downloading') return { downloading: true, pct: prog.pct == null ? null : prog.pct }
  if (p.state === 'ready-check') return m.ready ? 'ready' : 'not ready'
  if (prog && prog.state === 'installed') return m.steam_id === p.leader ? 'host · has the map' : 'has the map'
  return m.steam_id === p.leader ? 'host' : 'in party'
}

function PlayerCard({ user, role, host, onRemove, removeLabel }) {
  const name = nameOf(user)
  // 0.2.11 (B: "a bar ... before the percentage"): a download draws the bar, then the %.
  const dl = typeof role === 'object' && role && role.downloading
  return (
    <div className={'pcard' + (host ? ' host' : '')}>
      <Link to={profilePath(user)} className="pcard-link" title={`View ${name}'s profile`}>
        <span className="pcard-av">
          <Avatar user={user} />
          <span className="pdot on" />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pname">{name}</div>
          <div className="prole">{dl ? <DlBar pct={role.pct} className="in-row" /> : role}</div>
        </div>
      </Link>
      {onRemove && (
        <button className="pcard-x" title={removeLabel || "Kick"}
                aria-label={removeLabel || `Kick ${name}`} onClick={onRemove}>×</button>
      )}
    </div>
  )
}

// ── invite autocomplete — by ENW name ─────────────────────────────────────
// Movement's InviteBox: a plus that grows its word on hover, then a search. Debounced and
// guarded, so an earlier prefix's results cannot land last. Enter on a typed name invites
// that exact ENW name, which is the "invite friends using their ENW username" half of B's
// ask; the list under it is the same search Movement runs, friends and the online first.
function InviteBox({ R }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState(null)
  const inputRef = useRef(null)
  useEffect(() => { if (open && inputRef.current) inputRef.current.focus() }, [open])

  const term = q.trim()
  useEffect(() => {
    if (term.length < 2) { setResults(null); return undefined }
    let alive = true
    const t = setTimeout(() => {
      api.get('/api/party/invite-search?q=' + encodeURIComponent(term))
        .then((d) => { if (alive) setResults(d.results || []) })
        .catch(() => { if (alive) setResults([]) })
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [term])

  const close = () => { setOpen(false); setQ(''); setResults(null) }
  const pick = async (target) => {
    const out = await R.invite(target)
    if (out) close()
  }

  const held = new Set([
    ...((R.party && R.party.members) || []).map((m) => m.steam_id),
    ...((R.party && R.party.invited) || []).map((m) => m.steam_id),
  ])
  const list = (results || []).filter((u) => !held.has(u.steam_id))

  if (!open) return (
    <button className="pcard-add" onClick={() => setOpen(true)} aria-label="Invite a player to your party">
      <span className="plus" aria-hidden="true">＋</span>
      <span className="pcard-add-word" aria-hidden="true">Invite</span>
    </button>
  )
  return (
    <div className="invite">
      <div className="invite-head">
        <input ref={inputRef} value={q} placeholder="ENW name…" aria-label="Invite by ENW name"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') close()
            if (e.key === 'Enter' && term) pick({ username: term })
          }} />
        <button className="invite-close" title="Close search" aria-label="Close search" onClick={close}>×</button>
      </div>
      <div className="invite-list">
        {results == null && <div className="sug-empty">Type an <EnwWord /> name</div>}
        {results != null && list.length === 0 && <div className="sug-empty">No players found.</div>}
        {list.map((u) => (
          <div className="sug" key={u.steam_id} role="button" tabIndex={0}
               onClick={() => pick({ steam_id: u.steam_id })}
               onKeyDown={(e) => { if (e.key === 'Enter') pick({ steam_id: u.steam_id }) }}>
            <Avatar user={u} extra="sug-av" />
            <span className="sug-name">{nameOf(u)}</span>
            <span className={'sug-st' + (u.online ? ' on' : '')}>{u.friend ? 'friend' : u.online ? 'online' : 'offline'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── the invite link ───────────────────────────────────────────────────────
// Copies `<site>/party/<CODE>` (lib/parties.js link). Whoever opens it gets one card with
// Join (components/InviteToasts.jsx); in the launcher, enw-zombies://party/<CODE> does the
// same. Sits where the party code used to, which nothing could use.
function CopyInviteLink({ R }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return undefined
    const t = setTimeout(() => setDone(false), 1600)
    return () => clearTimeout(t)
  }, [done])
  const copy = async () => {
    const url = await R.shareLink()
    if (!url) return
    try { await navigator.clipboard.writeText(url); setDone(true) } catch { window.prompt('Copy the invite link', url) }
  }
  return (
    <button className="rlabel-code" style={{ cursor: 'pointer', background: 'none', border: 0, padding: 0, font: 'inherit' }}
            disabled={R.busy} onClick={copy} title="Copy an invite link to this party">
      {done ? 'Copied' : 'Copy link'}
    </button>
  )
}

// ── invites waiting on you ────────────────────────────────────────────────
function Invites({ R }) {
  return (
    <div className="rblock">
      <div className="rlabel">Invites · {R.invites.length}</div>
      {R.invites.map((i) => (
        <div className="invite-card" key={i.id}>
          <div className="invite-who">
            <Avatar user={i.from} extra="sug-av" />
            <div style={{ minWidth: 0 }}>
              <div className="pname">{nameOf(i.from)}</div>
              <div className="prole">{MODE_WORD[i.mode] || 'Verified'} · {i.map_title ? prettyTitle(i.map_title, i.map_key) : 'no map yet'}</div>
            </div>
          </div>
          <div className="invite-acts">
            <button className="btn small accent" disabled={R.busy} onClick={() => R.acceptInvite(i.id, i.party_id)}>Accept</button>
            <button className="btn small" disabled={R.busy} onClick={() => R.decline(i.id)}>Decline</button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── the online block ──────────────────────────────────────────────────────
// Movement's FriendsBlock. The heading comes off the server's scope, never a guess: an
// approved account sees everybody online and it says Online; anybody else sees their friends
// and it says Friends (lib/roster.js has the reason).
function OnlineBlock({ R }) {
  const rows = R.online.players || []
  const everyone = R.online.scope === 'online'
  return (
    <div className="rblock">
      <div className="rlabel"><span>{everyone ? 'Online' : 'Friends'} · {rows.length}</span></div>
      {rows.length === 0 && (
        <div className="friends-empty">{everyone ? 'Nobody else online.' : 'No friends online.'}</div>
      )}
      {rows.map((f) => <FriendRow key={f.steam_id} R={R} f={f} />)}
    </div>
  )
}

const VIS_WORD = { friends: 'Friends only', public: 'Public', private: 'Invite only' }
const MODE_WORD = { verified: 'Verified', custom: 'Custom' }

function FriendRow({ R, f }) {
  const lobby = f.lobby
  const game = f.game
  const at = lobby || game
  const art = at && at.art
  const mapName = at && at.map_key ? prettyTitle(at.map_title, at.map_key) : null
  const sub = game
    ? `in game · ${mapName || 'a map'}`
    : lobby
      ? `${MODE_WORD[lobby.mode] || 'Verified'} · ${mapName || 'picking a map'}`
      : 'online'
  const vis = lobby ? VIS_WORD[lobby.visibility] || null : null
  const name = nameOf(f)

  let act
  if (lobby && lobby.invited && lobby.invite_id) {
    act = <button className="fcard-btn accent" disabled={R.busy} onClick={() => R.joinParty(lobby.party_id)}>Accept</button>
  } else if (lobby && lobby.joinable) {
    act = <button className="fcard-btn" disabled={R.busy} title={`Join ${name}'s party`} onClick={() => R.joinParty(lobby.party_id)}>Join</button>
  } else if (f.held) {
    act = <span className="fcard-tag">{f.held === 'member' ? 'in party' : 'invited'}</span>
  } else if (game) {
    act = <span className="fcard-tag">in game</span>
  } else if (R.approved) {
    act = (
      <button className="fcard-ico" disabled={R.busy} title={`Invite ${name} to your party`}
              aria-label={`Invite ${name} to your party`} onClick={() => R.invite({ steam_id: f.steam_id })}>
        <span aria-hidden="true">＋</span>
      </button>
    )
  } else {
    act = null
  }

  return (
    <div className={'fcard' + (art ? ' has-map' : '')}
         style={art ? { '--h': String(mapHue(at.map_key)), backgroundImage: `url(${art})` } : undefined}>
      <Link to={profilePath(f)} className="fcard-link" title={`View ${name}'s profile`}>
        <span className="fcard-av-wrap">
          <Avatar user={f} extra="fcard-av" />
          <span className="pdot on" />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="fcard-name">
            <span className="pname">{name}</span>
            {vis ? <span className="fcard-vis">· {vis}</span> : null}
          </div>
          <div className="prole fcard-sub">{sub}</div>
        </div>
      </Link>
      <div className="fcard-act">{act}</div>
    </div>
  )
}

// ── the two lobby options, grouped tight above the card ──────────────────
// Movement's ChatScope + Visibility pair: the same pill segment twice, one unit. The top
// one is Verified / Custom here (Movement's is Global / Local chat). Only the leader of a
// party can move them; everyone else sees where they stand (`.locked`).
function ModeSeg({ R }) {
  const can = !R.party || R.party.is_leader
  return (
    <div className="prail-chatscope">
      <div className={'vis-seg' + (can ? '' : ' locked')}>
        {[['verified', 'Verified'], ['custom', 'Custom']].map(([k, label]) => (
          <button key={k} className={'vis-btn' + (R.mode === k ? ' on' : '')} disabled={!can || R.busy}
                  title={can ? (k === 'verified' ? 'Records and XP count' : 'Nothing counts') : 'Leader only'}
                  onClick={() => can && R.mode !== k && R.setMode(k)}>{label}</button>
        ))}
      </div>
    </div>
  )
}

// B's three words, in B's order — Movement draws the same three values as Friends /
// Invite-only / Public; the values the API takes are unchanged.
const VIS = [
  { key: 'private', label: 'Private' },
  { key: 'friends', label: 'Friends' },
  { key: 'public', label: 'Public' },
]
function Visibility({ R }) {
  const can = !R.party || R.party.is_leader
  return (
    <div className="prail-visibility">
      <div className={'vis-seg' + (can ? '' : ' locked')}>
        {VIS.map((v) => (
          <button key={v.key} className={'vis-btn' + (R.visibility === v.key ? ' on' : '')} disabled={!can || R.busy}
                  title={can ? undefined : 'Leader only'}
                  onClick={() => can && R.visibility !== v.key && R.setVisibility(v.key)}>{v.label}</button>
        ))}
      </div>
    </div>
  )
}

// ── the persistent server card ────────────────────────────────────────────
// Movement's Footer, to the letter in its layers: the map's art, the veil, a full-card
// click target UNDER a pointer-transparent copy layer, then the name, the mode line and the
// one primary action. The click target opens the map's page (Movement's openMap), and
// carries where you were so the page's back control returns there.
function ServerCard({ R }) {
  const nav = useNavigate()
  const loc = useLocation()

  if (!R.signedIn) {
    return (
      <a className="prail-server-launch as-link" href="/auth/steam">
        Sign in with Steam
      </a>
    )
  }

  const p = R.party
  const map = R.map
  const title = map ? prettyTitle(map.title, map.key) : null
  const leaderRow = p ? p.members.find((m) => m.steam_id === p.leader) : null
  const owner = nameOf(leaderRow || R.me)
  const serverName = title ? `${owner}'s ${title}` : `${owner}'s server`
  const state = p ? p.state : 'forming'
  const modeLabel = `${MODE_WORD[R.mode] || 'Verified'} · ${VIS.find((v) => v.key === R.visibility)?.label || 'Friends'}`
  const readyN = p ? p.members.filter((m) => m.ready).length : 0
  const statusLabel = state === 'ready-check'
    ? `${readyN} of ${p.members.length} ready`
    : state === 'launching' ? 'Starting'
      : R.resumable ? 'You left the game · still up'
      : state === 'in-game' ? `In game · ${MODE_WORD[R.mode] || 'Verified'}`
        : modeLabel
  const meRow = p && R.me ? p.members.find((m) => m.steam_id === R.me.steam_id) : null
  const playable = !map || map.on_server !== false

  // Already looking at it? Then the card is just a picture (Movement's mapAlreadyOpen rule:
  // a second click would only push a duplicate history entry).
  const here = loc.pathname
  const target = map ? `/m/${map.key}` : '/maps'
  const canOpen = here !== target
  const openMap = () => { if (canOpen) nav(target, { state: { back: here + loc.search } }) }

  // The primary action, by state. A refusal says why in the label rather than greying a
  // button that says "Play" — Movement's rule (approval first, because it is the outer gate).
  let primary = null
  let secondary = null
  if (!map) {
    primary = null
  } else if (R.resumable) {
    // A crash or Alt+F4 out of a game that is still up (a Quit from the Esc menu never
    // gets here: it cancels the server). Ten minutes, then the server goes.
    const mins = Math.max(1, Math.ceil((R.resumable.until - Date.now()) / 60_000))
    primary = (
      <button className="prail-server-launch" disabled={R.busy} onClick={() => R.resume()}
              title={`Kept for ${mins} more min`}>
        Resume
      </button>
    )
    secondary = (
      <button className="prail-server-launch as-link" disabled={R.busy} onClick={() => R.endGame()}
              title="Cancel the server and pick again">
        End game
      </button>
    )
  } else if (!R.approved) {
    primary = <button className="prail-server-launch" disabled>Approval required</button>
  } else if (!playable && (state === 'forming' || state === 'ready-check')) {
    primary = <button className="prail-server-launch" disabled title={map.server_note || undefined}>Not playable</button>
  } else if (state === 'forming') {
    if (p && !p.is_leader) {
      primary = <button className="prail-server-launch" disabled>Waiting for {owner}</button>
    } else {
      const waiting = p ? (p.installs_pending || []) : []
      primary = (
        <button className="prail-server-launch" disabled={R.busy || waiting.length > 0} onClick={() => R.play()}>
          {R.busy ? 'Starting…' : waiting.length > 0 ? 'Waiting for downloads' : 'Play'}
        </button>
      )
    }
  } else if (state === 'ready-check') {
    if (p.is_leader) {
      primary = (
        <>
          <button className="prail-server-launch" disabled={R.busy || !p.all_ready} onClick={() => R.go()}>
            {p.all_ready ? 'Go' : `Waiting for ${p.members.length - readyN}`}
          </button>
          <button className="prail-sub-btn" disabled={R.busy} onClick={R.cancel}>Cancel</button>
        </>
      )
    } else if (meRow && !meRow.ready) {
      primary = <button className="prail-server-launch" disabled={R.busy} onClick={R.ready}>Ready</button>
    } else {
      primary = <button className="prail-server-launch" disabled>Waiting for {owner}</button>
    }
  }

  const booting = (state === 'launching' || state === 'in-game') && !(R.launch && R.launch.connect)
  return (
    <div className="prail-live">
      <div className={'prail-live-card' + (map ? ' has-map' : ' is-empty')}
           style={map ? { '--h': String(mapHue(map.key)) } : undefined}>
        {map && map.art
          ? <img className="map-banner" src={map.art} alt="" decoding="async" />
          : map
            ? <div className="map-banner-ph"><span>{String(map.key).replace(/^nazi_zombie_/, '')}</span></div>
            : <div className="prail-live-empty" aria-hidden="true" />}
        <div className="prail-live-veil" />
        {canOpen && (
          <button type="button" className="prail-live-open" onClick={openMap}
                  title={map ? serverName : 'Maps'}
                  aria-label={map ? `Open the map page for ${title}` : 'Open the map list'} />
        )}
        <div className="prail-live-copy">
          {map && !playable && <span className="prail-live-np"><NotPlayable map={map} /></span>}
          {/* The × closes the SERVER (B 2026-09-23), for the whole party, and keeps the party.
              Only while there is one, and only for its host. Leave is in the party block. */}
          {p && p.is_leader && (state === 'launching' || state === 'in-game' || R.resumable) && (
            <button className="prail-live-end" disabled={R.busy} title="Close server" aria-label="Close server"
                    onClick={() => { if (window.confirm('Close the server? The game ends for the party.')) R.closeServer() }}>×</button>
          )}
          <div className="prail-live-name" title={serverName}>{map ? serverName : 'Pick a map'}</div>
          <div className="prail-live-mode">{statusLabel}</div>
          {/* Launcher 0.2.12: Download on its own, small, so the map is ready before Play. */}
          {map && playable && (state === 'forming' || state === 'ready-check') && <CardDownload mapKey={map.key} />}
          {booting && (
            <div className="prail-live-booting"><span className="spinner" /> {state === 'launching' ? 'Starting…' : 'Connecting…'}</div>
          )}
          {primary}
          {secondary}
        </div>
      </div>
    </div>
  )
}
