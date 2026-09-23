// soaklink.mjs -- the game-link sink for a local soak (dedi.md §23).
//
//   node tools/dev/soaklink.mjs --port 38797 --out <file.ndjson> [--exec "cmd" ...]
//
// A local soak has no host agent, but the DLL's game link is where the round counter,
// game_over / match_end, player connect/disconnect and the replay stream (snap / input)
// come out. This accepts the DLL's one TCP connection (and its reconnects), stamps every
// NDJSON line with the wall clock and appends it to --out. The file's size over time is
// the uncompressed replay-stream growth; a real host zstd-compresses the same stream.
//
// --exec sends `{t:"exec"}` commands once the game says map_loaded (dev knobs only: the
// referee refuses them unless the server has ENW_DEV_KNOBS=1). And when the file
// `<out>.end` appears, one `{t:"end", reason:"soak_end"}` -- the host's own end, which
// makes the referee send game_over + match_end and map_restart (referee.md §10.3). That is
// how a god-mode soak, which never dies, still exercises the game-over path. Nothing else
// is ever sent.
import net from 'node:net'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const port = Number(opt('port', 38797))
const out = opt('out', 'soaklink.ndjson')
const execs = []
for (let i = 0; i < argv.length; i++) if (argv[i] === '--exec') execs.push(argv[i + 1])

const w = fs.createWriteStream(out, { flags: 'a' })
let conns = 0
const server = net.createServer((sock) => {
  const n = ++conns
  w.write(JSON.stringify({ t: '_sink', wall: Date.now(), ev: 'connect', conn: n }) + '\n')
  let buf = ''
  let sent = false
  sock.setEncoding('utf8')
  sock.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      w.write(`{"wall":${Date.now()},"conn":${n},"m":${line}}\n`)
      if (!sent && execs.length && line.includes('"map_loaded"')) {
        sent = true
        execs.forEach((cmd, k) => sock.write(JSON.stringify({ t: 'exec', id: `soak${k}`, cmd }) + '\n'))
      }
    }
  })
  const endTimer = setInterval(() => {
    if (!fs.existsSync(`${out}.end`)) return
    clearInterval(endTimer)
    sock.write(JSON.stringify({ t: 'end', id: 'soakend', reason: 'soak_end' }) + '\n')
    w.write(JSON.stringify({ t: '_sink', wall: Date.now(), ev: 'sent end', conn: n }) + '\n')
  }, 1000)
  sock.on('close', () => clearInterval(endTimer))
  sock.on('error', () => {})
  sock.on('close', () => w.write(JSON.stringify({ t: '_sink', wall: Date.now(), ev: 'close', conn: n }) + '\n'))
})
server.listen(port, '127.0.0.1', () => console.log(`soaklink listening on 127.0.0.1:${port} -> ${out}`))
const stop = () => { server.close(); w.end(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
