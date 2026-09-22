'use strict'

// Cross-server chat — the Global channel (13 §2b), ported from Movement's
// `server/lib/chatNetwork.js` and matched to the drain the host agent already speaks.
//
// The shape is a RING WITH A CURSOR, not a pubsub:
//
//   * every line gets a monotonic id;
//   * a box long-polls `GET /api/gs/chat-feed?since=<id>&wait=<s>` and gets everything newer
//     than its cursor THAT DID NOT COME FROM ITSELF (a box already showed its own players'
//     lines locally; echoing them back would double every message);
//   * the website and launcher read the same ring over a socket.
//
// Long-poll rather than a websocket to the boxes, for the same reason as the rest of the
// pull protocol: a box behind NAT makes outbound requests and nothing else.

const { db, now } = require('../db/database')

const KEEP = 500
const MAX_LEN = 300

let waiters = []        // [{ origin, resolve, timer }]
let emit = null         // set by the socket layer: (line) => void

function setEmitter(fn) { emit = fn }

// `kind` is 'chat' for something a person typed and 'system' for a line the site
// composed out of an event (`lib/chatSystem.js`). It is a COLUMN rather than a prefix on
// the text, because the panel draws the two differently and a marker inside the text is a
// marker a player can type.
function push({ from, text, steamId = null, origin = 'web', mapKey = null, instance = null, channel = 'global', kind = 'chat' }) {
  const clean = String(text || '').replace(/[\r\n]+/g, ' ').slice(0, MAX_LEN).trim()
  if (!clean) return null
  const k = kind === 'system' ? 'system' : 'chat'
  const info = db.prepare(`INSERT INTO chat_network (at, origin, channel, kind, from_name, steam_id, text, map_key, instance)
                           VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(now(), origin, channel, k, from || 'player', steamId, clean, mapKey, instance)
  const line = {
    id: info.lastInsertRowid,
    at: now(),
    origin,
    channel,
    kind: k,
    from: from || 'player',
    steamid: steamId,
    text: clean,
    map: mapKey,
    instance,
  }
  // Wake every box waiting on the drain, and every browser on the socket.
  const ws = waiters
  waiters = []
  for (const w of ws) { clearTimeout(w.timer); w.resolve() }
  if (emit) { try { emit(line) } catch { /* a dead socket must not fail a chat line */ } }
  if (Math.random() < 0.05) db.prepare('DELETE FROM chat_network WHERE id NOT IN (SELECT id FROM chat_network ORDER BY id DESC LIMIT ?)').run(KEEP)
  return line
}

const latest = () => (db.prepare('SELECT MAX(id) m FROM chat_network').get().m || 0)

// The origin filter is IN THE QUERY, not after it. Filtering a LIMIT-ed page in JavaScript
// looks equivalent and is not: a box that has said a hundred things and then reconnects with
// `since=0` gets a page made entirely of its own lines, every one of which is filtered out,
// and the drain returns empty forever while the cursor never advances past them. Found
// exactly that way against a box with 2,400 of its own lines in the ring.
function since(cursor, { excludeOrigin = null, limit = 100 } = {}) {
  const sql = `SELECT * FROM chat_network WHERE id > ? AND removed=0
               ${excludeOrigin ? 'AND origin <> ?' : ''} ORDER BY id ASC LIMIT ?`
  const args = excludeOrigin ? [Number(cursor) || 0, excludeOrigin, limit] : [Number(cursor) || 0, limit]
  return db.prepare(sql).all(...args).map(project)
}

function tail(limit = 40) {
  return db.prepare('SELECT * FROM chat_network WHERE removed=0 ORDER BY id DESC LIMIT ?').all(limit).reverse().map(project)
}

const project = (r) => ({
  id: r.id, at: r.at, origin: r.origin, channel: r.channel, kind: r.kind || 'chat', from: r.from_name,
  steamid: r.steam_id, text: r.text, map: r.map_key, instance: r.instance,
})

/** The long-poll half of the drain. Resolves as soon as anything new lands, or on timeout. */
function wait(seconds, origin) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w.timer !== timer)
      resolve()
    }, Math.min(25, Math.max(1, seconds)) * 1000)
    timer.unref?.()
    waiters.push({ origin, resolve, timer })
  })
}

function remove(id, by) {
  db.prepare('UPDATE chat_network SET removed=1 WHERE id=?').run(Number(id))
  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('chat.remove', ?, ?, ?)")
    .run(by || null, JSON.stringify({ id }), now())
}

module.exports = { push, since, tail, latest, wait, remove, setEmitter, MAX_LEN }
