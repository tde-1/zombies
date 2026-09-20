import { io } from 'socket.io-client'

// One socket for the whole app, same origin, session-authenticated on the server side
// (server/index.js shares the express session with socket.io, so there is no second auth
// path and no token to leak).
//
// It carries three things: presence counts, the global chat ring, and a nudge when the
// party changes. Everything else is a normal fetch — a websocket that becomes the API is a
// websocket that has to reimplement caching, retries and status codes.

export const socket = io({ path: '/socket.io', autoConnect: true, transports: ['websocket', 'polling'] })

export function onChat(fn) {
  socket.on('chat', fn)
  return () => socket.off('chat', fn)
}

export function onPresence(fn) {
  socket.on('presence', fn)
  return () => socket.off('presence', fn)
}
