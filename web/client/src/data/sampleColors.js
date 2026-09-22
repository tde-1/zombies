// Dominant colour PAIR of an image, sampled IN THE BROWSER.
//
// **Copied verbatim from ENW Movement** (`movement-client/src/data/sampleColors.js`), B's
// ground rule: copy Movement, change only what zombies needs. Nothing needed changing.
//
// Movement bakes map colours offline (`scripts/build-map-colors.js` walks its whole mirror
// into `mapColors.json`) and keeps this runtime copy only for art it cannot precompute — a
// profile banner, uploaded whenever. Zombies has the opposite shape: the map art arrives
// from the archive pipeline whenever a cover is found, fourteen so far out of 2,284, and a
// baked table would be stale the next time the crawler finds one. So on this site this IS
// the extractor, for every map, with the per-URL memo below doing the work the bake did.
//
// Cost: one 160px-wide canvas, two passes over ~16k pixels. Sub-millisecond, off the paint
// path (it runs after the image has loaded, which it already had to for the card), and
// memoised per URL so re-opening a map is free.

const SAMPLE_W = 160         // downsample width — the histogram wants coverage, not detail
const MIN_CHROMA = 0.09      // below this a pixel reads as grey
const MIN_VALUE = 0.10       // near-black pixels carry no usable hue
const MAX_LIGHT = 0.92       // blown-out sky/white
const MIN_COLOURFUL = 0.02   // <2% colourful pixels -> the image is grey
const SECOND_EXCLUDE = 40    // zero this far either side of the primary before hunting again
const SECOND_MIN_MASS = 0.18 // a second ridge under 18% of the primary's mass isn't a colour

// circular box smooth of the chroma histogram, ±10°
function smoothBins(bins) {
  const out = new Float64Array(360)
  for (let h = 0; h < 360; h++) {
    let s = 0
    for (let d = -10; d <= 10; d++) s += bins[(h + d + 360) % 360]
    out[h] = s
  }
  return out
}

// The tallest ridge in a smoothed histogram, plus the circular weighted mean of the RAW bins
// within ±20° of it — so the answer sits on the ridge rather than on a bin edge.
function peakOf(bins, smooth) {
  let peak = 0
  for (let h = 1; h < 360; h++) if (smooth[h] > smooth[peak]) peak = h
  let sx = 0, sy = 0
  for (let d = -20; d <= 20; d++) {
    const h = (peak + d + 360) % 360
    const rad = (h * Math.PI) / 180
    sx += bins[h] * Math.cos(rad)
    sy += bins[h] * Math.sin(rad)
  }
  let mean = Math.round((Math.atan2(sy, sx) * 180) / Math.PI)
  if (mean < 0) mean += 360
  return { peak, mass: smooth[peak], mean: mean % 360 }
}

// Representative saturation + lightness for one hue: mean HSL s/l over the pixels whose hue
// sits within ±25° of it (all pixels for a grey image).
function slForHue(rgba, px, mean, isGrey) {
  let sSum = 0, lSum = 0, n = 0
  for (let i = 0; i < px; i++) {
    const o = i * 4
    const r = rgba[o] / 255, g = rgba[o + 1] / 255, b = rgba[o + 2] / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const c = max - min
    const l = (max + min) / 2
    if (max < MIN_VALUE || l > MAX_LIGHT) continue
    let h = 0
    if (c > 0) {
      if (max === r) h = ((g - b) / c) % 6
      else if (max === g) h = (b - r) / c + 2
      else h = (r - g) / c + 4
      h = Math.round(h * 60)
      if (h < 0) h += 360
    }
    const dh = Math.min(Math.abs(h - mean), 360 - Math.abs(h - mean))
    if (!isGrey && dh > 25) continue
    const s = l === 0 || l === 1 ? 0 : c / (1 - Math.abs(2 * l - 1))
    sSum += Math.min(1, s); lSum += l; n++
  }
  if (!n) return null
  return [Math.round((sSum / n) * 100), Math.round((lSum / n) * 100)]
}

// Chroma-weighted circular histogram. The primary is the tallest ridge; the secondary is the
// tallest ridge LEFT once everything within ±40° of the primary is zeroed — a genuinely
// different colour, not the shoulder of the same one. A mono-colour image gets a darker,
// quieter copy of its primary rather than a hue plucked out of the noise floor.
function dominantPair(rgba, px) {
  const bins = new Float64Array(360)
  let sampled = 0, colourful = 0
  for (let i = 0; i < px; i++) {
    const o = i * 4
    if (rgba[o + 3] < 128) continue   // transparent pixels aren't part of the picture
    const r = rgba[o] / 255, g = rgba[o + 1] / 255, b = rgba[o + 2] / 255
    sampled++
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const c = max - min
    const l = (max + min) / 2
    if (c < MIN_CHROMA || max < MIN_VALUE || l > MAX_LIGHT) continue
    colourful++
    let h
    if (max === r) h = ((g - b) / c) % 6
    else if (max === g) h = (b - r) / c + 2
    else h = (r - g) / c + 4
    h = Math.round(h * 60)
    if (h < 0) h += 360
    bins[h % 360] += c
  }
  // A near-grey image is still a colour: report its (weak) hue with its REAL low saturation.
  const isGrey = !sampled || colourful / sampled < MIN_COLOURFUL

  const first = peakOf(bins, smoothBins(bins))
  const sl1 = slForHue(rgba, px, first.mean, isGrey)
  if (!sl1) return null
  const primary = { h: first.mean, s: sl1[0], l: sl1[1] }
  const mono = { h2: primary.h, s2: Math.round(primary.s * 0.8), l2: Math.round(primary.l * 0.75) }
  if (isGrey) return { ...primary, ...mono }

  const bins2 = Float64Array.from(bins)
  for (let d = -SECOND_EXCLUDE; d <= SECOND_EXCLUDE; d++) bins2[(first.peak + d + 360) % 360] = 0
  const second = peakOf(bins2, smoothBins(bins2))
  if (!second.mass || second.mass < first.mass * SECOND_MIN_MASS) return { ...primary, ...mono }
  const sl2 = slForHue(rgba, px, second.mean, false)
  if (!sl2) return { ...primary, ...mono }
  return { ...primary, h2: second.mean, s2: sl2[0], l2: sl2[1] }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // Same-origin art (/banners/…) needs no opt-in; anything else has to volunteer CORS or the
    // canvas is tainted and getImageData throws. Either way a failure just costs the ambience.
    try { if (new URL(url, location.href).origin !== location.origin) img.crossOrigin = 'anonymous' }
    catch (e) { /* a relative URL we can't parse is same-origin by definition */ }
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url   // already in cache from the cover, in the profile case
  })
}

// url -> Promise<{h,s,l,h2,s2,l2}|null>. Cached forever: a banner URL is content-addressed
// (the filename changes when the image does), so a hit can never be stale.
const cache = new Map()
export function sampleImageColors(url) {
  if (!url) return Promise.resolve(null)
  if (cache.has(url)) return cache.get(url)
  const p = loadImage(url).then((img) => {
    const w = Math.max(1, Math.min(SAMPLE_W, img.naturalWidth || SAMPLE_W))
    const h = Math.max(1, Math.round(w * ((img.naturalHeight || 1) / (img.naturalWidth || 1))))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: false })
    if (!ctx) return null
    // Nearest-neighbour, not smoothed: averaging neighbours greys out the very chroma the
    // histogram weighs by. This makes the downsample a plain stride over the source pixels,
    // which is exactly what the offline extractor does.
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    return dominantPair(data, w * h)
  }).catch(() => null)
  cache.set(url, p)
  return p
}
