import { useState } from 'react'
import { api } from '../../api'
import { useSession } from '../../session'
import { OMITTED } from '../../data/wawSettings'
import { bridge, useLauncherStatus, describeLauncher } from '../launcherBridge'
import { LauncherUpdateBox, InstalledMapsBox } from '../LauncherBoxes'
import EnwWord from '../Enw'

// /settings -> ENW. Its own file on purpose: this tab is where the launcher's own things
// live (the client, its version, and - next - the installed maps and the Update button),
// not World at War's settings. Every WaW / launch setting is on the other tabs.
//
// Drawn in the same little-sections shape as the rest of the page (Gaff's `ss-section`
// headings, one short row each).

export default function EnwSection({ onStatus }) {
  const enw = bridge()
  const inLauncher = !!enw
  const openScreen = (name) => { try { enw.openScreen(name) } catch { /* older launcher */ } }
  const launcher = describeLauncher(useLauncherStatus())
  const { session, refresh } = useSession()
  const saved = session && session.user && session.user.settings
  // `pause_on_chat` is an account setting, not part of the `game` blob: the in-game overlay
  // reads it from /api/game-chat/me (web/server/lib/gameChat.js), default on.
  const [pauseOnChat, setPauseOnChat] = useState(() => !(saved && saved.pause_on_chat === false))
  const setPause = async (on) => {
    setPauseOnChat(on)
    onStatus && onStatus('saving…')
    try {
      await api.put('/api/me/settings', { pause_on_chat: on })
      onStatus && onStatus('saved')
      refresh()
    } catch (e) {
      setPauseOnChat(!on)
      onStatus && onStatus(`not saved: ${e.message}`)
    }
  }

  return (
    <>
      <div className="set-group">
        <div className="set-section"><span>launcher</span></div>
        {inLauncher && launcher ? (
          <>
            <div className="set-item"><div className="set-row"><span className="set-label">client</span><span className="set-value">{launcher.installed ? 'installed' : 'not installed'}</span></div></div>
            {launcher.version && <div className="set-item"><div className="set-row"><span className="set-label">version</span><span className="set-value">{launcher.version}</span></div></div>}
            {/* ~~an `update` line here~~ — the "update" section below (LauncherBoxes) says it, with the button. */}
            {/* Moved here from the account menu (B 2026-09-24): the launcher's own screen
                (folders, logs, remove the client) and, when missing, the client install. */}
            <div className="set-item"><div className="set-row">
              {!launcher.installed && <button type="button" className="btn small" onClick={() => openScreen('firstRun')}>Install the <EnwWord /> client</button>}
              <button type="button" className="btn small" onClick={() => openScreen('settings')}>Folders, logs, uninstall</button>
            </div></div>
          </>
        ) : (
          <div className="set-hint">open in the <EnwWord /> launcher to see the client</div>
        )}
      </div>

      <div className="set-group">
        <div className="set-section"><span>chat</span></div>
        <div className="set-item" title="pause_on_chat">
          <label className="set-check">
            <input type="checkbox" checked={pauseOnChat} onChange={(e) => setPause(e.target.checked)} />
            <span>pause game while chatting (solo)</span>
          </label>
        </div>
      </div>

      {/* ── SLOT: branch `updates-downloads` ─────────────────────────────────────────
          "Installed maps" and the Update button go here, as their own <div className="set-group">
          blocks (heading: <div className="set-section"><span>maps</span></div>). Nothing else
          on /settings depends on what is in this slot. */}
      {/* Filled by `updates-downloads` (launcher 0.2.12): both draw nothing outside the
          launcher, where there is nothing to update and no map folder. */}
      <LauncherUpdateBox />
      <InstalledMapsBox />
      {/* ── end SLOT ──────────────────────────────────────────────────────────────── */}

      <div className="set-group">
        <div className="set-section"><span>how settings apply</span></div>
        <div className="set-hint set-hint-block">saved to your account, applied at next launch. in-game changes sync back when you quit.</div>
        <details className="set-omitted">
          <summary>in the game's menus, not here</summary>
          <ul>{OMITTED.map((o) => <li key={o.label}><b>{o.label}</b>: {o.why}</li>)}</ul>
        </details>
      </div>
    </>
  )
}
