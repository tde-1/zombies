'use strict'

// Replays: where the file is, who may have it, and whether it is evidence.
//
// ── Three separate questions, deliberately kept apart ──────────────────────────────
//
// 1. **Is the file intact?** The Ed25519 footer answers that, and anybody can check it
//    with `infra/host-agent/tools/verify.js`. It is a property of the bytes.
//
// 2. **Who signed it?** The footer says, but a footer says whatever its author wants. The
//    answer that counts is whether the signing key is the one the SITE PINNED for that box
//    (lib/boxes.js), learned when the box first presented it and not movable without an
//    admin. host.md §5 is explicit: a file re-signed with a different key is internally
//    consistent, so integrity is not authorship.
//
// 3. **May this person download it?** Q-host-1, as the coordinator confirmed: everyone may
//    download their own games; someone else's full tracks need VIP or a public game; the
//    signed summary and event log are public for everyone, always, because that is what
//    makes a record checkable without trusting us.
//
// ── Where the bytes are ────────────────────────────────────────────────────────────
// In production: R2, and this file hands out a signed URL. There is no R2, so today it
// serves from a local directory — which works because the dev box and the site are the
// same machine, and which is the ONLY part of this file that changes when R2 exists.
// `ZM_REPLAY_DIR` points at it; `object_key` is the R2 seam and is null everywhere.

const fs = require('fs')
const path = require('path')
const { db, now } = require('../db/database')

const REPLAY_DIR = process.env.ZM_REPLAY_DIR
  || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'replays')

// The host agent's own container reader, imported rather than reimplemented: one
// implementation of the format, or the two drift and the site starts disagreeing with the
// tool everybody else runs. It is ESM, so this is a dynamic import and it is cached.
let replayLib = null
let replayLibErr = null
async function lib() {
  if (replayLib || replayLibErr) return replayLib
  try {
    const url = require('node:url').pathToFileURL(
      path.resolve(__dirname, '..', '..', '..', 'infra', 'host-agent', 'lib', 'replay.js'),
    ).href
    replayLib = await import(url)
  } catch (e) {
    // The site must work without the host agent's source tree beside it. Verification
    // becomes unavailable and says so; nothing else breaks.
    replayLibErr = e
    console.warn(`[replays] the host agent's replay reader is not available (${e.message}); verification is off`)
  }
  return replayLib
}

const rowFor = (matchId) => db.prepare('SELECT * FROM replays WHERE match_id=?').get(String(matchId))

/**
 * Resolve the stored pointer to a readable path, or null.
 *
 * The box stores an absolute path from ITS filesystem. On the dev box that is this
 * filesystem; on a real box it is not, and the answer will be an R2 key instead. Either
 * way this refuses anything that escapes the replay directory — the stored string comes
 * from a box, and a box is not trusted to name a path.
 */
function localPath(row) {
  if (!row || !row.file) return null
  const base = path.basename(String(row.file))
  if (!base.endsWith('.enwr')) return null
  const p = path.join(REPLAY_DIR, base)
  const rel = path.relative(REPLAY_DIR, p)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return fs.existsSync(p) ? p : null
}

/**
 * The one sentence that decides whether a run is record-grade, and why.
 *
 * Deliberately returns a grade AND a reason: a reviewer looking at a board needs to know
 * not just that something is wrong but which thing, because "unpinned key" and "recovered
 * after a crash" call for completely different decisions.
 */
function grade(row) {
  if (!row) return { grade: 'none', ok: false, reason: 'no replay was recorded for this game' }
  if (!row.key_id) {
    return {
      grade: 'unknown-key',
      ok: false,
      reason: 'the box did not say which key signed this, so it cannot be matched against the pin',
    }
  }
  if (!row.key_pinned) {
    return {
      grade: 'unpinned',
      ok: false,
      reason: `signed by ${row.key_id}, which is not the key pinned for ${row.box || 'this box'} — integrity is not authorship`,
    }
  }
  if (row.recovered || row.partial) {
    return {
      grade: 'recovered',
      ok: false,
      reason: 'recovered after the host died mid-game: the signature only proves nothing changed since recovery. Good enough for a badge, not for a record',
    }
  }
  return { grade: 'signed', ok: true, reason: "signed by the box's pinned key" }
}

/** Q-host-1's rule, as one function. */
function mayDownload(row, viewer) {
  if (!row) return { ok: false, reason: 'there is no replay for that game' }
  if (!viewer) return { ok: false, reason: 'sign in to download a replay' }
  const sid = String(viewer.steam_id)
  const mine = db.prepare(`SELECT 1 FROM game_players gp JOIN games g ON g.id=gp.game_id
                            WHERE g.match_id=? AND gp.steam_id=?`).get(row.match_id, sid)
  if (mine) return { ok: true, why: 'your own game' }
  if (viewer.is_admin || viewer.is_mod) return { ok: true, why: 'moderator' }
  if (viewer.vip_is) return { ok: true, why: 'VIP' }
  // A public game's tracks are public. "Public" means the lobby was public — a friends-only
  // game is not a public game just because it finished.
  const a = db.prepare('SELECT party_id FROM assignments WHERE match_id=?').get(row.match_id)
  if (a && a.party_id) {
    const p = db.prepare('SELECT visibility FROM parties WHERE id=?').get(a.party_id)
    if (p && p.visibility === 'public') return { ok: true, why: 'a public game' }
  } else if (a) {
    return { ok: true, why: 'a public game' }
  }
  return { ok: false, reason: "someone else's full replay needs VIP, or the game to have been public. The signed summary is public either way" }
}

/** Everything about a replay that is public: the pointer, the grade, how to check it. */
function describe(matchId, viewer) {
  const row = rowFor(matchId)
  if (!row) return null
  const g = grade(row)
  const file = localPath(row)
  const may = mayDownload(row, viewer)
  return {
    match_id: row.match_id,
    box: row.box,
    size: row.size,
    chunks: row.chunks,
    events: row.events,
    ratio: row.ratio,
    mb_per_hour: row.mb_per_hour,
    key_id: row.key_id,
    key_pinned: !!row.key_pinned,
    recovered: !!row.recovered,
    partial: !!row.partial,
    tier: row.tier,
    created_at: row.created_at,
    ...g,
    available: !!file,
    can_download: may.ok,
    download_reason: may.ok ? may.why : may.reason,
    // The command anybody can run to check this themselves, with the pinned key in it —
    // a bare `verify` proves only that the file is self-consistent.
    verify_command: `node infra/host-agent/tools/verify.js "${row.file || '<file>'}"`
      + (pinnedPub(row.box) ? ` --pub ${pinnedPub(row.box)}` : '  # no key pinned for this box yet'),
  }
}

const pinnedPub = (boxName) => {
  const b = boxName ? db.prepare('SELECT replay_pub FROM boxes WHERE name=?').get(String(boxName)) : null
  return b ? b.replay_pub : null
}

/**
 * Actually verify the file, against the box's PINNED key.
 *
 * This is the record-review action. It re-reads every chunk, rehashes the chain and checks
 * the footer signature — and passes `expectPub`, so a perfectly valid replay signed by
 * somebody else FAILS here rather than passing.
 */
async function verify(matchId) {
  const row = rowFor(matchId)
  if (!row) return { ok: false, error: 'no replay for that match' }
  const file = localPath(row)
  if (!file) return { ok: false, error: `the file is not on this machine (looked in ${REPLAY_DIR})` }
  const L = await lib()
  if (!L) return { ok: false, error: 'the replay reader is not available on this install' }

  const expectPub = pinnedPub(row.box)
  let r
  try {
    // `verifyFile(file, { expectPub })` — positional path, options second. Passing an
    // object for the path fails with a Node fs type error that reads like a corrupt
    // replay, which is exactly the wrong thing for a verification tool to say.
    r = L.verifyFile(file, { expectPub: expectPub || undefined })
  } catch (e) {
    return { ok: false, error: `verification threw: ${e.message}` }
  }

  // Learn the signing key from the file if the box never told us — but only to REPORT it.
  // Pinning from a file would be circular: the file says whatever its author wants, and
  // the pin's whole job is to be something the file cannot assert.
  const patch = {}
  if (!row.key_id && r.keyId) patch.key_id = r.keyId
  if (r.recovered) patch.recovered = 1
  if (r.partial) patch.partial = 1
  if (Object.keys(patch).length) {
    const pinnedMatches = r.keyId && expectPub && String(r.pub) === String(expectPub)
    db.prepare('UPDATE replays SET key_id=COALESCE(?, key_id), key_pinned=?, recovered=?, partial=? WHERE match_id=?')
      .run(patch.key_id || null, pinnedMatches ? 1 : (row.key_pinned || 0),
        patch.recovered || row.recovered || 0, patch.partial || row.partial || 0, row.match_id)
  }

  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('replay.verify', NULL, ?, ?)")
    .run(JSON.stringify({ match_id: row.match_id, ok: r.ok, errors: r.errors, key: r.keyId }), now())

  return {
    ok: !!r.ok,
    file,
    checked_against_pin: !!expectPub,
    pinned_pub: expectPub || null,
    signed_by: r.pub || null,
    key_id: r.keyId || null,
    recovered: !!r.recovered,
    partial: !!r.partial,
    chunks: r.chunks,
    events: r.events,
    errors: r.errors || [],
    header: r.header || null,
    // The verdict in the words host.md uses, so the site and the tool say the same thing.
    verdict: !r.ok ? 'INVALID'
      : !expectPub ? 'VALID, BUT NO KEY IS PINNED FOR THIS BOX — integrity only, not authorship'
        : r.recovered || r.partial ? 'VALID BUT RECOVERED — good enough for a badge, not record-grade evidence'
          : 'VALID — signed by this box\u2019s pinned key',
  }
}

/** The path and size for a download, once mayDownload has said yes. */
function fileFor(matchId) {
  const row = rowFor(matchId)
  const file = localPath(row)
  if (!file) return null
  return { path: file, name: path.basename(file), size: fs.statSync(file).size, row }
}

module.exports = { REPLAY_DIR, rowFor, localPath, grade, mayDownload, describe, verify, fileFor, pinnedPub }
