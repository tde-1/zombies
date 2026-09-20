// The dev-box game lock (docs/dev-box.md rule 5).
//
// On B's PC four agents want to start World at War and only one may. A lock file at
// ZombiesDev\locks\game.lock holds "<name> <pid|starting> <ISO time> <what>"; it is
// stale after 15 minutes or when the pid inside it is dead.
//
// On a player's machine ZombiesDev does not exist and none of this runs. It is a
// development courtesy, not a product feature, and it is deliberately the only part of
// the launcher that knows about other agents.
import fs from 'node:fs'
import path from 'node:path'

const DEV_ROOT = process.env.ENW_DEV_ROOT || 'C:\\Users\\b\\ZombiesDev'
const LOCK_DIR = path.join(DEV_ROOT, 'locks')
const LOCK_FILE = path.join(LOCK_DIR, 'game.lock')
const STALE_MS = 15 * 60 * 1000

export const enabled = () => fs.existsSync(DEV_ROOT)
export const lockFile = LOCK_FILE

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

export function read() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim()
    const [name, pidStr, time, ...why] = raw.split(/\s+/)
    const pid = /^\d+$/.test(pidStr) ? Number(pidStr) : null
    const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs
    return {
      held: true, raw, name, pid, time, why: why.join(' '), ageMs: age,
      stale: age > STALE_MS || (pid !== null && !alive(pid)),
    }
  } catch { return { held: false } }
}

// Returns { ok, reason, holder }. Never steals a live lock.
export function acquire(name, why, { force = false } = {}) {
  if (!enabled()) return { ok: true, reason: 'no dev box here — no lock needed' }
  const cur = read()
  if (cur.held && !cur.stale && !force) {
    return { ok: false, reason: `game.lock is held by ${cur.name} (pid ${cur.pid}, ${Math.round(cur.ageMs / 1000)}s ago): ${cur.why}`, holder: cur }
  }
  fs.mkdirSync(LOCK_DIR, { recursive: true })
  fs.writeFileSync(LOCK_FILE, `${name} starting ${new Date().toISOString()} ${why}`)
  return { ok: true, reason: cur.held ? `took a stale lock (was: ${cur.raw})` : 'took the lock', tookStale: !!cur.held }
}

export function update(name, pid, why) {
  if (!enabled()) return
  try { fs.writeFileSync(LOCK_FILE, `${name} ${pid} ${new Date().toISOString()} ${why}`) } catch {}
}

// Re-assert a lock we hold, while our game is still running. Two reasons this has to
// exist:
//
//   1. dev-box.md rule 5 makes a lock STALE after 15 minutes. A real zombies game runs
//      for hours, so without a heartbeat another agent would correctly conclude our
//      lock was abandoned and take it — while the game was still up.
//   2. A lock can be deleted out from under us. It happened on 2026-09-20: our launch
//      took the lock, the file was gone by the time we released it, and from outside
//      that looks exactly like a game running with no lock at all.
//
// Returns what it did, so the caller can say so rather than doing it silently. It
// never overwrites a lock that names somebody else — that is their game, and two
// holders is worse than none.
export function heartbeat(name, pid, why) {
  if (!enabled()) return { action: 'none' }
  const cur = read()
  if (!cur.held) {
    update(name, pid, why)
    return { action: 'restored', detail: 'the shared game lock had been removed while our game was running; put it back' }
  }
  if (cur.name !== name) {
    return { action: 'taken_by_other', detail: `another agent (${cur.name}, pid ${cur.pid}) holds the game lock while our game is running` }
  }
  update(name, pid, why)
  return { action: 'refreshed' }
}

// Only ever releases OUR lock: if someone else has taken it since, leave it alone.
export function release(name) {
  if (!enabled()) return { released: false, reason: 'no lock in use' }
  const cur = read()
  if (!cur.held) return { released: false, reason: 'already gone' }
  if (cur.name !== name) return { released: false, reason: `not ours any more (now ${cur.name}) — left alone` }
  try { fs.unlinkSync(LOCK_FILE); return { released: true } } catch (e) { return { released: false, reason: e.message } }
}
