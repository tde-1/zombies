// Lane R3 (replay.md §12): headless render check of the replay FX on a SCRATCH site.
//
//   node web/tools/r3-render-check.mjs <site> <shots dir>
//   e.g. node web/tools/r3-render-check.mjs http://127.0.0.1:3487 tmp/r3shots
//
// The §9.5 pattern: headless Edge, SwiftShader, CDP, against a scratch site serving the fixture
// replays that web/tools/make-fx-replay.mjs wrote (m_f0f0f0f0 with every replay-events-v1 kind,
// m_f0f0f0f1 the same game without them) and a COPY of lane R2's asset pack (_assets.json,
// _weapons, _powerups, _fx, _sounds) in its scratch maps dir. The old replay is opened with
// ?assets=off, which is exactly what a machine without the pack gets. Never port 3200 -- it
// refuses to run against it.
// Prints one line per check and a JSON summary; exits 1 on any failure.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [SITE, OUT] = process.argv.slice(2)
if (!SITE || !OUT) { console.error('usage: node web/tools/r3-render-check.mjs <scratch site url> <shots dir>'); process.exit(2) }
if (/:3200\b/.test(SITE) || /zombies\.enw\.gg/.test(SITE)) { console.error('refusing: that is the live site'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const port = 9800 + Math.floor(Math.random() * 150)
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'r3fx-'))
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1600,900', '--no-first-run',
  '--hide-scrollbars', '--mute-audio', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const killer = setTimeout(() => { console.log('TIMEOUT'); try { edge.kill() } catch { /* gone */ } process.exit(3) }, 300000)

let ws
let id = 0
const pending = new Map()
const handlers = []
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const m = { id: ++id, method, params }
  if (sessionId) m.sessionId = sessionId
  pending.set(m.id, { res, rej })
  ws.send(JSON.stringify(m))
})
const results = []
let failed = 0
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

try {
  let ver
  for (let i = 0; i < 60 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() } catch { await sleep(200) }
  }
  ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } else if (m.method) for (const h of handlers) h(m)
  })

  async function openReplay(match, query = '') {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const S = (m, p) => send(m, p, sessionId)
    const exceptions = []
    handlers.push((m) => {
      if (m.sessionId !== sessionId) return
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300))
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') exceptions.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300))
    })
    await S('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
    await S('Page.enable')
    await S('Runtime.enable')
    await S('Page.navigate', { url: `${SITE}/replay/${match}?r3ddebug${query}` })
    const ev = async (expr) => {
      const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      return r.result.value
    }
    for (let i = 0; i < 240; i++) {
      const ready = await ev(`!!(window.__r3d && window.__r3d.fx && !document.querySelector('.r3d-boot'))`).catch(() => false)
      if (ready) break
      await sleep(500)
    }
    // Models and the map need a moment after the boot screen.
    await sleep(5000)
    const key = async (code, k, vk, type = 'both') => {
      if (type !== 'up') await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k, windowsVirtualKeyCode: vk })
      if (type !== 'down') await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk })
    }
    const click = async (selector) => {
      const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2] })()`)
      for (const type of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type, x: r[0], y: r[1], button: 'left', clickCount: 1 })
    }
    const shot = async (name) => {
      const { data } = await S('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
    }
    // Seek to replay seconds (from the first snapshot), paused, and let a frame draw.
    const at = async (sec) => { await ev(`window.__r3d.seek(${sec}); window.__r3d.redraw(); 1`); await sleep(1200) }
    // Third person, framed from in front and to the side (the fixture walks toward -Y from
    // Nacht's spawn, so the default camera behind him is inside the start-room wall).
    const third = async () => {
      await key('Digit2', '2', 50)
      await sleep(300)
      await ev(`Object.assign(window.__r3d.api.state, { orbitDist: 140, orbitYaw: 232, orbitPitch: -16 }); window.__r3d.redraw(); 1`)
      await sleep(600)
    }
    return { S, ev, key, click, shot, at, third, exceptions, close: () => send('Target.closeTarget', { targetId }) }
  }

  // ---- the FX replay --------------------------------------------------------------
  // Fixture times are event ms; the first snapshot is at 500, so replay seconds = (ms - 500) / 1000.
  const R = await openReplay('m_f0f0f0f0')
  const fx0 = await R.ev('window.__r3d.fx()')
  check('viewer up with the FX index; R2’s manifest makes sound available', fx0 && fx0.sound && fx0.sound.available, fx0 && fx0.sound)
  check('sound is OFF before any gesture (autoplay rule)', fx0.sound && fx0.sound.enabled === false && fx0.sound.context === null)

  // Play with a real mouse click: the gesture that enables audio.
  await R.click('.r3d-play')
  await sleep(6000)
  const fx1 = await R.ev('window.__r3d.fx()')
  check('Play enables audio: context running, samples decoded, sounds played', fx1.sound.enabled && fx1.sound.context === 'running' && fx1.sound.played > 0,
    { played: fx1.sound.played, ready: fx1.sound.buffers.filter((b) => b[1] === 'ready').length, of: fx1.sound.buffers.length })
  // Scrub forward 10 s while playing: what was skipped must not be played late.
  const before = fx1.sound.played
  const tNow = await R.ev('parseFloat(document.querySelector(".r3d-scrub").value)')
  await R.ev(`window.__r3d.seek(${tNow + 10}); 1`)
  await sleep(700)
  const fx2 = await R.ev('window.__r3d.fx()')
  check('a 10 s scrub while playing plays nothing it skipped', fx2.sound.played - before <= 6, { before, after: fx2.sound.played })
  await R.key('Space', ' ', 32)   // pause
  await sleep(400)
  const playing = await R.ev(`document.querySelector('.r3d-play svg path').getAttribute('d').startsWith('M6')`)
  check('paused', !playing)

  // Third person, player 0 (the default focus).
  await R.third()
  // A muzzle flash: the colt's first shot at 1500 ms -> 1.0 s; 20 ms after it.
  await R.at(1.02)
  let g = await R.ev('window.__r3d.fx().gear')
  const s0 = g.slots.find((s) => s.slot === 0)
  const s1 = g.slots.find((s) => s.slot === 1)
  check('player 0 holds R2’s Colt, player 1 R2’s Ray Gun (world .glb in the hand)', s0 && /_weapons\/colt\.glb/.test(s0.key) && s1 && /_weapons\/ray_gun\.glb/.test(s1.key), g.slots)
  check('muzzle flash drawn 20 ms after the shot', s0 && s0.flash)
  await R.shot('r3-flash-3p')
  await R.at(1.1)
  g = await R.ev('window.__r3d.fx().gear')
  check('flash gone 100 ms after the shot', !g.slots.find((s) => s.slot === 0).flash)

  // The head hit at 1810 -> 1.31 s: hit marker on the crosshair, which sits at the aim point.
  await R.at(1.36)
  const hit = await R.ev(`(() => { const h = document.querySelector('.r3d-fx-hit'); const x = document.querySelector('.r3d-zm-xh');
    return { hm: +getComputedStyle(h).opacity, head: h.classList.contains('head'), img: h.classList.contains('img'), left: h.style.left, xh: x.style.display, xleft: x.style.left } })()`)
  check('hit marker shows on a hit (third person), head variant, the game’s damage_feedback image', hit.hm > 0.8 && hit.head && hit.img, hit)
  check('crosshair shown in third person, at the projected aim point (not the centre)', hit.xh !== 'none' && /px$/.test(hit.xleft), hit)
  await R.shot('r3-hitmarker-3p')

  // First person: the viewmodel is the mp40 placeholder at 3.6 s (a burst is on).
  await R.key('Digit1', '1', 49)
  await R.at(3.012)   // 3500 ms shot + 12 ms
  g = await R.ev('window.__r3d.fx().gear')
  check('first person: the MP40 in view, flashing', /_weapons\/mp40\.glb/.test(g.vm) && g.vmFlash, { vm: g.vm, flash: g.vmFlash })
  await R.shot('r3-flash-fp')

  // The swipe at 6000 ms -> 5.5 s: blood (R2's overlay_low_health image). Slot 0 is at the
  // Pack-a-Punch machine then: knuckle crack, empty hands.
  await R.at(5.55)
  const blood = await R.ev(`(() => { const b = document.querySelector('.r3d-fx-blood'); return { a: +getComputedStyle(b).opacity, img: b.classList.contains('img') && /hurt_overlay/.test(b.style.backgroundImage) } })()`)
  check('blood overlay on the swipe, the game’s hurt vignette', blood.a > 0.4 && blood.img, blood)
  await R.key('Digit2', '2', 50)
  await R.at(5.55)
  g = await R.ev('window.__r3d.fx().gear')
  check('knuckle crack: empty hands (no gun drawn)', /proc:none/.test(g.slots.find((s) => s.slot === 0).key), g.slots)
  await R.key('Digit1', '1', 49)
  await R.at(5.55)
  await R.shot('r3-blood-fp')

  // Power-ups on the floor at 7500 ms -> 7.0 s: insta-kill + double points.
  await R.third()
  await R.at(7.0)
  g = await R.ev('window.__r3d.fx().gear')
  check('two power-ups drawn where they spawned, R2’s models', g.pickups.length === 2 && g.pickups.every((k) => /_powerups\/(insta_kill|double_points)\.glb/.test(k)), g.pickups)
  await R.shot('r3-powerups-3p')

  // Pack-a-Punch: the upgraded mp40 from 11500 ms -> 12.0 s: camo on the held gun.
  await R.at(12.0)
  g = await R.ev('window.__r3d.fx().gear')
  check('the upgraded MP40 is R2’s gold model', /_weapons\/mp40_pap\.glb/.test(g.slots.find((s) => s.slot === 0).key), g.slots)
  check('every glb the replay asked for loaded', g.glbs.length > 0 && g.glbs.every(([, st]) => st === 'ready'), g.glbs)
  await R.shot('r3-pap-3p')

  // Timed chips at 17500 ms -> 17.0 s: exactly the time left, tenths.
  await R.at(17.0)
  const chips = await R.ev(`[...document.querySelectorAll('.r3d-fx-chip')].filter((c) => c.style.display !== 'none').map((c) => c.textContent)`)
  check('power-up chips with the exact time left', JSON.stringify(chips) === JSON.stringify(['Insta-Kill20.5', 'Double Points20.1', 'Fire Sale28.5', 'Death Machine29.5']), chips)
  await R.shot('r3-chips')

  // Tab scoreboard: the weapon column.
  await R.key('Tab', 'Tab', 9, 'down')
  await sleep(600)
  const sb = await R.ev(`[...document.querySelectorAll('.r3d-waw-sb tbody tr')].map((r) => [r.children[0].textContent, r.children[1].textContent])`)
  check('Tab scoreboard names each player’s weapon', JSON.stringify(sb.map((r) => r[1]).sort()) === JSON.stringify(['Ray Gun', 'The Afterburner']), sb)
  await R.shot('r3-scoreboard')
  await R.key('Tab', 'Tab', 9, 'up')
  // The feed carries the pickups and the PaP.
  await R.at(8.3)
  const feed = await R.ev(`[...document.querySelectorAll('.r3d-zm-ev')].map((e) => e.textContent)`)
  check('feed line for a pickup', feed.some((t) => /Insta-Kill/.test(t)), feed)
  check('no page exceptions (FX replay)', R.exceptions.length === 0, R.exceptions)
  await R.close()

  // ---- the same game with no R1 events: an old replay ------------------------------
  const O = await openReplay('m_f0f0f0f1', '&assets=off')
  await O.third()
  await O.at(12.0)
  const og = await O.ev('window.__r3d.fx()')
  check('old replay: silent (no cues), the sound button disabled', og.sound && og.sound.available === false && await O.ev(`document.querySelector('.r3d-snd').disabled`))
  check('old replay, no manifest: held weapons from the snapshot column as class placeholders (PaP camo on the upgraded MP40)', og.gear.slots.some((s) => s.slot === 0 && /proc:smg:pap/.test(s.key)) && og.gear.slots.some((s) => s.slot === 1 && /proc:raygun/.test(s.key)), og.gear.slots)
  check('old replay: no pickups, no chips, no marker', og.gear.pickups.length === 0
    && await O.ev(`[...document.querySelectorAll('.r3d-fx-chip')].every((c) => c.style.display === 'none') && +getComputedStyle(document.querySelector('.r3d-fx-hit')).opacity === 0`))
  await O.shot('r3-old-3p')
  check('no page exceptions (old replay)', O.exceptions.length === 0, O.exceptions)
  await O.close()

  // ---- optional: a REAL recorded replay (copied into the scratch replay dir) still plays --------
  const real = process.argv.includes('--real') ? process.argv[process.argv.indexOf('--real') + 1] : null
  if (real) {
    const Q = await openReplay(real)
    await Q.click('.r3d-play')
    await sleep(5000)
    await Q.key('Space', ' ', 32)
    await Q.third()
    const rf = await Q.ev('window.__r3d.fx()')
    check(`real replay ${real}: plays, held weapons from its snapshot column`, rf && rf.gear.slots.length > 0, rf && rf.gear.slots)
    check(`real replay ${real}: no FX cues, silent`, rf.sound.available === false, rf.sound)
    await Q.shot(`r3-real-${real}`)
    check(`no page exceptions (${real})`, Q.exceptions.length === 0, Q.exceptions)
    await Q.close()
  }
} catch (e) {
  check('harness', false, String(e.stack || e.message || e))
} finally {
  clearTimeout(killer)
  try { ws && ws.close() } catch { /* closing */ }
  edge.kill()
  await sleep(700)
  try { fs.rmSync(prof, { recursive: true, force: true }) } catch { /* edge may hold it */ }
}
console.log(JSON.stringify({ passed: results.length - failed, failed }))
process.exit(failed ? 1 : 0)
