'use strict'

// `/api/game-chat/menu/*` — what the in-game Esc menu speaks (client-dll/components/
// pause_menu.cpp; docs/kickstart/esc-menu.md). Same door as the chat overlay
// (routes/gamechat.js): the CHAT PASS in `Authorization: Bearer`, never the session cookie,
// and gate-exempt because it lives under `/api/game-chat` (middleware/gate.js). Every route
// refuses without a pass.
//
// The menu is the rail's online block and invites, drawn inside the game, so this is the
// rail's own server code (lib/roster.js, lib/parties.js) behind a second door, not a copy
// of it. Nothing here decides anything the rail does not already decide.
//
//   GET  /api/game-chat/menu/state          online friends (roster.forViewer, the reader's
//                                           scope), invites addressed to me, my party
//   POST /api/game-chat/menu/invite {steam_id}      = POST /api/party/invite (approved only)
//   POST /api/game-chat/menu/accept {invite_id}     = the rail's Accept: join that party
//   POST /api/game-chat/menu/decline {invite_id}    = POST /api/party/invites/:id/decline
//
// Accepting from inside a game only moves the player into the other party on the site. The
// LAUNCHER does the rest (launcher.md "Somebody else's Start is your launch"): its party
// watcher follows a match for the party it is in once no game flow is running, i.e. after
// this game exits. The menu says so rather than pretending to connect anywhere.

const express = require('express')
const gameChat = require('../lib/gameChat')
const roster = require('../lib/roster')
const parties = require('../lib/parties')
const users = require('../lib/users')

function bearer(req, res, next) {
  const h = String(req.headers.authorization || '')
  const m = /^Bearer\s+(\S+)$/i.exec(h)
  const u = m ? gameChat.verifyPass(m[1]) : null
  if (!u) return res.status(401).json({ error: 'no valid chat pass' })
  req.chatUser = u
  next()
}

const sidOf = (u) => String(u.steam_id || u.steamid || u.sid || '')

// One short line per friend, worded for a 640x480 panel: where they are, not how.
function whereOf(p) {
  if (p.game) return { kind: 'game', text: `In game: ${p.game.map_title || p.game.map_key || 'a map'}` }
  if (p.lobby && p.lobby.state === 'in-game') {
    return { kind: 'game', text: `In game: ${p.lobby.map_title || p.lobby.map_key || 'a map'}` }
  }
  if (p.lobby) {
    const map = p.lobby.map_title || p.lobby.map_key || 'no map yet'
    const n = p.lobby.members
    return { kind: 'lobby', text: `Lobby: ${map} (${n}/${parties.MAX_PLAYERS})` }
  }
  return { kind: 'online', text: 'Online' }
}

function state(sid) {
  const me = users.byId(sid)
  const on = roster.forViewer(sid)
  const party = parties.forPlayer(sid)
  const friends = on.players.slice(0, 24).map((p) => {
    const w = whereOf(p)
    return {
      steam_id: p.steam_id,
      name: p.name,
      where: w.text,
      where_kind: w.kind,
      held: p.held || null,                     // 'member' | 'invited' | null
      can_invite: !p.held,
      // They sit in a lobby that invited ME: the row's action is Accept, not Invite.
      invite_id: (p.lobby && p.lobby.invite_id) || null,
    }
  })
  const invites = parties.invitesFor(sid).slice(0, 8).map((i) => ({
    id: i.id,
    party_id: i.party_id,
    from: (i.from && i.from.name) || 'player',
    map_title: i.map_title || i.map_key || null,
    mode: i.mode || null,
  }))
  return {
    scope: on.scope,
    approved: !!(me && (me.approved || me.is_admin)),
    friends,
    invites,
    party: party ? {
      id: party.id,
      members: party.members.length,
      map_title: party.map ? party.map.title : null,
      state: party.state,
      is_leader: party.is_leader,
    } : null,
  }
}

function router() {
  const r = express.Router()
  r.use(bearer)

  r.get('/state', (req, res) => res.json(state(sidOf(req.chatUser))))

  // The rail's `requireApproved` gate, applied to the pass's account: the pass proves who,
  // not what they may do.
  const approved = (req, res, next) => {
    const u = users.byId(sidOf(req.chatUser))
    if (!u || !(u.approved || u.is_admin)) return res.status(403).json({ ok: false, error: 'your account is not approved yet' })
    next()
  }
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {})
  const reply = (res, out) => res.status(out && out.ok === false ? 400 : 200).json(out)

  r.post('/invite', approved, (req, res) => {
    const to = String(body(req).steam_id || '')
    if (!/^\d{5,20}$/.test(to)) return reply(res, { ok: false, error: 'no player given' })
    const out = parties.invite(sidOf(req.chatUser), to, null)
    reply(res, out.ok ? { ok: true, to: out.to ? out.to.name : null } : out)
  })

  r.post('/accept', approved, (req, res) => {
    const sid = sidOf(req.chatUser)
    const id = Number(body(req).invite_id || 0)
    const inv = parties.invitesFor(sid).find((i) => Number(i.id) === id)
    if (!inv) return reply(res, { ok: false, error: 'that invite is gone' })
    const out = parties.join(sid, inv.party_id)
    reply(res, out.ok ? { ok: true, party_id: inv.party_id, from: inv.from ? inv.from.name : null, map_title: inv.map_title || null } : out)
  })

  r.post('/decline', (req, res) => {
    const id = Number(body(req).invite_id || 0)
    reply(res, parties.declineInvite(sidOf(req.chatUser), id))
  })

  return r
}

module.exports = { router, state }
