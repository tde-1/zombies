import { useState } from 'react'
import { api, ago } from '../api'
import { useSession } from '../session'
import { PlayerLink } from './Bits'

// Map comments and profile comments, "the same as Movement" (13 §3b). One component,
// because they are the same object with a different subject — the only difference is the
// endpoint and whether the profile owner allows it, and the server decides that.

export default function Comments({ kind, subject, initial = [], onChange, canComment = true }) {
  const { signedIn, isMod, me } = useSession()
  const [list, setList] = useState(initial)
  const [body, setBody] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const base = kind === 'map' ? `/api/maps/${encodeURIComponent(subject)}/comments` : `/api/players/${encodeURIComponent(subject)}/comments`

  const post = async (e) => {
    e.preventDefault()
    const t = body.trim()
    if (!t) return
    setBusy(true); setErr(null)
    try {
      await api.post(base, { body: t })
      setBody('')
      if (onChange) onChange()
      else setList([{ id: Math.random(), body: t, at: Date.now(), author: me }, ...list])
    } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  const remove = async (id) => {
    try { await api.del(`/api/comments/${id}`); setList(list.filter((c) => c.id !== id)); if (onChange) onChange() } catch (e) { setErr(e.message) }
  }

  const report = async (id) => {
    try { await api.post('/api/report', { kind: 'comment', subject: String(id) }); setErr('Reported.') } catch (e) { setErr(e.message) }
  }

  return (
    <div className="card">
      {signedIn && canComment && (
        <form onSubmit={post} style={{ marginBottom: 12 }}>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={1200} placeholder="Say something" />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn small" type="submit" disabled={busy || !body.trim()}>Post</button>
            {err && <span className="tiny hot">{err}</span>}
          </div>
        </form>
      )}
      {!signedIn && <p className="tiny">Sign in to comment.</p>}
      {list.length === 0 ? <p className="empty">No comments yet.</p> : list.map((c) => (
        <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
          <div className="row" style={{ gap: 8 }}>
            <PlayerLink user={c.author} />
            <span className="tiny">{ago(c.at)}</span>
            <span style={{ flex: 1 }} />
            {signedIn && c.author && me && (c.author.steam_id === me.steam_id || isMod) && (
              <button className="btn small ghost" onClick={() => remove(c.id)}>Remove</button>
            )}
            {signedIn && c.author && me && c.author.steam_id !== me.steam_id && (
              <button className="btn small ghost" onClick={() => report(c.id)}>Report</button>
            )}
          </div>
          <div style={{ marginTop: 3 }}>{c.removed ? <span className="tiny">Removed by a moderator.</span> : c.body}</div>
        </div>
      ))}
    </div>
  )
}
