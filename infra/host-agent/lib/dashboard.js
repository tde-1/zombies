// Local dashboard: plain HTML + SSE, no framework, no build step, 127.0.0.1 only.
//
// This is two things at once, on purpose:
//   * the operator view of a game box (instances, CPU/RAM, event log, chat, controls);
//   * the prototype of the product's WEB LIVE VIEW — vault 99 §4.4 "Spectating: a web
//     live view (round, players, points, downs)". The 2D top-down canvas is the same
//     thing the site will serve to spectators, fed by the same `snap` events.
//
// It also plays back a recorded .enwr replay, which is phase 2 of the replay roadmap
// (vault 10: "player + zombie tracks with a 2D top-down view") and proves the container
// seeks: playback fetches ONE 60-second chunk at a time by its index offset.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeLog } from './util.js'
import { readFooter, readHeader, readChunk, verifyFile } from './replay.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Events that arrive 20×/s would drown the log; the live state already carries positions.
const NOISY = new Set(['snap', 'input'])

export class Dashboard {
  constructor({ port = 8787, host, replayDir, log } = {}) {
    this.port = port
    this.host = host
    this.replayDir = replayDir
    this.log = log || makeLog('dash')
    this.clients = new Set()
    this.server = http.createServer((req, res) => this.route(req, res).catch((e) => {
      this.log.warn(`${req.url}: ${e.message}`)
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })) }
    }))
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.log.info(`dashboard on http://127.0.0.1:${this.port}`)
        this.stateTimer = setInterval(() => this.push('state', this.host.state()), 250)
        this.stateTimer.unref?.()
        resolve()
      })
    })
  }

  push(kind, data) {
    if (!this.clients.size) return
    if (kind === 'event' && NOISY.has(data.ev?.t)) return
    const line = `data: ${JSON.stringify({ kind, data })}\n\n`
    for (const res of this.clients) { try { res.write(line) } catch { this.clients.delete(res) } }
  }

  async route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    const json = (code, o) => { const b = Buffer.from(JSON.stringify(o)); res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length, 'cache-control': 'no-store' }); res.end(b) }
    const body = async () => { let s = ''; for await (const c of req) { s += c; if (s.length > 1 << 20) break } try { return s ? JSON.parse(s) : {} } catch { return {} } }

    if (p === '/' || p === '/index.html') {
      const f = fs.readFileSync(path.join(__dirname, '..', 'web', 'dashboard.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': f.length })
      return res.end(f)
    }

    if (p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.write(`data: ${JSON.stringify({ kind: 'state', data: this.host.state() })}\n\n`)
      this.clients.add(res)
      req.on('close', () => this.clients.delete(res))
      return
    }

    if (p === '/api/state') return json(200, this.host.state())

    if (p === '/api/say' && req.method === 'POST') {
      const b = await body()
      if (!b.text) return json(400, { error: 'no text' })
      this.host.sayFromDashboard(b.from || 'ENW', String(b.text).slice(0, 300))
      return json(200, { ok: true })
    }

    // ---- Play Local: tell the agent to expect a game the launcher is about to start ----
    // The inverted, preferred shape: the launcher knows the instance id before it
    // launches (it sets ENW_INSTANCE), so the `hello` is matched against something we
    // were TOLD to expect rather than accepted blind. 127.0.0.1 only, like everything here.
    if (p === '/api/local/expect' && req.method === 'POST') {
      const b = await body()
      const id = String(b.instance || b.match_id || '').trim()
      if (!id) return json(400, { error: 'send {instance, match_id, map}' })
      if (!this.host.localEnabled()) return json(409, { error: 'this agent is not in local mode — start it with --local' })
      if (this.host.leaseHeld()) return json(409, { error: 'this box holds a lease; it will not adopt local games' })
      this.host.expected.set(id, { match_id: String(b.match_id || id), map: b.map || null, at: Date.now() })
      this.log.info(`expecting a local game: instance ${id} match ${b.match_id || id} map ${b.map || '?'}`)
      return json(200, { ok: true, instance: id, match_id: String(b.match_id || id), link: `${this.host.linkAddress()}`, expires_in_ms: 10 * 60_000 })
    }

    if (p === '/api/local/expected') return json(200, { local: this.host.localEnabled(), lease_held: this.host.leaseHeld(), expected: [...this.host.expected.entries()].map(([k, v]) => ({ instance: k, ...v })) })

    if (p === '/api/boot' && req.method === 'POST') {
      const b = await body()
      const g = this.host.boot({
        kind: b.kind || 'sim', matchId: b.match_id, mode: b.mode || 'custom', map: b.map || 'nazi_zombie_asylum',
        vip: !!b.vip,
        sim: { players: Number(b.players || 2), timescale: Number(b.timescale || 1), maxRound: Number(b.max_round || 15), eeRound: b.ee_round ?? null, afkSlot: b.afk_slot ?? null, lateJoinMs: b.late_join_ms ?? null, seed: Number(b.seed || Date.now() % 100000) },
      })
      return json(200, { ok: true, instance: g.instance.id, match_id: g.matchId })
    }

    const m = p.match(/^\/api\/instance\/([^/]+)\/(stop|pause|resume|end|kick)$/)
    if (m && req.method === 'POST') {
      const [, instId, action] = m
      const g = this.host.byInstance.get(instId)
      if (!g) return json(404, { error: 'no such instance' })
      const b = await body()
      if (action === 'stop') { await this.host.instances.remove(instId, 'stopped from the dashboard'); return json(200, { ok: true }) }
      if (action === 'pause') return json(200, { ok: g.referee.pause(b.reason || 'operator') })
      if (action === 'resume') return json(200, { ok: g.referee.resume(b.reason || 'operator') })
      if (action === 'end') { g.referee.send({ t: 'end', reason: 'operator' }); g.referee.finishGame('operator'); return json(200, { ok: true }) }
      if (action === 'kick') { g.referee.send({ t: 'kick', slot: Number(b.slot), reason: b.reason || 'operator' }); return json(200, { ok: true }) }
    }

    // ---- replays ------------------------------------------------------------
    if (p === '/api/replays') {
      let files = []
      try { files = fs.readdirSync(this.replayDir).filter((f) => f.endsWith('.enwr')) } catch { /* none yet */ }
      const out = []
      for (const f of files) {
        const full = path.join(this.replayDir, f)
        try {
          const { footer } = readFooter(full)
          const { header } = readHeader(full)
          out.push({
            file: f, size: fs.statSync(full).size, chunks: footer.chunks.length, events: footer.events,
            duration_ms: footer.duration_ms, map: header.map, map_name: header.map_name,
            match_id: header.match_id, mode: header.mode, started_at: header.started_at,
            summary: footer.summary || null, key_id: footer.key_id,
          })
        } catch (e) { out.push({ file: f, error: e.message, size: fs.statSync(full).size }) }
      }
      out.sort((x, y) => String(y.started_at || '').localeCompare(String(x.started_at || '')))
      return json(200, out)
    }

    const rm = p.match(/^\/api\/replay\/([^/]+)(?:\/(verify|chunk))?$/)
    if (rm) {
      const file = path.join(this.replayDir, path.basename(rm[1]))
      if (!fs.existsSync(file)) return json(404, { error: 'no such replay' })
      if (rm[2] === 'verify') return json(200, verifyFile(file))
      if (rm[2] === 'chunk') {
        const { footer } = readFooter(file)
        const i = Number(url.searchParams.get('i') || 0)
        const entry = footer.chunks[i]
        if (!entry) return json(404, { error: 'no such chunk' })
        // One chunk, by offset — the same read an HTTP Range request makes against R2.
        return json(200, { i, t0: entry.t0, t1: entry.t1, events: readChunk(file, entry).events })
      }
      const { footer } = readFooter(file)
      const { header } = readHeader(file)
      return json(200, { header, index: footer.chunks.map(({ i, off, len, t0, t1, n }) => ({ i, off, len, t0, t1, n })), summary: footer.summary || null, events: footer.events, event_counts: footer.event_counts })
    }

    json(404, { error: 'not found' })
  }

  close() { clearInterval(this.stateTimer); for (const c of this.clients) { try { c.end() } catch { /* ignore */ } } return new Promise((r) => this.server.close(r)) }
}
