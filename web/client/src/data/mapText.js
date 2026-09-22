// How a map is WRITTEN, in one place — because B's rule for the entry is a rule about order
// and it has to be the same order in the list, on a card and in a search hit:
//
//     name        "Clinic of Evil"
//     subtitle    the bsp name — `sanatorium`, `nazi_zombie_leviathan`
//     author
//     release date
//
// And what is NOT written: **no finish words under a map.** "Buyable Ending · Easter Egg ·
// Round 20" came off the list and the card entirely (B, 2026-09-22). Those three remain
// FILTERS, which is where they answer a question somebody asked, rather than a label under
// every map, which is where they were three more words to read two thousand times. The map's
// own page still states what counts as beating it, from the referee manifest, because that
// is a page somebody opened to find out.

// Titles come out of the archive crawl SHOUTING — "CLINIC OF EVIL", "ABANDONED SCHOOL" —
// because that is how they were typed on the forum posts they were scraped from. B writes
// them as "Clinic of Evil", so an all-caps title is title-cased for display and a title that
// already has case of its own is left exactly alone. Never written back to the database: the
// crawl records what the source said, and this is a reading of it.
const SMALL = new Set(['of', 'the', 'and', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'de', 'der', 'die', 'das', 'von'])
export function prettyTitle(title, key) {
  const t = String(title || '').trim()
  if (!t) return String(key || '').replace(/^nazi_zombie_/, '')
  // Has this title any lower case in it at all? If it has, somebody chose the case and we
  // keep it — "UGX Requiem" and "BO2 Hijacked Zombies" are right as they stand.
  if (/[a-z]/.test(t)) return t
  return t.toLowerCase().replace(/[^\s\-/]+/g, (w, i) => (
    i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)
  ))
}

// The bsp name, as the subtitle. It is printed WHOLE — `nazi_zombie_leviathan`, not
// `leviathan` — because it is the filename the player will see in their mods folder, in a
// download and in the console, and a subtitle that quietly drops the prefix is a second
// spelling of the one identifier the game actually uses.
export const bspOf = (m) => (m && m.key) || ''

// The release date, as one short readable string. `released_at` is when the map came out;
// `year` is all the crawl could recover for most of them, and that is stated as the year
// rather than dressed up as a date. Nothing is invented: a map with neither gets nothing,
// and the caller prints no separator for it.
export function releasedOf(m) {
  if (!m) return null
  if (m.released_at) {
    const d = new Date(m.released_at)
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' })
  }
  return m.year ? String(m.year) : null
}

// The card's own hue, for the wash behind it (`--h` on `.map-card`, Movement's rule). Real
// colour comes from the artwork and is sampled in the browser (ambience.js); this is the
// holding colour a card is drawn in before — or instead of — a picture, and it is derived
// from the engine key so a map is always the same colour on every surface. Neutral-ish on
// purpose: the site is grey and the MAP is the colour, so a map with no art gets a tint, not
// a paint job.
export function mapHue(key) {
  const s = String(key || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}
