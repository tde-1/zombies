// Invite tokens — "this SteamID may join this match, until this time".
//
// Shape: <payload-b64url>.<sig-b64url>, Ed25519 over the payload bytes.
// The SITE issues them (it holds the private half). A game box only ever verifies, so a
// stolen box can not mint joins for anyone. Bound to (steamid, match_id) so a token
// leaked from match A is useless on match B.
//
// The token is passed to the game in userinfo at connect (spec 5.1) and reaches us as
// `player_connect.token`; we answer with `auth {slot, allow, reason}`.
import crypto from 'node:crypto'
import { b64u, unb64u, canonical } from './util.js'
import { sign, verify } from './keys.js'

export const TOKEN_TTL_MS = 5 * 60 * 1000 // short-lived: a lobby launch, not a session

export function issue(privateKey, { steamid, matchId, ttlMs = TOKEN_TTL_MS, slot = null, name = null, keyId = null, now = Date.now() }) {
  const payload = {
    v: 0,
    sid: String(steamid),
    m: String(matchId),
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
    jti: crypto.randomBytes(8).toString('hex'),
    ...(slot != null ? { slot } : {}),
    ...(name ? { n: name } : {}),
    ...(keyId ? { k: keyId } : {}),
  }
  const body = Buffer.from(canonical(payload), 'utf8')
  return `${b64u(body)}.${b64u(sign(privateKey, body))}`
}

// Returns { ok, reason, payload }. `seen` is an optional Set used for single-use
// enforcement (replay of the same jti). Keep `now` injectable so tests are not flaky.
export function check(publicKey, token, { matchId = null, steamid = null, now = Date.now(), seen = null } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' }
  const [b, s] = token.split('.')
  let body, sig
  try { body = unb64u(b); sig = unb64u(s) } catch { return { ok: false, reason: 'malformed' } }
  if (sig.length !== 64) return { ok: false, reason: 'bad_signature_length' }
  if (!verify(publicKey, body, sig)) return { ok: false, reason: 'bad_signature' }
  let payload
  try { payload = JSON.parse(body.toString('utf8')) } catch { return { ok: false, reason: 'bad_payload' } }
  if (payload.v !== 0) return { ok: false, reason: 'bad_version' }
  const t = Math.floor(now / 1000)
  if (typeof payload.exp !== 'number' || t > payload.exp) return { ok: false, reason: 'expired', payload }
  if (typeof payload.iat === 'number' && payload.iat - 60 > t) return { ok: false, reason: 'not_yet_valid', payload }
  if (matchId != null && String(payload.m) !== String(matchId)) return { ok: false, reason: 'wrong_match', payload }
  if (steamid != null && String(payload.sid) !== String(steamid)) return { ok: false, reason: 'wrong_steamid', payload }
  if (seen) {
    if (seen.has(payload.jti)) return { ok: false, reason: 'replayed', payload }
    seen.add(payload.jti)
  }
  return { ok: true, reason: 'ok', payload }
}

/**
 * THE RETURNING PLAYER (host.md §16.4). A client connected to a game stays connected
 * through the `map_restart` that ends it, and re-announces itself to the warm instance
 * with the token it joined with: bound to the PREVIOUS match, used once already, and
 * possibly past its five minutes. `check()` rightly refuses that (`wrong_match`, then
 * `replayed`, then `expired`) and before 2026-09-23 the host kicked the player it had
 * verified a second earlier (box journal 12:17:02, "DENY (wrong_match)").
 *
 * This asks the narrower question: is this a token the SITE signed, for THIS SteamID, for
 * one of THESE matches? Signature, version, match and SteamID must all hold; expiry and
 * single use do not apply, because the connection it vouches for never went away. The
 * caller also requires that the host itself verified that SteamID in that match.
 */
export function checkBinding(publicKey, token, { matchIds = [], steamid = null } = {}) {
  if (!publicKey || typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' }
  const [b, s] = token.split('.')
  let body, sig
  try { body = unb64u(b); sig = unb64u(s) } catch { return { ok: false, reason: 'malformed' } }
  if (sig.length !== 64 || !verify(publicKey, body, sig)) return { ok: false, reason: 'bad_signature' }
  let payload
  try { payload = JSON.parse(body.toString('utf8')) } catch { return { ok: false, reason: 'bad_payload' } }
  if (payload.v !== 0) return { ok: false, reason: 'bad_version' }
  if (!matchIds.map(String).includes(String(payload.m))) return { ok: false, reason: 'wrong_match', payload }
  if (steamid == null || String(payload.sid) !== String(steamid)) return { ok: false, reason: 'wrong_steamid', payload }
  return { ok: true, reason: 'returning', payload }
}

// A host-side guard: holds the site's public key plus the jti set for this boot.
export class TokenGuard {
  constructor(publicKey, { singleUse = true, requireToken = true } = {}) {
    this.publicKey = publicKey
    this.singleUse = singleUse
    this.requireToken = requireToken
    this.seen = new Set()
    this.stats = { allowed: 0, denied: 0, byReason: {} }
  }

  setPublicKey(pk) { this.publicKey = pk }

  // `conn` is the player_connect event. Returns { allow, reason }.
  admit(conn, matchId) {
    const bump = (r) => { this.stats.byReason[r] = (this.stats.byReason[r] || 0) + 1 }
    if (!this.publicKey) {
      // Fail CLOSED on a required check. A box that has not learned the site key yet must
      // not become an open server — that is exactly the "impossible to join / trivially
      // joinable" trap the CS boxes taught us to avoid on the permissive side.
      if (!this.requireToken) { this.stats.allowed++; bump('no_key_open'); return { allow: true, reason: 'token_check_disabled' } }
      this.stats.denied++; bump('no_site_key'); return { allow: false, reason: 'server_not_ready' }
    }
    if (!conn.token) {
      if (!this.requireToken) { this.stats.allowed++; bump('no_token_open'); return { allow: true, reason: 'token_check_disabled' } }
      this.stats.denied++; bump('no_token'); return { allow: false, reason: 'invite_required' }
    }
    const steamid = conn.steamid || conn.xuid || null
    const r = check(this.publicKey, conn.token, { matchId, steamid, seen: this.singleUse ? this.seen : null })
    if (r.ok) { this.stats.allowed++; bump('ok'); return { allow: true, reason: 'ok', payload: r.payload } }
    this.stats.denied++; bump(r.reason)
    return { allow: false, reason: r.reason }
  }
}
