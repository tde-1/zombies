#!/usr/bin/env node
// The launcher half of the in-game Settings proof (esc-menu.md §9), against a dev home.
//
//   node tools/dev/settings-roundtrip.mjs stamp    --home C:\Users\b\ZombiesDev\homes\c1
//   node tools/dev/settings-roundtrip.mjs readback --home C:\Users\b\ZombiesDev\homes\c1
//
// `stamp` does what a launcher Play does before the game starts: merges an account into the
// engine's profile config.cfg (<home>\localappdata\Activision\CoDWaW\players\profiles\<active>)
// and records the snapshot. `readback` does what the launcher does after the game exits
// (crash or quit): launcher/src/main/wawcfg.js readBackAccount -> the patch
// settings.set() saves -> what the site's /settings shows for it (wawSettings.js
// fromLauncher/shownValue). The launcher's real settings store is never touched: a temp
// ENW_ROOT stands in for it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'enw-settings-proof-'))
// The launcher refuses to write outside ENW_ROOT (paths.js assertWritable). `stamp` writes
// the dev home's config.cfg and snapshot, so the home is the root for it; `readback`
// writes only the stand-in settings store, in a temp root.
const homeArg = process.argv[process.argv.indexOf('--home') + 1]
process.env.ENW_ROOT = process.argv[2] === 'stamp' && homeArg ? path.resolve(homeArg) : path.join(TMP, 'enwroot')
process.env.ENW_DEV_ROOT = path.join(TMP, 'nodevbox')
process.env.ENW_NO_DISPLAY_PROBE = '1'

const imp = (rel) => import(pathToFileURL(path.join(repo, rel)).href)
const wawcfg = await imp('launcher/src/main/wawcfg.js')
const gamecfg = await imp('launcher/src/main/gamecfg.js')
const settings = await imp('launcher/src/main/settings.js')
const site = await imp('web/client/src/data/wawSettings.js')

const cmd = process.argv[2]
const home = process.argv[process.argv.indexOf('--home') + 1]
if (!home || !fs.existsSync(home)) { console.error('--home <dir> is required and must exist'); process.exit(2) }

// The account this proof "launches" with: the values the in-game run then changes.
const ACCOUNT = { sensitivity: 5, fov: 80, showFps: false, maxFps: 125, rawMouse: true, waw: { r_aspectRatio: 'auto' }, wawBinds: { '+activate': ['F'] }, gameUpdatedAt: 1 }

const p = gamecfg.configPaths(home)
if (cmd === 'stamp') {
  const r = wawcfg.applyAccountToConfig({ homeDir: home, settings: ACCOUNT, display: null })
  console.log(JSON.stringify({ stamped: r.wrote, engineCfg: p.engineCfg, profile: p.engineProfile, pairs: r.pairs.length, binds: r.binds }, null, 1))
} else if (cmd === 'readback') {
  const r = wawcfg.readBackAccount({ homeDir: home })
  const saved = settings.set({ ...ACCOUNT }, '76561190000000001')
  const after = settings.set(r.changed, '76561190000000001')
  const g = site.fromLauncher(after)
  const show = {}
  for (const id of ['sensitivity', 'fov', 'showFps', 'r_aspectRatio', 'rawMouse', 'bind:+activate']) {
    const it = site.ALL.find((i) => i.id === id)
    show[id] = site.shownValue(g, it)
  }
  const cfg = fs.readFileSync(p.engineCfg, 'utf8')
  const lines = cfg.split(/\r?\n/).filter((l) => /^(seta (sensitivity|cg_fov|cg_drawFPS|r_aspectRatio|enw_rawmouse) |bind \S+ "\+activate")/i.test(l))
  console.log(JSON.stringify({ file: r.file, mtime: fs.statSync(p.engineCfg).mtime, configLines: lines, readBackPatch: r.changed, launcherBefore: { fov: saved.fov, sensitivity: saved.sensitivity }, launcherAfter: { fov: after.fov, sensitivity: after.sensitivity, showFps: after.showFps, waw: after.waw, wawBinds: after.wawBinds, gameUpdatedAt: after.gameUpdatedAt }, siteShows: show }, null, 1))
} else {
  console.error('usage: stamp|readback --home <dir>')
  process.exit(2)
}
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
