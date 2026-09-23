// The RAM guard: may this box start one more game process right now?
//
// MEASURED 2026-09-23 12:13-12:15 UTC (host.md §16): three CoDWaW.exe on the 3.8 GB box,
// with Steam's browser holding ~2 GB, took MemAvailable to 4 MB. Each instance is
// ~360-450 MB RSS once its map is loaded (dedi.md §19), and a WARM instance (finished, map
// restarted, nobody in it) holds the same. Nothing on the host checked memory before a boot.
//
// The rule, applied by `host.js` just before each boot leaves the boot queue:
//
//   effective = MemAvailable - (for every game process that has not loaded its map yet:
//                               expectRss - its RSS so far)
//
// The second term is because a boot that started a second ago has not grown yet, and
// MemAvailable read now would count that growth as free.
//
//   * effective >= floor              -> boot.
//   * an AGENT lease below the floor  -> retire WARM instances (nobody's), oldest first, if
//                                        that is enough; otherwise wait (the queue retries).
//   * a REAL player's lease below it  -> retire warm instances first, then the oldest AGENT
//                                        instances, until the estimate clears the floor; if
//                                        there is nothing left to retire, boot anyway and say
//                                        so (refusing a player a game they pressed Play for is
//                                        certain; the OOM is not).
//
// Pure functions except `readMeminfo`, so `test/run-all.js` drives every case.
import fs from 'node:fs'

export const MB = 1024 * 1024
export const DEFAULT_FLOOR_BYTES = 700 * MB
export const DEFAULT_EXPECT_RSS_BYTES = 450 * MB

/**
 * `/proc/meminfo` as `{ availableBytes, totalBytes }`, or null where there is no such file
 * (Windows, macOS) — in which case the guard is off, and the heartbeat says `mem: null`.
 */
export function readMeminfo(file = '/proc/meminfo') {
  let txt
  try { txt = fs.readFileSync(file, 'utf8') } catch { return null }
  return parseMeminfo(txt)
}

export function parseMeminfo(txt) {
  const kb = (k) => {
    const m = new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm').exec(String(txt || ''))
    return m ? Number(m[1]) * 1024 : null
  }
  const total = kb('MemTotal')
  // MemAvailable exists since Linux 3.14. Older kernels: free + buffers + cached is the
  // classic approximation, and it is only a floor check, so an approximation is fine.
  let avail = kb('MemAvailable')
  if (avail == null) {
    const parts = [kb('MemFree'), kb('Buffers'), kb('Cached')]
    avail = parts.every((x) => x == null) ? null : parts.reduce((s, x) => s + (x || 0), 0)
  }
  if (avail == null) return null
  return { availableBytes: avail, totalBytes: total }
}

/**
 * The decision for ONE boot.
 *
 * @param {object}   o
 * @param {number}   o.availBytes     MemAvailable now (null: guard off -> go)
 * @param {number}   o.floorBytes
 * @param {boolean}  o.real           a real player's lease (not `agent`)
 * @param {object[]} o.instances      every live game process on the box:
 *                                     { id, rssBytes, loaded, warm, agent, real, startedAt }
 *                                     (`loaded`: map_loaded seen; `real`/`agent`: its lease)
 * @param {number}  [o.expectRssBytes]
 * @returns {{ action: 'go'|'wait'|'evict', effective: number|null, victims: object[], why: string }}
 *   `evict`: retire `victims`, wait for the memory to come back, and ask again.
 */
export function ramPlan({ availBytes, floorBytes = DEFAULT_FLOOR_BYTES, real = false, instances = [], expectRssBytes = DEFAULT_EXPECT_RSS_BYTES } = {}) {
  if (availBytes == null || !Number.isFinite(Number(availBytes)) || !(floorBytes > 0)) {
    return { action: 'go', effective: null, victims: [], why: 'no memory figure on this platform (guard off)' }
  }
  const growth = instances
    .filter((i) => !i.loaded)
    .reduce((s, i) => s + Math.max(0, expectRssBytes - (Number(i.rssBytes) || 0)), 0)
  const effective = Number(availBytes) - growth
  const mb = (n) => `${Math.round(n / MB)} MB`
  const est = `${mb(effective)} available${growth ? ` (${mb(availBytes)} minus ${mb(growth)} still to be taken by booting games)` : ''}`
  if (effective >= floorBytes) return { action: 'go', effective, victims: [], why: `${est}, floor ${mb(floorBytes)}` }

  // What may be retired for room, in order. A warm instance is nobody's game; an agent
  // instance is an agent's test, and only a real player's lease may take one.
  const oldest = (a, b) => (a.startedAt || 0) - (b.startedAt || 0)
  const warm = instances.filter((i) => i.warm).sort(oldest)
  const agents = real ? instances.filter((i) => !i.warm && i.agent).sort(oldest) : []
  const victims = []
  let freed = 0
  for (const v of [...warm, ...agents]) {
    if (effective + freed >= floorBytes) break
    victims.push(v)
    // A process that has not loaded yet frees what it holds AND the growth reserved for it.
    freed += (Number(v.rssBytes) || 0) + (v.loaded ? 0 : Math.max(0, expectRssBytes - (Number(v.rssBytes) || 0)))
  }
  if (victims.length && (effective + freed >= floorBytes || real)) {
    return { action: 'evict', effective, victims, why: `${est}, floor ${mb(floorBytes)}: retiring ${victims.map((v) => `${v.id}${v.warm ? ' (warm)' : ' (agent)'}`).join(', ')} for room` }
  }
  if (real) return { action: 'go', effective, victims: [], why: `${est}, under the ${mb(floorBytes)} floor and nothing left to retire - booting the player's game anyway` }
  return { action: 'wait', effective, victims: [], why: `${est}, under the ${mb(floorBytes)} floor - an agent boot waits for memory` }
}
