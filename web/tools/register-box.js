#!/usr/bin/env node
// register-box — provision a game box's shared secret, out of band.
//
//   node web/tools/register-box.js --name zombies-dev --region nbg1 \
//        --note "Hetzner cx23, Wine" --max-instances 2 --out C:\path\enw-host.env
//
// A box authenticates to /api/gs/* with a per-box secret in `x-match-secret`
// (web/server/lib/boxes.js). There is an admin route for this, POST /api/admin/boxes,
// and it is the right way when a human is at a browser: it needs an admin SESSION, which
// is exactly the credential an agent must not have. This is the same call, from a shell.
//
// THE SECRET IS NEVER PRINTED. It goes to --out and nowhere else: not stdout, not the
// log, not an API response (boxes.list() deliberately omits match_key so it cannot end up
// in a screenshot). --out is written 0600 where the platform supports it.
//
// Idempotent in the only safe direction: if the box already exists this REFUSES and
// changes nothing, because re-creating it would mean minting a second secret and silently
// orphaning whatever is running with the first.
//
// BACK THE DATABASE UP FIRST. web/data/zombies.db is the live site's. --backup does it
// for you, into web/data/backup-<ISO>/, which is the convention already in that folder.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const name = arg('name')
const out = arg('out')
if (!name || !out || out === true) {
  console.error('usage: register-box.js --name <box> --out <env file> [--region r] [--note n] [--max-instances 2] [--backup] [--no-backup]')
  process.exit(2)
}

const DATA_DIR = process.env.ZM_DATA_DIR || path.join(__dirname, '..', 'data')
const DB_PATH = process.env.ZM_DB_PATH || path.join(DATA_DIR, 'zombies.db')
if (!fs.existsSync(DB_PATH)) { console.error(`no database at ${DB_PATH}`); process.exit(1) }

// ---- backup, before anything is opened for writing ------------------------------------
if (arg('no-backup') !== true) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')
  const dir = path.join(DATA_DIR, `backup-${stamp}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['zombies.db', 'zombies.db-wal', 'zombies.db-shm']) {
    const src = path.join(DATA_DIR, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f))
  }
  console.log(`backed up to ${dir}`)
}

const boxes = require('../server/lib/boxes')

if (boxes.byName(name)) {
  console.error(`box "${name}" already exists — refusing to mint a second secret for it.`)
  console.error('If its secret is lost, delete the row deliberately and re-run; anything')
  console.error('running with the old secret will stop being able to poll.')
  process.exit(3)
}

// 32 bytes from the CSPRNG. The site compares with a timing-safe equal (lib/util secretEq),
// so length costs nothing.
const secret = crypto.randomBytes(32).toString('hex')

const box = boxes.create({
  name,
  matchKey: secret,
  region: arg('region', null) || null,
  note: arg('note', null) || null,
  maxInstances: Number(arg('max-instances', 4)) || 4,
})

fs.writeFileSync(out, `ENW_BOX=${name}\nENW_SECRET=${secret}\n`, { mode: 0o600 })
try { fs.chmodSync(out, 0o600) } catch { /* Windows ACLs; the file still must be moved, not left here */ }

console.log(`created box #${box.id} "${box.name}" region=${box.region} max_instances=${box.max_instances}`)
console.log(`secret written to ${out} (mode 0600) — move it to the box and DELETE this copy.`)
console.log('It is not printed anywhere and it is not readable back out of the API.')
