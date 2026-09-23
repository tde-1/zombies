'use strict'

// Easter egg / power / song / ending guides for a map (2026-09-23).
//
// B: "Figure out a way to explain Easter eggs ... an Easter egg guide section that is
// blurred by default, with 'Show Easter egg steps' ... If a map has no Easter egg steps,
// don't show the section. Later we can work out each map's Easter eggs from the script
// files."
//
// Where they come from today: `archive/easter_eggs.py` reads the crawl cache (the release
// posts on callofdutyrepo, the UGX-Mods threads, moddb, archive.org descriptions) and the
// readmes shipped inside the maps we hold, finds the sections that are INSTRUCTIONS rather
// than feature lists, and writes `<archive work>/reports/map_guides.json`. That file comes
// in here through `node server/db/import-archive.js --guides` — never by hand, never over
// HTTP. Every guide is somebody else's words, so it carries the author's handle and the
// page it was posted on, and the map page prints both beside it (ip-posture.md: community
// text is quoted with attribution and a link, never copied wholesale).
//
// A guide is a heuristic's output. Its `confidence` is the script's own score and is shown
// to staff, not players; staff can hide one (reversible) or delete it (a tombstone, so the
// next import does not bring it back). `origin` leaves room for the second source B named:
// guides worked out of a map's own GSC scripts will arrive as `origin='script'` rows.

const { db, now } = require('../db/database')

const KINDS = ['easter_egg', 'power', 'song', 'ending', 'other']
const TAB = { easter_egg: 'Main quest', power: 'Power', song: 'Song', ending: 'Ending', other: 'Side quest' }
const KIND_ORDER = Object.fromEntries(KINDS.map((k, i) => [k, i]))
const STATES = ['live', 'hidden', 'deleted']

const MAX_STEPS = 40
const MAX_TEXT = 600

const sigOf = (mapKey, kind, title) => `${mapKey}|${kind}|${String(title || '').trim().toLowerCase()}`

function httpUrl(u) {
  if (!u) return null
  try { const x = new URL(String(u)); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null } catch { return null }
}

const str = (v, n) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null)

// Steps as the page will draw them: `{text, head?, label?, details?[]}`, nothing else.
// The JSON came off a scraper, so every field is re-typed and capped here rather than
// trusted — it ends up in front of every visitor.
function cleanSteps(steps) {
  if (!Array.isArray(steps)) return []
  const out = []
  for (const s of steps.slice(0, MAX_STEPS)) {
    const t = str(typeof s === 'string' ? s : s && s.text, MAX_TEXT)
    if (!t) continue
    const o = { text: t }
    if (s && s.head) o.head = true
    const label = s && str(s.label, 80)
    if (label) o.label = label
    if (s && Array.isArray(s.details)) {
      const d = s.details.map((x) => str(x, MAX_TEXT)).filter(Boolean).slice(0, 12)
      if (d.length) o.details = d
    }
    out.push(o)
  }
  // a guide that is only sub-headings is not a guide
  return out.some((s) => !s.head) ? out : []
}

/**
 * Load a `enw.map_guides/1` document. Each guide names the site keys it may belong to,
 * most specific first (a pipeline map's bsp, then `cat:<norm>`); the first that exists
 * wins, and a guide for a map the site does not have is counted and skipped.
 *
 * Idempotent: a guide is identified by (map, kind, title). A re-import updates it in
 * place and keeps whatever staff decided (hidden / deleted); an archive-made guide that
 * the new file no longer contains is removed, unless staff touched it.
 */
function importDoc(doc, { dry = false } = {}) {
  const stats = { in_file: 0, inserted: 0, updated: 0, unchanged: 0, tombstoned: 0, no_map: 0, bad: 0, removed: 0, kept_by_staff: 0, maps: 0 }
  if (!doc || !Array.isArray(doc.guides)) throw new Error('not a map_guides document (no guides[])')
  const exists = db.prepare('SELECT key FROM maps WHERE key=?')
  const get = db.prepare('SELECT * FROM map_guides WHERE sig=?')
  const ins = db.prepare(`INSERT INTO map_guides (sig, map_key, kind, title, reward, steps_json, source_url, source_site,
      source_author, source_file, confidence, evidence_json, origin, state, imported_at, updated_at)
      VALUES (@sig,@map_key,@kind,@title,@reward,@steps_json,@source_url,@source_site,@source_author,@source_file,
      @confidence,@evidence_json,'archive','live',@t,@t)`)
  const upd = db.prepare(`UPDATE map_guides SET reward=@reward, steps_json=@steps_json, source_url=@source_url,
      source_site=@source_site, source_author=@source_author, source_file=@source_file, confidence=@confidence,
      evidence_json=@evidence_json, imported_at=@t, updated_at=@t WHERE sig=@sig`)
  const seen = new Set()
  const maps = new Set()
  const t = now()

  const run = () => {
    for (const g of doc.guides) {
      stats.in_file++
      const kind = KINDS.includes(g && g.kind) ? g.kind : null
      const steps = cleanSteps(g && g.steps)
      const conf = Number(g && g.confidence)
      if (!kind || !steps.length || !Number.isFinite(conf)) { stats.bad++; continue }
      const keys = [...(Array.isArray(g.map_keys) ? g.map_keys : []), g.map_key].filter(Boolean).map(String)
      const mapKey = keys.find((k) => exists.get(k))
      if (!mapKey) { stats.no_map++; continue }
      const title = str(g.title, 80) || TAB[kind]
      const row = {
        sig: sigOf(mapKey, kind, title),
        map_key: mapKey, kind, title,
        reward: str(g.reward, 60),
        steps_json: JSON.stringify(steps),
        source_url: httpUrl(g.source_url),
        source_site: str(g.source_site, 60),
        source_author: str(g.source_author, 60),
        source_file: str(g.source_file, 200),
        confidence: Math.max(0, Math.min(1, Math.round(conf * 100) / 100)),
        evidence_json: g.evidence ? JSON.stringify(g.evidence).slice(0, 2000) : null,
        t,
      }
      if (seen.has(row.sig)) { stats.bad++; continue }
      seen.add(row.sig)
      maps.add(mapKey)
      const cur = get.get(row.sig)
      if (!cur) { if (!dry) ins.run(row); stats.inserted++; continue }
      // Staff deleted it: the tombstone stands, whatever the report says now.
      if (cur.state === 'deleted') { stats.tombstoned++; continue }
      if (cur.steps_json === row.steps_json && cur.source_url === row.source_url && cur.confidence === row.confidence && cur.reward === row.reward) {
        stats.unchanged++
        continue
      }
      if (!dry) upd.run(row)
      stats.updated++
    }
    // Gone from the file: the heuristic no longer finds it. Staff decisions stay.
    const stale = db.prepare("SELECT id, sig, state, staff_by FROM map_guides WHERE origin='archive'").all().filter((r) => !seen.has(r.sig))
    for (const r of stale) {
      if (r.state !== 'live' || r.staff_by) { stats.kept_by_staff++; continue }
      if (!dry) db.prepare('DELETE FROM map_guides WHERE id=?').run(r.id)
      stats.removed++
    }
  }
  if (dry) run(); else db.transaction(run)()
  stats.maps = maps.size
  return stats
}

function shape(r, { staff = false } = {}) {
  let steps = []
  try { steps = JSON.parse(r.steps_json) } catch { /* a row the importer wrote is valid JSON */ }
  const o = {
    id: r.id,
    kind: r.kind,
    tab: TAB[r.kind] || 'Guide',
    title: r.title,
    reward: r.reward,
    steps,
    source: { url: r.source_url, site: r.source_site, author: r.source_author, file: r.source_file },
  }
  if (staff) {
    o.map_key = r.map_key
    o.confidence = r.confidence
    o.confidence_label = r.confidence >= 0.7 ? 'high' : r.confidence >= 0.45 ? 'medium' : 'low'
    o.state = r.state
    o.origin = r.origin
    o.staff_by = r.staff_by
    o.staff_at = r.staff_at
    try { o.evidence = r.evidence_json ? JSON.parse(r.evidence_json) : null } catch { o.evidence = null }
  }
  return o
}

/** The live guides for one map, main quest first. Empty array when there are none. */
function forMap(mapKey) {
  return db.prepare("SELECT * FROM map_guides WHERE map_key=? AND state='live'").all(String(mapKey))
    .sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (b.confidence - a.confidence) || (a.id - b.id))
    .map((r) => shape(r))
}

/** Map keys with a live MAIN-QUEST guide — the cards' "EE" tag. */
function mainQuestKeys() {
  return new Set(db.prepare("SELECT DISTINCT map_key FROM map_guides WHERE kind='easter_egg' AND state='live'").all().map((r) => r.map_key))
}

/** Every guide for staff, with its confidence and state; deleted ones only on request. */
function adminList({ state } = {}) {
  const rows = state && STATES.includes(state)
    ? db.prepare('SELECT g.*, m.title AS map_title FROM map_guides g LEFT JOIN maps m ON m.key=g.map_key WHERE g.state=?').all(state)
    : db.prepare("SELECT g.*, m.title AS map_title FROM map_guides g LEFT JOIN maps m ON m.key=g.map_key WHERE g.state<>'deleted'").all()
  rows.sort((a, b) => (a.confidence - b.confidence) || String(a.map_key).localeCompare(String(b.map_key)))
  const counts = Object.fromEntries(STATES.map((s) => [s, db.prepare('SELECT COUNT(*) c FROM map_guides WHERE state=?').get(s).c]))
  counts.maps = db.prepare("SELECT COUNT(DISTINCT map_key) c FROM map_guides WHERE state='live'").get().c
  return { guides: rows.map((r) => ({ ...shape(r, { staff: true }), map_title: r.map_title })), counts }
}

/**
 * Hide, restore or delete one guide. Delete keeps a tombstone (state='deleted', steps
 * cleared) so that the next import does not quietly put it back.
 */
function setState(id, state, actor) {
  if (!STATES.includes(state)) return { ok: false, error: 'state is live, hidden or deleted' }
  const r = db.prepare('SELECT * FROM map_guides WHERE id=?').get(Number(id))
  if (!r) return { ok: false, error: 'no such guide' }
  const t = now()
  if (state === 'deleted') {
    db.prepare("UPDATE map_guides SET state='deleted', steps_json='[]', staff_by=?, staff_at=?, updated_at=? WHERE id=?").run(actor || null, t, t, r.id)
  } else {
    if (r.state === 'deleted') return { ok: false, error: 'a deleted guide cannot be restored; re-run the import after clearing the tombstone' }
    db.prepare('UPDATE map_guides SET state=?, staff_by=?, staff_at=?, updated_at=? WHERE id=?').run(state, actor || null, t, t, r.id)
  }
  db.prepare('INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES (?,?,?,?)')
    .run(`guide.${state}`, actor || null, JSON.stringify({ id: r.id, map: r.map_key, kind: r.kind, title: r.title }), t)
  return { ok: true, guide: shape(db.prepare('SELECT * FROM map_guides WHERE id=?').get(r.id), { staff: true }) }
}

module.exports = { importDoc, forMap, mainQuestKeys, adminList, setState, cleanSteps, KINDS, TAB }
