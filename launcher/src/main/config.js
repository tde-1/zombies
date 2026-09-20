// What the launcher points at, and how it finds out.
//
// The launcher wraps the live site (spec 13 §2: "It wraps the live site... one codebase:
// every site update reaches the launcher instantly"). Until `web/` serves, it points at
// whatever is running locally, and the URL stays configurable in every case — B should
// never need a new build to change where it looks.
//
// Order: ENW_SITE_URL > state/config.json > the first candidate that answers > the
// bundled placeholder page.
import fs from 'node:fs'
import path from 'node:path'
import { P, ensureDirs } from './paths.js'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
export const PLACEHOLDER = path.resolve(HERE, '..', 'renderer', 'placeholder.html')

// Where the site lives in production. Changing this changes where every packaged
// launcher points, so it is one constant and not spread through the file.
export const PRODUCTION_SITE = 'https://zombies.enw.gg'

export const DEFAULTS = {
  // In probe order. Each is tried once, briefly, at startup.
  // PRODUCTION FIRST. A friend who installs the packaged launcher has no repo and no
  // local site, so the default has to be the real one; the local ports are the dev
  // fallback, tried only if production does not answer.
  siteCandidates: [
    { url: PRODUCTION_SITE, what: 'ENW Zombies' },
    { url: 'http://127.0.0.1:3200', what: 'a local ENW Zombies site (web/)' },
    { url: 'http://127.0.0.1:5173', what: 'a local site (web/client, Vite dev server)' },
    { url: 'http://127.0.0.1:8080', what: 'the mock site (infra/host-agent/mock-site)' },
    { url: 'http://127.0.0.1:8787', what: "the host agent's dashboard" },
  ],
  site: null,               // pin one here; `ZM_SITE` overrides it
  siteUrl: null,            // the old name for the same thing, still honoured
  // The closed-beta front door (web/server/middleware/gate.js). Remembered once the
  // player types it; never logged, never sent anywhere but the site.
  sitePassword: null,
  // Where map FILES come from. Null means "the site's own download route", which is
  // B's home connection through a tunnel. Point it at a bucket (R2, Hetzner, anything
  // that serves bytes over HTTP) and nothing else changes: the file list, the sizes and
  // the hashes still come from the site, so the bucket needs no intelligence and we
  // still verify everything we get. `ZM_MAPS_BASE` overrides.
  //
  //   maps_base = 'https://maps.enw.gg'
  //     -> https://maps.enw.gg/<bsp>/<file>
  mapsBase: null,
  // Where the launcher asks for a server and an invite token.
  hostApi: 'http://127.0.0.1:8080',
  // The game box's own dashboard. Development source for live game state (phase,
  // round, who is connected) until the site carries it.
  hostDashboard: 'http://127.0.0.1:8787',
  // Where the game link should call home (passed to the client DLL as ENW_HOST).
  linkHost: '127.0.0.1:28960',
  // Where crash reports go. Local only: no cloud, ever, in this build.
  crashEndpoint: 'http://127.0.0.1:8791/crash',
  // Silent update source. Local folder or http; applied on the NEXT launch, never mid-game.
  updateFeed: null,
  deepLinkHosts: ['zombies.enw.gg', 'zm.enw.gg'],
  protocol: 'enwzombies',
  minimiseToTray: true,
  stealthLaunch: false,     // dev-box.md rule 6 when true: windowed, muted, off-screen
  useGameLock: true,
}

let cached = null

export function load() {
  if (cached) return cached
  ensureDirs()
  let onDisk = {}
  try { onDisk = JSON.parse(fs.readFileSync(P.config, 'utf8')) } catch {}
  cached = { ...DEFAULTS, ...onDisk }

  // The order, in one place so it can be read off:
  //   ZM_SITE  >  config.site  >  config.siteUrl (old name)  >  production
  // and if production does not answer, resolveSiteUrl() falls back to the local
  // candidates. ENW_SITE_URL is kept because it is in the docs and in people's shells.
  const pinned =
    process.env.ZM_SITE ||
    process.env.ENW_SITE_URL ||
    cached.site ||
    cached.siteUrl ||
    null
  cached.siteUrl = pinned
  cached.site = pinned
  if (process.env.ZM_SITE_PASSWORD) cached.sitePassword = process.env.ZM_SITE_PASSWORD
  // ZM_MAPS_BASE > config.mapsBase (> null, meaning the site's own route)
  if (process.env.ZM_MAPS_BASE) cached.mapsBase = process.env.ZM_MAPS_BASE
  if (cached.mapsBase) cached.mapsBase = String(cached.mapsBase).replace(/\/$/, '')
  if (process.env.ENW_HOST_API) cached.hostApi = process.env.ENW_HOST_API
  return cached
}

export function save(patch) {
  const next = { ...load(), ...patch }
  cached = next
  let onDisk = {}
  try { onDisk = JSON.parse(fs.readFileSync(P.config, 'utf8')) } catch {}
  fs.writeFileSync(P.config, JSON.stringify({ ...onDisk, ...patch }, null, 2))
  return next
}

// A site that answers at all — INCLUDING a 401. The closed-beta gate challenges every
// request, so treating 401 as "down" would send every packaged launcher to the dev
// fallback and then to the placeholder. A 401 means the site is there and wants the
// password, which is exactly the case we ship for.
async function alive(url, timeoutMs = 3500) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'manual' })
    return { ok: res.status < 500, gated: res.status === 401 }
  } catch { return { ok: false, gated: false } } finally { clearTimeout(t) }
}

// Returns { url, what, pinned, gated, probed:[{url,ok}] }.
export async function resolveSiteUrl() {
  const cfg = load()
  const probed = []
  if (cfg.siteUrl) {
    if (cfg.siteUrl.startsWith('file:')) return { url: cfg.siteUrl, what: 'the page you pinned', pinned: true, probed }
    const r = await alive(cfg.siteUrl)
    probed.push({ url: cfg.siteUrl, ok: r.ok, gated: r.gated })
    // A pinned URL is used even if it did not answer: the player asked for it, and
    // silently going somewhere else is worse than showing it failing.
    return { url: cfg.siteUrl, what: 'the site you configured', pinned: true, gated: r.gated, reachable: r.ok, probed }
  }
  for (const c of cfg.siteCandidates) {
    const r = await alive(c.url)
    probed.push({ url: c.url, ok: r.ok, gated: r.gated })
    if (r.ok) return { ...c, pinned: false, gated: r.gated, reachable: true, probed }
  }
  return {
    url: `file://${PLACEHOLDER.split(path.sep).join('/')}`,
    what: 'the built-in placeholder (nothing answered)',
    placeholder: true,
    pinned: false,
    probed,
  }
}
