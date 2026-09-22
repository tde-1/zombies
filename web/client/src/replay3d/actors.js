// The zombies layer on top of ENW Movement's scene.js.
//
// scene.js is ported verbatim and it draws exactly one player -- Movement is a
// speedrunning site and a KZ run has one runner in it. A zombies game has up to
// four players and up to 31 zombies, so this module adds the rest as its own
// objects in the same scene and the same frame. scene.js is not edited: every
// change to it is a change we would have to re-apply the next time Movement's
// viewer improves.
//
// The one player scene.js already owns stays the *focused* player, driven by
// `setPose`, because that is what the eye / follow / free cameras all read. This
// module hides that capsule for the focused slot (it would draw twice) and draws
// every other slot itself.
//
// COORDINATES. Everything here goes through scene.js's own `toThree`, which is
// (x, y, z) -> (x, z, -y): engine Z-up, inches, into three's Y-up. Nothing is
// scaled. A position out of `snap.players[].pos` is used exactly as recorded.
import {
  Group, Mesh, MeshStandardMaterial, CapsuleGeometry, InstancedMesh, Object3D,
  Color, Sprite, SpriteMaterial, CanvasTexture, RingGeometry, MeshBasicMaterial,
  DoubleSide, SphereGeometry, BoxGeometry, CylinderGeometry, AdditiveBlending, ConeGeometry,
} from 'three'
import { toThree } from './scene.js'
import { HULL } from './waw.js'

// WaW's hull, not Source's (replay.md §8.11): r15 x 70 standing, 50 crouched, 30 prone
// (bg_pmove). An AI zombie uses the same 15 x 70 box. Every actor below is sized from these.
const STAND_H = HULL.stand
const CAPSULE_R = HULL.radius

// Slot colours. Four, distinguishable at a glance and distinguishable from the
// zombies, which are the one colour that must never be mistaken for a player.
export const SLOT_COLORS = ['#5ec6ff', '#ffd166', '#8ce99a', '#ff9ec6']
// Red, not the old mud brown: on Nacht's night lighting the brown read as part of the
// floor, and "I cannot see the zombies" was half of B's complaint (replay.md §8.4).
const ZOMBIE_COLOR = 0xc8402c
const MAX_ZOMBIES = 64        // the sampler's own cap (replay.cpp kMaxZombies)

function nameplate(text, color) {
  // A canvas sprite rather than CSS overlay: it sorts with the scene, so a
  // nameplate behind a wall is behind the wall.
  const pad = 10
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')
  ctx.font = '600 34px Inter, Segoe UI, sans-serif'
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2
  c.width = w
  c.height = 56
  const g = c.getContext('2d')
  g.font = '600 34px Inter, Segoe UI, sans-serif'
  g.fillStyle = 'rgba(11,13,18,.72)'
  g.fillRect(0, 0, w, 56)
  g.fillStyle = color
  g.fillRect(0, 52, w, 4)
  g.fillStyle = '#ffffff'
  g.textBaseline = 'middle'
  g.fillText(text, pad, 26)
  const tex = new CanvasTexture(c)
  const sp = new Sprite(new SpriteMaterial({ map: tex, depthTest: true, transparent: true }))
  // Sprite scale is world units, and the map is in inches: 56 px tall reads as
  // about 22 inches, a little under a head.
  sp.scale.set(w * 0.42, 56 * 0.42, 1)
  return sp
}

/**
 * @param api the object createScene() returned
 */
export function createActors(api) {
  const { scene } = api
  const group = new Group()
  scene.add(group)

  const players = new Map()   // slot -> { group, capsule, plate, disc }

  function player(slot, name) {
    if (players.has(slot)) return players.get(slot)
    const color = SLOT_COLORS[slot % SLOT_COLORS.length]
    const g = new Group()
    const capsule = new Mesh(
      new CapsuleGeometry(CAPSULE_R, STAND_H - CAPSULE_R * 2, 6, 16),
      new MeshStandardMaterial({ color: new Color(color), roughness: 0.55, metalness: 0.05, fog: false }),
    )
    capsule.position.y = STAND_H / 2
    capsule.userData.h = STAND_H
    const disc = new Mesh(
      new RingGeometry(CAPSULE_R * 1.15, CAPSULE_R * 1.5, 24),
      new MeshBasicMaterial({ color: new Color(color), transparent: true, opacity: 0.35, side: DoubleSide, fog: false }),
    )
    disc.rotation.x = -Math.PI / 2
    disc.position.y = 1
    const plate = nameplate(name || `Slot ${slot}`, color)
    plate.position.y = STAND_H + 26
    g.add(capsule, disc, plate)
    group.add(g)
    const rec = { group: g, capsule, plate, disc, color }
    players.set(slot, rec)
    return rec
  }

  // Zombies are one InstancedMesh. 31 separate Meshes is 31 draw calls a frame
  // for objects that are all the same capsule, and the whole reason the viewer
  // can hold 60 fps on a software renderer is that the draw-call count stays
  // near the map's.
  const zGeo = new CapsuleGeometry(CAPSULE_R * 0.9, STAND_H - CAPSULE_R * 2, 4, 10)
  const zMat = new MeshStandardMaterial({ color: ZOMBIE_COLOR, roughness: 0.9, fog: false })
  const zombies = new InstancedMesh(zGeo, zMat, MAX_ZOMBIES)
  zombies.count = 0
  zombies.frustumCulled = false
  group.add(zombies)
  // Facing (§8.11 / B's ask 2): a pale wedge at head height pointing the way the zombie
  // faces -- the recorded yaw when the file has it (DLL 2026-09-22 late), otherwise its
  // direction of travel. Same instancing, one more draw call.
  const noseGeo = new ConeGeometry(3.5, 14, 6)
  noseGeo.rotateZ(-Math.PI / 2)          // point along +X, which is engine yaw 0
  noseGeo.translate(CAPSULE_R + 5, 0, 0)
  const noses = new InstancedMesh(noseGeo, new MeshBasicMaterial({ color: 0xe8a090, fog: false }), MAX_ZOMBIES)
  noses.count = 0
  noses.frustumCulled = false
  group.add(noses)
  const dummy = new Object3D()

  /**
   * @param list [{ slot, name, x, y, z, alive }] in ENGINE coordinates
   * @param focus the slot scene.js is driving with setPose (hidden here)
   */
  function setPlayers(list, focus) {
    const seen = new Set()
    for (const p of list) {
      seen.add(p.slot)
      const rec = player(p.slot, p.name)
      const v = toThree(p.x, p.y, p.z)
      rec.group.position.copy(v)
      // Down but not out is drawn translucent rather than removed: where a
      // player went down is most of what a zombies replay is watched for.
      const dead = p.alive === false
      // Stance height (§8.11): the capsule is scaled to the pose's hull height, feet fixed.
      const h = p.height || STAND_H
      if (rec.capsule.userData.h !== h) {
        rec.capsule.userData.h = h
        rec.capsule.scale.y = h / STAND_H
        rec.capsule.position.y = h / 2
        rec.plate.position.y = h + 26
      }
      rec.capsule.material.opacity = dead ? 0.28 : 0.92
      rec.capsule.material.transparent = true
      rec.disc.visible = !dead
      rec.group.visible = p.slot !== focus
    }
    for (const [slot, rec] of players) if (!seen.has(slot)) rec.group.visible = false
  }

  /** @param list [{ x, y, z, yaw }] in ENGINE coordinates; yaw in degrees, CCW from +X */
  function setZombies(list) {
    const n = Math.min(list.length, MAX_ZOMBIES)
    let m = 0
    for (let i = 0; i < n; i++) {
      const v = toThree(list[i].x, list[i].y, list[i].z)
      dummy.position.set(v.x, v.y + STAND_H / 2, v.z)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      zombies.setMatrixAt(i, dummy.matrix)
      if (list[i].yaw != null && Number.isFinite(list[i].yaw)) {
        // engine (cos y, sin y, 0) -> three (cos y, 0, -sin y): a rotation of +yaw about three's Y.
        dummy.position.set(v.x, v.y + STAND_H - 10, v.z)
        dummy.rotation.set(0, list[i].yaw * Math.PI / 180, 0)
        dummy.updateMatrix()
        noses.setMatrixAt(m++, dummy.matrix)
      }
    }
    zombies.count = n
    zombies.instanceMatrix.needsUpdate = true
    noses.count = m
    noses.instanceMatrix.needsUpdate = true
  }

  // Grenades (replay.md §8.6): small dark spheres, one InstancedMesh like the zombies,
  // and a pool of short-lived additive fireballs where a grenade track ends.
  const MAX_NADES = 16
  const nades = new InstancedMesh(new SphereGeometry(3, 10, 8),
    new MeshStandardMaterial({ color: 0x3d4a2a, roughness: 0.6, fog: false }), MAX_NADES)
  nades.count = 0
  nades.frustumCulled = false
  group.add(nades)
  /** @param list [{ x, y, z }] in ENGINE coordinates */
  function setNades(list) {
    const n = Math.min(list.length, MAX_NADES)
    for (let i = 0; i < n; i++) {
      const v = toThree(list[i].x, list[i].y, list[i].z)
      dummy.position.set(v.x, v.y + 3, v.z)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      nades.setMatrixAt(i, dummy.matrix)
    }
    nades.count = n
    nades.instanceMatrix.needsUpdate = true
  }
  const booms = []
  for (let i = 0; i < 8; i++) {
    const m = new Mesh(new SphereGeometry(1, 16, 12),
      new MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, fog: false }))
    m.visible = false
    group.add(m)
    booms.push(m)
  }
  /** @param list [{ x, y, z, age }] age in seconds since the explosion, 0..0.8 */
  function setExplosions(list) {
    for (let i = 0; i < booms.length; i++) {
      const b = booms[i]
      const e = list[i]
      if (!e) { b.visible = false; continue }
      const k = Math.min(1, e.age / 0.8)
      const v = toThree(e.x, e.y, e.z)
      b.position.set(v.x, v.y + 20, v.z)
      b.scale.setScalar(20 + 180 * k)   // WaW frag radius is 256; the ball grows most of it
      b.material.opacity = 0.85 * (1 - k)
      b.visible = true
    }
  }

  function setNames(byslot) {
    for (const [slot, rec] of players) {
      const want = byslot[slot]
      if (!want || rec.plate.userData.text === want) continue
      rec.group.remove(rec.plate)
      rec.plate = nameplate(want, rec.color)
      rec.plate.position.y = STAND_H + 26
      rec.plate.userData.text = want
      rec.group.add(rec.plate)
    }
  }

  function setNameplatesVisible(on) {
    for (const rec of players.values()) rec.plate.visible = on
  }

  function dispose() {
    scene.remove(group)
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) {
        if (!m) continue
        if (m.map) m.map.dispose()
        m.dispose()
      }
    })
  }

  return { group, setPlayers, setZombies, setNades, setExplosions, setNames, setNameplatesVisible, dispose }
}

/**
 * The map's own sky dome, ridden on the camera.
 *
 * A WaW map does not carry a six-face 2D skybox the way a Source map does -- it
 * carries `skyboxmodel "<xmodel>"` on worldspawn, a real dome mesh with the
 * map's moon and clouds painted on it. tools/maps/export_map.py emits it as a
 * node called `__sky`, so this finds it, takes it out of the depth buffer, and
 * pins it to the camera. Without the pin the player walks out of the dome.
 *
 * Returns a per-frame function, or null when the map has no sky node.
 */
export function installSkyDome(api) {
  let sky = null
  api.scene.traverse((o) => { if (o.name === '__sky') sky = o })
  if (!sky) return null
  const parent = sky.parent
  sky.traverse((o) => {
    if (!o.isMesh) return
    o.frustumCulled = false
    o.renderOrder = -1
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue
      m.depthWrite = false
      m.depthTest = false
      m.fog = false
      m.toneMapped = false
    }
  })
  const { camera } = api
  return function updateSky() {
    // The dome lives inside the map group, which is rotated -90 about X, so the
    // camera's world position has to come back through that rotation or the sky
    // tracks the camera along the wrong axis and shears past the horizon.
    parent.worldToLocal(sky.position.copy(camera.position))
  }
}

/**
 * The placeholder first-person gun (replay.md §8.7). Built from three primitives so there
 * is no downloaded asset and no licence question; it is NOT a WaW viewmodel and never
 * will be. Camera space, Source/CoD units: x right, y up, -z forward.
 *
 * Returns { object, update(fire, dt) }: `fire` true kicks it back and shows the flash.
 */
export function createPlaceholderGun() {
  const g = new Group()
  g.name = 'placeholder-gun'
  const metal = new MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.45, metalness: 0.6 })
  const wood = new MeshStandardMaterial({ color: 0x5a3b22, roughness: 0.8, metalness: 0 })
  const body = new Mesh(new BoxGeometry(2.2, 2.6, 12), metal)
  body.position.set(0, 0, -2)
  const barrel = new Mesh(new CylinderGeometry(0.45, 0.45, 12, 10), metal)
  barrel.rotation.x = Math.PI / 2
  barrel.position.set(0, 0.6, -13)
  const stock = new Mesh(new BoxGeometry(2, 3.4, 8), wood)
  stock.position.set(0, -1.2, 6)
  const grip = new Mesh(new BoxGeometry(1.8, 4, 2), wood)
  grip.position.set(0, -3, 1)
  grip.rotation.x = 0.35
  const flash = new Mesh(new SphereGeometry(1.6, 10, 8),
    new MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }))
  flash.position.set(0, 0.6, -20)
  flash.visible = false
  g.add(body, barrel, stock, grip, flash)
  const rest = { x: 7, y: -7.5, z: -14 }
  g.position.set(rest.x, rest.y, rest.z)
  let kick = 0
  let phase = 0
  return {
    object: g,
    update(fire, dt) {
      if (fire) {
        phase += dt
        // ~10 rounds a second while the trigger is held: a kick on every cycle.
        if (phase >= 0.1 || kick === 0) { phase = 0; kick = 1 }
      } else phase = 0
      kick = Math.max(0, kick - dt * 12)
      g.position.set(rest.x, rest.y + kick * 0.4, rest.z + kick * 2.2)
      g.rotation.x = kick * 0.12
      flash.visible = kick > 0.6
      flash.scale.setScalar(0.6 + Math.random() * 0.8)
    },
  }
}
