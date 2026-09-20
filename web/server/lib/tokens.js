'use strict'

// Invite tokens — "this SteamID may join this match, until this time".
//
// THE SITE ISSUES, THE BOX VERIFIES. This file is the issuing half of
// `infra/host-agent/lib/tokens.js` and the wire format is copied from it exactly:
//
//     <payload-b64url>.<sig-b64url>,  Ed25519 over the canonical payload bytes
//     payload = { v:0, sid, m, iat, exp, jti, slot?, n?, k? }
//
// If any of that drifts — a key renamed, a number stringified, canonical() ordering
// different — every join fails with `bad_signature` and the site looks fine from here. The
// contract test in `web/test/run-all.js` signs a token and verifies it with the host agent's
// own check() to stop that happening quietly.
//
// The token is handed to the launcher, passed into the game in userinfo at connect (99 §5.1)
// and reaches the box as `player_connect.token`. Five minutes is a lobby launch, not a
// session: a leaked token is worthless by the time anyone finds it.

const crypto = require('crypto')
const { b64u, canonical } = require('./util')
const keys = require('./siteKeys')

const TOKEN_TTL_MS = 5 * 60 * 1000

function issue({ steamid, matchId, ttlMs = TOKEN_TTL_MS, slot = null, name = null, now = Date.now() }) {
  const k = keys.site()
  const payload = {
    v: 0,
    sid: String(steamid),
    m: String(matchId),
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
    jti: crypto.randomBytes(8).toString('hex'),
    ...(slot != null ? { slot } : {}),
    ...(name ? { n: name } : {}),
    k: k.keyId,
  }
  const body = Buffer.from(canonical(payload), 'utf8')
  return `${b64u(body)}.${b64u(keys.sign(k.privateKey, body))}`
}

// The site rarely needs to verify its own tokens (the box does that), but the launcher
// hand-off and the tests do, and an issuer that cannot read its own output is not testable.
function check(token, { matchId = null, steamid = null, now = Date.now() } = {}) {
  const k = keys.site()
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' }
  const [b, s] = token.split('.')
  let body, sig
  try { body = Buffer.from(b, 'base64url'); sig = Buffer.from(s, 'base64url') } catch { return { ok: false, reason: 'malformed' } }
  if (sig.length !== 64) return { ok: false, reason: 'bad_signature_length' }
  if (!keys.verify(k.publicKey, body, sig)) return { ok: false, reason: 'bad_signature' }
  let payload
  try { payload = JSON.parse(body.toString('utf8')) } catch { return { ok: false, reason: 'bad_payload' } }
  const t = Math.floor(now / 1000)
  if (payload.v !== 0) return { ok: false, reason: 'bad_version' }
  if (typeof payload.exp !== 'number' || t > payload.exp) return { ok: false, reason: 'expired', payload }
  if (matchId != null && String(payload.m) !== String(matchId)) return { ok: false, reason: 'wrong_match', payload }
  if (steamid != null && String(payload.sid) !== String(steamid)) return { ok: false, reason: 'wrong_steamid', payload }
  return { ok: true, reason: 'ok', payload }
}

module.exports = { issue, check, TOKEN_TTL_MS }
