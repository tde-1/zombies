'use strict'

// The rule pass — the badges nobody hands out. Ported from Movement's
// `server/lib/achievements.js`, including the two invariants written at the top of it:
//
//   1. THE SWEEP NEVER REVOKES. Earned is earned. A map leaves rotation, a playlist is
//      edited, the pool grows — none of it takes a badge off somebody who did the work.
//      There is no code path in this file that deletes a badge_awards row.
//   2. IT NEVER THROWS INTO A REQUEST. Every rule is swept inside its own try/catch and the
//      sweep is fire-and-forget. A broken rule costs that rule's awards for one run.
//
// Three families (05 "Achievement badges"):
//
//   rounds       career round milestones 30 / 50 / 75 / 100, any map, Verified games only
//   maps         maps beaten 10 / 25 / 50 / 100 / all
//   collection   playlist completion, bound to a badge the owner DREW — Movement's bind
//                rather than mint, and keyed on `playlist-<id>` rather than the slug so a
//                rename can never orphan a badge people already hold
//
// The MAP badge is not here: it is minted by the game result itself (lib/results.js), the
// moment the referee says the map was finished, because a player should see it on the
// post-match screen and not on the next sweep.

const { db, now } = require('../db/database')
const badges = require('./badges')
const feed = require('./feed')

const SWEEP_MS = Number(process.env.ZM_ACHIEVEMENT_SWEEP_MS || 5 * 60_000)

const ROUND_MILESTONES = [30, 50, 75, 100]
const MAP_MILESTONES = [10, 25, 50, 100]

// ---- the facts each rule reads --------------------------------------------------------
function context() {
  // Highest round reached per player in a Verified, records-eligible game. Custom games are
  // excluded: 05 says round milestones are earned in Verified games, and a Custom lobby can
  // start at round 100.
  const bestRound = new Map()
  for (const r of db.prepare(`SELECT gp.steam_id, MAX(g.rounds) AS best
                                FROM game_players gp JOIN games g ON g.id=gp.game_id
                               WHERE g.mode='verified' AND gp.late=0
                               GROUP BY gp.steam_id`).all()) bestRound.set(r.steam_id, r.best || 0)

  // Maps beaten = map badges held. One badge per map, so the count is the holding count.
  const mapsBeaten = new Map()
  for (const r of db.prepare(`SELECT a.steam_id, COUNT(*) AS n FROM badge_awards a JOIN badges b ON b.id=a.badge_id
                               WHERE b.kind='map' GROUP BY a.steam_id`).all()) mapsBeaten.set(r.steam_id, r.n)

  const playableMaps = db.prepare(`SELECT key FROM maps WHERE hidden=0 AND health IN ('verified','playable','custom-only')`).all().map((r) => r.key)

  return { bestRound, mapsBeaten, playableMaps }
}

// ---- rules -----------------------------------------------------------------------------
// A rule is: the badge's rule key, a target (the denominator, 0 = cannot be judged now), a
// per-player current value, and the set of players who have cleared it.
function rules(ctx) {
  const out = []

  for (const r of ROUND_MILESTONES) {
    out.push({
      rule: `round-${r}`,
      target: () => r,
      current: (sid) => ctx.bestRound.get(String(sid)) || 0,
      eligible: () => [...ctx.bestRound.entries()].filter(([, v]) => v >= r).map(([k]) => k),
    })
  }

  for (const n of MAP_MILESTONES) {
    out.push({
      rule: `maps-${n}`,
      target: () => n,
      current: (sid) => ctx.mapsBeaten.get(String(sid)) || 0,
      eligible: () => [...ctx.mapsBeaten.entries()].filter(([, v]) => v >= n).map(([k]) => k),
    })
  }

  // "all" moves with the archive. It is earned the day you hold every playable map's badge,
  // and it is never taken back when the next map is imported — that is invariant 1, and it
  // is the only sane reading of "beat every map" on an archive that grows every week.
  out.push({
    rule: 'maps-all',
    target: () => ctx.playableMaps.length,
    current: (sid) => ctx.mapsBeaten.get(String(sid)) || 0,
    eligible: () => (ctx.playableMaps.length
      ? [...ctx.mapsBeaten.entries()].filter(([, v]) => v >= ctx.playableMaps.length).map(([k]) => k)
      : []),
  })

  // Playlist completion. A `curated` playlist has member rows; a `creator` playlist resolves
  // its maps from maps.author at read time (see the schema note), and both complete the same
  // way: hold the map badge for every map in the list.
  for (const pl of db.prepare("SELECT * FROM playlists WHERE reward_badge > 0 AND state != 'hidden'").all()) {
    const maps = playlistMaps(pl)
    if (!maps.length) continue
    const need = new Set(maps)
    const held = new Map()
    for (const r of db.prepare(`SELECT a.steam_id, b.map_key FROM badge_awards a JOIN badges b ON b.id=a.badge_id
                                 WHERE b.kind='map' AND b.map_key IS NOT NULL`).all()) {
      if (!need.has(r.map_key)) continue
      held.set(r.steam_id, (held.get(r.steam_id) || 0) + 1)
    }
    out.push({
      rule: `playlist-${pl.id}`,
      badgeId: pl.reward_badge,
      target: () => need.size,
      current: (sid) => held.get(String(sid)) || 0,
      eligible: () => [...held.entries()].filter(([, v]) => v >= need.size).map(([k]) => k),
    })
  }

  return out
}

function playlistMaps(pl) {
  if (pl.kind === 'creator' && pl.creator) {
    return db.prepare('SELECT key FROM maps WHERE author=? AND hidden=0').all(pl.creator).map((r) => r.key)
  }
  return db.prepare('SELECT map_key FROM playlist_maps WHERE playlist_id=? ORDER BY position').all(pl.id).map((r) => r.map_key)
}

// Stamp kind+rule onto the badge the owner drew (bind), never mint a second artless row.
// Movement's note: this is why reviving the playlist family did not duplicate a badge that
// already existed.
function bind() {
  for (const pl of db.prepare('SELECT * FROM playlists WHERE reward_badge > 0').all()) {
    const b = db.prepare('SELECT * FROM badges WHERE id=?').get(pl.reward_badge)
    if (!b) continue
    const rule = `playlist-${pl.id}`
    if (b.kind !== 'achievement' || b.rule !== rule) {
      db.prepare("UPDATE badges SET kind='achievement', rule=?, family='collection' WHERE id=?").run(rule, b.id)
    }
  }
}

// ---- the sweep ---------------------------------------------------------------------
let last = { at: null, awarded: 0, errors: 0 }

function sweep() {
  bind()
  const ctx = context()
  let awarded = 0
  let errors = 0
  for (const r of rules(ctx)) {
    try {
      const badge = r.badgeId ? db.prepare('SELECT * FROM badges WHERE id=?').get(r.badgeId) : badges.byRule(r.rule)
      if (!badge) continue
      if (!r.target()) continue
      for (const sid of r.eligible()) {
        if (badges.award(badge.id, sid, 'achievements')) {
          awarded++
          feed.push({ kind: 'badge', steam_id: sid, badge_id: badge.id, text: badge.name })
        }
      }
    } catch (e) {
      errors++
      // One bad rule costs that rule's awards for one run and nothing else.
      console.error(`[achievements] rule ${r.rule}: ${e.message}`)
    }
  }
  last = { at: now(), awarded, errors }
  return last
}

// Per-player progress for the badges directory: `progress[slug] = { current, target }`.
function progressFor(steamId) {
  const ctx = context()
  const out = {}
  for (const r of rules(ctx)) {
    try {
      const badge = r.badgeId ? db.prepare('SELECT * FROM badges WHERE id=?').get(r.badgeId) : badges.byRule(r.rule)
      if (!badge) continue
      const target = r.target()
      if (!target) continue
      out[badge.slug] = { current: Math.min(r.current(steamId), target), target }
    } catch { /* a cold rule renders without progress rather than failing the page */ }
  }
  return out
}

let timer = null
function startJobs() {
  if (timer) return
  sweep()
  timer = setInterval(() => { try { sweep() } catch (e) { console.error('[achievements] sweep:', e.message) } }, SWEEP_MS)
  timer.unref?.()
}

const lastSweep = () => last

module.exports = { SWEEP_MS, ROUND_MILESTONES, MAP_MILESTONES, sweep, progressFor, bind, startJobs, lastSweep, playlistMaps }
