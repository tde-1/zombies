'use strict'

// Who is asking. `req.me` is the user row or null; everything else is a guard.
//
// ACCESS AT LAUNCH (05, 99 §4.4): **play is waitlist + approval, the archive is open to any
// Steam login.** That is two different guards and the distinction matters — a YouTube viewer
// clicking a link in a video description must reach the map page, read the boards and the
// comments and see what the map is, without being approved for anything. `requireUser` is
// "signed in"; `requireApproved` is "may play".

const users = require('../lib/users')
const bans = require('../lib/bans')
const names = require('../lib/names')

// ── THE NAME GATE (2026-09-22, B: "to be a user you have to sign in with Steam and you have
// to have an ENW username") ─────────────────────────────────────────────────────────────
//
// Movement puts its picker in front of the whole site in the CLIENT (movement-client
// App.jsx: `if (me.needs_username) return <UsernameSetup/>`, ahead of the approval wall).
// This site does that too, and ALSO refuses here, because a client-side gate is a
// suggestion: everything a user sets — settings, a party, a comment, a lease whose invite
// token carries `n` — hangs off the account, and an account with no ENW name has nothing
// honest to hang it on. So every guard below that means "a user" means "a NAMED user".
//
// `requireSignedIn` is the one exception and it exists for the picker's own routes
// (`/api/me/username*`) and account deletion: the only things a nameless session may do
// are choose a name, or leave.
const NEEDS_NAME = 'Choose your ENW username first'
const nameless = (req) => !!(req.me && names.needsName(req.me.steam_id))

function attach(req, res, next) {
  const sid = req.session && req.session.steam_id
  req.me = sid ? users.byId(sid) : null
  if (req.me && req.me.deleted) req.me = null
  next()
}

const deny = (res, code, error) => res.status(code).json({ error })

function requireSignedIn(req, res, next) {
  if (!req.me) return deny(res, 401, 'sign in first')
  if (bans.siteBanned(req.me.steam_id)) return deny(res, 403, 'this account is banned')
  next()
}

function requireUser(req, res, next) {
  if (!req.me) return deny(res, 401, 'sign in first')
  if (bans.siteBanned(req.me.steam_id)) return deny(res, 403, 'this account is banned')
  if (nameless(req)) return res.status(403).json({ error: NEEDS_NAME, needs_name: true })
  next()
}

function requireApproved(req, res, next) {
  if (!req.me) return deny(res, 401, 'sign in first')
  if (bans.siteBanned(req.me.steam_id)) return deny(res, 403, 'this account is banned')
  if (nameless(req)) return res.status(403).json({ error: NEEDS_NAME, needs_name: true })
  if (!req.me.approved && !req.me.is_admin) return deny(res, 403, 'your account is on the waiting list')
  next()
}

function requireMod(req, res, next) {
  if (!req.me) return deny(res, 401, 'sign in first')
  if (nameless(req)) return res.status(403).json({ error: NEEDS_NAME, needs_name: true })
  if (!req.me.is_mod && !req.me.is_admin) return deny(res, 403, 'moderators only')
  next()
}

function requireAdmin(req, res, next) {
  if (!req.me) return deny(res, 401, 'sign in first')
  if (nameless(req)) return res.status(403).json({ error: NEEDS_NAME, needs_name: true })
  if (!req.me.is_admin) return deny(res, 403, 'admins only')
  next()
}

function requireArchivist(req, res, next) {
  if (!req.me) return deny(res, 401, 'sign in first')
  if (nameless(req)) return res.status(403).json({ error: NEEDS_NAME, needs_name: true })
  if (!req.me.is_archivist && !req.me.is_admin) return deny(res, 403, 'archivists only')
  next()
}

module.exports = { attach, nameless, requireSignedIn, requireUser, requireApproved, requireMod, requireAdmin, requireArchivist }
