'use strict'

// Game boxes — the site's half of the pull protocol's identity.
//
// A box authenticates with a per-box shared secret in `x-match-secret`, exactly as ENW's CS
// fleet does (`server/routes/gameserver.js`), and **the site never connects out to it**.
// Everything a box does is an outbound HTTP request from the box.
//
// ── THE KEY PIN ─────────────────────────────────────────────────────────────────────
// The host agent asked for this and it is the reason this file is not just a secrets table.
// From `docs/kickstart/host.md` §5:
//
//     a file re-signed with a different key is internally consistent and therefore *must* be
//     checked against the box's pinned public key. Integrity is not authorship.
//
// A replay's Ed25519 footer proves nothing has changed since it was signed. It does NOT
// prove who signed it. Without a pin, anybody who can reach `/api/gs/result` — which is
// anybody who has ever had a box secret, including a decommissioned cloud box — can hand us
// a flawless replay of a game that never happened, and `verify.js` will call it VALID.
//
// So: TRUST ON FIRST USE, then refuse to move.
//
//   * the first key a box presents is pinned, with the time;
//   * the same key thereafter is accepted silently;
//   * a DIFFERENT key is NOT accepted. It is parked in `replay_pub_pending`, the box is told
//     `key_pinned: false` in its next status reply, every replay it posts is stored with
//     `key_pinned = 0`, and an admin has to confirm the change. That is deliberately the
//     same shape as an SSH host-key warning, because it is the same problem.
//
// A box only ever posts its PUBLIC key. Nothing here holds a private key belonging to a box,
// and nothing here holds a credential that can reach ENW's CS:GO boxes (99 §0.2).

const { db, now } = require('../db/database')
const { secretEq, safeJson } = require('./util')

const STALE_MS = 30_000

/** Resolve a request's `x-match-secret` to a box row, or null. */
function authenticate(req) {
  const key = String((req.headers && req.headers['x-match-secret']) || '')
  if (!key) return null
  // Compared with a timing-safe equality against every enabled box. The list is tiny and
  // `===` on a secret is a habit not worth keeping.
  for (const b of db.prepare('SELECT * FROM boxes WHERE enabled=1').all()) {
    if (secretEq(key, b.match_key)) return b
  }
  return null
}

function touch(box, patch = {}) {
  db.prepare(`UPDATE boxes SET last_poll=?, polls=COALESCE(polls,0)+1,
              first_seen=COALESCE(first_seen,?), last_state=COALESCE(?, last_state) WHERE id=?`)
    .run(now(), now(), patch.state || null, box.id)
}

// How long a lease has to be unclaimed before the box's own silence about it counts as
// proof that it is not running. Long enough to cover a boot under Wine (measured: 6 s to
// `map_loaded`, plus the ExecStartPre rig wait after a restart), short enough that a dead
// lease does not eat a slot for a whole evening.
const LEASE_GRACE_MS = 90_000

function recordStatus(box, body) {
  db.prepare('UPDATE boxes SET last_status_json=?, last_state=?, last_poll=? WHERE id=?')
    .run(JSON.stringify(body || {}), (body && body.state) || null, now(), box.id)
  reapGhostLeases(box, body)
}

/**
 * Close leases this box is provably not running.
 *
 * THE BUG THIS FIXES was the second party-killer of the evening (the first was a box with
 * no `address`). A lease only ever leaves `leased`/`ready`/`live` when a game ENDS with a
 * result. An instance that is retired instead — a superseded lease, a host-agent restart,
 * a cancelled Start — leaves its row live forever, and `pickFree()` counts those rows
 * against `max_instances`. Two of them on a two-instance box and every future Start gets
 * "no game box is online", with the box sitting there idle. Measured tonight, twice.
 *
 * The box's status report is the evidence: it lists the instances it actually has. So a
 * lease for this box that the box does not mention, and that is older than the grace
 * period, is over. Nothing here touches a lease the box IS running, and nothing here runs
 * on a status report that carries no instance list at all — a box that says nothing must
 * not be read as a box that says "nothing".
 */
function reapGhostLeases(box, body) {
  if (!body || !Array.isArray(body.instances)) return
  const alive = new Set(body.instances.map((i) => i && i.match_id).filter(Boolean))
  const cutoff = now() - LEASE_GRACE_MS
  const rows = db.prepare(`SELECT id, match_id, party_id FROM assignments
                            WHERE box_id=? AND state IN ('leased','ready','live') AND issued_at < ?`)
    .all(box.id, cutoff)
  for (const a of rows) {
    if (alive.has(a.match_id)) continue
    db.prepare("UPDATE assignments SET state='ended', ended_at=? WHERE id=?").run(now(), a.id)
    if (a.party_id) db.prepare("UPDATE parties SET state='forming', match_id=NULL WHERE id=?").run(a.party_id)
    log('assignment.ghost', box.name, { match_id: a.match_id, why: 'the box is not running it' })
  }
}

/**
 * Offer a public key for pinning.
 *
 * @returns {object} { pinned, changed, key_id, pinned_key_id }
 *   pinned  — true when this exact key is the one we trust
 *   changed — true when a DIFFERENT key arrived and is now waiting for an admin
 */
function offerKey(box, pub, keyId) {
  if (!pub && !keyId) return { pinned: false, changed: false, key_id: null, pinned_key_id: box.replay_key_id || null }
  const fresh = db.prepare('SELECT * FROM boxes WHERE id=?').get(box.id)
  const id = keyId || null

  if (!fresh.replay_key_id) {
    db.prepare('UPDATE boxes SET replay_pub=?, replay_key_id=?, key_pinned_at=?, replay_pub_pending=NULL, pending_key_id=NULL WHERE id=?')
      .run(pub || null, id, now(), box.id)
    log('box.key.pinned', fresh.name, { key_id: id })
    return { pinned: true, changed: false, key_id: id, pinned_key_id: id, first: true }
  }

  if (fresh.replay_key_id === id) {
    // Same key. If we only ever saw the id (a status heartbeat), fill in the raw key now.
    if (pub && !fresh.replay_pub) db.prepare('UPDATE boxes SET replay_pub=? WHERE id=?').run(pub, box.id)
    return { pinned: true, changed: false, key_id: id, pinned_key_id: fresh.replay_key_id }
  }

  // A different key. This is the case the pin exists for.
  if (fresh.pending_key_id !== id) {
    db.prepare('UPDATE boxes SET replay_pub_pending=?, pending_key_id=?, pending_seen_at=? WHERE id=?')
      .run(pub || null, id, now(), box.id)
    log('box.key.changed', fresh.name, { was: fresh.replay_key_id, now: id })
    console.warn(`[boxes] ${fresh.name} presented replay key ${id}, but ${fresh.replay_key_id} is pinned. ` +
      'Replays from it are stored UNPINNED until an admin confirms the change.')
  }
  return { pinned: false, changed: true, key_id: id, pinned_key_id: fresh.replay_key_id }
}

/** Did the replay that just arrived come from the key we trust for this box? */
function keyMatchesPin(boxName, keyId) {
  if (!boxName || !keyId) return false
  const b = db.prepare('SELECT replay_key_id FROM boxes WHERE name=?').get(String(boxName))
  return !!(b && b.replay_key_id && b.replay_key_id === String(keyId))
}

/** An admin accepting a key change. The old key's replays keep their pinned flag. */
function acceptPendingKey(boxId, by) {
  const b = db.prepare('SELECT * FROM boxes WHERE id=?').get(Number(boxId))
  if (!b || !b.pending_key_id) return { ok: false, error: 'nothing pending' }
  db.prepare(`UPDATE boxes SET replay_pub=replay_pub_pending, replay_key_id=pending_key_id, key_pinned_at=?,
              replay_pub_pending=NULL, pending_key_id=NULL, pending_seen_at=NULL WHERE id=?`).run(now(), b.id)
  log('box.key.accepted', by, { box: b.name, key_id: b.pending_key_id })
  return { ok: true, key_id: b.pending_key_id }
}

function rejectPendingKey(boxId, by) {
  const b = db.prepare('SELECT * FROM boxes WHERE id=?').get(Number(boxId))
  if (!b) return { ok: false, error: 'no such box' }
  db.prepare('UPDATE boxes SET replay_pub_pending=NULL, pending_key_id=NULL, pending_seen_at=NULL WHERE id=?').run(b.id)
  log('box.key.rejected', by, { box: b.name, key_id: b.pending_key_id })
  return { ok: true }
}

// ---- registry --------------------------------------------------------------------
const byName = (name) => db.prepare('SELECT * FROM boxes WHERE name=?').get(String(name))
const byId = (id) => db.prepare('SELECT * FROM boxes WHERE id=?').get(Number(id))
const nameOf = (id) => (byId(id) || {}).name || null

function list() {
  return db.prepare('SELECT * FROM boxes ORDER BY name').all().map((b) => ({
    id: b.id,
    name: b.name,
    region: b.region,
    note: b.note,
    enabled: !!b.enabled,
    max_instances: b.max_instances,
    online: !!(b.last_poll && now() - b.last_poll < STALE_MS),
    last_poll: b.last_poll,
    last_state: b.last_state,
    status: safeJson(b.last_status_json, null),
    key: {
      pinned: b.replay_key_id || null,
      pinned_at: b.key_pinned_at || null,
      pending: b.pending_key_id || null,
      pending_seen_at: b.pending_seen_at || null,
    },
    // The secret is never in an API response, not even to an admin. It is provisioned out of
    // band; showing it in a browser is how it ends up in a screenshot.
  }))
}

function create({ name, matchKey, region = null, note = null, maxInstances = 4 }) {
  db.prepare(`INSERT INTO boxes (name, match_key, region, note, enabled, max_instances, created_at)
              VALUES (?,?,?,?,1,?,?)`).run(String(name), String(matchKey), region, note, maxInstances, now())
  return byName(name)
}

/**
 * The address a CLIENT dials to reach this box, written down by an operator.
 *
 * `assignments.connectFor()` prefers this over anything the box says about itself, and
 * until 2026-09-22 evening NOTHING WROTE IT — the column existed, every box had NULL, and
 * the host agent's status carries no `public_ip` either, so `connect` came back null for
 * every lease and a launcher sat on "Reserving server" until it timed out. The fallback was
 * never reached because there was nothing to fall back to.
 */
function setAddress(name, address) {
  const a = address == null || address === '' ? null : String(address).trim()
  // A host:port here would be silently concatenated with the instance port downstream.
  if (a && /[\s/]/.test(a)) throw new Error('an address is a host or an IP, with no port, scheme or path')
  db.prepare('UPDATE boxes SET address=? WHERE name=?').run(a, String(name))
  return byName(name)
}

function setEnabled(id, on) {
  db.prepare('UPDATE boxes SET enabled=? WHERE id=?').run(on ? 1 : 0, Number(id))
  return byId(id)
}

/** A box that has polled recently and has room. Used when leasing a game. */
function pickFree() {
  const cutoff = now() - STALE_MS
  const rows = db.prepare('SELECT * FROM boxes WHERE enabled=1 AND last_poll > ? ORDER BY last_poll DESC').all(cutoff)
  for (const b of rows) {
    const live = db.prepare("SELECT COUNT(*) c FROM assignments WHERE box_id=? AND state IN ('leased','ready','live')").get(b.id).c
    if (live < (b.max_instances || 1)) return b
  }
  return null
}

function log(event, actor, meta) {
  db.prepare('INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES (?,?,?,?)')
    .run(event, actor || null, JSON.stringify(meta || {}), now())
}

module.exports = {
  STALE_MS, authenticate, touch, recordStatus, offerKey, keyMatchesPin,
  acceptPendingKey, rejectPendingKey, byName, byId, nameOf, list, create, setEnabled, setAddress, pickFree,
  reapGhostLeases, LEASE_GRACE_MS,
}
