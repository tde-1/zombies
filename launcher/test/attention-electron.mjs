// A real Electron check of the attention path (lane SOC): a real, INVISIBLE BrowserWindow
// (off-screen, never focused, no taskbar activation), attention.js's rules driving its real
// flashFrame, the unread dot built from the real tray image with nativeImage, the Windows
// toast XML accepted by a real Notification object (constructed, NOT shown: no toast pops
// on B's screen), and the shell's WebAudio chime synthesised in a real renderer (an
// OfflineAudioContext, so nothing reaches the speakers; the rendered buffer is measured).
//
//   npx electron test/attention-electron.mjs      (prints one JSON line, exits 0/1)
import { app, BrowserWindow, nativeImage, Notification } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeAttention, dotBitmap, toastXml } from '../src/main/attention.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const out = { ok: true, checks: {} }
const note = (k, v, good = true) => { out.checks[k] = v; if (!good) out.ok = false }

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ x: -4000, y: -4000, width: 320, height: 200, show: false, focusable: false, skipTaskbar: true,
      webPreferences: { backgroundThrottling: false, contextIsolation: true } })
    win.showInactive()
    win.minimize()
    await new Promise((r) => setTimeout(r, 300))
    note('minimised', win.isMinimized())
    note('visible_when_minimised', win.isVisible())

    // flashFrame is real; count the calls through a wrapper.
    const calls = []
    const realFlash = win.flashFrame.bind(win)
    win.flashFrame = (f) => { calls.push(f); realFlash(f) }

    const base = nativeImage.createFromPath(path.resolve(HERE, '..', 'src', 'renderer', 'assets', 'tray.png'))
    const { width, height } = base.getSize()
    const dotted = nativeImage.createFromBitmap(dotBitmap(base.toBitmap(), width, height), { width, height })
    note('tray_image', { width, height, dotted_empty: dotted.isEmpty() }, !base.isEmpty() && !dotted.isEmpty())

    let chimes = 0
    const toasts = []
    const badges = []
    const a = makeAttention({
      win: () => win, gameRunning: () => false, soundOn: () => true,
      chime: () => { chimes++ }, toast: (t) => toasts.push(t), badge: (n) => badges.push(n),
    })
    const r1 = a.signal({ kind: 'invite', id: 'invite:1', invite_id: 1, title: 'deadshot invited you', body: 'Party on Der Riese' })
    const r2 = a.signal({ kind: 'party', id: 'chat:1', title: 'x', body: 'y' })
    note('signal_invite', r1, r1.flashed && r1.chimed && r1.toasted)
    note('signal_burst', r2, r2.flashed && !r2.chimed)
    note('flash_calls', calls, calls.length === 2 && calls.every((c) => c === true))
    a.focused()
    note('focus_clears', { calls, badges }, calls[calls.length - 1] === false && badges[badges.length - 1] === 0)

    // The toast object, built from our XML, never shown.
    note('notification_supported', Notification.isSupported())
    const n = new Notification({ toastXml: toastXml(toasts[0]), silent: true })
    note('toast_constructed', typeof n.show === 'function')

    // The chime's synthesis, rendered offline in a real renderer (same node graph as shell.js).
    await win.loadURL('data:text/html,<meta charset=utf-8><title>chime</title>')
    const peak = await win.webContents.executeJavaScript(`(async () => {
      const ctx = new OfflineAudioContext(1, 44100 * 0.5, 44100)
      const t0 = 0.01
      for (const [f, at] of [[880, 0], [1320, 0.12]]) {
        const o = ctx.createOscillator(); const g = ctx.createGain()
        o.type = 'sine'; o.frequency.value = f
        g.gain.setValueAtTime(0.0001, t0 + at)
        g.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.015)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.22)
        o.connect(g).connect(ctx.destination); o.start(t0 + at); o.stop(t0 + at + 0.25)
      }
      const buf = await ctx.startRendering()
      const d = buf.getChannelData(0); let p = 0; for (const x of d) p = Math.max(p, Math.abs(x))
      return Math.round(p * 1000) / 1000
    })()`)
    note('chime_peak', peak, peak > 0.05 && peak < 0.5)
    win.destroy()
  } catch (e) {
    note('error', String(e && e.stack || e), false)
  }
  console.log('ATTENTION_ELECTRON ' + JSON.stringify(out))
  app.exit(out.ok ? 0 : 1)
})
