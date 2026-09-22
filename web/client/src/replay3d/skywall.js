// Replay 3D — sky occluders ("sky walls").
//
// A staged map separates its arenas with brush faces textured `tools/toolsskybox` (or
// `toolsskybox2d`). In the engine those faces draw the SKY and WRITE DEPTH: you see sky where
// the mapper put it, and everything behind that face is occluded. The viewer used to HIDE them
// so its own sky dome showed through — which turned every skybox wall into a WINDOW, and on
// surf_listless_ksf you could see every other stage's arena through the walls.
//
// So: draw them. A sky wall here is a mesh that samples the map's OWN sky by view direction —
// the same six faces `setSky()` loaded for the dome — with no lighting, no fog, depthWrite and
// depthTest ON, in the ordinary opaque pass with the rest of the map. The picture across the
// boundary between a wall and the dome is then the same picture, and the geometry behind the
// wall is gone, exactly as in game.
//
// SAMPLING. Not a cube map. The obvious build — a CubeTexture and `textureCube` — has to guess
// three's `flipEnvMap` convention against the mirrored canvases the environment cube is made
// of, and guessing it wrong shows the wrong quarter of the sky on every wall (measured on
// surf_andromeda: the walls drew a different sky from the dome across the same frame). So this
// shader does what the DOME does, off the dome's own table: the six faces come with the Source
// basis `SKY_FACES` gives them (the image's right edge and top edge as world directions, the
// entry pixel-checked against sky148), the view direction picks the face it points at, and the
// uv is where that ray crosses that face's plane. Same table, same textures, same uv — the two
// cannot disagree.
//
// Where no sky loaded, the material still exists and still writes depth: it draws the scene's
// background colour. A map with a missing or unnamed sky (surf_listless_ksf's entity lump comes
// out empty, so it has no `skyname` at all) occludes correctly and shows flat background rather
// than a window into stage 4.
//
// Meshes converted here carry `userData.r3dSkywall = true`. That flag is what keeps them out of
// the material-render hide pass (the map's own render table calls a sky face 'nodraw', which is
// true of the TEXTURE and no longer true of the face) and out of the footstep raycast, which
// must never resolve a step against a tool face.

import * as THREE from 'three'

// Only the two sky tool textures. Everything else TOOLS_HIDDEN_RE matches — nodraw, trigger,
// clip, playerclip, invisible, skip, hint — stays hidden: those really are never drawn.
export const SKYWALL_RE = /toolsskybox2d|toolsskybox/i

export function isSkywallName(name) {
  return SKYWALL_RE.test(String(name || ''))
}

const VERT = `
varying vec3 vDir;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vDir = world.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * world;
}`

// uM[i] is the direction the face lies in (the dome plane's inward normal), uRight/uUp its
// image axes — all in the SOURCE frame, which is why the view direction is converted first:
// three (x, y, z) is Source (x, -z, y). The face is the one the ray points most directly at;
// the uv is where the ray crosses that face's plane, in [0,1] by construction because the plane
// is a square of the same half-extent as its distance.
const FRAG = `
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uTex2;
uniform sampler2D uTex3;
uniform sampler2D uTex4;
uniform sampler2D uTex5;
uniform vec3 uRight[6];
uniform vec3 uUp[6];
uniform vec3 uM[6];
uniform vec3 uBackground;
uniform float uHasSky;
varying vec3 vDir;

void main() {
  vec3 t = normalize(vDir);
  vec3 d = vec3(t.x, -t.z, t.y);
  int face = 0;
  float best = -1.0;
  for (int i = 0; i < 6; i++) {
    float k = dot(d, uM[i]);
    if (k > best) { best = k; face = i; }
  }
  vec2 uv = vec2(0.5);
  for (int i = 0; i < 6; i++) {
    if (i == face) {
      float k = max(dot(d, uM[i]), 1e-6);
      uv = vec2(dot(d, uRight[i]), dot(d, uUp[i])) / k * 0.5 + 0.5;
    }
  }
  vec4 c = vec4(uBackground, 1.0);
  if (face == 0) c = texture2D(uTex0, uv);
  else if (face == 1) c = texture2D(uTex1, uv);
  else if (face == 2) c = texture2D(uTex2, uv);
  else if (face == 3) c = texture2D(uTex3, uv);
  else if (face == 4) c = texture2D(uTex4, uv);
  else c = texture2D(uTex5, uv);
  gl_FragColor = vec4(mix(uBackground, c.rgb, uHasSky), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

// One material for every sky face in the map: they all draw the same thing, and sharing it
// means the sky landing is a handful of uniform writes rather than a traversal.
export function createSkywall(background = 0x0b0d12) {
  const zeros = () => [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector3())
  const material = new THREE.ShaderMaterial({
    name: 'r3d_skywall',
    uniforms: {
      uTex0: { value: null }, uTex1: { value: null }, uTex2: { value: null },
      uTex3: { value: null }, uTex4: { value: null }, uTex5: { value: null },
      uRight: { value: zeros() },
      uUp: { value: zeros() },
      uM: { value: zeros() },
      uBackground: { value: new THREE.Color(background) },
      uHasSky: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    // The whole point: opaque, depth-writing, drawn with the map.
    transparent: false,
    depthWrite: true,
    depthTest: true,
    fog: false,
    // The map is drawn double-sided (see scene.js loadMap); a sky wall is a map face and
    // follows it, or an arena's far wall vanishes when the camera is on its back side.
    side: THREE.DoubleSide,
    toneMapped: true,
  })

  return {
    material,
    // `faces` is scene.js's SKY_FACES (in order), `texs` the six loaded textures in the same
    // order. Passing the table in rather than importing it keeps this module off scene.js.
    setSky(faces, texs) {
      const ok = Array.isArray(texs) && texs.length === 6 && texs.every(Boolean)
      const u = material.uniforms
      if (ok) {
        faces.forEach((f, i) => {
          u.uRight.value[i].fromArray(f.right)
          u.uUp.value[i].fromArray(f.up)
          // The dome puts the plane at -normal * half, so the face lies along -(right x up).
          u.uM.value[i].crossVectors(u.uRight.value[i], u.uUp.value[i]).negate()
        })
        for (let i = 0; i < 6; i++) u['uTex' + i].value = texs[i]
      }
      u.uHasSky.value = ok ? 1 : 0
      material.needsUpdate = true
      return ok
    },
    setBackground(color) { material.uniforms.uBackground.value.set(color) },
    // Depth-only, for a map that has a 3D skybox placed (scene.js placeSkyCameraLeaf).
    //
    // The engine shows the 2D sky AND the 3D skybox THROUGH a sky-textured face; this shader
    // only knows the 2D dome, so painting it is what hid every distant mountain behind every
    // window a mapper cut with a sky face. It does not have to paint at all: the 3D-skybox pass
    // runs first and has already drawn the dome and the miniature over the whole frame, so the
    // right picture is in the colour buffer before this face is reached. All the face still has
    // to do is what it was converted for — write depth, so the next arena stays hidden.
    //
    // Only flipped where a miniature actually landed. A map with no sky_camera keeps painting,
    // which is the same frame it has always drawn.
    setDepthOnly(on) {
      const v = !!on
      if (material.colorWrite === !v) return
      material.colorWrite = !v
      material.needsUpdate = true
    },
    // Swap the sky-textured entries of one mesh's material for the occluder, and flag the mesh.
    // Returns true when this mesh is a sky wall. A mesh whose materials are ALL sky is the
    // normal case; a mixed mesh keeps its real materials and still occludes on the sky slots.
    convert(mesh) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      if (!mats.some((m) => m && isSkywallName(m.name))) return false
      const next = mats.map((m) => (m && isSkywallName(m.name) ? material : m))
      mesh.material = Array.isArray(mesh.material) ? next : next[0]
      mesh.userData.r3dSkywall = true
      return true
    },
    // The textures belong to setSky (the dome shares them and disposes them); only the
    // material is this module's to free.
    dispose() { material.dispose() },
  }
}
