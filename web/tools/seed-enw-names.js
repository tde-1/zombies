#!/usr/bin/env node
'use strict'

// Seed the seven approved accounts' ENW names.
//
// WHY A SCRIPT AND NOT THE SEED FILE. `db/seed.js` builds a demo world and is not run
// against the live database; these are real accounts that already exist (all seven are
// `approved = 1`), and every one of them had `enw_name = NULL`. The owner's row also held
// `username = 'Unknown Soldier'` — the engine's default `name` dvar, written back into the
// account by `lib/results.js` (removed; see the retraction there). This fixes both.
//
// The handles come from the site's own approvals (STATUS.md: "Approved: you, jamie, zeroh,
// stew, jacob, air, toku") mapped to the SteamIDs already in the users table. **Handles
// only** — no real names anywhere, ever, per the standing rule.
//
// IDEMPOTENT and NON-DESTRUCTIVE. A row that already has an `enw_name` is left alone
// unless `--force` is given: if somebody has picked, their pick wins over this list.
//
//   node web/tools/seed-enw-names.js [--dry] [--force]
//
// It goes through `lib/names.js` for validation and uniqueness rather than writing the
// column directly, so a seeded name is one the picker would also have accepted.

const path = require('node:path')
process.chdir(path.join(__dirname, '..'))

const { db, now } = require('../server/db/database')
const names = require('../server/lib/names')

// The seven approved accounts. SteamID64 -> ENW handle.
const SEED = {
  '76561198126330106': 'myu',
  '76561198396250036': 'zeroh',
  '76561198805847033': 'jamie',
  '76561199245978066': 'stew',
  '76561199013523774': 'jacob',
  '76561199074074176': 'air',
  '76561199559696300': 'toku',
}

const dry = process.argv.includes('--dry')
const force = process.argv.includes('--force')

let set = 0; let kept = 0; let missing = 0; let refused = 0

for (const [sid, handle] of Object.entries(SEED)) {
  const row = db.prepare('SELECT steam_id, username, enw_name, approved FROM users WHERE steam_id=?').get(sid)
  if (!row) { console.log(`  -  ${handle.padEnd(8)} ${sid}  no account row — skipped`); missing++; continue }

  if (row.enw_name && !force) {
    console.log(`  =  ${handle.padEnd(8)} ${sid}  already "${row.enw_name}" — kept`)
    kept++
  } else {
    const invalid = names.validate(handle)
    if (invalid) { console.log(`  !  ${handle.padEnd(8)} ${sid}  ${invalid}`); refused++; continue }
    if (names.taken(handle, sid)) { console.log(`  !  ${handle.padEnd(8)} ${sid}  taken by another account`); refused++; continue }
    console.log(`  ${dry ? '?' : '+'}  ${handle.padEnd(8)} ${sid}  enw_name = "${handle}"${row.enw_name ? ` (was "${row.enw_name}")` : ''}`)
    if (!dry) {
      db.prepare('UPDATE users SET enw_name=?, enw_checked=? WHERE steam_id=?').run(handle, now(), sid)
      db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('username.seed', NULL, ?, ?)")
        .run(JSON.stringify({ steam_id: sid, username: handle, from: row.enw_name || null }), now())
    }
    set++
  }

  // "Unknown Soldier" is the ENGINE's default, not a name anyone chose, and it is the
  // string B is annoyed by. Clear it wherever the result path wrote one in, so the
  // fallback chain in `users.pub` (enw_name || username || steam_id) can never surface it.
  if (row.username && /^unknown soldier$/i.test(String(row.username).trim())) {
    console.log(`     ${' '.repeat(8)} ${sid}  clearing username "${row.username}" (the engine's default, written back by results.js)`)
    if (!dry) db.prepare('UPDATE users SET username=NULL WHERE steam_id=?').run(sid)
  }
}

// Anyone else carrying it, seeded or not.
const strays = db.prepare("SELECT steam_id, username FROM users WHERE username IS NOT NULL AND lower(trim(username))='unknown soldier'").all()
for (const s of strays) {
  console.log(`  x  ${'-'.padEnd(8)} ${s.steam_id}  clearing stray "Unknown Soldier"`)
  if (!dry) db.prepare('UPDATE users SET username=NULL WHERE steam_id=?').run(s.steam_id)
}

console.log(`\n${dry ? '[dry run] ' : ''}${set} named, ${kept} kept, ${missing} missing, ${refused} refused.`)
