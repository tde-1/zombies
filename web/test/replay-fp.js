'use strict'

// Lane RV (replay.md §14): first-person hands, aim down sights, and the placeholder for guns the
// asset pack does not have.
//
//   node test/replay-fp.js
//
// fpmath.js and fx.js are ESM with no three.js, imported straight into node (as replay-fx.js does).

const path = require('path')
const url = require('url')
const { buildTrack } = require('../server/routes/replay')

let pass = 0
let fail = 0
const out = []
async function check(name, fn) {
  try { await fn(); pass++; out.push(['ok  ', name]) } catch (e) { fail++; out.push(['FAIL', `${name} — ${e.message}`]) }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }
const near = (a, b, eps, what) => { if (!(Math.abs(a - b) <= eps)) throw new Error(`${what || 'value'}: expected ~${b}, got ${a}`) }

const imp = (f) => import(url.pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'replay3d', f)).href)

// The asset pack's shape (tools/models/export_assets.py): two guns, one with first-person data.
const ASSETS = {
  base: '/mapdata/',
  weapons: {
    colt: { displayName: 'Colt M1911', glb: '_weapons/colt.glb', viewGlb: '_weapons/colt_view.glb', sounds: {} },
    stg44: {
      displayName: 'STG-44', glb: '_weapons/stg44.glb', viewGlb: '_weapons/stg44_view.glb', aliases: ['stg44'],
      fp: { idle: 'viewmodel_mp44_idle@first', ads: 'viewmodel_mp44_ads_up@last', standMove: [0, 0, -3.25], adsZoomFov: 45, adsInMs: 350, adsOutMs: 400 },
      pap: { displayName: 'Spatz-447 +', glb: '_weapons/stg44_pap.glb', viewGlb: '_weapons/stg44_pap_view.glb' },
    },
  },
  weaponByEngineName: { zombie_colt: { weapon: 'colt', pap: false }, zombie_stg44: { weapon: 'stg44', pap: false }, zombie_stg44_upgraded: { weapon: 'stg44', pap: true }, stg44: { weapon: 'stg44', pap: false } },
}

async function main() {
  const fm = await imp('fpmath.js')
  const fx = await imp('fx.js')
  const waw = await imp('waw.js')

  await check('ADS from the button: none held is hip; the ease runs at the weapon\'s in/out times', () => {
    eq(fm.adsFracFromPresses([], 1000), 0)
    eq(fm.adsFracFromPresses(null, 1000), 0)
    const e = [[1000, 2000]]
    eq(fm.adsFracFromPresses(e, 999, 300, 400), 0, 'before the press')
    near(fm.adsFracFromPresses(e, 1150, 300, 400), 0.5, 1e-9, 'half way in')
    eq(fm.adsFracFromPresses(e, 1500, 300, 400), 1, 'held')
    near(fm.adsFracFromPresses(e, 2200, 300, 400), 0.5, 1e-9, 'half way out')
    eq(fm.adsFracFromPresses(e, 2500, 300, 400), 0, 'out')
  })

  await check('ADS from the button: a quick re-aim starts from where the last one left off, and a held press has no end', () => {
    const e = [[0, 100], [200, 250], [5000, null]]
    // 0..100 in: 1/3; 100..200 out at 300: 0; 200..250: +1/6 -> 1/6
    near(fm.adsFracFromPresses(e, 250, 300, 300), 1 / 6, 1e-9)
    // tapped just before 0.1 s decayed it fully: 0..100 = 1/3, out 50 ms = -1/6 -> 1/6, +50/300 = 1/3
    near(fm.adsFracFromPresses([[0, 100], [150, 200]], 200, 300, 300), 1 / 3, 1e-9)
    eq(fm.adsFracFromPresses(e, 9000, 300, 300), 1, 'still held at the end of the file')
  })

  await check('ADS from the button is scrub-exact: any frame order gives the same answer', () => {
    const e = [[100, 400], [520, 900], [1000, 1010], [3000, 3600]]
    const want = []
    for (let t = 0; t < 4000; t += 7) want.push(fm.adsFracFromPresses(e, t, 250, 350))
    const order = want.map((_, i) => i).sort((a, b) => ((a * 7919) % 101) - ((b * 7919) % 101))
    for (const i of order) eq(fm.adsFracFromPresses(e, i * 7, 250, 350), want[i], `t=${i * 7}`)
  })

  await check('ADS from the DLL column (replay_events 2): tenths, interpolated between ticks; null when absent', () => {
    eq(fm.adsFracFromColumn(null, 3), null)
    eq(fm.adsFracFromColumn([null, null], 1), null)
    const col = [0, 0, 5, 10, 10]
    eq(fm.adsFracFromColumn(col, 3), 1)
    near(fm.adsFracFromColumn(col, 1.5), 0.25, 1e-9)
    eq(fm.adsFracFromColumn(col, 99), 1, 'clamped past the end')
  })

  await check('the pose: bind <- idle <- ads, each only where it has a value; halfway is a unit quaternion', () => {
    const bind = { q: [0, 0, 0, 1], t: [1, 2, 3] }
    const o = { q: [0, 0, 0, 0], t: [0, 0, 0] }
    fm.blendBone(bind, undefined, undefined, 0.5, o)
    eq(JSON.stringify(o), JSON.stringify({ q: [0, 0, 0, 1], t: [1, 2, 3] }), 'nothing animates it: bind')
    const idle = [[0, 0, Math.SQRT1_2, Math.SQRT1_2], null]
    fm.blendBone(bind, idle, undefined, 1, o)
    eq(o.t[0], 1, 'no idle translation keeps the bind offset'); near(o.q[2], Math.SQRT1_2, 1e-12)
    const ads = [null, [11, 2, 3]]
    fm.blendBone(bind, idle, ads, 0.5, o)
    near(o.t[0], 6, 1e-12, 'translation lerps idle -> ads'); near(o.q[2], Math.SQRT1_2, 1e-12, 'ads has no rotation: idle\'s')
    fm.blendBone(bind, [[0, 0, 0, 1], null], [[0, 0, 1, 0], null], 0.5, o)
    near(Math.hypot(...o.q), 1, 1e-12, 'normalised')
    near(o.q[2], Math.SQRT1_2, 1e-9, '90 degrees of 180')
  })

  await check('the ADS anim is scrubbed by the fraction: 0 is frame 0 (the hip), 1 the last frame (the sights)', () => {
    const o = {}
    fm.adsSeqSample(7, 0, o); eq(JSON.stringify(o), JSON.stringify({ a: 0, b: 1, t: 0 }))
    fm.adsSeqSample(7, 1, o); eq(o.a, 5); eq(o.b, 6); near(o.t, 1, 1e-12)
    fm.adsSeqSample(7, 0.5, o); eq(o.a, 3); near(o.t, 0, 1e-12)
    fm.adsSeqSample(7, 0.25, o); eq(o.a, 1); near(o.t, 0.5, 1e-12)
    fm.adsSeqSample(1, 0.7, o); eq(JSON.stringify(o), JSON.stringify({ a: 0, b: 0, t: 0 }), 'a one-frame anim')
    fm.adsSeqSample(7, 3, o); eq(o.b, 6, 'clamped')
  })

  await check('an old file (no recorded cues) gets fire cues from its presses and swipe cues from its health drops; recorded kinds are never doubled', () => {
    const track = { players: [{ slot: 0 }, { slot: 1 }], hits: [{ slot: 0, ms: 5000 }, { slot: 1, ms: 6000 }], fx: [] }
    const F = fx.buildFx(track, ASSETS)
    const n = fx.addInferredCues(F, track, (p) => (p.slot === 0 ? [1000, 1100] : [2000]), (p, ms) => (ms < 1050 ? 'zombie_colt' : 'springfield'))
    eq(n, 5)
    eq(JSON.stringify(F.cues.map((c) => [c.ms, c.kind, c.pid, c.name || null])), JSON.stringify([[1000, 'fire', 0, 'zombie_colt'], [1100, 'fire', 0, 'springfield'], [2000, 'fire', 1, 'springfield'], [5000, 'damage', 0, null], [6000, 'damage', 1, null]]))
    eq(JSON.stringify(F.cueMs), JSON.stringify([1000, 1100, 2000, 5000, 6000]), 'cueMs rebuilt')
    const v1 = { players: [{ slot: 0 }], hits: [{ slot: 0, ms: 5000 }], fx: [{ t: 'fire', ms: 900, pid: 0, name: 'colt' }, { t: 'damage', ms: 4990, pid: 0, hp: 60 }] }
    const G = fx.buildFx(v1, ASSETS)
    eq(fx.addInferredCues(G, v1, () => [1000], () => 'colt'), 0, 'a v1 file keeps its own cues only')
  })

  await check('a gun the pack does not have still fires: the stock gun of its class, else a rifle; not-guns and the flamethrower stay silent', () => {
    const A = { ...ASSETS, weapons: { ...ASSETS.weapons,
      m1carbine: { sounds: { fire: '_sounds/m1carbine_fire.ogg', fire_plr: '_sounds/m1carbine_fire_plr.ogg' } },
      thompson: { sounds: { fire: '_sounds/thompson_fire.ogg' } } }, sounds: { general: {} } }
    eq(JSON.stringify(fx.soundsFor({ kind: 'fire', name: 'm9' }, A, false, false)), JSON.stringify(['_sounds/m1carbine_fire.ogg']), 'unknown -> rifle')
    eq(JSON.stringify(fx.soundsFor({ kind: 'fire', name: 'm9' }, A, false, true)), JSON.stringify(['_sounds/m1carbine_fire_plr.ogg']), 'first person')
    eq(JSON.stringify(fx.soundsFor({ kind: 'fire', name: 'zombie_mp44_ext_smg' }, A, false, false)), JSON.stringify(['_sounds/thompson_fire.ogg']), 'an smg by its name')
    eq(fx.soundsFor({ kind: 'fire', name: 'm2_flamethrower_custom' }, A, false, false), null, 'flame')
    eq(fx.soundsFor({ kind: 'fire', name: 'zombie_knuckle_crack' }, A, false, false), null, 'not a gun')
  })

  await check('the FOV eases from cg_fov to the gun\'s adsZoomFov; no zoom data keeps the hip FOV', () => {
    eq(fm.adsFov(65, 45, 0), 65)
    eq(fm.adsFov(65, 45, 1), 45)
    near(fm.adsFov(65, 45, 0.5), 55, 1e-12)
    eq(fm.adsFov(65, null, 1), 65)
    eq(fm.adsFov(65, 0, 1), 65)
  })

  await check('a gun the pack does not have is the fake rifle and is flagged; a gun it has is not', () => {
    const t = waw.WEAPONS
    eq(JSON.stringify(fx.placeholderFor(ASSETS, 'springfield', 'springfield', t)), JSON.stringify({ cls: 'rifle', unknown: true }), 'springfield')
    eq(JSON.stringify(fx.placeholderFor(ASSETS, 'type99_lmg_bipod', 'type99_lmg_bipod', t)), JSON.stringify({ cls: 'rifle', unknown: true }), 'an mg is a rifle-sized fake too')
    eq(JSON.stringify(fx.placeholderFor(ASSETS, 'zombie_ppsh', 'zombie_ppsh', t)), JSON.stringify({ cls: 'rifle', unknown: true }), 'an smg the pack lacks')
    eq(fx.placeholderFor(ASSETS, 'colt', 'zombie_colt', t).unknown, false, 'in the pack')
    eq(fx.placeholderFor(ASSETS, 'stg44', 'stg44', t).unknown, false, "an older map's name for a gun the pack has (alias)")
    eq(fx.placeholderFor(ASSETS, 'stg44_upgraded', 'zombie_stg44_upgraded', t).unknown, false, 'upgraded')
    eq(fx.placeholderFor(ASSETS, '#37', '#37', t).unknown, false, 'an unbound index is not a name to log')
  })

  await check('not-guns keep their own stand-in; with no pack at all the §12 class placeholders stay', () => {
    const t = waw.WEAPONS
    eq(fx.placeholderFor(ASSETS, 'knuckle_crack', 'zombie_knuckle_crack', t).cls, 'none')
    eq(fx.placeholderFor(ASSETS, 'perk_bottle_jugg', 'zombie_perk_bottle_jugg', t).cls, 'bottle')
    eq(fx.placeholderFor(ASSETS, 'stielhandgranate', 'stielhandgranate', t).cls, 'grenade')
    eq(JSON.stringify(fx.placeholderFor(null, 'mp40', 'zombie_mp40', t)), JSON.stringify({ cls: 'smg', unknown: false }), 'assets off')
  })

  await check('the display name on the tag is the real weapon\'s, for a gun drawn as the fake', () => {
    eq(fx.displayName('springfield', false, ASSETS, 'springfield'), 'Springfield')
    eq(fx.displayName('ppsh', false, ASSETS, 'zombie_ppsh'), 'PPSh-41')
    eq(fx.displayName('stg44', true, ASSETS, 'zombie_stg44_upgraded'), 'Spatz-447 +')
  })

  await check('the track carries the DLL\'s `ads` per tick in tenths (v2), null on files without it; the ADS button edges on every file', () => {
    const ev = [{ t: 'player_connect', ms: 0, slot: 0, name: 'p' }]
    const btn = (ms, b) => ev.push({ t: 'input', ms, slot: 0, buttons: b })
    for (let k = 0; k < 40; k++) {
      const ms = 1000 + k * 50
      if (k === 5) btn(ms, 0x800)
      if (k === 25) btn(ms, 0)
      const p = { slot: 0, pos: [0, 0, 0], ang: [0, 0] }
      if (k === 0) Object.assign(p, { health: 100, alive: true, weapon: 'zombie_stg44' })
      if (k === 6) p.ads = 0.3
      if (k === 8) p.ads = 1
      if (k === 26) p.ads = 0.4
      if (k === 28) p.ads = 0
      ev.push({ t: 'snap', ms, players: [p], zombies_alive: 0 })
    }
    const lib = (e) => ({ readHeader: () => ({ header: { match_id: 'm_fp000001', map: 'nazi_zombie_factory', replay_events: 2 } }), readEvents: () => e })
    const t = buildTrack('x.enwr', lib(ev), 20)
    const a = t.players[0].ads
    truthy(Array.isArray(a), 'ads column')
    eq(a[0], null, 'before the first value'); eq(a[6], 3); eq(a[7], 3, 'carried forward'); eq(a[10], 10); eq(a[27], 4); eq(a[39], 0)
    eq(JSON.stringify(t.players[0].presses.ads), JSON.stringify([[1250, 2250]]), 'button edges')
    eq(t.replay_events, 2)
    const old = buildTrack('x.enwr', lib(ev.map((e) => (e.t === 'snap' ? { ...e, players: e.players.map(({ ads, ...rest }) => rest) } : e))), 20)
    eq(old.players[0].ads, null, 'a file without the field')
  })

  for (const [s, n] of out) console.log(`${s} ${n}`)
  console.log(`\nreplay-fp: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
