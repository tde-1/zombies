'use strict'

// Import the archive agent's work into the site.
//
// Two sources, two very different kinds of thing, and conflating them would be the whole
// bug:
//
//   archive/manifests/*.json      maps the PIPELINE TOOK END TO END — fetched, hashed,
//                                 AV-scanned, extracted without running an installer,
//                                 normalised to mods/<map>/ and scanned for a finish.
//                                 These have an engine key, a real sha256 of the original,
//                                 a source URL and a referee manifest. They are maps.
//
//   <archive work>/reports/catalogue.json
//                                 the CRAWL: every map anybody has ever heard of, with its
//                                 names, authors, tags, release posts and download links,
//                                 and whether those links are still alive. 2,276 of them.
//                                 Most have never been fetched. They are not maps yet —
//                                 they are a record that a map existed.
//
// So the first becomes a playable map row; the second becomes a `catalogued` row that the
// Maps list hides and the Archive page shows, which is exactly what 99 §4.8 asks for
// ("maps broken on our servers are hidden from the Maps list; they're listed on the
// Archive page"). Calling a crawl result playable would put maps in the browser that
// nobody has ever booted.
//
//   node server/db/import-archive.js                 the pipeline maps only
//   node server/db/import-archive.js --catalogue     also the 2,276-map index
//   node server/db/import-archive.js --dry           say what would change, change nothing
//   node server/db/import-archive.js --maps-list ../archive/tranche2.txt   only those maps
//   node server/db/import-archive.js --guides        the Easter egg / power / song guides only
//                                                    (reports/map_guides.json, lib/guides.js)
//
// Re-runnable. It never downgrades a map that already has a referee manifest
// (`referee/manifests/`), because that one was read by a human and this one was not.

const fs = require('fs')
const path = require('path')

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
// --maps-list <file>: only the manifests whose `map` is listed (one bsp per line, `#`
// comments). A tranche's import touches its own rows and nothing else (archive.md s12).
const ONLY = (() => {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--maps-list')
  if (i < 0) return null
  const s = new Set()
  for (const ln of fs.readFileSync(argv[i + 1], 'utf8').split(/\r?\n/)) {
    const b = ln.split('#')[0].trim().split(/\s+/)[0]
    if (b) s.add(b)
  }
  return s
})()

const { db, now } = require('./database')
const { slugify } = require('../lib/util')

const REPO = path.resolve(__dirname, '..', '..', '..')
const ARCHIVE_MANIFESTS = process.env.ZM_ARCHIVE_MANIFESTS || path.join(REPO, 'archive', 'manifests')
const REFEREE_MANIFESTS = path.join(REPO, 'referee', 'manifests')
const WORK = process.env.ZM_ARCHIVE_WORK || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'archive')
const CATALOGUE = process.env.ZM_ARCHIVE_CATALOGUE || path.join(WORK, 'reports', 'catalogue.json')

// Map art (the archive lane's media step, 2026-09-22). A manifest's `archive.cover` is a
// path RELATIVE TO THE ARCHIVE WORK DIRECTORY — `media/<bsp>/<file>` — which is on a dev
// box, outside the repo, and not reachable by a browser. So the importer COPIES the one
// cover per map into `web/public/media/maps/`, where `server/index.js` serves it at
// `/media/maps/<file>`, and `maps.art` holds that URL.
//
// A copy rather than a second static root over `ZombiesDev`, for two reasons. The site has
// to be servable from a machine that is not this one — the day it moves off B's PC, a
// static mount of a dev-box path is a dead image on every card. And a directory the
// archive pipeline writes into is not a directory the public web server should be reading
// out of: a file lands there the moment it is fetched, before it has been AV-scanned or
// even finished writing.
//
// The copies are content-addressed by nothing and named by the map, so a re-import
// overwrites in place and the URL never changes. They are gitignored: they are derived
// from the archive and `npm run import:archive` puts them back.
const MEDIA_OUT = process.env.ZM_MEDIA_DIR || path.join(__dirname, '..', '..', 'public', 'media', 'maps')
const MEDIA_URL = '/media/maps'
const COVER_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

const MAX_DESC = 4000
const MAX_CATALOGUE_DESC = 1200

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

// Maps the referee agent read by hand. Those rows are theirs; this importer may add files
// and sources to them but must not rewrite their title, finish or health.
const refereeOwned = new Set(
  (fs.existsSync(REFEREE_MANIFESTS) ? fs.readdirSync(REFEREE_MANIFESTS) : [])
    .filter((f) => f.endsWith('.json'))
    .map((f) => (readJson(path.join(REFEREE_MANIFESTS, f)) || {}).map)
    .filter(Boolean),
)

const stats = { maps: 0, updated: 0, versions: 0, files: 0, sources: 0, tags: 0, covers: 0, catalogued: 0, skipped: 0 }

function tagId(slug, label, kind, sort) {
  db.prepare('INSERT OR IGNORE INTO tags (slug, label, kind, sort_order) VALUES (?,?,?,?)')
    .run(slug, label || slug, kind || 'trait', sort || 90)
  const r = db.prepare('SELECT id FROM tags WHERE slug=?').get(slug)
  return r ? r.id : null
}

// The crawlers' tag vocabulary is not ours: they emit `easter_egg`, we call it
// `easter-egg`; they emit `top100` and `top_100` for the same thing. Normalise here rather
// than letting two spellings of one tag into the filter dropdown.
const TAG_MAP = {
  easter_egg: ['easter-egg', 'Easter Egg', 'finish', 10],
  buyable_ending: ['buyable-ending', 'Buyable Ending', 'finish', 11],
  top100: ['top-100', 'Top 100', 'list', 50],
  top_100: ['top-100', 'Top 100', 'list', 50],
  remake: ['remake', 'Remake', 'style', 20],
  horror: ['horror', 'Horror', 'style', 24],
}
function applyTags(mapId, raw) {
  for (const t of raw || []) {
    const spec = TAG_MAP[t] || [slugify(String(t)), String(t).replace(/_/g, ' '), 'trait', 90]
    const id = tagId(spec[0], spec[1], spec[2], spec[3])
    if (!id) continue
    const r = db.prepare('INSERT OR IGNORE INTO map_tags (map_id, tag_id) VALUES (?,?)').run(mapId, id)
    if (r.changes) stats.tags++
  }
}

// ---- 1. the maps the pipeline actually took ------------------------------------------
function importPipelineMaps() {
  if (!fs.existsSync(ARCHIVE_MANIFESTS)) { console.log(`no archive manifests at ${ARCHIVE_MANIFESTS}`); return }
  for (const f of fs.readdirSync(ARCHIVE_MANIFESTS).filter((x) => x.endsWith('.json'))) {
    const m = readJson(path.join(ARCHIVE_MANIFESTS, f))
    if (!m || !m.map) continue
    if (ONLY && !ONLY.has(m.map)) continue
    if (refereeOwned.has(m.map)) { stats.skipped++; continue }

    const a = m.archive || {}
    const finishes = m.finishes || []
    const ids = finishes.map((x) => (typeof x === 'string' ? x : x.id))
    const hasEe = ids.includes('easter_egg') ? 1 : 0
    const hasBuyable = ids.includes('buyable_ending') ? 1 : 0

    // Health, honestly. Nothing here has been booted on a server, so nothing here is
    // `verified` — that word is reserved for a map somebody has watched run. A manifest
    // the scanner could not decide (`needs_human`, or a `manual` verdict) is `custom-only`:
    // it will probably run, but we cannot referee a finish on it, so it must not offer
    // Verified play.
    const scannerVerdict = (m.scanner && m.scanner.verdict) || null
    const undecided = !!m.needs_human || scannerVerdict === 'manual'
    // A manifest the dedi proof marked `health: "broken"` (archive.md §10: the map did not
    // reach map_loaded on the box, or died right after) stays broken — the Maps list hides
    // it and a lease refuses it. Any other `health` value is not this importer's to trust.
    const health = m.health === 'broken' || scannerVerdict === 'not_a_zombies_map' ? 'broken'
      : undecided ? 'custom-only' : 'playable'

    const desc = (a.catalogue_description || '').trim().slice(0, MAX_DESC) || null
    const released = m.released ? Date.parse(m.released) : null
    const year = m.released ? Number(String(m.released).slice(0, 4)) : null

    const existing = db.prepare('SELECT * FROM maps WHERE key=?').get(m.map)
    if (DRY) { console.log(`${existing ? 'update' : 'insert'} ${m.map} (${health})`); continue }

    db.prepare(`INSERT INTO maps (key, slug, title, author, year, source, health, hidden, main_finish, round_n,
                  has_ee, has_buyable, description, release_post, released_at, added_at)
                VALUES (@key,@slug,@title,@author,@year,'custom',@health,@hidden,@main_finish,@round_n,
                  @has_ee,@has_buyable,@description,@release_post,@released_at,@added_at)
                ON CONFLICT(key) DO UPDATE SET
                  hidden=CASE WHEN @hidden_set=1 THEN excluded.hidden ELSE maps.hidden END,
                  title=excluded.title, author=COALESCE(excluded.author, maps.author),
                  year=COALESCE(excluded.year, maps.year), health=excluded.health,
                  main_finish=excluded.main_finish, round_n=excluded.round_n,
                  has_ee=excluded.has_ee, has_buyable=excluded.has_buyable,
                  description=COALESCE(excluded.description, maps.description),
                  release_post=COALESCE(excluded.release_post, maps.release_post),
                  released_at=COALESCE(excluded.released_at, maps.released_at)`)
      .run({
        key: m.map,
        slug: uniqueSlug(m.title || m.map, m.map),
        title: m.title || m.map,
        author: m.author || null,
        year,
        health,
        // `site_hidden` (archive.md s12, tranche 2): phase 1 imports a staged map BEFORE its box
        // proof so `lease-cli --proof` has a row and an fs_game to boot; `true` keeps it off
        // every list until `popular.py --apply` writes the result and sets it `false`. A
        // manifest without the key leaves `maps.hidden` alone (an admin may have set it).
        hidden: m.site_hidden === true ? 1 : 0,
        hidden_set: typeof m.site_hidden === 'boolean' ? 1 : 0,
        main_finish: (m.badge && m.badge.main_finish) || 'round',
        round_n: (m.badge && m.badge.round_n) || 20,
        has_ee: hasEe,
        has_buyable: hasBuyable,
        description: desc,
        release_post: a.source_page || null,
        released_at: released,
        added_at: now(),
      })
    existing ? stats.updated++ : stats.maps++

    const map = db.prepare('SELECT * FROM maps WHERE key=?').get(m.map)
    applyTags(map.id, a.catalogue_tags)

    // The cover, if the media step got one. Written after the map row exists so a failed
    // copy leaves a map with no art rather than a map with a broken one.
    // ...but never over tools/maps/map_art.py's output (2026-09-22). That script owns the
    // picture for every map now — it reads this same cover as its first choice and writes a
    // web-sized copy with a thumb beside it — so a re-import that put the raw cover back
    // would take the thumb away from every card showing this map.
    const art = importCover(m.map, a.cover)
    if (art) {
      db.prepare("UPDATE maps SET art=? WHERE id=? AND (art IS NULL OR art NOT LIKE '/media/maps/%.webp%')").run(art, map.id)
      stats.covers++
    }

    // The version, and the ORIGINAL as a file row. 99 §4.8: originals are sacred — the
    // exact file, its sha256, where it came from and when. That is this row, and nothing
    // in the site may rewrite its hash.
    const version = versionOf(m)
    db.prepare(`INSERT OR IGNORE INTO map_versions (map_id, version, latest, health, fs_game, notes, size_bytes, sha256, released_at, added_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(map.id, version, 1, health, m.fs_game || null, m.notes || null,
        a.original_size || null, a.original_sha256 || null, released, now())
    const v = db.prepare('SELECT * FROM map_versions WHERE map_id=? AND version=?').get(map.id, version)
    if (v && !v.latest) db.prepare('UPDATE map_versions SET latest=0 WHERE map_id=?').run(map.id)
    db.prepare('UPDATE map_versions SET latest=1 WHERE id=?').run(v.id)
    stats.versions++

    if (a.original && a.original_sha256) {
      const r = db.prepare(`INSERT OR IGNORE INTO map_files (map_version_id, path, sha256, size, kind, source_url, fetched_at)
                            VALUES (?,?,?,?, 'original', ?, ?)`)
        .run(v.id, a.original, a.original_sha256, a.original_size || null, a.source_url || null,
          a.fetched ? Date.parse(a.fetched) : null)
      if (r.changes) stats.files++
    }
    for (const [p, h] of Object.entries(m.script_fingerprints || {})) {
      db.prepare(`INSERT OR IGNORE INTO map_files (map_version_id, path, sha256, kind, fetched_at) VALUES (?,?,?, 'script', ?)`)
        .run(v.id, p, h, now())
    }

    db.prepare(`INSERT INTO manifests (map_version_id, map_key, schema, confidence, json, imported_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(map_version_id) DO UPDATE SET json=excluded.json, confidence=excluded.confidence, imported_at=excluded.imported_at`)
      .run(v.id, m.map, m.schema || 'enw.referee.manifest/0', m.confidence || null, JSON.stringify(m), now())

    for (const [url, kind] of [[a.source_url, 'download'], [a.source_page, 'page']]) {
      if (!url) continue
      const r = db.prepare(`INSERT OR IGNORE INTO archive_sources (url, site, kind, map_key, status, note, last_checked, created_at)
                            VALUES (?,?,?,?, 'fetched', ?, ?, ?)`)
        .run(url, hostOf(url), kind, m.map, a.av ? `AV: ${a.av}` : null, a.fetched ? Date.parse(a.fetched) : null, now())
      if (r.changes) stats.sources++
    }
  }
}

/**
 * Copy one map's cover out of the archive work directory and into the site's media
 * directory. Returns the URL to store in `maps.art`, or null.
 *
 * Nothing here trusts the manifest's path. It is resolved against the work directory and
 * then checked to still be inside it, because a `cover` of `../../../Windows/win.ini`
 * would otherwise be copied into a directory this server publishes. The extension is
 * allow-listed for the same reason: the file is going somewhere a browser will fetch it
 * from, and `.html` there is a script on our own origin.
 */
function importCover(mapKey, cover) {
  if (!cover) return null
  const src = path.resolve(WORK, String(cover))
  const root = path.resolve(WORK) + path.sep
  if (!src.startsWith(root)) { console.warn(`  cover for ${mapKey} points outside the archive: ${cover}`); return null }
  const ext = path.extname(src).toLowerCase()
  if (!COVER_EXT.has(ext)) { console.warn(`  cover for ${mapKey} is not an image: ${cover}`); return null }
  if (!fs.existsSync(src)) { console.warn(`  cover for ${mapKey} is missing: ${src}`); return null }
  const name = `${mapKey}${ext}`
  const dest = path.join(MEDIA_OUT, name)
  if (DRY) return `${MEDIA_URL}/${name}`
  try {
    fs.mkdirSync(MEDIA_OUT, { recursive: true })
    // Only when it changed: a re-import of fourteen maps should not rewrite fourteen files
    // and bump every mtime the browser caches against.
    const s1 = fs.statSync(src)
    let same = false
    try { const s2 = fs.statSync(dest); same = s2.size === s1.size && s2.mtimeMs >= s1.mtimeMs } catch { /* not copied yet */ }
    if (!same) fs.copyFileSync(src, dest)
  } catch (e) {
    console.warn(`  cover for ${mapKey} could not be copied: ${e.message}`)
    return null
  }
  return `${MEDIA_URL}/${name}`
}

function versionOf(m) {
  // The crawlers put the version in the filename more often than in a field
  // (`nazi_zombie_leviathan_v1.2.exe`). Read it if it is there; "1.0" if it is not, which
  // is a claim about our numbering, not about the author's.
  const f = (m.archive && m.archive.original) || ''
  const hit = String(f).match(/[_-]v?(\d+(?:\.\d+)*)\.[a-z0-9]{2,4}$/i)
  return hit ? hit[1] : '1.0'
}

const hostOf = (u) => { try { return new URL(u).host } catch { return null } }

function uniqueSlug(title, key) {
  const base = slugify(title)
  const taken = db.prepare('SELECT key FROM maps WHERE slug=?').get(base)
  if (!taken || taken.key === key) return base
  // The one fallback could itself be taken (tranche 2, 2026-09-23: "Perk A Cola Inc" met a
  // catalogue row AND that row's own suffixed slug, and the whole import died on UNIQUE).
  // A map that already has a row keeps its slug; otherwise try the key suffix, then numbers.
  const own = db.prepare('SELECT slug FROM maps WHERE key=?').get(key)
  if (own && own.slug) return own.slug
  for (let i = 0; i < 50; i++) {
    const s = i === 0 ? `${base}-${slugify(key).slice(-8)}` : `${base}-${slugify(key).slice(-8)}-${i + 1}`
    const t = db.prepare('SELECT key FROM maps WHERE slug=?').get(s)
    if (!t || t.key === key) return s
  }
  return `${base}-${slugify(key)}`
}

// ---- 2. the crawl index ----------------------------------------------------------------
function importCatalogue() {
  if (!fs.existsSync(CATALOGUE)) {
    console.log(`no catalogue at ${CATALOGUE} — run \`python archive/export.py\` first`)
    return
  }
  const rows = readJson(CATALOGUE)
  if (!Array.isArray(rows)) { console.log('the catalogue is not an array'); return }
  console.log(`catalogue: ${rows.length} entries`)

  const known = new Set(db.prepare("SELECT key FROM maps WHERE source <> 'catalogue'").all().map((r) => r.key))
  const knownNorm = new Set([...known].map((k) => norm(k)))

  const insMap = db.prepare(`INSERT INTO maps (key, slug, title, author, year, source, health, hidden, description, release_post, released_at, added_at)
      VALUES (@key,@slug,@title,@author,@year,'catalogue','catalogued',0,@description,@release_post,@released_at,@added_at)
      ON CONFLICT(key) DO UPDATE SET
        title=excluded.title, author=COALESCE(excluded.author, maps.author),
        description=COALESCE(excluded.description, maps.description),
        release_post=COALESCE(excluded.release_post, maps.release_post),
        released_at=COALESCE(excluded.released_at, maps.released_at)`)
  // The link's size rides along (2026-09-22) and is refreshed on a re-import: the checker
  // measures it, and the map page says how big a map is from it.
  const insSrc = db.prepare(`INSERT INTO archive_sources (url, site, kind, map_key, status, http_status, note, last_checked, created_at, size_bytes)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(url, map_key) DO UPDATE SET size_bytes=COALESCE(excluded.size_bytes, archive_sources.size_bytes)`)

  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.norm) continue
      // A map the pipeline already took is not a catalogue stub — attach the links to the
      // real row instead of minting a second one under a different key.
      const realKey = knownNorm.has(r.norm) ? [...known].find((k) => norm(k) === r.norm) : null
      const key = realKey || `cat:${r.norm}`
      const best = (r.sightings || []).find((s) => s.description) || (r.sightings || [])[0] || {}

      if (!realKey) {
        if (DRY) { stats.catalogued++; continue }
        insMap.run({
          key,
          slug: uniqueSlug(r.names && r.names[0] ? r.names[0] : r.norm, key),
          title: (r.names && r.names[0]) || r.norm,
          author: (r.authors && r.authors[0]) || null,
          year: best.released ? Number(String(best.released).slice(0, 4)) : null,
          description: best.description ? String(best.description).slice(0, MAX_CATALOGUE_DESC) : null,
          release_post: best.url || null,
          released_at: best.released ? Date.parse(best.released) : null,
          added_at: now(),
        })
        stats.catalogued++
        const m2 = db.prepare('SELECT id FROM maps WHERE key=?').get(key)
        if (m2) applyTags(m2.id, r.tags)
      }

      if (DRY) continue
      for (const l of r.links || []) {
        if (!l.url) continue
        // `verdict` is the link checker's word: alive / dead / blocked / unknown. Stored
        // as-is — this table is a record of what the checker found, not a second opinion.
        const res = insSrc.run(l.url, l.host || hostOf(l.url), 'download', key,
          l.verdict || 'unchecked', null, l.error || l.label || null,
          l.checked ? Date.parse(l.checked) : null, now(), Number.isFinite(l.size) && l.size > 0 ? l.size : null)
        if (res.changes) stats.sources++
      }
    }
  })
  tx()
}

const norm = (k) => String(k).toLowerCase().replace(/^nazi_zombie_/, '').replace(/[^a-z0-9]/g, '')

// ---- run ----------------------------------------------------------------------------
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_sources_url ON archive_sources(url, map_key)')

// ---- 3. Easter egg / power / song guides (2026-09-23) ---------------------------------
// `archive/easter_eggs.py` writes <work>/reports/map_guides.json out of the crawl cache;
// lib/guides.js owns the table and the rules (attach to the first site key that exists,
// keep staff decisions, drop what the heuristic no longer finds).
//
//   node server/db/import-archive.js --guides                 guides only
//   node server/db/import-archive.js --guides --dry           say what would change
//   ZM_ARCHIVE_GUIDES=<file> ...                              another report
const GUIDES = process.env.ZM_ARCHIVE_GUIDES || path.join(WORK, 'reports', 'map_guides.json')
function importGuides() {
  const doc = readJson(GUIDES)
  if (!doc) { console.log(`no guides at ${GUIDES} — run \`python archive/easter_eggs.py\` first`); return }
  const s = require('../lib/guides').importDoc(doc, { dry: DRY })
  console.log(`${DRY ? '(dry) ' : ''}guides: ${s.in_file} in the report (made ${doc.generated || '?'}), +${s.inserted} new, ${s.updated} updated, ` +
    `${s.unchanged} unchanged, ${s.tombstoned} deleted by staff, ${s.removed} removed, ${s.kept_by_staff} kept by staff, ${s.no_map} for maps the site lacks, ${s.bad} unusable · ${s.maps} maps`)
}

// `--guides` on its own imports only the guides: the coordinator can load them into the
// live database without re-running the map import.
const GUIDES_ONLY = args.has('--guides') && !args.has('--catalogue') && !args.has('--maps')
if (!GUIDES_ONLY) importPipelineMaps()
if (args.has('--catalogue')) importCatalogue()
if (args.has('--guides')) importGuides()

const c = (t, w) => db.prepare(`SELECT COUNT(*) c FROM ${t}${w ? ' WHERE ' + w : ''}`).get().c
if (!GUIDES_ONLY) console.log(DRY ? '(dry run, nothing written)' : 'imported:',
  `+${stats.maps} maps, ${stats.updated} updated, ${stats.catalogued} catalogued, ` +
  `${stats.files} originals, ${stats.covers} covers, ${stats.sources} sources, ${stats.tags} tags, ${stats.skipped} left to the referee agent`)
if (!DRY && !GUIDES_ONLY) {
  console.log(`  playable now: ${c('maps', "hidden=0 AND health IN ('verified','playable','custom-only')")}` +
    ` · catalogued: ${c('maps', "health='catalogued'")} · links on file: ${c('archive_sources')}`)
}
