'use strict'

// The rail's online block: who is about, and whose lobby you can drop into.
//
// Movement's `FriendsBlock` (movement-client/src/components/PartyRail.jsx) and the server
// half that feeds it, with zombies' nouns. Its rule carries over word for word:
//
//   WHO IS IN IT DEPENDS ON THE READER (Movement, owner 2026-08-21). An approved account gets
//   every player on the site right now and the block calls itself Online; anybody else gets
//   their own accepted friends and it calls itself Friends. "Here is everyone who is online"
//   is a roster of the community, and that is not something to hand to an account that has
//   not been let in yet.
//
// The scope is decided HERE and sent with the list, never guessed by the client: a block that
// says "Online" over a friends-only list is what makes a reader think the site is empty.
//
// Each row carries what the rail needs to pick its one action, worked out for THIS reader:
//   lobby     they are in a party that has not launched: its map, who may join, and whether
//             this reader may (`joinable`) or has been asked (`invited` + `invite_id`)
//   game      they are in a game a box is reporting (the box beats the lobby, presence.js)
//   held      they are already in, or already invited to, the reader's own party

const { db } = require('../db/database')
const presence = require('./presence')
const users = require('./users')
const bans = require('./bans')
const parties = require('./parties')

function forViewer(viewerId) {
  const me = String(viewerId)
  const viewer = users.byId(me)
  const everyone = !!(viewer && (viewer.approved || viewer.is_admin))
  const friends = new Set(users.friendIds(me))

  const ids = presence.onlineIds().filter((id) => id !== me && (everyone || friends.has(id)))

  const mine = parties.forPlayerRow(me)
  const myMembers = new Set(mine ? db.prepare('SELECT steam_id FROM party_members WHERE party_id=?').all(mine.id).map((r) => r.steam_id) : [])
  const myInvited = new Set(mine ? db.prepare("SELECT to_steam FROM party_invites WHERE party_id=? AND state='pending'").all(mine.id).map((r) => r.to_steam) : [])
  // Invites addressed to the reader, by the party they came from, so a row sitting in that
  // lobby offers Accept rather than a second, contradictory action.
  const toMe = new Map(db.prepare("SELECT id, party_id FROM party_invites WHERE to_steam=? AND state='pending'").all(me).map((r) => [r.party_id, r.id]))
  const publicBanned = bans.publicBanned(me)

  const rows = []
  for (const id of ids) {
    const u = users.publicById(id)
    if (!u || u.deleted) continue
    const where = presence.whereabouts(id) || { state: 'online' }
    const isFriend = friends.has(id)
    const row = {
      ...u,
      online: true,
      friend: isFriend,
      // Where the friendship comes from ('zombies', 'movement'), so the rail can say
      // "friend on Movement" and a remove button knows it is not ours to press.
      friend_sources: isFriend ? users.friendSources(me, id) : [],
      client: where.client || null,
      held: myMembers.has(id) ? 'member' : myInvited.has(id) ? 'invited' : null,
      lobby: null,
      game: null,
    }
    if (where.state === 'in-game' && where.match_id) {
      row.game = { match_id: where.match_id, map_key: where.map_key, map_title: where.map_title, art: artOf(where.map_key), round: where.round || null }
    } else if (where.party_id) {
      const p = db.prepare('SELECT * FROM parties WHERE id=?').get(where.party_id)
      if (p) {
        const n = db.prepare('SELECT COUNT(*) c FROM party_members WHERE party_id=?').get(p.id).c
        const inviteId = toMe.get(p.id) || null
        const open = ['forming', 'ready-check'].includes(p.state) && n < parties.MAX_PLAYERS
        const allowed = inviteId != null
          || (p.visibility === 'public' && !publicBanned)
          || (p.visibility === 'friends' && users.friendIds(p.leader).includes(me))
        row.lobby = {
          party_id: p.id,
          map_key: p.map_key || null,
          map_title: where.map_title || null,
          art: artOf(p.map_key),
          mode: p.mode,
          visibility: p.visibility,
          state: p.state,
          members: n,
          full: n >= parties.MAX_PLAYERS,
          mine: !!(mine && mine.id === p.id),
          joinable: !!(open && allowed && !(mine && mine.id === p.id)),
          invited: inviteId != null,
          invite_id: inviteId,
        }
      }
    }
    row.status = statusOf(row)
    rows.push(row)
  }

  // FRIENDS FIRST (B, 2026-09-23: "friends first, then everyone else"), then somebody
  // sitting on a map (those rows have something to do), then by name, so the list does not
  // reshuffle on every push.
  rows.sort((a, b) => (Number(b.friend) - Number(a.friend))
    || (Number(!!(b.lobby || b.game)) - Number(!!(a.lobby || a.game)))
    || String(a.name).localeCompare(String(b.name)))
  return { scope: everyone ? 'online' : 'friends', players: rows, friends: rows.filter((r) => r.friend).length }
}

// One line of where somebody is, worded once here so the rail, the Esc menu and the launcher
// say the same thing. B's words: Online / In launcher / In game on <map> round N / In party.
function statusOf(row) {
  const pretty = (t, k) => t || k || null
  if (row.game) {
    const map = pretty(row.game.map_title, row.game.map_key) || 'a map'
    return { kind: 'game', text: `In game on ${map}${row.game.round ? `, round ${row.game.round}` : ''}` }
  }
  if (row.lobby) {
    const map = pretty(row.lobby.map_title, row.lobby.map_key)
    return { kind: 'party', text: `In party${map ? ` on ${map}` : ''} (${row.lobby.members}/${parties.MAX_PLAYERS})` }
  }
  if (row.client === 'launcher') return { kind: 'launcher', text: 'In launcher' }
  return { kind: 'online', text: 'Online' }
}

const artOf = (key) => {
  if (!key) return null
  const m = db.prepare('SELECT art FROM maps WHERE key=?').get(String(key))
  return (m && m.art) || null
}

/**
 * The invite box's search: players by ENW name (or Steam persona), friends and the online
 * first. Two characters minimum, eight rows, the same shape Movement's `friendSearch` has.
 * It answers WHO matches a prefix the reader typed, which is what the nav search already
 * answers for anybody; it never lists the whole user table.
 */
function search(viewerId, q) {
  const s = String(q || '').trim().toLowerCase()
  if (s.length < 2) return []
  const me = String(viewerId)
  const online = new Set(presence.onlineIds())
  const friends = new Set(users.friendIds(me))
  const like = `%${s.replace(/[%_]/g, '')}%`
  return db.prepare(`SELECT * FROM users WHERE deleted=0 AND steam_id<>?
                       AND (lower(enw_name) LIKE ? OR lower(username) LIKE ?) LIMIT 40`).all(me, like, like)
    .map((r) => ({ ...users.pub(r), online: online.has(r.steam_id), friend: friends.has(r.steam_id) }))
    .sort((a, b) => (Number(b.friend) - Number(a.friend)) || (Number(b.online) - Number(a.online))
      || (Number(String(b.name).toLowerCase().startsWith(s)) - Number(String(a.name).toLowerCase().startsWith(s)))
      || String(a.name).localeCompare(String(b.name)))
    .slice(0, 8)
}

module.exports = { forViewer, search, statusOf }
