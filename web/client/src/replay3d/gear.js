// Replay gear (lane R3, replay.md §12): the weapons in the players' hands, the muzzle flash,
// the first-person weapon, and the power-up pickups on the floor.
//
// ASSETS. Lane R2 serves them under /mapdata/ with a manifest, /mapdata/_assets.json:
//   weapons:  { <name>: { glb, displayName, pap: { glb?, displayName? }, sounds, muzzle: { tag, sprite } } }
//   powerups: { <kind>: { glb, sounds, durationMs? } }
//   fx:       { <name>: <png> ... } (+ _fx/fx.json)
// Everything here works WITHOUT it: every weapon is a procedural placeholder of its class
// (pistol, smg, rifle, mg, shotgun, launcher, ray gun, wonder weapon, flamethrower, grenade,
// knife) built from primitives -- no downloaded asset, no licence question, the rule §8.7 set --
// and every power-up is a primitive stand-in with the game's green glow. A glb that is listed but
// fails to load leaves the placeholder where it is. Nothing here can break the viewer.
//
// FRAME. Everything is built with the barrel along +X and up +Y, which is both a player
// model's root frame (models.js: engine +X forward, Y up) and Unlinker's weapon xmodel frame.
// The viewmodel turns that to camera space (-Z forward).
//
// COST. Four held guns, four flash sprites, one viewmodel and a pool of 12 pickups, all built
// once and reused; the per-frame path writes transforms into existing objects and allocates
// nothing (the temps are module-level).
import {
  Group, Mesh, BoxGeometry, CylinderGeometry, SphereGeometry, TorusGeometry, OctahedronGeometry,
  MeshStandardMaterial, MeshBasicMaterial, Sprite, SpriteMaterial, CanvasTexture, AdditiveBlending,
  Vector3, Quaternion, Euler, Box3, TextureLoader, SRGBColorSpace, Color,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { toThree } from './scene.js'
import { weaponClass, weaponKeys } from './fx.js'
import { WEAPONS } from './waw.js'

export const MAPDATA = '/mapdata'
export const ASSETS_URL = `${MAPDATA}/_assets.json`

/** The asset manifest, or null. Never rejects. */
export async function loadAssets(url = ASSETS_URL) {
  try {
    const r = await fetch(url, { cache: 'no-cache' })
    if (!r.ok) return null
    const j = await r.json()
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}

const assetUrl = (p) => (!p ? null : /^(https?:)?\//.test(p) ? p : `${MAPDATA}/${String(p).replace(/^\.?\//, '')}`)

const tmpV = new Vector3()
const tmpV2 = new Vector3()
const tmpQ = new Quaternion()
const tmpE = new Euler(0, 0, 0, 'YZX')
const tmpBox = new Box3()

// ------------------------------------------------------------ procedural textures --

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  draw(c.getContext('2d'), w, h)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
}
// A four-point muzzle star with a hot core: the stand-in when fx.json has no sprite.
const flashTex = () => canvasTex(64, 64, (g, w) => {
  const c = w / 2
  const rg = g.createRadialGradient(c, c, 0, c, c, c)
  rg.addColorStop(0, 'rgba(255,255,235,1)')
  rg.addColorStop(0.25, 'rgba(255,214,120,.9)')
  rg.addColorStop(0.6, 'rgba(255,140,40,.25)')
  rg.addColorStop(1, 'rgba(255,120,20,0)')
  g.fillStyle = rg
  g.fillRect(0, 0, w, w)
  g.globalCompositeOperation = 'lighter'
  g.fillStyle = 'rgba(255,220,150,.8)'
  for (const [dx, dy] of [[1, 0.12], [0.12, 1]]) {
    g.beginPath(); g.ellipse(c, c, c * dx, c * dy, 0, 0, Math.PI * 2); g.fill()
  }
})
// The green glow every WaW power-up drop sits in.
const glowTex = () => canvasTex(64, 64, (g, w) => {
  const c = w / 2
  const rg = g.createRadialGradient(c, c, 0, c, c, c)
  rg.addColorStop(0, 'rgba(170,255,140,.95)')
  rg.addColorStop(0.35, 'rgba(90,230,70,.55)')
  rg.addColorStop(1, 'rgba(40,160,30,0)')
  g.fillStyle = rg
  g.fillRect(0, 0, w, w)
})
// Pack-a-Punch camo: WaW's upgraded weapons wear a shifting purple/blue pattern. A procedural
// blotch texture, not the game's image.
const camoTex = () => canvasTex(128, 128, (g, w) => {
  g.fillStyle = '#2a0f45'
  g.fillRect(0, 0, w, w)
  let s = 7
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
  const cols = ['#6a2bd0', '#2c7de8', '#b04df0', '#15134a', '#48c8ff']
  for (let i = 0; i < 70; i++) {
    g.fillStyle = cols[i % cols.length]
    g.globalAlpha = 0.55 + rnd() * 0.4
    g.beginPath()
    g.ellipse(rnd() * w, rnd() * w, 4 + rnd() * 16, 3 + rnd() * 10, rnd() * Math.PI, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 1
})

// --------------------------------------------------------------- procedural guns --

// One template per class, built once: meshes share geometry and materials across clones.
function buildGunTemplates(M) {
  const box = (w, h, d, m, x, y, z) => { const o = new Mesh(new BoxGeometry(w, h, d), m); o.position.set(x, y, z); return o }
  // A cylinder along +X.
  const tube = (r, len, m, x, y, z, seg = 10) => {
    const o = new Mesh(new CylinderGeometry(r, r, len, seg), m)
    o.rotation.z = -Math.PI / 2
    o.position.set(x, y, z)
    return o
  }
  const make = (parts, muzzleX, muzzleY = 0.8) => {
    const g = new Group()
    for (const p of parts) g.add(p)
    const mz = new Group()
    mz.name = 'muzzle'
    mz.position.set(muzzleX, muzzleY, 0)
    g.add(mz)
    return g
  }
  const { metal, wood, dark, green, brass, blade } = M
  return {
    pistol: make([box(7, 1.6, 1.1, metal, 2.5, 0.9, 0), box(1.3, 3.6, 1, dark, -0.2, -1.2, 0), tube(0.35, 2, metal, 6.5, 0.8, 0)], 7.6),
    smg: make([box(11, 2.2, 1.6, metal, 3, 0.6, 0), box(1.4, 3.4, 1.2, wood, -0.3, -1.5, 0), box(1.3, 5, 1, dark, 3.8, -2.6, 0),
      box(6, 1.8, 1.3, wood, -5, 0.2, 0), tube(0.4, 5, metal, 10.5, 0.8, 0)], 13),
    rifle: make([box(20, 1.8, 1.5, wood, 6, 0, 0), box(9, 3, 1.4, wood, -8, -0.8, 0), box(10, 1.2, 1.2, metal, 7, 1.2, 0),
      box(1.3, 3, 1.1, wood, 0, -1.6, 0), tube(0.35, 12, metal, 20, 0.9, 0)], 26),
    mg: make([box(18, 3.4, 2.4, metal, 6, 0.6, 0), box(8, 3, 1.8, wood, -8, -0.4, 0), new Mesh(new CylinderGeometry(2.6, 2.6, 2, 14), dark),
      tube(0.8, 14, metal, 21, 1, 0), box(1.3, 3.2, 1.1, dark, 0, -2, 0)], 28, 1),
    spread: make([box(16, 2.2, 1.8, wood, 3, -0.2, 0), box(9, 3.2, 1.5, wood, -9, -0.9, 0), tube(0.6, 16, metal, 16, 0.9, 0),
      tube(0.55, 12, dark, 14, -0.4, 0)], 24),
    launcher: make([tube(2.4, 40, green, 6, 2.4, 0, 14), box(1.6, 4, 1.4, dark, 0, -1.8, 0), box(3, 2.4, 1.6, dark, 2, 5, 0)], 26, 2.4),
    raygun: make([box(6, 3.2, 1.6, M.red, 2, 1.1, 0), box(1.4, 3.6, 1.1, dark, -0.4, -1.2, 0), tube(0.9, 4, M.red, 6.5, 1.5, 0),
      ...[4.2, 5.6, 7].map((x) => { const t = new Mesh(new TorusGeometry(1.35, 0.35, 6, 14), green); t.rotation.y = Math.PI / 2; t.position.set(x, 1.5, 0); return t })], 8.8, 1.5),
    wonder: make([box(14, 3, 2.4, brass, 4, 0.6, 0), box(7, 2.6, 1.6, wood, -7, -0.4, 0), box(1.4, 3.2, 1.1, dark, 0, -1.8, 0),
      ...[-0.9, 0.9].map((zz) => tube(0.45, 9, metal, 14, 2.4, zz)), new Mesh(new SphereGeometry(1.4, 10, 8), M.bulb)], 19, 2.4),
    flame: make([tube(0.7, 20, metal, 8, 0.6, 0), box(8, 2.6, 2, dark, 0, 0, 0), box(1.4, 3.6, 1.2, dark, -1, -2.2, 0)], 18, 0.6),
    grenade: make([new Mesh(new CylinderGeometry(1.3, 1.3, 4, 10), green), tube(0.45, 7, wood, 0, -3, 0)], 0, 0),
    melee: make([box(6, 0.9, 0.25, blade, 4, 0.3, 0), box(3.4, 1.2, 1, wood, -0.6, 0, 0)], 7, 0.3),
    // v1 §2's non-guns: the Pack-a-Punch knuckle crack (empty hands) and a perk bottle.
    none: make([], 0, 0),
    bottle: make([(() => { const o = new Mesh(new CylinderGeometry(1.3, 1.3, 5, 10), M.bottle); o.position.set(1, 1.5, 0); return o })(),
      (() => { const o = new Mesh(new CylinderGeometry(0.5, 0.8, 1.6, 8), M.bottle); o.position.set(1, 4.8, 0); return o })()], 0, 0),
  }
}
// The wonder weapon's bulb and the mg's drum sit at their positions after the fact.
function placeOddParts(T) {
  const drum = T.mg.children.find((c) => c.geometry && c.geometry.type === 'CylinderGeometry' && c.position.lengthSq() === 0)
  if (drum) { drum.rotation.x = Math.PI / 2; drum.position.set(4, -2.4, 0) }
  const bulb = T.wonder.children.find((c) => c.geometry && c.geometry.type === 'SphereGeometry')
  if (bulb) bulb.position.set(9, 3.4, 0)
}

// Classes that make no flash when they "fire".
const NO_FLASH = new Set(['grenade', 'melee', 'none', 'bottle'])

// ---------------------------------------------------------------- power-up stand-ins --

function buildPowerupTemplates(M) {
  const g = (...parts) => { const o = new Group(); for (const p of parts) o.add(p); return o }
  const at = (m, x, y, z) => { m.position.set(x, y, z); return m }
  return {
    max_ammo: g(at(new Mesh(new BoxGeometry(12, 7, 7), M.olive), 0, 0, 0), at(new Mesh(new BoxGeometry(12.2, 1.4, 7.2), M.brass), 0, 1.8, 0)),
    insta_kill: g(at(new Mesh(new SphereGeometry(5, 14, 10), M.bone), 0, 1, 0), at(new Mesh(new BoxGeometry(5, 3, 4), M.bone), 0, -3.4, 1),
      at(new Mesh(new SphereGeometry(1.3, 8, 6), M.black), 1.8, 1.6, 4.2), at(new Mesh(new SphereGeometry(1.3, 8, 6), M.black), -1.8, 1.6, 4.2)),
    double_points: g(at(new Mesh(new CylinderGeometry(6, 6, 1.6, 20), M.brass), 0, 0, 0)),
    nuke: g(at(new Mesh(new SphereGeometry(4.5, 14, 10), M.olive), 0, 0, 0), at(new Mesh(new CylinderGeometry(1.2, 2.4, 6, 8), M.olive), 0, 5, 0)),
    carpenter: g(at(new Mesh(new BoxGeometry(8, 2.6, 2.6), M.metal), 0, 4, 0), at(new Mesh(new CylinderGeometry(0.8, 0.8, 11, 8), M.wood), 0, -1.5, 0)),
    fire_sale: g(at(new Mesh(new BoxGeometry(10, 8, 6), M.red), 0, 0, 0), at(new Mesh(new BoxGeometry(10.2, 1.2, 6.2), M.white), 0, 2, 0)),
    death_machine: g(...[0, 1, 2, 3, 4, 5].map((i) => at(new Mesh(new CylinderGeometry(0.7, 0.7, 12, 6), M.metal),
      Math.cos(i * Math.PI / 3) * 1.8, 0, Math.sin(i * Math.PI / 3) * 1.8))),
    other: g(new Mesh(new OctahedronGeometry(5), M.brass)),
  }
}

// ------------------------------------------------------------------------ gear --

/**
 * @param api     createScene()'s object
 * @param actors  createActors()'s object (handOf)
 * @param assets  /mapdata/_assets.json or null
 */
export function createGear(api, actors, assetsIn) {
  let assets = assetsIn || null
  const root = new Group()
  root.name = 'r3-gear'
  api.scene.add(root)
  const owned = []   // geometries / materials / textures to dispose
  const own = (x) => { owned.push(x); return x }

  const M = {
    metal: own(new MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.45, metalness: 0.6, fog: false })),
    dark: own(new MeshStandardMaterial({ color: 0x18191c, roughness: 0.6, metalness: 0.3, fog: false })),
    wood: own(new MeshStandardMaterial({ color: 0x5a3b22, roughness: 0.8, metalness: 0, fog: false })),
    green: own(new MeshStandardMaterial({ color: 0x3f5a2a, roughness: 0.6, emissive: new Color(0x0a3a08), fog: false })),
    olive: own(new MeshStandardMaterial({ color: 0x55603a, roughness: 0.7, emissive: new Color(0x132208), fog: false })),
    brass: own(new MeshStandardMaterial({ color: 0xc8a040, roughness: 0.35, metalness: 0.7, emissive: new Color(0x3a2a08), fog: false })),
    red: own(new MeshStandardMaterial({ color: 0xb02a20, roughness: 0.45, metalness: 0.3, emissive: new Color(0x2a0402), fog: false })),
    bone: own(new MeshStandardMaterial({ color: 0xe8e0c8, roughness: 0.6, emissive: new Color(0x302c20), fog: false })),
    black: own(new MeshBasicMaterial({ color: 0x050505, fog: false })),
    white: own(new MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6, fog: false })),
    blade: own(new MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.25, metalness: 0.9, fog: false })),
    bulb: own(new MeshBasicMaterial({ color: 0x9fd8ff, fog: false })),
    bottle: own(new MeshStandardMaterial({ color: 0x7a2418, roughness: 0.2, metalness: 0.1, emissive: new Color(0x2a0602), fog: false })),
  }
  const camo = own(camoTex())
  // Pack-a-Punch: every material of a gun gets a camo twin, made once per source material.
  const camoOf = new Map()
  const camoMat = (m) => {
    if (!m || m.isMeshBasicMaterial) return m
    let c = camoOf.get(m)
    if (!c) {
      c = own(m.clone())
      c.map = camo
      c.color = new Color(0xffffff)
      c.emissive = new Color(0x2a1060)
      c.emissiveMap = camo
      c.metalness = 0.5
      c.roughness = 0.35
      c.needsUpdate = true
      camoOf.set(m, c)
    }
    return c
  }
  const gunT = buildGunTemplates(M)
  placeOddParts(gunT)
  const pupT = buildPowerupTemplates(M)
  for (const t of [...Object.values(gunT), ...Object.values(pupT)]) t.traverse((o) => { if (o.geometry) own(o.geometry) })

  const flashTexture = own(flashTex())
  const glowTexture = own(glowTex())
  // A manifest sprite for the muzzle flash, when fx.json names one; else the procedural star.
  const texLoader = new TextureLoader()
  const texCache = new Map()
  const spriteTex = (p) => {
    const u = assetUrl(p && /\.(png|webp|jpg)$/i.test(p) ? p : p ? `_fx/${p}.png` : null)
    if (!u) return flashTexture
    if (!texCache.has(u)) {
      const t = texLoader.load(u, undefined, undefined, () => { texCache.set(u, flashTexture) })
      t.colorSpace = SRGBColorSpace
      own(t)
      texCache.set(u, t)
    }
    return texCache.get(u)
  }
  // fx.muzzle_flash may be a file name/path ("_fx/muzzle_flash.png") or anything truthy (then the
  // conventional _fx/muzzle_flash.png).
  const manifestFlash = (a) => {
    const v = a && a.fx && (a.fx.muzzle_flash || a.fx.muzzleflash)
    if (!v) return null
    return spriteTex(typeof v === 'string' ? v : 'muzzle_flash')
  }
  let defaultFlashSprite = manifestFlash(assets) || flashTexture
  const flashMat = (tex) => own(new SpriteMaterial({ map: tex, color: 0xffffff, blending: AdditiveBlending, transparent: true, depthWrite: false, fog: false }))

  // ---- glb templates (weapons and power-ups), loaded on first use, cached by URL
  const loader = new GLTFLoader()
  const glbs = new Map()   // url -> { state: 'loading'|'ready'|'failed', scene }
  const glb = (u) => {
    if (!u) return null
    let e = glbs.get(u)
    if (!e) {
      e = { state: 'loading', scene: null }
      glbs.set(u, e)
      loader.loadAsync(u).then((g) => { e.scene = g.scene; e.state = 'ready' }).catch(() => { e.state = 'failed' })
    }
    return e
  }
  const weaponEntry = (name, raw) => {
    const W = assets && assets.weapons
    if (!W) return null
    for (const k of weaponKeys(name, raw)) if (W[k]) return W[k]
    return null
  }

  // What to draw for (name, pap, raw): a key that changes when the picture does, and what to build.
  // Memoised per (name, raw, pap) so the per-frame call allocates nothing; an entry made while its
  // glb was still loading is recomputed once the load settles, and all of it on setAssets().
  const visCache = new Map()
  function visualFor(name, pap, raw) {
    const ck = `${name}|${raw}|${pap ? 1 : 0}`
    const hit = visCache.get(ck)
    if (hit && !(hit.pending && hit.pending.state !== 'loading')) return hit.v
    const w = weaponEntry(name, raw)
    const cls = weaponClass(name, WEAPONS, raw)
    let v = null
    let pending = null
    if (w) {
      const u = assetUrl(pap && w.pap && w.pap.glb ? w.pap.glb : w.glb)
      const e = glb(u)
      if (e && e.state === 'ready') {
        const camoIt = pap && !(w.pap && w.pap.glb)
        v = { key: `glb:${u}:${camoIt ? 'pap' : ''}`, cls, glbScene: e.scene, camo: camoIt, muzzleTag: (w.muzzle && w.muzzle.tag) || 'tag_flash', sprite: w.muzzle && w.muzzle.sprite }
      } else if (e && e.state === 'loading') pending = e
    }
    if (!v) v = { key: `proc:${cls}:${pap ? 'pap' : ''}`, cls, glbScene: null, camo: !!pap && cls !== 'none' && cls !== 'bottle', muzzleTag: null, sprite: w && w.muzzle && w.muzzle.sprite }
    visCache.set(ck, { v, pending })
    return v
  }

  function buildVisual(v) {
    let obj
    let muzzle = null
    if (v.glbScene) {
      obj = v.glbScene.clone(true)
      obj.traverse((o) => { if (o.name === v.muzzleTag && !muzzle) muzzle = o })
      if (!muzzle) {
        // No tag_flash: the front of the model's box, at its middle height.
        tmpBox.setFromObject(obj)
        muzzle = new Group()
        muzzle.position.set(tmpBox.max.x, (tmpBox.min.y + tmpBox.max.y) / 2, (tmpBox.min.z + tmpBox.max.z) / 2)
        obj.add(muzzle)
      }
    } else {
      obj = gunT[v.cls] ? gunT[v.cls].clone(true) : gunT.rifle.clone(true)
      muzzle = obj.getObjectByName('muzzle')
    }
    obj.traverse((o) => {
      if (!o.isMesh) return
      o.frustumCulled = false
      if (v.camo) o.material = Array.isArray(o.material) ? o.material.map(camoMat) : camoMat(o.material)
    })
    return { obj, muzzle }
  }

  // ---- held weapons, one slot each
  const slots = new Map()   // slot -> { holder, key, gun, muzzle, flash }
  function slotGear(slot) {
    let s = slots.get(slot)
    if (s) return s
    const holder = new Group()
    holder.rotation.order = 'YZX'
    root.add(holder)
    const flash = new Sprite(flashMat(defaultFlashSprite))
    flash.visible = false
    flash.renderOrder = 5
    s = { holder, key: '', gun: null, muzzle: null, flash, cls: 'rifle' }
    slots.set(slot, s)
    return s
  }
  function setGun(s, v) {
    if (s.key === v.key) return
    if (s.gun) s.holder.remove(s.gun)
    const b = buildVisual(v)
    s.gun = b.obj
    s.muzzle = b.muzzle
    s.cls = v.cls
    s.key = v.key
    s.holder.add(s.gun)
    ;(s.muzzle || s.gun).add(s.flash)
    if (v.sprite) s.flash.material.map = spriteTex(v.sprite)
  }

  // A seeded 0..1 from a shot's time, so the flash's size/roll is the same every time that
  // frame is drawn (scrub-exact) and differs shot to shot.
  const seeded = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x) }

  /**
   * Per frame. `list` is the viewer's sampled players ({ slot, x, y, z, yaw, pitch, alive, stance });
   * `state(slot)` -> { name, pap, fireAge, fireMs, show } from the reducer.
   */
  function update(list, state, focus, eyes) {
    for (const s of slots.values()) s.holder.visible = false
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      const st = state(p.slot)
      if (!st || !st.name || !p.alive || (eyes && p.slot === focus)) continue
      const s = slotGear(p.slot)
      setGun(s, visualFor(st.name, st.pap, st.raw))
      s.holder.visible = true
      const h = actors && actors.handOf ? actors.handOf(p.slot) : null
      const yaw = (p.yaw || 0) * Math.PI / 180
      const pitch = (p.pitch || 0) * Math.PI / 180
      if (h && h.bone && h.root && h.root.parent && h.root.parent.visible !== false) {
        h.bone.updateWorldMatrix(true, false)
        h.bone.getWorldPosition(tmpV)
        root.worldToLocal(tmpV)
        if (h.isTag) {
          // Lane R2's tag_weapon: the weapon glb is authored in its frame.
          h.bone.getWorldQuaternion(tmpQ)
          s.holder.position.copy(tmpV)
          s.holder.quaternion.copy(tmpQ)
          continue
        }
        // A wrist: the grip sits ~3 u further along the aim.
        tmpE.set(0, yaw, -pitch, 'YZX')
        tmpV2.set(3, 0, 0).applyEuler(tmpE)
        s.holder.position.copy(tmpV).add(tmpV2)
        s.holder.rotation.set(0, yaw, -pitch, 'YZX')
      } else {
        // Capsules: chest height, a hand's width right of centre, a little forward.
        toThree(p.x, p.y, p.z, tmpV)
        const hgt = p.stance === 'crouch' ? 30 : p.stance === 'prone' ? 8 : 44
        tmpE.set(0, yaw, 0, 'YZX')
        tmpV2.set(14, hgt, 8).applyEuler(tmpE)
        s.holder.position.copy(tmpV).add(tmpV2)
        s.holder.rotation.set(0, yaw, -pitch, 'YZX')
      }
    }
    // Flashes last: visibility depends on the holder being shown.
    for (const [slot, s] of slots) {
      if (!s.holder.visible) { s.flash.visible = false; continue }
      const st = state(slot)
      const on = st && st.fireAge < 60 && !NO_FLASH.has(s.cls)
      s.flash.visible = !!on
      if (on) {
        const r = seeded(st.fireMs || 0)
        const k = 1 - st.fireAge / 60
        s.flash.scale.setScalar((s.cls === 'pistol' ? 7 : s.cls === 'mg' ? 13 : 10) * (0.75 + 0.5 * r) * (0.6 + 0.4 * k))
        s.flash.material.rotation = r * Math.PI * 2
        s.flash.position.set(s.flash.scale.x * 0.35, 0, 0)
      }
    }
  }

  // ---- the first-person weapon (camera space: x right, y up, -z forward)
  const vm = new Group()
  vm.name = 'r3-viewmodel'
  const vmInner = new Group()
  vmInner.rotation.y = Math.PI / 2   // our +X barrel -> camera -Z
  vm.add(vmInner)
  const vmFlash = new Sprite(flashMat(defaultFlashSprite))
  vmFlash.visible = false
  const VM_REST = { x: 6.5, y: -6.5, z: -10 }
  vm.position.set(VM_REST.x, VM_REST.y, VM_REST.z)
  const vmState = { key: '', gun: null, muzzle: null, cls: 'rifle', kick: 0, phase: 0 }
  function setViewmodelWeapon(name, pap, raw) {
    const v = visualFor(name || 'm1garand', !!pap, name ? raw : null)
    if (vmState.key === v.key) return
    if (vmState.gun) vmInner.remove(vmState.gun)
    const b = buildVisual(v)
    vmState.gun = b.obj
    vmState.muzzle = b.muzzle
    vmState.cls = v.cls
    vmState.key = v.key
    // A long gun pulled back so its muzzle is in frame; a pistol pushed forward.
    const back = { none: 0, bottle: 4, rifle: -10, mg: -12, spread: -9, launcher: -8, wonder: -6, flame: -6, smg: -4, pistol: 2, raygun: 2, grenade: 4, melee: 4 }[v.cls] || -6
    vmState.gun.position.set(back, 0, 0)
    vmInner.add(vmState.gun)
    ;(vmState.muzzle || vmState.gun).add(vmFlash)
    if (v.sprite) vmFlash.material.map = spriteTex(v.sprite)
  }
  setViewmodelWeapon('m1garand', false)
  /**
   * @param fireAge ms since the focused player's last recorded shot (Infinity: none yet), or
   *   null when the file has no fire events for them -- then `held` (the attack button is down)
   *   kicks it the old way (§8.7).
   */
  function updateViewmodel(fireAge, fireMs, held, dt) {
    const recorded = fireAge !== null && fireAge !== undefined
    if (recorded) {
      vmState.kick = fireAge < 90 ? 1 - fireAge / 90 : 0
    } else {
      if (held) { vmState.phase += dt; if (vmState.phase >= 0.1 || vmState.kick === 0) { vmState.phase = 0; vmState.kick = 1 } } else vmState.phase = 0
      vmState.kick = Math.max(0, vmState.kick - dt * 12)
    }
    const k = vmState.kick
    vm.position.set(VM_REST.x, VM_REST.y + k * 0.4, VM_REST.z + k * 2.2)
    vm.rotation.x = k * 0.12
    const on = recorded ? fireAge < 60 : k > 0.6
    vmFlash.visible = on && !NO_FLASH.has(vmState.cls)
    if (vmFlash.visible) {
      const r = seeded(fireMs || 0)
      vmFlash.scale.setScalar((vmState.cls === 'pistol' ? 5 : 7) * (0.75 + 0.5 * r))
      vmFlash.material.rotation = r * Math.PI * 2
      vmFlash.position.set(vmFlash.scale.x * 0.3, 0, 0)
    }
  }

  // ---- power-ups on the floor
  const PUP_MAX = 12
  const pups = []
  for (let i = 0; i < PUP_MAX; i++) {
    const holder = new Group()
    holder.visible = false
    const spin = new Group()
    holder.add(spin)
    const glow = new Sprite(own(new SpriteMaterial({ map: glowTexture, color: 0xffffff, blending: AdditiveBlending, transparent: true, depthWrite: false, fog: false })))
    glow.scale.setScalar(34)
    holder.add(glow)
    root.add(holder)
    pups.push({ holder, spin, glow, key: '', model: null })
  }
  function pupVisual(kind) {
    const a = assets && assets.powerups && assets.powerups[kind]
    const u = assetUrl(a && a.glb)
    const e = glb(u)
    if (e && e.state === 'ready') return { key: `glb:${u}`, build: () => e.scene.clone(true) }
    return { key: `proc:${kind}`, build: () => (pupT[kind] || pupT.other).clone(true) }
  }
  /** @param list fx.powerupsAt()'s pooled list; tSec the replay clock (bob and spin). */
  function setPowerups(list, tSec) {
    for (let i = 0; i < PUP_MAX; i++) {
      const slot = pups[i]
      const p = list[i]
      if (!p) { slot.holder.visible = false; continue }
      const v = pupVisual(p.kind)
      if (slot.key !== v.key) {
        if (slot.model) slot.spin.remove(slot.model)
        slot.model = v.build()
        slot.model.traverse((o) => { if (o.isMesh) o.frustumCulled = false })
        slot.spin.add(slot.model)
        slot.key = v.key
      }
      toThree(p.x, p.y, p.z, slot.holder.position)
      // WaW's drops hover about a foot and a half up, bob and turn.
      const ph = tSec + (Number(p.id) || 0) * 0.7
      slot.holder.position.y += 22 + 3 * Math.sin(ph * 3)
      slot.spin.rotation.y = ph * 1.8
      slot.holder.visible = !p.blink
    }
  }

  function dispose() {
    api.scene.remove(root)
    for (const x of owned) { try { x.dispose() } catch { /* already gone */ } }
    for (const e of glbs.values()) {
      if (!e.scene) continue
      e.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) { if (m) { if (m.map) m.map.dispose(); m.dispose() } }
      })
    }
  }

  /** The manifest arrived (or changed): glbs are looked up from now on; placeholders until they load. */
  function setAssets(a) {
    assets = a || null
    visCache.clear()
    const t = manifestFlash(assets)
    if (t) {
      defaultFlashSprite = t
      for (const s of slots.values()) s.flash.material.map = t
      vmFlash.material.map = t
    }
  }

  return {
    root, update, setPowerups, dispose, setAssets,
    viewmodel: vm, setViewmodelWeapon, updateViewmodel,
    // ?r3ddebug (window.__r3d.fx()): what is drawn right now, for the render check (replay.md §12).
    info: () => ({
      slots: [...slots.entries()].map(([k, s]) => ({ slot: k, key: s.key, shown: s.holder.visible, flash: s.flash.visible })),
      vm: vmState.key, vmFlash: vmFlash.visible,
      pickups: pups.filter((p) => p.holder.visible).map((p) => p.key),
      glbs: [...glbs.entries()].map(([u, e]) => [u, e.state]),
    }),
  }
}
