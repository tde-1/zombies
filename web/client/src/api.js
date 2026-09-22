// One fetch wrapper, same-origin, credentials included. Movement's api.js in miniature.
//
// Every call returns the parsed body and THROWS an Error carrying the server's own message
// on a non-2xx, because the server's message is written for a player to read ("that lobby is
// friends-only") and inventing a second sentence in the client would lose it.

async function req(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* html error page */ }
  if (!res.ok) {
    const e = new Error((json && json.error) || `${res.status} ${res.statusText}`)
    e.status = res.status
    e.body = json
    throw e
  }
  return json
}

export const api = {
  get: (p) => req(p),
  post: (p, body) => req(p, { method: 'POST', body: body || {} }),
  put: (p, body) => req(p, { method: 'PUT', body: body || {} }),
  del: (p) => req(p, { method: 'DELETE' }),
}

// Steam is the only sign-in (2026-09-22). There is no dev page to fall back to.
export const SIGN_IN = '/auth/steam'

// ---- formatting ---------------------------------------------------------------------
export function dur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

// A speedrun time. Different from dur(): a board wants 1:02:33.4, not "1h 02m".
export function clock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const t = Math.floor(ms / 100) / 10
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = (t % 60).toFixed(1).padStart(4, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export function ago(ts) {
  if (!ts) return ''
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

export const hours = (ms) => (ms > 0 ? `${Math.round(ms / 3600000)}h` : '0h')
export const num = (n) => (n == null ? '—' : Number(n).toLocaleString())
