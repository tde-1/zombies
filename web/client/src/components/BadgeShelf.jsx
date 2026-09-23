import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { Hex } from './Bits'

// COPIED FROM MOVEMENT, `movement-client/src/components/BadgeShelf.jsx`, comments and all. What
// changed for zombies, and only this:
//   * a badge with no uploaded art draws our Hex (a map or record badge's art is the map's,
//     and lib/badges.js forPlayer already lets those through without an upload);
//   * the pin write is PUT /api/me/pinned {ids} (server/routes/me.js), not Movement's route;
//   * this site has no toast, so "you can pin three" and a failed write are a plain alert.
//
// The badges a player wears, in two places on the profile.
//
// PINNED badges ride in the identity bar, beside the picture and the name (<BadgePins>), each
// under its own name — those are the ones the player chose to be known for, so they sit in the
// one part of the page everybody reads. Everything else is a shelf of small marks in the rail
// card (<BadgeShelf>), and a badge that is pinned is NOT repeated there: it is worn, not owned-
// and-listed, and drawing it twice was half of what made the block feel like filler.
//
// A badge is ARTWORK (server/lib/badgeArt.js — PNG or WebP, alpha required) and nothing else.
// There is no frame, no plate and no ring around it (owner, 2026-08-05): the art is cut out
// with alpha, so a wash behind it and a hairline around it were chrome the icon never asked
// for. Rarity is DEAD outright (owner, later the same day) — a badge is either given by staff
// or earned as an achievement, and the hover card states which and how it is obtained.
// Nothing here draws a glyph or a letter standing in for a badge either: art-less badges are
// filtered out server-side and never reach this component.
//
// Data comes from GET /api/players/:id → `badges` (all) and `pinned`, which Profile.jsx hands
// over as Movement's envelope { pinned, all, max_pinned }.
// On your OWN profile both registers are the editor: clicking a mark pins or unpins it, and the
// whole list goes up at once (PUT /api/me/pinned) so two tabs can't disagree.

// How many marks the shelf shows before it offers the rest. Not pagination — expanding reveals
// every remaining badge at once and there is no second page, ever.
const SHELF_PREVIEW = 14

// The kind, as a small stated line. Staff badges were decided by a person; achievements were
// earned on the servers. That split is the one fact the card leads with.
const KIND_WORD = { staff: 'Staff badge', achievement: 'Achievement' }

function awardedOn(ms) {
  const d = new Date(Number(ms))
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString()
}

// The whole badge as one line of text. It is the accessible name, so nothing the visible caption
// trims is actually lost to someone reading with a screen reader.
function fullLabel(b) {
  const bits = [b.name]
  if (b.description) bits.push(b.description)
  const on = awardedOn(b.awarded_at)
  if (on) bits.push(`Awarded ${on}`)
  return bits.join(' · ')
}

// The card a badge shows when you point at it (or focus it).
//
// It is rendered into <body> and positioned FIXED against the mark's own rect, which is what
// lets it be a proper floating object: it can't be clipped by the rail, it flips under the mark
// when there is no room above, and it clamps itself inside the viewport instead of hanging off
// the left edge (the old absolutely-positioned card needed a first-child special case for
// exactly that, and still went off-screen for the last mark in a row). It re-places itself on
// scroll because the rail is sticky and the page moves under it.
function HoverCard({ anchor, badge, actionable, pinned }) {
  const cardRef = useRef(null)
  const [pos, setPos] = useState(null)

  const place = useCallback(() => {
    const el = anchor.current
    const card = cardRef.current
    if (!el || !card) return
    const a = el.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    const M = 10
    const left = Math.min(Math.max(M, a.left + a.width / 2 - c.width / 2), window.innerWidth - c.width - M)
    let top = a.top - c.height - 10
    let under = false
    if (top < M) { top = a.bottom + 10; under = true }
    setPos({ left: Math.round(left), top: Math.round(top), under })
  }, [anchor])

  // Before paint, so the card is never seen at 0,0 on its way to where it belongs.
  useLayoutEffect(() => { place() }, [place])
  useEffect(() => {
    const h = () => place()
    window.addEventListener('scroll', h, true)
    window.addEventListener('resize', h)
    return () => { window.removeEventListener('scroll', h, true); window.removeEventListener('resize', h) }
  }, [place])

  const holders = badge.holders != null
    ? `${badge.holders.toLocaleString()} ${badge.holders === 1 ? 'holder' : 'holders'}`
    : null
  const on = awardedOn(badge.awarded_at)

  return createPortal(
    <div
      ref={cardRef}
      className={'badge-card' + (pos ? ' is-placed' : '') + (pos && pos.under ? ' is-under' : '')}
      style={pos ? { left: pos.left + 'px', top: pos.top + 'px' } : undefined}
      role="presentation"
    >
      <div className="badge-card-top">
        <span className="badge-card-art"><BadgeArt badge={badge} size={40} /></span>
        <span className="badge-card-id">
          <span className="badge-card-n">{badge.name}</span>
          <span className={'badge-card-r' + (badge.kind === 'achievement' ? ' is-auto' : ' is-staff')}>
            {KIND_WORD[badge.kind] || KIND_WORD.staff}
          </span>
        </span>
      </div>
      {badge.description && <div className="badge-card-d">{badge.description}</div>}
      {/* how it is obtained — the line that replaced the rarity word, and the reason a visitor
          points at a badge they do not hold. A staff badge with nothing stored says who gives it. */}
      <div className="badge-card-o">
        {(badge.obtain && String(badge.obtain).trim()) || 'Awarded by staff'}
      </div>
      <div className="badge-card-m">
        {on ? `Awarded ${on}` : 'Awarded'}{holders ? ` · ${holders}` : ''}
      </div>
      {actionable && <div className="badge-card-a">{pinned ? 'Click to unpin' : 'Click to pin'}</div>}
    </div>,
    document.body
  )
}

// The art, or our Hex where a badge has none uploaded (map and record badges).
function BadgeArt({ badge, size }) {
  if (badge.art) return <img src={badge.art} alt="" draggable="false" />
  return <span className="hex-fallback"><Hex badge={badge} size={size} gold={badge.kind === 'record'} /></span>
}

// One badge. `size` picks the register — 'lg' is a pinned badge in the header and carries its
// name; 'sm' is a shelf mark. Everything else is identical, including the card.
function Badge({ badge, size, onClick, pinned, actionable }) {
  const markRef = useRef(null)
  const [open, setOpen] = useState(false)
  const Tag = actionable ? 'button' : 'span'
  return (
    <Tag
      ref={markRef}
      type={actionable ? 'button' : undefined}
      className={'badge-mark badge-' + size + (pinned ? ' is-pinned' : '') + (actionable ? ' is-actionable' : '')}
      onClick={actionable ? onClick : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-pressed={actionable ? !!pinned : undefined}
      aria-label={actionable
        ? `${pinned ? 'Unpin' : 'Pin'} ${badge.name}`
        : fullLabel(badge)}
    >
      <span className="badge-art">
        <BadgeArt badge={badge} size={size === 'lg' ? 38 : 28} />
      </span>
      {size === 'lg' && <span className="badge-cap">{badge.name}</span>}
      {open && <HoverCard anchor={markRef} badge={badge} actionable={actionable} pinned={pinned} />}
    </Tag>
  )
}

// The shared half of both registers: the lists, and the one write. Pinning from the header and
// pinning from the shelf are the same operation, so they are the same code — the whole list goes
// up, so the server is never reconciling a diff, and what comes back is what was actually kept.
function usePins(badges, onChanged) {
  const all = useMemo(() => (badges && Array.isArray(badges.all) ? badges.all : []), [badges])
  const pinned = useMemo(() => (badges && Array.isArray(badges.pinned) ? badges.pinned : []), [badges])
  const maxPinned = (badges && badges.max_pinned) || 3
  const pinnedIds = useMemo(() => new Set(pinned.map((b) => b.id)), [pinned])
  const [busy, setBusy] = useState(false)

  const toggle = async (badge) => {
    if (busy) return
    const isPinned = pinnedIds.has(badge.id)
    if (!isPinned && pinned.length >= maxPinned) {
      window.alert(`Max ${maxPinned} pinned.`)
      return
    }
    const next = isPinned
      ? pinned.filter((b) => b.id !== badge.id).map((b) => b.id)
      : [...pinned.map((b) => b.id), badge.id]
    setBusy(true)
    try {
      await api.put('/api/me/pinned', { ids: next })
      onChanged()
    } catch (e) {
      window.alert(e.message)
    } finally {
      setBusy(false)
    }
  }

  return { all, pinned, pinnedIds, maxPinned, busy, toggle }
}

// The pinned register, in the identity header beside the picture. Absent entirely when nothing
// is pinned — empty frames waiting to be filled would be worse than the plain header this was,
// and on your own profile the shelf below is already the way to fill it.
export function BadgePins({ badges, isSelf, onChanged }) {
  const { pinned, busy, toggle } = usePins(badges, onChanged)
  if (!pinned.length) return null
  return (
    <div className={'prof-pins' + (busy ? ' is-busy' : '')}>
      {pinned.map((b) => (
        <Badge key={b.id} badge={b} size="lg" pinned actionable={isSelf} onClick={() => toggle(b)} />
      ))}
    </div>
  )
}

// The pinned register somewhere that is NOT a profile: a leaderboard row, where the marks sit
// beside the name and nobody can edit them. Same <Badge> and the same hover card as the header
// wears — a badge means one thing wherever it is drawn — minus the caption, because a ladder
// row is one line and the name under a mark would be a second.
//
// It takes the badges straight (an array), not the profile's { pinned, all } envelope: the
// ladder endpoint sends only what a row wears (routes/movement.js LADDER_PINS), and asking a
// list of twenty for everything twenty people own would be the wrong request.
export function BadgeMarks({ badges, size = 'sm', className = '' }) {
  const list = Array.isArray(badges) ? badges : []
  if (!list.length) return null
  return (
    <span className={'badge-marks' + (className ? ' ' + className : '')}>
      {list.map((b) => <Badge key={b.id} badge={b} size={size} />)}
    </span>
  )
}

export default function BadgeShelf({ badges, isSelf, onChanged }) {
  const { all, pinnedIds, busy, toggle } = usePins(badges, onChanged)
  const [expanded, setExpanded] = useState(false)

  // What is worn is in the header; this is what is left. A player whose every badge is pinned
  // gets no block at all rather than a heading over an empty row.
  const unpinned = useMemo(() => all.filter((b) => !pinnedIds.has(b.id)), [all, pinnedIds])
  if (!unpinned.length) return null

  const shown = expanded ? unpinned : unpinned.slice(0, SHELF_PREVIEW)
  const hidden = unpinned.length - shown.length

  return (
    <div className={'badge-block' + (busy ? ' is-busy' : '')}>
      <div className="badge-head">
        <span className="section-label">Badges</span>
        <span className="badge-count">{all.length.toLocaleString()}</span>
      </div>

      <div className="badge-shelf">
        {shown.map((b) => (
          <Badge key={b.id} badge={b} size="sm" actionable={isSelf} onClick={() => toggle(b)} />
        ))}
        {hidden > 0 && (
          <button type="button" className="badge-more" onClick={() => setExpanded(true)}>
            +{hidden}
          </button>
        )}
        {expanded && unpinned.length > SHELF_PREVIEW && (
          <button type="button" className="badge-more" onClick={() => setExpanded(false)}>
            Fewer
          </button>
        )}
      </div>
    </div>
  )
}
