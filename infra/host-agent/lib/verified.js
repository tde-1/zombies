// The Verified environment judge (docs/kickstart/verified-rules.md).
//
// The DLL REPORTS (server/components/referee/verified_env.hpp): every watched server dvar
// once at load and on change (`dvar`), and each client's reported FPS cap (`client_dvar`,
// from userinfo `enw_fps`, written by client-dll fps_guard.cpp). This file JUDGES, because
// the host is where a result becomes a record and a rule change must not need a DLL deploy.
//
// Pure: no I/O, no clock. `EnvLog` accumulates; `judge()` answers.

export const RULESET = 'ENW-Verified-2026-09-23'

// Server dvars and the value a Verified game must hold for its WHOLE length. Every value is
// the stock one a real dedicated server printed in its own dvar dump
// (ZombiesDev\logs\dedi\maps\nazi_zombie_leviathan.console.log); verified-rules.md §3.
export const SERVER_RULES = Object.freeze({
  sv_cheats: '0',
  timescale: '1',
  fixedtime: '0',
  developer: '0',
  developer_script: '0',
  g_gameskill: '1',                  // Regular
  g_player_maxhealth: '100',
  jump_height: '39',
  player_backSpeedScale: '0.7',      // ZWR: backspeed scale <= 1.0; stock is 0.7
  player_strafeSpeedScale: '0.8',
  player_sprintSpeedScale: '1.5',
  player_sprintUnlimited: '0',
  player_sustainAmmo: '0',
  player_meleeRange: '64',
  player_lastStandBleedoutTime: '30',
  perk_weapReloadMultiplier: '0.5',
  bg_fallDamageMaxHeight: '350',
  arcademode: '0',
  zombiemode: '1',
})

// Reported for the record's proof, never judged: they describe the server, not the run.
export const SERVER_INFO = Object.freeze(['sv_fps', 'sv_maxRate', 'com_maxfps', 'onlinegame', 'systemlink'])

// ZWR / b2: 20..250 and not changed mid-game. 250 is also Plutonium's cheat line.
export const CLIENT_FPS = Object.freeze({ min: 20, max: 250 })

const same = (a, b) => {
  const x = Number(a), y = Number(b)
  if (String(a).trim() !== '' && String(b).trim() !== '' && Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) < 1e-4
  return String(a) === String(b)
}

// The engine's cap is whole milliseconds: 1000 / com_maxfps (verified_env.hpp effective_fps).
export function effectiveFps(maxfps) {
  const n = Number(maxfps)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(1000 / Math.max(1, Math.floor(1000 / n)))
}

export class EnvLog {
  constructor() {
    this.server = new Map()   // name -> [{ ms, value }], every distinct value in order
    this.fps = new Map()      // player key -> { name, slot, values: [{ ms, value }], live }
  }

  /** A `dvar` event. */
  dvar(name, value, ms) {
    if (!name) return
    const h = this.server.get(name) || []
    if (!h.length || String(h.at(-1).value) !== String(value)) h.push({ ms: ms ?? null, value: String(value) })
    this.server.set(name, h)
  }

  /**
   * A `client_dvar` com_maxfps report. `live` = the game had gone live when it arrived: a
   * value that moves BEFORE go-live (the menu, the load) replaces the start value rather
   * than counting as a mid-game change.
   */
  clientFps(key, { name = null, slot = null, value, ms = null, live = false }) {
    const v = Number(value)
    if (!Number.isFinite(v)) return
    const e = this.fps.get(key) || { name, slot, values: [] }
    if (name) e.name = name
    if (slot != null) e.slot = slot
    const last = e.values.at(-1)
    if (!last) e.values.push({ ms, value: v, live })
    else if (last.value !== v) {
      if (!live && !e.values.some((x) => x.live)) e.values = [{ ms, value: v, live }]
      else e.values.push({ ms, value: v, live })
    }
    this.fps.set(key, e)
  }

  /** The DLL's game_over carries the last server values: fill anything the stream missed. */
  seedFromGameOver(dvars) {
    if (!dvars || typeof dvars !== 'object') return
    for (const [k, v] of Object.entries(dvars)) if (!this.server.has(k)) this.dvar(k, v, null)
  }
}

/**
 * @param {EnvLog} env
 * @param {object} o
 * @param {string[]} o.players  keys of the players who were in the game (for "unreported")
 * @param {boolean} [o.requireFpsReport]  unreported FPS is a violation (off until every client ships fps_guard)
 * @param {boolean} [o.requireServerEnv]  a server that reported no dvars is a violation (off until the DLL is deployed)
 */
export function judge(env, { players = [], names = {}, requireFpsReport = false, requireServerEnv = false } = {}) {
  const violations = []
  const unknown = []
  const observed = { server: {}, fps: {} }

  const serverReported = env.server.size > 0
  for (const [name, want] of Object.entries(SERVER_RULES)) {
    const h = env.server.get(name)
    if (!h) continue
    observed.server[name] = h.at(-1).value
    for (const { value } of h) {
      if (String(value).startsWith('?type')) { unknown.push(`${name} reported an unexpected type (${value})`); continue }
      if (!same(value, want)) violations.push(`${name} was ${value} (Verified needs ${want})`)
    }
  }
  for (const name of SERVER_INFO) {
    const h = env.server.get(name)
    if (h) observed.server[name] = h.at(-1).value
  }
  if (!serverReported) {
    if (requireServerEnv) violations.push('the server reported no settings')
    else unknown.push('the server reported no settings (a DLL older than 2026-09-23)')
  }

  const unreported = []
  for (const key of players) {
    const e = env.fps.get(key)
    const who = names[key] || e?.name || key
    if (!e || !e.values.length) { unreported.push(who); continue }
    const vals = e.values.map((x) => x.value)
    observed.fps[who] = { first: vals[0], last: vals.at(-1), runs_at: effectiveFps(vals.at(-1)), changes: vals.length - 1 }
    for (const v of new Set(vals)) {
      if (v <= 0) violations.push(`${who} ran com_maxfps uncapped (0)`)
      else if (v < CLIENT_FPS.min || v > CLIENT_FPS.max) violations.push(`${who} ran com_maxfps ${v} (Verified allows ${CLIENT_FPS.min}–${CLIENT_FPS.max})`)
    }
    if (vals.length > 1) violations.push(`${who} changed com_maxfps mid-game (${vals.join(' → ')})`)
  }
  if (unreported.length) {
    const msg = `no FPS report from ${unreported.join(', ')}`
    if (requireFpsReport) violations.push(msg)
    else unknown.push(`${msg} (a client older than fps_guard)`)
  }

  return {
    ruleset: RULESET,
    ok: violations.length === 0,
    violations: [...new Set(violations)],
    unknown: [...new Set(unknown)],
    enforced: {
      server: { ...SERVER_RULES },
      client: { com_maxfps: `${CLIENT_FPS.min}-${CLIENT_FPS.max}, unchanged after go-live` },
      require_fps_report: !!requireFpsReport,
      require_server_env: !!requireServerEnv,
    },
    observed,
  }
}
