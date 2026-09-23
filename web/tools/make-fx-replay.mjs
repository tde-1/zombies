// Lane R3 (replay.md §12): write the synthetic FX replay as a signed .enwr, for the viewer's
// scratch-site render check -- and, optionally, a stub asset manifest with procedural sounds so
// the manifest and audio paths run before lane R2's real assets exist.
//
//   node web/tools/make-fx-replay.mjs --replays <dir> [--maps <dir>]
//
// Writes, into --replays:
//   m_f0f0f0f0.enwr   every R1 event kind (web/test/fixtures/fx-events.js), Nacht, 2 players
//   m_f0f0f0f1.enwr   the same game with the R1 events removed: an "old" replay
// and, with --maps (a SCRATCH maps dir -- never ZombiesDev\maps, which the live site serves):
//   _assets.json      the R2 manifest shape, with sounds only; one weapon names a glb that does
//                     not exist, to prove the placeholder fallback
//   _sounds/*.wav     short procedural tones/noise (not game audio)
//
// Signed with a throwaway key made here; nothing is written anywhere else.
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
const mapsDir = arg('--maps')
if (!outDir) { console.error('usage: node web/tools/make-fx-replay.mjs --replays <dir> [--maps <scratch maps dir>]'); process.exit(2) }
if (mapsDir && /ZombiesDev[\\/]+maps[\\/]*$/i.test(path.resolve(mapsDir))) {
  console.error('refusing: that is the live maps dir (replay.md rule: scratch only)'); process.exit(2)
}

const pair = keys.generate()
const raw = keys.exportPair(pair)
const keyId = crypto.createHash('sha256').update(Buffer.from(raw.pub, 'base64url')).digest('hex').slice(0, 16)
const FX = new Set(['weapon', 'fire', 'hit', 'damage', 'pap', 'powerup'])

function write(id, events) {
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `${id}.enwr`)
  const w = new ReplayWriter({
    file,
    header: { match_id: id, map: 'nazi_zombie_prototype', map_name: 'Nacht der Untoten (R3 fixture)', mode: 'local', box: null, started_at: new Date().toISOString() },
    privateKey: pair.privateKey, pub: raw.pub, keyId, chunkMs: 60_000,
  })
  for (const e of events) w.append(e)
  const st = w.close({ summary: { rounds: 1, fixture: 'lane R3' } })
  console.log(`${file}  ${st.events} events`)
}

const ev = fixtureEvents()
write('m_f0f0f0f0', ev)
write('m_f0f0f0f1', ev.filter((e) => !FX.has(e.t)))

if (mapsDir) {
  const snd = path.join(mapsDir, '_sounds')
  fs.mkdirSync(snd, { recursive: true })
  // 16-bit mono PCM WAV, 22.05 kHz.
  const wav = (name, secs, f) => {
    const rate = 22050
    const n = Math.round(rate * secs)
    const b = Buffer.alloc(44 + n * 2)
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
    b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
    let seed = 1
    const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 1073741823.5 - 1 }
    for (let i = 0; i < n; i++) {
      const t = i / rate
      const v = Math.max(-1, Math.min(1, f(t, noise)))
      b.writeInt16LE(Math.round(v * 30000), 44 + i * 2)
    }
    fs.writeFileSync(path.join(snd, `${name}.wav`), b)
  }
  const env = (t, a, d) => Math.min(1, t / a) * Math.exp(-t / d)
  wav('shot_pistol', 0.25, (t, n) => n() * env(t, 0.002, 0.04))
  wav('shot_smg', 0.2, (t, n) => n() * env(t, 0.002, 0.03) * 0.9)
  wav('shot_smg_pap', 0.3, (t, n) => (n() * 0.6 + Math.sin(2 * Math.PI * 900 * t) * 0.5) * env(t, 0.002, 0.05))
  wav('shot_raygun', 0.35, (t) => Math.sin(2 * Math.PI * (1400 - 2600 * t) * t) * env(t, 0.003, 0.1))
  wav('hit_marker', 0.08, (t) => Math.sin(2 * Math.PI * 2200 * t) * env(t, 0.001, 0.02))
  wav('player_hit', 0.4, (t, n) => (n() * 0.5 + Math.sin(2 * Math.PI * 90 * t)) * env(t, 0.005, 0.12))
  wav('pap_jingle', 1.6, (t) => [523, 659, 784, 1047].reduce((a, f, i) => a + (t > i * 0.3 ? Math.sin(2 * Math.PI * f * t) * env(t - i * 0.3, 0.01, 0.3) : 0), 0) * 0.5)
  wav('powerup_spawn', 0.5, (t) => Math.sin(2 * Math.PI * (300 + 600 * t) * t) * env(t, 0.02, 0.2) * 0.6)
  wav('powerup_grab', 0.4, (t) => Math.sin(2 * Math.PI * 880 * t) * env(t, 0.005, 0.12))
  for (const k of ['insta_kill', 'double_points', 'max_ammo', 'nuke', 'carpenter', 'fire_sale', 'death_machine']) {
    // A stand-in "announcer": a two-note call, pitched per kind.
    const f0 = 180 + 20 * k.length
    wav(`announce_${k}`, 0.7, (t) => (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * f0 * 1.5 * t)) * env(t, 0.02, 0.25) * 0.5)
  }
  const s = (k) => `_sounds/${k}.wav`
  const assets = {
    note: 'lane R3 STUB manifest for the scratch site: procedural tones, no models. Lane R2 replaces it.',
    weapons: {
      zombie_colt: { displayName: 'M1911', sounds: { fire: s('shot_pistol') }, muzzle: { tag: 'tag_flash' } },
      mp40: { displayName: 'MP40', glb: '_weapons/mp40_does_not_exist.glb', pap: { displayName: 'The Afterburner' }, sounds: { fire: s('shot_smg'), fire_pap: s('shot_smg_pap') }, muzzle: { tag: 'tag_flash' } },
      ray_gun: { displayName: 'Ray Gun', sounds: { fire: s('shot_raygun') } },
    },
    powerups: Object.fromEntries(['insta_kill', 'double_points', 'max_ammo', 'nuke', 'carpenter', 'fire_sale', 'death_machine', 'other']
      .map((k) => [k, { sounds: { pickup: s('powerup_grab'), announce: k === 'other' ? null : s(`announce_${k}`) } }])),
    fx: {},
    sounds: { hit_marker: s('hit_marker'), player_hit: s('player_hit'), pap_upgrade: s('pap_jingle'), powerup_spawn: s('powerup_spawn') },
  }
  fs.writeFileSync(path.join(mapsDir, '_assets.json'), JSON.stringify(assets, null, 2))
  console.log(`${path.join(mapsDir, '_assets.json')} + ${fs.readdirSync(snd).length} sounds`)
}
