import { NavLink, Link, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { useSession } from '../session'
import { api, SIGN_IN, SIGN_IN_STEAM } from '../api'
import { Lockup, Avatar, Level } from './Bits'
import { THEMES, applyTheme, savedTheme } from '../themes'

export default function Nav() {
  const { signedIn, me, standing, isMod, authMode, refresh } = useSession()
  const [theme, setTheme] = useState(savedTheme())
  const [q, setQ] = useState('')
  const [hits, setHits] = useState(null)
  const nav = useNavigate()
  const box = useRef(null)

  useEffect(() => { applyTheme(theme) }, [theme])

  // The one search box (13 §3). It searches maps and players; the ranking is the server's.
  useEffect(() => {
    if (!q.trim()) { setHits(null); return undefined }
    const t = setTimeout(() => { api.get(`/api/search?q=${encodeURIComponent(q)}`).then(setHits).catch(() => setHits(null)) }, 180)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setHits(null) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  const go = (to) => { setQ(''); setHits(null); nav(to) }

  return (
    <nav className="nav">
      <Link to="/" className="lockup" aria-label="ENW Zombies"><Lockup h={20} /></Link>
      <NavLink to="/maps" className={({ isActive }) => `tab ${isActive ? 'on' : ''}`}>Maps</NavLink>
      <NavLink to="/records" className={({ isActive }) => `tab ${isActive ? 'on' : ''}`}>Records</NavLink>
      <NavLink to="/badges" className={({ isActive }) => `tab ${isActive ? 'on' : ''}`}>Badges</NavLink>
      <NavLink to="/playlists" className={({ isActive }) => `tab ${isActive ? 'on' : ''}`}>Playlists</NavLink>
      <NavLink to="/custom" className={({ isActive }) => `tab ${isActive ? 'on' : ''}`}>Custom</NavLink>
      {isMod && <NavLink to="/admin" className={({ isActive }) => `tab ${isActive ? 'on' : ''}`}>Admin</NavLink>}

      <div className="spacer" />

      <div ref={box} className="nav-search">
        <input type="search" value={q} placeholder="Search" onChange={(e) => setQ(e.target.value)} />
        {hits && (hits.maps.length || hits.players.length) ? (
          <div className="nav-hits">
            {hits.maps.map((m) => (
              <button key={m.key} className="btn ghost" style={{ width: '100%', justifyContent: 'flex-start', border: 0 }} onClick={() => go(`/m/${m.key}`)}>
                {m.title} <span className="tiny" style={{ marginLeft: 6 }}>{m.key}</span>
              </button>
            ))}
            {hits.players.map((p) => (
              <button key={p.steam_id} className="btn ghost" style={{ width: '100%', justifyContent: 'flex-start', border: 0 }} onClick={() => go(`/id/${p.name}`)}>
                {p.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <select className="nav-theme" value={theme} onChange={(e) => setTheme(e.target.value)} title="Theme">
        {Object.entries(THEMES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
      </select>

      {signedIn ? (
        <div className="row" style={{ gap: 8 }}>
          <Link to={`/id/${me.name}`} className="me">
            <Avatar user={me} />
            <span>{me.name}</span>
            <Level standing={standing} />
          </Link>
          <button className="btn small ghost" onClick={async () => { await api.post('/auth/logout'); refresh() }}>Sign out</button>
        </div>
      ) : (
        <a className="btn small primary" href={authMode === 'steam' ? SIGN_IN_STEAM : SIGN_IN}>
          {authMode === 'steam' ? 'Sign in' : 'Sign in (dev)'}
        </a>
      )}
    </nav>
  )
}
