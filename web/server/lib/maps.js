'use strict'

// The archive's query layer: the map list, its four filters, the smart search, and the map
// page's payload.
//
// 99 §4.8 / 13 §3 shape everything here:
//   * a map whose health is `broken` is HIDDEN from the Maps list and appears only on the
//     Archive page. That is one WHERE clause and it is the difference between a browse page
//     that works and one full of maps that crash the server.
//   * the search RANKS: map name (including the `nazi_zombie_*` alias) first, then author,
//     then tags, then the description/readme. One box, clear results.

const { db, now } = require('../db/database')
const { safeJson } = require('./util')

const LIST_HEALTH = ['verified', 'playable', 'custom-only']
// Which of those our own boxes will actually referee. `custom-only` is a map a player can
// download and run on their own PC and nothing more, so "playable on our server" is a
// narrower question than "in the list".
const SERVER_HEALTH = ['verified', 'playable']

// ...and which of THOSE we have actually booted on a dedicated server, to game over, with a
// real client attached. `health` answers "does this map work", which is a different question
// from "does this map work HEADLESS, under Wine, on the box" — and conflating them put eight
// customs in the party's map list that no dedicated server has ever survived (ORBiT and UGX
// Requiem stall the *client* at the 32-bit ceiling; Zombie Desert, Project Viking, MW2 Rust
// and Clinic of Evil `Com_Error` on `flag_wait` before `flag_init`, proven fatal on a stock
// listen game too; Der Berg overflows `localVars`).
//
// So this is a measured list, not a policy, and every entry names its evidence. Adding a map
// here without a five-gate run behind it is how a party of four gets a server that dies.
//
//   nazi_zombie_prototype/asylum/sumpf/factory  the stock four — join65/join66 and the box
//   nazi_zombie_fear_mc_2                       Minecraft Village Remastered — join83,
//                                               five gates, 300 s, real client
const SERVER_PROVEN = new Set([
  'nazi_zombie_prototype',
  'nazi_zombie_asylum',
  'nazi_zombie_sumpf',
  'nazi_zombie_factory',
  'nazi_zombie_fear_mc_2',
])

/** Playable on OUR boxes: proven headless, and not broken since. */
const onServer = (row) => !!row && SERVER_PROVEN.has(row.key) && row.health !== 'broken'

function project(row, { me = null } = {}) {
  if (!row) return null
  const out = {
    key: row.key,
    slug: row.slug || row.key,
    title: row.title,
    author: row.author || null,
    year: row.year || null,
    source: row.source,
    health: row.health,
    main_finish: row.main_finish,
    round_n: row.round_n,
    has_ee: !!row.has_ee,
    has_buyable: !!row.has_buyable,
    description: row.description || null,
    art: row.art || null,
    // Playable on our boxes, as its own field rather than something every card has to
    // re-derive from `health`. The map browser filters on it and the list row prints it.
    on_server: onServer(row),
    released_at: row.released_at || null,
    added_at: row.added_at || null,
    plays: row.plays || 0,
    beaten_by: row.beaten_by || 0,
    thumbs_up: row.thumbs_up || 0,
    thumbs_down: row.thumbs_down || 0,
    rating: ratingOf(row),
    tags: tagsFor(row.id),
  }
  if (me) {
    const p = db.prepare('SELECT * FROM map_progress WHERE steam_id=? AND map_key=?').get(String(me), row.key)
    out.progress = p ? {
      played: !!p.played, beaten: !!p.beaten, solo: !!p.solo, ee: !!p.ee,
      buyable: !!p.buyable, best_round: p.best_round || 0, games: p.games || 0,
    } : { played: false, beaten: false, solo: false, ee: false, buyable: false, best_round: 0, games: 0 }
    out.favourite = !!db.prepare('SELECT 1 FROM favourites WHERE map_key=? AND steam_id=?').get(row.key, String(me))
    const r = db.prepare('SELECT thumbs FROM ratings WHERE map_key=? AND steam_id=?').get(row.key, String(me))
    out.my_rating = r ? r.thumbs : 0
  }
  return out
}

// Thumbs as a 0-1 score with a small prior, so one up-vote does not make a map "100%". The
// prior is two neutral votes, which is enough to stop a single rating dominating the sort
// and small enough to get out of the way once a map has been played.
function ratingOf(row) {
  const up = row.thumbs_up || 0
  const down = row.thumbs_down || 0
  const n = up + down
  if (!n) return null
  return Math.round(((up + 1) / (n + 2)) * 100)
}

function tagsFor(mapId) {
  return db.prepare(`SELECT t.slug, t.label, t.kind FROM map_tags mt JOIN tags t ON t.id=mt.tag_id
                     WHERE mt.map_id=? ORDER BY t.sort_order`).all(mapId)
}

const byKey = (key) => db.prepare('SELECT * FROM maps WHERE key=?').get(String(key))
const bySlug = (slug) => db.prepare('SELECT * FROM maps WHERE slug=? OR key=?').get(String(slug), String(slug))

// ---- the smart search ------------------------------------------------------------------
// One box, ranked. The ranking is 13 §3's, in its order, and the scores are spaced far
// enough apart that a tag hit can never outrank a name hit no matter how many tags match.
//
//   1000  the engine key or the title starts with the query
//    800  the engine key or the title contains it
//    600  the alias form matches — somebody typed "factory" for `nazi_zombie_factory`, or
//         "der riese" with the underscore spelling in their head
//    400  the author
//    200  a tag
//    100  the description or readme
function score(row, q) {
  const s = q.toLowerCase().trim()
  if (!s) return 1
  const key = String(row.key || '').toLowerCase()
  const title = String(row.title || '').toLowerCase()
  const bare = key.replace(/^nazi_zombie_/, '')
  let best = 0
  const hit = (v, exact, contains) => {
    if (!v) return
    if (v.startsWith(s)) best = Math.max(best, exact)
    else if (v.includes(s)) best = Math.max(best, contains)
  }
  hit(key, 1000, 800)
  hit(title, 1000, 800)
  hit(bare, 600, 600)
  hit(title.replace(/[^a-z0-9]/g, ''), 600, 600)
  hit(s.replace(/[^a-z0-9]/g, '') && title.replace(/[^a-z0-9]/g, '').includes(s.replace(/[^a-z0-9]/g, '')) ? title.replace(/[^a-z0-9]/g, '') : '', 600, 600)
  if (best) return best
  if (String(row.author || '').toLowerCase().includes(s)) return 400
  const tags = tagsFor(row.id).map((t) => `${t.slug} ${t.label}`.toLowerCase()).join(' ')
  if (tags.includes(s)) return 200
  if (String(row.description || '').toLowerCase().includes(s)) return 100
  if (String(row.readme || '').toLowerCase().includes(s)) return 100
  return 0
}

/**
 * The Maps page. Every filter in 13 §3, and `includeBroken` for the Archive page.
 *
 * @param {object} o
 * @param {string} [o.q]          the search box
 * @param {string} [o.finish]     'ee' | 'buyable' | 'survival'
 * @param {string} [o.author]
 * @param {number} [o.year]
 * @param {string} [o.tag]
 * @param {string} [o.progress]   'unplayed' | 'played' | 'beaten' | 'ee'   (needs `me`)
 * @param {string} [o.sort]       'popular' | 'rating' | 'newest' | 'oldest' | 'name' | 'relevance'
 * @param {string} [o.me]         the viewer, for the progress filter and the per-map flags
 */
function list(o = {}) {
  const includeBroken = !!o.includeBroken
  let rows = db.prepare('SELECT * FROM maps').all()
  if (!includeBroken) rows = rows.filter((r) => !r.hidden && LIST_HEALTH.includes(r.health))

  if (o.finish === 'ee') rows = rows.filter((r) => r.has_ee)
  else if (o.finish === 'buyable') rows = rows.filter((r) => r.has_buyable)
  else if (o.finish === 'survival') rows = rows.filter((r) => !r.has_ee && !r.has_buyable)

  if (o.author) rows = rows.filter((r) => String(r.author || '').toLowerCase() === String(o.author).toLowerCase())
  if (o.year) rows = rows.filter((r) => Number(r.year) === Number(o.year))
  if (o.source) rows = rows.filter((r) => r.source === o.source)

  // Playable on OUR server. `custom-only` is a real map that a real person can download and
  // run, and it is deliberately in LIST_HEALTH — it is just not one our boxes will referee.
  // So this is its own question and not a second spelling of the health filter.
  if (o.server) rows = rows.filter((r) => onServer(r))

  // Has anything to watch or beat. Records first, replays second, and either counts: a map
  // whose only artefact is a signed replay still has something on its page worth opening.
  if (o.records) {
    const withR = new Set([
      ...db.prepare('SELECT DISTINCT b.map_key k FROM records r JOIN boards b ON b.id=r.board_id').all().map((x) => x.k),
      ...db.prepare('SELECT DISTINCT g.map_key k FROM replays rp JOIN games g ON g.id=rp.game_id').all().map((x) => x.k),
    ].filter(Boolean))
    rows = rows.filter((r) => withR.has(r.key))
  }

  // TAGS: **OR within a group, AND across groups.** That is Movement's rule for every chip
  // group on its bar ("Slides or Ladders is a sensible thing to ask for") and it is the only
  // reading that makes a bar of groups useful — Large AND Hard is a question; Large OR Hard
  // is nearly the whole pool.
  //
  // A group is a comma-separated list of slugs. The caller sends one param per group (`tag`,
  // `size`, `difficulty`, `style`) and they are all the same machinery: `tag` is the
  // catch-all, and a single slug in it still works, so every link anybody has already pasted
  // keeps meaning what it meant.
  const groups = (Array.isArray(o.tagGroups) ? o.tagGroups : [o.tag])
    .map((g) => String(g || '').split(',').map((x) => x.trim()).filter(Boolean))
    .filter((g) => g.length)
  for (const group of groups) {
    const ids = db.prepare(`SELECT id FROM tags WHERE slug IN (${group.map(() => '?').join(',')})`).all(...group).map((t) => t.id)
    // A group naming only slugs that do not exist can match nothing. Answering "everything"
    // there would silently drop a filter the reader can see is on.
    if (!ids.length) return { maps: [], total: 0 }
    const mapIds = new Set(db.prepare(`SELECT map_id FROM map_tags WHERE tag_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((x) => x.map_id))
    rows = rows.filter((r) => mapIds.has(r.id))
  }

  if (o.progress && o.me) {
    const prog = new Map(db.prepare('SELECT * FROM map_progress WHERE steam_id=?').all(String(o.me)).map((p) => [p.map_key, p]))
    rows = rows.filter((r) => {
      const p = prog.get(r.key)
      if (o.progress === 'unplayed') return !p || !p.played
      if (o.progress === 'played') return !!(p && p.played)
      if (o.progress === 'beaten') return !!(p && p.beaten)
      if (o.progress === 'ee') return !!(p && p.ee)
      return true
    })
  }

  const q = String(o.q || '').trim()
  if (q) {
    rows = rows.map((r) => ({ r, s: score(r, q) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || String(a.r.title).localeCompare(String(b.r.title)))
      .map((x) => x.r)
  } else {
    const sort = o.sort || 'popular'
    const cmp = {
      popular: (a, b) => (b.plays || 0) - (a.plays || 0) || String(a.title).localeCompare(String(b.title)),
      rating: (a, b) => (ratingOf(b) ?? -1) - (ratingOf(a) ?? -1) || (b.thumbs_up || 0) - (a.thumbs_up || 0),
      newest: (a, b) => (b.added_at || 0) - (a.added_at || 0),
      oldest: (a, b) => (a.released_at || a.added_at || 0) - (b.released_at || b.added_at || 0),
      name: (a, b) => String(a.title).localeCompare(String(b.title)),
    }[sort] || ((a, b) => (b.plays || 0) - (a.plays || 0))
    rows = rows.sort(cmp)
  }

  const total = rows.length
  const offset = Number(o.offset || 0)
  const limit = o.limit == null ? total : Number(o.limit)
  return { maps: rows.slice(offset, offset + limit).map((r) => project(r, { me: o.me })), total }
}

// Everything the map page needs in one call, the way Movement's MapDashboard is fed.
function detail(key, { me = null } = {}) {
  const row = bySlug(key)
  if (!row) return null
  const versions = db.prepare('SELECT * FROM map_versions WHERE map_id=? ORDER BY latest DESC, id DESC').all(row.id)
  const latest = versions.find((v) => v.latest) || versions[0] || null
  const manifest = latest ? db.prepare('SELECT * FROM manifests WHERE map_version_id=?').get(latest.id) : null
  const m = manifest ? safeJson(manifest.json, {}) : {}
  return {
    ...project(row, { me }),
    readme: row.readme || null,
    release_post: row.release_post || null,
    versions: versions.map((v) => ({
      id: v.id, version: v.version, latest: !!v.latest, health: v.health, fs_game: v.fs_game,
      notes: v.notes, added_at: v.added_at,
    })),
    version_id: latest ? latest.id : null,
    // What counts as beating this map, straight from the referee's manifest — the site does
    // not re-state the rules, it shows the ones the box will actually apply.
    finishes: (m.finishes || []).map((f) => ({ id: f.id, label: f.label, priority: f.priority, solo_ok: !!f.solo_ok })),
    signals: (m.signals || []).map((s) => ({ id: s.id, label: s.label })),
    manifest_confidence: m.confidence || null,
    manifest_notes: m.notes || null,
    files: latest ? db.prepare('SELECT path, sha256, size, kind FROM map_files WHERE map_version_id=?').all(latest.id) : [],
  }
}

// The PLAYABLE pool's authors and years, not the crawl's. The crawl knows about nine
// hundred authors, none of whose maps can be played yet, and a dropdown with nine hundred
// entries is not a filter. `all: true` is for the creator index, which does want them.
function authors({ all = false } = {}) {
  const where = all ? 'hidden=0' : `hidden=0 AND health IN ('verified','playable','custom-only')`
  return db.prepare(`SELECT author AS name, COUNT(*) AS maps, SUM(plays) AS plays
                       FROM maps WHERE author IS NOT NULL AND author <> '' AND ${where}
                      GROUP BY author ORDER BY maps DESC, name`).all()
}

function years({ all = false } = {}) {
  const where = all ? '1=1' : `health IN ('verified','playable','custom-only')`
  return db.prepare(`SELECT year, COUNT(*) AS maps FROM maps WHERE year IS NOT NULL AND ${where}
                      GROUP BY year ORDER BY year`).all()
}

/** Headline numbers for the Archive page. All counted, none typed. */
function archiveStats() {
  const n = (sql, ...a) => db.prepare(sql).get(...a).c
  return {
    catalogued: n("SELECT COUNT(*) c FROM maps"),
    playable: n("SELECT COUNT(*) c FROM maps WHERE hidden=0 AND health IN ('verified','playable','custom-only')"),
    crawled_only: n("SELECT COUNT(*) c FROM maps WHERE health='catalogued'"),
    broken: n("SELECT COUNT(*) c FROM maps WHERE health='broken'"),
    originals_held: n("SELECT COUNT(*) c FROM map_files WHERE kind='original'"),
    links: n('SELECT COUNT(*) c FROM archive_sources'),
    links_alive: n("SELECT COUNT(*) c FROM archive_sources WHERE status IN ('alive','fetched')"),
    links_dead: n("SELECT COUNT(*) c FROM archive_sources WHERE status='dead'"),
    links_unchecked: n("SELECT COUNT(*) c FROM archive_sources WHERE status NOT IN ('alive','fetched','dead','blocked')"),
  }
}

/** The download links and their health, for a map page's archive block. */
const sourcesFor = (mapKey) => db.prepare(`SELECT url, site, kind, status, note, last_checked
                                             FROM archive_sources WHERE map_key=? ORDER BY
                                             CASE status WHEN 'fetched' THEN 0 WHEN 'alive' THEN 1 ELSE 2 END, id`)
  .all(String(mapKey))

function tagCloud() {
  return db.prepare(`SELECT t.slug, t.label, t.kind, COUNT(mt.map_id) AS maps
                       FROM tags t LEFT JOIN map_tags mt ON mt.tag_id=t.id
                      GROUP BY t.id HAVING maps > 0 ORDER BY t.sort_order`).all()
}

// ---- writes --------------------------------------------------------------------------
function rate(mapKey, steamId, thumbs, gameId = null) {
  // 13 §2c: only players who have played it can rate. The proof is a game row, not a flag.
  const played = db.prepare('SELECT played FROM map_progress WHERE steam_id=? AND map_key=?').get(String(steamId), String(mapKey))
  if (!played || !played.played) return { ok: false, error: 'play it first' }
  const t = thumbs > 0 ? 1 : thumbs < 0 ? -1 : 0
  if (t === 0) db.prepare('DELETE FROM ratings WHERE map_key=? AND steam_id=?').run(String(mapKey), String(steamId))
  else {
    db.prepare(`INSERT INTO ratings (map_key, steam_id, thumbs, game_id, created_at) VALUES (?,?,?,?,?)
                ON CONFLICT(map_key, steam_id) DO UPDATE SET thumbs=excluded.thumbs, created_at=excluded.created_at`)
      .run(String(mapKey), String(steamId), t, gameId, now())
  }
  recountRatings(mapKey)
  return { ok: true, thumbs: t }
}

function recountRatings(mapKey = null) {
  const keys = mapKey ? [String(mapKey)] : db.prepare('SELECT key FROM maps').all().map((r) => r.key)
  const upd = db.prepare('UPDATE maps SET thumbs_up=?, thumbs_down=? WHERE key=?')
  for (const k of keys) {
    const u = db.prepare("SELECT COUNT(*) c FROM ratings WHERE map_key=? AND thumbs=1").get(k).c
    const d = db.prepare("SELECT COUNT(*) c FROM ratings WHERE map_key=? AND thumbs=-1").get(k).c
    upd.run(u, d, k)
  }
}

function favourite(mapKey, steamId, on) {
  if (on) db.prepare('INSERT OR IGNORE INTO favourites (map_key, steam_id, created_at) VALUES (?,?,?)').run(String(mapKey), String(steamId), now())
  else db.prepare('DELETE FROM favourites WHERE map_key=? AND steam_id=?').run(String(mapKey), String(steamId))
  return { ok: true, favourite: !!on }
}

const favouritesOf = (steamId) => db.prepare(`SELECT m.* FROM favourites f JOIN maps m ON m.key=f.map_key
                                              WHERE f.steam_id=? ORDER BY f.created_at DESC`).all(String(steamId)).map((r) => project(r))

const count = () => db.prepare(`SELECT COUNT(*) c FROM maps WHERE hidden=0 AND health IN ('verified','playable','custom-only')`).get().c

module.exports = {
  project, byKey, bySlug, list, detail, authors, years, tagCloud, archiveStats, sourcesFor,
  rate, recountRatings, favourite, favouritesOf, count, ratingOf, tagsFor, LIST_HEALTH, SERVER_HEALTH,
  SERVER_PROVEN, onServer,
}
