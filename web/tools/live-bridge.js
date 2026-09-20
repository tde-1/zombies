#!/usr/bin/env node
'use strict'

// A DEVELOPMENT SHIM, and it should not survive.
//
// The live view needs the box to POST frames to `/api/gs/live`. The host agent does not do
// that yet — it has every byte (its own dashboard draws the same 2D view from them), it
// just has no reason to send them anywhere. That is a small change in somebody else's
// folder (`infra/host-agent/`), which is not mine to make, and asking for it is in
// `docs/kickstart/questions.md`.
//
// So this stands in for that change: it polls the host agent's LOCAL dashboard
// (`GET /api/state`, 127.0.0.1:8787 — the one host.md §2 documents) and posts each live
// game's referee state to the site with the box's own shared secret. The frames are real,
// from a real referee watching a real (or simulated) game; only the transport is a shim.
//
//   node tools/live-bridge.js
//   node tools/live-bridge.js --dash http://127.0.0.1:8787 --site http://127.0.0.1:3200 \
//                             --secret devkey-a --box box-a --hz 4
//
// When the host agent posts directly, delete this file. The two ways it could do that, in
// order of how little it costs them:
//
//   1. `reportStatus()` already POSTs to /api/gs/status. Have it send
//      `this.state().instances` instead of `this.instances.list().map(i => i.info())` and
//      the site picks the frames out of the heartbeat with no new endpoint at all — but
//      only at the heartbeat's rate, which is slow for a live view.
//   2. A 4 Hz timer posting `{instances:[{instance, match_id, state}]}` to /api/gs/live.
//      That is the real answer.

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const k = String(process.argv[i]).replace(/^--/, '')
  args[k] = process.argv[i + 1]
}

const DASH = (args.dash || process.env.ENW_DASH || 'http://127.0.0.1:8787').replace(/\/$/, '')
const SITE = (args.site || process.env.ENW_SITE || 'http://127.0.0.1:3200').replace(/\/$/, '')
const SECRET = args.secret || process.env.ENW_SECRET || 'devkey-a'
const HZ = Math.max(0.5, Math.min(10, Number(args.hz || 4)))
const EVERY = Math.round(1000 / HZ)

let posted = 0
let missed = 0
let lastErr = null
let lastBox = null

async function tick() {
  let state
  try {
    const res = await fetch(`${DASH}/api/state`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) throw new Error(`dashboard ${res.status}`)
    state = await res.json()
  } catch (e) {
    if (lastErr !== e.message) { lastErr = e.message; console.warn(`[bridge] host agent: ${e.message}`) }
    missed++
    return
  }
  lastErr = null
  if (state.box && state.box !== lastBox) { lastBox = state.box; console.log(`[bridge] box ${state.box}, key ${state.key_id || '-'}`) }

  const instances = (state.instances || [])
    .filter((i) => i.game && !i.finished)
    .map((i) => ({ instance: i.id, match_id: i.game.match || i.match_id, state: i.game }))
    .filter((i) => i.match_id)

  if (!instances.length) return

  try {
    const res = await fetch(`${SITE}/api/gs/live`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-match-secret': SECRET },
      body: JSON.stringify({ instances }),
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) throw new Error(`site ${res.status} ${(await res.text()).slice(0, 120)}`)
    const j = await res.json()
    posted += j.taken || 0
  } catch (e) {
    if (lastErr !== e.message) { lastErr = e.message; console.warn(`[bridge] site: ${e.message}`) }
    missed++
  }
}

console.log(`[bridge] ${DASH}/api/state -> ${SITE}/api/gs/live at ${HZ} Hz  (a dev shim; see the header)`)
setInterval(tick, EVERY)
setInterval(() => {
  if (posted || missed) console.log(`[bridge] ${posted} frames posted, ${missed} misses`)
  posted = 0; missed = 0
}, 10_000).unref?.()
