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

// ── Numbers from a summary ────────────────────────────────────────────────────────────
//
// `Number(x || 0)` looks safe and is not: `Number('abc')` is NaN, and better-sqlite3 binds
// NaN to an INTEGER column as NULL without complaining. A launcher that sends
// `rounds: "abc"` — a half-parsed console line, a missing field read as a string — got a
// stored game with **no round on it at all**, which is the one number B's MVP is about.
// Proven before the fix: `POST /local/result {rounds:"abc"}` → 200, and `rounds: null` in
// the row.
//
// So every number that reaches a column goes through here. A numeric string still parses
// (a box is allowed to be sloppy about JSON types); anything that is not a number becomes
// the fallback, and nothing NaN or Infinite is ever bound.
function num(v, fallback = 0, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
const int = (v, fallback = 0, bounds) => Math.round(num(v, fallback, bounds))

// The same for text. An object or an array where a name was expected is a bind error from
// better-sqlite3 — which reaches the box as a 500 it retries forever (rule 3). Anything
// that is not a string or a number becomes null; everything else is capped, because a
// summary field is a label and not a payload.
function str(v, max = 200) {
  if (v == null) return null
  if (typeof v === 'object') return null
  const s = String(v)
  return s ? s.slice(0, max) : null
}

// `Date.parse` of anything unparseable is NaN, which SQLite stores as NULL — so a bad
// timestamp silently becomes "no timestamp" rather than being noticed. Numbers are already
// epoch millis (the host agent sends ISO, a launcher may not).
function parseWhen(v) {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Date.parse(String(v))
  return Number.isFinite(n) ? n : null
}

// A round counter is a non-negative integer. The cap is a bound on OUR storage, not a claim
// about the game: a local game has the console open and can say anything.
const MAX_ROUND = 100_000
const MAX_MS = 400 * 86400_000

// May this game's numbers appear as a player's ACHIEVEMENT — a best round, a career high —
// rather than merely in their history? Only a Verified game we refereed on our own box.
// Local is the player's PC with cheats; Custom can start at round 100 by design; a
// self-reported result did not come from a box at all.
const eligibleForStats = (game) => game.mode === 'verified' && !game.self_reported

// ---- IDENTITY (referee lane, commit bd3bd59; `docs/protocol/game-link-v0.md`) -----------
//
// A result's `players[]` now carry `identity`, and it is what the row's `steamid` is WORTH:
//
//   none      no token was presented. A Local or dev run. There is no `steamid` at all.
//   claimed   a token was presented and parsed, and its signature was NOT checked.
//   verified  the host answered `auth allow:true` with a real check.
//   refused   the host, or the game, said no. No `steamid` is sent.
//
// **Only `verified` may be awarded anything.** The other three are ATTENDANCE: they stay in
// `summary_json`, which is the whole result exactly as the box sent it, and they get no
// `game_players` row — so no XP, no records, no badges, no map progress, and the game shows
// as untracked for them.
//
// `claimed` is the one that matters and the one that looks safe. It means a token arrived
// and parsed — which is to say somebody sent us a well-formed blob naming an account. Until
// the signature has been checked that is a CLAIM about who was playing, and crediting a
// round-40 record to it would be crediting it to whoever typed the loudest.
//
// An ABSENT `identity` is treated as `none`, not as verified. Every box that can post to
// `/api/gs/result` speaks the current protocol; a body without the field is either older
// than 2026-09-22 or is not a referee, and "we could not tell" has to fail closed on the one
// path that hands out records.
const VERIFIED = 'verified'

/**
 * @param {object} body  the box's POST body: { box, instance, summary, replay }
 * @param {object} [opts]
 * @param {boolean} [opts.selfReported]
 * @param {boolean} [opts.requireVerifiedIdentity]  seat only `identity:"verified"` rows.
 *        ON for `/api/gs/result` and `/api/gs/spool` — the paths a game box posts through,
 *        and the only ones that can produce a record. OFF for a Local run, which never had
 *        a token to check, already scores zero of everything (`mode: 'local'` forces
 *        `records_eligible: 0` and `xp_multiplier: 0` above), and whose one consequence is
 *        the player's own map_progress "played" tick on their own machine.
 * @returns {object} { ok, game_id, match_id, awarded, records, repeat, unverified }
 */
function ingest(body, { selfReported = false, requireVerifiedIdentity = false } = {}) {
  const summary = body && body.summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return { ok: false, error: 'no summary' }
  if (!summary.match_id || typeof summary.match_id === 'object') return { ok: false, error: 'no summary' }

  // `players` is iterated twice below and a box that sends the wrong type must get a
  // refusal, not a 500 that it retries forever. Proven before the fix:
  // `POST /local/result {players:"me"}` → HTTP 500 and the run lost.
  if (summary.players != null && !Array.isArray(summary.players)) {
    return { ok: false, error: 'players must be a list' }
  }
  if (summary.flags != null && !Array.isArray(summary.flags)) return { ok: false, error: 'flags must be a list' }
  if (summary.finish != null && (typeof summary.finish !== 'object' || Array.isArray(summary.finish))) {
    return { ok: false, error: 'finish must be an object or null' }
  }

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
  // A player's Restart game (docs/kickstart/esc-menu.md §3) ends one run and starts the next
  // on the same lease: the next run has its own id `<lease>.r<n>` and names the lease in
  // `lease_match_id`. Only a run id that really is a run of that lease is attached to it.
  const leaseId = typeof summary.lease_match_id === 'string' && String(summary.match_id).startsWith(summary.lease_match_id + '.r')
    ? summary.lease_match_id : null
  let assignment = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(String(leaseId || summary.match_id))
  // ...and only by the box that holds that lease.
  if (leaseId && assignment && body.box && boxes.nameOf(assignment.box_id) !== String(body.box)) assignment = null

  // The map's own game mode (game-modes.md) is the LEASE's, not the box's word: the site
  // chose it. The box's part is the proof that it took (`game_mode_applied`, from the DLL's
  // answer and the map's own "vote over" notify). A lease with a mode whose result does not
  // prove it -- an old host agent, an old DLL, a menu somebody answered by hand, a different
  // mode -- is kept, marked, and never a record, because nobody can say which board it is on.
  const gameMode = assignment && assignment.game_mode ? String(assignment.game_mode) : null
  const modeFlags = []
  if (gameMode && (summary.game_mode_applied !== true || (summary.game_mode != null && String(summary.game_mode) !== gameMode))) {
    modeFlags.push('game_mode_unconfirmed')
  }

  const row = {
    match_id: String(summary.match_id),
    box: str(body.box, 64) || (assignment ? boxes.nameOf(assignment.box_id) : null),
    instance: str(body.instance, 64) || str(summary.instance, 64),
    mode: str(summary.mode, 32) || 'verified',
    map_key: str(summary.map, 64) || '',
    map_id: map ? map.id : null,
    map_version_id: version ? version.id : null,
    fs_game: str(summary.fs_game, 200),
    party_id: assignment ? assignment.party_id : null,
    settings_json: assignment ? assignment.settings_json : null,
    fingerprint: str(summary.fingerprint, 64),
    rounds: int(summary.rounds, 0, { min: 0, max: MAX_ROUND }),
    finish_kind: summary.finish ? str(summary.finish.kind, 32) : null,
    finish_label: summary.finish ? (str(summary.finish.label, 64) || FINISH_LABEL[summary.finish.kind] || null) : null,
    badge_earned: summary.badge && typeof summary.badge === 'object' ? str(summary.badge.kind, 32) : null,
    player_count: int(summary.player_count, (summary.players || []).length, { min: 0, max: 64 }),
    solo: summary.solo ? 1 : 0,
    duration_ms: int(summary.duration_ms, 0, { min: 0, max: MAX_MS }),
    duration_rta_ms: int(summary.duration_rta_ms, 0, { min: 0, max: MAX_MS }),
    paused_ms: int(summary.paused_ms, 0, { min: 0, max: MAX_MS }),
    flags: JSON.stringify([...new Set([...(summary.flags || []), ...modeFlags])]),
    records_eligible: summary.records_eligible && !modeFlags.length ? 1 : 0,
    game_mode: gameMode,
    xp_multiplier: num(summary.xp_multiplier, 1, { min: 0, max: 10 }),
    end_reason: str(summary.end_reason, 40),
    started_at: parseWhen(summary.started_at),
    ended_at: parseWhen(summary.ended_at) ?? now(),
    received_at: now(),
    self_reported: untrusted ? 1 : 0,
    summary_json: JSON.stringify(summary),
  }

  if (existing) {
    // A retry. Refresh the row (the box may have learned more, e.g. the replay closed) and
    // stop: the consequences below already ran.
    db.prepare(`UPDATE games SET summary_json=?, received_at=?, ended_at=COALESCE(ended_at,?) WHERE id=?`)
      .run(row.summary_json, now(), row.ended_at, existing.id)

    // ── The one case where a repeat is allowed to change the numbers ────────────────
    //
    // A local run that went silent is written from its live frames alone and flagged
    // `frames_only` (lib/localMatches.js) — the map, the round, the time, and nothing
    // else. It is a placeholder for a run nobody closed out, and when the real result does
    // turn up (the launcher came back, the referee finished writing, the player's PC
    // reconnected) the placeholder must give way to it.
    //
    // This is not a hole in rule 2. It is narrow by construction: only a row we ourselves
    // synthesised, only when the arriving result is not itself frames-only, and it re-runs
    // no consequence, because a frames-only row earns nothing to un-earn.
    const wasFramesOnly = (safeJson(existing.flags, []) || []).includes('frames_only')
    const nowFramesOnly = (summary.flags || []).includes('frames_only')
    if (wasFramesOnly && !nowFramesOnly) {
      db.prepare(`UPDATE games SET rounds=@rounds, finish_kind=@finish_kind, finish_label=@finish_label,
                    duration_ms=@duration_ms, duration_rta_ms=@duration_rta_ms, paused_ms=@paused_ms,
                    flags=@flags, end_reason=@end_reason, started_at=COALESCE(@started_at, started_at),
                    ended_at=@ended_at WHERE id=@id`)
        .run({ ...row, id: existing.id })
      db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('local.superseded', ?, ?, ?)")
        .run(existing.box || null, JSON.stringify({ match_id: row.match_id, was_rounds: existing.rounds, rounds: row.rounds }), now())
    }

    if (body.replay) storeReplay(existing, body)
    return { ok: true, game_id: existing.id, match_id: row.match_id, repeat: true, superseded: wasFramesOnly && !nowFramesOnly }
  }

  const info = db.prepare(`INSERT INTO games (match_id, box, instance, mode, map_key, map_id, map_version_id, fs_game,
      party_id, settings_json, fingerprint, rounds, finish_kind, finish_label, badge_earned, player_count, solo,
      duration_ms, duration_rta_ms, paused_ms, flags, records_eligible, xp_multiplier, end_reason,
      started_at, ended_at, received_at, self_reported, summary_json, game_mode)
    VALUES (@match_id,@box,@instance,@mode,@map_key,@map_id,@map_version_id,@fs_game,@party_id,@settings_json,
      @fingerprint,@rounds,@finish_kind,@finish_label,@badge_earned,@player_count,@solo,@duration_ms,
      @duration_rta_ms,@paused_ms,@flags,@records_eligible,@xp_multiplier,@end_reason,@started_at,@ended_at,
      @received_at,@self_reported,@summary_json,@game_mode)`).run(row)
  const game = db.prepare('SELECT * FROM games WHERE id=?').get(info.lastInsertRowid)

  const insP = db.prepare(`INSERT OR REPLACE INTO game_players (game_id, steam_id, slot, name, score, kills, headshots,
      downs, revives, bleedouts, points_earned, points_spent, time_alive_ms, rounds_played, joined_round, late, afk_kicked)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const seated = []
  const unverified = []
  for (const p of summary.players || []) {
    // A player with no SteamID is a slot the box could not identify — a bot, a local test,
    // or a connect the DLL saw before the token check. It is recorded in summary_json and
    // NOT given a row here, because a row keyed on a made-up id would attach somebody's
    // badge to nobody. The same goes for an entry that is not an object at all.
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue
    const sid = str(p.steamid, 32)
    if (!sid) continue
    // The identity gate. See VERIFIED above: `claimed` / `refused` / absent are attendance,
    // and attendance gets no row, which is what makes it award nothing anywhere downstream
    // — XP, badges and map progress all iterate `game_players` or `seated`.
    if (requireVerifiedIdentity && p.identity !== VERIFIED) {
      unverified.push({ slot: p.slot == null ? null : p.slot, name: str(p.name, 64), identity: str(p.identity, 16) || 'none' })
      continue
    }
    const s = (p.stats && typeof p.stats === 'object' && !Array.isArray(p.stats)) ? p.stats : {}
    const stat = (...vs) => { for (const v of vs) if (v != null) return int(v, 0, { min: 0, max: 1e12 }); return 0 }
    // The combat counters are monotonic, and a host before 2026-09-23 put its raw fold in
    // `stats` and the value reconciled with the game's own result at the top level — so
    // "stats first" threw the reconciled one away (bug 7). The larger of the two is right
    // for a counter from either kind of host.
    const most = (...vs) => Math.max(0, ...vs.filter((v) => v != null).map((v) => int(v, 0, { min: 0, max: 1e12 })))
    insP.run(game.id, sid, p.slot == null ? null : int(p.slot, 0, { min: 0, max: 63 }), str(p.name, 64),
      stat(p.score), most(s.kills, p.kills), most(s.headshots, p.headshots), most(s.downs, p.downs),
      most(s.revives, p.revives), stat(s.deaths, p.bleedouts),
      stat(s.points_earned), stat(s.points_spent), stat(s.time_alive_ms),
      stat(s.rounds_played, p.rounds_played), int(p.joined_round, 1, { min: 0, max: MAX_ROUND }),
      p.late ? 1 : 0, p.afk_kicked ? 1 : 0)
    // ~~`users.ensure(sid, { username: str(p.name, 64) })`~~ — **REMOVED 2026-09-23, and
    // this line is the whole of "why does the site call me Unknown Soldier".**
    //
    // It took the name the GAME reported and wrote it into the account. Nothing ever
    // passed `+name`, so the engine's stock default for the `name` dvar — "Unknown
    // Soldier" — arrived on the roster, came back in the result, and became the owner's
    // site username. The live DB carried exactly that row.
    //
    // The direction is now one-way and it is the other way: the site decides the name,
    // the token carries it (`lib/tokens.js` `n`), and the referee pins the server's copy
    // of the client's userinfo to it. A result is still credited by `steamid` and never by
    // name (the insert above, and `game_players` is keyed on the id) — so nothing here
    // needs a name to attribute anything, which is why dropping it costs nothing.
    //
    // The row is still ENSURED, because a verified player who has never opened the site
    // must still have an account for XP and badges to attach to. Just without a name.
    users.ensure(sid)
    seated.push({ ...p, steam_id: sid })
  }

  if (body.replay) storeReplay(game, body)

  const out = { ok: true, game_id: game.id, match_id: game.match_id, awarded: [], records: [], errors: [], unverified }
  // Said out loud in the audit log rather than only in a return value the box discards. A
  // player who finished a round-40 game and got nothing for it will ask why, and this is the
  // row that answers — with the identity the referee actually reported.
  if (unverified.length) {
    try {
      db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('result.unverified', ?, ?, ?)")
        .run(String(body.box || 'unknown'), JSON.stringify({ match_id: game.match_id, players: unverified }), now())
    } catch (e) { out.errors.push('audit: ' + e.message) }
  }

  // Everything below is consequence, and none of it may fail the box's POST.
  try { out.awarded = applyProgressAndBadges(game, summary, seated) } catch (e) { out.errors.push('badges: ' + e.message) }
  try { for (const p of db.prepare('SELECT * FROM game_players WHERE game_id=?').all(game.id)) xp.creditGame(game, p) } catch (e) { out.errors.push('xp: ' + e.message) }
  try { out.records = records.submitFromGame(game, summary).map((r) => ({ board: r.board.id, category: r.board.category, record: r.record.id })) } catch (e) { out.errors.push('records: ' + e.message) }
  try { mapRecords.onRunFinish(game.map_key) } catch (e) { out.errors.push('map records: ' + e.message) }
  try {
    if (map) db.prepare('UPDATE maps SET plays = COALESCE(plays,0) + 1 WHERE id=?').run(map.id)
    recountBeaten(game.map_key)
  } catch (e) { out.errors.push('counts: ' + e.message) }
  // An abandoned run that a player restarted is not the end of the lease: the game goes on
  // on the same box under the next run id, and closing the lease here would free the box
  // (and send the party back to forming) under a game that is still being played.
  // The same for a run that ENDED on its own (a solo down) and was restarted inside the
  // host's restart grace (esc-menu.md §12): the result is a real game over, and the box says
  // `lease_continues` beside it because the next run of the lease is already on the map.
  // Only from the box that holds the lease.
  const continues = body.lease_continues === true && !!assignment && !!body.box && boxes.nameOf(assignment.box_id) === String(body.box)
  if (summary.end_reason !== 'player_restart' && !continues) {
    try { closeAssignment(assignment, game) } catch (e) { out.errors.push('assignment: ' + e.message) }
  }
  if (continues) out.lease_continues = true

  // The in-game line B asked for (2026-09-23): "Your record has been uploaded", said to each
  // verified player of a box game the moment the site has stored it — this call is the
  // host's POST, so the line and the host's confirmation are the same event. Only the box
  // path (`requireVerifiedIdentity`), only seated (verified) players, only on first
  // arrival (a retry returned above). It travels on the overlay's own long-poll
  // (gameChat.notify, a private `notice` line); a game that has already closed simply
  // never shows it. esc-menu.md §10.3.
  if (requireVerifiedIdentity && !untrusted) {
    try { out.notified = noticeSeated(game, seated) } catch (e) { out.errors.push('notice: ' + e.message) }
  }

  if (out.errors.length) {
    db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('result.partial', ?, ?, ?)")
      .run(game.box || null, JSON.stringify({ match_id: game.match_id, errors: out.errors }), now())
  }
  return out
}

// The line each seated player gets. A record-eligible Verified game: the record is up. Anything
// else (Custom mode, a late join, a refused Verified run): the game is saved, and says it is
// not a record, rather than letting the player believe it is.
const RECORD_UPLOADED = 'Your record has been uploaded.'
const GAME_SAVED = 'Your game has been saved. Not record-eligible.'
function noticeLine(game, p) {
  return game.records_eligible && game.mode === 'verified' && !p.late ? RECORD_UPLOADED : GAME_SAVED
}
function noticeSeated(game, seated) {
  const gameChat = require('./gameChat')   // lazy: gameChat pulls in the chat ring and parties
  let n = 0
  for (const p of seated) if (gameChat.notify(p.steam_id, noticeLine(game, p))) n++
  return n
}

function storeReplay(game, body) {
  const r = (body.replay && typeof body.replay === 'object' && !Array.isArray(body.replay)) ? body.replay : {}
  // The box's replay-signing key, pinned on first sight. A file signed with a key that is
  // not the pin is NOT record evidence, whatever its own signature says (host.md §5).
  const keyId = str(r.key_id, 64) || str(body.key_id, 64) || null
  const pinned = keyId ? boxes.keyMatchesPin(game.box, keyId) : false
  db.prepare(`INSERT INTO replays (match_id, game_id, box, object_key, file, size, chunks, events, ratio,
      mb_per_hour, key_id, key_pinned, recovered, partial, tier, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(match_id) DO UPDATE SET size=excluded.size, chunks=excluded.chunks, events=excluded.events,
      ratio=excluded.ratio, mb_per_hour=excluded.mb_per_hour, key_id=excluded.key_id, key_pinned=excluded.key_pinned`)
    .run(game.match_id, game.id, game.box || null, str(r.object_key, 400), str(r.file, 400),
      r.size == null ? null : int(r.size, 0, { min: 0 }), r.chunks == null ? null : int(r.chunks, 0, { min: 0 }),
      r.events == null ? null : int(r.events, 0, { min: 0 }), r.ratio == null ? null : num(r.ratio, 0, { min: 0 }),
      r.mb_per_hour == null ? null : num(r.mb_per_hour, 0, { min: 0 }),
      keyId, pinned ? 1 : 0, r.recovered ? 1 : 0, r.partial ? 1 : 0, str(r.tier, 16) || 'full', now())
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

  // The home feed is a log of records and badges — things the site vouched for — and a
  // self-reported finish is neither: it earns no badge above and can hold no record.
  // That argues for keeping it out, and it did for a while.
  //
  // It goes in anyway, because right now a self-reported finish is the ONLY kind of finish
  // there is. Nobody has a refereed run; the dedicated server does not take clients yet. So
  // gating these out leaves four people playing a game all evening and a home page that
  // never changes once — which reads as broken, not as rigorous.
  //
  // The distinction is kept in the data rather than by the row's absence: `self_reported`
  // rides on the feed row, so the client marks it and any later query drops it in one
  // clause. When refereed runs exist, nothing here needs revisiting.
  if (finish) {
    const map2 = db.prepare('SELECT title FROM maps WHERE key=?').get(game.map_key)
    feed.push({
      kind: 'finish', map_key: game.map_key, game_id: game.id,
      text: `${game.finish_label || finish} on ${map2 ? map2.title : game.map_key}`,
      data: {
        rounds: game.rounds, players: seated.length, solo, mode: game.mode,
        self_reported: !!game.self_reported,
      },
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
  // Only a party still on THIS match goes back to forming. A superseded game's result (a map
  // switch, a second Play: the box retires the old game and posts it) arrives after the party
  // has moved on to its new match, and resetting it then took the party out of the game it is
  // in (cloud-brief-parties.md task 4).
  if (assignment.party_id) {
    db.prepare("UPDATE parties SET state='forming', match_id=NULL, ready_since=NULL, updated_at=? WHERE id=? AND (match_id=? OR match_id IS NULL)")
      .run(now(), assignment.party_id, assignment.match_id)
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
    // The map's own game mode (UGX's Gun Game ...), null for a map without modes.
    game_mode: game.game_mode || null,
    game_mode_label: game.game_mode ? require('./gameModes').label(game.map_key, game.game_mode) : null,
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
    // Three flags the UI lane needs and cannot derive. They are DATA, not copy: what a
    // page says about a self-reported game is theirs to decide, but it cannot decide
    // anything if the API will not say which rows are which.
    //
    //   demo        seeded scaffolding, never a real run (db/seed.js --demo)
    //   abandoned   nobody posted a result; the round came from the live frames
    //   end_reason  why it stopped, in the referee's own word
    demo: !!game.demo,
    abandoned: game.end_reason === 'abandoned',
    end_reason: game.end_reason || null,
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
  // Per map and game mode, because a round in Gun Game or Sharpshooter (game-modes.md) is not
  // a round in the map's own default mode: only games in a map's DEFAULT mode (or on a map
  // without modes) count toward the headline best round.
  const gameModes = require('./gameModes')
  const bestRows = db.prepare(`SELECT g.map_key, g.game_mode, COALESCE(MAX(g.rounds),0) best
                             FROM game_players gp JOIN games g ON g.id=gp.game_id
                            WHERE gp.steam_id=? AND g.mode='verified' AND COALESCE(g.self_reported,0)=0
                              AND gp.late=0
                            GROUP BY g.map_key, g.game_mode`).all(sid)
  const best = { best: 0 }
  for (const r of bestRows) {
    if (r.game_mode && r.game_mode !== gameModes.resolve(r.map_key, null)) continue
    best.best = Math.max(best.best, r.best)
  }
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

module.exports = { ingest, project, byId, byMatch, recent, careerFor, recountBeaten, RECORD_UPLOADED, GAME_SAVED }
