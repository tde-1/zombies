import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useSession } from '../session'
import { Loading } from '../components/Bits'
import { bridge } from '../components/launcherBridge'
import {
  ALL, COMMON_MODES, defaultsFor, shownValue, valueOf, withValue,
  toLauncherPatch, fromLauncher, newer, keyName,
} from '../data/wawSettings'
import { TABS, GROUPS, OLD_HASH, groupItems, groupsOf, labelOf } from '../data/settingsLayout'
import SettingRow from '../components/settings/SettingRow'
import EnwSection from '../components/settings/EnwSection'
import TabIcon from '../components/settings/TabIcon'

// /settings - every World at War Options-menu setting, plus ENW's launch knobs, per SteamID.
//
// 2026-09-22 (late): B, "Clean up the settings menu. It should be like my project Gaff's
// settings menu, split off into little sections and really simplified." So the page is
// Gaff's settings screen (WatchGame/app/src/components/SettingsScreen.jsx and the `ss-*`
// rules in WatchGame/app/src/styles.css): a rail with a search box and a few icon tabs
// (Display, Graphics, Audio, Controls, Game, ENW), and in each tab small lowercase section
// headings with one short row per setting - checkbox, segmented buttons, select or slider -
// and a one-line hint only where the value does not explain itself.
//
// What each row WRITES is unchanged: data/wawSettings.js (dvar, values, defaults and the
// source of every row; client.md §8). data/settingsLayout.js only places rows into tabs and
// groups. Saved per SteamID on the site (`settings.game`) and - inside the launcher - handed
// to the launcher through the preload bridge, which puts it on the command line and into the
// config.cfg the engine reads at the next launch (launcher/src/main/wawcfg.js).

const tabFromHash = () => {
  const h = (typeof location !== 'undefined' ? location.hash : '').slice(1)
  if (TABS.some((t) => t.id === h)) return h
  return OLD_HASH[h] || 'display'
}

export default function Settings() {
  const { signedIn, session, loading, refresh } = useSession()
  const enw = bridge()
  const [game, setGame] = useState(null)
  const [tab, setTab] = useState(tabFromHash)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [displays, setDisplays] = useState([])
  const [capture, setCapture] = useState(null) // { command, slot }
  const timer = useRef(null)
  const latest = useRef(null)

  // Load: the site's copy, the launcher's copy, and whichever is newer wins - the
  // launcher's is newer after a game where the player changed something in the game's
  // own menus (the post-exit read-back), the site's after an edit here in a browser.
  useEffect(() => {
    if (loading || !signedIn) return undefined
    let live = true
    ;(async () => {
      const siteGame = (session && session.user && session.user.settings && session.user.settings.game) || null
      let g = siteGame ? { ...siteGame } : { waw: {}, wawBinds: {}, updatedAt: 0 }
      if (enw && enw.getSettings) {
        try {
          const L = await enw.getSettings()
          const who = newer(siteGame || { updatedAt: 0 }, L)
          if (who === 'launcher' || !siteGame) {
            // Take the launcher's (it also carries the keys it had before this page existed).
            g = { ...g, ...fromLauncher(L), waw: { ...(g.waw || {}), ...((L && L.waw) || {}) }, wawBinds: { ...(g.wawBinds || {}), ...((L && L.wawBinds) || {}) } }
            if (who === 'launcher') api.put('/api/me/settings', { game: g }).then(refresh).catch(() => {})
          } else if (who === 'site') {
            enw.setSettings(toLauncherPatch(g)).catch(() => {})
          }
        } catch { /* older launcher: the site copy stands */ }
        try { const d = await enw.getDisplays(); if (live) setDisplays((d && d.displays) || []) } catch { /* no monitor list */ }
      }
      if (live) setGame(g)
    })()
    return () => { live = false }
  }, [loading, signedIn]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { try { history.replaceState(null, '', `#${tab}`) } catch { /* no history */ } }, [tab])
  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const save = useCallback((g) => {
    latest.current = g
    setStatus('saving…')
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const body = { ...latest.current, updatedAt: Date.now() }
      try {
        await api.put('/api/me/settings', { game: body })
        let where = 'saved'
        if (enw && enw.setSettings) {
          try { await enw.setSettings(toLauncherPatch(body)); where = 'saved · applies at your next launch' } catch { where = 'saved to your account · restart the launcher to pick it up' }
        }
        setStatus(where)
        refresh()
      } catch (e) {
        setStatus(`not saved: ${e.message}`)
      }
    }, 350)
  }, [enw, refresh])

  const change = (it, v) => setGame((g) => { const n = withValue(g, it, v); save(n); return n })
  // Reset one little group to its defaults: the game's own, and ENW's for ENW's own knobs.
  const reset = (group) => setGame((g) => {
    const d = defaultsFor(groupItems(group))
    const { waw, wawBinds, ...keys } = d
    const n = { ...g, ...keys, waw: { ...(g.waw || {}), ...waw }, wawBinds: { ...(g.wawBinds || {}), ...wawBinds } }
    save(n)
    return n
  })

  // Bind capture: the next key, mouse button or wheel notch. Escape cancels, Backspace or
  // Delete clears the slot - the game's own menu uses the same two keys.
  useEffect(() => {
    if (!capture) return undefined
    const it = ALL.find((i) => i.to === 'bind' && i.command === capture.command)
    const take = (e) => {
      e.preventDefault(); e.stopPropagation()
      if (e.type === 'keydown' && e.key === 'Escape') { setCapture(null); return }
      const cur = [...((valueOf(game, it) !== undefined ? valueOf(game, it) : it.def) || [])]
      if (e.type === 'keydown' && (e.key === 'Backspace' || e.key === 'Delete')) {
        cur.splice(capture.slot, 1)
        change(it, cur); setCapture(null); return
      }
      const k = keyName(e)
      if (!k || k === 'ESCAPE') return
      // A mouse button bound here must not also click whatever is under the pointer.
      if (e.type === 'mousedown') window.addEventListener('click', (c) => { c.preventDefault(); c.stopPropagation() }, { capture: true, once: true })
      cur[capture.slot] = k
      change(it, cur.filter(Boolean)); setCapture(null)
    }
    const opts = { capture: true }
    window.addEventListener('keydown', take, opts)
    window.addEventListener('mousedown', take, opts)
    window.addEventListener('wheel', take, { capture: true, passive: false })
    return () => {
      window.removeEventListener('keydown', take, opts)
      window.removeEventListener('mousedown', take, opts)
      window.removeEventListener('wheel', take, { capture: true, passive: false })
    }
  }, [capture, game]) // eslint-disable-line react-hooks/exhaustive-deps

  const modes = useMemo(() => {
    const own = displays.map((d) => `${d.width}x${d.height}`)
    return [...new Set([...own, ...COMMON_MODES])]
  }, [displays])

  // Search, as Gaff's: every row whose label, dvar or group matches, with a crumb.
  const q = query.trim().toLowerCase()
  const hits = useMemo(() => {
    if (!q) return []
    const out = []
    for (const g of GROUPS) {
      for (const it of groupItems(g)) {
        const hay = `${labelOf(it)} ${it.label} ${it.dvar || ''} ${it.command || ''} ${g.label} ${g.tab}`.toLowerCase()
        if (hay.includes(q)) out.push({ g, it })
      }
    }
    return out
  }, [q])

  if (loading) return <div className="page"><Loading /></div>
  if (!signedIn) {
    return (
      <div className="page set-page">
        <div className="set-screen set-screen-empty">
          <div className="set-head"><h1>settings</h1></div>
          <p className="set-hint set-hint-block">Sign in to save your settings to your account.</p>
        </div>
      </div>
    )
  }
  if (!game) return <div className="page"><Loading /></div>

  const ctx = {
    mode: game.mode || 'borderless',
    modes,
    displays,
    capture,
    setCapture,
    picmipManual: shownValue(game, ALL.find((i) => i.id === 'r_picmip_manual')),
  }
  const tabLabel = (id) => (TABS.find((t) => t.id === id) || {}).label || id
  const pick = (id) => { setCapture(null); setQuery(''); setTab(id) }

  return (
    <div className="page set-page">
      <div className="set-screen">
        <div className="set-head">
          <h1>settings</h1>
          <span className="set-status" aria-live="polite">{status}</span>
        </div>
        <div className="set-body">
          <nav className="set-nav" aria-label="Settings">
            <label className="set-search">
              <TabIcon name="search" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search settings" aria-label="search settings" />
              {query && <button type="button" className="set-search-clear" onClick={() => setQuery('')} aria-label="clear search">×</button>}
            </label>
            <div className="set-tabs">
              {TABS.map((t) => (
                <button key={t.id} type="button" className={`set-tab ${!q && tab === t.id ? 'on' : ''}`}
                        aria-current={!q && tab === t.id ? 'page' : undefined} onClick={() => pick(t.id)}>
                  <TabIcon name={t.icon} />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </nav>

          <div className="set-content">
            {q ? (
              hits.length === 0
                ? <div className="set-empty">no settings match “{query}”</div>
                : hits.map(({ g, it }) => (
                  <div key={it.id} className="set-result">
                    <button type="button" className="set-crumb" onClick={() => pick(g.tab)}>{tabLabel(g.tab)} › {g.label}</button>
                    <SettingRow it={it} game={game} change={change} ctx={ctx} />
                  </div>
                ))
            ) : (
              <>{tab === 'enw' && <EnwSection onStatus={setStatus} />}{
              groupsOf(tab).map((g) => (
                <div key={g.id} className={`set-group ${g.keys ? 'set-keys' : ''}`}>
                  <div className="set-section">
                    <span>{g.label}</span>
                    <button type="button" className="set-reset" onClick={() => { setCapture(null); reset(g) }}
                            title={g.keys ? 'Back to the game\'s default keys (aim down sights stays on hold)' : 'Back to the game\'s defaults'}>reset</button>
                  </div>
                  {g.keys && g.id === 'move' && <div className="set-hint">click a box, then press a key or mouse button. esc cancels, backspace clears.</div>}
                  {groupItems(g).map((it) => <SettingRow key={it.id} it={it} game={game} change={change} ctx={ctx} />)}
                </div>
              ))}</>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
