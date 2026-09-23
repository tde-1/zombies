'use strict'
// Ports and readiness for the suites that spawn a real server (bug 14: "the test server
// never came up on 33991" under load).
//
// Two causes, both fixed here:
//   * the port was fixed, so a second worktree (or a leftover child) running the same suite
//     held it, and the new server died on EADDRINUSE while the wait polled somebody else's;
//   * the wait was 20 s of flat 250 ms polls, which a loaded machine starting node, SQLite
//     and a seed in parallel can outlast.
// So: the preferred port if it is free, else one the OS hands out; and a wait that polls
// with a jittered backoff to a long deadline, and stops at once if the child has exited.

const net = require('net')

function canListen (port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)))
  })
}

function osPort (host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen({ port: 0, host, exclusive: true }, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

// The preferred port when nothing holds it, otherwise any free one. `avoid` keeps two picks
// in one run apart.
async function freePort (preferred, avoid = []) {
  if (preferred && !avoid.includes(preferred) && await canListen(preferred)) return preferred
  for (let i = 0; i < 20; i++) {
    const p = await osPort()
    if (!avoid.includes(p)) return p
  }
  throw new Error('no free port')
}

// Poll `url` until it answers ok. `child` (optional): give up at once if it exits, with its
// stderr tail when the caller collected one.
async function waitHttp (url, { timeoutMs = 60000, child = null, headers = {}, stderr = () => '', ok = (r) => r.ok } = {}) {
  const until = Date.now() + timeoutMs
  let delay = 150
  for (;;) {
    if (child && child.exitCode !== null) {
      const tail = String(stderr() || '').trim().split('\n').slice(-6).join('\n')
      throw new Error(`the test server exited (${child.exitCode}) before answering ${url}${tail ? '\n' + tail : ''}`)
    }
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) })
      if (ok(r)) return
    } catch { /* not yet */ }
    if (Date.now() > until) throw new Error(`the test server never came up at ${url} (waited ${Math.round(timeoutMs / 1000)} s)`)
    await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * delay)))
    delay = Math.min(1000, Math.round(delay * 1.5))
  }
}

module.exports = { freePort, waitHttp, canListen }
