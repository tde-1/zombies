#!/usr/bin/env node
// Recover a replay whose host died before it could sign the footer.
//
//   node tools/recover.js <file.enwr> [--out <file>] [--key <host-key.json>]
//
// WHY THIS EXISTS. The footer — the index, the chain and the signature — is written when
// the game ends. Kill the host agent mid-game (a box crash, an OOM, a Windows
// TerminateProcess, which is what `child.kill('SIGTERM')` actually does there) and what is
// on disk is a header plus a run of good chunks and NO footer. `verify.js` correctly calls
// that "not a replay": nothing about it can be proved. Vault 10 §5 says a server crash
// should still save the game up to the crash, TAGGED. This is that tool.
//
// WHAT IT CAN AND CANNOT CLAIM. It rebuilds the index and the chain from the bytes that
// survived and signs the result NOW, with this box's key. That proves the file has not
// been modified SINCE RECOVERY. It does NOT prove the original was untampered, because
// nothing signed it at the time. The output therefore carries `recovered: true` and
// `partial: true` in its footer, and anything reading a replay must treat a recovered one
// as evidence of a lower grade — good enough for a badge, not for a world record.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { readHeader, MAGIC, CHUNK_HEAD_LEN, FOOTER_MAGIC, FORMAT_VERSION, CF_ZSTD } from '../lib/replay.js'
import { sha256, sha256hex, canonical, b64u, parseArgs, fmtBytes } from '../lib/util.js'
import * as keys from '../lib/keys.js'
import { sign } from '../lib/keys.js'

const a = parseArgs(process.argv.slice(2))
const file = a._[0]
if (!file) { console.error('usage: node tools/recover.js <file.enwr> [--out <file>] [--key <host-key.json>]'); process.exit(2) }

const keyFile = a.key || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'keys', 'host-box-a.json')
const hostKey = keys.loadOrCreate(keyFile)
const out = a.out || file.replace(/\.enwr$/, '') + '.recovered.enwr'

const head = readHeader(file)
const buf = fs.readFileSync(file)
let off = head.bodyOffset
let chain = sha256(head.headerBytes)
const index = []
let events = 0
let rawBytes = 0
let t0 = null, t1 = null

while (off + CHUNK_HEAD_LEN <= buf.length) {
  const plen = buf.readUInt32LE(off)
  const flags = buf.readUInt8(off + 4)
  const ulen = buf.readUInt32LE(off + 5)
  // A footer's length prefix would appear here as a nonsense "chunk"; so would the tail of
  // a half-written record. Either way, stop at the first thing that does not decode.
  if (plen <= 0 || plen > 64 * 1024 * 1024 || off + CHUNK_HEAD_LEN + plen > buf.length) break
  const record = buf.subarray(off, off + CHUNK_HEAD_LEN + plen)
  let raw
  try { raw = flags & CF_ZSTD ? zlib.zstdDecompressSync(record.subarray(CHUNK_HEAD_LEN)) : record.subarray(CHUNK_HEAD_LEN) }
  catch { break }
  if (raw.length !== ulen) break
  const lines = raw.toString('utf8').split('\n').filter(Boolean)
  let c0 = null, c1 = null
  for (const l of lines) { try { const e = JSON.parse(l); if (Number.isFinite(e.ms)) { if (c0 == null) c0 = e.ms; c1 = e.ms } } catch { /* skip */ } }
  const h = sha256(record)
  chain = sha256(Buffer.concat([chain, h]))
  index.push({ i: index.length, off, len: plen, ulen, t0: c0 ?? 0, t1: c1 ?? 0, n: lines.length, hash: h.toString('hex'), chain: chain.toString('hex') })
  events += lines.length
  rawBytes += raw.length
  if (t0 == null) t0 = c0
  t1 = c1
  off += record.length
}

if (!index.length) { console.error(`${file}: no complete chunks survived — nothing to recover`); process.exit(1) }

const footerNoSig = {
  v: FORMAT_VERSION, alg: 'ed25519', key_id: hostKey.keyId, pub: hostKey.pub,
  header_hash: sha256hex(head.headerBytes), chunks: index, final_chain: chain.toString('hex'),
  events, raw_bytes: rawBytes, duration_ms: (t1 ?? 0) - (t0 ?? 0),
  signed_at: new Date().toISOString(),
  // The honest part. A reader that ignores these has been warned.
  recovered: true,
  partial: true,
  recovered_from: path.basename(file),
  recovered_note: 'The host did not sign this replay at the time: it was rebuilt from the surviving chunks and signed afterwards. The signature proves it has not changed SINCE RECOVERY, not that the original was untampered. Not record-grade evidence.',
  trailing_bytes: buf.length - off,
}
const footerBytes = Buffer.from(canonical({ ...footerNoSig, sig: b64u(sign(hostKey.privateKey, Buffer.from(canonical(footerNoSig), 'utf8'))) }), 'utf8')

const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(footerBytes.length, 0)
fs.writeFileSync(out, Buffer.concat([buf.subarray(0, off), lenBuf, footerBytes, lenBuf, FOOTER_MAGIC]))

console.log(`recovered ${index.length} chunk(s), ${events} events, ${((footerNoSig.duration_ms) / 60000).toFixed(1)} min of game time`)
console.log(`  discarded ${fmtBytes(buf.length - off)} of incomplete tail`)
console.log(`  -> ${out} (${fmtBytes(fs.statSync(out).size)}), marked recovered + partial, signed by ${hostKey.keyId}`)
console.log(`  verify it with: node tools/verify.js "${out}"`)
