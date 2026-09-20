#!/usr/bin/env node
// A local endpoint for crash reports, so "auto-reported silently" is a real thing that
// happens on this machine rather than a promise about a service that does not exist.
//
// Nothing leaves the box: it listens on 127.0.0.1 and writes JSON files. When there IS
// a real bug-report pipeline, the launcher points `crashEndpoint` at it and this stays
// as the local development sink.
//
//   node tools/crash-sink.js [--port 8791] [--dir <folder>]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
const PORT = Number(val('--port', 8791))
const DIR = path.resolve(val('--dir', path.join(os.homedir(), 'ZombiesDev', 'crash-reports')))
fs.mkdirSync(DIR, { recursive: true })

let n = 0
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).slice(-50)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, received: n, dir: DIR, recent: files }, null, 2))
    return
  }
  if (req.method !== 'POST' || !req.url.startsWith('/crash')) {
    res.writeHead(404); res.end('no'); return
  }
  let body = ''
  let tooBig = false
  req.on('data', (d) => {
    body += d
    if (body.length > 8 * 1024 * 1024) { tooBig = true; req.destroy() }
  })
  req.on('end', () => {
    if (tooBig) { res.writeHead(413); res.end('too big'); return }
    let payload
    try { payload = JSON.parse(body) } catch { res.writeHead(400); res.end('bad json'); return }
    const name = `${(payload.at || new Date().toISOString()).replace(/[:.]/g, '-')}-${(payload.kind || 'unknown').replace(/[^\w-]/g, '')}-${(payload.id || '').slice(0, 8)}.json`
    fs.writeFileSync(path.join(DIR, name), JSON.stringify(payload, null, 2))
    n++
    console.log(`[crash-sink] ${payload.kind}: ${payload.error?.message || '(no message)'}  -> ${name}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, id: payload.id }))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[crash-sink] listening on http://127.0.0.1:${PORT}/crash`)
  console.log(`[crash-sink] writing to ${DIR}`)
})
