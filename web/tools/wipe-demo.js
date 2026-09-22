'use strict'

// Wipe every piece of made-up content off the site, keeping everything real.
//
//   node tools/wipe-demo.js --dry-run      say what would go, touch nothing
//   node tools/wipe-demo.js                back up, then do it
//
// B, 2026-09-22: "Wipe all fake data. Every seeded demo game, record, badge, XP, comment,
// playlist, party, live frame goes. Keep users, the map catalogue, the archive, admin/mod
// flags." README hard rule 7 ("do not write to web/data") was lifted by B for this one
// script on that night, and for nothing else.
//
// ── What "fake" turned out to mean ────────────────────────────────────────────────
// Not just `games.demo = 1`. The eight games on the live database all carry `demo = 0`,
// because they were not written by the seed at all — they were written by real host-agent
// SIMULATIONS posting real results through the real ingest path. That is exactly what made
// them worth having while the pull protocol was being proved, and exactly what makes them
// indistinguishable from a Friday night's play on the boards. Nobody played them. So the
// rule here is by TABLE, not by flag: everything that is a record of somebody having
// played goes, whoever wrote it, and everything that is catalogue, configuration or
// identity stays.
//
// ── The backup is the point ───────────────────────────────────────────────────────
// This is the one destructive script in the repo that runs against the live database, so
// it copies every `*.db` in the data directory into `data/backup-<timestamp>/` BEFORE it
// opens a transaction, and refuses to delete anything if that copy did not happen. The
// copy goes through SQLite's `VACUUM INTO` rather than `fs.copyFile` so the write-ahead
// log is checkpointed into it: a plain file copy of a WAL database can be missing the last
// few minutes of writes, which is the worst possible property for a backup taken
// immediately before a delete.
//
// Live frames are in memory (`server/lib/live.js`, `server/lib/partyProgress.js`) and die
// with the process, so there is nothing here to delete for them — restarting the site is
// the wipe.

const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')

// Everything that is a record of play, a social act, or a lobby. In delete order: children
// before parents, so a foreign key never stands in the way.
const WIPE = [
  // games and everything hanging off one
  'game_players', 'replays', 'records', 'local_matches', 'assignments', 'games',
  // what a game awarded
  'badge_awards', 'badge_holds', 'xp_ledger', 'map_progress',
  // what a player said or chose
  'comments', 'ratings', 'favourites', 'feed', 'chat_network',
  // lobbies and presence
  'party_invites', 'party_members', 'parties', 'presence',
  // curated demo content
  'playlist_maps', 'playlists',
  // the seeded moderation queue: one report about a game that never happened
  'reports', 'infractions', 'bans',
  // the friend graph between demo accounts
  'friendships',
]

// Counters the schema keeps DENORMALISED on a row that is itself kept. These are the
// subtle half of the wipe and the half that is easy to miss: `maps.plays`, `beaten_by`,
// `thumbs_up`/`thumbs_down` and every account's level, prestige and XP total are cached
// sums maintained by the ingest path, not rows the deletes above can reach. Left alone,
// the site would show a wiped map with "Beaten by 2 · 1 game · 50%" and an account at
// level 6 with no games behind it — which is worse than the demo data was, because it is
// a number with nothing underneath it.
//
// Written as UPDATEs to zero rather than as a recompute, because there is nothing left to
// recompute FROM: every game, rating and XP ledger row has just been deleted. The ingest
// path puts them back the first time somebody plays.
const COUNTERS = [
  'UPDATE maps SET plays=0, beaten_by=0, thumbs_up=0, thumbs_down=0',
  'UPDATE users SET level=1, prestige=0, xp_total=0, active_ms=0, pinned_badges=NULL',
]

// Reserved demo SteamIDs. `server/db/seed.js` puts its invented players in the
// 7656119000000000x range precisely because it is NOT real SteamID64 space, so nothing
// here can ever match a person. Real accounts (`76561198…`, `76561199…`) are untouched,
// admin and mod flags included — that is the "keep users" half of B's instruction.
const DEMO_ID = /^7656119000000000\d$/

// Kept, and worth naming so the next reader does not have to diff two lists: `maps`,
// `map_versions`, `map_files`, `map_tags`, `tags`, `manifests`, `archive_sources`,
// `creators` (the catalogue and the archive), `badges`, `boards`, `presets` (definitions
// of what can be earned or configured, not records of anybody earning it), `boxes`,
// `activity_log` (a real audit trail, including the box key pins of §4d), `map_of_week`,
// `users`, `sessions` and `settings`.

function dataDir () {
  return process.env.ZM_DATA_DIR || path.join(__dirname, '..', 'data')
}

function stamp (d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')
}

/**
 * Copy every database in `dir` into `dir/backup-<timestamp>/`.
 *
 * @returns {{dir:string, files:string[]}}
 * @throws if there is a database to copy and copying it failed. A wipe without a backup
 *         does not happen.
 */
function backup (dir, at = new Date()) {
  const out = path.join(dir, 'backup-' + stamp(at))
  const dbs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.db')) : []
  fs.mkdirSync(out, { recursive: true })
  const files = []
  for (const f of dbs) {
    const dest = path.join(out, f)
    const src = new Database(path.join(dir, f), { readonly: true })
    try {
      src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
    } finally {
      src.close()
    }
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
      throw new Error(`backup of ${f} produced nothing at ${dest}`)
    }
    files.push(dest)
  }
  return { dir: out, files }
}

/** How many rows each wipeable table holds right now, plus the demo accounts. */
function survey (db) {
  const out = {}
  for (const t of WIPE) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) continue
    out[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c
  }
  out.users_demo = db.prepare('SELECT * FROM users').all().filter((u) => DEMO_ID.test(u.steam_id)).length
  return out
}

/**
 * @param {{dataDir?:string, dryRun?:boolean, at?:Date}} opts
 * @returns {{backup:string|null, before:object, after:object, users_removed:string[]}}
 */
function wipe (opts = {}) {
  const dir = opts.dataDir || dataDir()
  const file = path.join(dir, 'zombies.db')
  if (!fs.existsSync(file)) throw new Error('no database at ' + file)

  let backupDir = null
  if (!opts.dryRun) backupDir = backup(dir, opts.at || new Date()).dir

  const db = new Database(file)
  db.pragma('foreign_keys = OFF')
  const before = survey(db)
  let removed = []
  if (!opts.dryRun) {
    const run = db.transaction(() => {
      for (const t of WIPE) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) continue
        db.prepare(`DELETE FROM "${t}"`).run()
      }
      for (const sql of COUNTERS) {
        const table = sql.split(' ')[1]
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.prepare(sql).run()
      }
      removed = db.prepare('SELECT steam_id FROM users').all()
        .map((u) => u.steam_id).filter((id) => DEMO_ID.test(id))
      for (const id of removed) db.prepare('DELETE FROM users WHERE steam_id=?').run(id)
      // Autoincrement high-water marks, so the next real game is id 1 rather than id 9 and
      // nobody looking at the table later infers eight games that are not there. The table
      // only exists once something in the schema has said AUTOINCREMENT.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get()) {
        db.prepare('DELETE FROM sqlite_sequence WHERE name IN (' + WIPE.map(() => '?').join(',') + ')').run(...WIPE)
      }
    })
    run()
  }
  const after = survey(db)
  db.close()
  return { backup: backupDir, before, after, users_removed: removed }
}

module.exports = { wipe, backup, survey, WIPE, COUNTERS, DEMO_ID }

if (require.main === module) {
  const dry = process.argv.includes('--dry-run')
  const r = wipe({ dryRun: dry })
  const total = Object.entries(r.before).filter(([k]) => k !== 'users_demo')
    .reduce((n, [, c]) => n + c, 0)
  if (r.backup) console.log('backup  ' + r.backup)
  for (const [t, c] of Object.entries(r.before)) if (c) console.log(`  ${String(c).padStart(6)}  ${t}`)
  console.log(dry
    ? `\ndry run: ${total} rows and ${r.before.users_demo} demo account(s) would go. Nothing was touched.`
    : `\nwiped ${total} rows and ${r.users_removed.length} demo account(s). Maps, archive, users and flags kept.`)
  if (!dry) console.log('restart the site for the in-memory live frames to go with them.')
}
