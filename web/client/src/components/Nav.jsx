import { NavLink, Link } from 'react-router-dom'
import { useSession } from '../session'
import { Lockup } from './Bits'
import SearchBar from './SearchBar'
import UserMenu from './UserMenu'

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

export default function Nav() {
  const { isMod } = useSession()

  return (
    <nav className="mv-nav">
      <div className="mv-nav-bar">
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
          <UserMenu />
        </div>
      </div>
    </nav>
  )
}
