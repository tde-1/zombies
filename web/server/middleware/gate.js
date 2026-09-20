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
const EXEMPT = [/^\/api\/gs(\/|$)/, /^\/healthz$/]

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
