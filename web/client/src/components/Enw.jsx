import enwMark from '../assets/enw-mark.svg'

// The ENW mark standing in for the WORD "ENW" inside a line of text. Movement's
// `components/EnwWord.jsx`, verbatim: painted as a mask over currentColor so it takes the
// line's colour, sized off the line's em (theme.css .enw-inline), and read out as "ENW".
export default function EnwWord({ className = '' }) {
  return (
    <span
      className={'enw-inline' + (className ? ' ' + className : '')}
      role="img"
      aria-label="ENW"
      style={{ '--enw-mark-url': `url(${enwMark})` }}
    />
  )
}

// "ENW Zombies" in a line: the mark, a word space, the word. No lockup foot (B, 2026-09-22).
export function EnwName({ product = 'Zombies' }) {
  return <span className="enw-name"><EnwWord /> {product}</span>
}
