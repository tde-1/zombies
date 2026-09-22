import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronIcon } from './Icons'

// THE way back to the map list — Movement's `components/ModeBack.jsx`, same control, same
// place (the top-left corner of the page, outside the page's own panels), same class names.
// Movement's label is the mode ("ENW Surf"); Zombies has one mode, so it says Maps.
//
// Where it goes is Movement's closeMap rule: back to the list you came from when you came
// from one (the pool on /maps with its filters, or home), otherwise the whole list.
// `state.back` is set by whoever opened the map page (the rail's server card, a list row).
export default function BackButton({ label = 'Maps', onClick }) {
  const nav = useNavigate()
  const loc = useLocation()
  const back = loc.state && typeof loc.state.back === 'string' ? loc.state.back : null
  const go = onClick || (() => {
    if (back && (back === '/' || back.startsWith('/maps'))) nav(back)
    else nav('/maps')
  })
  return (
    <div className="hub-top-back">
      <button type="button" className="hub-back" onClick={go} title={`Back to ${label}`}>
        <ChevronIcon direction="left" />
        <span className="hub-back-k">{label}</span>
      </button>
    </div>
  )
}
