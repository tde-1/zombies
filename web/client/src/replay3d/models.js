// Player and zombie models for the replay (replay.md §9).
//
// The meshes are the game's own xmodels -- the four Marines, the four heroes, the stock
// zombie bodies with their heads, the hellhound -- unlinked from B's install by
// tools/models/export_models.py and served beside the map exports at /mapdata/_models/
// (never committed: they are Treyarch's). Each .glb is a glTF SKIN on the T4 humanoid rig,
// bind pose, with the parts the game attaches (head, helmet, gear, hat) already merged onto
// the body's skeleton. models.json says which model is which and which set each map uses.
//
// FRAME AND SCALE. Unlinker writes Y-up with the engine's +X forward and engine inches,
// which is exactly scene.js's toThree ((x, y, z) -> (x, z, -y)), so a model is placed at
// toThree(origin) and turned by the recorded yaw about three's Y -- nothing is rescaled.
// The world shell's 2.54x (replay.md §8.12) was Husky's centimetres; these never went
// through Husky, and their height (71-73 u, the 70-u hull plus a helmet) is the check.
//
// MOTION. The track has no animation state (§3, §8.4: position, yaw, stance bits, alive),
// so the gait is procedural: the legs, arms and spine are swung about the character's own
// lateral axis by a phase that is the DISTANCE WALKED along the track (scrub-exact: the
// same time always gives the same pose), with an amplitude from the speed. A zombie leans
// and reaches; a player carries. The xanims are in the zone (582 of them) and OAT dumps
// them, but only as the engine's binary; reading those is the next step, not this one.
import { Group, Vector3, Quaternion, Color } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'

export const MODELS_BASE = '/mapdata/_models'
// One full gait cycle (two steps) per this many inches walked. WaW's walk is ~ 30 u a step.
const STRIDE = 64
const Z_AXIS = new Vector3(0, 0, 1)   // the character's lateral axis in model space (glTF +Z)
const tmpQ = new Quaternion()
const tmpQ2 = new Quaternion()

/**
 * Choose the set for a map and load its models. Never rejects: a missing manifest or a
 * failed .glb returns null (or leaves that template out) and the caller keeps its capsules.
 *
 * @returns {Promise<null | { set, source, templates: Map<string, object>, manifest }>}
 */
export async function loadModelSet(map, { base = MODELS_BASE, slots = null, dogs = false } = {}) {
  let manifest
  try {
    const r = await fetch(`${base}/models.json`, { cache: 'no-cache' })
    if (!r.ok) return null
    manifest = await r.json()
  } catch { return null }
  // Which set: a stock map's own; else what the custom map's fastfile carries
  // (export_models.py classify_customs); else the default (Marines + Nacht zombies).
  const lower = (o) => { const m = new Map(); for (const k of Object.keys(o || {})) m.set(k.toLowerCase(), o[k]); return m }
  const key = String(map || '').toLowerCase()
  let set = lower(manifest.maps).get(key)
  let source = 'stock'
  if (!set) { set = lower(manifest.customs).get(key); if (set) source = 'custom' }
  if (!set) { set = manifest.default; source = 'default' }
  if (!set) return null
  // Only what this replay can show: the players' own models (by slot, the rule actors.js
  // uses), every zombie variant, and the hellhound only when the track marks dogs.
  const ps = set.players || []
  const playerIds = slots && ps.length ? slots.map((s) => ps[((s % ps.length) + ps.length) % ps.length]) : ps
  const want = new Set([...playerIds, ...(set.zombies || []), ...(dogs ? (set.dogs || []) : [])])
  const v = encodeURIComponent(manifest.built_at || '')
  const loader = new GLTFLoader()
  const templates = new Map()
  await Promise.all([...want].map(async (id) => {
    const m = manifest.models && manifest.models[id]
    if (!m) return
    try {
      const g = await loader.loadAsync(`${base}/${m.url}?v=${v}`)
      templates.set(id, { id, gltf: g, info: m })
    } catch { /* this one stays a capsule */ }
  }))
  if (!templates.size) return null
  return { set, source, templates, manifest }
}

// Bones the gait drives. A name the rig lacks is skipped (the hellhound has none of them).
const DRIVEN = ['j_mainroot', 'j_spinelower', 'j_spineupper', 'j_neck', 'j_head',
  'j_hip_le', 'j_hip_ri', 'j_knee_le', 'j_knee_ri', 'j_ankle_le', 'j_ankle_ri',
  'j_shoulder_le', 'j_shoulder_ri', 'j_elbow_le', 'j_elbow_ri']

/**
 * One instance of a template: its own skeleton (SkeletonUtils.clone -- a plain clone would
 * share bones), and for every driven bone its bind rotation and the lateral axis expressed
 * in that bone's own frame, so a swing is "about the character's side-to-side axis" whatever
 * the bone's local convention is.
 */
export function makeActor(tpl) {
  const inner = cloneSkinned(tpl.gltf.scene)
  const root = new Group()           // placed at the origin, turned by yaw
  const body = new Group()           // tilted for prone / down / death, bobbed
  body.add(inner)
  root.add(body)
  root.name = `model:${tpl.id}`
  inner.updateMatrixWorld(true)
  const bones = {}
  // Lane R3 (§12): where a held weapon goes. `wrist` (j_wrist_ri) is what gear.js uses, with R2's
  // measured palm frame (assets-pipeline.md §3: tag_weapon_right is animated and sits by the hip in
  // the bind pose). `hand` is the fallback for a rig without a wrist bone: first match wins.
  const HAND = ['tag_weapon', 'tag_weapon_right', 'j_gun', 'j_wrist_ri']
  let hand = null
  let handRank = HAND.length
  let wrist = null
  inner.traverse((o) => {
    const r = HAND.indexOf(o.name)
    if (r >= 0 && r < handRank) { hand = o; handRank = r }
    if (o.name === 'j_wrist_ri' && !wrist) wrist = o
  })
  inner.traverse((o) => {
    if (o.isSkinnedMesh) {
      o.frustumCulled = false
      o.castShadow = false
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) {
        if (!m || m.userData.enwTuned) continue
        // Readable on a night map: a little of the albedo as emission, and no fog, the same
        // rule the capsules had (§8.4: "I cannot see the zombies" was half of B's complaint).
        if (m.map) { m.emissiveMap = m.map; m.emissive = new Color(0.32, 0.32, 0.32) }
        m.fog = false
        m.userData.enwTuned = true
      }
    }
    if (o.isBone && DRIVEN.includes(o.name) && !bones[o.name]) {
      const wq = o.getWorldQuaternion(new Quaternion())
      bones[o.name] = { bone: o, bind: o.quaternion.clone(), axis: Z_AXIS.clone().applyQuaternion(wq.invert()).normalize() }
    }
  })
  return { id: tpl.id, kind: tpl.info.kind, height: tpl.info.height || 72, root, body, bones, hand, handIsTag: handRank === 0, wrist }
}

function swing(a, name, rad) {
  const b = a.bones[name]
  if (!b) return
  b.bone.quaternion.copy(b.bind).multiply(tmpQ.setFromAxisAngle(b.axis, rad))
}

/**
 * Pose an actor for this instant. Pure function of its arguments.
 *
 * @param s { phase (inches walked), speed (u/s), stance 'stand'|'crouch'|'prone',
 *            down (player not alive), death (seconds since a zombie died, or null), t (s) }
 */
export function poseActor(a, s) {
  const ph = (s.phase / STRIDE) * Math.PI * 2
  const amp = Math.min(1, Math.max(0, (s.speed - 6) / 110))
  const sin = Math.sin(ph)
  const zombie = a.kind === 'zombie'
  const body = a.body
  body.position.set(0, 0, 0)
  body.rotation.set(0, 0, 0)

  // Legs: hips swing opposite, the knee bends on the forward swing, the ankle follows.
  let hipL = 0.42 * amp * sin
  let hipR = -hipL
  let kneeL = -(0.12 + 0.75 * Math.max(0, Math.sin(ph + Math.PI * 0.5))) * amp
  let kneeR = -(0.12 + 0.75 * Math.max(0, Math.sin(ph + Math.PI * 1.5))) * amp
  let ankL = 0.15 * amp * Math.max(0, -sin)
  let ankR = 0.15 * amp * Math.max(0, sin)
  // Bob: lowest at mid-stride.
  body.position.y = -1.4 * amp * Math.abs(Math.cos(ph))
  let spine = zombie ? -0.14 - 0.05 * amp : -0.04 * amp
  spine += 0.015 * Math.sin(s.t * 1.7)                    // breathing, so a still body is alive
  let shL, shR, elL, elR
  if (zombie) {
    // The reach: upper arms raised toward the front, forearms brought level, swaying with the step.
    shL = 1.0 + 0.12 * Math.sin(ph + 0.6) + 0.04 * Math.sin(s.t * 1.3)
    shR = 1.0 + 0.12 * Math.sin(ph + 0.6 + Math.PI) + 0.04 * Math.sin(s.t * 1.1 + 1)
    elL = -0.75
    elR = -0.75
    if (s.death != null) {
      // The arms drop as it falls.
      const k = Math.min(1, s.death / 0.55)
      shL = shL * (1 - k) + 0.25 * k
      shR = shR * (1 - k) + 0.1 * k
      elL *= 1 - k
      elR *= 1 - k
    }
  } else {
    // A player carries a weapon: the bind pose already has the forearms forward; swing a little.
    shL = -0.12 * amp * sin
    shR = 0.12 * amp * sin
    elL = 0
    elR = 0
  }
  if (s.stance === 'crouch' && !s.down) {
    hipL += 1.05; hipR += 1.05; kneeL -= 1.75; kneeR -= 1.75; ankL += 0.7; ankR += 0.7
    body.position.y -= 18
    spine -= 0.25
  }
  swing(a, 'j_spinelower', spine * 0.6)
  swing(a, 'j_spineupper', spine * 0.4)
  swing(a, 'j_hip_le', hipL)
  swing(a, 'j_hip_ri', hipR)
  swing(a, 'j_knee_le', kneeL)
  swing(a, 'j_knee_ri', kneeR)
  swing(a, 'j_ankle_le', ankL)
  swing(a, 'j_ankle_ri', ankR)
  swing(a, 'j_shoulder_le', shL)
  swing(a, 'j_shoulder_ri', shR)
  swing(a, 'j_elbow_le', elL)
  swing(a, 'j_elbow_ri', elR)
  if (zombie) swing(a, 'j_head', 0.12)

  if (a.kind === 'dog') {
    // No gait for the dog's rig: a trot bob and a nod.
    body.position.y = -1.2 * amp * Math.abs(Math.sin(ph * 2))
    body.rotation.z = 0.04 * amp * Math.sin(ph * 2)
  }
  if (s.stance === 'prone' && !s.down) {
    // Face down along the facing, feet at the origin.
    body.rotation.z = -Math.PI / 2
    body.position.y = 6
  }
  if (s.down) {
    // Down (last stand) or out: on the ground, on the back. The track does not say which.
    body.rotation.z = Math.PI / 2 * 0.92
    body.position.y = 5
    body.position.x = 8
  }
  if (s.death != null) {
    // A zombie killed in the track: a simple fall backwards over 0.55 s, then it sinks
    // into the floor and is gone by 2 s (no ragdoll, no corpse state in the recording).
    const k = Math.min(1, s.death / 0.55)
    body.rotation.z = (Math.PI / 2) * 0.95 * k * k
    body.position.y = 4 * k - Math.max(0, s.death - 1.2) * 40
  }
}

/** Deterministic variant for a zombie track: the same zombie always wears the same body. */
export function variantOf(key, n) {
  let h = 2166136261
  const s = String(key)
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) % Math.max(1, n)
}
