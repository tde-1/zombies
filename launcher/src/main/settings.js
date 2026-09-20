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

export const DEFAULT_SETTINGS = {
  fov: 80,            // spec 4.5: cap ~90-100 for the gun model, <=120 for speedruns
  maxFps: 125,        // spec 4.5: <=250, server enforces allowed values
  fullscreen: true,
  resolution: '',     // '' = leave it to the game
  volume: 1,
  sensitivity: null,
  showFps: false,
  chatChannel: 'auto', // spec 2b: solo -> Global, group -> Local, then it sticks
  autoRemoveUnplayedMaps: false, // spec: off by default
  autoRemoveDays: 30,
  streamerMode: false,
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

export function set(patch, steamid = null) {
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
