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
export function Avatar({ user, size = 'sm' }) {
  if (!user) return <span className={`avatar ${size === 'lg' ? 'lg' : ''}`}>?</span>
  const initial = String(user.name || '?').trim().charAt(0).toUpperCase()
  return (
    <span className={`avatar ${size === 'lg' ? 'lg' : ''}`} title={user.name}>
      {user.avatar ? <img src={user.avatar} alt="" /> : initial}
    </span>
  )
}

export function PlayerLink({ user, avatar = true }) {
  if (!user) return <span className="sub">—</span>
  return (
    <Link to={`/id/${encodeURIComponent(user.name || user.steam_id)}`} className="row" style={{ gap: 7, display: 'inline-flex' }}>
      {avatar && <Avatar user={user} />}
      <span>{user.name}{user.vip && <span className="chip vip" style={{ marginLeft: 6 }}>VIP</span>}</span>
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
        <span className="bar" style={{ width: 70 }}><i style={{ width: `${Math.round(standing.progress * 100)}%` }} /></span>
      )}
    </span>
  )
}

// ---- badges -------------------------------------------------------------------------
// The map badge is Movement's glass hexagon with the map art, gold while the holder holds a
// record on that map (05). `locked` is the shelf's greyed-out slot.
export function Hex({ badge, size = 58, gold = false, locked = false, label = null }) {
  const nm = label || (badge && badge.name) || ''
  return (
    <span className={`hex ${gold ? 'gold' : ''} ${locked ? 'locked' : ''}`} style={{ '--size': `${size}px` }} title={nm}>
      {badge && badge.art ? <img src={badge.art} alt="" /> : <span>{shortName(nm)}</span>}
    </span>
  )
}

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
      {map.has_ee && <span className="chip ee">Easter Egg</span>}
      {map.has_buyable && <span className="chip be">Buyable Ending</span>}
      {!map.has_ee && !map.has_buyable && <span className="chip">Round {map.round_n}</span>}
    </>
  )
}

export function Health({ health }) {
  if (health === 'verified') return <span className="chip" title="Read end to end and refereed">Verified</span>
  if (health === 'broken') return <span className="chip be" title="Does not run on our servers">Broken</span>
  if (health === 'custom-only') return <span className="chip" title="Runs, but not in a Verified game">Custom only</span>
  return <span className="chip">Playable</span>
}

// ---- layout helpers --------------------------------------------------------------------
export function Section({ title, sub, right, children }) {
  return (
    <section className="section">
      {(title || right) && (
        <header>
          {title && <h2>{title}</h2>}
          {sub && <span className="sub">{sub}</span>}
          {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
        </header>
      )}
      {children}
    </section>
  )
}

export const Empty = ({ children }) => <div className="empty">{children}</div>

export function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <b className="num">{typeof value === 'number' ? num(value) : value}</b>
      {sub && <span className="tiny">{sub}</span>}
    </div>
  )
}

export const When = ({ at }) => <span className="when">{ago(at)}</span>
