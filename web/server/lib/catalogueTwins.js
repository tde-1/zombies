'use strict'

// Catalogue twins (B, 2026-09-23 evening: the launcher showed "Cheese Cube Unlimited: not
// playable" beside the real, box-proven `nazi_zombie_ccube_u`). A `catalogued` row is the
// crawl's record that a map exists (db/import-archive.js --catalogue). Once the pipeline has
// taken the same map for real, the stub is a twin: a second card with the same name, whose
// only message is "not playable". This hides the twin and records WHICH real map superseded
// it (`maps.superseded_by`), so the old catalogue slug still resolves -- to the real map page
// (lib/maps.js detail()).
//
// When is a stub the same map? Three signals, strongest first:
//   norm      the real map's release was fetched from THIS catalogue entry: extract.json
//             records the catalogue norm it came from, and the stub's key is `cat:<norm>`
//   post      the same release post URL (release_post) on both rows
//   size      one of the stub's download links measures exactly the real map's original (>1 MB)
//   title     the same title once lowercased with only a-z0-9 kept
//   subtitle  the stub's title starts with the real title (>= 8 chars) AND both name the same
//             author (UGX's "Cheese Cube Unlimited: Cube of Circles")
// `norm` or `post` alone is enough. `title` alone is enough only when nothing contradicts it:
// exactly one real map carries that title, and where both rows name an author or a year they
// agree (year within 1). Anything else is AMBIGUOUS: left visible and reported, never hidden.
//
// Only a VISIBLE real map (hidden=0, not broken) supersedes a stub: hiding the stub of a map
// nobody can see would leave nothing on the list.

const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const normAuthor = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '')

function sameAuthor (a, b) {
  const x = normAuthor(a); const y = normAuthor(b)
  return !x || !y || x === y || x.includes(y) || y.includes(x)
}
const sameYear = (a, b) => !a || !b || Math.abs(Number(a) - Number(b)) <= 1

/**
 * Plan the twins. `normOf` maps a real map key -> the catalogue norm its release came from
 * (extract.json), when known.
 * -> { hide: [{cat, real, why}], ambiguous: [{cat, reals, why}] }
 */
function plan (db, { normOf = {} } = {}) {
  const reals = db.prepare(`SELECT m.key, m.slug, m.title, m.author, m.year, m.release_post,
                                   (SELECT size_bytes FROM map_versions v WHERE v.map_id=m.id AND v.latest=1
                                     ORDER BY v.id DESC LIMIT 1) AS size_bytes
                            FROM maps m
                            WHERE m.source <> 'catalogue' AND m.health <> 'catalogued'
                              AND m.hidden = 0 AND m.health <> 'broken'`).all()
  // `size`: a stub whose download link measures exactly the bytes of a real map's original
  // (archive.org's `CheeseCubev1-byZK.exe` = Cheese Cube's MediaFire exe, 78,983,876 B).
  const bySize = new Map()
  for (const r of reals) if (r.size_bytes > 1e6) bySize.set(r.size_bytes, [...(bySize.get(r.size_bytes) || []), r])
  const linkSizes = db.prepare('SELECT DISTINCT size_bytes FROM archive_sources WHERE map_key=? AND size_bytes > 1000000')
  const cats = db.prepare(`SELECT key, slug, title, author, year, release_post, superseded_by FROM maps
                           WHERE source = 'catalogue' OR health = 'catalogued'`).all()
  const byTitle = new Map()
  const byPost = new Map()
  const byNorm = new Map()
  for (const r of reals) {
    const t = normTitle(r.title)
    if (t) byTitle.set(t, [...(byTitle.get(t) || []), r])
    if (r.release_post) byPost.set(r.release_post, [...(byPost.get(r.release_post) || []), r])
    if (normOf[r.key]) byNorm.set(`cat:${normOf[r.key]}`, r)
  }
  const hide = []
  const ambiguous = []
  for (const c of cats) {
    const n = byNorm.get(c.key)
    if (n) { hide.push({ cat: c.key, real: n.key, why: 'norm' }); continue }
    const p = c.release_post ? (byPost.get(c.release_post) || []) : []
    if (p.length === 1) { hide.push({ cat: c.key, real: p[0].key, why: 'post' }); continue }
    const s = [...new Set(linkSizes.all(c.key).flatMap((x) => (bySize.get(x.size_bytes) || []).map((r) => r.key)))]
    if (s.length === 1) { hide.push({ cat: c.key, real: s[0], why: 'size' }); continue }
    const t = byTitle.get(normTitle(c.title)) || []
    if (!t.length) {
      // `subtitle`: "Cheese Cube Unlimited: Cube of Circles" (UGX's thread title) for the real
      // "Cheese Cube Unlimited" -- only with the SAME author on both rows, because "Nacht der
      // Untoten Reimagined" is not "Nacht der Untoten".
      const ct = normTitle(c.title)
      // ...and only a real SUBTITLE, "<title>: <more>": "City of Hell - Next Station v1.0 (T4M)" is
      // another release of City of Hell, not the same one.
      const colon = (r) => new RegExp('^\\W*' + String(r.title).trim().split(/\W+/).filter(Boolean)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\W+') + '\\s*:', 'i').test(String(c.title))
      const pre = reals.filter((r) => normTitle(r.title).length >= 8 && ct.startsWith(normTitle(r.title)) && colon(r) &&
                                      normAuthor(c.author) && normAuthor(c.author) === normAuthor(r.author) &&
                                      sameYear(c.year, r.year))
      // nested prefixes ("Cheese Cube" and "Cheese Cube Unlimited"): the longest, most specific wins
      const best = Math.max(0, ...pre.map((r) => normTitle(r.title).length))
      const top = pre.filter((r) => normTitle(r.title).length === best)
      if (top.length === 1) hide.push({ cat: c.key, real: top[0].key, why: 'subtitle' })
      else if (top.length > 1) ambiguous.push({ cat: c.key, reals: top.map((r) => r.key), why: 'subtitle of several real maps' })
      continue
    }
    if (t.length > 1) {
      ambiguous.push({ cat: c.key, reals: t.map((r) => r.key), why: 'title matches several real maps' })
      continue
    }
    const r = t[0]
    if (!sameAuthor(c.author, r.author)) {
      ambiguous.push({ cat: c.key, reals: [r.key], why: `title only; authors differ (${c.author} / ${r.author})` })
      continue
    }
    if (!sameYear(c.year, r.year)) {
      ambiguous.push({ cat: c.key, reals: [r.key], why: `title only; years differ (${c.year} / ${r.year})` })
      continue
    }
    hide.push({ cat: c.key, real: r.key, why: 'title' })
  }
  return { hide, ambiguous }
}

/** Apply a plan: hide each twin and link it to its real map. Additive, idempotent. */
function apply (db, p) {
  const st = db.prepare('UPDATE maps SET hidden=1, superseded_by=? WHERE key=?')
  let n = 0
  db.transaction(() => { for (const h of p.hide) n += st.run(h.real, h.cat).changes })()
  return n
}

module.exports = { normTitle, plan, apply }
