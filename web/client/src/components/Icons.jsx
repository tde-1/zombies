// The stroked glyph set, copied from Movement (`movement-client/src/components/ServerIcons.jsx`)
// — only the four this site actually draws. They are one language: 24x24 viewBox, no fill,
// `currentColor` at 1.8 stroke with round caps and joins, sized by `.server-icon` in
// theme.css. A glyph drawn any other way reads as borrowed from somewhere else.

export function ChevronIcon({ direction = 'right' }) {
  // One glyph, four ways — the same path rotated, rather than four paths to keep in step.
  const turn = { left: 180, up: -90, down: 90 }[direction]
  return (
    <svg className="server-icon" viewBox="0 0 24 24" aria-hidden="true"
         style={turn ? { transform: `rotate(${turn}deg)` } : undefined}>
      <path d="m9 5 7 7-7 7" />
    </svg>
  )
}

export function SearchIcon() {
  return (
    <svg className="server-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </svg>
  )
}

export function GridIcon() {
  return (
    <svg className="server-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  )
}

export function ListIcon() {
  return (
    <svg className="server-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </svg>
  )
}
