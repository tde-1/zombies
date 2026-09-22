'use strict'

// THE ENW NAME — the one display name a Zombies account has, everywhere.
//
// B's ask (2026-09-23): "Make people's usernames their ENW username. When they sign in,
// their username in World at War is locked to the ENW name and they can't spoof another
// name at all. Right now it says Unknown Soldier."
//
// ── Where "Unknown Soldier" came from, because it is not a string in this repo ────────
//
// It is the ENGINE's stock default for the `name` dvar. Nothing ever passed `+name`, so
// every client booted as "Unknown Soldier"; the referee read that off the roster, the box
// posted it in the result, and `lib/results.js` wrote it straight back into
// `users.username`. The live DB proves it — the owner's row held
// `username = 'Unknown Soldier'` and every other approved row held NULL. So the site was
// showing a name the GAME invented about itself. That write-back is gone (results.js), and
// this file is what replaces it.
//
// ── Why the name does not come from Steam, and does not come from Movement's SSO ──────
//
// STEAM. Steam OpenID gives an id and nothing else. The persona name needs a Steam Web API
// key, and 99 §4.1 / `routes/auth.js` decided against one (registering a key on the ENW
// account would silently replace Movement's). So `users.username` is NULL for a real
// sign-in and always will be.
//
// MOVEMENT'S `/sso/redeem`. **It does not answer this question, and this is the finding.**
// `CSGO-Matchmaker/server/routes/internal.js` `POST /internal/sso/redeem` takes an opaque
// single-use TICKET and answers with the `steam_id` it was minted for — a login handoff,
// deliberately "NO player data, no reads". It is steamid-OUT, not name-out, and it is
// the wrong direction for us: we already know the steamid and want the name.
//
// THE REAL AUTHORITY is drops.ws, and Movement is itself only a mirror of it
// (`CSGO-Matchmaker/server/lib/dropsNames.js`, owner directive 2026-07-30: "drops.ws holds
// the NOCASE unique index, the reservation table, the rename history and the 14-day
// cooldown … two authorities would mean two identities per person"). Its contract is
//
//     GET /internal/name?steam_id=<id64>   ->  { name, changed_at, has_name }
//     header: x-internal-secret: <DROPS_INTERNAL_SECRET>
//
// `lib/enw.js` is the Zombies client for exactly that API and it is STUBBED: `ZM_ENW_BASE`
// is unset and **the shared secret is not configured on this side**. Per the standing rule,
// no secret is invented here. So:
//
//   * configured (`ZM_ENW_BASE` + `ZM_ENW_SECRET`) -> the ENW authority decides, this file
//     mirrors, and the picker never appears. Nothing else has to change.
//   * NOT configured (today) -> this file IS the authority, as a Zombies-side first-login
//     picker ported from Movement's `POST /username`. Set once, unique case-insensitively,
//     and only an admin can rename.
//
const { db, now } = require('../db/database')
const enw = require('./enw')

// ── THE RULES, 2026-09-22 (B: "everyone should have the exact same ENW username") ──────
//
// Retracted, in place: the earlier version of this block said the rules were Movement's
// "character for character" and then diverged three ways — its own error wording, no
// date-shape refusal, and a Zombies-only reserved list. Each of those is a name, or a
// sentence, that one ENW site would treat differently from another. They are now the
// authority's, verbatim, and where each line comes from is cited so the next copy can be
// checked rather than trusted:
//
//   shape + wording   drops.ws  csgo-server/src/utils/usernameRules.js:9-30
//                     Movement  CSGO-Matchmaker/server/lib/dropsNames.js:60-72 (validateLocally,
//                               the same strings; Movement trims first, and so does drops.ws's
//                               own route, csgo-server/src/routes/auth.js:127)
//   blocklist         drops.ws  csgo-server/src/utils/usernameBlocklist.js + src/data/*.csv,
//                               copied into ./usernames/ (see blocklist.js for why a copy)
//   uniqueness        drops.ws  NOCASE unique index on players.site_username
//                               (csgo-server/src/routes/auth.js:150-156 relies on it); ours is
//                               idx_users_enw_name, NOCASE, on enw_name ONLY
//   set once          Movement  CSGO-Matchmaker/server/routes/auth.js:198-229 (409 "You already
//                               have a username"); renames live on drops.ws behind a 14-day
//                               cooldown, VIP and a revert window (routes/auth.js:164,
//                               db/database.js:1095) — none of which exists here, so a rename on
//                               Zombies is an admin's (rename() below), exactly as on Movement
//
// Not mirrored, because it cannot be without the authority's data: drops.ws's
// `username_reservations` (a name held for somebody else's 14-day revert window) and its
// per-player name locks. A name reserved over there reads as free here. That is the gap the
// shared-identity question (questions.md Q-id-1) exists to close.
const RULES = { MIN: 3, MAX: 20, PATTERN: /^[a-zA-Z0-9_-]+$/ }
const ALL_DIGITS = /^\d+$/
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}/

const { checkBlocked } = require('./usernames/blocklist')

// Movement's `validateLocally`, verbatim (dropsNames.js:63-72). The strings are the ones a
// Movement player sees from `POST /username`; the picker's short per-rule lines are the
// client's, copied from movement-client/src/pages/UsernameSetup.jsx.
function validate (name) {
  const s = typeof name === 'string' ? name.trim() : ''
  if (!s) return 'Username is required'
  if (s.length < RULES.MIN) return `Username must be at least ${RULES.MIN} characters`
  if (s.length > RULES.MAX) return `Username must be ${RULES.MAX} characters or fewer`
  if (!RULES.PATTERN.test(s)) return 'Username can only contain letters, numbers, underscores and hyphens'
  if (DATE_SHAPE.test(s)) return 'Invalid username'
  if (ALL_DIGITS.test(s)) return 'Usernames cannot be only numbers'
  return null
}

// Case-insensitive, on `enw_name` only — drops.ws's unique index is on the site name and
// nothing else. (It used to be across `username` too, because `users.pub()` rendered the
// Steam persona as a fallback name; it does not any more, so a persona is not a name anybody
// sees and cannot collide with one.)
function taken (name, exceptSteamId = null) {
  const row = db.prepare(`SELECT steam_id FROM users
                           WHERE lower(enw_name) = lower(?) AND deleted = 0`).get(String(name).trim())
  if (!row) return false
  return exceptSteamId == null || String(row.steam_id) !== String(exceptSteamId)
}

const isSet = (row) => !!(row && row.enw_name)

/**
 * Does this account still have to pick? The one question the client asks.
 *
 * FALSE whenever the ENW authority is live, whatever the row says: with `ZM_ENW_BASE` set,
 * the name is not ours to choose and a picker would be the split identity Movement's
 * directive exists to prevent. `enw.refreshName()` fills the column in the background.
 */
function needsName (steamId) {
  if (enw.enabled()) return false
  const row = db.prepare('SELECT enw_name, deleted FROM users WHERE steam_id=?').get(String(steamId))
  if (!row || row.deleted) return false
  return !isSet(row)
}

// drops.ws's `availability()` order (csgo-server/src/utils/usernames.js:71-90): shape, then
// the static blocklist ("a slur shouldn't be reported as merely taken"), then the holder.
// `reason` is drops.ws's vocabulary — ok | invalid | blocked | taken — so the picker's words
// for each are Movement's words for each.
function check (name, steamId = null) {
  const invalid = validate(name)
  if (invalid) return { available: false, reason: 'invalid', error: invalid }
  if (checkBlocked(String(name).trim()).blocked) return { available: false, reason: 'blocked', error: 'That username is not available' }
  if (taken(name, steamId)) return { available: false, reason: 'taken', error: 'That username is already taken' }
  return { available: true, reason: 'ok' }
}

/**
 * The first-login claim. SET ONCE — a second call is a 409, exactly as Movement's route is.
 *
 * Renaming is deliberately not here. On Movement it lives on the authority behind real
 * rules (VIP, a 14-day cooldown, a revert window); here there is no such apparatus, so the
 * only rename is an admin's (`rename()` below), which is logged. A self-serve rename would
 * make the lock in the game decorative — you cannot stop somebody spoofing a name in
 * `+name` and then hand them a button that changes the enforced one.
 */
function claim (steamId, name) {
  const sid = String(steamId)
  const s = String(name || '').trim()
  const invalid = validate(s)
  if (invalid) return { ok: false, reason: 'invalid', error: invalid }

  const row = db.prepare('SELECT enw_name, deleted FROM users WHERE steam_id=?').get(sid)
  if (!row || row.deleted) return { ok: false, reason: 'no_account', error: 'no such account' }
  if (isSet(row)) return { ok: false, reason: 'already_set', error: 'You already have a username' }

  // Fails CLOSED while the authority is live, for Movement's reason: writing a name here
  // that drops.ws never agreed to is the split identity. Unconfigured, we ARE the
  // authority and the claim is ours to make.
  if (enw.enabled()) return { ok: false, reason: 'authority', error: 'Your ENW name comes from your ENW account' }

  // The same refusals, in the same order and the same words, as drops.ws's set-username
  // (csgo-server/src/routes/auth.js:134-140).
  const avail = check(s, sid)
  if (!avail.available) return { ok: false, reason: avail.reason, error: avail.error }

  // UNIQUE-by-read-then-write is a race on paper. better-sqlite3 is synchronous and this
  // process is single-threaded, so the check and the write cannot interleave; the index
  // below is the guarantee if that ever stops being true.
  db.prepare('UPDATE users SET enw_name=?, enw_checked=? WHERE steam_id=?').run(s, now(), sid)
  audit('USERNAME_SET', sid, { username: s, via: 'picker' })
  return { ok: true, name: s }
}

/** An admin rename. The only way a set name changes while the picker is the authority. */
function rename (steamId, name, bySteamId = null) {
  const sid = String(steamId)
  const s = String(name || '').trim()
  const invalid = validate(s)
  if (invalid) return { ok: false, reason: 'invalid', error: invalid }
  const row = db.prepare('SELECT enw_name, deleted FROM users WHERE steam_id=?').get(sid)
  if (!row || row.deleted) return { ok: false, reason: 'no_account', error: 'no such account' }
  // An admin rename passes the blocklist too: drops.ws's staff force-rename bypasses the
  // cooldown and the lock, not the list (csgo-server/src/routes/cases.js:2026).
  const avail = check(s, sid)
  if (!avail.available) return { ok: false, reason: avail.reason, error: avail.error }
  const was = row.enw_name || null
  db.prepare('UPDATE users SET enw_name=?, enw_checked=? WHERE steam_id=?').run(s, now(), sid)
  audit('USERNAME_RENAME', bySteamId, { steam_id: sid, from: was, to: s })
  return { ok: true, name: s, from: was }
}

/**
 * THE ONE READER. Everything that needs a display name for an account — the token's `n`,
 * the launcher's `+name`, the party panel, a scoreboard — comes through here, so there is
 * exactly one answer to "what is this person called".
 *
 * The SteamID is the last resort and is deliberately not pretty: a row with no name should
 * look unfinished, because it is. It must never fall back to something the GAME supplied,
 * which is the loop that produced "Unknown Soldier" — and, since 2026-09-22, never to the
 * Steam persona in `username` either (B: the name is the ENW name, everywhere).
 */
function displayName (steamId) {
  const row = db.prepare('SELECT enw_name, deleted FROM users WHERE steam_id=?').get(String(steamId))
  if (!row) return String(steamId)
  if (row.deleted) return 'Deleted player'
  return row.enw_name || String(steamId)
}

/** Is this name the account's own, i.e. may it be enforced in game? */
const hasEnforceableName = (steamId) => {
  const row = db.prepare('SELECT enw_name FROM users WHERE steam_id=?').get(String(steamId))
  return !!(row && row.enw_name)
}

function audit (event, actor, meta) {
  try {
    db.prepare('INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES (?,?,?,?)')
      .run(event, actor == null ? null : String(actor), JSON.stringify(meta || {}), now())
  } catch (e) { /* an audit row is never worth failing a sign-in for */ }
}

module.exports = { RULES, validate, taken, check, claim, rename, needsName, displayName, hasEnforceableName }
