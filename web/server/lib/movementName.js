'use strict'

// The name this player already wears on ENW Movement — a PREFILL for the picker, and
// nothing more (2026-09-22).
//
// Movement answers `GET /api/players/<steamid64>/profile` with no session at all: it is on
// the movement host's MOVEMENT_PUBLIC list (CSGO-Matchmaker/server/index.js:464-480, "a
// profile is a link people paste") and the handler is CSGO-Matchmaker/server/routes/players.js:93.
// Its `user.username` is `publicUser()` (server/lib/users.js:38-56), which is:
//
//   * the shared ENW name when the account has one (dropsNames.mirrorLocally writes it
//     there with name_source='drops'), OR
//   * the Steam persona when it does not (name_source='steam').
//
// **`name_source` is not on the public projection**, so from outside there is no telling
// those two apart. That is why this is a suggestion the player confirms and not an
// adoption: an ENW name and a Steam persona that happens to fit the rules look identical
// here. Verifying rather than suggesting needs drops.ws's `GET /internal/name`, behind the
// shared secret we do not hold — questions.md Q-id-1.
//
// READ-ONLY, NO CREDENTIALS, and cheap: one GET per nameless account per hour at most, and
// only while that account is looking at the picker. `ZM_MOVEMENT_URL=off` switches it off
// (the test suites do, so `npm test` never leaves the machine).

const TIMEOUT_MS = 4000
const TTL_MS = 60 * 60_000
const cache = new Map() // steam_id -> { val, exp }

function base () {
  const v = process.env.ZM_MOVEMENT_URL
  if (v === 'off' || v === '0' || v === '') return null
  return String(v || 'https://movement.enw.gg').replace(/\/+$/, '')
}

/** @returns {Promise<string|null>} the Movement-side name, or null for none / no answer */
async function lookup (steamId) {
  const sid = String(steamId || '')
  if (!/^\d{17}$/.test(sid)) return null
  const b = base()
  if (!b) return null
  const hit = cache.get(sid)
  if (hit && hit.exp > Date.now()) return hit.val
  let val = null
  try {
    const r = await fetch(`${b}/api/players/${sid}/profile`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    // A missing route on that site falls through to its SPA shell as 200 text/html
    // (dropsNames.js:91-95 has the same guard for the same reason).
    const ctype = String(r.headers.get('content-type') || '')
    if (r.ok && ctype.includes('application/json')) {
      const d = await r.json()
      const u = d && d.user
      if (u && String(u.steam_id) === sid && typeof u.username === 'string') val = u.username.trim().slice(0, 64) || null
    }
  } catch { /* unreachable, slow or refused: no suggestion, which is fine */ }
  cache.set(sid, { val, exp: Date.now() + TTL_MS })
  return val
}

module.exports = { lookup, enabled: () => !!base() }
