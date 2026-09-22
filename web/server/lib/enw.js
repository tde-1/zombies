'use strict'

// THE ONLY TWO RUNTIME LINKS BETWEEN ZOMBIES AND ENW (vault 11 §9b, 99 §0.2).
//
//   1. The ENW NAME, over a narrow read-only SSO/name API.
//   2. VIP STATUS, over a narrow read-only API. One VIP covers Movement + Zombies.
//
// Everything else — servers, database, CDN, Cloudflare zone, Hetzner project — is separate,
// and **Zombies must never hold a credential that can reach the CS:GO boxes.** That rule is
// why this file is one file with two functions and a hard-coded refusal to do anything else.
//
// BOTH ARE STUBBED. `ZM_ENW_BASE` is unset by default and no request leaves this machine:
// the name resolver falls back to the Steam persona and VIP falls back to whatever is
// cached on the row (0 for a new account). B wires the real endpoints later; when they
// exist, set ZM_ENW_BASE and ZM_ENW_TOKEN and the two fetches below start working with no
// other change. The seam is deliberately this narrow so that reviewing it is one screen.
//
// Local development can force VIP on for an account without any of that: `ZM_VIP_FORCE` is
// a comma-separated SteamID list, and the admin panel has a VIP override. Both write the
// cache, both are logged, neither pretends to be ENW.

const { db, now } = require('../db/database')

// ── THE CONTRACT, corrected 2026-09-23 ────────────────────────────────────────────────
//
// This file used to guess: `?steamid=` with an `Authorization: Bearer`. The authority's
// real shape is in `CSGO-Matchmaker/server/lib/dropsNames.js`, which is Movement's own
// client for the same API and has been in production since 2026-07-30:
//
//     GET /internal/name?steam_id=<id64>   ->  { name, changed_at, has_name }
//     header: x-internal-secret: <the shared string>
//
// `steam_id`, not `steamid`; a header, not a bearer. Wired up as it was, the day B set
// `ZM_ENW_BASE` every lookup would have 403'd on the auth and 400'd on the parameter, and
// the failure is SILENT by design (see `call()`) — names would simply never arrive and
// nobody would know why. Both spellings are sent now, so this works against the real
// authority and against anything built to the older guess.
//
// **What this is NOT: Movement's `POST /internal/sso/redeem`.** That route takes a
// single-use ticket and answers with a `steam_id`; it is the login handoff and it
// exposes no player data at all. It cannot answer "what is this steamid called".
//
// NOT CONFIGURED TODAY, and no secret is invented here. `lib/names.js` carries the
// Zombies-side picker that stands in until B supplies one.
const BASE = process.env.ZM_ENW_BASE || null            // e.g. https://drops.ws
// The shared internal secret (drops.ws calls it DROPS_INTERNAL_SECRET). B's to supply.
const SECRET = process.env.ZM_ENW_SECRET || null
const TOKEN = process.env.ZM_ENW_TOKEN || null          // the older bearer spelling, kept
const TIMEOUT_MS = Number(process.env.ZM_ENW_TIMEOUT_MS || 2500)
const NAME_TTL_MS = 6 * 3600_000
const VIP_TTL_MS = 15 * 60_000

const FORCED_VIP = new Set(String(process.env.ZM_VIP_FORCE || '').split(',').map((s) => s.trim()).filter(Boolean))

const enabled = () => !!BASE

async function call(pathname) {
  if (!BASE) return null
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(BASE.replace(/\/$/, '') + pathname, {
      headers: {
        accept: 'application/json',
        ...(SECRET ? { 'x-internal-secret': SECRET } : {}),
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      signal: ac.signal,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    // An ENW outage must never be visible on a Zombies page. The caller falls back to the
    // cache; this returns null and says nothing.
    return null
  } finally { clearTimeout(to) }
}

// ---- 1. the ENW name -----------------------------------------------------------------
// Refreshed at most every six hours and NEVER inside the request that renders a profile:
// callers get the cached value immediately and the refresh runs after the response.
function cachedName(steamId) {
  const u = db.prepare('SELECT enw_name, enw_checked FROM users WHERE steam_id=?').get(String(steamId))
  return u ? u.enw_name : null
}

async function refreshName(steamId) {
  const u = db.prepare('SELECT enw_name, enw_checked FROM users WHERE steam_id=?').get(String(steamId))
  if (!u) return null
  if (!enabled()) return u.enw_name
  if (u.enw_checked && now() - u.enw_checked < NAME_TTL_MS) return u.enw_name
  const sid = encodeURIComponent(steamId)
  const j = await call(`/internal/name?steam_id=${sid}&steamid=${sid}`)
  // `has_name: false` is a real answer — that account has not picked on the authority yet
  // — and it must not overwrite a cached name with null on every refresh.
  const name = j && (j.name || j.username) ? String(j.name || j.username) : u.enw_name
  db.prepare('UPDATE users SET enw_name=?, enw_checked=? WHERE steam_id=?').run(name || null, now(), String(steamId))
  return name
}

// ---- 2. VIP --------------------------------------------------------------------------
// The cache is the answer. A stale VIP is a cosmetic problem for fifteen minutes; a blocked
// page is not.
function isVip(steamId) {
  if (FORCED_VIP.has(String(steamId))) return true
  const u = db.prepare('SELECT vip_is FROM users WHERE steam_id=?').get(String(steamId))
  return !!(u && u.vip_is)
}

async function refreshVip(steamId) {
  if (FORCED_VIP.has(String(steamId))) {
    db.prepare('UPDATE users SET vip_is=1, vip_checked=? WHERE steam_id=?').run(now(), String(steamId))
    return true
  }
  const u = db.prepare('SELECT vip_is, vip_checked FROM users WHERE steam_id=?').get(String(steamId))
  if (!u) return false
  if (!enabled()) return !!u.vip_is
  if (u.vip_checked && now() - u.vip_checked < VIP_TTL_MS) return !!u.vip_is
  const sid = encodeURIComponent(steamId)
  const j = await call(`/internal/vip?steam_id=${sid}&steamid=${sid}`)
  if (!j) { db.prepare('UPDATE users SET vip_checked=? WHERE steam_id=?').run(now(), String(steamId)); return !!u.vip_is }
  const vip = !!(j.vip || j.is_vip)
  db.prepare('UPDATE users SET vip_is=?, vip_checked=? WHERE steam_id=?').run(vip ? 1 : 0, now(), String(steamId))
  return vip
}

// Any VIP in the lobby uncaps the whole game (05, 99 §4.4). The box is told at lease time,
// so this is read once when a game is assigned rather than polled.
const anyVip = (steamIds) => (steamIds || []).some((s) => isVip(s))

function status() {
  return {
    enabled: enabled(),
    base: BASE ? BASE.replace(/^https?:\/\//, '') : null,
    has_token: !!(SECRET || TOKEN),
    has_secret: !!SECRET,
    forced_vip: FORCED_VIP.size,
    // "the Steam persona" was wrong and is corrected: there is no Steam Web API key, so
    // there is no persona to fall back TO. Unconfigured, the name comes from the
    // Zombies-side picker in lib/names.js.
    note: enabled() ? 'live' : 'stubbed — no request leaves this machine; the ENW name comes from the Zombies-side picker (lib/names.js) and VIP from the cached value',
  }
}

module.exports = { enabled, cachedName, refreshName, isVip, refreshVip, anyVip, status }
