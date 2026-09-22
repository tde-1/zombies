import { useEffect, useRef, useState } from 'react'
import { api, SIGN_IN } from '../api'
import { bySeq, mergeComment, mergeServerList, rowKey } from '../comments'

// Profile comment wall — the bottom of a player's profile.
//
// COPIED FROM MOVEMENT, `movement-client/src/components/ProfileComments.jsx`, with its comments.
// Two things differ, both named here rather than hidden:
//   * there is no `profile:<steamid>` socket room on this site (map comments have none either),
//     so the wall is live by its 60 s poll and by the author's own optimistic post only;
//   * a failure is written under the composer instead of a toast — this site has no toast.
//
// Steam's shape, our conventions. From Steam: it sits at the FOOT of the profile at page width,
// oldest first with the newest at the bottom, every post carrying its own avatar and full
// timestamp, and the composer underneath the wall rather than above it. It's a guestbook you
// scroll to, not a chat log you watch — so unlike MapComments there is no fixed-height scroll
// box, no consecutive-post grouping, and no auto-scroll: the page itself is the scroller, and
// yanking someone down the page when a comment lands would be hostile.
//
// From Movement's map threads, everything that made those correct:
//   * the SAME reconciliation module (../comments) — mergeComment() is the only way a row
//     enters the list, which is what makes a double insert impossible when the optimistic copy
//     and the poll both carry the same comment;
//   * removedRef, so a delete can't be undone by a poll already in flight;
//   * optimistic posting — the comment is on screen and the box is empty before the request
//     leaves, and the draft comes back on failure instead of being lost.
//
// Server: GET/POST /api/players/:id/comments, DELETE /api/players/:id/comments/:cid
// (server/routes/players.js). Your own post, or anybody's if you are staff.

const POLL_MS = 60000
const BODY_MAX = 600
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const p2 = (n) => (n < 10 ? '0' + n : String(n))
const stamp = (ms) => {
  const d = new Date(ms)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
const initials = (n) => String(n || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?'
const base = (id) => `/api/players/${encodeURIComponent(id)}/comments`

export default function ProfileComments({ profileId, me, ownerName }) {
  const [state, setState] = useState({ status: 'loading', comments: [] })
  // The owner's comment privacy, decided by the server. `block` is the reason a signed-in
  // viewer can't post (friends-only, or the wall is closed) — null when they can.
  const [block, setBlock] = useState(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const taRef = useRef(null)
  const removedRef = useRef(new Set())
  const tmpRef = useRef(0)

  const grow = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(160, Math.max(56, ta.scrollHeight)) + 'px'
  }
  const refocus = () => { const ta = taRef.current; if (ta) ta.focus() }

  // Load + poll. A different profile resets the wall outright so a stale one never flashes.
  useEffect(() => {
    if (!profileId) return undefined
    let cancelled = false
    removedRef.current = new Set()
    setBlock(null)
    setState({ status: 'loading', comments: [] })
    const load = () => api.get(base(profileId))
      .then((d) => {
        if (cancelled) return
        const rows = (d && d.comments) || []
        setBlock((d && d.post_block) || null)
        setState((s) => ({ status: 'ok', comments: mergeServerList(s.comments, rows, removedRef.current) }))
      })
      .catch(() => { if (!cancelled) setState((s) => (s.status === 'ok' ? s : { status: 'offline', comments: [] })) })
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [profileId, me && me.steam_id])

  const post = () => {
    const body = text.trim()
    if (!body || busy || !me) return
    const tmp = ++tmpRef.current
    const optimistic = {
      id: null,
      tmp,
      pending: true,
      steam_id: me.steam_id,
      username: me.name || 'You',
      avatar: me.avatar || null,
      body,
      created_at: Date.now(),
      mine: true,
      can_remove: false, // nothing to remove until the server gives it an id
    }
    setBusy(true)
    setErr(null)
    setText('')
    setState((s) => ({ status: 'ok', comments: [...s.comments, optimistic].sort(bySeq) }))
    requestAnimationFrame(() => { grow(); refocus() })

    api.post(base(profileId), { body })
      .then((d) => {
        setState((s) => (d && d.comment
          ? { status: 'ok', comments: mergeComment(s.comments, d.comment, removedRef.current) }
          : { ...s, comments: s.comments.filter((x) => !(x.pending && x.tmp === tmp)) }))
      })
      .catch((e) => {
        // Hand the draft back rather than losing what they wrote.
        setState((s) => ({ ...s, comments: s.comments.filter((x) => !(x.pending && x.tmp === tmp)) }))
        setText((cur) => cur || body)
        requestAnimationFrame(() => { grow(); refocus() })
        setErr(e.message)
      })
      .finally(() => setBusy(false))
  }

  const remove = async (c) => {
    if (c.id == null || removedRef.current.has(c.id)) return
    removedRef.current.add(c.id)
    setState((s) => ({ ...s, comments: s.comments.filter((x) => x.id !== c.id) }))
    try {
      await api.del(`${base(profileId)}/${c.id}`)
    } catch (e) {
      // A 404 means it was already gone (staff got there first) — leave it deleted.
      if (e && e.status !== 404) {
        removedRef.current.delete(c.id)
        setState((s) => ({ status: 'ok', comments: mergeComment(s.comments, c, removedRef.current) }))
        setErr(e.message)
      }
    }
  }

  // Enter posts, Shift+Enter newlines — same as the map thread, so the muscle memory carries.
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post() }
  }

  const list = state.comments
  const mineProfile = !!(me && String(me.steam_id) === String(profileId))

  return (
    <section className="cmt cmt-wall">
      <div className="cmt-top">
        <div className="section-label" style={{ margin: 0 }}>
          Comments
          {state.status === 'ok' && list.length > 0 && (
            <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}> · {list.length}</span>
          )}
        </div>
      </div>

      <div className="cmt-wall-log">
        {state.status === 'loading' ? (
          <div className="row" style={{ padding: 12 }}><span className="spinner" /> <span className="muted small">loading…</span></div>
        ) : state.status === 'offline' ? (
          <div className="empty">Comments are offline.</div>
        ) : list.length === 0 ? (
          <div className="empty">
            {mineProfile ? 'Nobody has posted on your profile yet.' : `No comments for ${ownerName || 'this player'} yet.`}
          </div>
        ) : (
          // Every post gets its own header — a profile wall is read top to bottom over months,
          // so the grouping that keeps a live map thread compact would only hide who said what.
          list.map((c) => (
            <div className={'msg lead' + (c.pending ? ' pending' : '')} key={rowKey(c)}>
              {c.avatar
                ? <img className="msg-av" src={c.avatar} alt="" loading="lazy" />
                : <div className="msg-av msg-av-ph">{initials(c.username)}</div>}
              <div className="msg-main">
                <div className="msg-head">
                  <span className={'msg-name' + (c.mine ? ' me' : '')}>{c.username}</span>
                  <span className="msg-when">{stamp(c.created_at)}</span>
                </div>
                <div className="msg-body">{c.body}</div>
              </div>
              {c.can_remove && !c.pending && (
                <button
                  className="msg-del"
                  type="button"
                  title={c.mine ? 'Delete your comment' : 'Delete this comment'}
                  aria-label={`Delete comment by ${c.username}`}
                  onClick={() => remove(c)}
                >×</button>
              )}
            </div>
          ))
        )}
      </div>

      {me && block ? (
        <div className="cmt-bar cmt-signin">
          <span className="muted small">{block[0].toUpperCase() + block.slice(1)}.</span>
        </div>
      ) : me ? (
        <form className="cmt-wall-bar" onSubmit={(e) => { e.preventDefault(); post() }}>
          <textarea
            ref={taRef}
            value={text}
            maxLength={BODY_MAX}
            rows={2}
            placeholder={mineProfile ? 'Post on your own profile…' : `Leave a comment for ${ownerName || 'this player'}…`}
            onChange={(e) => { setText(e.target.value); grow() }}
            onKeyDown={onKeyDown}
          />
          <div className="cmt-wall-actions">
            <span className="faint small">{err ? <span className="hot">{err}</span> : `${text.length}/${BODY_MAX}`}</span>
            <button className="btn btn-sm btn-accent" type="submit" disabled={busy || !text.trim()}>Post comment</button>
          </div>
        </form>
      ) : (
        <div className="cmt-bar cmt-signin">
          <a className="btn btn-sm btn-accent btn-block" href={SIGN_IN}>Sign in to comment</a>
        </div>
      )}
    </section>
  )
}
