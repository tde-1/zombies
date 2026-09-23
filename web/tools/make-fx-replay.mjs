// Lane R3 (replay.md §12): write the synthetic replay-events-v1 fixture as signed .enwr files,
// for the viewer's scratch-site render check (web/tools/r3-render-check.mjs).
//
//   node web/tools/make-fx-replay.mjs --replays <scratch replay dir>
//
// Writes, into --replays:
//   m_f0f0f0f0.enwr   every v1 event kind (web/test/fixtures/fx-events.js), Nacht, 2 players, with
//                     the v1 header (replay_events 1, snap_hz 20, zombie_hz 20)
//   m_f0f0f0f1.enwr   the same game with the v1 events and header fields removed: an "old" replay
//
// Signed with a throwaway key made here. The sounds, models and sprites are lane R2's real pack
// (ZombiesDev\maps\_assets.json and friends, assets-pipeline.md); this writes none of them.
// Never point --replays at ZombiesDev\replays (the live site reads it).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { fixtureEvents } = require(path.join(here, '..', 'test', 'fixtures', 'fx-events.js'))
const { ReplayWriter } = await import(pathToFileURL(path.join(here, '..', '..', 'infra', 'host-agent', 'lib', 'replay.js')).href)
const keys = await import(pathToFileURL(path.join(here, '..', '..', 'infra', 'host-agent', 'lib', 'keys.js')).href)

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const outDir = arg('--replays')
if (!outDir) { console.error('usage: node web/tools/make-fx-replay.mjs --replays <scratch replay dir>'); process.exit(2) }
if (/ZombiesDev[\\/]+replays[\\/]*$/i.test(path.resolve(outDir))) {
  console.error('refusing: that is the live replay dir (scratch only)'); process.exit(2)
}

const pair = keys.generate()
const raw = keys.exportPair(pair)
const keyId = crypto.createHash('sha256').update(Buffer.from(raw.pub, 'base64url')).digest('hex').slice(0, 16)
const FX = new Set(['weapon', 'fire', 'hit', 'damage', 'pap', 'powerup'])

function write(id, events, v1) {
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `${id}.enwr`)
  const header = { match_id: id, map: 'nazi_zombie_prototype', map_name: 'Nacht der Untoten (R3 fixture)', mode: 'local', box: null, started_at: new Date().toISOString() }
  if (v1) Object.assign(header, { replay_events: 1, snap_hz: 20, zombie_hz: 20 })
  const w = new ReplayWriter({ file, header, privateKey: pair.privateKey, pub: raw.pub, keyId, chunkMs: 60_000 })
  for (const e of events) w.append(e)
  const st = w.close({ summary: { rounds: 1, fixture: 'lane R3' } })
  console.log(`${file}  ${st.events} events`)
}

const ev = fixtureEvents()
write('m_f0f0f0f0', ev, true)
write('m_f0f0f0f1', ev.filter((e) => !FX.has(e.t)).map((e) => {
  if (e.t !== 'map_loaded') return e
  const { replay_events: _a, snap_hz: _b, zombie_hz: _c, ...rest } = e
  return rest
}), false)
