'use strict'

// Seed the database from the repo's OWN artefacts. Nothing here is invented map data:
//
//   referee/manifests/*.json      the referee agent's hand-verified manifests — the title,
//                                 the author, the fs_game, the main finish, the round
//                                 target, the finishes and signals, the script hashes.
//   C:\Users\b\ZombiesDev\scripts\scan-results\*.json
//                                 referee/scan_map.py's machine verdict per map (entity
//                                 count, script count, flags found, the finish it deduced).
//                                 Read when present; absent is not an error, because that
//                                 directory is dev-box state and not in the repo.
//
// Release facts for the four stock maps (Treyarch, the WaW map packs) are common knowledge
// and are written out below. Everything else about a map comes from its manifest.
//
//   node server/db/seed.js            top up: insert what is missing, leave the rest
//   node server/db/seed.js --reset    delete the database file first
//   node server/db/seed.js --demo     also create demo players, games, records and comments
//                                     so every page has something on it (dev only)
//
// The demo block is SCAFFOLDING and says so on every row it writes: demo accounts have
// steam ids in the reserved 7656119000000000x range, which is not a real SteamID64 space,
// so they can never collide with a signed-in player.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const args = new Set(process.argv.slice(2))
const REPO = path.resolve(__dirname, '..', '..', '..')

if (args.has('--reset')) {
  const dir = process.env.ZM_DATA_DIR || path.join(__dirname, '..', '..', 'data')
  for (const f of ['zombies.db', 'zombies.db-wal', 'zombies.db-shm']) {
    const p = path.join(dir, f)
    if (fs.existsSync(p)) { fs.rmSync(p); console.log('removed', p) }
  }
}

const { db, now } = require('./database')
const { slugify, shortCode, weekStart } = require('../lib/util')

const MANIFEST_DIR = path.join(REPO, 'referee', 'manifests')
const SCAN_DIR = process.env.ZM_SCAN_DIR || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'scripts', 'scan-results')

// Release facts for the maps that shipped with the game. Treyarch, World at War, 2008-09.
const STOCK = {
  nazi_zombie_prototype: {
    author: 'Treyarch', year: 2008, released: '2008-11-11', order: 1,
    description: 'The map that started it. A bombed-out airfield bunker with no power, no perks and no Pack-a-Punch: boards, a Kar98k and the stairs. Every custom map descends from this one.',
  },
  nazi_zombie_asylum: {
    author: 'Treyarch', year: 2009, released: '2009-03-19', order: 2,
    description: 'Wittenau Sanatorium. Two starting rooms either side of a locked asylum, the first power switch, the first Perk-a-Colas and the first time the map wants you to open it up rather than hold a corner.',
  },
  nazi_zombie_sumpf: {
    author: 'Treyarch', year: 2009, released: '2009-06-11', order: 3,
    description: 'Shi No Numa. Four huts around a swamp, the Wunderwaffe DG-2, hellhounds, and the flogger. The first map with an outdoors.',
  },
  nazi_zombie_factory: {
    author: 'Treyarch', year: 2009, released: '2009-08-06', order: 4,
    description: 'Der Riese. Teleporters, the Pack-a-Punch, the bowie knife, and the Fly Trap — the first Easter egg in zombies, and still the one every custom map is answering.',
  },
}

// The tag vocabulary of 13 §3: finishes, style, size and difficulty. Claude derives further
// traits once the whole catalogue is in; these are the ones the filters need on day one.
const TAGS = [
  ['easter-egg', 'Easter Egg', 'finish', 10],
  ['buyable-ending', 'Buyable Ending', 'finish', 11],
  ['survival-only', 'Survival only', 'finish', 12],
  ['remake', 'Remake', 'style', 20],
  ['original', 'Original', 'style', 21],
  ['box-map', 'Box map', 'style', 22],
  ['meme', 'Meme', 'style', 23],
  ['horror', 'Horror', 'style', 24],
  ['puzzle-heavy', 'Puzzle heavy', 'style', 25],
  ['stock', 'Stock map', 'style', 26],
  ['small', 'Small', 'size', 30],
  ['medium', 'Medium', 'size', 31],
  ['large', 'Large', 'size', 32],
  ['easy', 'Easy', 'difficulty', 40],
  ['normal', 'Normal', 'difficulty', 41],
  ['hard', 'Hard', 'difficulty', 42],
]

// The four Verified challenge presets (13 §4d), mirroring ZWR's challenge categories. They
// are LOCKED: fixed rulesets with their own boards, not free-form knobs.
const CHALLENGES = [
  ['no-power', 'No Power', 'The power stays off for the whole game. Perks and traps are unavailable wherever they need it.', { power: 'never' }],
  ['no-perks', 'No Perks', 'No perk may be bought. The power may still be turned on.', { perks: 'none' }],
  ['no-jug', 'No Jug', 'Every perk except Juggernog is allowed.', { perks: 'no_jug' }],
  ['first-room', 'First Room', 'No door, debris or barrier may be bought. You never leave the spawn room.', { doors: 'none' }],
]

const CHALLENGE_KEYS = CHALLENGES.map(([slug]) => slug.replace(/-/g, '_'))

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function ensureTags() {
  const ins = db.prepare('INSERT OR IGNORE INTO tags (slug, label, kind, sort_order) VALUES (?,?,?,?)')
  for (const [slug, label, kind, sort] of TAGS) ins.run(slug, label, kind, sort)
}

function tagId(slug) {
  const r = db.prepare('SELECT id FROM tags WHERE slug=?').get(slug)
  return r ? r.id : null
}

function tagMap(mapId, slugs) {
  const ins = db.prepare('INSERT OR IGNORE INTO map_tags (map_id, tag_id) VALUES (?,?)')
  for (const s of slugs) { const t = tagId(s); if (t) ins.run(mapId, t) }
}

// ---- maps -------------------------------------------------------------------------
function seedMaps() {
  if (!fs.existsSync(MANIFEST_DIR)) {
    console.error(`no manifests at ${MANIFEST_DIR} — nothing to seed`)
    return []
  }
  const files = fs.readdirSync(MANIFEST_DIR).filter((f) => f.endsWith('.json'))
  const out = []
  for (const f of files) {
    const m = readJson(path.join(MANIFEST_DIR, f))
    if (!m || !m.map) continue
    const scan = readJson(path.join(SCAN_DIR, `${m.map}.json`))
    const stock = STOCK[m.map] || null

    const finishes = m.finishes || []
    const hasEe = finishes.some((x) => x.id === 'easter_egg') ? 1 : 0
    const hasBuyable = finishes.some((x) => x.id === 'buyable_ending') ? 1 : 0
    const mainFinish = (m.badge && m.badge.main_finish) || 'round'
    const roundN = (m.badge && m.badge.round_n) || 20

    // The author string on a custom map is the manifest's free-text `author` line, which is
    // "nikfar1, 2012; ships the ZCT MOD2_MW mod alongside" on the one map we have. Split on
    // the first comma: the name is what a creator page is keyed on, and the rest is a note.
    let author = stock ? stock.author : null
    let year = stock ? stock.year : null
    if (!author && m.author) {
      const mm = String(m.author).match(/^([^,;]+)(?:,\s*(\d{4}))?/)
      if (mm) { author = mm[1].trim(); year = mm[2] ? Number(mm[2]) : null }
    }

    const description = stock ? stock.description : null
    const released = stock && stock.released ? Date.parse(stock.released) : null

    db.prepare(`INSERT INTO maps (key, slug, title, author, year, source, health, hidden, main_finish, round_n,
                                  has_ee, has_buyable, description, released_at, added_at)
                VALUES (@key,@slug,@title,@author,@year,@source,@health,0,@main_finish,@round_n,
                        @has_ee,@has_buyable,@description,@released_at,@added_at)
                ON CONFLICT(key) DO UPDATE SET
                  title=excluded.title, author=excluded.author, year=excluded.year,
                  source=excluded.source, main_finish=excluded.main_finish, round_n=excluded.round_n,
                  has_ee=excluded.has_ee, has_buyable=excluded.has_buyable,
                  description=COALESCE(maps.description, excluded.description)`)
      .run({
        key: m.map,
        slug: slugify(m.title || m.map),
        title: m.title || m.map,
        author, year,
        source: m.source || 'custom',
        // Every map we have a manifest for has been read end to end; `verified` is the
        // manifest's own confidence promoted, and anything else stays `playable` until a
        // boot test says otherwise (99 §4.8).
        health: m.confidence === 'read' ? 'verified' : 'playable',
        main_finish: mainFinish,
        round_n: roundN,
        has_ee: hasEe,
        has_buyable: hasBuyable,
        description,
        released_at: released,
        added_at: now(),
      })

    const map = db.prepare('SELECT * FROM maps WHERE key=?').get(m.map)

    // One version per map for now. A real archive import writes one per release; the column
    // exists so boards freeze per version (99 §4.7) from the first game played.
    db.prepare(`INSERT OR IGNORE INTO map_versions (map_id, version, latest, health, fs_game, notes, added_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(map.id, '1.0', 1, map.health, m.fs_game || null, m.notes || null, now())
    const ver = db.prepare('SELECT * FROM map_versions WHERE map_id=? AND latest=1').get(map.id)

    // The script fingerprints ARE the archive's file record for a stock map: we do not ship
    // the game's files, so the hash of the script that ran is what we can honestly record.
    const fp = m.script_fingerprints || {}
    const insFile = db.prepare('INSERT OR IGNORE INTO map_files (map_version_id, path, sha256, kind, fetched_at) VALUES (?,?,?,?,?)')
    for (const [p, h] of Object.entries(fp)) insFile.run(ver.id, p, h, 'script', now())

    db.prepare(`INSERT INTO manifests (map_version_id, map_key, schema, confidence, json, imported_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(map_version_id) DO UPDATE SET json=excluded.json, confidence=excluded.confidence, imported_at=excluded.imported_at`)
      .run(ver.id, m.map, m.schema || 'enw.referee.manifest/0', m.confidence || null, JSON.stringify(m), now())

    const tags = []
    if (hasEe) tags.push('easter-egg')
    if (hasBuyable) tags.push('buyable-ending')
    if (!hasEe && !hasBuyable) tags.push('survival-only')
    if (m.source === 'stock') tags.push('stock', 'original')
    else tags.push('original')
    // Size from the scanner's entity count when we have it: a 1,000-entity map and a
    // 5,000-entity one are not the same size of thing, and this is the only size signal that
    // exists before anyone has played.
    if (scan && Number.isFinite(scan.entities)) {
      tags.push(scan.entities < 1500 ? 'small' : scan.entities < 3500 ? 'medium' : 'large')
    }
    tagMap(map.id, tags)

    if (scan) {
      db.prepare(`UPDATE maps SET readme = COALESCE(readme, ?) WHERE id=?`)
        .run(scan.verdict ? `Scanner verdict: ${scan.verdict.finish} — ${scan.verdict.why}` : null, map.id)
    }

    out.push({ map, ver, manifest: m })
    console.log(`map  ${m.map.padEnd(24)} ${(m.title || '').padEnd(24)} ${mainFinish}${hasEe ? ' +EE' : ''}${hasBuyable ? ' +BE' : ''}`)
  }
  return out
}

// ---- boards ----------------------------------------------------------------------
// 99 §4.7: split solo/2p/3p/4p, per map version, plus the challenge brackets. The profile is
// the NAMED RULE PROFILE a run is checked against (11 §7); ENW-Verified is ours and the ZWR
// board exists so a run can be posted under their rules without renaming ours.
function seedBoards(entries) {
  const ins = db.prepare(`INSERT OR IGNORE INTO boards (map_key, map_version_id, category, label, player_count, profile, sort, created_at)
                          VALUES (?,?,?,?,?,?,?,?)`)
  let n = 0
  for (const { map, ver, manifest } of entries) {
    const cats = [['round', `Round`, 'round_desc']]
    if (map.has_ee) cats.push(['ee_speedrun', 'Easter Egg', 'time_asc'])
    if (map.has_buyable) cats.push(['buyable_speedrun', 'Buyable Ending', 'time_asc'])
    for (const [i, key] of CHALLENGE_KEYS.entries()) cats.push([key, CHALLENGES[i][1], 'round_desc'])
    for (const [cat, label, sort] of cats) {
      for (let pc = 1; pc <= 4; pc++) {
        ins.run(map.key, ver.id, cat, label, pc, 'ENW-Verified', sort, now()); n++
      }
    }
    // One ZWR-profile board per map for the headline category, so the difference between
    // "our rules" and "their rules" is visible in the data from day one rather than being
    // retrofitted when somebody asks.
    const headline = map.has_ee ? 'ee_speedrun' : map.has_buyable ? 'buyable_speedrun' : 'round'
    const sort = headline === 'round' ? 'round_desc' : 'time_asc'
    for (let pc = 1; pc <= 4; pc++) { ins.run(map.key, ver.id, headline, 'ZWR', pc, 'ZWR-WaW-2025-09', sort, now()); n++ }
    void manifest
  }
  console.log(`boards ${n}`)
}

// ---- badges ----------------------------------------------------------------------
function seedBadges(entries) {
  const ins = db.prepare(`INSERT OR IGNORE INTO badges (slug, name, description, obtain, kind, rule, family, map_key, sort_order, created_at, created_by)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  // One badge per map (05). Earned by the map's main finish: Easter Egg > Buyable Ending >
  // Round N. Other finishes are ticks on the same badge, which is why there is exactly one
  // row here per map and no badge per finish.
  for (const { map } of entries) {
    const label = map.main_finish === 'easter_egg' ? 'the Easter Egg'
      : map.main_finish === 'buyable_ending' ? 'the Buyable Ending'
        : `round ${map.round_n}`
    ins.run(`map-${map.key}`, map.title, `Beat ${map.title}.`, `Finish ${map.title} by reaching ${label} in a Verified game.`,
      'map', `map-${map.key}`, 'map', map.key, 100, now(), 'seed')
    // The held record badge. Movement's kind:'record' — gold while you hold the record on
    // that map, back to glass when you lose it.
    ins.run(`record-${map.key}`, `${map.title} record`, `Hold a record on ${map.title}.`,
      'Held by whoever holds the highest round or a speedrun world record on this map.',
      'record', `m:${map.key}`, 'record', map.key, 200, now(), 'seed')
  }

  // Career achievements (05). Round milestones are career-wide on any Verified game; per-map
  // rounds live on the boards and as ticks on the map badge.
  for (const r of [30, 50, 75, 100]) {
    ins.run(`round-${r}`, `Round ${r}`, `Reach round ${r} in a Verified game.`, `Reach round ${r} on any map in a Verified game.`,
      'achievement', `round-${r}`, 'rounds', null, 300 + r, now(), 'seed')
  }
  for (const n of [10, 25, 50, 100]) {
    ins.run(`maps-${n}`, `${n} maps`, `Beat ${n} maps.`, `Earn the map badge on ${n} different maps.`,
      'achievement', `maps-${n}`, 'maps', null, 400 + n, now(), 'seed')
  }
  ins.run('maps-all', 'Every map', 'Beat every playable map in the archive.', 'Earn the map badge on every map currently playable on ENW.',
    'achievement', 'maps-all', 'maps', null, 599, now(), 'seed')

  // Staff and archive badges: hand-awarded, never swept (05).
  ins.run('archivist', 'Archivist', 'Rescues maps into the archive.', 'Awarded by staff.', 'staff', null, 'staff', null, 700, now(), 'seed')
  ins.run('map-maker', 'Map Maker', 'Made a map in the archive.', 'Awarded by staff once a creator claim is verified.', 'staff', null, 'staff', null, 701, now(), 'seed')
  ins.run('content-creator', 'Content Creator', 'Makes videos about custom zombies.', 'Awarded by staff.', 'staff', null, 'staff', null, 702, now(), 'seed')
  console.log(`badges ${db.prepare('SELECT COUNT(*) c FROM badges').get().c}`)
}

// ---- playlists ---------------------------------------------------------------------
function seedPlaylists(entries) {
  const stock = entries.filter((e) => e.map.source === 'stock').sort((a, b) => (STOCK[a.map.key]?.order || 9) - (STOCK[b.map.key]?.order || 9))
  if (stock.length) {
    const badge = db.prepare('SELECT id FROM badges WHERE slug=?').get('playlist-treyarch-four')
      || (db.prepare(`INSERT OR IGNORE INTO badges (slug, name, description, obtain, kind, family, sort_order, created_at, created_by)
                      VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('playlist-treyarch-four', 'Treyarch four', 'Beat all four maps that shipped with World at War.',
          'Earn the map badge on Nacht der Untoten, Verruckt, Shi No Numa and Der Riese.', 'achievement', 'collection', 800, now(), 'seed'),
      db.prepare('SELECT id FROM badges WHERE slug=?').get('playlist-treyarch-four'))
    db.prepare(`INSERT OR IGNORE INTO playlists (slug, name, blurb, kind, state, sort_order, reward_badge, created_at, created_by)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('treyarch-four', 'Treyarch four', 'The four maps that shipped with the game, in release order.',
        'curated', 'live', 1, badge.id, now(), 'seed')
    const pl = db.prepare('SELECT id FROM playlists WHERE slug=?').get('treyarch-four')
    // The rule key is playlist-<id>, never the slug: Movement's own comment says a rename
    // must never orphan a badge people already hold.
    db.prepare('UPDATE badges SET rule=? WHERE id=?').run(`playlist-${pl.id}`, badge.id)
    const insm = db.prepare('INSERT OR IGNORE INTO playlist_maps (playlist_id, map_key, position, added_at) VALUES (?,?,?,?)')
    stock.forEach((e, i) => insm.run(pl.id, e.map.key, i, now()))
  }

  // One automatic playlist per creator (13 §3). It has NO member rows: `kind='creator'`
  // resolves its maps at read time from maps.author, so a newly imported map by that author
  // joins the list without anybody editing it.
  const authors = db.prepare("SELECT DISTINCT author FROM maps WHERE author IS NOT NULL AND author <> ''").all()
  for (const { author } of authors) {
    db.prepare(`INSERT OR IGNORE INTO playlists (slug, name, blurb, kind, creator, state, sort_order, created_at, created_by)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`by-${slugify(author)}`, `Maps by ${author}`, null, 'creator', author, 'live', 50, now(), 'seed')
    db.prepare('INSERT OR IGNORE INTO creators (slug, name, created_at) VALUES (?,?,?)').run(slugify(author), author, now())
  }
  console.log(`playlists ${db.prepare('SELECT COUNT(*) c FROM playlists').get().c}`)
}

function seedPresets() {
  const ins = db.prepare(`INSERT OR IGNORE INTO presets (code, owner, name, blurb, knobs_json, locked, featured, created_at)
                          VALUES (?,?,?,?,?,?,?,?)`)
  for (const [slug, name, blurb, knobs] of CHALLENGES) {
    ins.run(slug.toUpperCase().replace(/-/g, ''), null, name, blurb, JSON.stringify(knobs), 1, 1, now())
  }
  // Two ordinary Custom presets, so the share-code path has something real in it.
  ins.run(shortCode(6), null, 'Sprinters', 'Everything runs from round 1. Stock everything else.',
    JSON.stringify({ zombies: { speed: 'sprint' } }), 0, 1, now())
  ins.run(shortCode(6), null, 'Round 30 start', 'Start at round 30 with 10,000 points and the power on.',
    JSON.stringify({ start: { round: 30, points: 10000 }, perks: { power_on: true } }), 0, 0, now())
}

// A development game box, so `node infra/host-agent/host.js --site http://127.0.0.1:3200
// --secret devkey-a --box box-a` finds a lease waiting for it without anyone editing rows by
// hand. The secret is the host agent's own default dev key and is worth nothing anywhere else.
function seedBox() {
  db.prepare(`INSERT OR IGNORE INTO boxes (name, match_key, region, note, enabled, max_instances, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run('box-a', process.env.ZM_DEV_BOX_KEY || 'devkey-a', 'dev', "B's PC — the host agent's default dev box", 1, 4, now())
  db.prepare(`INSERT OR IGNORE INTO boxes (name, match_key, region, note, enabled, max_instances, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run('box-b', 'devkey-b', 'dev', 'second dev box, for the two-box demo', 1, 4, now())
}

function seedWeek(entries) {
  if (!entries.length) return
  const pick = entries.find((e) => e.map.key === 'nazi_zombie_factory') || entries[0]
  db.prepare(`INSERT OR IGNORE INTO map_of_week (week_start, map_key, note, set_at, set_by) VALUES (?,?,?,?,?)`)
    .run(weekStart(), pick.map.key, 'The Fly Trap still counts. Solo is allowed.', now(), 'seed')
}

// ---- demo content (dev only) --------------------------------------------------------
function seedDemo(entries) {
  const results = require('../lib/results')
  const users = require('../lib/users')
  const people = [
    ['76561190000000001', 'dexter', 'Dexter'],
    ['76561190000000002', 'air', 'Air'],
    ['76561190000000003', 'jamie', 'Jamie'],
    ['76561190000000004', 'stew', 'Stew'],
  ]
  for (const [sid, name, enw] of people) {
    users.ensure(sid, { username: name, enw_name: enw })
    db.prepare('UPDATE users SET approved=1 WHERE steam_id=?').run(sid)
  }
  db.prepare('UPDATE users SET is_admin=1, is_mod=1, vip_is=1 WHERE steam_id=?').run('76561190000000001')
  db.prepare('UPDATE users SET vip_is=1 WHERE steam_id=?').run('76561190000000003')

  // Friendships, so the home page's "friends online" rail has a roster to draw.
  const fr = db.prepare(`INSERT OR IGNORE INTO friendships (requester_steam_id, addressee_steam_id, status, created_at, updated_at)
                         VALUES (?,?, 'accepted', ?, ?)`)
  fr.run(people[0][0], people[1][0], now(), now())
  fr.run(people[0][0], people[2][0], now(), now())
  fr.run(people[1][0], people[3][0], now(), now())

  // Games, written through the REAL ingest path (lib/results.ingest) rather than by
  // inserting rows: the demo data then exercises exactly the code a game box drives, and a
  // bug in badge awarding or XP shows up in the seed rather than in production.
  let t = Date.now() - 12 * 3600_000
  const mk = (map, mode, rounds, finish, players, mins, extra = {}) => {
    t += 40 * 60_000
    const dur = mins * 60_000
    return {
      box: 'box-a', instance: 'inst-01',
      summary: {
        match_id: 'm_' + crypto.randomBytes(4).toString('hex'),
        instance: 'inst-01', mode, map, map_name: null, fs_game: null,
        manifest: map, manifest_confidence: 'read',
        badge: finish ? { kind: finish, map } : null,
        signals: ['box_used'],
        players: players.map(([sid, name], i) => ({
          slot: i, steamid: sid, name,
          score: 10000 + i * 1500, kills: 300 + i * 40, downs: i, revives: 1, bleedouts: 0,
          rounds_played: rounds, joined_round: 1, late: false, reconnects: 0,
          afk_kicked: false, connected_at_end: true,
          stats: {
            kills: 300 + i * 40, deaths: 0, headshots: 120 + i * 20, downs: i, revives: 1,
            points_earned: 40000, points_spent: 30000, highest_points: 10000 + i * 1500,
            time_alive_ms: dur, rounds_played: rounds,
          },
        })),
        player_count: players.length, solo: players.length === 1,
        rounds, finish: finish ? { kind: finish, label: finish === 'easter_egg' ? 'Fly Trap' : finish === 'buyable_ending' ? 'Buyable Ending' : `Round ${rounds}` } : null,
        duration_ms: dur, duration_rta_ms: dur + 30_000, paused_ms: 0, pauses: 0,
        started_at: new Date(t - dur).toISOString(), ended_at: new Date(t).toISOString(),
        end_reason: finish ? 'finish' : 'game_over',
        flags: [], records_eligible: mode === 'verified', xp_multiplier: mode === 'verified' ? 1 : 0.25,
        zombies_alive_max: 24, chat_lines: 12, events: 4000, hashes: {}, dvars: {},
        vip_uncapped: false, fingerprint: crypto.randomBytes(6).toString('hex'),
        ...extra,
      },
      replay: { file: 'demo.enwr', size: 5_800_000, chunks: 30, events: 4000, ratio: 11.8, mb_per_hour: 5.98 },
    }
  }
  const P = people.map(([sid, n]) => [sid, n])
  const games = [
    mk('nazi_zombie_factory', 'verified', 34, 'easter_egg', [P[0], P[1]], 95),
    mk('nazi_zombie_prototype', 'verified', 41, 'round', [P[0]], 120),
    mk('nazi_zombie_asylum', 'verified', 22, 'round', [P[1], P[2], P[3]], 70),
    mk('nazi_zombie_ali', 'verified', 14, 'buyable_ending', [P[2], P[3]], 38),
    mk('nazi_zombie_sumpf', 'custom', 18, null, [P[0], P[3]], 45),
    mk('nazi_zombie_factory', 'verified', 26, 'round', [P[2]], 80),
  ]
  for (const g of games) {
    try { results.ingest(g) } catch (e) { console.error('demo game failed:', e.message) }
  }

  // A comment on each map and one on a profile, so the moderation surfaces are not empty.
  const c = db.prepare('INSERT INTO comments (kind, subject, steam_id, body, created_at) VALUES (?,?,?,?,?)')
  for (const { map } of entries.slice(0, 3)) {
    c.run('map', map.key, people[1][0], `Ran this solo last night. ${map.main_finish === 'round' ? 'Train in the back room, it holds to 30 easily.' : 'The ending is cheaper than it looks.'}`, now())
  }
  c.run('profile', people[0][0], people[2][0], 'gg on the Fly Trap run', now())

  // A rating and a favourite each, so the thumbs and the star have real counts.
  const r = db.prepare('INSERT OR IGNORE INTO ratings (map_key, steam_id, thumbs, created_at) VALUES (?,?,?,?)')
  const f = db.prepare('INSERT OR IGNORE INTO favourites (map_key, steam_id, created_at) VALUES (?,?,?)')
  for (const { map } of entries) {
    r.run(map.key, people[0][0], 1, now())
    r.run(map.key, people[1][0], map.key === 'nazi_zombie_ali' ? -1 : 1, now())
  }
  f.run('nazi_zombie_factory', people[0][0], now())
  f.run('nazi_zombie_prototype', people[1][0], now())
  require('../lib/maps').recountRatings()

  db.prepare("INSERT OR IGNORE INTO reports (kind, subject, reporter, reported, reason, detail, status, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run('comment', String(1), people[3][0], people[1][0], 'spam', 'Demo report so the queue is not empty.', 'new', now())

  console.log(`demo   ${people.length} players, ${games.length} games`)
}

// ---- run -----------------------------------------------------------------------------
ensureTags()
const entries = seedMaps()
seedBoards(entries)
seedBadges(entries)
seedPlaylists(entries)
seedPresets()
seedBox()
seedWeek(entries)
if (args.has('--demo') || process.env.ZM_SEED_DEMO === '1') seedDemo(entries)

console.log('seeded.')
