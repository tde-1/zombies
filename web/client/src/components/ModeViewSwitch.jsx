import { GridIcon, ListIcon } from './Icons'

// The two ways to look at the maps, as one control. COPIED FROM MOVEMENT,
// `movement-client/src/components/ModeViewSwitch.jsx` — same markup, same classes, same
// words-and-icons rule ("an icon is a fine reminder of a control you already know and a poor
// way to introduce one"). Movement's pair is Home | Maps; ours is Cards | List (B, 2026-09-23),
// because /maps is both of Movement's pages at one address.
export default function ModeViewSwitch({ current, onGo }) {
  const opts = [
    ['cards', 'Cards', <GridIcon key="c" />, 'Rows and playlists'],
    ['list', 'List', <ListIcon key="l" />, 'Every map, searchable'],
  ]
  return (
    <div className="modeview" role="group" aria-label="How to view the maps">
      {opts.map(([key, label, icon, title]) => (
        <button
          key={key}
          className={'modeview-btn' + (current === key ? ' on' : '')}
          aria-pressed={current === key}
          title={title}
          onClick={() => { if (current !== key) onGo(key) }}
        >
          {icon}<span>{label}</span>
        </button>
      ))}
    </div>
  )
}
