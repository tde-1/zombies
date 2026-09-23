'use strict'

// Easter egg guides (2026-09-23): the ingestion (lib/guides.js importDoc, which is what
// `import-archive.js --guides` runs), the map page's `guides` and the cards' `ee_guide`,
// and the routes over HTTP — the map page, and the admin list with hide / delete. Plus the
// extractor's own self-test (`python archive/easter_eggs.py --selftest`) when Python is on
// the PATH. A throwaway database, 127.0.0.1 only.
//
//   node test/guides.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawnSync } = require('child_process')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-guides-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')
process.env.ZM_STEAM_AVATARS = 'off'

let pass = 0
let fail = 0
const out = []
async function check(name, fn) {
  try { await fn(); pass++; out.push(['ok  ', name]) } catch (e) { fail++; out.push(['FAIL', `${name} — ${e.message}`]) }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }

const { db, now } = require('../server/db/database')
const users = require('../server/lib/users')
const maps = require('../server/lib/maps')
const guides = require('../server/lib/guides')

// Two maps: a pipeline map (bsp key) and a catalogue stub, and one with no guide at all.
const addMap = (key, title, source, health) => db.prepare(`INSERT INTO maps (key, slug, title, author, source, health, main_finish, round_n, added_at)
  VALUES (?,?,?,?,?,?, 'round', 20, ?)`).run(key, key.replace(/[^a-z0-9]/g, ''), title, 'someone', source, health, now())
addMap('battlestar_galactica', 'Battlestar Galactica', 'custom', 'playable')
addMap('cat:escher', 'Escher', 'catalogue', 'catalogued')
addMap('cat:nothing', 'Nothing Here', 'catalogue', 'catalogued')

const MOD = '76561198000000201'
const PLAYER = '76561198000000202'
users.ensure(MOD, { enw_name: 'modder' })
users.ensure(PLAYER, { enw_name: 'player' })
db.prepare('UPDATE users SET approved=1').run()
db.prepare('UPDATE users SET is_mod=1 WHERE steam_id=?').run(MOD)

const doc = () => ({
  schema: 'enw.map_guides/1',
  generated: '2026-09-23T01:00:00Z',
  guides: [
    {
      norm: 'battlestargalactica', map_keys: ['battlestar_galactica', 'cat:battlestargalactica'],
      kind: 'ending', title: 'How To Win', reward: 'The ending',
      steps: [{ text: 'You must destroy all 11 hidden Cylon spy devices' }, { text: 'Once done you will be able to buy the ending !' }],
      source_url: 'https://callofdutyrepo.com/2015/05/31/battlestar-galactica/', source_site: 'callofdutyrepo.com', source_author: 'CanadianTyler',
      confidence: 0.76, evidence: { steps: 2 },
    },
    {
      norm: 'escher', map_keys: ['cat:escher'], kind: 'easter_egg', title: 'Easter Egg Guide', reward: 'Pack-a-Punch',
      steps: [{ text: 'Fill all 6 soul boxes', label: 'Appease The Boxes' }, { text: 'Find and shoot all 3 teddy bears', details: ['Under the ramp'] }, { text: 'Kill the NPC' }],
      source_url: 'https://callofdutyrepo.com/2019/01/01/escher/', source_site: 'callofdutyrepo.com', source_author: 'JayJiveCertified',
      confidence: 0.9,
    },
    {
      norm: 'escher', map_keys: ['cat:escher'], kind: 'song', title: 'Song', reward: 'A song',
      steps: [{ text: 'Hold F on all 3 teddy bears' }],
      // a scraped link that is not http(s) must never reach an href
      source_url: 'javascript:alert(1)', source_site: 'callofdutyrepo.com', source_author: 'JayJiveCertified',
      confidence: 0.57,
    },
    { norm: 'ghost', map_keys: ['cat:ghost'], kind: 'easter_egg', title: 'x', steps: [{ text: 'Shoot the thing' }], confidence: 0.8 },
    { norm: 'escher', map_keys: ['cat:escher'], kind: 'wizardry', title: 'x', steps: [{ text: 'Shoot the thing' }], confidence: 0.8 },
    { norm: 'escher', map_keys: ['cat:escher'], kind: 'power', title: 'x', steps: [{ text: '   ' }], confidence: 0.8 },
  ],
})

function req(port, method, p, { as, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: {
      ...(as ? { 'x-test-user': as } : {}),
      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let t = ''
      res.on('data', (c) => { t += c })
      res.on('end', () => { let j = null; try { j = JSON.parse(t) } catch {} resolve({ status: res.statusCode, body: j }) })
    })
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

async function main() {
  // ---- ingestion ----------------------------------------------------------------------
  await check('import: guides land on the first site key that exists; unknown maps and bad rows are counted, not stored', () => {
    const s = guides.importDoc(doc())
    eq(s.in_file, 6, 'in_file')
    eq(s.inserted, 3, 'inserted')
    eq(s.no_map, 1, 'no_map')
    eq(s.bad, 2, 'bad (unknown kind, empty steps)')
    eq(s.maps, 2, 'maps')
    eq(db.prepare("SELECT COUNT(*) c FROM map_guides WHERE map_key='battlestar_galactica'").get().c, 1, 'on the bsp key, not the cat: one')
  })
  await check('import: a non-http source link is dropped, the rest of the guide kept', () => {
    const g = db.prepare("SELECT * FROM map_guides WHERE kind='song'").get()
    eq(g.source_url, null, 'source_url')
    eq(g.source_author, 'JayJiveCertified', 'author kept')
  })
  await check('import: re-running the same report changes nothing', () => {
    const s = guides.importDoc(doc())
    eq(s.inserted, 0, 'inserted'); eq(s.updated, 0, 'updated'); eq(s.unchanged, 3, 'unchanged'); eq(s.removed, 0, 'removed')
  })
  await check('import: dry run writes nothing', () => {
    const d = doc(); d.guides[0].steps.push({ text: 'Buy the ending for 50,000' })
    const before = db.prepare("SELECT steps_json FROM map_guides WHERE map_key='battlestar_galactica'").get().steps_json
    const s = guides.importDoc(d, { dry: true })
    eq(s.updated, 1, 'would update')
    eq(db.prepare("SELECT steps_json FROM map_guides WHERE map_key='battlestar_galactica'").get().steps_json, before, 'unchanged row')
  })

  // ---- what the pages read ------------------------------------------------------------
  await check('the map page: guides main quest first, with source; a map with none gets []', () => {
    const e = maps.detail('cat:escher')
    eq(e.guides.length, 2, 'two guides')
    eq(e.guides[0].kind, 'easter_egg', 'main quest first')
    eq(e.guides[0].tab, 'Main quest', 'tab')
    eq(e.guides[0].steps[0].label, 'Appease The Boxes', 'label kept')
    eq(e.guides[0].source.author, 'JayJiveCertified', 'author')
    eq(e.guides[0].confidence, undefined, 'confidence is staff-only')
    eq(maps.detail('cat:nothing').guides.length, 0, 'no guides')
  })
  await check('cards: ee_guide only where a live MAIN-QUEST guide exists', () => {
    const all = maps.list({ includeBroken: true }).maps
    const by = Object.fromEntries(all.map((m) => [m.key, m.ee_guide]))
    eq(by['cat:escher'], true, 'escher')
    eq(by.battlestar_galactica, false, 'an ending guide is not a main quest')
    eq(by['cat:nothing'], false, 'nothing')
  })

  // ---- over HTTP ------------------------------------------------------------------------
  const express = require('express')
  const app = express()
  app.use(express.json())
  app.use((q, _r, next) => { const who = q.headers['x-test-user']; q.me = who ? users.byId(String(who)) : null; next() })
  app.use('/api/maps', require('../server/routes/maps').router())
  app.use('/api/admin', require('../server/routes/admin').router())
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = server.address().port

  await check('HTTP: GET /api/maps/:key carries the guides, and none for a map without', async () => {
    const r = await req(port, 'GET', '/api/maps/cat%3Aescher')
    eq(r.status, 200, 'status')
    eq(r.body.map.guides.length, 2, 'guides')
    const n = await req(port, 'GET', '/api/maps/cat%3Anothing')
    eq(n.body.map.guides.length, 0, 'none')
  })
  let songId = null
  let questId = null
  await check('HTTP: the admin list is mods only and shows confidence', async () => {
    eq((await req(port, 'GET', '/api/admin/guides')).status, 401, 'anonymous')
    eq((await req(port, 'GET', '/api/admin/guides', { as: PLAYER })).status, 403, 'a player')
    const r = await req(port, 'GET', '/api/admin/guides', { as: MOD })
    eq(r.status, 200, 'mod')
    eq(r.body.guides.length, 3, 'three')
    eq(r.body.guides[0].confidence, 0.57, 'weakest first')
    eq(r.body.guides[0].confidence_label, 'medium', 'label')
    eq(r.body.counts.maps, 2, 'maps with guides')
    songId = r.body.guides.find((g) => g.kind === 'song').id
    questId = r.body.guides.find((g) => g.kind === 'easter_egg').id
  })
  await check('HTTP: hide takes a guide off the map page; show puts it back; a bad state is a 400', async () => {
    eq((await req(port, 'POST', `/api/admin/guides/${songId}`, { as: PLAYER, body: { state: 'hidden' } })).status, 403, 'player')
    eq((await req(port, 'POST', `/api/admin/guides/${songId}`, { as: MOD, body: { state: 'hidden' } })).status, 200, 'hide')
    eq((await req(port, 'GET', '/api/maps/cat%3Aescher')).body.map.guides.length, 1, 'hidden is gone')
    eq((await req(port, 'POST', `/api/admin/guides/${songId}`, { as: MOD, body: { state: 'bogus' } })).status, 400, 'bad state')
    eq((await req(port, 'POST', '/api/admin/guides/999999', { as: MOD, body: { state: 'hidden' } })).status, 404, 'no such guide')
    eq((await req(port, 'POST', `/api/admin/guides/${songId}`, { as: MOD, body: { state: 'live' } })).status, 200, 'show')
    eq((await req(port, 'GET', '/api/maps/cat%3Aescher')).body.map.guides.length, 2, 'back')
  })
  await check('HTTP: delete is a tombstone the next import respects, and the EE tag goes with it', async () => {
    eq((await req(port, 'POST', `/api/admin/guides/${questId}`, { as: MOD, body: { state: 'deleted' } })).status, 200, 'delete')
    const s = guides.importDoc(doc())
    eq(s.inserted, 0, 'not re-inserted')
    eq(s.tombstoned, 1, 'tombstoned')
    const row = db.prepare('SELECT state, steps_json FROM map_guides WHERE id=?').get(questId)
    eq(row.state, 'deleted', 'still deleted')
    eq(row.steps_json, '[]', 'steps cleared')
    eq(maps.detail('cat:escher').guides.some((g) => g.kind === 'easter_egg'), false, 'not on the page')
    eq(maps.list({ includeBroken: true }).maps.find((m) => m.key === 'cat:escher').ee_guide, false, 'no EE tag')
    eq(db.prepare("SELECT COUNT(*) c FROM activity_log WHERE event LIKE 'guide.%'").get().c, 3, 'logged')
  })
  await check('import: a guide the heuristic no longer finds is removed, unless staff touched it', () => {
    const d = doc(); d.guides = d.guides.filter((g) => g.kind !== 'ending' && g.kind !== 'song')
    const s = guides.importDoc(d)
    eq(s.removed, 1, 'the ending guide, untouched by staff, goes')
    eq(s.kept_by_staff, 1, 'the song (hidden then shown by staff) stays')
    eq(db.prepare("SELECT state FROM map_guides WHERE kind='easter_egg'").get().state, 'deleted', 'the tombstone stays')
  })
  server.close()

  // ---- the extractor ------------------------------------------------------------------
  const py = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    [path.join(__dirname, '..', '..', 'archive', 'easter_eggs.py'), '--selftest'], { encoding: 'utf8' })
  if (py.error) {
    out.push(['skip', `archive/easter_eggs.py --selftest (no python: ${py.error.code})`])
  } else {
    await check('archive/easter_eggs.py --selftest: guides kept, feature lists rejected', () => {
      if (py.status !== 0) throw new Error((py.stdout + py.stderr).trim().split('\n').slice(-6).join(' | '))
    })
  }

  for (const [s, n] of out) console.log(`${s}  ${n}`)
  console.log(`\n${pass} passed, ${fail} failed`)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* windows file lock */ }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
