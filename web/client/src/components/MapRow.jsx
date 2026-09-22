import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronIcon } from './Icons'

// A row of map cards that pages with arrows instead of a scrollbar.
//
// COPIED FROM MOVEMENT, `movement-client/src/components/MapRow.jsx`, mechanism and comments
// intact — none of it is about CS:GO and all four of its decisions cost measurement:
//
// "A page" is however many whole cards are on screen right now — not a fixed number. The
// step is measured off the real DOM (the first card's width plus the gap the grid actually
// laid out), so it stays correct across every breakpoint without a matching set of media
// queries here, and a click always lands the row on a card boundary rather than halfway
// through one.
//
// The track is still a scroll container, and deliberately: that is what keeps the keyboard
// working. Tabbing onto a card the row has paged past scrolls it into view for free, which a
// transform-based carousel would have had to reimplement — and reimplement wrongly, because
// the browser knows where focus went and we would only be guessing.
//
// The arrows are absent, not disabled, when everything already fits: an arrow that cannot do
// anything is a control asking to be clicked. At the ends of a row that does overflow they
// disable, so the row's edges are legible rather than the arrows vanishing under the cursor.

export default function MapRow({ title, blurb, count, onOpen, actions, className, children }) {
  const track = useRef(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(true)
  const [overflows, setOverflows] = useState(false)

  const measure = useCallback(() => {
    const el = track.current
    if (!el) return
    // 1px of slack: sub-pixel layout means scrollLeft rarely reaches scrollWidth-clientWidth
    // exactly, and without it the right arrow stays live on a row that is already at its end.
    const max = el.scrollWidth - el.clientWidth
    setOverflows(max > 1)
    setAtStart(el.scrollLeft <= 1)
    setAtEnd(el.scrollLeft >= max - 1)
  }, [])

  // Measure after layout rather than after paint: the first frame would otherwise draw the
  // arrows in their wrong state and correct them, which reads as a flicker on every row.
  useLayoutEffect(measure)

  useEffect(() => {
    const el = track.current
    if (!el) return undefined
    el.addEventListener('scroll', measure, { passive: true })
    // The row re-pages when the window changes, and also when the CARDS change — art loading
    // in does not move the geometry (the frame owns the height), but a row whose contents are
    // swapped does. ResizeObserver on the track catches both without a resize listener.
    let ro = null
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
      if (el.firstElementChild) ro.observe(el.firstElementChild)
    } else {
      window.addEventListener('resize', measure)
    }
    return () => {
      el.removeEventListener('scroll', measure)
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', measure)
    }
  }, [measure])

  // One page = as many whole cards as are showing. Falls back to the visible width when the
  // row is empty or the card has no measurable box yet, so a click is never a no-op.
  const page = (dir) => {
    const el = track.current
    if (!el) return
    const card = el.firstElementChild
    let step = el.clientWidth
    if (card) {
      const w = card.getBoundingClientRect().width
      const gap = parseFloat(getComputedStyle(el).columnGap || '0') || 0
      const unit = w + gap
      if (unit > 0) step = Math.max(unit, Math.floor(el.clientWidth / unit) * unit)
    }
    // No `behavior` here on purpose. The track declares `scroll-behavior: smooth` in CSS, and
    // the reduced-motion query next to it flips that to `auto` — so leaving the choice to CSS
    // is what makes these buttons honour the preference. Passing behavior:'smooth' from JS
    // overrides the stylesheet and animates for people who asked us not to.
    el.scrollBy({ left: dir * step })
  }

  const Heading = onOpen ? 'button' : 'span'
  return (
    <section className={'maprow' + (className ? ' ' + className : '')}>
      <div className="maprow-head">
        <Heading className="maprow-title" {...(onOpen ? { onClick: onOpen, type: 'button' } : {})}>{title}</Heading>
        {count != null && <span className="maprow-count">{count}</span>}
        {blurb && <span className="maprow-blurb">{blurb}</span>}
        <div className="maprow-actions">
          {actions}
          {overflows && (
            <div className="maprow-arrows">
              <button className="maprow-arrow" onClick={() => page(-1)} disabled={atStart}
                      aria-label={`Previous maps in ${title}`}>
                <ChevronIcon direction="left" />
              </button>
              <button className="maprow-arrow" onClick={() => page(1)} disabled={atEnd}
                      aria-label={`More maps in ${title}`}>
                <ChevronIcon direction="right" />
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="maprow-track" ref={track}>{children}</div>
    </section>
  )
}
