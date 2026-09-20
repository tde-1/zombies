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

export const DEFAULTS = {
  // In probe order. Each is tried once, briefly, at startup.
  siteCandidates: [
    { url: 'http://127.0.0.1:8099', what: 'the ENW Zombies site (web/)' },
    { url: 'http://127.0.0.1:3000', what: 'the ENW Zombies site (web/, dev server)' },
    { url: 'http://127.0.0.1:8080', what: 'the mock site (infra/host-agent/mock-site)' },
    { url: 'http://127.0.0.1:8787', what: "the host agent's dashboard" },
  ],
  siteUrl: null,            // set this to pin one
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
  if (process.env.ENW_SITE_URL) cached.siteUrl = process.env.ENW_SITE_URL
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

async function alive(url, timeoutMs = 700) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'manual' })
    return res.status < 500
  } catch { return false } finally { clearTimeout(t) }
}

// Returns { url, what, pinned, probed:[{url,ok}] }.
export async function resolveSiteUrl() {
  const cfg = load()
  const probed = []
  if (cfg.siteUrl) {
    const ok = cfg.siteUrl.startsWith('file:') || (await alive(cfg.siteUrl))
    probed.push({ url: cfg.siteUrl, ok })
    if (ok) return { url: cfg.siteUrl, what: 'the site you configured', pinned: true, probed }
  }
  for (const c of cfg.siteCandidates) {
    const ok = await alive(c.url)
    probed.push({ url: c.url, ok })
    if (ok) return { ...c, pinned: false, probed }
  }
  return {
    url: `file://${PLACEHOLDER.replace(/\\/g, '/')}`,
    what: 'the built-in placeholder (nothing is serving locally yet)',
    placeholder: true,
    pinned: false,
    probed,
  }
}
