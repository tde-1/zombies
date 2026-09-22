'use strict'

// The player's Steam picture, without a Steam Web API key (B, 2026-09-22: "make people's
// Steam profile pictures appear on the UI").
//
// Sign-in is OpenID and carries no picture (routes/auth.js explains why there is no key).
// The public profile does: `https://steamcommunity.com/profiles/<steamid64>?xml=1` answers
// with `<avatarFull>` / `<avatarMedium>` for every account, private ones included, and needs
// no credentials. We read it:
//
//   * once at sign-in (forced), and
//   * at most once a day after that, when the player's own `/api/me` finds it stale.
//
// Never per page render, and never for somebody else: a row shows whatever URL is cached on
// `users.avatar`, and a player who has not been back keeps the last picture we saw.
// `ZM_STEAM_AVATARS=off` switches it off (the test suites do, so `npm test` stays offline).

const { db, now } = require('../db/database')

const TIMEOUT_MS = 5000
const DAY_MS = 24 * 60 * 60_000
const RETRY_MS = 60 * 60_000          // a failed read is tried again in an hour, not every boot
const inflight = new Set()

const enabled = () => {
  const v = String(process.env.ZM_STEAM_AVATARS || '').toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

// Only Steam's own image hosts. The URL lands in an <img src> on every page that shows the
// player, so it is checked here rather than trusted because it came out of Steam's XML.
const HOST_OK = /(^|\.)(steamstatic\.com|akamaihd\.net|steamcdn-a\.akamaihd\.net|cloudflare\.steamstatic\.com)$/i
function cleanUrl (u) {
  try {
    const url = new URL(String(u || '').trim())
    if (url.protocol !== 'https:' || !HOST_OK.test(url.hostname)) return null
    return url.toString()
  } catch { return null }
}

/** Pull `<tag><![CDATA[...]]></tag>` or `<tag>...</tag>` out of Steam's profile XML. */
function tagOf (xml, tag) {
  const m = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${tag}>`).exec(xml)
  return m ? (m[1] != null ? m[1] : m[2]) : null
}

function parse (xml) {
  const s = String(xml || '')
  return cleanUrl(tagOf(s, 'avatarFull')) || cleanUrl(tagOf(s, 'avatarMedium')) || null
}

/**
 * Read the picture and cache it on the users row.
 * @param {string} steamId
 * @param {{force?:boolean}} [o]  force = ignore the daily window (sign-in)
 * @returns {Promise<string|null>} the cached URL after the attempt
 */
async function refresh (steamId, { force = false } = {}) {
  const sid = String(steamId || '')
  if (!/^\d{17}$/.test(sid) || !enabled() || inflight.has(sid)) return null
  const row = db.prepare('SELECT avatar, avatar_checked FROM users WHERE steam_id=?').get(sid)
  if (!row) return null
  if (!force && row.avatar_checked && now() - row.avatar_checked < DAY_MS) return row.avatar || null
  inflight.add(sid)
  try {
    let url = null
    try {
      const r = await fetch(`https://steamcommunity.com/profiles/${sid}?xml=1`, {
        headers: { accept: 'text/xml' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (r.ok) url = parse(await r.text())
    } catch { /* Steam slow or down: keep the last picture */ }
    if (url) {
      db.prepare('UPDATE users SET avatar=?, avatar_checked=? WHERE steam_id=?').run(url, now(), sid)
      return url
    }
    // Nothing usable: keep what we had and look again in an hour rather than a day.
    db.prepare('UPDATE users SET avatar_checked=? WHERE steam_id=?').run(now() - DAY_MS + RETRY_MS, sid)
    return row.avatar || null
  } finally { inflight.delete(sid) }
}

/** Fire-and-forget form for request handlers: never delays a response, never throws. */
function refreshSoon (steamId, o) { setImmediate(() => { refresh(steamId, o).catch(() => {}) }) }

module.exports = { refresh, refreshSoon, parse, cleanUrl, enabled, DAY_MS }
