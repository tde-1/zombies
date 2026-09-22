import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { SearchIcon } from './Icons'
import { Avatar } from './Bits'
import { prettyTitle, bspOf, mapHue } from '../data/mapText'

// The one search box, top-left of the nav, where Movement's is
// (`movement-client/src/components/SearchBar.jsx` — this is that component with our two
// result kinds). It sits where a wordmark would and is absolutely positioned like one, so
// the nav's links stay centred on the bar however wide the box gets.
//
// THE RANKING IS THE SERVER'S, and it is the one 13 §3 specifies: the engine key and its
// `nazi_zombie_` alias and the title first, then the author, then tags, then the description
// or readme (`server/lib/maps.js`, `score()`). Re-ranking here would be a second opinion
// about the same question, and the one with the readme text is better informed.
//
// Three things copied from Movement that are easy to leave out:
//
//   `/` and Ctrl+K reach the box from anywhere, guarded on what already has the keyboard —
//   `/` is a character, and stealing it out of the map filter or a comment box makes those
//   fields unusable.
//
//   The last row is "all N maps matching …", which lands on /maps?q=… — the box answers
//   "which map is this" and the pool answers "what is there like this", and the second
//   question is one keystroke from the first rather than a different page you have to know
//   about.
//
//   The query is DEBOUNCED and the answer is guarded by a sequence number. Without the
//   guard a slow response for "ver" can land after the fast one for "verruckt" and replace
//   it, which reads as the box ignoring what you typed.

const MIN = 2

export default function SearchBar() {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef(null)
  const input = useRef(null)
  const seq = useRef(0)
  const nav = useNavigate()

  const term = q.trim()

  useEffect(() => {
    if (term.length < MIN) { setHits(null); return undefined }
    const mine = ++seq.current
    const t = setTimeout(() => {
      api.get(`/api/search?q=${encodeURIComponent(term)}`)
        .then((d) => { if (mine === seq.current) setHits(d) })
        .catch(() => { if (mine === seq.current) setHits(null) })
    }, 160)
    return () => clearTimeout(t)
  }, [term])

  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  const focus = useCallback(() => {
    setOpen(true)
    if (input.current) { input.current.focus(); input.current.select() }
  }, [])

  useEffect(() => {
    const hit = (e) => {
      const el = e.target
      const tag = el && el.tagName ? el.tagName.toLowerCase() : ''
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (el && el.isContentEditable)
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); focus(); return }
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); focus() }
    }
    window.addEventListener('keydown', hit)
    return () => window.removeEventListener('keydown', hit)
  }, [focus])

  const maps = (hits && hits.maps) || []
  const players = (hits && hits.players) || []

  // One flat list, so the cursor and the highlight agree without either side counting groups.
  const flat = useMemo(() => {
    const out = []
    for (const p of players) out.push({ kind: 'player', p })
    for (const m of maps) out.push({ kind: 'map', m })
    if (term.length >= MIN) out.push({ kind: 'more', to: `/maps?q=${encodeURIComponent(term)}`, label: `All maps matching “${term}”` })
    return out
  }, [players, maps, term])

  useEffect(() => { setActive(0) }, [flat.length, term])

  const close = () => { setOpen(false); setQ('') }

  const go = (item) => {
    if (!item) return
    if (item.kind === 'player') nav(`/id/${encodeURIComponent(item.p.name || item.p.steam_id)}`)
    else if (item.kind === 'map') nav(`/m/${item.m.key}`)
    else nav(item.to)
    close()
    if (input.current) input.current.blur()
  }

  const onKey = (e) => {
    if (e.key === 'Escape') { close(); if (input.current) input.current.blur(); return }
    if (!flat.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % flat.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + flat.length) % flat.length) }
    else if (e.key === 'Enter') { e.preventDefault(); go(flat[active]) }
  }

  const showResults = open && term.length >= MIN
  const empty = showResults && hits && !players.length && !maps.length
  const idxOf = (kind, i) => flat.findIndex((f) => f.kind === kind && (kind === 'player' ? f.p === players[i] : f.m === maps[i]))

  return (
    <div className="nav-search" ref={box}>
      <div className={'nav-search-box' + (open ? ' open' : '')}>
        <span className="nav-search-ico" aria-hidden="true"><SearchIcon /></span>
        <input
          ref={input}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true) }}
          onFocus={focus}
          onKeyDown={onKey}
          placeholder="Search maps and players…"
          aria-label="Search maps and players"
        />
        {q
          ? <button className="nav-search-clear" title="Clear" aria-label="Clear search" onClick={close}>×</button>
          : <span className="nav-search-key" aria-hidden="true">/</span>}
      </div>

      {showResults && (
        <div className="nav-search-panel" role="listbox">
          {empty && (
            <div className="nav-search-empty">
              <div>Nothing matches “{term}”.</div>
            </div>
          )}

          {players.length > 0 && (
            <>
              <div className="nav-search-group"><span>Players</span><span className="nav-search-count">{players.length}</span></div>
              {players.map((p, i) => {
                const idx = idxOf('player', i)
                return (
                  <button key={p.steam_id} type="button" role="option" aria-selected={active === idx}
                          className={'nav-search-row' + (active === idx ? ' on' : '')}
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => go({ kind: 'player', p })}>
                    <Avatar user={p} size="sm" />
                    <span className="nav-search-name">{p.name}</span>
                  </button>
                )
              })}
            </>
          )}

          {maps.length > 0 && (
            <>
              <div className="nav-search-group"><span>Maps</span><span className="nav-search-count">{maps.length}</span></div>
              {maps.map((m, i) => {
                const idx = idxOf('map', i)
                return (
                  <button key={m.key} type="button" role="option" aria-selected={active === idx}
                          className={'nav-search-row' + (active === idx ? ' on' : '')}
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => go({ kind: 'map', m })}>
                    <span className="nav-search-art" style={{
                      '--h': String(mapHue(m.key)),
                      backgroundImage: m.art ? `url(${m.art})` : undefined,
                    }} />
                    {/* Name first, bsp underneath — the same order as every other map entry
                        on the site (data/mapText.js). */}
                    <span className="nav-search-name">
                      {prettyTitle(m.title, m.key)}
                      <span className="nav-search-sub">{bspOf(m)}</span>
                    </span>
                    <span className="nav-search-meta">{m.author || ''}</span>
                  </button>
                )
              })}
            </>
          )}

          {flat.length > 0 && flat[flat.length - 1].kind === 'more' && (() => {
            const it = flat[flat.length - 1]
            const idx = flat.length - 1
            return (
              <button type="button" role="option" aria-selected={active === idx}
                      className={'nav-search-row nav-search-more' + (active === idx ? ' on' : '')}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => go(it)}>
                <span className="nav-search-name">{it.label}</span>
              </button>
            )
          })()}
        </div>
      )}
    </div>
  )
}
