import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { Lockup } from '../components/Bits'
import { deepLink } from '../components/playGate'
import { prettyTitle } from '../data/mapText'

// The install page, and — since 2026-09-22 — the place every Play button in a plain browser
// lands. Behind the beta gate like every other page on the site; the installer itself is not
// (`middleware/gate.js` exempts `/updates`, because electron-updater cannot answer a password
// prompt and a silently dead updater is much the worse failure).
//
// THE VERSION IS READ, NOT WRITTEN. `/updates/latest.yml` is the feed the launcher lane
// publishes and it already names the current installer and its size. Hard-coding `0.2.0`
// here would mean this page and the auto-updater could disagree the moment they ship 0.2.1 —
// and the page would be the one that was wrong, pointing at a file that may no longer exist.
//
// ── The context, and why it is on the URL ────────────────────────────────────────────────
// `?map=`, `?party=`, `?then=` and `?label=` are written by `components/playGate.js` when it
// turns somebody away from a Play button. They exist so this page can say *"install the
// launcher to play Clinic of Evil"* — the sentence a person who just pressed Play is owed —
// and so the "Open in launcher" button has something to open.
//
// ── Open in launcher first, download second ──────────────────────────────────────────────
// Somebody who already has the launcher does not need an installer, they need the app to
// come forward. There is no way to ASK a browser whether a protocol is registered, so this
// is the usual timeout trick and it is honest about what it is: navigating to the scheme
// either hands the page to the OS (and the browser stops running our timer, or at least
// blurs) or does nothing at all. If nothing has happened after a beat, the download is
// offered as what it always was rather than as a failure.
//
// The fallback is a REVEAL, not an automatic redirect. A page that navigated somewhere on a
// timer would fight the OS's own "open this application?" prompt, which is exactly the
// moment the timer expires.

const FEED = '/updates/latest.yml'
const HANDOFF_MS = 1600

// `then` comes off the URL, so it is treated as hostile: a site-relative path and nothing
// else. `//evil.example` is a protocol-relative URL that a naive "starts with /" check lets
// straight through, which is how an open redirect is usually built.
const safePath = (p) => (typeof p === 'string' && /^\/[^/\\]/.test(p) ? p : null)

export default function Download() {
  const [sp] = useSearchParams()
  const [rel, setRel] = useState(null)
  const [failed, setFailed] = useState(false)
  const [map, setMap] = useState(null)
  const [tried, setTried] = useState(false)
  const timer = useRef(null)

  const mapKey = sp.get('map') || null
  const partyId = sp.get('party') || null
  const then = safePath(sp.get('then'))
  const label = sp.get('label') || null

  useEffect(() => {
    fetch(FEED, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        // Three fields out of a small, known YAML file rather than a parser dependency for a
        // page with one link on it. Leading whitespace is allowed on purpose: `size` only
        // ever appears indented, under `files:`.
        const one = (k) => { const m = text.match(new RegExp(`^\\s*${k}:\\s*'?([^'\\n\\r]+)'?`, 'm')); return m ? m[1].trim() : null }
        const path = one('path')
        if (!path) throw new Error('no path in the feed')
        setRel({ path, version: one('version'), size: Number(one('size')) || null })
      })
      .catch(() => setFailed(true))
  }, [])

  // The map's real name, for the sentence. It is fetched rather than passed on the URL
  // because a title in a query string is a title somebody can rewrite, and this one is
  // printed as fact.
  useEffect(() => {
    if (!mapKey) return undefined
    let off = false
    api.get(`/api/maps/${encodeURIComponent(mapKey)}`)
      .then((d) => { if (!off && d && d.map) setMap(d.map) })
      .catch(() => { /* an unknown key just means the generic sentence */ })
    return () => { off = true }
  }, [mapKey])

  useEffect(() => () => clearTimeout(timer.current), [])

  const openInLauncher = () => {
    setTried(true)
    clearTimeout(timer.current)
    // The reveal is on a timer only so the install block does not appear *before* the OS has
    // had a chance to answer. Nothing navigates.
    timer.current = setTimeout(() => setTried('timeout'), HANDOFF_MS)
    window.location.href = deepLink({ map: mapKey, party: partyId })
  }

  const what = label || (map ? prettyTitle(map.title, map.key) : null)
  const heading = what
    ? `Install the launcher to play ${what}`
    : partyId ? 'Install the launcher to join that party' : 'Install the ENW Zombies launcher'

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="card" style={{ textAlign: 'center', padding: '30px 24px' }}>
        <Lockup h={46} />
        <h1 style={{ margin: '16px 0 6px' }}>{heading}</h1>
        <p className="sub" style={{ margin: '0 0 20px' }}>
          Windows · needs World at War
        </p>

        {/* Already have it? Then the installer is the wrong offer, and it is second. */}
        {(mapKey || partyId) && (
          <div style={{ marginBottom: 18 }}>
            <button className="btn primary big" onClick={openInLauncher}>Open in launcher</button>
            <p className="tiny" style={{ margin: '8px 0 0' }}>
              {tried === 'timeout' ? 'Nothing opened? Install it below.' : tried ? 'Opening…' : null}
            </p>
          </div>
        )}

        {rel ? (
          <>
            <a className={`btn big ${mapKey || partyId ? 'ghost' : 'primary'}`} href={`/updates/${rel.path}`}>
              Download{rel.version ? ` ${rel.version}` : ''}
            </a>
            <p className="tiny" style={{ margin: '10px 0 0' }}>
              {rel.path}{rel.size ? ` · ${(rel.size / 1048576).toFixed(0)} MB` : ''}
            </p>
          </>
        ) : failed ? (
          // Said plainly rather than shown as a dead button. The feed being unreachable is
          // the same thing that stops everybody's launcher updating, so it is worth naming.
          <p className="sub" style={{ margin: 0 }}>
            No build yet. <a href="/updates/">Check the feed</a>
          </p>
        ) : (
          <p className="sub" style={{ margin: 0 }}>Loading…</p>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <ol className="steps">
          <li>
            <b>Run the installer.</b> SmartScreen: More info, then Run anyway.
          </li>
          <li>
            <b>Sign in with Steam.</b>
          </li>
          <li>
            <b>Pick a map and press Play.</b> Your Steam install is never changed.
          </li>
        </ol>
      </div>

      {(then || mapKey) && (
        <p className="tiny" style={{ textAlign: 'center', marginTop: 14 }}>
          <Link to={then || `/m/${mapKey}`}>← Back to {what || 'the map'}</Link>
        </p>
      )}

      <p className="tiny" style={{ textAlign: 'center', marginTop: 10 }}>
        Closed beta. Playing needs approval.
      </p>
    </div>
  )
}
