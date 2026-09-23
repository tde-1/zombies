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
import { EventEmitter } from 'node:events'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'enw-launcher-test-'))
process.env.ENW_ROOT = path.join(TMP, 'enwroot')
process.env.ENW_DEV_ROOT = path.join(TMP, 'nodevbox') // keep the real game lock out of it
process.env.ENW_NO_DISPLAY_PROBE = '1'                 // no PowerShell, no per-machine answers

const vdf = await import('../src/main/vdf.js')
const pe = await import('../src/main/pe.js')
const detect = await import('../src/main/detect.js')
const paths = await import('../src/main/paths.js')
const setup = await import('../src/main/setup.js')
const launch = await import('../src/main/launch.js')
const crash = await import('../src/main/crash.js')
const settings = await import('../src/main/settings.js')
const updates = await import('../src/main/updates.js')
const hostagent = await import('../src/main/hostagent.js')
const gamecfg = await import('../src/main/gamecfg.js')
const display = await import('../src/main/display.js')
const partyprogress = await import('../src/main/partyprogress.js')
const { BootFlow } = await import('../src/main/bootflow.js')

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

await test('maps install under OUR LocalAppData, and never into the player own folder', async () => {
  // dedi measured this: <fs_homepath>\mods and <game copy>\mods both fail SILENTLY —
  // the .iwds mount and the search path looks right, but `mod.ff` is a zone, not a
  // filesystem asset, so it never loads and +map never runs. Only
  // <LocalAppData>\Activision\CoDWaW\mods works.
  //
  // WHAT CHANGED ON 2026-09-23: <LocalAppData> no longer means the PLAYER'S
  // LocalAppData. `client-dll/components/enw_localappdata.cpp` patches the engine's
  // SHGetFolderPathA import, so the game resolves it to `<ENW>\home\localappdata`
  // and the measurement above still holds with our folder in the slot. B: "our client
  // must never touch the user's own World at War data." This test is the line.
  const paths2 = await import('../src/main/paths.js')
  const lib = await import('../src/main/library.js')
  const want = path.join(paths2.P.localAppData, 'Activision', 'CoDWaW', 'mods')
  assert.equal(paths2.P.maps.toLowerCase(), want.toLowerCase())
  assert.equal(lib.installDir('some_map'), path.join(want, 'some_map'))
  assert.ok(paths2.isInside(paths2.P.maps, paths2.ENW_ROOT), 'the map library must be inside the ENW folder now')
  assert.ok(paths2.assertWritable(path.join(want, 'some_map', 'mod.ff')))

  // The player's own game data: refused BY NAME, not merely by being elsewhere — and
  // the carve-out that used to let us write to their mods folder is gone.
  const theirs = path.join(process.env.LOCALAPPDATA, 'Activision', 'CoDWaW')
  assert.equal(paths2.P.userGameData.toLowerCase(), theirs.toLowerCase())
  for (const rel of [['mods'], ['mods', 'some_map', 'mod.ff'], ['players', 'x'], ['__CoDWaW']]) {
    assert.throws(() => paths2.assertWritable(path.join(theirs, ...rel)), /Refusing to write/, rel.join('/') + ' must be refused')
  }
  // And the launcher must HAND the redirect to the game, or the folder above is a
  // place the engine never looks and every map install is silently useless.
  const ls = String(fs.readFileSync(new URL('../src/main/launch.js', import.meta.url)))
  assert.match(ls, /ENW_LOCALAPPDATA: P\.localAppData/, 'every launch must pass ENW_LOCALAPPDATA')
})

// The four Treyarch maps are inside World at War. `isInstalled` means "WE installed
// it", which is false for them for ever — which is why the boot flow asked the site
// for Nacht der Untoten's files and stopped B's launch when it had none.
await test('the stock four are ready without an install, and are not "installed by us"', async () => {
  const lib = await import('../src/main/library.js')
  for (const bsp of ['nazi_zombie_prototype', 'nazi_zombie_asylum', 'nazi_zombie_sumpf', 'nazi_zombie_factory']) {
    assert.equal(lib.isStock(bsp), true, bsp)
    assert.equal(lib.mapReady(bsp), true, bsp)
  }
  assert.equal(lib.isStock('nazi_zombie_fear_mc_2'), false)
  assert.equal(lib.isStock(''), false)
  assert.equal(lib.isStock(undefined), false)
  // A custom map nobody has installed is NOT ready, or the download would be skipped
  // for a map that really is missing.
  assert.equal(lib.mapReady('definitely_not_a_real_map_' + Date.now()), false)
})

// The Play card is the verified journey. It defaulted to 'custom', so a stock map read
// "CUSTOM / Untracked." and the lease the site opened said mode=custom.
// The mode has ONE owner now: the site's party (`parties.js :: create` defaults to
// verified). The launcher shell defaulted it too, and the shell's copy was the one that
// reached POST /api/launcher/play - which is how B's lease came out `mode: custom` under
// a card the site thought was Verified. The rail is gone and so is that second owner.
await test('the shell owns no mode of its own, and still spells the one it is told', async () => {
  const src = String(fs.readFileSync(new URL('../src/renderer/shell.js', import.meta.url)))
  assert.ok(!/mode: 'custom',/.test(src), 'nothing may default the mode to Custom')
  assert.ok(!/mode: 'verified',/.test(src), 'the shell must not hold a mode at all now')
  assert.ok(/const modeLabel = /.test(src), 'one spelling of the mode, for the boot screen')
})

// The rail is gone, and it has to STAY gone: a map list in the shell is a second copy of
// the site's, with its own idea of what is installed.
await test('the launcher shell draws no rail, no map list and no Play button', async () => {
  const html = String(fs.readFileSync(new URL('../src/renderer/shell.html', import.meta.url)))
  const css = String(fs.readFileSync(new URL('../src/renderer/shell.css', import.meta.url)))
  const js = String(fs.readFileSync(new URL('../src/renderer/shell.js', import.meta.url)))
  for (const id of ['id="rail"', 'id="mapList"', 'id="playBtn"', 'id="playLocalBtn"', 'id="modeBtn"', 'id="cornerCard"']) {
    assert.ok(!html.includes(id), `${id} is still in the shell`)
  }
  assert.ok(!/#rail\s*\{|\.maplist/.test(css), 'rail CSS survived')
  assert.ok(!/window\.enw\.maps\(/.test(js), 'the shell is still fetching its own map catalogue')
  // What it keeps: the boot screen, and the status block that moved into Settings.
  assert.ok(html.includes('id="bootSteps"') && html.includes('id="statusBody"'))
})

// B, 2026-09-22: the launcher's own top bar and its green theme are gone. The window is
// frameless, the site's nav is the title bar, and the window buttons are drawn by the site
// through a four-call IPC surface. None of the old bar may come back.
await test('the launcher draws no bar of its own over the site, and the window is frameless', async () => {
  const html = String(fs.readFileSync(new URL('../src/renderer/shell.html', import.meta.url)))
  const css = String(fs.readFileSync(new URL('../src/renderer/shell.css', import.meta.url)))
  const js = String(fs.readFileSync(new URL('../src/renderer/shell.js', import.meta.url)))
  const main = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  const pre = String(fs.readFileSync(new URL('../src/preload/preload.cjs', import.meta.url)))
  const ph = String(fs.readFileSync(new URL('../src/renderer/placeholder.html', import.meta.url)))
  for (const id of ['id="topbar"', 'id="navBack"', 'id="navFwd"', 'id="navReload"', 'id="sitePill"', 'id="setupPill"', 'id="accountPill"', 'id="settingsPill"']) {
    assert.ok(!html.includes(id), `${id} is still in the shell`)
  }
  assert.ok(!/sitePill|accountPill|navBack/.test(js), 'shell.js still wires the old bar')
  assert.ok(!/#11120e|#7b7e58|#e4dfd1/i.test(css + ph), 'the green/olive/bone palette survived')
  assert.ok(/frame: false/.test(main), 'the main window must be frameless')
  assert.ok(/const TOPBAR_HEIGHT = 0$/m.test(main), 'the site view must start at the top of the window')
  for (const ch of ['winMinimize', 'winMaximize', 'winClose', 'winIsMaximized', 'openScreen']) {
    assert.ok(main.includes(`handle('${ch}'`), `main.js has no ${ch} handler`)
    assert.ok(pre.includes(`'${ch}'`), `the preload does not expose ${ch}`)
  }
  // The screens' strip and the fallback page both carry the three buttons.
  for (const src of [html, ph]) for (const id of ['wcMin', 'wcMax', 'wcClose']) assert.ok(src.includes(`id="${id}"`))
  assert.ok(/-webkit-app-region:\s*drag/.test(css) && /-webkit-app-region:\s*drag/.test(ph), 'no drag region')
  // Reload moved to the keyboard, and it reloads the site, not the shell.
  assert.ok(/before-input-event/.test(main) && /'f5'/.test(main), 'Ctrl+R / F5 are not wired')
})

// The site's home folds to one column at 1080px, so the window has to be wide enough for
// the site view - which is now the whole window - to stay above it.
await test('the window is wide enough for the site home to be two columns', async () => {
  const src = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  const num = (name) => Number((new RegExp('const ' + name + ' = ([0-9]+)').exec(src) || [])[1])
  assert.ok(num('MIN_WIDTH') > 1080, `MIN_WIDTH ${num('MIN_WIDTH')} is not above the site's 1080px fold`)
  assert.ok(num('DEFAULT_WIDTH') >= num('MIN_WIDTH'))
  // The constant is named once more, in the paragraph that explains why it is gone.
  assert.ok(!/w - RAIL_WIDTH/.test(src), 'the site view is still having a rail subtracted from it')
})

await test("a map the player installed themselves is never touched", async () => {
  const lib = await import('../src/main/library.js')
  // B's own nazi_zombie_ali lives in that folder. Ours carry a record file; theirs
  // do not, and that is the whole test.
  const o = lib.ownership('definitely_not_a_real_map_' + Date.now())
  assert.equal(o.state, 'absent')
  const src = String(fs.readFileSync(new URL('../src/main/library.js', import.meta.url)))
  assert.ok(src.includes("state: 'theirs'"), 'ownership must be able to say a map belongs to the player')
  // The "already in your own World at War mods folder" refusal is GONE (2026-09-23):
  // there is no longer a shared folder to collide in, and that message was the one B
  // hit when 8 of 10 Install buttons refused. What must survive is the uninstall
  // guard, which is about ENW's own records rather than about the player's folder.
  assert.ok(!/throw new Error\([^)]*already in your own World at War mods folder/.test(src),
    'install must no longer refuse a map because of the player own mods folder — it is not shared any more')
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
  assert.equal(cfg.DEFAULTS.mapsBase, null, 'default is the site own route')
  const src = String(fs.readFileSync(new URL('../src/main/library.js', import.meta.url)))
  assert.ok(src.includes('mapsBase'), 'installFromSite must take a base')
  // The hash check is not conditional on where the bytes came from.
  assert.ok(src.includes('did not match the hash the archive recorded'))
})

// ----------------------------------------------------------------- the updater --
group('Updates: never break a friend launcher')

await test('the feed resolves ZM_UPDATE_FEED > config > the site', async () => {
  const { resolveFeed } = await import('../src/main/autoupdate.js')
  assert.equal(resolveFeed({ env: { ZM_UPDATE_FEED: 'https://bucket/u/' }, config: { updateFeed: 'https://x' }, siteUrl: 'https://s' }), 'https://bucket/u')
  assert.equal(resolveFeed({ env: {}, config: { updateFeed: 'https://x/' }, siteUrl: 'https://s' }), 'https://x')
  assert.equal(resolveFeed({ env: {}, config: {}, siteUrl: 'https://s/' }), 'https://s/updates')
  // No site and no feed is a supported state, not an error.
  assert.equal(resolveFeed({ env: {}, config: {}, siteUrl: null }), null)
  // A placeholder page is not an update feed.
  assert.equal(resolveFeed({ env: {}, config: {}, siteUrl: 'file:///x.html' }), null)
})

await test('no feed is fine and says so', async () => {
  const { AutoUpdater } = await import('../src/main/autoupdate.js')
  const u = new AutoUpdater({ feedUrl: null, currentVersion: '0.1.0', gate: new updates.IdleGate() })
  await u.start()
  assert.equal(u.status().enabled, false)
  assert.equal(u.status().current, '0.1.0')
  assert.match(u.status().error, /no update feed/)
})

await test('a broken feed does not throw at the caller', async () => {
  const { AutoUpdater } = await import('../src/main/autoupdate.js')
  const u = new AutoUpdater({ feedUrl: 'http://127.0.0.1:1/nothing-here', currentVersion: '0.1.0', gate: new updates.IdleGate() })
  // The whole point: this resolves. It does not reject, and it does not throw.
  await u.start()
  assert.ok(u.status().checked || u.status().error, 'it either checked or recorded why it could not')
})

await test('an update is never applied while a game is running', async () => {
  const { AutoUpdater } = await import('../src/main/autoupdate.js')
  const gate = new updates.IdleGate()
  const u = new AutoUpdater({ feedUrl: 'https://example.invalid', currentVersion: '0.1.0', gate })
  u.updater = { quitAndInstall: () => { throw new Error('should not be reached') } }
  u.state.downloaded = '0.2.0'
  gate.block('game', 'a game is running')
  assert.equal(u.applyIfSafe(), false, 'must refuse while a game is running')
  gate.unblock('game')
  // With nothing busy it tries — and even a throwing quitAndInstall must not escape.
  assert.equal(u.applyIfSafe(), false)
})

await test('nothing downloaded means nothing to apply', async () => {
  const { AutoUpdater } = await import('../src/main/autoupdate.js')
  const u = new AutoUpdater({ feedUrl: 'https://example.invalid', currentVersion: '0.1.0', gate: new updates.IdleGate() })
  assert.equal(u.applyIfSafe(), false)
})

await test('a build with no client DLL is refused, loudly', async () => {
  // The first packaged build shipped with no enw_t4.dll. Setup then "succeeded" with a
  // soft warning and the launcher said "not installed yet" forever with no reason.
  // Now it throws, naming every path it looked in.
  // Behaviour, not a grep for a sentence: the message a player gets must name every
  // path we looked at, because "ENW client is not installed" with no reason is
  // exactly the report we got from B and could do nothing with.
  const tried = [
    { path: 'C:\\somewhere\\resources\\client\\enw_t4.dll', via: 'shipped with the launcher', exists: false },
    { path: 'C:\\somewhere\\resources\\app.asar\\resources\\client\\enw_t4.dll', via: 'staged', exists: false, skipped: 'inside app.asar' },
  ]
  const msg = setup.explainMissingClient(tried)
  assert.match(msg, /enw_t4\.dll/, 'the error must name the file')
  assert.match(msg, /packaging fault/, 'and say the build is at fault, not the player')
  for (const t of tried) assert.ok(msg.includes(t.path), `must list ${t.path}`)

  // The build itself refuses rather than producing an installer that cannot work.
  const stage = String(fs.readFileSync(new URL('../tools/stage-client.js', import.meta.url)))
  assert.ok(stage.includes('process.exit(1)'))
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(pkg.scripts.pack, /stage-client/, 'pack must stage the client first')
  assert.ok((pkg.build.extraResources || []).some((r) => String(r.to) === 'client'), 'the DLL must ship as a real file')
})

await test('the client DLL is never taken from inside app.asar', () => {
  // MEASURED on the packaged build of 2026-09-20: `resources/**` was packed into the
  // archive AND shipped beside it, and the mtime sort picked the copy INSIDE
  // app.asar. It happens to copy, because Electron patches fs for this process only.
  // It is the kind of thing that works until it does not.
  const r = setup.findClientDll({ explicit: 'C:\\x\\resources\\app.asar\\resources\\client\\enw_t4.dll' })
  assert.equal(r.tried[0].skipped, 'inside app.asar', 'an asar path must be refused by name')
  assert.ok(!r.dll || !/app\.asar/.test(r.dll.path), `chose ${r.dll?.path}`)
  for (const t of r.tried) if (/app\.asar/.test(t.path)) assert.equal(t.exists, false, `${t.path} must never count as found`)
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.build.files.includes('!resources/client/**'), 'and it must not be packed into the archive at all')
})

await test('an updated launcher repairs the client DLL it did not install', () => {
  // MEASURED on B's machine, 2026-09-22. He updated to 0.2.0 and got an 0.1.x
  // client: `resources/client/enw_t4.dll` is replaced by the update, nothing ever
  // copies it into `<ENW>\game\binkw32.dll`, and `status().installed` is three
  // existsSync calls so the UI said "installed" and no one re-ran setup. His DLL
  // log read `components registered: 28` with no `borderless:` line at all, for
  // a build whose client registers 39. Both of 0.2.0's features live in that DLL.
  const game = paths.P.game
  fs.mkdirSync(game, { recursive: true })
  const proxy = path.join(game, 'binkw32.dll')
  const original = path.join(game, 'binkw32_org.dll')
  const shipped = setup.shippedClientDll()
  assert.ok(shipped && shipped.sha256, 'this checkout must have a client DLL to ship')

  // The stock Bink library, and an old ENW client in its place.
  fs.writeFileSync(original, 'stock bink, must never be touched')
  fs.writeFileSync(proxy, 'an old ENW client from a previous launcher version')
  const stockBefore = fs.readFileSync(original)

  assert.equal(setup.status().clientDll.stale, true, 'status must SAY it is stale, not just "installed"')

  const r = setup.ensureClientDll()
  assert.equal(r.ok, true)
  assert.equal(r.changed, true, 'it must actually copy')
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(proxy)).digest('hex'), shipped.sha256,
    'the installed client must now BE the shipped one — read back, not assumed')
  assert.deepEqual(fs.readFileSync(original), stockBefore, 'the stock Bink library must not be touched')
  assert.equal(setup.status().clientDll.stale, false)

  // Idempotent: pressing Play twice must not copy twice.
  const again = setup.ensureClientDll()
  assert.equal(again.changed, false, 'a matching client is left alone')
  assert.ok(!fs.existsSync(`${proxy}.new`), 'no temp file may be left behind')

  // And it is never a way to install from nothing: no setup, no repair.
  fs.rmSync(proxy); fs.rmSync(original)
  const none = setup.ensureClientDll()
  assert.equal(none.changed, false)
  assert.match(none.reason, /not installed/, 'it must not quietly half-install a game folder')
  assert.ok(!fs.existsSync(proxy), 'and it must not create a proxy with no binkw32_org beside it')
})

await test('the 4 GB (large address aware) flag is set on OUR exe, read back, and reversible', () => {
  // dedi.md 14.7: ORBiT and UGX Requiem pass every server-side gate and then stall
  // the CLIENT in CL_InitCGame at about 1.5 GB RSS. That is the 32-bit 2 GB user
  // address space, and the fix the whole custom-map community uses is two bytes in
  // IMAGE_FILE_HEADER.Characteristics. B approved it for OUR copy only, 2026-09-23.
  const game = paths.P.game
  fs.mkdirSync(game, { recursive: true })
  const exe = path.join(game, 'CoDWaW.exe')

  // A minimal 32-bit PE, laid out where the real one has its fields. Characteristics
  // 0x0103 is exactly what B's own CoDWaW.exe reads (RELOCS_STRIPPED |
  // EXECUTABLE_IMAGE | 32BIT_MACHINE), so the arithmetic below is the real one.
  const buf = Buffer.alloc(0x600)
  buf.write('MZ', 0, 'latin1')
  buf.writeUInt32LE(0x100, 0x3c)
  buf.writeUInt32LE(0x00004550, 0x100)
  buf.writeUInt16LE(0x14c, 0x104)        // machine = i386
  buf.writeUInt16LE(0x0103, 0x100 + 22)  // Characteristics
  buf.writeUInt16LE(0x10b, 0x100 + 24)   // PE32 optional header magic
  fs.writeFileSync(exe, buf)

  assert.equal(pe.characteristics(exe).laa, false, 'the fixture must start without the flag')
  assert.equal(setup.status().largeAddressAware.laa, false, 'status must report it')

  const r = setup.ensureLargeAddressAware({ enabled: true })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.changed, true)
  assert.equal(r.laa, true)
  // READ BACK OFF DISK, not from the return value: a header patch that did not land
  // is the one failure mode that matters here.
  const onDisk = fs.readFileSync(exe).readUInt16LE(0x100 + 22)
  assert.equal(onDisk, 0x0123, `Characteristics on disk is 0x${onDisk.toString(16)}, expected 0x0123`)
  assert.equal(pe.characteristics(exe).laa, true)
  assert.equal(setup.status().largeAddressAware.laa, true)

  // Nothing else in the file may move. A 4 GB patch that rewrites a byte of .text is
  // a corrupt game executable that only fails at launch.
  const after = fs.readFileSync(exe)
  buf.writeUInt16LE(0x0123, 0x100 + 22)
  assert.deepEqual(after, buf, 'exactly two bytes, and only those two')

  // Idempotent: pressing Play twice must not write twice.
  assert.equal(setup.ensureLargeAddressAware({ enabled: true }).changed, false)

  // The record of the original, and the restore that uses it.
  const rec = JSON.parse(fs.readFileSync(paths.P.exePatch, 'utf8'))
  assert.equal(rec.original.characteristics, 0x0103, 'the ORIGINAL bytes must be written down before the first patch')
  assert.equal(rec.original.laa, false)
  assert.equal(rec.applied.laa, true)

  const back = setup.restoreGameExe()
  assert.equal(back.ok, true, back.reason)
  assert.equal(back.changed, true)
  assert.equal(fs.readFileSync(exe).readUInt16LE(0x100 + 22), 0x0103, 'repair must put the recorded bytes back')
  assert.equal(setup.status().largeAddressAware.laa, false)
  // And a second restore records the original ONCE -- it is never overwritten with a
  // patched value, which would make "repair" repair to the patch.
  setup.ensureLargeAddressAware({ enabled: true })
  assert.equal(JSON.parse(fs.readFileSync(paths.P.exePatch, 'utf8')).original.characteristics, 0x0103)

  fs.rmSync(exe)
  assert.equal(setup.ensureLargeAddressAware({ enabled: true }).ok, false, 'no install, nothing to patch')
})

await test('the LAA patch can never reach the player own install', () => {
  // dev-box.md rule 1. The guard is assertWritable(), the same one every other write
  // in this app goes through -- but this is the write that edits a game EXECUTABLE,
  // so it is asserted by name rather than by inheritance.
  assert.equal(setup.writable('C:\Program Files (x86)\Steam\steamapps\common\Call of Duty World at War\CoDWaW.exe'), false)
  // And the tool itself refuses anything that is not a 32-bit PE, so a 64-bit or
  // non-PE file cannot be "patched" into nonsense.
  const junk = path.join(paths.P.state, 'not-a-pe.bin')
  fs.mkdirSync(paths.P.state, { recursive: true })
  fs.writeFileSync(junk, Buffer.alloc(0x800))
  assert.equal(pe.characteristics(junk), null)
  assert.equal(pe.setLargeAddressAware(junk, true).ok, false)
})

await test('the referee ships with the launcher and is reachable when packaged', () => {
  // A player has no repo and no Node. If host.js is not an extraResource there is no
  // referee on their machine, and a local game records nothing — silently.
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const ex = pkg.build.extraResources || []
  assert.ok(ex.some((r) => String(r.to) === 'host-agent'), 'the host agent must ship beside the app')
  const found = hostagent.findHostAgent()
  assert.ok(found.file, `host.js must be findable; looked in ${found.tried.map((t) => t.path).join(', ')}`)
  assert.ok(fs.existsSync(found.file))
})

await test('files another program has to open are unpacked from the asar', () => {
  // powershell.exe cannot read inside app.asar. Without asarUnpack the window nanny
  // silently never runs in a packaged build, and the "Set Optimal Settings?" modal
  // that blocked every unattended run comes back.
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok((pkg.build.asarUnpack || []).includes('tools/**'), 'tools/ must be unpacked')
  assert.equal(
    paths.unpacked('C:\\x\\resources\\app.asar\\tools\\window-nanny.ps1'),
    'C:\\x\\resources\\app.asar.unpacked\\tools\\window-nanny.ps1'
  )
})

await test('a path with a space in it survives being turned back from a file: URL', () => {
  // `new URL(import.meta.url).pathname` does not decode, so a player called
  // "John Smith" got %20 in every path derived from it. Four files did this.
  const p = paths.dirOfModule('file:///C:/Users/John%20Smith/AppData/Local/Programs/ENW%20Zombies/resources/app.asar/src/main/x.js')
  assert.ok(!p.includes('%20'), `decoded, got ${p}`)
  assert.ok(p.includes('John Smith'))
  const src = String(fs.readFileSync(new URL('../src/main/launch.js', import.meta.url)))
  assert.ok(!/new URL\(import\.meta\.url\)\.pathname/.test(src), 'launch.js must not hand-roll it')
})

// ------------------------------------------------------- the launch command --
group('The launch command line')

await test('has the three things the brief asks for', () => {
  const a = launch.buildArgs({ host: '10.0.0.5:28960' }).join(' ')
  assert.match(a, /\+set com_introPlayed 1/)
  assert.match(a, /\+set fs_game mods\/enw/)
  // NOT `+connect`: this exe answers that with `Unknown command "connect"` and then sits
  // in the menu. Joining is armed in the environment instead.
  assert.equal(a.includes('+connect'), false)
  const e = launch.connectEnv({ host: '10.0.0.5:28960', map: 'nazi_zombie_prototype' })
  assert.equal(e.ENW_CLIENT_CONNECT, 'nazi_zombie_prototype')
  assert.equal(e.ENW_CONNECT_ADDR, '10.0.0.5:28960')
  assert.equal(e.ENW_RAW_SOCKETS, '1')
  // A local game keeps stock behaviour, and a join with no map name is a bug, not a guess.
  assert.deepEqual(launch.connectEnv({ host: null, map: 'x' }), {})
  assert.throws(() => launch.connectEnv({ host: '10.0.0.5:28960' }), /map name/)
  // …and the map goes on the command line ONLY when there is no server to join.
  assert.equal(launch.buildArgs({ host: '10.0.0.5:28960', map: 'nazi_zombie_prototype' }).includes('+map'), false)
  assert.equal(launch.buildArgs({ map: 'nazi_zombie_prototype' }).includes('+map'), true)
})

await test('a token puts `+exec enw_auth.cfg` on the line, and nothing else does', () => {
  // The DLL writes that file from the pipe's token; without the `+exec` nothing reads it
  // and the token never reaches userinfo, which is `identity: none` on the box.
  const withTok = launch.buildArgs({ host: '10.0.0.5:28960', token: 'a.b' }).join(' ')
  assert.match(withTok, /\+exec enw_auth\.cfg/)
  const without = launch.buildArgs({ host: '10.0.0.5:28960' }).join(' ')
  assert.equal(without.includes('enw_auth.cfg'), false)
})

await test('THE INVITE TOKEN IS NEVER IN IT', () => {
  const secret = 'eyJhbGciOiJFZDI1NTE5In0.SECRETTOKENVALUE'
  const a = launch.buildArgs({ host: '127.0.0.1:28960', token: secret, settings: { fov: 90 } }).join(' ')
  assert.equal(a.includes(secret), false)
  assert.equal(a.includes('token'), false)
  assert.equal(a.toLowerCase().includes('secret'), false)
})

await test('every launch carries `+set name <ENW name>`, local games included', () => {
  // B, 2026-09-23: "right now it says Unknown Soldier, which is annoying". That string is
  // the ENGINE's default for the `name` dvar and the reason it appeared is simply that
  // nothing ever passed `+name`. Local too: a local game never reaches a server, so the
  // referee's lock cannot apply and this line is all there is.
  const a = launch.buildArgs({ map: 'nazi_zombie_prototype', playerName: 'enw-tester' })
  const i = a.indexOf('name')
  assert.ok(i > 0 && a[i - 1] === '+set', '`+set name` is not on the line')
  assert.equal(a[i + 1], 'enw-tester')
  const joined = launch.buildArgs({ host: '10.0.0.5:28960', playerName: 'enw-tester' }).join(' ')
  assert.match(joined, /\+set name enw-tester/)
})

await test('a name cannot break out of the infostring or smuggle a second command', () => {
  // The engine's userinfo is backslash-delimited and `set` is console input, so a
  // backslash, a quote or a semicolon in a name would split the key/value pairs or run
  // something else. Stripped here and stripped again server-side by Info_SetValueForKey.
  const a = launch.buildArgs({ map: 'x', playerName: 'ev\il";quit' })
  const i = a.indexOf('name')
  assert.equal(a[i + 1], 'evilquit')
})

await test('no name on the session means no `+set name`, not an invented one', () => {
  // An account that has not picked yet gets the engine's own default rather than a
  // SteamID or a placeholder pretending to be a name.
  const a = launch.buildArgs({ map: 'x', playerName: null })
  const i = a.indexOf('name')
  assert.equal(i === -1 || a[i - 1] !== '+set', true, 'a nameless session still set a name')
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

await test('the same pipe carries the in-game chat pass, with or without an invite token', async () => {
  const net = await import('node:net')
  const read = (p) => new Promise((resolve, reject) => {
    const c = net.connect(p)
    let buf = ''
    c.on('data', (d) => { buf += d })
    c.on('end', () => resolve(JSON.parse(buf)))
    c.on('error', reject)
    setTimeout(() => reject(new Error('pipe timeout')), 4000)
  })
  const chat = { base: 'https://zombies.enw.gg', bearer: 'gc1.abc.def' }
  const both = launch.serveToken('TOKEN-ABC', { chat })
  const a = await read(both.pipePath)
  assert.equal(a.v, 0)
  assert.equal(a.token, 'TOKEN-ABC')
  assert.deepEqual(a.chat, chat)
  both.close()
  // Play Local: no invite, chat only. The DLL (auth_token.cpp) must not see a token.
  const only = launch.serveToken(null, { chat })
  const b = await read(only.pipePath)
  assert.equal('token' in b, false)
  assert.deepEqual(b.chat, chat)
  only.close()
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

// The `enw-zombies://` scheme. These are a CONTRACT WITH THE WEB LANE, not an internal
// shape — the site is building the sending side against these exact strings and they are
// written down in docs/protocol/launcher-v0.md §7. If one of these fails, a link
// somebody put in a YouTube description stopped working.
const deeplink = await import('../src/main/deeplink.js')

await test('enw-zombies://map/<key> and enw-zombies://party/<id> route, and nothing else does', () => {
  assert.equal(deeplink.SCHEME, 'enw-zombies')
  assert.deepEqual(
    { ...deeplink.parse('enw-zombies://map/nazi_zombie_prototype'), url: undefined },
    { kind: 'map', map: 'nazi_zombie_prototype', url: undefined })
  assert.deepEqual(
    { ...deeplink.parse('enw-zombies://party/1234'), url: undefined },
    { kind: 'party', party: '1234', url: undefined })
  // The host of a non-special scheme is NOT lower-cased by the URL parser (measured),
  // so the route has to be, and the argument must not be.
  assert.equal(deeplink.parse('enw-zombies://MAP/Foo%20Bar').map, 'Foo Bar')
  // Trailing slashes, the opaque no-slashes form some chat clients produce, and the
  // legacy https:// deep links.
  assert.equal(deeplink.parse('enw-zombies://map/water/').map, 'water')
  assert.equal(deeplink.parse('enw-zombies:map/water').map, 'water')
  assert.equal(deeplink.parse('https://zombies.enw.gg/m/water'), null, 'a web link is not ours to parse here')
  assert.equal(deeplink.parse('enwzombies://m/water'), null, 'the legacy scheme stays with main.js')
})

await test('a malformed enw-zombies:// link goes home, says why, and never throws', () => {
  for (const [raw, why] of [
    ['enw-zombies://', /no route/],
    ['enw-zombies://map/', /no map key/],
    ['enw-zombies://party/', /no party id/],
    ['enw-zombies://wat/x', /unknown route "wat"/],
    ['enw-zombies://map/%E0%A4%A', /.?/],       // an undecodable escape
  ]) {
    const r = deeplink.parse(raw)
    assert.ok(r, `${raw} must still answer`)
    if (why.source !== '.?') {
      assert.equal(r.kind, 'home', raw)
      assert.match(r.why, why, raw)
    }
    assert.equal(r.url, raw)
  }
  // Nothing that is not ours is claimed, and no input type throws.
  for (const junk of [null, undefined, '', 42, {}, 'not a url at all', 'https://evil.example/map/x']) {
    assert.equal(deeplink.parse(junk), null, String(junk))
  }
})

await test('the deep-link URL is found anywhere in argv, not only at the end', () => {
  assert.equal(deeplink.fromArgv(['C:\\x\\ENW Zombies.exe', 'enw-zombies://map/water']), 'enw-zombies://map/water')
  // MEASURED elsewhere and the reason this searches rather than indexes: the NSIS stub
  // and `start` both append their own switches on some machines.
  assert.equal(deeplink.fromArgv(['exe', 'enw-zombies://party/9', '--allow-file-access-from-files']), 'enw-zombies://party/9')
  assert.equal(deeplink.fromArgv(['exe', '  enw-zombies://map/x  ']), 'enw-zombies://map/x', 'trimmed')
  assert.equal(deeplink.fromArgv(['exe', '--no-sandbox']), null)
  assert.equal(deeplink.fromArgv([]), null)
  assert.equal(deeplink.fromArgv(), null)
})

await test('a second launcher forwards its URL to the running one and focuses it, instead of opening a second app', () => {
  const got = { links: [], focused: 0, logs: [] }
  const forward = deeplink.makeSecondInstance({
    onLink: (u) => got.links.push(u),
    onFocus: () => { got.focused++ },
    log: (...a) => got.logs.push(a.join(' ')),
  })

  const r = forward(['C:\\x\\ENW Zombies.exe', 'enw-zombies://map/nazi_zombie_prototype'])
  assert.equal(r.forwarded, true)
  assert.equal(r.route.kind, 'map')
  assert.deepEqual(got.links, ['enw-zombies://map/nazi_zombie_prototype'])
  assert.equal(got.focused, 1, 'the window the player already has must come up')

  // A second launch with no link is not an error: it means "show me the launcher".
  const bare = forward(['C:\\x\\ENW Zombies.exe'])
  assert.equal(bare.forwarded, false)
  assert.equal(got.links.length, 1, 'nothing was routed')
  assert.equal(got.focused, 2)

  // A malformed one still forwards — the primary decides it means home, and the log
  // has to carry the URL either way.
  const bad = forward(['exe', 'enw-zombies://wat/x'])
  assert.equal(bad.forwarded, true)
  assert.equal(bad.route.kind, 'home')
  assert.ok(got.logs.some((l) => l.includes('enw-zombies://wat/x')), 'every received URL is logged')
})

await test('protocol registration uses the script path in a dev checkout and never throws', () => {
  const calls = []
  const fakeApp = { setAsDefaultProtocolClient: (...a) => { calls.push(a); return true } }
  deeplink.register(fakeApp, { isDev: true, argv: ['electron.exe', 'main.js'], execPath: 'C:\\e\\electron.exe' })
  assert.equal(calls[0][0], 'enw-zombies')
  assert.equal(calls[0][1], 'C:\\e\\electron.exe')
  assert.equal(calls[0][2].length, 1, 'the script path is passed, or the callback starts a bare Electron')

  calls.length = 0
  deeplink.register(fakeApp, { isDev: false })
  assert.deepEqual(calls[0], ['enw-zombies'])

  // An OS that refuses, and an Electron that throws, both end with a working launcher.
  assert.equal(deeplink.register({ setAsDefaultProtocolClient: () => false }, { isDev: false }), false)
  assert.equal(deeplink.register({ setAsDefaultProtocolClient: () => { throw new Error('nope') } }, { isDev: false }), false)
})

// ------------------------------------------------------------ check for updates --
group('Check for updates')

const updatecheck = await import('../src/main/updatecheck.js')

// A stand-in for electron-updater's `autoUpdater`: the same event names, the same
// `checkForUpdates()` shape, and nothing else. Driving the real one would need a packed
// app, a feed and a network.
function fakeUpdater() {
  const u = new EventEmitter()
  u.calls = []
  u.setFeedURL = (o) => u.calls.push(['setFeedURL', o])
  u.checkForUpdates = async () => { u.calls.push(['checkForUpdates']); return u.result ?? { updateInfo: {} } }
  u.quitAndInstall = (...a) => u.calls.push(['quitAndInstall', ...a])
  u.downloadUpdate = async () => { u.calls.push(['downloadUpdate']); return [] }
  return u
}
const mk = (over = {}) => {
  const lines = []
  const up = new updatecheck.UpdateCheck({
    feedUrl: 'https://zombies.enw.gg/updates',
    currentVersion: '0.2.2',
    log: (...a) => lines.push(a.join(' ')),
    ...over,
  })
  return { up, lines }
}

await test('the player-facing lines are exactly the five short sentences', () => {
  const d = updatecheck.describe
  assert.equal(d({ phase: 'checking' }), 'Checking…')
  assert.equal(d({ phase: 'up_to_date', current: '0.2.2' }), 'You are up to date (0.2.2)')
  assert.equal(d({ phase: 'downloading', percent: 37.4 }), 'Downloading 37%')
  assert.equal(d({ phase: 'downloading', percent: 0 }), 'Downloading 0%')
  assert.equal(d({ phase: 'ready' }), 'Ready to install')
  assert.equal(d({ phase: 'idle' }), '')
  // A percentage out of range is a bug somewhere else and must not reach the player as
  // "Downloading 4300%".
  assert.equal(d({ phase: 'downloading', percent: 4300 }), 'Downloading 100%')
  assert.equal(d({ phase: 'downloading', percent: -2 }), 'Downloading 0%')
})

await test('a 404, a DNS failure and a timeout are all "no feed reachable", with the detail in parentheses', () => {
  for (const raw of [
    'HttpError: 404 Not Found',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_ABORTED',                      // MEASURED in B's log; it was really a 401
    'getaddrinfo ENOTFOUND zombies.enw.gg',
    'getaddrinfo EAI_AGAIN zombies.enw.gg',
    'connect ETIMEDOUT 1.2.3.4:443',
    'connect ECONNREFUSED 127.0.0.1:443',
    'Cannot find latest.yml in the latest release artifacts',
  ]) {
    const e = updatecheck.explain(new Error(raw))
    assert.equal(e.kind, 'unreachable', raw)
    assert.match(e.text, /update server could not be reached/, raw)
    assert.ok(!/^net::|^HttpError|^getaddrinfo|^connect /.test(e.text), `the player must not be led with an errno: ${raw}`)
    assert.ok(e.text.includes(`(${raw})`), `the technical detail is kept, in parentheses: ${raw}`)
  }
  // Something that is genuinely NOT a reachability problem keeps its own sentence.
  const other = updatecheck.explain(new Error('electron-updater did not export a usable autoUpdater'))
  assert.equal(other.kind, 'failed')
  assert.match(other.text, /could not be checked/)
})

await test('a dev checkout says so in plain English instead of throwing', async () => {
  const { up, lines } = mk({ isDev: true, loadUpdater: async () => { throw new Error('must not be reached') } })
  const s = await up.check()
  assert.equal(s.phase, 'unsupported')
  assert.match(s.message, /development checkout/)
  assert.ok(lines.some((l) => l.includes('development checkout')), 'and the reason is in launcher.log')
  assert.equal(s.canInstall, false)

  // No feed configured is the same kind of fact, not an error.
  const none = mk({ feedUrl: null })
  const s2 = await none.up.check()
  assert.equal(s2.phase, 'unsupported')
  assert.match(s2.message, /No update server is configured/)
})

await test('a check runs to Ready to install, pushes each state, and logs every step', async () => {
  const fake = fakeUpdater()
  const { up, lines } = mk({ loadUpdater: async () => ({ autoUpdater: fake }) })
  const seen = []
  up.on('status', (s) => seen.push(s.message))

  await up.check()
  fake.emit('update-available', { version: '0.2.3' })
  // 0.2.11: finding it does not download it; Update now does.
  assert.equal(fake.autoDownload, false, 'the check must not download by itself')
  assert.equal(fake.calls.some((c) => c[0] === 'downloadUpdate'), false)
  up.download()
  await new Promise((r) => setImmediate(r))
  assert.ok(fake.calls.some((c) => c[0] === 'downloadUpdate'), 'Update now starts the download')
  fake.emit('download-progress', { percent: 37.4 })
  fake.emit('update-downloaded', { version: '0.2.3' })

  assert.deepEqual(seen, [
    'Checking…',
    'Update 0.2.3 available',
    'Downloading 0%',
    'Downloading 37%',
    'Ready to install',
  ])
  assert.equal(up.status().canInstall, true, '"Restart and update" appears only now')
  assert.equal(up.status().downloaded, '0.2.3')
  // The log carries the whole story: started, what was found, the download, done.
  const log = lines.join('\n')
  for (const want of ['check started', 'update available: 0.2.3', 'downloading 37%', 'downloaded 0.2.3']) {
    assert.ok(log.includes(want), `launcher.log must say "${want}"\n${log}`)
  }
  // And the feed was actually set on the updater we were handed.
  assert.equal(fake.calls[0][0], 'setFeedURL')
  assert.equal(fake.calls[0][1].url, 'https://zombies.enw.gg/updates')
})

await test('an already-current launcher says "You are up to date", and a failure says why', async () => {
  const fake = fakeUpdater()
  const { up } = mk({ loadUpdater: async () => ({ autoUpdater: fake }) })
  await up.check()
  fake.emit('update-not-available', {})
  assert.equal(up.status().message, 'You are up to date (0.2.2)')
  assert.equal(up.status().canInstall, false)

  fake.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED'))
  assert.equal(up.status().phase, 'unreachable')
  assert.match(up.status().message, /update server could not be reached.*ERR_NAME_NOT_RESOLVED/s)

  // A check that throws on the way in never escapes into the IPC layer.
  const bad = mk({ loadUpdater: async () => { throw new Error('connect ETIMEDOUT 1.2.3.4:443') } })
  const s = await bad.up.check()
  assert.equal(s.phase, 'unreachable')
  assert.ok(bad.lines.some((l) => l.includes('no feed reachable')), 'the log names the reason')
})

await test('download progress is logged at intervals, not on every event', async () => {
  const fake = fakeUpdater()
  const { up, lines } = mk({ loadUpdater: async () => ({ autoUpdater: fake }) })
  const pushes = []
  up.on('status', (s) => pushes.push(s.message))
  await up.check()
  for (let i = 0; i <= 100; i++) fake.emit('download-progress', { percent: i })

  const logged = lines.filter((l) => l.startsWith('downloading '))
  // 0,10,20…100 — eleven marks out of a hundred and one events. A 94 MB installer
  // produces hundreds of these, and a log the download drowns out is a log nobody reads.
  assert.equal(logged.length, 11, `expected one line per 10%, got:\n${logged.join('\n')}`)
  assert.equal(logged[0], 'downloading 0%')
  assert.equal(logged.at(-1), 'downloading 100%')
  // The UI still sees every one of them: the throttle is on the FILE, not the screen.
  assert.equal(pushes.filter((m) => m.startsWith('Downloading ')).length, 101)
})

await test('"Restart and update" refuses when nothing is downloaded, and calls quitAndInstall when something is', async () => {
  const fake = fakeUpdater()
  const { up, lines } = mk({ loadUpdater: async () => ({ autoUpdater: fake }) })
  await up.check()

  const no = up.quitAndInstall()
  assert.equal(no.ok, false)
  assert.match(no.why, /nothing is downloaded/)
  assert.equal(fake.calls.some((c) => c[0] === 'quitAndInstall'), false,
    'quitAndInstall with nothing staged closes the launcher and opens nothing')

  fake.emit('update-downloaded', { version: '0.2.3' })
  const yes = up.quitAndInstall()
  assert.equal(yes.ok, true)
  assert.equal(yes.version, '0.2.3')
  assert.ok(fake.calls.some((c) => c[0] === 'quitAndInstall'))
  assert.ok(lines.some((l) => l.includes('quitAndInstall called for 0.2.3')))
})

await test('the electron-builder config registers enw-zombies for the installer', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const protos = pkg.build.protocols
  assert.ok(Array.isArray(protos) && protos.length === 1, 'exactly one protocol block')
  assert.deepEqual(protos[0].schemes, ['enw-zombies'])
  assert.ok(protos[0].name, 'NSIS needs a name for the scheme')
  // Registration in the installer is the only reason `start enw-zombies://…` works on a
  // machine where the launcher has never been run. UNPROVEN here: this asserts the
  // config, not the registry key a packaged install writes.
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

await test('a game that froze or crashed gets one terse line; a quit or our own stop gets none (lane CL)', () => {
  // B's zombie_town hang: the DLL said 'hang', Windows closed the window with 0xCFFFFFFF.
  assert.equal(crash.gameEndNotice({ session: { exit: 'hang' }, exitCode: 3489660927, map: 'Town of the Dead' }),
    'World at War froze on Town of the Dead. We have the logs.')
  assert.match(crash.gameEndNotice({ session: null, exitCode: crash.HUNG_EXIT_CODE }), /^World at War froze\. /)
  assert.match(crash.gameEndNotice({ session: { exit: 'crash' }, exitCode: -1073741819, map: 'x' }), /crashed on x/)
  assert.match(crash.gameEndNotice({ session: { exit: 'unknown' }, exitCode: -1073741819 }), /closed unexpectedly/)
  assert.equal(crash.gameEndNotice({ session: { exit: 'quit' }, exitCode: 0 }), null)
  assert.equal(crash.gameEndNotice({ session: { exit: 'error' }, exitCode: 0 }), null)
  assert.equal(crash.gameEndNotice({ session: null, exitCode: 0 }), null)
  assert.equal(crash.gameEndNotice({ session: { exit: 'hang' }, exitCode: 1, stoppedByUs: true }), null)
  for (const s of ['hang', 'crash']) assert.equal(/0x|stack|exception|null|undefined/i.test(crash.gameEndNotice({ session: { exit: s } })), false)
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


// ------------------------------------------------- the launch baseline (§4.3) --
group('The launch baseline: borderless, native, vsync off')

const SCREENS = [
  { id: 'DISPLAY1', index: 0, label: 'Display 1', x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 1, primary: true },
  { id: 'DISPLAY2', index: 1, label: 'Display 2', x: -1440, y: -340, width: 1440, height: 2560, scaleFactor: 1, primary: false },
]
const dvarsOf = (args) => {
  const m = new Map()
  for (let i = 0; i < args.length; i++) if (args[i] === '+set') m.set(args[i + 1], args[i + 2])
  return m
}

await test('the default launch is borderless at the primary display native size', () => {
  const d = display.pickDisplay(SCREENS, undefined)
  const v = new Map(gamecfg.baselineDvars({}, d))
  assert.equal(v.get('r_mode'), '2560x1440', 'r_mode must be the primary display native size')
  assert.equal(v.get('r_fullscreen'), '0')
  assert.equal(v.get('r_noborder'), '1')
  assert.equal(v.get('vid_xpos'), '0')
  assert.equal(v.get('vid_ypos'), '0')
  assert.equal(v.get('r_monitor'), '0')
})

await test('THE 60 FPS AND THE 800x600 ARE BOTH GONE', () => {
  const v = dvarsOf(launch.buildArgs({ settings: {}, display: display.pickDisplay(SCREENS) }))
  assert.equal(v.get('r_vsync'), '0', 'vsync on is what capped the game at the monitor refresh')
  assert.equal(v.get('com_maxfps'), '250', 'the stock cap is 85')
  assert.notEqual(v.get('r_mode'), '800x600', 'the engine default is 800x600 and must not survive')
  assert.equal(v.get('r_mode'), '2560x1440')
})

await test('r_mode is a STRING WxH, never an index', () => {
  const v = new Map(gamecfg.baselineDvars({ mode: 'windowed', resolution: '1920x1080' }, SCREENS[0]))
  assert.equal(v.get('r_mode'), '1920x1080')
  assert.equal(display.validResolution('1920 x 1080'), '1920x1080')
  assert.equal(display.validResolution('1080p'), null)
  assert.equal(display.validResolution('6'), null)
  assert.equal(display.validResolution(6), null)
})

await test('a second monitor is launched on, at its own origin', () => {
  const d = display.pickDisplay(SCREENS, 'DISPLAY2')
  const v = new Map(gamecfg.baselineDvars({ display: 'DISPLAY2' }, d))
  assert.equal(v.get('r_mode'), '1440x2560')
  assert.equal(v.get('vid_xpos'), '-1440')
  assert.equal(v.get('vid_ypos'), '-340')
  assert.equal(v.get('r_monitor'), '1')
})

await test('a monitor that has been unplugged falls back to the primary, not to a failure', () => {
  assert.equal(display.pickDisplay(SCREENS, 'DISPLAY9-GONE').id, 'DISPLAY1')
})

await test('borderless ignores a saved resolution; fullscreen and windowed honour it', () => {
  const b = new Map(gamecfg.baselineDvars({ mode: 'borderless', resolution: '1280x720' }, SCREENS[0]))
  assert.equal(b.get('r_mode'), '2560x1440', 'borderless always uses the display native size (spec 4.3)')
  const f = new Map(gamecfg.baselineDvars({ mode: 'fullscreen', resolution: '1280x720' }, SCREENS[0]))
  assert.equal(f.get('r_mode'), '1280x720')
  assert.equal(f.get('r_fullscreen'), '1')
  assert.equal(f.get('r_noborder'), undefined, 'fullscreen is not borderless')
  assert.equal(f.get('vid_xpos'), undefined, 'a fullscreen window is not positioned')
})

await test('no display information at all: nothing is invented', () => {
  const v = new Map(gamecfg.baselineDvars({ mode: 'borderless' }, null))
  assert.equal(v.get('r_mode'), undefined, 'better to leave the game its own resolution than to guess one')
  assert.equal(v.get('r_vsync'), '0', 'the rest of the baseline still applies')
})

await test('an account saved before Display settings existed still gets borderless', () => {
  // DEFAULT_SETTINGS used to be `fullscreen: true`, which was the old default rather
  // than a choice, so it must not pin the mode. An explicit `false` is a choice.
  assert.equal(gamecfg.resolveMode({ fullscreen: true }), 'borderless')
  assert.equal(gamecfg.resolveMode({ fullscreen: false }), 'windowed')
  assert.equal(gamecfg.resolveMode({ mode: 'fullscreen', fullscreen: false }), 'fullscreen')
})

await test('the dev window modes are untouched by all of this', () => {
  for (const mode of ['small', 'offscreen']) {
    const v = dvarsOf(launch.buildArgs({ windowMode: mode, settings: { mode: 'borderless' }, display: SCREENS[0] }))
    assert.equal(v.get('r_mode'), '800x600', `${mode} must stay 800x600`)
    assert.equal(v.get('snd_volume'), '0')
    assert.equal(v.get('r_noborder'), undefined)
  }
})

await test('nothing appends a resolution after the player one (the DLL reads the LAST +set)', () => {
  const args = launch.buildArgs({ settings: {}, display: SCREENS[0], map: 'nazi_zombie_prototype', extra: ['+set', 'sv_cheats', '0'] })
  assert.equal(dvarsOf(args).get('r_mode'), '2560x1440')
  assert.equal(args.filter((x, i) => x === 'r_mode' && args[i - 1] === '+set').length, 1, 'r_mode must appear exactly once')
})

await test('every bundled fix has a reason and a source', () => {
  assert.ok(gamecfg.COMMUNITY_FIXES.length >= 10)
  for (const f of gamecfg.COMMUNITY_FIXES) {
    assert.ok(f.dvar && f.value !== undefined, `${f.name} needs a dvar and a value`)
    assert.ok(f.why && f.why.length > 20, `${f.name} needs a reason`)
    assert.match(f.source, /^https?:\/\//, `${f.name} needs a source URL`)
  }
})

await test('no bundled fix touches gameplay', () => {
  // Records rules care about FPS and FOV, which the spec already bounds. Nothing
  // else may change what the game simulates.
  const forbidden = /^(g_|sv_|zombie|perk|player_|jump_|bg_|ai_|cg_gun|timescale)/i
  for (const f of gamecfg.COMMUNITY_FIXES) assert.equal(forbidden.test(f.dvar), false, `${f.dvar} is a gameplay dvar`)
})

await test('the FPS and FOV caps from spec 4.5 are enforced', () => {
  assert.equal(gamecfg.clampFps(9999), '250')
  assert.equal(gamecfg.clampFps(0), '250')
  assert.equal(gamecfg.clampFps('abc'), '250')
  assert.equal(gamecfg.clampFps(144), '144')
  assert.equal(gamecfg.clampFov(500), '120')
  assert.equal(gamecfg.clampFov(10), '65')
  assert.equal(gamecfg.clampFov(90), '90')
})

// ---------------------------------------------- seeding, and the round trip --
group('The home folder seed and the round trip')

const HOME = path.join(process.env.ENW_ROOT, 'testhome')
const PCFG = () => path.join(HOME, 'players', 'profiles', gamecfg.PROFILE, 'config.cfg')

await test('the first launch seeds config.cfg so the in-game menu is not lying', () => {
  const r = gamecfg.seedHome({ homeDir: HOME, settings: {}, display: SCREENS[0] })
  assert.equal(r.written, true, r.reason)
  const text = fs.readFileSync(r.paths.profileCfg, 'utf8')
  assert.match(text, /seta r_mode "2560x1440"/)
  assert.match(text, /seta r_vsync "0"/)
  assert.match(text, /seta com_maxfps "250"/)
  assert.match(text, /seta cg_fov "80"/)
  assert.equal(fs.readFileSync(r.paths.activeTxt, 'utf8'), gamecfg.PROFILE, 'active.txt must name the profile or the engine reads a different one')
  assert.ok(fs.existsSync(r.paths.plainCfg))
})

await test('a second launch does NOT overwrite the config the player now owns', () => {
  fs.writeFileSync(PCFG(), 'seta r_mode "1280x720"\nseta cg_fov "95"\n')
  const r = gamecfg.seedHome({ homeDir: HOME, settings: {}, display: SCREENS[0] })
  assert.equal(r.written, false, 'the game owns config.cfg once it exists')
  assert.match(fs.readFileSync(r.paths.profileCfg, 'utf8'), /1280x720/)
})

await test('parses seta, set, quoted and bare, and binds', () => {
  const { dvars, binds } = gamecfg.parseConfigCfg([
    '// generated by Call of Duty, do not modify',
    'seta r_mode "1920x1080"',
    'seta r_fullscreen "0"',
    'set com_maxfps 125',
    'seta cg_fov "95"',
    'bind W "+forward"',
    'bind SPACE +gostand',
    '',
  ].join('\r\n'))
  assert.equal(dvars.get('r_mode'), '1920x1080')
  assert.equal(dvars.get('com_maxfps'), '125')
  assert.equal(binds.get('W'), '+forward')
  assert.equal(binds.get('SPACE'), '+gostand')
  assert.equal(dvars.has('//'), false)
})

await test('an in-game change is read back and becomes the next launch', () => {
  const saved = { mode: 'borderless', resolution: '2560x1440', fov: 80, maxFps: 250, vsync: false }
  fs.writeFileSync(PCFG(), 'seta r_mode "1920x1080"\nseta r_fullscreen "1"\nseta cg_fov "95"\nseta com_maxfps "125"\nseta r_vsync "1"\n')
  const r = gamecfg.applyReadBack({ homeDir: HOME, saved })
  assert.equal(r.changed.resolution, '1920x1080')
  assert.equal(r.changed.mode, 'fullscreen')
  assert.equal(r.changed.fov, 95)
  assert.equal(r.changed.maxFps, 125)
  assert.equal(r.changed.vsync, true)
  // And the next launch really does use them.
  const v = new Map(gamecfg.baselineDvars({ ...saved, ...r.changed }, SCREENS[0]))
  assert.equal(v.get('r_mode'), '1920x1080')
  assert.equal(v.get('r_fullscreen'), '1')
  assert.equal(v.get('r_vsync'), '1')
})

await test('a stale saved value NEVER overrides an in-game change, and vice versa', () => {
  // The game wrote only a resolution. Everything else the account holds must survive
  // untouched -- absence in config.cfg is "no opinion", not "back to the default".
  fs.writeFileSync(PCFG(), 'seta r_mode "3440x1440"\n')
  const r = gamecfg.applyReadBack({ homeDir: HOME, saved: { mode: 'borderless', resolution: '2560x1440', fov: 110, maxFps: 190 } })
  assert.deepEqual(Object.keys(r.changed), ['resolution'])
  assert.equal(r.changed.resolution, '3440x1440')
})

await test('borderless is not silently demoted to windowed every single launch', () => {
  // Borderless and windowed both write `r_fullscreen 0`, and vanilla has no
  // r_noborder to tell them apart. Without this the default mode would decay.
  fs.writeFileSync(PCFG(), 'seta r_fullscreen "0"\nseta r_mode "2560x1440"\n')
  const r = gamecfg.applyReadBack({ homeDir: HOME, saved: { mode: 'borderless', resolution: '2560x1440' } })
  assert.equal('mode' in r.changed, false, 'must stay borderless')
  // But a player who really did pick windowed in game (the DLL writes r_noborder 0)
  // is believed.
  fs.writeFileSync(PCFG(), 'seta r_fullscreen "0"\nseta r_noborder "0"\nseta r_mode "1280x720"\n')
  const r2 = gamecfg.applyReadBack({ homeDir: HOME, saved: { mode: 'borderless', resolution: '2560x1440' } })
  assert.equal(r2.changed.mode, 'windowed')
})

// ------------------------------------------------- 2026-09-22, launcher 0.2.3 --
// Three things B reported after playing 0.2.2, and the first two were the same bug.

await test('the seed goes where the ENGINE reads it, not where fs_homepath suggests', () => {
  // `%s/players/profiles/%s/config.cfg` resolves against the engine's LOCAL APP
  // DATA folder -- which enw_localappdata.cpp points at <home>\localappdata --
  // and NOT against fs_homepath. Seeding only the fs_homepath tree is why B's
  // profile still held `seta r_mode "800x600"` and `vid_xpos "40"` after a
  // session launched with 2560x1440 at 0,0: config.cfg is exec'd during
  // Com_Init, after the command line's `+set`s, so it wins.
  const H = path.join(process.env.ENW_ROOT, 'enginehome')
  const r = gamecfg.seedHome({ homeDir: H, settings: {}, display: SCREENS[0] })
  assert.equal(r.written, true, r.reason)
  const expected = path.join(H, 'localappdata', 'Activision', 'CoDWaW', 'players', 'profiles', gamecfg.PROFILE, 'config.cfg')
  assert.equal(r.paths.engineCfg, expected)
  assert.ok(fs.existsSync(expected), 'the engine-side config.cfg must exist')
  assert.match(fs.readFileSync(expected, 'utf8'), /seta r_mode "2560x1440"/)
})

await test('aim down sights defaults to HOLD, and it is a bind because T4 has no ADS dvar', () => {
  const H = path.join(process.env.ENW_ROOT, 'adshome')
  const r = gamecfg.seedHome({ homeDir: H, settings: {}, display: SCREENS[0] })
  const text = fs.readFileSync(r.paths.engineCfg, 'utf8')
  assert.match(text, /bind MOUSE2 "\+speed_throw"/, 'hold, not toggle')
  assert.doesNotMatch(text, /\+toggleads_throw/)
  // And it round-trips: a player who picks Toggle in the Controls menu keeps it.
  const { binds } = gamecfg.parseConfigCfg('bind MOUSE2 "+toggleads_throw"\n')
  assert.equal(binds.get('MOUSE2'), '+toggleads_throw')
  const patch = gamecfg.settingsFromConfig({ dvars: new Map(), binds })
  assert.equal(patch.binds.MOUSE2, '+toggleads_throw')
})

await test('the seed MERGES into the config the game wrote; binds and unknown lines survive', () => {
  // The engine's own config.cfg is ~500 lines including every key binding.
  // Replacing it with our 30-line baseline would wipe them.
  const existing = [
    '// generated by Call of Duty, do not modify',
    'unbindall',
    'bind W "+forward"',
    'bind MOUSE2 "+toggleads_throw"',
    'seta r_mode "800x600"',
    'seta cg_mysteriousThing "keep me"',
    'seta vid_xpos "40"',
    'con_hidechannel *; con_showchannel dontfilter error',
    '',
  ].join('\r\n')
  const merged = gamecfg.mergeConfigCfg(existing, [['r_mode', '2560x1440'], ['vid_xpos', '0'], ['cg_fov', '80']])
  assert.match(merged, /bind W "\+forward"/, 'the player\'s binds survive')
  assert.match(merged, /seta cg_mysteriousThing "keep me"/, 'dvars we have no opinion about survive')
  assert.match(merged, /seta r_mode "2560x1440"/)
  assert.doesNotMatch(merged, /800x600/)
  assert.match(merged, /seta vid_xpos "0"/)
  assert.doesNotMatch(merged, /vid_xpos "40"/)
  assert.match(merged, /seta cg_fov "80"/, 'a dvar the file lacked is appended')
  assert.match(merged, /bind MOUSE2 "\+speed_throw"/, 'the ADS bind is substituted in place')
  assert.ok(merged.trimEnd().endsWith('con_hidechannel *; con_showchannel dontfilter error'), 'con_hidechannel stays last')
  assert.equal((merged.match(/seta r_mode/g) || []).length, 1, 'no duplicate lines')
})

await test('cg_drawFPS is a string enum on T4, not a bool', () => {
  // The engine writes `seta cg_drawFPS "Off"`. `1` is not one of its values.
  const on = new Map(gamecfg.baselineDvars({ showFps: true }, SCREENS[0]))
  const off = new Map(gamecfg.baselineDvars({ showFps: false }, SCREENS[0]))
  assert.equal(on.get('cg_drawFPS'), 'Simple')
  assert.equal(off.get('cg_drawFPS'), 'Off')
  assert.equal(gamecfg.settingsFromConfig({ dvars: new Map([['cg_drawFPS', 'Off']]) }).showFps, false)
  assert.equal(gamecfg.settingsFromConfig({ dvars: new Map([['cg_drawFPS', 'Simple']]) }).showFps, true)
})

await test('r_displayRefresh follows the panel, in the engine\'s own "N Hz" format', () => {
  const v = new Map(gamecfg.baselineDvars({}, { ...SCREENS[0], refresh: 240 }))
  assert.equal(v.get('r_displayRefresh'), '240 Hz')
  // No refresh reported: say nothing rather than invent 60.
  const q = new Map(gamecfg.baselineDvars({}, { ...SCREENS[0], refresh: null }))
  assert.equal(q.has('r_displayRefresh'), false)
})

await test('no config.cfg at all is not an error', () => {
  const r = gamecfg.applyReadBack({ homeDir: path.join(process.env.ENW_ROOT, 'emptyhome'), saved: {} })
  assert.deepEqual(r.changed, {})
  assert.equal(r.file, null)
})

await test('the display probe parses what the PowerShell helper prints', () => {
  const list = display.parseDisplayLines('\\\\.\\DISPLAY1|0|0|2560|1440|True\r\n\\\\.\\DISPLAY2|-1440|-340|1440|2560|False\r\nnot a display line\r\n')
  assert.equal(list.length, 2)
  assert.equal(list[0].width, 2560)
  assert.equal(list[0].primary, true)
  assert.equal(list[1].x, -1440)
  assert.equal(list[1].primary, false)
})

await test('settings validation refuses a resolution that would break the command line', () => {
  const bad = settings.validate({ resolution: '1920 by 1080' })
  assert.equal('resolution' in bad.patch, false)
  assert.equal(bad.notes.length, 1)
  assert.equal(settings.validate({ resolution: '1920x1080' }).patch.resolution, '1920x1080')
  assert.equal(settings.validate({ mode: 'fullscreen' }).patch.fullscreen, true)
  assert.equal(settings.validate({ mode: 'borderless' }).patch.fullscreen, false)
  assert.equal('mode' in settings.validate({ mode: 'kiosk' }).patch, false)
  assert.equal(settings.validate({ maxFps: 9000 }).patch.maxFps, 250)
})

await test('the shipped defaults are the ones the spec asks for', () => {
  assert.equal(settings.DEFAULT_SETTINGS.mode, 'borderless')
  assert.equal(settings.DEFAULT_SETTINGS.vsync, false)
  assert.equal(settings.DEFAULT_SETTINGS.maxFps, 250)
  assert.equal(settings.DEFAULT_SETTINGS.display, 'primary')
})

// ------------------------------------------------------------ party progress --
group('Party download progress')

// A stand-in SiteApi: records what would have gone to the site, answers ok.
function fakeApi(hello = {}) {
  const calls = []
  return {
    baseUrl: 'http://site.test',
    calls,
    hello,
    can: (c) => !!hello?.capabilities?.[c],
    async req(p, opts = {}) { calls.push({ path: p, ...opts }); return { ok: true, status: 200, data: { ok: true } } },
    async startPlay() { calls.push({ startPlay: true }); return { ok: true } },
  }
}

await test('nothing is sent when the player is not in a party', () => {
  const api = fakeApi()
  assert.equal(partyprogress.attach(api, { state: 'idle', party: null, map: { key: 'water' } }, 'water'), null)
  assert.equal(partyprogress.attach(api, null, 'water'), null)
  assert.equal(partyprogress.attach(api, { signedOut: true }, 'water'), null)
  assert.equal(api.calls.length, 0)
})

await test('nothing is sent for a map the party did not stage', () => {
  const api = fakeApi()
  const play = { party: { id: 7 }, map: { key: 'water' } }
  assert.equal(partyprogress.attach(api, play, 'nazi_zombie_leviathan'), null)
  assert.ok(partyprogress.attach(api, play, 'water'))
  assert.equal(api.calls.length, 0)     // attach alone posts nothing
})

await test('it posts to the party route at about 1 Hz, and terminal states always land', async () => {
  const api = fakeApi()
  const r = partyprogress.attach(api, { party: { id: 7 }, map: { key: 'water' } }, 'water')
  r.downloading(10, 100)                 // the first one goes
  r.downloading(20, 100)                 // too soon: accepted and dropped
  r.downloading(30, 100)
  r.lastAt = 0                           // a second has passed
  r.downloading(40, 100)
  await r.installed(100)
  assert.equal(api.calls.length, 3)
  for (const c of api.calls) {
    assert.equal(c.path, '/api/party/7/progress')
    assert.equal(c.method, 'POST')
    assert.equal(c.body.map, 'water')
  }
  assert.deepEqual(api.calls.map((c) => c.body.state), ['downloading', 'downloading', 'installed'])
  assert.equal(api.calls[0].body.bytes, 10)
  assert.equal(api.calls[0].body.total, 100)
  // `installed` is sent once the hash check has passed, and nothing follows it.
  r.downloading(50, 100)
  assert.equal(api.calls.length, 3)
})

await test('a failed install tells the party, with the reason', async () => {
  const api = fakeApi()
  const r = partyprogress.attach(api, { party: { id: 3 }, map: { key: 'water' } }, 'water')
  await r.failed(new Error('water.iwd did not match the hash the archive recorded'))
  assert.equal(api.calls.length, 1)
  assert.equal(api.calls[0].body.state, 'failed')
  assert.match(api.calls[0].body.error, /did not match the hash/)
})

await test('a site that hangs up never breaks the download', async () => {
  const api = { baseUrl: 'http://site.test', async req() { throw new Error('socket hang up') } }
  const r = new partyprogress.PartyProgress({ api, partyId: 1, map: 'water' })
  await r.downloading(1, 2)
  await r.installed(2)
  assert.equal(r.failedPosts, 2)         // both noticed, neither thrown
})

// ------------------------------------------------------------- joined launch --
group('Following somebody else pressing Start')

await test('a follower never presses Play for the party, and launches at the match the site leased', async () => {
  const api = fakeApi()
  const play = {
    state: 'ready',
    party: { id: 7, is_leader: false },
    map: { key: 'water' },
    match: { match_id: 'm_abc', connect: '10.0.0.5:28960', token: 'tok_follower' },
  }
  api.play = async () => play
  const flow = new BootFlow({ map: 'water', api, follow: true, launch: false, serverTimeoutMs: 4000 })
  const snap = await flow.runViaSite(api)
  assert.equal(api.calls.some((c) => c.startPlay), false, 'a member must not POST /api/launcher/play')
  assert.equal(flow.host, '10.0.0.5:28960')
  assert.equal(flow.matchId, 'm_abc')
  assert.equal(snap.steps.find((s) => s.id === 'ready').state, 'done')
  assert.equal(snap.failed, false)
})

await test('the leader own Play still asks the site for a server', async () => {
  const api = fakeApi()
  api.play = async () => ({ state: 'ready', party: { id: 7, is_leader: true }, map: { key: 'water' },
                            match: { match_id: 'm_abc', connect: '10.0.0.5:28960', token: 't' } })
  const flow = new BootFlow({ map: 'water', api, launch: false, serverTimeoutMs: 4000 })
  await flow.runViaSite(api)
  assert.equal(api.calls.some((c) => c.startPlay), true)
})

await test('the map is installed before the game is launched, and a failed install stops the launch', async () => {
  const api = fakeApi()
  api.play = async () => ({ state: 'ready', party: { id: 7, is_leader: false }, map: { key: 'water' },
                            match: { match_id: 'm_abc', connect: '10.0.0.5:28960', token: 't' } })
  let asked = null
  const flow = new BootFlow({
    map: 'water', api, follow: true, launch: false, serverTimeoutMs: 4000,
    ensureMap: async (bsp, onProgress) => { asked = bsp; onProgress({ file: 'water.iwd', done: 50, total: 100 }); return { already: false } },
  })
  const snap = await flow.runViaSite(api)
  assert.equal(asked, 'water')
  assert.equal(snap.steps.find((s) => s.id === 'download').state, 'done')

  const bad = new BootFlow({
    map: 'water', api, follow: true, serverTimeoutMs: 4000,
    ensureMap: async () => { throw new Error('water.iwd did not match the hash the archive recorded') },
  })
  const s2 = await bad.runViaSite(api)
  assert.equal(s2.failed, true)
  assert.equal(s2.steps.find((s) => s.id === 'download').state, 'failed')
  // The game is still never launched — but the steps after the failure are now WRITTEN
  // DOWN as stopped rather than left absent. An absent step is drawn as "waiting", and
  // a boot screen saying "waiting" about a launch that has already given up is what B
  // sat in front of on 0.2.3.
  assert.equal(bad.launch, null, 'a map that did not install is never launched')
  const l2 = s2.steps.find((s) => s.id === 'launching')
  assert.equal(l2.state, 'failed')
  assert.ok(/^stopped: /.test(l2.detail), 'the launch step says it stopped and why')
  assert.equal(s2.steps.find((s) => s.id === 'in_game').state, 'failed')
})

// host.md §16: B cancelled a silent "Reserving server" twice at ~30 s while his lease sat
// in the box's boot queue. The box now says `queued` and the boot screen says so.
await test('a boot queued on the box shows on the boot screen, and the launch still goes through', async () => {
  const api = fakeApi()
  let n = 0
  const queued = { state: 'reserving', party: { id: 7, is_leader: false }, map: { key: 'water' },
                   match: { match_id: 'm_q', connect: null, token: 't', state: 'leased', preparing: { phase: 'queued', ahead: 1, reason: 'boot' } } }
  api.play = async () => (++n < 3 ? queued : { ...queued, state: 'ready', match: { ...queued.match, preparing: null, state: 'ready', connect: '10.0.0.5:28960' } })
  const flow = new BootFlow({ map: 'water', api, follow: true, launch: false, serverTimeoutMs: 8000 })
  const seen = []
  flow.on('step', (s) => seen.push(`${s.id}:${s.detail}`))
  const snap = await flow.runViaSite(api)
  assert.ok(seen.includes('reserving:the server is starting another game first; yours is next'), seen.join(' | '))
  assert.equal(snap.failed, false)
  assert.equal(flow.host, '10.0.0.5:28960')
})

await test('the preparing words: queued, memory, a map pull, and nothing for nothing', async () => {
  const { preparingDetail } = await import('../src/main/bootflow.js')
  assert.equal(preparingDetail({ phase: 'queued', ahead: 2 }), 'the server is starting 2 games before yours, one at a time')
  assert.equal(preparingDetail({ phase: 'queued', ahead: 0 }), 'the server is starting your game')
  assert.equal(preparingDetail({ phase: 'queued', ahead: 0, reason: 'memory' }), 'the server is freeing memory for your game')
  assert.equal(preparingDetail({ phase: 'downloading', percent: 41.6 }), 'the server is downloading the map (42%)')
  assert.equal(preparingDetail(null), null)
})

// A stock map has no payload ANYWHERE: the site holds no files for it by design, so
// the download step must never run. This is the exact launch B lost.
await test('a stock map skips the download step instead of asking the site for files', async () => {
  const api = fakeApi()
  api.play = async () => ({ state: 'ready', party: { id: 7, is_leader: false },
                            map: { key: 'nazi_zombie_prototype', source: 'stock' },
                            match: { match_id: 'm_stock', connect: '10.0.0.5:28960', token: 't' } })
  let asked = null
  const flow = new BootFlow({
    map: 'nazi_zombie_prototype', api, follow: true, launch: false, serverTimeoutMs: 4000,
    isStock: (b) => b === 'nazi_zombie_prototype',
    ensureMap: async (bsp) => { asked = bsp; throw new Error('The site has no files for nazi_zombie_prototype yet.') },
  })
  const snap = await flow.runViaSite(api)
  assert.equal(asked, null, 'nothing is downloaded for a map that ships with the game')
  assert.equal(snap.steps.find((s) => s.id === 'download').state, 'done')
  assert.equal(snap.steps.find((s) => s.id === 'download').detail, 'installed: stock')
  assert.equal(snap.failed, false)
})

// The site's own answer is enough on its own, so a launcher one release behind the
// map table still gets this right.
await test('the site saying source: stock is enough on its own', async () => {
  const api = fakeApi()
  api.play = async () => ({ state: 'ready', party: { id: 7, is_leader: false },
                            map: { key: 'nazi_zombie_sumpf', source: 'stock' },
                            match: { match_id: 'm_s2', connect: '10.0.0.5:28960', token: 't' } })
  const flow = new BootFlow({
    map: 'nazi_zombie_sumpf', api, follow: true, launch: false, serverTimeoutMs: 4000,
    ensureMap: async () => { throw new Error('the site has no files') },
  })
  const snap = await flow.runViaSite(api)
  assert.equal(snap.steps.find((s) => s.id === 'download').detail, 'installed: stock')
})

// A download that broke on a map that is nonetheless on disk is a broken CHECK, not a
// reason to refuse a ready server.
await test('a failed download on a map that is already on this PC still launches', async () => {
  const api = fakeApi()
  api.play = async () => ({ state: 'ready', party: { id: 7, is_leader: false }, map: { key: 'water' },
                            match: { match_id: 'm_w', connect: '10.0.0.5:28960', token: 't' } })
  const flow = new BootFlow({
    map: 'water', api, follow: true, launch: false, serverTimeoutMs: 4000,
    mapReady: () => true,
    ensureMap: async () => { throw new Error('the site answered 503') },
  })
  const snap = await flow.runViaSite(api)
  assert.equal(snap.steps.find((s) => s.id === 'download').state, 'done')
  assert.equal(snap.failed, false)
})

// ------------------------------------- 2026-09-22, 0.2.4: what B actually played --
// B played windowed-with-a-border, at 60 fps, with toggle ADS. Three saved-state bugs,
// all of them "a value that was never chosen became the value we use".
group('0.2.4: the settings that were never chosen')

const focusguard = await import('../src/main/focusguard.js')

await test('an account block never shadows a key it does not define', () => {
  // B's real state\settings.json: the account block keyed by his steamid carries
  // resolution/fov/maxFps/binds and NO `mode`, while `local` says mode "borderless".
  // get() used to pick ONE of the two objects, so signing in threw the local block
  // away whole and every key the account happened not to carry fell back to a bare
  // default instead of to what this computer was playing with.
  settings.signOut()
  settings.set({ mode: 'borderless', chatChannel: 'local', maxFps: 250 })   // the local block
  settings.signIn({ steamid: '76561190000000009', name: 'shadow' })
  settings.set({ resolution: '2560x1440' })                                 // the account block
  const s = settings.get()
  assert.equal(s.mode, 'borderless', 'a key the account does not define must fall through to local')
  assert.equal(s.chatChannel, 'local')
  assert.equal(s.resolution, '2560x1440', 'a key the account DOES define still wins')
  // And the general case: a null/undefined IN THE ACCOUNT BLOCK is "no opinion", not
  // an override. Written straight to the state file, because set() deliberately keeps
  // the local copy in step and so cannot produce this shape on its own.
  const raw = JSON.parse(fs.readFileSync(paths.P.settings, 'utf8'))
  raw.accounts['76561190000000009'] = { resolution: null, fov: undefined, maxFps: 190 }
  raw.local = { ...raw.local, resolution: '3440x1440', fov: 110, mode: 'borderless' }
  fs.writeFileSync(paths.P.settings, JSON.stringify(raw, null, 2))
  const t = settings.get('76561190000000009')
  assert.equal(t.resolution, '3440x1440', 'a null account value must not shadow the local one')
  assert.equal(t.fov, 110, 'nor an undefined one')
  assert.equal(t.maxFps, 190, 'a defined account value still wins')
  settings.signOut()
})

await test('ENW_BORDERLESS is 1 for an account with no mode and a local borderless', () => {
  // The env var the DLL's borderless component reads. It must follow the EFFECTIVE
  // resolved mode, not a raw account block.
  settings.signOut()
  settings.set({ mode: 'borderless' })
  settings.signIn({ steamid: '76561190000000010', name: 'noMode' })
  settings.set({ resolution: '2560x1440' })
  const s = settings.get()
  assert.equal(s.mode, 'borderless')
  assert.equal(launch.borderlessEnv(s, true), '1')
  // A dev window mode still gets an explicit '0' rather than inheriting one.
  assert.equal(launch.borderlessEnv(s, false), '0')
  assert.equal(launch.borderlessEnv({ mode: 'windowed' }, true), '0')
  settings.signOut()
})

await test('the FPS lock the DLL enforces mid-game is the same cap the launcher writes (250)', () => {
  // verified-rules.md: every board caps WaW at 250. fps_guard.cpp reads ENW_FPS_CAP.
  assert.equal(launch.fpsCapEnv(), '250')
  assert.equal(gamecfg.clampFps(333), '250', 'the launch value never exceeds the lock')
  assert.equal(gamecfg.clampFps(0), '250', 'uncapped is never written')
  assert.equal(gamecfg.clampFps(125), '125')
})

await test('the read-back never persists a value the engine defaulted to', () => {
  // B's account ended up holding maxFps 60 and fov 65 -- the engine's 2008 stock
  // defaults, saved there because until 0.2.3 we read back a profile the seed had
  // never reached. A first read-back must refuse them.
  const H = path.join(process.env.ENW_ROOT, 'stockhome')
  const cfgDir = path.join(H, 'players', 'profiles', gamecfg.PROFILE)
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.writeFileSync(path.join(cfgDir, 'config.cfg'),
    'seta com_maxfps "60"\r\nseta cg_fov "65"\r\nseta r_mode "800x600"\r\nseta sensitivity "4.2"\r\n')
  const r = gamecfg.applyReadBack({ homeDir: H, saved: { maxFps: 250, fov: 80, resolution: '2560x1440' } })
  assert.equal('maxFps' in r.changed, false, 'com_maxfps 60 is the engine default, not a choice')
  assert.equal('fov' in r.changed, false, 'cg_fov 65 is the engine default, not a choice')
  assert.equal('resolution' in r.changed, false, 'r_mode 800x600 is the engine default')
  assert.equal(r.changed.sensitivity, 4.2, 'a value that is NOT a stock default still comes back')

  // And a value identical to the one we seeded is not a change either, whatever it is.
  const S = path.join(process.env.ENW_ROOT, 'seedhome')
  gamecfg.seedHome({ homeDir: S, settings: { fov: 95 }, display: SCREENS[0] })
  fs.writeFileSync(path.join(S, 'players', 'profiles', gamecfg.PROFILE, 'config.cfg'),
    'seta cg_fov "95"\r\nseta com_maxfps "125"\r\n')
  const r2 = gamecfg.applyReadBack({ homeDir: S, saved: { fov: 80, maxFps: 250 } })
  assert.equal('fov' in r2.changed, false, 'cg_fov 95 is exactly what we seeded; the player changed nothing')
  assert.equal(r2.changed.maxFps, 125, 'com_maxfps 125 is not what we seeded, so it is a real in-game change')

  // A LATER read-back believes the player: 65 is only refused on the first one.
  fs.writeFileSync(path.join(S, 'players', 'profiles', gamecfg.PROFILE, 'config.cfg'), 'seta cg_fov "65"\r\n')
  const r3 = gamecfg.applyReadBack({ homeDir: S, saved: { fov: 80 } })
  assert.equal(r3.changed.fov, 65, 'a player who really picks 65 later is believed')
})

await test('the stock-defaults repair runs once per account and is idempotent', () => {
  settings.signOut()
  settings.signIn({ steamid: '76561190000000011', name: 'sixty' })
  settings.set({ maxFps: 60, fov: 65 })
  const lines = []
  const first = settings.migrate({ log: (l) => lines.push(l) })
  const after = settings.get('76561190000000011')
  assert.equal(after.maxFps, 250, 'back to the seeded baseline')
  assert.equal(after.fov, 80)
  assert.ok(first.ran.length, 'the migration reports what it changed')
  assert.ok(lines.join(' ').includes('maxFps 60 -> 250'), 'and says so in one line')
  // Idempotent: a player who then really chooses 60 keeps it.
  settings.set({ maxFps: 60 }, '76561190000000011')
  const second = settings.migrate({ log: () => {} })
  assert.equal(second.ran.length, 0, 'the marker stops it running twice')
  assert.equal(settings.get('76561190000000011').maxFps, 60, 'a real choice of 60 survives')
  settings.signOut()
})

await test('the ADS bind repair is once-only and never clobbers a player-changed bind', () => {
  // The engine's active profile is whatever active.txt names -- `$$$` on B's box, not
  // our `enw` -- and it held the stock `bind MOUSE2 "+toggleads_throw"`. seedHome()
  // will not revisit a config already at BASELINE_VERSION, so this has to.
  const H = path.join(process.env.ENW_ROOT, 'adsmigrate')
  const profiles = path.join(H, 'localappdata', 'Activision', 'CoDWaW', 'players', 'profiles')
  fs.mkdirSync(path.join(profiles, '$$$'), { recursive: true })
  fs.writeFileSync(path.join(profiles, 'active.txt'), '$$$')
  const engineCfg = path.join(profiles, '$$$', 'config.cfg')
  fs.writeFileSync(engineCfg, 'unbindall\r\nbind W "+forward"\r\nbind MOUSE2 "+toggleads_throw"\r\n')
  fs.mkdirSync(path.join(H, 'players', 'profiles', gamecfg.PROFILE), { recursive: true })

  // It reads active.txt rather than imposing our own profile name.
  assert.equal(gamecfg.configPaths(H).engineProfile, '$$$')
  assert.equal(gamecfg.configPaths(H).engineCfg, engineCfg)

  const r = gamecfg.migrateAdsBind({ homeDir: H })
  assert.equal(r.ran, true)
  assert.deepEqual(r.changed, [engineCfg])
  const text = fs.readFileSync(engineCfg, 'utf8')
  assert.match(text, /bind MOUSE2 "\+speed_throw"/)
  assert.doesNotMatch(text, /\+toggleads_throw/)
  assert.match(text, /bind W "\+forward"/, 'nothing else is touched')

  // Once only: a player who goes back to toggle in the Controls menu keeps it.
  fs.writeFileSync(engineCfg, 'bind MOUSE2 "+toggleads_throw"\r\n')
  const again = gamecfg.migrateAdsBind({ homeDir: H })
  assert.equal(again.ran, false)
  assert.match(fs.readFileSync(engineCfg, 'utf8'), /\+toggleads_throw/, 'a later choice of toggle survives')

  // And a bind that is not the stock toggle one is never rewritten, even on the first run.
  const H2 = path.join(process.env.ENW_ROOT, 'adskeep')
  const p2 = path.join(H2, 'localappdata', 'Activision', 'CoDWaW', 'players', 'profiles', gamecfg.PROFILE)
  fs.mkdirSync(p2, { recursive: true })
  fs.mkdirSync(path.join(H2, 'players', 'profiles', gamecfg.PROFILE), { recursive: true })
  fs.writeFileSync(path.join(p2, 'config.cfg'), 'bind MOUSE2 "+melee"\r\n')
  const keep = gamecfg.migrateAdsBind({ homeDir: H2 })
  assert.equal(keep.ran, true)
  assert.deepEqual(keep.changed, [], 'a player-changed bind is left exactly alone')
  assert.match(fs.readFileSync(path.join(p2, 'config.cfg'), 'utf8'), /\+melee/)
})

await test('r_multiGpu: the baseline pins 0 and a player who has two GPUs can still turn it on', async () => {
  // B, 2026-09-23 13:35: OFF fixed the invisible/garbled zombies on fear_mc_2 and most of
  // the stutter (mod-compat.md §10.4). 1 was the baseline from afc6276 until today.
  const fix = gamecfg.COMMUNITY_FIXES.find((f) => f.dvar === 'r_multiGpu')
  assert.equal(fix.value, '0')
  const base = new Map(gamecfg.baselineDvars({}, null))
  assert.equal(base.get('r_multiGpu'), '0', 'the launch line carries r_multiGpu 0')
  const wawcfg = await import('../src/main/wawcfg.js')
  const mine = wawcfg.launchDvars({ waw: { r_multiGpu: '1' } }, null)
  assert.deepEqual(mine.filter(([d]) => d === 'r_multiGpu'), [['r_multiGpu', '1']], 'a player\'s own 1 replaces the baseline, once')
})

await test('r_multiGpu repair: the old default 1 in config.cfg becomes 0 once, and a later 1 is the player\'s', async () => {
  const wawcfg = await import('../src/main/wawcfg.js')
  const H = path.join(process.env.ENW_ROOT, 'mgpu')
  const profiles = path.join(H, 'localappdata', 'Activision', 'CoDWaW', 'players', 'profiles')
  fs.mkdirSync(path.join(profiles, 'anna'), { recursive: true })
  fs.writeFileSync(path.join(profiles, 'active.txt'), 'anna')
  const engineCfg = path.join(profiles, 'anna', 'config.cfg')
  fs.writeFileSync(engineCfg, 'unbindall\r\nseta r_aaSamples "4"\r\nseta r_multiGpu "1"\r\nseta sm_enable "1"\r\ncon_hidechannel *\r\n')
  const plain = path.join(H, 'main', 'config.cfg')
  fs.mkdirSync(path.dirname(plain), { recursive: true })
  fs.writeFileSync(plain, 'set r_multigpu 1\r\n')
  // What the last launch wrote: the account snapshot the read-back compares against.
  const stampFile = wawcfg.accountStamp(H)
  assert.equal(stampFile, gamecfg.configPaths(H).account)
  fs.mkdirSync(path.dirname(stampFile), { recursive: true })
  fs.writeFileSync(stampFile, JSON.stringify({ dvars: { r_multigpu: '1', r_aasamples: '4' }, binds: {} }))

  const lines = []
  const r = gamecfg.migrateMultiGpu({ homeDir: H, log: (l) => lines.push(l) })
  assert.equal(r.ran, true)
  assert.deepEqual(r.changed.sort(), [engineCfg, plain].sort())
  const text = fs.readFileSync(engineCfg, 'utf8')
  assert.match(text, /^seta r_multiGpu "0"\r$/m)
  assert.match(text, /seta r_aaSamples "4"/, 'nothing else is touched')
  assert.match(text, /con_hidechannel \*/)
  assert.match(fs.readFileSync(plain, 'utf8'), /^set r_multigpu "0"/m)
  assert.equal(lines.length, 1)
  assert.ok(lines[0].startsWith('repair: r_multiGpu 1 -> 0 (old default)'), lines[0])
  // Our repair is not an in-game change: the snapshot moved with it.
  assert.equal(JSON.parse(fs.readFileSync(stampFile, 'utf8')).dvars.r_multigpu, '0')
  assert.equal(wawcfg.readBackAccount({ homeDir: H }).changed.waw, undefined, 'the read-back saw the repair as the player\'s change')

  // Once only: the player turns it back on in game (two real GPUs) and keeps it.
  fs.writeFileSync(engineCfg, text.replace('seta r_multiGpu "0"', 'seta r_multiGpu "1"'))
  const again = gamecfg.migrateMultiGpu({ homeDir: H, log: (l) => lines.push(l) })
  assert.equal(again.ran, false)
  assert.equal(lines.length, 1)
  assert.match(fs.readFileSync(engineCfg, 'utf8'), /seta r_multiGpu "1"/, 'a later choice of 1 survives')
  assert.equal(wawcfg.readBackAccount({ homeDir: H }).changed.waw.r_multiGpu, '1', 'and is read back as the player\'s')

  // It shares the marker file with the ADS repair without clobbering it.
  gamecfg.migrateAdsBind({ homeDir: H })
  const marks = JSON.parse(fs.readFileSync(gamecfg.configPaths(H).migrations, 'utf8')).done
  assert.ok(marks.includes('multigpu-off-2026-09-23') && marks.includes('ads-hold-2026-09-22'), JSON.stringify(marks))
})

await test('r_multiGpu repair: the saved account setting goes 1 -> 0 once, and an older site copy cannot bring it back', () => {
  const SID = '76561190000000012'
  settings.signOut()
  settings.signIn({ steamid: SID, name: 'twogpu' })
  // The account as the site left it before the fix (gameUpdatedAt from the past).
  settings.set({ waw: { r_multiGpu: '1', r_aaSamples: '4' }, gameUpdatedAt: 1700000000000 })
  const lines = []
  const m = settings.migrate({ log: (l) => lines.push(l) })
  assert.equal(settings.get(SID).waw.r_multiGpu, '0')
  assert.equal(settings.get(SID).waw.r_aaSamples, '4', 'nothing else is touched')
  assert.equal(settings.get(SID).gameUpdatedAt, 1700000000000, 'the repair does not make this copy "newer" than the site\'s')
  assert.ok(m.ran.some((x) => x.id === SID && x.name === 'multigpu-off-2026-09-23'))
  assert.ok(lines.some((l) => l.includes('repair: r_multiGpu 1 -> 0 (old default)')), lines.join(' | '))

  // The site's copy, still unmigrated and older than the repair, is pushed back in: held.
  settings.set({ waw: { r_multiGpu: '1' }, gameUpdatedAt: 1700000000001 })
  assert.equal(settings.get(SID).waw.r_multiGpu, '0', 'a pre-repair copy brought the old default back')

  // The player's own hand, after the repair: kept. From the launcher (no stamp) ...
  settings.set({ waw: { r_multiGpu: '1' } })
  assert.equal(settings.get(SID).waw.r_multiGpu, '1')
  // ... and from the site, stamped after the repair.
  settings.set({ waw: { r_multiGpu: '0' } })
  settings.set({ waw: { r_multiGpu: '1' }, gameUpdatedAt: Date.now() + 1000 })
  assert.equal(settings.get(SID).waw.r_multiGpu, '1')
  // And never repaired twice.
  const second = settings.migrate({ log: () => {} })
  assert.equal(second.ran.length, 0)
  assert.equal(settings.get(SID).waw.r_multiGpu, '1')
  settings.signOut()
})

await test('the launcher never takes focus from a running game', () => {
  // A focus flap makes the Q3-lineage engine deactivate the mouse and drop button
  // events; B played windowed, so our window is on the same desktop as the game.
  let shown = 0
  let focused = 0
  let running = false
  const win = { show: () => shown++, focus: () => focused++ }
  const r = focusguard.makeWindowRaiser({ win: () => win, busy: () => running })

  running = true
  const deferred = r.raise('a party deep link')
  assert.equal(deferred.deferred, true)
  assert.equal(shown, 0, 'the game keeps focus')
  assert.equal(focused, 0)
  // ...and it is not dropped: the window comes up once the game is gone.
  running = false
  r.flush()
  assert.equal(shown, 1)
  assert.equal(focused, 1)
  r.flush()
  assert.equal(shown, 1, 'flushing twice raises once')

  // With no game running a raise is immediate.
  r.raise('the Steam sign-in finishing')
  assert.equal(shown, 2)
  assert.equal(focused, 2)
})

await test('a deep link still routes while its window raise is deferred', () => {
  // main.js imports electron and cannot be loaded here, so this is the same contract
  // check the deep-link group already uses: the RAISE is deferred, the side effects
  // are not -- a party invite that arrives mid-game must still navigate the site view.
  const navigated = []
  const running = true
  const r = focusguard.makeWindowRaiser({ win: () => ({ show: () => {}, focus: () => {} }), busy: () => running })
  const handle = (link) => {
    const raised = r.raise('a deep link')
    if (link.kind === 'party') navigated.push(`/party/${link.party}`)
    return raised
  }
  const res = handle({ kind: 'party', party: '1234' })
  assert.equal(res.deferred, true)
  assert.deepEqual(navigated, ['/party/1234'], 'the party page is opened even though the window stayed down')
})

// ---------------------------------------------------------------------------

await test('0.2.10: the active profile is named after the ENW name (World at War shows the profile name)', () => {
  const home = path.join(paths.P.root, 'profile-home')
  const profs = path.join(home, 'localappdata', 'Activision', 'CoDWaW', 'players', 'profiles')
  fs.mkdirSync(path.join(profs, 'enw'), { recursive: true })
  fs.writeFileSync(path.join(profs, 'enw', 'config.cfg'), 'unbindall\r\nbind W "+forward"\r\nseta name "Unknown Soldier"\r\nseta cg_fov "65"\r\n')
  fs.writeFileSync(path.join(profs, 'enw', 'mpdata'), 'x')
  fs.writeFileSync(path.join(profs, 'active.txt'), 'enw')
  const r = gamecfg.usePlayerProfile({ homeDir: home, name: 'myu' })
  assert.equal(r.profile, 'myu'); assert.equal(r.changed, true); assert.equal(r.copiedFrom, 'enw')
  assert.equal(fs.readFileSync(path.join(profs, 'active.txt'), 'utf8'), 'myu')
  const cfg = fs.readFileSync(path.join(profs, 'myu', 'config.cfg'), 'utf8')
  assert.match(cfg, /bind W "\+forward"/, 'binds come along')
  assert.match(cfg, /seta name "myu"/); assert.doesNotMatch(cfg, /Unknown Soldier/)
  assert.ok(fs.existsSync(path.join(profs, 'myu', 'mpdata')))
  const again = gamecfg.usePlayerProfile({ homeDir: home, name: 'myu' })
  assert.equal(again.changed, false); assert.equal(again.copiedFrom, null)
  assert.equal(gamecfg.usePlayerProfile({ homeDir: home, name: '' }).profile, null)
  assert.equal(gamecfg.profileNameFor('ev\il";/..'), 'evil')
  assert.equal(gamecfg.profileNameFor('CON'), null)
  assert.equal(fs.readFileSync(path.join(profs, 'active.txt'), 'utf8'), 'myu')
})

await test('0.2.10: the shell strip is hidden while the site shows (its drag region won the nav hit test)', () => {
  const main = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  const css = String(fs.readFileSync(new URL('../src/renderer/shell.css', import.meta.url)))
  const html = String(fs.readFileSync(new URL('../src/renderer/shell.html', import.meta.url)))
  // Hiding the site shows the strip; showing the site goes through stripGone() (below).
  assert.match(main, /function showSite\(visible\)[\s\S]{0,300}setVisible\(false\)\s*\n\s*shellStrip\(true\)/)
  assert.match(css, /html\.site-shown #chrome \{ display: none; \}/)
  assert.match(html, /<html lang="en" class="site-shown">/)
})

await test('2026-09-23: after a game the nav is clickable at once -- strip hidden and painted BEFORE the site shows', () => {
  const main = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  const fn = main.slice(main.indexOf('function showSite(visible)'), main.indexOf('function shellStrip('))
  // The site view is made visible only inside stripGone().then(), and a later call wins.
  const show = fn.indexOf('stripGone().then(')
  assert.ok(show > 0, 'showSite(true) must wait for stripGone()')
  assert.ok(fn.indexOf('state.siteView.setVisible(true)', show) > show, 'setVisible(true) must come after the strip is gone')
  assert.match(fn, /if \(gen !== siteGen\) return/)
  // stripGone: the class, two frames and a settle in the shell, and a bound in main.
  assert.match(fn, /classList\.toggle\('site-shown', true\);[\s\S]{0,120}requestAnimationFrame\(\(\) => requestAnimationFrame\(/)
  assert.match(fn, /Promise\.race\(/)
  // The shell keeps painting while the site covers it (a hidden page sends no regions).
  assert.match(main, /preload: PRELOAD,[\s\S]{0,400}backgroundThrottling: false/)
})

// ------------------------------------------------------------------ 0.2.11 --
group('0.2.11: update chip, installed maps, Download')

await test('0.2.11: the launch-time check reaches the chip without downloading; Update now, Later, Restart', async () => {
  const fake = fakeUpdater()
  const { up } = mk({ loadUpdater: async () => ({ autoUpdater: fake }) })
  const seen = []
  up.on('status', (s) => seen.push(s))
  // attach() only listens: no checkForUpdates, no download.
  await up.attach()
  assert.equal(fake.calls.some((c) => c[0] === 'checkForUpdates'), false)
  // Before anything is found, Update now refuses rather than guessing.
  assert.match(up.download().refused || '', /no update has been found/)
  // The silent lane's check fires on the shared updater; the chip's machine hears it.
  fake.emit('update-available', { version: '0.2.11' })
  assert.equal(up.status().phase, 'available')
  assert.equal(up.status().available, '0.2.11')
  assert.equal(up.status().message, 'Update 0.2.11 available')
  assert.equal(fake.calls.some((c) => c[0] === 'downloadUpdate'), false)
  // Later hides it for the session and is in the status the page reads.
  assert.equal(up.later().later, true)
  up.download()
  await new Promise((r) => setImmediate(r))
  assert.equal(up.status().later, false, 'pressing Update now after Later brings the chip back')
  assert.equal(fake.calls.filter((c) => c[0] === 'downloadUpdate').length, 1)
  up.download() // a double press is still one download
  await new Promise((r) => setImmediate(r))
  assert.equal(fake.calls.filter((c) => c[0] === 'downloadUpdate').length, 1)
  fake.emit('update-downloaded', { version: '0.2.11' })
  assert.equal(up.status().canInstall, true)
  assert.equal(up.quitAndInstall().ok, true)
})

await test('0.2.11: the dev fake updater walks every phase (the screenshots were driven by it)', async () => {
  const f = updatecheck.fakeUpdater('9.9.9', { stepMs: 1 })
  const { up } = mk({ loadUpdater: async () => ({ autoUpdater: f }) })
  const phases = new Set()
  up.on('status', (s) => phases.add(s.phase))
  await up.check()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(up.status().phase, 'available')
  up.download()
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual([...phases], ['checking', 'available', 'downloading', 'ready'])
})

await test('0.2.11: the silent lane finds an update but leaves the download to the player', async () => {
  const { AutoUpdater } = await import('../src/main/autoupdate.js')
  const u = new AutoUpdater({ feedUrl: 'https://example.invalid', currentVersion: '0.2.10', gate: new updates.IdleGate(), backgroundDownload: false })
  assert.equal(u.backgroundDownload, false)
  const main = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  assert.match(main, /backgroundDownload: false/)
  assert.match(main, /updateCheck\(\)\.attach\(\)[\s\S]{0,80}state\.updater\.start\(\)/, 'the chip listens before the launch check runs')
  assert.match(main, /FAKE_UPDATE = !app\.isPackaged &&/, 'the fake updater can never run in a packaged app')
  assert.match(main, /handle\('restartAndUpdate'[\s\S]{0,200}blockers\.has\('game'\)/, 'Restart now refuses mid-game')
})

await test('0.2.11: installed maps are ENW\'s own installs only, measured on disk, largest first', async () => {
  const lib = await import('../src/main/library.js')
  const mk1 = (bsp, bytes, record = true) => {
    const d = lib.installDir(bsp)
    fs.mkdirSync(path.join(d, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(d, 'mod.ff'), Buffer.alloc(bytes))
    fs.writeFileSync(path.join(d, 'sub', 'x.iwd'), Buffer.alloc(10))
    if (record) fs.writeFileSync(path.join(d, '.enw-installed.json'), JSON.stringify({ bsp, title: bsp.toUpperCase(), files: [{ rel: 'mod.ff', size: bytes }, { rel: 'sub\\x.iwd', size: 10 }], bytes: bytes + 10 }))
  }
  mk1('zm_small_0211', 1000)
  mk1('zm_big_0211', 50000)
  mk1('zm_theirs_0211', 99999, false) // the player's own folder: never listed
  const list = lib.installedList().filter((m) => m.bsp.endsWith('_0211'))
  assert.deepEqual(list.map((m) => m.bsp), ['zm_big_0211', 'zm_small_0211'])
  assert.ok(list[0].bytes >= 50010, 'size is what is on disk, sub-folders included')
  assert.equal(list[0].title, 'ZM_BIG_0211')
  // Removal takes only what we recorded, and the list follows.
  lib.uninstall('zm_small_0211')
  assert.deepEqual(lib.installedList().filter((m) => m.bsp.endsWith('_0211')).map((m) => m.bsp), ['zm_big_0211'])
  assert.ok(fs.existsSync(path.join(lib.installDir('zm_theirs_0211'), 'mod.ff')), 'the player\'s folder is untouched')
  assert.match(lib.uninstall('zm_theirs_0211').join(' '), /yours/)
})

await test('0.2.11: the bridge carries the new calls, and the fallback page draws the update chip', () => {
  const pre = String(fs.readFileSync(new URL('../src/preload/preload.cjs', import.meta.url)))
  const main = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  for (const n of ['updateNow', 'updateLater', 'mapState', 'installedMaps', 'removeMaps']) {
    assert.match(pre, new RegExp(`${n}: \\(`), `preload: ${n}`)
    assert.match(main, new RegExp(`handle\\('${n}'`), `main: ${n}`)
  }
  assert.match(pre, /onMapState: \(fn\) => on\('mapState', fn\)/)
  const ph = String(fs.readFileSync(new URL('../src/renderer/placeholder.html', import.meta.url)))
  for (const w of ['Update now', 'Restart now', 'Later', 'enw.updateNow()', 'enw.updateLater()', 'enw.restartAndUpdate()', 'onUpdateStatus']) {
    assert.ok(ph.includes(w), `placeholder.html: ${w}`)
  }
  // removeMaps refuses a downloading map and anything mid-game.
  assert.match(main, /still downloading/)
  assert.match(main, /a game is running/)
})

await test('0.2.12+: the version is at least 0.2.12 and npm test runs both suites', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const [a, b, c] = String(pkg.version).split('.').map(Number)
  assert.ok(a > 0 || b > 2 || (b === 2 && c >= 12), `version ${pkg.version} is older than 0.2.12`)
  assert.match(pkg.scripts.test, /run-all\.js/)
  assert.match(pkg.scripts.test, /waw-settings\.js/)
})

group('Party follow: at most once per match (2026-09-23, the relaunch loop)')

const followgate = await import('../src/main/followgate.js')
const pollInGame = (id, state = 'in-game') => ({ state, map: { key: 'nazi_zombie_sumpf' }, party: { id: 7, is_leader: false }, match: { match_id: id, state: 'ready', connect: '1.2.3.4:28961' } })

await test('followgate: the poll after the game exits does NOT relaunch the same match (B\'s loop)', () => {
  const alive = new Set()
  const g = followgate.makeFollowGate({ isAlive: (pid) => alive.has(pid) })
  // Poll 1: somebody pressed Start -> follow.
  let d = g.decide(pollInGame('m_506fba68'), { flowRunning: false })
  assert.equal(d.follow, true, d.reason)
  g.noteLaunch(d.matchId, 'followed')
  const pids = new Set([4242]); alive.add(4242); g.watchPids(pids)
  // While the flow runs: no.
  assert.equal(g.decide(pollInGame('m_506fba68'), { flowRunning: true }).follow, false)
  // The flow gave up but the game is still up (a failed step clears state.flow): no.
  d = g.decide(pollInGame('m_506fba68'), { flowRunning: false })
  assert.equal(d.follow, false); assert.match(d.reason, /still running \(process 4242\)/)
  // A new match while our game is alive: still no.
  assert.equal(g.decide(pollInGame('m_other'), { flowRunning: false }).follow, false)
  // Steam restarted the game under a new pid (the nanny adopts it into the same Set).
  pids.add(5151); alive.add(5151); alive.delete(4242)
  assert.match(g.decide(pollInGame('m_506fba68')).reason, /process 5151/)
  // The game exits. The site still says in-game with the same match for minutes: never again.
  alive.delete(5151); g.noteEnded('m_506fba68')
  for (let i = 0; i < 60; i++) {
    d = g.decide(pollInGame('m_506fba68'), { flowRunning: false })
    assert.equal(d.follow, false, `poll ${i} relaunched`)
  }
  assert.match(d.reason, /already launched m_506fba68 \(followed, .*ended at .*only Play or Resume/)
  // The same decision has the same key, so main.js logs it once, not once per poll.
  assert.equal(g.decide(pollInGame('m_506fba68')).key, d.key)
})

await test('followgate: a NEW match is followed; Resume lifts the ledger for one match; no id, no launch', () => {
  const g = followgate.makeFollowGate({ isAlive: () => false })
  g.noteLaunch('m_a', 'Play'); g.noteEnded('m_a')
  assert.equal(g.decide(pollInGame('m_a')).follow, false)
  assert.equal(g.decide(pollInGame('m_b')).follow, true, 'the leader pressed Start again: new match id')
  assert.equal(g.allow('m_a'), true)
  assert.equal(g.decide(pollInGame('m_a')).follow, true, 'Resume sends the player back into m_a')
  const noId = pollInGame(null); delete noId.match.match_id
  assert.equal(g.decide(noId).follow, false)
  assert.equal(g.decide({ ...pollInGame('m_c'), state: 'idle' }).follow, false)
  assert.equal(g.decide({ ...pollInGame('m_c'), map: null }).follow, false)
  assert.equal(g.decide({ signedOut: true }).follow, false)
  for (const st of followgate.FOLLOW_STATES) assert.equal(g.decide(pollInGame('m_' + st, st)).follow, true, st)
})

await test('followgate: main.js follows through the gate, records every launch, refuses a launch beside a live game', () => {
  const main = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  assert.doesNotMatch(main, /if \(state\.flow \|\| !FOLLOW_STATES\.includes\(p\.state\)\) return/, 'the old level trigger is back')
  assert.match(main, /const d = followGate\.decide\(p, \{ flowRunning: !!state\.flow \}\)/)
  assert.match(main, /followGate\.noteLaunch\(d\.matchId, 'followed'\)[\s\S]{0,400}startPlay\(\{ map: bsp[^\n]*follow: true/)
  assert.match(main, /flow\.on\('update', noteMatch\)/)
  assert.match(main, /flow\.on\('launched', \(\) => followGate\.watchPids\(flow\.launch\?\.pids\)\)/)
  assert.match(main, /async function startPlay\(opts = \{\}\) \{[\s\S]{0,400}followGate\.gameAlive\(\)/)
  assert.match(main, /followGate\.noteEnded\(/)
  const pre = String(fs.readFileSync(new URL('../src/preload/preload.cjs', import.meta.url)))
  assert.match(pre, /resumeMatch: \(matchId\) => call\('resumeMatch', matchId\)/)
  assert.match(main, /handle\('resumeMatch'/)
})

// -------------------------------------------------------------- Steam gate --
group('Steam: started, waited for, and a Retry when it will not come (2026-09-23)')

const steamMod = await import('../src/main/steam.js')

// A fake Steam: a script of readings, one per poll, and a fake clock that the waits advance.
function fakeSteam(readings, { exe = 'C:\\Steam\\steam.exe' } = {}) {
  let t = 0
  let i = 0
  const states = []
  const started = []
  return {
    states, started,
    opts: {
      read: async () => readings[Math.min(i++, readings.length - 1)],
      findExe: async () => exe,
      start: (e) => { started.push(e) },
      onState: (s) => states.push(s.state),
      wait: async (ms) => { t += ms },
      now: () => t,
      timeouts: { startMs: 60_000, signInMs: 150_000, settleMs: 6_000, pollMs: 1_000 },
    },
    get t() { return t },
  }
}
const OFF = { running: false, signedIn: false }
const UP = { running: true, signedIn: false }
const IN = { running: true, signedIn: true }

await test('steam: already running and signed in -> no state shown, no start, no wait', async () => {
  const f = fakeSteam([IN])
  const r = await steamMod.ensureSteam(f.opts)
  assert.deepEqual(r, { ok: true, waited: false, started: false })
  assert.deepEqual(f.states, [])
  assert.deepEqual(f.started, [])
  assert.equal(f.t, 0)
})

await test('steam: closed -> starts it once, "starting" then "signin" then settles, then ok', async () => {
  const f = fakeSteam([OFF, OFF, UP, UP, IN])
  const r = await steamMod.ensureSteam(f.opts)
  assert.equal(r.ok, true)
  assert.equal(r.started, true)
  assert.deepEqual(f.started, ['C:\\Steam\\steam.exe'])
  assert.deepEqual(f.states, ['starting', 'signin', 'settling'])
  assert.ok(f.t >= 6_000, 'waits the settle time after a fresh sign-in')
})

await test('steam: up but ActiveUser 0 -> "signin" only, nothing started', async () => {
  const f = fakeSteam([UP, UP, IN])
  const r = await steamMod.ensureSteam(f.opts)
  assert.equal(r.ok, true)
  assert.deepEqual(f.started, [])
  assert.deepEqual(f.states, ['signin', 'settling'])
})

await test('steam: never comes up -> no_start after the start timeout, short message, no throw', async () => {
  const f = fakeSteam([OFF])
  const r = await steamMod.ensureSteam(f.opts)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no_start')
  assert.equal(r.message, steamMod.MSG.noStart)
  assert.ok(f.t >= 60_000 && f.t < 62_000, `gave up at ${f.t} ms`)
})

await test('steam: up but nobody signs in -> not_signed_in after the sign-in timeout', async () => {
  const f = fakeSteam([UP])
  const r = await steamMod.ensureSteam(f.opts)
  assert.equal(r.reason, 'not_signed_in')
  assert.equal(r.message, steamMod.MSG.notSignedIn)
  assert.ok(f.t >= 150_000 && f.t < 152_000, `gave up at ${f.t} ms`)
})

await test('steam: not installed -> not_installed at once; a read that throws counts as closed', async () => {
  const f = fakeSteam([OFF], { exe: null })
  const r = await steamMod.ensureSteam(f.opts)
  assert.equal(r.reason, 'not_installed')
  assert.equal(f.t, 0)
  const g = fakeSteam([IN])
  g.opts.read = async () => { throw new Error('reg.exe missing') }
  g.opts.findExe = async () => null
  assert.equal((await steamMod.ensureSteam(g.opts)).reason, 'not_installed')
})

await test('steam: a start that throws falls back to steam://open/main', async () => {
  const f = fakeSteam([OFF, IN])
  const urls = []
  const r = await steamMod.ensureSteam({ ...f.opts, start: () => { throw new Error('EACCES') }, openUrl: (u) => urls.push(u) })
  assert.equal(r.ok, true)
  assert.deepEqual(urls, ['steam://open/main'])
  const g = fakeSteam([OFF])
  assert.equal((await steamMod.ensureSteam({ ...g.opts, start: () => { throw new Error('x') } })).reason, 'no_start')
})

await test('steam: cancel while waiting stops the wait', async () => {
  const f = fakeSteam([UP])
  let n = 0
  const r = await steamMod.ensureSteam({ ...f.opts, cancelled: () => ++n > 3 })
  assert.equal(r.reason, 'cancelled')
  assert.ok(f.t < 10_000)
})

await test('steam: readState trusts ActiveUser only when the registry pid IS a running steam.exe', async () => {
  const q = (pid, user) => async () => ({ ok: true, values: { pid: { type: 'REG_DWORD', value: pid }, ActiveUser: { type: 'REG_DWORD', value: user } } })
  let s = await steamMod.readState({ query: q('0x2424', '0x9e5f0fa'), processes: async () => [9252] })
  assert.deepEqual(s, { running: true, signedIn: true, pid: 9252, user: 0x9e5f0fa })
  s = await steamMod.readState({ query: q('0x2424', '0x0'), processes: async () => [9252] })
  assert.equal(s.running, true); assert.equal(s.signedIn, false)
  // closed: no steam.exe, stale key
  s = await steamMod.readState({ query: q('0x2424', '0x9e5f0fa'), processes: async () => [] })
  assert.deepEqual(s, { running: false, signedIn: false, pid: 0, user: 0 })
  // a fresh start after a crash: new steam.exe, the key still names the old session
  s = await steamMod.readState({ query: q('0x2424', '0x9e5f0fa'), processes: async () => [777] })
  assert.equal(s.running, true); assert.equal(s.signedIn, false)
  // no key at all
  s = await steamMod.readState({ query: async () => ({ ok: false, values: {} }), processes: async () => [] })
  assert.equal(s.running, false)
})

await test('steam: steamExe prefers the client own SteamExe, then SteamPath, and normalises slashes', async () => {
  const vals = { SteamExe: 'c:/program files (x86)/steam/steam.exe', SteamPath: 'd:/steam' }
  const get = async (_k, n) => vals[n] || null
  assert.equal(await steamMod.steamExe({ get, exists: (p) => p === 'c:\\program files (x86)\\steam\\steam.exe' }), 'c:\\program files (x86)\\steam\\steam.exe')
  assert.equal(await steamMod.steamExe({ get, exists: (p) => p === 'd:\\steam\\steam.exe' }), 'd:\\steam\\steam.exe')
  assert.equal(await steamMod.steamExe({ get: async () => null, exists: () => false }), null)
})

await test('steam: the boot flow waits for Steam first, draws the step, then carries on', async () => {
  const f = new BootFlow({
    localMap: 'nazi_zombie_prototype', launch: false,
    steam: async ({ onState }) => { onState({ state: 'starting', message: 'Starting Steam...' }); onState({ state: 'signin', message: 'Waiting for Steam sign-in' }); return { ok: true, waited: true } },
  })
  const seen = []
  f.on('step', (s) => { if (s.id === 'steam') seen.push(`${s.state}:${s.detail}`) })
  const snap = await f.run()
  assert.deepEqual(seen, ['active:Starting Steam...', 'active:Waiting for Steam sign-in', 'done:signed in'])
  assert.equal(snap.failed, false)
  assert.equal(snap.retry, false)
  assert.ok(snap.steps.find((s) => s.id === 'ready'), 'the rest of the flow ran')
})

await test('steam: Steam fine -> no steam step at all; Steam failing -> one failed step, retry, nothing else ran', async () => {
  const ok = await new BootFlow({ localMap: 'x', launch: false, steam: async () => ({ ok: true, waited: false }) }).run()
  assert.equal(ok.steps.some((s) => s.id === 'steam'), false)

  let asked = false
  const api = { startPlay: async () => { asked = true; return { ok: true } } }
  const bad = await new BootFlow({ map: 'x', api, steam: async () => ({ ok: false, reason: 'not_signed_in', message: steamMod.MSG.notSignedIn }) }).run()
  assert.equal(asked, false, 'the site was never asked for a server')
  assert.equal(bad.failed, true)
  assert.equal(bad.retry, true)
  assert.equal(bad.steamFailed, 'Not signed in to Steam.')
  assert.deepEqual(bad.steps.map((s) => s.id), ['steam'])

  const thrown = await new BootFlow({ localMap: 'x', steam: async () => { throw new Error('boom\n    at stack') } }).run()
  assert.equal(thrown.steamFailed, steamMod.MSG.noStart, 'a throw becomes the plain message, never a stack')
})

await test('steam: the wording stays terse', () => {
  for (const [k, v] of Object.entries(steamMod.MSG)) assert.ok(v.length <= 36 && !/\n|error|exception/i.test(v), `${k}: "${v}"`)
  assert.equal(steamMod.MSG.starting, 'Starting Steam...')
  assert.equal(steamMod.MSG.signin, 'Waiting for Steam sign-in')
})

await test('steam: main.js gates Play on Steam, refuses a second game, skips the lease on a Steam failure, and wires Retry', () => {
  const main = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  assert.match(main, /steam: process\.env\.ENW_SKIP_STEAM_CHECK === '1' \? null[\s\S]{0,120}steam\.ensureSteam\(/)
  assert.match(main, /gameproc\.clearForPlay\([\s\S]{0,2000}throw new Error\(text\)/)
  assert.match(main, /if \(snap\.steamFailed\) \{[\s\S]{0,300}return\s*\}[\s\S]{0,200}AND THE LEASE HAS TO GO BACK/)
  assert.match(main, /handle\('retryPlay'[\s\S]{0,200}startPlay\(state\.lastPlayOpts\)/)
  const pre = String(fs.readFileSync(new URL('../src/preload/preload.cjs', import.meta.url)))
  assert.match(pre, /retryPlay: \(\) => call\('retryPlay'\)/)
  const shell = String(fs.readFileSync(new URL('../src/renderer/shell.js', import.meta.url)))
  assert.match(shell, /\$\('bootRetry'\)\.classList\.toggle\('on', !!snap\.retry\)/)
  assert.match(shell, /window\.enw\.retryPlay\(\)/)
  const html = String(fs.readFileSync(new URL('../src/renderer/shell.html', import.meta.url)))
  assert.match(html, /<button id="bootRetry">Retry<\/button>/)
})

await test('steam: play-cli checks Steam without starting it; allowStart:false never starts or waits', async () => {
  const f = fakeSteam([OFF])
  const r = await steamMod.ensureSteam({ ...f.opts, allowStart: false })
  assert.equal(r.reason, 'not_running'); assert.deepEqual(f.started, []); assert.equal(f.t, 0)
  const g = fakeSteam([UP])
  assert.equal((await steamMod.ensureSteam({ ...g.opts, allowStart: false })).reason, 'not_signed_in')
  const cli = String(fs.readFileSync(new URL('../src/main/play-cli.js', import.meta.url)))
  assert.match(cli, /steam: process\.env\.ENW_SKIP_STEAM_CHECK === '1' \? null : \(h\) => ensureSteam\(\{ \.\.\.h, allowStart: false \}\)/)
})

// ------------------------------------------------- no game before Steam, any path --
group('No CoDWaW.exe before the Steam check passes, from every entry point')

await test('order: a failing Steam check leaves every BootFlow path without a GameLaunch', async () => {
  const no = async () => ({ ok: false, reason: 'no_start', message: steamMod.MSG.noStart })
  let asked = 0
  const api = { startPlay: async () => { asked++; return { ok: true } } }
  const paths = {
    local: { localMap: 'nazi_zombie_prototype' },
    site: { map: 'x', api },
    follow: { map: 'x', api, follow: true },
    fallback: { map: 'x', siteUrl: 'http://127.0.0.1:9', requireSite: true },
  }
  for (const [name, o] of Object.entries(paths)) {
    const f = new BootFlow({ ...o, steam: no })
    const snap = await f.run()
    assert.equal(f.launch, null, `${name}: a GameLaunch was made`)
    assert.deepEqual(snap.steps.map((s) => s.id), ['steam'], `${name}: nothing ran after Steam`)
  }
  assert.equal(asked, 0)
})

await test('order: in bootflow.js the Steam gate is the first await of run(), before every new GameLaunch', () => {
  const src = String(fs.readFileSync(new URL('../src/main/bootflow.js', import.meta.url)))
  const run = src.slice(src.indexOf('  async run() {'))
  const firstAwait = run.indexOf('await ')
  assert.equal(run.indexOf('await this.steamGate()'), firstAwait, 'steamGate is the first await in run()')
  assert.ok(run.indexOf('await this.steamGate()') < run.indexOf('this.runLocal()'))
  assert.ok(run.indexOf('await this.steamGate()') < run.indexOf('this.runViaSite('))
  // GameLaunch is only ever built inside BootFlow: nothing else in the launcher spawns the game
  for (const f of ['main.js', 'deeplink.js', 'play-cli.js', 'localrun.js', 'hostagent.js']) {
    const s = String(fs.readFileSync(new URL(`../src/main/${f}`, import.meta.url)))
    assert.doesNotMatch(s, /new GameLaunch|\blaunch\(\{|spawn\([^)]*CoDWaW/i, `${f} starts the game itself`)
  }
})

await test('order: deep links (enw-zombies://map|party) navigate the site and never press Play', () => {
  const main = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  const body = main.slice(main.indexOf('function handleDeepLink(raw) {'), main.indexOf('function openSitePath('))
  assert.ok(body.length > 100)
  assert.doesNotMatch(body, /startPlay|playLocal|new BootFlow|retryPlay/, 'a deep link starts a launch')
  assert.match(body, /openSitePath\(`\/party\//)
  assert.match(body, /openSitePath\(`\/m\//)
  // and every launch goes through startPlay -> BootFlow with the steam gate wired
  assert.match(main, /new BootFlow\(\{[\s\S]{0,4000}steam: process\.env\.ENW_SKIP_STEAM_CHECK === '1' \? null/)
  assert.equal((main.match(/new BootFlow\(/g) || []).length, 1)
})

// ------------------------------------------------------ stuck vs live game --
group('A CoDWaW.exe already running: live (refuse) or stuck (end it and go on)')

const gameproc = await import('../src/main/gameproc.js')
const NOW = 1_000_000_000
const proc = (o = {}) => ({ pid: 100, createdAt: NOW - 5 * 60_000, commandLine: '"C:\\ENW\\game\\CoDWaW.exe" +set fs_game mods/enw', hasWindow: false, ...o })

await test('classify: a window, or ours and connected, is live; a dedicated server or the lock holder is never touched', () => {
  assert.equal(gameproc.classify(proc({ hasWindow: true }), { now: NOW }).kind, 'live')
  assert.equal(gameproc.classify(proc({ hasWindow: true }), { now: NOW, ours: { encrypted: true } }).kind, 'live', 'a window always wins')
  assert.equal(gameproc.classify(proc(), { now: NOW, ours: { connected: true } }).kind, 'live')
  assert.equal(gameproc.classify(proc({ commandLine: 'CoDWaW.exe +set dedicated 1 +map x' }), { now: NOW }).kind, 'other')
  assert.equal(gameproc.classify(proc(), { now: NOW, lockPid: 100 }).kind, 'other')
  assert.equal(gameproc.classify(proc({ createdAt: NOW - 10_000 }), { now: NOW }).kind, 'starting', 'inside the grace period')
})

await test('classify: ours with STILL ENCRYPTED, or no window past the grace period, is stuck', () => {
  assert.equal(gameproc.classify(proc({ createdAt: NOW - 1000 }), { now: NOW, ours: { encrypted: true } }).kind, 'stuck')
  const s = gameproc.classify(proc(), { now: NOW })
  assert.equal(s.kind, 'stuck'); assert.equal(s.ours, false); assert.match(s.why, /no window after 300 s, never connected/)
  assert.equal(gameproc.classify(proc({ createdAt: 0 }), { now: NOW }).kind, 'stuck', 'unknown start time counts as old')
})

await test('dllLogSaysEncrypted reads the DLL log in our logs folder', () => {
  const d = fs.mkdtempSync(path.join(TMP, 'logs-'))
  fs.writeFileSync(path.join(d, 'enw-4242.log'), '=== enw_t4 log ===\n[E] steamstub: STILL ENCRYPTED after 60000 ms. first dword 9EF490B8\n')
  fs.writeFileSync(path.join(d, 'enw-4243.log'), '[I] steamstub: decrypted after 97 ms\n')
  assert.equal(gameproc.dllLogSaysEncrypted(d, 4242), true)
  assert.equal(gameproc.dllLogSaysEncrypted(d, 4243), false)
  assert.equal(gameproc.dllLogSaysEncrypted(d, 1), false)
})

await test('clearForPlay: a stuck process is ended by pid (after a re-read) and Play goes on; the decision is logged', async () => {
  const lines = []
  const ended = []
  const r = await gameproc.clearForPlay({
    list: async () => [proc({ pid: 555 })],
    ctxFor: () => ({ now: NOW }),
    end: async (pid) => { ended.push(pid); return true },
    log: (l) => lines.push(l),
  })
  assert.equal(r.ok, true); assert.deepEqual(r.killed, [555]); assert.deepEqual(ended, [555])
  assert.ok(lines.some((l) => /555: stuck/.test(l)) && lines.some((l) => /555: ended/.test(l)), lines.join(' | '))
})

await test('clearForPlay: a live game blocks and nothing is ended; a window appearing before the kill saves it', async () => {
  const ended = []
  const end = async (pid) => { ended.push(pid); return true }
  let r = await gameproc.clearForPlay({ list: async () => [proc({ pid: 1, hasWindow: true }), proc({ pid: 2 })], ctxFor: () => ({ now: NOW }), end })
  assert.equal(r.ok, false); assert.equal(r.blocking.proc.pid, 1); assert.equal(r.blocking.kind, 'live'); assert.deepEqual(ended, [])
  let n = 0
  r = await gameproc.clearForPlay({ list: async () => [proc({ pid: 3, hasWindow: n++ > 0 })], ctxFor: () => ({ now: NOW }), end })
  assert.equal(r.ok, false); assert.equal(r.blocking.kind, 'live'); assert.deepEqual(ended, [])
  r = await gameproc.clearForPlay({ list: async () => [proc({ pid: 4, createdAt: NOW - 5000 })], ctxFor: () => ({ now: NOW }), end })
  assert.equal(r.blocking.kind, 'starting'); assert.deepEqual(ended, [])
  r = await gameproc.clearForPlay({ list: async () => null, end })
  assert.equal(r.unknown, true); assert.deepEqual(ended, [])
  r = await gameproc.clearForPlay({ list: async () => [proc({ pid: 5 })], ctxFor: () => ({ now: NOW }), end: async () => false })
  assert.equal(r.ok, false); assert.equal(r.blocking.endFailed, true)
  r = await gameproc.clearForPlay({ list: async () => [], end })
  assert.equal(r.ok, true); assert.deepEqual(r.killed, [])
})

await test('parseList: PowerShell output, one object or many, and junk', () => {
  assert.deepEqual(gameproc.parseList('{"pid":7,"created":123,"cmd":"x","win":0}'), [{ pid: 7, createdAt: 123, commandLine: 'x', hasWindow: false }])
  assert.equal(gameproc.parseList('[{"pid":7,"created":1,"cmd":"","win":656}]')[0].hasWindow, true)
  assert.deepEqual(gameproc.parseList('[]'), [])
  assert.equal(gameproc.parseList('garbage'), null)
})

await test('main.js: classifies before refusing, offers End game only for a game it started, ends only its own from the toast', () => {
  const main = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  assert.match(main, /gameproc\.clearForPlay\(\{[\s\S]{0,300}ours: ourGame\(p\.pid, p\.createdAt\)/)
  assert.match(main, /const oursPid = b && started\(b\.proc\.pid\)/)
  assert.match(main, /action: \{ label: 'End game', call: 'endGame', arg: oursPid \}/)
  assert.match(main, /handle\('endGame'[\s\S]{0,200}state\.launches[\s\S]{0,120}if \(!l\) throw new Error\('Not a game this launcher started\.'\)/)
  const shell = String(fs.readFileSync(new URL('../src/renderer/shell.js', import.meta.url)))
  assert.match(shell, /action\.call === 'endGame'/)
  assert.match(shell, /toast\(t\.text, t\.kind, t\.action\)/)
})

// ------------------------------------------------------------- volume (bug 15) --
group('Volume is snd_menu_master, not snd_volume (bug 15)')

await test('volume: the account volume goes out as snd_menu_master, never snd_volume, and comes back from it', async () => {
  const pairs = gamecfg.baselineDvars({ volume: 0.4 }, null)
  const m = new Map(pairs)
  assert.equal(m.get('snd_menu_master'), '0.4')
  assert.equal(m.has('snd_volume'), false)
  const back = gamecfg.settingsFromConfig(gamecfg.parseConfigCfg('seta snd_menu_master "0.25"\r\nseta snd_volume "0.9"\r\n'))
  assert.equal(back.volume, 0.25)
  assert.equal(gamecfg.settingsFromConfig(gamecfg.parseConfigCfg('seta snd_volume "0.9"\r\n')).volume, undefined, 'snd_volume is not read')
  const wawcfg = await import('../src/main/wawcfg.js')
  const lines = wawcfg.accountConfigLines({ volume: 0.4 }, null)
  assert.ok(lines.pairs.some(([d, v]) => d === 'snd_menu_master' && v === '0.4'), 'the volume reaches config.cfg, which beats +set')
  // the site's own master slider still wins over the launcher's volume, in place
  const both = new Map(wawcfg.launchDvars({ volume: 0.4, waw: { snd_menu_master: '0.7' } }, null))
  assert.equal(both.get('snd_menu_master'), '0.7')
  const modcompat = await import('../src/main/modcompat.js')
  assert.ok(modcompat.MANAGED_DVARS.has('snd_menu_master'))
  assert.equal(modcompat.MANAGED_DVARS.has('snd_volume'), false)
})

await test('volume: every sound dvar the launcher or site writes is registered by the exe (dump check when present)', () => {
  const src = String(fs.readFileSync(new URL('../src/main/gamecfg.js', import.meta.url)))
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /'snd_volume'/, 'no code path writes snd_volume')
  const SOUND = ['snd_menu_master', 'snd_menu_voice', 'snd_menu_music', 'snd_menu_sfx', 'snd_cinematicVolumeScale', 'snd_losOcclusion']
  const dump = process.env.ENW_T4_DUMP || 'C:\\Users\\b\\ZombiesDev\\dumps\\codwaw-1.7-a.exe'
  if (!fs.existsSync(dump)) { console.log('         (no decrypted dump on this machine; name check only)'); return }
  const b = fs.readFileSync(dump)
  // A registered dvar's name is loaded as `mov edi, <name>` (BF imm32) in the sound init;
  // snd_volume's name is only ever referenced from data.
  const regRef = (name) => {
    const off = b.indexOf(Buffer.from(`\0${name}\0`)) + 1
    if (off <= 0) return false
    const va = Buffer.alloc(4); va.writeUInt32LE(0x400000 + off)
    for (let i = b.indexOf(va); i >= 0; i = b.indexOf(va, i + 1)) if (b[i - 1] === 0xBF) return true
    return false
  }
  for (const d of SOUND) assert.ok(regRef(d), `${d} is registered`)
  assert.equal(regRef('snd_volume'), false, 'snd_volume is never registered')
})

// ------------------------------------------------------------ attention (SOC) --
// Flash, chime, toast, unread dot for invites / DMs / party chat while the window is not in
// front (attention.js). A mocked BrowserWindow: the Electron half is main.js setupAttention.
group('Attention: flash, chime, toast (lane SOC)')
const attention = await import('../src/main/attention.js')

function fakeWin({ visible = true, minimized = false, focused = false } = {}) {
  const w = { visible, minimized, focused, flashes: [] }
  w.isVisible = () => w.visible
  w.isMinimized = () => w.minimized
  w.isFocused = () => w.focused
  w.isDestroyed = () => false
  w.flashFrame = (f) => w.flashes.push(f)
  return w
}
function rig({ win, game = false, sound = true, streamer = false } = {}) {
  const r = { chimes: 0, toasts: [], badges: [], t: 1_000_000 }
  r.a = attention.makeAttention({
    win: () => win, gameRunning: () => game, soundOn: () => sound, streamer: () => streamer,
    chime: () => { r.chimes++ }, toast: (x) => r.toasts.push(x), badge: (n) => r.badges.push(n), now: () => r.t,
  })
  return r
}

await test('attention: a focused window is left alone (the site shows its own toast)', () => {
  const w = fakeWin({ focused: true })
  const r = rig({ win: w })
  assert.equal(r.a.signal({ kind: 'invite', id: 'invite:1', invite_id: 1, title: 't' }).skipped, 'focused')
  assert.deepEqual([w.flashes, r.chimes, r.toasts.length, r.badges], [[], 0, 0, []])
})

await test('attention: minimised -> flashFrame(true), one chime, a toast with the invite id, unread dot', () => {
  const w = fakeWin({ minimized: true })
  const r = rig({ win: w })
  const out = r.a.signal({ kind: 'invite', id: 'invite:7', invite_id: 7, title: 'deadshot invited you', body: 'Party on Der Riese' })
  assert.deepEqual(w.flashes, [true])
  assert.equal(r.chimes, 1)
  assert.equal(r.toasts.length, 1)
  assert.equal(r.toasts[0].invite_id, 7)
  assert.equal(r.toasts[0].title, 'deadshot invited you')
  assert.deepEqual(r.badges, [1])
  assert.equal(out.unread, 1)
})

await test('attention: a chat burst is one chime; the flash and the count still move; a quiet gap chimes again', () => {
  const w = fakeWin({ visible: true, focused: false })
  const r = rig({ win: w })
  r.a.signal({ kind: 'party', id: 'chat:1', title: 'x' }); r.t += 1500
  r.a.signal({ kind: 'party', id: 'chat:2', title: 'x' }); r.t += 1500
  r.a.signal({ kind: 'dm', id: 'chat:3', title: 'x' })
  assert.equal(r.chimes, 1, 'one chime for three lines 1.5 s apart')
  assert.equal(w.flashes.length, 3)
  assert.deepEqual(r.badges, [1, 2, 3])
  assert.equal(r.toasts.length, 0, 'no toast for chat while the window has a taskbar button')
  r.t += attention.BURST_MS + 1
  r.a.signal({ kind: 'dm', id: 'chat:4', title: 'x' })
  assert.equal(r.chimes, 2, 'a new burst chimes')
})

await test('attention: a long conversation still chimes every MAX_QUIET_MS', () => {
  const r = rig({ win: fakeWin({ minimized: true }) })
  for (let i = 0; i < 20; i++) { r.a.signal({ kind: 'party', id: `c${i}` }); r.t += 2000 }
  assert.equal(r.chimes, 2, `20 lines 2 s apart over 40 s: ${r.chimes}`)
})

await test('attention: Notification sound off -> flash, dot and toast, no chime', () => {
  const w = fakeWin({ minimized: true })
  const r = rig({ win: w, sound: false })
  const out = r.a.signal({ kind: 'invite', id: 'invite:2', invite_id: 2 })
  assert.equal(r.chimes, 0)
  assert.equal(out.flashed, true)
  assert.equal(r.toasts.length, 1)
})

await test('attention: a game running -> nothing at all (the in-game overlay has it)', () => {
  const w = fakeWin({ visible: true })
  const r = rig({ win: w, game: true })
  assert.equal(r.a.signal({ kind: 'dm', id: 'chat:9' }).skipped, 'in game')
  assert.deepEqual([w.flashes, r.chimes, r.badges], [[], 0, []])
})

await test('attention: in the tray -> no flash (no button), a DM toasts once per burst', () => {
  const w = fakeWin({ visible: false, minimized: false })
  const r = rig({ win: w })
  r.a.signal({ kind: 'dm', id: 'chat:20', title: 'staminup messaged you', body: 'gl' }); r.t += 500
  r.a.signal({ kind: 'dm', id: 'chat:21', title: 'staminup messaged you', body: 'hf' })
  assert.deepEqual(w.flashes, [])
  assert.equal(r.toasts.length, 1)
  assert.equal(r.chimes, 1)
})

await test('attention: own lines and double deliveries are refused', () => {
  const r = rig({ win: fakeWin({ minimized: true }) })
  assert.equal(r.a.signal({ kind: 'dm', id: 'chat:5', self: true }).skipped, 'own message')
  r.a.signal({ kind: 'dm', id: 'chat:6' })
  assert.equal(r.a.signal({ kind: 'dm', id: 'chat:6' }).skipped, 'duplicate')
  assert.equal(r.a.signal({ kind: 'friend' }).skipped, 'unknown kind')
})

await test('attention: coming to the front stops the flash and clears the dot', () => {
  const w = fakeWin({ minimized: true })
  const r = rig({ win: w })
  r.a.signal({ kind: 'dm', id: 'chat:30' })
  r.a.focused()
  assert.deepEqual(w.flashes, [true, false])
  assert.deepEqual(r.badges, [1, 0])
  assert.equal(r.a.unread, 0)
})

await test('attention: streamer mode hides who and what', () => {
  const r = rig({ win: fakeWin({ minimized: true }), streamer: true })
  r.a.signal({ kind: 'invite', id: 'invite:3', invite_id: 3, title: 'deadshot invited you', body: 'Party on Der Riese' })
  assert.equal(r.toasts[0].title, 'You have a party invite')
  assert.doesNotMatch(JSON.stringify(r.toasts[0]), /deadshot|Riese/)
})

await test('attention: the toast XML accepts by protocol, is silent, and escapes', () => {
  const x = attention.toastXml({ kind: 'invite', title: '<b>"x"&', body: "it's", invite_id: 42 })
  assert.match(x, /arguments="enw-zombies:\/\/invite\/42"/)
  assert.match(x, /<audio silent="true"\/>/)
  assert.match(x, /&lt;b&gt;&quot;x&quot;&amp;/)
  assert.doesNotMatch(x, /<b>/)
  assert.doesNotMatch(attention.toastXml({ kind: 'dm', title: 'a', body: 'b' }), /<actions>/)
  assert.deepEqual({ ...deeplink.parse('enw-zombies://invite/42'), url: undefined }, { kind: 'invite', invite: 42, url: undefined })
  assert.equal(deeplink.parse('enw-zombies://invite/42;rm').kind, 'home')
  assert.equal(deeplink.parse('enw-zombies://open').kind, 'home')
})

await test('attention: the unread dot paints red into the tray bitmap, alpha on', () => {
  const w = 16, h = 16
  const out = attention.dotBitmap(Buffer.alloc(w * h * 4), w, h, { bgra: true })
  const r = Math.max(2, Math.round(16 * 0.22)); const cx = w - r - 1, cy = r + 1
  const i = (cy * w + cx) * 4
  assert.deepEqual([out[i], out[i + 1], out[i + 2], out[i + 3]], [45, 55, 225, 255])
  assert.equal(out[0 + 3], 0, 'a far corner untouched')
})

await test('attention: wired -- site view unthrottled, IPC + preload + chime + setting present', () => {
  const main = String(fs.readFileSync(new URL('../src/main/main.js', import.meta.url)))
  assert.match(main, /preload: PRELOAD, sandbox: false, backgroundThrottling: false \}/, 'the site view keeps running in the tray')
  assert.match(main, /handle\('attention'/)
  assert.match(main, /win\.on\('focus', \(\) => state\.attention\?\.focused\(\)\)/)
  const pre = String(fs.readFileSync(new URL('../src/preload/preload.cjs', import.meta.url)))
  assert.match(pre, /attention: \(ev\) => call\('attention', ev\)/)
  const shell = String(fs.readFileSync(new URL('../src/renderer/shell.js', import.meta.url)))
  assert.match(shell, /onChime\(\(\) => chime\(\)\)/)
  assert.equal(settings.DEFAULT_SETTINGS.notifySound, true, 'on by default')
  assert.ok(settings.GAME_KEYS.includes('notifySound'), 'synced with the site copy')
  assert.equal(settings.validate({ notifySound: false }).patch.notifySound, false)
  assert.equal(settings.validate({ notifySound: 'yes' }).patch.notifySound, true)
})

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
