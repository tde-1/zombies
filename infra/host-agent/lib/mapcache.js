// The box's map cache: pull a leased map from the bucket before boot, keep the mods dir
// inside a disk budget, and warm it with the maps people actually play.
//
// B, 2026-09-23 (via the coordinator): the bucket is the source of truth for map files;
// the box downloads maps on demand, fully automatic, nothing manual. docs/kickstart/host.md
// "2026-09-23 - map cache" is the operator's half of this file.
//
// WHERE THE MAPS LIVE. One directory, /home/waw/waw-en/mods, that three symlinks point at
// (waw-inst-*/mods, homes/inst-*/mods, the prefix's AppData mods; launcher.md "three
// symlinks, not one"). So "the slot's game copy" is that ONE shared dir, and a map pulled
// for one slot is there for every slot. `modsDir` is its realpath; staging and the state
// file sit beside it in `<parent>/.enw-mapcache/`, on the same filesystem, so an install
// is a rename and never a copy.
//
// THE FOUR RULES THIS FILE EXISTS TO KEEP
//   1. A half-pulled map is never visible. Files download into staging, each is checked
//      against the site's size and sha256, and only a complete, verified directory is
//      renamed into mods/. A repair (some files bad) builds a full copy in staging from
//      hardlinks of the good files plus the re-pulled ones and swaps it in with two
//      renames under a journal, so a crash between them is put right at the next start.
//   2. Never evict the stock four, a map a live (or warm, or booting, or preparing)
//      instance is on, or a map a live lease names. The host passes `inUse()`.
//   3. No loops. Each file is fetched ONCE per pull. A failed pull fails that lease; the
//      next lease may try again (that is a person pressing Play, not a timer). A failed
//      prefetch waits PREFETCH_COOLDOWN_MS. Prefetch never evicts anything, so prefetch and
//      trim cannot undo each other. Bucket egress is included only up to 1 TB/month.
//   4. The existing library is trimmed GRADUALLY: one directory per maintenance tick
//      (60 s), only while nothing is booting or pulling, least-recently-used first, never
//      a popular map before every unpopular one, each eviction logged. A map dir with no
//      record here is seeded with its mtime as its last use.
//
// THE BUDGET, EXACTLY
//   usage   = bytes of every map dir in mods/ + bytes promised to pulls in flight
//   A LEASE's pull evicts (oldest first) until BOTH hold after the pull:
//     usage + need <= max(budget, usage)       - a pull never grows a library that is
//                                                already over budget; trim shrinks it
//     free - need  >= minFree                  - the disk is the hard limit
//   If the budget half cannot be met (everything left is protected) but the disk half can,
//   the pull goes ahead over budget, loudly. If the disk half cannot, the lease fails.
//   A PREFETCH only runs when usage + size <= budget * PREFETCH_SHARE's cap and the disk
//   half holds without evicting anything.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { makeLog, sleep } from './util.js'

export const STOCK_MAPS = new Set(['nazi_zombie_prototype', 'nazi_zombie_asylum', 'nazi_zombie_sumpf', 'nazi_zombie_factory'])
export const DEFAULT_BUCKET_URL = 'https://enw-zombies.nbg1.your-objectstorage.com'
const GB = 1024 ** 3
const MB = 1024 ** 2
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
// Map data only (web/server/lib/mapfiles.js ALLOWED) - and an .exe that came with a map is
// never ours to fetch (hard rule 6), whatever a list says.
const REFUSED_EXT = new Set(['.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.msi', '.sh'])
const PREFETCH_COOLDOWN_MS = 6 * 3600_000
const POPULAR_TTL_MS = 30 * 60_000
const STATE_DIR = '.enw-mapcache'

/** The mod folder a lease needs, or null for a stock map (nothing to pull). */
export function modNameOf(asg) {
  const bsp = String(asg?.map || '')
  if (!bsp || STOCK_MAPS.has(bsp)) return null
  const fg = asg?.fs_game ? String(asg.fs_game).replace(/\\/g, '/') : ''
  const m = /^mods\/([^/]+)\/?$/i.exec(fg)
  // An fs_game that is not a plain mods/<dir> is not ours to guess at.
  if (fg && !m) return null
  const name = m ? m[1] : bsp
  if (!NAME_RE.test(name) || STOCK_MAPS.has(name)) return null
  return name
}

/** A list path made safe to join under a map dir, or null. */
export function safeRel(rel) {
  const s = String(rel || '').replace(/\\/g, '/')
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null
  const parts = s.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  if (REFUSED_EXT.has(path.extname(s).toLowerCase())) return null
  return parts.join('/')
}

/**
 * The cache's settings from the environment (/root/enw-host.env on the box).
 * ON by default only where it belongs: a Wine box attached to a site. A dev PC, a sim run
 * or a test has to ask for it (ENW_MAP_CACHE=on) and name ENW_MODS_DIR.
 */
export function configFromEnv(env = process.env, { wine = null, site = null } = {}) {
  const num = (k, d) => (env[k] != null && env[k] !== '' && Number.isFinite(Number(env[k])) ? Number(env[k]) : d)
  const flag = String(env.ENW_MAP_CACHE || '').toLowerCase()
  const enabled = flag ? !['0', 'off', 'false', 'no'].includes(flag) : !!(wine && site)
  let modsDir = env.ENW_MODS_DIR || null
  if (!modsDir && wine?.gameDir) modsDir = path.join(wine.gameDir.replace(/\{slot\}/g, 'inst-01'), 'mods')
  return {
    enabled,
    modsDir,
    bucketUrl: String(env.ENW_MAP_BUCKET_URL || DEFAULT_BUCKET_URL).replace(/\/+$/, ''),
    budgetBytes: Math.round(num('ENW_MODS_BUDGET_GB', 15) * GB),
    minFreeBytes: Math.round(num('ENW_MODS_MIN_FREE_GB', 1) * GB),
    prefetchTop: Math.max(0, Math.floor(num('ENW_MAP_PREFETCH_TOP', 20))),
    prefetchShare: Math.min(1, Math.max(0, num('ENW_MAP_PREFETCH_SHARE', 0.67))),
    prefetchBps: Math.max(0, num('ENW_MAP_PREFETCH_MBPS', 10)) * MB,
    trim: !['0', 'off', 'false', 'no'].includes(String(env.ENW_MAP_TRIM || 'on').toLowerCase()),
    stallMs: Math.max(1000, num('ENW_MAP_STALL_S', 30) * 1000),
  }
}

export class MapCache extends EventEmitter {
  /**
   * @param {object}   o
   * @param {string}   o.modsDir        the ONE mods dir (symlinks resolved here)
   * @param {string}   o.bucketUrl      public bucket base; files are <base>/mods/<bsp>/<rel>
   * @param {Function} o.fetchFiles     async (bsp) => the site's file list
   *                                    ({ stock, files: [{ path, size, sha256 }] })
   * @param {Function} [o.fetchPopular] async () => [{ map, fs_game, plays, size_bytes }]
   * @param {Function} [o.inUse]        () => iterable of mod names that must not be evicted
   * @param {Function} [o.busy]         () => true while a game is booting (no trim/prefetch)
   * @param {Function} [o.statfs]       (dir) => { free } bytes (tests)
   * @param {Function} [o.fetch]        fetch implementation (tests)
   */
  constructor(o = {}) {
    super()
    this.log = o.log || makeLog('maps')
    this.modsDir = path.resolve(o.modsDir)
    this.root = path.join(path.dirname(this.modsDir), STATE_DIR)
    this.staging = path.join(this.root, 'staging')
    this.stateFile = path.join(this.root, 'state.json')
    this.bucketUrl = String(o.bucketUrl || DEFAULT_BUCKET_URL).replace(/\/+$/, '')
    this.budgetBytes = o.budgetBytes ?? 15 * GB
    this.minFreeBytes = o.minFreeBytes ?? 1 * GB
    this.prefetchTop = o.prefetchTop ?? 20
    this.prefetchShare = o.prefetchShare ?? 0.67
    this.prefetchBps = o.prefetchBps ?? 10 * MB
    this.trimOn = o.trim !== false
    this.stallMs = o.stallMs ?? 30_000
    this.fetchFiles = o.fetchFiles
    this.fetchPopular = o.fetchPopular || null
    // Two different questions. `inUse`: maps a running process (live, warm, booting) is on -
    // their files are never replaced or removed. `leased`: maps a live lease names - never
    // evicted, but a lease's own map may be repaired before its game boots.
    this.inUse = o.inUse || (() => [])
    this.leased = o.leased || (() => [])
    this.busy = o.busy || (() => false)
    this.statfs = o.statfs || ((dir) => { const s = fs.statfsSync(dir); return { free: s.bavail * s.bsize } })
    this.fetch = o.fetch || globalThis.fetch
    this.now = o.now || Date.now
    this.jobs = new Map()          // mod name -> job (one pull per map, however many leases)
    this.popular = { at: 0, list: [] }
    this.stats = { pulls: 0, pulledBytes: 0, repairs: 0, evictions: 0, failures: 0, prefetches: 0 }
    this.state = { v: 1, maps: {}, failed: {} }
  }

  // ---- start-up ------------------------------------------------------------------------
  /** Load the state, make the dirs, and put right whatever a crash left in staging. */
  init() {
    const real = fs.realpathSync(this.modsDir)
    if (real !== this.modsDir) {
      this.modsDir = real
      this.root = path.join(path.dirname(real), STATE_DIR)
      this.staging = path.join(this.root, 'staging')
      this.stateFile = path.join(this.root, 'state.json')
    }
    fs.mkdirSync(this.staging, { recursive: true })
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      if (j && j.maps) this.state = { v: 1, maps: j.maps || {}, failed: j.failed || {} }
    } catch { /* first start: every dir is seeded from its mtime by scan() */ }
    this.recover()
    return this
  }

  /**
   * A crash mid-pull leaves `<name>.new-*` dirs (discard); a crash mid-swap leaves a
   * `<name>.swap.json` journal, written only once the new copy was fully verified: if
   * mods/<name> is missing, put the new copy in (or, failing that, the old one back).
   */
  recover() {
    let ents = []
    try { ents = fs.readdirSync(this.staging) } catch { return }
    for (const f of ents.filter((e) => e.endsWith('.swap.json'))) {
      const jf = path.join(this.staging, f)
      try {
        const j = JSON.parse(fs.readFileSync(jf, 'utf8'))
        const target = path.join(this.modsDir, j.name)
        if (NAME_RE.test(j.name) && !fs.existsSync(target)) {
          const src = [j.next, j.old].find((p) => p && p.startsWith(this.staging) && fs.existsSync(p))
          if (src) { fs.renameSync(src, target); this.log.warn(`recovered ${j.name} after an interrupted swap (${src === j.next ? 'new copy' : 'old copy'})`) }
        }
      } catch (e) { this.log.error(`could not read swap journal ${f}: ${e.message}`) }
      try { fs.unlinkSync(jf) } catch { /* ignore */ }
    }
    for (const e of fs.readdirSync(this.staging)) {
      fs.rmSync(path.join(this.staging, e), { recursive: true, force: true })
      this.log.info(`removed ${e} from staging (left by an earlier run)`)
    }
  }

  saveState() {
    const tmp = `${this.stateFile}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state))
      fs.renameSync(tmp, this.stateFile)
    } catch (e) { this.log.error(`could not save ${this.stateFile}: ${e.message}`) }
  }

  touch(name, when = this.now()) {
    if (!name) return
    const m = this.state.maps[name] || (this.state.maps[name] = {})
    m.last_used = Math.max(m.last_used || 0, when)
  }

  // ---- what is on disk -----------------------------------------------------------------
  /** Every map dir in mods/: name, bytes, last use (recorded, else the dir's mtime). */
  scan() {
    const out = []
    let ents = []
    try { ents = fs.readdirSync(this.modsDir, { withFileTypes: true }) } catch { return out }
    for (const e of ents) {
      // Real directories only: never follow (or delete through) a symlink in mods/.
      if (!e.isDirectory() || !NAME_RE.test(e.name)) continue
      const dir = path.join(this.modsDir, e.name)
      let st
      try { st = fs.lstatSync(dir) } catch { continue }
      const rec = this.state.maps[e.name]
      out.push({ name: e.name, bytes: dirBytes(dir), lastUsed: rec?.last_used || st.mtimeMs })
    }
    return out
  }

  freeBytes() { return this.statfs(this.modsDir).free }

  /** Bytes promised to pulls in flight: counted as used, and as not yet free. */
  inflight() {
    let total = 0, left = 0
    for (const j of this.jobs.values()) { total += j.total || 0; left += Math.max(0, (j.total || 0) - (j.done || 0)) }
    return { total, left }
  }

  usage(list = this.scan()) {
    const fl = this.inflight()
    return { used: list.reduce((s, m) => s + m.bytes, 0) + fl.total, free: this.freeBytes() - fl.left }
  }

  protectedSet(extra = []) {
    const p = new Set([...STOCK_MAPS, ...extra, ...this.jobs.keys()])
    for (const n of this.inUse() || []) if (n) p.add(n)
    for (const n of this.leased() || []) if (n) p.add(n)
    return p
  }

  /** Eviction order: unpopular maps oldest-use first, then popular ones least popular first. */
  candidates(protect, list = this.scan()) {
    const rank = this.popularRank()
    const free = list.filter((m) => !protect.has(m.name) && !STOCK_MAPS.has(m.name))
    const cold = free.filter((m) => !rank.has(m.name)).sort((a, b) => a.lastUsed - b.lastUsed)
    const hot = free.filter((m) => rank.has(m.name)).sort((a, b) => rank.get(b.name) - rank.get(a.name))
    return [...cold, ...hot]
  }

  evict(name, why) {
    const dir = path.join(this.modsDir, name)
    if (STOCK_MAPS.has(name) || !NAME_RE.test(name)) throw new Error(`refusing to evict ${name}`)
    const bytes = dirBytes(dir)
    // Out of the game's sight in one rename, then deleted at leisure.
    const gone = path.join(this.staging, `${name}.evict-${this.now()}-${crypto.randomBytes(3).toString('hex')}`)
    fs.renameSync(dir, gone)
    fs.rmSync(gone, { recursive: true, force: true })
    const last = this.state.maps[name]?.last_used
    delete this.state.maps[name]
    this.saveState()
    this.stats.evictions++
    this.log.info(`evicted ${name} (${fmtGB(bytes)}, last used ${last ? new Date(last).toISOString() : 'unknown'}): ${why}`)
    this.emit('evicted', { name, bytes, why })
    return bytes
  }

  /**
   * Make room for `need` bytes (see THE BUDGET at the top).
   * @returns {{ ok: boolean, evicted: string[], overBudget?: boolean, error?: string }}
   */
  makeRoom(need, { protect = new Set(), noEvict = false, forName = '' } = {}) {
    const list = this.scan()
    const { used, free } = this.usage(list)
    const cap = Math.max(this.budgetBytes, used)
    let evicted = 0
    const out = []
    const budgetOk = () => used + need - evicted <= cap
    const diskOk = () => free - need + evicted >= this.minFreeBytes
    if (!noEvict) {
      for (const m of this.candidates(protect, list)) {
        if (budgetOk() && diskOk()) break
        try { evicted += this.evict(m.name, `room for ${forName} (${fmtGB(need)})`); out.push(m.name) }
        catch (e) { this.log.error(`could not evict ${m.name}: ${e.message}`) }
      }
    }
    if (!diskOk()) return { ok: false, evicted: out, error: `not enough disk for ${forName}: need ${fmtGB(need)} + ${fmtGB(this.minFreeBytes)} reserve, ${fmtGB(free + evicted)} free` }
    if (!budgetOk()) {
      if (noEvict) return { ok: false, evicted: out, error: 'over budget' }
      this.log.warn(`${forName} goes in OVER the ${fmtGB(this.budgetBytes)} budget: everything else in mods/ is protected`)
      return { ok: true, evicted: out, overBudget: true }
    }
    return { ok: true, evicted: out }
  }

  // ---- the lease path --------------------------------------------------------------------
  /** Progress of the pull for this lease's map, or null when nothing is happening. */
  progress(asg) {
    const j = this.jobs.get(modNameOf(asg))
    return j ? snapshot(j) : null
  }

  /**
   * Make sure the lease's map is installed and matches the site's list. Resolves with
   * { ok, name, pulled, repaired, bytes, unverified, error }. Never rejects.
   * Concurrent calls for the same map share ONE pull.
   */
  ensure(asg, { onProgress = null, urgent = true, noEvict = false } = {}) {
    const name = modNameOf(asg)
    if (!name) return Promise.resolve({ ok: true, name: null, skipped: 'stock' })
    let job = this.jobs.get(name)
    if (job) {
      if (urgent) job.urgent = true
      if (onProgress) job.listeners.add(onProgress)
      return job.promise
    }
    job = { name, bsp: String(asg.map), phase: 'listing', total: 0, done: 0, files: 0, filesDone: 0, urgent, noEvict, listeners: new Set(onProgress ? [onProgress] : []), started: this.now() }
    this.jobs.set(name, job)
    job.promise = this.run(job)
      .catch((e) => ({ ok: false, name, error: e.message }))
      .then((r) => {
        this.jobs.delete(name)
        if (!r.ok) { this.stats.failures++; this.state.failed[job.bsp] = this.now(); this.saveState() }
        return r
      })
    return job.promise
  }

  async run(job) {
    const { name, bsp } = job
    const dir = path.join(this.modsDir, name)
    const exists = fs.existsSync(dir)
    let list
    try { list = await this.fetchFiles(bsp) }
    catch (e) {
      if (exists) { this.log.warn(`${bsp}: could not get the file list (${e.message}); booting the copy on disk unverified`); this.touch(name); this.saveState(); return { ok: true, name, unverified: true } }
      return { ok: false, name, error: `no file list for ${bsp}: ${e.message}` }
    }
    if (list?.stock) return { ok: true, name: null, skipped: 'stock' }
    const files = []
    for (const f of list?.files || []) {
      const rel = safeRel(f.path)
      if (!rel || !Number.isFinite(Number(f.size)) || Number(f.size) < 0) { this.log.warn(`${bsp}: ignoring unsafe list entry ${JSON.stringify(f.path)}`); continue }
      files.push({ path: rel, size: Number(f.size), sha256: f.sha256 ? String(f.sha256).toLowerCase() : null })
    }
    if (!files.length) {
      if (exists) { this.log.warn(`${bsp}: the site lists no files; booting the copy on disk unverified`); this.touch(name); this.saveState(); return { ok: true, name, unverified: true } }
      return { ok: false, name, error: `the site has no files for ${bsp}` }
    }
    job.files = files.length

    // What is wrong with the copy on disk, if there is one.
    let bad = files
    if (exists) {
      job.phase = 'verifying'
      job.total = files.reduce((s, f) => s + f.size, 0)
      this.tick(job, true)
      bad = await this.verify(name, files, job)
      job.done = 0
      if (!bad.length) { this.touch(name); this.saveState(); return { ok: true, name, pulled: false } }
      if ([...(this.inUse() || [])].includes(name)) {
        // A running game has these files open and evidently loaded them. Replacing them
        // under it would help nobody; the next lease with the dir free repairs it.
        this.log.warn(`${name}: ${bad.length} file(s) differ from the site's list but a live instance is on this map - booting it as is`)
        this.touch(name); this.saveState()
        return { ok: true, name, pulled: false, unverified: true }
      }
      this.log.warn(`${name}: ${bad.length} of ${files.length} file(s) missing or wrong (${bad.slice(0, 3).map((f) => f.path).join(', ')}${bad.length > 3 ? ', ...' : ''}) - re-pulling those`)
    }

    const need = bad.reduce((s, f) => s + f.size, 0)
    job.phase = 'downloading'
    job.total = 0          // not counted as in flight while its own room is being made
    job.done = 0
    job.filesDone = 0
    const room = this.makeRoom(need, { protect: this.protectedSet([name]), noEvict: job.noEvict, forName: name })
    if (!room.ok) return { ok: false, name, error: room.error }
    job.total = need

    const next = path.join(this.staging, `${name}.new-${this.now()}-${crypto.randomBytes(3).toString('hex')}`)
    try {
      fs.mkdirSync(next, { recursive: true })
      if (exists) linkTree(dir, next, new Set(bad.map((f) => f.path)))
      this.tick(job, true)
      for (const f of bad) {
        const url = `${this.bucketUrl}/mods/${encodeURIComponent(bsp)}/${f.path.split('/').map(encodeURIComponent).join('/')}`
        const dest = path.join(next, ...f.path.split('/'))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        await this.download(url, dest, f, job)
        job.filesDone++
        this.tick(job, true)
      }
      job.phase = 'installing'
      this.tick(job, true)
      if (!exists) {
        if (fs.existsSync(dir)) throw new Error(`${dir} appeared while pulling`)
        fs.renameSync(next, dir)
      } else {
        const old = path.join(this.staging, `${name}.old-${this.now()}-${crypto.randomBytes(3).toString('hex')}`)
        const journal = path.join(this.staging, `${name}.swap.json`)
        fs.writeFileSync(journal, JSON.stringify({ name, next, old }))
        fs.renameSync(dir, old)
        fs.renameSync(next, dir)
        fs.rmSync(old, { recursive: true, force: true })
        fs.unlinkSync(journal)
      }
    } catch (e) {
      fs.rmSync(next, { recursive: true, force: true })
      return { ok: false, name, error: e.message }
    }
    // Record what was verified, so the next lease needs no rehash.
    const rec = this.state.maps[name] || (this.state.maps[name] = {})
    rec.files = rec.files || {}
    for (const f of bad) {
      try { const st = fs.statSync(path.join(dir, ...f.path.split('/'))); rec.files[f.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: f.sha256 } } catch { /* ignore */ }
    }
    rec.bytes = dirBytes(dir)
    this.touch(name)
    delete this.state.failed[bsp]
    this.saveState()
    this.stats.pulls++
    this.stats.pulledBytes += need
    if (exists) this.stats.repairs++
    const secs = (this.now() - job.started) / 1000
    this.log.info(`${exists ? 'repaired' : 'pulled'} ${name}: ${bad.length} file(s), ${fmtGB(need)} in ${secs.toFixed(1)} s${room.evicted.length ? `; evicted ${room.evicted.join(', ')}` : ''}`)
    return { ok: true, name, pulled: !exists, repaired: exists, bytes: need, evicted: room.evicted }
  }

  /** The files of the copy on disk that do not match the list. Hashes only when needed. */
  async verify(name, files, job) {
    const dir = path.join(this.modsDir, name)
    const rec = this.state.maps[name] || (this.state.maps[name] = {})
    rec.files = rec.files || {}
    const bad = []
    for (const f of files) {
      const full = path.join(dir, ...f.path.split('/'))
      let st
      try { st = fs.statSync(full) } catch { bad.push(f); job.done += f.size; continue }
      if (!st.isFile() || st.size !== f.size) { bad.push(f); job.done += f.size; continue }
      if (f.sha256) {
        const known = rec.files[f.path]
        const cached = known && known.size === st.size && known.mtimeMs === st.mtimeMs && known.sha256
        const sha = cached || await hashFile(full, (n) => { job.done += n; this.tick(job) })
        if (cached) job.done += f.size
        if (sha !== f.sha256) { bad.push(f); continue }
        rec.files[f.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha }
      } else job.done += f.size
      this.tick(job)
    }
    return bad
  }

  /** One file, one attempt: size and sha256 checked on the fly. */
  async download(url, dest, f, job) {
    const ac = new AbortController()
    let stall = setTimeout(() => ac.abort(), this.stallMs)
    const kick = () => { clearTimeout(stall); stall = setTimeout(() => ac.abort(), this.stallMs) }
    const fh = await fsp.open(dest, 'wx')
    const hash = crypto.createHash('sha256')
    let n = 0
    const t0 = this.now()
    try {
      const res = await this.fetch(url, { signal: ac.signal })
      if (res.status !== 200) throw new Error(`GET ${url} -> ${res.status}`)
      for await (const chunk of res.body) {
        kick()
        n += chunk.length
        if (n > f.size) throw new Error(`${f.path}: the bucket sent more than the listed ${f.size} bytes`)
        hash.update(chunk)
        await fh.write(chunk)
        job.done += chunk.length
        this.tick(job)
        // A prefetch is throttled; a lease waiting on the same map lifts it (ensure()).
        if (!job.urgent && this.prefetchBps > 0) {
          const ahead = (n / this.prefetchBps) * 1000 - (this.now() - t0)
          if (ahead > 5) await sleep(Math.min(ahead, 1000))
        }
      }
      if (n !== f.size) throw new Error(`${f.path}: got ${n} bytes, the list says ${f.size}`)
      const sha = hash.digest('hex')
      if (f.sha256 && sha !== f.sha256) throw new Error(`${f.path}: sha256 mismatch (got ${sha.slice(0, 12)}, the list says ${f.sha256.slice(0, 12)})`)
      await fh.sync()
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`${f.path}: no data for ${this.stallMs / 1000} s from the bucket`)
      throw e
    } finally {
      clearTimeout(stall)
      await fh.close().catch(() => {})
    }
  }

  tick(job, force = false) {
    const t = this.now()
    if (!force && t - (job.lastTick || 0) < 1000) return
    job.lastTick = t
    const snap = snapshot(job)
    for (const fn of job.listeners) { try { fn(snap) } catch { /* a listener never breaks a pull */ } }
    this.emit('progress', snap)
  }

  // ---- idle-time work -------------------------------------------------------------------
  popularRank() {
    const rank = new Map()
    this.popularSet().forEach((p, i) => rank.set(p.name, i))
    return rank
  }

  /** The top maps by plays that fit the prefetch share of the budget, most played first. */
  popularSet() {
    const out = []
    let bytes = 0
    const cap = this.budgetBytes * this.prefetchShare
    for (const p of this.popular.list) {
      if (out.length >= this.prefetchTop) break
      const name = modNameOf(p)
      if (!name || !(p.plays > 0)) continue
      const size = Number(p.size_bytes) || 0
      if (bytes + size > cap) continue
      bytes += size
      out.push({ ...p, name, size })
    }
    return out
  }

  async refreshPopular(force = false) {
    if (!this.fetchPopular || (!force && this.now() - this.popular.at < POPULAR_TTL_MS)) return
    this.popular.at = this.now()
    try {
      const r = await this.fetchPopular()
      const list = Array.isArray(r) ? r : r?.maps
      if (Array.isArray(list)) {
        this.popular.list = list.filter((p) => p && p.map).sort((a, b) => (b.plays || 0) - (a.plays || 0))
        this.popular.ok = true
      }
    } catch (e) { this.log.debug(`popular maps: ${e.message}`) }
  }

  /** Evict ONE map if the library is over budget and nothing is booting or pulling. */
  trimStep() {
    if (!this.trimOn || this.busy() || this.jobs.size) return null
    // Not before the site has said which maps are popular: an LRU with no popularity is
    // an LRU of rsync mtimes on the box's first start, and would trim the maps people play.
    // (A site without GET /api/gs/popular-maps therefore gets no trim, only the pull-time
    // eviction that keeps the disk reserve.)
    if (this.fetchPopular && !this.popular.ok) return null
    const list = this.scan()
    const { used } = this.usage(list)
    if (used <= this.budgetBytes) return null
    const c = this.candidates(this.protectedSet(), list)[0]
    if (!c) { this.log.warn(`mods/ is ${fmtGB(used)}, over the ${fmtGB(this.budgetBytes)} budget, and every map in it is protected`); return null }
    try {
      this.evict(c.name, `trim: mods/ is ${fmtGB(used)}, budget ${fmtGB(this.budgetBytes)}`)
      return c.name
    } catch (e) { this.log.error(`trim could not evict ${c.name}: ${e.message}`); return null }
  }

  /** Start ONE throttled prefetch of a popular map that fits without evicting anything. */
  async prefetchStep() {
    if (this.prefetchTop <= 0 || !this.fetchPopular || this.busy() || this.jobs.size) return null
    await this.refreshPopular()
    if (this.busy() || this.jobs.size) return null
    const have = new Set(this.scan().map((m) => m.name))
    const { used, free } = this.usage()
    for (const p of this.popularSet()) {
      if (have.has(p.name) || !p.size) continue
      if (this.now() - (this.state.failed[p.map] || 0) < PREFETCH_COOLDOWN_MS) continue
      if (used + p.size > this.budgetBytes || free - p.size < this.minFreeBytes) continue
      this.log.info(`prefetch ${p.name} (${p.plays} plays, ${fmtGB(p.size)}) at <= ${(this.prefetchBps / MB).toFixed(0)} MB/s`)
      this.stats.prefetches++
      return this.ensure({ map: p.map, fs_game: p.fs_game }, { urgent: false, noEvict: true })
    }
    return null
  }

  /** The maintenance tick: remember what is in use, trim one, or prefetch one. */
  async maintain() {
    if (this.maintaining) return
    this.maintaining = true
    try {
      let touched = 0
      for (const n of this.inUse() || []) if (n && fs.existsSync(path.join(this.modsDir, n))) { this.touch(n); touched++ }
      if (touched) this.saveState()
      await this.refreshPopular()
      if (!this.trimStep()) await this.prefetchStep()
    } finally { this.maintaining = false }
  }

  info() {
    const list = this.scan()
    const { used, free } = this.usage(list)
    return {
      mods_dir: this.modsDir, maps: list.length, used_bytes: used, free_bytes: free,
      budget_bytes: this.budgetBytes, min_free_bytes: this.minFreeBytes,
      pulling: [...this.jobs.values()].map(snapshot), stats: this.stats,
    }
  }
}

// ---- helpers ------------------------------------------------------------------------------
function snapshot(j) {
  return {
    map: j.bsp, mod: j.name, phase: j.phase, prefetch: !j.urgent,
    bytes_done: j.done, bytes_total: j.total,
    percent: j.total ? Math.min(100, Math.floor((j.done / j.total) * 100)) : 0,
    files_done: j.filesDone || 0, files_total: j.files || 0,
  }
}

function dirBytes(dir) {
  let n = 0
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) n += dirBytes(p)
    else if (e.isFile()) { try { n += fs.statSync(p).size } catch { /* raced */ } }
  }
  return n
}

/** Hardlink every file under `from` into `to`, except the relative paths in `skip`. */
function linkTree(from, to, skip, rel = '') {
  for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) { fs.mkdirSync(path.join(to, r), { recursive: true }); linkTree(from, to, skip, r); continue }
    if (!e.isFile() || skip.has(r)) continue
    try { fs.linkSync(path.join(from, r), path.join(to, r)) }
    catch { fs.copyFileSync(path.join(from, r), path.join(to, r)) }
  }
}

async function hashFile(file, onBytes) {
  const h = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) { h.update(chunk); onBytes?.(chunk.length) }
  return h.digest('hex')
}

function fmtGB(n) { return n >= GB ? `${(n / GB).toFixed(2)} GB` : `${(n / MB).toFixed(1)} MB` }
