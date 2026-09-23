// Replay FX: the event -> scene-state reducer (lane R3, replay.md §12).
//
// The recording gains six event kinds (lane R1, docs/protocol/replay-events-v1.md):
//   weapon  {t, pid, name, pap, raw}            what a player holds, from this moment
//   fire    {t, pid, name}                       one shot
//   hit     {t, pid, zid, part, dmg}             a player's shot landed on a zombie
//   damage  {t, pid, by, hp}                     a player was hurt (by = zombie id)
//   pap     {t, pid, name, state}                Pack-a-Punch: "start" | "done"
//   powerup {t, id, kind, x, y, z, state, by?, until?}   "spawn" | "pickup" | "expire"
//
// This file turns them into what the viewer draws AT A GIVEN INSTANT, as a pure function of
// (events, time). A paused, scrubbed or played frame at the same time is the same picture,
// which is the rule every overlay in this viewer already keeps (waw.js, §8.11). No three.js,
// no DOM, no audio here: web/test/replay-fx.js imports it straight into node.
//
// OLD REPLAYS. A file with none of these events gives an empty index, and every query below
// answers "nothing": no flash, no marker, no pickup, no chip. The held weapon still comes from
// the snapshot column the track always had (`players[].wpn`), which is recorded data.
//
// FIELD CONVENTIONS. Today's events are `{t: "<kind>", ms, slot}`; the R1 contract names the
// player `pid`. Both are accepted: kind from a string `t` (or `type`), time from `ms` (or a
// numeric `t`), player from `pid` (or `slot`). Nothing else is guessed.

export const FX_KINDS = ['weapon', 'fire', 'hit', 'damage', 'pap', 'powerup']
const FX_SET = new Set(FX_KINDS)

// How long each effect lasts, in replay milliseconds.
export const FX_MS = {
  flash: 60,          // muzzle flash sprite (B's ask: ~60 ms)
  // Hit marker: _damagefeedback.gsc shows the marker at alpha 1 and fadeOverTime(1) to 0 --
  // one second, linear. [H] recalled from the stock script, not re-read from the zone.
  hitMarker: 1000,
  // The blood overlay on a swipe: full at the hit, gone by 1.2 s. ENW's, not WaW's numbers
  // (WaW's own is the red flash + the direction smear, which §8.11 already draws).
  blood: 1200,
}

// Timed power-ups: the ones with a HUD countdown. Stock WaW runs each for 30 s
// (_zombiemode_powerups.gsc: `wait 30` in the insta-kill and double-points threads); the
// asset manifest's durationMs wins, and the event's `until` wins over both.
export const TIMED = new Set(['insta_kill', 'double_points', 'fire_sale', 'death_machine'])
export const DEFAULT_TIMED_MS = 30000
// A pickup nobody collected: WaW blinks it out 26.5 s after the drop (powerup_timeout:
// wait 15, blink for 11.5). Used only when the file has no `expire` for it.
export const POWERUP_TIMEOUT_MS = 26500

export const POWERUP_LABEL = {
  max_ammo: 'Max Ammo', insta_kill: 'Insta-Kill', double_points: 'Double Points', nuke: 'Kaboom!',
  carpenter: 'Carpenter', fire_sale: 'Fire Sale', death_machine: 'Death Machine', other: 'Power-up',
}

// ---------------------------------------------------------------- normalising --

/** One raw event -> `{ type, ms, pid, ...fields }`, or null if it is not an FX event. */
export function normEvent(e) {
  if (!e || typeof e !== 'object') return null
  const type = typeof e.t === 'string' ? e.t : (typeof e.type === 'string' ? e.type : null)
  if (!type || !FX_SET.has(type)) return null
  const ms = Number.isFinite(e.ms) ? e.ms : (typeof e.t === 'number' ? e.t : NaN)
  if (!Number.isFinite(ms)) return null
  const pid = e.pid !== undefined ? e.pid : e.slot
  const out = { type, ms, pid: pid === undefined || pid === null ? null : Number(pid) }
  for (const k of ['name', 'pap', 'raw', 'zid', 'part', 'dmg', 'kill', 'by', 'hp', 'state', 'id', 'kind', 'until']) {
    if (e[k] !== undefined) out[k] = e[k]
  }
  if (Array.isArray(e.pos) && e.pos.length >= 3) { out.x = +e.pos[0]; out.y = +e.pos[1]; out.z = +e.pos[2] }
  if (e.x !== undefined) out.x = +e.x
  if (e.y !== undefined) out.y = +e.y
  if (e.z !== undefined) out.z = +e.z
  return out
}

// ------------------------------------------------------------------- weapons --

/** `zombie_colt_upgraded` -> `zombie_colt`; the base weapon a PaP'd name belongs to. */
export function baseWeapon(name) {
  const s = String(name || '')
  return s.replace(/_upgraded(_zm)?$/, '').replace(/_zm$/, '')
}

// NAMES (replay-events-v1 §2). An event's `name` is the engine name with `_upgraded`, a leading
// `zombie_` and a trailing `_zombie` stripped (`zombie_thompson_upgraded` -> `thompson`, pap true;
// `ptrs41_zombie` -> `ptrs41`); `raw` is the engine's own; a snapshot's `weapon` is the engine name;
// `"#<index>"` means the weapon table was not bound. Tables here (waw.js WEAPONS, DISPLAY, the asset
// manifest) are keyed by whichever form they were written in, so every lookup tries all of them.
/** Lookup keys for a weapon, most specific first: raw, raw without _upgraded, the stripped core, zombie_core, core_zombie. */
export function weaponKeys(name, raw) {
  const out = []
  const add = (k) => { if (k && !out.includes(k)) out.push(k) }
  for (const n of [raw, name]) {
    if (!n || /^#/.test(String(n))) continue
    const full = String(n)
    add(full)
    const b = baseWeapon(full)
    add(b)
    const core = b.replace(/^zombie_/, '').replace(/_zombie$/, '')
    add(core)
    add('zombie_' + core)
    add(core + '_zombie')
  }
  return out
}
/** `zombie_thompson_upgraded` / `thompson` -> `thompson`: the form v1 events use for `name`. */
export const coreWeapon = (n) => baseWeapon(n).replace(/^zombie_/, '').replace(/_zombie$/, '')
const pick = (table, keys) => { if (table) for (const k of keys) if (table[k]) return table[k]; return null }

/**
 * The asset manifest's weapon entry for a name, or null: R2's `weaponByEngineName` (engine name ->
 * { weapon, pap }) first, then every key form. Returns { entry, key, pap } (pap null = not said).
 */
export function assetWeapon(assets, name, raw) {
  const W = assets && assets.weapons
  if (!W) return null
  const by = assets.weaponByEngineName
  if (by) {
    for (const n of [raw, name]) {
      const m = n && by[n]
      if (m && W[m.weapon]) return { entry: W[m.weapon], key: m.weapon, pap: !!m.pap }
    }
  }
  for (const k of weaponKeys(name, raw)) if (W[k]) return { entry: W[k], key: k, pap: null }
  return null
}

// What a weapon LOOKS like when there is no model for it: a class from waw.js's weapon table
// when the name is there (its `cls`), else a guess from the name, else a rifle. Two non-guns the
// scripts put in players' hands (v1 §2) have their own: the Pack-a-Punch knuckle crack is empty
// hands ('none'), a perk is a bottle.
const CLASS_BY_NAME = [
  [/knuckle_crack/, 'none'], [/perk_bottle|perk/, 'bottle'],
  [/ray_?gun|raygun/, 'raygun'], [/tesla|thunder|wunder/, 'wonder'],
  [/colt|walther|357|nambu|tokarev|pistol|luger|m1911/, 'pistol'],
  [/thompson|mp40|ppsh|type100|stg|mp44|smg/, 'smg'],
  [/30cal|mg42|fg42|bar|dp28|type99|lmg|browning/, 'mg'],
  [/shotgun|doublebarrel|trench|ithaca|m1897/, 'spread'],
  [/panzer|bazooka|launcher|rpg/, 'launcher'],
  [/flame/, 'flame'],
  [/grenade|frag|molotov|stiel|mk2|satchel|betty/, 'grenade'],
  [/knife|melee|bowie/, 'melee'],
  [/kar98|springfield|garand|gewehr|carbine|mosin|svt|ptrs|arisaka|rifle/, 'rifle'],
]
export function weaponClass(name, table, raw) {
  const keys = weaponKeys(name, raw)
  const s = keys.join(' ').toLowerCase()
  if (/knuckle_crack/.test(s)) return 'none'
  if (/perk_bottle/.test(s)) return 'bottle'
  const row = pick(table, keys)
  if (row && row.cls) {
    if (/ray_?gun/.test(s)) return 'raygun'
    return row.cls === 'rocketlauncher' ? 'launcher' : row.cls === 'gas' ? 'flame' : row.cls
  }
  for (const [re, cls] of CLASS_BY_NAME) if (re.test(s)) return cls
  return 'rifle'
}

// Display names. The asset manifest's `displayName` is used when it is there; this table is
// the fallback for the stock zombies weapons (the names the game's own HUD/wall-buys use), and
// anything else is its file name made readable. Pack-a-Punch names are WaW's own.
const DISPLAY = {
  zombie_colt: 'M1911', colt: 'M1911', knuckle_crack: 'Pack-a-Punch', zombie_knuckle_crack: 'Pack-a-Punch', m1911: 'M1911', walther: 'Walther P38', sw_357: '.357 Magnum', nambu: 'Nambu',
  m1carbine: 'M1A1 Carbine', m1garand: 'M1 Garand', m1garand_gl: 'M1 Garand w/ Launcher', kar98k: 'Kar98k',
  kar98k_scoped_zombie: 'Scoped Kar98k', springfield: 'Springfield', gewehr43: 'Gewehr 43', mosin_rifle: 'Mosin-Nagant',
  svt40: 'SVT-40', type99_rifle: 'Arisaka', ptrs41_zombie: 'PTRS-41', ptrs41: 'PTRS-41',
  thompson: 'Thompson', mp40: 'MP40', stg44: 'STG-44', ppsh: 'PPSh-41', type100_smg: 'Type 100',
  bar: 'BAR', '30cal_bipod': 'Browning M1919', mg42_bipod: 'MG42', fg42_bipod: 'FG42', dp28: 'DP-28', type99_lmg: 'Type 99',
  shotgun: 'M1897 Trench Gun', doublebarrel: 'Double-Barreled Shotgun', doublebarrel_sawed_grip: 'Sawed-Off Shotgun',
  panzerschrek: 'Panzerschreck', m2_flamethrower_zombie: 'M2 Flamethrower', ray_gun: 'Ray Gun', tesla_gun: 'Wunderwaffe DG-2',
  stielhandgranate: 'Stielhandgranate', fraggrenade: 'Frag Grenade', mk2_frag: 'Mk 2 Grenade', molotov: 'Molotov',
  zombie_melee: 'Knife', bowie_knife: 'Bowie Knife',
}
// WaW's upgraded names (the game's PATCH_*_UPGRADED strings; assets-pipeline.md §2 confirms the
// six R2 extracted). The asset manifest's pap.displayName wins over this table.
const DISPLAY_PAP = {
  zombie_colt: 'C-3000 b1at-ch35', colt: 'C-3000 b1at-ch35', ray_gun: "Porter's X2 Ray Gun", tesla_gun: 'Wunderwaffe DG-3 JZ',
  thompson: 'Gibs-o-matic', mp40: 'The Afterburner', stg44: 'Spatz-447 +', bar: 'The Widow Maker',
  '30cal_bipod': 'B115 Accelerator', mg42_bipod: "Barracuda FU-A11", fg42_bipod: 'Die Klaue',
  m1carbine: 'Widdershins RC-1', m1garand: 'The Imploder', kar98k: 'Armageddon',
  gewehr43: 'G115 Compressor', ptrs41_zombie: 'The Penetrator', kar98k_scoped_zombie: 'Armageddon',
  shotgun: 'Gut Shot', doublebarrel: 'Bang Bangs', doublebarrel_sawed_grip: 'Snuff Box', panzerschrek: 'Longinus',
}
const pretty = (s) => String(s).replace(/^zombie_/, '').replace(/_zombie$/, '').replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase())

/** The name to show for a weapon, PaP'd or not. `assets` is /mapdata/_assets.json or null. */
export function displayName(name, pap, assets, raw) {
  if (!name && !raw) return null
  if (/^#/.test(String(name || '')) && !raw) return null     // weapon table not bound: no name to show
  const keys = weaponKeys(name, raw)
  if (!keys.length) return null
  if (/perk_bottle/.test(keys[0])) return 'Perk-a-Cola'
  const aw = assetWeapon(assets, name, raw)
  const w = aw && aw.entry
  if (w) {
    if (pap && w.pap && w.pap.displayName) return w.pap.displayName
    if (w.displayName) return pap && !w.pap ? `${w.displayName} (PaP)` : w.displayName
  }
  const plain = pick(DISPLAY, keys)
  const core = coreWeapon(keys[0])
  if (pap) return pick(DISPLAY_PAP, keys) || `${plain || pretty(core)} (PaP)`
  return plain || pretty(core)
}

/** Remaining time as the HUD shows it: tenths of a second, rounded DOWN (0.0 is the end). */
export function fmtTenths(ms) {
  const t = Math.max(0, Math.floor(ms / 100))      // tenths
  const s = Math.floor(t / 10)
  const d = t % 10
  if (s >= 60) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${d}`
  return `${s}.${d}`
}

// ------------------------------------------------------------------ indexing --

// Binary search: the index of the last element of the sorted `arr` that is <= v, or -1.
export function lastLE(arr, v) {
  let lo = 0
  let hi = arr.length - 1
  let out = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= v) { out = mid; lo = mid + 1 } else hi = mid - 1
  }
  return out
}

function perPid(map, pid) {
  let a = map.get(pid)
  if (!a) { a = { ms: [], ev: [] }; map.set(pid, a) }
  return a
}

/**
 * Index a track's FX events once. Everything per-frame below is a binary search into this.
 *
 * @param track   the decoded track; FX events are read from `track.fx` (routes/replay.js),
 *                and also from `track.events` in case a builder put them there
 * @param assets  /mapdata/_assets.json, or null (durations, and which power-ups are timed)
 */
export function buildFx(track, assets = null) {
  const raw = []
  for (const e of (track && track.fx) || []) raw.push(e)
  for (const e of (track && track.events) || []) if (e && FX_SET.has(e.t)) raw.push(e)
  const evs = []
  for (const e of raw) { const n = normEvent(e); if (n) evs.push(n) }
  evs.sort((a, b) => a.ms - b.ms)

  const fx = {
    count: evs.length,
    weapons: new Map(),   // pid -> { ms: [], ev: [{name, pap, raw}] }
    fires: new Map(),     // pid -> { ms: [], ev: [{name}] }
    hits: new Map(),      // pid -> { ms: [], ev: [{zid, part, dmg}] }
    damage: new Map(),    // pid -> { ms: [], ev: [{by, hp}] }
    pap: new Map(),       // pid -> { ms: [], ev: [{name, state}] }
    powerups: [],         // [{ id, kind, x, y, z, spawnMs, goneMs, pickupMs, by, activeUntil }]
    windows: [],          // timed power-ups in effect: [{ kind, from, to, by }]
    cues: [],             // sound cues, sorted by ms: { ms, kind, pid, name, pap, x, y, z, pkind }
    feed: [],             // lines for the event feed: pickups and PaP
  }
  const dur = (kind) => {
    const a = assets && assets.powerups && assets.powerups[kind]
    if (a && Number.isFinite(a.durationMs) && a.durationMs > 0) return a.durationMs
    return TIMED.has(kind) ? DEFAULT_TIMED_MS : 0
  }
  const pups = new Map()  // id -> record (the live one for that id)

  for (const e of evs) {
    switch (e.type) {
      case 'weapon': {
        if (e.pid === null) break
        const pap = !!e.pap || /_upgraded(_zm)?$/.test(String(e.name || '')) || /_upgraded(_zm)?$/.test(String(e.raw || ''))
        const a = perPid(fx.weapons, e.pid)
        a.ms.push(e.ms); a.ev.push({ name: e.name || null, pap, raw: e.raw === undefined ? null : e.raw })
        break
      }
      case 'fire': {
        if (e.pid === null) break
        const a = perPid(fx.fires, e.pid)
        a.ms.push(e.ms); a.ev.push({ name: e.name || null })
        fx.cues.push({ ms: e.ms, kind: 'fire', pid: e.pid, name: e.name || null, pap: null })
        break
      }
      case 'hit': {
        if (e.pid === null) break
        const a = perPid(fx.hits, e.pid)
        a.ms.push(e.ms); a.ev.push({ zid: e.zid === undefined ? null : e.zid, part: e.part === 'head' ? 'head' : 'body', dmg: +e.dmg || 0, kill: e.kill === true })
        fx.cues.push({ ms: e.ms, kind: 'hit', pid: e.pid, part: e.part === 'head' ? 'head' : 'body' })
        break
      }
      case 'damage': {
        if (e.pid === null) break
        const a = perPid(fx.damage, e.pid)
        a.ms.push(e.ms); a.ev.push({ by: e.by === undefined ? null : e.by, hp: Number.isFinite(+e.hp) ? +e.hp : null })
        fx.cues.push({ ms: e.ms, kind: 'damage', pid: e.pid })
        break
      }
      case 'pap': {
        if (e.pid === null) break
        const state = e.state === 'done' ? 'done' : 'start'
        const a = perPid(fx.pap, e.pid)
        a.ms.push(e.ms); a.ev.push({ name: e.name || null, state })
        if (state === 'start') fx.cues.push({ ms: e.ms, kind: 'pap', pid: e.pid, name: e.name || null })
        else fx.cues.push({ ms: e.ms, kind: 'pap_done', pid: e.pid, name: e.name || null })
        fx.feed.push({ t: 'pap', ms: e.ms, slot: e.pid, name: e.name || null, raw: e.raw || null, state })
        break
      }
      case 'powerup': {
        const id = e.id === undefined ? `${e.kind}:${e.ms}` : e.id
        const kind = e.kind && POWERUP_LABEL[e.kind] ? e.kind : 'other'
        let p = pups.get(id)
        if (e.state === 'spawn' || !p) {
          if (e.state !== 'spawn' && !p) {
            // A pickup/expire for a drop the file never spawned (the recording started late):
            // no model to draw, but the pickup and its timer are still real.
            p = { id, kind, x: e.x, y: e.y, z: e.z, spawnMs: null, goneMs: e.ms, pickupMs: null, by: null, activeUntil: null }
          } else {
            p = { id, kind, x: e.x, y: e.y, z: e.z, spawnMs: e.ms, goneMs: e.ms + POWERUP_TIMEOUT_MS, pickupMs: null, by: null, activeUntil: null }
            fx.cues.push({ ms: e.ms, kind: 'powerup_spawn', pkind: kind, x: e.x, y: e.y, z: e.z })
          }
          fx.powerups.push(p)
          pups.set(id, p)
          if (e.state === 'spawn') break
        }
        if (e.state === 'pickup') {
          p.pickupMs = e.ms
          p.goneMs = Math.min(p.goneMs, e.ms)
          p.by = e.by === undefined ? null : e.by
          // `until` is on the events' own clock. A value smaller than the pickup time is read
          // as a duration (a builder that sends "30000"), which is stated in replay.md §12.
          let until = Number(e.until)
          if (Number.isFinite(until) && until > 0 && until <= e.ms) until = e.ms + until
          const d = dur(kind)
          const to = Number.isFinite(until) && until > e.ms ? until : (d > 0 ? e.ms + d : null)
          if (to !== null) {
            p.activeUntil = to
            fx.windows.push({ kind, from: e.ms, to, by: p.by, id })
          }
          fx.cues.push({ ms: e.ms, kind: 'powerup_pickup', pkind: kind, pid: p.by, x: p.x, y: p.y, z: p.z })
          fx.feed.push({ t: 'powerup', ms: e.ms, kind, slot: p.by })
        } else if (e.state === 'expire') {
          if (p.pickupMs === null) {
            p.goneMs = Math.min(p.goneMs, e.ms)       // an uncollected drop blinked out
          } else {
            // The effect ended (early, or on time): cut its window here.
            for (const w of fx.windows) if (w.id === id && w.to > e.ms) w.to = e.ms
            p.activeUntil = Math.min(p.activeUntil === null ? e.ms : p.activeUntil, e.ms)
          }
        }
        break
      }
      default: break
    }
  }
  for (const w of fx.windows) {
    const covered = fx.windows.some((o) => o !== w && o.kind === w.kind && o.from <= w.to && o.to > w.to)
    if (!covered) fx.cues.push({ ms: w.to, kind: 'powerup_end', pkind: w.kind })
  }
  fx.cues.sort((a, b) => a.ms - b.ms)
  fx.cueMs = fx.cues.map((c) => c.ms)
  return fx
}

// ------------------------------------------------------------------- queries --

/**
 * What a player holds at `ms`: the last `weapon` event, else the snapshot column.
 * `colName` is `(pid) => name|null` for the snapshot fallback (the viewer's weaponNameAt).
 * Pack-a-Punch: the event's own `pap`, or a PaP `done` for the same base weapon after it.
 * Writes into `out` ({ name, pap, source }) and returns it: no allocation per frame.
 */
export function weaponAt(fx, pid, ms, colName, out) {
  out.name = null; out.pap = false; out.source = 'none'; out.raw = null
  const w = fx && fx.weapons.get(pid)
  const i = w ? lastLE(w.ms, ms) : -1
  if (i >= 0) {
    const e = w.ev[i]
    out.name = e.name; out.pap = e.pap; out.source = 'event'; out.raw = e.raw
    const p = fx.pap.get(pid)
    if (!out.pap && p && e.name) {
      const base = coreWeapon(e.name)
      for (let k = lastLE(p.ms, ms); k >= 0 && p.ms[k] >= w.ms[i]; k--) {
        if (p.ev[k].state === 'done' && (!p.ev[k].name || coreWeapon(p.ev[k].name) === base)) { out.pap = true; break }
      }
    }
    return out
  }
  if (colName) {
    const n = colName(pid)
    if (n) { out.name = n; out.raw = n; out.pap = /_upgraded(_zm)?$/.test(n); out.source = 'snapshot' }
  }
  return out
}

/** Milliseconds since the player's last shot at or before `ms`, or Infinity. */
export function fireAge(fx, pid, ms) {
  const f = fx && fx.fires.get(pid)
  if (!f) return Infinity
  const i = lastLE(f.ms, ms)
  return i < 0 ? Infinity : ms - f.ms[i]
}

/** The hit marker for a player at `ms`: { alpha, part } in `out`, alpha 0 when none. */
export function hitMarkerAt(fx, pid, ms, out) {
  out.alpha = 0; out.part = 'body'; out.age = Infinity
  const h = fx && fx.hits.get(pid)
  if (!h) return out
  const i = lastLE(h.ms, ms)
  if (i < 0) return out
  const age = ms - h.ms[i]
  if (age >= FX_MS.hitMarker) return out
  out.age = age
  out.alpha = 1 - age / FX_MS.hitMarker
  out.part = h.ev[i].part
  return out
}

/** The blood overlay for a player at `ms`: { alpha, hp } in `out`. Harder hits (lower hp) read stronger. */
export function bloodAt(fx, pid, ms, out) {
  out.alpha = 0; out.hp = null; out.age = Infinity
  const d = fx && fx.damage.get(pid)
  if (!d) return out
  const i = lastLE(d.ms, ms)
  if (i < 0) return out
  const age = ms - d.ms[i]
  if (age >= FX_MS.blood) return out
  const hp = d.ev[i].hp
  const weight = hp === null ? 0.8 : Math.min(1, 0.55 + (100 - Math.max(0, Math.min(100, hp))) / 160)
  out.age = age
  out.hp = hp
  out.alpha = weight * (1 - age / FX_MS.blood)
  return out
}

/** Whether a player is at the Pack-a-Punch machine at `ms` (between a start and its done). */
export function papBusyAt(fx, pid, ms) {
  const p = fx && fx.pap.get(pid)
  if (!p) return false
  const i = lastLE(p.ms, ms)
  return i >= 0 && p.ev[i].state === 'start' && ms - p.ms[i] < 8000
}

/**
 * Power-up pickups on the ground at `ms`, written into the pooled array `out` (objects are
 * reused; `out.length` is set). Each: { id, kind, x, y, z, age } with age in ms since the drop.
 */
export function powerupsAt(fx, ms, out) {
  let n = 0
  if (fx) {
    for (const p of fx.powerups) {
      if (p.spawnMs === null || ms < p.spawnMs || ms >= p.goneMs || !Number.isFinite(p.x)) continue
      let o = out[n]
      if (!o) { o = {}; out[n] = o }
      o.id = p.id; o.kind = p.kind; o.x = p.x; o.y = p.y; o.z = p.z; o.age = ms - p.spawnMs
      // The last 11.5 s before a timeout blink, as the game's powerup_timeout does.
      o.blink = p.pickupMs === null && p.goneMs - ms < 11500 ? ((Math.floor((ms - p.spawnMs) / 250) & 1) === 1) : false
      n++
    }
  }
  out.length = n
  return out
}

/**
 * Timed power-ups in effect at `ms`, one chip per kind with the longest time left, written into
 * the pooled `out`: { kind, label, leftMs, text }. Sorted by kind order for a steady layout.
 */
const CHIP_ORDER = ['insta_kill', 'double_points', 'fire_sale', 'death_machine', 'other']
export function chipsAt(fx, ms, out) {
  let n = 0
  if (fx) {
    for (const kind of CHIP_ORDER) {
      let left = -1
      for (const w of fx.windows) if (w.kind === kind && ms >= w.from && ms < w.to && w.to - ms > left) left = w.to - ms
      if (left <= 0) continue
      let o = out[n]
      if (!o) { o = {}; out[n] = o }
      o.kind = kind; o.label = POWERUP_LABEL[kind]; o.leftMs = left; o.text = fmtTenths(left)
      n++
    }
  }
  out.length = n
  return out
}

// -------------------------------------------------------------------- audio --

// Seconds of REPLAY time scheduled ahead of the clock: Movement's audio.js LOOKAHEAD, the same
// idea -- only what falls inside this window is ever queued, so a pause or a seek has at most
// this much to throw away.
export const LOOKAHEAD_MS = 250

/**
 * The cue scheduler, lifted from Movement's replay3d/audio.js `update` (CSGO-Matchmaker) and
 * made pure: it decides WHICH cues to start and WHEN (seconds from now), and the caller's
 * `emit(cue, delaySec)` makes the noise. A seek, a jump the seek path did not announce, or a
 * speed change drops everything queued (`drop()`), and cues the clock skipped over are NOT
 * played late -- scrubbing across a fight is silent.
 */
export class CueScheduler {
  constructor(fx) {
    this.cues = (fx && fx.cues) || []
    this.cueMs = (fx && fx.cueMs) || this.cues.map((c) => c.ms)
    this.index = 0
    this.cursor = -Infinity    // replay ms up to which cues have been handed out
    this.rate = 1
    this.onDrop = null         // () => void: stop every source already started/scheduled
  }
  drop() { if (this.onDrop) this.onDrop() }
  /** Put the cursor at `ms` without playing anything (seek, scrub, pause). */
  seek(ms) {
    this.drop()
    this.cursor = ms
    this.index = lastLE(this.cueMs, ms - 1e-6) + 1
  }
  /**
   * Called every frame. `playing` false keeps the cursor on the clock and plays nothing.
   * Returns the number of cues emitted this call.
   */
  update(ms, playing, rate, emit) {
    const speed = rate > 0 ? rate : 1
    if (!playing) { if (this.cursor !== ms) { this.cursor = ms; this.index = lastLE(this.cueMs, ms - 1e-6) + 1 } return 0 }
    if (this.rate !== speed || ms < this.cursor - LOOKAHEAD_MS * speed - 500 || ms > this.cursor + 1000) {
      // A speed change restretches the queue; a clock that jumped belongs to another part of
      // the replay. Both start again from here, and what was skipped stays silent.
      this.drop()
      this.rate = speed
      this.cursor = ms
      this.index = lastLE(this.cueMs, ms - 1e-6) + 1
    }
    const until = ms + LOOKAHEAD_MS * speed
    let n = 0
    while (this.index < this.cues.length && this.cueMs[this.index] <= until) {
      const c = this.cues[this.index++]
      // Timed off THIS frame's clock; one the frame already stepped past plays now.
      emit(c, Math.max(0, (c.ms - ms) / 1000 / speed))
      n++
    }
    if (until > this.cursor) this.cursor = until
    return n
  }
}

/**
 * Which sounds a cue plays, from the asset manifest (lane R2, assets-pipeline.md §3), or null --
 * no manifest means no sound at all, never a broken viewer. Values are manifest paths
 * ("_sounds/mp40_fire.ogg", relative to /mapdata/) or bare keys (-> /mapdata/_sounds/<key>.ogg).
 *   fire           -> weapons[w].sounds.fire (third person) or .fire_plr (`firstPerson`); upgraded:
 *                     pap.sounds.fire(_plr), else sounds.fire_pap(_plr)
 *   hit            -> general.hit_marker (hit_marker_head if one exists)
 *   damage         -> general.zombie_swipe, then general.player_hit (the swipe, then the pain)
 *   pap            -> general.pap_upgrade (the machine at work)
 *   pap_done       -> general.pap_ready
 *   powerup_spawn  -> powerups[kind].spawnSound, else general.powerup_spawn
 *   powerup_pickup -> powerups[kind].sounds.pickup, .announce (2D), .sting (2D, max ammo)
 *   powerup_end    -> powerups[kind].sounds.end (insta-kill / double points running out)
 */
export function soundsFor(cue, assets, pap, firstPerson) {
  if (!assets) return null
  const S = (assets.sounds && assets.sounds.general) || assets.sounds || {}
  const G = (k) => (typeof S[k] === 'string' || Array.isArray(S[k]) ? S[k] : null)
  switch (cue.kind) {
    case 'fire': {
      const aw = assetWeapon(assets, cue.name, cue.raw)
      const w = aw && aw.entry
      if (!w) return null
      const ws = w.sounds || {}
      const ps = (w.pap && w.pap.sounds) || {}
      if (pap) {
        const v = firstPerson ? (ps.fire_plr || ws.fire_pap_plr || ps.fire || ws.fire_pap) : (ps.fire || ws.fire_pap)
        if (v) return [v]
      }
      return [(firstPerson && ws.fire_plr) || ws.fire || null]
    }
    case 'hit': return [(cue.part === 'head' && G('hit_marker_head')) || G('hit_marker')]
    case 'damage': return [G('zombie_swipe'), G('player_hit')]
    case 'pap': return [G('pap_upgrade') || G('pap_jingle')]
    case 'pap_done': return [G('pap_ready') || G('pap_done')]
    case 'powerup_spawn': {
      const p = assets.powerups && assets.powerups[cue.pkind]
      return [(p && (p.spawnSound || (p.sounds && p.sounds.spawn))) || G('powerup_spawn')]
    }
    case 'powerup_pickup': {
      const p = assets.powerups && assets.powerups[cue.pkind]
      const ps = (p && p.sounds) || {}
      return [ps.pickup || G('powerup_grab') || G('powerup_pickup'), ps.announce || null, ps.sting || null]
    }
    case 'powerup_end': {
      const p = assets.powerups && assets.powerups[cue.pkind]
      return [(p && p.sounds && p.sounds.end) || null]
    }
    default: return null
  }
}

/** A manifest sound value -> a URL. A bare key is /mapdata/_sounds/<key>.ogg. */
export function soundUrl(v, base = '/mapdata') {
  if (!v) return null
  base = String(base).replace(/\/+$/, '')
  if (Array.isArray(v)) v = v[0]
  const s = String(v)
  if (/^(https?:)?\//.test(s)) return s
  if (/\.(ogg|wav|mp3|m4a|opus)$/i.test(s)) return `${base}/${s.replace(/^\.?\//, '')}`
  return `${base}/_sounds/${encodeURIComponent(s)}.ogg`
}
