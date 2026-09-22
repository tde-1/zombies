import { useEffect, useState } from 'react'
import { Lockup } from '../components/Bits'

// The install page. Behind the beta gate like every other page on the site — the installer
// itself is not (`middleware/gate.js` exempts `/updates`, because electron-updater cannot
// answer a password prompt and a silently dead updater is much the worse failure). So this
// page is for the four people who have the password, and the bytes it points at would be
// reachable by anyone who guessed the filename. That is the existing, deliberate split; an
// installer is not a secret.
//
// THE VERSION IS READ, NOT WRITTEN. `/updates/latest.yml` is the feed the launcher lane
// publishes, and it already names the current installer and its size. Hard-coding
// `0.2.0` here would mean this page and the auto-updater could disagree the moment they
// ship 0.2.1 — and the page would be the one that was wrong, pointing at a file that may no
// longer exist. Reading the feed makes a new release show up here with no deploy at all.

const FEED = '/updates/latest.yml'

export default function Download() {
  const [rel, setRel] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    fetch(FEED, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        // Three fields out of a small, known YAML file rather than a parser dependency for
        // a page with one link on it. `path` is the file; `version` and `size` are what
        // the page says about it.
        // Leading whitespace is allowed on purpose: `size` only ever appears indented,
        // under `files:`. Anchored hard to the line start it matched nothing, and the page
        // quietly dropped the megabytes off a 90 MB download.
        const one = (k) => { const m = text.match(new RegExp(`^\\s*${k}:\\s*'?([^'\\n\\r]+)'?`, 'm')); return m ? m[1].trim() : null }
        const path = one('path')
        if (!path) throw new Error('no path in the feed')
        setRel({ path, version: one('version'), size: Number(one('size')) || null })
      })
      .catch(() => setFailed(true))
  }, [])

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="card" style={{ textAlign: 'center', padding: '30px 24px' }}>
        <Lockup h={46} />
        <h1 style={{ margin: '16px 0 6px' }}>Install the ENW Zombies launcher</h1>
        <p className="sub" style={{ margin: '0 0 20px' }}>
          Windows. You need World at War already installed.
        </p>

        {rel ? (
          <>
            <a className="btn primary big" href={`/updates/${rel.path}`}>
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
            No build is published right now. <a href="/updates/">Check the feed</a>, or ask B.
          </p>
        ) : (
          <p className="sub" style={{ margin: 0 }}>Looking for the latest build…</p>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <ol className="steps">
          <li>
            <b>Run the installer.</b> Windows SmartScreen will warn you — it is unsigned.
            More info, then Run anyway.
          </li>
          <li>
            <b>Sign in with Steam.</b> The launcher opens your browser, Steam sends you back,
            and you are signed in on the site too.
          </li>
          <li>
            <b>It finds World at War and installs the ENW client.</b> Your Steam copy is never
            written to — the launcher makes its own copy and patches that. Then pick a map and
            press Play; it downloads the map and launches the game for you.
          </li>
        </ol>
      </div>

      <p className="tiny" style={{ textAlign: 'center', marginTop: 14 }}>
        This is a closed beta. Things will break, and your account has to be approved before
        you can play — browsing does not need it.
      </p>
    </div>
  )
}
