'use strict'
// The ENW mark for the few pages the server draws itself (a sign-in that went wrong, the
// no-build fallback). Movement's `assets/enw-mark.svg` paths in its corrected box, the same
// file as web/client/src/assets/enw-mark.svg. Inline, so the page needs no second request.

const PATH = 'M2.05 0 70 0 70 30 2.05 30ZM20.05 66 70 66 70 93.9 20.05 93.9ZM2.05 128 70 128 70 156 2.05 156ZM76.22 2.51 168 88.64 168 0 198 0 198 154.04 102.04 66.5 102.04 156 76.22 156ZM204 148.74 228.82 80.79 259.32 151.48 321.8 0 287.99 0 259.48 73.33 231.19 1.3 204 65.78Z'

function enwMarkSvg (h = 28) {
  const w = Math.round((h * 319.75 / 156) * 100) / 100
  return `<svg class="enw-mark" role="img" aria-label="ENW" viewBox="2.05 0 319.75 156" width="${w}" height="${h}"><path fill="#fff" d="${PATH}"/></svg>`
}

// The site's ground and greys (web/client/src/theme.css :root), for those pages.
const PAGE_CSS = 'html{color-scheme:dark;background:#080808}body{background:#080808 linear-gradient(178deg,#0e0e0e 0%,#080808 45%,#040404 100%) fixed;color:#e7e7e7}'

module.exports = { enwMarkSvg, PAGE_CSS, PATH }
