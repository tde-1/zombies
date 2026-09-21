import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { SessionProvider } from './session'
import Nav from './components/Nav'
import PartyRail from './components/PartyRail'
import Home from './pages/Home'

// Everything past the front door is split out, Movement's rule: a visitor who opens the home
// page should not download the admin console with it.
const Maps = lazy(() => import('./pages/Maps'))
const MapPage = lazy(() => import('./pages/MapPage'))
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
const NotFound = lazy(() => import('./pages/Misc').then((m) => ({ default: m.NotFound })))

export default function App() {
  return (
    <SessionProvider>
      <div className="shell">
        {/* The rail sits ABOVE the router (Movement's party.jsx): it survives navigation,
            so the map you picked and the ready check you are in do not reset when you click
            into somebody's profile. It is on the left, where Movement's is. */}
        <PartyRail />
        <div className="main">
          <Nav />
          <Suspense fallback={<div className="page"><div className="loading"><span className="spinner" /></div></div>}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/home" element={<Navigate to="/" replace />} />
              <Route path="/maps" element={<Maps />} />
              {/* /m/<map> is the deep link YouTubers put in a description (13 §2d). It is
                  short on purpose and must never change. */}
              <Route path="/m/:key" element={<MapPage />} />
              <Route path="/archive" element={<Archive />} />
              <Route path="/records" element={<Records />} />
              <Route path="/badges" element={<Badges />} />
              <Route path="/badges/:slug" element={<BadgePage />} />
              <Route path="/playlists" element={<Playlists />} />
              <Route path="/playlists/:slug" element={<PlaylistPage />} />
              <Route path="/id/:who" element={<Profile />} />
              <Route path="/creator/:name" element={<Creator />} />
              <Route path="/game/:id" element={<Game />} />
              <Route path="/custom" element={<Custom />} />
              <Route path="/live" element={<LiveList />} />
              <Route path="/live/:matchId" element={<Live />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </div>
      </div>
    </SessionProvider>
  )
}
