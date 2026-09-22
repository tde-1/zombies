'use strict'

// A player's ENW Movement profile, mirrored: the BANNER (and its crop), and the country
// code. B, 2026-09-22: "if they have a banner on Movement it should show here the same, like
// it does across Movement and drops.ws."
//
// WHERE IT COMES FROM. Movement answers `GET /api/players/<steamid64>/profile` with no
// session at all — it is on the movement host's MOVEMENT_PUBLIC list
// (CSGO-Matchmaker/server/index.js, "a profile is a link people paste") and the handler is
// CSGO-Matchmaker/server/routes/players.js `/:steam_id/profile`. Its `user` is
// `publicUser()` (server/lib/users.js), which carries `banner` as a same-origin path
// (`/banners/<steamid>-<12 hex>.<ext>`, lib/profileBanners.js urlFor) and `banner_pos`, the
// crop's vertical focal point 0..100. `/banners/*` is a plain static mount on that host.
// Both are read-only and need no credentials, the same read lib/movementName.js already makes.
//
// WHAT IS KEPT, AND NOTHING ELSE (the privacy rule, people skill): steam_id, the Movement
// username (so a mismatch with the ENW name can be seen, never displayed), the banner file,
// banner_pos, and the two-letter country. NOT the avatar, NOT the badges, NOT the showcase
// skins (this is not CS:GO), NOT last_seen, NOT the VIP state. Movement has no bio field on
// its public projection, so there is none to copy.
//
// THE BANNER IS DOWNLOADED, NEVER HOTLINKED. The bytes are fetched once, checked by MAGIC
// BYTES (Movement's own rule: the type is the file's, not the name's), capped at 2 MB, and
// written under `<data>/media/banners/<steamid>-<12 hex of the source name>.<ext>`, served at
// `/media/banners/`. Movement's filenames are content-addressed (a new upload mints a new
// name), so the same source name means the same bytes and is never fetched twice; a changed
// banner on Movement becomes a new file here and the old one is removed.
//
// WHEN. At sign-in (after the redirect is on its way, like the ENW name lookups), on a
// profile view whose copy is older than STALE_MS (in the background — the page renders with
// whatever is cached), and from `web/tools/import-movement-profiles.js` for the seven
// approved accounts. `ZM_MOVEMENT_URL=off` switches all of it off, and the test suites do.
//
// ONE BANNER, ONE PLACE TO SET IT. There is deliberately no upload here. A banner set on
// Movement shows on Movement, on drops.ws and here; a second upload on this site would be a
// second banner that disagrees with the other two. The profile's own "Edit banner" goes to
// Movement.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { db, now, DATA_DIR } = require('../db/database')

const TIMEOUT_MS = 6000
const STALE_MS = 6 * 60 * 60_000
const MAX_BYTES = 2 * 1024 * 1024
const BANNER_DIR = path.join(DATA_DIR, 'media', 'banners')
const PUBLIC_PREFIX = '/media/banners/'

// Movement's four accepted types, by magic bytes (CSGO-Matchmaker/server/lib/profileBanners.js
// TYPES). No SVG: it can carry script.
const TYPES = [
  { ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: '.gif', test: (b) => ['GIF87a', 'GIF89a'].includes(b.slice(0, 6).toString('latin1')) },
  { ext: '.webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
]
const sniff = (buf) => (Buffer.isBuffer(buf) && buf.length >= 12 ? TYPES.find((t) => t.test(buf)) || null : null)

// Movement's generated banner path, and nothing else. A path we did not expect is not fetched.
const MV_BANNER = /^\/banners\/([0-9]{1,20}-[0-9a-f]{12})\.(jpg|png|gif|webp)$/
// Our stored name: the same shape, so it can never be a path.
const SAFE_NAME = /^[0-9]{17}-[0-9a-f]{12}\.(jpg|png|gif|webp)$/

function base() {
  const v = process.env.ZM_MOVEMENT_URL
  if (v === 'off' || v === '0' || v === '') return null
  return String(v || 'https://movement.enw.gg').replace(/\/+$/, '')
}

const clampPos = (v) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50
}
const country = (raw) => {
  const c = String(raw || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(c) ? c : null
}

const get = (steamId) => db.prepare('SELECT * FROM movement_profiles WHERE steam_id=?').get(String(steamId)) || null

/** The projection a profile carries. null when we have never seen them on Movement. */
function forPlayer(steamId) {
  const r = get(steamId)
  const b = base()
  const profileUrl = b ? `${b}/id/${String(steamId)}` : null
  if (!r || !r.found) return { found: false, banner: null, banner_pos: 50, country: null, profile_url: profileUrl }
  return {
    found: true,
    banner: r.banner_file && SAFE_NAME.test(r.banner_file) && fs.existsSync(path.join(BANNER_DIR, r.banner_file))
      ? PUBLIC_PREFIX + r.banner_file : null,
    banner_pos: clampPos(r.banner_pos),
    country: country(r.country),
    profile_url: profileUrl,
    fetched_at: r.fetched_at,
  }
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
  // A missing route on that site falls through to its SPA shell as 200 text/html.
  if (r.status === 404) return { missing: true }
  const ctype = String(r.headers.get('content-type') || '')
  if (!r.ok || !ctype.includes('application/json')) throw new Error(`movement answered ${r.status} ${ctype}`)
  return { body: await r.json() }
}

async function fetchBanner(b, src) {
  const r = await fetch(b + src, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!r.ok) throw new Error(`banner ${r.status}`)
  const len = Number(r.headers.get('content-length') || 0)
  if (len > MAX_BYTES) throw new Error('banner too large')
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('banner too large')
  const t = sniff(buf)
  if (!t) throw new Error('banner is not an image we accept')
  return { buf, ext: t.ext }
}

const inflight = new Map()

/**
 * Read this player's Movement profile and mirror what we keep. Never throws; resolves to
 * { ok, found, banner, changed, error }. Concurrent calls for one SteamID share one read.
 */
function refresh(steamId) {
  const sid = String(steamId || '')
  if (!/^\d{17}$/.test(sid)) return Promise.resolve({ ok: false, error: 'not a SteamID64' })
  if (!base()) return Promise.resolve({ ok: false, error: 'off' })
  if (inflight.has(sid)) return inflight.get(sid)
  const p = doRefresh(sid).finally(() => inflight.delete(sid))
  inflight.set(sid, p)
  return p
}

async function doRefresh(sid) {
  const b = base()
  const prev = get(sid)
  const t = now()
  let res
  try { res = await fetchJson(`${b}/api/players/${sid}/profile`) } catch (e) {
    // Unreachable: keep whatever we had, and only stamp the attempt.
    if (prev) db.prepare('UPDATE movement_profiles SET checked_at=?, error=? WHERE steam_id=?').run(t, String(e.message).slice(0, 200), sid)
    return { ok: false, error: e.message }
  }
  const u = res.body && res.body.user
  if (res.missing || !u || String(u.steam_id) !== sid) {
    upsert(sid, { found: 0, mv_name: null, banner_src: null, banner_file: null, banner_pos: 50, country: null, fetched_at: t, checked_at: t, error: null })
    if (prev && prev.banner_file) removeFile(prev.banner_file)
    return { ok: true, found: false, banner: null }
  }

  const src = typeof u.banner === 'string' && MV_BANNER.test(u.banner) ? u.banner : null
  let file = prev && prev.banner_src === src ? prev.banner_file : null
  let error = null
  if (src && !(file && fs.existsSync(path.join(BANNER_DIR, file)))) {
    try {
      const { buf, ext } = await fetchBanner(b, src)
      const tag = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12)
      file = `${sid}-${tag}${ext}`
      fs.mkdirSync(BANNER_DIR, { recursive: true })
      fs.writeFileSync(path.join(BANNER_DIR, file), buf)
    } catch (e) { error = String(e.message).slice(0, 200); file = null }
  }
  if (!src) file = null
  if (prev && prev.banner_file && prev.banner_file !== file) removeFile(prev.banner_file)
  upsert(sid, {
    found: 1,
    mv_name: typeof u.username === 'string' ? u.username.trim().slice(0, 64) || null : null,
    banner_src: src,
    banner_file: file,
    banner_pos: clampPos(u.banner_pos),
    country: country(u.country),
    fetched_at: t,
    checked_at: t,
    error,
  })
  return { ok: !error, found: true, banner: file ? PUBLIC_PREFIX + file : null, changed: !prev || prev.banner_file !== file, error }
}

function upsert(sid, v) {
  db.prepare(`INSERT INTO movement_profiles (steam_id, found, mv_name, banner_src, banner_file, banner_pos, country, fetched_at, checked_at, error)
              VALUES (@steam_id, @found, @mv_name, @banner_src, @banner_file, @banner_pos, @country, @fetched_at, @checked_at, @error)
              ON CONFLICT(steam_id) DO UPDATE SET found=@found, mv_name=@mv_name, banner_src=@banner_src, banner_file=@banner_file,
                banner_pos=@banner_pos, country=@country, fetched_at=@fetched_at, checked_at=@checked_at, error=@error`)
    .run({ steam_id: sid, ...v })
}

function removeFile(name) {
  if (!SAFE_NAME.test(String(name))) return
  try { fs.unlinkSync(path.join(BANNER_DIR, name)) } catch { /* already gone */ }
}

/** A profile view: refresh in the background when our copy is old. Never awaited. */
function refreshIfStale(steamId) {
  if (!base()) return
  const r = get(steamId)
  const last = r ? (r.checked_at || r.fetched_at || 0) : 0
  if (Date.now() - last < STALE_MS) return
  refresh(steamId).catch(() => {})
}

module.exports = { forPlayer, refresh, refreshIfStale, enabled: () => !!base(), BANNER_DIR, PUBLIC_PREFIX, sniff }
