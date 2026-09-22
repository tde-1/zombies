#!/usr/bin/env node
// Prove the launch harness without the game.
//
// Four agents are contending for game.lock on this box, and the game itself is the one
// thing this code does not control. So: build a fake game folder whose "CoDWaW.exe" is
// a copy of node.exe, run the real GameLaunch against it, and check what the child
// actually received — the command line, the working directory, the environment, and
// the invite token over the pipe.
//
// What this does NOT prove: that the engine likes the arguments, that our binkw32
// proxy loads, or that the map comes up. Those need the real exe and the lock.
//
//   node test/launch-harness.js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'enw-harness-'))
process.env.ENW_ROOT = path.join(TMP, 'enwroot')
process.env.ENW_DEV_ROOT = path.join(TMP, 'devbox')   // a game lock of our own, not B's
fs.mkdirSync(path.join(TMP, 'devbox', 'locks'), { recursive: true })
// The launcher refuses to start while a real World at War is running — it reads the
// pid out of %LOCALAPPDATA%\Activision\CoDWaW\__CoDWaW. That guard is correct and it
// fired the first time this harness ran, with another agent's game live. Point
// LOCALAPPDATA at our own temp dir so the stand-in run neither sees nor disturbs it.
process.env.LOCALAPPDATA = path.join(TMP, 'localappdata')
fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true })

const { GameLaunch } = await import('../src/main/launch.js')
const lock = await import('../src/main/gamelock.js')

// ---- the stand-in "game" -----------------------------------------------------------
// node.exe, renamed. NODE_OPTIONS=--require <shim> makes it run our shim before it
// fails on the nonsense "script path" the engine's arguments look like, and the shim
// exits cleanly once it has written its report.
const gameDir = path.join(TMP, 'fakegame')
fs.mkdirSync(gameDir, { recursive: true })
fs.copyFileSync(process.execPath, path.join(gameDir, 'CoDWaW.exe'))

const reportFile = path.join(TMP, 'child-report.json')
const shim = path.join(TMP, 'shim.cjs')
fs.writeFileSync(shim, `
const fs = require('fs'), net = require('net')
// The engine's arguments look like a nonsense script path to node, so it would exit
// with MODULE_NOT_FOUND before our async pipe read finished. A --require preload runs
// before the entry point, so we simply take the entry point away.
require('module').runMain = () => {}
const out = {
  argv: process.argv.slice(1),
  cwd: process.cwd(),
  env: {
    SteamAppId: process.env.SteamAppId, SteamGameId: process.env.SteamGameId,
    ENW_HOST: process.env.ENW_HOST, ENW_INSTANCE: process.env.ENW_INSTANCE,
    ENW_ROLE: process.env.ENW_ROLE, ENW_LOGDIR: process.env.ENW_LOGDIR,
    ENW_TOKEN_PIPE: process.env.ENW_TOKEN_PIPE, ENW_TOKEN: process.env.ENW_TOKEN || null,
    ENW_FS_HOMEPATH: process.env.ENW_FS_HOMEPATH || null,
    ENW_CLIENT_CONNECT: process.env.ENW_CLIENT_CONNECT || null,
    ENW_CONNECT_ADDR: process.env.ENW_CONNECT_ADDR || null,
    ENW_RAW_SOCKETS: process.env.ENW_RAW_SOCKETS || null,
  },
  token: null, tokenError: null,
}
// Read the invite token exactly the way the client DLL is being asked to.
const done = () => { fs.writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify(out, null, 2)); process.exit(0) }
if (out.env.ENW_TOKEN_PIPE) {
  const c = net.connect(out.env.ENW_TOKEN_PIPE)
  let buf = ''
  c.on('data', (d) => { buf += d })
  c.on('end', () => { try { out.token = JSON.parse(buf).token } catch (e) { out.tokenError = 'bad payload: ' + buf.slice(0, 80) } ; setTimeout(done, 1500) })
  c.on('error', (e) => { out.tokenError = e.message; setTimeout(done, 1500) })
} else { setTimeout(done, 1500) }
`)
// Backslashes are eaten inside NODE_OPTIONS quoting; node accepts forward slashes.
process.env.NODE_OPTIONS = `--require "${shim.split(path.sep).join('/')}"`

// ---- run the real launcher ---------------------------------------------------------
const SECRET = 'eyJhbGciOiJFZDI1NTE5In0.THIS-IS-THE-INVITE-TOKEN'
const events = []
const l = new GameLaunch({
  gameDir,
  host: '127.0.0.1:28964',
  map: 'nazi_zombie_prototype',   // CL_ConnectLocal takes one; a join without it throws
  token: SECRET,
  instance: 'm_harness',
  role: 'client',
  linkHost: '127.0.0.1:38700',
  settings: { fov: 95, maxFps: 200 },
  lockName: 'launcher-harness',
  why: 'launch harness (no real game)',
  nannySeconds: 20,
})
l.on('note', (n) => events.push(`note: ${n}`))
l.on('spawn', (s) => events.push(`spawn: pid ${s.pid}`))
l.on('exit', (e) => events.push(`exit: code ${e.code}`))

const started = await l.start()
console.log(`launched pid ${started.pid}`)
console.log(`lock during launch: ${JSON.stringify(lock.read())}`)

// Wait for the child's report.
const deadline = Date.now() + 15000
while (!fs.existsSync(reportFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
if (!fs.existsSync(reportFile)) {
  console.error('the stand-in never wrote its report')
  try { fs.appendFileSync(process.stderr.fd, fs.readFileSync(started.stderr)) } catch {}
  process.exit(1)
}
const child = JSON.parse(fs.readFileSync(reportFile, 'utf8'))

// ---- what the child actually got ---------------------------------------------------
let fail = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) } catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message}`) }
}

console.log('\nWhat the stand-in game received')
const cmdline = child.argv.join(' ')
check('the three arguments from the brief', () => {
  assert.match(cmdline, /\+set com_introPlayed 1/)
  assert.match(cmdline, /\+set fs_game mods\/enw/)
  assert.equal(cmdline.includes('+connect'), false, 'this exe has no `connect` client command')
})
check('the join is armed in the environment, which is the only thing that works', () => {
  assert.equal(child.env.ENW_CONNECT_ADDR, '127.0.0.1:28964')
  assert.ok(child.env.ENW_CLIENT_CONNECT, 'ENW_CLIENT_CONNECT (the map name) is missing')
  assert.equal(child.env.ENW_RAW_SOCKETS, '1')
})
check('the account settings, applied over the top', () => {
  assert.match(cmdline, /\+set cg_fov 95/)
  assert.match(cmdline, /\+set com_maxfps 200/)
})
check('fs_homepath points at the ENW folder, with no space in it', () => {
  const i = child.argv.indexOf('fs_homepath')
  assert.ok(i > 0, 'fs_homepath missing')
  assert.equal(child.argv[i + 1].includes(' '), false)
})
check('THE TOKEN IS NOT IN THE COMMAND LINE THE CHILD SEES', () => {
  assert.equal(cmdline.includes(SECRET), false, 'the token reached the command line')
  assert.equal(cmdline.includes('THIS-IS-THE-INVITE-TOKEN'), false)
})
check('the DLL is told where to write the userinfo config, and the engine is told to exec it', () => {
  assert.equal(child.env.ENW_FS_HOMEPATH, child.argv[child.argv.indexOf('fs_homepath') + 1])
  assert.match(cmdline, /\+exec enw_auth\.cfg/)
})
check('the token IS delivered over the pipe', () => {
  assert.equal(child.tokenError, null, String(child.tokenError))
  assert.equal(child.token, SECRET)
})
check('the token is not in the environment either (pipe mode)', () => {
  assert.equal(child.env.ENW_TOKEN, null)
  assert.ok(child.env.ENW_TOKEN_PIPE.startsWith('\\\\.\\pipe\\enw-launch-'))
})
check('SteamStub hints are set (a copied exe exits without them)', () => {
  assert.equal(child.env.SteamAppId, '10090')
  assert.equal(child.env.SteamGameId, '10090')
})
check('game-link v0 environment is set', () => {
  assert.equal(child.env.ENW_HOST, '127.0.0.1:38700')
  assert.equal(child.env.ENW_INSTANCE, 'm_harness')
  assert.equal(child.env.ENW_ROLE, 'client')
  assert.ok(child.env.ENW_LOGDIR)
})
check('the working directory is our game folder', () => {
  assert.equal(child.cwd.toLowerCase(), fs.realpathSync(gameDir).toLowerCase())
})

// Give the exit handler a moment, then check the lock was cleaned up.
await new Promise((r) => setTimeout(r, 2500))
check('the game lock is released afterwards', () => {
  const s = lock.read()
  assert.equal(s.held, false, `still held: ${s.raw}`)
})
check('the token pipe is closed afterwards', () => {
  assert.equal(l.tokenPipe.closed, true)
})

console.log('\nWhat the launcher reported')
for (const e of events) console.log(`  ${e}`)

console.log(`\nfull command line the child saw:\n  ${cmdline}`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`\n${fail ? `${fail} FAILED` : 'all checks passed'}`)
process.exit(fail ? 1 : 0)
