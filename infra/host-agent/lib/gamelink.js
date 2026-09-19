// Game-link server — the host half of docs/protocol/game-link-v0.md.
//
// One TCP listener, many game processes. NDJSON, one UTF-8 JSON object per line.
// Binds 127.0.0.1 by default: the DLL always runs on the same box, and nothing on the
// internet should ever be able to speak this protocol.
//
// BACKPRESSURE, both directions, because a game frame must never block on us and we must
// never grow without bound on a wedged peer:
//   outbound — writes go through a bounded queue; when the socket says "wait", we buffer
//              up to `outQueueMax` messages and DROP THE OLDEST beyond that, counting the
//              drops. Chat and snapshots are droppable; that is better than a stall.
//   inbound  — a line longer than `maxLine` (a peer that never sends \n) kills the
//              connection rather than the host.
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { ndjsonSplit, makeLog } from './util.js'

// Host -> game messages that may be discarded under backpressure. Everything else is a
// decision (auth/kick/end/pause/resume/exec/set) and must be delivered.
const DROPPABLE_OUT = new Set(['say', 'tell'])

export class LinkConn extends EventEmitter {
  constructor(socket, server) {
    super()
    this.socket = socket
    this.server = server
    this.log = server.log
    this.id = `c${++server.connSeq}`
    this.instance = null
    this.role = null
    this.pid = null
    this.buf = Buffer.alloc(0)
    this.out = []
    this.draining = false
    this.closed = false
    this.stats = { rx: 0, tx: 0, rxBytes: 0, txBytes: 0, dropped: 0, bad: 0, connectedAt: Date.now() }
    this.remote = `${socket.remoteAddress}:${socket.remotePort}`

    socket.setNoDelay(true)
    socket.on('data', (d) => this.onData(d))
    socket.on('drain', () => this.flush())
    socket.on('error', (e) => { this.log.debug(`${this.id} socket error: ${e.message}`) })
    socket.on('close', () => this.onClose())
  }

  onData(d) {
    this.stats.rxBytes += d.length
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d
    const { lines, rest, overflow } = ndjsonSplit(this.buf, this.server.maxLine)
    this.buf = rest
    if (overflow) {
      this.log.warn(`${this.id}: oversize line (> ${this.server.maxLine} bytes) — dropping the connection`)
      return this.destroy('oversize_line')
    }
    for (const line of lines) {
      let msg
      try { msg = JSON.parse(line.toString('utf8')) } catch { this.stats.bad++; continue }
      if (!msg || typeof msg.t !== 'string') { this.stats.bad++; continue }
      this.stats.rx++
      if (msg.t === 'hello') {
        this.instance = String(msg.instance || '')
        this.role = msg.role || null
        this.pid = msg.pid || null
        this.server.emit('hello', this, msg)
      }
      // Unknown `t` values are ignored by both sides — that is the protocol's forward
      // compatibility rule, so we hand everything up and let the consumer filter.
      this.emit('message', msg)
      this.server.emit('message', this, msg)
    }
  }

  /** Queue one host→game message. Never throws, never blocks. */
  send(obj) {
    if (this.closed) return false
    const line = Buffer.from(JSON.stringify(obj) + '\n', 'utf8')
    if (this.draining) {
      this.out.push({ t: obj.t, line })
      // Overflow drops the oldest DROPPABLE message only. `auth`, `kick`, `end`, `pause`
      // and `exec` change what happens in the game; losing one silently is a bug that
      // looks like the game misbehaving. Chat is the only thing worth losing.
      while (this.out.length > this.server.outQueueMax) {
        const i = this.out.findIndex((x) => DROPPABLE_OUT.has(x.t))
        if (i < 0) break
        this.out.splice(i, 1)
        this.stats.dropped++
      }
      return true
    }
    const ok = this.socket.write(line)
    this.stats.tx++
    this.stats.txBytes += line.length
    if (!ok) this.draining = true
    return ok
  }

  flush() {
    this.draining = false
    while (this.out.length) {
      const { line } = this.out.shift()
      const ok = this.socket.write(line)
      this.stats.tx++
      this.stats.txBytes += line.length
      if (!ok) { this.draining = true; return }
    }
  }

  destroy(reason) {
    if (this.closed) return
    this.closeReason = reason
    try { this.socket.destroy() } catch { /* already gone */ }
  }

  onClose() {
    if (this.closed) return
    this.closed = true
    this.server.conns.delete(this.id)
    this.emit('close', this.closeReason || 'closed')
    this.server.emit('close', this, this.closeReason || 'closed')
  }
}

export class GameLinkServer extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 0, maxLine = 1 << 20, outQueueMax = 4096, log } = {}) {
    super()
    this.host = host
    this.wantPort = port
    this.maxLine = maxLine
    this.outQueueMax = outQueueMax
    this.log = log || makeLog('gamelink')
    this.conns = new Map()
    this.connSeq = 0
    this.server = net.createServer((s) => {
      const c = new LinkConn(s, this)
      this.conns.set(c.id, c)
      this.log.debug(`${c.id} connected from ${c.remote}`)
      this.emit('connection', c)
    })
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.wantPort, this.host, () => {
        this.port = this.server.address().port
        this.log.info(`listening on ${this.host}:${this.port}`)
        resolve(this.port)
      })
    })
  }

  /** All live connections for an instance id (normally exactly one). */
  forInstance(instanceId) {
    return [...this.conns.values()].filter((c) => c.instance === instanceId)
  }

  sendTo(instanceId, obj) {
    let n = 0
    for (const c of this.forInstance(instanceId)) { c.send(obj); n++ }
    return n
  }

  broadcast(obj) { for (const c of this.conns.values()) c.send(obj) }

  stats() {
    return [...this.conns.values()].map((c) => ({ id: c.id, instance: c.instance, role: c.role, pid: c.pid, ...c.stats }))
  }

  close() { return new Promise((r) => { for (const c of this.conns.values()) c.destroy('shutdown'); this.server.close(r) }) }
}
