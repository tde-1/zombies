// First-person arms + the gun's own viewmodel, posed by the gun's idle and ADS animations
// (lane RV, replay.md §14). The asset pack (tools/models/export_assets.py) serves:
//   _weapons/viewhands_<id>.glb   the arms, skinned (bind pose), root bone tag_view
//   _weapons/fp_poses.json        { poses: { "<idle anim>@first": { bones: { name: [q|null, t|null] } },
//                                            "<adsUp anim>@all": { seq: [ { name: [q|null, t|null] }, ...every frame ] } } }
//   weapons[w].fp / .pap.fp       { idle, ads (pose keys), standMove [F,R,U], adsZoomFov, adsInMs, adsOutMs }
//   weapons[w].viewGlb / .pap.viewGlb  the gun's viewmodel (static, R2), root = its j_gun
// How the engine builds the view: the arms' tag_view sits at the eye; the gun's root bone j_gun
// hangs on the arms' tag_weapon; the weapon's viewmodel anims move every bone (the idle frame for
// most bones; adsUpAnim, SCRUBBED by the aim fraction, for the bones it moves -- frame 0 is the hip,
// the last frame the sights -- as the engine does). Anim values are bone-LOCAL in the
// engine's frame (X forward, Y left, Z up); the .glb's root bone carries the Y-up turn, so only
// the root needs it composed in.
//
// Nothing here can break the viewer: until the arms, the poses and the gun's viewmodel are all
// loaded, `ready` is false and gear.js keeps drawing its placeholder.
import { Group, Quaternion, Vector3, Object3D } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { blendBone, adsSeqSample } from './fpmath.js'

// glTF's Y-up turn of an engine-frame root: -90 deg about X (every Unlinker skeleton's root).
const Y_UP = new Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2)
// And back, for a static R2 viewmodel (built in that Y-up frame) hung on an engine-frame bone.
const Y_UP_INV = new Quaternion(Math.SQRT1_2, 0, 0, Math.SQRT1_2)
const tmpQ = new Quaternion()
const tmpV = new Vector3()
const scratch = { q: [0, 0, 0, 1], t: [0, 0, 0] }

export function createFpHands(mapdata = '/mapdata') {
  const url = (p) => (!p ? null : /^(https?:)?\//.test(p) ? p : `${mapdata}/${String(p).replace(/^\.?\//, '')}`)
  const loader = new GLTFLoader()
  const root = new Group()
  root.name = 'r3-fphands'
  root.visible = false
  // Camera space is x right, y up, -z forward; the pack's Y-up frame is +X forward, so a quarter
  // turn about Y (gear.js does the same for its placeholder).
  const inner = new Group()
  inner.rotation.y = Math.PI / 2
  root.add(inner)
  // Room for a stance offset (duckedOfs / proneOfs, not modelled yet); zero at a stand.
  const offset = new Group()
  inner.add(offset)

  let assets = null
  let arms = null          // { scene, bones: Map(name -> Object3D), bind: Map(name -> {q,t}), root }
  let armsState = 'none'   // none | loading | ready | failed
  let poses = null
  let posesState = 'none'
  const guns = new Map()   // url -> { state, scene }
  let cur = { key: '', fp: null, gun: null, url: null, muzzle: null }
  const jgun = new Object3D()
  jgun.name = 'r3-jgun'
  let onChange = null

  function loadArms() {
    if (armsState !== 'none' || !assets) return
    const id = assets.viewhandsDefault
    const vh = id && assets.viewhands && assets.viewhands[id]
    if (!vh || !vh.glb) { armsState = 'failed'; return }
    armsState = 'loading'
    loader.loadAsync(url(vh.glb)).then((g) => {
      const bones = new Map()
      const bind = new Map()
      g.scene.traverse((o) => {
        if (o.isBone || (o.name && /^(tag_|j_)/.test(o.name))) {
          if (!bones.has(o.name)) {
            bones.set(o.name, o)
            bind.set(o.name, { q: o.quaternion.toArray(), t: o.position.toArray() })
          }
        }
        if (o.isMesh) { o.frustumCulled = false; o.renderOrder = 1 }
      })
      const rootBone = [...bones.values()].find((b) => !b.parent || !bones.has(b.parent.name))
      arms = { scene: g.scene, bones, bind, root: rootBone ? rootBone.name : 'tag_view' }
      offset.add(g.scene)
      const tw = bones.get('tag_weapon')
      if (tw) tw.add(jgun)
      armsState = 'ready'
      if (onChange) onChange()
    }).catch(() => { armsState = 'failed'; if (onChange) onChange() })
  }
  function loadPoses() {
    if (posesState !== 'none' || !assets || !assets.fpPoses) { if (!assets || !assets.fpPoses) posesState = 'failed'; return }
    posesState = 'loading'
    fetch(url(assets.fpPoses)).then((r) => (r.ok ? r.json() : null)).then((j) => {
      poses = j && j.poses ? j.poses : null
      posesState = poses ? 'ready' : 'failed'
      if (onChange) onChange()
    }).catch(() => { posesState = 'failed'; if (onChange) onChange() })
  }
  function gunGlb(u) {
    let e = guns.get(u)
    if (!e) {
      e = { state: 'loading', scene: null }
      guns.set(u, e)
      loader.loadAsync(u).then((g) => { e.scene = g.scene; e.state = 'ready'; if (onChange) onChange() })
        .catch(() => { e.state = 'failed'; if (onChange) onChange() })
    }
    return e
  }

  /** The manifest arrived: first-person loads start only when setWeapon() is first called. */
  function setAssets(a) { assets = a || null }

  /**
   * The watched player's gun: the manifest's weapon entry (fx.js assetWeapon) and whether it is
   * upgraded. null entry = a gun the pack does not have (then gear.js's placeholder is drawn).
   */
  function setWeapon(entry, pap) {
    if (!assets || !entry) { cur.key = ''; cur.fp = null; return }
    loadArms()
    loadPoses()
    const v = pap && entry.pap ? entry.pap : entry
    const fp = v.fp || entry.fp || null
    const u = url(v.viewGlb || entry.viewGlb)
    const key = `${u}|${fp ? fp.idle : ''}|${fp ? fp.ads : ''}`
    if (key === cur.key && cur.gun) return
    cur.key = key
    cur.fp = fp
    cur.url = u
    const e = u ? gunGlb(u) : null
    if (cur.gun) { jgun.remove(cur.gun); cur.gun = null; cur.muzzle = null }
    if (e && e.state === 'ready') {
      const holder = new Group()
      holder.quaternion.copy(Y_UP_INV)
      const g = e.scene.clone(true)
      g.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.renderOrder = 1 } })
      holder.add(g)
      jgun.add(holder)
      cur.gun = holder
      cur.muzzle = holder.getObjectByName('tag_flash') || null
    } else if (e && e.state === 'loading') {
      cur.key = ''          // try again next frame, once it lands
    }
  }

  /** Whether the real arms + gun can be drawn for the current weapon. */
  function ready() {
    return armsState === 'ready' && posesState === 'ready' && !!cur.gun && !!cur.fp && !!(poses && poses[cur.fp.idle])
  }

  /** Pose everything for ADS fraction `frac` (0 hip .. 1 sights). */
  // One bone's value: from the ADS anim, scrubbed by the aim fraction, where that anim moves it
  // (tag_torso: frame 0 is the hip, the last frame the sights); from the idle frame otherwise.
  const seqAt = { a: 0, b: 0, t: 0 }
  function boneValue(name, bind, idle, seq) {
    if (seq && seq[0][name]) {
      return blendBone(bind, seq[seqAt.a][name], seq[seqAt.b][name], seqAt.t, scratch)
    }
    return idle && idle[name] ? blendBone(bind, idle[name], undefined, 0, scratch) : null
  }
  const ID = { q: [0, 0, 0, 1], t: [0, 0, 0] }

  function update(frac) {
    root.visible = ready()
    if (!root.visible) return false
    const idle = poses[cur.fp.idle] && poses[cur.fp.idle].bones
    const seq = cur.fp.ads && poses[cur.fp.ads] && poses[cur.fp.ads].seq && poses[cur.fp.ads].seq.length ? poses[cur.fp.ads].seq : null
    adsSeqSample(seq ? seq.length : 0, frac, seqAt)
    for (const [name, bone] of arms.bones) {
      const bind = arms.bind.get(name)
      const isRoot = name === arms.root
      const v = boneValue(name, isRoot ? ID : bind, idle, seq)
      if (!v) { bone.quaternion.fromArray(bind.q); bone.position.fromArray(bind.t); continue }
      if (isRoot) {
        // The root's bind carries the Y-up turn: compose the anim's engine-frame value into it.
        tmpQ.fromArray(v.q)
        bone.quaternion.copy(Y_UP).multiply(tmpQ)
        bone.position.fromArray(v.t).applyQuaternion(Y_UP)
        continue
      }
      bone.quaternion.fromArray(v.q)
      bone.position.fromArray(v.t)
    }
    // The gun's root on tag_weapon: the anim's j_gun (identity when it has none).
    const jv = boneValue('j_gun', ID, idle, seq)
    if (jv) {
      jgun.quaternion.fromArray(scratch.q)
      jgun.position.fromArray(scratch.t)
    } else { jgun.quaternion.identity(); jgun.position.set(0, 0, 0) }
    // No stance offset at a stand: the weapon file's standMove* is the pull while MOVING (its
    // siblings are duckedOfs*/proneOfs* for the stance), which the replay does not model yet.
    offset.position.set(0, 0, 0)
    return true
  }

  function info() {
    return { arms: armsState, poses: posesState, ready: ready(), weapon: cur.url, idle: cur.fp && cur.fp.idle, ads: cur.fp && cur.fp.ads,
      guns: [...guns.entries()].map(([u, e]) => [u, e.state]) }
  }

  function dispose() {
    root.removeFromParent()
    const kill = (s) => s && s.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) { if (m) { if (m.map) m.map.dispose(); m.dispose() } }
    })
    if (arms) kill(arms.scene)
    for (const e of guns.values()) kill(e.scene)
  }

  return {
    root, setAssets, setWeapon, update, ready, info, dispose,
    get muzzle() { return cur.muzzle },
    get fp() { return cur.fp },
    set onChange(f) { onChange = f },
    worldPos: (out) => root.getWorldPosition(out || tmpV),
  }
}
