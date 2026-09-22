import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { prettyTitle, mapHue } from '../data/mapText'

// ── The map picker: the server card's sheet ────────────────────────────────
//
// Movement's GameModePicker sheet (`movement-client/src/components/GameModePicker.jsx`), with
// maps where it has modes. Everything that is not the cards is copied: portalled to <body>
// because the rail is a 302px stacking context and this has to sit over the nav and the page;
// the scrim is the grey layer over the site's ambient pour; the sheet takes a wash of the
// current map's own hue fading to the ground; Esc, the scrim and the × all close; the current
// card wears a "current" pill top-left, out of flow.
//
// What is ours: a search box in the head, because Movement's sheet has eight modes and this
// one has the whole pool. The cards are drawn for the first 60 matches only — two thousand
// art tiles is a stress test, and a search that narrows to what you typed is how anybody
// finds a map in a list that long anyway. The current map is always first.

const SHOW = 60

export default function MapPicker({ R, onClose }) {
  const boxRef = useRef(null)
  const inputRef = useRef(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    if (inputRef.current) inputRef.current.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pool = R.pool || []
  const cur = R.mapKey

  // The same ranking the pool list on home uses: the key and its `nazi_zombie_` alias first,
  // then the title, then the author.
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    let list = pool
    if (s) {
      const score = (m) => {
        const key = (m.key || '').toLowerCase()
        const alias = key.replace('nazi_zombie_', '')
        const title = (m.title || '').toLowerCase()
        const author = (m.author || '').toLowerCase()
        if (key.startsWith(s) || alias.startsWith(s)) return 0
        if (title.startsWith(s)) return 1
        if (key.includes(s) || title.includes(s)) return 2
        if (author.includes(s)) return 3
        return -1
      }
      list = pool.map((m) => [score(m), m]).filter(([n]) => n >= 0).sort((a, b) => a[0] - b[0]).map(([, m]) => m)
    } else if (cur) {
      const c = pool.find((m) => m.key === cur)
      if (c) list = [c, ...pool.filter((m) => m.key !== cur)]
    }
    return list
  }, [pool, q, cur])

  const pick = async (key) => {
    await R.stageMap(key)
    onClose()
  }

  return createPortal(
    <div className="rgm-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={'rgm-sheet mpk-sheet' + (cur ? ' has-hue' : '')}
           style={cur ? { '--h': String(mapHue(cur)) } : undefined}
           role="dialog" aria-modal="true" aria-label="Choose a map" tabIndex={-1} ref={boxRef}>
        <div className="rgm-head">
          <h3>Select a map</h3>
          <span className="mpk-count">{pool.length.toLocaleString()} maps</span>
          <button type="button" className="rgm-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="mpk-search">
          <input ref={inputRef} type="search" value={q} placeholder="Search by name, bsp or author"
                 aria-label="Search maps" onChange={(e) => setQ(e.target.value)}
                 onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && shown[0]) pick(shown[0].key) }} />
        </div>
        {shown.length === 0 && <p className="mpk-none">No map matches.</p>}
        <div className="rgm-cards mpk-cards">
          {shown.slice(0, SHOW).map((m) => {
            const on = m.key === cur
            return (
              <button type="button" key={m.key}
                      className={'rgm-card mpk-card' + (on ? ' on' : '') + (m.art ? ' has-art' : '')}
                      style={m.art ? { backgroundImage: `url(${m.art})` } : { '--h': String(mapHue(m.key)) }}
                      onClick={() => pick(m.key)} aria-current={on || undefined}
                      title={prettyTitle(m.title, m.key)}>
                {on && <span className="rgm-cur">current</span>}
                {!m.art && <span className="mpk-stem">{String(m.key).replace(/^nazi_zombie_/, '')}</span>}
                <span className="rgm-card-name">{prettyTitle(m.title, m.key)}</span>
                <span className="rgm-card-note">{[m.author, m.year].filter(Boolean).join(' · ') || m.key}</span>
              </button>
            )
          })}
        </div>
        <div className="mpk-foot">
          {shown.length > SHOW && <span>{(shown.length - SHOW).toLocaleString()} more — type to narrow.</span>}
          {cur && <Link to={`/m/${cur}`} onClick={onClose}>Open the current map’s page</Link>}
          <Link to="/maps" onClick={onClose}>Browse and filter every map</Link>
        </div>
      </div>
    </div>,
    document.body,
  )
}
