'use strict'
// The object-storage redirect (server/lib/bucket.js, docs/kickstart/storage.md).
//
//   node test/bucket.js
//
// No network beyond 127.0.0.1: the bucket's anonymous HEAD is replaced, and a second
// local server plays the bucket for the follow-the-redirect checks.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const express = require('express')
const bucket = require('../server/lib/bucket')

let pass = 0
let fail = 0
async function check (name, fn) {
  try { await fn(); pass++; console.log(`ok    ${name}`) } catch (e) { fail++; console.log(`FAIL  ${name} — ${e.message}`) }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const ENV = { S3_ENDPOINT: 'https://nbg1.your-objectstorage.com', S3_BUCKET_FILES: 'enw-zombies-files', S3_BUCKET_MAPS: 'enw-zombies-maps' }
const listen = (app, host) => new Promise((resolve) => { const s = http.createServer(app).listen(0, host, () => resolve(s)) })

async function main () {
  let heads = 0
  const present = new Map()
  bucket._setHead(async (url) => { heads++; return present.has(url) ? { exists: true, size: present.get(url) } : { exists: false } })

  await check('not configured -> serve locally, and nothing is asked of the bucket', async () => {
    heads = 0
    eq(await bucket.target('files', 'updates/x.exe', 10, { env: {} }), null)
    eq(heads, 0, 'HEADs')
  })

  await check('configured + object exists (same size) -> the public bucket URL', async () => {
    const url = 'https://enw-zombies-files.nbg1.your-objectstorage.com/updates/ENW-Zombies-Launcher-Setup-0.2.11.exe'
    present.set(url, 94607297)
    eq(await bucket.target('files', bucket.keys.update('ENW-Zombies-Launcher-Setup-0.2.11.exe'), 94607297, { env: ENV }), url)
  })

  await check('configured + object missing -> serve locally', async () => {
    eq(await bucket.target('files', 'updates/nope.exe', 1, { env: ENV }), null)
  })

  await check('configured + bucket copy is a different size -> serve locally (stale copy never wins)', async () => {
    present.set('https://enw-zombies-files.nbg1.your-objectstorage.com/updates/stale.exe', 5)
    eq(await bucket.target('files', 'updates/stale.exe', 6, { env: ENV }), null)
  })

  await check('the existence answer is cached for 5 minutes, then asked again', async () => {
    bucket._clear(); heads = 0
    const t = 1_000_000
    await bucket.target('maps', 'mods/a/b.iwd', null, { env: ENV, now: t })
    await bucket.target('maps', 'mods/a/b.iwd', null, { env: ENV, now: t + bucket.TTL_MS - 1 })
    eq(heads, 1, 'HEADs inside the TTL')
    await bucket.target('maps', 'mods/a/b.iwd', null, { env: ENV, now: t + bucket.TTL_MS + 1 })
    eq(heads, 2, 'HEADs after the TTL')
  })

  await check('a HEAD that throws (timeout, DNS) -> serve locally', async () => {
    bucket._setHead(async () => { throw new Error('timeout') })
    eq(await bucket.target('maps', 'mods/x/y.ff', 1, { env: ENV }), null)
    bucket._setHead(async (url) => { heads++; return present.has(url) ? { exists: true, size: present.get(url) } : { exists: false } })
  })

  await check('map keys and URLs: backslashes become slashes, names are encoded', async () => {
    eq(bucket.keys.mapFile('nazi_zombie_x', 'zone\\mod 1.ff'), 'mods/nazi_zombie_x/zone/mod 1.ff')
    eq(bucket.publicUrl('enw-zombies-maps', 'mods/a/zone/mod 1.ff', ENV.S3_ENDPOINT),
      'https://enw-zombies-maps.nbg1.your-objectstorage.com/mods/a/zone/mod%201.ff')
  })

  // ---- the middleware, over real HTTP ------------------------------------------------
  // "The bucket" is a second local server on a DIFFERENT ORIGIN (localhost vs 127.0.0.1)
  // that echoes the headers it received, so the follow checks prove what a launcher's
  // fetch really sends after the 302: the Range header, and no password or cookie.
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-bucket-'))
  const body = Buffer.alloc(1000, 7)
  fs.writeFileSync(path.join(TMP, 'Setup-1.0.0.exe'), body)
  fs.writeFileSync(path.join(TMP, 'Setup-1.0.0.exe.blockmap'), Buffer.alloc(40, 1))
  fs.writeFileSync(path.join(TMP, 'latest.yml'), 'version: 1.0.0\npath: Setup-1.0.0.exe\n')

  const fake = express()
  fake.use((req, res) => res.status(206).json({ path: req.path, range: req.headers.range || null, authorization: req.headers.authorization || null, cookie: req.headers.cookie || null }))
  const fakeSrv = await listen(fake, '127.0.0.1')
  const fakeEndpoint = `http://localhost:${fakeSrv.address().port}`

  const site = express()
  site.use('/updates', bucket.redirectMiddleware('files', TMP, (rel) => (/\.ya?ml$/i.test(rel) ? null : bucket.keys.update(rel))))
  site.use('/updates', express.static(TMP, { index: false }))
  const siteSrv = await listen(site, '127.0.0.1')
  const base = `http://127.0.0.1:${siteSrv.address().port}`

  const saved = { ...process.env }
  Object.assign(process.env, ENV)

  await check('HTTP: not configured -> 200 from disk', async () => {
    delete process.env.S3_BUCKET_FILES; bucket._clear()
    const r = await fetch(`${base}/updates/Setup-1.0.0.exe`, { redirect: 'manual' })
    eq(r.status, 200, 'status'); eq((await r.arrayBuffer()).byteLength, 1000, 'bytes')
    process.env.S3_BUCKET_FILES = ENV.S3_BUCKET_FILES
  })

  await check('HTTP: configured + exists -> 302 to the bucket for the installer AND the blockmap', async () => {
    bucket._clear()
    const u1 = 'https://enw-zombies-files.nbg1.your-objectstorage.com/updates/Setup-1.0.0.exe'
    const u2 = `${u1}.blockmap`
    present.set(u1, 1000); present.set(u2, 40)
    const r1 = await fetch(`${base}/updates/Setup-1.0.0.exe`, { redirect: 'manual' })
    eq(r1.status, 302, 'installer status'); eq(r1.headers.get('location'), u1, 'installer location')
    const r2 = await fetch(`${base}/updates/Setup-1.0.0.exe.blockmap`, { method: 'HEAD', redirect: 'manual' })
    eq(r2.status, 302, 'blockmap status'); eq(r2.headers.get('location'), u2, 'blockmap location')
  })

  await check('HTTP: latest.yml is always served locally, even with the bucket configured', async () => {
    present.set('https://enw-zombies-files.nbg1.your-objectstorage.com/updates/latest.yml', 37)
    const r = await fetch(`${base}/updates/latest.yml`, { redirect: 'manual' })
    eq(r.status, 200, 'status')
  })

  await check('HTTP: a file that is not in the feed directory is never redirected', async () => {
    present.set('https://enw-zombies-files.nbg1.your-objectstorage.com/updates/ghost.exe', 1)
    const r = await fetch(`${base}/updates/ghost.exe`, { redirect: 'manual' })
    eq(r.status, 404, 'status')
  })

  await check('HTTP: following the 302 cross-origin keeps Range and drops Authorization + Cookie', async () => {
    process.env.S3_ENDPOINT = fakeEndpoint; bucket._clear()
    const want = `${fakeEndpoint.replace('//', '//enw-zombies-files.')}/updates/Setup-1.0.0.exe`
    present.set(want, 1000)
    // The site's own 302 names `enw-zombies-files.localhost`, which not every resolver
    // answers, so the follow itself goes through a one-line hop that redirects to the
    // fake at plain `localhost` - still a different origin from 127.0.0.1, which is the
    // property under test.
    const first = await fetch(`${base}/updates/Setup-1.0.0.exe`, { redirect: 'manual' })
    eq(first.status, 302, 'status'); eq(first.headers.get('location'), want, 'location')
    const fakeSite = express()
    fakeSite.get('/go', (req, res) => res.redirect(302, `${fakeEndpoint}/updates/Setup-1.0.0.exe`))
    const hop = await listen(fakeSite, '127.0.0.1')
    const r = await fetch(`http://127.0.0.1:${hop.address().port}/go`, {
      headers: { range: 'bytes=0-99', authorization: 'Basic ZW53OnNlY3JldA==', cookie: 'zm.sid=abc' },
      redirect: 'follow',
    })
    const got = await r.json()
    hop.closeAllConnections(); hop.close()
    eq(got.path, '/updates/Setup-1.0.0.exe', 'path at the bucket')
    eq(got.range, 'bytes=0-99', 'Range at the bucket')
    eq(got.authorization, null, 'Authorization at the bucket')
    eq(got.cookie, null, 'Cookie at the bucket')
  })

  for (const k of Object.keys(ENV)) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k] }
  for (const s of [siteSrv, fakeSrv]) { s.closeAllConnections(); await new Promise((r) => s.close(r)) }
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\nbucket: ${pass} passed, ${fail} failed`)
  // exitCode, not exit(): exiting while fetch's keep-alive sockets are mid-close trips a
  // libuv assertion on Windows (src\win\async.c).
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
