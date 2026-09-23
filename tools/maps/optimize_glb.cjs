#!/usr/bin/env node
// Shrink export_map.py's raw .glb for the web -- ENW Movement's recipe
// (CSGO-Matchmaker/scripts/replay3d/optimize.js): dedup + flatten + prune, textures to WebP
// at <= N px, NORMAL to 8-bit and TEXCOORD_0 to 16-bit through KHR_mesh_quantization -- plus
// one step Movement does not take, meshopt, for the file that is served.
//
//   node tools/maps/optimize_glb.cjs <in.glb> <out.glb> [texture-size=512] [--quality 80]
//                                    [--meshopt <served.glb>]
//
// <out.glb> is the CHECKABLE file: float32 POSITION and plain buffers, so export_all.py's
// validator and web/server/lib/mapAlign.js read engine units straight out of it.
//
// --meshopt writes the SERVED file from exactly that document: EXT_meshopt_compression via
// gltf-transform's meshopt(), POSITION quantized to 16 bits per mesh with a node transform to
// undo it -- or kept float when one 16-bit step over the shell would exceed a unit (a map with
// far-flung pieces). Over Shi No Numa's 17 000-u shell that is 0.26 u per step, and every
// primitive of `__world` is ONE mesh on ONE grid, so shared vertices stay shared and no seam
// opens. It halves a shell-heavy map (Shi No Numa 20.8 -> 10.6 MB). Why Movement does not:
// its site's script policy refuses WebAssembly, and three's meshopt decoder is WebAssembly.
// zombies.enw.gg sends no such policy, and scene.js registers the decoder (a self-contained
// module inside three, nothing extra served). The served bytes are decoded again here and the
// `__world` bounds compared with the checkable file's before they are accepted.
//
// Libraries: @gltf-transform/* 4.x (MIT), sharp (Apache-2.0), meshoptimizer (MIT), resolved
// from the prefix Movement uses (R3D_NODE_PREFIX, default C:/Users/b/tools/r3dnode) -- nothing
// is added to this repo's package.json.
'use strict'
const fs = require('fs')
const path = require('path')
function req(name) {
  const cands = [name, path.join(process.env.R3D_NODE_PREFIX || 'C:/Users/b/tools/r3dnode', 'node_modules', name)]
  let last
  for (const c of cands) { try { return require(c) } catch (e) { last = e } }
  throw last
}
const { NodeIO } = req('@gltf-transform/core')
const { ALL_EXTENSIONS, KHRMeshQuantization, EXTMeshoptCompression } = req('@gltf-transform/extensions')
const { dedup, prune, flatten, textureCompress, quantize, meshopt, reorder, getBounds } = req('@gltf-transform/functions')
const { MeshoptEncoder, MeshoptDecoder } = req('meshoptimizer')
const sharp = req('sharp')

async function main() {
  const argv = process.argv.slice(2)
  const opt = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt }
  const quality = Number(opt('--quality', 80))
  const served = opt('--meshopt', null)
  const flags = new Set(['--quality', '--meshopt'])
  const pos = argv.filter((a, i) => !flags.has(a) && !flags.has(argv[i - 1]))
  const [inp, out, sizeArg] = pos
  const size = Number(sizeArg || 512)
  await MeshoptEncoder.ready
  await MeshoptDecoder.ready
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder })
  const doc = await io.read(inp)
  await doc.transform(
    // export_map.py already writes one mesh per model and many nodes (a repeated xmodel is
    // stored once); dedup() finishes the job across accessors, materials and textures.
    dedup(),
    flatten(),
    prune({ keepAttributes: false }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality }),
    dedup({ propertyTypes: ['Texture', 'Material'] }),
  )
  await doc.transform(
    // Tiled UVs (outside [0,1]) are left float by quantize() itself.
    quantize({ pattern: /^(NORMAL|TEXCOORD_0)$/, quantizeNormal: 8, quantizeTexcoord: 16 }),
  )
  // gltf-transform 4.4 decides whether to declare KHR_mesh_quantization from POSITION's
  // component size alone, so with POSITION float it never does and the file would carry
  // 8-bit normals no loader may accept. Declared from the attributes instead (Movement's fix).
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
  const res = {
    meshes: root.listMeshes().length, nodes: root.listNodes().length,
    textures: root.listTextures().length, materials: root.listMaterials().length,
    unique_tris: tris, texture_size: size, quality, quantized, checkable_bytes: fs.statSync(out).size,
  }
  if (served) {
    const worldBounds = (d) => {
      const n = d.getRoot().listNodes().find((x) => x.getName() === '__world')
      return n ? getBounds(n) : null
    }
    const before = worldBounds(doc)
    const encode = async (d, bits) => {
      if (bits) {
        // meshopt()'s own reorder + quantize, POSITION at 16 bits (its default is 14).
        await d.transform(meshopt({ encoder: MeshoptEncoder, level: 'low', quantizePosition: bits }))
      } else {
        // POSITION stays float; everything else as meshopt() would do it.
        await d.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }),
          quantize({ pattern: /^(TEXCOORD|JOINTS|WEIGHTS|COLOR)(_\d+)?$/, quantizeNormal: 8 }))
        d.createExtension(EXTMeshoptCompression).setRequired(true)
          .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER })
      }
      await io.write(served, d)
      // Read the served bytes back through the decoder: what a browser will get.
      const after = worldBounds(await io.read(served))
      let err = 0
      if (before && after) {
        for (let k = 0; k < 3; k++) err = Math.max(err, Math.abs(before.min[k] - after.min[k]), Math.abs(before.max[k] - after.max[k]))
      }
      return err
    }
    let bits = 16
    let err = await encode(doc, bits)
    if (err >= 1) {
      // A shell with far-flung pieces (fear_mc_2: a 16-bit step over 9 u) would ship a coarse
      // grid. Keep its positions float instead; meshopt still encodes them.
      bits = 0
      err = await encode(await io.read(out), 0)
    }
    res.meshopt = { bytes: fs.statSync(served).size, position_bits: bits || 'float', world_bounds_err: +err.toFixed(3), ok: !before || err < 1 }
    if (!res.meshopt.ok) { console.log(JSON.stringify(res)); process.exit(2) }
  }
  console.log(JSON.stringify(res))
}
main().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1) })
