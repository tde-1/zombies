'use strict'

// Pre-approve Steam accounts for the closed beta, so they can sign in and play without
// waiting on the queue.
//
//   node tools/approve.js                         the beta list below
//   node tools/approve.js 7656119… 7656119…       those accounts
//   node tools/approve.js --list                  who is approved now
//
// It runs **the same two statements `server/routes/admin.js` runs** for
// `POST /api/admin/player/:who/approve`: set `users.approved = 1`, then write a
// `user.approve` line into `activity_log`. Deliberately the same, and deliberately not a
// second implementation — an approval that did not leave the same audit trail as an
// approval made through the admin page would be an approval nobody could later account
// for. The actor is recorded as the owner's account, because that is whose decision it is.
//
// An account that has never signed in has no row yet, so `users.ensure()` creates one
// first. That is safe: the row carries nothing but the SteamID and the default settings
// until Steam sign-in fills in the persona, and approving ahead of the first sign-in is
// the entire point of the exercise.
//
// Handles only, never real names (README: real names, Discord handles and emails never go
// into code, docs, fixtures or commits).

const path = require('node:path')

// The seven accounts B named on 2026-09-22 for the morning, plus the ones added after.
const BETA = [
  ['76561198126330106', 'B', { admin: true }],
  ['76561198805847033', 'jamie'],
  ['76561198396250036', 'zeroh'],
  ['76561199245978066', 'stew'],
  ['76561199013523774', 'jacob'],
  ['76561199074074176', 'air'],
  ['76561199559696300', 'toku'],
  // Added 2026-09-24 (steamcommunity.com/profiles/76561198335411273). Play access only.
  ['76561198335411273', null],
]

const OWNER = BETA[0][0]

function load () {
  // Required lazily so the module can be imported by a test that has already pointed
  // ZM_DATA_DIR at a scratch directory.
  const { db, now } = require(path.join(__dirname, '..', 'server', 'db', 'database'))
  const users = require(path.join(__dirname, '..', 'server', 'lib', 'users'))
  return { db, now, users }
}

/**
 * @param {Array<[string,string,object=]>} list
 * @returns {Array<{steam_id:string,handle:string|null,created:boolean,was:boolean}>}
 */
function approve (list = BETA, { actor = OWNER } = {}) {
  const { db, now, users } = load()
  const out = []
  const tx = db.transaction(() => {
    for (const [sid, handle, opts] of list) {
      if (!/^7656119\d{10}$/.test(String(sid))) throw new Error(`not a SteamID64: ${sid}`)
      const existed = !!db.prepare('SELECT 1 FROM users WHERE steam_id=?').get(String(sid))
      const before = db.prepare('SELECT approved FROM users WHERE steam_id=?').get(String(sid))
      users.ensure(sid)
      // The two statements routes/admin.js runs, verbatim.
      db.prepare('UPDATE users SET approved=1 WHERE steam_id=?').run(String(sid))
      db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('user.approve', ?, ?, ?)")
        .run(String(actor), JSON.stringify({ steam_id: String(sid), via: 'tools/approve.js' }), now())
      // The owner is the site's admin and moderator. Nobody else on this list is, and the
      // script never grants a role it was not told to.
      if (opts && opts.admin) db.prepare('UPDATE users SET is_admin=1, is_mod=1 WHERE steam_id=?').run(String(sid))
      out.push({ steam_id: String(sid), handle: handle || null, created: !existed, was: !!(before && before.approved) })
    }
  })
  tx()
  return out
}

function approved () {
  const { db } = load()
  return db.prepare('SELECT steam_id, approved, is_admin, is_mod FROM users WHERE approved=1 AND deleted=0 ORDER BY steam_id').all()
}

module.exports = { approve, approved, BETA, OWNER }

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    for (const u of approved()) console.log(`${u.steam_id}  ${u.is_admin ? 'admin' : u.is_mod ? 'mod' : ''}`)
    console.log(`${approved().length} approved`)
  } else {
    const ids = args.filter((a) => !a.startsWith('--'))
    const list = ids.length ? ids.map((id) => [id, null]) : BETA
    for (const r of approve(list)) {
      console.log(`${r.steam_id}  ${r.handle || ''}`.padEnd(30) +
        (r.was ? 'already approved' : r.created ? 'row created, approved' : 'approved'))
    }
    console.log(`${approved().length} accounts approved in total`)
  }
}
