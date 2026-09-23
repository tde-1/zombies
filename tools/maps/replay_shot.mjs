#!/usr/bin/env node
// Screenshot the replay viewer from a FIXED camera, headless, for the export proof.
//
//   node tools/maps/replay_shot.mjs <site> <matchId> <out-prefix> [x y z yaw pitch]...
//
// Starts headless Edge (SwiftShader WebGL, replay.md §7f), opens <site>/replay/<matchId>?r3ddebug,
// waits for the map, switches to the free camera and, for each pose (engine units, degrees),
// calls window.__r3d.api.setFreeAt(...) and saves <out-prefix>-<n>.png at 1600x900. With no pose
// given it uses two derived from the sidecar spawn: eye height looking along +X, and a 3/4
// overview 700 u back and 500 u up. Nothing is shown on screen; the browser profile is a temp dir.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [site, match, prefix, ...rest] = process.argv.slice(2)
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const port = 9300 + Math.floor(Math.random() * 500)
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'r3dshot-'))
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1600,900', '--no-first-run',
  '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws, id = 0
const pending = new Map()
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const m = { id: ++id, method, params }
  if (sessionId) m.sessionId = sessionId
  pending.set(m.id, { res, rej })
  ws.send(JSON.stringify(m))
})

try {
  let ver
  for (let i = 0; i < 50 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() } catch { await sleep(200) }
  }
  ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) }
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const S = (m, p) => send(m, p, sessionId)
  await S('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await S('Page.enable')
  await S('Runtime.enable')
  await S('Page.navigate', { url: `${site}/replay/${match}?r3ddebug` })
  const ev = async (expr) => (await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value
  // Map in: the scene has a __world (or a grid note) and the loader is done.
  let state = null
  for (let i = 0; i < 240; i++) {
    state = await ev(`(() => { const r = window.__r3d; if (!r) return null; let w = 0, meshes = 0, tex = new Set();
      r.api.scene.traverse((o) => { if (o.name === '__world') w = 1; if (o.isMesh) { meshes++; const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) if (m && m.map) tex.add(m.map.uuid) } });
      const note = document.body.innerText.includes('No world model'); return { w, meshes, textures: tex.size, note } })()`)
    if (state && (state.w || state.note) && state.meshes > 0) break
    await sleep(500)
  }
  await sleep(3000)
  let poses = []
  for (let i = 0; i + 4 < rest.length; i += 5) poses.push(rest.slice(i, i + 5).map(Number))
  if (!poses.length) {
    const sp = await ev(`(async () => { const t = await (await fetch('/api/replay/${match}/track?hz=10')).json();
      const m = await (await fetch('/mapdata/' + t.map + '/' + t.map + '.meta.json')).json(); return m.spawn })()`)
    const [x, y, z] = sp || [0, 0, 0]
    poses = [[x, y, z + 60, 0, -5], [x - 700, y - 700, z + 500, 45, -30]]
  }
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Digit3', key: '3', windowsVirtualKeyCode: 51 })
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Digit3', key: '3', windowsVirtualKeyCode: 51 })
  await sleep(500)
  const out = []
  for (let n = 0; n < poses.length; n++) {
    const [x, y, z, yaw, pitch] = poses[n]
    await ev(`window.__r3d.api.setFreeAt(${x}, ${y}, ${z}, ${yaw}, ${pitch}); window.__r3d.redraw(); 1`)
    await sleep(2500)
    const { data } = await S('Page.captureScreenshot', { format: 'png' })
    const f = `${prefix}-${n + 1}.png`
    fs.writeFileSync(f, Buffer.from(data, 'base64'))
    out.push(f)
  }
  console.log(JSON.stringify({ match, state, poses, shots: out }))
} finally {
  try { ws && ws.close() } catch { /* closing */ }
  edge.kill()
  await sleep(500)
  try { fs.rmSync(prof, { recursive: true, force: true }) } catch { /* edge may hold it briefly */ }
}
