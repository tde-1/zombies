// Small shared helpers. Zero dependencies (node: builtins only).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

let LOG_LEVEL = LEVELS[process.env.ENW_LOG_LEVEL || 'info'] ?? LEVELS.info

export function setLogLevel(name) {
  LOG_LEVEL = LEVELS[name] ?? LOG_LEVEL
}

const COLOR = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }

// THE LOG RING (telemetry, docs/kickstart/host.md §15). Every line any makeLog() logger
// emits — debug included, whatever the console level — is also kept here, so an instance's
// own host lines can be pulled out when it ends and put in its bundle. One array write per
// line, no file I/O, no timers: a fixed-size circular buffer of { t, level, tag, msg }.
export const LOG_RING_SIZE = Number(process.env.ENW_LOG_RING || 20_000)
const RING = new Array(LOG_RING_SIZE)
let ringNext = 0
let ringCount = 0
const fmtArg = (x) => (typeof x === 'string' ? x
  : x instanceof Error ? (x.stack || x.message)
  : (() => { try { return typeof x === 'object' ? JSON.stringify(x) : String(x) } catch { return String(x) } })())

function ringPush(level, tag, args) {
  RING[ringNext] = { t: Date.now(), level, tag, msg: args.length === 1 && typeof args[0] === 'string' ? args[0] : args.map(fmtArg).join(' ') }
  ringNext = (ringNext + 1) % LOG_RING_SIZE
  if (ringCount < LOG_RING_SIZE) ringCount++
}

/** The ring's lines, oldest first, optionally filtered: `(e) => bool`. */
export function ringLines(filter = null) {
  const out = []
  const start = (ringNext - ringCount + LOG_RING_SIZE) % LOG_RING_SIZE
  for (let i = 0; i < ringCount; i++) {
    const e = RING[(start + i) % LOG_RING_SIZE]
    if (e && (!filter || filter(e))) out.push(e)
  }
  return out
}

/** One ring entry as a log line: ISO time, level, tag, text. */
export const ringFormat = (e) => `${new Date(e.t).toISOString()} ${e.level.padEnd(5)} ${e.tag} ${e.msg}`

export function makeLog(tag) {
  const emit = (level, ...args) => {
    try { ringPush(level, tag, args) } catch { /* the ring must never break a log call */ }
    if (LEVELS[level] < LOG_LEVEL) return
    const ts = new Date().toISOString().slice(11, 23)
    const head = `${COLOR[level]}${ts} ${level.padEnd(5)} ${tag}\x1b[0m`
    console.log(head, ...args)
  }
  return {
    debug: (...a) => emit('debug', ...a),
    info: (...a) => emit('info', ...a),
    warn: (...a) => emit('warn', ...a),
    error: (...a) => emit('error', ...a),
    child: (sub) => makeLog(`${tag}/${sub}`),
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function nowMs() { return Date.now() }

export function id(prefix, bytes = 6) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`
}

export function sha256(buf) { return crypto.createHash('sha256').update(buf).digest() }
export function sha256hex(buf) { return sha256(buf).toString('hex') }

export function b64u(buf) { return Buffer.from(buf).toString('base64url') }
export function unb64u(s) { return Buffer.from(String(s), 'base64url') }

export function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); return p }

export function ensureDirOf(file) { mkdirp(path.dirname(file)); return file }

// Deterministic JSON (sorted keys) — what we sign and hash over.
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
}

export function fmtDur(ms) {
  if (!Number.isFinite(ms)) return '?'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`
    : m > 0 ? `${m}m${String(sec).padStart(2, '0')}s` : `${sec}s`
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MiB`
  return `${(n / 1024 ** 3).toFixed(2)} GiB`
}

// A tiny deterministic PRNG so simulated games and measurements reproduce exactly.
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Split a growing Buffer into NDJSON lines. Returns { lines, rest, overflow }.
// `maxLine` guards against a peer that never sends a newline (memory DoS).
export function ndjsonSplit(buf, maxLine) {
  const lines = []
  let start = 0
  let overflow = false
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue
    let end = i
    if (end > start && buf[end - 1] === 0x0d) end--
    if (end > start) lines.push(buf.subarray(start, end))
    start = i + 1
  }
  let rest = buf.subarray(start)
  if (rest.length > maxLine) { overflow = true; rest = Buffer.alloc(0) }
  return { lines, rest, overflow }
}

export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1)
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i]
      else out[a.slice(2)] = true
    } else out._.push(a)
  }
  return out
}
