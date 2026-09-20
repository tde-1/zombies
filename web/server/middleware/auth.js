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

function attach(req, res, next) {
  const sid = req.session && req.session.steam_id
  req.me = sid ? users.byId(sid) : null
  if (req.me && req.me.deleted) req.me = null
  next()
}

const deny = (res, code, error) => res.status(code).json({ error })

function requireUser(req, res, next) {
  if (!req.me) return deny(res, 401, 'sign in first')
  if (bans.siteBanned(req.me.steam_id)) return deny(res, 403, 'this account is banned')
  next()
}

function requireApproved(req, res, next) {
  if (!req.me) return deny(res, 401, 'sign in first')
  if (bans.siteBanned(req.me.steam_id)) return deny(res, 403, 'this account is banned')
  if (!req.me.approved && !req.me.is_admin) return deny(res, 403, 'your account is on the waiting list')
  next()
}

function requireMod(req, res, next) {
  if (!req.me) return deny(res, 401, 'sign in first')
  if (!req.me.is_mod && !req.me.is_admin) return deny(res, 403, 'moderators only')
  next()
}

function requireAdmin(req, res, next) {
  if (!req.me) return deny(res, 401, 'sign in first')
  if (!req.me.is_admin) return deny(res, 403, 'admins only')
  next()
}

function requireArchivist(req, res, next) {
  if (!req.me) return deny(res, 401, 'sign in first')
  if (!req.me.is_archivist && !req.me.is_admin) return deny(res, 403, 'archivists only')
  next()
}

module.exports = { attach, requireUser, requireApproved, requireMod, requireAdmin, requireArchivist }
