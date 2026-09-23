import { io } from 'socket.io-client'

// One socket for the whole app, same origin, session-authenticated on the server side
// (server/index.js shares the express session with socket.io, so there is no second auth
// path and no token to leak).
//
// It carries three things: presence counts, the global chat ring, and a nudge when the
// party changes. Everything else is a normal fetch — a websocket that becomes the API is a
// websocket that has to reimplement caching, retries and status codes.

// `auth.client` tells the server this socket is the launcher (the preload's `window.enw`
// exists before any page script runs), so somebody else's rail can say "In launcher".
const CLIENT = typeof window !== 'undefined' && window.enw ? 'launcher' : 'site'
export const socket = io({ path: '/socket.io', autoConnect: true, transports: ['websocket', 'polling'], auth: { client: CLIENT } })

export function onChat(fn) {
  socket.on('chat', fn)
  return () => socket.off('chat', fn)
}

export function onPresence(fn) {
  socket.on('presence', fn)
  return () => socket.off('presence', fn)
}
