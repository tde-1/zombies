'use strict'

// Run the flag rules (rules.js) over one bundle and keep the evidence.
//
//   evaluate({ manifest, files, texts })  ->  { flags, severity, hits }
//     files  [{ name, size, binary }]        every file in the bundle
//     texts  Map name -> string              the text files the ingest read (tails)
//     hits   { <flag>: { label, severity, count, detail, excerpts: [{ file, line, lines }] } }
//
// Excerpts are the lines AROUND each hit (merged windows), newest hits kept when there are
// too many, capped per flag (EXCERPT_LINES_PER_FLAG) and per incident. They are what the
// admin sheet shows and what the AI brief is made of, so the brief never needs the bundle.

const fs = require('node:fs')
const path = require('node:path')
const { RULES } = require('./rules')

const EXCERPT_LINES_PER_FLAG = 300
const EXCERPT_LINES_TOTAL = 1500
const LINE_MAX = 400
const ANSI = /\x1b\[[0-9;]*m/g

// Crash-like flags get a wide window (what led up to it matters) and the log's last lines.
const WIDE = new Set(['crash', 'hang', 'server_freeze', 'site_crash', 'oom_kill', 'launcher_error'])

// launcher.log is sent as a 4 MB tail: days of history. A line from before this bundle's
// session is not evidence about it (crash review L1: yesterday's "play released the lease
// (the launch failed)" and a morning 502 flagged every client bundle lease_refused and
// launcher_update_failed). Lines stamped before the window are not grepped. The window:
// the session's start (manifest.session.started_at, else created_at - duration_ms, else
// created_at - 6 h) less 10 minutes, to created_at + 1 minute. No created_at -> no window.
const LAUNCHER_FILE = /(^|\/)(launcher\.log|.*-std(out|err)\.log)$/i
const ISO_AT = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/
function launcherWindow (m) {
  const end = Date.parse(m && m.created_at)
  if (!Number.isFinite(end)) return null
  let start = Date.parse(m.session && m.session.started_at)
  if (!Number.isFinite(start)) start = Number(m.duration_ms) > 0 ? end - Number(m.duration_ms) : end - 6 * 3600e3
  return { start: start - 10 * 60e3, end: end + 60e3 }
}
// Per line: is it inside the window? An unstamped line (a continuation: headers, a stack)
// belongs to the stamped line above it; lines before the first stamp are kept.
function windowMask (ls, win) {
  const keep = new Array(ls.length)
  let cur = true
  for (let i = 0; i < ls.length; i++) {
    const x = ISO_AT.exec(ls[i])
    if (x) { const t = Date.parse(x[1]); cur = !Number.isFinite(t) || (t >= win.start && t <= win.end) }
    keep[i] = cur
  }
  return keep
}

const CHRONIC_FILE = process.env.ZM_CHRONIC_ASSETS || path.join(__dirname, '..', '..', 'data', 'chronic-assets.json')
let chronic = null
function chronicFor (map) {
  if (!chronic) {
    try { chronic = JSON.parse(fs.readFileSync(CHRONIC_FILE, 'utf8')) } catch { chronic = { maps: {} } }
  }
  const maps = chronic.maps || {}
  return new Set([...(maps['*'] || []), ...(maps[String(map || '').toLowerCase()] || [])].map((s) => String(s).toLowerCase()))
}

function evaluate ({ manifest = {}, files = [], texts = new Map() } = {}) {
  const lines = new Map()
  for (const [name, t] of texts) lines.set(name, String(t).replace(ANSI, '').split(/\r?\n/))
  const kind = manifest.kind || 'client'
  const flags = []
  const results = {}
  const win = launcherWindow(manifest)
  const masks = new Map()
  if (win) for (const [name, ls] of lines) if (LAUNCHER_FILE.test(name)) masks.set(name, windowMask(ls, win))

  const ctx = {
    manifest,
    files,
    text: (f) => lines.get(f) || [],
    knownAssets: () => chronicFor(manifest.map),
    flagged: (id) => flags.includes(id),
    grep (re, filesSrc) {
      const fre = filesSrc ? (filesSrc instanceof RegExp ? filesSrc : new RegExp(filesSrc, 'i')) : null
      const rx = new RegExp(re.source, re.flags.replace('g', ''))
      const out = []
      for (const [f, ls] of lines) {
        if (fre && !fre.test(f)) continue
        const keep = masks.get(f)
        for (let i = 0; i < ls.length; i++) if ((!keep || keep[i]) && rx.test(ls[i])) out.push({ file: f, idx: i })
      }
      return out
    },
  }

  for (const r of RULES) {
    if (r.kinds && !r.kinds.includes(kind)) continue
    let res = null
    try {
      if (r.test) res = r.test(ctx)
      else if (r.line) {
        const m = ctx.grep(r.line, r.files)
        if (m.length >= (r.min || 1)) {
          res = { count: m.length, lines: m, detail: r.detail ? r.detail(m, ctx) : `${m.length}× — ${String(ctx.text(m[0].file)[m[0].idx] || '').replace(/^\[[\d:.]+\] (\[\w+\] )?/, '').trim().slice(0, 180)}` }
        }
      }
    } catch (e) {
      res = null
      console.warn(`[telemetry] rule ${r.id}: ${e.message}`)
    }
    if (!res) continue
    flags.push(r.id)
    results[r.id] = { label: r.label, severity: r.severity, count: res.count || 1, detail: res.detail || '', _lines: res.lines || [] }
  }

  // Excerpts, worst flags first so the total cap cuts the least important.
  let budget = EXCERPT_LINES_TOTAL
  const order = Object.keys(results).sort((a, b) => results[a].severity - results[b].severity)
  for (const id of order) {
    const r = results[id]
    const wide = WIDE.has(id)
    const want = Math.min(EXCERPT_LINES_PER_FLAG, budget)
    r.excerpts = want > 0 ? excerpts(lines, r._lines, { before: wide ? 30 : 3, after: wide ? 40 : 8, max: want }) : []
    // A crash with no line to anchor on still gets the end of the game's own log.
    if (wide && !r.excerpts.length && want > 0) r.excerpts = tails(lines, Math.min(120, want))
    budget -= r.excerpts.reduce((a, e) => a + e.lines.length, 0)
    delete r._lines
  }

  const severity = flags.length ? Math.min(...flags.map((f) => results[f].severity)) : 4
  flags.sort((a, b) => results[a].severity - results[b].severity || RULES.findIndex((r) => r.id === a) - RULES.findIndex((r) => r.id === b))
  return { flags, severity, hits: results }
}

// Merge ±windows around hit lines, per file; keep the NEWEST windows when over `max`.
function excerpts (lines, hits, { before, after, max }) {
  const byFile = new Map()
  for (const h of hits) { if (!byFile.has(h.file)) byFile.set(h.file, []); byFile.get(h.file).push(h.idx) }
  const blocks = []
  for (const [file, idxs] of byFile) {
    const ls = lines.get(file) || []
    idxs.sort((a, b) => a - b)
    let cur = null
    for (const i of idxs) {
      const s = Math.max(0, i - before)
      const e = Math.min(ls.length - 1, i + after)
      if (cur && s <= cur.e + 1) cur.e = Math.max(cur.e, e)
      else { if (cur) blocks.push(cur); cur = { file, s, e } }
    }
    if (cur) blocks.push(cur)
  }
  // Newest first within the budget, then shown in file order.
  const out = []
  let left = max
  for (const b of blocks.slice().reverse()) {
    if (left <= 0) break
    const ls = lines.get(b.file)
    let s = b.s
    if (b.e - s + 1 > left) s = b.e - left + 1
    out.push({ file: b.file, line: s + 1, lines: ls.slice(s, b.e + 1).map((x) => x.slice(0, LINE_MAX)) })
    left -= b.e - s + 1
  }
  return out.reverse()
}

// The last n lines of the game's own log (the DLL log, else the biggest text file).
function tails (lines, n) {
  const names = [...lines.keys()]
  const pick = names.find((f) => /enw-\d+\.log$/i.test(f)) || names.find((f) => /console/i.test(f)) || names.find((f) => /host|journal|launcher/i.test(f))
  if (!pick) return []
  const ls = lines.get(pick)
  let end = ls.length
  while (end > 0 && !ls[end - 1].trim()) end--
  const s = Math.max(0, end - n)
  return [{ file: pick, line: s + 1, lines: ls.slice(s, end).map((x) => x.slice(0, LINE_MAX)), tail: true }]
}

module.exports = { evaluate, excerpts, EXCERPT_LINES_PER_FLAG, _resetChronic () { chronic = null } }
