// What the launcher is told about a socket event (attention.js). Pure: no socket, no React,
// so web/test/friends.js imports it under node. null = nothing to tell (own line, a notice,
// global chat, an event with no id).

export function toAttention(event, payload, meId) {
  const me = String(meId || '')
  if (event === 'invite_received') {
    const i = payload && payload.invite
    if (!i || !i.id) return null
    const from = (i.from && (i.from.name || i.from.enw_name)) || 'Somebody'
    return {
      kind: 'invite',
      id: `invite:${i.id}`,
      invite_id: Number(i.id),
      party_id: i.party_id || null,
      from,
      from_steam: (i.from && i.from.steam_id) || null,
      title: `${from} invited you`,
      body: i.map_title ? `Party on ${i.map_title}` : 'Join their party',
    }
  }
  if (event === 'chat-private') {
    const l = payload || {}
    if (l.channel !== 'party' && l.channel !== 'dm') return null
    if (l.kind === 'system' || !l.text) return null
    if (me && String(l.steamid || '') === me) return null
    const from = l.from || 'Somebody'
    return {
      kind: l.channel === 'dm' ? 'dm' : 'party',
      id: `chat:${l.id}`,
      from,
      from_steam: l.steamid || null,
      title: l.channel === 'dm' ? `${from} messaged you` : `${from} in party chat`,
      body: String(l.text).slice(0, 140),
    }
  }
  return null
}
