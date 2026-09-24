#!/usr/bin/env node
'use strict'

// The playlists the Maps cards view (the landing page) draws, as data.
//
//   ZM_DATA_DIR=<a copy> node web/tools/seed-playlists.js            # dry run: prints the plan
//   ZM_DATA_DIR=<dir>    node web/tools/seed-playlists.js --apply    # back up, then write
//   ... --only essentials,christmas
//
// Round 1 (2026-09-23) seeded six hidden-by-default rows. Round 2 (B, 2026-09-24: "the first
// few rows people see are a mixture of the classics and the best of the community maps ...
// then a row with the unserious ones") makes this the whole set, in page order, all live.
//
// OWNERSHIP. The script rewrites a playlist only if it is OURS: created_by 'seed-playlists'
// and no staff playlist.update / playlist.delete in activity_log for its id. Anything staff
// made or touched is left exactly as it is, and a slug staff hold is not taken. `from` renames
// one of our round-1 slugs in place. RETIRE lists our old slugs that no longer have a row;
// they go hidden (not deleted), so the panel can bring one back.
//
// ELIGIBILITY. Every row: the map exists, is not hidden, not broken, not superseded, and
// launches on our servers (lib/maps.js onServer: SERVER_PROVEN or box-proven). `front` rows
// (the ones above the fold) also need real art — no generated "NO SCREENSHOT ON FILE" card —
// except the stock four, whose art is a placeholder on purpose (ip-posture.md §4), and a map
// may appear in only one front row. Each row lists more candidates than `cap`, in priority
// order, so a map that drops out is replaced by the next one; re-run after the art lands and
// the row fills back in with the names it was meant to have.
//
// IDEMPOTENT: a row already matching the plan is not written. With --apply the database is
// copied first with VACUUM INTO into <data>/backup-<ISO>/, and nothing is written if that fails.
//
// Signals behind the order (2026-09-24): UGX / codrepo thread views and the popular-rank runs
// (ZombiesDev/archive/reports/popular*.json, catalogue.json), and the maps people name when
// they name WaW customs. Site ratings and plays are too thin to rank on yet.

const fs = require('node:fs')
const path = require('node:path')

const STOCK = ['nazi_zombie_prototype', 'nazi_zombie_asylum', 'nazi_zombie_sumpf', 'nazi_zombie_factory']

const SET = [
  {
    slug: 'essentials', name: 'Essentials', blurb: null, front: true,
    maps: ['nazi_zombie_leviathan', 'nazi_zombie_factory', 'nuketown', 'nacht_reimagined', 'nazi_zombie_ccube',
      'nazi_zombie_asylum', 'killhouse', 'nazi_zombie_johndoe', 'nazi_zombie_derberg', 'cryogenic', 'zombie_town',
      'nazi_zombie_malibu', 'nazi_zombie_zhunterz', 'zm_nuked'],
  },
  {
    slug: 'fan-favourites', from: 'community-classics', name: 'Fan favourites', blurb: null, front: true,
    maps: ['nazi_zombie_cargo', 'nazi_zombie_prototype', 'dead_palace', 'nightclub', 'nazi_zombie_sumpf',
      'nazi_zombie_path', 'bridge_zombie', 'nazi_zombie_lorkeep', 'nazi_zombie_hijacked', 'hghrise', 'mw2rust',
      'nazi_zombie_library', 'nazi_zombie_denial2', 'zm_hospital', 'nazi_zombie_pd', 'ut_box_map'],
  },
  {
    slug: 'community-picks', name: 'Community picks', blurb: null, front: true,
    maps: ['escape_asylum', 'nazi_zombie_pd', 'nazi_zombie_beachtown', 'nazi_zombie_hotelv2', 'nazi_zombie_ils',
      'nazi_zombie_dcv2', 'nazi_zombie_temple', 'nazi_zombie_legion', 'nazi_zombie_hanoizom', 'nazi_zombie_rats',
      'bank_job', 'nazi_zombie_dt2', 'nazi_zombie_pogreb', 'nazi_zombie_reich', 'kri', 'aliendefense',
      'nazi_zombie_prison', 'mr_freeze'],
  },
  {
    // The unserious ones. Not "meme" (B). A wall-buy pun, which is as far as the joke goes.
    slug: 'off-the-wall', from: 'minecraft', name: 'Off the wall', blurb: null, front: true,
    maps: ['nazi_zombie_fear_mc_2', 'nazi_zombie_poke', 'futurama', 'chal_harambe', 'nazi_zombie_fivenights',
      'kingdom_hearts', 'jigsaw', 'bcast', 'chickn', 'nazi_zombie_mine', 'nazi_zombie_ccube_u',
      'nazi_zombie_enclosed', 'nazi_zombie_arkham', 'battlestar_galactica', 'ahkanto', 'nazi_zombie_halloweencube'],
  },
  {
    slug: 'remakes', name: 'Remakes', blurb: null,
    maps: ['nuketown', 'nacht_reimagined', 'killhouse', 'mw2rust', 'nazi_zombie_hijacked', 'nazi_zombie_cargo',
      'zm_nuked', 'hghrise'],
  },
  {
    slug: 'challenge', from: 'small-fast', name: 'Challenge maps', blurb: null,
    maps: ['nazi_zombie_arena', 'ut_box_map', 'cube', 'nazi_zombie_ccube', 'nazi_zombie_ccube_u', 'nazi_zombie_bored',
      'nazi_zombie_enclosed', 'chal_dual_wield', 'chal_harambe', 'chickn', 'kri', 'nazi_zombie_tank'],
  },
  {
    slug: 'christmas', name: 'Christmas', blurb: null,
    maps: ['nazi_zombie_bloodsport', 'navidad_p_zombie', 'xmas_refinery', 'nazi_zombie_arkham', 'thirty_seven',
      'nazi_zombie_snowglobe', 'trailer_park_christmas'],
  },
  {
    slug: 'stock', name: 'Stock', blurb: null,
    maps: STOCK,
  },
]
const RETIRE = ['big-maps']
const CAP = 12
const BY = 'seed-playlists'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const onlyAt = argv.indexOf('--only')
const ONLY = onlyAt >= 0 ? new Set(String(argv[onlyAt + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)) : null

process.chdir(path.join(__dirname, '..'))
const { db, now, DB_PATH, DATA_DIR } = require('../server/db/database')
const { onServer } = require('../server/lib/maps')

function backup() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const out = path.join(DATA_DIR, `backup-${stamp}`)
  fs.mkdirSync(out, { recursive: true })
  const dest = path.join(out, path.basename(DB_PATH))
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error(`backup produced nothing at ${dest}`)
  return dest
}

const bySlug = (slug) => (slug ? db.prepare('SELECT * FROM playlists WHERE slug=?').get(slug) : null)

// Ours = we made it and no staff edit since. Staff edits are audited (routes/admin.js).
function ours(pl) {
  if (!pl || pl.created_by !== BY) return false
  const touched = db.prepare(`SELECT 1 FROM activity_log WHERE event IN ('playlist.update','playlist.delete')
                               AND COALESCE(actor,'') <> ? AND json_valid(metadata) AND json_extract(metadata,'$.id') = ? LIMIT 1`).get(BY, pl.id)
  return !touched
}

const hasRealArt = (m) => !!m.art && m.art_source !== 'placeholder'

function plan() {
  const rows = []
  const usedFront = new Set()
  SET.forEach((p, i) => {
    const sort_order = (i + 1) * 10
    const cap = p.cap || CAP
    const keep = []
    const skipped = []
    for (const k of p.maps) {
      const m = db.prepare('SELECT * FROM maps WHERE key=?').get(k)
      if (!m) { skipped.push(`${k} (not in this DB)`); continue }
      if (m.health === 'broken') { skipped.push(`${k} (broken)`); continue }
      if (m.hidden) { skipped.push(`${k} (hidden)`); continue }
      if (m.superseded_by) { skipped.push(`${k} (superseded by ${m.superseded_by})`); continue }
      if (!onServer(m)) { skipped.push(`${k} (not playable on our servers)`); continue }
      if (p.front && !hasRealArt(m) && !STOCK.includes(k)) { skipped.push(`${k} (no real art)`); continue }
      if (p.front && usedFront.has(k)) continue
      if (keep.length >= cap) continue
      keep.push(k)
    }
    if (p.front) keep.forEach((k) => usedFront.add(k))
    else {
      // Lower rows may carry a generated card, but behind the maps with a picture (the row
      // and its playlist cover lead with art).
      const art = (k) => STOCK.includes(k) || hasRealArt(db.prepare('SELECT art, art_source FROM maps WHERE key=?').get(k))
      keep.splice(0, keep.length, ...keep.filter(art), ...keep.filter((k) => !art(k)))
    }
    if (ONLY && !ONLY.has(p.slug)) return
    const cur = bySlug(p.slug) || bySlug(p.from)
    const mine = !cur || ours(cur)
    let change = 'create'
    if (cur && !mine) change = 'staff-owned, left alone'
    else if (cur) {
      const members = db.prepare('SELECT map_key FROM playlist_maps WHERE playlist_id=? ORDER BY position').all(cur.id).map((r) => r.map_key)
      const same = cur.slug === p.slug && cur.name === p.name && (cur.blurb || null) === (p.blurb || null) &&
        cur.state === 'live' && cur.sort_order === sort_order && cur.kind === 'curated' && members.join(',') === keep.join(',')
      change = same ? 'up to date' : (cur.slug !== p.slug ? `update (was /${cur.slug})` : 'update')
    }
    if (!keep.length && change === 'create') change = 'nothing to add'
    rows.push({ ...p, id: cur ? cur.id : null, change, keep, skipped, sort_order })
  })
  const retire = []
  for (const slug of RETIRE) {
    if (ONLY && !ONLY.has(slug)) continue
    const cur = bySlug(slug)
    if (cur && ours(cur) && cur.state !== 'hidden') retire.push(cur)
  }
  return Object.assign(rows, { retire })
}

function main() {
  console.log(`database  ${DB_PATH}`)
  console.log(`mode      ${APPLY ? 'APPLY' : 'dry run'}`)
  const rows = plan()
  for (const r of rows) {
    console.log(`  ${String(r.sort_order).padStart(3)} ${r.slug.padEnd(18)} ${r.change}, ${r.keep.length} maps`)
    console.log(`        ${r.keep.join(', ')}`)
    if (r.skipped.length) console.log(`        skipped: ${r.skipped.join(', ')}`)
  }
  for (const p of rows.retire) console.log(`      ${p.slug.padEnd(18)} retire (hidden)`)
  const todo = rows.filter((r) => r.keep.length && (r.change === 'create' || r.change.startsWith('update')))
  if (!APPLY) { console.log('\nDry run. Add --apply to write.'); return }
  if (!todo.length && !rows.retire.length) { console.log('\nNothing to write.'); return }
  const b = backup()
  console.log(`\nbackup    ${b}`)
  const t = now()
  const log = db.prepare('INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES (?,?,?,?)')
  const tx = db.transaction(() => {
    for (const r of todo) {
      let id = r.id
      if (id) {
        db.prepare(`UPDATE playlists SET slug=?, name=?, blurb=?, kind='curated', state='live', sort_order=?, updated_at=? WHERE id=?`)
          .run(r.slug, r.name, r.blurb, r.sort_order, t, id)
        db.prepare('DELETE FROM playlist_maps WHERE playlist_id=?').run(id)
      } else {
        id = db.prepare(`INSERT INTO playlists (slug, name, blurb, kind, state, sort_order, reward_badge, created_at, created_by, updated_at)
                         VALUES (?,?,?,'curated','live',?,0,?,?,?)`).run(r.slug, r.name, r.blurb, r.sort_order, t, BY, t).lastInsertRowid
      }
      const ins = db.prepare('INSERT OR IGNORE INTO playlist_maps (playlist_id, map_key, position, added_at) VALUES (?,?,?,?)')
      r.keep.forEach((k, i) => ins.run(id, k, i, t))
      log.run(r.id ? 'playlist.seed' : 'playlist.create', BY, JSON.stringify({ id: Number(id), slug: r.slug, maps: r.keep.length, state: 'live' }), t)
    }
    for (const p of rows.retire) {
      db.prepare(`UPDATE playlists SET state='hidden', updated_at=? WHERE id=?`).run(t, p.id)
      log.run('playlist.seed', BY, JSON.stringify({ id: p.id, slug: p.slug, state: 'hidden' }), t)
    }
  })
  tx()
  console.log(`wrote     ${todo.length} playlist(s)${rows.retire.length ? `, retired ${rows.retire.map((p) => p.slug).join(', ')}` : ''}`)
}

if (require.main === module) main()

module.exports = { SET, RETIRE, plan }
