'use strict'
// A single shared password in front of the whole site, for the private beta.
//
// This is a front door, not an identity: everyone types the same password, and who you
// ARE is still decided by sign-in. It exists so zombies.enw.gg can be public on the
// internet without being open to the internet.
//
// Off unless ZM_SITE_PASSWORD is set, so local development is unchanged.
// Exempt: the pull protocol (/api/gs/*, which has its own per-box secret and is used by
// game boxes that cannot type a password) and /healthz.

const crypto = require('node:crypto')

const REALM = 'ENW Zombies (closed beta)'
const EXEMPT = [
  /^\/api\/gs(\/|$)/,
  // The in-game chat overlay (routes/gamechat.js). The game cannot type a password either,
  // and every route under it refuses without a chat pass, which only a signed-in
  // launcher can get (POST /api/launcher/chat-token, which IS behind the gate).
  /^\/api\/game-chat(\/|$)/,
  // The in-game Esc menu's Exit game (routes/site.js POST /api/party/quit). Same reason
  // and the same lock: the game cannot type a password, and the route refuses anything
  // that is not a session or a valid chat pass.
  /^\/api\/party\/quit$/,
  /^\/healthz$/,
  // The launcher's update feed. An installer is not a secret, and a silently dead updater
  // is much the worse failure: electron-updater would get a 401 it cannot answer, every
  // friend's client would stop updating, and nobody would find out for weeks. The launcher
  // does send the password as well, so this is belt and braces rather than the only thing
  // holding it up. Nothing under /updates identifies anyone or reveals anything the
  // installer itself does not.
  /^\/updates(\/|$)/,
  // Exported map geometry for the replay viewer (/mapdata, routes/replay.js). Asked for
  // by B through the coordinator, 2026-09-23, and it is worth being honest about the
  // trade rather than filing it under "static assets".
  //
  // FOR: it is one 38 MB file per map fetched by a loader, not a page. A gate cookie that
  // has expired mid-session turns that fetch into a 401 body the glb parser reads as
  // corrupt geometry, and the viewer then reports "the map failed to load" for a map that
  // is sitting right there. Nothing under here identifies anyone or says anything about
  // a game, a player or a record.
  // AGAINST, and unresolved: a `.glb` built by tools/maps/export_map.py is DERIVED FROM
  // THE GAME — Treyarch's geometry and Treyarch's textures, re-encoded. Exempting it puts
  // game assets on a public URL with no password in front of them. That is a redistribution
  // question, not a security one, and it is B's to answer; it is in questions.md.
  /^\/mapdata(\/|$)/,
  // Signing in with Steam. These have to be reachable without the beta password because
  // two of the parties in the handshake cannot possibly supply one: Steam, which redirects
  // the browser back to us and knows nothing about a password, and the player's own
  // browser, which the launcher opens fresh and which may never have visited this site.
  //
  // It costs nothing. None of these paths serves site content — they start an identity
  // handshake, finish one, or redeem a code. Somebody who gets through here has an
  // account and still cannot see a single page without the password, because the gate
  // and the session are different things. An account is not access.
  /^\/auth\/steam(\/|$)/,
  /^\/auth\/launcher(\/|$)/,
  // A map's card picture, and only that (tools/maps/map_art.py: <stem>.webp and
  // <stem>.thumb.webp). The launcher's Discord Rich Presence shows it as the large image
  // while a player is in that map, and Discord's image proxy fetches it from here: it
  // cannot type a password, so behind the gate every friend's presence would show a blank
  // square. It is the picture on the map's public card; the page around it stays gated.
  /^\/media\/maps\/[a-z0-9_-]+(\.thumb)?\.webp$/,
]

function timingSafeEqual (a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

function gate () {
  const password = process.env.ZM_SITE_PASSWORD || ''
  if (!password) return (req, res, next) => next()

  // A cookie so the password is typed once per browser rather than on every request,
  // and so the game-facing paths are never asked for it.
  const cookieName = 'zm_gate'
  const token = crypto.createHash('sha256').update('zm-gate:' + password).digest('hex').slice(0, 32)

  return function siteGate (req, res, next) {
    if (EXEMPT.some(re => re.test(req.path))) return next()
    if (req.headers.cookie && req.headers.cookie.includes(`${cookieName}=${token}`)) return next()

    const header = req.headers.authorization || ''
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
      const supplied = decoded.slice(decoded.indexOf(':') + 1)
      if (timingSafeEqual(supplied, password)) {
        res.setHeader('Set-Cookie',
          `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`)
        return next()
      }
    }

    res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`)
    res.status(401).type('text/plain').send('ENW Zombies is in closed beta. Ask B for the password.')
  }
}

module.exports = { gate }
