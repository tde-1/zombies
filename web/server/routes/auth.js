'use strict'

// Sign-in. **Steam OpenID, and nothing else** (B, 2026-09-22: "Remove all the dev logins and
// all the fake logins … To be a user you have to sign in with Steam and you have to have an
// ENW username").
//
// ── What went, and why none of it is behind a flag ────────────────────────────────────
// This file used to carry a MOCK PROVIDER: `ZM_AUTH=mock` (the default!) registered a page at
// `/auth/mock` that listed every account on the site and signed you in as whichever you
// clicked, or as any SteamID you typed. §10e narrowed it to loopback and to "not on a Steam
// site"; it is now gone outright, with `ZM_AUTH`, `ZM_ALLOW_MOCK`, the account list and the
// "first account on an empty site is the admin" rule. A dev box signs in with Steam too:
// OpenID needs a URL for Steam to send the browser back to, not a public one, so with
// `ZM_PUBLIC_URL` unset the site uses its own loopback address and real Steam sign-in works
// on 127.0.0.1 exactly as it does on zombies.enw.gg.
//
// ── The one thing that stays: a TEST-ONLY hook ────────────────────────────────────────
// `npm test` spawns real servers and signs in as several players over HTTP; it cannot drive
// steamcommunity.com. So `ZM_TEST_LOGIN=1` registers `POST /auth/test-login` ({steam_id}),
// which does exactly what a verified Steam return does — `users.ensure(steamid)`, set the
// session, finish a launcher flow if one is open — and nothing more: no name, no approval,
// no admin. Three locks, and it is documented in docs/kickstart/web.md (the 2026-09-22
// identity section):
//
//   1. the server REFUSES TO START with ZM_TEST_LOGIN=1 and NODE_ENV=production;
//   2. the route is not registered at all unless ZM_TEST_LOGIN=1 — on zombies.enw.gg it is a
//      404, and `infra/site.env` / `infra/keepalive.ps1` set neither;
//   3. it answers loopback callers only, whatever the env says.
//
// The ENW name is not fetched here. It is a separate narrow API (lib/enw.js) and is refreshed
// after the response, so a slow or absent ENW never delays a login. Choosing one is the first
// thing a new account does after this file is finished with it (lib/names.js, the picker).

const express = require('express')
const crypto = require('node:crypto')
const users = require('../lib/users')
const enw = require('../lib/enw')
const steamAvatar = require('../lib/steamAvatar')
const { db, now } = require('../db/database')

// ── Signing in from the LAUNCHER ──────────────────────────────────────────────────
//
// The launcher is a native app, so this follows RFC 8252 (OAuth 2.0 for Native Apps):
// the sign-in happens in the USER'S OWN BROWSER, and the result comes back to the app
// over a loopback redirect. Not in an embedded window.
//
// That is not a workaround for the window opening externally — it is the recommendation,
// for two reasons that both matter here. An embedded webview hides the address bar and
// the padlock, so nobody can tell a real Steam login from a painted one, and the app that
// hosts the webview can read what is typed into it; a Steam password is exactly the thing
// that must never go through our process. And the system browser already has the user's
// Steam session, so for most people this is one click rather than a fresh login.
//
// The flow, end to end:
//
//   1. launcher  binds 127.0.0.1:<ephemeral>, invents `state` and a PKCE verifier
//   2. launcher  opens the system browser at /auth/launcher/start?port&state&challenge
//   3. site      remembers the flow in the session, sends the browser to Steam
//   4. Steam     signs the user in and redirects to /auth/steam/return
//   5. site      mints a single-use code and redirects to http://127.0.0.1:<port>/cb
//   6. launcher  checks `state`, POSTs code + verifier to /auth/launcher/exchange
//   7. site      checks SHA-256(verifier) against the stored challenge, burns the code,
//                and sets the session cookie on the launcher's own request
//
// Why each guard is there, because every one of them is a real attack on this shape:
//
//   * PKCE (S256). Any other process on the machine could receive that callback if it
//     got to the port first. The code alone is worthless without the verifier, which
//     never leaves the launcher.
//   * `state`, so a callback the launcher did not start is ignored.
//   * The redirect target is BUILT HERE from a port number — the launcher never sends a
//     URL. There is no open redirect to find, because there is no URL to supply.
//   * 127.0.0.1 literal, never `localhost`: RFC 8252 §8.3, because `localhost` can be
//     pointed elsewhere by DNS or the hosts file.
//   * Codes are single use with a 120-second life, and the store is capped, so a flood
//     of starts cannot grow memory without bound.
//
// ── Two clocks, not one (2026-09-22) ──────────────────────────────────────────────
// This used to be ONE constant, and that was the bug that stopped B signing in. The
// 120-second life is right for a CODE: it is minted by a machine and spent by a machine
// milliseconds later, so anything longer is only exposure. It is completely wrong for
// the BROWSER LEG, which is a person: opening a tab, logging in to Steam, and reading a
// Steam Guard code off a phone. Two minutes is routinely not enough for that, and when
// it ran out `finishLauncherFlow` quietly declined to fire, the browser was redirected
// to `/`, and the player got the closed-beta password box instead of a sign-in — which
// looks exactly like "I could not log in through the website". The launcher, meanwhile,
// gave up at 125 s with "Sign-in timed out".
//
//   LAUNCHER_FLOW_TTL_MS   start -> Steam -> return.  A HUMAN is in this one.
//   LAUNCHER_CODE_TTL_MS   return -> exchange.        Only the launcher is in this one.
//
// The site's window is deliberately LONGER than the launcher's own timeout, so the
// launcher is always the party that gives up first and can say so in its own words.
// `ZM_LAUNCHER_FLOW_TTL_MS` exists so test/launcher-signin.js can prove the expiry page
// without sleeping for a quarter of an hour. Nothing sets it in production.
const LAUNCHER_FLOW_TTL_MS = Number(process.env.ZM_LAUNCHER_FLOW_TTL_MS) || 15 * 60_000
const LAUNCHER_CODE_TTL_MS = 120_000
const LAUNCHER_MAX_PENDING = 200
const launcherCodes = new Map()

function sweepLauncherCodes () {
  const cutoff = Date.now()
  for (const [k, v] of launcherCodes) if (v.expires <= cutoff) launcherCodes.delete(k)
  // Cap after sweeping: if something is hammering /start, drop the oldest rather than
  // letting the map grow. Losing a stale half-finished sign-in is harmless.
  while (launcherCodes.size > LAUNCHER_MAX_PENDING) {
    launcherCodes.delete(launcherCodes.keys().next().value)
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const sha256b64url = (s) => b64url(crypto.createHash('sha256').update(String(s)).digest())

// Step 5, shared by every provider. Returns true when it has sent the browser back to the
// launcher, false when this was an ordinary sign-in in an ordinary browser.
//
// It is a function of its own rather than inline in the Steam return because the test-only
// hook finishes the same flow, so `test/launcher-signin.js` exercises the real code.
//
// The code goes in the query string and the SteamID does not. A URL is the most leaked
// string there is — history, referrers, shoulders — so what travels that way is worth
// nothing alone: two minutes to live, one use, and unusable without the verifier that
// never left the launcher.
function finishLauncherFlow (req, res) {
  const flow = req.session && req.session.launcher
  if (!flow) return false
  if (Date.now() - flow.at >= LAUNCHER_FLOW_TTL_MS) {
    // Say so, rather than falling through to a redirect to `/` that the beta gate then
    // answers with a password box. The player did nothing wrong and deserves to be told
    // which thing ran out.
    delete req.session.launcher
    signInProblem(res, 'That sign-in took too long',
      'The launcher opened this page more than fifteen minutes ago, so it stopped waiting.',
      'Close this tab and press <b>Sign in</b> in ENW Zombies again.')
    return true
  }
  delete req.session.launcher
  sweepLauncherCodes()
  const code = b64url(crypto.randomBytes(32))
  launcherCodes.set(code, {
    steam_id: req.session.steam_id,
    challenge: flow.challenge,
    expires: Date.now() + LAUNCHER_CODE_TTL_MS,
  })
  // Built here from a port, never taken as a URL, and 127.0.0.1 rather than `localhost`
  // (RFC 8252 §8.3 — a name can be repointed, an address cannot).
  res.redirect(`http://127.0.0.1:${flow.port}/cb`
    + `?code=${encodeURIComponent(code)}&state=${encodeURIComponent(flow.state)}`)
  return true
}

const PORT = Number(process.env.PORT || process.env.ZM_PORT || 3200)
// Where Steam sends the browser back to. On the live site that is https://zombies.enw.gg
// (infra/site.env). Unset — a dev box, a test — it is this process's own loopback address,
// which Steam accepts as an OpenID realm like any other.
const PUBLIC_URL = (process.env.ZM_PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')
const STEAM_API_KEY = process.env.STEAM_API_KEY || null
const TEST_LOGIN = process.env.ZM_TEST_LOGIN === '1'

function router() {
  const r = express.Router()

  // Lock 1 of the test hook: refuse to come up at all rather than serve it in production.
  if (TEST_LOGIN && process.env.NODE_ENV === 'production') {
    throw new Error('ZM_TEST_LOGIN=1 is set with NODE_ENV=production. The test-only sign-in is never served in production; unset ZM_TEST_LOGIN.')
  }

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

  // ---- the launcher's half of RFC 8252 ------------------------------------------------
  // Step 2: the launcher has opened the system browser here. Nothing is decided yet; we
  // only remember what the launcher told us and hand the browser to the identity provider.
  r.get('/launcher/start', (req, res) => {
    const port = Number(req.query.port)
    const state = String(req.query.state || '')
    const challenge = String(req.query.challenge || '')

    // Ports below 1024 need privilege the launcher does not have, so a low one is either
    // a mistake or somebody trying to make us talk to something else.
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return res.status(400).type('text/plain').send('bad callback port')
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) {
      return res.status(400).type('text/plain').send('bad state')
    }
    // 43 chars is exactly a base64url SHA-256. S256 only: `plain` is in the RFC for
    // devices that cannot hash, which does not describe an Electron app.
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return res.status(400).type('text/plain').send('bad PKCE challenge')
    }

    // ── The origin has to be the one Steam will come back to ────────────────────────
    //
    // Steam's `return_to` is built from ZM_PUBLIC_URL and nothing else, so the return
    // leg ALWAYS lands on that origin. If the launcher opened this page on a different
    // one — it fell back to http://127.0.0.1:3200, or somebody pinned a site URL — then
    // the `launcher` flow we are about to write goes into a session belonging to a
    // different cookie jar, the return finds nothing, and the whole thing dies silently
    // with the player parked on a page that cannot explain itself.
    //
    // It is fixable rather than merely reportable: send the browser to the public
    // origin's copy of this exact URL and carry on there. Built from ZM_PUBLIC_URL and
    // the three values already validated above — nothing the caller supplied reaches
    // the Location header, so this is not an open redirect. `moved` stops a loop if
    // ZM_PUBLIC_URL disagrees with what the proxy actually passes us.
    if (PUBLIC_URL && !req.query.moved) {
      let want = null
      try { want = new URL(PUBLIC_URL) } catch { /* misconfigured; carry on regardless */ }
      const here = `${req.protocol}://${req.get('host') || ''}`
      if (want && want.origin && want.origin !== here) {
        console.warn(`[auth] launcher sign-in started on ${here} but ZM_PUBLIC_URL is ${want.origin}; moving the browser there`)
        return res.redirect(`${want.origin}/auth/launcher/start?port=${port}`
          + `&state=${encodeURIComponent(state)}&challenge=${encodeURIComponent(challenge)}&moved=1`)
      }
    }

    req.session.launcher = { port, state, challenge, at: Date.now() }
    // Steam, always — there is no other provider (2026-09-22). The mock-mode branch that
    // used to live here went with the mock.
    res.redirect('/auth/steam')
  })

  // Step 6: the launcher redeems its code. This is the only request in the flow that comes
  // from the launcher itself rather than from a browser, and the only one that gets a
  // session cookie.
  r.post('/launcher/exchange', express.json({ limit: '4kb' }), (req, res) => {
    sweepLauncherCodes()
    const code = String((req.body && req.body.code) || '')
    const verifier = String((req.body && req.body.verifier) || '')
    if (!code || !verifier) return res.status(400).json({ error: 'code and verifier are required' })

    const entry = launcherCodes.get(code)
    // One message for every failure. Telling a caller whether a code was unknown, expired
    // or already spent is telling them how to probe.
    const nope = () => res.status(400).json({ error: 'that sign-in code is not valid' })
    if (!entry) return nope()
    launcherCodes.delete(code)                       // single use, whatever happens next
    if (entry.expires <= Date.now()) return nope()
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return nope()

    const expected = Buffer.from(entry.challenge)
    const actual = Buffer.from(sha256b64url(verifier))
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return nope()

    const u = users.byId(entry.steam_id)
    if (!u) return nope()
    req.session.steam_id = u.steam_id
    db.prepare('UPDATE users SET last_seen=? WHERE steam_id=?').run(now(), u.steam_id)
    // `needs_name`: this Steam account has not chosen its ENW username yet, so `you.name` is
    // a bare SteamID and is not a name to put in the game. The launcher's wrapped site shows
    // the picker next, and the launcher re-reads the name from /api/launcher/hello before a
    // launch (launcher/src/main/main.js).
    res.json({ ok: true, you: users.pub(u), needs_name: require('../lib/names').needsName(u.steam_id) })
  })

  // ---- the test-only hook (see the top of this file) ---------------------------------
  // ~~The mock provider~~ — **removed 2026-09-22, B: Steam sign-in only, no dev logins.** What
  // replaced it is not a sign-in page: there is no GET, nothing lists accounts, nothing makes
  // anybody an admin, and it does not exist unless the test suites asked for it.
  if (TEST_LOGIN) {
    r.post('/test-login', express.urlencoded({ extended: false }), express.json({ limit: '4kb' }), (req, res) => {
      if (process.env.NODE_ENV === 'production' || !isLoopback(req)) return res.status(404).type('text/plain').send('Not found')
      const sid = String((req.body && req.body.steam_id) || '').trim()
      if (!/^\d{17}$/.test(sid)) return res.status(400).json({ error: 'steam_id must be a SteamID64' })
      console.warn(`[auth] TEST-ONLY sign-in as ${sid} (ZM_TEST_LOGIN=1)`)
      const u = users.ensure(sid)
      req.session.steam_id = u.steam_id
      db.prepare('UPDATE users SET last_seen=? WHERE steam_id=?').run(now(), sid)
      if (finishLauncherFlow(req, res)) return
      res.json({ ok: true, you: users.pub(users.byId(sid)) })
    })
  }

  // ---- real Steam OpenID ------------------------------------------------------------
  {
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

      // The return leg, and why it is wrapped rather than handed straight to passport.
      //
      // Two things were wrong here and both of them ended with the player looking at
      // something that is not a sign-in page:
      //
      //  * `failureRedirect: '/'` sent every refusal — Steam cancelled, an assertion
      //    that would not verify — to the site root, which is behind the closed-beta
      //    password. The player pressed "sign in" and got a browser password box. The
      //    root is the ONE place this handler must not send anybody: `/auth/*` is
      //    exempt from the gate precisely because a freshly opened browser has no
      //    password, and redirecting off `/auth/*` throws that exemption away.
      //  * `failureRedirect` does not cover an ERROR, only a failure. passport-openid
      //    raises `InternalOpenIDError: Failed to verify assertion` as an error, so it
      //    went to Express's default handler: **HTTP 500 with a full Node stack trace**,
      //    on a path that is deliberately reachable without the beta password. Verified
      //    on a private instance on 3399.
      //
      // So: no redirect, no stack. The page is rendered here, on a gate-exempt path,
      // and it says which leg failed.
      const steamReturn = (req, res, next) => {
        passport.authenticate('steam', { session: false }, (err, user) => {
          if (err) {
            console.warn(`[auth] Steam return failed: ${err.message || err}`)
            return signInProblem(res, 'Steam could not confirm that sign-in',
              'Steam sent us back, but the answer did not check out. That is usually a sign-in that was left open too long, or Steam having a bad minute.',
              'Close this tab and try <b>Sign in</b> again.', 400)
          }
          if (!user) {
            return signInProblem(res, 'That sign-in was cancelled',
              'Steam did not sign you in, so nothing changed here.',
              'Close this tab and press <b>Sign in</b> again when you are ready.', 400)
          }
          req.user = user
          next()
        })(req, res, next)
      }

      r.get('/steam/return', steamReturn, (req, res) => {
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
        // And their ENW Movement banner (lib/movementProfile.js): public read, file copied here.
        setImmediate(() => { require('../lib/movementProfile').refresh(u.steam_id).catch(() => {}) })
        // The Steam picture, read off the public profile with no key (lib/steamAvatar.js).
        steamAvatar.refreshSoon(u.steam_id, { force: true })

        if (finishLauncherFlow(req, res)) return
        res.redirect(String(req.session.next || '/'))
      })
    } catch (e) {
      console.warn(`[auth] passport-steam is not usable (${e.message}). Sign-in is unavailable until it is installed (npm install).`)
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

// There is one mode. Kept as a function because /api/me, /api/launcher/hello, /api/health
// and the site page all report it, and the launcher reads `auth` off hello.
function effectiveMode() { return 'steam' }

function isLoopback (req) {
  const ip = String(req.ip || (req.connection && req.connection.remoteAddress) || '')
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

// A sign-in that did not work, said out loud, ON A GATE-EXEMPT PATH.
//
// Every failure in the browser leg used to end at `/`, and `/` is behind the
// closed-beta password — so the last thing a player saw after pressing "Sign in" was a
// browser password box, or a bare 500 with a Node stack in it. Neither says what
// happened and neither is something the launcher can recover from. This is rendered
// in place, under /auth/, so nothing is redirected out of the exemption.
function signInProblem (res, title, what, next, status = 410) {
  res.status(status).type('html').send(`<!doctype html><meta charset="utf-8">
<title>ENW Zombies — ${esc(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;
    background:#11120e;color:#e4dfd1;font:15px/1.6 'Open Sans',system-ui,sans-serif}
  main{max-width:34rem;padding:2rem}
  h1{font-size:16px;letter-spacing:.06em;text-transform:uppercase;color:#b0342c;margin:0 0 .8rem}
  p{color:#9a9684;margin:.4rem 0}
  b{color:#e4dfd1;font-weight:600}
</style>
<main><h1>${esc(title)}</h1><p>${esc(what)}</p><p>${next}</p></main>`)
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

module.exports = { router, effectiveMode }
