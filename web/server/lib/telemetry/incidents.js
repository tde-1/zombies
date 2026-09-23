'use strict'

// The incidents table: write, read for the admin Issues page, the AI brief, the digest.
// docs/kickstart/telemetry.md §3, §5, §8.

const crypto = require('node:crypto')
const { db, now } = require('../../db/database')
const { catalogue, byId, SEVERITY_NAMES } = require('./rules')
const { evaluate } = require('./flags')

const J = (v, d) => { if (v == null) return d; try { return JSON.parse(v) } catch { return d } }
const isSteam = (s) => /^7656119\d{10}$/.test(String(s || ''))
const KIND_WORDS = { client: 'Game session', launcher: 'Launcher', host: 'Box instance', journal: 'Box journal', site: 'Site' }
const BRIEF_MAX = 60 * 1024

function nameOf (sid) {
  if (!isSteam(sid)) return null
  try { const u = require('../users').publicById(sid); return u ? (u.name || u.enw_name || sid) : sid } catch { return sid }
}

// One paragraph a person (or a model) reads first.
function summarize (r) {
  const m = r.manifest || {}
  const hits = r.hits || {}
  const who = r.steam_id ? (nameOf(r.steam_id) || r.steam_id) : (r.box || 'the site')
  const where = [r.map_key ? `on ${r.map_key}` : null, r.match_id ? `(match ${r.match_id})` : null].filter(Boolean).join(' ')
  const ver = [r.launcher_version ? `launcher ${r.launcher_version}` : null, r.dll_sha ? `DLL ${String(r.dll_sha).slice(0, 8)}` : null].filter(Boolean).join(', ')
  const head = `${KIND_WORDS[r.kind] || r.kind} from ${who}${where ? ' ' + where : ''}, ${r.reason || 'no reason given'}${ver ? `; ${ver}` : ''}.`
  const s = m.session || {}
  const end = [
    m.exit_code != null ? `exit code ${m.exit_code}` : null,
    m.exit_reason ? `exit reason ${m.exit_reason}` : null,
    s.exit && s.exit !== 'unknown' ? `the DLL says "${s.exit}"` : null,
    s.last_error ? `last engine error "${String(s.last_error).slice(0, 120)}"` : null,
    m.duration_ms ? `after ${Math.round(m.duration_ms / 60000)} min` : null,
  ].filter(Boolean).join(', ')
  const flags = (r.flags || []).map((f) => { const h = hits[f] || {}; return `${h.label || f} (P${h.severity || '?'}${h.count > 1 ? `, ${h.count}×` : ''})${h.detail ? `: ${String(h.detail).slice(0, 160)}` : ''}` })
  const files = Array.isArray(r.files) ? r.files.filter((f) => !f.refused) : []
  const dumps = files.filter((f) => f.binary && /\.dmp$/i.test(f.name)).length
  return [
    head,
    end ? `It ended with ${end}.` : null,
    flags.length ? `Flags: ${flags.join('; ')}.` : 'No flags: nothing in the logs matched a rule.',
    files.length ? `${files.length} file${files.length > 1 ? 's' : ''}${dumps ? `, ${dumps} dump${dumps > 1 ? 's' : ''}` : ''}, ${fmtBytes(r.size || 0)} compressed.` : null,
  ].filter(Boolean).join(' ')
}

function fmtBytes (n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`
  return `${n} B`
}

function insert (r) {
  const t = now()
  const row = { ...r, received_at: t, last_at: r.at || t }
  row.summary = summarize(row)
  const info = db.prepare(`INSERT INTO incidents (public_id, bundle_id, source, kind, reason, steam_id, box, at, received_at, launcher_version, dll_sha,
      map_key, match_id, instance, severity, flags, hits, summary, manifest, files, size, bucket_key, local_path, upload_state, fingerprint, count, last_at)
      VALUES (@public_id, @bundle_id, @source, @kind, @reason, @steam_id, @box, @at, @received_at, @launcher_version, @dll_sha,
      @map_key, @match_id, @instance, @severity, @flags, @hits, @summary, @manifest, @files, @size, @bucket_key, @local_path, @upload_state, @fingerprint, @count, @last_at)`)
    .run({
      public_id: row.public_id || crypto.randomBytes(16).toString('hex'), bundle_id: row.bundle_id || null, source: row.source, kind: row.kind,
      reason: row.reason || null, steam_id: row.steam_id || null, box: row.box || null, at: row.at || t, received_at: t,
      launcher_version: row.launcher_version || null, dll_sha: row.dll_sha || null, map_key: row.map_key || null, match_id: row.match_id || null,
      instance: row.instance || null, severity: row.severity || 4, flags: JSON.stringify(row.flags || []), hits: JSON.stringify(row.hits || {}),
      summary: row.summary, manifest: JSON.stringify(row.manifest || {}), files: JSON.stringify(row.files || []), size: row.size || 0,
      bucket_key: row.bucket_key || null, local_path: row.local_path || null, upload_state: row.upload_state || (row.local_path ? 'pending' : 'none'),
      fingerprint: row.fingerprint || null, count: row.count || 1, last_at: row.last_at,
    })
  return byRowId(info.lastInsertRowid)
}

const byRowId = (id) => db.prepare('SELECT * FROM incidents WHERE id=?').get(Number(id))

// ---- site incidents -------------------------------------------------------------------
// The site's own trouble (lib/telemetry/siteLog.js). The same error inside COALESCE_MS is
// one incident with a count, not a thousand rows: a 5xx loop must not bury a crash.
const COALESCE_MS = 6 * 3600_000
function recordSite ({ reason, fingerprint, notes = '', lines = [], route = null }) {
  const fp = crypto.createHash('sha1').update(String(fingerprint || notes)).digest('hex').slice(0, 20)
  const t = now()
  const open = db.prepare('SELECT * FROM incidents WHERE kind=? AND fingerprint=? AND reviewed=0 AND last_at > ? ORDER BY id DESC LIMIT 1').get('site', fp, t - COALESCE_MS)
  if (open) {
    const hits = J(open.hits, {})
    const first = Object.keys(hits)[0]
    if (first && lines.length && hits[first].excerpts && hits[first].excerpts.length < 20) {
      hits[first].excerpts.push({ file: 'site.log', line: 0, lines: lines.slice(-40).map((l) => String(l).slice(0, 400)) })
    }
    if (first) hits[first].count = (open.count || 1) + 1
    db.prepare('UPDATE incidents SET count=count+1, last_at=?, hits=? WHERE id=?').run(t, JSON.stringify(hits), open.id)
    return byRowId(open.id)
  }
  const manifest = { kind: 'site', reason, notes: String(notes).slice(0, 4000), route, count: 1 }
  const texts = new Map([['site.log', lines.join('\n')]])
  const f = evaluate({ manifest, files: [{ name: 'site.log', size: 0 }], texts })
  // The site rule has no lines to anchor on: keep what was logged as its excerpt.
  for (const k of f.flags) if (!f.hits[k].excerpts.length && lines.length) f.hits[k].excerpts = [{ file: 'site.log', line: 1, lines: lines.slice(-80).map((l) => String(l).slice(0, 400)) }]
  return insert({ source: 'site', kind: 'site', reason, box: 'site', at: t, severity: f.severity, flags: f.flags, hits: f.hits, manifest, files: [], size: 0, fingerprint: fp, upload_state: 'none' })
}

// ---- reading ---------------------------------------------------------------------------
function pub (r, { full = false } = {}) {
  if (!r) return null
  const store = require('./store')
  const out = {
    id: r.id, at: r.at, received_at: r.received_at, last_at: r.last_at, count: r.count || 1,
    kind: r.kind, reason: r.reason, source: r.source,
    who: r.steam_id ? { steam_id: r.steam_id, name: nameOf(r.steam_id) || r.steam_id } : null,
    steam_id: r.steam_id, box: r.box,
    map_key: r.map_key, match_id: r.match_id, instance: r.instance,
    launcher_version: r.launcher_version, dll_sha: r.dll_sha,
    severity: r.severity, flags: J(r.flags, []), summary: r.summary, size: r.size || 0,
    reviewed: !!r.reviewed, reviewed_at: r.reviewed_at, reviewed_by: r.reviewed_by ? { steam_id: r.reviewed_by, name: nameOf(r.reviewed_by) || r.reviewed_by } : null,
    bug: r.bug, note: r.note,
    upload_state: r.upload_state, upload_error: r.upload_error || null,
    download: r.upload_state === 'uploaded' ? store.publicUrl(r.bucket_key) : (r.local_path ? `/api/admin/incidents/${r.id}/bundle` : null),
    bucket_key: r.bucket_key,
  }
  if (full) {
    out.manifest = J(r.manifest, {})
    out.files = J(r.files, [])
    out.hits = J(r.hits, {})
  }
  return out
}

const SORT = { at: 'i.at', severity: 'i.severity', size: 'i.size', who: "COALESCE(i.steam_id, i.box, '')", kind: 'i.kind', received: 'i.received_at' }

function where (q) {
  const w = []
  const v = []
  const sev = String(q.severity || '').split(',').map(Number).filter((n) => n >= 1 && n <= 4)
  if (sev.length) { w.push(`i.severity IN (${sev.map(() => '?').join(',')})`); v.push(...sev) }
  if (q.flag) { w.push('EXISTS (SELECT 1 FROM json_each(i.flags) j WHERE j.value = ?)'); v.push(String(q.flag)) }
  if (q.kind) { w.push('i.kind = ?'); v.push(String(q.kind)) }
  if (q.who) { w.push('(i.steam_id = ? OR i.box = ?)'); v.push(String(q.who), String(q.who)) }
  if (q.version) { w.push('i.launcher_version = ?'); v.push(String(q.version)) }
  if (q.map) { w.push('i.map_key = ?'); v.push(String(q.map)) }
  if (q.reviewed === '0' || q.reviewed === 0 || q.reviewed === false) w.push('i.reviewed = 0')
  else if (q.reviewed === '1' || q.reviewed === 1 || q.reviewed === true) w.push('i.reviewed = 1')
  if (q.q) {
    const l = `%${String(q.q).slice(0, 80)}%`
    w.push('(i.summary LIKE ? OR i.match_id LIKE ? OR i.map_key LIKE ? OR i.steam_id LIKE ? OR i.box LIKE ? OR i.bug LIKE ? OR i.note LIKE ?)')
    v.push(l, l, l, l, l, l, l)
  }
  if (Number(q.since) > 0) { w.push('i.at >= ?'); v.push(Number(q.since)) }
  return { W: w.length ? 'WHERE ' + w.join(' AND ') : '', v }
}

function list (q = {}) {
  const n = Math.max(1, Math.min(200, Number(q.size) || 50))
  const p = Math.max(1, Number(q.page) || 1)
  const { W, v } = where(q)
  const sort = SORT[q.sort] || SORT.at
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC'
  const total = db.prepare(`SELECT COUNT(*) c FROM incidents i ${W}`).get(...v).c
  const rows = db.prepare(`SELECT * FROM incidents i ${W} ORDER BY ${sort} ${dir}, i.id DESC LIMIT ? OFFSET ?`).all(...v, n, (p - 1) * n)
  // Facets over everything (not the current filter), so a chip never vanishes when picked.
  const rules = new Map(catalogue().map((r) => [r.id, r]))
  const flags = db.prepare("SELECT j.value flag, COUNT(*) c FROM incidents i, json_each(i.flags) j WHERE json_valid(i.flags) GROUP BY j.value ORDER BY c DESC").all()
    .map((x) => ({ flag: x.flag, label: (rules.get(x.flag) || {}).label || x.flag, severity: (rules.get(x.flag) || {}).severity || null, c: x.c }))
  return {
    total, page: p, size: n,
    rows: rows.map((r) => pub(r)),
    facets: {
      flags,
      kinds: db.prepare('SELECT kind, COUNT(*) c FROM incidents GROUP BY kind ORDER BY c DESC').all(),
      versions: db.prepare('SELECT launcher_version v, COUNT(*) c FROM incidents WHERE launcher_version IS NOT NULL GROUP BY launcher_version ORDER BY launcher_version DESC LIMIT 40').all(),
      maps: db.prepare('SELECT map_key map, COUNT(*) c FROM incidents WHERE map_key IS NOT NULL GROUP BY map_key ORDER BY c DESC LIMIT 80').all(),
      people: db.prepare("SELECT COALESCE(steam_id, box) who, COUNT(*) c FROM incidents WHERE COALESCE(steam_id, box) IS NOT NULL GROUP BY COALESCE(steam_id, box) ORDER BY c DESC LIMIT 80").all()
        .map((x) => ({ who: x.who, name: nameOf(x.who) || x.who, c: x.c })),
    },
    unreviewed: unreviewed(),
  }
}

function unreviewed ({ days = 30 } = {}) {
  const since = now() - days * 86400_000
  const r = db.prepare('SELECT severity, COUNT(*) c FROM incidents WHERE reviewed=0 AND at >= ? AND severity <= 2 GROUP BY severity').all(since)
  const o = { p1: 0, p2: 0 }
  for (const x of r) o[`p${x.severity}`] = x.c
  return o
}

const detail = (id) => pub(byRowId(id), { full: true })

function review (id, { reviewed, bug, note }, by) {
  const r = byRowId(id)
  if (!r) return null
  const on = reviewed === undefined ? !!r.reviewed : !!reviewed
  db.prepare('UPDATE incidents SET reviewed=?, reviewed_by=?, reviewed_at=?, bug=?, note=? WHERE id=?')
    .run(on ? 1 : 0, on ? by : null, on ? now() : null,
      bug === undefined ? r.bug : (bug ? String(bug).slice(0, 500) : null),
      note === undefined ? r.note : (note ? String(note).slice(0, 2000) : null), r.id)
  return detail(r.id)
}

// ---- the AI brief ------------------------------------------------------------------------
// Plain text sized for pasting into a model: what, who, versions, the summary, every flag
// with its detail and the log lines around it. Newest excerpt lines are kept when over.
function brief (id) {
  const r = detail(id)
  if (!r) return null
  const m = r.manifest || {}
  const ts = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '?')
  const head = [
    `ENW Zombies incident #${r.id} — ${SEVERITY_NAMES[r.severity] || 'P' + r.severity}`,
    `kind: ${r.kind} (${KIND_WORDS[r.kind] || ''})   reason: ${r.reason || '-'}   source: ${r.source}`,
    `when: ${ts(r.at)}${r.count > 1 ? `   (×${r.count}, last ${ts(r.last_at)})` : ''}   received: ${ts(r.received_at)}`,
    `who: ${r.who ? `${r.who.name} (${r.who.steam_id})` : (r.box || '-')}`,
    `map: ${r.map_key || '-'}   match: ${r.match_id || '-'}   instance: ${r.instance || '-'}`,
    `launcher: ${r.launcher_version || '-'}   dll: ${r.dll_sha || '-'}`,
    m.machine ? `machine: ${JSON.stringify(m.machine)}` : null,
    m.session ? `DLL session: ${JSON.stringify(m.session)}` : null,
    m.exit_code != null || m.exit_reason ? `exit: code ${m.exit_code ?? '-'}, reason ${m.exit_reason || '-'}, duration ${m.duration_ms ? Math.round(m.duration_ms / 1000) + ' s' : '-'}` : null,
    m.summary_line ? `host SUMMARY: ${String(m.summary_line).slice(0, 600)}` : null,
    m.host ? `box health: ${JSON.stringify(m.host)}` : null,
    m.wer ? `WER: ${JSON.stringify(m.wer)}` : null,
    Array.isArray(m.events) && m.events.length ? `Windows events: ${m.events.slice(0, 5).map((e) => `${e.id || e.Id} ${String(e.message || e.Message || '').replace(/\s+/g, ' ').slice(0, 300)}`).join(' | ')}` : null,
    r.bug ? `bug line: ${r.bug}` : null,
    r.note ? `note: ${r.note}` : null,
    '',
    `SUMMARY: ${r.summary}`,
    '',
    `FILES: ${(r.files || []).map((f) => `${f.name}${f.refused ? ' (refused)' : ` ${fmtBytes(f.size || 0)}${f.binary ? ' bin' : ''}${f.truncated ? ' tail' : ''}`}`).join(', ') || '-'}`,
    `BUNDLE: ${r.download || 'not stored'}`,
  ].filter((x) => x != null)
  let out = head.join('\n') + '\n'
  const flags = r.flags || []
  if (!flags.length) out += '\nNo flag fired.\n'
  // Budget the excerpts across flags, worst first.
  let left = BRIEF_MAX - out.length
  for (const f of flags) {
    const h = r.hits[f] || {}
    const rule = byId.get(f)
    let block = `\n=== FLAG ${f} — ${h.label || f} (P${h.severity}) ×${h.count || 1}\n${h.detail ? `detail: ${h.detail}\n` : ''}${rule ? `rule: ${rule.description}\n` : ''}`
    for (const e of h.excerpts || []) {
      block += `--- ${e.file}${e.line ? ` from line ${e.line}` : ''}${e.tail ? ' (end of log)' : ''}\n${(e.lines || []).join('\n')}\n`
    }
    if (block.length > left) block = block.slice(0, Math.max(0, left - 40)) + '\n[… cut: brief size limit]\n'
    out += block
    left -= block.length
    if (left <= 0) break
  }
  return out
}

// ---- the digest -------------------------------------------------------------------------
// One day's incidents grouped by flag, for `logs/digest/<date>.json`.
function digest (date) {
  const start = Date.parse(`${date}T00:00:00Z`)
  const end = start + 86400_000
  const store = require('./store')
  const rows = db.prepare('SELECT * FROM incidents WHERE at >= ? AND at < ? ORDER BY severity, at').all(start, end)
  const groups = {}
  const entry = (r) => ({ id: r.id, at: new Date(r.at).toISOString(), severity: r.severity, kind: r.kind, reason: r.reason, who: r.steam_id ? `${nameOf(r.steam_id)} (${r.steam_id})` : r.box, map: r.map_key, version: r.launcher_version, count: r.count || 1, summary: r.summary, bundle: r.upload_state === 'uploaded' ? store.publicUrl(r.bucket_key) : null, admin: `/admin?tab=issues&incident=${r.id}` })
  for (const r of rows) {
    const fl = J(r.flags, [])
    for (const f of (fl.length ? fl : ['(no flags)'])) {
      if (!groups[f]) { const rule = byId.get(f); groups[f] = { flag: f, label: rule ? rule.label : f, severity: rule ? rule.severity : 4, count: 0, incidents: [] } }
      groups[f].count++
      if (groups[f].incidents.length < 200) groups[f].incidents.push(entry(r))
    }
  }
  const bySev = { 1: 0, 2: 0, 3: 0, 4: 0 }
  for (const r of rows) bySev[r.severity] = (bySev[r.severity] || 0) + 1
  return {
    date, generated_at: new Date().toISOString(), total: rows.length,
    severity: { p1: bySev[1], p2: bySev[2], p3: bySev[3], p4: bySev[4] },
    unreviewed: rows.filter((r) => !r.reviewed).length,
    groups: Object.values(groups).sort((a, b) => a.severity - b.severity || b.count - a.count),
  }
}

module.exports = { insert, recordSite, list, detail, review, brief, digest, summarize, unreviewed, byRowId, pub, rules: catalogue }
