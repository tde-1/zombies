'use strict'

// Leases — "box, this is what you should be running".
//
// The pull protocol, copied from ENW's CS:GO matchmaker: the site writes a row here and the
// box discovers it on its next `GET /api/gs/assignment`. The site never pushes and never
// dials out, so a box behind NAT with no inbound rules works with no extra machinery.
//
// The `nonce` is what makes a 3-second poll free: the box caches it and only reconfigures
// when it changes (`infra/host-agent/lib/siteclient.js`). It is a hash of the assignment
// with the tokens and the timestamp REMOVED, so re-issuing an identical lease — which
// happens whenever the site restarts — does not restart a running game.
//
// Invite tokens are minted here, one per whitelisted SteamID, bound to (steamid, match).
// They live five minutes: long enough for a launcher to start WaW and connect, short enough
// that a leaked one is worthless. The box only ever holds the public half of the key that
// signed them, so a stolen box cannot mint a join for anyone.

const { db, now } = require('../db/database')
const { canonical, sha256hex, matchId: newMatchId, safeJson } = require('./util')
const tokens = require('./tokens')
const boxes = require('./boxes')
const enw = require('./enw')
const maps = require('./maps')

const nonceOf = (x) => sha256hex(canonical(x)).slice(0, 12)

const LIVE_STATES = "('leased','ready','live')"

// ── SEVERAL GAMES PER BOX (2026-09-23) ─────────────────────────────────────────────────
//
// Until tonight `lease()` superseded EVERY live lease on the box, whoever it belonged to,
// and the host agent retired every game whose match id was not the newest. So a box ran
// one game at a time whatever `max_instances` said, and any second Play (an agent's
// fake-ID proof, a friend's party) kicked the first. It kicked B at 19:21 and several
// times after. The rules now, in order:
//
//   1. A player re-pressing Play replaces THEIR OWN game: a live lease of the same party,
//      or of exactly the same set of SteamIDs, is superseded. Never anybody else's.
//   2. Otherwise the lease takes a free slot. A box holds `capacity(box).max` live leases.
//   3. `reserve` of those slots (default 1 on a box of 3 or more) are for AGENT leases
//      (`agent: true`; lease-cli sets it): real players get max - reserve, and an agent
//      never takes the last slot a real player is still entitled to.
//   4. A real lease that finds the box full while real players are under their share
//      supersedes the OLDEST agent lease. The only cross-party supersede there is.
//   5. Anything else is "No free server right now", and nothing is superseded.
//
// A box on the OLD pull protocol (a host agent that does not poll with `?v=2`) can only
// run the newest lease it is shown, so its capacity is 1 until it polls with v=2 or says
// `protocol: 2` in a status report.
const protocols = new Map()           // box id -> { v, at }

/** The host agent's GET /api/gs/assignment says which protocol it speaks. */
function notePoll(box, v) {
  protocols.set(box.id, { v: Number(v) || 1, at: now() })
}

/** How many live leases this box may hold, and how many of those are agent-only. */
function capacity(box) {
  const fresh = db.prepare('SELECT * FROM boxes WHERE id=?').get(box.id) || box
  const st = safeJson(fresh.last_status_json, null) || {}
  let max = Math.max(1, Number(fresh.max_instances) || 1)
  // The box knows how many game copies it really has (host.js checkSlotCopies).
  if (Number(st.max_instances) > 0) max = Math.min(max, Number(st.max_instances))
  const p = protocols.get(fresh.id)
  const v = Math.max((p && p.v) || 1, Number(st.protocol) || 1)
  if (v < 2) max = 1
  const r = fresh.reserve == null ? (max >= 3 ? 1 : 0) : Math.max(0, Number(fresh.reserve) || 0)
  return { max, reserve: Math.min(r, max), protocol: v }
}

function liveOn(boxId) {
  return db.prepare(`SELECT * FROM assignments WHERE box_id=? AND state IN ${LIVE_STATES} ORDER BY id`).all(boxId)
}

const idSet = (players) => [...new Set((players || []).map((p) => String(p.steamid)))].sort().join(',')

/** Rule 1: is this live row the same party's, or the same players', game? */
function sameGame(row, partyId, ids) {
  if (partyId && row.party_id && Number(row.party_id) === Number(partyId)) return true
  return idSet(safeJson(row.players_json, [])) === ids
}

/**
 * Rules 2-5 for one box. `own` are rows rule 1 is about to supersede; they do not count.
 * @returns {{ ok: boolean, yieldRow?: object, cap: object, why?: 'full'|'reserve' }}
 */
function admit(box, { agent, own = [] } = {}) {
  const cap = capacity(box)
  const ownIds = new Set(own.map((r) => r.id))
  const rows = liveOn(box.id).filter((r) => !ownIds.has(r.id))
  const total = rows.length
  const agents = rows.filter((r) => r.agent)
  const real = total - agents.length
  const realShare = cap.max - cap.reserve
  if (agent) {
    if (total >= cap.max) return { ok: false, cap, why: 'full' }
    // Never the last slot a real player is still entitled to. A one-slot box (an old-protocol
    // agent, or a box with one game copy) is the exception: an empty one takes the agent,
    // because rule 4 hands the slot straight back the moment a real player presses Play.
    if (cap.max > 1 && total + 1 >= cap.max && real < realShare) return { ok: false, cap, why: 'reserve' }
    return { ok: true, cap }
  }
  if (real >= realShare) return { ok: false, cap, why: 'full' }
  if (total < cap.max) return { ok: true, cap }
  if (agents.length) return { ok: true, cap, yieldRow: agents[0] }
  return { ok: false, cap, why: 'full' }
}

function supersede(row, why, by) {
  db.prepare("UPDATE assignments SET state='superseded', ended_at=? WHERE id=?").run(now(), row.id)
  if (row.party_id) {
    db.prepare("UPDATE parties SET state='forming', match_id=NULL WHERE id=? AND match_id=?").run(row.party_id, row.match_id)
  }
  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('assignment.supersede', ?, ?, ?)")
    .run(by || null, JSON.stringify({ match_id: row.match_id, why }), now())
}

const NO_FREE = 'No free server right now'

/**
 * Lease a game onto a box.
 *
 * @param {object} o
 * @param {object} o.box        the box row (or null to pick a free one)
 * @param {string} o.mapKey
 * @param {string} [o.mode]     verified | custom
 * @param {Array}  o.players    [{ steamid, name }]
 * @param {object} [o.settings] the Custom knobs, or {} for Verified
 * @param {number} [o.partyId]
 */
function lease(o) {
  // An agent lease is one an agent asked for (`agent: true`, or lease-cli, which sets
  // ZM_AGENT_LEASE in its own process only). It may use the reserve, and it yields.
  const agent = !!o.agent || process.env.ZM_AGENT_LEASE === '1'

  const map = db.prepare('SELECT * FROM maps WHERE key=?').get(String(o.mapKey))
  if (!map) return { ok: false, error: 'no such map' }
  if (map.health === 'broken') return { ok: false, error: 'that map does not run on our servers' }
  // The map list already hides these, but the UI is not the boundary: a deep link, a stale
  // party or a hand-made POST must not be able to lease a map no dedicated server has ever
  // survived. `maps.onServer` is the measured list (lib/maps.js).
  if (!maps.onServer(map)) return { ok: false, error: 'that map does not run on our servers yet' }
  const version = db.prepare('SELECT * FROM map_versions WHERE map_id=? AND latest=1').get(map.id)

  // THE NAME IS NOT THE CALLER'S TO GIVE (2026-09-23).
  //
  // This used to take `p.name` from whoever asked for the lease. That name goes into the
  // invite token's `n`, and the referee now OVERWRITES the client's userinfo with it — so
  // a caller-supplied name would be a signed, server-enforced impersonation, which is
  // worse than the spoofing it replaces. It is read from the account here, by SteamID,
  // through the one reader in `lib/names.js`.
  //
  // `P1`..`P4` stays as the last resort for an account that has not picked yet, rather
  // than a raw SteamID, because it is what a scoreboard can show without being wrong.
  const names = require('./names')
  const players = (o.players || []).map((p, i) => {
    const steamid = String(typeof p === 'string' ? p : p.steamid)
    return { steamid, name: names.hasEnforceableName(steamid) ? names.displayName(steamid) : `P${i + 1}` }
  })
  if (!players.length) return { ok: false, error: 'nobody in the lobby' }
  if (players.length > 4) return { ok: false, error: 'World at War has four client slots' }

  const mode = o.mode === 'custom' ? 'custom' : 'verified'
  // Any VIP in the lobby uncaps the whole game (05). Read once, at lease time, because the
  // box needs to know before the first round and nothing should poll for it mid-game.
  const vip = enw.anyVip(players.map((p) => p.steamid))

  const matchId = o.matchId || newMatchId()
  const settings = mode === 'custom' ? { ...(o.settings || {}) } : {}
  // `dev` (test god mode and friends, dedi.md §23) is an agent's and nobody else's: a
  // party leader can store any Custom settings (parties.setSettings), so it is dropped
  // here for every lease that is not an agent's. The host also requires `agent` + custom.
  if (!agent) delete settings.dev

  // The manifest travels WITH the lease. The box reads `referee/manifests/` from its own
  // disk today, which works because the repo is the same one; a real cloud box has no repo,
  // so the site sends the manifest it has on file and the box uses it if it has nothing
  // better. Sending it also means the run is refereed against the version the site thinks
  // it leased, which is what makes "per map version" boards honest.
  const manifest = version
    ? safeJson((db.prepare('SELECT json FROM manifests WHERE map_version_id=?').get(version.id) || {}).json, null)
    : null

  const core = {
    match_id: matchId,
    map: map.key,
    fs_game: (version && version.fs_game) || null,
    mode,
    settings,
    players,
    whitelist: players.map((p) => p.steamid),
    vip,
    kind: 'game',
    map_version: version ? version.version : null,
    manifest,
  }
  const nonce = nonceOf(core)

  // ---- which box, and whose game (if anybody's) makes way ----------------------------
  const ids = idSet(players)
  const own = db.prepare(`SELECT * FROM assignments WHERE state IN ${LIVE_STATES} ORDER BY id`).all()
    .filter((r) => sameGame(r, o.partyId, ids))
  const candidates = o.box ? [o.box] : boxes.online()
  if (!candidates.length) return { ok: false, error: 'no game box is online' }
  let box = null
  let verdict = null
  for (const b of candidates) {
    verdict = admit(b, { agent, own: own.filter((r) => r.box_id === b.id) })
    if (verdict.ok) { box = b; break }
  }
  if (!box) {
    return {
      ok: false, full: true, error: NO_FREE,
      why: verdict && verdict.why === 'reserve' ? 'the last free slot is kept for players' : 'every slot is in use',
    }
  }

  const tok = {}
  for (const p of players) tok[p.steamid] = tokens.issue({ steamid: p.steamid, matchId, name: p.name })

  // Rule 1: this party's / these players' own earlier game, wherever it is.
  for (const r of own) supersede(r, `replaced by ${matchId} (same players)`, o.by)
  // Rule 4: a real player takes the oldest agent's slot.
  if (verdict.yieldRow) supersede(verdict.yieldRow, `agent lease yields to ${matchId}`, o.by)

  db.prepare(`INSERT INTO assignments (box_id, match_id, party_id, map_key, map_version_id, fs_game, mode,
      settings_json, players_json, tokens_json, vip, kind, nonce, state, issued_at, agent)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'leased', ?, ?)`)
    .run(box.id, matchId, o.partyId || null, map.key, version ? version.id : null, core.fs_game, mode,
      JSON.stringify(settings), JSON.stringify(players), JSON.stringify(tok), vip ? 1 : 0, 'game', nonce, now(), agent ? 1 : 0)

  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('assignment.lease', ?, ?, ?)")
    .run(o.by || null, JSON.stringify({
      box: box.name, match_id: matchId, map: map.key, mode, players: players.length, agent,
      replaced: own.map((r) => r.match_id), yielded: verdict.yieldRow ? verdict.yieldRow.match_id : null,
    }), now())

  return { ok: true, box: box.name, match_id: matchId, nonce, assignment: { status: 'leased', ...core, nonce, tokens: tok } }
}

/**
 * What the box's poll sees. `idle` is a first-class answer, not an empty response.
 *
 * `v: 2` (the host agent polls with `?v=2`): EVERY live lease on the box, oldest first,
 * each in the old single-lease shape with its own nonce, under `assignments`. The top-level
 * nonce is a hash of theirs, so the box's nonce cache still works. Without `v` it is the
 * old shape, the newest live lease alone, which is all an old host agent can parse; and
 * `capacity()` holds such a box to one lease, so nothing it cannot see can exist.
 */
function forBox(box, { v = 1 } = {}) {
  const rows = liveOn(box.id)
  if (Number(v) >= 2) {
    const list = rows.map(shapeOf)
    return {
      v: 2,
      status: list.length ? 'leased' : 'idle',
      nonce: list.length ? nonceOf(list.map((x) => x.nonce)) : 'idle',
      assignments: list,
    }
  }
  const a = rows[rows.length - 1]
  if (!a) return { status: 'idle', nonce: 'idle' }
  return shapeOf(a)
}

function shapeOf(a) {
  return {
    status: 'leased',
    match_id: a.match_id,
    map: a.map_key,
    fs_game: a.fs_game,
    mode: a.mode,
    settings: safeJson(a.settings_json, {}),
    players: safeJson(a.players_json, []),
    whitelist: (safeJson(a.players_json, []) || []).map((p) => p.steamid),
    vip: !!a.vip,
    kind: a.kind,
    // An agent's lease (lease-cli). The host needs it to allow `settings.dev` (dedi.md §23).
    agent: !!a.agent,
    tokens: safeJson(a.tokens_json, {}),
    manifest: manifestFor(a),
    map_version: a.map_version_id ? (db.prepare('SELECT version FROM map_versions WHERE id=?').get(a.map_version_id) || {}).version : null,
    nonce: a.nonce,
    issued_at: new Date(a.issued_at || now()).toISOString(),
  }
}

function manifestFor(a) {
  if (!a.map_version_id) return null
  const m = db.prepare('SELECT json FROM manifests WHERE map_version_id=?').get(a.map_version_id)
  return m ? safeJson(m.json, null) : null
}

/** The box said `ready` / `live` / `booting`. */
function ack(box, state, matchId) {
  if (!matchId) return
  const a = db.prepare('SELECT * FROM assignments WHERE match_id=? AND box_id=?').get(String(matchId), box.id)
  if (!a) return
  // Forward only: a late 'ready' must not take a live game back to ready (the launcher's
  // cancel guard keys on 'live'), and nothing here revives an ended lease.
  if (!['leased', 'ready', 'live'].includes(a.state)) return
  const next = state === 'live' || a.state === 'live' ? 'live' : state === 'ready' ? 'ready' : a.state
  db.prepare('UPDATE assignments SET state=?, acked_at=COALESCE(acked_at,?), ready_at=CASE WHEN ?=\'ready\' THEN ? ELSE ready_at END WHERE id=?')
    .run(next, now(), state, now(), a.id)
  if (a.party_id && (state === 'ready' || state === 'live')) {
    db.prepare("UPDATE parties SET state='in-game', match_id=?, updated_at=? WHERE id=?").run(a.match_id, now(), a.party_id)
  }
}

function cancel(matchId, by) {
  const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(String(matchId))
  if (!a) return { ok: false, error: 'no such lease' }
  // By match id and nothing else: cancelling one game on a box never touches another.
  if (!['leased', 'ready', 'live'].includes(a.state)) return { ok: true, already: a.state }
  db.prepare("UPDATE assignments SET state='cancelled', ended_at=? WHERE id=?").run(now(), a.id)
  if (a.party_id) db.prepare("UPDATE parties SET state='forming', match_id=NULL WHERE id=? AND (match_id=? OR match_id IS NULL)").run(a.party_id, a.match_id)
  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('assignment.cancel', ?, ?, ?)")
    .run(by || null, JSON.stringify({ match_id: matchId }), now())
  return { ok: true }
}

/**
 * The launcher's "give the box back" (POST /api/launcher/cancel), which is for a launch
 * that never got going and must never end a game somebody is playing. See the route for
 * the 2026-09-23 m_6d80aa20 incident this exists for.
 *
 * @param {string} matchId  the party's current match
 * @param {object} o  { by, named: the match the launcher says it is releasing, force }
 */
function release(matchId, { by = null, named = null, force = false } = {}) {
  if (named && String(named) !== String(matchId)) {
    return { ok: true, noop: true, note: 'that is not your party\'s current game; nothing was cancelled' }
  }
  const a = db.prepare('SELECT state FROM assignments WHERE match_id=?').get(String(matchId))
  if (a && a.state === 'live' && !force) {
    return { ok: false, live: true, error: 'that game is live; end it in game' }
  }
  return cancel(matchId, by)
}

/** Live games, for the home page and the map page's "join". */
function live() {
  const rows = db.prepare(`SELECT a.*, b.name AS box_name FROM assignments a JOIN boxes b ON b.id=a.box_id
                            WHERE a.state IN ('leased','ready','live') ORDER BY a.issued_at DESC`).all()
  const users = require('./users')
  return rows.map((a) => {
    const players = safeJson(a.players_json, []) || []
    const party = a.party_id ? db.prepare('SELECT * FROM parties WHERE id=?').get(a.party_id) : null
    const mapRow = db.prepare('SELECT title FROM maps WHERE key=?').get(a.map_key)
    // Movement's joinability rule, ported: a stranger's PRIVATE lobby serialises with
    // `connect: null` AND `map: null`. Not "map plus a disabled button" — the map name is
    // itself information about a private game, and a serialiser that leaks it is how a
    // private lobby stops being private.
    const isPublic = !party || party.visibility === 'public'
    return {
      match_id: a.match_id,
      state: a.state,
      mode: a.mode,
      box: a.box_name,
      map: isPublic ? a.map_key : null,
      map_title: isPublic ? ((mapRow && mapRow.title) || a.map_key) : null,
      visibility: party ? party.visibility : 'public',
      party_id: a.party_id || null,
      player_count: players.length,
      players: isPublic ? players.map((p) => users.publicById(p.steamid) || { steam_id: p.steamid, name: p.name }) : [],
      started_at: a.issued_at,
      joinable: isPublic && players.length < 4 && a.state !== 'done',
    }
  })
}

module.exports = { lease, forBox, ack, cancel, release, live, nonceOf, capacity, notePoll, admit, NO_FREE }
