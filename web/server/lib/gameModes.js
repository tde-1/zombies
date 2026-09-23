'use strict'

// A map's own game modes (docs/kickstart/game-modes.md, lane UGX, 2026-09-23).
//
// Some custom maps ask for a choice in a menu when the game starts — Battlestar Galactica's UGX
// Mod vote (Classic / Gun Game / Arcade Mode / Sharpshooter / Bounty Hunter). The party leader
// picks it here instead, the lease carries it, the server answers the menu so nobody ever sees
// it, and records are kept per mode.
//
// The catalogue is data/map-modes.json, written by archive/scan_modes.py from the maps' own
// scripts (which modes the map's settings allow, which response picks each). A map with no entry
// has no modes and nothing here applies to it. `other` in that file lists menus the scanner
// found but that are not a known mechanism — those are never answered automatically.

const fs = require('fs')
const path = require('path')
const { safeJson } = require('./util')

const FILE = process.env.ZM_MAP_MODES_FILE || path.join(__dirname, '..', 'data', 'map-modes.json')
const TOKEN = /^[A-Za-z0-9_]{1,63}$/

let cache = { mtime: 0, doc: { maps: {}, mechanisms: {} } }
function doc() {
  try {
    const st = fs.statSync(FILE)
    if (st.mtimeMs !== cache.mtime) {
      const d = safeJson(fs.readFileSync(FILE, 'utf8'), {}) || {}
      cache = { mtime: st.mtimeMs, doc: { maps: d.maps || {}, mechanisms: d.mechanisms || {} } }
    }
  } catch { cache = { mtime: 0, doc: { maps: {}, mechanisms: {} } } }
  return cache.doc
}

function entry(mapKey) {
  const d = doc()
  const e = mapKey ? d.maps[String(mapKey)] : null
  if (!e || !Array.isArray(e.modes) || !e.modes.length) return null
  const mech = d.mechanisms[e.mechanism]
  if (!mech) return null
  return { e, mech }
}

/** What the site and the rail show: `{ default, modes: [{id, label, note}] }`, or null. */
function forMap(mapKey) {
  const x = entry(mapKey)
  if (!x) return null
  return {
    default: x.e.default,
    mechanism: x.e.mechanism,
    modes: x.e.modes.map((m) => ({ id: m.id, label: m.label, note: m.note || null })),
  }
}

/**
 * The mode a party / lease really gets: the asked-for id if the map offers it, else the map's
 * default; null for a map with no modes (whatever was asked).
 */
function resolve(mapKey, id) {
  const x = entry(mapKey)
  if (!x) return null
  const want = id == null ? '' : String(id)
  if (x.e.modes.some((m) => m.id === want)) return want
  return x.e.default
}

function label(mapKey, id) {
  const x = entry(mapKey)
  const m = x && x.e.modes.find((mm) => mm.id === id)
  return m ? m.label : (id || null)
}

/**
 * What the box needs to answer the menu (infra/host-agent/lib/gamemode.js re-checks every
 * piece). null when the map has no modes or the entry is not usable — never half of one.
 */
function leaseSpec(mapKey, id) {
  const x = entry(mapKey)
  if (!x) return null
  const m = x.e.modes.find((mm) => mm.id === id)
  if (!m) return null
  const spec = {
    id: m.id,
    label: m.label,
    mechanism: x.e.mechanism,
    hide: [...(x.mech.hide || [])],
    answer_menu: x.mech.answer_menu,
    responses: [m.response, x.mech.start].filter(Boolean),
    done: x.mech.done || null,
  }
  const toks = [spec.id, spec.answer_menu, ...spec.hide, ...spec.responses, ...(spec.done ? [spec.done] : [])]
  if (!toks.every((t) => TOKEN.test(String(t)))) return null
  if (!spec.hide.includes(spec.answer_menu) || spec.responses.length < 1) return null
  return spec
}

module.exports = { forMap, resolve, label, leaseSpec, FILE }
