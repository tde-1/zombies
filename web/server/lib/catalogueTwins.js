'use strict'

// Catalogue twins (B, 2026-09-23 evening: the launcher showed "Cheese Cube Unlimited: not
// playable" beside the real, box-proven `nazi_zombie_ccube_u`). A `catalogued` row is the
// crawl's record that a map exists (db/import-archive.js --catalogue). Once the pipeline has
// taken the SAME map for real, the stub is a twin: a second card with the same name whose only
// message is "not playable". This hides the twin and records which real map superseded it
// (`maps.superseded_by`), so the old catalogue slug still resolves -- to the real map page
// (lib/maps.js detail(), which also lists a map's superseded rows as "Earlier versions").
//
// B's rule (2026-09-23 23:20, overriding the first version of this file): MAPS IN A SERIES ARE
// DISTINCT MAPS. Cheese Cube, Cheese Cube Unlimited and Cheese Cube Unlimited: Cube of Circles
// are three maps; Pokemon Kanto Carnage and its Nighttime edition are two. Only a genuinely
// identical map, or an iterative update of the same map, may be merged. So:
//
//   AUTO-HIDE   only an EXACT normalised title match (lowercase, a-z0-9 only) with exactly one
//               visible real map, and no contradiction where both rows name an author or a
//               year (year within 1).
//   REVIEW      everything looser, never hidden: the same release post, a download of exactly
//               the real original's bytes, the catalogue entry the release was fetched from,
//               a subtitle / suffix / edition word (Unlimited, Nighttime, Remastered, 2, II,
//               Reimagined, v1.1...), a title that several real maps share, or a conflict.
//               Each review row names the signal, for a person to decide.
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
 * (extract.json), when known -- a REVIEW signal only.
 * -> { hide: [{cat, real, why:'title'}], review: [{cat, reals, why}] }
 */
function plan (db, { normOf = {} } = {}) {
  const reals = db.prepare(`SELECT m.key, m.slug, m.title, m.author, m.year, m.release_post,
                                   (SELECT size_bytes FROM map_versions v WHERE v.map_id=m.id AND v.latest=1
                                     ORDER BY v.id DESC LIMIT 1) AS size_bytes
                            FROM maps m
                            WHERE m.source <> 'catalogue' AND m.health <> 'catalogued'
                              AND m.hidden = 0 AND m.health <> 'broken'`).all()
  const cats = db.prepare(`SELECT key, slug, title, author, year, release_post, superseded_by FROM maps
                           WHERE source = 'catalogue' OR health = 'catalogued'`).all()
  const byTitle = new Map(); const byPost = new Map(); const byNorm = new Map(); const bySize = new Map()
  for (const r of reals) {
    const t = normTitle(r.title)
    if (t) byTitle.set(t, [...(byTitle.get(t) || []), r])
    if (r.release_post) byPost.set(r.release_post, [...(byPost.get(r.release_post) || []), r])
    if (normOf[r.key]) byNorm.set(`cat:${normOf[r.key]}`, r)
    if (r.size_bytes > 1e6) bySize.set(r.size_bytes, [...(bySize.get(r.size_bytes) || []), r])
  }
  const linkSizes = db.prepare('SELECT DISTINCT size_bytes FROM archive_sources WHERE map_key=? AND size_bytes > 1000000')

  const hide = []
  const review = []
  for (const c of cats) {
    const ct = normTitle(c.title)
    const t = byTitle.get(ct) || []
    if (t.length === 1 && sameAuthor(c.author, t[0].author) && sameYear(c.year, t[0].year)) {
      hide.push({ cat: c.key, real: t[0].key, why: 'title' })
      continue
    }
    // Everything below is evidence for a person, never an automatic hide.
    const why = []
    const reals2 = new Set()
    if (t.length > 1) { why.push('title matches several real maps'); t.forEach((r) => reals2.add(r.key)) }
    if (t.length === 1) {
      why.push(`title matches but ${!sameAuthor(c.author, t[0].author) ? `authors differ (${c.author} / ${t[0].author})` : `years differ (${c.year} / ${t[0].year})`}`)
      reals2.add(t[0].key)
    }
    const n = byNorm.get(c.key)
    if (n) { why.push('the real release was fetched from this catalogue entry'); reals2.add(n.key) }
    for (const r of (c.release_post ? byPost.get(c.release_post) || [] : [])) { why.push('same release post'); reals2.add(r.key) }
    for (const x of linkSizes.all(c.key)) for (const r of bySize.get(x.size_bytes) || []) { why.push('a link with the same bytes'); reals2.add(r.key) }
    if (ct.length >= 6) {
      for (const r of reals) {
        const rt = normTitle(r.title)
        if (rt.length >= 6 && rt !== ct && (ct.startsWith(rt) || rt.startsWith(ct))) {
          why.push(`title is an edition / subtitle of "${r.title}"`); reals2.add(r.key)
        }
      }
    }
    if (why.length) review.push({ cat: c.key, reals: [...reals2], why: [...new Set(why)].join('; ') })
  }
  return { hide, review, ambiguous: review }
}

/** Apply a plan: hide each exact-title twin and link it to its real map. Idempotent. */
function apply (db, p) {
  const st = db.prepare('UPDATE maps SET hidden=1, superseded_by=? WHERE key=?')
  let n = 0
  db.transaction(() => { for (const h of p.hide) n += st.run(h.real, h.cat).changes })()
  return n
}

module.exports = { normTitle, plan, apply }
