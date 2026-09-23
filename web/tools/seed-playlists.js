#!/usr/bin/env node
'use strict'

// Seed the first playlists (2026-09-23). The live DB has none, and /maps' cards view draws a
// row per live playlist, so until some exist that view is Popular and a button.
//
//   ZM_DATA_DIR=<a copy> node web/tools/seed-playlists.js            # dry run: prints the plan
//   ZM_DATA_DIR=<dir>    node web/tools/seed-playlists.js --apply    # back up, then write
//   ... --apply --live        publish them at once (default: hidden, publish from Admin → Playlists)
//   ... --only stock,minecraft
//
// ADDITIVE and IDEMPOTENT. A slug that already exists is left exactly as it is (staff may
// have edited it), and a map key missing from this DB, or broken, is skipped and named.
// With --apply the database is copied first with VACUUM INTO into <data>/backup-<ISO>/
// (the convention wipe-demo.js set), and nothing is written if that copy fails.
//
// Rule 7: pointing this at web/data is B's or the coordinator's call, not an agent's.
//
// The set is a suggestion to publish from, built from maps that load on our box
// (lib/maps.js SERVER_PROVEN + boxProven.json). Reorder and rename in the panel.

const fs = require('node:fs')
const path = require('node:path')

const SET = [
  {
    slug: 'stock', name: 'Stock', blurb: "Treyarch's four.",
    maps: ['nazi_zombie_prototype', 'nazi_zombie_asylum', 'nazi_zombie_sumpf', 'nazi_zombie_factory'],
  },
  {
    slug: 'community-classics', name: 'Community classics', blurb: 'The customs people still play.',
    maps: ['nacht_reimagined', 'nazi_zombie_johndoe', 'nazi_zombie_denial2', 'nazi_zombie_ils', 'nazi_zombie_lorkeep', 'nazi_zombie_temple', 'zombie_town', 'nazi_zombie_hanoizom'],
  },
  {
    slug: 'minecraft', name: 'Minecraft', blurb: null,
    maps: ['nazi_zombie_fear_mc_2', 'nazi_zombie_mine'],
  },
  {
    slug: 'small-fast', name: 'Small and fast', blurb: 'One room, quick rounds.',
    maps: ['nazi_zombie_arena', 'chal_dual_wield', 'chal_harambe', 'ut_box_map', 'cube', 'nazi_zombie_enclosed', 'nazi_zombie_bored', 'nazi_zombie_dome_snow'],
  },
  {
    slug: 'big-maps', name: 'Big maps', blurb: 'Bring a team.',
    maps: ['battlestar_galactica', 'futurama', 'kingdom_hearts', 'escape_asylum', 'mr_freeze', 'nazi_zombie_hotelv2', 'nazi_zombie_prison', 'ugxm_garage'],
  },
  {
    slug: 'christmas', name: 'Christmas', blurb: null,
    maps: ['nazi_zombie_bloodsport', 'nazi_zombie_arkham', 'navidad_p_zombie', 'thirty_seven', 'nazi_zombie_snowglobe'],
  },
]

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const LIVE = argv.includes('--live')
const onlyAt = argv.indexOf('--only')
const ONLY = onlyAt >= 0 ? new Set(String(argv[onlyAt + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)) : null

process.chdir(path.join(__dirname, '..'))
const { db, now, DB_PATH, DATA_DIR } = require('../server/db/database')

function backup() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const out = path.join(DATA_DIR, `backup-${stamp}`)
  fs.mkdirSync(out, { recursive: true })
  const dest = path.join(out, path.basename(DB_PATH))
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error(`backup produced nothing at ${dest}`)
  return dest
}

function plan() {
  const rows = []
  let order = (db.prepare('SELECT MAX(sort_order) m FROM playlists').get().m || 0)
  for (const p of SET) {
    if (ONLY && !ONLY.has(p.slug)) continue
    const exists = !!db.prepare('SELECT 1 FROM playlists WHERE slug=?').get(p.slug)
    const keep = []
    const skipped = []
    for (const k of p.maps) {
      const m = db.prepare('SELECT key, health, hidden FROM maps WHERE key=?').get(k)
      if (!m) skipped.push(`${k} (not in this DB)`)
      else if (m.health === 'broken') skipped.push(`${k} (broken)`)
      else if (m.hidden) skipped.push(`${k} (hidden)`)
      else keep.push(k)
    }
    order += 10
    rows.push({ ...p, exists, keep, skipped, sort_order: order })
  }
  return rows
}

function main() {
  console.log(`database  ${DB_PATH}`)
  console.log(`mode      ${APPLY ? 'APPLY' : 'dry run'}${APPLY ? `, state ${LIVE ? 'live' : 'hidden'}` : ''}`)
  const rows = plan()
  for (const r of rows) {
    const verb = r.exists ? 'exists, left alone' : r.keep.length ? `create, ${r.keep.length} maps` : 'nothing to add'
    console.log(`  ${r.slug.padEnd(20)} ${verb}`)
    if (!r.exists && r.skipped.length) console.log(`      skipped: ${r.skipped.join(', ')}`)
  }
  if (!APPLY) { console.log('\nDry run. Add --apply to write (and --live to publish).'); return }
  const todo = rows.filter((r) => !r.exists && r.keep.length)
  if (!todo.length) { console.log('\nNothing to write.'); return }
  const b = backup()
  console.log(`\nbackup    ${b}`)
  const t = now()
  const tx = db.transaction(() => {
    for (const r of todo) {
      const info = db.prepare(`INSERT INTO playlists (slug, name, blurb, kind, state, sort_order, reward_badge, created_at, created_by, updated_at)
                               VALUES (?,?,?,?,?,?,0,?,?,?)`).run(r.slug, r.name, r.blurb, 'curated', LIVE ? 'live' : 'hidden', r.sort_order, t, 'seed-playlists', t)
      const ins = db.prepare('INSERT OR IGNORE INTO playlist_maps (playlist_id, map_key, position, added_at) VALUES (?,?,?,?)')
      r.keep.forEach((k, i) => ins.run(info.lastInsertRowid, k, i, t))
      db.prepare('INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES (?,?,?,?)')
        .run('playlist.create', 'seed-playlists', JSON.stringify({ id: info.lastInsertRowid, slug: r.slug, maps: r.keep.length, state: LIVE ? 'live' : 'hidden' }), t)
    }
  })
  tx()
  console.log(`wrote     ${todo.length} playlist(s): ${todo.map((r) => r.slug).join(', ')}`)
}

if (require.main === module) main()

module.exports = { SET, plan }
