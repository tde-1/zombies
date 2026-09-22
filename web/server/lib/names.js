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
// The rules below are Movement's `dropsNames.RULES` character for character, including the
// all-digits refusal, so a name picked here can never be one the authority would reject on
// the day B wires the secret up.

const { db, now } = require('../db/database')
const enw = require('./enw')

// Movement's `dropsNames.js` RULES, mirrored. 3-20 (not 3-16: a legal 17-character name on
// the authority must stay reachable), and the all-digits refusal is the one deliberate
// divergence Movement carries — a number is an ADDRESS on an ENW site, so a player called
// "5" would be claiming somebody else's link.
const RULES = { MIN: 3, MAX: 20, PATTERN: /^[a-zA-Z0-9_-]+$/ }
const ALL_DIGITS = /^\d+$/

// Reserved on our side, for reasons that are ours. "Unknown Soldier" fails PATTERN anyway
// (the space), but the bare word does not, and a player called `admin` or `console` in a
// chat line or a server console print is a spoof with no engine involved.
const RESERVED = new Set(['admin', 'administrator', 'console', 'server', 'enw', 'system',
  'moderator', 'unknown', 'unknownsoldier', 'deleted', 'anonymous'])

function validate (name) {
  const s = typeof name === 'string' ? name.trim() : ''
  if (!s) return 'A username is required'
  if (s.length < RULES.MIN) return `Your username must be at least ${RULES.MIN} characters`
  if (s.length > RULES.MAX) return `Your username must be ${RULES.MAX} characters or fewer`
  if (!RULES.PATTERN.test(s)) return 'Letters, numbers, underscores and hyphens only'
  if (ALL_DIGITS.test(s)) return 'A username cannot be only numbers'
  if (RESERVED.has(s.toLowerCase())) return 'That username is reserved'
  return null
}

// Case-insensitive across BOTH name columns. `username` still holds the Steam persona on
// any row that ever had one, and it is a name the site renders (`users.pub`), so letting
// somebody claim an `enw_name` that collides with it would put two identical names on the
// site — which is the impersonation this whole file exists to close.
function taken (name, exceptSteamId = null) {
  const row = db.prepare(`SELECT steam_id FROM users
                           WHERE (lower(enw_name) = lower(?) OR lower(username) = lower(?))
                             AND deleted = 0`).get(String(name), String(name))
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

function check (name, steamId = null) {
  const invalid = validate(name)
  if (invalid) return { available: false, reason: 'invalid', error: invalid }
  if (taken(name, steamId)) return { available: false, reason: 'taken', error: 'That username is taken' }
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

  if (taken(s, sid)) return { ok: false, reason: 'taken', error: 'That username is taken' }

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
  if (taken(s, sid)) return { ok: false, reason: 'taken', error: 'That username is taken' }
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
 * which is the loop that produced "Unknown Soldier".
 */
function displayName (steamId) {
  const row = db.prepare('SELECT enw_name, username, deleted FROM users WHERE steam_id=?').get(String(steamId))
  if (!row) return String(steamId)
  if (row.deleted) return 'Deleted player'
  return row.enw_name || row.username || String(steamId)
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
