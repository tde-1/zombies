'use strict'

// `/api/me` — everything the signed-in browser needs about itself, in one call, the way
// Movement's `/api/me` works: the client asks once on boot and once after any action that
// could change who it is.

const express = require('express')
const users = require('../lib/users')
const badges = require('../lib/badges')
const xp = require('../lib/xp')
const enw = require('../lib/enw')
const names = require('../lib/names')
const parties = require('../lib/parties')
const bans = require('../lib/bans')
const discord = require('../lib/discord')
const { requireUser } = require('../middleware/auth')

function router() {
  const r = express.Router()

  // Is this browser the LAUNCHER'S browser?
  //
  // The launcher's wrapped view stamps `X-ENW-Launcher: <version>` on every request it makes,
  // navigations included (launcher/src/main/main.js) — the header it offered us in
  // `launcher-v0.md` §"Still open for you", now taken up. The client also sniffs `window.enw`,
  // and both signals exist for a reason: the preload bridge is the one that can actually
  // LAUNCH a game, and the header is the one that is true before any client JS has run. A
  // page that has to decide where the Play button goes on first paint reads this.
  const launcherOf = (req) => {
    const v = req.get('x-enw-launcher')
    return v ? { launcher: true, launcher_version: String(v).slice(0, 32) } : { launcher: false }
  }

  r.get('/', (req, res) => {
    if (!req.me) return res.json({ signed_in: false, auth: require('./auth').effectiveMode(), ...launcherOf(req), discord: discord.forMe(null) })
    const sid = req.me.steam_id
    // Both ENW lookups are fire-and-forget AFTER the response is composed: a slow or absent
    // ENW must never delay the site's own boot call.
    setImmediate(() => { enw.refreshName(sid).catch(() => {}); enw.refreshVip(sid).catch(() => {}) })
    res.json({
      signed_in: true,
      auth: require('./auth').effectiveMode(),
      ...launcherOf(req),
      // The top-right Discord link. `invite` is null when the person has already linked
      // (or when nobody configured one), so the client has no URL to draw and cannot get
      // the rule wrong in a second place. lib/discord.js.
      discord: discord.forMe(sid),
      user: {
        ...users.pub(req.me),
        settings: users.settings(sid),
        privacy_history: req.me.privacy_history || 'public',
        profile_comments: req.me.profile_comments || 'everyone',
      },
      // THE FIRST-LOGIN PICKER'S ONE SIGNAL (2026-09-23, lib/names.js). True means this
      // account has no ENW name yet and the client must ask for one before anything else
      // — it is the name the invite token carries and the referee pins in game, so a
      // player without one cannot be given the lock. Always false once B configures the
      // ENW name authority, because then the name is not ours to pick.
      needs_name: names.needsName(sid),
      name_rules: names.RULES,
      standing: xp.forPlayer(sid),
      pinned: badges.pinnedFor(sid),
      party: parties.forPlayer(sid),
      invites: parties.invitesFor(sid),
      friend_requests: users.pendingRequests(sid),
      bans: bans.activeBans(sid).map((b) => ({ scope: b.scope, reason: b.reason, expires_at: b.expires_at })),
    })
  })

  // The launcher's `syncFromSite()` looks for exactly this path (launcher.md §4). It is
  // the same object `/api/me` embeds, served on its own so a settings sync is not a
  // full session fetch.
  r.get('/settings', requireUser, (req, res) => {
    res.json({ settings: users.settings(req.me.steam_id), defaults: users.DEFAULT_SETTINGS })
  })

  r.put('/settings', requireUser, (req, res) => {
    res.json({ ok: true, settings: users.saveSettings(req.me.steam_id, req.body || {}) })
  })

  r.put('/privacy', requireUser, (req, res) => {
    const { history, profile_comments: pc } = req.body || {}
    // Records and badges are ALWAYS public (99 §4.1). Only the game history can be hidden,
    // so there is nothing else this route can set.
    if (history && ['public', 'private'].includes(history)) {
      require('../db/database').db.prepare('UPDATE users SET privacy_history=? WHERE steam_id=?').run(history, req.me.steam_id)
    }
    if (pc && ['everyone', 'friends', 'nobody'].includes(pc)) {
      require('../db/database').db.prepare('UPDATE users SET profile_comments=? WHERE steam_id=?').run(pc, req.me.steam_id)
    }
    res.json({ ok: true })
  })

  // ---- the first-login username picker (2026-09-23) -----------------------------------
  //
  // Ported from Movement's `POST /username` (`CSGO-Matchmaker/server/routes/auth.js`),
  // minus the half that belongs to an authority we are not: there is no claim to make
  // over the wire, because with `ZM_ENW_BASE` unset this site IS the authority for the
  // name (lib/names.js says why, and refuses the claim outright when it is not).
  //
  // Set once. A rename is an admin's, and only an admin's — see the note in lib/names.js:
  // a self-serve rename would make the in-game lock decorative.

  // Live availability, so the field can say "taken" before the player presses anything.
  // It answers only available/not — never who holds a name, which would make this an
  // account-enumeration endpoint for anybody with a session.
  r.get('/username/check', requireUser, (req, res) => {
    const c = names.check(String((req.query && req.query.username) || ''), req.me.steam_id)
    res.json({ available: c.available, reason: c.reason, error: c.error || null })
  })

  r.post('/username', requireUser, (req, res) => {
    const r0 = names.claim(req.me.steam_id, (req.body && req.body.username) || '')
    if (!r0.ok) {
      const status = r0.reason === 'invalid' ? 400
        : r0.reason === 'taken' || r0.reason === 'already_set' ? 409
          : r0.reason === 'authority' ? 503 : 404
      return res.status(status).json({ error: r0.error, reason: r0.reason })
    }
    res.json({ ok: true, name: r0.name, user: users.publicById(req.me.steam_id) })
  })

  r.put('/pinned', requireUser, (req, res) => {
    res.json({ ok: true, pinned: badges.setPinned(req.me.steam_id, (req.body && req.body.ids) || []) })
  })

  r.post('/delete', requireUser, (req, res) => {
    // 99 §4.1: deletion anonymises. Records and replays are kept, attached to
    // "Deleted player", because a board with a hole in it is not a board.
    users.anonymise(req.me.steam_id)
    req.session.destroy(() => res.json({ ok: true }))
  })

  return r
}

module.exports = { router }
