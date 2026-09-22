// Replay 3D — where the map's bytes come from.
//
// Two addresses for the same object. The manifest carries both (server/lib/replay3d.js):
//
//   manifest.public.glb   the FastDL bucket itself, path-style, with ?v=<built_at>. The bucket
//                         carries a CORS rule for movement.enw.gg, so the browser can take the
//                         9 MB straight from Hetzner — no site process in the middle, and the
//                         file is cacheable forever under that version.
//   manifest.glbUrl       the site's own proxy route, which has always worked and always will.
//
// So: try the bucket, fall back to the proxy on anything that is not a 200 (a CORS rule that
// got dropped, a network that eats the request, an object that is only in the proxy's cache).
// A map that fails both ways is a map that fails, and the viewer says so in words.
//
// The same functions serve the PREFETCH on hover: they go through the browser's HTTP cache
// (`cache: 'default'`, and the version query keeps it honest), so a prefetched glb is already
// there when the viewer asks for it a second later. Nothing is held in JS — a couple of these
// buffers would be tens of megabytes we cannot drop.

const isAbs = (u) => /^https?:\/\//i.test(String(u || ''))

// One fetch with progress. Resolves { ok, status, buffer } and never throws.
async function once(url, { onProgress, signal } = {}) {
  try {
    // credentials only for our own routes: sending a cookie cross-origin would make the request
    // one the bucket's CORS rule does not cover, and it has nothing to authenticate anyway.
    const res = await fetch(url, { credentials: isAbs(url) ? 'omit' : 'include', signal })
    if (!res.ok) return { ok: false, status: res.status, buffer: null }
    const len = Number(res.headers.get('content-length')) || 0
    if (!onProgress || !res.body || !res.body.getReader) {
      const buffer = await res.arrayBuffer()
      if (onProgress) onProgress(buffer.byteLength, buffer.byteLength)
      return { ok: true, status: res.status, buffer }
    }
    const reader = res.body.getReader()
    const chunks = []
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      got += value.byteLength
      onProgress(got, len)
    }
    const out = new Uint8Array(got)
    let at = 0
    for (const c of chunks) { out.set(c, at); at += c.byteLength }
    return { ok: true, status: res.status, buffer: out.buffer }
  } catch (e) {
    return { ok: false, status: 0, buffer: null, error: e }
  }
}

// ---- the bytes we already have, in memory, keyed by the URL they came from.
//
// The comment further down says nothing is held in JS, because a couple of these buffers is
// tens of megabytes we cannot drop. That was right while one viewer opened, took its map and
// closed. It stopped being right when the map page's Route card started playing the same map
// the full viewer opens NEXT, off the card's own expand control: the browser's HTTP cache
// would usually answer the second request, but "usually" means a second trip through the
// network stack and a second 9 MB decode of a file we are still holding a decoded scene of.
//
// So: a small LRU, bounded by BYTES first (one map's glb is most of it) and by entries second.
//
// The size is what ONE map costs, not two. The job here is the card→viewer handoff, which
// needs the map that is on screen and nothing else; the fleet's biggest glb is 43.8 MB, so a
// 48 MB cap could not hold two of anything anyway — it held one heavy map, evicted everything
// else to do it, and left 4 MB of headroom. 64 MB with 4 entries holds the heaviest map, its
// entities and its materials with room for the sky, and says so.
//
// And it is stored ONCE. The old code copied on put and again on take, so a 44 MB map briefly
// occupied 132 MB: the source buffer, the stored copy and the handed-out copy. The copy on
// take is the one that has to stay — a loader that hands a typed array to a worker can detach
// what it was given, and the next reader would find an empty buffer with no way to tell that
// is what happened. The copy on put is redundant: `once()` built that ArrayBuffer for this
// call and nothing else holds it.
const CACHE_MAX_BYTES = 64 * 1024 * 1024
const CACHE_MAX_ENTRIES = 4
const cache = new Map()   // url -> ArrayBuffer, in least-recently-used order
let cacheBytes = 0

function cacheTake(url) {
  if (!cache.has(url)) return null
  const buf = cache.get(url)
  cache.delete(url); cache.set(url, buf)   // touch: Map keeps insertion order, so re-insert
  return buf.slice(0)
}
function cachePut(url, buffer) {
  if (!buffer || buffer.byteLength > CACHE_MAX_BYTES) return
  if (cache.has(url)) { cacheBytes -= cache.get(url).byteLength; cache.delete(url) }
  cache.set(url, buffer)
  cacheBytes += buffer.byteLength
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cacheBytes -= cache.get(oldest).byteLength
    cache.delete(oldest)
  }
}
// For a test, and for a page that wants the memory back.
export function clearAssetCache() { cache.clear(); cacheBytes = 0 }
export function assetCacheStats() { return { entries: cache.size, bytes: cacheBytes } }

// ---- one request per URL, even when two callers want it at the same moment.
//
// The cache above answers the second caller only once the first has FINISHED, and the handoff
// it was built for does not wait that long. The Route card starts the map when the map page
// opens and the expand control sits on the card itself, so the viewer's request usually lands
// while the card's is still in flight: a miss, a second connection, and the same 9-44 MB down
// the wire twice. The browser's own cache cannot help there — it stores a response, and there
// is no response yet.
//
// So a request that is in flight is JOINED rather than repeated. The second caller awaits the
// first's promise, gets its own copy of the bytes, and its progress bar is fed off the same
// stream (from where that stream has already reached, so a joined bar does not start at zero
// and crawl through numbers the first caller already passed).
//
// A caller that brings an AbortSignal is never joined: it owns its request, and cancelling a
// shared fetch would cancel it for somebody else. Nothing in the viewer passes one today.
const inflight = new Map()   // url -> { promise, feed: Set<onProgress>, got, len, takers }

function join(url, opts) {
  if (opts.signal) return { promise: once(url, opts), shared: () => false }
  let e = inflight.get(url)
  if (!e) {
    e = { feed: new Set(), got: 0, len: 0, takers: 0 }
    e.promise = once(url, {
      onProgress: (n, t) => {
        e.got = n; e.len = t
        for (const fn of e.feed) { try { fn(n, t) } catch (err) { /* a progress bar is not worth a throw */ } }
      },
    }).then((r) => { inflight.delete(url); return r })
    inflight.set(url, e)
  }
  e.takers += 1
  const fn = opts.onProgress
  if (fn) {
    e.feed.add(fn)
    if (e.got > 0 || e.len > 0) fn(e.got, e.len)
  }
  return { promise: e.promise.then((r) => { if (fn) e.feed.delete(fn); return r }), shared: () => e.takers > 1 }
}

// The bucket first, then the proxy. `urls` is [preferred, fallback]; a null entry is skipped.
// Resolves { ok, buffer, from: 'public' | 'proxy' | 'memory' } — never throws.
export async function fetchAsset(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean)
  for (const url of list) {
    const hit = cacheTake(url)
    if (hit) {
      // The boot bar is driven by onProgress; a file that is already here is simply done.
      if (opts.onProgress) opts.onProgress(hit.byteLength, hit.byteLength)
      return { ok: true, buffer: hit, from: 'memory', status: 200 }
    }
  }
  for (let i = 0; i < list.length; i++) {
    const { promise, shared } = join(list[i], opts)
    const r = await promise
    if (r.ok) {
      // The fetched buffer is the one that STAYS; the caller gets the copy, exactly as a
      // later cache hit does. One copy live at a time either way. A file too big to cache is
      // copied too when the request was shared — two callers cannot both own bytes a loader
      // is allowed to detach.
      cachePut(list[i], r.buffer)
      const out = cache.has(list[i]) || shared() ? r.buffer.slice(0) : r.buffer
      return { ok: true, buffer: out, from: isAbs(list[i]) ? 'public' : 'proxy', status: r.status }
    }
    // A 404 from the bucket still tries the proxy: the proxy may hold a copy of an object that
    // was re-uploaded under a new version, and it costs one request to find out.
    if (opts.signal && opts.signal.aborted) break
  }
  return { ok: false, buffer: null, from: null }
}

export async function fetchJson(urls, opts = {}) {
  const r = await fetchAsset(urls, opts)
  if (!r.ok) return null
  try { return JSON.parse(new TextDecoder().decode(new Uint8Array(r.buffer))) } catch (e) { return null }
}

// Warm the browser cache for a map, once per (game, map). Called when the pointer lands on a
// Watch control — the map is the big half of the wait and it is the same file whichever row on
// that map is clicked, so hovering one row pays for all of them. Fire and forget: nothing waits
// on it, a failure is not reported, and nothing is held in JS.
//
// It goes through the manifest because that is what knows the bucket URL and the version; the
// viewer then asks for the identical URL and the browser answers out of its cache.
//
// It goes through join() rather than fetch() so that the map page cannot pay twice for one
// file: the Route card is usually already pulling the same map when a Watch row underneath it
// is hovered, and a bare fetch would open a second connection for bytes that are on their way.
// Joined, the hover costs nothing and the card's own request still fills the browser cache for
// every other row. It also covers the other order — hover, then click a fraction of a second
// later — where the viewer used to open a second connection for a file the hover had barely
// started. A map that is already here in full is skipped outright.
//
// The cost of going this way is that a warm-up holds the bytes until its own request settles
// (they are dropped straight after, and only a click keeps them). That is the same buffer the
// viewer would be holding a moment later on the click this is warming for.
const prefetched = new Set()
export function prefetchMap(game, map, variant) {
  const key = `${game}/${map}`
  if (!game || !map || !variant || prefetched.has(key)) return
  prefetched.add(key)
  const q = new URLSearchParams({ game, map, variant })
  fetch('/api/mv/replay3d/manifest?' + q.toString(), { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (!m || !m.public) return
      for (const u of [m.public.glb, m.public.entities]) {
        if (!u || cache.has(u)) continue
        // The result is dropped on purpose — the point is the browser's cache and the in-flight
        // entry, not bytes held here for a map that may never be opened.
        join(u, {}).promise.catch(() => null)
      }
    })
    .catch(() => null)
}
