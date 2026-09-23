#!/usr/bin/env node
// What rate does a replay ACTUALLY record at, and what would the 20 Hz zombie track cost?
//
//   node tools/replay-rate.js <file.enwr> [more.enwr ...] [--project] [--json]
//
// WHY (lane R1, 2026-09-23). B: "the replay snapshot rate looks too low". The DLL's comment
// said "players 20 Hz, zombies 10 Hz"; this reads what the file says instead:
//   * player snaps per second, zombie snaps per second (a snap carrying a `zombies` list),
//   * the spacing between snaps, and the size in MB per game-hour.
//
// --project re-encodes the SAME events with the host's own writer (zstd-10, 60 s chunks)
// three ways, so before and after are compared like for like:
//   before   the file as recorded (re-encoded: should match the real size within a few %),
//   20hz     every snap between two zombie snaps gets a zombie list, positions linearly
//            interpolated by id (what a replay-events-v1 DLL records, minus the real
//            sub-50 ms motion -- see the caveat in replay-events-v1.md section 4),
//   20hz+ev  the 20 Hz track plus a SYNTHETIC replay-events-v1 load at the rates in
//            R1_LOAD below (fire / hit / damage / weapon / powerup and the clip/ammo fields),
//            only while a zombie is up. The rates are assumptions, stated, not measurements.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readHeader, readEvents, ReplayWriter } from '../lib/replay.js'
import * as keys from '../lib/keys.js'
import { parseArgs } from '../lib/util.js'

// Per player, per second with at least one zombie up. A WaW round-5 player on an SMG fires
// in bursts; 4 shots/s averaged over the time zombies are up is generous for a zombies game
// (a pistol round-1 player is under 2).
export const R1_LOAD = { fire: 4, hit: 3, damage: 0.1, weapon: 0.05, powerup: 1 / 180 }

/** Pure: rate facts about one game's events. */
export function rateSummary(events) {
  let first = null, last = null, snaps = 0, withPlayers = 0, withZombies = 0
  const gaps = { lt40: 0, g40_60: 0, g60_110: 0, ge110: 0 }
  const counts = {}
  let prev = null
  for (const ev of events) {
    counts[ev.t] = (counts[ev.t] || 0) + 1
    if (ev.t !== 'snap') continue
    snaps++
    if (ev.players?.length) withPlayers++
    if (ev.zombies?.length) withZombies++
    if (first == null) first = ev.ms
    last = ev.ms
    if (prev != null) {
      const g = ev.ms - prev
      if (g < 40) gaps.lt40++; else if (g < 60) gaps.g40_60++; else if (g < 110) gaps.g60_110++; else gaps.ge110++
    }
    prev = ev.ms
  }
  const seconds = first == null ? 0 : (last - first) / 1000
  const per = (n) => (seconds > 0 ? Math.round((n / seconds) * 100) / 100 : null)
  return { seconds, snaps, snapHz: per(snaps), playerHz: per(withPlayers), zombieHz: per(withZombies), gaps, counts }
}

const r1 = (v) => Math.round(v * 10) / 10
function lerpAngle(a, b, f) {
  let d = ((b - a + 540) % 360) - 180
  return a + d * f
}

/**
 * Pure: give every snap that sits between two zombie snaps its own zombie list, positions
 * interpolated by id. A pre-R1 DLL writes zombies on every OTHER frame, so this is the 20 Hz
 * track's shape (same fields, same rounding), with straight-line motion in between.
 */
export function upsampleZombies(events) {
  const snaps = []
  events.forEach((ev, i) => { if (ev.t === 'snap') snaps.push(i) })
  const out = events.slice()
  for (let k = 1; k + 1 < snaps.length; k++) {
    const cur = events[snaps[k]]
    if (cur.zombies) continue
    const a = events[snaps[k - 1]], b = events[snaps[k + 1]]
    if (!a.zombies?.length || !b.zombies?.length) continue
    const f = b.ms > a.ms ? (cur.ms - a.ms) / (b.ms - a.ms) : 0.5
    const byId = new Map(b.zombies.map((z) => [z.id, z]))
    const zombies = a.zombies.map((za) => {
      const zb = byId.get(za.id)
      const z = { id: za.id, pos: za.pos, yaw: za.yaw, health: za.health }
      if (zb && za.pos && zb.pos) z.pos = za.pos.map((v, j) => r1(v + (zb.pos[j] - v) * f))
      if (zb && za.yaw != null && zb.yaw != null) z.yaw = r1(lerpAngle(za.yaw, zb.yaw, f))
      if (z.yaw == null) delete z.yaw
      return z
    })
    const up = { ...cur, zombies }
    if (a.zombies_alive != null && up.zombies_alive == null) up.zombies_alive = a.zombies_alive
    if (a.kills_round != null && up.kills_round == null) up.kills_round = a.kills_round
    out[snaps[k]] = up
  }
  return out
}

/** Pure, deterministic: a synthetic replay-events-v1 load at R1_LOAD rates (see header). */
export function addSyntheticR1(events, load = R1_LOAD) {
  const out = []
  const acc = new Map()
  const clip = new Map()
  let lastMs = null
  for (const ev of events) {
    if (ev.t !== 'snap' || !ev.players?.length) { out.push(ev); continue }
    const dt = lastMs == null ? 0 : Math.max(0, Math.min(200, ev.ms - lastMs)) / 1000
    lastMs = ev.ms
    const hot = (ev.zombies?.length || ev.zombies_alive) > 0
    const snap = { ...ev, players: ev.players.map((p) => ({ ...p })) }
    const extra = []
    for (const p of snap.players) {
      const a = acc.get(p.slot) || { fire: 0, hit: 0, damage: 0, weapon: 0, powerup: 0 }
      acc.set(p.slot, a)
      if (!hot) continue
      for (const k of Object.keys(load)) a[k] += load[k] * dt
      const z = ev.zombies?.[0]?.id ?? 300
      while (a.fire >= 1) {
        a.fire--
        extra.push({ t: 'fire', ms: ev.ms, slot: p.slot, name: 'thompson' })
        let c = (clip.get(p.slot) ?? 30) - 1
        if (c <= 0) { c = 30; p.ammo = 150 }
        clip.set(p.slot, c)
        p.clip = c
      }
      while (a.hit >= 1) { a.hit--; extra.push({ t: 'hit', ms: ev.ms, slot: p.slot, zid: z, part: 'body', dmg: 150 }) }
      while (a.damage >= 1) { a.damage--; extra.push({ t: 'damage', ms: ev.ms, slot: p.slot, by: z, hp: 60 }) }
      while (a.weapon >= 1) {
        a.weapon--
        extra.push({ t: 'weapon', ms: ev.ms, slot: p.slot, name: 'mp40', pap: false, raw: 'zombie_mp40' })
        p.weapon = 'zombie_mp40'
      }
      while (a.powerup >= 1) {
        a.powerup--
        extra.push({ t: 'powerup', ms: ev.ms, id: 412, kind: 'max_ammo', x: 120.5, y: -300.2, z: 40.1, state: 'spawn' })
        extra.push({ t: 'powerup', ms: ev.ms + 4000, id: 412, kind: 'max_ammo', x: 120.5, y: -300.2, z: 40.1, state: 'pickup', by: p.slot })
      }
    }
    out.push(snap, ...extra)
  }
  return out
}

function encodedSize(events, dir, tag, key) {
  const file = path.join(dir, `${tag}.enwr`)
  const w = new ReplayWriter({ file, header: { match_id: tag }, privateKey: key.privateKey, pub: key.pub, keyId: key.keyId, level: 10 })
  for (const ev of events) w.append(ev)
  const st = w.close()
  fs.rmSync(file, { force: true })
  return st.size
}

export function project(events, { dir = os.tmpdir(), key = null } = {}) {
  const k = key || (() => { const p = keys.generate(); const r = keys.exportPair(p); return { ...r, privateKey: p.privateKey, keyId: 'measure' } })()
  const s = rateSummary(events)
  const hours = s.seconds / 3600
  const mbh = (bytes) => (hours > 0 ? Math.round((bytes / 1e6 / hours) * 100) / 100 : null)
  const up = upsampleZombies(events)
  const ev = addSyntheticR1(up)
  const before = encodedSize(events, dir, 'r1-before', k)
  const hz20 = encodedSize(up, dir, 'r1-20hz', k)
  const hz20ev = encodedSize(ev, dir, 'r1-20hz-ev', k)
  return {
    seconds: s.seconds,
    zombieHzBefore: s.zombieHz,
    zombieHzAfter: rateSummary(up).zombieHz,
    bytes: { before, hz20, hz20ev },
    mbPerHour: { before: mbh(before), hz20: mbh(hz20), hz20ev: mbh(hz20ev) },
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('replay-rate.js')) {
  const a = parseArgs(process.argv.slice(2))
  const files = a._
  if (!files.length) {
    console.error('usage: replay-rate.js <file.enwr> [...] [--project] [--json]')
    process.exit(2)
  }
  const tot = { seconds: 0, size: 0, before: 0, hz20: 0, hz20ev: 0 }
  for (const f of files) {
    let h, events
    try { h = readHeader(f).header; events = [...readEvents(f)] } catch (e) { console.log(`${path.basename(f)}  unreadable: ${e.message}`); continue }
    const s = rateSummary(events)
    if (!s.snaps || s.seconds < 5) { if (!a.json) console.log(`${path.basename(f)}  ${h.map}  no game (${s.snaps} snaps)`); continue }
    const size = fs.statSync(f).size
    const row = { file: path.basename(f), map: h.map, dll_build: h.dll_build || null, box: h.box || null,
      replay_events: h.replay_events ?? 0, ...s, bytes: size, mbPerHour: Math.round((size / 1e6 / (s.seconds / 3600)) * 100) / 100 }
    if (a.project) row.project = project(events)
    tot.seconds += s.seconds
    tot.size += size
    if (row.project) { tot.before += row.project.bytes.before; tot.hz20 += row.project.bytes.hz20; tot.hz20ev += row.project.bytes.hz20ev }
    if (a.json) { console.log(JSON.stringify(row)); continue }
    console.log(`${row.file}  ${row.map}  dll ${row.dll_build}  ${Math.round(s.seconds)}s  players ${s.playerHz} Hz  zombies ${s.zombieHz} Hz  ` +
      `${row.mbPerHour} MB/h` + (row.project ? `  | re-encoded ${row.project.mbPerHour.before}  20 Hz zombies ${row.project.mbPerHour.hz20}  +events ${row.project.mbPerHour.hz20ev} MB/h` : ''))
  }
  if (!a.json && tot.seconds > 0) {
    const h = tot.seconds / 3600
    const m = (b) => Math.round((b / 1e6 / h) * 100) / 100
    console.log(`\nALL  ${Math.round(tot.seconds)} s of game  actual ${m(tot.size)} MB/h` +
      (tot.before ? `  | re-encoded ${m(tot.before)}  20 Hz zombies ${m(tot.hz20)}  +events ${m(tot.hz20ev)} MB/h` : ''))
  }
}
