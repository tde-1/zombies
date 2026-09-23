// THE AMBIENCE: the selected map's art poured behind the whole site.
//
// A port of ENW Movement's ambient system, which lives in the back half of
// `movement-client/src/themes.js` and is the mechanism B asked for by name. It is the same
// source stack, the same filmic grade, the same OKLCH tween and the same double-buffered
// backdrop. It is a file of its own here only because our `themes.js` is already the
// three-palette switcher and Movement's is not; `themes.js` re-exports it, so an import
// from either spelling works.
//
// What changed, and only this:
//
//   Movement                                    Zombies
//   a map key -> a baked thumb URL              a map row -> `maps.art`, the cover the
//   a map key -> mapColors.json (precomputed)   archive pipeline found, sampled in the
//                                               browser (data/sampleColors.js)
//   no map -> no ambience, the site's ground    no map -> the WaW default pair below
//
// The grade and the tween are copied rather than approximated because each exists for a
// specific thing that looked wrong on a screen. Sampled map colours are honest and raw — a
// neon map shouts, a night map is nearly black, and 58-92 degrees is the exact yellow-green
// band that turns a wash into pond water — so every colour is graded into one register
// before it is painted. And interpolating two colours in HSL walks through a muddy
// grey-purple midpoint, which is what every map-to-map change used to drag the page
// through, so the tween runs in OKLCH where the midpoints are the ones the eye expects.
//
// It is DOM painting outside React on purpose: six custom properties land on every frame of
// a 450 ms tween, and on a page listing two thousand maps a write to <html> re-resolves
// every node on it. They land on one element instead.

import { sampleImageColors } from './data/sampleColors'

// No map selected, and no art to sample. A colour PAIR rather than a gradient string, so the
// default goes through the identical grade, tween and projection a map does — the page with
// nothing open has to be the same kind of surface as the page with Der Riese open, or
// picking a map reads as the site changing rather than as the map arriving.
//
// ~~Muddy olive as the primary, dried blood as the crown — 06's palette.~~ **Retracted in
// place, B 2026-09-22: one theme, Movement's.** The olive pair was 06's brand palette
// arriving by the back door: with nothing selected — which is how the site opens — every
// page was washed the old theme's green, so removing the palette from themes.js and leaving
// this would have moved the brand colour rather than dropped it.
//
// The pair is now NEARLY NEUTRAL: the same two hues, at a chroma low enough that the
// grade's own floor is what you see. That is Movement's ground exactly ("the site is grey;
// the MAP you're on is the colour"), and it keeps the mechanism honest — a map with art
// still pours its real colour over this, and the crossfade between the two still runs in
// OKLCH on the same rAF.
export const WAW_DEFAULT = { h: 66, s: 3, l: 12, h2: 20, s2: 4, l2: 9 }

let baseAmb = null        // what the page is about when nothing is open or hovered
let overrideAmb = null    // the open map
let previewAmb = null     // whatever the pointer is over

const srcId = (s) => (s && s.key) || null
const srcImg = (s) => (s && s.art) || null

// A source's colour pair. Art is sampled once per URL and then remembered; a map with no
// art yet — 2,270 of the 2,284 — has no honest colour of its own, so it takes the WaW
// default rather than a hue invented from its name. An invented hue is what makes a site
// look like it is describing data it does not have.
const colors = new Map()
function colorOf(src, onReady) {
  const img = srcImg(src)
  if (!img) return WAW_DEFAULT
  if (colors.has(img)) return colors.get(img) || WAW_DEFAULT
  colors.set(img, null)   // in flight: the default stands until the sample lands
  sampleImageColors(img).then((c) => { colors.set(img, c || WAW_DEFAULT); if (onReady) onReady() })
  return WAW_DEFAULT
}

// ── the backdrop ─────────────────────────────────────────────────────────────
// The map ITSELF: its artwork projected huge, blurred and darkened behind the whole site. A
// flat synthesized hue reads like an LED strip; real art carries the organic colour
// variation that makes an atmosphere. Two stacked layers double-buffer, so a map-to-map
// change crossfades instead of popping.
let bdEl = null, bdLayers = null, bdFront = 0, bdKey = null, pourEl = null

function ensureAmbEls() {
  if (bdEl) return
  bdEl = document.createElement('div')
  bdEl.id = 'amb-backdrop'
  bdEl.setAttribute('aria-hidden', 'true')
  bdEl.innerHTML = '<div class="amb-art"></div><div class="amb-art"></div>'
  document.body.insertBefore(bdEl, document.body.firstChild)
  bdLayers = bdEl.querySelectorAll('.amb-art')
  // The pour's own node. --amb-* are registered `inherits: false` (theme.css says why), and
  // a non-inherited property cannot reach a pseudo-element, so the pour cannot be
  // .shell::before. Inserted straight after the backdrop, which keeps the paint order:
  // projection, its vignette, then the pour, then the page.
  pourEl = document.createElement('div')
  pourEl.id = 'amb-pour'
  pourEl.setAttribute('aria-hidden', 'true')
  bdEl.after(pourEl)
}

function paintBackdropArt(src) {
  ensureAmbEls()
  const img = srcImg(src)
  const id = img ? srcId(src) : null
  if (id === bdKey) return
  bdKey = id
  if (!img) { bdLayers.forEach((l) => { l.style.opacity = '0' }); return }
  const back = bdLayers[1 - bdFront]
  back.style.backgroundImage = 'url("' + img + '")'
  back.style.opacity = '1'
  bdLayers[bdFront].style.opacity = '0'
  bdFront = 1 - bdFront
}

// ── the colourist pass ───────────────────────────────────────────────────────
// One function, applied to BOTH the primary and the secondary, so the whole site's ground
// lives in one register no matter which map is on. Film grades every shot before it reaches
// an audience for the same reason.
export function gradeAmbient({ h, s, l }) {
  // Saturation: compress toward a filmic middle and hard-cap at 52. A 95%-saturated neon
  // map and a 12%-saturated concrete one both land somewhere the ground can carry; the +6
  // floor stops a truly grey map washing out to nothing.
  const gs = Math.min(52, s * 0.82 + 6)
  // Lightness: the pour must always read as LIT ground. A black map cannot drag it to
  // nothing and a snow map cannot blow it out to milk.
  const gl = 30 + l * 0.22
  // Hue: 58-92 is the harsh yellow-green nobody leaves alone. Roll it 40% of the way toward
  // 95 (olive/moss). A partial shift, not a clamp — the map keeps its identity, it just
  // stops being acidic. On this site that is also the site's own ground, which is why the
  // olive it rolls toward is the colour the page already wanted.
  const gh = h >= 58 && h <= 92 ? h + (95 - h) * 0.4 : h
  return { h: Math.round(gh), s: Math.round(gs), l: Math.round(gl) }
}

// ── sRGB <-> OKLab <-> OKLCH ─────────────────────────────────────────────────
// Bjorn Ottosson's OKLab (2020), transcribed from the reference formulas. Needed for ONE
// thing: interpolating two colours without walking through a colour neither end contains.
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

function linearRgbToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}
function oklabToLinearRgb(L, a, bb) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
}
function hslToRgb(h, s, l) {
  const S = s / 100, L = l / 100
  const k = (n) => (n + h / 30) % 12
  const a = S * Math.min(L, 1 - L)
  const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)]
}
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (!d) return [0, 0, l * 100]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return [h, s * 100, l * 100]
}
function hslToOklch({ h, s, l }) {
  const [r, g, b] = hslToRgb(h, s, l)
  const [L, A, B] = linearRgbToOklab(toLinear(r), toLinear(g), toLinear(b))
  let H = (Math.atan2(B, A) * 180) / Math.PI
  if (H < 0) H += 360
  return { L, C: Math.hypot(A, B), H }
}
function oklchToHsl({ L, C, H }) {
  const rad = (H * Math.PI) / 180
  const [r, g, b] = oklabToLinearRgb(L, C * Math.cos(rad), C * Math.sin(rad))
  // Interpolating between two in-gamut colours can graze the edge of sRGB; clamping is the
  // honest fix here — these are wash colours at 52% saturation or less, so nothing visibly
  // shifts.
  return rgbToHsl(clamp01(fromLinear(r)), clamp01(fromLinear(g)), clamp01(fromLinear(b)))
}

// ── the morph ────────────────────────────────────────────────────────────────
// One tween drives BOTH ambient colours. It is JS rather than a CSS transition on the vars
// because CSS can only interpolate them as raw numbers, which is the HSL-midpoint problem
// again. A new target mid-flight re-aims from the colour currently on screen, so sweeping
// the pointer down the map list reads as one liquid movement rather than a queue of
// restarts.
const AMB_TWEEN_MS = 450
const easeOutCubic = (t) => 1 - (1 - t) ** 3
let ambCur = null, ambFrom = null, ambTo = null, ambRaf = 0, ambT0 = 0

// Shortest way round the hue circle. An achromatic end (C near 0) has no meaningful hue, so
// it borrows the other end's — otherwise a grey map spins the wheel on the way in or out.
function lerpOklch(a, b, t) {
  const aH = a.C < 0.002 ? b.H : a.H
  const bH = b.C < 0.002 ? a.H : b.H
  const d = ((bH - aH + 540) % 360) - 180
  return { L: a.L + (b.L - a.L) * t, C: a.C + (b.C - a.C) * t, H: (aH + d * t + 360) % 360 }
}

function writeAmb(pair) {
  ensureAmbEls()
  const names = [['--amb-h', '--amb-s', '--amb-l'], ['--amb2-h', '--amb2-s', '--amb2-l']]
  pair.forEach((c, i) => {
    const hsl = oklchToHsl(c)
    names[i].forEach((n, j) => pourEl.style.setProperty(n, String(Math.round(hsl[j] * 10) / 10)))
  })
}

function ambStep(nowMs) {
  const t = Math.min(1, (nowMs - ambT0) / AMB_TWEEN_MS)
  ambCur = ambFrom.map((f, i) => lerpOklch(f, ambTo[i], easeOutCubic(t)))
  writeAmb(ambCur)
  if (t < 1) { ambRaf = requestAnimationFrame(ambStep); return }
  ambCur = ambTo
  ambRaf = 0   // idle: nothing scheduled, nothing running
}

function tweenAmb(target) {
  // First paint has nothing to move FROM, and a hidden tab never fires rAF. Both take the
  // target outright.
  if (!ambCur || document.hidden) {
    if (ambRaf) { cancelAnimationFrame(ambRaf); ambRaf = 0 }
    ambCur = target
    writeAmb(target)
    return
  }
  ambFrom = ambCur
  ambTo = target
  ambT0 = performance.now()
  if (!ambRaf) ambRaf = requestAnimationFrame(ambStep)
}

// THE MAP PAGE ONLY (B, 2026-09-23: "use the map colours very sparingly, only on the map
// page; the rest of the site is dark and black"). The ambience paints for the open map on
// /m/<key> and nothing else: home's selected map, a hover in a list or on a card, and a
// profile's banner all leave the ground black. Their calls stay (the tiers are still
// recorded), so putting a tier back is this one test, not a hunt through the pages.
const onMapPage = () => typeof location !== 'undefined' && /^\/m\/[^/]+/.test(location.pathname)

function clearAmbience() {
  if (!bdEl) return
  paintBackdropArt(null)
  const root = document.documentElement
  delete root.dataset.amb
  delete root.dataset.ambStrong
}

function paintAmbience() {
  if (!overrideAmb || !onMapPage()) { clearAmbience(); return }
  const src = overrideAmb
  ensureAmbEls()
  paintBackdropArt(src)
  const c = colorOf(src, paintAmbience)
  // The primary pours from the top; the secondary is the crown and the low corner echo.
  tweenAmb([
    hslToOklch(gradeAmbient(c)),
    hslToOklch(gradeAmbient({ h: c.h2, s: c.s2, l: c.l2 })),
  ])
  const root = document.documentElement
  // ~~Always on: "no map" is a colour here rather than an absence.~~ Retracted 2026-09-23:
  // no map is black, Movement's absence. The open map cranks the strength to match its page.
  root.dataset.amb = '1'
  root.dataset.ambStrong = '1'
}

// A source is `{ key, art }`; a map row already is one. null clears that tier.
export function setBaseAmbience(src) { baseAmb = src || null; paintAmbience() }

// Opening a map COMMITS its atmosphere, so it also ends any hover preview. React fires no
// mouseleave when the hovered row unmounts under the click, so without this the preview
// stays latched on the very map just opened — the same colour, but `data-amb-strong` is
// gated on there being no preview, so the step up to the map page's stronger projection
// never lands.
export function setAmbienceOverride(src) {
  cancelSettle()
  wantAmb = null
  previewAmb = null
  overrideAmb = src || null
  paintAmbience()
}

// ── hover the pointer did not mean ───────────────────────────────────────────
// The map list draws its whole pool in one scroll, and scrolling drags all of it under a
// stationary pointer: Chrome fires a real mouseenter/mouseleave for every row, so one flick
// of the wheel used to mean dozens of backdrop swaps, each fetching an image and re-blurring
// a full-viewport layer at 64px. None of it was hover. The reader was reading, not pointing.
//
// So a pointer's preview is a REQUEST, not a paint. While the page is moving it is banked
// and nothing is painted; when the page stops we settle on whatever the pointer actually
// ended up over. A pointer that crosses a row in under SETTLE_MS never paints it either —
// that cannot be a deliberate hover, and skipping it is what keeps a fast sweep from
// queueing a run of image fetches. The row the pointer comes to rest on always paints.
const SCROLL_IDLE_MS = 140
const SETTLE_MS = 70
let scrolling = false, scrollTimer = 0, settleTimer = 0
let wantAmb = null            // what the pointer is asking for, painted or not

function cancelSettle() { if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0 } }

function applyPreview() {
  settleTimer = 0
  if (previewAmb === wantAmb) return
  previewAmb = wantAmb
  paintAmbience()
}

function requestPreview(src) {
  wantAmb = src || null
  cancelSettle()
  if (scrolling) return   // banked; scroll-idle below reconciles it
  settleTimer = setTimeout(applyPreview, SETTLE_MS)
}

if (typeof window !== 'undefined') {
  addEventListener('scroll', () => {
    scrolling = true
    // Whatever is painted is the previous rest position; it stays until we settle again.
    cancelSettle()
    clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => { scrolling = false; applyPreview() }, SCROLL_IDLE_MS)
  }, { passive: true, capture: true })
}

// endHoverAmbience takes no arguments on purpose — it is passed straight to onMouseLeave and
// onBlur, so it must ignore the event object React hands it.
export function hoverAmbience(src) { requestPreview(src) }
export function endHoverAmbience() { requestPreview(null) }
