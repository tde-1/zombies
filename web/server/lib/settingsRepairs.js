'use strict'

// One-time repairs of the account settings the site stores (users.settings_json), run at
// server start. Each runs ONCE per database: a row in `site_migrations` records it, so a
// value a player sets after the repair is theirs and is never touched again.
//
// Before anything is rewritten the database is copied with VACUUM INTO into
// `<data>/backup-<ISO>/`, the convention tools/seed-playlists.js, lease-cli.js and
// wipe-demo.js already use. No rows to change, no backup.
//
// ---- multigpu-off-2026-09-23 ----------------------------------------------------------
// `r_multiGpu 1` was ENW's launch baseline (launcher gamecfg.js COMMUNITY_FIXES, afc6276,
// 2026-09-22) and the Settings page called it a stutter fix. B, 2026-09-23 13:35: turning
// "dual video cards" OFF fixed the invisible/garbled zombies on nazi_zombie_fear_mc_2 and
// most of the mouse stutter (docs/kickstart/mod-compat.md §10.4). A stored '1' cannot be
// told apart from that old default, so every one becomes '0', once.
//
// `game.updatedAt` is deliberately NOT moved. The launcher repairs its own copy the same
// way (launcher settings.js MIGRATIONS) and holds back a site copy stamped before its
// repair; bumping the stamp here would make the site's copy "newer" and push every other
// site value over whatever the launcher has not synced yet.

const fs = require('fs')
const path = require('path')
const { db, DB_PATH, DATA_DIR } = require('../db/database')
const { safeJson } = require('./util')

const MULTIGPU = 'multigpu-off-2026-09-23'
const LINE = 'repair: r_multiGpu 1 -> 0 (old default)'

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS site_migrations (
    name TEXT PRIMARY KEY,
    at   INTEGER NOT NULL,
    note TEXT
  )`)
}

const isDone = (name) => !!db.prepare('SELECT 1 FROM site_migrations WHERE name=?').get(name)

function backup({ dataDir = DATA_DIR, dbPath = DB_PATH } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const out = path.join(dataDir, `backup-${stamp}`)
  fs.mkdirSync(out, { recursive: true })
  const dest = path.join(out, path.basename(dbPath))
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error(`backup produced nothing at ${dest}`)
  return dest
}

// Turn every r_multiGpu '1' in one settings blob into '0'. Both places a `waw` map can sit:
// `game.waw` (the Settings page) and a top-level `waw` (a launcher-shaped PUT).
function fixBlob(s) {
  let n = 0
  for (const waw of [s && s.game && s.game.waw, s && s.waw]) {
    if (!waw || typeof waw !== 'object') continue
    for (const k of Object.keys(waw)) {
      if (k.toLowerCase() === 'r_multigpu' && String(waw[k]) === '1') { waw[k] = '0'; n++ }
    }
  }
  return n
}

function repairMultiGpu({ log = console.log, dataDir, dbPath } = {}) {
  ensureTable()
  if (isDone(MULTIGPU)) return { ran: false, name: MULTIGPU, changed: 0 }
  const rows = db.prepare("SELECT steam_id, settings_json FROM users WHERE settings_json LIKE '%r_multigpu%'").all()
  const fixes = []
  for (const r of rows) {
    const s = safeJson(r.settings_json)
    if (s && fixBlob(s)) fixes.push([r.steam_id, JSON.stringify(s)])
  }
  let saved = null
  if (fixes.length) saved = backup({ dataDir, dbPath })
  const note = `${LINE} on ${fixes.length} account${fixes.length === 1 ? '' : 's'}${saved ? `; backup ${saved}` : ''}`
  db.transaction(() => {
    const up = db.prepare('UPDATE users SET settings_json=? WHERE steam_id=?')
    for (const [sid, json] of fixes) up.run(json, sid)
    db.prepare('INSERT INTO site_migrations (name, at, note) VALUES (?,?,?)').run(MULTIGPU, Date.now(), note)
  })()
  log(`[settings] ${MULTIGPU}: ${note}`)
  return { ran: true, name: MULTIGPU, changed: fixes.length, accounts: fixes.map(([sid]) => sid), backup: saved }
}

// Every repair, in order. Never throws: a failed repair must not keep the site down.
function run(opts = {}) {
  const log = opts.log || console.log
  const out = []
  for (const fn of [repairMultiGpu]) {
    try { out.push(fn({ ...opts, log })) } catch (e) { log(`[settings] repair ${fn.name} failed: ${e.message}`); out.push({ ran: false, error: e.message }) }
  }
  return out
}

module.exports = { run, repairMultiGpu, fixBlob, MULTIGPU, LINE }
