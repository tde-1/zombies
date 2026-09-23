// Replay 3D — the three.js side. Imperative: ReplayViewer.jsx owns time, the decoded replay
// and the DOM; this module owns the WebGL scene (map, zones, player capsule, three cameras)
// and is driven by setPose()/setCamera()/render(). Everything three lives here so the main
// bundle never imports it: this file is only ever reached through import().
//
// Units: Source units throughout (no scaling). Axes: Source (x, y, z) -> three (x, z, -y),
// which is a -90 degree rotation about X applied to the map group and to every converted
// point. three's +Y is up.

// Named, not `import * as THREE`. three's entry point is a barrel of side-effectful class
// declarations, so a namespace import defeats rollup's tree-shaking entirely and every
// geometry, loader and WebXR helper in the library ships: measured at 778.0 kB raw / 164.4 kB
// brotli against 611.5 / 127.9 for exactly this list. The names are then collected into a
// local THREE object so the ~200 `THREE.X` call sites below read unchanged — the object is
// built from the bindings, so only what is listed here is reachable and only it is bundled.
//
// Adding a `THREE.Something` anywhere in this file means adding Something here too, or it is
// undefined at runtime rather than caught at build time — and note that the list is NOT only
// what `THREE.` reads: studioEnvironmentTexture takes the object as a parameter and reads six
// more names off it, and audio.js reads Raycaster and Vector3 off the exported `scene.THREE`.
// scripts/replay3d/check-three-imports.js walks both kinds and fails on a gap.
import {
  AdditiveBlending, Box3, BoxGeometry, BufferAttribute, BufferGeometry, CapsuleGeometry, ClampToEdgeWrapping,
  Color, CubeTexture, CylinderGeometry, DataTexture, DirectionalLight, DoubleSide, EdgesGeometry,
  EquirectangularReflectionMapping, Float32BufferAttribute, FloatType, Fog, GridHelper, Group,
  HemisphereLight, InstancedBufferAttribute,
  LinearFilter, LinearSRGBColorSpace, Line, LineBasicMaterial, LineSegments, MathUtils, Matrix3, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PMREMGenerator, PerspectiveCamera, PlaneGeometry,
  RGBAFormat, Ray, Raycaster, RingGeometry, SRGBColorSpace, Scene, ShaderChunk, TextureLoader, Vector3,
  WebGLRenderer,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { createSkywall, isSkywallName } from './skywall.js'

const THREE = {
  AdditiveBlending, Box3, BoxGeometry, BufferAttribute, BufferGeometry, CapsuleGeometry, ClampToEdgeWrapping,
  Color, CubeTexture, CylinderGeometry, DataTexture, DirectionalLight, DoubleSide, EdgesGeometry,
  EquirectangularReflectionMapping, Float32BufferAttribute, FloatType, Fog, GridHelper, Group,
  HemisphereLight, InstancedBufferAttribute,
  LinearFilter, LinearSRGBColorSpace, Line, LineBasicMaterial, LineSegments, MathUtils, Matrix3, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PMREMGenerator, PerspectiveCamera, PlaneGeometry,
  RGBAFormat, Ray, Raycaster, RingGeometry, SRGBColorSpace, Scene, ShaderChunk, TextureLoader, Vector3,
  WebGLRenderer,
}

// The layer the 3D skybox draws on. It is rendered as its OWN pass, before the world and with
// the depth buffer cleared between the two, which is exactly what the engine does — so nothing
// in the miniature can ever win a depth test against real map geometry, however the two overlap
// once the miniature is scaled up over the level. Layer 0 is everything else.
const SKY_LAYER = 1

// `fogmaxdensity` is a cap on how much fog a pixel can take, and three's Fog has no such thing:
// its factor runs to 1 at fogFar and there is no uniform to hold it back. Half the maps that
// carry fog at all set it (24 of the 54 in the replay-holding set, down to 0.1 on surf_summit),
// and on those the difference is not subtle — a map that meant "distance goes 10% hazy" would
// otherwise go solid.
//
// So the cap is compiled INTO the fog chunk as a literal, once, when a map's fog lands. This is
// the whole patch: three's fog_fragment ends in one mix() whose third argument is the factor.
// A map with no cap (or no fog) puts the stock chunk back, so nothing about a map without
// fogmaxdensity is touched. ShaderChunk is module state on the three instance this file
// imports — one viewer at a time owns it, which is how the viewer already works.
const FOG_MIX = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );'
const FOG_FRAGMENT_STOCK = THREE.ShaderChunk.fog_fragment
function fogChunkFor(maxDensity) {
  if (!(maxDensity > 0) || maxDensity >= 1) return FOG_FRAGMENT_STOCK
  return FOG_FRAGMENT_STOCK.replace(FOG_MIX, FOG_MIX.replace('fogFactor );', `fogFactor * ${maxDensity.toFixed(5)} );`))
}

export const STAND_H = 72
export const DUCK_H = 54
export const EYE_STAND = 64
export const EYE_DUCK = 46
export const CAPSULE_R = 16

// Tool textures: faces the engine never draws. TOOLSSKYBOX is the exception — the engine draws
// the SKY there and writes depth, so hiding it turns a staged map's dividing wall into a window
// onto the next arena. Those faces become sky occluders instead (replay3d/skywall.js).
const TOOLS_HIDDEN_RE = /toolsskybox|toolsskybox2d|toolsnodraw|toolstrigger|toolsclip|toolsplayerclip|toolsinvisible|toolsskip|toolshint/i

// The six sky faces in the Source frame. The names are Quake 2's, which Source kept, and
// they do NOT mean what they say: rt is +X, ft is -Y, lf is -X, bk is +Y (gl_warp.c: face
// order +X -X +Y -Y +Z -Z takes suffixes rt lf bk ft up dn). Each entry gives, as seen from
// INSIDE the box, which world direction the image's right edge and top edge point to; the
// face sits on the axis those two span. Checked against sky148's pixels: every shared edge
// matches its neighbour with no mirroring and no rotation once placed this way (ft's right
// column is lf's left column, up's bottom row is rt's top row, and so on).
export const SKY_FACES = [
  { face: 'rt', right: [0, -1, 0], up: [0, 0, 1] },   // +X
  { face: 'lf', right: [0, 1, 0], up: [0, 0, 1] },    // -X
  { face: 'bk', right: [1, 0, 0], up: [0, 0, 1] },    // +Y
  { face: 'ft', right: [-1, 0, 0], up: [0, 0, 1] },   // -Y
  { face: 'up', right: [0, -1, 0], up: [-1, 0, 0] },  // +Z
  { face: 'dn', right: [0, -1, 0], up: [1, 0, 0] },   // -Z
]
const SKY_HALF = 30000

const DEG = Math.PI / 180

// A Source FOV (fov, viewmodel_fov) is the HORIZONTAL angle at 4:3; wider screens keep the
// vertical angle and widen (view.cpp ScaleFOVByWidthRatio). three's PerspectiveCamera.fov is
// vertical, so: vfov = 2 atan(tan(h/2) * 3/4). 90 -> 73.7, 60 -> 46.8.
export function sourceFovToVertical(h) {
  return 2 * Math.atan(Math.tan(h * DEG / 2) * 0.75) / DEG
}

// Source -> three point.
export function toThree(x, y, z, out) {
  const v = out || new THREE.Vector3()
  v.set(x, z, -y)
  return v
}

// Source view angles (pitch, yaw) -> unit forward vector in three space.
// Source: forward = (cos p cos y, cos p sin y, -sin p), pitch positive = looking down.
export function forwardOf(pitch, yaw, out) {
  const p = pitch * DEG
  const y = yaw * DEG
  const cp = Math.cos(p)
  return toThree(cp * Math.cos(y), cp * Math.sin(y), -Math.sin(p), out)
}

// A neutral studio, as an equirectangular HDR strip, for the viewmodel pass to reflect.
// Written here rather than taken from three's RoomEnvironment because that room is a lit
// interior with coloured emitters: reflected off a Damascus blade it came out mint green
// (measured mean [0.573, 0.618, 0.569] against Valve's own item render's [0.640, 0.660,
// 0.675]). Everything below is neutral by construction, so a steel blade reflects grey and
// reads as steel. Linear radiance, so values above 1 are allowed and are what make a
// specular highlight.
//   sky    0.35 overhead falling to 0.12 at the horizon, and a 0.04 floor: a DARK surround,
//          so a blade has something dark to be shaped against
//   band   a bright ring at +40 elevation running through every longitude -- a softbox. It
//          has to be a full ring, not a disc: the viewmodel camera carries the runner's yaw,
//          so a single light placed in world space is in the blade's reflection for one
//          heading and behind it for the next, and a disc measurably did nothing.
//   keys   two small, very bright discs on the ring, for the streak
//
// The ring is what separates a Damascus blade from a Doppler one. At roughness 0.45 the
// PMREM chain has spread it over most of the blade, which is the silver; at 0.14 it stays a
// streak on near-black, which is the sheen.
function studioEnvironmentTexture(THREEns) {
  const W = 256
  const H = 128
  const data = new Float32Array(W * H * 4)
  const disc = (lon, lat, cLon, cLat, radius, peak) => {
    // angular distance on the sphere, then a smooth falloff to the disc's edge
    const d = Math.acos(Math.max(-1, Math.min(1,
      Math.sin(lat) * Math.sin(cLat) + Math.cos(lat) * Math.cos(cLat) * Math.cos(lon - cLon))))
    if (d >= radius) return 0
    const t = 1 - d / radius
    return peak * t * t
  }
  const D = Math.PI / 180
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * Math.PI          // +pi/2 up .. -pi/2 down
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI
      const up = Math.sin(lat)
      let v = up > 0 ? 0.15 + 0.30 * up : 0.05
      const dLat = (lat - 40 * D) / (11 * D)
      v += 8.5 * Math.exp(-dLat * dLat)                        // the softbox ring
      v += disc(lon, lat, -35 * D, 40 * D, 9 * D, 40.0)        // two streak keys on it
      v += disc(lon, lat, 120 * D, 40 * D, 9 * D, 40.0)
      const i = (y * W + x) * 4
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 1
    }
  }
  const tex = new THREEns.DataTexture(data, W, H, THREEns.RGBAFormat, THREEns.FloatType)
  tex.mapping = THREEns.EquirectangularReflectionMapping
  tex.colorSpace = THREEns.LinearSRGBColorSpace
  tex.minFilter = THREEns.LinearFilter
  tex.magFilter = THREEns.LinearFilter
  tex.needsUpdate = true
  return tex
}

export function isWebGL2Available() {
  try {
    const c = document.createElement('canvas')
    return !!(window.WebGL2RenderingContext && c.getContext('webgl2'))
  } catch (e) { return false }
}

// Who is doing the drawing. The Steam in-game overlay browser is modern Chromium, so WebGL2
// EXISTS there and the viewer runs — but its web views are composited through gameoverlayui
// and a heavy scene gets no GPU fast path: the frames are rasterised on the CPU (SwiftShader)
// and a map this size comes out at single-digit frames per second. Nothing in the page says
// so — the only honest witness is the GL renderer string, and it has to be read off a
// throwaway context BEFORE the real one exists, because antialiasing is a context-creation
// attribute and the one cost setAutoQuality's ladder cannot take back afterwards.
let glRendererInfo = null
export function probeGLRenderer() {
  if (glRendererInfo) return glRendererInfo
  let name = ''
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      name = String((ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '')
      const lose = gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
    }
  } catch (e) { /* an unreadable probe is an unknown renderer, not a software one */ }
  glRendererInfo = { name, software: /swiftshader|software|llvmpipe|softpipe|basic render/i.test(name) }
  return glRendererInfo
}

export function createScene(canvas, opts) {
  // opts.software: the probe's word. A software renderer gets NO MSAA from the start — four
  // samples per pixel is the single most expensive thing this renderer asks of a CPU.
  const software = !!(opts && opts.software)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !software, powerPreference: 'high-performance' })
  // alpha, premultipliedAlpha and preserveDrawingBuffer are all left at three's defaults on
  // purpose: false, true, false. An alpha or preserved drawing buffer is the pair of context
  // attributes that costs Firefox the most -- both take the canvas off the compositor's fast
  // path -- and nothing here reads the buffer back, so there is nothing to ask for.
  //
  // The cap is 2 on every engine. A Gecko-only 1.5 was tried and REVERTED on the measurement:
  // on surf_4am with the camera parked on 1197 draw calls, scene.render() is 10.7 ms of a
  // 12.5 ms frame in Waterfox and 9.4 ms in Edge, so the frame is draw-call bound, not
  // fill bound, and pixel ratio 1 -> 2 did not cost what a fill-bound scene would. Capping
  // Gecko lower bought no measurable frame time and spent real sharpness on a HiDPI screen.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0d12)
  // The viewer's own distance haze, which every map got and still gets until the map's OWN
  // env_fog_controller lands (setFog). A map that carries no fog controller keeps exactly this.
  scene.fog = new THREE.Fog(0x0b0d12, 6000, 22000)
  const DEFAULT_FOG = { color: 0x0b0d12, near: 6000, far: 22000 }
  // What shows where nothing is drawn. It is the RENDERER's clear colour rather than
  // `scene.background` once the 3D skybox has its own pass, because a scene background that is
  // a Color force-clears on EVERY render call whatever `autoClear` says (three's
  // WebGLBackground) — which wiped the skybox pass and left the whole horizon one flat colour.
  const background = new THREE.Color(0x0b0d12)
  function applyBackground() {
    renderer.setClearColor(background, 1)
    scene.background = state.skyTwoPass ? null : background
    skywall.setBackground(background)
  }

  // Near 8, not 1. A 24-bit depth buffer's resolution at distance z is about z^2 / (near * 2^24),
  // so a near plane of 1 over a 50 000-unit map cannot separate two surfaces a unit apart once
  // they are 4 000 units away — which is exactly the pairs of coplanar brush faces the map is
  // full of (see loadMap: they are drawn double-sided, so both are there to be confused). Eight
  // units back is 0.12 units of resolution at that distance instead of 0.95, which covers the
  // 0.46-1.0 unit separations measured on surf_zae's ramps and surf_andromeda's floors, and 8
  // units is a quarter of the player's own width — nothing a camera behind the eyes can reach.
  const camera = new THREE.PerspectiveCamera(90, 1, 8, 50000)

  // World light: no shadows, no lightmaps (VRAD's are in the BSP but the exporter drops them).
  // What there is: the map's own light_environment as the sun (colour, direction, relative
  // brightness -- setLighting, from entities.json), a hemisphere whose sky/ground colours come
  // from _ambient and the sky cube's dn face, and the sky cube itself as an image-based
  // environment (setSky) so the ambient carries the sky's hue and its bright side. A map with
  // no light_environment (an indoor map) keeps the neutral studio pair below. The intensities
  // are chosen so the total is close to the flat pair this replaced (hemi 1.4 + sun 0.9), and
  // they step down once the environment is in (applyLights).
  const hemi = new THREE.HemisphereLight(0xdfe6f2, 0x2a2f3a, 1.4)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xffffff, 0.9)
  sun.position.set(2000, 6000, 3000)
  scene.add(sun)
  const lighting = { env: null, sky: null, ground: null, hasEnvironment: false }
  const LIGHT_DEFAULT = { hemiSky: new THREE.Color(0xdfe6f2), hemiGround: new THREE.Color(0x2a2f3a), sunPos: new THREE.Vector3(2000, 6000, 3000) }
  function applyLights() {
    const le = lighting.env
    // With the sky environment lighting the world too, the analytic pair steps down to keep
    // the overall level where it was.
    const k = lighting.hasEnvironment ? 0.55 : 1
    if (le) {
      sun.color.copy(le.color)
      // _light brightness is a relative scale in VRAD (200-300 is a normal outdoor sun).
      // 0.006 per unit puts 200 at 1.2: measured on snakeskin (sun 12 degrees off vertical),
      // 2.0 lifted the marble floor by a third over the flat pair while the walls barely
      // moved -- a near-overhead sun is a floor light. The clamp keeps a mapper's 40 or 900
      // within reason.
      sun.intensity = THREE.MathUtils.clamp(le.brightness * 0.006, 0.5, 2.4) * (lighting.hasEnvironment ? 0.85 : 1)
      // The light travels along sunDir; the light sits the other way.
      toThree(-le.dir[0] * 20000, -le.dir[1] * 20000, -le.dir[2] * 20000, sun.position)
      hemi.color.copy(le.ambient || lighting.sky || LIGHT_DEFAULT.hemiSky)
      hemi.groundColor.copy(lighting.ground || LIGHT_DEFAULT.hemiGround)
      // The walls' light. _ambient's brightness (20 on snakeskin) is not used as a scale:
      // VRAD's ambient also gathers the sky's own radiance, which is most of what lights a
      // wall in game, and at 0.44 the walls measured half of what they were.
      hemi.intensity = 1.3 * (lighting.hasEnvironment ? 0.85 : 1)
    } else {
      sun.color.set(0xffffff)
      sun.intensity = 0.9 * k
      sun.position.copy(LIGHT_DEFAULT.sunPos)
      hemi.color.copy(LIGHT_DEFAULT.hemiSky)
      hemi.groundColor.copy(lighting.ground || LIGHT_DEFAULT.hemiGround)
      hemi.intensity = 1.4 * k
    }
  }

  // Map group: Source coords inside, rotated to three's Y-up.
  const mapGroup = new THREE.Group()
  mapGroup.rotation.x = -Math.PI / 2
  scene.add(mapGroup)

  // Placeholder ground: a grid in Source XY at the replay's lowest z (set by setGrid).
  const grid = new THREE.GridHelper(16384, 128, 0x3a4150, 0x22262f)
  grid.visible = false
  scene.add(grid)

  // Sky: an inverted box in the Source frame (so its faces sit on Source axes), following the
  // camera every frame, drawn first behind everything. Faces arrive later via setSky().
  const skyGroup = new THREE.Group()
  skyGroup.rotation.x = -Math.PI / 2
  scene.add(skyGroup)
  const skyMats = SKY_FACES.map(() => new THREE.MeshBasicMaterial({ color: 0x0b0d12, depthWrite: false, depthTest: false, fog: false }))
  // The map's own toolsskybox faces, drawn as sky and writing depth. Same six textures as the
  // dome and the same table, so the two match across every boundary; they arrive with setSky().
  const skywall = createSkywall(0x0b0d12)
  const skyBox = new THREE.Group()
  skyBox.visible = false
  skyGroup.add(skyBox)
  {
    const right = new THREE.Vector3(), up = new THREE.Vector3(), normal = new THREE.Vector3()
    SKY_FACES.forEach((f, i) => {
      // A plane whose local +X is the image's right, +Y its top, so +Z (their cross) faces
      // the viewer at the centre; the face sits SKY_HALF behind it along -Z.
      right.fromArray(f.right); up.fromArray(f.up); normal.crossVectors(right, up)
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * SKY_HALF, 2 * SKY_HALF), skyMats[i])
      m.matrixAutoUpdate = false
      m.matrix.makeBasis(right, up, normal).setPosition(-normal.x * SKY_HALF, -normal.y * SKY_HALF, -normal.z * SKY_HALF)
      m.renderOrder = -1
      m.frustumCulled = false
      skyBox.add(m)
    })
  }

  // Zones (translucent boxes) live in a Source-space group too.
  const zoneGroup = new THREE.Group()
  zoneGroup.rotation.x = -Math.PI / 2
  scene.add(zoneGroup)

  // Player: capsule + a view line from eye height. Built in three space directly.
  const player = new THREE.Group()
  // The runner, the view line and the ground disc are MARKERS, not map surfaces: they say where
  // the run is and must read the same at every distance, so none of them takes the map's fog.
  const capMat = new THREE.MeshStandardMaterial({ color: 0x5ec6ff, roughness: 0.55, metalness: 0.05, transparent: true, opacity: 0.92, fog: false })
  const standGeo = new THREE.CapsuleGeometry(CAPSULE_R, STAND_H - 2 * CAPSULE_R, 6, 16)
  const duckGeo = new THREE.CapsuleGeometry(CAPSULE_R, DUCK_H - 2 * CAPSULE_R, 6, 16)
  const capsule = new THREE.Mesh(standGeo, capMat)
  player.add(capsule)
  const viewGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)])
  const viewLine = new THREE.Line(viewGeo, new THREE.LineBasicMaterial({ color: 0xffd166, fog: false }))
  player.add(viewLine)
  // Small ground disc so height off the floor reads in Follow cam.
  const disc = new THREE.Mesh(new THREE.RingGeometry(CAPSULE_R * 0.7, CAPSULE_R * 1.1, 24), new THREE.MeshBasicMaterial({ color: 0x5ec6ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, fog: false }))
  disc.rotation.x = -Math.PI / 2
  player.add(disc)
  scene.add(player)

  // ---- viewmodel: a second scene drawn on top of the world in Eyes cam (standard FPS
  // two-pass: world with the world camera, clear depth, viewmodel with its own camera at
  // `viewmodelFov`, so the hands do not clip into walls and the FOV is the game's
  // viewmodel_fov, not the world FOV). The `viewmodel` group is a child of the viewmodel
  // camera — camera space, x right, y up, -z forward, Source units — and it follows the
  // recorded pitch/yaw because the camera does. It is EMPTY here: the skins round attaches
  // the arms + knife via setViewmodel(). Skipped in Follow/Free cams.
  const vmScene = new THREE.Scene()
  // 60 is the game's shipped viewmodel_fov: viewmodel_presetpos defaults to 1 "Desktop",
  // whose callback (view.cpp ViewmodelPresetPos_Callback) sets viewmodel_fov 60 and
  // viewmodel_offset 1/1/-1. 68 belongs to preset 3 "Classic", which pairs it with offset
  // 2.5/0/-1.5 — carrying 68 alongside the Desktop offset drew the weapon too small.
  const vmCamera = new THREE.PerspectiveCamera(sourceFovToVertical(90), 1, 0.5, 400)
  const viewmodel = new THREE.Group()
  viewmodel.name = 'viewmodel'
  vmCamera.add(viewmodel)
  vmScene.add(vmCamera)
  // The viewmodel's own lights (the baked albedos are dark; CS:GO lights the viewmodel in
  // the engine): a hemisphere for ambient, a key from above-right and a soft fill from the
  // left, all riding the camera. Directional lights aim at their target, so each targets the
  // viewmodel group (also a camera child) — a default world-origin target would swing the
  // light as the runner moves.
  vmScene.add(new THREE.HemisphereLight(0xf4f6fa, 0x4a505c, 2.8))
  // An environment for the viewmodel pass. A CS:GO knife material is `$envmap env_cubemap`
  // with `$phong 1` and `$phongalbedotint 1` — most of what makes a blade read as steel is
  // reflected surroundings and a broad specular lobe, neither of which two directional
  // lights can produce. Without an environment a metal in three's standard material has no
  // diffuse and nothing to reflect, so it goes black; that is why the knives had to be
  // rendered as near-dielectrics and came out flat. The studio above is procedural — no
  // external file, no fetch, nothing to 404 — and PMREM-filtered once, here, where the
  // renderer is (a PMREM texture belongs to the renderer that built it). It sits in world
  // space, which is what `$envmap env_cubemap` does too: the highlight sweeps across a blade
  // as the runner turns, instead of being painted on.
  //
  // It is deliberately NOT `vmScene.environment`. A scene environment lights every standard
  // material in the pass, and three overrides each material's own `envMapIntensity` with
  // `scene.environmentIntensity` whenever `material.envMap === null`
  // (WebGLRenderer, setProgram) — so a scene environment cannot be opted out of, and it
  // measurably brightened the arms and gloves, which are settled. Instead the texture is
  // handed only to materials that asked for it by name in setViewmodel().
  const vmEnvironment = (() => {
    const pmrem = new THREE.PMREMGenerator(renderer)
    const src = studioEnvironmentTexture(THREE)
    const t = pmrem.fromEquirectangular(src).texture
    src.dispose()
    pmrem.dispose()
    return t
  })()
  {
    const key = new THREE.DirectionalLight(0xfff8f0, 3.6)
    key.position.set(1.2, 1.6, 0.6)
    key.target = viewmodel
    vmCamera.add(key)
    const fill = new THREE.DirectionalLight(0xe6edff, 1.4)
    fill.position.set(-1.4, 0.4, 0.8)
    fill.target = viewmodel
    vmCamera.add(fill)
  }
  let vmVisible = true

  // ---- state
  const state = {
    mode: 'follow', // 'free' | 'follow' | 'eyes'
    // player pose in Source space
    origin: new THREE.Vector3(),
    pitch: 0, yaw: 0,
    ducked: false,
    // free cam
    freePos: new THREE.Vector3(0, 300, 600),
    freeYaw: 0, freePitch: 0,
    // follow cam orbit
    orbitYaw: 180, orbitPitch: -20, orbitDist: 220,
    followSet: false,
    keys: new Set(),
    mapLoaded: false,
    mapBounds: null,
    // Frame cap for the caller's loop: 0 = the display rate. setMaxFps(); ?fps=<n> in the
    // viewer sets it. renderCount is how many frames actually drew (a paused, untouched
    // viewer must not add to it — the loop only renders on change).
    maxFps: 0,
    renderCount: 0,
    // The adaptive quality governor's current ladder level (setAutoQuality). 0 is full cost.
    qualityLevel: 0,
  }

  const tmpV = new THREE.Vector3()
  const tmpF = new THREE.Vector3()
  const eyeV = new THREE.Vector3()

  function playerEyeThree(out) {
    return toThree(state.origin.x, state.origin.y, state.origin.z + eyeHeight(), out)
  }

  // ENW ZOMBIES (replay.md §8.11, position accuracy): Movement's constants are Source's --
  // eye 64 / 46, hull 72 x r16. A WaW player's eye is 60 / 40 / 11 (stand / crouch / prone)
  // and the hull is r15 x 70 / 50 / 30 (bg_pmove). `body` = { eye, height, radius } overrides
  // them per pose; without it this is Movement's code path, unchanged.
  function eyeHeight() {
    if (state.body) return state.body.eye
    return state.ducked ? EYE_DUCK : EYE_STAND
  }

  function setPose(ox, oy, oz, pitch, yaw, ducked, body) {
    state.origin.set(ox, oy, oz)
    state.pitch = pitch
    state.yaw = yaw
    state.body = body || null
    if (body) {
      state.ducked = !!ducked
      capsule.geometry = standGeo
      capsule.scale.set(body.radius / CAPSULE_R, body.height / STAND_H, body.radius / CAPSULE_R)
    } else if (ducked !== state.ducked) {
      state.ducked = ducked
      capsule.geometry = ducked ? duckGeo : standGeo
    }
    if (!body) capsule.scale.set(1, 1, 1)
    const h = body ? body.height : (ducked ? DUCK_H : STAND_H)
    toThree(ox, oy, oz, player.position)
    capsule.position.set(0, h / 2, 0)
    disc.position.set(0, 0.5, 0)
    // view line from eye, 48 units along the look direction
    const eyeH = eyeHeight()
    forwardOf(pitch, yaw, tmpF)
    const pos = viewGeo.attributes.position
    pos.setXYZ(0, 0, eyeH, 0)
    pos.setXYZ(1, tmpF.x * 48, eyeH + tmpF.y * 48, tmpF.z * 48)
    pos.needsUpdate = true
    // Follow cam's first frame sits behind the runner.
    if (!state.followSet) { state.orbitYaw = yaw + 180; state.followSet = true }
  }

  function setMode(mode) {
    if (mode === state.mode) return
    if (mode === 'free') {
      // Take over from wherever the camera is now.
      state.freePos.copy(camera.position)
      const dir = camera.getWorldDirection(tmpV)
      state.freePitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) / DEG
      state.freeYaw = Math.atan2(-dir.z, dir.x) / DEG
    }
    state.mode = mode
    player.visible = mode !== 'eyes'
  }

  function updateCamera() {
    if (state.mode === 'eyes') {
      playerEyeThree(camera.position)
      forwardOf(state.pitch, state.yaw, tmpF)
      camera.lookAt(camera.position.x + tmpF.x, camera.position.y + tmpF.y, camera.position.z + tmpF.z)
      camera.fov = sourceFovToVertical(state.worldFov || 90) // installWorldFov (end of file) sets state.worldFov
    } else if (state.mode === 'follow') {
      // Orbit around a point at chest height. Source yaw/pitch semantics for the orbit angles.
      toThree(state.origin.x, state.origin.y, state.origin.z + (state.body ? state.body.height : (state.ducked ? DUCK_H : STAND_H)) * 0.6, eyeV)
      forwardOf(state.orbitPitch, state.orbitYaw, tmpF)
      camera.position.set(eyeV.x + tmpF.x * state.orbitDist, eyeV.y + tmpF.y * state.orbitDist, eyeV.z + tmpF.z * state.orbitDist)
      camera.lookAt(eyeV)
      camera.fov = 75
    } else {
      camera.position.copy(state.freePos)
      const p = state.freePitch * DEG
      const y = state.freeYaw * DEG
      camera.lookAt(state.freePos.x + Math.cos(p) * Math.cos(y), state.freePos.y + Math.sin(p), state.freePos.z - Math.cos(p) * Math.sin(y))
      camera.fov = 90
    }
    camera.updateProjectionMatrix()
  }

  // Free-cam movement, dt in seconds.
  function tickFree(dt, fast) {
    if (state.mode !== 'free' || state.keys.size === 0) return
    const speed = (fast ? 2400 : 700) * dt
    const p = state.freePitch * DEG
    const y = state.freeYaw * DEG
    const fwd = tmpF.set(Math.cos(p) * Math.cos(y), Math.sin(p), -Math.cos(p) * Math.sin(y))
    const right = tmpV.set(Math.sin(y), 0, Math.cos(y))
    const k = state.keys
    if (k.has('KeyW')) state.freePos.addScaledVector(fwd, speed)
    if (k.has('KeyS')) state.freePos.addScaledVector(fwd, -speed)
    if (k.has('KeyD')) state.freePos.addScaledVector(right, speed)
    if (k.has('KeyA')) state.freePos.addScaledVector(right, -speed)
    if (k.has('KeyE') || k.has('Space')) state.freePos.y += speed
    if (k.has('KeyQ') || k.has('KeyC')) state.freePos.y -= speed
  }

  // Mouse drag: dx/dy in pixels.
  function drag(dx, dy) {
    if (state.mode === 'free') {
      state.freeYaw -= dx * 0.2
      state.freePitch = THREE.MathUtils.clamp(state.freePitch - dy * 0.2, -89, 89)
    } else if (state.mode === 'follow') {
      state.orbitYaw += dx * 0.3
      state.orbitPitch = THREE.MathUtils.clamp(state.orbitPitch + dy * 0.3, -85, 85)
    }
  }
  function wheel(dy) {
    if (state.mode === 'follow') state.orbitDist = THREE.MathUtils.clamp(state.orbitDist * (dy > 0 ? 1.15 : 0.87), 60, 2000)
  }

  function resize() {
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    vmCamera.aspect = w / h
    vmCamera.updateProjectionMatrix()
  }

  function render() {
    const t0 = quality.auto ? performance.now() : 0
    updateCamera()
    // The sky box rides on the camera (in Source coords: three (x, y, z) -> (x, -z, y)).
    skyBox.position.set(camera.position.x, -camera.position.z, camera.position.y)
    renderer.autoClear = true
    // The 3D skybox, where the map has one: its own pass, on its own layer, with its own far
    // plane and the sky_camera's own fog, then the depth buffer is cleared. That clear is the
    // whole point — it is how the engine guarantees no part of the miniature can stand in front
    // of real map geometry, and it is why this can be a plain static transform.
    // Skipped at governor level 3+: the pass is a whole second draw of the map, and a renderer
    // that cannot hold the frame rate loses the horizon before it loses the run.
    if (state.skyTwoPass && !quality.skyOff) {
      const far = camera.far
      const worldFog = scene.fog
      camera.far = state.skyFar || far
      camera.updateProjectionMatrix()
      camera.layers.set(SKY_LAYER)
      if (skyFog) scene.fog = skyFog
      renderer.render(scene, camera)
      scene.fog = worldFog
      camera.layers.set(0)
      camera.far = far
      camera.updateProjectionMatrix()
      renderer.autoClear = false
      renderer.clearDepth()
    }
    renderer.render(scene, camera)
    renderer.autoClear = true
    state.renderCount++
    // Second pass: the viewmodel, Eyes cam only. Same eye position and look direction as
    // the world camera, its own FOV, depth cleared so it draws over the map. The governor's
    // vmOff (level 3+) forces it off without touching the viewer's own Viewmodel toggle —
    // quality.vmOff is the machine's word, vmVisible is the person's.
    if (state.mode === 'eyes' && vmVisible && !quality.vmOff && viewmodel.children.length) {
      vmCamera.position.copy(camera.position)
      vmCamera.quaternion.copy(camera.quaternion)
      renderer.autoClear = false
      renderer.clearDepth()
      renderer.render(vmScene, vmCamera)
      renderer.autoClear = true
    }
    if (quality.auto) govern(performance.now(), t0)
  }

  // Frame cap. n <= 0 or not a number = uncapped (display rate).
  function setMaxFps(n) { const f = Number(n); state.maxFps = Number.isFinite(f) && f > 0 ? f : 0 }

  // ---- adaptive quality. The probe (probeGLRenderer) can only say WHO renders; this watches
  // the frames themselves, because who renders never says how well. Every render leaves two
  // numbers: how long the picture took (renderMs) and how long since the previous one (gap).
  // A gap over 17.5 ms is a rate under the 60 fps both loops ask for — but only with an
  // expensive render behind it, or the number being read is the caller's own frame cap on a
  // fast machine (a capped 60 reads as a 16.7 ms gap over a 4 ms render, and that is the cap
  // working, not trouble). Slow frames step the level down; real headroom, held for a while,
  // steps it back up. A paused viewer renders only on change and those gaps are seconds long —
  // ignored, so the governor never moves on a still picture.
  const quality = {
    auto: false,
    level: 0,
    minLevel: 0,      // a software-probed scene starts degraded and never climbs back to full
    emaGap: 0,
    emaRender: 0,
    lastAt: 0,
    lastStepAt: 0,
    upFrames: 0,
    skyOff: false,    // level >= 3: the 3D skybox's second pass is skipped
    vmOff: false,     // level >= 3: the viewmodel pass is skipped (the viewer's toggle untouched)
  }
  // The pixel-ratio cap per level. Resolution is the lever that costs a software rasteriser
  // the most and the picture the least, so it is three of the five rungs; the extra passes
  // (skybox, viewmodel) go before the last resolution cut.
  const QUALITY_PR = [2, 1.5, 1, 1, 0.5]
  const QUALITY_MAX = QUALITY_PR.length - 1
  function applyQuality() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY_PR[quality.level]))
    quality.skyOff = quality.level >= 3
    quality.vmOff = quality.level >= 3
    state.qualityLevel = quality.level
    api.resize()
  }
  function govern(now, t0) {
    const gap = quality.lastAt ? now - quality.lastAt : 0
    quality.lastAt = now
    if (gap <= 0 || gap > 250) return   // a pause, a tab switch, the first frame: nothing to read
    const renderMs = now - t0
    quality.emaGap = quality.emaGap ? quality.emaGap * 0.9 + gap * 0.1 : gap
    quality.emaRender = quality.emaRender ? quality.emaRender * 0.9 + renderMs * 0.1 : renderMs
    if (quality.emaGap > 17.5 && quality.emaRender > 12 && quality.level < QUALITY_MAX
        && now - quality.lastStepAt > 1500) {
      quality.level++
      quality.lastStepAt = now
      quality.upFrames = 0
      applyQuality()
      return
    }
    if (quality.emaGap < 14 && quality.emaRender < 7 && quality.level > quality.minLevel
        && now - quality.lastStepAt > 4000) {
      // Headroom has to be HELD: four seconds of cheap frames, so a camera swing through one
      // cheap corner does not yo-yo the picture.
      quality.upFrames++
      if (quality.upFrames >= 240) {
        quality.level--
        quality.lastStepAt = now
        quality.upFrames = 0
        applyQuality()
      }
    } else quality.upFrames = 0
  }
  // opts.software is the probe's word: start two rungs down (pixel ratio 1, extra passes still
  // on) with the floor just below full — the governor may climb one rung if the frames say the
  // probe was too pessimistic, but never back to a picture the renderer already failed at.
  function setAutoQuality(opts) {
    quality.auto = true
    if (opts && opts.software) {
      quality.level = 2
      quality.minLevel = 1
      applyQuality()
    }
  }

  // ---- viewmodel API (the seam the skins round fills)
  // setViewmodel(object3d|null): replace the viewmodel contents. The object goes into
  // camera space (x right, y up, -z forward, Source units): a knife held at the usual
  // CS:GO offset sits around (8, -6, -14) with the blade along -z. null empties the group.
  // The previous object is removed but NOT disposed — the caller owns it.
  // A material that set `userData.envMap = true` (viewmodel.js does it for the knife, and
  // only the knife) gets this pass's PMREM environment; its own envMapIntensity then holds,
  // which is the whole reason the environment is not on the scene.
  function setViewmodel(obj) {
    while (viewmodel.children.length) viewmodel.remove(viewmodel.children[0])
    if (obj) viewmodel.add(obj)
    if (obj) {
      obj.traverse((o) => {
        if (!o.isMesh) return
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (m && m.userData && m.userData.envMap && m.envMap !== vmEnvironment) {
            m.envMap = vmEnvironment
            m.needsUpdate = true
          }
        }
      })
    }
  }
  // setViewmodelVisible(bool): show/hide the pass without dropping the object.
  function setViewmodelVisible(v) { vmVisible = !!v; viewmodel.visible = vmVisible }
  // setViewmodelFov(deg): CS:GO viewmodel_fov (default 60) — a Source FOV, converted.
  function setViewmodelFov(deg) {
    const f = Number(deg)
    if (!Number.isFinite(f)) return
    vmCamera.fov = sourceFovToVertical(Math.max(5, Math.min(120, f)))   // 5: a scoped ADS zoom (replay.md §14)
    vmCamera.updateProjectionMatrix()
  }

  // Ground grid for the no-map case: sits at the run's lowest z, centred on the run.
  function setGrid(cx, cy, z, visible) {
    grid.position.set(cx, z, -cy)
    grid.visible = visible
  }

  // Load the map glb. Resolves { ok, error }. Never throws.
  //
  // THE MESHOPT DECODER — where this parts from Movement. Movement registers none: its site's
  // script-src lacks 'wasm-unsafe-eval' and three's decoder instantiates WebAssembly. This site
  // sends no Content-Security-Policy, and tools/maps/export_all.py serves every WaW map as
  // EXT_meshopt_compression (a shell-heavy map is half the bytes: Shi No Numa 20.8 -> 10.6 MB).
  // The decoder is a self-contained module inside three (the WASM is inlined), so nothing
  // else is fetched. A file without the extension loads exactly as before. IF A CSP IS EVER
  // ADDED, script-src needs 'wasm-unsafe-eval' or every exported map falls to the grid (§7e).
  // KHR_mesh_quantization and EXT_texture_webp need nothing registered.
  // `src` is either a URL or the glb bytes already in hand (ReplayViewer fetches them itself so
  // it can show real progress and fall back from the bucket to the proxy). parse() takes the
  // buffer with an empty base path: a glb embeds its textures, so nothing is resolved relative.
  async function loadMap(src) {
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    try {
      const gltf = await new Promise((resolve, reject) => (
        src instanceof ArrayBuffer
          ? loader.parse(src, '', resolve, reject)
          : loader.load(src, resolve, undefined, reject)
      ))
      const root = gltf.scene
      root.traverse((o) => {
        if (o.isMesh) {
          o.frustumCulled = true
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          // DOUBLE-sided, and it has to stay that way. Source lights a map with baked lightmaps
          // and this viewer has a sun and a hemisphere instead; three flips the normal on a
          // back face, so double-siding is also what keeps an interior lit at all. Rendering
          // the map single-sided — which is what the engine does, and which would end the
          // z-fighting described below outright — drops surf_zae's frame to 15/255 mean
          // luminance from 53. Correct culling, unusable picture, so: not that.
          //
          // The z-fighting it costs: two brushes butted together each contribute their own face
          // to the shared plane facing opposite ways, and drawn double-sided they both draw.
          // On surf_zae that back-to-back coplanar overlap is 0.95% of the visible surface
          // (surf_andromeda 0.20%) against ~0.0001% on a map that does not flicker. The camera's
          // near plane is what decides whether the depth buffer can tell them apart.
          // NOT the place to paper over a material that lost its texture in conversion: an
          // untextured near-black material is a real fault (scripts/replay3d/ramp-audit.js finds
          // 78 of them directly under a run across 132 maps) but recolouring every one of them
          // here is a change to how every map looks, and it wants its own before-and-after.
          for (const m of mats) { if (m) { m.side = THREE.DoubleSide; applyBlendMaterial(m) } }
          // Tool faces (nodraw, clips, triggers) are not drawn, and not raycast either:
          // an invisible mesh is skipped by Raycaster.intersectObjects only when it walks
          // children (recursive), so callers that gather meshes must check `visible` too.
          // A SKY face is not one of them: it draws the sky and occludes what is behind it,
          // so it is converted to an occluder and stays visible. A mesh carrying both a sky
          // face and a real tool face is still hidden — the tool face wins, as before.
          if (mats.some((m) => m && TOOLS_HIDDEN_RE.test(m.name || '') && !isSkywallName(m.name))) o.visible = false
          else skywall.convert(o)
        }
      })
      // Which way up is the file? Compare its bounds against the run: if the model's extents
      // already look Y-up (its Y span matches the run's z span better than its Z span does),
      // add it without the Source->three rotation.
      const box = new THREE.Box3().setFromObject(root)
      state.mapBounds = box
      mapGroup.add(root)
      state.mapLoaded = true
      grid.visible = false
      return { ok: true, box }
    } catch (e) {
      return { ok: false, error: e && (e.message || String(e)) }
    }
  }
  // Undo the map-group rotation when the glb is already Y-up.
  function setMapYUp(yUp) { mapGroup.rotation.x = yUp ? 0 : -Math.PI / 2 }

  // Build every shader the scene needs BEFORE the first frame asks for one. three compiles a
  // material's program the first time that material is drawn, and a browser compiles and links
  // a program synchronously unless it is asked otherwise — so the opening seconds of a replay
  // are a run of long frames, one per material the camera turns to face, which is exactly when
  // a viewer is judged. compileAsync uses KHR_parallel_shader_compile where it exists and takes
  // the whole cost off the frame where it does not.
  //
  // Kept on the strength of the argument, NOT of a measurement: pricing it means sampling the
  // first seconds after the map lands, and the box this was benched on was too contended for
  // that number to mean anything. Nothing about it is engine-specific.
  //
  // Never awaited by a caller and never fatal: a scene that could not precompile is a scene
  // that compiles lazily, which is what it did before.
  function precompile() {
    try {
      const p = renderer.compileAsync ? renderer.compileAsync(scene, camera) : null
      if (p && p.catch) p.catch(() => {})
      return p || Promise.resolve()
    } catch (e) { return Promise.resolve() }
  }

  // The 3D skybox. A Source map's distant scenery is a MINIATURE built at 1/sky_camera-scale
  // somewhere off the level, which the engine draws separately, scaled up, behind everything
  // (docs/REPLAY-3D-VIEWER-PLAN.md, "3D skybox"). SourceIO imports it at 1:1 where it sits, so
  // it arrives as a small block of geometry buried outside the map: on surf_4am that is 753 of
  // the file's 2772 primitives and 24 068 of its 150 451 triangles.
  //
  // This used to HIDE that block, on the grounds that nobody could see it. Nobody could see it
  // because it was never put where it belongs — and hiding it is why surf_boreas has no
  // mountains and reads as "the skybox doesn't load": boreas's 2D sky is one 64x64 near-white
  // VTF on all six faces, so with the fog drawn (setFog) and the miniature gone there is
  // nothing out there at all. Placed, it is the map's horizon.
  //
  // WHERE it goes. The engine renders the miniature at 1:1 from a camera at
  // `sky_origin + player/scale`, which is the same picture as leaving the camera where it is
  // and building the miniature at `scale`x around the sky_camera: a skybox point p draws at
  // `(p - sky_origin) * scale`. That is a static transform — one group, scaled, offset — and it
  // is exact when the player is at the world origin and a parallax approximation everywhere
  // else, which is the same approximation as drawing the 2D sky on a box 30 000 units wide.
  //
  // HOW it is drawn: its own pass, on SKY_LAYER, before the world and with the depth buffer
  // cleared between the two (render()). The engine does exactly this, and it is the only way
  // the miniature cannot win a depth test it should lose — scaled up, it wraps around the level.
  //
  // WHICH meshes: unchanged. The same three guards decide, because the cost of getting it wrong
  // is still a piece of the level in the wrong place:
  //   - the sky_camera must be clear of the run itself — not of the run's BOUNDING BOX, which on
  //     a map like surf_4am covers nearly the world. A camera the runner goes near is not a
  //     3D skybox camera we can separate, and the map is left alone;
  //   - a mesh must be small next to the map, so the merged per-material world meshes (which
  //     span it) are never candidates, and must sit within an eighth of the world of the camera;
  //   - a mesh the runner passes through is never moved, whatever else is true of it.
  //
  // WHICH TRIANGLES: the guards above name MESHES, and a mesh is not the unit the file is cut
  // into. SourceIO merges world brush faces per MATERIAL into meshes that span the level, so a
  // miniature mountain sharing `nature/rock` with the arena walls arrives inside a world-spanning
  // mesh — too big for the size guard, and left buried at 1:1. That is why surf_boreas still had
  // no mountains after the miniature was placed: 36 meshes moved and the scenery was not among
  // them. The same is true of every `_disp*` displacement, which is how a Source hillside is
  // built in the first place.
  //
  // So what the miniature IS is a REGION, not a set of meshes, and the region is MEASURED rather
  // than guessed: a 3D skybox is built in a sealed room of sky faces with the sky_camera inside
  // it, and skyRoomBox fires a ray along each axis to find that room's own walls. Where a room
  // cannot be measured the box of what the guards found, grown by a margin, stands in for it —
  // and is treated as the guess it is.
  //
  // Every remaining map mesh is then walked triangle by triangle and the ones whose centroid
  // falls inside the region come across: a mesh entirely inside is moved whole, a mesh partly
  // inside is COPIED into a new primitive carrying the same material (so the render table, the
  // footstep surface and the sky-wall flag still read the same name) and its originals stay
  // where they are, buried under the level, doing what they always did.
  //
  // The region is only trusted where it is provably somewhere else than the run: a box that
  // reaches the runner's own path is a box that would take the LEVEL into the skybox. Then the
  // split is skipped, the mesh-level behaviour above stands, and the reason is reported
  // (state.skyLeaf.regionSkip).
  //
  // `sky` is { origin, scale, fog } (skyboxFromEntities); `runPoints` is a sampled Float32Array
  // of the run's own positions, x/y/z per point, Source units. Returns { placed, tris, scale }.
  const RUN_CLEAR = 1024
  const skyLeaf = new THREE.Group()
  skyLeaf.name = 'r3d_skyleaf'
  mapGroup.add(skyLeaf)
  function placeSkyCameraLeaf(sky3d, runPoints) {
    const out = { placed: 0, tris: 0, scale: 0 }
    const skyOrigin = sky3d && sky3d.origin
    if (!skyOrigin || !state.mapLoaded) return out
    // The transform below is written in the map group's own space, which is Source coords only
    // while the group carries the Source->three rotation. A Y-up glb (setMapYUp) is already in
    // three's frame and the sky_camera's Source origin does not address it, so that file keeps
    // the old behaviour: the miniature is hidden rather than put somewhere wrong.
    const sourceFrame = mapGroup.rotation.x !== 0
    const world = new THREE.Box3().setFromObject(mapGroup)
    const span = world.getSize(new THREE.Vector3())
    const worldSpan = Math.max(span.x, span.y, span.z)
    if (!(worldSpan > 0)) return out
    const sky = toThree(skyOrigin[0], skyOrigin[1], skyOrigin[2], new THREE.Vector3())
    const pts = []
    const p = new THREE.Vector3()
    for (let i = 0; runPoints && i + 2 < runPoints.length; i += 3) {
      toThree(runPoints[i], runPoints[i + 1], runPoints[i + 2], p)
      if (p.distanceTo(sky) <= RUN_CLEAR) return out
      pts.push(p.x, p.y, p.z)
    }
    const near = worldSpan / 8
    const box = new THREE.Box3()
    const centre = new THREE.Vector3()
    const size = new THREE.Vector3()
    const reachesRun = (b) => {
      for (let i = 0; i < pts.length; i += 3) {
        if (pts[i] >= b.min.x && pts[i] <= b.max.x && pts[i + 1] >= b.min.y && pts[i + 1] <= b.max.y
          && pts[i + 2] >= b.min.z && pts[i + 2] <= b.max.z) return true
      }
      return false
    }
    const leaf = []
    mapGroup.traverse((o) => {
      if (!o.isMesh || !o.visible || o.userData.r3dSkyLeaf) return
      box.setFromObject(o)
      box.getSize(size)
      if (Math.max(size.x, size.y, size.z) >= worldSpan * 0.25) return
      box.getCenter(centre)
      if (Math.abs(centre.x - sky.x) > near || Math.abs(centre.y - sky.y) > near || Math.abs(centre.z - sky.z) > near) return
      if (reachesRun(box.expandByScalar(RUN_CLEAR / 4))) return
      leaf.push(o)
    })
    // Where the miniature IS. Measured first, because it decides both of the two splits below
    // and because it stands on its own: on 13 of the 79 maps with a sky_camera the guards above
    // find NOTHING — every triangle of the miniature is merged into a mesh that spans the level
    // — and a map used to get no 3D skybox at all for it. A measured room is proof enough.
    const room = sourceFrame ? skyRoomBox(skyOrigin) : null
    if (!leaf.length && !room) return out
    // The miniature's own SKY faces. A 3D skybox room is a box with `tools/toolsskybox` cut
    // into its walls and ceiling — that is where the 2D sky shows through, and without them the
    // miniature is a closed shell that paints the whole horizon in one colour (measured on
    // surf_andromeda: the starfield went flat blue, and on surf_4am flat grey).
    //
    // They cannot simply be collected the way the rock is: SourceIO merges per MATERIAL, so
    // every toolsskybox face in the file — the map's own arena walls and the skybox room's —
    // arrives as ONE mesh that spans the world, which the size guard rejects for good reason.
    // So the triangles are split by position instead: those sitting in the sky_camera's own
    // neighbourhood are copied into the leaf. Positions only — the sky-wall shader reads
    // nothing else (skywall.js: the view direction picks the face and the uv).
    //
    // The originals stay where they are, buried under the level, doing what they always did.
    //
    // WHICH of them is the room's, measured (skyRoomBox); the `near` cube is only the fallback
    // for a map whose room could not be measured.
    const skyFaces = sourceFrame ? extractSkywallNear(skyOrigin, near, room) : null
    // Re-parenting has to preserve the world transform each mesh already has (a glb nests its
    // nodes), so the group is neutral while the meshes come across and takes its own transform
    // afterwards. attach() is what does the first half.
    skyLeaf.position.set(0, 0, 0)
    skyLeaf.scale.set(1, 1, 1)
    skyLeaf.updateMatrixWorld(true)
    for (const o of leaf) {
      if (!sourceFrame) { o.visible = false } else { skyLeaf.attach(o) }
      o.userData.r3dSkyLeaf = true
      // Its own pass. Sound never resolves a footstep against it (audio.makeSurfaceResolver),
      // and the ramp audit / validate rigs read the world meshes, which these no longer are.
      o.layers.set(SKY_LAYER)
      o.frustumCulled = false
      out.placed++
      const g = o.geometry
      if (g) out.tris += Math.floor((g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)) / 3)
    }
    if (!sourceFrame) { state.skyLeaf = { ...out, placed: 0, hidden: out.placed }; return { ...out, placed: 0 } }
    // ---- the leaf REGION. The room where it was measured (skyRoomBox), which is the engine's
    // own answer and the only one that can tell a miniature mountain from a real one; otherwise
    // the box of what the mesh guards found, grown, which is a guess and is treated as one.
    const region = new THREE.Box3()
    if (room) {
      region.copy(room).applyMatrix4(mapGroup.matrixWorld)
      out.regionFrom = 'room'
    } else {
      const one = new THREE.Box3()
      for (const o of leaf) region.union(one.setFromObject(o))
      region.getSize(size)
      // A margin, so a mountain whose foot sits just outside the box of the rock next to it is
      // not cut in half by it. Proportional, with a floor for a small miniature.
      region.expandByScalar(Math.max(64, Math.max(size.x, size.y, size.z) * 0.05))
      out.regionFrom = 'meshes'
    }
    region.getSize(size)
    const regionSpan = Math.max(size.x, size.y, size.z)
    out.region = [region.min.toArray().map(Math.round), region.max.toArray().map(Math.round)]
    // The guard. A region that reaches the run is a region that would take the LEVEL into the
    // skybox and scale it up over the player's head, and no measurement is worth that: nothing is
    // split, the mesh-level placement above is what ships, and that is what shipped before this.
    //
    // Size is only a guard on the GUESS. A measured room is allowed to be enormous, because a lot
    // of them are: surf_boreas builds its skybox in the whole bottom slab of the map, x and y wall
    // to wall and 11 008 units deep, with the level in the space above it. A box drawn round some
    // meshes has no such standing, so half the world is where it stops being credible.
    const regionSkip = !(regionSpan > 0) ? 'empty region'
      : (out.regionFrom === 'meshes' && regionSpan > worldSpan * 0.5) ? `guessed region spans ${Math.round(regionSpan)} of a ${Math.round(worldSpan)} world`
        : reachesRun(region.clone().expandByScalar(RUN_CLEAR)) ? 'region reaches the run'
          : null
    if (regionSkip) {
      out.regionSkip = regionSkip
      // eslint-disable-next-line no-console
      console.warn('[r3d] 3D skybox: not splitting by region:', regionSkip)
    } else {
      const r = extractLeafRegion(region)
      out.regionMoved = r.moved
      out.regionMovedTris = r.movedTris
      out.regionSplit = r.split
      out.regionSplitTris = r.splitTris
      out.regionSkipped = r.skipped
      out.placed += r.moved + r.split
      out.tris += r.movedTris + r.splitTris
    }
    // No MESH landed, so there is no miniature: the second pass is not turned on, the map's own
    // sky walls keep painting, and the map is exactly the map it was. This is the floor under
    // measuring a room rather than guessing one — a room that came back as the whole world (the
    // rays found the map's outer hull and nothing nearer) is rejected by the run guard above, and
    // what is left over is a set of sky faces, which is a shape, not a skybox. An empty group
    // also has no bounding box, and a far plane measured off one is not a number.
    if (!out.placed) {
      if (skyFaces) skyFaces.geometry.dispose()
      state.skyLeaf = out
      return out
    }
    if (skyFaces) {
      // Built in the map group's own space already, so it is ADDED, not attached.
      skyFaces.layers.set(SKY_LAYER)
      skyLeaf.add(skyFaces)
      out.skyFaces = Math.floor(skyFaces.geometry.attributes.position.count / 3)
    }
    const scale = THREE.MathUtils.clamp(Number(sky3d.scale) || 16, 1, 256)
    skyLeaf.scale.setScalar(scale)
    skyLeaf.position.set(-skyOrigin[0] * scale, -skyOrigin[1] * scale, -skyOrigin[2] * scale)
    skyLeaf.updateMatrixWorld(true)
    out.scale = scale
    // Scaled up, the miniature reaches well past the world camera's 50 000-unit far plane. Its
    // pass gets a far plane of its own (render()), sized to what actually landed — the world
    // pass keeps 50 000, so nothing about the map's own depth precision moves.
    const placedBox = new THREE.Box3().setFromObject(skyLeaf)
    // Measured from the world origin, so the camera's own distance from it is added back.
    state.skyFar = Math.max(50000, placedBox.min.length(), placedBox.max.length()) * 1.05 + worldSpan
    // The dome joins the same pass: it is this pass's background, and it has to be painted
    // before the miniature rather than after it.
    for (const m of skyBox.children) m.layers.set(SKY_LAYER)
    // Both world lights reach the miniature — a light only lights what shares a layer with it.
    hemi.layers.enable(SKY_LAYER)
    sun.layers.enable(SKY_LAYER)
    // The map's own toolsskybox faces stop painting and become pure depth: the picture behind
    // them is already the right one (this pass drew it), and writing over it is what kept the
    // 3D skybox out of every window a mapper cut with a sky face.
    skywall.setDepthOnly(true)
    state.skyTwoPass = true
    applyBackground()
    // Fog for the miniature is the sky_camera's own, at the scale it is drawn: a fog distance
    // in skybox space is `scale` times as far once the skybox is `scale` times as big.
    if (sky3d.fog) skyFog = new THREE.Fog(new THREE.Color().setRGB(sky3d.fog.color[0], sky3d.fog.color[1], sky3d.fog.color[2], THREE.SRGBColorSpace), sky3d.fog.start * scale, sky3d.fog.end * scale)
    state.skyLeaf = out
    return out
  }

  // The 3D skybox ROOM, as a Box3 in the map group's own (Source) space, or null.
  //
  // A room is what makes the miniature a separate world: a sealed box of `tools/toolsskybox`
  // brushes with the sky_camera inside it and the scenery built in there. So its extent is not
  // guessed from what the mesh guards happened to catch — it is MEASURED, by firing a ray from
  // the sky_camera along each of the six axes and taking the first SKY face each one meets.
  // Nothing but sky faces are tested, so a mountain standing in the way changes no answer, and
  // from inside a sealed box the first sky face along an axis is that box's own wall.
  //
  // This is the difference between a region that is the skybox and a region that is a box drawn
  // round some of it. On surf_boreas the mesh guards found a 6 642 x 8 851 x 2 546 corner of a
  // room several times that size, and a box drawn round THAT reaches into the level.
  //
  // A floor is often terrain rather than a sky face, and a room open at the top happens too, so
  // an axis that meets nothing is not a failure: it falls back to the map's own bound on that
  // side. A room that lost more than one side is not a room, and the caller falls back to the
  // mesh guards' own box.
  const SKY_ROOM_AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  function skyRoomBox(skyOrigin) {
    mapGroup.updateMatrixWorld(true)
    const toLocal = mapGroup.matrixWorld.clone().invert()
    const o = new THREE.Vector3(skyOrigin[0], skyOrigin[1], skyOrigin[2])
    const rays = SKY_ROOM_AXES.map((d) => new THREE.Ray(o.clone(), new THREE.Vector3(d[0], d[1], d[2])))
    const hit = new THREE.Vector3()
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const t = SKY_ROOM_AXES.map(() => Infinity)
    mapGroup.traverse((m) => {
      if (!m.isMesh || !m.visible || !m.userData.r3dSkywall || m.userData.r3dSkyLeaf) return
      const pos = m.geometry && m.geometry.attributes && m.geometry.attributes.position
      if (!pos) return
      const idx = m.geometry.index
      const n = idx ? idx.count : pos.count
      const toMap = toLocal.clone().multiply(m.matrixWorld)
      for (let i = 0; i + 2 < n; i += 3) {
        const j0 = idx ? idx.getX(i) : i, j1 = idx ? idx.getX(i + 1) : i + 1, j2 = idx ? idx.getX(i + 2) : i + 2
        a.set(pos.getX(j0), pos.getY(j0), pos.getZ(j0)).applyMatrix4(toMap)
        b.set(pos.getX(j1), pos.getY(j1), pos.getZ(j1)).applyMatrix4(toMap)
        c.set(pos.getX(j2), pos.getY(j2), pos.getZ(j2)).applyMatrix4(toMap)
        // Both faces: a room's walls point inward, and nothing here knows which way that is.
        for (let k = 0; k < 6; k++) {
          if (!rays[k].intersectTriangle(a, b, c, false, hit)) continue
          const d = hit.distanceTo(o)
          if (d > 1 && d < t[k]) t[k] = d
        }
      }
    })
    if (t.filter((d) => d === Infinity).length > 1) return null
    // The map's own bound on a side the rays never met.
    const worldLocal = new THREE.Box3().setFromObject(mapGroup).applyMatrix4(toLocal)
    const at = (k, axis, sign) => (t[k] === Infinity
      ? (sign > 0 ? worldLocal.max[axis] : worldLocal.min[axis])
      : o[axis] + sign * t[k])
    return new THREE.Box3(
      new THREE.Vector3(at(1, 'x', -1), at(3, 'y', -1), at(5, 'z', -1)),
      new THREE.Vector3(at(0, 'x', 1), at(2, 'y', 1), at(4, 'z', 1)))
  }

  // Every sky-wall triangle sitting inside the 3D skybox room (`room`, a Box3 in the map group's
  // space — its walls ARE those triangles, so the test carries a margin outward), or, where no
  // room could be measured, within `near` of `skyOrigin` (Source units). One positions-only mesh
  // in the map group's space, or null. See placeSkyCameraLeaf for why the split is by position
  // rather than by mesh.
  const SKY_ROOM_MARGIN = 16
  function extractSkywallNear(skyOrigin, near, room) {
    mapGroup.updateMatrixWorld(true)
    const toLocal = mapGroup.matrixWorld.clone().invert()
    const grown = room ? room.clone().expandByScalar(SKY_ROOM_MARGIN) : null
    const v = new THREE.Vector3()
    const out = []
    mapGroup.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.userData.r3dSkywall || o.userData.r3dSkyLeaf) return
      const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position
      if (!pos) return
      const idx = o.geometry.index
      const n = idx ? idx.count : pos.count
      const toMap = toLocal.clone().multiply(o.matrixWorld)
      const tri = []
      for (let i = 0; i + 2 < n; i += 3) {
        let keep = true
        tri.length = 0
        for (let k = 0; k < 3; k++) {
          const j = idx ? idx.getX(i + k) : i + k
          v.set(pos.getX(j), pos.getY(j), pos.getZ(j)).applyMatrix4(toMap)
          if (grown ? !grown.containsPoint(v)
            : (Math.abs(v.x - skyOrigin[0]) > near || Math.abs(v.y - skyOrigin[1]) > near || Math.abs(v.z - skyOrigin[2]) > near)) { keep = false; break }
          tri.push(v.x, v.y, v.z)
        }
        if (keep) out.push(tri[0], tri[1], tri[2], tri[3], tri[4], tri[5], tri[6], tri[7], tri[8])
      }
    })
    if (!out.length) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
    const mesh = new THREE.Mesh(g, skywall.material)
    mesh.userData.r3dSkywall = true
    mesh.userData.r3dSkyLeaf = true
    mesh.frustumCulled = false
    return mesh
  }

  // Everything of the map that stands inside `region` (a Box3 in WORLD space), moved into the
  // placed group: a mesh wholly inside comes across whole, a mesh partly inside leaves a copy of
  // the triangles that are inside. Returns what it did. See placeSkyCameraLeaf for why a mesh is
  // the wrong unit and a region is the right one.
  //
  // Triangles are classified by CENTROID, once, on the CPU, at load. A centroid is one point per
  // triangle and it cannot straddle: a triangle is in the skybox or it is in the level, never
  // both, so no face is ever drawn twice and no seam opens between the two halves of a mesh that
  // was cut. The vertices come across in the map group's own space (the group is identity while
  // this runs and takes its scale afterwards) and normals with them, through the normal matrix.
  //
  // Copies, not cuts: the originals stay in the world mesh they were merged into, buried outside
  // the level where they have always been, which is what the sky-wall split does and for the
  // same reason — rebuilding a world-spanning mesh to remove them risks the level to save
  // geometry nobody can reach. The copy carries the SAME material instance, so the render table
  // (applyMaterialRender), the footstep surface and every later material pass still read one
  // name and change both.
  function extractLeafRegion(region) {
    const out = { moved: 0, movedTris: 0, split: 0, splitTris: 0, skipped: 0 }
    mapGroup.updateMatrixWorld(true)
    const toLocal = mapGroup.matrixWorld.clone().invert()
    // The map group's rotation is a quarter turn about x, so an axis-aligned box carries into its
    // space as an axis-aligned box exactly. Carrying the REGION in once beats carrying every
    // vertex out.
    const local = region.clone().applyMatrix4(toLocal)
    const box = new THREE.Box3()
    const cand = []
    mapGroup.traverse((o) => {
      // Already the skybox's, or the sky wall's own split (extractSkywallNear), which runs first
      // and owns every toolsskybox face there is.
      if (!o.isMesh || !o.visible || o.userData.r3dSkyLeaf || o.userData.r3dSkywall) return
      // A skinned or instanced mesh is not a bag of world triangles and none of the map is one.
      // Nor is a multi-material mesh: its triangles are addressed through geometry groups, and
      // our converter writes one material per primitive, so this never fires on our own files.
      if (o.isSkinnedMesh || o.isInstancedMesh || Array.isArray(o.material)) { out.skipped++; return }
      const g = o.geometry
      if (!g || !g.attributes || !g.attributes.position) return
      if (!box.setFromObject(o).intersectsBox(region)) return
      cand.push(o)
    })
    const v = new THREE.Vector3()
    const c = new THREE.Vector3()
    // Collected first and moved after: attach() re-parents, and re-parenting inside a traverse
    // walks the tree out from under it.
    for (const o of cand) {
      const g = o.geometry
      const pos = g.attributes.position
      const idx = g.index
      const n = idx ? idx.count : pos.count
      const toMap = toLocal.clone().multiply(o.matrixWorld)
      const inside = []
      for (let i = 0; i + 2 < n; i += 3) {
        c.set(0, 0, 0)
        for (let k = 0; k < 3; k++) {
          const j = idx ? idx.getX(i + k) : i + k
          c.add(v.set(pos.getX(j), pos.getY(j), pos.getZ(j)).applyMatrix4(toMap))
        }
        if (local.containsPoint(c.multiplyScalar(1 / 3))) inside.push(i)
      }
      if (!inside.length) continue
      const tris = Math.floor(n / 3)
      if (inside.length === tris) {
        // Wholly inside: the guards would have taken it if it had been small enough to name.
        skyLeaf.attach(o)
        markSkyLeaf(o)
        out.moved++
        out.movedTris += tris
        continue
      }
      const mesh = copyTrianglesToMap(o, inside, toMap)
      if (!mesh) continue
      markSkyLeaf(mesh)
      skyLeaf.add(mesh)
      out.split++
      out.splitTris += inside.length
    }
    return out
  }

  // The skybox's own pass, and out of everything that reads the world: the footstep resolver
  // (audio.makeSurfaceResolver), the ramp audit and the validate rigs all skip r3dSkyLeaf.
  //
  // Frustum culling is left ALONE here, which is to say on. The mesh-guard path turns it off for
  // the handful it finds; a region takes hundreds (surf_boreas: 974), and a hundreds-of-meshes
  // group that cannot be culled is hundreds of draw calls every frame whichever way the camera
  // faces. These are ordinary map meshes with ordinary bounds, and the skybox pass sets its own
  // projection before it draws, so the frustum they are tested against is its own.
  function markSkyLeaf(o) {
    o.userData.r3dSkyLeaf = true
    o.layers.set(SKY_LAYER)
  }

  // `tris` (first-vertex offsets into o.geometry) as a new non-indexed mesh in the map group's
  // space, sharing o's material. Every attribute the source carries comes across — a copy that
  // kept only positions would light flat and sample the wrong part of its texture.
  function copyTrianglesToMap(o, tris, toMap) {
    const g = o.geometry
    const idx = g.index
    const src = g.attributes
    const names = Object.keys(src)
    const nrm = new THREE.Matrix3().getNormalMatrix(toMap)
    const count = tris.length * 3
    const dst = {}
    for (const name of names) dst[name] = new Float32Array(count * src[name].itemSize)
    const v = new THREE.Vector3()
    let w = 0
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const j = idx ? idx.getX(t + k) : t + k
        for (const name of names) {
          const a = src[name]
          const it = a.itemSize
          const at = w * it
          if (name === 'position') {
            v.set(a.getX(j), a.getY(j), a.getZ(j)).applyMatrix4(toMap)
            dst[name][at] = v.x; dst[name][at + 1] = v.y; dst[name][at + 2] = v.z
          } else if (name === 'normal' || name === 'tangent') {
            // A direction takes the normal matrix, not the transform: the group may scale.
            v.set(a.getX(j), a.getY(j), a.getZ(j)).applyMatrix3(nrm).normalize()
            dst[name][at] = v.x; dst[name][at + 1] = v.y; dst[name][at + 2] = v.z
            // A tangent's w is a handedness, not a coordinate.
            for (let q = 3; q < it; q++) dst[name][at + q] = a.getComponent(j, q)
          } else {
            // getComponent denormalises, so a byte-packed colour arrives as the float it means.
            for (let q = 0; q < it; q++) dst[name][at + q] = a.getComponent(j, q)
          }
        }
        w++
      }
    }
    const ng = new THREE.BufferGeometry()
    for (const name of names) ng.setAttribute(name, new THREE.BufferAttribute(dst[name], src[name].itemSize))
    const mesh = new THREE.Mesh(ng, o.material)
    mesh.name = (o.name || 'mesh') + '_skyleaf'
    return mesh
  }

  // ---- fog (fogFromEntities)
  //
  // Source units are the viewer's units, so `fogstart` / `fogend` go straight into three's
  // linear Fog. Three differences from the engine, all of them stated rather than papered over:
  //   - three's linear fog ramps with smoothstep between near and far; Source's is linear.
  //     The two agree at both ends and differ by at most ~10% of the factor in the middle.
  //   - `fogmaxdensity` is compiled into the fog chunk (fogChunkFor); see there.
  //   - `farz`, where a map sets one above zero, becomes the world camera's far plane, which is
  //     what it is. No map in the replay-holding set sets one, so nothing exercises it.
  // The fog colour also becomes the scene's clear colour, which is what shows where no sky
  // dome covers — a map with no sky reads as haze rather than as the viewer's own void blue.
  let skyFog = null
  function setFog(fog) {
    const f = fog && fog.world
    const chunk = fogChunkFor(f ? f.maxDensity : 1)
    if (THREE.ShaderChunk.fog_fragment !== chunk) {
      THREE.ShaderChunk.fog_fragment = chunk
      // Materials already compiled were built against the old chunk.
      scene.traverse((o) => {
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && m.fog) m.needsUpdate = true
      })
    }
    if (!f) {
      scene.fog = new THREE.Fog(DEFAULT_FOG.color, DEFAULT_FOG.near, DEFAULT_FOG.far)
      background.set(DEFAULT_FOG.color)
      applyBackground()
      state.fog = null
      return null
    }
    const c = new THREE.Color().setRGB(f.color[0], f.color[1], f.color[2], THREE.SRGBColorSpace)
    scene.fog = new THREE.Fog(c, f.start, f.end)
    background.copy(c)
    applyBackground()
    if (f.farz > 0) { camera.far = f.farz; camera.updateProjectionMatrix() }
    state.fog = { color: c.getHexString(), start: f.start, end: f.end, maxDensity: f.maxDensity, capped: chunk !== FOG_FRAGMENT_STOCK }
    return state.fog
  }

  // A blended terrain material: two textures, mixed by the displacement's painted alpha.
  //
  // Source calls it WorldVertexTransition — `$basetexture` under `$basetexture2`, and which one
  // you see at a vertex is the DISPLACEMENT's own vertex alpha (surf_boreas's mountains are
  // alpine_rock01 under alpine_snow01, so this is the snow). glTF has one albedo slot, so
  // scripts/replay3d/convert.py sends the second texture out on the emissive slot and the
  // `$blendmodulatetexture` on the normal slot, and says so in the material's extras — which
  // GLTFLoader hands back as `userData`. Nothing here fires on a material that does not carry
  // `r3d_blend2`, so a map baked before that step looks exactly as it did.
  //
  // The factor is COLOR_0.r: convert.py writes the painted alpha into R, G and B and pins A to 1
  // (SourceIO's `vertex_alpha` layer), and R is the channel that survives every exporter setting.
  // `vertexColors` has to be on for the attribute to reach the shader at all, so <color_fragment>
  // — three's "tint the surface by the vertex colour" — is replaced with nothing: Source blends
  // two textures with this number, it does not tint by it.
  //
  // $blendmodulatetexture, where the map has one, is the engine's own formula: the modulate
  // texture's green is where the transition sits and its red is how wide it is, so the factor is
  // smoothstep(g - r, g + r, alpha). A zero-width band would make smoothstep undefined, so that
  // degenerate case is a hard step, which is what a zero-width transition means.
  function applyBlendMaterial(m) {
    if (!m || !m.userData || !m.userData.r3d_blend2 || m.userData.r3dBlend) return false
    if (!m.map) return false
    const base2 = m.emissiveMap || null
    // prune() folds a texture that is one flat colour into the emissive FACTOR and drops the
    // image; that colour is still the second surface, so it stands in for the texture.
    const flat2 = m.emissive ? m.emissive.clone() : null
    if (!base2 && !flat2) return false
    const mod = m.userData.r3d_blendmod ? m.normalMap : null
    m.userData.r3dBlend = true
    m.emissiveMap = null
    if (m.emissive) m.emissive.setRGB(0, 0, 0)
    m.normalMap = null                    // the modulate texture is not a normal map
    m.vertexColors = true
    const sample2 = base2 ? 'texture2D( r3dBase2, vMapUv )' : 'vec4( r3dFlat2, 1.0 )'
    const factor = mod
      ? ['vec3 r3dM = texture2D( r3dBlendMod, vMapUv ).rgb;',
         'float r3dLo = r3dM.g - r3dM.r, r3dHi = r3dM.g + r3dM.r;',
         'r3dF = r3dHi > r3dLo ? smoothstep( r3dLo, r3dHi, r3dF ) : step( r3dLo, r3dF );'].join('\n')
      : ''
    m.onBeforeCompile = (shader) => {
      if (base2) shader.uniforms.r3dBase2 = { value: base2 }
      else shader.uniforms.r3dFlat2 = { value: flat2 }
      if (mod) shader.uniforms.r3dBlendMod = { value: mod }
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', [
          base2 ? 'uniform sampler2D r3dBase2;' : 'uniform vec3 r3dFlat2;',
          mod ? 'uniform sampler2D r3dBlendMod;' : '',
          'void main() {',
        ].filter(Boolean).join('\n'))
        .replace('#include <map_fragment>', [
          'float r3dF = vColor.r;',
          factor,
          'diffuseColor *= mix( texture2D( map, vMapUv ), ' + sample2 + ', r3dF );',
        ].filter(Boolean).join('\n'))
        .replace('#include <color_fragment>', '')
    }
    m.customProgramCacheKey = () => 'r3d-blend-' + (base2 ? 't' : 'f') + (mod ? 'm' : '')
    m.needsUpdate = true
    return true
  }

  // How the engine draws a material, where the glb cannot say it. `render` is the map's
  // <map>.materials.json `render` table (scripts/replay3d/materials.py), material name ->
  //
  //   'nodraw'      A face the engine never draws: the compiler's surface flags, %compilenodraw,
  //                 or the sky, which the viewer draws as its own box. SourceIO filters none of
  //                 them, so they arrive as ordinary geometry — on surf_4am the nodraw shell is
  //                 an opaque black wall standing in front of the stage 4 and 5 ramps. Hidden,
  //                 the same way TOOLS_HIDDEN_RE hides the ones it can recognise by name, and
  //                 the map's own flags recognise the ones a name never could.
  //   'additive'    ADDED to what is behind it: the black in the texture is see-through and only
  //                 the bright parts draw. glTF has no additive mode, so the texture comes out as
  //                 an opaque lit base colour and a texture that is black except for a few bright
  //                 lines becomes a black wall — surf_andromeda's ramps, in a 0x0b0d12 void.
  //                 Redrawn unlit (the engine does not shade what it adds) with no depth write.
  //   'translucent' See-through. That only matters where the exporter ALSO gave it no texture,
  //                 which is what a fully transparent texture comes out as: an opaque black
  //                 material. A material the map calls see-through and the file gives us nothing
  //                 to draw is not a wall, so it is hidden. One that kept its texture is left
  //                 alone — SourceIO already wrote its blend mode.
  //
  // A mesh is only hidden when EVERY material on it is hidden-class: leaving a nodraw face drawn
  // costs a black patch, and hiding a mesh that also carries real geometry costs the map.
  // Safe to call late and more than once; the map may land first.
  function applyMaterialRender(render) {
    if (!render || typeof render !== 'object') return { additive: 0, hidden: 0, panes: 0 }
    const out = { additive: 0, hidden: 0, panes: 0 }
    const hides = (m) => {
      const how = m ? render[String(m.name || '').toUpperCase()] : null
      return how === 'nodraw' || (how === 'translucent' && !m.map)
    }
    const panes = []
    mapGroup.traverse((o) => {
      if (!o.isMesh || !o.visible) return
      // A sky wall's render class is 'nodraw' — the compiler's SURF_SKY says the TEXTURE is
      // never drawn, which stopped being the whole story when the face became an occluder.
      if (o.userData.r3dSkywall) return
      // A backing pane is this function's own output, not map geometry.
      if (o.userData.r3dAdditivePane) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      if (mats.length && mats.every(hides)) { o.visible = false; out.hidden++; return }
      let changed = false
      const next = mats.map((m) => {
        if (!m || m.userData.r3dAdditive) return m
        if (render[String(m.name || '').toUpperCase()] !== 'additive') return m
        changed = true
        const b = new THREE.MeshBasicMaterial({
          // White where there is a texture — the map IS the colour, and tinting it would count
          // the colour twice. Where there is none, the base colour is all the material has:
          // convert.py's authored-colour step recovers it from the vmt's $color (or the base
          // texture's own average) for exactly the materials the exporter left flat, and an
          // additive face that threw it away would add white light instead of its own.
          name: m.name, map: m.map || null, color: m.map ? 0xffffff : (m.color ? m.color.clone() : 0xffffff),
          blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
          side: THREE.DoubleSide, toneMapped: false,
          // An additive face ADDS light; fog MIXES toward a colour, so a fogged additive face
          // is a face that adds the fog colour to whatever is behind it, which is not haze —
          // it is a glow the wrong colour. Additive faces (and the pane under them) are the
          // one class of map surface the map's fog does not reach.
          fog: false,
        })
        b.userData.r3dAdditive = true
        out.additive++
        return b
      })
      if (changed) {
        o.material = Array.isArray(o.material) ? next : next[0]
        // Additive draws OVER what is behind it and never darkens it, so every black texel of
        // an additive material contributes exactly nothing and the face has no body. On a grid
        // texture that is most of the face: bluegrid_02, the whole ramp surface of
        // surf_andromeda, is 128x128 with 76.6% of its texels pure black and a mean luminance
        // of 11.6/255. Drawn additive and nothing else, a ramp is a few glowing lines with
        // nothing between them; far enough away the mip chain averages the lines out too and
        // the ramp is a 4.5% haze over the cave behind it. That is the "invisible ramps".
        //
        // So an additive face gets a second pass under it: one pane, same geometry, in the
        // texture's own hue, faint. It gives the face a body at every distance while the
        // additive pass keeps the glow. A material that is mostly BRIGHT (a light shaft, a
        // holo panel) already has a body, so the pane fades out as the texture's mean rises —
        // paneOpacity is scaled by how much of the texture is dark.
        const pane = additivePane(o, next)
        if (pane) { panes.push(pane); out.panes++ }
      }
    })
    for (const [parent, pane] of panes) parent.add(pane)
    state.renderTable = out
    return out
  }

  // One faint pane under an additive mesh -> [parent, mesh], or null where the material is
  // bright enough not to need one. Shares the mesh's geometry: no new vertex data.
  const PANE_MAX_OPACITY = 0.34
  function additivePane(o, mats) {
    const m = mats.find((x) => x && x.userData.r3dAdditive)
    if (!m || !o.parent) return null
    const t = textureTone(m.map)
    if (!t) return null
    // Two conditions, and the pane fades out on either. `dark` is the share of the texture
    // that is BLACK, which is the share of the face that additive draws nothing at all for —
    // a grid is 0.77 of it, a glow or a light shaft has a gradient and is far less. `mean` is
    // how bright the material is overall: something already bright does not need a body.
    const strength = clamp01((t.dark - 0.35) / 0.45) * clamp01(1 - t.mean * 2)
    if (strength <= 0.02) return null
    const pane = new THREE.Mesh(o.geometry, new THREE.MeshBasicMaterial({
      name: m.name, color: t.hue, transparent: true, opacity: PANE_MAX_OPACITY * strength,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
    }))
    pane.userData.r3dAdditivePane = true
    pane.position.copy(o.position)
    pane.quaternion.copy(o.quaternion)
    pane.scale.copy(o.scale)
    pane.frustumCulled = o.frustumCulled
    // Whatever pass the face is in. A new Object3D is on layer 0, and a pane under a 3D-skybox
    // face left there is the one piece of the miniature drawn in the WORLD pass — at 1:1, in
    // front of the level.
    pane.layers.mask = o.layers.mask
    // Both passes are transparent, so three sorts them together; renderOrder is what says the
    // pane is underneath. Without it the two tie on depth (same geometry) and flip about.
    pane.renderOrder = o.renderOrder
    o.renderOrder = pane.renderOrder + 1
    return [o.parent, pane]
  }

  // A texture -> { mean, dark, hue }: its mean luminance 0..1, the share of its texels that are
  // black, and the hue that mean points at with the brightness divided out, which is the colour
  // a person calls the material. bluegrid_02 reads mean 0.045, dark 0.766, hue cyan.
  //
  // Read at the texture's own size (capped at 256) rather than off a small downsample: `dark`
  // is a count of black texels, and averaging a grid down turns black texels into grey ones.
  // Once per image, cached on the image.
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
  const toneCache = new WeakMap()
  function textureTone(tex) {
    const img = tex && tex.image
    if (!img || !img.width) return null
    if (toneCache.has(img)) return toneCache.get(img)
    let tone = null
    try {
      const N = Math.min(256, Math.max(8, img.width, img.height))
      const c = document.createElement('canvas')
      c.width = N; c.height = N
      const g = c.getContext('2d', { willReadFrequently: true })
      g.drawImage(img, 0, 0, N, N)
      const d = g.getImageData(0, 0, N, N).data
      let r = 0, gg = 0, b = 0, dark = 0
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]; gg += d[i + 1]; b += d[i + 2]
        if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 16) dark++
      }
      const n = d.length / 4
      r /= n * 255; gg /= n * 255; b /= n * 255
      const peak = Math.max(r, gg, b, 1e-4)
      tone = { mean: r * 0.299 + gg * 0.587 + b * 0.114, dark: dark / n, hue: new THREE.Color(r / peak, gg / peak, b / peak) }
    } catch (e) { tone = null /* a tainted or not-yet-decoded image: no pane, as before */ }
    toneCache.set(img, tone)
    return tone
  }

  // The sky: urls = { ft, bk, lf, rt, up, dn }. Any face that fails leaves the plain
  // background — the box only shows once all six loaded. Resolves true/false, never throws.
  async function setSky(urls) {
    if (!urls) return false
    const loader = new THREE.TextureLoader()
    const load = (u) => new Promise((resolve) => loader.load(u, (t) => resolve(t), undefined, () => resolve(null)))
    const texs = await Promise.all(SKY_FACES.map((f) => urls[f.face] ? load(urls[f.face]) : Promise.resolve(null)))
    if (texs.some((t) => !t)) { for (const t of texs) t && t.dispose(); return false }
    SKY_FACES.forEach((f, i) => {
      const t = texs[i]
      t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = THREE.ClampToEdgeWrapping
      t.wrapT = THREE.ClampToEdgeWrapping
      t.needsUpdate = true
      skyMats[i].map = t
      skyMats[i].color.set(0xffffff)
      skyMats[i].needsUpdate = true
    })
    // The map's own toolsskybox faces draw the same six faces, off the same table.
    skywall.setSky(SKY_FACES, texs)
    skyBox.visible = true
    // The same six faces light the world: an image-based environment (PMREM of the cube), and
    // the hemisphere's colours from the up and dn faces.
    try { installSkyEnvironment(texs) } catch (e) { /* no environment: the analytic lights stand */ }
    return true
  }

  // Sky faces -> the WORLD scene's environment. The viewmodel pass has its own studio
  // (vmEnvironment) and is untouched: a different scene, so scene.environment never reaches it.
  //
  // A WebGL cube map is addressed as if seen from OUTSIDE (the RenderMan convention: for face
  // +X the image's right edge is -Z and its top +Y; +Y's right is +X and top is +Z; and so on),
  // while the sky faces are drawn from INSIDE, so every face is mirrored once on its way in.
  // Working through the SKY_FACES table against that convention, in three's frame (three +Y =
  // Source +Z up, three +Z = Source -Y): the four side faces flip horizontally, up transposes,
  // dn transposes the other diagonal. Faces are drawn through a canvas at 256 px: PMREM only
  // needs that much, and it keeps the copy cheap.
  function installSkyEnvironment(texs) {
    const byName = {}
    SKY_FACES.forEach((f, i) => { byName[f.face] = texs[i].image })
    const N = 256
    const draw = (img, transform) => {
      const c = document.createElement('canvas')
      c.width = N; c.height = N
      const g = c.getContext('2d')
      g.setTransform(...transform)
      g.drawImage(img, 0, 0, N, N)
      return c
    }
    const flipH = [-1, 0, 0, 1, N, 0]
    const faces = [
      draw(byName.rt, flipH),                 // +X  (Source +X)
      draw(byName.lf, flipH),                 // -X  (Source -X)
      draw(byName.up, [0, 1, 1, 0, 0, 0]),    // +Y  (Source +Z): transpose
      draw(byName.dn, [0, -1, -1, 0, N, N]),  // -Y  (Source -Z): anti-transpose
      draw(byName.ft, flipH),                 // +Z  (Source -Y)
      draw(byName.bk, flipH),                 // -Z  (Source +Y)
    ]
    // Mean colours for the hemisphere: sky from up, ground from dn (darkened: a floor
    // bounces less than a sky emits).
    const mean = (canvas) => {
      const d = canvas.getContext('2d').getImageData(0, 0, N, N).data
      let r = 0, g = 0, b = 0
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2] }
      const n = d.length / 4
      return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace)
    }
    lighting.sky = mean(faces[2])
    lighting.ground = mean(faces[3]).multiplyScalar(0.45)
    const cube = new THREE.CubeTexture(faces)
    cube.colorSpace = THREE.SRGBColorSpace
    cube.needsUpdate = true
    const pmrem = new THREE.PMREMGenerator(renderer)
    const env = pmrem.fromCubemap(cube).texture
    pmrem.dispose()
    cube.dispose()
    if (scene.environment) scene.environment.dispose()
    scene.environment = env
    scene.environmentIntensity = 0.5
    lighting.hasEnvironment = true
    applyLights()
  }

  // The map's light_environment (lightingFromEntities): null keeps the neutral defaults.
  function setLighting(le) {
    lighting.env = le || null
    applyLights()
  }

  // Zones: [{ kind, min: [x,y,z], max: [x,y,z] }] in Source space.
  //
  // kind decides both the colour and the SHAPE. start / end / start-bonus / end-bonus / other
  // are volumes and are drawn as the box they are. start-mark / end-mark are not volumes at
  // all — they are the point a run began or finished on a map that carries no zone geometry —
  // so they are drawn as a flat disc, which cannot be mistaken for a timer box.
  //
  // A zone is drawn as its EDGES and nothing else (owner, 2026-08-19). The tinted faces this
  // used to carry stood between the camera and the map on every frame the run spent inside a
  // zone — a start box is bigger than the platform it sits on, so the whole first second of a
  // run was seen through a green wall. The edges alone say the same thing and hide nothing;
  // they carry the full colour, which the fill used to be doing half of.
  function setZones(zones) {
    while (zoneGroup.children.length) {
      const c = zoneGroup.children.pop()
      c.geometry && c.geometry.dispose()
      c.material && c.material.dispose()
    }
    for (const z of zones || []) {
      const sx = Math.max(1, z.max[0] - z.min[0])
      const sy = Math.max(1, z.max[1] - z.min[1])
      const sz = Math.max(1, z.max[2] - z.min[2])
      const color = z.kind === 'start' || z.kind === 'start-mark' ? 0x3ddc84
        : z.kind === 'end' || z.kind === 'end-mark' ? 0xff5c5c
        : z.kind === 'start-bonus' ? 0x1f7a4a : z.kind === 'end-bonus' ? 0x8a3a3a : 0x8899aa
      const isMark = z.kind === 'start-mark' || z.kind === 'end-mark'
      // The solid is built only to be read for its edges, and is thrown away in the same
      // breath — nothing but the LineSegments is ever added to the scene.
      const solid = isMark
        ? new THREE.CylinderGeometry(Math.max(sx, sy) / 2, Math.max(sx, sy) / 2, Math.max(2, sz), 24)
        : new THREE.BoxGeometry(sx, sy, sz)
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(solid),
        // A zone edge is a marker: it says where the timer's box is, at any distance, so the
        // map's fog does not wash it out.
        new THREE.LineBasicMaterial({ color, transparent: false, toneMapped: false, fog: false }),
      )
      solid.dispose()
      edges.position.set((z.min[0] + z.max[0]) / 2, (z.min[1] + z.max[1]) / 2, (z.min[2] + z.max[2]) / 2)
      // three's cylinder stands on Y; this scene is Source Z-up, so lay the disc flat.
      if (isMark) edges.rotation.x = Math.PI / 2
      zoneGroup.add(edges)
    }
  }

  function dispose() {
    for (const s of [scene, vmScene]) s.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) {
          if (!m) continue
          for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) v.dispose() }
          m.dispose()
        }
      }
    })
    vmEnvironment.dispose()
    skywall.dispose()
    if (scene.environment) { scene.environment.dispose(); scene.environment = null }
    renderer.dispose()
    renderer.forceContextLoss && renderer.forceContextLoss()
  }

  // Named, not returned as a literal: the governor's applyQuality calls api.resize(), which
  // installRouteLine wraps so a pixel-ratio step also re-sizes the fat line's materials.
  const api = {
    THREE, renderer, scene, camera, state, lighting,
    viewmodel, viewmodelCamera: vmCamera, viewmodelScene: vmScene,
    setViewmodel, setViewmodelVisible, setViewmodelFov, setMaxFps, setAutoQuality,
    isViewmodelVisible: () => vmVisible,
    setPose, setMode, render, resize, tickFree, drag, wheel, setGrid, loadMap, setMapYUp, precompile, applyMaterialRender, placeSkyCameraLeaf, setFog, setSky, setLighting, skyMats, skywall, setZones, dispose,
    setFreeAt(x, y, z, yaw, pitch) { toThree(x, y, z, state.freePos); state.freeYaw = yaw; state.freePitch = pitch },
  }
  return api
}

// entities.json -> zone boxes. Tolerant of a few shapes the exporter might emit:
//   { classname, targetname, mins:[..], maxs:[..] } (absolute) or
//   { classname, targetname, origin:[..], mins, maxs } (relative to origin) or
//   { ..., bbox: { min, max } } / { ..., min, max }.
export function zonesFromEntities(entities) {
  const out = []
  const list = Array.isArray(entities) ? entities : (entities && Array.isArray(entities.entities) ? entities.entities : [])
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const cls = String(e.classname || '').toLowerCase()
    const tn = String(e.targetname || '').toLowerCase()
    const isTrigger = cls === 'trigger_multiple' || cls === 'trigger_once' || cls.startsWith('climb_') || cls.startsWith('func_')
    let kind = null
    if (/start/.test(tn) || cls === 'climb_startbutton' || /timer_start|zone_start|start_zone/.test(tn)) kind = 'start'
    else if (/(^|_)(end|stop|finish)/.test(tn) || cls === 'climb_endbutton' || /timer_end|zone_end|end_zone/.test(tn)) kind = 'end'
    // Surf maps name their timer volumes <start|end>[bonus]_trigger and cp<N>_trigger — not
    // the climb_* buttons KZ uses and not shavit's mod_zone_*. start/end are caught above
    // (start_trigger contains "start", end_trigger starts with "end"); the checkpoints are
    // their own vocabulary and are drawn dimmed, as the stage/checkpoint rows of a timer
    // snapshot are. Verified on surf_aircontrol_ksf's entity lump, both bucket prefixes.
    if (!kind && isTrigger && /^cp\d+_trigger$/.test(tn)) kind = 'other'
    if (!kind && !(isTrigger && /zone|timer/.test(tn))) continue
    if (!kind) kind = 'other'
    // Bonus courses (climb_bonus1_startbutton …) are drawn but marked so the main course
    // is the one that reads as start/end.
    if (/bonus\d*/.test(tn)) kind = kind + '-bonus'
    let min = e.mins || e.min || (e.bbox && e.bbox.min)
    let max = e.maxs || e.max || (e.bbox && e.bbox.max)
    if (!Array.isArray(min) || !Array.isArray(max) || min.length < 3 || max.length < 3) continue
    min = min.map(Number); max = max.map(Number)
    const straddles = min[0] <= 0 && max[0] >= 0 && min[1] <= 0 && max[1] >= 0 && min[2] <= 0 && max[2] >= 0
    // The entities JSON carries `origin` as the raw keyvalue string and `origin_vec` as the
    // parsed triple. A brush entity WITH an origin has compiler-recentred bounds (they
    // straddle zero) — world AABB = origin + mins/maxs. Without an origin the bounds are
    // already world-space. Both forms occur on one map, so branch, never assume.
    let origin = Array.isArray(e.origin_vec) ? e.origin_vec : (Array.isArray(e.origin) ? e.origin : null)
    if (!origin && typeof e.origin === 'string') {
      const p = e.origin.trim().split(/\s+/).map(Number)
      if (p.length >= 3 && p.every(Number.isFinite)) origin = p
    }
    if (origin && origin.length >= 3 && (e.bbox_relative || (e.mins && straddles))) {
      const o = origin.map(Number)
      min = [min[0] + o[0], min[1] + o[1], min[2] + o[2]]
      max = [max[0] + o[0], max[1] + o[1], max[2] + o[2]]
    }
    if (min.some((v) => !Number.isFinite(v)) || max.some((v) => !Number.isFinite(v))) continue
    out.push({ kind, min, max, targetname: e.targetname || '', classname: e.classname || '' })
  }
  return out
}

// worldspawn `skyname` out of entities.json (the same shapes zonesFromEntities accepts).
export function skynameFromEntities(entities) {
  const list = Array.isArray(entities) ? entities : (entities && Array.isArray(entities.entities) ? entities.entities : [])
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    if (String(e.classname || '').toLowerCase() !== 'worldspawn') continue
    const kv = e.kv && typeof e.kv === 'object' ? e.kv : e
    const name = String(kv.skyname || '').trim().toLowerCase()
    return /^[a-z0-9_-]+$/.test(name) ? name : null
  }
  return null
}

// A `fogcolor` / `_light` style keyvalue -> [r, g, b] in 0..1 sRGB, or null.
function rgb01(s) {
  const p = String(s == null ? '' : s).trim().split(/\s+/).map(Number)
  if (p.length < 3 || !p.slice(0, 3).every(Number.isFinite)) return null
  return p.slice(0, 3).map((v) => Math.min(255, Math.max(0, v)) / 255)
}
// The fog keys shared by env_fog_controller and sky_camera -> { color, start, end, maxDensity,
// farz } or null when the entity's fog is off or unreadable. `fogcolor2` / `fogblend` /
// `fogdir` are the angle-blended second colour, which needs the view direction and a per-frame
// uniform; only `fogcolor` is read, and `fogblend` is 0 on every map in the replay-holding set.
function fogKeys(kv) {
  if (String(kv.fogenable) !== '1') return null
  const color = rgb01(kv.fogcolor)
  const start = Number(kv.fogstart)
  const end = Number(kv.fogend)
  if (!color || !Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return null
  const d = Number(kv.fogmaxdensity)
  const farz = Number(kv.farz)
  return { color, start, end, maxDensity: Number.isFinite(d) && d > 0 && d <= 1 ? d : 1, farz: Number.isFinite(farz) && farz > 0 ? farz : 0 }
}

// entities.json -> { world, sky }: the map's fog and the 3D skybox's own fog, either of which
// may be null. `world` is the env_fog_controller the engine would obey — the one flagged MASTER
// (spawnflags bit 0, fogcontroller.cpp SF_FOG_MASTER), else the first one that is enabled. Seven
// maps in the replay-holding set carry two controllers, which is why the flag is read at all.
export function fogFromEntities(entities) {
  const list = Array.isArray(entities) ? entities : (entities && Array.isArray(entities.entities) ? entities.entities : [])
  let first = null
  let master = null
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    if (String(e.classname || '').toLowerCase() !== 'env_fog_controller') continue
    const kv = e.kv && typeof e.kv === 'object' ? e.kv : e
    const f = fogKeys(kv)
    if (!f) continue
    if (!first) first = f
    if (!master && (Number(kv.spawnflags) & 1)) master = f
  }
  const box = skyboxFromEntities(entities)
  return { world: master || first || null, sky: box ? box.fog : null }
}

// sky_camera out of entities.json -> { origin, scale, fog } in Source units, or null. The entity
// is the eye the engine renders the 3D skybox from, so it sits inside the miniature: it is the
// one thing in the file that says where that block of geometry is, how much bigger it is drawn
// (`scale`, 16 on 62 of the 79 maps that have one) and what fog it is drawn through.
export function skyboxFromEntities(entities) {
  const list = Array.isArray(entities) ? entities : (entities && Array.isArray(entities.entities) ? entities.entities : [])
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    if (String(e.classname || '').toLowerCase() !== 'sky_camera') continue
    const kv = e.kv && typeof e.kv === 'object' ? e.kv : e
    const o = e.origin_vec || e.origin || kv.origin_vec || kv.origin
    const v = Array.isArray(o) ? o.map(Number) : String(o || '').trim().split(/\s+/).map(Number)
    if (v.length !== 3 || !v.every((n) => Number.isFinite(n))) continue
    const s = Number(kv.scale)
    return { origin: v, scale: Number.isFinite(s) && s >= 1 ? s : 16, fog: fogKeys(kv) }
  }
  return null
}

// light_environment out of entities.json -> { dir, color, brightness, ambient } or null.
//   dir        unit vector, Source frame, the way the light TRAVELS. VRAD
//              (SetupLightNormalFromProps): x = cos(pitch) cos(yaw), y = cos(pitch) sin(yaw),
//              z = sin(pitch), with the `pitch` key overriding angles' pitch when it is set and
//              non-zero -- so the usual "-90 = straight down" gives z = -1. Note the sign: this is
//              NOT Source's view-angle forward (which has z = -sin), and using that would put the
//              sun underground.
//   color      _light rgb (0-255 sRGB) as a linear THREE.Color; brightness its 4th number
//   ambient    _ambient rgb the same way, or null when the key is missing
export function lightingFromEntities(entities) {
  const list = Array.isArray(entities) ? entities : (entities && Array.isArray(entities.entities) ? entities.entities : [])
  const nums = (s) => String(s == null ? '' : s).trim().split(/\s+/).map(Number)
  const colorOf = (s) => {
    const p = nums(s)
    if (p.length < 3 || !p.slice(0, 3).every(Number.isFinite)) return null
    const c = new THREE.Color().setRGB(THREE.MathUtils.clamp(p[0], 0, 255) / 255, THREE.MathUtils.clamp(p[1], 0, 255) / 255, THREE.MathUtils.clamp(p[2], 0, 255) / 255, THREE.SRGBColorSpace)
    return { color: c, brightness: Number.isFinite(p[3]) ? p[3] : 200 }
  }
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    if (String(e.classname || '').toLowerCase() !== 'light_environment') continue
    const kv = e.kv && typeof e.kv === 'object' ? e.kv : e
    const ang = nums(kv.angles)
    let pitch = ang.length >= 1 && Number.isFinite(ang[0]) ? ang[0] : 0
    const yaw = ang.length >= 2 && Number.isFinite(ang[1]) ? ang[1] : 0
    const pk = Number(kv.pitch)
    if (Number.isFinite(pk) && pk !== 0) pitch = pk
    const p = pitch * DEG
    const y = yaw * DEG
    const dir = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)]
    const light = colorOf(kv._light) || { color: new THREE.Color(1, 1, 1), brightness: 200 }
    const amb = colorOf(kv._ambient)
    return { dir, color: light.color, brightness: light.brightness, ambient: amb ? amb.color : null, ambientBrightness: amb ? amb.brightness : null }
  }
  return null
}

// World FOV (the eyes camera): CS:GO fov_desired, 60..120, default 90 — a Source FOV, so the
// same horizontal-4:3 -> vertical conversion the viewmodel FOV uses. Kept out of createScene as
// an installer so it is one isolated addition: installWorldFov(api) gives the returned scene
// object a setWorldFov(deg), which stores state.worldFov; updateCamera reads it in Eyes cam
// (Follow / Free keep their fixed FOVs).
export function installWorldFov(api) {
  api.setWorldFov = function setWorldFov(deg) {
    const f = Number(deg)
    if (!Number.isFinite(f)) return
    api.state.worldFov = Math.max(5, Math.min(120, f))   // 5, not 60: ADS zooms to the gun's adsZoomFov (§14)
  }
  return api
}

// Fullbright: the flat studio pair the viewer lit the map with before it had the map's own
// sun and sky (hemisphere 0xdfe6f2 / 0x2a2f3a at 1.4, a white directional at 0.9 from
// (2000, 6000, 3000), no environment). Kept out of createScene as an installer, like the world
// FOV: installFullbright(api) gives the scene object a setFullbright(on). On, it parks the
// scene's environment and writes the old values straight onto the two world lights; off, it
// puts the environment back and re-runs the map lighting through setLighting. setSky and
// setLighting are wrapped so a sky or a light_environment landing while fullbright is on does
// not switch the map's lighting back under it. The viewmodel pass (its own scene, its own
// lights, its own environment) is never touched.
export function installFullbright(api) {
  const { THREE, scene } = api
  const hemi = scene.children.find((o) => o.isHemisphereLight)
  const sun = scene.children.find((o) => o.isDirectionalLight)
  const st = { on: false, env: null }
  const applyFlat = () => {
    if (!hemi || !sun) return
    if (scene.environment) { st.env = scene.environment; scene.environment = null }
    hemi.color.set(0xdfe6f2); hemi.groundColor.set(0x2a2f3a); hemi.intensity = 1.4
    sun.color.set(0xffffff); sun.intensity = 0.9; sun.position.set(2000, 6000, 3000)
  }
  const restore = () => {
    if (st.env && !scene.environment) { scene.environment = st.env; st.env = null }
    api.setLighting(api.lighting ? api.lighting.env : null)
  }
  const setSky0 = api.setSky
  api.setSky = async function setSky(urls) {
    const r = await setSky0.call(api, urls)
    if (st.on) applyFlat()
    return r
  }
  const setLighting0 = api.setLighting
  api.setLighting = function setLighting(le) {
    setLighting0.call(api, le)
    if (st.on) applyFlat()
  }
  api.setFullbright = function setFullbright(on) {
    st.on = !!on
    api.state.fullbright = st.on
    if (st.on) applyFlat()
    else restore()
  }
  api.state.fullbright = false
  return api
}

// ---- The route line: where the run goes, drawn whole, before it goes there.
//
// Owner, 2026-08-19: "a trail of which direction they go in, but it should be persistent, even
// ahead of them, so you can see which way they go before they even go that way, like they're
// following a line." So this is NOT a trail that accumulates behind the runner — it is the
// WHOLE run's path, built once when the replay lands and never rebuilt. What moves is one
// uniform: where the runner is along it.
//
// Which half is bright: the part AHEAD, at full strength; the part already travelled dims to
// ROUTE_BEHIND. That way round because the line is an instruction, not a record — the thing a
// person is reading it for is the corner that has not happened yet, and a line that brightens
// as it is consumed puts the emphasis on the part they have already watched.
//
// Two passes, same geometry:
//   solid   depthTest on, so the line is behind the wall it is behind and the picture stays
//           readable as a picture;
//   (a depthTest-off ghost pass was tried and cut by the owner: a route seen through walls is
//   noise). It does not write depth, so nothing the map draws is disturbed.
//
// Screen-space width, not world units (LineMaterial with worldUnits false): a line 2.6 CSS px
// wide reads the same in the map page's small card and in a fullscreen viewer, and does not
// swell into a pipe when the camera is close to it.
const ROUTE_LIFT = 12          // Source units above the recorded origin, which is the FEET.
                               // Enough to clear a ramp face without z-fighting it, low enough
                               // that the line is on the surface rather than at knee height.
const ROUTE_WIDTH = 2.6        // CSS px
const ROUTE_AHEAD = 0.92       // opacity of the part not yet run
const ROUTE_BEHIND = 0.30      // ... and of the part already run
const ROUTE_EPS = 4            // Ramer-Douglas-Peucker tolerance, Source units
const ROUTE_MAX_POINTS = 3000  // and the cap the tolerance is raised to meet
const ROUTE_BREAK = 400        // a step longer than this is a teleport, not a segment. The same
                               // number the frame loops use to refuse to interpolate.
const ROUTE_FEATHER = 0.004    // the head's crossfade, in fractions of the run

// The line's colour is the site's own game plate — theme.css --plate-csgo / --plate-css, the
// two saturated hues the site already uses to say which game you are looking at. Not gold, not
// green, not red: those three are the signal family and each of them already means something
// about a value (a record, good, bad), and a route is not a value. The CS:GO plate is the
// authentic Counter-Strike orange, which is what makes the line read as belonging to the game
// rather than to the browser.
export function routeColor(game) {
  return String(game || '').startsWith('css') ? 0x4e9cee : 0xf0962b
}

// Ramer-Douglas-Peucker over a flat xyz array, point indices lo..hi inclusive -> a Uint8Array
// of keeps. Iterative, with an explicit stack: a ten-minute bhop run is 60 000 points and the
// recursive form is a stack overflow on the first straight corridor.
function routeSimplify(p, lo, hi, eps) {
  const keep = new Uint8Array(hi - lo + 1)
  keep[0] = 1
  keep[hi - lo] = 1
  const e2 = eps * eps
  const stack = [lo, hi]
  while (stack.length) {
    const b = stack.pop()
    const a = stack.pop()
    if (b - a < 2) continue
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2]
    const dx = p[b * 3] - ax, dy = p[b * 3 + 1] - ay, dz = p[b * 3 + 2] - az
    const dd = dx * dx + dy * dy + dz * dz
    let best = -1
    let bestD = 0
    for (let i = a + 1; i < b; i++) {
      const px = p[i * 3] - ax, py = p[i * 3 + 1] - ay, pz = p[i * 3 + 2] - az
      let t = dd > 0 ? (px * dx + py * dy + pz * dz) / dd : 0
      if (t < 0) t = 0; else if (t > 1) t = 1
      const qx = px - dx * t, qy = py - dy * t, qz = pz - dz * t
      const d = qx * qx + qy * qy + qz * qz
      if (d > bestD) { bestD = d; best = i }
    }
    if (best >= 0 && bestD > e2) { keep[best - lo] = 1; stack.push(a, best, best, b) }
  }
  return keep
}

// The run window's origins -> the points the line is drawn through, and the tick each one sits
// on. Split at teleports so a saveloc does not draw a straight line across the map, simplified
// per piece, and the tolerance doubles until the whole thing fits ROUTE_MAX_POINTS.
export function routePoints(origin, from, to, opts = {}) {
  const lift = opts.lift == null ? ROUTE_LIFT : opts.lift
  const t0 = Math.max(0, Math.floor(from))
  const t1 = Math.min(Math.floor(origin.length / 3) - 1, Math.floor(to))
  if (!(t1 > t0)) return { pts: [], ticks: [], from: t0, to: t1 }
  // The pieces: contiguous runs of ticks with no teleport-sized step between them.
  const cuts = [t0]
  for (let i = t0 + 1; i <= t1; i++) {
    const dx = origin[i * 3] - origin[(i - 1) * 3]
    const dy = origin[i * 3 + 1] - origin[(i - 1) * 3 + 1]
    const dz = origin[i * 3 + 2] - origin[(i - 1) * 3 + 2]
    if (dx * dx + dy * dy + dz * dz > ROUTE_BREAK * ROUTE_BREAK) cuts.push(i)
  }
  cuts.push(t1 + 1)
  let eps = opts.eps == null ? ROUTE_EPS : opts.eps
  let pieces = null
  for (let round = 0; round < 8; round++) {
    pieces = []
    let n = 0
    for (let c = 0; c + 1 < cuts.length; c++) {
      const lo = cuts[c]
      const hi = cuts[c + 1] - 1
      if (hi <= lo) continue
      const keep = routeSimplify(origin, lo, hi, eps)
      const idx = []
      for (let i = 0; i < keep.length; i++) if (keep[i]) idx.push(lo + i)
      if (idx.length > 1) { pieces.push(idx); n += idx.length }
    }
    if (n <= ROUTE_MAX_POINTS) break
    eps *= 2
  }
  // Flattened, as segment pairs: LineSegmentsGeometry takes start/end per segment, which is
  // what lets a teleport be a GAP rather than a stripe. Consecutive segments share an endpoint,
  // and LineMaterial caps every segment round, so a shared endpoint reads as a joint.
  const pts = []
  const ticks = []
  for (const idx of pieces) {
    for (let i = 0; i + 1 < idx.length; i++) {
      const a = idx[i], b = idx[i + 1]
      pts.push(origin[a * 3], origin[a * 3 + 1], origin[a * 3 + 2] + lift)
      pts.push(origin[b * 3], origin[b * 3 + 1], origin[b * 3 + 2] + lift)
      ticks.push(a, b)
    }
  }
  return { pts, ticks, from: t0, to: t1, eps }
}

// installRouteLine(api) gives the scene object:
//   setRouteLine(origin, from, to, { color })  build it, once, from the decoded ticks
//   setRouteHead(tick)                          where the runner is (a fractional tick index)
//   setRouteVisible(on)                         show/hide without rebuilding
//   clearRouteLine()                            drop it and free the buffers
// Kept out of createScene as an installer, like the world FOV and Fullbright: three's fat-line
// classes are only reachable through this function, so a viewer that never asks for a route
// line still pays for them (they are in the same chunk) but nothing else in the scene changes.
export function installRouteLine(api) {
  const { scene } = api
  const group = new THREE.Group()
  group.name = 'routeLine'
  group.visible = false
  group.renderOrder = 2
  scene.add(group)
  const head = { value: 0 }
  let built = null   // { geometry, mats: [], first, last }

  // The two materials differ only in depthTest and in how far their opacity is knocked down.
  // The split is a shader patch rather than a vertex-colour rewrite because the runner moves
  // every frame and the geometry must not: each segment carries its own normalised position
  // along the run (aRouteStart/aRouteEnd), and `uRouteHead` is the only thing that changes.
  function routeMaterial(color, opacity, depthTest) {
    const m = new LineMaterial({
      color, linewidth: ROUTE_WIDTH, transparent: true, opacity,
      depthTest, depthWrite: false, worldUnits: false, toneMapped: false,
    })
    m.fog = true
    m.uniforms.uRouteHead = head
    m.uniforms.uRouteBehind = { value: ROUTE_BEHIND }
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('uniform float linewidth;',
          'uniform float linewidth;\nattribute float aRouteStart;\nattribute float aRouteEnd;\nvarying float vRouteT;')
        .replace('vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );',
          'vRouteT = ( position.y < 0.5 ) ? aRouteStart : aRouteEnd;\n\t\t\tvec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <clipping_planes_pars_fragment>',
          '#include <clipping_planes_pars_fragment>\nuniform float uRouteHead;\nuniform float uRouteBehind;\nvarying float vRouteT;')
        .replace('gl_FragColor = vec4( diffuseColor.rgb, alpha );',
          'gl_FragColor = vec4( diffuseColor.rgb, alpha * mix( uRouteBehind, 1.0, smoothstep( uRouteHead - ' + ROUTE_FEATHER.toFixed(4) + ', uRouteHead + ' + ROUTE_FEATHER.toFixed(4) + ', vRouteT ) ) );')
    }
    return m
  }

  function sizeMaterials() {
    if (!built) return
    const w = api.renderer.domElement.clientWidth || 1
    const h = api.renderer.domElement.clientHeight || 1
    for (const m of built.mats) m.resolution.set(w, h)
  }

  api.clearRouteLine = function clearRouteLine() {
    while (group.children.length) group.remove(group.children[0])
    if (built) {
      built.geometry.dispose()
      for (const m of built.mats) m.dispose()
      built = null
    }
  }

  api.setRouteLine = function setRouteLine(origin, from, to, opts = {}) {
    api.clearRouteLine()
    if (!origin || !origin.length) return 0
    const r = routePoints(origin, from, to, opts)
    if (r.pts.length < 6) return 0
    // Source -> three, in place: the line is added to the scene directly rather than to
    // mapGroup, so it carries the same conversion every other converted point does.
    const xyz = new Float32Array(r.pts.length)
    for (let i = 0; i < r.pts.length; i += 3) {
      xyz[i] = r.pts[i]
      xyz[i + 1] = r.pts[i + 2]
      xyz[i + 2] = -r.pts[i + 1]
    }
    const span = Math.max(1, r.to - r.from)
    const segs = r.ticks.length / 2
    const aStart = new Float32Array(segs)
    const aEnd = new Float32Array(segs)
    for (let s = 0; s < segs; s++) {
      aStart[s] = (r.ticks[s * 2] - r.from) / span
      aEnd[s] = (r.ticks[s * 2 + 1] - r.from) / span
    }
    const geometry = new LineSegmentsGeometry()
    geometry.setPositions(xyz)
    geometry.setAttribute('aRouteStart', new THREE.InstancedBufferAttribute(aStart, 1))
    geometry.setAttribute('aRouteEnd', new THREE.InstancedBufferAttribute(aEnd, 1))
    // White, and ONE depth-tested pass: a wall hides the line behind it, the sky hides it too
    // (the sky walls write depth). The owner cut the x-ray ghost pass — a route seen through
    // walls is noise, not help.
    const color = opts.color == null ? 0xffffff : opts.color
    const solid = routeMaterial(color, ROUTE_AHEAD, true)
    const mSolid = new LineSegments2(geometry, solid)
    // The frustum is not culled: a run's bounding box is most of the map and the computed one
    // for an instanced fat line is the quad template, not the path.
    mSolid.renderOrder = 2
    mSolid.frustumCulled = false
    group.add(mSolid)
    built = { geometry, mats: [solid], first: r.from, last: r.to }
    sizeMaterials()
    api.setRouteHead(r.from)
    api.state.routeSegments = segs
    return segs
  }

  api.setRouteHead = function setRouteHead(tick) {
    if (!built) return
    const t = (Number(tick) - built.first) / Math.max(1, built.last - built.first)
    head.value = t < 0 ? 0 : t > 1 ? 1 : t
  }

  api.setRouteVisible = function setRouteVisible(on) {
    group.visible = !!on
    api.state.routeVisible = !!on
  }
  api.isRouteVisible = () => group.visible

  // A fat line's width is in screen pixels, so it has to be told the size of the screen.
  const resize0 = api.resize
  api.resize = function resize() { resize0.call(api); sizeMaterials() }
  const dispose0 = api.dispose
  api.dispose = function dispose() { api.clearRouteLine(); dispose0.call(api) }

  api.state.routeVisible = false
  api.state.routeSegments = 0
  return api
}
