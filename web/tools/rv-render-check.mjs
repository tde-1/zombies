// Lane RV (replay.md §14): headless check of replay SOUND (an AnalyserNode on the audio graph),
// the first-person arms + aim-down-sights, and the placeholder for guns the pack does not have,
// on a SCRATCH site.
//
//   node web/tools/rv-render-check.mjs <site> <shots dir> --v1 <match> --custom <match> --old <match>
//   e.g. node web/tools/rv-render-check.mjs http://127.0.0.1:3472 tmp/rvshots --v1 m_abe60828 --custom m_da684190 --old m_0c608cd9
//
//   --v1      a real replay-events-v1 game with stock guns and the ADS button held while shooting
//             (m_abe60828: bridge_zombie, the Colt, aimed at 32.8-34.1 s of the file)
//   --custom  a real v1 game whose gun is not in the asset pack (m_da684190: battlestar_galactica's `m9`)
//   --old     a real game recorded before replay-events-v1 (m_0c608cd9: fear_mc_2, no fire events)
// plus the R3 fixture m_f0f0f0f0 (web/tools/make-fx-replay.mjs) for the MP40 and its PaP.
//
// Headless Edge with --mute-audio: nothing reaches the speakers, but Chromium still RENDERS the
// graph, so an AnalyserNode spliced in front of the destination (a pass-through patch of
// AudioNode.connect, installed before the page's scripts) measures the real signal. Refuses the
// live site. One line per check, a JSON summary; exit 1 on any failure.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [SITE, OUT] = process.argv.slice(2)
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const V1 = arg('--v1')
const CUSTOM = arg('--custom')
const OLD = arg('--old')
if (!SITE || !OUT || !V1) { console.error('usage: node web/tools/rv-render-check.mjs <scratch site> <shots dir> --v1 <m> [--custom <m>] [--old <m>]'); process.exit(2) }
if (/:3200\b/.test(SITE) || /zombies\.enw\.gg/.test(SITE)) { console.error('refusing: that is the live site'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const port = 9300 + Math.floor(Math.random() * 150)
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'rvcheck-'))
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,720', '--no-first-run',
  '--hide-scrollbars', '--mute-audio', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const killer = setTimeout(() => { console.log('TIMEOUT'); try { edge.kill() } catch { /* gone */ } process.exit(3) }, 420000)

// The audio tap: every node connected to the destination is ALSO connected to one analyser per
// context (analyser -> gain 0 -> destination, so it is pulled and adds nothing). Sampled every
// 20 ms: the peak, and when a sample was over the noise floor.
const TAP = `(() => {
  const orig = AudioNode.prototype.connect
  const T = window.__tap = { peak: 0, loud: 0, samples: 0, reset() { this.peak = 0; this.loud = 0; this.samples = 0 } }
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = orig.call(this, dest, ...rest)
    try {
      if (dest instanceof AudioDestinationNode && !this.__tapped) {
        this.__tapped = true
        const ctx = this.context
        if (!ctx.__an) {
          const an = ctx.createAnalyser(); an.fftSize = 2048
          const z = ctx.createGain(); z.gain.value = 0
          orig.call(an, z); orig.call(z, ctx.destination)
          ctx.__an = an
          const buf = new Float32Array(2048)
          setInterval(() => {
            an.getFloatTimeDomainData(buf); let m = 0
            for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v }
            T.samples++; T.state = ctx.state
            if (m > T.peak) T.peak = m
            if (m > 0.01) T.loud++
          }, 20)
        }
        orig.call(this, ctx.__an)
      }
    } catch (e) { T.err = String(e) }
    return r
  }
})()`

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
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`)
}

try {
  let ver
  for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() } catch { await sleep(200) } }
  ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } else if (m.method) for (const h of handlers) h(m)
  })

  async function openReplay(match, query = '') {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const S = (m, p) => send(m, p, sessionId)
    const exceptions = []
    const infos = []
    handlers.push((m) => {
      if (m.sessionId !== sessionId) return
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300))
      if (m.method === 'Runtime.consoleAPICalled') {
        const s = m.params.args.map((a) => a.value ?? a.description).join(' ')
        if (m.params.type === 'error') exceptions.push('console.error: ' + s.slice(0, 300))
        else infos.push(s.slice(0, 300))
      }
    })
    await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
    await S('Page.enable')
    await S('Runtime.enable')
    await S('Page.addScriptToEvaluateOnNewDocument', { source: TAP })
    await S('Page.navigate', { url: `${SITE}/replay/${match}?r3ddebug${query}` })
    const ev = async (expr) => {
      const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      return r.result.value
    }
    for (let i = 0; i < 240; i++) {
      if (await ev(`!!(window.__r3d && window.__r3d.fx && !document.querySelector('.r3d-boot'))`).catch(() => false)) break
      await sleep(500)
    }
    await sleep(3500)
    const click = async (selector) => {
      const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2] })()`)
      for (const type of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type, x: r[0], y: r[1], button: 'left', clickCount: 1 })
    }
    const key = async (code, k, vk) => { for (const type of ['keyDown', 'keyUp']) await S('Input.dispatchKeyEvent', { type, code, key: k, windowsVirtualKeyCode: vk }) }
    const cam = (n) => click(`.r3d-cams button:nth-child(${n})`)
    const shot = async (name) => {
      const { data } = await S('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
    }
    // Replay seconds (from the first snapshot) for a file ms, from the page's own track.
    const secOf = async (ms) => ev(`fetch('/api/replay/${match}/track?hz=20').then(r => r.json()).then(t => (${ms} - t.t0_ms) / 1000)`)
    const firstCue = async () => ev(`fetch('/api/replay/${match}/track?hz=20').then(r => r.json()).then(t => {
      const f = (t.fx || []).find(e => e.t === 'fire'); const pr = t.players[0].presses.fire[0]
      return ((f ? f.ms : pr[0]) - t.t0_ms) / 1000 })`)
    const at = async (sec) => { await ev(`window.__r3d.seek(${sec}); window.__r3d.redraw(); 1`); await sleep(2200); await ev('window.__r3d.redraw(); 1'); await sleep(700) }
    const fx = () => ev('window.__r3d.fx()')
    const tap = () => ev('({ peak: window.__tap.peak, loud: window.__tap.loud, samples: window.__tap.samples, state: window.__tap.state, err: window.__tap.err })')
    const tapReset = () => ev('window.__tap.reset(); 1')
    return { S, ev, click, key, cam, shot, at, fx, tap, tapReset, secOf, firstCue, exceptions, infos, close: () => send('Target.closeTarget', { targetId }) }
  }

  // Play from 1 s before the first shot and listen for `ms`.
  async function listen(R, ms = 6000) {
    const s = await R.firstCue()
    await R.at(Math.max(0, s - 1))
    await R.tapReset()
    await R.click('.r3d-play')
    await sleep(ms)
    return { tap: await R.tap(), sound: (await R.fx()).sound }
  }

  // ---- 1. the real v1 game: sound, then first person hip -> ADS ---------------------------------
  {
    const R = await openReplay(V1)
    const f0 = await R.fx()
    check(`${V1}: silent before any gesture (no audio context yet)`, f0.sound && f0.sound.available && f0.sound.context === null, f0.sound)
    const l = await listen(R)
    check(`${V1}: a real click on Play -> context running and a non-zero signal at the destination`, l.sound.context === 'running' && l.tap.peak > 0.05 && l.tap.loud > 3, { tap: l.tap, played: l.sound.played })
    // M mutes: the listener's master gain goes to 0, the analyser (after it) hears nothing.
    await R.key('KeyM', 'm', 77)
    await sleep(300)
    await R.tapReset()
    await sleep(2500)
    const m = await R.tap()
    check(`${V1}: M mutes (signal at the destination falls to ~0)`, m.peak < 0.01, m)
    await R.key('KeyM', 'm', 77)
    await R.key('Space', ' ', 32)   // pause
    await sleep(300)

    // First person. The file's ADS button: held 32.834-34.079 s of the file (a Colt shot at 33.381).
    await R.cam(1)
    await sleep(400)
    const hip = await R.secOf(32300)
    const ads = await R.secOf(33300)
    await R.at(hip)
    let g = await R.fx()
    check(`${V1}: first person draws the game's arms holding the Colt's own viewmodel (hip)`, g.gear.fpOn && /colt_view\.glb/.test(g.gear.fp.weapon) && g.gear.fp.arms === 'ready' && g.ads === 0, { fp: g.gear.fp, ads: g.ads })
    check(`${V1}: hip FOV is cg_fov 65`, Math.abs(g.fov - 65) < 0.01, g.fov)
    await R.shot('rv-fp-hip-colt')
    await R.at(ads)
    g = await R.fx()
    check(`${V1}: aiming (button held > adsTransInTime) -> ADS fraction 1`, g.ads === 1, g.ads)
    const colt = await R.ev(`fetch('/mapdata/_assets.json').then(r => r.json()).then(a => a.weapons.colt.fp)`)
    check(`${V1}: ADS FOV is the Colt's adsZoomFov (${colt && colt.adsZoomFov})`, colt && Math.abs(g.fov - colt.adsZoomFov) < 0.01, g.fov)
    await R.shot('rv-fp-ads-colt')
    const mid = await R.secOf(32834 + 120)
    await R.at(mid)
    g = await R.fx()
    check(`${V1}: half way in (120 ms of the Colt's 245 ms) -> about half`, g.ads > 0.4 && g.ads < 0.6, g.ads)
    await R.shot('rv-fp-mid-colt')
    check(`no page exceptions (${V1})`, R.exceptions.length === 0, R.exceptions)
    await R.close()
  }

  // ---- 2. a custom map's gun the pack does not have ----------------------------------------------
  if (CUSTOM) {
    const R = await openReplay(CUSTOM)
    const l = await listen(R)
    check(`${CUSTOM}: its unknown gun fires with a stand-in sound (a fire sample loaded, signal at the destination)`,
      l.sound.buffers.some(([u, s]) => /_fire\.ogg$/.test(u) && s === 'ready') && l.tap.peak > 0.05, { tap: l.tap, buffers: l.sound.buffers })
    await R.key('Space', ' ', 32)
    await R.cam(2)
    await sleep(500)
    await R.at((await R.firstCue()) + 0.5)
    const g = (await R.fx()).gear
    const s0 = g.slots.find((s) => s.slot === 0)
    check(`${CUSTOM}: the player holds the placeholder rifle (the fake gun), not nothing`, s0 && s0.shown && s0.key === 'proc:rifle:', g.slots)
    check(`${CUSTOM}: the unknown name is reported (and logged once)`, g.unknown.length > 0 && R.infos.some((s) => /not in the asset pack/.test(s)), { unknown: g.unknown, infos: R.infos.filter((s) => /asset pack/.test(s)) })
    await R.shot('rv-custom-fake-gun-3p')
    check(`no page exceptions (${CUSTOM})`, R.exceptions.length === 0, R.exceptions)
    await R.close()
  }

  // ---- 3. a game recorded before replay-events-v1 -------------------------------------------------
  if (OLD) {
    const R = await openReplay(OLD)
    const f0 = await R.fx()
    check(`${OLD}: an old file (no recorded cues) still has sound (inferred from the attack button)`, f0.sound.available === true, f0.sound)
    const l = await listen(R)
    check(`${OLD}: after Play, a non-zero signal`, l.tap.peak > 0.05, { tap: l.tap, played: l.sound.played })
    check(`no page exceptions (${OLD})`, R.exceptions.length === 0, R.exceptions)
    await R.close()
  }

  // ---- 4. the R3 fixture: the MP40 and its Pack-a-Punch in first person; ?assets=off ------------
  {
    const R = await openReplay('m_f0f0f0f0')
    await R.cam(1)
    await sleep(400)
    await R.at(3.0)      // the MP40 burst (fixture ms 3500)
    let g = (await R.fx()).gear
    check('fixture: first person MP40 is the real viewmodel on the arms', g.fpOn && /mp40_view\.glb/.test(g.fp.weapon), g.fp)
    await R.shot('rv-fp-mp40')
    await R.at(9.6)      // after the PaP (fixture: done at 9500 ms)
    g = (await R.fx()).gear
    check('fixture: after Pack-a-Punch the upgraded viewmodel', g.fpOn && /mp40_pap_view\.glb/.test(g.fp.weapon), g.fp)
    await R.shot('rv-fp-mp40-pap')
    check('no page exceptions (fixture)', R.exceptions.length === 0, R.exceptions)
    await R.close()
    const O = await openReplay('m_f0f0f0f0', '&assets=off')
    await O.cam(1)
    await sleep(400)
    await O.at(3.0)
    g = (await O.fx()).gear
    check('?assets=off: no arms, the §8.7 placeholder stays', !g.fpOn && g.fp.arms === 'none', { fpOn: g.fpOn, fp: g.fp })
    await O.close()
  }
} catch (e) {
  check('harness', false, e.stack || e.message)
} finally {
  clearTimeout(killer)
  console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, failed }))
  try { edge.kill() } catch { /* gone */ }
  setTimeout(() => process.exit(failed ? 1 : 0), 300)
}
