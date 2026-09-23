// World at War's own Options menus, applied at launch (web /settings, 2026-09-22).
//
// The site's Settings page is laid out like WaW's Options menus and saves, per SteamID,
// every item as the dvar or bind the game's own menu writes. This module is the launcher
// half: the whitelist those values must pass, the command-line dvars they become, the
// per-launch merge into the config.cfg the ENGINE reads, and the read-back of what the
// player changed in game.
//
// Where each dvar comes from is written beside it in web/client/src/data/wawSettings.js
// (the stock menus compiled into zone/english/ui.ff, plus the game's shipped .cfg files).
// A test in each package checks the two lists agree.
//
// WHY A PER-LAUNCH MERGE, when seedHome() deliberately writes only once per baseline:
// `config.cfg` is exec'd during Com_Init and the in-game menu reads the dvars it sets
// (launcher.md 0.2.3 §1 measured a config beating the command line). A setting changed on
// the site must therefore reach that file, or the menu - and possibly the game - keeps
// the old value. It does not break the "in-game changes win" rule, because the read-back
// below turns every in-game change into the saved value before the next launch writes it.
import fs from 'node:fs'
import path from 'node:path'
import { P, assertWritable } from './paths.js'
import { baselineDvars, configPaths, parseConfigCfg, PROFILE, clampFov, clampFps } from './gamecfg.js'
import { validResolution } from './display.js'

// ------------------------------------------------------------------ whitelist --

const bool = { type: 'enum', values: ['0', '1'] }
const vol = { type: 'num', min: 0, max: 1 }
const picmip = { type: 'enum', values: ['0', '1', '2', '3'] }

// Engine casing, as the game writes them in config.cfg. Matching is case-insensitive.
export const WAW_DVARS = {
  // options_graphics
  r_displayRefresh: { type: 're', re: /^\d{2,3} Hz$/ },
  r_aspectRatio: { type: 'enum', values: ['auto', 'standard', 'wide 16:10', 'wide 16:9'] },
  r_aaSamples: { type: 'enum', values: ['1', '2', '4'] },
  r_gamma: { type: 'num', min: 0.5, max: 3 },
  r_multiGpu: bool,
  sm_enable: bool,
  r_specular: bool,
  r_gfxopt_water_simulation: bool,
  r_gfxopt_dynamic_foliage: bool,
  fx_marks: bool,
  ai_corpseCount: { type: 'enum', values: ['3', '5', '10', '20', '32'] },
  // options_graphics_texture
  r_texFilterMipMode: { type: 'enum', values: ['Unchanged', 'Force Bilinear', 'Force Trilinear'] },
  r_texFilterAnisoMin: { type: 'num', min: 1, max: 16, int: true },
  r_picmip_manual: bool,
  r_picmip: picmip,
  r_picmip_bump: picmip,
  r_picmip_spec: picmip,
  // options_sound
  snd_menu_master: vol,
  snd_menu_voice: vol,
  snd_menu_music: vol,
  snd_menu_sfx: vol,
  snd_cinematicVolumeScale: vol,
  snd_losOcclusion: bool,
  // options_game
  cg_mature: bool,
  cg_blood: bool,
  monkeytoy: bool,
  cg_subtitles: bool,
  hud_enable: bool,
  cg_drawCrosshair: bool,
  // options_look
  ui_mousePitch: bool,
  m_pitch: { type: 'enum', values: ['0.022', '-0.022'] },
  cl_freelook: bool,
  m_filter: bool,
  // ENW extras: real archived engine dvars, not items in WaW's menus
  r_dof_enable: bool,
  r_glow_allowed: bool,
}

const CANON = new Map(Object.keys(WAW_DVARS).map((d) => [d.toLowerCase(), d]))
export const canonDvar = (d) => CANON.get(String(d || '').toLowerCase()) || null

// Every command a bind row in the stock menus binds (options_look / _move / _shoot / _misc).
export const BIND_COMMANDS = [
  '+leanleft', '+leanright', '+lookup', '+lookdown', '+left', '+right', '+mlook', 'centerview',
  '+forward', '+back', '+moveleft', '+moveright', '+gostand', 'gocrouch', 'goprone', 'togglecrouch',
  'toggleprone', '+movedown', '+prone', '+stance', '+strafe',
  '+attack', '+speed_throw', '+toggleads_throw', '+melee', 'weapnext', '+reload', '+sprint',
  '+breath_sprint', '+holdbreath', '+frag', '+smoke', '+actionslot 3', '+actionslot 4', '+actionslot 2',
  '+activate', '+actionslot 1', 'enw_screenshot', '+scores', 'acceptInvitation', 'savegame_lastcommit',
]
// [SS] 2026-09-24: the screenshot row is ENW's own command (client DLL screenshot.cpp, client.md 15). WaW's
// `screenshotJPEG` / `screenshot` drop the game on a display over ~3.4 MP (client.md 14) and write into the
// player's Documents, so we never bind them: an account that saved keys for the old row keeps them (read
// as enw_screenshot), and every `bind <key> "screenshotJPEG"` in the engine's config becomes ours.
export const SCREENSHOT_CMD = 'enw_screenshot'
export const STOCK_SCREENSHOT_CMDS = ['screenshotjpeg', 'screenshot']
const BIND_CANON = new Map([...BIND_COMMANDS.map((c) => [c.toLowerCase(), c]), ...STOCK_SCREENSHOT_CMDS.map((c) => [c, SCREENSHOT_CMD])])

// A key name as the engine writes it in a bind line. ESCAPE and the console keys are the
// game's own and are never rebindable from here.
const KEY_RE = /^(?:[A-Z0-9]|F\d{1,2}|MOUSE[1-5]|MWHEEL(?:UP|DOWN)|KP_\w+|SPACE|SHIFT|CTRL|ALT|TAB|ENTER|BACKSPACE|UPARROW|DOWNARROW|LEFTARROW|RIGHTARROW|INS|DEL|HOME|END|PGUP|PGDN|PAUSE|CAPSLOCK|SEMICOLON|[\-=\[\]',./\\])$/
export const validKey = (k) => KEY_RE.test(String(k || '').toUpperCase())

// One value against its rule. Returns the canonical string, or undefined if it fails.
export function checkValue(dvar, v) {
  const rule = WAW_DVARS[dvar]
  if (!rule) return undefined
  const s = String(v).trim()
  if (rule.type === 'enum') return rule.values.find((x) => x.toLowerCase() === s.toLowerCase())
  if (rule.type === 're') return rule.re.test(s) ? s : undefined
  const n = Number(s)
  if (!Number.isFinite(n) || n < rule.min || n > rule.max) return undefined
  return String(rule.int ? Math.round(n) : Math.round(n * 1000) / 1000)
}

// Validate a `waw` patch. Values: a string (set it), null (game default: `reset <dvar>`),
// '' (no opinion: stop writing it). Unknown dvars and bad values are dropped with a note.
export function validateWaw(patch = {}) {
  const out = {}
  const notes = []
  for (const [k, v] of Object.entries(patch || {})) {
    const d = canonDvar(k)
    if (!d) { notes.push(`waw: ${k} is not an item in WaW's menus; dropped`); continue }
    if (v === null || v === '') { out[d] = v; continue }
    const c = checkValue(d, v)
    if (c === undefined) { notes.push(`waw: ${d} "${v}" is not a value the game's menu offers; kept the saved one`); continue }
    out[d] = c
  }
  return { waw: out, notes }
}

// Validate a `wawBinds` patch: { command: [key, key] } (at most two keys, as the menu).
// null = back to the stock keys; [] = unbound.
export function validateBinds(patch = {}) {
  const out = {}
  const notes = []
  for (const [c, keys] of Object.entries(patch || {})) {
    const cmd = BIND_CANON.get(String(c).toLowerCase())
    if (!cmd) { notes.push(`binds: ${c} is not a command in WaW's control menus; dropped`); continue }
    if (keys === null) { out[cmd] = null; continue }
    if (!Array.isArray(keys)) { notes.push(`binds: ${cmd} needs a list of keys`); continue }
    const ks = [...new Set(keys.map((k) => String(k).toUpperCase()))].filter(validKey).slice(0, 2)
    out[cmd] = ks
  }
  return { binds: out, notes }
}

// ------------------------------------------------------------------ command line --

// The launch dvars: the baseline (gamecfg.js) with the account's WaW menu values laid over
// it IN PLACE - a value the player chose replaces the bundled fix for the same dvar rather
// than appearing twice - and the rest appended. `null` (game default) takes the dvar OFF
// the command line; its `reset` goes into config.cfg (accountConfigLines).
export function launchDvars(settings = {}, display = null) {
  const base = baselineDvars(settings, display)
  const waw = settings.waw || {}
  const want = new Map()
  const drop = new Set()
  for (const [k, v] of Object.entries(waw)) {
    const d = canonDvar(k)
    if (!d || v === '' || v === undefined) continue
    if (v === null) { drop.add(d.toLowerCase()); continue }
    const c = checkValue(d, v)
    if (c !== undefined) want.set(d.toLowerCase(), [d, c])
  }
  const out = []
  for (const [d, v] of base) {
    const lk = d.toLowerCase()
    if (drop.has(lk)) continue
    if (want.has(lk)) { out.push([d, want.get(lk)[1]]); want.delete(lk); continue }
    out.push([d, v])
  }
  for (const [, pair] of want) out.push(pair)
  return out
}

// The dvars from the account that go into config.cfg every launch: everything the site or
// the launcher's own Settings screen decides. Not the bundled community fixes - those stay
// seed-once, exactly as before, so an in-game change to one of them is never undone.
// `snd_menu_master` is the account's volume (bug 15): a `+set` alone loses to the
// config.cfg the engine execs after it, so the volume has to be in the file too.
const ACCOUNT_DVARS = new Set(['r_fullscreen', 'r_mode', 'r_displayrefresh', 'vid_xpos', 'vid_ypos', 'r_monitor',
  'r_vsync', 'com_maxfps', 'cg_fov', 'sensitivity', 'cg_drawfps', 'snd_menu_master'])

export function accountConfigLines(settings = {}, display = null) {
  const pairs = launchDvars(settings, display)
    .filter(([d]) => ACCOUNT_DVARS.has(d.toLowerCase()) || (canonDvar(d) && (settings.waw || {})[canonDvar(d)] !== undefined && (settings.waw || {})[canonDvar(d)] !== ''))
  const resets = Object.entries(settings.waw || {}).filter(([k, v]) => v === null && canonDvar(k)).map(([k]) => canonDvar(k))
  const binds = {}
  for (const [c, keys] of Object.entries(settings.wawBinds || {})) {
    if (BIND_CANON.has(String(c).toLowerCase()) && Array.isArray(keys)) binds[BIND_CANON.get(String(c).toLowerCase())] = keys
  }
  // Raw input is an environment switch for the DLL, not an engine dvar, so the config
  // carries it as ENW's own archived dvar: the in-game Settings tab (esc-menu.md §9) shows
  // this value and writes a change back into the same line for the read-back below.
  pairs.push([RAW_MOUSE_DVAR, settings.rawMouse === false ? '0' : '1'])
  // The two Discord switches ride the same way (esc-menu.md §11.3, B 2026-09-23: every
  // launcher setting changeable in game): the in-game Settings tab and the ENW console
  // write them, the read-back below saves them, the launcher acts on them next launch.
  pairs.push([DISCORD_DVARS.presence, settings.discordPresence === false ? '0' : '1'])
  pairs.push([DISCORD_DVARS.overlay, DISCORD_OVERLAY_VALUES.includes(settings.discordOverlay) ? settings.discordOverlay : 'auto'])
  // [SS] the screenshot format rides the same way; the DLL reads it at each shot, so an in-game change is live.
  pairs.push([SHOT_FORMAT_DVAR, settings.screenshotFormat === 'png' ? 'png' : 'jpg'])
  return { pairs, resets, binds }
}

// ENW's own archived dvar for the DLL's raw-input switch (not a WaW menu item).
export const RAW_MOUSE_DVAR = 'enw_rawmouse'
// ...and for the launcher's Discord rich presence and the DLL's Discord-hook gate.
export const DISCORD_DVARS = { presence: 'enw_discord', overlay: 'enw_discordhook' }
const DISCORD_OVERLAY_VALUES = ['auto', 'allow', 'refuse']
// ...and for the screenshot key's file type (client DLL screenshot.cpp).
export const SHOT_FORMAT_DVAR = 'enw_shotformat'

// Fold the account into a config.cfg the game wrote. Case-insensitive on dvar names
// (the engine writes `ai_corpseCount`; the menu says `ai_corpsecount`); everything we
// have no opinion about is passed through untouched; `con_hidechannel`, the engine's own
// last line, stays last.
export function mergeAccountIntoConfig(existing = '', { pairs = [], resets = [], binds = {} } = {}) {
  const want = new Map(pairs.map(([d, v]) => [d.toLowerCase(), [d, String(v).replace(/"/g, '')]]))
  const reset = new Map(resets.map((d) => [d.toLowerCase(), d]))
  // key (upper) -> command, from the binds we own
  const keyTo = new Map()
  const ownedCmds = new Set(Object.keys(binds).map((c) => c.toLowerCase()))
  for (const [cmd, keys] of Object.entries(binds)) for (const k of keys) keyTo.set(String(k).toUpperCase(), cmd)

  const seen = new Set()
  const seenKey = new Set()
  const out = []
  for (const raw of String(existing).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const m = line.match(/^(\s*)(?:seta|setu|set|sets|reset)\s+(\S+)/)
    if (m) {
      const lk = m[2].toLowerCase()
      if (want.has(lk)) { if (!seen.has(lk)) { out.push(`${m[1]}seta ${want.get(lk)[0]} "${want.get(lk)[1]}"`); seen.add(lk) } continue }
      if (reset.has(lk)) { if (!seen.has(lk)) { out.push(`${m[1]}reset ${reset.get(lk)}`); seen.add(lk) } continue }
    }
    const b = line.match(/^(\s*)bind\s+(\S+)\s+"?([^"]*)"?\s*$/i)
    if (b) {
      const key = b[2].toUpperCase()
      let cmd = b[3].trim()
      // [SS] WaW's screenshot commands become ENW's, on whatever key the player had them.
      const rewritten = STOCK_SCREENSHOT_CMDS.includes(cmd.toLowerCase())
      if (rewritten) cmd = SCREENSHOT_CMD
      if (keyTo.has(key)) {
        if (!seenKey.has(key)) { out.push(`${b[1]}bind ${key} "${keyTo.get(key)}"`); seenKey.add(key) }
        continue
      }
      // Another key still bound to a command we now own: that binding is gone, as it is
      // when you rebind in the game's own menu.
      if (ownedCmds.has(cmd.toLowerCase())) continue
      if (rewritten) { if (!seenKey.has(key)) { out.push(`${b[1]}bind ${key} "${cmd}"`); seenKey.add(key) } continue }
    }
    out.push(line)
  }

  const tail = []
  while (out.length && (out[out.length - 1] === '' || /^con_(hide|show)channel\b/.test(out[out.length - 1]))) tail.unshift(out.pop())

  const added = []
  for (const [lk, [d, v]] of want) if (!seen.has(lk)) added.push(`seta ${d} "${v}"`)
  for (const [lk, d] of reset) if (!seen.has(lk)) added.push(`reset ${d}`)
  for (const [key, cmd] of keyTo) if (!seenKey.has(key)) added.push(`bind ${key} "${cmd}"`)
  if (added.length) {
    out.push('// --- ENW Zombies: your settings from the site (change them in game and they stay changed)')
    out.push(...added)
  }
  return [...out, ...tail].join('\r\n').replace(/\r\n*$/, '') + '\r\n'
}

// What a config says, for every dvar and bind we might have written: the snapshot the
// read-back compares against.
function snapshotOf(text) {
  const { dvars, binds } = parseConfigCfg(text)
  const d = {}
  for (const [k, v] of dvars) d[k.toLowerCase()] = v
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^reset\s+(\S+)/)
    if (m) d[m[1].toLowerCase()] = null
  }
  const cmds = {}
  for (const [key, cmd] of binds) {
    const c = BIND_CANON.get(String(cmd).toLowerCase())
    if (c) (cmds[c] = cmds[c] || []).push(key.toUpperCase())
  }
  return { dvars: d, binds: cmds }
}

export const accountStamp = (homeDir = P.home, profile = PROFILE) => configPaths(homeDir, profile).account

// Every launch (player mode only): merge the account into each config.cfg that exists,
// and record what the engine will read, so the read-back can tell an in-game change from
// what we wrote. Never creates a config the engine has not got - seedHome() does that.
export function applyAccountToConfig({ homeDir = P.home, profile = PROFILE, settings = {}, display = null, localAppData = null } = {}) {
  const p = configPaths(homeDir, profile, localAppData)
  const lines = accountConfigLines(settings, display)
  const wrote = []
  let snapshot = null
  for (const file of [p.engineCfg, p.profileCfg, p.plainCfg]) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const merged = mergeAccountIntoConfig(text, lines)
    if (merged !== text) fs.writeFileSync(assertWritable(file), merged)
    wrote.push(file)
    if (!snapshot) snapshot = snapshotOf(merged)
  }
  if (snapshot) {
    const stamp = accountStamp(homeDir, profile)
    fs.mkdirSync(assertWritable(path.dirname(stamp)), { recursive: true })
    fs.writeFileSync(assertWritable(stamp), JSON.stringify({ at: new Date().toISOString(), file: wrote[0], ...snapshot }, null, 2))
  }
  return { wrote, pairs: lines.pairs, resets: lines.resets, binds: lines.binds }
}

// Launcher keys whose dvar the read-back can compare against the snapshot.
const KEY_DVAR = { fov: 'cg_fov', maxFps: 'com_maxfps', vsync: 'r_vsync', sensitivity: 'sensitivity', showFps: 'cg_drawfps', resolution: 'r_mode' }

// After the game exits: everything the player changed in the game's own menus, relative
// to what this launch wrote, as a settings patch. Only differences count - an untouched
// value is not a change, and a dvar we did not record is not ours to claim.
//
// `commit` (2026-09-23, the in-game Settings tab): once the launcher has taken the patch,
// the snapshot is moved forward to what the config says now. Then a LATER read-back of the
// same file finds nothing, and one that finds something is a change the launcher never
// saw - the game wrote it (write-through: the engine saves config.cfg on the frame after
// an archived dvar changes) and the launcher died or was closed before the game exited.
// launch.js runs that catch-up before it merges the account into the config again, so an
// in-game change is never overwritten by the stale account value.
export function readBackAccount({ homeDir = P.home, profile = PROFILE, localAppData = null, commit = false } = {}) {
  let stamp
  try { stamp = JSON.parse(fs.readFileSync(accountStamp(homeDir, profile), 'utf8')) } catch { return { changed: {}, reason: 'no launch snapshot' } }
  const p = configPaths(homeDir, profile, localAppData)
  let text = null
  let file = null
  for (const f of [p.engineCfg, p.profileCfg, p.plainCfg]) {
    try { text = fs.readFileSync(f, 'utf8'); file = f; break } catch {}
  }
  if (text === null) return { changed: {}, reason: 'no config.cfg' }
  const now = snapshotOf(text)
  const changed = {}
  const waw = {}
  for (const [lk, before] of Object.entries(stamp.dvars || {})) {
    const d = canonDvar(lk)
    if (!d || before === null || !(lk in now.dvars)) continue
    const after = now.dvars[lk]
    if (after === null || String(after) === String(before)) continue
    const c = checkValue(d, after)
    if (c !== undefined) waw[d] = c
  }
  if (Object.keys(waw).length) changed.waw = waw

  for (const [key, dv] of Object.entries(KEY_DVAR)) {
    const before = (stamp.dvars || {})[dv]
    const after = now.dvars[dv]
    if (before === undefined || before === null || after === undefined || after === null || String(before) === String(after)) continue
    if (key === 'fov') changed.fov = Number(clampFov(after))
    else if (key === 'maxFps') changed.maxFps = Number(clampFps(after))
    else if (key === 'vsync') changed.vsync = after === '1'
    else if (key === 'showFps') changed.showFps = after !== '0' && after.toLowerCase() !== 'off'
    else if (key === 'sensitivity') { const n = Number(after); if (Number.isFinite(n) && n > 0) changed.sensitivity = n }
    else if (key === 'resolution') { const r = validResolution(after); if (r) changed.resolution = r }
  }

  {
    const before = (stamp.dvars || {})[RAW_MOUSE_DVAR]
    const after = now.dvars[RAW_MOUSE_DVAR]
    if (after === '0' || after === '1') {
      if (before !== undefined && before !== null && String(before) !== after) changed.rawMouse = after === '1'
    }
  }
  {
    const before = (stamp.dvars || {})[DISCORD_DVARS.presence]
    const after = now.dvars[DISCORD_DVARS.presence]
    if ((after === '0' || after === '1') && before !== undefined && before !== null && String(before) !== after) changed.discordPresence = after === '1'
  }
  {
    const before = (stamp.dvars || {})[DISCORD_DVARS.overlay]
    const after = now.dvars[DISCORD_DVARS.overlay]
    if (DISCORD_OVERLAY_VALUES.includes(after) && before !== undefined && before !== null && String(before) !== after) changed.discordOverlay = after
  }

  {
    const before = (stamp.dvars || {})[SHOT_FORMAT_DVAR]
    const after = now.dvars[SHOT_FORMAT_DVAR]
    if ((after === 'jpg' || after === 'png') && before !== undefined && before !== null && String(before) !== after) changed.screenshotFormat = after
  }

  const binds = {}
  for (const cmd of BIND_COMMANDS) {
    const a = ((stamp.binds || {})[cmd] || []).slice().sort().join(',')
    const b = (now.binds[cmd] || []).slice().sort().join(',')
    if (a !== b) binds[cmd] = (now.binds[cmd] || []).slice(0, 2)
  }
  if (Object.keys(binds).length) changed.wawBinds = binds
  if (commit && Object.keys(changed).length) {
    try { fs.writeFileSync(assertWritable(accountStamp(homeDir, profile)), JSON.stringify({ ...stamp, at: new Date().toISOString(), committedAt: new Date().toISOString(), file, ...now }, null, 2)) } catch {}
  }
  return { changed, file, reason: Object.keys(changed).length ? 'the player changed settings in game' : 'nothing changed in game' }
}

// Fold a read-back patch into a settings object (the shape settings.get() returns), the way
// settings.set() would: `waw` and `wawBinds` merge key by key, everything else replaces.
export function foldReadBack(settings = {}, patch = {}) {
  const out = { ...settings }
  for (const [k, v] of Object.entries(patch || {})) {
    if ((k === 'waw' || k === 'wawBinds') && v && typeof v === 'object') out[k] = { ...(settings[k] || {}), ...v }
    else out[k] = v
  }
  return out
}
