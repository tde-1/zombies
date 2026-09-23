// The chat dock's one merge. Every source of lines — the backlog fetch, the live socket, the
// catch-up after a reconnect — goes through here, so a line is drawn once however many of
// them deliver it. Keyed on the ring's id (chat_network.id), ordered by it, capped.
// Pure, so web/test/chat-dedupe.js runs it under node.

const idOf = (l) => (l && l.id != null ? Number(l.id) : NaN)

export function mergeLines(prev, incoming, cap = 200) {
  const byId = new Map()
  for (const l of prev || []) if (Number.isFinite(idOf(l))) byId.set(idOf(l), l)
  for (const l of incoming || []) if (Number.isFinite(idOf(l)) && !byId.has(idOf(l))) byId.set(idOf(l), l)
  const out = [...byId.values()].sort((a, b) => idOf(a) - idOf(b))
  return out.length > cap ? out.slice(-cap) : out
}

/** The newest id held: the cursor for `/api/chat?since=`. */
export function lastId(lines) {
  let m = 0
  for (const l of lines || []) if (idOf(l) > m) m = idOf(l)
  return m
}
