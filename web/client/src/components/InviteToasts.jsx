import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { socket } from '../socket'
import { prettyTitle } from '../data/mapText'
import './invites.css'

// Invite toasts and the invite-link card — Movement's party notifications, ported.
//
//   invite_received    a card, top right: who, which map, Accept / Decline, time left.
//                      (GOnext's InvitesOverlay + Movement's rail `Invites` card; the rail
//                      keeps its own card too, so a toast that times out loses nothing.)
//   invite_withdrawn   the card goes, and a line says why (Movement's PARTY_NOTICE).
//   party_updated      with a `notice`: one line — "<name> declined." and the rest.
//   /party/<CODE>      the invite link (lib/parties.js link): one card, Join / Not now.
//   /party/<id>        enw-zombies://party/<id> from the launcher: if an invite to that
//                      party is waiting, the same card accepts it.
//
// Rendered by the rail's provider (rail.jsx), above the router, so it is on every page.
// Takes the rail's value as a prop rather than calling useRail(): rail.jsx imports this.

const NOTICE = {
  declined: (n) => `${n} declined.`,
  left: (n) => `${n} left the party.`,
  closed: (n) => `${n} closed the party.`,
  withdrawn: (n) => `${n} withdrew the invite.`,
  removed: (n) => `${n} was removed from the party.`,
  kicked: (n) => `${n} removed you from the party.`,
  joined: (n) => `${n} joined the party.`,
}
const INVITE_MS = 30_000     // a toast; the rail card stays until the invite does
const NOTE_MS = 5_000
const LINK = /^\/party\/([A-Za-z2-9]{8})\/?$/
const PARTY_ID = /^\/party\/(\d+)\/?$/

const nameOf = (u) => (u && (u.name || u.enw_name || u.username)) || 'someone'
const left = (at) => {
  const m = Math.max(0, Math.round((Number(at) - Date.now()) / 60000))
  return m < 1 ? 'under a minute' : `${m}m left`
}

function Av({ user }) {
  const [bad, setBad] = useState(false)
  return (
    <span className="avatar invt-av">
      {user && user.avatar && !bad
        ? <img src={user.avatar} alt="" onError={() => setBad(true)} />
        : nameOf(user).slice(0, 1).toUpperCase()}
    </span>
  )
}

export default function InviteToasts({ R }) {
  const [toasts, setToasts] = useState([])
  const [, tick] = useState(0)
  const seq = useRef(0)
  const signedIn = !!(R && R.signedIn)

  const drop = useCallback((key) => setToasts((t) => t.filter((x) => x.key !== key)), [])
  const note = useCallback((text) => {
    const key = `n${++seq.current}`
    setToasts((t) => [...t, { key, kind: 'note', text }].slice(-4))
    setTimeout(() => drop(key), NOTE_MS)
  }, [drop])

  useEffect(() => {
    if (!signedIn) { setToasts([]); return undefined }
    const onInvite = (p) => {
      const inv = p && p.invite
      if (!inv || !inv.id) return
      const key = `i${inv.id}`
      setToasts((t) => (t.some((x) => x.key === key) ? t : [...t, { key, kind: 'invite', invite: inv }].slice(-4)))
      setTimeout(() => drop(key), INVITE_MS)
    }
    const onWithdrawn = (p) => {
      if (!p) return
      drop(`i${p.invite_id}`)
      const n = p.notice
      if (n && NOTICE[n.kind]) note(NOTICE[n.kind](n.username || 'someone'))
    }
    const onParty = (p) => {
      const n = p && p.notice
      if (n && n.username && NOTICE[n.kind]) note(NOTICE[n.kind](n.username))
    }
    socket.on('invite_received', onInvite)
    socket.on('invite_withdrawn', onWithdrawn)
    socket.on('party_updated', onParty)
    return () => {
      socket.off('invite_received', onInvite)
      socket.off('invite_withdrawn', onWithdrawn)
      socket.off('party_updated', onParty)
    }
  }, [signedIn, drop, note])

  // A card whose invite is no longer pending (accepted from the rail, expired, gone) goes.
  const pendingIds = (R && R.invites ? R.invites : []).map((i) => i.id).join(',')
  useEffect(() => {
    const live = new Set(pendingIds.split(',').filter(Boolean).map(Number))
    setToasts((t) => t.filter((x) => x.kind !== 'invite' || live.has(Number(x.invite.id))))
  }, [pendingIds])

  // Time left on an invite card is minutes; a half-minute redraw is plenty.
  useEffect(() => {
    if (!toasts.some((t) => t.kind === 'invite')) return undefined
    const id = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [toasts])

  const accept = async (inv) => {
    const ok = await R.acceptInvite(inv.id, inv.party_id)
    if (ok) note(`Joined ${nameOf(inv.from)}'s party.`)
    drop(`i${inv.id}`)
  }
  const decline = async (inv) => { await R.decline(inv.id); drop(`i${inv.id}`) }

  return (
    <>
      {toasts.length > 0 && (
        <div className="invt-stack" role="status" aria-live="polite">
          {toasts.map((t) => (t.kind === 'note'
            ? <div className="invt invt-note" key={t.key}>{t.text}</div>
            : (
              <div className="invt invt-invite" key={t.key}>
                <div className="invt-who">
                  <Av user={t.invite.from} />
                  <div className="invt-txt">
                    <div className="invt-name">{nameOf(t.invite.from)} invited you</div>
                    <div className="invt-sub">
                      {t.invite.map_title ? prettyTitle(t.invite.map_title, t.invite.map_key) : 'No map yet'}
                      {t.invite.size ? ` · ${t.invite.size}/4` : ''}
                      {t.invite.expires_at ? ` · ${left(t.invite.expires_at)}` : ''}
                    </div>
                  </div>
                  <button className="invt-x" aria-label="Hide" title="Hide" onClick={() => drop(t.key)}>×</button>
                </div>
                <div className="invt-acts">
                  <button className="btn btn-sm btn-accent" disabled={R.busy} onClick={() => accept(t.invite)}>Accept</button>
                  <button className="btn btn-sm" disabled={R.busy} onClick={() => decline(t.invite)}>Decline</button>
                </div>
              </div>
            )))}
        </div>
      )}
      <PartyLanding R={R} onNote={note} />
    </>
  )
}

// ── /party/<CODE> and /party/<id> ───────────────────────────────────────────
function PartyLanding({ R, onNote }) {
  const loc = useLocation()
  const nav = useNavigate()
  const [card, setCard] = useState(null)       // { kind:'link', code, party } | { kind:'invite', invite }
  const [err, setErr] = useState(null)
  const [gone, setGone] = useState(null)       // the path dismissed
  const linkCode = (LINK.exec(loc.pathname) || [])[1] || null
  const partyId = (PARTY_ID.exec(loc.pathname) || [])[1] || null
  const signedIn = !!(R && R.signedIn)

  useEffect(() => {
    setErr(null)
    if (gone === loc.pathname) { setCard(null); return undefined }
    if (linkCode && signedIn) {
      let dead = false
      api.get(`/api/party/link/${encodeURIComponent(linkCode)}`)
        .then((d) => {
          if (dead) return
          if (d.party && d.party.mine) { setCard(null); nav('/', { replace: true }); return }
          setCard({ kind: 'link', code: linkCode.toUpperCase(), party: d.party })
        })
        .catch((e) => { if (!dead) { setCard({ kind: 'dead' }); setErr(e.message) } })
      return () => { dead = true }
    }
    if (linkCode && !signedIn) { setCard({ kind: 'signin' }); return undefined }
    if (partyId && signedIn) {
      const inv = (R.invites || []).find((i) => String(i.party_id) === String(partyId))
      setCard(inv ? { kind: 'invite', invite: inv } : null)
      return undefined
    }
    setCard(null)
    return undefined
  }, [linkCode, partyId, signedIn, gone, loc.pathname, R && R.invites, nav])

  if (!card) return null
  const close = () => { setGone(loc.pathname); nav('/', { replace: true }) }
  const join = async () => {
    const ok = card.kind === 'link' ? await R.joinByLink(card.code) : await R.acceptInvite(card.invite.id, card.invite.party_id)
    if (ok) {
      onNote(`Joined ${nameOf(card.kind === 'link' ? card.party.leader : card.invite.from)}'s party.`)
      setGone(loc.pathname)
      nav('/', { replace: true })
    }
  }
  const p = card.party
  const from = card.kind === 'link' ? p && p.leader : card.invite && card.invite.from
  const map = card.kind === 'link' ? p && p.map : card.invite && card.invite.map_title ? { key: card.invite.map_key, title: card.invite.map_title } : null
  return (
    <div className="invl-scrim" onClick={close}>
      <div className="invl" role="dialog" aria-label="Party invite" onClick={(e) => e.stopPropagation()}>
        {card.kind === 'signin' && <><div className="invl-title">Sign in to join this party.</div>
          <div className="invl-acts"><a className="btn btn-accent" href="/auth/steam">Sign in</a><button className="btn" onClick={close}>Not now</button></div></>}
        {card.kind === 'dead' && <><div className="invl-title">That invite link is dead.</div>
          <div className="invl-sub">{err || 'The party ended or changed its link.'}</div>
          <div className="invl-acts"><button className="btn" onClick={close}>OK</button></div></>}
        {(card.kind === 'link' || card.kind === 'invite') && (
          <>
            <div className="invt-who">
              <Av user={from} />
              <div className="invt-txt">
                <div className="invl-title">{nameOf(from)}&rsquo;s party</div>
                <div className="invl-sub">
                  {map ? prettyTitle(map.title, map.key) : 'No map yet'}
                  {card.kind === 'link' ? ` · ${p.size}/4` : ''}
                  {card.kind === 'invite' && card.invite.expires_at ? ` · ${left(card.invite.expires_at)}` : ''}
                </div>
              </div>
            </div>
            {R.err && <div className="invl-err">{R.err}</div>}
            <div className="invl-acts">
              <button className="btn btn-accent" disabled={R.busy || (p && p.full) || !R.approved} onClick={join}>
                {p && p.full ? 'Full' : !R.approved ? 'Approval required' : 'Join'}
              </button>
              <button className="btn" onClick={close}>Not now</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
