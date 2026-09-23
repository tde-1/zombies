#!/usr/bin/env node
// The site's Settings page (web /settings, WaW's Options menus) -> the launcher -> the game.
//
// The proof B asked for: "given saved settings, the generated config / +set list contains
// X". Each test starts from the SITE's own shape, pushed through the site's own
// toLauncherPatch() (web/client/src/data/wawSettings.js) exactly as the page does it, then
// through settings.set() / settings.get() exactly as the preload bridge does it, and reads
// what the launch would put on the command line and into the engine's config.cfg.
//
//   node test/waw-settings.js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'enw-waw-test-'))
process.env.ENW_ROOT = path.join(TMP, 'enwroot')
process.env.ENW_DEV_ROOT = path.join(TMP, 'nodevbox')
process.env.ENW_NO_DISPLAY_PROBE = '1'

const settings = await import('../src/main/settings.js')
const launch = await import('../src/main/launch.js')
const gamecfg = await import('../src/main/gamecfg.js')
const wawcfg = await import('../src/main/wawcfg.js')
const site = await import('../../web/client/src/data/wawSettings.js')

let pass = 0
let fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`) } catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message}`) }
}

const DISPLAY = { id: 'd1', index: 0, x: 0, y: 0, width: 2560, height: 1440, refresh: 144, primary: true }
const SID = '76561190000000001' // a demo id, never a real account

// What the page saves: a `game` object built with the page's own helpers.
function siteGame(edit) {
  let g = site.allDefaults()
  g = edit(g)
  g.updatedAt = 1_758_500_000_000
  return g
}
const argsOf = (s) => launch.settingsArgs(s, DISPLAY)
const plusSet = (args) => {
  const m = new Map()
  for (let i = 0; i < args.length; i++) if (args[i] === '+set') m.set(args[i + 1], (m.get(args[i + 1]) || []).concat(args[i + 2]))
  return m
}
const item = (id) => site.ALL.find((i) => i.id === id)

console.log('\nWaW settings: the site -> the launcher -> the launch')

await test('every site item maps to a dvar or command the launcher whitelists, and back', () => {
  for (const it of site.ALL) {
    if (it.to === 'waw') {
      assert.ok(wawcfg.WAW_DVARS[it.dvar], `${it.label}: ${it.dvar} is not in wawcfg.WAW_DVARS`)
      for (const o of it.options || []) if (o.value !== '') assert.notEqual(wawcfg.checkValue(it.dvar, o.value), undefined, `${it.label}: option ${o.label}=${o.value} fails the launcher check`)
      if (it.def !== null && it.def !== '') assert.notEqual(wawcfg.checkValue(it.dvar, it.def), undefined, `${it.label}: default ${it.def} fails the launcher check`)
      for (const extra of Object.values(it.also || {})) for (const [d, v] of Object.entries(extra)) assert.notEqual(wawcfg.checkValue(d, v), undefined, `${it.label}: ${d}=${v}`)
    }
    if (it.to === 'bind') assert.ok(wawcfg.BIND_COMMANDS.includes(it.command), `${it.label}: ${it.command} is not a whitelisted command`)
    if (it.to.startsWith('key:')) assert.ok(it.to.slice(4) in settings.DEFAULT_SETTINGS, `${it.label}: ${it.to} is not a launcher setting`)
    assert.ok(it.src && it.src.length > 10, `${it.label} has no source`)
  }
  const siteDvars = new Set(site.ALL.filter((i) => i.to === 'waw').flatMap((i) => [i.dvar, ...Object.values(i.also || {}).flatMap(Object.keys)]))
  for (const d of Object.keys(wawcfg.WAW_DVARS)) assert.ok(siteDvars.has(d), `the launcher whitelists ${d} but the site offers no item for it`)
  for (const c of wawcfg.BIND_COMMANDS) assert.ok(site.BINDS.some((b) => b.command === c), `the launcher whitelists ${c} but the site offers no bind row`)
})

await test('no WaW-menu dvar changes what the game simulates (ai_corpseCount is the one, and it is corpse clean-up only)', () => {
  const forbidden = /^(g_|sv_|zombie|perk|player_|jump_|bg_|ai_|cg_gun|timescale)/i
  const hits = Object.keys(wawcfg.WAW_DVARS).filter((d) => forbidden.test(d))
  assert.deepEqual(hits, ['ai_corpseCount'])
})

await test('a value saved on the site reaches the +set list (texture mipmaps, corpses, brightness, master volume)', () => {
  settings.signIn({ steamid: SID, name: 'tester' })
  let g = siteGame((x) => x)
  g = site.withValue(g, item('r_texFilterMipMode'), 'Force Trilinear')
  g = site.withValue(g, item('ai_corpseCount'), '20')
  g = site.withValue(g, item('r_gamma'), '1.4')
  g = site.withValue(g, item('snd_menu_master'), '0.6')
  settings.set(site.toLauncherPatch(g), SID)
  const s = settings.get(SID)
  const m = plusSet(argsOf(s))
  assert.deepEqual(m.get('r_texFilterMipMode'), ['Force Trilinear'])
  assert.deepEqual(m.get('ai_corpseCount'), ['20'])
  assert.deepEqual(m.get('r_gamma'), ['1.4'])
  assert.deepEqual(m.get('snd_menu_master'), ['0.6'])
})

await test('a saved value REPLACES the bundled fix for the same dvar (one r_texFilterAnisoMin, the player\'s)', () => {
  let g = site.allDefaults()
  g = site.withValue(g, item('r_texFilterAnisoMin'), '8')
  g.updatedAt = 2
  settings.set(site.toLauncherPatch(g), SID)
  const m = plusSet(argsOf(settings.get(SID)))
  assert.deepEqual(m.get('r_texFilterAnisoMin'), ['8'], 'exactly once, the saved value')
  assert.deepEqual(m.get('r_mode'), ['2560x1440'], 'r_mode still once (the borderless test in run-all.js)')
})

await test('"game default" takes the dvar off the command line and puts `reset <dvar>` in config.cfg', () => {
  // Shadows' game default is the game's own (Set Recommended is hardware-dependent).
  let g = site.allDefaults()
  assert.equal(site.valueOf(g, item('sm_enable')), null)
  g.updatedAt = 3
  settings.set(site.toLauncherPatch(g), SID)
  const s = settings.get(SID)
  const m = plusSet(argsOf(s))
  assert.equal(m.has('sm_enable'), false, 'the bundled sm_enable 1 is dropped, not forced')
  const lines = wawcfg.accountConfigLines(s, DISPLAY)
  assert.ok(lines.resets.includes('sm_enable'))
  const cfg = wawcfg.mergeAccountIntoConfig('seta sm_enable "1"\r\ncon_hidechannel *\r\n', lines)
  assert.match(cfg, /^reset sm_enable$/m)
  assert.doesNotMatch(cfg, /seta sm_enable/)
})

await test('launcher keys from the page reach their own dvars (Sync Every Frame, sensitivity, FOV, Max FPS, Show FPS, windowed 1920x1080)', () => {
  let g = site.allDefaults()
  g = site.withValue(g, item('vsync'), true)
  g = site.withValue(g, item('sensitivity'), 2.5)
  g = site.withValue(g, item('fov'), 95)
  g = site.withValue(g, item('maxFps'), 125)
  g = site.withValue(g, item('showFps'), true)
  g = site.withValue(g, item('mode'), 'windowed')
  g = site.withValue(g, item('resolution'), '1920x1080')
  g.updatedAt = 4
  settings.set(site.toLauncherPatch(g), SID)
  const m = plusSet(argsOf(settings.get(SID)))
  assert.deepEqual(m.get('r_vsync'), ['1'])
  assert.deepEqual(m.get('sensitivity'), ['2.5'])
  assert.deepEqual(m.get('cg_fov'), ['95'])
  assert.deepEqual(m.get('com_maxfps'), ['125'])
  assert.deepEqual(m.get('cg_drawFPS'), ['Simple'])
  assert.deepEqual(m.get('r_fullscreen'), ['0'])
  assert.deepEqual(m.get('r_mode'), ['1920x1080'])
  assert.equal(m.has('r_noborder'), false, 'windowed is not borderless')
})

await test('Invert Mouse writes both ui_mousePitch and m_pitch, as the menu\'s uiScript does; Mature writes cg_blood with it', () => {
  let g = site.allDefaults()
  g = site.withValue(g, item('ui_mousePitch'), '1')
  g = site.withValue(g, item('cg_mature'), '1')
  const p = site.toLauncherPatch(g)
  assert.equal(p.waw.ui_mousePitch, '1')
  assert.equal(p.waw.m_pitch, '-0.022')
  assert.equal(p.waw.cg_blood, '1')
  g = site.withValue(g, item('ui_mousePitch'), '0')
  assert.equal(site.toLauncherPatch(g).waw.m_pitch, '0.022')
})

await test('the launcher refuses what the game\'s menus do not offer', () => {
  const r = settings.validate({ waw: { r_gamma: '9', g_speed: '400', ai_corpseCount: '7', r_aspectRatio: 'WIDE 16:9', m_pitch: '0.5' }, wawBinds: { 'kill': ['K'], '+forward': ['UPARROW', 'W', 'Z'], '+back': ['ESCAPE'] } })
  assert.deepEqual(r.patch.waw, { r_aspectRatio: 'wide 16:9' })
  assert.deepEqual(r.patch.wawBinds, { '+forward': ['UPARROW', 'W'], '+back': [] })
  assert.ok(r.notes.length >= 5)
})

await test('the page\'s edits bump gameUpdatedAt only when the site says so; the launcher\'s own edits stamp now', () => {
  const before = Date.now()
  const s = settings.set({ fov: 90 }, SID)
  assert.ok(s.gameUpdatedAt >= before, 'a launcher-side change is newer than the site')
  const s2 = settings.set({ fov: 91, gameUpdatedAt: 123 }, SID)
  assert.equal(s2.gameUpdatedAt, 123)
  assert.equal(site.newer({ updatedAt: 500 }, { gameUpdatedAt: 123 }), 'site')
  assert.equal(site.newer({ updatedAt: 5 }, { gameUpdatedAt: 123 }), 'launcher')
})

await test('the read-back merges key by key: a partial waw patch does not wipe the rest', () => {
  settings.set({ waw: { r_gamma: '1.2', fx_marks: '0' }, gameUpdatedAt: 10 }, SID)
  settings.set({ waw: { fx_marks: '1' } }, SID)
  const s = settings.get(SID)
  assert.equal(s.waw.r_gamma, '1.2')
  assert.equal(s.waw.fx_marks, '1')
  settings.set({ waw: { r_gamma: '' } }, SID)
  assert.equal('r_gamma' in settings.get(SID).waw, false, "'' removes the override")
})

// ---- the config.cfg the ENGINE reads ------------------------------------------------------

function fakeHome(name) {
  const home = path.join(process.env.ENW_ROOT, name)
  const p = gamecfg.configPaths(home)
  fs.mkdirSync(p.engineProfileDir, { recursive: true })
  // A slice of a real engine-written config.cfg (ZombiesDev\homes\d2, 2026-09-22).
  fs.writeFileSync(p.engineCfg, [
    'unbindall',
    'bind TAB "+scores"',
    'bind W "+forward"',
    'bind UPARROW "+forward"',
    'bind MOUSE2 "+speed_throw"',
    'bind F "+activate"',
    'seta ai_corpseCount "5"',
    'seta r_texFilterMipMode "Unchanged"',
    'seta r_gamma "1"',
    'seta sm_enable "1"',
    'seta snd_menu_master "1"',
    'seta cg_fov "80"',
    'seta some_unrelated_dvar "keep me"',
    'con_hidechannel *',
    '',
  ].join('\r\n'))
  return { home, p }
}

await test('every launch merges the account into the config the engine reads; unrelated lines survive; con_hidechannel stays last', () => {
  const { home, p } = fakeHome('home1')
  let g = site.allDefaults()
  g = site.withValue(g, item('ai_corpseCount'), '32')
  g = site.withValue(g, item('r_texFilterMipMode'), 'Force Bilinear')
  g = site.withValue(g, item('fov'), 100)
  g = site.withValue(g, item('bind:+forward'), ['I'])
  g = site.withValue(g, item('bind:+activate'), ['E']) // E was Lean Right: taking it frees it
  g.updatedAt = 20
  settings.set(site.toLauncherPatch(g), SID)
  const r = wawcfg.applyAccountToConfig({ homeDir: home, settings: settings.get(SID), display: DISPLAY })
  assert.equal(r.wrote[0], p.engineCfg)
  const cfg = fs.readFileSync(p.engineCfg, 'utf8')
  assert.match(cfg, /^seta ai_corpseCount "32"$/m)
  assert.match(cfg, /^seta r_texFilterMipMode "Force Bilinear"$/m)
  assert.match(cfg, /^seta cg_fov "100"$/m)
  assert.match(cfg, /^bind I "\+forward"$/m)
  assert.doesNotMatch(cfg, /^bind W "\+forward"$/m, 'the old key for Forward is released, as the menu does')
  assert.doesNotMatch(cfg, /^bind UPARROW "\+forward"$/m)
  assert.match(cfg, /^bind E "\+activate"$/m)
  assert.doesNotMatch(cfg, /^bind F "\+activate"$/m)
  assert.match(cfg, /^bind MOUSE2 "\+speed_throw"$/m, 'ADS stays on hold')
  assert.match(cfg, /^seta some_unrelated_dvar "keep me"$/m)
  assert.match(cfg, /^unbindall$/m)
  assert.match(cfg.trimEnd(), /con_hidechannel \*$/)
  assert.equal((cfg.match(/ai_corpseCount/gi) || []).length, 1, 'one line per dvar')
  assert.equal(site.valueOf(g, item('bind:+leanright')).length, 0, 'E is no longer Lean Right on the page either')
})

await test('the read-back returns exactly what the player changed in game, and nothing it did not', () => {
  const { home, p } = fakeHome('home2')
  settings.set({ waw: { ai_corpseCount: '10' }, wawBinds: { '+activate': ['F'] }, gameUpdatedAt: 30 }, SID)
  wawcfg.applyAccountToConfig({ homeDir: home, settings: settings.get(SID), display: DISPLAY })
  assert.deepEqual(wawcfg.readBackAccount({ homeDir: home }).changed, {}, 'an untouched config is no change')
  // The player opens Graphics in game and picks Insane corpses, turns Subtitles on, and
  // rebinds Use to H - the engine rewrites config.cfg on exit.
  let cfg = fs.readFileSync(p.engineCfg, 'utf8')
  cfg = cfg.replace('seta ai_corpseCount "10"', 'seta ai_corpseCount "32"').replace('bind F "+activate"', 'bind H "+activate"')
  cfg = cfg.replace('con_hidechannel', 'seta cg_subtitles "1"\r\ncon_hidechannel')
  fs.writeFileSync(p.engineCfg, cfg)
  const back = wawcfg.readBackAccount({ homeDir: home })
  // cg_subtitles is claimed because the account (earlier tests saved the site's defaults)
  // had it at "0", so this launch wrote it and the snapshot knows it.
  assert.deepEqual(back.changed.waw, { ai_corpseCount: '32', cg_subtitles: '1' })
  assert.equal('r_gamma' in back.changed.waw, false, 'an untouched dvar is not claimed')
  assert.deepEqual(back.changed.wawBinds, { '+activate': ['H'] })
  settings.set(back.changed, SID)
  assert.equal(settings.get(SID).waw.ai_corpseCount, '32', 'saved to the account for the next launch and the site')
})

await test('the launch wires it: settingsArgs uses the account, start() merges the config, the env carries raw mouse off, the read-back is folded in', () => {
  const src = fs.readFileSync(new URL('../src/main/launch.js', import.meta.url), 'utf8')
  assert.match(src, /applyAccountToConfig\(\{ homeDir, profile: o\.profile \|\| PROFILE, settings: o\.settings \|\| \{\}, display \}\)/)
  assert.match(src, /rawMouse === false \? \{ ENW_RAW_MOUSE: '0' \}/)
  assert.match(src, /readBackAccount\(/)
  const off = settings.set({ rawMouse: false }, SID)
  assert.equal(off.rawMouse, false)
  assert.match(src, /\['allow', 'refuse'\]\.includes\(o\.settings\.discordOverlay\) \? \{ ENW_DISCORD_HOOK: o\.settings\.discordOverlay \}/)
  assert.equal(settings.get(SID).discordOverlay, 'auto', 'Discord overlay defaults to auto')
  assert.equal(settings.set({ discordOverlay: 'refuse' }, SID).discordOverlay, 'refuse')
  assert.equal(settings.set({ discordOverlay: 'maybe' }, SID).discordOverlay, 'refuse', 'a bad value keeps the saved one')
  settings.set({ discordOverlay: 'auto' }, SID)
})

// ---- the in-game ENW Esc menu's Settings tab (esc-menu.md §9) -------------------------
const gen = await import('../../tools/settings/gen-ingame-schema.mjs')

await test('in-game schema: the committed shared/settings/ingame-settings.json is exactly what the catalogue generates', async () => {
  const want = gen.render(await gen.buildSchema())
  assert.equal(gen.readCommitted(), want, 'stale: run node tools/settings/gen-ingame-schema.mjs')
})

await test('in-game schema: every value a control can write passes the launcher whitelist; mod-owned and gameplay dvars are absent', async () => {
  const s = await gen.buildSchema()
  const byId = new Map(s.items.map((i) => [i.id, i]))
  for (const it of s.items) {
    if (it.kind === 'bind') { assert.ok(wawcfg.BIND_COMMANDS.includes(it.command), it.command); continue }
    if (it.to === 'waw') {
      assert.ok(wawcfg.canonDvar(it.dvar), `${it.id}: ${it.dvar} is not whitelisted`)
      for (const v of it.values || []) if (v !== '') assert.notEqual(wawcfg.checkValue(wawcfg.canonDvar(it.dvar), v), undefined, `${it.id}=${v}`)
      if (it.kind === 'slider') for (const v of [it.min, it.max]) assert.notEqual(wawcfg.checkValue(wawcfg.canonDvar(it.dvar), v), undefined, `${it.id}=${v}`)
      for (const extra of Object.values(it.also || {})) for (const [d, v] of extra) assert.notEqual(wawcfg.checkValue(wawcfg.canonDvar(d), v), undefined, `${it.id} also ${d}=${v}`)
    }
  }
  for (const bad of ['monkeytoy', 'con_external', 'sv_cheats', 'developer', 'ai_corpseCount']) {
    assert.equal([...byId.values()].some((i) => String(i.dvar || '').toLowerCase() === bad.toLowerCase()), false, `${bad} must never be an in-game control`)
  }
  // A Verified game: com_maxfps may not change mid-game (records rule), nothing restarts the renderer.
  assert.equal(byId.get('maxFps').verified, false)
  for (const it of s.items) if (it.apply === 'vid_restart') assert.equal(it.verified, false, `${it.id} restarts the renderer`)
  assert.equal(byId.get('sensitivity').verified, true)
  assert.equal(byId.get('fov').max, 120, 'FOV tops out at the records cap')
  assert.deepEqual(byId.get('showFps').values, ['Off', 'Simple'], 'cg_drawFPS is an enum on T4')
})

await test('raw input round-trips through config.cfg (enw_rawmouse): launch writes it, an in-game change comes back as rawMouse', () => {
  const { home, p } = fakeHome('home-raw')
  wawcfg.applyAccountToConfig({ homeDir: home, settings: { rawMouse: true }, display: DISPLAY })
  let cfg = fs.readFileSync(p.engineCfg, 'utf8')
  assert.match(cfg, /^seta enw_rawmouse "1"$/m)
  assert.deepEqual(wawcfg.readBackAccount({ homeDir: home }).changed, {})
  fs.writeFileSync(p.engineCfg, cfg.replace('seta enw_rawmouse "1"', 'seta enw_rawmouse "0"'))
  assert.deepEqual(wawcfg.readBackAccount({ homeDir: home }).changed, { rawMouse: false })
})

await test('the sync message: what the in-game tab writes (write-through config.cfg) is the patch the launcher saves and the site reads', () => {
  const { home, p } = fakeHome('home-ingame')
  settings.set({ sensitivity: 5, fov: 80, waw: { r_aspectRatio: 'auto', ui_mousePitch: '0', m_pitch: '0.022' }, gameUpdatedAt: 40 }, SID)
  wawcfg.applyAccountToConfig({ homeDir: home, settings: settings.get(SID), display: DISPLAY })
  // The engine's write-through after the tab set sensitivity 7.5, FOV 95, invert, 16:9, rebound Use.
  let cfg = fs.readFileSync(p.engineCfg, 'utf8')
  cfg = cfg.replace(/^seta sensitivity "[^"]*"$/m, 'seta sensitivity "7.5"').replace(/^seta cg_fov "[^"]*"$/m, 'seta cg_fov "95"')
    .replace(/^seta ui_mousePitch "[^"]*"$/m, 'seta ui_mousePitch "1"').replace(/^seta m_pitch "[^"]*"$/m, 'seta m_pitch "-0.022"')
    .replace(/^seta r_aspectRatio "[^"]*"$/m, 'seta r_aspectRatio "wide 16:9"').replace(/^bind \S+ "\+activate"$/m, 'bind G "+activate"')
  fs.writeFileSync(p.engineCfg, cfg)
  const back = wawcfg.readBackAccount({ homeDir: home, commit: true })
  assert.equal(back.changed.sensitivity, 7.5)
  assert.equal(back.changed.fov, 95)
  assert.deepEqual(back.changed.waw, { r_aspectRatio: 'wide 16:9', ui_mousePitch: '1', m_pitch: '-0.022' })
  assert.deepEqual(back.changed.wawBinds['+activate'], ['G'])
  const saved = settings.set(back.changed, SID)
  const pageGame = site.fromLauncher(saved)
  assert.equal(site.shownValue(pageGame, item('fov')), 95, '/settings shows the in-game FOV')
  assert.equal(site.shownValue(pageGame, item('ui_mousePitch')), '1')
  assert.equal(site.shownValue(pageGame, item('r_aspectRatio')), 'wide 16:9')
  // commit moved the snapshot: the same file is no change the second time.
  assert.deepEqual(wawcfg.readBackAccount({ homeDir: home }).changed, {})
})

await test('catch-up: a change the game saved but the launcher never read back survives the next launch\'s merge', () => {
  const { home, p } = fakeHome('home-catchup')
  const acct = { sensitivity: 5, fov: 80, gameUpdatedAt: 50 }
  wawcfg.applyAccountToConfig({ homeDir: home, settings: acct, display: DISPLAY })
  // The game wrote FOV 110 (write-through), then the launcher died: no read-back ran.
  fs.writeFileSync(p.engineCfg, fs.readFileSync(p.engineCfg, 'utf8').replace(/^seta cg_fov "[^"]*"$/m, 'seta cg_fov "110"'))
  // Next launch, exactly as launch.js start() does it: catch up, fold, then merge.
  const missed = wawcfg.readBackAccount({ homeDir: home, commit: true })
  assert.deepEqual(missed.changed, { fov: 110 })
  const next = wawcfg.foldReadBack(acct, missed.changed)
  wawcfg.applyAccountToConfig({ homeDir: home, settings: next, display: DISPLAY })
  assert.match(fs.readFileSync(p.engineCfg, 'utf8'), /^seta cg_fov "110"$/m, 'the stale account value did not overwrite the in-game one')
  const src = fs.readFileSync(new URL('../src/main/launch.js', import.meta.url), 'utf8')
  assert.match(src, /const missed = readBackAccount\(\{ homeDir, profile: o\.profile \|\| PROFILE, commit: true \}\)/)
  assert.ok(src.indexOf('const missed = readBackAccount') < src.indexOf('const acct = applyAccountToConfig'), 'catch-up runs before the merge')
  assert.match(src, /this\.pendingReadBack\) r\.changed = foldReadBack/)
})

await test('with nothing saved from the site the launch line is exactly the old baseline', () => {
  const s = { ...settings.DEFAULT_SETTINGS }
  assert.deepEqual(launch.settingsArgs(s, DISPLAY), gamecfg.dvarsToArgs(gamecfg.baselineDvars(s, DISPLAY)))
})

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
