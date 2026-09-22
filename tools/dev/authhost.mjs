// A dev game-link host that does exactly one job: the INVITE-TOKEN half.
//
// WHY THIS EXISTS. `jointest.ps1` launches a real dedicated server and a real client
// and nothing is listening on the game link, so the referee's identity decisions have
// never been observable in a join run -- and `auth {slot, allow, reason}` (host->game)
// has never been answered at all, because the only thing that sends one is the real
// host agent, which this lane may not edit and which needs a site, a lease and a box
// registration to run.
//
// So this is the smallest possible stand-in, and the parts that MATTER are not
// stand-ins at all:
//
//   * it issues tokens with **web/server/lib/tokens.js** -- the site's own issuing
//     code, against a scratch key directory (ZM_KEY_DIR), never web/keys and never
//     the live DB;
//   * it verifies them with **infra/host-agent/lib/tokens.js :: TokenGuard** -- the
//     box's own verifying code, imported unmodified.
//
// Nothing about the signature check is simulated. What is simulated is only the
// plumbing around it: one TCP listener, NDJSON in and out, every line written to a
// transcript so a run can be read afterwards.
//
//   node tools/dev/authhost.mjs mint   --keydir <d> --match m_x --steamid 7656... [--forge]
//   node tools/dev/authhost.mjs serve  --keydir <d> --match m_x --port 38795 --out <f>
//
// Never point --keydir at web/keys: a dev run must not touch the site's real key.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')

const argv = process.argv.slice(2)
const mode = argv[0]
const opt = (name, dflt = null) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const flag = (name) => argv.includes('--' + name)

const keydir = path.resolve(opt('keydir', path.join(repo, 'build', 'authtest-keys')))
if (/[\\/]web[\\/]keys$/i.test(keydir)) {
  console.error('refusing to use the site\'s real key directory'); process.exit(2)
}
fs.mkdirSync(keydir, { recursive: true })
process.env.ZM_KEY_DIR = keydir

const require_ = createRequire(import.meta.url)
const siteTokens = require_(path.join(repo, 'web', 'server', 'lib', 'tokens.js'))
const siteKeys = require_(path.join(repo, 'web', 'server', 'lib', 'siteKeys.js'))

if (mode === 'mint') {
  const steamid = opt('steamid', '76561198000000001')
  const matchId = opt('match', 'm_devtest')
  const slot = opt('slot', null)
  let t = siteTokens.issue({
    steamid, matchId, name: opt('name', null),
    ...(slot != null ? { slot: Number(slot) } : {}),
    ttlMs: Number(opt('ttl', 30 * 60 * 1000)),
  })
  if (flag('forge')) {
    // A FORGED TOKEN: the payload says a different account, the signature is the one
    // the site made for the original. Every byte is otherwise well-formed, which is
    // the point -- this is what the check has to catch, not a corrupt string.
    const [b, s] = t.split('.')
    const p = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'))
    p.sid = opt('forge-sid', '76561198999999999')
    const { canonical, b64u } = require_(path.join(repo, 'web', 'server', 'lib', 'util.js'))
    t = `${b64u(Buffer.from(canonical(p), 'utf8'))}.${s}`
  }
  process.stdout.write(t + '\n')
  process.exit(0)
}

if (mode === 'selftest') {
  // THE CROSS-LANE CONTRACT, both halves, with neither half stubbed: every token here
  // is issued by the SITE's code and judged by the BOX's code.
  //
  // `infra/host-agent/test/run-all.js` already has the forged case, but it forges with
  // the host agent's OWN issuer -- so it proves the verifier rejects a signature from
  // another key, and nothing about the site. These are the cases that cross the lane
  // boundary, plus the two refusals the REFEREE now makes on its own (wrong match,
  // replayed jti) so that both sides of each are written down in one place.
  const { TokenGuard, check } = await import(
    'file://' + path.join(repo, 'infra', 'host-agent', 'lib', 'tokens.js').replace(/\\/g, '/'))
  const hk = await import(
    'file://' + path.join(repo, 'infra', 'host-agent', 'lib', 'keys.js').replace(/\\/g, '/'))
  const pub = hk.publicFromRaw(siteKeys.site().pub)
  const M = 'm_selftest'
  const SID = '76561198012345678'
  let fail = 0
  const t = (what, got, want) => {
    const ok = got === want
    if (!ok) fail++
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}: ${got}${ok ? '' : ` (wanted ${want})`}`)
  }

  const good = siteTokens.issue({ steamid: SID, matchId: M })
  t('a site-issued token verifies at the box', check(pub, good, { matchId: M, steamid: SID }).reason, 'ok')

  // Forged: the site's signature, somebody else's account in the payload. This is the
  // one that matters, because the REFEREE reads `sid` out of the payload WITHOUT a key
  // -- so the whole safety of that read rests on this returning bad_signature.
  const [b, s] = good.split('.')
  const { canonical, b64u } = require_(path.join(repo, 'web', 'server', 'lib', 'util.js'))
  const p2 = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'))
  p2.sid = '76561198999999999'
  const forged = `${b64u(Buffer.from(canonical(p2), 'utf8'))}.${s}`
  t('a payload edited to another steamid', check(pub, forged, { matchId: M }).reason, 'bad_signature')
  t('...and the box refuses to seat it', new TokenGuard(pub).admit({ slot: 0, token: forged }, M).allow, false)

  // Single use. The box keeps a jti set per boot; the referee keeps one per MATCH, so
  // a second client presenting the same token is refused even with the link down.
  const g = new TokenGuard(pub)
  t('the first presentation of a token', g.admit({ slot: 0, steamid: SID, token: good }, M).reason, 'ok')
  t('the second presentation of the SAME token', g.admit({ slot: 1, steamid: SID, token: good }, M).reason, 'replayed')

  // Bound to the lease.
  t('a token minted for another match', check(pub, siteTokens.issue({ steamid: SID, matchId: 'm_other' }),
                                              { matchId: M }).reason, 'wrong_match')

  // Short-lived by construction.
  t('a token past its exp', check(pub, siteTokens.issue({ steamid: SID, matchId: M, ttlMs: 1000 }),
                                  { matchId: M, now: Date.now() + 60_000 }).reason, 'expired')

  // And the shape the referee's own parser insists on: a steamid64 is 17 digits, so a
  // signed token for "1" is still not an account and must never reach a roster row.
  const shorty = siteTokens.issue({ steamid: '1', matchId: M })
  t('a well-signed token whose sid is not an id64 still verifies host-side',
    check(pub, shorty, { matchId: M }).reason, 'ok')
  console.log(fail ? `\n${fail} FAILED` : '\nall ok — the referee\'s unverified read of `sid` is safe ' +
    'exactly because an edited payload cannot survive the box\'s check')
  process.exit(fail ? 1 : 0)
}

if (mode !== 'serve') {
  console.error('usage: authhost.mjs mint|serve|selftest  [--keydir d] [--match m] [--steamid s] [--port p] [--out f]')
  process.exit(2)
}

// ------------------------------------------------------------------ serve --
const { TokenGuard } = await import(
  'file://' + path.join(repo, 'infra', 'host-agent', 'lib', 'tokens.js').replace(/\\/g, '/'))
const hostKeys = await import(
  'file://' + path.join(repo, 'infra', 'host-agent', 'lib', 'keys.js').replace(/\\/g, '/'))

const matchId = opt('match', 'm_devtest')
const port = Number(opt('port', 38795))
const outPath = opt('out', path.join(repo, 'build', 'authtest-link.ndjson'))
fs.mkdirSync(path.dirname(outPath), { recursive: true })
const out = fs.createWriteStream(outPath, { flags: 'w' })

// The box only ever holds the PUBLIC half, exactly as in production: it would fetch
// this from GET /api/gs/keys. Here it is read out of the scratch key file.
const guard = new TokenGuard(hostKeys.publicFromRaw(siteKeys.site().pub),
                             { singleUse: true, requireToken: true })

const say = (s) => { const l = `[authhost] ${s}`; console.log(l); out.write(l + '\n') }
say(`match=${matchId} port=${port} keydir=${keydir} site key ${siteKeys.site().keyId}`)

net.createServer((sock) => {
  say(`link connected from ${sock.remoteAddress}:${sock.remotePort}`)
  let buf = ''
  const send = (o) => { const l = JSON.stringify(o); out.write('<- ' + l + '\n'); sock.write(l + '\n') }
  sock.on('data', (d) => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      out.write('-> ' + line + '\n')
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.t === 'hello') { say('game said hello'); send({ t: 'hello_ack', v: 0 }) }
      if (m.t === 'player_connect') {
        const r = guard.admit(m, matchId)
        say(`auth slot ${m.slot} ${m.name || ''} ${m.steamid || '(no id)'} identity=${m.identity}: ` +
            `${r.allow ? 'ALLOW' : 'DENY'} (${r.reason})`)
        send({ t: 'auth', slot: m.slot, allow: r.allow, reason: r.reason })
      }
      if (m.t === 'game_over') {
        say('GAME OVER: ' + JSON.stringify(m.players))
      }
      if (m.t === 'match_end') say('match_end (this harness never reuses an instance)')
    }
  })
  sock.on('close', () => say('link closed'))
  sock.on('error', (e) => say('link error ' + e.message))
}).listen(port, '127.0.0.1', () => say(`listening on 127.0.0.1:${port}`))

process.on('SIGINT', () => { say('bye'); out.end(); process.exit(0) })
