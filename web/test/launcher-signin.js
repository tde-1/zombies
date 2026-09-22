'use strict'

// The launcher's Steam sign-in (RFC 8252), including the attacks it is supposed to stop.
//
//   node test/launcher-signin.js
//
// Steam itself is not reachable from a test, so the OpenID round trip is stood in for by
// the TEST-ONLY hook (`ZM_TEST_LOGIN=1` -> `POST /auth/test-login`, routes/auth.js; the
// mock sign-in page it replaced is gone, 2026-09-22) — the part under test is everything
// on OUR side of it: the code, the PKCE check, the redirect construction and the guards.
// The one thing this cannot prove is that Steam redirects where we think; that needs a
// human and a browser.

const assert = require('node:assert')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const PORT = 33993
const BASE = `http://127.0.0.1:${PORT}`
// The second instance runs WITHOUT the test hook, exactly as zombies.enw.gg does, because
// the checks that matter most are about what the browser sees when the STEAM leg goes
// wrong, and about the hook not existing there.
// `localhost` rather than 127.0.0.1 on purpose: it makes the public origin DIFFERENT
// from the one a launcher reaching 127.0.0.1 would use, which is the mismatch under test.
const STEAM_PORT = 33994
const STEAM_BASE = `http://127.0.0.1:${STEAM_PORT}`
const STEAM_PUBLIC = `http://localhost:${STEAM_PORT}`
// Long enough that every happy-path check below finishes its own flow well inside it, short
// enough that the one expiry check does not make the suite sleep. Both instances get it.
const FLOW_TTL_MS = 1200
const PASSWORD = 'test-beta-password'
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-signin-'))
const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-signin-steam-'))

const b64url = (b) => Buffer.from(b).toString('base64url')
const sha256b64url = (s) => b64url(crypto.createHash('sha256').update(String(s)).digest())

let passed = 0, failed = 0, child = null, steamChild = null
async function check (name, fn) {
  try { await fn(); console.log('ok    ' + name); passed++ }
  catch (e) { console.log('FAIL  ' + name + ' — ' + e.message); failed++ }
}

// No redirect following anywhere: the redirect IS the thing under test.
function get (p, opts = {}) {
  return fetch(BASE + p, { redirect: 'manual', ...opts })
}
const auth = { authorization: 'Basic ' + Buffer.from('beta:' + PASSWORD).toString('base64') }

async function main () {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ZM_PORT: String(PORT), ZM_DATA_DIR: DATA, ZM_SITE_PASSWORD: PASSWORD,
           ZM_TEST_LOGIN: '1', ZM_MOVEMENT_URL: 'off', ZM_PUBLIC_URL: BASE, STEAM_API_KEY: '',
           ZM_LAUNCHER_FLOW_TTL_MS: String(FLOW_TTL_MS) },
    stdio: 'ignore',
  })
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/health', { headers: auth }); break } catch { await new Promise(r => setTimeout(r, 250)) }
  }

  const verifier = b64url(crypto.randomBytes(32))
  const challenge = sha256b64url(verifier)
  const state = b64url(crypto.randomBytes(16))

  await check('the sign-in paths are reachable without the beta password', async () => {
    // The whole point: Steam and a freshly opened browser cannot send it.
    const r = await get(`/auth/launcher/start?port=41234&state=${state}&challenge=${challenge}`)
    assert.notStrictEqual(r.status, 401, 'start asked for the beta password')
    const s = await get('/auth/steam')
    assert.notStrictEqual(s.status, 401, '/auth/steam asked for the beta password')
    // ...but the site itself still does.
    const home = await get('/')
    assert.strictEqual(home.status, 401, 'the site stopped being gated')
  })

  await check('a bad port, state or challenge is refused', async () => {
    for (const q of [
      `port=80&state=${state}&challenge=${challenge}`,            // privileged port
      `port=99999&state=${state}&challenge=${challenge}`,          // not a port
      `port=41234&state=short&challenge=${challenge}`,             // state too short
      `port=41234&state=${state}&challenge=not-a-sha256`,          // wrong length
      `port=41234&state=${state}`,                                 // no challenge at all
    ]) {
      const r = await get('/auth/launcher/start?' + q)
      assert.strictEqual(r.status, 400, 'accepted ' + q)
    }
  })

  await check('the callback is built from a port, so there is no open redirect', async () => {
    // A URL supplied as the port must not survive into a Location header.
    const evil = encodeURIComponent('https://evil.example/steal')
    const r = await get(`/auth/launcher/start?port=${evil}&state=${state}&challenge=${challenge}`)
    assert.strictEqual(r.status, 400)
    const all = JSON.stringify([...r.headers])
    assert.ok(!all.includes('evil.example'), 'the supplied host reached a header')
  })

  // The full happy path. The test-only hook stands in for Steam's redirect.
  let code = null
  const jar = []
  await check('a launcher flow ends at 127.0.0.1 with a code and the state it sent', async () => {
    const started = await get(`/auth/launcher/start?port=41234&state=${state}&challenge=${challenge}`)
    assert.strictEqual(started.status, 302)
    // Steam, on every site: there is no other provider to send it to (2026-09-22).
    assert.strictEqual(started.headers.get('location'), '/auth/steam',
      'the launcher flow must go to Steam')
    for (const c of started.headers.getSetCookie()) jar.push(c.split(';')[0])

    const done = await fetch(BASE + '/auth/test-login', {
      method: 'POST', redirect: 'manual',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded', cookie: jar.join('; ') },
      body: 'steam_id=76561198000000009',
    })
    const loc = done.headers.get('location') || ''
    assert.ok(loc.startsWith('http://127.0.0.1:41234/cb?'), 'went to ' + loc)
    assert.ok(!loc.startsWith('http://localhost'), 'used a hostname, not 127.0.0.1')
    const u = new URL(loc)
    assert.strictEqual(u.searchParams.get('state'), state, 'state was not echoed')
    code = u.searchParams.get('code')
    assert.ok(code && code.length >= 40, 'no usable code')
    assert.ok(!loc.includes('76561198000000009'), 'the SteamID travelled in the URL')
  })

  await check('the code is worthless without the verifier', async () => {
    const r = await fetch(BASE + '/auth/launcher/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, verifier: b64url(crypto.randomBytes(32)) }),
    })
    assert.strictEqual(r.status, 400, 'a wrong verifier was accepted')
  })

  await check('...and a burnt code cannot be retried, even with the right verifier', async () => {
    // The previous check spent it. Single use means single use whatever went wrong.
    const r = await fetch(BASE + '/auth/launcher/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, verifier }),
    })
    assert.strictEqual(r.status, 400, 'a spent code was accepted')
  })

  await check('the real verifier signs the launcher in, once', async () => {
    const st = b64url(crypto.randomBytes(16))
    const jar2 = []
    const started = await get(`/auth/launcher/start?port=41235&state=${st}&challenge=${challenge}`)
    for (const c of started.headers.getSetCookie()) jar2.push(c.split(';')[0])
    const done = await fetch(BASE + '/auth/test-login', {
      method: 'POST', redirect: 'manual',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded', cookie: jar2.join('; ') },
      body: 'steam_id=76561198000000009',
    })
    const fresh = new URL(done.headers.get('location')).searchParams.get('code')

    const ex = await fetch(BASE + '/auth/launcher/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: fresh, verifier }),
    })
    assert.strictEqual(ex.status, 200, 'the exchange failed')
    const body = await ex.json()
    assert.strictEqual(body.ok, true)
    assert.ok(body.you && body.you.steam_id === '76561198000000009', 'wrong account')

    // The session cookie must be set on THIS response — that is what makes the launcher
    // signed in for every later API call.
    const set = ex.headers.getSetCookie().join(';')
    assert.ok(set.includes('zm.sid'), 'no session cookie came back')
  })

  await check('a made-up code is refused and says nothing useful about why', async () => {
    const r = await fetch(BASE + '/auth/launcher/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: b64url(crypto.randomBytes(32)), verifier }),
    })
    assert.strictEqual(r.status, 400)
    const b = await r.json()
    assert.strictEqual(b.error, 'that sign-in code is not valid', 'the error distinguishes failures')
  })

  await check('a launcher flow that ran out gets a page, not the closed-beta password box', async () => {
    // LAUNCHER_FLOW_TTL_MS times a HUMAN doing a Steam Guard login; it used to be the
    // 120-second machine TTL, and when it expired the browser was redirected to `/` —
    // which is behind the beta password. Checked on the test-hook instance because that is
    // the one where a flow can be finished without Steam; the code path is the same
    // `finishLauncherFlow` on both.
    const st = b64url(crypto.randomBytes(16))
    const jar3 = []
    const started = await get(`/auth/launcher/start?port=41236&state=${st}&challenge=${challenge}`)
    assert.strictEqual(started.status, 302, 'start did not begin a flow')
    for (const c of started.headers.getSetCookie()) jar3.push(c.split(';')[0])

    await new Promise(r => setTimeout(r, FLOW_TTL_MS + 150))   // the human took too long

    const done = await fetch(BASE + '/auth/test-login', {
      method: 'POST', redirect: 'manual',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded', cookie: jar3.join('; ') },
      body: 'steam_id=76561198000000009',
    })
    const loc = done.headers.get('location') || ''
    assert.ok(!loc.startsWith('http://127.0.0.1:41236/'), 'an expired flow still minted a code')
    assert.notStrictEqual(loc, '/', 'still redirected to the gated site root')
    const body = await done.text()
    assert.ok(/too long/i.test(body), 'the page does not say the sign-in expired: ' + body.slice(0, 120))
  })

  // ── the Steam leg, and the three ways it used to dump a player somewhere useless ──
  //
  // None of this needs Steam. What is under test is OUR side of the return: what the
  // browser is shown when the answer does not check out, when the flow has expired, and
  // when the launcher started on the wrong origin. All three used to end at `/` or at a
  // 500, and `/` is behind the beta password — so "sign in" ended in a password box.
  steamChild = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ZM_PORT: String(STEAM_PORT), ZM_DATA_DIR: DATA2, ZM_SITE_PASSWORD: PASSWORD,
           ZM_PUBLIC_URL: STEAM_PUBLIC, STEAM_API_KEY: '', ZM_MOVEMENT_URL: 'off',
           ZM_LAUNCHER_FLOW_TTL_MS: String(FLOW_TTL_MS) },
    stdio: 'ignore',
  })
  for (let i = 0; i < 60; i++) {
    try { await fetch(STEAM_BASE + '/api/health', { headers: auth }); break } catch { await new Promise(r => setTimeout(r, 250)) }
  }
  const sget = (p, opts = {}) => fetch(STEAM_BASE + p, { redirect: 'manual', ...opts })

  await check('steam mode really is on, and /auth/steam goes to Steam', async () => {
    const r = await sget('/auth/steam')
    assert.strictEqual(r.status, 302)
    const loc = r.headers.get('location') || ''
    assert.ok(loc.startsWith('https://steamcommunity.com/openid/login'), 'went to ' + loc)
    assert.ok(loc.includes(encodeURIComponent(STEAM_PUBLIC + '/auth/steam/return')), 'wrong return_to')
  })

  await check('a Steam return that will not verify is explained, not a 500 with a stack in it', async () => {
    const r = await sget('/auth/steam/return?openid.mode=id_res')
    // It used to be 500 + the full InternalOpenIDError stack, on a path deliberately
    // reachable WITHOUT the beta password.
    assert.notStrictEqual(r.status, 500, 'still a 500')
    assert.notStrictEqual(r.status, 302, 'still redirecting (that lands on the password box)')
    const body = await r.text()
    assert.ok(!/node_modules|InternalOpenIDError|at Strategy/.test(body), 'a stack trace reached the browser')
    assert.ok(/Steam/.test(body), 'the page does not say what happened')
  })

  // ── Steam sign-in ONLY (B, 2026-09-22) ────────────────────────────────────────
  await check('no dev sign-in exists on a site without the test hook: /auth/mock and /auth/test-login are 404', async () => {
    // /auth/mock used to be registered alongside Steam for as long as ZM_SITE_PASSWORD was
    // set — which made a shared password a way to sign in as anybody, the admin included.
    // It is gone everywhere now (2026-09-22). /auth/test-login exists only with
    // ZM_TEST_LOGIN=1, and this instance is configured the way zombies.enw.gg is. Both
    // verbs, because a GET-only guard is not a guard.
    for (const p of ['/auth/mock', '/auth/test-login']) {
      for (const init of [{}, { method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body: 'steam_id=76561198000000009' }]) {
        const r = await fetch(`${STEAM_PUBLIC}${p}`, { redirect: 'manual', headers: auth, ...init })
        assert.strictEqual(r.status, 404, `${p} answered ${r.status} on a Steam-only site`)
      }
    }
    // ...and the test-hook instance has no mock either: the hook is not a sign-in page.
    const m = await fetch(`${BASE}/auth/mock`, { redirect: 'manual', headers: auth })
    assert.strictEqual(m.status, 404, `/auth/mock answered ${m.status} on the test-hook instance`)
    const g = await fetch(`${BASE}/auth/test-login`, { redirect: 'manual', headers: auth })
    assert.strictEqual(g.status, 404, 'the test hook answers GET — it must be POST only, with no page')
  })

  await check('the test hook refuses to boot in production', async () => {
    // Lock 1 of three (routes/auth.js): ZM_TEST_LOGIN=1 with NODE_ENV=production does not
    // start a server at all, rather than starting one with a way in.
    const DATA3 = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-signin-prod-'))
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['server/index.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ZM_PORT: '33995', ZM_DATA_DIR: DATA3, NODE_ENV: 'production', ZM_TEST_LOGIN: '1', ZM_MOVEMENT_URL: 'off' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let err = ''
      c.stderr.on('data', (d) => { err += d })
      const t = setTimeout(() => { c.kill(); resolve({ code: 'still running', err }) }, 8000)
      c.on('exit', (code) => { clearTimeout(t); resolve({ code, err }) })
    })
    try { fs.rmSync(DATA3, { recursive: true, force: true }) } catch {}
    assert.notStrictEqual(out.code, 'still running', 'a production server came up with the test hook set')
    assert.notStrictEqual(out.code, 0, 'exited 0')
    assert.ok(/ZM_TEST_LOGIN/.test(out.err), 'the refusal does not say why: ' + out.err.slice(0, 200))
  })

  await check('a launcher that started on the wrong origin is moved to ZM_PUBLIC_URL', async () => {
    // 127.0.0.1 is not the public origin here, so the session written at /start would
    // be in a jar Steam's return never reaches. The fix is to move the browser, with
    // the three already-validated values carried across and nothing the caller sent.
    const st = b64url(crypto.randomBytes(16))
    const r = await sget(`/auth/launcher/start?port=41237&state=${st}&challenge=${challenge}`)
    assert.strictEqual(r.status, 302)
    const loc = r.headers.get('location') || ''
    assert.ok(loc.startsWith(STEAM_PUBLIC + '/auth/launcher/start?'), 'went to ' + loc)
    const u = new URL(loc)
    assert.strictEqual(u.searchParams.get('port'), '41237')
    assert.strictEqual(u.searchParams.get('state'), st)
    assert.strictEqual(u.searchParams.get('moved'), '1', 'nothing stops this looping')
  })

  await check('...and the move happens once, so a wrong ZM_PUBLIC_URL cannot loop', async () => {
    const st = b64url(crypto.randomBytes(16))
    const r = await sget(`/auth/launcher/start?port=41238&state=${st}&challenge=${challenge}&moved=1`)
    assert.strictEqual(r.status, 302)
    assert.strictEqual(r.headers.get('location'), '/auth/steam', 'it bounced again')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
}

main()
  .catch((e) => { console.error(e); failed++ })
  .finally(() => {
    if (child) child.kill()
    if (steamChild) steamChild.kill()
    try { fs.rmSync(DATA, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(DATA2, { recursive: true, force: true }) } catch {}
    process.exit(failed ? 1 : 0)
  })
