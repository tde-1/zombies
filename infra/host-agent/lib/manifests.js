// Per-map manifests: the CONSUMER side of `enw.referee.manifest/0`.
//
// OWNERSHIP: `referee/manifests/*.json` and `referee/manifests/_schema.md` belong to the
// referee agent. The host agent only reads them. This file implements the evaluator the
// schema describes, against the game-link v0 event stream.
//
// The schema's own rules, honoured here:
//   * finishes are evaluated in `priority` order, LOWEST FIRST
//     (1 = Easter Egg, 2 = Buyable Ending, 3 = Round N) — the badge ranking in vault 05.
//   * a map with no manifest needs none: the default is `round`, N = 20.
//   * `{"manual": true}` never awards automatically. An ungated badge is worse than a
//     missing one, so it is treated as permanently false and reported as needing review.
//   * `solo_ok: false` means the finish does not count in a 1-player game.
//
// Conditions are stateful (`seq`, `count`, `requires`), so each GAME gets its own
// evaluator instance built from the shared manifest.
import fs from 'node:fs'
import path from 'node:path'
import { makeLog, canonical } from './util.js'

const log = makeLog('manifests')

export const SCHEMA = 'enw.referee.manifest/0'
export const DEFAULT_ROUND_N = 20

/** The manifest used for a map that has no file — exactly what _schema.md prescribes. */
export function defaultManifest(map) {
  return {
    schema: SCHEMA,
    map: map || '*',
    title: map || 'Unknown map',
    source: 'stock',
    fs_game: null,
    badge: { main_finish: 'round', round_n: DEFAULT_ROUND_N },
    finishes: [{ id: 'round', label: `Round ${DEFAULT_ROUND_N}`, priority: 3, when: { round_at_least: DEFAULT_ROUND_N } }],
    signals: [],
    confidence: 'default',
    _source: '(built-in default: no manifest for this map)',
    _default: true,
  }
}

export class ManifestStore {
  constructor(dirs) {
    this.dirs = dirs.filter(Boolean)
    this.byMap = new Map()
    this.reload()
  }

  reload() {
    this.byMap.clear()
    for (const dir of this.dirs) {
      let files = []
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { continue }
      for (const f of files) {
        const p = path.join(dir, f)
        try {
          const m = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (!m.map) { log.warn(`${p}: no "map" field, skipped`); continue }
          if (m.schema && m.schema !== SCHEMA) log.warn(`${p}: schema "${m.schema}" is not ${SCHEMA} — reading it anyway`)
          m._source = p
          this.byMap.set(String(m.map).toLowerCase(), m)
        } catch (e) { log.warn(`${p}: ${e.message}`) }
      }
    }
    log.info(`loaded ${this.byMap.size} manifest(s): ${[...this.byMap.keys()].join(', ') || '(none)'}`)
    return this.byMap.size
  }

  get(map) {
    return this.byMap.get(String(map || '').toLowerCase()) || defaultManifest(map)
  }

  list() { return [...this.byMap.values()] }
}

// ---- conditions ------------------------------------------------------------------
// Every node exposes: feed(ev, ctx) -> fired-now (bool), and `.done` (sticky true).

class Cond {
  constructor() { this.done = false }
  feed() { return false }
}

class Never extends Cond {           // {"manual": true}
  constructor(reason) { super(); this.reason = reason; this.manual = true }
}

class Flag extends Cond {            // {"flag":"x"} — flag_set() does level notify(<flag>)
  constructor(name) { super(); this.name = name }
  feed(ev) {
    if (this.done) return false
    if (ev.t !== 'notify') return false
    if (ev.name !== this.name) return false
    if (ev.ent && ev.ent !== 'level') return false
    this.done = true
    return true
  }
}

class Notify extends Cond {          // {"notify":{"ent":"level"|"any","name":"x"}}
  constructor(spec) { super(); this.ent = spec.ent ?? 'any'; this.name = spec.name }
  feed(ev) {
    if (this.done) return false
    if (ev.t !== 'notify' || ev.name !== this.name) return false
    if (this.ent !== 'any' && ev.ent !== this.ent) return false
    this.done = true
    return true
  }
}

class RoundAtLeast extends Cond {    // {"round_at_least":N}
  constructor(n) { super(); this.n = Number(n) }
  feed(ev, ctx) {
    if (this.done) return false
    const r = ev.t === 'round' ? Number(ev.n) : (ctx?.maxRound ?? 0)
    if (!(r >= this.n)) return false
    this.done = true
    return true
  }
}

class TriggerUsed extends Cond {     // {"trigger_used":{"targetname":"x","zombie_cost":50000}}
  constructor(spec) { super(); this.spec = spec }
  feed(ev) {
    if (this.done) return false
    if (ev.t !== 'notify' || ev.name !== 'trigger') return false
    const a = ev.args || {}
    for (const [k, v] of Object.entries(this.spec)) if (String(a[k]) !== String(v)) return false
    this.done = true
    return true
  }
}

// {"level_var":{"name":"tom_victory","equals":true}} — added to the schema after the
// nazi_zombie_ali scan: a custom map's ending may set a plain script variable rather
// than a flag, and a variable does not notify. The DLL therefore POLLS a small allow-list
// of level variables and sends `level_var` when one changes (see the protocol doc).
class LevelVar extends Cond {
  constructor(spec) { super(); this.spec = spec }
  feed(ev, ctx) {
    if (this.done) return false
    const cur = ev.t === 'level_var' && ev.name === this.spec.name ? ev.value : ctx?.levelVars?.[this.spec.name]
    if (cur === undefined) return false
    // Loose equality on purpose: GSC's `true` arrives as 1 from some builtins.
    const want = this.spec.equals
    const same = cur === want || String(cur) === String(want) ||
      (typeof want === 'boolean' && Boolean(cur === 1 || cur === '1' || cur === true) === want)
    if (!same) return false
    this.done = true
    return true
  }
}

class DvarIs extends Cond {          // {"dvar":{"name":"x","equals":"1"}}
  constructor(spec) { super(); this.spec = spec }
  feed(ev, ctx) {
    if (this.done) return false
    const cur = ev.t === 'dvar' && ev.name === this.spec.name ? ev.value : ctx?.dvars?.[this.spec.name]
    if (cur == null || String(cur) !== String(this.spec.equals)) return false
    this.done = true
    return true
  }
}

class All extends Cond {
  constructor(kids) { super(); this.kids = kids }
  feed(ev, ctx) {
    if (this.done) return false
    let any = false
    for (const k of this.kids) if (k.feed(ev, ctx)) any = true
    if (any && this.kids.every((k) => k.done)) { this.done = true; return true }
    return false
  }
}

class Any extends Cond {
  constructor(kids) { super(); this.kids = kids }
  feed(ev, ctx) {
    if (this.done) return false
    for (const k of this.kids) if (k.feed(ev, ctx)) { this.done = true; return true }
    return false
  }
}

class Seq extends Cond {             // each becomes true IN ORDER
  constructor(kids) { super(); this.kids = kids; this.i = 0 }
  feed(ev, ctx) {
    if (this.done) return false
    const k = this.kids[this.i]
    if (!k) { this.done = true; return true }
    if (!k.feed(ev, ctx)) return false
    this.i++
    if (this.i >= this.kids.length) { this.done = true; return true }
    return false
  }
}

class Count extends Cond {           // {"count":{"of":<cond>,"n":6}} — n DISTINCT firings
  constructor(spec) {
    super()
    this.n = Number(spec.n)
    this.spec = spec.of
    this.seen = new Set()
  }
  feed(ev, ctx) {
    if (this.done) return false
    // A fresh inner node per event: `count` is about distinct occurrences, so the inner
    // condition must not latch after the first one.
    const probe = buildCond(this.spec)
    if (!probe.feed(ev, ctx)) return false
    this.seen.add(canonical({ ent: ev.ent, name: ev.name, args: ev.args, slot: ev.slot }))
    if (this.seen.size < this.n) return false
    this.done = true
    return true
  }
}

export function buildCond(spec) {
  if (!spec || typeof spec !== 'object') return new Never('empty condition')
  if (spec.manual) return new Never('manual: needs staff review')
  if (spec.flag != null) return new Flag(spec.flag)
  if (spec.notify) return new Notify(spec.notify)
  if (spec.round_at_least != null) return new RoundAtLeast(spec.round_at_least)
  if (spec.trigger_used) return new TriggerUsed(spec.trigger_used)
  if (spec.dvar) return new DvarIs(spec.dvar)
  if (spec.level_var) return new LevelVar(spec.level_var)
  if (spec.all) return new All(spec.all.map(buildCond))
  if (spec.any) return new Any(spec.any.map(buildCond))
  if (spec.seq) return new Seq(spec.seq.map(buildCond))
  if (spec.count) return new Count(spec.count)
  return new Never(`unknown condition ${Object.keys(spec).join(',')}`)
}

/** Maps a finish id/priority onto the kind the badge model understands. */
export function finishKind(f) {
  if (f.id === 'easter_egg' || f.priority === 1) return 'easter_egg'
  if (f.id === 'buyable_ending' || f.priority === 2) return 'buyable_ending'
  if (f.id === 'round' || f.priority === 3) return 'round'
  return f.id
}

/** One game's evaluation of one manifest. Stateful; do not share between games. */
export class ManifestEvaluator {
  constructor(manifest) {
    this.manifest = manifest || defaultManifest(null)
    this.finishes = (this.manifest.finishes || []).map((f) => ({
      spec: f,
      id: f.id,
      label: f.label || f.id,
      priority: Number(f.priority ?? 99),
      kind: finishKind(f),
      soloOk: f.solo_ok !== false,
      when: buildCond(f.when),
      requires: f.requires ? buildCond(f.requires) : null,
      achieved: false,
      atMs: null,
      atRound: null,
    })).sort((x, y) => x.priority - y.priority)
    this.signals = (this.manifest.signals || []).map((s) => ({
      id: s.id, label: s.label || s.id, when: buildCond(s.when), seen: false, atMs: null,
    }))
    this.manualFinishes = this.finishes.filter((f) => f.when instanceof Never && f.when.manual).map((f) => f.id)
  }

  /**
   * Feed one event. Returns { finishes: [...newly achieved], signals: [...newly seen] }.
   * `ctx` carries { round, maxRound, players, dvars } from the referee.
   */
  feed(ev, ctx) {
    const out = { finishes: [], signals: [] }
    for (const s of this.signals) {
      if (s.seen) continue
      if (s.when.feed(ev, ctx)) { s.seen = true; s.atMs = ev.ms ?? null; out.signals.push(s) }
    }
    for (const f of this.finishes) {
      if (f.achieved) continue
      // `requires` is an ordering guard: it must have gone true at some earlier point.
      if (f.requires) f.requires.feed(ev, ctx)
      const fired = f.when.feed(ev, ctx)
      if (!fired) continue
      if (f.requires && !f.requires.done) continue      // out of order: not this finish
      if (!f.soloOk && (ctx?.players ?? 1) <= 1) continue
      f.achieved = true
      f.atMs = ev.ms ?? null
      f.atRound = ctx?.round ?? null
      out.finishes.push(f)
    }
    return out
  }

  /** The best finish achieved so far — lowest priority number wins. */
  best() {
    const done = this.finishes.filter((f) => f.achieved)
    if (!done.length) return null
    const f = done.reduce((a, b) => (a.priority <= b.priority ? a : b))
    return { id: f.id, kind: f.kind, label: f.label, priority: f.priority, at_round: f.atRound, at_ms: f.atMs }
  }

  /** The badge this map mints, per `badge.main_finish`. */
  badgeEarned() {
    const want = this.manifest.badge?.main_finish || 'round'
    const b = this.best()
    if (!b) return null
    return { minted: b.kind === want, main_finish: want, ...b }
  }

  seenSignals() { return this.signals.filter((s) => s.seen).map((s) => s.id) }
}
