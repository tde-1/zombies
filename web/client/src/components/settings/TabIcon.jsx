// The /settings rail's tab glyphs. Gaff puts a Tabler icon beside every tab
// (WatchGame SettingsScreen.jsx `TABS[].icon`); the site does not load Tabler, so these are
// drawn in the site's own stroke language (components/Icons.jsx: 24x24, no fill,
// currentColor, round caps - sized by `.server-icon`).

const PATHS = {
  display: (<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /></>),
  graphics: (<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 16 5-5 4 4 3-3 6 6" /><circle cx="15.5" cy="9" r="1.2" /></>),
  audio: (<><path d="M4 10v4h4l5 4V6L8 10H4Z" /><path d="M16 9a4 4 0 0 1 0 6" /><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" /></>),
  controls: (<><rect x="7" y="3" width="10" height="18" rx="5" /><path d="M12 7v3" /></>),
  game: (<><circle cx="12" cy="12" r="7.5" /><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5" /></>),
  enw: (<><path d="M9 3v4M15 3v4" /><path d="M6 7h12v3a6 6 0 0 1-12 0V7Z" /><path d="M12 16v5" /></>),
  search: (<><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></>),
}

export default function TabIcon({ name }) {
  return <svg className="server-icon set-tab-icon" viewBox="0 0 24 24" aria-hidden="true">{PATHS[name] || null}</svg>
}
