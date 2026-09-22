#!/usr/bin/env node
'use strict'

// Line every Zombies ENW name up with the name the same Steam account wears on ENW Movement.
//
// B, 2026-09-22: "Everyone should have the exact same ENW username." The seven approved
// accounts were named by `seed-enw-names.js` from the approvals list, in lower case; Movement
// is the other place those people already have a name. Read from movement.enw.gg's PUBLIC
// profile (`GET /api/players/<id>/profile`, no session, no credentials — lib/movementName.js
// says why it is a suggestion and not proof).
//
// What it changes, and only with --apply:
//   * CASE-ONLY differences (`jamie` here, `Jamie` there) — adopt Movement's casing. drops.ws
//     treats a re-capitalisation as a real change (username_history kind 'case'), so the
//     exact string is the name, not just its letters.
// What it only REPORTS:
//   * a different name altogether — that is a person's identity, and picking one of two is a
//     decision for B (and for them), not for a script;
//   * a Movement name this site would refuse (rules or drops.ws blocklist).
//
//   ZM_DATA_DIR=<copy> node web/tools/align-enw-names.js           # report
//   ZM_DATA_DIR=<dir>  node web/tools/align-enw-names.js --apply   # adopt case-only fixes
//
// Rule 7 applies: pointing this at web/data is B's or the coordinator's call.

const path = require('node:path')
process.chdir(path.join(__dirname, '..'))

const { db, now } = require('../server/db/database')
const names = require('../server/lib/names')
const movementName = require('../server/lib/movementName')

const apply = process.argv.includes('--apply')

async function main () {
  const rows = db.prepare("SELECT steam_id, enw_name FROM users WHERE deleted=0 AND enw_name IS NOT NULL AND steam_id NOT LIKE '7656119000000000%' ORDER BY created_at").all()
  let same = 0; let cased = 0; let differ = 0; let none = 0
  for (const r of rows) {
    const mv = await movementName.lookup(r.steam_id)
    if (!mv) { console.log(`  -  ${r.steam_id}  ${r.enw_name.padEnd(20)} not on Movement`); none++; continue }
    if (mv === r.enw_name) { console.log(`  =  ${r.steam_id}  ${r.enw_name}`); same++; continue }
    if (mv.toLowerCase() === r.enw_name.toLowerCase()) {
      const c = names.check(mv, r.steam_id)
      if (!c.available) { console.log(`  !  ${r.steam_id}  ${r.enw_name} -> ${mv}  refused here (${c.reason})`); differ++; continue }
      console.log(`  ${apply ? '+' : '?'}  ${r.steam_id}  ${r.enw_name} -> ${mv}  (case only)`)
      if (apply) {
        db.prepare('UPDATE users SET enw_name=?, enw_checked=? WHERE steam_id=?').run(mv, now(), r.steam_id)
        db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('username.align', NULL, ?, ?)")
          .run(JSON.stringify({ steam_id: r.steam_id, from: r.enw_name, to: mv, source: 'movement', kind: 'case' }), now())
      }
      cased++
      continue
    }
    console.log(`  x  ${r.steam_id}  here "${r.enw_name}", Movement "${mv}" — different names, left alone`)
    differ++
  }
  console.log(`\n${apply ? '' : '[report only] '}${same} same, ${cased} case-only${apply ? ' (fixed)' : ''}, ${differ} different, ${none} not on Movement.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
