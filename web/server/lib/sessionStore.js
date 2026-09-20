'use strict'

// A SQLite session store for express-session.
//
// The default MemoryStore loses every session when the process restarts, which during
// development means `node --watch` signs everybody out on every save, and during an
// integration pass means the site forgets who you are the moment anyone redeploys it. It
// also cannot work behind more than one process at all.
//
// This is express-session's Store interface over one table. No new dependency:
// better-sqlite3 is already here and a session write is a single prepared statement on a
// WAL database, which is faster than the round trip to a Redis nobody has installed.
//
// The table is created here rather than in db/database.js on purpose — it is infrastructure
// for the HTTP layer, not part of the product's data model, and a `DELETE FROM sessions` is
// always safe.

const session = require('express-session')
const { db, now } = require('../db/database')

const PRUNE_MS = 15 * 60_000

db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  data       TEXT NOT NULL
)`)
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)')

const Store = session.Store

class SqliteStore extends Store {
  constructor({ ttlMs = 30 * 86400_000 } = {}) {
    super()
    this.ttlMs = ttlMs
    this.q = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid=?'),
      set: db.prepare(`INSERT INTO sessions (sid, expires_at, data) VALUES (?,?,?)
                       ON CONFLICT(sid) DO UPDATE SET expires_at=excluded.expires_at, data=excluded.data`),
      del: db.prepare('DELETE FROM sessions WHERE sid=?'),
      touch: db.prepare('UPDATE sessions SET expires_at=? WHERE sid=?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
      all: db.prepare('SELECT sid, data FROM sessions WHERE expires_at > ?'),
      count: db.prepare('SELECT COUNT(*) c FROM sessions WHERE expires_at > ?'),
      clear: db.prepare('DELETE FROM sessions'),
    }
    this.prune()
    this.timer = setInterval(() => this.prune(), PRUNE_MS)
    this.timer.unref?.()
  }

  // express-session's contract is callback-style and it will hand us `undefined` for a
  // missing session — NOT an error. Returning an error for "not signed in" turns every
  // anonymous request into a 500.
  get(sid, cb) {
    try {
      const row = this.q.get.get(sid)
      if (!row) return cb(null, undefined)
      if (row.expires_at < now()) { this.q.del.run(sid); return cb(null, undefined) }
      return cb(null, JSON.parse(row.data))
    } catch (e) { return cb(e) }
  }

  set(sid, sess, cb) {
    try {
      this.q.set.run(sid, this.expiry(sess), JSON.stringify(sess))
      return cb ? cb(null) : undefined
    } catch (e) { return cb ? cb(e) : undefined }
  }

  destroy(sid, cb) {
    try { this.q.del.run(sid); return cb ? cb(null) : undefined } catch (e) { return cb ? cb(e) : undefined }
  }

  // Called on every request for a rolling session. One UPDATE of one integer.
  touch(sid, sess, cb) {
    try { this.q.touch.run(this.expiry(sess), sid); return cb ? cb(null) : undefined } catch (e) { return cb ? cb(e) : undefined }
  }

  length(cb) {
    try { return cb(null, this.q.count.get(now()).c) } catch (e) { return cb(e) }
  }

  clear(cb) {
    try { this.q.clear.run(); return cb ? cb(null) : undefined } catch (e) { return cb ? cb(e) : undefined }
  }

  all(cb) {
    try { return cb(null, this.q.all.all(now()).map((r) => JSON.parse(r.data))) } catch (e) { return cb(e) }
  }

  expiry(sess) {
    const c = sess && sess.cookie
    if (c && c.expires) return new Date(c.expires).getTime()
    if (c && c.maxAge) return now() + c.maxAge
    return now() + this.ttlMs
  }

  prune() {
    try { this.q.prune.run(now()) } catch { /* a locked database prunes next time */ }
  }
}

module.exports = { SqliteStore }
