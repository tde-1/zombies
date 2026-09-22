import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate, useMatch } from 'react-router-dom'
import { SessionProvider, useSession } from './session'
import { RailProvider } from './rail'
import Nav from './components/Nav'
import PartyRail from './components/PartyRail'
import ChatDock from './components/ChatDock'
import { GameSettingsSync } from './components/launcherBridge'
import Home from './pages/Home'
// NOT lazy: home renders `MapBody` out of this module, so it lands in the first chunk
// whatever this line says, and a lazy route over a module that is already loaded only buys
// a Suspense boundary nobody ever sees.
import MapPage from './pages/MapPage'
// NOT lazy either: it is the first thing every new account sees, and a spinner in front of
// the one screen standing between a player and the site is a spinner too many.
import UsernameSetup from './pages/UsernameSetup'

// Everything past the front door is split out, Movement's rule: a visitor who opens the home
// page should not download the admin console with it.
const Maps = lazy(() => import('./pages/Maps'))
const Profile = lazy(() => import('./pages/Profile'))
const Records = lazy(() => import('./pages/Records'))
const Badges = lazy(() => import('./pages/Badges'))
const BadgePage = lazy(() => import('./pages/Badges').then((m) => ({ default: m.BadgePage })))
const Playlists = lazy(() => import('./pages/Playlists'))
const PlaylistPage = lazy(() => import('./pages/Playlists').then((m) => ({ default: m.PlaylistPage })))
const Custom = lazy(() => import('./pages/Custom'))
const Live = lazy(() => import('./pages/Live'))
const LiveList = lazy(() => import('./pages/Live').then((m) => ({ default: m.LiveList })))
const Admin = lazy(() => import('./pages/Admin'))
const Creator = lazy(() => import('./pages/Misc').then((m) => ({ default: m.Creator })))
const Game = lazy(() => import('./pages/Misc').then((m) => ({ default: m.Game })))
const Archive = lazy(() => import('./pages/Archive'))
const Download = lazy(() => import('./pages/Download'))
const Settings = lazy(() => import('./pages/Settings'))
// The 3D replay viewer. Split hard: this chunk carries three.js.
const Replay = lazy(() => import('./pages/Replay'))
const NotFound = lazy(() => import('./pages/Misc').then((m) => ({ default: m.NotFound })))

export default function App() {
  return (
    <SessionProvider>
      <RailProvider>
        <Shell />
      </RailProvider>
    </SessionProvider>
  )
}

function Shell() {
  // The replay viewer is a full-bleed 3D view; Movement renders its replay page without the
  // shell for the same reason. Everything else carries the rail.
  const bare = !!useMatch('/replay/:matchId')
  return (
    <>
      {/* Keeps the launcher's copy of /settings and the account's in step (launcherBridge.js). */}
      <GameSettingsSync />
      {/* THE RAIL IS BACK, ON THE LEFT, and it is Movement's (B, 2026-09-22 evening: "the
          leftmost stuck thing that has all online players, your current party, and your map
          in the bottom left with the Play button"). It sits ABOVE the router, Movement's
          reason: it survives navigation, so a party, a staged map and a ready check are on
          screen whatever page you are reading.
          ~~The party is a panel at the top of home's left column (`PartyPanel.jsx`)~~ —
          superseded by this; that panel is deleted and everything it did is in the rail's
          roster and server card. The earlier objection to a rail was a THIRD region, on the
          right; this is the left spine, the nav stays one bar across the top because it is
          the launcher's title bar, and there is still no right column. */}
      {/* THE CHAT DOCK SITS ABOVE THE ROUTER, for the same reason: it survives navigation. */}
      <div className="shell no-rail">
        <div className="main">
          <Nav />
          <NameGate>
          <div className={'shell-row' + (bare ? ' bare' : '')}>
          {!bare && <PartyRail />}
          <div className="shell-page">
          <Suspense fallback={<div className="page"><div className="loading"><span className="spinner" /></div></div>}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/home" element={<Navigate to="/" replace />} />
              {/* `enw-zombies://party/<id>` opens /party/<id> in the launcher's wrapped view
                  (docs/protocol/launcher-v0.md §7), and the party lives in the rail, on every
                  page — there is no page of its own to send it to. So the route exists and lands on
                  home rather than on a 404. It does NOT try to join anything: the launcher
                  says joining is the site's decision, and the site's decision is made by the
                  invite the person already holds. */}
              <Route path="/party/:id" element={<Home />} />
              <Route path="/maps" element={<Maps />} />
              {/* /m/<map> is the deep link YouTubers put in a description (13 §2d). It is
                  short on purpose and must never change. */}
              <Route path="/m/:key" element={<MapPage />} />
              <Route path="/archive" element={<Archive />} />
              <Route path="/download" element={<Download />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/records" element={<Records />} />
              <Route path="/badges" element={<Badges />} />
              <Route path="/badges/:slug" element={<BadgePage />} />
              <Route path="/playlists" element={<Playlists />} />
              <Route path="/playlists/:slug" element={<PlaylistPage />} />
              <Route path="/id/:who" element={<Profile />} />
              <Route path="/creator/:name" element={<Creator />} />
              <Route path="/game/:id" element={<Game />} />
              {/* A replay link is pasted into a video description like /m/<map> is,
                  so it is a route of its own and the match id must never change. */}
              <Route path="/replay/:matchId" element={<Replay />} />
              <Route path="/custom" element={<Custom />} />
              <Route path="/live" element={<LiveList />} />
              <Route path="/live/:matchId" element={<Live />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
          </div>
          </div>
          </NameGate>
        </div>
      </div>
      <DockUnlessNameless />
    </>
  )
}

// ── The name gate (2026-09-22) ─────────────────────────────────────────────────────────
// Movement's App.jsx `Gate`, the one line of it this site needs: signed in with no ENW name
// means the picker and nothing else, AHEAD of the approval wall. Signed out is untouched —
// the map pages stay public. The nav stays because in the launcher it is the title bar.
// The server refuses a nameless account everything but the picker's own routes
// (server/middleware/auth.js), so this is the polite half of a gate, not the gate.
function NameGate ({ children }) {
  const { me, needsName, refresh } = useSession()
  if (needsName) return <UsernameSetup me={me} onDone={refresh} />
  return children
}

// The chat dock signs lines with the ENW name; there is none to sign with yet.
function DockUnlessNameless () {
  const { needsName } = useSession()
  return needsName ? null : <ChatDock />
}
