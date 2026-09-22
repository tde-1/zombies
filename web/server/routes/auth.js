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
const crypto = require('node:crypto')
const users = require('../lib/users')
const enw = require('../lib/enw')
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
// It hangs off the provider rather than living inside the Steam handler because the mock
// is still the fallback while the beta gate is up: if a launcher could only complete the
// handshake against real Steam, then the day Steam or the redirect broke, the fallback
// would be useless precisely when it was needed.
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
    // The launcher's loopback flow sent EVERY site to `/auth/steam`, including a site
    // running the mock provider — which answers 404, because in mock mode that route is
    // not registered at all. So the one sign-in path a developer (or an agent) can
    // actually drive was the one path this flow could not use, and the launcher's own
    // `supportsLoopbackSignIn()` probe said yes to it regardless. `finishLauncherFlow`
    // is already called by both providers; only the door was wrong. Live is
    // `ZM_AUTH=steam` and is not affected by this line.
    res.redirect(effectiveMode() === 'mock' ? '/auth/mock' : '/auth/steam')
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
    res.json({ ok: true, you: users.pub(u) })
  })

  // ---- the mock provider -----------------------------------------------------------
  // ~~Kept registered alongside real Steam sign-in for as long as the closed-beta gate is
  // up~~ — **retracted 2026-09-22, B: Steam sign-in only.** The fallback was insurance
  // against Steam OpenID not working, and Steam OpenID works (§9): `/auth/steam` redirects
  // correctly, the realm is right, and the three faults in the browser leg are fixed. What
  // the fallback bought us was one less way to be locked out; what it cost is a page that
  // lets anyone who has the shared password become **anyone**, including the admin —
  // and four people now hold that password.
  //
  // So it is registered ONLY in mock mode, which needs `ZM_AUTH` unset or `ZM_PUBLIC_URL`
  // absent. The live site is `ZM_AUTH=steam` with a public URL, so on zombies.enw.gg these
  // two routes do not exist at all. `mockAllowed()` below is the second lock, for a dev
  // box that has been left with `NODE_ENV=production` set.
  if (effectiveMode() === 'mock') {
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
        console.warn(`[auth] MOCK SIGN-IN from ${req.ip} as ${sid} — allowed by ZM_ALLOW_MOCK`)
      }
      req.session.steam_id = u.steam_id
      db.prepare('UPDATE users SET last_seen=? WHERE steam_id=?').run(now(), sid)
      if (finishLauncherFlow(req, res)) return
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

        if (finishLauncherFlow(req, res)) return
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
// ~~So: the shared-password gate IS the access control for the beta~~ — **retracted
// 2026-09-22, B: Steam sign-in only.** `ZM_SITE_PASSWORD` used to open this page to
// anybody who had typed the beta password, which is how a shared password became a way to
// sign in as the site owner. It does not any more. The rule is back to the narrow one:
//
//   never when NODE_ENV=production, and otherwise loopback only.
//
// `ZM_ALLOW_MOCK=1` is the one escape hatch and it exists for the test suites, which spawn
// a real server and sign in over HTTP as several different players. It is never set in
// production; `infra/site.env` does not carry it and neither does `infra/keepalive.ps1`.
function mockAllowed (req) {
  if (process.env.NODE_ENV === 'production') return false
  if (process.env.ZM_ALLOW_MOCK === '1') return true
  return isLoopback(req)
}

function localOnly (req) { return mockAllowed(req) }

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
