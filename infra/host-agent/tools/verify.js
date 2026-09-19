#!/usr/bin/env node
// Prove a replay is unmodified — the tool a board admin, a rival, or anyone at all runs.
//
//   node tools/verify.js <file.enwr> [--pub <base64url>] [--json]
//   node tools/verify.js <file.enwr> --tamper        # flip one byte and watch it fail
//
// The point of `--tamper` is that "it says VALID" means nothing on its own. The demo
// copies the replay, changes ONE byte in the middle of a chunk (a single digit of one
// player's position, say), and verifies the copy: the chunk hash, the chain from that
// chunk onwards, and the signature all fail. That is what makes a record verifiable
// without a video (vault 10 §4b).
import fs from 'node:fs'
import path from 'node:path'
import { verifyFile, readFooter, readHeader, readChunk } from '../lib/replay.js'
import { parseArgs, fmtBytes, fmtDur } from '../lib/util.js'

const a = parseArgs(process.argv.slice(2))
const file = a._[0]
if (!file) {
  console.error('usage: node tools/verify.js <file.enwr> [--pub <key>] [--tamper] [--json] [--dump N]')
  process.exit(2)
}
if (!fs.existsSync(file)) { console.error(`no such file: ${file}`); process.exit(2) }

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[90m${s}\x1b[0m`

function report(r, label) {
  if (a.json) { console.log(JSON.stringify(r, null, 2)); return r.ok }
  console.log(`\n${label}`)
  console.log(dim('  ' + '-'.repeat(68)))
  console.log(`  file          ${r.file}`)
  console.log(`  size          ${fmtBytes(r.size)}`)
  if (r.header) {
    console.log(`  match         ${r.header.match_id}  ${r.header.map_name || r.header.map || '?'}  (${r.header.mode})`)
    console.log(`  recorded by   box ${r.header.box}, instance ${r.header.instance}, ${r.header.dll_build || 'unknown build'}`)
    console.log(`  exe sha256    ${r.header.exe_sha256 || dim('(not reported)')}`)
  }
  console.log(`  content       ${r.chunks} chunks, ${r.events} events, ${fmtDur(r.durationMs)} of game time`)
  if (r.rawBytes) console.log(`  compression   ${fmtBytes(r.rawBytes)} -> ${fmtBytes(r.size)}  (${(r.rawBytes / r.size).toFixed(1)}x)`)
  console.log(`  signed by     ${r.keyId} ${dim(r.pub || '')}`)
  console.log(`  signed at     ${r.signedAt}`)
  if (r.durationMs > 0) console.log(`  size rate     ${(r.size / 1048576 / (r.durationMs / 3600000)).toFixed(2)} MB per game-hour`)
  console.log(dim('  ' + '-'.repeat(68)))
  if (r.ok) console.log(`  ${green('VALID')} — every chunk hashes to its index entry, the chain is intact, and the footer signature checks out.`)
  else {
    console.log(`  ${red('INVALID')} — ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}:`)
    for (const e of r.errors) console.log(`    ${red('x')} ${e}`)
  }
  console.log()
  return r.ok
}

const first = verifyFile(file, { expectPub: a.pub || null })
let ok = report(first, 'VERIFY')

if (a.dump) {
  const { footer } = readFooter(file)
  const i = Number(a.dump)
  const entry = footer.chunks[i]
  if (entry) for (const ev of readChunk(file, entry).events.slice(0, 40)) console.log(JSON.stringify(ev))
}

if (a.tamper) {
  const copy = path.join(path.dirname(file), path.basename(file, '.enwr') + '.TAMPERED.enwr')
  fs.copyFileSync(file, copy)
  const { footer } = readFooter(file)
  const target = footer.chunks[Math.floor(footer.chunks.length / 2)] || footer.chunks[0]
  // One byte, in the middle of a real chunk's payload. Nothing else is touched: the file
  // is the same length, the index still points at the same offsets, the footer is
  // untouched and still carries a genuine signature from the real host key.
  const at = target.off + 9 + Math.floor(target.len / 2)
  const fd = fs.openSync(copy, 'r+')
  const b = Buffer.alloc(1)
  fs.readSync(fd, b, 0, 1, at)
  const before = b[0]
  b[0] = b[0] ^ 0x01
  fs.writeSync(fd, b, 0, 1, at)
  fs.closeSync(fd)
  console.log(`TAMPER DEMO: copied to ${path.basename(copy)} and flipped one bit at byte ${at} (chunk ${target.i}, 0x${before.toString(16)} -> 0x${b[0].toString(16)}). Same file size, same index, same real signature.`)
  const second = verifyFile(copy)
  report(second, 'VERIFY (tampered copy)')
  if (second.ok) { console.log(red('THE TAMPER DEMO FAILED: a modified replay verified as valid. That is a bug in the format or the verifier.')); ok = false }
  else console.log(green('Tamper detected, as it must be.') + ' The original still verifies; the copy does not.')
  if (!a.keep) fs.unlinkSync(copy)
}

process.exit(ok ? 0 : 1)
