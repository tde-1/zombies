'use strict'
// Catalogue twins (lib/catalogueTwins.js). B, 2026-09-23: "Cheese Cube Unlimited: not playable"
// sat beside the real one; and then B's rule: MAPS IN A SERIES ARE DISTINCT MAPS. Only an exact
// normalised title hides a stub; every looser match is a review row, never hidden.
//
//   node test/catalogue-twins.js

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-twins-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')
process.env.ZM_STEAM_AVATARS = 'off'

const { db, now } = require('../server/db/database')
const twins = require('../server/lib/catalogueTwins')
const maps = require('../server/lib/maps')

let pass = 0; let fail = 0
function check (name, fn) {
  try { fn(); pass++; console.log('ok    ' + name) } catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + e.message) }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const add = (key, o) => db.prepare(`INSERT INTO maps (key, slug, title, author, year, source, health, hidden, release_post, main_finish, round_n, added_at)
  VALUES (@key,@slug,@title,@author,@year,@source,@health,@hidden,@release_post,'round',20,@added_at)`).run({
  key, slug: o.slug || key.replace(':', '-'), title: o.title, author: o.author || null, year: o.year || null,
  source: o.source || 'custom', health: o.health || 'playable', hidden: o.hidden ? 1 : 0,
  release_post: o.release_post || null, added_at: now(),
})
const cat = (key, o) => add(key, { ...o, source: 'catalogue', health: 'catalogued' })
const mid = (k) => db.prepare('SELECT id FROM maps WHERE key=?').get(k).id

// real, visible maps
add('nazi_zombie_ccube', { title: 'Cheese Cube', author: 'ZK Studios', year: 2013, release_post: 'https://callofdutyrepo.com/2013/04/18/cheese-cube/' })
add('nazi_zombie_ccube_u', { title: 'Cheese Cube Unlimited', author: 'ZK Studios', year: 2014, health: 'custom-only' })
add('ahkanto', { title: 'POKEMON KANTO CARNAGE - NIGHTTIME', author: 'someone', year: 2016 })
add('nacht_reimagined', { title: 'Nacht der Untoten', author: 'A' })
add('bunker', { title: 'Bunker', author: 'Alpha', year: 2012 })
add('town_a', { title: 'Town', author: 'A' })
add('town_b', { title: 'Town', author: 'B' })
add('nazi_zombie_hiddenreal', { title: 'Hidden Real', hidden: true })
db.prepare(`INSERT INTO map_versions (map_id, version, latest, health, fs_game, size_bytes, added_at) VALUES (?,?,1,'playable','mods/x',?,?)`)
  .run(mid('ahkanto'), 'v1', 273000000, now())

// catalogue stubs
cat('cat:cheesecube', { title: 'CHEESE CUBE', author: 'ZK Studios', year: 2013 })                                  // exact
cat('cat:cheesecubeunlimited', { title: 'Cheese Cube Unlimited', author: 'ZK Studios', year: 2014 })               // exact
cat('cat:cheesecubeunlimitedcubeofcircles', { title: 'Cheese Cube Unlimited: Cube of Circles', author: 'ZK Studios' }) // a third map
cat('cat:pokemonkantocarnage', { title: 'Pokemon Kanto Carnage' })                                                  // the day edition
db.prepare(`INSERT INTO archive_sources (url, site, kind, map_key, status, created_at, size_bytes) VALUES (?,?,?,?,?,?,?)`)
  .run('https://example.invalid/pkc.exe', 'mediafire.com', 'download', 'cat:pokemonkantocarnage', 'alive', now(), 273000000)
cat('cat:ccubepost', { title: 'Cheese Cube Remastered', release_post: 'https://callofdutyrepo.com/2013/04/18/cheese-cube/' }) // post only
cat('cat:nachtreimagined', { title: 'Nacht der Untoten Reimagined', author: 'A' })                                 // edition word
cat('cat:nacht2', { title: 'Nacht der Untoten 2', author: 'A' })                                                   // sequel number
cat('cat:bunker', { title: 'BUNKER', author: 'Somebody Else', year: 2016 })                                        // collision
cat('cat:town', { title: 'Town' })                                                                                 // two reals
cat('cat:hiddenreal', { title: 'Hidden Real' })                                                                    // real is hidden

const p = twins.plan(db, { normOf: { nazi_zombie_ccube_u: 'cheesecubeunlimitedcubeofcircles' } })
const hid = Object.fromEntries(p.hide.map((h) => [h.cat, h]))
const rev = Object.fromEntries(p.review.map((a) => [a.cat, a]))

check('an exact normalised title (case and punctuation aside) hides the stub', () => {
  eq(hid['cat:cheesecube'] && hid['cat:cheesecube'].real, 'nazi_zombie_ccube', 'Cheese Cube')
  eq(hid['cat:cheesecubeunlimited'] && hid['cat:cheesecubeunlimited'].real, 'nazi_zombie_ccube_u', 'Cheese Cube Unlimited')
})
check('Cheese Cube, Cheese Cube Unlimited and Cube of Circles are three maps', () => {
  eq(hid['cat:cheesecubeunlimitedcubeofcircles'], undefined, 'Cube of Circles is not hidden')
  eq(!!rev['cat:cheesecubeunlimitedcubeofcircles'], true, 'it is a review row (subtitle + fetched-from signal)')
})
check('Pokemon Kanto Carnage and its Nighttime edition are two maps, even with the same bytes on a link', () => {
  eq(hid['cat:pokemonkantocarnage'], undefined, 'not hidden'); eq(!!rev['cat:pokemonkantocarnage'], true, 'review')
})
check('a release post match alone is review, not a hide', () => {
  eq(hid['cat:ccubepost'], undefined, 'not hidden'); eq(/same release post/.test(rev['cat:ccubepost'].why), true, 'names the signal')
})
check('edition words (Reimagined, 2) are review, not a hide', () => {
  eq(hid['cat:nachtreimagined'], undefined, 'Reimagined'); eq(hid['cat:nacht2'], undefined, '2')
  eq(!!rev['cat:nachtreimagined'] && !!rev['cat:nacht2'], true, 'both listed')
})
check('an exact title with another author and year is review, not a hide', () => {
  eq(hid['cat:bunker'], undefined, 'not hidden'); eq(!!rev['cat:bunker'], true, 'listed')
})
check('a title two real maps share is review', () => {
  eq(hid['cat:town'], undefined, 'not hidden'); eq(rev['cat:town'].reals.length, 2, 'both named')
})
check('a real map nobody can see supersedes nothing', () => {
  eq(hid['cat:hiddenreal'], undefined, 'not hidden')
})
check('apply hides only the exact twins, links them, and is idempotent', () => {
  eq(twins.apply(db, p), 2, 'two rows changed')
  const r = db.prepare("SELECT hidden, superseded_by FROM maps WHERE key='cat:cheesecubeunlimited'").get()
  eq(r.hidden, 1, 'hidden'); eq(r.superseded_by, 'nazi_zombie_ccube_u', 'linked')
  eq(db.prepare("SELECT hidden FROM maps WHERE key='cat:cheesecubeunlimitedcubeofcircles'").get().hidden, 0, 'Cube of Circles stays visible')
  eq(db.prepare("SELECT hidden FROM maps WHERE key='cat:pokemonkantocarnage'").get().hidden, 0, 'Kanto Carnage stays visible')
  eq(twins.apply(db, p), 2, 'a re-run changes the same two rows to the same values')
})
check("the stub's old slug shows the real map; the real map lists it under Earlier versions", () => {
  const d = maps.detail('cat-cheesecubeunlimited')
  eq(d.key, 'nazi_zombie_ccube_u', 'the real map')
  eq(d.redirected_from && d.redirected_from.key, 'cat:cheesecubeunlimited', 'redirected_from')
  const real = maps.detail('nazi_zombie_ccube_u')
  eq(real.redirected_from, null, 'a real map is not redirected')
  eq(real.earlier_versions.map((v) => v.key).join(','), 'cat:cheesecubeunlimited', 'earlier versions')
})

console.log(`\ncatalogue-twins: ${pass} passed, ${fail} failed`)
try { db.close() } catch { /* */ }
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
