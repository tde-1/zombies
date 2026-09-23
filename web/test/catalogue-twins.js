'use strict'
// Catalogue twins (lib/catalogueTwins.js, B 2026-09-23: "Cheese Cube Unlimited: not playable"
// beside the real one). A visible real map hides the catalogue stub of the same map and links
// it; the stub's old slug shows the real map; a mere name collision is reported, not hidden.
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

// real maps
add('nazi_zombie_ccube_u', { title: 'Cheese Cube Unlimited', author: 'ZK Studios', year: 2014, health: 'custom-only' })
add('nazi_zombie_ccube', { title: 'Cheese Cube', author: 'ZK Studios', year: 2013, release_post: 'https://callofdutyrepo.com/2013/04/18/cheese-cube/' })
add('bunker', { title: 'Bunker', author: 'Alpha', year: 2012 })
add('nazi_zombie_hiddenreal', { title: 'Hidden Real', hidden: true })
add('town_a', { title: 'Town', author: 'A' })
add('town_b', { title: 'Town', author: 'B' })
// catalogue stubs
const cat = (key, o) => add(key, { ...o, source: 'catalogue', health: 'catalogued' })
cat('cat:cheesecubeunlimited', { title: 'CHEESE CUBE UNLIMITED', author: 'ZK Studios', year: 2014 })          // title
cat('cat:cheesecube', { title: 'Cheese Cube (ZK)', release_post: 'https://callofdutyrepo.com/2013/04/18/cheese-cube/' }) // post
cat('cat:cheesecubev1byzk', { title: 'Cheesecubev1-Byzk' })                                               // norm (extract)
cat('cat:bunker', { title: 'BUNKER', author: 'Somebody Else', year: 2016 })                               // collision
cat('cat:hiddenreal', { title: 'Hidden Real' })                                                           // real is hidden
cat('cat:town', { title: 'Town' })                                                                        // two reals
cat('cat:cheesecubeunlimitedcubeofcircles', { title: 'Cheese Cube Unlimited: Cube of Circles', author: 'ZK Studios' }) // subtitle
add('nacht_reimagined', { title: 'Nacht der Untoten', author: 'Someone' })
cat('cat:nachtreimagined2', { title: 'Nacht der Untoten Reimagined', author: 'Other Person' })          // prefix, other author
cat('cat:ccubeexe', { title: 'Ccube Exe' })                                                                // size
const mid = (k) => db.prepare('SELECT id FROM maps WHERE key=?').get(k).id
db.prepare(`INSERT INTO map_versions (map_id, version, latest, health, fs_game, size_bytes, added_at) VALUES (?,?,1,'playable','mods/x',?,?)`)
  .run(mid('nazi_zombie_ccube'), 'v1', 78983876, now())
db.prepare(`INSERT INTO archive_sources (url, site, kind, map_key, status, created_at, size_bytes) VALUES (?,?,?,?,?,?,?)`)
  .run('https://archive.org/download/x/CheeseCubev1-byZK.exe', 'archive.org', 'download', 'cat:ccubeexe', 'alive', now(), 78983876)

const p = twins.plan(db, { normOf: { nazi_zombie_ccube: 'cheesecubev1byzk' } })
const hid = Object.fromEntries(p.hide.map((h) => [h.cat, h]))
const amb = Object.fromEntries(p.ambiguous.map((a) => [a.cat, a]))

check('the same title, same author/year: the stub is a twin of the real map', () => {
  eq(hid['cat:cheesecubeunlimited'] && hid['cat:cheesecubeunlimited'].real, 'nazi_zombie_ccube_u', 'real')
  eq(hid['cat:cheesecubeunlimited'].why, 'title', 'signal')
})
check('the same release post URL is enough on its own', () => {
  eq(hid['cat:cheesecube'] && hid['cat:cheesecube'].real, 'nazi_zombie_ccube', 'real'); eq(hid['cat:cheesecube'].why, 'post', 'signal')
})
check('the catalogue entry the release was fetched from (extract.json norm) is enough on its own', () => {
  eq(hid['cat:cheesecubev1byzk'] && hid['cat:cheesecubev1byzk'].real, 'nazi_zombie_ccube', 'real'); eq(hid['cat:cheesecubev1byzk'].why, 'norm', 'signal')
})
check('a name that merely collides (another author, another year) is reported, never hidden', () => {
  eq(hid['cat:bunker'], undefined, 'not hidden'); eq(!!amb['cat:bunker'], true, 'listed as ambiguous')
})
check('a title two real maps share is ambiguous', () => {
  eq(hid['cat:town'], undefined, 'not hidden'); eq(amb['cat:town'].reals.length, 2, 'both named')
})
check('a download link with exactly the real original\'s bytes is enough on its own', () => {
  eq(hid['cat:ccubeexe'] && hid['cat:ccubeexe'].real, 'nazi_zombie_ccube', 'real'); eq(hid['cat:ccubeexe'].why, 'size', 'signal')
})
check('a subtitle of the real title by the same author is a twin; by another author it is not', () => {
  eq(hid['cat:cheesecubeunlimitedcubeofcircles'] && hid['cat:cheesecubeunlimitedcubeofcircles'].real, 'nazi_zombie_ccube_u', 'Cube of Circles')
  eq(hid['cat:nachtreimagined2'], undefined, 'Nacht der Untoten Reimagined is another map')
})
check('a real map nobody can see supersedes nothing', () => {
  eq(hid['cat:hiddenreal'], undefined, 'not hidden'); eq(amb['cat:hiddenreal'], undefined, 'not even ambiguous')
})
check('apply hides the twins, links them, and is idempotent', () => {
  eq(twins.apply(db, p), 5, 'five rows changed')
  const r = db.prepare("SELECT hidden, superseded_by FROM maps WHERE key='cat:cheesecubeunlimited'").get()
  eq(r.hidden, 1, 'hidden'); eq(r.superseded_by, 'nazi_zombie_ccube_u', 'linked')
  eq(db.prepare("SELECT hidden FROM maps WHERE key='cat:bunker'").get().hidden, 0, 'the collision stays visible')
  twins.apply(db, p)
  eq(db.prepare("SELECT superseded_by FROM maps WHERE key='cat:cheesecube'").get().superseded_by, 'nazi_zombie_ccube', 'unchanged')
})
check("the stub's old slug shows the real map and says where it came from", () => {
  const d = maps.detail('cat-cheesecubeunlimited')
  eq(d.key, 'nazi_zombie_ccube_u', 'the real map')
  eq(d.redirected_from && d.redirected_from.key, 'cat:cheesecubeunlimited', 'redirected_from')
  eq(maps.detail('nazi_zombie_ccube_u').redirected_from, null, 'a real map is not redirected')
})

console.log(`\ncatalogue-twins: ${pass} passed, ${fail} failed`)
try { db.close() } catch { /* */ }
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
