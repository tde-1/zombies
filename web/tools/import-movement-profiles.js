#!/usr/bin/env node
'use strict'

// Copy the seven approved accounts' ENW Movement banners (and country code) onto this site.
//
// B, 2026-09-22: "Copy people's ENW profile stuff over already — if they have a banner on
// Movement it should show here the same."
//
// HOW. Movement exposes a PUBLIC profile read by SteamID — `GET /api/players/<id>/profile`,
// no session (CSGO-Matchmaker/server/index.js MOVEMENT_PUBLIC; routes/players.js). So this
// does not touch Movement's database or its box: it makes the same anonymous GET a browser
// makes, and downloads the banner FILE into `<data>/media/banners/` so nothing is hotlinked.
// It is `lib/movementProfile.refresh()`, the exact code sign-in runs, called for a fixed list.
//
// WHAT IS COPIED: steam_id, the Movement username (kept, not displayed), the banner file and
// its crop position, the two-letter country. Nothing else — no avatar, no email (Movement's
// public read has none), no real name, no Discord handle. Movement has no bio field.
//
// WHICH DATABASE: whatever the server would open — `ZM_DATA_DIR` / `ZM_DB_PATH`, else web/data.
// Run it against a copy first:
//
//   ZM_DATA_DIR=<a copy> node web/tools/import-movement-profiles.js [--dry]
//
// `--dry` reads Movement and prints what it found without writing a row or a file.
// Idempotent: a banner already copied is not fetched again (Movement's banner names are
// content-addressed), and a changed one replaces the old file.

const path = require('node:path')
process.chdir(path.join(__dirname, '..'))

if (process.env.ZM_MOVEMENT_URL === 'off') {
  console.error('ZM_MOVEMENT_URL=off — nothing to read from. Unset it (default https://movement.enw.gg).')
  process.exit(2)
}

const { db, DB_PATH } = require('../server/db/database')
const mp = require('../server/lib/movementProfile')

// The seven approved accounts (STATUS.md "Approved"; web/tools/seed-enw-names.js). Handles
// only, per the standing rule.
const SEVEN = {
  '76561198126330106': 'myu',
  '76561198396250036': 'zeroh',
  '76561198805847033': 'jamie',
  '76561199245978066': 'stew',
  '76561199013523774': 'jacob',
  '76561199074074176': 'air',
  '76561199559696300': 'toku',
}

const dry = process.argv.includes('--dry')

async function main() {
  console.log(`database  ${DB_PATH}`)
  console.log(`banners   ${mp.BANNER_DIR}`)
  console.log(`mode      ${dry ? 'dry run (reads Movement, writes nothing)' : 'write'}\n`)
  let found = 0; let banners = 0; let missing = 0; let failed = 0
  for (const [sid, handle] of Object.entries(SEVEN)) {
    if (dry) {
      try {
        const base = String(process.env.ZM_MOVEMENT_URL || 'https://movement.enw.gg').replace(/\/+$/, '')
        const r = await fetch(`${base}/api/players/${sid}/profile`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) })
        const d = r.ok ? await r.json() : null
        const u = d && d.user
        if (!u) { console.log(`  -  ${handle.padEnd(7)} ${sid}  not on Movement (${r.status})`); missing++; continue }
        found++
        if (u.banner) banners++
        console.log(`  ?  ${handle.padEnd(7)} ${sid}  banner ${u.banner || '(none)'}  pos ${u.banner_pos}  country ${u.country || '-'}`)
      } catch (e) { console.log(`  !  ${handle.padEnd(7)} ${sid}  ${e.message}`); failed++ }
      continue
    }
    const r = await mp.refresh(sid)
    if (r.error && !r.found) { console.log(`  !  ${handle.padEnd(7)} ${sid}  ${r.error}`); failed++; continue }
    if (!r.found) { console.log(`  -  ${handle.padEnd(7)} ${sid}  not on Movement`); missing++; continue }
    found++
    if (r.banner) banners++
    const row = db.prepare('SELECT banner_pos, country FROM movement_profiles WHERE steam_id=?').get(sid) || {}
    console.log(`  +  ${handle.padEnd(7)} ${sid}  banner ${r.banner || '(none)'}${r.error ? ` (copy failed: ${r.error})` : ''}  pos ${row.banner_pos}  country ${row.country || '-'}`)
  }
  console.log(`\n${found} on Movement, ${banners} with a banner, ${missing} not found, ${failed} failed`)
}

main().catch((e) => { console.error(e); process.exit(1) })
