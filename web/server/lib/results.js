'use strict'

// Ingest — what happens when a game box POSTs /api/gs/result.
//
// This is the single most important write path on the site: it is where a game that
// happened on a box becomes a row, a badge, a record, a level and a line on the home page.
// Everything else on the site reads what this function wrote.
//
// Three rules shape it:
//
//   1. THE BOX DECIDES WHAT HAPPENED; THE SITE DECIDES WHAT IT IS WORTH. The referee's
//      summary (host.md §4) is authoritative about rounds, finishes, flags and eligibility —
//      it watched the game and we did not. The site never second-guesses it. What the site
//      owns is the consequence: which badge, which board, how much XP, who sees it.
//   2. IT IS IDEMPOTENT. A box that retries because the site was down (the coordinator's
//      Q-host-2 answer: spool and retry) must not mint a second badge or a second level.
//      `games.match_id` is UNIQUE and a repeat post updates rather than inserts; XP is
//      guarded by its own ledger; badges by their composite key.
//   3. IT NEVER THROWS INTO THE BOX'S REQUEST. A box whose result post 500s will retry
//      forever. Everything after the game row is written is wrapped, and a failure is logged
//      and surfaced on the admin page rather than bounced back.
//
// What we deliberately do NOT do: verify the replay. The file lives on the box (and later in
// R2); the site stores the pointer, the signing key id and whether that key matched the
// box's pin. Verification is `tools/verify.js --pub <pinned key>` and belongs where the
// bytes are.

const { db, now } = require('../db/database')
const { safeJson } = require('./util')
const users = require('./users')
const badges = require('./badges')
const records = require('./records')
const mapRecords = require('./mapRecords')
const xp = require('./xp')
const feed = require('./feed')
const boxes = require('./boxes')

const FINISH_LABEL = { easter_egg: 'Easter Egg', buyable_ending: 'Buyable Ending', round: 'Round' }

// May this game's numbers appear as a player's ACHIEVEMENT — a best round, a career high —
// rather than merely in their history? Only a Verified game we refereed on our own box.
// Local is the player's PC with cheats; Custom can start at round 100 by design; a
// self-reported result did not come from a box at all.
const eligibleForStats = (game) => game.mode === 'verified' && !game.self_reported

/**
 * @param {object} body  the box's POST body: { box, instance, summary, replay }
 * @returns {object} { ok, game_id, match_id, awarded, records, repeat }
 */
function ingest(body, { selfReported = false } = {}) {
  const summary = body && body.summary
  if (!summary || !summary.match_id) return { ok: false, error: 'no summary' }

  // ── THE LOCAL DOWNGRADE ─────────────────────────────────────────────────────────
  // 13 §4: a Local game runs on the player's own PC "as just a normal client", with the
  // full console and cheats, and nothing is tracked — "if they want their stuff tracked,
  // they have to play through our servers."
  //
  // The referee already sets `records_eligible: false` and `xp_multiplier: 0` for a local
  // game, and it is right to. This does it AGAIN, here, and it is not redundant: rule 1 of
  // this file is that the box decides what happened and the site decides what it is worth,
  // and "worth nothing" is the one verdict the site must not be able to be talked out of.
  // A box that sends `mode: 'local', records_eligible: true` — through a bug, a fork, or
  // because somebody's PC is posting it — gets zero anyway.
  const isLocal = String(summary.mode || '') === 'local'
  const untrusted = isLocal || selfReported
  if (untrusted) {
    summary.records_eligible = false
    summary.xp_multiplier = 0
  }

  const existing = db.prepare('SELECT * FROM games WHERE match_id=?').get(String(summary.match_id))
  const map = db.prepare('SELECT * FROM maps WHERE key=?').get(String(summary.map || ''))
  const version = map ? db.prepare('SELECT * FROM map_versions WHERE map_id=? AND latest=1').get(map.id) : null
  const assignment = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(String(summary.match_id))

  const row = {
    match_id: String(summary.match_id),
    box: body.box || (assignment ? boxes.nameOf(assignment.box_id) : null),
    instance: body.instance || summary.instance || null,
    mode: summary.mode || 'verified',
    map_key: String(summary.map || ''),
    map_id: map ? map.id : null,
    map_version_id: version ? version.id : null,
    fs_game: summary.fs_game || null,
    party_id: assignment ? assignment.party_id : null,
    settings_json: assignment ? assignment.settings_json : null,
    fingerprint: summary.fingerprint || null,
    rounds: Number(summary.rounds || 0),
    finish_kind: summary.finish ? summary.finish.kind : null,
    finish_label: summary.finish ? (summary.finish.label || FINISH_LABEL[summary.finish.kind] || null) : null,
    badge_earned: summary.badge ? (summary.badge.kind || null) : null,
    player_count: Number(summary.player_count || (summary.players || []).length),
    solo: summary.solo ? 1 : 0,
    duration_ms: Number(summary.duration_ms || 0),
    duration_rta_ms: Number(summary.duration_rta_ms || 0),
    paused_ms: Number(summary.paused_ms || 0),
    flags: JSON.stringify(summary.flags || []),
    records_eligible: summary.records_eligible ? 1 : 0,
    xp_multiplier: Number(summary.xp_multiplier != null ? summary.xp_multiplier : 1),
    end_reason: summary.end_reason || null,
    started_at: summary.started_at ? Date.parse(summary.started_at) : null,
    ended_at: summary.ended_at ? Date.parse(summary.ended_at) : now(),
    received_at: now(),
    self_reported: untrusted ? 1 : 0,
    summary_json: JSON.stringify(summary),
  }

  if (existing) {
    // A retry. Refresh the row (the box may have learned more, e.g. the replay closed) and
    // stop: the consequences below already ran.
    db.prepare(`UPDATE games SET summary_json=?, received_at=?, ended_at=COALESCE(ended_at,?) WHERE id=?`)
      .run(row.summary_json, now(), row.ended_at, existing.id)
    if (body.replay) storeReplay(existing, body)
    return { ok: true, game_id: existing.id, match_id: row.match_id, repeat: true }
  }

  const info = db.prepare(`INSERT INTO games (match_id, box, instance, mode, map_key, map_id, map_version_id, fs_game,
      party_id, settings_json, fingerprint, rounds, finish_kind, finish_label, badge_earned, player_count, solo,
      duration_ms, duration_rta_ms, paused_ms, flags, records_eligible, xp_multiplier, end_reason,
      started_at, ended_at, received_at, self_reported, summary_json)
    VALUES (@match_id,@box,@instance,@mode,@map_key,@map_id,@map_version_id,@fs_game,@party_id,@settings_json,
      @fingerprint,@rounds,@finish_kind,@finish_label,@badge_earned,@player_count,@solo,@duration_ms,
      @duration_rta_ms,@paused_ms,@flags,@records_eligible,@xp_multiplier,@end_reason,@started_at,@ended_at,
      @received_at,@self_reported,@summary_json)`).run(row)
  const game = db.prepare('SELECT * FROM games WHERE id=?').get(info.lastInsertRowid)

  const insP = db.prepare(`INSERT OR REPLACE INTO game_players (game_id, steam_id, slot, name, score, kills, headshots,
      downs, revives, bleedouts, points_earned, points_spent, time_alive_ms, rounds_played, joined_round, late, afk_kicked)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const seated = []
  for (const p of summary.players || []) {
    // A player with no SteamID is a slot the box could not identify — a bot, a local test,
    // or a connect the DLL saw before the token check. It is recorded in summary_json and
    // NOT given a row here, because a row keyed on a made-up id would attach somebody's
    // badge to nobody.
    if (!p.steamid) continue
    const s = p.stats || {}
    insP.run(game.id, String(p.steamid), p.slot ?? null, p.name || null,
      p.score || 0, s.kills ?? p.kills ?? 0, s.headshots ?? 0, s.downs ?? p.downs ?? 0,
      s.revives ?? p.revives ?? 0, s.deaths ?? p.bleedouts ?? 0,
      s.points_earned ?? 0, s.points_spent ?? 0, s.time_alive_ms ?? 0,
      s.rounds_played ?? p.rounds_played ?? 0, p.joined_round ?? 1,
      p.late ? 1 : 0, p.afk_kicked ? 1 : 0)
    users.ensure(p.steamid, { username: p.name || null })
    seated.push({ ...p, steam_id: String(p.steamid) })
  }

  if (body.replay) storeReplay(game, body)

  const out = { ok: true, game_id: game.id, match_id: game.match_id, awarded: [], records: [], errors: [] }

  // Everything below is consequence, and none of it may fail the box's POST.
  try { out.awarded = applyProgressAndBadges(game, summary, seated) } catch (e) { out.errors.push('badges: ' + e.message) }
  try { for (const p of db.prepare('SELECT * FROM game_players WHERE game_id=?').all(game.id)) xp.creditGame(game, p) } catch (e) { out.errors.push('xp: ' + e.message) }
  try { out.records = records.submitFromGame(game, summary).map((r) => ({ board: r.board.id, category: r.board.category, record: r.record.id })) } catch (e) { out.errors.push('records: ' + e.message) }
  try { mapRecords.onRunFinish(game.map_key) } catch (e) { out.errors.push('map records: ' + e.message) }
  try {
    if (map) db.prepare('UPDATE maps SET plays = COALESCE(plays,0) + 1 WHERE id=?').run(map.id)
    recountBeaten(game.map_key)
  } catch (e) { out.errors.push('counts: ' + e.message) }
  try { closeAssignment(assignment, game) } catch (e) { out.errors.push('assignment: ' + e.message) }

  if (out.errors.length) {
    db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('result.partial', ?, ?, ?)")
      .run(game.box || null, JSON.stringify({ match_id: game.match_id, errors: out.errors }), now())
  }
  return out
}

function storeReplay(game, body) {
  const r = body.replay || {}
  // The box's replay-signing key, pinned on first sight. A file signed with a key that is
  // not the pin is NOT record evidence, whatever its own signature says (host.md §5).
  const keyId = r.key_id || body.key_id || null
  const pinned = keyId ? boxes.keyMatchesPin(game.box, keyId) : false
  db.prepare(`INSERT INTO replays (match_id, game_id, box, object_key, file, size, chunks, events, ratio,
      mb_per_hour, key_id, key_pinned, recovered, partial, tier, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(match_id) DO UPDATE SET size=excluded.size, chunks=excluded.chunks, events=excluded.events,
      ratio=excluded.ratio, mb_per_hour=excluded.mb_per_hour, key_id=excluded.key_id, key_pinned=excluded.key_pinned`)
    .run(game.match_id, game.id, game.box || null, r.object_key || null, r.file || null,
      r.size || null, r.chunks || null, r.events || null, r.ratio || null, r.mb_per_hour || null,
      keyId, pinned ? 1 : 0, r.recovered ? 1 : 0, r.partial ? 1 : 0, r.tier || 'full', now())
}

// The map shelf, the ticks, and the one badge per map.
//
// 05: the badge is earned by the map's MAIN finish (Easter Egg > Buyable Ending > Round N).
// Other finishes on the same map do not mint a second badge — they are ticks on this one,
// and solo is a mark, not another badge.
function applyProgressAndBadges(game, summary, seated) {
  const map = db.prepare('SELECT * FROM maps WHERE key=?').get(game.map_key)
  if (!map) return []
  const mapBadge = db.prepare(`SELECT * FROM badges WHERE kind='map' AND map_key=?`).get(game.map_key)
  const finish = game.finish_kind
  const solo = !!game.solo
  const awarded = []

  for (const p of seated) {
    const sid = p.steam_id
    // A late joiner earns no achievements and no records from that game (99 §4.4), but it
    // still counts as having played the map — the shelf is a history, not a reward.
    const eligible = !p.late && game.mode === 'verified'

    db.prepare(`INSERT INTO map_progress (steam_id, map_key, played, games, time_ms, first_played, last_played)
                VALUES (?,?,1,1,?,?,?)
                ON CONFLICT(steam_id, map_key) DO UPDATE SET
                  played=1, games=map_progress.games+1, time_ms=map_progress.time_ms+excluded.time_ms,
                  last_played=excluded.last_played`)
      .run(sid, game.map_key, game.duration_ms || 0, now(), now())

    // BEST ROUND IS A VERIFIED-ONLY NUMBER, and this is the whole reason it is guarded
    // here rather than written with the rest of the history above.
    //
    // A Local game runs on the player's own PC with the console open, so "round 255" costs
    // one command. A Custom game can be *started* at round 100 by its own knobs (13 §4c).
    // Neither is a lie the player told — both are the mode working as designed — but
    // either one landing in `best_round` would put a number on the map shelf and on the
    // profile's career strip that reads as an achievement and is not one.
    //
    // The row above still records that the game was PLAYED, because the shelf is a history.
    // This is the one field on it that is a claim.
    if (eligibleForStats(game)) {
      db.prepare(`UPDATE map_progress SET best_round = MAX(best_round, ?) WHERE steam_id=? AND map_key=?`)
        .run(game.rounds || 0, sid, game.map_key)
    }

    if (!eligible || !finish) continue

    // Tick whichever finish this was.
    if (finish === 'easter_egg') db.prepare('UPDATE map_progress SET ee=1, beaten=1 WHERE steam_id=? AND map_key=?').run(sid, game.map_key)
    else if (finish === 'buyable_ending') db.prepare('UPDATE map_progress SET buyable=1, beaten=1 WHERE steam_id=? AND map_key=?').run(sid, game.map_key)
    else if (finish === 'round') db.prepare('UPDATE map_progress SET beaten=1 WHERE steam_id=? AND map_key=?').run(sid, game.map_key)
    if (solo) db.prepare('UPDATE map_progress SET solo=1 WHERE steam_id=? AND map_key=?').run(sid, game.map_key)

    if (!mapBadge) continue
    const tick = finish === 'round' ? `Round ${game.rounds}` : FINISH_LABEL[finish] || finish
    // The badge itself is only minted by the MAIN finish. A Round 20 on a map whose main
    // finish is the Easter Egg ticks the shelf and the hover card but does not mint the
    // badge — that is 05's "one badge per map, earned by its main finish" read literally.
    if (finish === map.main_finish) {
      if (badges.award(mapBadge.id, sid, 'result', { solo, ticks: [tick], gameId: game.id })) {
        awarded.push({ steam_id: sid, badge: mapBadge.slug, name: mapBadge.name })
        feed.push({ kind: 'badge', steam_id: sid, map_key: game.map_key, badge_id: mapBadge.id, game_id: game.id, text: `beat ${map.title}` })
      } else {
        badges.addTicks(mapBadge.id, sid, [tick], { solo })
      }
    } else {
      badges.addTicks(mapBadge.id, sid, [tick], { solo })
    }
  }

  if (finish) {
    const map2 = db.prepare('SELECT title FROM maps WHERE key=?').get(game.map_key)
    feed.push({
      kind: 'finish', map_key: game.map_key, game_id: game.id,
      text: `${game.finish_label || finish} on ${map2 ? map2.title : game.map_key}`,
      data: { rounds: game.rounds, players: seated.length, solo },
    })
  }
  return awarded
}

function recountBeaten(mapKey) {
  const n = db.prepare('SELECT COUNT(*) c FROM map_progress WHERE map_key=? AND beaten=1').get(String(mapKey)).c
  db.prepare('UPDATE maps SET beaten_by=? WHERE key=?').run(n, String(mapKey))
}

function closeAssignment(assignment, game) {
  if (!assignment) return
  db.prepare("UPDATE assignments SET state='done', ended_at=? WHERE id=?").run(now(), assignment.id)
  if (assignment.party_id) {
    db.prepare("UPDATE parties SET state='forming', match_id=NULL, ready_since=NULL, updated_at=? WHERE id=?")
      .run(now(), assignment.party_id)
  }
  void game
}

// ---- reads ---------------------------------------------------------------------------
function project(game, { withPlayers = true } = {}) {
  if (!game) return null
  const out = {
    id: game.id,
    match_id: game.match_id,
    mode: game.mode,
    map_key: game.map_key,
    map_title: (db.prepare('SELECT title FROM maps WHERE key=?').get(game.map_key) || {}).title || game.map_key,
    rounds: game.rounds,
    finish: game.finish_kind ? { kind: game.finish_kind, label: game.finish_label } : null,
    player_count: game.player_count,
    solo: !!game.solo,
    duration_ms: game.duration_ms,
    duration_rta_ms: game.duration_rta_ms,
    paused_ms: game.paused_ms,
    flags: safeJson(game.flags, []) || [],
    records_eligible: !!game.records_eligible,
    self_reported: !!game.self_reported,
    fingerprint: game.fingerprint,
    started_at: game.started_at,
    ended_at: game.ended_at,
    box: game.box,
  }
  if (withPlayers) {
    out.players = db.prepare('SELECT * FROM game_players WHERE game_id=? ORDER BY slot').all(game.id).map((p) => ({
      ...users.publicById(p.steam_id),
      slot: p.slot, score: p.score, kills: p.kills, headshots: p.headshots, downs: p.downs,
      revives: p.revives, bleedouts: p.bleedouts, points_earned: p.points_earned,
      points_spent: p.points_spent, rounds_played: p.rounds_played, joined_round: p.joined_round,
      late: !!p.late, afk_kicked: !!p.afk_kicked, xp: p.xp_awarded,
    }))
  }
  const r = db.prepare('SELECT * FROM replays WHERE game_id=?').get(game.id)
  if (r) out.replay = { size: r.size, chunks: r.chunks, events: r.events, key_id: r.key_id, key_pinned: !!r.key_pinned, recovered: !!r.recovered, partial: !!r.partial }
  return out
}

const byId = (id) => project(db.prepare('SELECT * FROM games WHERE id=?').get(Number(id)))
const byMatch = (matchId) => project(db.prepare('SELECT * FROM games WHERE match_id=?').get(String(matchId)))

function recent({ limit = 20, mapKey = null, steamId = null } = {}) {
  let sql = 'SELECT g.* FROM games g'
  const args = []
  const where = []
  if (steamId) { sql += ' JOIN game_players gp ON gp.game_id=g.id'; where.push('gp.steam_id=?'); args.push(String(steamId)) }
  if (mapKey) { where.push('g.map_key=?'); args.push(String(mapKey)) }
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY g.ended_at DESC LIMIT ?'
  args.push(limit)
  return db.prepare(sql).all(...args).map((g) => project(g))
}

/** The career stats strip (05 "Profile additions"). */
function careerFor(steamId) {
  const sid = String(steamId)
  // Games and hours count every mode — they are a history. The HIGHEST ROUND does not:
  // see eligibleForStats above. Two queries rather than one because they are answering two
  // different questions, and merging them is how the wrong one gets the wrong filter.
  const g = db.prepare(`SELECT COUNT(*) games, COALESCE(SUM(g.duration_ms),0) ms
                          FROM game_players gp JOIN games g ON g.id=gp.game_id WHERE gp.steam_id=?`).get(sid)
  const best = db.prepare(`SELECT COALESCE(MAX(g.rounds),0) best
                             FROM game_players gp JOIN games g ON g.id=gp.game_id
                            WHERE gp.steam_id=? AND g.mode='verified' AND COALESCE(g.self_reported,0)=0
                              AND gp.late=0`).get(sid)
  const p = db.prepare(`SELECT COALESCE(SUM(kills),0) kills, COALESCE(SUM(downs),0) downs,
                               COALESCE(SUM(revives),0) revives, COALESCE(SUM(headshots),0) headshots
                          FROM game_players WHERE steam_id=?`).get(sid)
  const beaten = db.prepare('SELECT COUNT(*) c FROM map_progress WHERE steam_id=? AND beaten=1').get(sid).c
  const ee = db.prepare('SELECT COUNT(*) c FROM map_progress WHERE steam_id=? AND ee=1').get(sid).c
  const total = require('./maps').count()
  return {
    games: g.games, time_ms: g.ms, best_round: best.best,
    kills: p.kills, downs: p.downs, revives: p.revives, headshots: p.headshots,
    maps_beaten: beaten, maps_total: total, easter_eggs: ee,
  }
}

module.exports = { ingest, project, byId, byMatch, recent, careerFor, recountBeaten }
