#!/usr/bin/env node
'use strict'
// Copy shared/telemetry/*.cjs (the canonical scrubber, tar and bundle writer) to the two
// places that cannot require them from the repo: the launcher (packaged into an asar) and
// the host agent (scp'd to the box). docs/kickstart/telemetry.md §4. Each suite has a
// test that fails when a copy differs, so forgetting this is caught, not shipped.
//
//   node tools/telemetry/sync-shared.js          copy
//   node tools/telemetry/sync-shared.js --check  exit 1 if any copy differs
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const SRC = path.join(REPO, 'shared', 'telemetry')
const DESTS = [
  path.join(REPO, 'launcher', 'src', 'main', 'telemetry'),
  path.join(REPO, 'infra', 'host-agent', 'lib', 'telemetry'),
]
const FILES = ['scrub.cjs', 'tar.cjs', 'bundle.cjs']

const check = process.argv.includes('--check')
let bad = 0
for (const d of DESTS) {
  fs.mkdirSync(d, { recursive: true })
  for (const f of FILES) {
    const a = fs.readFileSync(path.join(SRC, f))
    const p = path.join(d, f)
    const b = fs.existsSync(p) ? fs.readFileSync(p) : null
    if (b && a.equals(b)) continue
    if (check) { console.log(`DIFFERS ${path.relative(REPO, p)}`); bad++ } else { fs.writeFileSync(p, a); console.log(`copied ${path.relative(REPO, p)}`) }
  }
}
if (check && bad) process.exit(1)
if (!bad) console.log(check ? 'telemetry copies: identical' : 'telemetry copies: done')
