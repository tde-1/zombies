#!/usr/bin/env node
// Shrink export_map.py's raw .glb for the web -- ENW Movement's recipe, unchanged in kind
// (CSGO-Matchmaker/scripts/replay3d/optimize.js): dedup + flatten + prune, textures to WebP
// at <= N px, NORMAL to 8-bit and TEXCOORD_0 to 16-bit through KHR_mesh_quantization.
//
//   node tools/maps/optimize_glb.cjs <in.glb> <out.glb> [texture-size=512] [--quality 80]
//
// NO Draco / meshopt / KTX2, for the same reason as Movement: each needs a decoder in the
// viewer (a WASM one for meshopt and Basis, which a strict script-src refuses, and ~300 KB of
// decoder for Draco), while KHR_mesh_quantization and EXT_texture_webp are read by three's
// stock GLTFLoader with nothing registered. POSITION stays float32: quantizing it snaps the
// map to a grid and opens seams between surfaces (Movement measured it on brush faces; a
// Husky shell is the same kind of mesh).
//
// Libraries: @gltf-transform/* 4.x (MIT) and sharp (Apache-2.0), resolved from the same
// shared prefix Movement uses (R3D_NODE_PREFIX, default C:/Users/b/tools/r3dnode) -- nothing
// is added to this repo's package.json.
'use strict'
const path = require('path')
function req(name) {
  const cands = [name, path.join(process.env.R3D_NODE_PREFIX || 'C:/Users/b/tools/r3dnode', 'node_modules', name)]
  let last
  for (const c of cands) { try { return require(c) } catch (e) { last = e } }
  throw last
}
const { NodeIO } = req('@gltf-transform/core')
const { ALL_EXTENSIONS, KHRMeshQuantization } = req('@gltf-transform/extensions')
const { dedup, prune, flatten, textureCompress, quantize } = req('@gltf-transform/functions')
const sharp = req('sharp')

async function main() {
  const argv = process.argv.slice(2)
  const qi = argv.indexOf('--quality')
  const quality = qi >= 0 ? Number(argv[qi + 1]) : 80
  const pos = argv.filter((a, i) => a !== '--quality' && argv[i - 1] !== '--quality')
  const [inp, out, sizeArg] = pos
  const size = Number(sizeArg || 512)
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const doc = await io.read(inp)
  await doc.transform(
    // export_map.py already writes one mesh per model and many nodes; dedup() finishes the
    // job across accessors, materials and textures (a texture two models both carry).
    dedup(),
    flatten(),
    prune({ keepAttributes: false }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality }),
    dedup({ propertyTypes: ['Texture', 'Material'] }),
  )
  await doc.transform(
    quantize({ pattern: /^(NORMAL|TEXCOORD_0)$/, quantizeNormal: 8, quantizeTexcoord: 16 }),
  )
  // gltf-transform 4.4 decides whether to declare KHR_mesh_quantization from POSITION's
  // component size alone, so with POSITION float (as here) it never declares it and the file
  // would carry 8-bit normals no loader may accept. Declared from the attributes instead --
  // Movement hit and fixed the same thing.
  const root = doc.getRoot()
  const quantized = root.listMeshes().some((m) => m.listPrimitives().some((p) => p.listSemantics()
    .some((s) => (s === 'NORMAL' || s === 'TEXCOORD_0') && p.getAttribute(s).getComponentSize() < 4)))
  if (quantized) doc.createExtension(KHRMeshQuantization).setRequired(true)
  await io.write(out, doc)
  let tris = 0
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
    const ix = p.getIndices()
    tris += Math.floor((ix ? ix.getCount() : p.getAttribute('POSITION').getCount()) / 3)
  }
  console.log(JSON.stringify({
    meshes: root.listMeshes().length, nodes: root.listNodes().length,
    textures: root.listTextures().length, materials: root.listMaterials().length,
    unique_tris: tris, texture_size: size, quality, quantized,
  }))
}
main().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1) })
