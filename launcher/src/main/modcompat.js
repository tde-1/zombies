// Mod compatibility: the player's copy of a map must be the server's copy, and the
// settings round trip must never keep a value the MOD set. docs/kickstart/mod-compat.md.
//
// Two jobs, both small, both called from existing paths rather than adding new ones:
//
//  1. checkInstalled(dir, spec) -- before Play, compare what is on disk with the file
//     list the site serves (the archive's list, which is what the box was staged from;
//     tools/maps/modcompat_check.py proves box == archive). A file that is missing, a
//     different size, or different bytes is named, and main.js re-downloads just those
//     through the normal verified install. A stray .ff/.iwd in the folder that the
//     server does not have is removed: the engine mounts every .iwd it finds, so an
//     extra one is a client-only asset set nobody else is playing with.
//     Hashing 600 MB on every Play would cost seconds, so a file whose size and mtime
//     still equal what the install recorded is trusted; anything else is hashed.
//
//  2. modOwnedDvars(dir) -- which of the dvars the launcher writes or reads back does
//     this mod set itself (scripts, menus, exec strings in its fastfiles and loose
//     files)? Minecraft Village's anti-cheat runs `set monkeytoy 1` from a menu and
//     `setClientDvars("monkeytoy","1")` from GSC; the engine archives it into
//     config.cfg, and the read-back then saved it to B's account as HIS choice, so
//     every later launch, on every map, went out with `+set monkeytoy 1`. The read-back
//     now drops a change to any dvar the map that was just played sets on its own.
//     The account's own values and wawSettings' meaning are untouched.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { WAW_DVARS } from './wawcfg.js'

const RECORD = '.enw-installed.json'
// Files the engine or we write into a mod folder at runtime; never part of a map.
const RUNTIME = new Set([RECORD.toLowerCase(), 'console.log', 'mpdata', 'mpdatabk0000'])
// What the engine itself loads from a mod folder. An extra one of these is a mismatch.
const ENGINE_EXT = new Set(['.ff', '.iwd'])

// Every dvar the launcher writes to the command line or config.cfg AND reads back after
// the game. Settings keys map to their dvar so a read-back patch can be filtered.
const SETTING_DVAR = {
  resolution: 'r_mode', fov: 'cg_fov', maxFps: 'com_maxfps', vsync: 'r_vsync', volume: 'snd_volume',
  sensitivity: 'sensitivity', showFps: 'cg_drawfps', display: 'r_monitor', mode: 'r_fullscreen', fullscreen: 'r_fullscreen',
}
export const MANAGED_DVARS = new Set([
  ...Object.keys(WAW_DVARS).map((d) => d.toLowerCase()),
  ...Object.values(SETTING_DVAR), 'r_noborder', 'vid_xpos', 'vid_ypos', 'r_displayrefresh',
])

const sha256 = (file) => {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (n <= 0) break; h.update(buf.subarray(0, n)) }
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

const readRecord = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8')) } catch { return null } }

// ------------------------------------------------------------------ 1. the files --

// `spec` is the site's /api/maps/<bsp>/files answer ({ files: [{path,size,sha256}] }).
// Returns { ok, bad: [{ path, why }], extra: [path] }. Changes no map file; it only
// caches size+mtime of files it has just hashed into the install record.
export function checkInstalled(dir, spec) {
  const rec = readRecord(dir) || { files: [] }
  const byRel = new Map((rec.files || []).map((f) => [String(f.rel).toLowerCase(), f]))
  const want = new Map()
  const bad = []
  for (const f of spec?.files || []) {
    const rel = String(f.path)
    want.set(rel.toLowerCase(), f)
    const full = path.join(dir, rel)
    let st
    try { st = fs.statSync(full) } catch { bad.push({ path: rel, why: 'missing' }); continue }
    const r = byRel.get(rel.toLowerCase())
    // A file we repaired on install (mod.arena's BOM) is compared with what we wrote.
    const expectSha = r?.repaired?.sha256After || f.sha256
    if (f.size != null && !r?.repaired && st.size !== f.size) { bad.push({ path: rel, why: `size ${st.size}, the server's is ${f.size}` }); continue }
    if (r && r.mtimeMs && r.mtimeMs === Math.floor(st.mtimeMs) && r.checkedSize === st.size) continue
    if (!expectSha) continue
    const got = sha256(full)
    if (got !== expectSha) { bad.push({ path: rel, why: `bytes differ (${got.slice(0, 12)}…, the server's ${String(expectSha).slice(0, 12)}…)` }); continue }
    if (r) { r.mtimeMs = Math.floor(st.mtimeMs); r.checkedSize = st.size }
  }
  const extra = []
  for (const name of listFiles(dir)) {
    const lk = name.toLowerCase()
    if (want.has(lk) || RUNTIME.has(path.basename(lk))) continue
    if (ENGINE_EXT.has(path.extname(lk))) extra.push(name)
  }
  // Remember the hashes we just proved, so the next Play is a stat per file.
  if (rec.files?.length) { try { fs.writeFileSync(path.join(dir, RECORD), JSON.stringify(rec, null, 2)) } catch {} }
  return { ok: !bad.length && !extra.length, bad, extra }
}

function listFiles(dir, base = dir) {
  const out = []
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p, base))
    else out.push(path.relative(base, p).split(path.sep).join('/'))
  }
  return out
}

// Remove files the server does not have. Only .ff/.iwd (what the engine loads), only
// inside the map's own folder, which is ENW's (library.js installDir).
export function removeExtras(dir, extra) {
  const done = []
  for (const rel of extra || []) {
    const p = path.join(dir, rel)
    if (!p.startsWith(dir + path.sep)) continue
    try { fs.unlinkSync(p); done.push(rel) } catch {}
  }
  return done
}

// ------------------------------------------------------------- 2. mod-owned dvars --

const RE_SCRIPT = /set(?:client|saved)?dvars?\s*\(\s*"([A-Za-z_]\w*)"/gi
const RE_MENU = /"setdvar"\s+"?([A-Za-z_]\w*)/gi
const RE_EXEC = /"exec"\s+"([^"]{1,400})"/gi
const RE_CFG = /(?:^|[;\n"])\s*(?:seta|sets|set|setu)\s+([A-Za-z_]\w*)/gi

function scanText(s, found) {
  for (const re of [RE_SCRIPT, RE_MENU, RE_CFG]) { re.lastIndex = 0; let m; while ((m = re.exec(s))) found.add(m[1].toLowerCase()) }
  RE_EXEC.lastIndex = 0
  let m
  while ((m = RE_EXEC.exec(s))) {
    for (const part of m[1].split(';')) { const x = part.trim().match(/^(?:seta|sets|set|setu)\s+([A-Za-z_]\w*)/i); if (x) found.add(x[1].toLowerCase()) }
  }
}

// A WaW fastfile is "IWffu100" + a 4-byte version, then one zlib stream.
function scanFastfile(file, found) {
  const raw = fs.readFileSync(file)
  if (raw.length < 16 || raw.toString('latin1', 0, 8) !== 'IWffu100') return false
  let data
  try { data = zlib.inflateSync(raw.subarray(12), { finishFlush: zlib.constants.Z_SYNC_FLUSH }) } catch { return false }
  const SLICE = 8 << 20
  for (let i = 0; i < data.length; i += SLICE) scanText(data.toString('latin1', i, Math.min(data.length, i + SLICE + 512)), found)
  return true
}

// Every dvar name the mod sets, from its fastfiles and loose text files. .iwd contents
// are not opened (zip): a mod that sets a dvar only from a script inside an .iwd is
// missed, and mod-compat.md says so.
export function scanModDvars(dir) {
  const found = new Set()
  const scanned = []
  for (const rel of listFiles(dir)) {
    const ext = path.extname(rel).toLowerCase()
    const full = path.join(dir, rel)
    try {
      if (ext === '.ff') { if (scanFastfile(full, found)) scanned.push(rel) }
      else if (['.cfg', '.gsc', '.csc', '.menu', '.txt'].includes(ext)) { scanText(fs.readFileSync(full, 'latin1'), found); scanned.push(rel) }
    } catch {}
  }
  return { all: found, scanned }
}

// The managed dvars this map sets itself, cached in its install record (version 1).
export function modOwnedDvars(dir) {
  const rec = readRecord(dir)
  if (rec?.modDvars?.v === 1) return new Set(rec.modDvars.owned)
  const { all, scanned } = scanModDvars(dir)
  const owned = [...all].filter((d) => MANAGED_DVARS.has(d)).sort()
  if (rec) {
    rec.modDvars = { v: 1, owned, setByMod: all.size, scanned, at: new Date().toISOString() }
    try { fs.writeFileSync(path.join(dir, RECORD), JSON.stringify(rec, null, 2)) } catch {}
  }
  return new Set(owned)
}

// A read-back patch minus every change the mod could have made. Returns
// { changed, dropped: [key] }.
export function dropModOwned(changed = {}, owned = new Set()) {
  if (!owned.size) return { changed, dropped: [] }
  const out = { ...changed }
  const dropped = []
  for (const [key, dvar] of Object.entries(SETTING_DVAR)) {
    if (key in out && owned.has(dvar)) { delete out[key]; dropped.push(key) }
  }
  if (out.waw) {
    const w = { ...out.waw }
    for (const d of Object.keys(w)) if (owned.has(d.toLowerCase())) { delete w[d]; dropped.push(`waw.${d}`) }
    if (Object.keys(w).length) out.waw = w
    else delete out.waw
  }
  return { changed: out, dropped }
}
