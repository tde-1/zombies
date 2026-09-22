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
import { MODES, clampFov, clampFps } from './gamecfg.js'
import { validResolution } from './display.js'

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
}

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

export function get(steamid = null) {
  const a = all()
  const id = steamid || session().steamid
  const stored = (id && a.accounts[id]) || a.local || {}
  return { ...DEFAULT_SETTINGS, ...stored, _scope: id ? `account ${id}` : 'this computer (not signed in)' }
}

// Validation, in one place, because these values end up on a command line the engine
// parses itself and in a config.cfg the engine execs. A bad `resolution` is not a
// cosmetic problem: `+set r_mode 1920 x 1080` is three arguments.
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
  return { patch: out, notes }
}

export function set(rawPatch, steamid = null) {
  const { patch } = validate(rawPatch)
  const a = all()
  const id = steamid || session().steamid
  const target = id ? (a.accounts[id] = { ...(a.accounts[id] || {}), ...patch }) : (a.local = { ...(a.local || {}), ...patch })
  // Keep the local copy in step so a signed-out launch still feels like the player's.
  if (id) a.local = { ...(a.local || {}), ...patch }
  write(P.settings, a)
  return { ...DEFAULT_SETTINGS, ...target }
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
