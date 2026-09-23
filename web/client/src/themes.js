// ONE SKIN, AND IT IS MOVEMENT'S (B, 2026-09-22).
//
// ~~The three per-game looks.~~ **Retracted in place.** This file used to hold three
// palettes — Zombies (olive + dried blood), Ember (Movement's CS:GO orange) and Dusk
// (CS:Source blue) — behind a dropdown in the nav. B cut all of it: "one theme, Movement's.
// Remove the Zombies / Ember / Dusk theme dropdown and the extra palettes."
//
// The reasoning is Movement's own, and it is the sentence at the top of its theme.css: the
// site is grey, and THE MAP YOU ARE ON IS THE COLOUR. A palette switcher on a site whose
// whole ground is already painted by the open map's artwork (`ambience.js`, §10b) was two
// systems competing to say what colour the page is, and the one with a saved preference in
// localStorage always won the argument by default. Gold and green survive as data
// semantics — a record you hold, a map you have beaten — and nothing else on the page has a
// hue that did not come out of a screenshot.
//
// The tokens below are Movement's `:root` verbatim (movement-client/src/theme.css, the
// "Radio" block) — including its derived OKLCH signal family, which is measured rather than
// eyeballed and whose comment is copied into theme.css beside the values.
//
// MOVEMENT'S WARNING STILL APPLIES, and now more sharply, because there is only one palette
// left to get wrong: these values are written as INLINE custom properties on <html>, and an
// inline custom property BEATS the stylesheet. A stale hex here does not lose to theme.css,
// it silently wins over it. theme.css's `:root` block holds the identical values; if you
// retune one, retune both.

export const MOVEMENT = {
  label: 'Movement',
  note: "Movement's one skin. Neutral grey ground; the map is the colour.",
  tokens: {
    // Black mainly (B, 2026-09-23): Movement's ground eight steps down. theme.css says why.
    '--bg': '#080808',
    '--panel': 'rgba(255,255,255,.05)',
    '--panel-2': 'rgba(255,255,255,.085)',
    '--panel-solid': '#141414',
    '--panel-deep': '#040404',
    '--line': 'rgba(255,255,255,.09)',
    '--line-2': 'rgba(255,255,255,.16)',
    '--text': '#e7e7e7',
    '--muted': '#9b9b9b',
    '--faint': '#6e6e6e',
    // Near-white, zero hue. On Movement the accent is HIERARCHY, not a colour: it is how a
    // chip says "on" and how a button says "this is the one". The olive that used to be
    // here was the site's own brand green, which is exactly the thing B asked to lose.
    '--accent': '#d9d9d9',
    '--accent-2': '#a8a8a8',
    '--accent-soft': 'rgba(217,217,217,.12)',
    '--accent-ink': '#161616',
    // `--hot` is this site's own token (the archive's "broken", a refusal, a destructive
    // button). It takes Movement's --bad so there is one red on the page rather than two.
    '--hot': '#e1675a',
    '--hot-deep': '#8c3830',
    '--hot-soft': 'rgba(225,103,90,.14)',
    '--paper': '#efefef',
    '--gold': '#d9c148',
    '--good': '#7acf7a',
    '--bad': '#e1675a',
    '--text-rgb': '231,231,231',
    '--accent-rgb': '217,217,217',
    '--gold-rgb': '217,193,72',
    '--good-rgb': '122,207,122',
    '--bad-rgb': '225,103,90',
    '--scrim-rgb': '12,12,12',
    '--bg-grad': 'linear-gradient(178deg,#0e0e0e 0%,#080808 45%,#040404 100%)',
  },
}

const KEY = 'zm.theme'

/**
 * Paint the one skin. Still a function, and still called once on boot, for two reasons: the
 * ambient system reads `--bg` and the `--*-rgb` channels off the computed style, and a page
 * opened by somebody who used the old dropdown has a `zm.theme` in localStorage and a
 * `data-theme` this would otherwise leave saying "ember".
 */
export function applyTheme() {
  const root = document.documentElement
  for (const [k, v] of Object.entries(MOVEMENT.tokens)) root.style.setProperty(k, v)
  root.dataset.theme = 'movement'
  // The old preference is REMOVED rather than ignored. Left in place it would be a saved
  // choice that nothing reads, waiting to confuse the next person who greps for it.
  try { localStorage.removeItem(KEY) } catch { /* private browsing */ }
  return 'movement'
}

// The ambient system — the selected map's art poured behind the whole site — is
// `ambience.js`. On Movement it is the back half of this file. Re-exported so an import from
// either spelling works.
export { setBaseAmbience, setAmbienceOverride, hoverAmbience, endHoverAmbience, gradeAmbient, WAW_DEFAULT } from './ambience'
