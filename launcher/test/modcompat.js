#!/usr/bin/env node
// mod-compat.md: the pre-launch "your files are the server's files" check, and the
// mod-owned dvar exclusion on the settings read-back.
//
//   node test/modcompat.js
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'enw-modcompat-'))
process.env.ENW_ROOT = path.join(TMP, 'enwroot')
process.env.ENW_DEV_ROOT = path.join(TMP, 'nodevbox')
process.env.ENW_NO_DISPLAY_PROBE = '1'
const mc = await import('../src/main/modcompat.js')

let pass = 0
let fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`) } catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message}`) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

// A fake map: a fastfile in WaW's shape ("IWffu100" + version + zlib) carrying the same
// strings Minecraft Village's mod.ff does, an iwd, and the install record.
function makeMap(name) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  const script = Buffer.from(
    'self setClientDvars( "monkeytoy", "1" ); self SetClientDvar( "cg_fov", 65 );' +
    ' "exec" "set monkeytoy 1;set ufo 0;set r_gamma 1.4" ; SetDvar( "zombie_debug", "0" ); "setdvar" "hud_fade_ammodisplay" "9999"', 'latin1')
  const ff = Buffer.concat([Buffer.from('IWffu100', 'latin1'), Buffer.from([0x83, 1, 0, 0]), zlib.deflateSync(script)])
  const iwd = Buffer.from('PK not really a zip')
  fs.writeFileSync(path.join(dir, 'mod.ff'), ff)
  fs.writeFileSync(path.join(dir, 'map.iwd'), iwd)
  const spec = { files: [{ path: 'mod.ff', size: ff.length, sha256: sha(ff) }, { path: 'map.iwd', size: iwd.length, sha256: sha(iwd) }] }
  fs.writeFileSync(path.join(dir, '.enw-installed.json'), JSON.stringify({ bsp: name, files: spec.files.map((f) => ({ rel: f.path, size: f.size, sha256: f.sha256 })) }))
  return { dir, spec }
}

await test('an installed map identical to the server is ok, and the second check is a stat', () => {
  const { dir, spec } = makeMap('same')
  assert.deepEqual(mc.checkInstalled(dir, spec), { ok: true, bad: [], extra: [] })
  const rec = JSON.parse(fs.readFileSync(path.join(dir, '.enw-installed.json'), 'utf8'))
  assert.ok(rec.files.every((f) => f.mtimeMs && f.checkedSize), 'hashed files are remembered by size+mtime')
})

await test('different bytes, a missing file and a stray .iwd are all named', () => {
  const { dir, spec } = makeMap('differs')
  fs.writeFileSync(path.join(dir, 'map.iwd'), Buffer.from('PK not really a zi!'))   // same size, other bytes
  fs.unlinkSync(path.join(dir, 'mod.ff'))
  fs.writeFileSync(path.join(dir, 'zz_hitmarker_addon.iwd'), 'x')
  fs.writeFileSync(path.join(dir, 'console.log'), 'engine output is not a map file')
  const c = mc.checkInstalled(dir, spec)
  assert.equal(c.ok, false)
  assert.deepEqual(c.bad.map((b) => b.path).sort(), ['map.iwd', 'mod.ff'])
  assert.match(c.bad.find((b) => b.path === 'map.iwd').why, /bytes differ/)
  assert.deepEqual(c.extra, ['zz_hitmarker_addon.iwd'])
  assert.deepEqual(mc.removeExtras(dir, c.extra), ['zz_hitmarker_addon.iwd'])
  assert.ok(fs.existsSync(path.join(dir, 'console.log')))
})

await test('a mod.arena we repaired (BOM) is compared with what we wrote, not the archive', () => {
  const { dir, spec } = makeMap('arena')
  const orig = Buffer.from('﻿{ map "x" }', 'utf8')
  const fixed = orig.subarray(3)
  fs.writeFileSync(path.join(dir, 'mod.arena'), fixed)
  spec.files.push({ path: 'mod.arena', size: orig.length, sha256: sha(orig) })
  const rec = JSON.parse(fs.readFileSync(path.join(dir, '.enw-installed.json'), 'utf8'))
  rec.files.push({ rel: 'mod.arena', size: fixed.length, sha256: sha(orig), repaired: { sha256Before: sha(orig), sha256After: sha(fixed) } })
  fs.writeFileSync(path.join(dir, '.enw-installed.json'), JSON.stringify(rec))
  assert.equal(mc.checkInstalled(dir, spec).ok, true)
})

await test('the dvars a mod sets are found in its fastfile, and only managed ones are owned', () => {
  const { dir } = makeMap('dvars')
  const { all } = mc.scanModDvars(dir)
  for (const d of ['monkeytoy', 'cg_fov', 'ufo', 'r_gamma', 'zombie_debug', 'hud_fade_ammodisplay']) assert.ok(all.has(d), d)
  assert.deepEqual([...mc.modOwnedDvars(dir)].sort(), ['cg_fov', 'monkeytoy', 'r_gamma'])
  const rec = JSON.parse(fs.readFileSync(path.join(dir, '.enw-installed.json'), 'utf8'))
  assert.deepEqual(rec.modDvars.owned, ['cg_fov', 'monkeytoy', 'r_gamma'], 'cached in the install record')
})

await test('the read-back drops what the mod set and keeps what the player changed', () => {
  const owned = new Set(['cg_fov', 'monkeytoy'])
  const r = mc.dropModOwned({ fov: 40, maxFps: 144, waw: { monkeytoy: '1', r_gamma: '1.2' } }, owned)
  assert.deepEqual(r.changed, { maxFps: 144, waw: { r_gamma: '1.2' } })
  assert.deepEqual(r.dropped.sort(), ['fov', 'waw.monkeytoy'])
  assert.deepEqual(mc.dropModOwned({ waw: { monkeytoy: '1' } }, owned).changed, {}, 'an emptied waw patch disappears')
  assert.deepEqual(mc.dropModOwned({ fov: 90 }, new Set()).changed, { fov: 90 }, 'a stock map owns nothing')
})

await test('launch.js filters the read-back by the fs_game it launched', () => {
  const src = fs.readFileSync(new URL('../src/main/launch.js', import.meta.url), 'utf8')
  assert.match(src, /dropModOwned\(r\.changed \|\| \{\}, modOwnedDvars\(/)
  const main = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8')
  assert.match(main, /modcompat\.checkInstalled\(dir, listed\.data\)/)
  assert.match(main, /only: new Set\(c\.bad\.map/)
})

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
