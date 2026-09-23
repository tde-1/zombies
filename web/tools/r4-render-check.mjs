// Lane R4 (replay.md §13): headless render check of spectator switching on a SCRATCH site.
//
//   node web/tools/r4-render-check.mjs <site> <shots dir>
//   e.g. node web/tools/r4-render-check.mjs http://127.0.0.1:3488 tmp/r4shots
//
// The §9.5 / §12.5 pattern (the harness is r3-render-check.mjs's): headless Edge, SwiftShader,
// CDP, against a scratch site serving the fixtures web/tools/make-fx-replay.mjs wrote --
// m_f0f0f0f2 (four players; slot 2 down 6-12 s, slot 3 down from 15 s) and m_f0f0f0f3 (solo) --
// with a COPY of Nacht's export and lane R2's pack in its scratch maps dir. Refuses port 3200.
// Fixture ms -> replay seconds: (ms - 500) / 1000.
// Prints one line per check and a JSON summary; exits 1 on any failure.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [SITE, OUT] = process.argv.slice(2)
if (!SITE || !OUT) { console.error('usage: node web/tools/r4-render-check.mjs <scratch site url> <shots dir>'); process.exit(2) }
if (/:3200\b/.test(SITE) || /zombies\.enw\.gg/.test(SITE)) { console.error('refusing: that is the live site'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const port = 9800 + Math.floor(Math.random() * 150)
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'r4spec-'))
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

// Keys: [code, key, windowsVirtualKeyCode]
const K = {
  1: ['Digit1', '1', 49], 2: ['Digit2', '2', 50], 3: ['Digit3', '3', 51], 4: ['Digit4', '4', 52],
  F: ['KeyF', 'f', 70], Q: ['KeyQ', 'q', 81], E: ['KeyE', 'e', 69], Esc: ['Escape', 'Escape', 27],
  '[': ['BracketLeft', '[', 219], ']': ['BracketRight', ']', 221], Space: ['Space', ' ', 32],
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

  async function openReplay(match, { mobile = false } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const S = (m, p) => send(m, p, sessionId)
    const exceptions = []
    handlers.push((m) => {
      if (m.sessionId !== sessionId) return
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300))
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') exceptions.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300))
    })
    if (mobile) {
      await S('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true })
      await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    } else {
      await S('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
    }
    await S('Page.enable')
    await S('Runtime.enable')
    await S('Page.navigate', { url: `${SITE}/replay/${match}?r3ddebug` })
    const ev = async (expr) => {
      const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      return r.result.value
    }
    for (let i = 0; i < 240; i++) {
      const ready = await ev(`!!(window.__r3d && window.__r3d.fx && window.__r3d.spec && !document.querySelector('.r3d-boot'))`).catch(() => false)
      if (ready) break
      await sleep(500)
    }
    await sleep(5000)
    const key = async (name) => {
      const [code, k, vk] = K[name]
      await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k, windowsVirtualKeyCode: vk })
      await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk })
      await sleep(500)
    }
    const centre = (selector) => ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2] })()`)
    const click = async (selector) => {
      const r = await centre(selector)
      for (const type of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type, x: r[0], y: r[1], button: 'left', clickCount: 1 })
      await sleep(500)
    }
    const tap = async (selector) => {
      const r = await centre(selector)
      await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r[0], y: r[1] }] })
      await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(700)
    }
    const shot = async (name) => {
      const { data } = await S('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
    }
    const at = async (sec) => { await ev(`window.__r3d.seek(${sec}); window.__r3d.redraw(); 1`); await sleep(1200) }
    const spec = () => ev('window.__r3d.spec()')
    // What the panel shows: the header line, and per row its key, name, watching, down tag, eye.
    const panel = () => ev(`(() => {
      const h = document.querySelector('.r3d-spec-head')
      return {
        head: h ? h.textContent : null,
        rows: [...document.querySelectorAll('.r3d-zm-score .r3d-zm-row')].map((r) => ({
          key: r.querySelector('.r3d-spec-key') ? r.querySelector('.r3d-spec-key').textContent : null,
          name: r.querySelector('.r3d-zm-name').textContent,
          on: r.classList.contains('on'), watching: r.classList.contains('watching'),
          down: !!r.querySelector('.r3d-spec-tag'), eye: !!r.querySelector('.r3d-spec-eye'),
        })),
        prompt: document.querySelector('.r3d-spec-down') ? document.querySelector('.r3d-spec-down').textContent : null,
      } })()`)
    const overlays = () => ev(`(() => { const h = document.querySelector('.r3d-fx-hit'); const x = document.querySelector('.r3d-zm-xh'); const b = document.querySelector('.r3d-fx-blood')
      return { hm: +getComputedStyle(h).opacity, xh: x.style.display !== 'none' && x.style.visibility !== 'hidden', blood: +getComputedStyle(b).opacity } })()`)
    return { S, ev, key, click, tap, shot, at, spec, panel, overlays, exceptions, close: () => send('Target.closeTarget', { targetId }) }
  }

  // ---- the co-op fixture ---------------------------------------------------------------
  const R = await openReplay('m_f0f0f0f2')
  await R.at(2.06)
  let p = await R.panel()
  let s = await R.spec()
  check('co-op: the panel lists four players with their number keys', p.rows.length === 4 && p.rows.map((r) => r.key).join('') === '1234', p.rows)
  check('co-op: default follows player 1 in third person; the panel says so', s.focus === 0 && s.mode === 'follow' && /Following\s*Fixture One\s*Third person/.test(p.head) && p.rows[0].watching && p.rows[0].eye, { s, head: p.head })
  const hmOne = (await R.overlays()).hm
  await R.shot('r4-coop-default')

  // Click row 3 (slot 2, Fixture Three): follow him; the hit marker is now his (2510 ms -> 2.01 s).
  await R.click('.r3d-zm-score .r3d-zm-row:nth-child(4)')   // child 1 is the header line
  await R.at(2.06)
  s = await R.spec(); p = await R.panel()
  let o = await R.overlays()
  let g = await R.ev('window.__r3d.fx().gear')
  check('click a row: follows that player (third person kept)', s.focus === 2 && s.mode === 'follow' && p.rows[2].watching && !p.rows[0].watching, { s, rows: p.rows })
  check('the panel names the followed player and his weapon', /Fixture Three/.test(p.head) && /Thompson/i.test(p.head), p.head)
  check('the HUD follows him: his hit marker shows (player 1\'s was fading)', o.hm > 0.8 && hmOne < 0.5, { now: o.hm, before: hmOne })
  check('crosshair drawn at his aim point', o.xh, o)
  await R.shot('r4-click-follow-3p')

  // Number key 4 -> slot 3; F -> first person; his gun (a Kar98k: no R2 model -> the rifle placeholder).
  await R.key(4)
  await R.key('F')
  await R.at(3.52)   // his shot at 4000 ms
  s = await R.spec(); g = await R.ev('window.__r3d.fx().gear')
  check('key 4 picks player 4; F switches to first person', s.focus === 3 && s.mode === 'eyes', s)
  check('first-person gun is player 4\'s (rifle placeholder for the Kar98k)', /rifle|kar98k/i.test(String(g.vm)), { vm: g.vm })
  await R.shot('r4-key4-fp')

  // Seek, play, pause: the target and the view persist.
  await R.at(0.5)
  await R.click('.r3d-play'); await sleep(1500); await R.key('Space')
  await R.at(11.0)
  s = await R.spec()
  check('follow target and view persist across seek, play and pause', s.focus === 3 && s.mode === 'eyes', s)

  // Cycling: ] forward, [ back, E forward, Q back (all alive at 11 s? slot 2 is down 5.5-11.5 s).
  await R.at(3.0)   // everybody up
  await R.key(']'); const c1 = (await R.spec()).focus
  await R.key(']'); const c2 = (await R.spec()).focus
  await R.key('['); const c3 = (await R.spec()).focus
  await R.key('E'); const c4 = (await R.spec()).focus
  await R.key('Q'); const c5 = (await R.spec()).focus
  check('] / [ and E / Q cycle through the players, wrapping', [c1, c2, c3, c4, c5].join(',') === '0,1,0,1,0', [c1, c2, c3, c4, c5])
  await R.at(8.0)   // slot 2 down
  await R.key(1); await R.key(']')
  check('cycling skips a downed player', (await R.spec()).focus === 1)
  await R.key(']')
  check('...and goes on to the next one up', (await R.spec()).focus === 3)

  // Esc: free cam; the panel says so; no crosshair, no marker. A click on a row goes back to following.
  await R.key('Esc')
  s = await R.spec(); p = await R.panel(); o = await R.overlays()
  check('Esc: free cam, "Free cam" in the panel, nobody marked as watched', s.mode === 'free' && /Free cam/.test(p.head) && !p.rows.some((r) => r.watching), { s, head: p.head })
  check('free cam: no crosshair, no hit marker', !o.xh && o.hm === 0, o)
  await R.shot('r4-free')
  await R.key('E')
  check('free cam: E is the fly key, not a cycle', (await R.spec()).mode === 'free')
  await R.click('.r3d-zm-score .r3d-zm-row:nth-child(2)')
  s = await R.spec()
  check('free cam -> click a row: follows him, in the last view (first person)', s.focus === 0 && s.mode === 'eyes', s)

  // Down: follow slot 2 (key 3) at 8 s. The camera stays on him; the marker and the prompt show.
  await R.key(3)
  await R.key('F')   // third person, so the body is in shot
  await R.at(8.0)
  s = await R.spec(); p = await R.panel()
  check('followed player down: the camera stays on him', s.focus === 2 && s.mode === 'follow', s)
  check('down marker + the offer of the next player who is up', p.prompt && /Down\s*Fixture Three/.test(p.prompt) && /Watch Fixture Four/.test(p.prompt), p.prompt)
  check('the panel tags him Down', p.rows[2].down && !p.rows[3].down, p.rows)
  await R.shot('r4-down-prompt-3p')
  await R.click('.r3d-spec-down-next')
  s = await R.spec(); p = await R.panel()
  check('the prompt\'s button follows the next player who is up; the prompt goes', s.focus === 3 && !p.prompt, { s, prompt: p.prompt })
  // Revived at 12 s: the prompt is gone for slot 2.
  await R.key(3); await R.at(12.0)
  check('revived: no prompt', !(await R.panel()).prompt)
  // Slot 3 down from 15 s (-> 14.5): the offer wraps to player 1; E takes it.
  await R.key(4); await R.at(16.0)
  p = await R.panel()
  check('player 4 down: the offer wraps to player 1', /Watch Fixture One/.test(p.prompt || ''), p.prompt)
  await R.key('F'); await R.at(16.0)
  await R.shot('r4-down-prompt-fp')
  await R.key('E')
  check('E takes the offer', (await R.spec()).focus === 0)
  check('no page exceptions (co-op)', R.exceptions.length === 0, R.exceptions)
  await R.close()

  // ---- touch: a phone in landscape, tapping a panel row ------------------------------------
  const T = await openReplay('m_f0f0f0f2', { mobile: true })
  await T.at(3.0)
  await T.tap('.r3d-zm-score .r3d-zm-row:nth-child(3)')
  s = await T.spec()
  check('touch: tapping a panel row follows that player', s.focus === 1, s)
  await T.key('Esc')
  await T.tap('.r3d-zm-score .r3d-zm-row:nth-child(5)')
  s = await T.spec()
  check('touch: from free cam, a tap follows', s.focus === 3 && s.mode !== 'free', s)
  await T.shot('r4-touch')
  check('no page exceptions (touch)', T.exceptions.length === 0, T.exceptions)
  await T.close()

  // ---- solo: today's behaviour ---------------------------------------------------------------
  const O = await openReplay('m_f0f0f0f3')
  await O.at(2.0)
  p = await O.panel()
  check('solo: no Following line, no number keys, no eye', p.head === null && p.rows.length === 1 && p.rows[0].key === null && !p.rows[0].eye, p)
  await O.key(1); const m1 = (await O.spec()).mode
  await O.key(3); const m3 = (await O.spec()).mode
  await O.key(2); const m2 = (await O.spec()).mode
  check('solo: 1 / 2 / 3 are still first person / third person / free cam', [m1, m3, m2].join(',') === 'eyes,free,follow', [m1, m3, m2])
  await O.key(3)
  await O.click('.r3d-zm-score .r3d-zm-row')
  check('solo: clicking the row in free cam changes nothing (as before)', (await O.spec()).mode === 'free')
  await O.key(2)
  await O.shot('r4-solo')
  check('no page exceptions (solo)', O.exceptions.length === 0, O.exceptions)
  await O.close()
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
