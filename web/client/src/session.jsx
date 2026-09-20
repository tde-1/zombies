import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { socket } from './socket'

// Who is signed in, their party, their invites — one context above the router, refreshed on
// demand. Movement's session.jsx: the whole app asks `useSession()` and nothing else fetches
// /api/me.

const Ctx = createContext(null)

export function SessionProvider({ children }) {
  const [me, setMe] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try { setMe(await api.get('/api/me')) } catch { setMe({ signed_in: false }) } finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // A heartbeat keeps presence alive. 30 s against a 70 s window, so one dropped beat does
  // not make somebody vanish from their friends' rails.
  useEffect(() => {
    if (!me || !me.signed_in) return undefined
    const t = setInterval(() => socket.emit('heartbeat'), 30_000)
    socket.emit('heartbeat')
    return () => clearInterval(t)
  }, [me])

  const value = useMemo(() => ({
    me: me && me.signed_in ? me.user : null,
    session: me,
    standing: me && me.standing,
    party: me && me.party,
    loading,
    signedIn: !!(me && me.signed_in),
    isAdmin: !!(me && me.user && me.user.admin),
    isMod: !!(me && me.user && (me.user.mod || me.user.admin)),
    approved: !!(me && me.user && (me.user.approved || me.user.admin)),
    authMode: (me && me.auth) || 'mock',
    refresh,
  }), [me, loading, refresh])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useSession = () => useContext(Ctx)
