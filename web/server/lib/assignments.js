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
  const box = o.box || boxes.pickFree()
  if (!box) return { ok: false, error: 'no game box is online' }

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
  const settings = mode === 'custom' ? (o.settings || {}) : {}

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

  const tok = {}
  for (const p of players) tok[p.steamid] = tokens.issue({ steamid: p.steamid, matchId, name: p.name })

  // One live lease per box. An older one is closed rather than stacked: the protocol has no
  // queue on the box side and two leases would race for the same instance.
  db.prepare("UPDATE assignments SET state='superseded', ended_at=? WHERE box_id=? AND state IN ('leased','ready','live')")
    .run(now(), box.id)

  db.prepare(`INSERT INTO assignments (box_id, match_id, party_id, map_key, map_version_id, fs_game, mode,
      settings_json, players_json, tokens_json, vip, kind, nonce, state, issued_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'leased', ?)`)
    .run(box.id, matchId, o.partyId || null, map.key, version ? version.id : null, core.fs_game, mode,
      JSON.stringify(settings), JSON.stringify(players), JSON.stringify(tok), vip ? 1 : 0, 'game', nonce, now())

  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('assignment.lease', ?, ?, ?)")
    .run(o.by || null, JSON.stringify({ box: box.name, match_id: matchId, map: map.key, mode, players: players.length }), now())

  return { ok: true, box: box.name, match_id: matchId, nonce, assignment: { status: 'leased', ...core, nonce, tokens: tok } }
}

/** What the box's poll sees. `idle` is a first-class answer, not an empty response. */
function forBox(box) {
  const a = db.prepare(`SELECT * FROM assignments WHERE box_id=? AND state IN ('leased','ready','live')
                        ORDER BY id DESC LIMIT 1`).get(box.id)
  if (!a) return { status: 'idle', nonce: 'idle' }
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
  const next = state === 'ready' ? 'ready' : state === 'live' ? 'live' : a.state
  db.prepare('UPDATE assignments SET state=?, acked_at=COALESCE(acked_at,?), ready_at=CASE WHEN ?=\'ready\' THEN ? ELSE ready_at END WHERE id=?')
    .run(next, now(), state, now(), a.id)
  if (a.party_id && (state === 'ready' || state === 'live')) {
    db.prepare("UPDATE parties SET state='in-game', match_id=?, updated_at=? WHERE id=?").run(a.match_id, now(), a.party_id)
  }
}

function cancel(matchId, by) {
  const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(String(matchId))
  if (!a) return { ok: false, error: 'no such lease' }
  db.prepare("UPDATE assignments SET state='cancelled', ended_at=? WHERE id=?").run(now(), a.id)
  if (a.party_id) db.prepare("UPDATE parties SET state='forming', match_id=NULL WHERE id=?").run(a.party_id)
  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('assignment.cancel', ?, ?, ?)")
    .run(by || null, JSON.stringify({ match_id: matchId }), now())
  return { ok: true }
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

module.exports = { lease, forBox, ack, cancel, live, nonceOf }
