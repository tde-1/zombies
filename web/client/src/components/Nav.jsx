import { useEffect, useState } from 'react'
import { NavLink, Link } from 'react-router-dom'
import { useSession } from '../session'
import { Lockup } from './Bits'
import SearchBar from './SearchBar'
import UserMenu from './UserMenu'
import WindowControls from './WindowControls'

// Movement's nav bar (`movement-client/src/components/Nav.jsx`): search top-left where the
// wordmark would be, the links centred and growing outward from the middle, the account in
// the top right. Three regions, and the middle one is the only one that is a list of pages.
//
// B's list for this morning (2026-09-22) and what each line cost:
//
//   THE BAR IS **Maps, Records, Admin** and nothing else. Admin is staff-only. It was seven
//   tabs — Maps, Records, Badges, Playlists, Custom, Download, Admin — and the seven were
//   not one kind of thing: two were pages you read, two were staff tools with no gate on
//   them, one was a directory that belongs to your account, and one was an install page.
//
//   PLAYLISTS AND CUSTOM MOVED UNDER ADMIN. Both are real and both still have their routes
//   and their deep links (/playlists/<slug>, /custom); what they are not is a thing a player
//   browsing maps needs a permanent tab for. The Admin console links them.
//
//   BADGES MOVED TO THE ACCOUNT MENU (UserMenu.jsx), which is where Movement keeps it.
//
//   THE THEME DROPDOWN IS GONE, with the two extra palettes behind it. One theme, Movement's
//   — see themes.js, which is now a single token block and an `applyTheme()`.
//
//   SIGN OUT LEFT THE HEADER for the account dropdown.
//
// DOWNLOAD is the one link Movement has no equivalent for, and it is not in the bar either
// any more: every Play button in a plain browser now goes there by itself
// (`components/playGate.js`), which is a better door than a tab, and the lockup's own menu
// would be a fourth region. It stays linked from the party panel's signed-out state, the map
// page and the gate, which is where somebody actually wants it.

// ── The ENW Discord, top right ────────────────────────────────────────────────
//
// A port of Movement's `movement-client/src/components/DiscordNavLink.jsx` (its branch
// `claude/pvp-url-rewrite-installer`), mechanism and reasoning:
//
//   * it is shown to anybody the site has NOT linked to a Discord account, and signed
//     out it shows, because signed out nobody is known to be in the Discord;
//   * the X hides it for 24 hours ON THIS BROWSER and then it comes back until they
//     link. localStorage is right for that and only that: it is one viewer's
//     convenience, and an unreadable store simply means the link shows;
//   * a tab left open all day gets the link back — the snooze wakes itself on a timer
//     rather than waiting for a reload.
//
// WHAT IS DIFFERENT HERE, and it is the honest part. Movement's gate is `me.discord`,
// truthy once its Discord OAuth link or its in-game verification importer has written
// `users.discord_id`. Zombies has the COLUMN (`server/db/database.js`) and the gate
// (`server/lib/discord.js`, surfaced as `session.discord`), and **nothing that writes
// it**: neither the OAuth flow (`server/lib/discordLink.js`, `server/routes/discord.js`
// in Movement — it ports straight in and needs an app's client id, secret and redirect
// URI) nor the verification feed came over tonight. So today every signed-in player is
// unlinked and everybody sees the link. TODO, `docs/kickstart/web.md` §12d.
//
// The invite is Movement's own constant, `https://discord.enw.gg`, served by the API so
// the "already linked" rule lives in exactly one place. `ENW_DISCORD_INVITE` overrides.
const DISCORD_SNOOZE_KEY = 'zm.discordNav.dismissedAt'
const DISCORD_SNOOZE_MS = 24 * 60 * 60 * 1000

const readDismissed = () => {
  try { return Number(window.localStorage.getItem(DISCORD_SNOOZE_KEY)) || 0 } catch { return 0 }
}

function DiscordNavLink() {
  const { discord, loading } = useSession()
  const [dismissedAt, setDismissedAt] = useState(readDismissed)
  const [now, setNow] = useState(() => Date.now())

  const wakeIn = dismissedAt ? dismissedAt + DISCORD_SNOOZE_MS - now : 0
  useEffect(() => {
    if (wakeIn <= 0) return undefined
    const id = setTimeout(() => setNow(Date.now()), Math.min(wakeIn + 1000, 2147483000))
    return () => clearTimeout(id)
  }, [wakeIn])

  if (loading) return null
  // `invite` is null when the server says there is nothing to show — either this account
  // has linked, or nobody configured a URL. One rule, one place.
  if (!discord || !discord.invite) return null
  if (wakeIn > 0) return null

  const dismiss = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const t = Date.now()
    try { window.localStorage.setItem(DISCORD_SNOOZE_KEY, String(t)) } catch { /* hides for this page only */ }
    setDismissedAt(t)
    setNow(t)
  }

  return (
    <span className="mv-discord">
      <a className="mv-inv mv-discord-link" href={discord.invite} target="_blank" rel="noopener noreferrer">
        Discord<span className="ext-arrow">↗</span>
      </a>
      <button type="button" className="mv-discord-x" onClick={dismiss}
              aria-label="Hide the Discord link for a day" title="Hide for a day">
        <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
          <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  )
}

export default function Nav() {
  const { isMod } = useSession()

  return (
    <nav className="mv-nav">
      <div className="mv-nav-bar">
        {/* Inside the launcher the drag region is this empty underlay, never the bar itself:
            Electron on Windows hit-tests a dragged ancestor before its no-drag children get
            the click (B, 2026-09-22: "I can't click anything on the nav bar"). */}
        <div className="mv-drag" aria-hidden="true" />
        <SearchBar />
        <div className="mv-nav-center">
          {/* The lockup is the way home and sits inside the centred group rather than in the
              corner: the corners are the search and the account, and a brand mark competing
              with the search box for the top-left is the layout Movement deleted. */}
          <Link to="/" className="mv-lockup" aria-label="ENW Zombies"><Lockup h={18} /></Link>
          <NavLink to="/maps" className={({ isActive }) => 'mv-navlink' + (isActive ? ' active' : '')}>Maps</NavLink>
          <NavLink to="/records" className={({ isActive }) => 'mv-navlink' + (isActive ? ' active' : '')}>Records</NavLink>
          {isMod && <NavLink to="/admin" className={({ isActive }) => 'mv-navlink' + (isActive ? ' active' : '')}>Admin</NavLink>}
        </div>
        <div className="mv-nav-right">
          <DiscordNavLink />
          <UserMenu />
          {/* Inside the launcher only: the window is frameless and this bar is its title
              bar. Renders nothing in a browser. */}
          <WindowControls />
        </div>
      </div>
    </nav>
  )
}
