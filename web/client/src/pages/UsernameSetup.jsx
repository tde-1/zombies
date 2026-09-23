import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import EnwWord from '../components/Enw'

// ── The name gate ───────────────────────────────────────────────────────────────────────
//
// A port of ENW Movement's `movement-client/src/pages/UsernameSetup.jsx`, mechanism, rules
// and words (B, 2026-09-22: "if they don't have an ENW username, they should be able to
// assert one using the design conventions set by drops.ws and ENW Movement"). The instant
// you sign in, this takes the page over until you have a name; signed OUT nothing changes.
// App.jsx renders it ahead of everything else, the approval wall included, so choosing a
// name is the first thing that happens — exactly Movement's order.
//
// What differs, and why:
//
//  * It sits UNDER the nav rather than replacing the whole window. In the launcher the nav IS
//    the title bar (window controls, the drag region), and a screen with no way to move or
//    close the window is not a screen.
//  * The name cannot be claimed on drops.ws from here — Zombies does not hold the shared
//    secret (docs/kickstart/questions.md Q-id-1) — so the server checks it against the same
//    rules and the same blocklist drops.ws uses (server/lib/names.js), and the line under the
//    heading asks for the SAME name rather than claiming it is shared.
//  * The one addition: when this Steam account already has a name on ENW Movement, it is
//    offered (GET /api/me/username/suggest, read from movement.enw.gg's public profile).
//    Offered, not adopted — Movement's public profile cannot say whether that name is the
//    shared ENW one or a Steam persona.

const MIN = 3
const MAX = 20
const SHAPE = /^[a-zA-Z0-9_-]+$/
// A number is an ADDRESS on the ENW sites — movement.enw.gg/5 is the player holding movement
// UID #5 — so a name made only of digits is not one you can have (Movement, owner 2026-08-06).
const ALL_DIGITS = /^\d+$/

// Said as a fact, once — the field itself enforces the rest. (Movement's words.)
const RULES = '3 to 20 characters. Letters, numbers, underscores and hyphens.'

// Movement's verdict lines, verbatim (UsernameSetup.jsx MESSAGE).
const MESSAGE = {
  taken: 'Taken.',
  reserved: 'Reserved by another player right now.',
  blocked: 'Not available.',
  short: `At least ${MIN} characters.`,
  long: `At most ${MAX} characters.`,
  chars: 'Letters, numbers, underscores and hyphens only.',
  digits: 'Names cannot be only numbers.',
  invalid: 'Not a valid name.',
  unavailable: "Couldn't check that right now.",
}

function shapeReason (v) {
  if (v.length < MIN) return 'short'
  if (v.length > MAX) return 'long'
  if (!SHAPE.test(v)) return 'chars'
  if (ALL_DIGITS.test(v)) return 'digits'
  return null
}

export default function UsernameSetup ({ me, onDone }) {
  const [name, setName] = useState('')
  const [state, setState] = useState({ kind: 'idle' }) // idle | checking | ok | bad
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [suggest, setSuggest] = useState(null) // { name, available, reason } from Movement
  const touched = useRef(false)

  // Guards a slow check landing after a newer keystroke and overwriting its verdict.
  const seq = useRef(0)

  const trimmed = name.trim()
  // Movement's client checks length and characters here and leaves "only numbers" to the
  // verdict line; the same, so the button's enabled state matches theirs.
  const shapeOk = trimmed.length >= MIN && trimmed.length <= MAX && SHAPE.test(trimmed)

  // The Movement name, once. It pre-fills the field only if the player has not started
  // typing, and only if it would pass here — a prefill the claim then refuses is worse
  // than an empty field.
  useEffect(() => {
    let live = true
    api.get('/api/me/username/suggest').then((r) => {
      if (!live || !r || !r.name) return
      setSuggest(r)
      if (r.available && !touched.current) setName(r.name)
    }).catch(() => {})
    return () => { live = false }
  }, [])

  useEffect(() => {
    setError(null)
    if (!trimmed) return setState({ kind: 'idle' })
    if (!shapeOk) return setState({ kind: 'bad', reason: shapeReason(trimmed) || 'invalid' })
    if (ALL_DIGITS.test(trimmed)) return setState({ kind: 'bad', reason: 'digits' })

    const mine = ++seq.current
    setState({ kind: 'checking' })
    const t = setTimeout(async () => {
      try {
        const r = await api.get('/api/me/username/check?username=' + encodeURIComponent(trimmed))
        if (seq.current !== mine) return
        setState(r && r.available ? { kind: 'ok' } : { kind: 'bad', reason: (r && r.reason) || 'taken' })
      } catch {
        if (seq.current !== mine) return
        setState({ kind: 'bad', reason: 'unavailable' })
      }
    }, 350)
    return () => clearTimeout(t)
  }, [trimmed, shapeOk])

  const save = async () => {
    if (busy || !shapeOk) return
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/me/username', { username: trimmed })
      onDone()
    } catch (e) {
      // The server's sentence, as Movement shows it (drops.ws wording: "That username is
      // already taken", "Usernames cannot be only numbers", …).
      setError(e.message)
      setBusy(false)
    }
  }

  const signOut = () => api.post('/auth/logout').finally(() => { window.location.href = '/' })

  // The verdict line. Never a bare tick or cross — the word is the answer (Movement).
  const verdict =
    state.kind === 'checking' ? <span className="muted small">Checking…</span>
      : state.kind === 'ok' ? <span className="small" style={{ color: 'var(--good)' }}>Available.</span>
        : state.kind === 'bad' ? <span className="small" style={{ color: 'var(--bad)' }}>{MESSAGE[state.reason] || MESSAGE.taken}</span>
          : null

  return (
    <div className="page" style={{ maxWidth: 520, margin: '0 auto', padding: '48px 16px' }}>
      <div className="card name-gate" style={{ textAlign: 'left', padding: 28 }}>
        <h2 style={{ textAlign: 'center', margin: 0 }}>Choose your name</h2>
        <p className="muted" style={{ textAlign: 'center', marginTop: 6 }}>
          Your <EnwWord /> username, the same as on <EnwWord /> Movement.
        </p>

        {suggest && suggest.name ? (
          <p className="small" style={{ marginTop: 14, marginBottom: 0 }}>
            On <EnwWord /> Movement you are <b>{suggest.name}</b>.{' '}
            {suggest.available
              ? (trimmed === suggest.name ? null
                  : <button type="button" className="btn small ghost" onClick={() => { touched.current = true; setName(suggest.name) }}>Use it</button>)
              : <span style={{ color: 'var(--bad)' }}>{MESSAGE[suggest.reason] || MESSAGE.taken}</span>}
          </p>
        ) : null}

        <input
          type="text"
          style={{ marginTop: 14, width: '100%' }}
          value={name}
          maxLength={MAX}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          placeholder="Your name"
          aria-label="Your ENW username"
          onChange={(e) => { touched.current = true; setName(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && state.kind === 'ok') save() }}
        />

        <div className="muted small" style={{ marginTop: 8 }}>{RULES}</div>
        <div style={{ minHeight: 20, marginTop: 4 }}>{verdict}</div>

        {error ? <p className="small" style={{ color: 'var(--bad)', marginTop: 4 }}>{error}</p> : null}

        <button
          type="button"
          className="btn primary"
          style={{ width: '100%', marginTop: 14 }}
          disabled={busy || !shapeOk || state.kind === 'checking'}
          onClick={save}
        >
          {busy ? 'Saving…' : 'Continue'}
        </button>

        <p className="muted small" style={{ marginTop: 16, textAlign: 'center' }}>
          Signed in as {(me && me.steam_id) || 'your Steam account'}
          {' · '}
          <button type="button" className="btn small ghost" style={{ padding: '2px 6px' }} onClick={signOut}>Sign out</button>
        </p>
      </div>
    </div>
  )
}
