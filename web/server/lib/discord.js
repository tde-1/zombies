'use strict'

// The Discord invite in the top right — Movement's behaviour: the link is an INVITATION,
// so it is shown to people who are not in yet and to nobody else.
//
// ── What "in the Discord" means here, honestly ────────────────────────────────────
//
// It means **this account has a `discord_id` on its row**, and nothing more. It is not a
// membership check against Discord's API — we do not hold a bot token, a guild id or a
// user's OAuth grant — and this file does not pretend otherwise. What it is, is the same
// test Movement's own top-right link makes: has this person linked their Discord to their
// account. Nothing writes `discord_id` yet (the OAuth link flow is `web.md` §12d and was
// not built tonight), so today the answer is "no" for everybody and the link shows for
// everybody.
//
// That is deliberately the failure direction that is merely untidy. An invite shown to
// somebody already in the server is a link they ignore. An invite hidden from somebody
// outside it is the feature silently not working.
//
// ── The invite URL ────────────────────────────────────────────────────────────────
//
// Movement's is a module constant — `DISCORD_INVITE = 'https://discord.enw.gg'` in
// `movement-client/src/components/DiscordNavLink.jsx` — not env, not config, not a row.
// It is the same community, so it is the same default here, and B does not have to
// supply anything for the link to work tonight.
//
// `ENW_DISCORD_INVITE` in `infra/site.env` overrides it, for the day the vanity URL moves
// or Zombies wants its own channel. It is read per call rather than cached so that a
// keepalive restart is all it takes.

const { db } = require('../db/database')

const DEFAULT_INVITE = 'https://discord.enw.gg'

/** The invite. Movement's, unless this deployment names another. */
function invite() {
  const v = String(process.env.ENW_DISCORD_INVITE || '').trim()
  if (!v) return DEFAULT_INVITE
  // An env var is a thing that gets pasted wrong at 2am, and this string goes into an
  // `href` every visitor sees. An `https://` URL or nothing.
  if (!/^https:\/\/[a-z0-9.-]+(\/[^\s]*)?$/i.test(v)) return DEFAULT_INVITE
  return v.slice(0, 200)
}

/** Has this account linked a Discord? `null`/signed out is "no". */
function isLinked(steamId) {
  if (!steamId) return false
  try {
    const row = db.prepare('SELECT discord_id FROM users WHERE steam_id=?').get(String(steamId))
    return !!(row && row.discord_id)
  } catch { return false }
}

/**
 * What `/api/me` tells the browser. `invite` is null when unset OR when the person has
 * already linked — the client never gets a URL it is not supposed to draw, so there is no
 * second place the rule could be got wrong.
 */
function forMe(steamId) {
  const linked = isLinked(steamId)
  return { linked, invite: linked ? null : invite() }
}

module.exports = { invite, isLinked, forMe }
