'use strict'

const crypto = require('crypto')

// Canonical JSON — key-sorted, undefined dropped. IDENTICAL to
// `infra/host-agent/lib/util.js` canonical(), and it has to be: the invite token this site
// signs is verified byte-for-byte by the box, and the assignment nonce the box caches is a
// hash of this string. Two spellings of "canonical" would be a bug that only shows up as a
// token that will not verify.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
}

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const unb64u = (s) => Buffer.from(String(s), 'base64url')

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex')

// A short, human-typeable id. Used for match ids, party codes and preset share codes.
// No vowels beyond what base32 gives us and no ambiguous glyphs is deliberate: a preset code
// gets read out loud in a Discord call.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
function shortCode(n = 6) {
  const bytes = crypto.randomBytes(n)
  let out = ''
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

function matchId() {
  return 'm_' + crypto.randomBytes(4).toString('hex')
}

function slugify(name, max = 48) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'x'
}

function safeJson(s, fallback = null) {
  if (s == null) return fallback
  if (typeof s === 'object') return s
  try { return JSON.parse(s) } catch { return fallback }
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

// Midnight Monday for a timestamp, in the server's timezone. The map-of-the-week key
// (Movement's lib/movementWeek.js): the week IS a number, so a run and the week it counts
// toward join on an integer rather than on a date range.
function weekStart(ts = Date.now()) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  const dow = (d.getDay() + 6) % 7 // Monday = 0
  d.setDate(d.getDate() - dow)
  return d.getTime()
}

function fmtDur(ms) {
  if (!Number.isFinite(ms)) return '?'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`
}

// Timing-safe compare for the per-box shared secret. `x-match-secret` is attacker-supplied
// and compared on every poll from every box; a plain === leaks its length and content by
// timing. Movement's boxes are on a trusted network and it does not matter much there; this
// costs nothing, so we do it.
function secretEq(a, b) {
  const A = Buffer.from(String(a || ''))
  const B = Buffer.from(String(b || ''))
  if (A.length !== B.length) return false
  return crypto.timingSafeEqual(A, B)
}

module.exports = {
  canonical, b64u, unb64u, sha256hex, shortCode, matchId, slugify, safeJson,
  clamp, weekStart, fmtDur, secretEq,
}
