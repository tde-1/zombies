// Game settings and the signed-in account.
//
// Spec 13 §2: "Settings are saved to their ENW account, separate from the WaW install,
// and applied over the top at launch. Their own WaW config is never modified. They
// follow the player across devices."
//
// So the account is the source of truth and the local file is a cache. Today there is
// no account service, so this writes to disk keyed by account id and syncs to the site
// when the site offers the endpoint. The shape is the same either way, which is the
// point: when the endpoint appears, nothing else changes.
import fs from 'node:fs'
import { P, ensureDirs, assertWritable } from './paths.js'
import { MODES, clampFov, clampFps, MULTIGPU_REPAIR, MULTIGPU_REPAIR_LINE } from './gamecfg.js'
import { validResolution } from './display.js'
import { validateWaw, validateBinds } from './wawcfg.js'

export const DEFAULT_SETTINGS = {
  fov: 80,            // spec 4.5: cap ~90-100 for the gun model, <=120 for speedruns
  maxFps: 250,        // spec 4.5: <=250, SERVER ENFORCES ALLOWED VALUES for a record game
  // Display (spec 4.3 "Display defaults", B 2026-09-22). The game launches borderless
  // windowed at the primary display's native resolution, and it is these three that
  // say so -- `resolution: ''` no longer means "leave it to the game", because the
  // game's own answer to that was 800x600 (see gamecfg.js).
  display: 'primary',       // 'primary', or a display id / index from display.js
  mode: 'borderless',       // 'borderless' | 'fullscreen' | 'windowed'
  resolution: '',           // '' = the chosen display's native size. Borderless ignores it.
  vsync: false,             // stock is ON, and on a 60 Hz panel that IS the 60 fps cap
  fullscreen: false,        // kept only so older code and older saved files still read
  volume: 1,
  sensitivity: null,
  showFps: false,
  binds: null,              // round-tripped out of config.cfg; the launcher does not edit them
  chatChannel: 'auto', // spec 2b: solo -> Global, group -> Local, then it sticks
  autoRemoveUnplayedMaps: false, // spec: off by default
  autoRemoveDays: 30,
  streamerMode: false,
  // The "4 GB patch" on OUR copy of CoDWaW.exe (setup.js, "THE LARGE ADDRESS AWARE
  // FLAG"). On by default because without it the big custom maps — ORBiT, UGX
  // Requiem — run the client out of address space in CL_InitCGame. Turning it off
  // puts the header back to the bytes we recorded before we first touched it; it
  // never reaches the player's own install either way.
  largeAddressAware: true,
  // The site's Settings page (web /settings, laid out like WaW's Options menus). `waw` is
  // { <dvar>: value | null (game default) }, `wawBinds` is { <command>: [key, key] }, both
  // checked against wawcfg.js's whitelist of what the game's own menus write.
  // `gameUpdatedAt` says which copy is newer, this one or the site's (ms since epoch).
  waw: {},
  wawBinds: {},
  gameUpdatedAt: 0,
  // The client DLL's raw-input mouse (client.md 1, 5). Off = ENW_RAW_MOUSE=0.
  rawMouse: true,
  // Discord Rich Presence (discord.js). Off clears it at once.
  discordPresence: true,
  // The client DLL's gate on Discord's in-game overlay hook (overlay_guard.cpp,
  // chat-overlay.md 13): auto | allow | refuse, passed as ENW_DISCORD_HOOK.
  discordOverlay: 'auto',
}

// The keys the site's /settings page also holds (web wawSettings.js LAUNCHER_KEYS), so a
// change to any of them moves gameUpdatedAt and the newer copy wins.
export const GAME_KEYS = ['mode', 'display', 'resolution', 'vsync', 'fov', 'maxFps', 'showFps', 'sensitivity', 'rawMouse', 'discordPresence', 'discordOverlay', 'waw', 'wawBinds']

function read(file, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { return { ...fallback } }
}

function write(file, data) {
  ensureDirs()
  fs.writeFileSync(assertWritable(file), JSON.stringify(data, null, 2))
}

// ------------------------------------------------------------------ session --

// Sign-in is mocked: Steam OpenID needs a site to redirect to and a secret we do not
// have locally. What is real is the shape — a steamid, a persona, and a remembered
// session — and the Steam account we can read off this machine.
export function session() {
  return read(P.session, { signedIn: false, steamid: null, name: null, since: null, mock: true })
}

export function signIn({ steamid, name, mock = true }) {
  const s = { signedIn: true, steamid: String(steamid), name: name || null, since: new Date().toISOString(), mock }
  write(P.session, s)
  return s
}

export function signOut() {
  const s = { signedIn: false, steamid: null, name: null, since: null, mock: true }
  write(P.session, s)
  return s
}

// ----------------------------------------------------------------- settings --

// Per account, with a local fallback for "not signed in yet". Stored in one file as
// { accounts: { <steamid>: {...} }, local: {...} } so switching account is not a
// migration.
function all() {
  return read(P.settings, { accounts: {}, local: { ...DEFAULT_SETTINGS } })
}

// Merge `over` onto `base` WITHOUT letting a key it does not define shadow one that
// `base` does. `{ ...base, ...over }` is not this: a key present-and-undefined in
// `over` (which JSON.parse cannot produce, but an object built in code can) wins, and
// — the live bug — an object that is used INSTEAD of `base` shadows every key at once.
//
// Evidence (B's state\settings.json, 2026-09-22): his account block
// `accounts["76561198126330106"]` has no `mode`, no `fullscreen` and no `vsync`, while
// `local` has `mode: "borderless"`. `get()` used to pick ONE of the two objects
// (`(id && a.accounts[id]) || a.local`), so signing in threw the whole local block
// away and every key the account happened not to carry fell back to a bare default
// instead of to what this computer was actually playing with. `mode` is the one that
// reaches `ENW_BORDERLESS` (launch.js), so it gets a test of its own.
function mergeDefined(base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined || v === null) continue // never shadow with "no opinion"
    out[k] = v
  }
  return out
}

export function get(steamid = null) {
  const a = all()
  const id = steamid || session().steamid
  // Defaults, then this computer's copy, then the account: each layer may only
  // override a key it actually defines.
  let out = mergeDefined({ ...DEFAULT_SETTINGS }, a.local || {})
  if (id && a.accounts[id]) out = mergeDefined(out, a.accounts[id])
  return { ...out, _scope: id ? `account ${id}` : 'this computer (not signed in)' }
}

// Validation, in one place, because these values end up on a command line the engine
// parses itself and in a config.cfg the engine execs. A bad `resolution` is not a
// cosmetic problem: `+set r_mode 1920 x 1080` is three arguments.
export const DISCORD_OVERLAY = ['auto', 'allow', 'refuse']

export function validate(patch = {}) {
  const out = { ...patch }
  const notes = []
  if ('mode' in out && !MODES.includes(out.mode)) { notes.push(`mode "${out.mode}" is not one of ${MODES.join('/')}; kept the saved one`); delete out.mode }
  if ('resolution' in out && out.resolution !== '' && out.resolution !== null) {
    const r = validResolution(out.resolution)
    if (!r) { notes.push(`resolution "${out.resolution}" is not WxH; kept the saved one`); delete out.resolution }
    else out.resolution = r
  }
  if ('fov' in out && out.fov !== null) out.fov = Number(clampFov(out.fov))
  if ('maxFps' in out && out.maxFps !== null) out.maxFps = Number(clampFps(out.maxFps))
  if ('vsync' in out) out.vsync = !!out.vsync
  if ('largeAddressAware' in out) out.largeAddressAware = !!out.largeAddressAware
  if ('display' in out && out.display !== null) out.display = String(out.display)
  // Keep the legacy flag in step with the mode so nothing that still reads it lies.
  if ('mode' in out) out.fullscreen = out.mode === 'fullscreen'
  if ('volume' in out && out.volume !== null) out.volume = Math.min(1, Math.max(0, Number(out.volume) || 0))
  if ('rawMouse' in out) out.rawMouse = out.rawMouse !== false
  if ('discordPresence' in out) out.discordPresence = out.discordPresence !== false
  if ('discordOverlay' in out && !DISCORD_OVERLAY.includes(out.discordOverlay)) { notes.push(`discordOverlay "${out.discordOverlay}" is not one of ${DISCORD_OVERLAY.join('/')}; kept the saved one`); delete out.discordOverlay }
  if ('sensitivity' in out && out.sensitivity !== null) {
    const n = Number(out.sensitivity)
    if (Number.isFinite(n) && n > 0 && n <= 100) out.sensitivity = Math.round(n * 1000) / 1000
    else { notes.push(`sensitivity "${out.sensitivity}" is not a number the game takes; kept the saved one`); delete out.sensitivity }
  }
  if ('showFps' in out) out.showFps = !!out.showFps
  if ('waw' in out) { const r = validateWaw(out.waw); out.waw = r.waw; notes.push(...r.notes) }
  if ('wawBinds' in out) { const r = validateBinds(out.wawBinds); out.wawBinds = r.binds; notes.push(...r.notes) }
  if ('gameUpdatedAt' in out) out.gameUpdatedAt = Number(out.gameUpdatedAt) || 0
  return { patch: out, notes }
}

// `waw` and `wawBinds` are MERGED key by key, not replaced: the post-game read-back
// sends only what the player changed. '' in `waw` removes that dvar (no opinion); null
// keeps meaning "game default". A null bind goes back to the stock keys by removal.
function mergeGame(prev = {}, patch = {}) {
  const out = { ...prev, ...patch }
  if (patch.waw) {
    const w = { ...(prev.waw || {}) }
    for (const [k, v] of Object.entries(patch.waw)) { if (v === '') delete w[k]; else w[k] = v }
    out.waw = w
  }
  if (patch.wawBinds) {
    const b = { ...(prev.wawBinds || {}) }
    for (const [k, v] of Object.entries(patch.wawBinds)) { if (v === null) delete b[k]; else b[k] = v }
    out.wawBinds = b
  }
  // A change to how the game runs that does not carry its own time (the launcher's
  // Settings screen, the read-back) is newer than whatever the site holds.
  if (!('gameUpdatedAt' in patch) && GAME_KEYS.some((k) => k in patch)) out.gameUpdatedAt = Date.now()
  return out
}

export function set(rawPatch, steamid = null) {
  const { patch } = validate(rawPatch)
  const a = all()
  const id = steamid || session().steamid
  guardRepaired(a, id, patch)
  const target = id ? (a.accounts[id] = mergeGame(a.accounts[id] || {}, patch)) : (a.local = mergeGame(a.local || {}, patch))
  // Keep the local copy in step so a signed-out launch still feels like the player's.
  if (id) a.local = mergeGame(a.local || {}, patch)
  write(P.settings, a)
  return { ...DEFAULT_SETTINGS, ...target }
}

// ---------------------------------------------------------------- migrations --

// One-time repairs of a saved block, with a marker so each one runs exactly once per
// account. The marker lives in the settings file itself (`migrations: { <id>: [...] }`)
// because that is the file the repair is about — a separate marker file could go out
// of step with it.
const MULTIGPU_DVAR = 'r_multiGpu'

export const MIGRATIONS = {
  // 2026-09-22. B's account held `maxFps: 60` and `fov: 65` — the engine's own 2008
  // stock defaults, NOT anything he chose. They got there because the config.cfg we
  // seeded was written to a folder the engine never opens (launcher.md 0.2.3 §1), so
  // the post-exit read-back parsed the engine's untouched `$$$` profile and persisted
  // its defaults into his account; every launch since re-applied them. That is the
  // live "60 FPS" report. applyReadBack no longer does this (gamecfg.js), but the
  // values already saved have to be put back by hand, once.
  //
  // Only exact stock values are touched: a player who really chose 60 fps typed 60,
  // and we cannot tell those apart — so the marker means we only ever risk it once,
  // and anything else is left alone.
  'stock-defaults-2026-09-22': (b) => {
    const notes = []
    if (Number(b.maxFps) === 60) { b.maxFps = 250; notes.push('maxFps 60 -> 250') }
    if (Number(b.fov) === 65) { b.fov = 80; notes.push('fov 65 -> 80') }
    return notes
  },
  // 2026-09-23. `r_multiGpu 1` was the ENW default (gamecfg.js COMMUNITY_FIXES, afc6276)
  // and the site's Settings page said it "fixes stutter". B, 13:35: OFF fixed the
  // invisible/garbled zombies on fear_mc_2 and most of the mouse stutter
  // (mod-compat.md §10.4). A saved '1' cannot be told from the old default, so it is
  // repaired once; turning it back on afterwards sticks. gamecfg.js migrateMultiGpu
  // does the same to the config.cfg the engine reads.
  [MULTIGPU_REPAIR]: (b) => {
    if (!b.waw || String(b.waw[MULTIGPU_DVAR]) !== '1') return []
    b.waw = { ...b.waw, [MULTIGPU_DVAR]: '0' }
    return [MULTIGPU_REPAIR_LINE]
  },
}

// Why each migration exists, for its one log line.
const MIGRATION_WHY = {
  'stock-defaults-2026-09-22': 'these were the engine\'s 2008 stock defaults, saved into the account by the 0.2.3 read-back bug, not a choice the player made',
  [MULTIGPU_REPAIR]: 'ENW\'s own launch baseline pinned r_multiGpu 1 until 2026-09-23; on a single GPU it breaks skinned models and stutters',
}

// A copy of the settings that is OLDER than the r_multiGpu repair must not bring the old
// default back. The site holds its own copy and pushes it here whenever its
// `gameUpdatedAt` is newer than ours (web launcherBridge.js GameSettingsSync); until the
// site's own migration has run (web/server/lib/settingsRepairs.js, at server start) that
// copy can still say '1'. A patch that carries a `gameUpdatedAt` from before the repair
// is such a copy. A patch with no stamp is the launcher's own (its Settings screen, the
// read-back of an in-game change) or one from after the repair: the player's hand, kept.
function guardRepaired(a, id, patch) {
  if (!patch.waw || String(patch.waw[MULTIGPU_DVAR]) !== '1' || !('gameUpdatedAt' in patch)) return false
  const at = Number(((a.migratedAt || {})[id || 'local'] || {})[MULTIGPU_REPAIR]) || 0
  if (!at || Number(patch.gameUpdatedAt) >= at) return false
  patch.waw = { ...patch.waw, [MULTIGPU_DVAR]: '0' }
  return true
}

// Run every migration that has not run yet, for the signed-in account (or all of
// them) and for the local block. Idempotent: the marker is written whether or not
// the migration found anything to change, so it never runs twice.
export function migrate({ steamid = null, log = () => {} } = {}) {
  const a = all()
  a.migrations = a.migrations || {}
  // When each migration ran, per block: guardRepaired() needs it to tell a copy from
  // before the repair from a choice made after it.
  a.migratedAt = a.migratedAt || {}
  const ran = []
  let dirty = false

  const ids = steamid ? [steamid] : Object.keys(a.accounts || {})
  const blocks = [['local', a.local = a.local || {}], ...ids.map((id) => [id, a.accounts[id] = a.accounts[id] || {}])]

  for (const [id, block] of blocks) {
    const done = new Set(a.migrations[id] || [])
    for (const [name, fn] of Object.entries(MIGRATIONS)) {
      if (done.has(name)) continue
      const notes = fn(block) || []
      done.add(name)
      a.migratedAt[id] = { ...(a.migratedAt[id] || {}), [name]: Date.now() }
      dirty = true
      if (notes.length) {
        ran.push({ id, name, notes })
        log(`settings migration "${name}" on ${id === 'local' ? 'this computer' : `account ${id}`}: ${notes.join(', ')} — ${MIGRATION_WHY[name] || 'a one-time repair'}`)
      }
    }
    a.migrations[id] = [...done]
  }

  if (dirty) write(P.settings, a)
  return { ran, migrations: a.migrations }
}

// Pull settings the site holds for this account, if the site offers them. Local wins
// only when the site has nothing: the account is the source of truth (spec 13 §2).
export async function syncFromSite(siteUrl, steamid) {
  if (!siteUrl || !steamid) return { synced: false, reason: 'not signed in' }
  try {
    const res = await fetch(`${siteUrl.replace(/\/$/, '')}/api/me/settings`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { synced: false, reason: `the site answered ${res.status}` }
    const remote = await res.json()
    set(remote, steamid)
    return { synced: true, from: 'the site' }
  } catch (e) {
    return { synced: false, reason: `the site has no settings endpoint yet (${e.message}); using the copy on this computer` }
  }
}
