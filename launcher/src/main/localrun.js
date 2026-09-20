// A local game, reported to the site — the launcher's half of `launcher-v0.md` §6.
//
// This is the real implementation of what `web/tools/local-run.js` demonstrates over
// HTTP, driven from the app instead of a script:
//
//   1. `POST /api/launcher/local/start`   the site opens a local match for this player
//   2. the launcher installs the map and launches World at War with our DLL
//   3. `POST /api/launcher/local/live`    frames, so a friend can watch at /live/<id>
//   4. `POST /api/launcher/local/result`  the referee's summary and the replay pointer
//
// **No box secret ever lives on a player's PC.** All three endpoints are authenticated
// by the player's own session cookie, and everything through them is stamped
// `self_reported`. If this file ever needs `x-match-secret`, the design is wrong —
// that header belongs to a game box, and a player's machine is not one.
//
// And the thing worth keeping in the front of your mind, which web put well: a local
// game's replay is VALID and is still not EVIDENCE. On this dev box the local host
// agent *is* the pinned box, so every signature check passes — the **mode** decides
// legitimacy, not the key. The launcher's job is to be honest about the mode, which is
// why it never claims otherwise and the site downgrades it even if it did.
import { EventEmitter } from 'node:events'

export class LocalRun extends EventEmitter {
  constructor({ api, dashUrl = 'http://127.0.0.1:8787', hz = 4 } = {}) {
    super()
    this.api = api
    this.dashUrl = String(dashUrl).replace(/\/$/, '')
    this.hz = hz
    this.matchId = null
    this.frames = 0
    this.stopped = false
  }

  async dash() {
    const res = await fetch(`${this.dashUrl}/api/state`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`the host agent answered ${res.status}`)
    return res.json()
  }

  // 1b. Register the game with the local host agent BEFORE launching it.
  //
  // The host agent inverted this the safe way: rather than adopting whatever says
  // hello, the launcher declares what it is about to start and the box matches the
  // `hello` against something it was told to expect. So the registration has to
  // happen before the spawn, and the box hands back the link address to launch with
  // — we do not guess the port.
  //
  // We register under the SITE's match id, so the site, the box and the signed replay
  // all name the same game.
  async expect({ instance, matchId, map }) {
    const res = await fetch(`${this.dashUrl}/api/local/expect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instance, match_id: matchId, map }),
      signal: AbortSignal.timeout(4000),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      // 409s are the agent's two deliberate refusals, and both are worth showing as
      // written: not in local mode, or it holds a lease and will not adopt.
      throw new Error(data?.error || `the host agent answered ${res.status}`)
    }
    this.expected = data
    this.emit('expected', data)
    return data
  }

  // 1. Open the match. The site decides the match id and hands back the account's
  //    settings and whatever it knows about installing the map.
  async start(mapKey) {
    const r = await this.api.req('/api/launcher/local/start', { method: 'POST', body: { map_key: mapKey } })
    if (!r.ok) throw new Error(r.data?.error || `the site answered ${r.status} when starting a local game`)
    this.matchId = r.data.match_id
    this.started = r.data
    this.emit('started', r.data)
    return r.data
  }

  // 3. Relay frames while the game runs, and 4. post the result when it ends.
  //    Resolves with what the site stored, so the caller can show the player that it
  //    was filed as local and counted for nothing.
  async relayUntilDone({ instanceId = null, timeoutMs = 30 * 60 * 1000 } = {}) {
    const until = Date.now() + timeoutMs
    let inst = null

    // Find our instance: the one the host agent is running a game on.
    while (!this.stopped && Date.now() < until) {
      try {
        const s = await this.dash()
        inst = instanceId ? s.instances.find((x) => x.id === instanceId) : s.instances.find((x) => x.game)
        if (inst) break
      } catch {}
      await sleep(1000)
    }
    if (!inst) return { ok: false, reason: 'no host agent instance ever reported a game' }
    this.emit('instance', inst)

    let last = null
    while (!this.stopped && Date.now() < until) {
      let s
      try { s = await this.dash() } catch { await sleep(1000); continue }

      const cur = s.instances.find((x) => x.id === inst.id)
      if (cur?.game && !cur.finished) {
        last = cur.game
        try {
          await this.api.req('/api/launcher/local/live', { method: 'POST', body: { match_id: this.matchId, state: cur.game } })
          this.frames++
          this.emit('frame', { n: this.frames, round: cur.game.round, players: cur.game.players?.length || 0 })
        } catch {}
      }

      const done = s.games?.find((g) => g.summary && g.summary.instance === inst.id)
      if (done) {
        const r = await this.api.req('/api/launcher/local/result', {
          method: 'POST',
          body: { summary: { ...done.summary, match_id: this.matchId }, replay: done.replay || null },
        })
        if (!r.ok) return { ok: false, reason: r.data?.error || `the site answered ${r.status}`, frames: this.frames }
        this.emit('result', r.data)
        return { ok: true, frames: this.frames, stored: r.data, summary: done.summary, replay: done.replay || null }
      }

      if (cur && cur.finished) break
      if (!cur) break
      await sleep(Math.round(1000 / this.hz))
    }
    return { ok: false, reason: 'the game ended without the referee producing a summary', frames: this.frames, lastRound: last?.round ?? null }
  }

  // What the site says about the game afterwards. This is the part worth showing: it
  // is the site refusing to count it.
  async verdict() {
    if (!this.matchId) return null
    const g = await this.api.req(`/api/games/${this.matchId}`)
    const rp = await this.api.req(`/api/replays/${this.matchId}`)
    return {
      game: g.ok ? g.data?.game : null,
      replay: rp.ok ? rp.data?.replay : null,
    }
  }

  stop() { this.stopped = true }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
