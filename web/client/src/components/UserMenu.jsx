import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, SIGN_IN, SIGN_IN_STEAM } from '../api'
import { useSession } from '../session'
import { Level } from './Bits'
import { bridge, useLauncherStatus, describeLauncher } from './launcherBridge'

// Top-right account chip: avatar + name, click for a dropdown → Profile / Badges / Settings /
// Sign out. Copied from Movement (`movement-client/src/components/UserMenu.jsx`), including
// its rule that Profile and Settings live HERE and not in the nav.
//
// B, 2026-09-22, two changes to what was in this corner:
//
//   BADGES MOVED IN. The badge directory was a nav tab. It is directly under Profile now,
//   which is Movement's own placement and its own reasoning: the badges you wear live on
//   your profile, and this is the list of every one there is to get. The nav is down to
//   three links because of it.
//
//   SIGN OUT LEFT THE HEADER. It was a button sitting in the bar beside the account chip —
//   the most destructive control on the site, drawn at the same weight as a link, one
//   mis-click from the thing next to it. It is the last item of this menu now, under a
//   separator, in the site's one red.
//
// Signed out this is the Steam button and nothing else: the site is browsable either way,
// and Steam is the only way in (§10e).

const initials = (name) => (name || '?').trim().slice(0, 2).toUpperCase()

export default function UserMenu() {
  const { me, standing, loading, signedIn, authMode, refresh } = useSession()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const nav = useNavigate()
  // Inside the launcher this menu also carries what the launcher's old top bar did:
  // Settings, the client / update status, and sign-in through the launcher's own Steam
  // round trip (the wrapped view cannot follow Steam's OpenID page itself).
  const enw = bridge()
  const launcher = describeLauncher(useLauncherStatus())
  const [signingIn, setSigningIn] = useState(false)
  useEffect(() => (enw && enw.onSession ? enw.onSession(() => refresh()) : undefined), [enw, refresh])
  const openScreen = (name) => { setOpen(false); try { enw.openScreen(name) } catch { /* older launcher */ } }

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [])

  if (loading) return <div className="um-chip um-skeleton" />

  if (!signedIn || !me) {
    if (enw && enw.openScreen) {
      const signIn = async () => {
        setSigningIn(true)
        try { await enw.signIn() } catch { /* the launcher toasts its own reason */ }
        setSigningIn(false)
        refresh()
      }
      return (
        <div className="um-signed-out">
          <button type="button" className="btn small primary" onClick={signIn} disabled={signingIn}>
            {signingIn ? 'Waiting for your browser…' : 'Sign in'}
          </button>
          <button type="button" className="um-cog" onClick={() => openScreen('settings')}
                  aria-label="Launcher settings" title="Launcher settings">
            <svg viewBox="0 0 24 24" width="16" height="16" className="server-icon" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </button>
        </div>
      )
    }
    return (
      <a className="btn small primary" href={authMode === 'steam' ? SIGN_IN_STEAM : SIGN_IN}>
        {authMode === 'steam' ? 'Sign in' : 'Sign in (dev)'}
      </a>
    )
  }

  const who = encodeURIComponent(me.name || me.steam_id)
  const go = (to) => { setOpen(false); nav(to) }
  const signOut = async () => {
    setOpen(false)
    try { await api.post('/auth/logout') } catch { /* already gone */ }
    // The launcher keeps its own copy of who is signed in (settings.session); drop it too.
    if (enw && enw.signOut) { try { await enw.signOut() } catch { /* nothing held */ } }
    refresh()
  }

  return (
    <div className="um" ref={ref}>
      <button className="um-chip" onClick={() => setOpen((o) => !o)}
              aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
        {me.avatar
          ? <img className="um-av" src={me.avatar} alt="" />
          : <span className="um-av um-initials">{initials(me.name)}</span>}
        <span className="um-name">{me.name}</span>
        <Level standing={standing} />
        <span className="um-caret">▾</span>
      </button>
      {open && (
        <div className="um-menu" role="menu">
          <div className="um-head">
            {me.vip && <span className="tag gold">VIP</span>}
            <span className="um-head-name">{me.name}</span>
          </div>
          <button className="um-item" role="menuitem" onClick={() => go(`/id/${who}`)}>Profile</button>
          {/* Directly under Profile, Movement's placement: the badges you wear live there,
              and this is the list of every one there is to get. */}
          <button className="um-item" role="menuitem" onClick={() => go('/badges')}>Badges</button>
          {/* Your settings are a section of your own profile (pages/Profile.jsx) rather than
              a page of their own — there are eight of them and they are all about how the
              game runs for you. The hash is the anchor on that section. */}
          <button className="um-item" role="menuitem" onClick={() => go(`/id/${who}#settings`)}>Settings</button>
          {launcher && (
            <>
              <div className="um-sep" />
              <div className="um-launcher">
                <div className={launcher.installed ? '' : 'warn'}>{launcher.client}</div>
                <div>Launcher <b>{launcher.version || '?'}</b>{launcher.update ? ` · ${launcher.update}` : ''}</div>
              </div>
              {!launcher.installed && (
                <button className="um-item" role="menuitem" onClick={() => openScreen('firstRun')}>Install the ENW client</button>
              )}
              {launcher.updateReady && (
                <button className="um-item" role="menuitem" onClick={() => { setOpen(false); enw.restartAndUpdate().catch(() => {}) }}>Restart to update</button>
              )}
              <button className="um-item" role="menuitem" onClick={() => openScreen('settings')}>Launcher settings</button>
            </>
          )}
          <div className="um-sep" />
          <button className="um-item um-danger" role="menuitem" onClick={signOut}>Sign out</button>
        </div>
      )}
    </div>
  )
}
