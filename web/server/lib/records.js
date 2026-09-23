'use strict'

// Boards and records (99 §4.7, vault 10).
//
// A BOARD is (map, map version, category, player count, rule profile). Four things decide
// where a run goes and all four are load-bearing:
//
//   map version   old versions are frozen boards with basic tracking. A run on 1.0 never
//                 competes with a run on 1.1, because they are not the same map.
//   player count  solo / 2p / 3p / 4p, always split. A 4-player round 40 and a solo round 40
//                 are not comparable and never share a board.
//   category      round · ee_speedrun · buyable_speedrun · the four challenge brackets.
//   profile       the NAMED RULE PROFILE the run is checked against (ENW-Verified,
//                 ZWR-WaW-2025-09, SRC-WaW). A run is auto-checked against its profile and
//                 the MISMATCH IS SHOWN rather than the run being silently dropped —
//                 vault 10's rule, and the reason `profile_ok`/`profile_note` exist.
//
// A run is a TEAM's. `records.steam_id` is the primary holder and `records.roster` is
// everyone who was in it; the board shows the roster and every member holds the map's record
// badge while the run stands.

const { db, now } = require('../db/database')
const { safeJson } = require('./util')

const CATEGORY_LABEL = {
  round: 'Highest round',
  ee_speedrun: 'Easter Egg',
  buyable_speedrun: 'Buyable Ending',
  no_power: 'No Power',
  no_perks: 'No Perks',
  no_jug: 'No Jug',
  first_room: 'First Room',
}

const TIME_CATEGORIES = new Set(['ee_speedrun', 'buyable_speedrun'])

// ---- the rule profiles (11 §7) ---------------------------------------------------------
// The values a run is checked against. A run outside them still posts — it is real, it
// happened, and hiding it would be worse — but it is marked and the mismatch is shown.
const PROFILES = {
  'ENW-Verified': {
    label: 'ENW Verified',
    note: 'Our rules: stock settings, the archive version of the map, hash-checked, no cheat dvars.',
    check(run) {
      const bad = []
      if (run.mode !== 'verified') bad.push('not a Verified game')
      if (run.flags.includes('late_join')) bad.push('somebody joined late')
      if (run.flags.includes('all_afk')) bad.push('everyone went AFK')
      if (run.flags.includes('resumed')) bad.push('the game was resumed after a crash')
      return bad
    },
  },
  'ZWR-WaW-2025-09': {
    label: 'ZWR',
    note: 'Zombie World Records: FOV ≤ 120, com_maxfps 20–250 and unchanged mid-game, backspeed/strafe scale ≤ 1.0, sv_cheats 0, Regular difficulty, no zombie counter.',
    check(run) {
      const bad = []
      const d = run.dvars || {}
      const num = (k) => (d[k] == null ? null : Number(d[k]))
      const fov = num('cg_fov')
      const scale = num('cg_fovscale') ?? 1
      if (fov != null && fov * scale > 120) bad.push(`FOV ${fov} × ${scale} is over 120`)
      const fps = num('com_maxfps')
      if (fps != null && (fps < 20 || fps > 250)) bad.push(`com_maxfps ${fps} is outside 20–250`)
      for (const k of ['player_backspeedscale', 'player_strafespeedscale']) {
        const v = num(k)
        if (v != null && v > 1) bad.push(`${k} ${v} is over 1.0`)
      }
      if (num('sv_cheats')) bad.push('sv_cheats was on')
      if (run.settings && run.settings.zombie_counter) bad.push('the zombie counter was on')
      return bad
    },
  },
  'SRC-WaW': {
    label: 'speedrun.com',
    note: 'RTA from the first playable frame. The same dvar limits as ZWR.',
    check(run) { return PROFILES['ZWR-WaW-2025-09'].check(run) },
  },
}

// ---- game modes (docs/kickstart/game-modes.md) ---------------------------------------
// A map's own game mode (UGX's Classic / Gun Game / Sharpshooter ...) is a FIFTH thing that
// decides the board: a Gun Game round 12 and a Classic round 12 are not the same feat. The
// boards table's UNIQUE key is inline and cannot be altered without rebuilding a live table,
// so a mode's board carries the mode in its category key -- `round@gungame` -- and, for
// filtering, in its own `game_mode` column. A map without modes (and every board from before
// modes) has `game_mode` '' and a bare category, exactly as before.
const MODE_SEP = '@'
const baseCategory = (c) => String(c || '').split(MODE_SEP)[0]
const categoryKey = (c, gameMode) => (gameMode ? `${c}${MODE_SEP}${gameMode}` : c)
const labelOf = (c) => CATEGORY_LABEL[baseCategory(c)] || baseCategory(c)
const modeLabel = (mapKey, gm) => (gm ? require('./gameModes').label(mapKey, gm) : null)

function ensureBoard({ mapKey, versionId, category, playerCount, profile = 'ENW-Verified', gameMode = '' }) {
  const base = baseCategory(category)
  const gm = gameMode || ''
  const key = categoryKey(base, gm)
  const sort = TIME_CATEGORIES.has(base) ? 'time_asc' : 'round_desc'
  const label = gm ? `${labelOf(base)} · ${modeLabel(mapKey, gm)}` : labelOf(base)
  db.prepare(`INSERT OR IGNORE INTO boards (map_key, map_version_id, category, label, player_count, profile, sort, created_at, game_mode)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(String(mapKey), versionId || null, key, label, playerCount, profile, sort, now(), gm)
  return db.prepare(`SELECT * FROM boards WHERE map_key=? AND map_version_id IS ? AND category=? AND player_count=? AND profile=?`)
    .get(String(mapKey), versionId || null, key, playerCount, profile)
}

function rowsFor(boardId, limit = 50) {
  const b = db.prepare('SELECT * FROM boards WHERE id=?').get(Number(boardId))
  if (!b) return []
  const order = b.sort === 'time_asc' ? 'r.value_ms ASC' : 'r.round DESC, r.value_ms ASC'
  // `has_replay`, `kills`, `downs` are for the map page's records tab: a Watch button on the
  // row when the game's replay is on file, and the team's kills and downs for that game. The
  // two sums are NULL when the game has no player rows, so the page can hide an empty column.
  const rows = db.prepare(`SELECT r.*, g.ended_at, g.match_id AS game_match,
                                  (SELECT 1 FROM replays rp WHERE rp.game_id=r.game_id) AS has_replay,
                                  (SELECT SUM(gp.kills) FROM game_players gp WHERE gp.game_id=r.game_id) AS team_kills,
                                  (SELECT SUM(gp.downs) FROM game_players gp WHERE gp.game_id=r.game_id) AS team_downs
                             FROM records r LEFT JOIN games g ON g.id=r.game_id
                            WHERE r.board_id=? AND r.current=1 AND r.verified=1
                            ORDER BY ${order}, r.created_at ASC LIMIT ?`).all(Number(boardId), limit)
  const users = require('./users')
  return rows.map((r, i) => ({
    rank: i + 1,
    id: r.id,
    value_ms: r.value_ms,
    round: r.round,
    fingerprint: r.fingerprint,
    profile_ok: !!r.profile_ok,
    profile_note: r.profile_note || null,
    at: r.created_at,
    match_id: r.match_id || r.game_match || null,
    game_id: r.game_id || null,
    replay: !!r.has_replay && !!(r.match_id || r.game_match),
    kills: r.team_kills == null ? null : r.team_kills,
    downs: r.team_downs == null ? null : r.team_downs,
    players: (safeJson(r.roster, []) || [String(r.steam_id)]).map((sid) => users.publicById(sid)).filter(Boolean),
  }))
}

// Every board for a map, grouped for the map page: category, then player count.
// `gameMode`: undefined = every mode's boards (each group says its mode); a string = that
// mode's only ('' = the boards of a map without modes, or from before modes).
function forMap(mapKey, { versionId = null, profile = 'ENW-Verified', limit = 10, gameMode } = {}) {
  const where = ['map_key=?', 'profile=?']
  const args = [String(mapKey), profile]
  if (versionId) { where.push('map_version_id=?'); args.push(versionId) }
  if (gameMode !== undefined && gameMode !== null) { where.push("COALESCE(game_mode,'')=?"); args.push(String(gameMode)) }
  const boards = db.prepare(`SELECT * FROM boards WHERE ${where.join(' AND ')} ORDER BY category, player_count`).all(...args)
  const groups = new Map()
  for (const b of boards) {
    if (!groups.has(b.category)) {
      groups.set(b.category, {
        category: b.category, base: baseCategory(b.category), label: labelOf(b.category), sort: b.sort,
        game_mode: b.game_mode || null, game_mode_label: modeLabel(mapKey, b.game_mode), counts: [],
      })
    }
    groups.get(b.category).counts.push({
      player_count: b.player_count,
      board_id: b.id,
      frozen: !!b.frozen,
      rows: rowsFor(b.id, limit),
    })
  }
  // A board with no runs on it still renders — 13's rule about empty states is that they say
  // why, and "nobody has done this yet" is information.
  return [...groups.values()]
}

// ---- submission --------------------------------------------------------------------
/**
 * Post a finished game to every board it belongs on.
 *
 * Called from lib/results.ingest with the row already written. Returns the records created,
 * so the caller can write the feed lines and move the held record badges.
 */
function submitFromGame(game, summary) {
  if (!game.records_eligible) return []
  const roster = db.prepare('SELECT steam_id, slot FROM game_players WHERE game_id=? AND late=0 ORDER BY slot').all(game.id)
  if (!roster.length) return []
  const ids = roster.map((r) => r.steam_id)
  const primary = ids[0]
  const pc = Math.min(4, Math.max(1, ids.length))

  const run = {
    mode: game.mode,
    flags: safeJson(game.flags, []) || [],
    dvars: (summary && summary.dvars) || {},
    settings: safeJson(game.settings_json, {}) || {},
  }

  const made = []
  const cats = []
  // Every game posts to the round board for its player count.
  cats.push({ category: 'round', round: game.rounds, value_ms: game.duration_ms })
  // A speedrun category only exists if the run actually finished that way.
  if (game.finish_kind === 'easter_egg') cats.push({ category: 'ee_speedrun', round: game.rounds, value_ms: game.duration_ms })
  if (game.finish_kind === 'buyable_ending') cats.push({ category: 'buyable_speedrun', round: game.rounds, value_ms: game.duration_ms })
  // A locked challenge preset posts to its own bracket as well as to the open one.
  const challenge = run.settings && run.settings.challenge
  if (challenge && CATEGORY_LABEL[challenge]) cats.push({ category: challenge, round: game.rounds, value_ms: game.duration_ms })

  for (const profile of Object.keys(PROFILES)) {
    const problems = PROFILES[profile].check(run)
    // ENW-Verified is the site's own board and a run that fails it does not belong on it at
    // all. The external profiles are DESCRIPTIVE — a run that misses a ZWR rule still posts,
    // marked, because vault 10 wants the mismatch shown rather than the run hidden.
    if (profile === 'ENW-Verified' && problems.length) continue
    for (const c of cats) {
      // An external profile only gets the categories it actually has. ZWR and
      // speedrun.com run highest-round and the two speedruns; the four ENW challenge
      // brackets are ours, and minting a "ZWR No Jug" board would be inventing a category
      // on somebody else's behalf — and would put the same run on three boards that all
      // say the same thing.
      if (profile !== 'ENW-Verified' && !['round', 'ee_speedrun', 'buyable_speedrun'].includes(c.category)) continue
      const board = ensureBoard({ mapKey: game.map_key, versionId: game.map_version_id, category: c.category, playerCount: pc, profile,
        gameMode: game.game_mode || '' })
      if (!board || board.frozen) continue
      const rec = insertRun(board, {
        steamId: primary, roster: ids, gameId: game.id, matchId: game.match_id,
        valueMs: c.value_ms, round: c.round, fingerprint: game.fingerprint,
        profileOk: problems.length === 0,
        profileNote: problems.length ? problems.join('; ') : null,
      })
      if (rec) made.push({ board, record: rec })
    }
  }
  return made
}

// A roster's standing entry on a board. A slower later run is stored (it is evidence, and
// the replay is attached to it) but `current` moves only when the run is better.
function insertRun(board, r) {
  const key = JSON.stringify([...r.roster].sort())
  const existing = db.prepare('SELECT * FROM records WHERE board_id=? AND roster=? AND current=1').get(board.id, key)
  const better = !existing
    || (board.sort === 'time_asc' ? (r.valueMs ?? Infinity) < (existing.value_ms ?? Infinity)
      : (r.round ?? 0) > (existing.round ?? 0))
  const info = db.prepare(`INSERT INTO records (board_id, steam_id, roster, game_id, match_id, value_ms, round,
                                                fingerprint, profile_ok, profile_note, current, verified, created_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`)
    .run(board.id, r.steamId, key, r.gameId, r.matchId, r.valueMs, r.round, r.fingerprint,
      r.profileOk ? 1 : 0, r.profileNote, better ? 1 : 0, now())
  if (better && existing) db.prepare('UPDATE records SET current=0 WHERE id=?').run(existing.id)
  return db.prepare('SELECT * FROM records WHERE id=?').get(info.lastInsertRowid)
}

// The record hub: the top row of every board, newest first, across every map.
function hub({ category = null, playerCount = null, profile = 'ENW-Verified', limit = 60, gameMode = null } = {}) {
  const where = ['b.profile=?']
  const args = [profile]
  // `category` is the base category (every mode's board of it); `gameMode` narrows to one mode.
  if (category) { where.push(`(b.category=? OR b.category LIKE ?)`); args.push(category, `${category}${MODE_SEP}%`) }
  if (gameMode) { where.push('b.game_mode=?'); args.push(String(gameMode)) }
  if (playerCount) { where.push('b.player_count=?'); args.push(Number(playerCount)) }
  const boards = db.prepare(`SELECT b.*, m.title FROM boards b JOIN maps m ON m.key=b.map_key
                              WHERE ${where.join(' AND ')} ORDER BY b.map_key, b.category, b.player_count`).all(...args)
  const out = []
  for (const b of boards) {
    const rows = rowsFor(b.id, 1)
    if (!rows.length) continue
    out.push({
      board_id: b.id, map_key: b.map_key, map_title: b.title, category: b.category,
      label: labelOf(b.category), base: baseCategory(b.category), player_count: b.player_count,
      game_mode: b.game_mode || null, game_mode_label: modeLabel(b.map_key, b.game_mode),
      profile: b.profile, sort: b.sort, top: rows[0],
    })
  }
  out.sort((a, b) => (b.top.at || 0) - (a.top.at || 0))
  return out.slice(0, limit)
}

// What this player currently holds. DEDUPED by (map, category, player count): the same run
// stands on the ENW board and on the ZWR and speedrun.com boards, and listing it three
// times on a profile says nothing the first line did not. ENW-Verified wins because it is
// the board this site owns; the others are shown on the map page where the profile filter
// is a visible control.
function heldBy(steamId) {
  const sid = String(steamId)
  const rows = db.prepare(`SELECT r.*, b.map_key, b.category, b.player_count, b.profile, b.sort, b.game_mode, m.title
                             FROM records r JOIN boards b ON b.id=r.board_id JOIN maps m ON m.key=b.map_key
                            WHERE r.current=1 AND r.verified=1 AND r.roster LIKE ?
                            ORDER BY CASE b.profile WHEN 'ENW-Verified' THEN 0 ELSE 1 END`).all(`%"${sid}"%`)
  const held = []
  const seen = new Set()
  for (const r of rows) {
    const key = `${r.map_key}|${r.category}|${r.player_count}`
    if (seen.has(key)) continue
    const top = rowsFor(r.board_id, 1)[0]
    if (top && top.id === r.id) {
      seen.add(key)
      held.push({
        map_key: r.map_key, map_title: r.title, category: r.category, label: labelOf(r.category), base: baseCategory(r.category),
        game_mode: r.game_mode || null, game_mode_label: modeLabel(r.map_key, r.game_mode),
        player_count: r.player_count, profile: r.profile, round: r.round, value_ms: r.value_ms, at: r.created_at,
        match_id: top.match_id, replay: top.replay,
      })
    }
  }
  return held
}

const categories = () => Object.entries(CATEGORY_LABEL).map(([key, label]) => ({ key, label, time: TIME_CATEGORIES.has(key) }))
const profiles = () => Object.entries(PROFILES).map(([key, p]) => ({ key, label: p.label, note: p.note }))

module.exports = {
  CATEGORY_LABEL, TIME_CATEGORIES, PROFILES,
  ensureBoard, rowsFor, forMap, submitFromGame, hub, heldBy, categories, profiles, baseCategory, categoryKey,
}
