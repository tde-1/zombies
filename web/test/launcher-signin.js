'use strict'

// The launcher's Steam sign-in (RFC 8252), including the attacks it is supposed to stop.
//
//   node test/launcher-signin.js
//
// Steam itself is not reachable from a test, so the OpenID round trip is stood in for by
// the mock sign-in — the part under test is everything on OUR side of it: the code, the
// PKCE check, the redirect construction and the guards. The one thing this cannot prove
// is that Steam redirects where we think; that needs a human and a browser.

const assert = require('node:assert')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const PORT = 33993
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'test-beta-password'
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-signin-'))

const b64url = (b) => Buffer.from(b).toString('base64url')
const sha256b64url = (s) => b64url(crypto.createHash('sha256').update(String(s)).digest())

let passed = 0, failed = 0, child = null
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
           ZM_AUTH: 'mock', ZM_PUBLIC_URL: BASE, STEAM_API_KEY: '' },
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

  // The full happy path. mock sign-in stands in for Steam's redirect.
  let code = null
  const jar = []
  await check('a launcher flow ends at 127.0.0.1 with a code and the state it sent', async () => {
    const started = await get(`/auth/launcher/start?port=41234&state=${state}&challenge=${challenge}`)
    assert.strictEqual(started.status, 302)
    for (const c of started.headers.getSetCookie()) jar.push(c.split(';')[0])

    const done = await fetch(BASE + '/auth/mock', {
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
    const done = await fetch(BASE + '/auth/mock', {
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

  console.log(`\n${passed} passed, ${failed} failed`)
}

main()
  .catch((e) => { console.error(e); failed++ })
  .finally(() => {
    if (child) child.kill()
    try { fs.rmSync(DATA, { recursive: true, force: true }) } catch {}
    process.exit(failed ? 1 : 0)
  })
