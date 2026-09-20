'use strict'

// XP, levels and prestige (05 "XP, levels & prestige", 99 §4.6).
//
// XP IS ACTIVE TIME, not kills and not rounds. Verified full, Custom 25%, Local none.
// Paused time never counts.
//
// **The active-time score is not computed here.** It is a risk/trust score over signals only
// the game box sees — view movement from usercmds, player movement, damage, points spent,
// round progression, and how the minute compares with that player's own average — and the
// box is the only thing with them. The site consumes `time_alive_ms` and the referee's
// flags, applies the multiplier and writes a ledger row. When the box grows a real
// `active_ms` field (it will: the protocol already carries `input`), this file reads that
// instead of the fallback below and nothing else changes.
//
// THE FALLBACK IS DELIBERATELY CONSERVATIVE. Until the box scores minutes, a player is
// credited with their time alive capped at the game's own length, minus paused time, and a
// game flagged `all_afk` or `afk_kick` credits that player nothing. It under-credits rather
// than over-credits, because 05's whole worry is XP farming on a rented server.
//
// The curve is confirmed: 65 levels per prestige, prestige unlimited, each level costing a
// set number of active minutes rising gently. The exact weights are Q29 and get tuned on
// beta data; they are two constants here so tuning is one edit.

const { db, now } = require('../db/database')
const { safeJson } = require('./util')

const LEVELS_PER_PRESTIGE = 65
// Minutes of active play for level 1→2, and the gentle rise per level. 8 minutes to the
// first level and ~28 to the last of a prestige puts a full prestige at roughly 20 hours of
// active play, which is the right order for a game whose sessions are measured in hours.
const BASE_MINUTES = 8
const RISE = 0.31
const XP_PER_MINUTE = 100

const MULTIPLIER = { verified: 1, custom: 0.25, local: 0 }

/** Active minutes needed to go from `level` to `level + 1`. */
const costOf = (level) => Math.round(BASE_MINUTES + RISE * (Math.min(level, LEVELS_PER_PRESTIGE) - 1)) * XP_PER_MINUTE

/** Total XP to reach `level` within one prestige. */
function toLevel(level) {
  let t = 0
  for (let l = 1; l < level; l++) t += costOf(l)
  return t
}

const PRESTIGE_COST = toLevel(LEVELS_PER_PRESTIGE + 1)

/** Where an XP total lands. Prestige is unlimited, so this never saturates. */
function standing(xpTotal) {
  const xp = Math.max(0, Number(xpTotal) || 0)
  const prestige = Math.floor(xp / PRESTIGE_COST)
  let rest = xp - prestige * PRESTIGE_COST
  let level = 1
  while (level < LEVELS_PER_PRESTIGE && rest >= costOf(level)) { rest -= costOf(level); level++ }
  const next = level < LEVELS_PER_PRESTIGE ? costOf(level) : null
  return {
    prestige,
    level,
    xp,
    into_level: rest,
    next_level_cost: next,
    progress: next ? Math.min(1, rest / next) : 1,
    emblem: emblemFor(prestige),
  }
}

// 05's emblem table. 1–10 are WaW's own icons (placeholder art), 11 is the missing-texture
// icon — the Easter egg for the glitched "11th prestige" — 12–22 repeat in silver and 23–33
// in gold. 34+ is TBD, and rather than invent something it keeps cycling the gold set with
// the tier number shown, which is honest about being unfinished.
function emblemFor(prestige) {
  if (prestige <= 0) return { tier: 0, icon: 'none', finish: 'none', label: 'No prestige' }
  if (prestige === 11) return { tier: 11, icon: 'missing', finish: 'none', label: 'Missing texture' }
  if (prestige <= 10) return { tier: prestige, icon: `waw-${prestige}`, finish: 'plain', label: `Prestige ${prestige}` }
  if (prestige <= 22) return { tier: prestige, icon: `waw-${prestige - 11}`, finish: 'silver', label: `Prestige ${prestige}` }
  if (prestige <= 33) return { tier: prestige, icon: `waw-${prestige - 22}`, finish: 'gold', label: `Prestige ${prestige}` }
  return { tier: prestige, icon: `waw-${((prestige - 34) % 11) + 1}`, finish: 'gold', label: `Prestige ${prestige}`, tbd: true }
}

/**
 * Credit one player for one game. Idempotent per (game, player): the ledger's own rows are
 * the guard, so replaying a result post never pays twice.
 */
function creditGame(game, player) {
  const sid = String(player.steam_id)
  const already = db.prepare('SELECT 1 FROM xp_ledger WHERE steam_id=? AND game_id=? AND reason=?').get(sid, game.id, 'game')
  if (already) return null

  const mult = MULTIPLIER[game.mode] != null ? MULTIPLIER[game.mode] : 0
  if (!mult) return null

  const flags = safeJson(game.flags, []) || []
  // An AFK kick pays that player nothing for the game — the kick IS the finding that the
  // minutes were not play.
  if (player.afk_kicked || flags.includes('all_afk')) return writeLedger(sid, game.id, 0, mult, 'afk')

  // Time alive, capped at the game's own length and with paused time removed. `duration_ms`
  // is in-game time and already excludes pauses (host.md §4), so this is belt and braces.
  const cap = Math.max(0, (game.duration_ms || 0) - (game.paused_ms || 0))
  const activeMs = Math.max(0, Math.min(player.time_alive_ms || 0, cap))
  const minutes = activeMs / 60_000
  const xp = Math.round(minutes * XP_PER_MINUTE * mult)
  return writeLedger(sid, game.id, activeMs, mult, 'game', xp)
}

function writeLedger(sid, gameId, activeMs, mult, note, xp = 0) {
  db.prepare(`INSERT INTO xp_ledger (steam_id, game_id, reason, active_ms, multiplier, xp, note, created_at)
              VALUES (?,?,?,?,?,?,?,?)`).run(sid, gameId, 'game', activeMs, mult, xp, note, now())
  const before = standing(db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get(sid)?.xp_total || 0)
  db.prepare(`UPDATE users SET xp_total = COALESCE(xp_total,0) + ?, active_ms = COALESCE(active_ms,0) + ? WHERE steam_id=?`)
    .run(xp, activeMs, sid)
  const row = db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get(sid)
  const after = standing(row ? row.xp_total : 0)
  db.prepare('UPDATE users SET level=?, prestige=? WHERE steam_id=?').run(after.level, after.prestige, sid)
  if (gameId) db.prepare('UPDATE game_players SET xp_awarded=? WHERE game_id=? AND steam_id=?').run(xp, gameId, sid)
  return { xp, activeMs, before, after, levelled: after.level !== before.level || after.prestige !== before.prestige }
}

/** Rebuild a player's total from the ledger. The cache is a cache; this is the truth. */
function rebuild(steamId) {
  const sid = String(steamId)
  const t = db.prepare('SELECT COALESCE(SUM(xp),0) xp, COALESCE(SUM(active_ms),0) ms FROM xp_ledger WHERE steam_id=?').get(sid)
  const s = standing(t.xp)
  db.prepare('UPDATE users SET xp_total=?, active_ms=?, level=?, prestige=? WHERE steam_id=?').run(t.xp, t.ms, s.level, s.prestige, sid)
  return s
}

const forPlayer = (steamId) => standing(db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get(String(steamId))?.xp_total || 0)

module.exports = {
  LEVELS_PER_PRESTIGE, PRESTIGE_COST, XP_PER_MINUTE, MULTIPLIER,
  costOf, toLevel, standing, emblemFor, creditGame, rebuild, forPlayer,
}
