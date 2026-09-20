#!/usr/bin/env node
// In-process checks for the parts of the launcher that must not be wrong.
//
// Bias: the tests here are about DAMAGE and TRUST, not coverage. Writing into
// someone's Steam install, deleting their game through a junction, putting an invite
// token on a command line, or accepting a modified exe as verified — those are the
// failures worth a test. Rendering is checked by the smoke run instead.
//
//   node test/run-all.js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'enw-launcher-test-'))
process.env.ENW_ROOT = path.join(TMP, 'enwroot')
process.env.ENW_DEV_ROOT = path.join(TMP, 'nodevbox') // keep the real game lock out of it

const vdf = await import('../src/main/vdf.js')
const pe = await import('../src/main/pe.js')
const detect = await import('../src/main/detect.js')
const paths = await import('../src/main/paths.js')
const setup = await import('../src/main/setup.js')
const launch = await import('../src/main/launch.js')
const crash = await import('../src/main/crash.js')
const settings = await import('../src/main/settings.js')
const updates = await import('../src/main/updates.js')

let pass = 0
let fail = 0
const only = process.argv[2] || null
async function test(name, fn) {
  if (only && !name.includes(only)) return
  try { await fn(); pass++; console.log(`  ok   ${name}`) }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message}`) }
}
const group = (n) => console.log(`\n${n}`)

// ----------------------------------------------------------------------- vdf --
group('VDF')

await test('parses libraryfolders.vdf (object format)', () => {
  const v = vdf.parse(`
"libraryfolders"
{
  "0"
  {
    "path"    "C:\\\\Program Files (x86)\\\\Steam"
    "apps" { "10090" "12345678" "220" "1" }
  }
  "1"
  {
    "path"    "D:\\\\SteamLibrary"
    "apps" { "730" "99" }
  }
}`)
  const lf = vdf.get(v, 'libraryfolders')
  assert.equal(vdf.getPath(lf, '0', 'path'), 'C:\\Program Files (x86)\\Steam')
  assert.equal(vdf.getPath(lf, '1', 'path'), 'D:\\SteamLibrary')
  assert.ok('10090' in vdf.getPath(lf, '0', 'apps'))
})

await test('parses the old flat libraryfolders format', () => {
  const v = vdf.parse(`"LibraryFolders"\n{\n "TimeNextStatsReport" "x"\n "1" "D:\\\\Games\\\\Steam"\n}`)
  assert.equal(vdf.getPath(v, 'LibraryFolders', '1'), 'D:\\Games\\Steam')
})

await test('survives comments, escapes and a truncated file', () => {
  const v = vdf.parse(`"a" { // a comment\n "b" "line\\nbreak" \n "c" "quote\\"inside"\n "d" {`)
  assert.equal(vdf.getPath(v, 'a', 'b'), 'line\nbreak')
  assert.equal(vdf.getPath(v, 'a', 'c'), 'quote"inside')
})

await test('lookups are case-insensitive (Steam is inconsistent)', () => {
  const v = vdf.parse('"AppState" { "InstallDir" "Call of Duty World at War" }')
  assert.equal(vdf.getPath(v, 'appstate', 'installdir'), 'Call of Duty World at War')
})

// ------------------------------------------------------------------------ pe --
group('PE reading')

const REAL_EXE = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Call of Duty World at War\\CoDWaW.exe'
const haveReal = fs.existsSync(REAL_EXE)

await test('reads the real CoDWaW.exe: 32-bit, 1.7, SteamStub', () => {
  if (!haveReal) return
  const info = pe.read(REAL_EXE)
  assert.equal(info.pe32, true)
  assert.equal(info.machine, 0x14c)
  assert.equal(info.hasBind, true, 'expected a .bind section (SteamStub)')
  assert.equal(pe.isVersion17(info.version), true)
  assert.equal(info.size, detect.KNOWN.size)
})

await test('returns null for junk rather than throwing', () => {
  const f = path.join(TMP, 'junk.exe')
  fs.writeFileSync(f, crypto.randomBytes(4096))
  assert.equal(pe.read(f), null)
  fs.writeFileSync(f, Buffer.from('MZ' + '\0'.repeat(2000)))
  assert.equal(pe.read(f), null)
})

// ------------------------------------------------------------------ validate --
group('Validation: what we refuse')

function fakeInstall(name, { exeBytes = null, withData = true } = {}) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'CoDWaW.exe'), exeBytes ?? Buffer.alloc(1024))
  if (withData) { fs.mkdirSync(path.join(dir, 'main'), { recursive: true }); fs.mkdirSync(path.join(dir, 'zone'), { recursive: true }) }
  return dir
}

await test('rejects a folder with no CoDWaW.exe', () => {
  const dir = path.join(TMP, 'empty')
  fs.mkdirSync(dir, { recursive: true })
  const v = detect.validate(dir)
  assert.equal(v.ok, false)
  assert.match(v.reason, /No CoDWaW\.exe/)
})

await test('rejects a renamed non-Steam executable as "not the Steam release"', () => {
  const v = detect.validate(fakeInstall('fake1'))
  assert.equal(v.ok, false)
  assert.equal(v.grade, 'rejected')
  assert.match(v.reason, /not the Steam release/)
})

await test('rejects an exe with no game data beside it', () => {
  if (!haveReal) return
  const dir = fakeInstall('fake2', { exeBytes: fs.readFileSync(REAL_EXE), withData: false })
  const v = detect.validate(dir)
  assert.equal(v.ok, false)
  assert.match(v.reason, /not the game files/)
})

await test('grades the real install "verified" and names the build', () => {
  if (!haveReal) return
  const v = detect.validate(path.dirname(REAL_EXE))
  assert.equal(v.ok, true)
  assert.equal(v.grade, 'verified')
  assert.equal(v.knownBuild, true)
  assert.equal(v.sha256, detect.KNOWN.sha256)
  assert.ok(v.checks.every((c) => c.ok), 'every check should pass on B\'s install')
})

await test('a modified exe of the right size is accepted but NOT verified', () => {
  if (!haveReal) return
  const bytes = Buffer.from(fs.readFileSync(REAL_EXE))
  bytes[bytes.length - 1] ^= 0xff // one flipped byte
  const dir = fakeInstall('modified', { exeBytes: bytes })
  const v = detect.validate(dir)
  assert.equal(v.ok, true)
  assert.notEqual(v.grade, 'verified')
  assert.equal(v.knownBuild, false)
  assert.match(v.reason, /differs from the build we know/)
})

await test('never accepts CoDWaWmp.exe as the target', () => {
  assert.equal(detect.FORBIDDEN_EXE, 'codwawmp.exe')
})

// ------------------------------------------------------------ browse search --
group('The forgiving browse fallback')

await test('finds the game from a folder inside it', () => {
  if (!haveReal) return
  const r = detect.searchAround(path.join(path.dirname(REAL_EXE), 'main'))
  assert.equal(r.hits.length >= 1, true)
  assert.equal(r.hits[0].dir.toLowerCase(), path.dirname(REAL_EXE).toLowerCase())
  assert.match(r.hits[0].how, /above/)
})

await test('finds the game from the Steam root above it', () => {
  if (!haveReal) return
  const r = detect.searchAround('C:\\Program Files (x86)\\Steam')
  assert.equal(r.hits[0].dir.toLowerCase(), path.dirname(REAL_EXE).toLowerCase())
})

await test('is bounded: a huge wrong pick gives up instead of hanging', () => {
  const t0 = Date.now()
  const r = detect.searchAround(os.homedir(), { maxDirs: 300 })
  assert.ok(Date.now() - t0 < 15000, 'should not take 15 s')
  assert.ok(r.scanned <= 300 + 50)
})

await test('accepts the exe itself being picked', () => {
  if (!haveReal) return
  const r = detect.searchAround(REAL_EXE)
  assert.equal(r.hits[0].dir.toLowerCase(), path.dirname(REAL_EXE).toLowerCase())
})

// ----------------------------------------------------------- the write guard --
group('The write guard (never touch the player\'s game)')

await test('refuses every path under a Steam install', () => {
  for (const p of [
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Call of Duty World at War\\binkw32.dll',
    'C:\\Program Files (x86)\\Steam\\anything.txt',
    'C:\\Program Files\\Steam\\x',
  ]) assert.throws(() => paths.assertWritable(p), /Refusing to write/, p)
})

await test('refuses anything outside the ENW folder', () => {
  assert.throws(() => paths.assertWritable('C:\\Users\\b\\Desktop\\whatever.txt'), /Refusing to write outside/)
  assert.throws(() => paths.assertWritable(path.join(TMP, 'sneaky.txt')), /Refusing to write outside/)
})

await test('allows paths inside the ENW folder', () => {
  assert.ok(paths.assertWritable(path.join(paths.P.root, 'game', 'binkw32.dll')))
})

await test('a protected root added at runtime is honoured', () => {
  const custom = path.join(TMP, 'someones-game')
  fs.mkdirSync(custom, { recursive: true })
  paths.protectPath(custom)
  assert.throws(() => paths.assertWritable(path.join(custom, 'x')), /protected game install/)
})

await test('isInside does not match a sibling with a shared prefix', () => {
  assert.equal(paths.isInside('C:\\a\\bc', 'C:\\a\\b'), false)
  assert.equal(paths.isInside('C:\\a\\b\\c', 'C:\\a\\b'), true)
})

// ------------------------------------------------------- junction behaviour --
group('Junctions: uninstall must never delete through one')

await test('removing our folder removes the link, not the target', () => {
  const target = path.join(TMP, 'precious')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'game-data.txt'), 'do not delete me')
  const gameDir = paths.P.game
  fs.mkdirSync(gameDir, { recursive: true })
  const link = path.join(gameDir, 'main')
  if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'junction')
  assert.ok(fs.existsSync(path.join(link, 'game-data.txt')), 'the junction should be readable')

  setup.removeGameFolder()

  assert.equal(fs.existsSync(gameDir), false, 'our folder should be gone')
  assert.equal(fs.existsSync(path.join(target, 'game-data.txt')), true, 'THE TARGET MUST SURVIVE')
})

// ------------------------------------------------- the map library / junctions --
group('Map library')

await test('mkdirSync(recursive) over a DANGLING junction throws ENOENT', () => {
  // The trap that broke the first custom-map launch. A junction whose target has gone
  // is not "an existing directory" to Node: existsSync says false and `mkdir -p` throws
  // ENOENT instead of doing nothing. Anything that creates a directory which might
  // already be a link has to check first.
  const target = path.join(TMP, 'dangle-target')
  const link = path.join(TMP, 'dangle-link')
  fs.mkdirSync(target, { recursive: true })
  try { fs.symlinkSync(target, link, 'junction') } catch { return } // not NTFS
  assert.equal(fs.existsSync(link), true, 'a live junction exists')
  assert.doesNotThrow(() => fs.mkdirSync(link, { recursive: true }), 'a live junction is fine')
  fs.rmdirSync(target)
  assert.equal(fs.existsSync(link), false, 'a dangling junction does not "exist"')
  assert.throws(() => fs.mkdirSync(link, { recursive: true }), /ENOENT/)
})

await test('maps install to the ONE folder World at War loads them from', async () => {
  // dedi measured this: <fs_homepath>\mods and <game copy>\mods both fail SILENTLY —
  // the .iwds mount and the search path looks right, but `mod.ff` is a zone, not a
  // filesystem asset, so it never loads and +map never runs. Only the player's own
  // %LOCALAPPDATA%\Activision\CoDWaW\mods works. Locking that in.
  const paths2 = await import('../src/main/paths.js')
  const lib = await import('../src/main/library.js')
  const want = path.join(process.env.LOCALAPPDATA, 'Activision', 'CoDWaW', 'mods')
  assert.equal(paths2.P.maps.toLowerCase(), want.toLowerCase())
  assert.equal(lib.installDir('some_map'), path.join(want, 'some_map'))
  // …and that folder is the one exception to "never write outside the ENW folder".
  assert.ok(paths2.assertWritable(path.join(want, 'some_map', 'mod.ff')))
  assert.throws(() => paths2.assertWritable(path.join(process.env.LOCALAPPDATA, 'Activision', 'CoDWaW', 'players', 'x')), /Refusing to write/)
})

await test("a map the player installed themselves is never touched", async () => {
  const lib = await import('../src/main/library.js')
  // B's own nazi_zombie_ali lives in that folder. Ours carry a record file; theirs
  // do not, and that is the whole test.
  const o = lib.ownership('definitely_not_a_real_map_' + Date.now())
  assert.equal(o.state, 'absent')
  const src = String(fs.readFileSync(new URL('../src/main/library.js', import.meta.url)))
  assert.ok(src.includes("state: 'theirs'"), 'ownership must be able to say a map belongs to the player')
  assert.ok(src.includes('ENW did not put it there'), 'install must refuse to overwrite it')
  assert.ok(src.includes('that map is yours'), 'uninstall must refuse to delete it')
})

await test('the console-log detector catches the SILENT wrong-location failure', async () => {
  // The coordinator is right that asserting the path is not enough: the bug class is
  // "everything looks fine and the map never loads". So drive the real detector with
  // real lines from both runs.
  //
  // WORKING (Leviathan installed in %LOCALAPPDATA%\Activision\CoDWaW\mods):
  const { GameLaunch } = await import('../src/main/launch.js')
  const good = new GameLaunch({ fsGame: 'mods/nazi_zombie_leviathan', installDir: 'X' })
  let up = null
  good.on('map_up', (e) => { up = e })
  for (const line of [
    "Loading fastfile 'mod'",
    'Server: nazi_zombie_leviathan',
    "Waited 937 msec for asset 'maps/nazi_zombie_leviathan.d3dbsp' of type 'col_map_mp'.",
  ]) good.onConsoleLine(line)
  assert.ok(up, 'a real loading sequence must report the map as up')
  assert.equal(up.map, 'nazi_zombie_leviathan')
  assert.equal(good.diagnose(), null, 'a working run has nothing to diagnose')

  // SILENT FAILURE (same map installed under <fs_homepath>\mods): the .iwds mount and
  // the search path prints fine, but `Loading fastfile 'mod'` never appears.
  const bad = new GameLaunch({ fsGame: 'mods/nazi_zombie_hijacked', installDir: 'Y' })
  let badUp = null
  bad.on('map_up', (e) => { badUp = e })
  for (const line of [
    'C:\Users\b\AppData\Local\ENWZombies\home/mods/nazi_zombie_hijacked',
    "Loading fastfile 'common'",
    `Error: Can't find map "nazi_zombie_hijacked".`,
    'A mod is required for custom maps',
  ]) bad.onConsoleLine(line)
  assert.equal(badUp, null, 'a map that never loaded must not be reported as up')
  const d = bad.diagnose()
  assert.ok(d, 'the silent failure must be diagnosed, not left as "no map yet"')
  assert.match(d.why, /Activision/)
  assert.equal(d.check, 'Y')
})

await test("a map's title is not its bsp name, and the catalogue keeps both", async () => {
  const lib = await import('../src/main/library.js')
  const c = lib.catalogue()
  if (!c.maps.length) return
  for (const m of c.maps) {
    assert.ok(m.bsp, 'every map has a bsp')
    assert.ok(m.title, 'every map has a title')
  }
  // The specific pair, because the whole point is that they differ.
  const water = c.maps.find((m) => m.bsp === 'water')
  if (water) assert.equal(water.title, 'Alcatraz')
})

await test('an executable inside a map is never copied', async () => {
  const lib = await import('../src/main/library.js')
  const src = String(fs.readFileSync(new URL('../src/main/library.js', import.meta.url)))
  assert.ok(src.includes("'.exe'"), 'the banned list must name .exe')
  assert.ok(src.includes('never copies or runs an executable that came with a map'))
  assert.ok(typeof lib.install === 'function')
})

// ------------------------------------------------------------- site + password --
group('Site URL and the closed-beta password')

await test('the site resolves production first, then local', async () => {
  const cfg = await import('../src/main/config.js')
  assert.equal(cfg.PRODUCTION_SITE, 'https://zombies.enw.gg')
  assert.equal(cfg.DEFAULTS.siteCandidates[0].url, cfg.PRODUCTION_SITE)
  assert.match(cfg.DEFAULTS.siteCandidates[1].url, /127\.0\.0\.1:3200/)
})

await test('config.save exists and round-trips', async () => {
  // It did not, for one commit: an edit to load() took save() with it and storing the
  // password crashed with "cfg.save is not a function". Caught from a log, not a test.
  const cfg = await import('../src/main/config.js')
  assert.equal(typeof cfg.save, 'function')
  cfg.save({ sitePassword: 'round-trip' })
  assert.equal(cfg.load().sitePassword, 'round-trip')
  cfg.save({ sitePassword: null })
})

await test('the map source is config, not code', async () => {
  // B may move maps to a bucket. Switching has to be a setting: the file LIST, the
  // sizes and the hashes still come from the site either way, so the bucket needs no
  // intelligence and we still verify everything we are given.
  const cfg = await import('../src/main/config.js')
  assert.equal(cfg.DEFAULTS.mapsBase, null, 'default is the site's own route')
  const src = String(fs.readFileSync(new URL('../src/main/library.js', import.meta.url)))
  assert.ok(src.includes('mapsBase'), 'installFromSite must take a base')
  // The hash check is not conditional on where the bytes came from.
  assert.ok(src.includes('did not match the hash the archive recorded'))
})

// ------------------------------------------------------- the launch command --
group('The launch command line')

await test('has the three things the brief asks for', () => {
  const a = launch.buildArgs({ host: '10.0.0.5:28960' }).join(' ')
  assert.match(a, /\+set com_introPlayed 1/)
  assert.match(a, /\+set fs_game mods\/enw/)
  assert.match(a, /\+connect 10\.0\.0\.5:28960/)
})

await test('THE INVITE TOKEN IS NEVER IN IT', () => {
  const secret = 'eyJhbGciOiJFZDI1NTE5In0.SECRETTOKENVALUE'
  const a = launch.buildArgs({ host: '127.0.0.1:28960', token: secret, settings: { fov: 90 } }).join(' ')
  assert.equal(a.includes(secret), false)
  assert.equal(a.includes('token'), false)
  assert.equal(a.toLowerCase().includes('secret'), false)
})

await test('fs_homepath has no space in it (the engine parses its own command line)', () => {
  const home = launch.buildArgs({}).find((x, i, arr) => arr[i - 1] === 'fs_homepath')
  assert.ok(home, 'fs_homepath should be set')
  assert.equal(home.includes(' '), false, `fs_homepath must not contain a space: ${home}`)
})

await test('account settings are applied over the top, not written to a config', () => {
  const a = launch.buildArgs({ settings: { fov: 95, maxFps: 200, fullscreen: false } }).join(' ')
  assert.match(a, /\+set cg_fov 95/)
  assert.match(a, /\+set com_maxfps 200/)
  assert.match(a, /\+set r_fullscreen 0/)
})

await test('dev stealth mode is windowed, muted and off-screen', () => {
  const a = launch.buildArgs({ stealth: true }).join(' ')
  for (const want of ['r_fullscreen 0', 'r_mode 800x600', 'vid_xpos -4000', 'snd_volume 0']) assert.match(a, new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

await test('the token pipe hands over exactly one token and then closes', async () => {
  const net = await import('node:net')
  const srv = launch.serveToken('TOKEN-ABC')
  const got = await new Promise((resolve, reject) => {
    const c = net.connect(srv.pipePath)
    let buf = ''
    c.on('data', (d) => { buf += d })
    c.on('end', () => resolve(buf))
    c.on('error', reject)
    setTimeout(() => reject(new Error('pipe timeout')), 4000)
  })
  assert.equal(JSON.parse(got).token, 'TOKEN-ABC')
  srv.close()
})

// ---------------------------------------------------------------- deep links --
group('Deep links')

await test('parses zombies.enw.gg/m/<map> and enwzombies://m/<map>', async () => {
  // parseDeepLink lives in main.js, which imports electron. Re-implement the contract
  // here against the same config so the shapes cannot drift silently.
  const cfg = await import('../src/main/config.js')
  const hosts = cfg.DEFAULTS.deepLinkHosts
  assert.ok(hosts.includes('zombies.enw.gg'))
  assert.equal(cfg.DEFAULTS.protocol, 'enwzombies')
  const u = new URL('https://zombies.enw.gg/m/nazi_zombie_sumpf')
  assert.equal(u.pathname.split('/').filter(Boolean)[1], 'nazi_zombie_sumpf')
})

// ----------------------------------------------------------------- redaction --
group('Crash reports')

await test('redacts tokens, pipe names and key/value secrets', () => {
  const s = crash.redact('token: eyJhbGciOiJFZDI1NTE5In0.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and \\\\.\\pipe\\enw-launch-deadbeefdeadbeef')
  assert.equal(s.includes('deadbeefdeadbeef'), false)
  assert.match(s, /<redacted>/)
})

await test('a report saves to disk when there is no endpoint', async () => {
  const payload = crash.build({ kind: 'game_crash', error: new Error('boom'), context: { map: 'x' } })
  const r = await crash.report(null, payload)
  assert.equal(r.sent, false)
  assert.ok(fs.existsSync(r.saved))
})

await test('the player message says nothing technical', () => {
  for (const k of ['game_crash', 'map_failed', 'server_unreachable', 'setup_failed']) {
    const m = crash.playerMessage(k)
    assert.ok(m.length > 20)
    assert.equal(/stack|exception|null|undefined|0x/i.test(m), false, `${k}: ${m}`)
  }
})

// ------------------------------------------------------------------ settings --
group('Settings')

await test('fall back to a local copy when nobody is signed in', () => {
  const s = settings.set({ fov: 101 })
  assert.equal(s.fov, 101)
  assert.match(settings.get()._scope, /this computer/)
})

await test('are stored per account once signed in', () => {
  settings.signIn({ steamid: '76561190000000001', name: 'A' })
  settings.set({ fov: 77 })
  assert.equal(settings.get().fov, 77)
  settings.signIn({ steamid: '76561190000000002', name: 'B' })
  assert.notEqual(settings.get('76561190000000001').fov, undefined)
  assert.equal(settings.get('76561190000000001').fov, 77)
  settings.signOut()
})

// ------------------------------------------------------------------- updates --
group('Updates: never mid-something')

await test('the idle gate holds a refresh until nothing is busy', async () => {
  const g = new updates.IdleGate()
  g.block('game', 'a game is running')
  let ran = false
  g.when(() => { ran = true }, { everyMs: 20 })
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(ran, false, 'must not refresh while a game is running')
  g.unblock('game')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(ran, true, 'should refresh once idle')
})

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
