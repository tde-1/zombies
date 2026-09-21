'use strict'

// Sign-in. Steam OpenID, with a MOCK PROVIDER for local development.
//
// ── Why the mock is the default ───────────────────────────────────────────────────
// Real Steam OpenID needs a Steam Web API key to turn the returned identity into a persona
// name and avatar (passport-steam fetches the player summary). We do not have one, we are
// not creating accounts and we are not calling anybody's production API, so:
//
//   ZM_AUTH=mock   (default)  a dev-only sign-in page. Pick or type a SteamID and you are
//                             that person. Bound to 127.0.0.1 and refused outright when
//                             NODE_ENV=production, because a mock login reachable from the
//                             internet is not a login.
//   ZM_AUTH=steam             the real thing, once STEAM_API_KEY and ZM_PUBLIC_URL are set.
//                             passport-steam is an OPTIONAL dependency: if it is not
//                             installed the server says so at boot and stays on the mock
//                             rather than failing to start.
//
// The ENW name is not fetched here. It is a separate narrow API (lib/enw.js) and is refreshed
// after the response, so a slow or absent ENW never delays a login.

const express = require('express')
const users = require('../lib/users')
const enw = require('../lib/enw')
const { db, now } = require('../db/database')

const MODE = (process.env.ZM_AUTH || 'mock').toLowerCase()
const PUBLIC_URL = process.env.ZM_PUBLIC_URL || null
const STEAM_API_KEY = process.env.STEAM_API_KEY || null

// Dev identities the mock sign-in page offers. They are the seed's demo players plus
// whatever else is already in the database, so signing in as somebody who has games shows a
// populated site immediately.
function devIdentities() {
  return db.prepare('SELECT steam_id, username, enw_name, is_admin FROM users WHERE deleted=0 ORDER BY is_admin DESC, created_at LIMIT 25').all()
}

function router() {
  const r = express.Router()

  r.get('/mode', (req, res) => res.json({
    mode: effectiveMode(),
    // Can somebody sign in with Steam? That is the question callers are actually asking,
    // and it does not involve the API key. It used to report false whenever the key was
    // missing, which is how a working sign-in stayed switched off.
    steam_ready: effectiveMode() === 'steam',
    // Whether we can show persona names and avatars, which is what the key buys.
    steam_profiles: !!STEAM_API_KEY,
    enw: enw.status(),
  }))

  // ---- the mock provider -----------------------------------------------------------
  // Kept registered alongside real Steam sign-in for as long as the closed-beta gate is
  // up. The reason is narrow: turning Steam on removes the only other way in, and if the
  // redirect round-trip fails for any reason — a realm mismatch, Steam being down, the
  // tunnel changing hostname — everyone is locked out of their own site with no way to
  // look at anything. During the beta the front door is one shared password held by four
  // people, so the extra exposure is small and the insurance is worth it.
  //
  // It must go when the site opens to the public. Mock sign-in lets anyone who can reach
  // it become anyone.
  const betaFallback = effectiveMode() !== 'mock' && !!process.env.ZM_SITE_PASSWORD
  if (betaFallback) {
    console.warn('[auth] mock sign-in stays available as a fallback while ZM_SITE_PASSWORD is set')
  }
  if (effectiveMode() === 'mock' || betaFallback) {
    r.get('/mock', (req, res) => {
      if (!localOnly(req)) return res.status(403).send('the mock sign-in is not available on this site')
      const list = devIdentities()
      res.type('html').send(mockPage(list, String(req.query.next || '/')))
    })

    r.post('/mock', express.urlencoded({ extended: false }), (req, res) => {
      if (!localOnly(req)) return res.status(403).send('the mock sign-in is not available on this site')
      const sid = String(req.body.steam_id || '').trim()
      if (!/^\d{5,20}$/.test(sid)) return res.status(400).send('that is not a SteamID')
      const name = String(req.body.username || '').trim() || null
      const u = users.ensure(sid, { username: name || undefined })
      // First account on an empty site is the admin. Somebody has to be, and asking a
      // developer to edit a row to see the admin page is friction for no safety.
      const count = db.prepare('SELECT COUNT(*) c FROM users').get().c
      if (count === 1) db.prepare('UPDATE users SET is_admin=1, is_mod=1, approved=1 WHERE steam_id=?').run(sid)
      if (!isLoopback(req)) {
        // Worth shouting about: this is a real account being created or signed into
        // from off-box, with only the shared password in front of it.
        console.warn(`[auth] MOCK SIGN-IN from ${req.ip} as ${sid} — allowed because the shared-password gate is on`)
      }
      req.session.steam_id = u.steam_id
      db.prepare('UPDATE users SET last_seen=? WHERE steam_id=?').run(now(), sid)
      res.redirect(String(req.body.next || '/'))
    })
  }

  // ---- real Steam OpenID ------------------------------------------------------------
  if (effectiveMode() === 'steam') {
    let passport = null
    try {
      passport = require('passport')
      const SteamStrategy = require('passport-steam').Strategy
      passport.serializeUser((u, done) => done(null, u))
      passport.deserializeUser((u, done) => done(null, u))
      // **Signing in with Steam does not need a Steam Web API key.**
      //
      // This was the blocker for weeks and it was never real. Steam sign-in is OpenID
      // 2.0: the browser goes to Steam, Steam sends it back with a signed claim, and we
      // verify the claim. No key is involved. The key is for ISteamUser/GetPlayerSummaries
      // — the persona NAME and the AVATAR — and passport-steam skips that call entirely
      // when `profile` is false (strategy.js: `if (options.profile) getUserProfile(...)`).
      //
      // So the key is a nice-to-have for display, not a prerequisite for identity. We
      // switch on it rather than wait for it: no key means real accounts with a plain
      // name until one arrives, and the day it does, names and avatars fill in with no
      // migration — the steam_id was right all along.
      //
      // That also avoids a trap. Steam issues ONE Web API key per account, and
      // registering one replaces any key that account already has. If the Steam account
      // behind ENW Movement's sign-in is the same one, registering a key for Zombies
      // would silently break Movement's login. Not needing a key sidesteps it.
      passport.use(new SteamStrategy({
        returnURL: `${PUBLIC_URL}/auth/steam/return`,
        realm: PUBLIC_URL,
        apiKey: STEAM_API_KEY || undefined,
        profile: !!STEAM_API_KEY,
      }, (identifier, profile, done) => done(null, { identifier, profile })))
      r.use(passport.initialize())
      r.get('/steam', passport.authenticate('steam', { session: false }))
      r.get('/steam/return', passport.authenticate('steam', { session: false, failureRedirect: '/' }), (req, res) => {
        // With no key there is no profile object, so the SteamID64 comes out of the
        // OpenID identifier itself — which is the part Steam signed, and therefore the
        // part worth trusting. passport-steam has already checked the endpoint, the
        // namespace and the claimed id before we get here.
        const { identifier, profile } = req.user || {}
        const claimed = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(String(identifier || ''))
        const steamId = claimed ? claimed[1] : (profile && profile.id) || null
        if (!steamId) {
          console.warn('[auth] Steam returned a claim we could not read a SteamID64 out of')
          return res.status(400).type('text/plain').send('Steam sign-in failed. Try again.')
        }
        const p = profile || {}
        const u = users.ensure(steamId, {
          username: p.displayName || null,
          avatar: (p.photos && p.photos[2] && p.photos[2].value) || null,
        })
        req.session.steam_id = u.steam_id
        // Both ENW lookups happen AFTER the redirect is on its way.
        setImmediate(() => { enw.refreshName(u.steam_id).catch(() => {}); enw.refreshVip(u.steam_id).catch(() => {}) })
        res.redirect(String(req.session.next || '/'))
      })
    } catch (e) {
      console.warn(`[auth] ZM_AUTH=steam but passport-steam is not usable (${e.message}). Sign-in is unavailable; set ZM_AUTH=mock for local work.`)
      r.get('/steam', (req, res) => res.status(503).json({ error: 'Steam sign-in is not configured on this server' }))
    }
  }

  r.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }))
  })
  r.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'))
  })

  return r
}

// The API key is deliberately NOT part of this test. Sign-in is OpenID and needs only a
// public URL to be redirected back to; the key adds names and avatars. Requiring it here
// is what kept real sign-in switched off while it was already available.
function effectiveMode() {
  if (MODE === 'steam' && PUBLIC_URL) return 'steam'
  return 'mock'
}

function isLoopback (req) {
  const ip = String(req.ip || req.connection.remoteAddress || '')
  return ip.includes('127.0.0.1') || ip.includes('::1') || ip === '::ffff:127.0.0.1'
}

// Who may use the mock sign-in.
//
// It used to be loopback-only, which was right when the site only ever ran on a dev
// box. The closed beta is served at zombies.enw.gg through a Cloudflare tunnel, so
// nobody is loopback any more and the mock was refused for everyone — with no Steam
// key yet, that left the site with no way in at all.
//
// So: the shared-password gate IS the access control for the beta. If you got here you
// already typed it, and a stranger cannot. When the gate is on, the mock is allowed and
// every use of it is logged loudly. With the gate off we are back to the old rule —
// loopback only, never in production — because then nothing is protecting it.
function mockAllowed (req) {
  if (process.env.ZM_SITE_PASSWORD) return true
  if (process.env.NODE_ENV === 'production') return false
  return isLoopback(req)
}

function localOnly (req) { return mockAllowed(req) }

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function mockPage(list, next) {
  const rows = list.map((u) => `
    <form method="post" class="row">
      <input type="hidden" name="steam_id" value="${esc(u.steam_id)}">
      <input type="hidden" name="next" value="${esc(next)}">
      <button type="submit"><b>${esc(u.enw_name || u.username || u.steam_id)}</b>
        <span>${esc(u.steam_id)}${u.is_admin ? ' · admin' : ''}</span></button>
    </form>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>ENW Zombies — dev sign-in</title>
<style>
  :root{--zm-bg:#11120e;--zm-panel:#1a1c15;--zm-bone:#e4dfd1;--zm-muted:#9a9684;--zm-olive:#565a3c;--zm-blood-hi:#b0342c}
  body{margin:0;background:var(--zm-bg);color:var(--zm-bone);font:15px/1.5 'Open Sans',system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
  main{width:420px;max-width:92vw}
  h1{font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:var(--zm-muted);margin:0 0 4px}
  p{color:var(--zm-muted);font-size:13px;margin:0 0 18px}
  .row button{display:flex;width:100%;justify-content:space-between;align-items:baseline;gap:10px;margin:0 0 6px;
    background:var(--zm-panel);color:var(--zm-bone);border:1px solid rgba(230,226,214,.10);border-radius:10px;
    padding:10px 14px;font:inherit;cursor:pointer;text-align:left}
  .row button:hover{border-color:var(--zm-olive)}
  .row span{color:var(--zm-muted);font-size:12px}
  form.new{margin-top:18px;display:flex;gap:8px}
  input[type=text]{flex:1;background:#0d0e0b;border:1px solid rgba(230,226,214,.14);border-radius:8px;color:var(--zm-bone);padding:9px 12px;font:inherit}
  form.new button{background:var(--zm-blood-hi);border:0;border-radius:8px;color:#fff;padding:9px 16px;font:inherit;cursor:pointer}
  .note{margin-top:22px;font-size:12px;color:var(--zm-muted);border-top:1px solid rgba(230,226,214,.10);padding-top:12px}
</style>
<main>
  <h1>ENW Zombies — development sign-in</h1>
  <p>Steam OpenID is not configured on this server, so this stands in for it. Pick an account or type any SteamID.</p>
  ${rows || '<p>No accounts yet — type a SteamID below.</p>'}
  <form method="post" class="new">
    <input type="hidden" name="next" value="${esc(next)}">
    <input type="text" name="steam_id" placeholder="76561198000000000" pattern="\\d{5,20}" required>
    <button type="submit">Sign in</button>
  </form>
  <div class="note">During the closed beta this is behind the shared site password. It is refused entirely when that password is not set and you are not on the machine itself.
  It creates a local account row; it does not talk to Steam, to ENW, or to anything else.</div>
</main>`
}

module.exports = { router, effectiveMode }
