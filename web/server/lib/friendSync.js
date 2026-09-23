'use strict'

// FRIENDS FROM THE REST OF ENW, READ-ONLY (lane SOC, 2026-09-23; web.md "Friends across ENW").
//
// B: "ENW friends need to carry over to ENW Zombies from the ENW main server, from Movement
// and from drops. The whole system needs to be connected friends-wise."
//
// WHERE ENW'S FRIENDS ACTUALLY LIVE (checked read-only on 2026-09-23, not assumed):
//
//   movement   `friendships` in Movement's prod DB (movement.enw.gg, `matchmaker.db` on the web
//              host). Movement's own table, the one this site's `friendships` was copied from
//              verbatim. GOnext PvP already reads it the same way (read-only, "main" DB). This
//              IS the ENW friend graph: 89 accepted pairs on the day this was written.
//   drops      drops.ws's `database.db` has NO friend table (all 70-odd tables listed; the only
//              "friend" in its source is whether the Steam bot is on your Steam friends list).
//              drops shares identity by SteamID and the ENW username, not friends.
//   enw.gg     the main ENW site (PHP + MySQL on shared hosting) has no friends feature either,
//              and the ENW Discord server has no readable friend graph (Discord gives bots no
//              friends list). So nothing to import from them today.
//
// So one source is wired, and the shape takes more: a source is a name plus how to run one
// SELECT against it. Adding drops later, if it ever grows friends, is one entry in SOURCES.
//
// HOW IT READS, AND THE RULES IT KEEPS
//
//   * `sqlite3 -readonly` over ssh, with the site owner's existing key (`ssh <host>` from the
//     machine this site runs on, BatchMode so it can never prompt). Movement's live DB runs
//     busy_timeout=0; a plain open can write (a WAL checkpoint, a journal), a -readonly one
//     cannot. The SQL goes in on stdin, so nothing from a row or a user reaches a shell.
//   * It asks only for pairs where BOTH ends already have an ENW Zombies account (the IN
//     lists below), so the other product's wider graph never lands here. Only SteamID64s
//     cross the wire, in both directions: no names, emails or anything else.
//   * Nothing on the Movement host is written, migrated, restarted or deployed. Ever.
//   * Soft-fails: host down, key refused, table renamed = the old edges stay, the error is
//     recorded in `friend_sync`, and the site carries on. Every read path here is optional.
//
// WHEN: at start, every ZM_FRIENDS_SYNC_MIN minutes (default 10), and when somebody connects
// who was not in the last sync's account list (a new sign-in), at most every 15 s.
//
// CONFIG (all unset = off, which is what the tests and every other box get):
//   ZM_FRIENDS_MOVEMENT_SSH     ssh host (an alias from ~/.ssh/config, or user@host)
//   ZM_FRIENDS_MOVEMENT_DB      the DB path on that host (default below)
//   ZM_FRIENDS_MOVEMENT_LOCAL   a local copy of a Movement DB, opened readonly instead of ssh
//                               (the tests; a box that has the file)

const fs = require('fs')
const { execFile } = require('child_process')
const { db, now } = require('../db/database')

const DEFAULT_MOVEMENT_DB = '/home/deploy/gonext/data/matchmaker.db'
const SID = /^\d{17}$/
const HOST_OK = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,120}$/      // no leading '-': never an ssh option
const PATH_OK = /^\/[A-Za-z0-9._/-]{1,200}$/
const MAX_IN = 1500             // above this the SELECT takes every accepted pair and filters here
const NEW_USER_FLOOR_MS = 15_000
const TIMEOUT_MS = 30_000

// Places that were checked and hold no friend graph. Shown on the admin status so "why are
// my drops friends not here" has an answer that is not a shrug.
const NOT_SOURCES = [
  { source: 'drops', why: 'drops.ws has no friends table (checked 2026-09-23); it shares SteamID and ENW username only' },
  { source: 'enw.gg', why: 'the ENW main site and Discord server have no readable friend list (checked 2026-09-23)' },
]

// Both reads are ONE statement, the same text over ssh and against a local copy.
function selectSql(ids) {
  const clean = ids.filter((s) => SID.test(s))
  if (!clean.length) return null
  if (clean.length > MAX_IN) {
    return "SELECT requester_steam_id, addressee_steam_id FROM friendships WHERE status='accepted';"
  }
  const list = clean.map((s) => `'${s}'`).join(',')
  return `SELECT requester_steam_id, addressee_steam_id FROM friendships WHERE status='accepted' AND requester_steam_id IN (${list}) AND addressee_steam_id IN (${list});`
}

// The exact argv. Exported so a test can pin it: -readonly is not optional.
function sshArgs(host, dbPath) {
  if (!HOST_OK.test(String(host || ''))) throw new Error('bad ssh host')
  if (!PATH_OK.test(String(dbPath || ''))) throw new Error('bad db path')
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10',
    host, `sqlite3 -readonly -bail -csv '${dbPath}'`]
}

function sshRunner(host, dbPath, { bin = process.env.ZM_FRIENDS_SSH_BIN || 'ssh' } = {}) {
  const args = sshArgs(host, dbPath)
  return (sql) => new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String((stderr || err.message || '')).trim().slice(0, 300) || 'ssh failed'))
        resolve(parseCsv(stdout))
      })
    child.stdin.on('error', () => { /* the exit callback reports it */ })
    child.stdin.end(`.timeout 3000\n${sql}\n`)
  })
}

function localRunner(file) {
  return async (sql) => {
    if (!fs.existsSync(file)) throw new Error('no such file')
    const Database = require('better-sqlite3')
    const h = new Database(file, { readonly: true, fileMustExist: true })
    try {
      h.pragma('busy_timeout = 3000')
      return h.prepare(sql).raw().all().map((r) => [String(r[0]), String(r[1])])
    } finally { h.close() }
  }
}

function parseCsv(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^"?(\d{17})"?,"?(\d{17})"?$/.exec(line.trim())
    if (m) out.push([m[1], m[2]])
  }
  return out
}

// name -> { run(sql) => [[a,b]...], mode }. Built from env on first use; `configure` swaps it.
let sources = null
function fromEnv() {
  const s = {}
  const local = process.env.ZM_FRIENDS_MOVEMENT_LOCAL
  const host = process.env.ZM_FRIENDS_MOVEMENT_SSH
  if (local) s.movement = { mode: 'local', run: localRunner(local) }
  else if (host) {
    try { s.movement = { mode: 'ssh', run: sshRunner(host, process.env.ZM_FRIENDS_MOVEMENT_DB || DEFAULT_MOVEMENT_DB) } } catch (e) {
      s.movement = { mode: 'ssh', run: async () => { throw e } }
    }
  }
  return s
}
const SOURCES = () => (sources || (sources = fromEnv()))
function configure(map) { sources = map; lastIds = null }

let onChange = () => {}
function setOnChange(fn) { onChange = typeof fn === 'function' ? fn : () => {} }

let running = null
let lastIds = null              // the account list the last sync asked about
let lastTry = 0

const accountIds = () => db.prepare('SELECT steam_id FROM users WHERE deleted=0').all()
  .map((r) => String(r.steam_id)).filter((s) => SID.test(s))

const edgeKey = (a, b) => (a < b ? [a, b] : [b, a])
const signature = (source) => db.prepare('SELECT a, b FROM friend_edges WHERE source=? ORDER BY a, b').all(source)
  .map((r) => `${r.a}-${r.b}`).join(',')

async function syncOne(name, src, ids, reason) {
  const t = now()
  db.prepare(`INSERT INTO friend_sync (source, tried_at, reason) VALUES (?,?,?)
              ON CONFLICT(source) DO UPDATE SET tried_at=excluded.tried_at, reason=excluded.reason`).run(name, t, reason)
  const sql = selectSql(ids)
  if (!sql) return { source: name, ok: true, edges: 0, changed: false }
  let rows
  try { rows = await src.run(sql) } catch (e) {
    const error = String(e && e.message || e).slice(0, 300)
    db.prepare('UPDATE friend_sync SET error=? WHERE source=?').run(error, name)
    return { source: name, ok: false, error }
  }
  const mine = new Set(ids)
  const pairs = new Map()
  for (const [x, y] of rows) {
    if (!SID.test(x) || !SID.test(y) || x === y || !mine.has(x) || !mine.has(y)) continue
    const [a, b] = edgeKey(x, y)
    pairs.set(`${a}-${b}`, [a, b])
  }
  const before = signature(name)
  db.transaction(() => {
    db.prepare('DELETE FROM friend_edges WHERE source=?').run(name)
    const ins = db.prepare('INSERT OR IGNORE INTO friend_edges (a, b, source, synced_at) VALUES (?,?,?,?)')
    for (const [a, b] of pairs.values()) ins.run(a, b, name, t)
    db.prepare('UPDATE friend_sync SET ok_at=?, edges=?, error=NULL WHERE source=?').run(t, pairs.size, name)
  })()
  const changed = signature(name) !== before
  return { source: name, ok: true, edges: pairs.size, changed }
}

/** Run every configured source now. Concurrent calls share one run. */
function syncAll(reason = 'manual') {
  if (running) return running
  const all = SOURCES()
  const names = Object.keys(all)
  if (!names.length) return Promise.resolve({ ok: true, configured: false, results: [] })
  lastTry = Date.now()
  const ids = accountIds()
  running = (async () => {
    const results = []
    for (const n of names) results.push(await syncOne(n, all[n], ids, reason))
    lastIds = new Set(ids)
    if (results.some((r) => r.changed)) { try { onChange(results) } catch { /* a listener never fails a sync */ } }
    return { ok: results.every((r) => r.ok), configured: true, results }
  })().finally(() => { running = null })
  return running
}

/**
 * Somebody connected. If they were not an account when the last sync asked, sync now (15 s
 * floor), so a friend who signs in for the first time finds their Movement friends at once.
 */
function maybeSync(reason, steamId) {
  if (!Object.keys(SOURCES()).length || running) return null
  const sid = String(steamId || '')
  const unseen = sid && (!lastIds || !lastIds.has(sid))
  if (unseen && Date.now() - lastTry >= NEW_USER_FLOOR_MS) return syncAll(reason)
  return null
}

let timer = null
function start() {
  if (timer || !Object.keys(SOURCES()).length) return false
  const min = Math.max(2, Number(process.env.ZM_FRIENDS_SYNC_MIN) || 10)
  syncAll('start').catch(() => {})
  timer = setInterval(() => { syncAll('timer').catch(() => {}) }, min * 60_000)
  timer.unref()
  return true
}
function stop() { if (timer) clearInterval(timer); timer = null }

function status() {
  const rows = new Map(db.prepare('SELECT * FROM friend_sync').all().map((r) => [r.source, r]))
  const conf = SOURCES()
  const out = Object.keys(conf).map((n) => ({ source: n, configured: true, mode: conf[n].mode, ...(rows.get(n) || {}) }))
  for (const [n, r] of rows) if (!conf[n]) out.push({ source: n, configured: false, ...r })
  return { sources: out, not_sources: NOT_SOURCES, running: !!running }
}

/** The sources a pair of accounts are friends through, other than this site's own table. */
function sourcesOf(x, y) {
  const [a, b] = edgeKey(String(x), String(y))
  return db.prepare('SELECT source FROM friend_edges WHERE a=? AND b=?').all(a, b).map((r) => r.source)
}

/** Every account `steamId` is friends with through an imported source. */
function importedFriendIds(steamId) {
  const sid = String(steamId)
  return db.prepare('SELECT CASE WHEN a=? THEN b ELSE a END AS id FROM friend_edges WHERE a=? OR b=?')
    .all(sid, sid, sid).map((r) => r.id)
}

module.exports = {
  syncAll, maybeSync, start, stop, status, configure, setOnChange,
  sourcesOf, importedFriendIds,
  // for the tests
  selectSql, sshArgs, parseCsv, localRunner, sshRunner, DEFAULT_MOVEMENT_DB, NOT_SOURCES,
}
