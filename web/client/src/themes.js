// The three per-game looks. 99 §4.10: the zombies palette is "the third per-game theme
// beside Ember and Dusk", so all three live here and Zombies is the default because this is
// the zombies site.
//
// Movement's themes.js is the model, including its warning, which applies verbatim: these
// values are written as INLINE custom properties on <html>, and an inline custom property
// BEATS the stylesheet. A stale hex here does not lose to theme.css, it silently wins over
// it — which on Movement read as two shades of orange on the same page rather than as a bug.
// If you retune a palette, retune theme.css's :root block with it.
//
// The Zombies tokens are 06 exactly: muddy olive + dried blood, low saturation, the same
// idea as Ember and Dusk.

export const THEMES = {
  zombies: {
    label: 'Zombies',
    note: 'WW2 field green with a dried-blood accent (06).',
    tokens: {
      '--bg': '#11120e',
      '--panel': '#1a1c15',
      '--panel-2': '#22241a',
      '--line': 'rgba(228,223,209,.10)',
      '--line-2': 'rgba(228,223,209,.18)',
      '--text': '#e4dfd1',
      '--muted': '#9a9684',
      '--faint': '#6e6b5d',
      '--accent': '#7b7e58',
      '--accent-2': '#565a3c',
      '--accent-ink': '#11120e',
      '--hot': '#b0342c',
      '--hot-deep': '#7a1f1b',
      '--paper': '#e9e5d8',
      '--gold': '#c9a94a',
      '--good': '#7f9a5c',
      '--bad': '#b0342c',
      '--bg-grad': 'linear-gradient(178deg,#15170f 0%,#11120e 45%,#0c0d09 100%)',
    },
  },
  ember: {
    label: 'Ember',
    note: "Movement's CS:GO look, kept so the three sites read as one family.",
    tokens: {
      '--bg': '#101010',
      '--panel': '#1a1a1a',
      '--panel-2': '#232323',
      '--line': 'rgba(255,255,255,.09)',
      '--line-2': 'rgba(255,255,255,.16)',
      '--text': '#e7e7e7',
      '--muted': '#9b9b9b',
      '--faint': '#6e6e6e',
      '--accent': '#f0962b',
      '--accent-2': '#a9671c',
      '--accent-ink': '#1d1206',
      '--hot': '#e1675a',
      '--hot-deep': '#8c3830',
      '--paper': '#efefef',
      '--gold': '#d9c148',
      '--good': '#7acf7a',
      '--bad': '#e1675a',
      '--bg-grad': 'linear-gradient(178deg,#161616 0%,#101010 45%,#0a0a0a 100%)',
    },
  },
  dusk: {
    label: 'Dusk',
    note: "Movement's CS:Source look.",
    tokens: {
      '--bg': '#0d1016',
      '--panel': '#161b24',
      '--panel-2': '#1e2531',
      '--line': 'rgba(222,231,245,.10)',
      '--line-2': 'rgba(222,231,245,.18)',
      '--text': '#dee7f5',
      '--muted': '#8e99ab',
      '--faint': '#646d7c',
      '--accent': '#4e9cee',
      '--accent-2': '#2f6aa6',
      '--accent-ink': '#0b1220',
      '--hot': '#e1675a',
      '--hot-deep': '#8c3830',
      '--paper': '#e6ecf6',
      '--gold': '#d9c148',
      '--good': '#7acf7a',
      '--bad': '#e1675a',
      '--bg-grad': 'linear-gradient(178deg,#12161f 0%,#0d1016 45%,#080a0e 100%)',
    },
  },
}

export const DEFAULT_THEME = 'zombies'
const KEY = 'zm.theme'

export function applyTheme(name) {
  const t = THEMES[name] ? name : DEFAULT_THEME
  const root = document.documentElement
  for (const [k, v] of Object.entries(THEMES[t].tokens)) root.style.setProperty(k, v)
  root.dataset.theme = t
  try { localStorage.setItem(KEY, t) } catch { /* private browsing */ }
  return t
}

export function savedTheme() {
  try { return THEMES[localStorage.getItem(KEY)] ? localStorage.getItem(KEY) : DEFAULT_THEME } catch { return DEFAULT_THEME }
}
