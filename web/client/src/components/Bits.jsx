import { Link } from 'react-router-dom'
import { ago, num } from '../api'

// The small shared pieces. One file because each is a dozen lines and a directory of
// twelve-line files is harder to read than one page of them.

// ---- the ENW mark and the option-A lockup -------------------------------------------
// 06: B picked option A — the Movement F3 lockup with "ZOMBIES" as the width-matched foot,
// bone on olive-black. The path is the ENW mark from `assets/logo-mockups.html`; the
// viewBox and the F3 proportions (word at 0.21 of the mark height, gap at 0.14) are that
// file's, so the two render identically.
const MARK = 'M2.05 0 70 0 70 30 2.05 30ZM20.05 66 70 66 70 93.9 20.05 93.9ZM2.05 128 70 128 70 156 2.05 156ZM76.22 2.51 168 88.64 168 0 198 0 198 154.04 102.04 66.5 102.04 156 76.22 156ZM204 148.74 228.82 80.79 259.32 151.48 321.8 0 287.99 0 259.48 73.33 231.19 1.3 204 65.78Z'
const VB = [0, 0, 321.8, 156]

export function Mark({ h = 22 }) {
  return (
    <svg className="mark" viewBox={VB.join(' ')} width={(h * VB[2]) / VB[3]} height={h} aria-hidden="true">
      <path d={MARK} fill="currentColor" />
    </svg>
  )
}

export function Lockup({ h = 22, word = true }) {
  const markW = (h * VB[2]) / VB[3]
  const size = h * 0.21
  // Width-matching by letter-spacing, the F3 rule. "ZOMBIES" is seven characters, so the
  // tracking is (markWidth - naturalWidth) / 6 — approximated here from the cap width
  // because the browser cannot be measured during render, and trimmed on the right so the
  // trailing space does not push the lockup off-centre.
  const natural = size * 0.72 * 7
  const ls = word ? (markW - natural) / 6 : 0
  return (
    <span className="lockup" title="ENW Zombies">
      <span style={{ display: 'inline-block' }}>
        <Mark h={h} />
        {word && (
          <span className="word" style={{ fontSize: size, letterSpacing: `${ls}px`, marginRight: -ls, marginTop: h * 0.14 }}>
            ZOMBIES
          </span>
        )}
      </span>
    </span>
  )
}

// ---- people -----------------------------------------------------------------------
export function Avatar({ user, size = 'md' }) {
  const cls = `avatar ${size === 'lg' ? 'lg' : size === 'sm' ? 'sm' : ''}`
  if (!user) return <span className={cls}>?</span>
  const initial = String(user.name || '?').trim().charAt(0).toUpperCase()
  return (
    <span className={cls} title={user.name}>
      {user.avatar ? <img src={user.avatar} alt="" /> : initial}
    </span>
  )
}

export function PlayerLink({ user, avatar = true }) {
  if (!user) return <span className="faint">—</span>
  return (
    <Link to={`/id/${encodeURIComponent(user.name || user.steam_id)}`} className="who">
      {avatar && <Avatar user={user} size="sm" />}
      <span className="who-n">{user.name}</span>
      {user.vip && <span className="tag gold">VIP</span>}
    </Link>
  )
}

// ---- level and prestige --------------------------------------------------------------
export function Level({ standing, showBar = false }) {
  if (!standing) return null
  const e = standing.emblem || {}
  return (
    <span className="level" title={`${e.label || 'No prestige'} · level ${standing.level}`}>
      {standing.prestige > 0 && <span className={`em ${e.finish === 'silver' ? 'silver' : e.finish === 'gold' ? 'gold' : ''} ${e.icon === 'missing' ? 'missing' : ''}`}>{e.icon === 'missing' ? '' : standing.prestige}</span>}
      <b className="num">{standing.level}</b>
      {showBar && standing.next_level_cost && (
        <span className="bar-meter" style={{ width: 70 }}><i style={{ width: `${Math.round(standing.progress * 100)}%` }} /></span>
      )}
    </span>
  )
}

// ---- badges -------------------------------------------------------------------------
// The map badge is Movement's glass hexagon with the map art, gold while the holder holds a
// record on that map (05). `locked` is the shelf's greyed-out slot.
// With no art, the hexagon shows the map's ENGINE NAME stem — FACTORY, PROTOTYPE, ALI —
// not a truncated copy of the title that is already printed underneath it. The stem is what
// the community and every filename call the map anyway, and it is short enough to read at
// 56px, which the title is not.
export function Hex({ badge, size = 58, gold = false, locked = false, label = null, code = null }) {
  const nm = label || (badge && badge.name) || ''
  const stem = code || stemOf(badge)
  return (
    <span className={`hex ${gold ? 'gold' : ''} ${locked ? 'locked' : ''}`} style={{ '--size': `${size}px` }} title={nm}>
      {badge && badge.art ? <img src={badge.art} alt="" /> : <span>{stem || shortName(nm)}</span>}
    </span>
  )
}

const stemOf = (b) => (b && b.map_key ? String(b.map_key).replace(/^nazi_zombie_/, '').toUpperCase().slice(0, 9) : null)
const shortName = (s) => String(s || '').split(/\s+/).slice(0, 2).map((w) => w.slice(0, 6)).join(' ')

export function BadgeTile({ badge, gold = false }) {
  return (
    <Link to={`/badges/${badge.slug}`} className="badgewrap">
      <Hex badge={badge} gold={gold} />
      <span className="nm">{badge.name}</span>
    </Link>
  )
}

// ---- chips ---------------------------------------------------------------------------
export function FinishChips({ map }) {
  return (
    <>
      {map.has_ee && <span className="tag gold">Easter egg</span>}
      {map.has_buyable && <span className="tag hot">Buyable ending</span>}
      {!map.has_ee && !map.has_buyable && <span className="tag">Round {map.round_n}</span>}
    </>
  )
}

export function Health({ health }) {
  if (health === 'verified') return <span className="tag good">Verified</span>
  if (health === 'broken') return <span className="tag hot">Broken</span>
  if (health === 'custom-only') return <span className="tag">Custom only</span>
  if (health === 'catalogued') return <span className="tag">Catalogued</span>
  return null
}

// Untracked: one mark, one place. A local or self-reported game earns nothing, and that is
// worth four characters, not a sentence.
export function Untracked({ title = 'No badges, records or XP' }) {
  return <span className="tag hot" title={title}>Untracked</span>
}

// ---- layout helpers --------------------------------------------------------------------
export function Section({ title, right, children }) {
  return (
    <section className="section">
      {(title || right) && (
        <header>
          {title && <div className="section-label">{title}</div>}
          {right && <span className="right">{right}</span>}
        </header>
      )}
      {children}
    </section>
  )
}

export const Empty = ({ children }) => <div className="empty">{children}</div>

export const Loading = () => <div className="loading"><span className="spinner" /></div>

export const Page = ({ wide = false, children }) => <div className={`page${wide ? ' wide' : ''}`}>{children}</div>

export function Stat({ label, value, tone }) {
  const v = value === null || value === undefined || value === '' ? '—' : value
  return (
    <div className="stat">
      <span>{label}</span>
      <b className={`num ${tone || ''}`}>{typeof v === 'number' ? num(v) : v}</b>
    </div>
  )
}

export const When = ({ at }) => <span className="when">{ago(at)}</span>
