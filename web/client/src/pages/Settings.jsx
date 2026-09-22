import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useSession } from '../session'
import { Loading } from '../components/Bits'
import { bridge } from '../components/launcherBridge'
import {
  SECTIONS, ALL, OMITTED, COMMON_MODES, sectionDefaults, shownValue, valueOf, withValue,
  toLauncherPatch, fromLauncher, newer, keyName,
} from '../data/wawSettings'

// /settings - World at War's Options menus, on the site (B, 2026-09-22: "make it look like
// the game's World at War settings menu, with all the exact same settings").
//
// Every row is an item out of the stock menus compiled into the game's ui.ff, in the menu's
// own order, writing the dvar or bind that menu writes (data/wawSettings.js has the source
// per row). Saved per SteamID on the site (`settings.game`), and - inside the launcher -
// handed to the launcher through the preload bridge, which puts it on the command line and
// into the config.cfg the engine reads at the next launch (launcher/src/main/wawcfg.js).
//
// Layout follows the game: a column of menu names on the left (Options: Graphics, Texture
// Settings, Sound, Game Options; Controls: Look, Move, Combat, Interact), the selected
// menu's rows on the right, label right-aligned and value left-aligned, and the game's
// "< value >" cycling on a list item.

const GROUPS = [
  { label: 'Options', ids: ['graphics', 'texture', 'sound', 'game'] },
  { label: 'Controls', ids: ['look', 'move', 'combat', 'interact'] },
  { label: 'ENW', ids: ['enw'] },
]

const fmt = (it, v) => {
  if (v === null || v === undefined) return 'Game default'
  if (it.kind === 'toggle') {
    const on = it.to === 'waw' ? String(v) === '1' : !!v
    return on ? 'Yes' : 'No'
  }
  if (it.options) {
    const o = it.options.find((x) => String(x.value) === String(v))
    return o ? o.label : String(v)
  }
  if (it.kind === 'slider') return it.max <= 1 ? `${Math.round(Number(v) * 100)}%` : String(v)
  return String(v)
}

export default function Settings() {
  const { signedIn, session, loading, refresh } = useSession()
  const enw = bridge()
  const [game, setGame] = useState(null)
  const [section, setSection] = useState(() => {
    const h = (location.hash || '').slice(1)
    return SECTIONS.some((s) => s.id === h) ? h : 'graphics'
  })
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

  useEffect(() => { try { history.replaceState(null, '', `#${section}`) } catch { /* no history */ } }, [section])
  useEffect(() => {
    const onHash = () => { const h = (location.hash || '').slice(1); if (SECTIONS.some((s) => s.id === h)) setSection(h) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const save = useCallback((g) => {
    latest.current = g
    setStatus('Saving…')
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const body = { ...latest.current, updatedAt: Date.now() }
      try {
        await api.put('/api/me/settings', { game: body })
        let where = 'Saved to your account'
        if (enw && enw.setSettings) {
          try { await enw.setSettings(toLauncherPatch(body)); where = 'Saved · the launcher applies it at your next launch' } catch { where = 'Saved to your account (the launcher did not take it: restart it)' }
        } else {
          where = 'Saved to your account · applied the next time you launch from the ENW launcher'
        }
        setStatus(where)
        refresh()
      } catch (e) {
        setStatus(`Not saved: ${e.message}`)
      }
    }, 350)
  }, [enw, refresh])

  const change = (it, v) => setGame((g) => { const n = withValue(g, it, v); save(n); return n })
  const reset = () => setGame((g) => {
    const d = sectionDefaults(section)
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

  const items = useMemo(() => ALL.filter((i) => i.section === section), [section])
  const modes = useMemo(() => {
    const own = displays.map((d) => `${d.width}x${d.height}`)
    return [...new Set([...own, ...COMMON_MODES])]
  }, [displays])

  if (loading) return <div className="page"><Loading /></div>
  if (!signedIn) {
    return (
      <div className="page waw-page">
        <h1 className="waw-title">Options</h1>
        <p className="muted">Sign in to keep your World at War settings on your account. They follow you to any PC you launch from.</p>
      </div>
    )
  }
  if (!game) return <div className="page"><Loading /></div>

  const sec = SECTIONS.find((s) => s.id === section) || SECTIONS[0]
  const isControls = ['look', 'move', 'combat', 'interact'].includes(sec.id)
  const mode = game.mode || 'borderless'

  return (
    <div className="page wide waw-page">
      <div className="waw-head">
        <h1 className="waw-title">{isControls ? 'Controls' : sec.id === 'enw' ? 'ENW' : 'Options'}</h1>
        <span className="waw-status" aria-live="polite">{status}</span>
      </div>
      <div className="waw-shell">
        <nav className="waw-menu" aria-label="Settings menus">
          {GROUPS.map((g) => (
            <div key={g.label} className="waw-group">
              <div className="waw-group-label">{g.label}</div>
              {g.ids.map((id) => {
                const s = SECTIONS.find((x) => x.id === id)
                return (
                  <button key={id} type="button" className={`waw-menu-item ${section === id ? 'on' : ''}`}
                          aria-current={section === id ? 'page' : undefined} onClick={() => { setCapture(null); setSection(id) }}>
                    {s.label}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <section className="waw-panel" aria-label={sec.label}>
          <div className="waw-panel-head">
            <h2>{sec.label}</h2>
            {sec.menu && <code className="waw-src" title="The stock menu this page is taken from">{sec.menu}</code>}
          </div>
          {isControls && <div className="waw-keys-head"><span /><span>Key</span><span>Alternate</span></div>}
          <div className="waw-rows">
            {items.map((it) => (
              <Row key={it.id} it={it} game={game} change={change} mode={mode} modes={modes}
                   displays={displays} capture={capture} setCapture={setCapture} />
            ))}
          </div>
          <div className="waw-foot">
            <button type="button" className="btn small ghost" onClick={reset}>
              {sec.id === 'enw' ? 'Reset to ENW defaults' : isControls ? 'Set default controls' : 'Reset to game defaults'}
            </button>
            <span className="tiny">
              {sec.id === 'enw' ? 'ENW\'s own launch settings. Not in World at War\'s menus.'
                : isControls ? 'Game defaults are default_controls.cfg, with aim down sights on hold (ENW).'
                  : 'Changes apply at your next launch. Anything you change in the game\'s own menus comes back here after you quit.'}
            </span>
          </div>
          {sec.id === 'enw' && (
            <details className="waw-omitted">
              <summary>In the game's menus, not mapped here</summary>
              <ul>{OMITTED.map((o) => <li key={o.label}><b>{o.label}</b> — {o.why}</li>)}</ul>
            </details>
          )}
        </section>
      </div>
    </div>
  )
}

function Row({ it, game, change, mode, modes, displays, capture, setCapture }) {
  const v = shownValue(game, it)
  const chosen = valueOf(game, it)
  const fromEnw = (chosen === undefined || chosen === '') && it.enw !== undefined
  const title = `${it.dvar || it.command || it.to.slice(4)} — ${it.src}`

  if (it.kind === 'bind') {
    const keys = (chosen !== undefined ? chosen : it.def) || []
    return (
      <div className="waw-row waw-bind" title={title}>
        <span className="waw-label">{it.label}</span>
        {[0, 1].map((slot) => {
          const on = capture && capture.command === it.command && capture.slot === slot
          return (
            <button key={slot} type="button" className={`waw-key ${on ? 'capturing' : ''} ${keys[slot] ? '' : 'empty'}`}
                    onClick={(e) => { e.stopPropagation(); setCapture(on ? null : { command: it.command, slot }) }}
                    aria-label={`${it.label}, ${slot ? 'alternate' : 'key'}: ${keys[slot] || 'unbound'}`}>
              {on ? 'Press a key…' : (keys[slot] || '—')}
            </button>
          )
        })}
      </div>
    )
  }

  let control
  if (it.kind === 'slider') {
    const n = Number(v)
    control = (
      <div className="waw-slider">
        <input type="range" min={it.min} max={it.max} step={it.step} value={Number.isFinite(n) ? n : it.min}
               aria-label={it.label}
               onChange={(e) => change(it, it.to === 'waw' ? String(e.target.value) : Number(e.target.value))} />
        <span className="waw-val">{fmt(it, v)}</span>
      </div>
    )
  } else if (it.kind === 'mode') {
    const locked = mode === 'borderless'
    control = (
      <select className="waw-select" value={locked ? '' : (v || '')} disabled={locked} aria-label={it.label}
              onChange={(e) => change(it, e.target.value)}>
        <option value="">{locked ? 'Native (borderless)' : 'Native size of the monitor'}</option>
        {modes.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    )
  } else if (it.kind === 'monitor') {
    control = (
      <select className="waw-select" value={String(v || 'primary')} aria-label={it.label} onChange={(e) => change(it, e.target.value)}>
        <option value="primary">Main display</option>
        {displays.map((d) => <option key={d.id} value={String(d.id)}>{`${d.label} — ${d.width}x${d.height}${d.primary ? ' (main)' : ''}`}</option>)}
      </select>
    )
  } else {
    // The game's "< value >" list: toggle or options, cycled with the arrows or a click.
    const opts = it.kind === 'toggle'
      ? (it.to === 'waw' ? [{ label: 'Yes', value: '1' }, { label: 'No', value: '0' }] : [{ label: 'Yes', value: true }, { label: 'No', value: false }])
      : it.options
    const idx = Math.max(0, opts.findIndex((o) => String(o.value) === String(v)))
    const known = opts.some((o) => String(o.value) === String(v))
    const step = (d) => change(it, opts[(idx + d + opts.length) % opts.length].value)
    control = (
      <div className="waw-cycle" role="group" aria-label={it.label}>
        <button type="button" className="waw-arrow" onClick={() => step(-1)} aria-label={`Previous ${it.label}`}>‹</button>
        <button type="button" className="waw-cycle-val" onClick={() => step(1)}>{known ? opts[idx].label : fmt(it, v)}</button>
        <button type="button" className="waw-arrow" onClick={() => step(1)} aria-label={`Next ${it.label}`}>›</button>
      </div>
    )
  }

  return (
    <div className="waw-row" title={title}>
      <span className="waw-label">{it.label}</span>
      <span className="waw-control">{control}</span>
      <span className="waw-meta">
        {fromEnw && <span className="tag" title="ENW's launch baseline sets this until you choose">ENW</span>}
        {chosen === null && <span className="tag" title="The game picks this itself (reset to its registered default)">Game</span>}
        {it.dvar && <code>{it.dvar}</code>}
      </span>
      {(it.note || it.needsManual) && <span className="waw-note">{it.needsManual ? 'Used when Texture Quality is Manual. ' : ''}{it.note || ''}</span>}
    </div>
  )
}
