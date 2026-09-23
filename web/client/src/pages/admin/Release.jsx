import { useState } from 'react'
import { api } from '../../api'
import { Panel, Empty, when, stamp, useLoad, useAct } from './kit'

// Release: what players get. The launcher feed as electron-updater reads it, and the game
// DLL per box. The site is never sent the DLL's sha256: the referee hears a build stamp and
// the game exe's sha256 at `hello`, and those are shown as heard. The sha you deployed can be
// written down here (next-session.md "Deploy a box DLL") so it lives with the box.
export default function Release() {
  const r = useLoad(() => api.get('/api/admin/release'), [])
  if (!r.data) return <Panel title="Release"><Empty>{r.err || 'Loading…'}</Empty></Panel>
  const f = r.data.feed
  return (
    <>
      <Panel title="Launcher feed" sub="/updates/latest.yml" right={<a className="btn small ghost" href="/updates/latest.yml" target="_blank" rel="noreferrer">Open</a>}>
        {!f.published ? <Empty>No latest.yml published.</Empty> : (
          <dl className="adm-dl">
            <dt>Version</dt><dd><b className="adm-big">{f.version}</b></dd>
            <dt>Released</dt><dd>{f.release_date ? `${stamp(Date.parse(f.release_date))} · ${when(Date.parse(f.release_date))}` : '—'}</dd>
            <dt>Installer</dt><dd className="mono">{f.installer}{f.size ? ` · ${(f.size / 1048576).toFixed(1)} MiB` : ''}</dd>
            <dt>On this server</dt><dd>{f.on_disk ? (f.on_disk.matches ? <span className="tag good">present, size matches</span> : <span className="tag hot">size differs from latest.yml</span>) : <span className="tag hot">missing</span>}</dd>
            <dt>Bucket</dt><dd>{f.bucket ? <span className="mono">{f.bucket}</span> : <span className="faint">not configured, served from here</span>}</dd>
            <dt>sha512</dt><dd className="mono adm-wrap">{f.sha512}</dd>
            <dt>Earlier</dt><dd className="faint">{f.recent.filter((v) => v !== f.version).slice(0, 6).join(' · ') || '—'}</dd>
          </dl>
        )}
      </Panel>
      <Panel title="Game DLL on each box">
        {r.data.boxes.length === 0 ? <Empty>No boxes.</Empty> : r.data.boxes.map((b) => <BoxDll key={b.name} b={b} onDone={r.reload} />)}
      </Panel>
    </>
  )
}

function BoxDll({ b, onDone }) {
  const [sha, setSha] = useState('')
  const [commit, setCommit] = useState('')
  const act = useAct()
  const save = async () => { if (await act(() => api.post(`/api/admin/release/box/${encodeURIComponent(b.name)}`, { sha256: sha.trim(), commit: commit.trim() || null }), 'Noted')) { setSha(''); setCommit(''); onDone() } }
  return (
    <div className="adm-card">
      <h3 className="adm-h3">{b.name}</h3>
      <dl className="adm-dl">
        <dt>Deployed (noted)</dt><dd>{b.noted ? <><b className="mono">{b.noted.sha256.slice(0, 12)}</b>{b.noted.commit ? <span className="faint"> · commit {b.noted.commit}</span> : ''}<span className="faint"> · {when(b.noted.at)}</span></> : <span className="faint">not noted</span>}</dd>
        <dt>Reported by the agent</dt><dd>{b.reported ? <b className="mono">{b.reported}</b> : <span className="faint">the agent does not send it</span>}</dd>
        <dt>Heard in the last game</dt><dd>{b.heard ? <><span className="mono">{b.heard.dll_build || 'no stamp'}</span><span className="faint"> · {b.heard.match_id} · {when(b.heard.at)}</span></> : <span className="faint">no games yet</span>}</dd>
        <dt>Game exe sha256</dt><dd className="mono adm-wrap">{(b.heard && b.heard.exe_sha256) || '—'}</dd>
      </dl>
      <div className="adm-form">
        <label className="grow">Note a deploy: DLL sha256<input type="text" value={sha} placeholder="6b1ccfc5…" onChange={(e) => setSha(e.target.value)} /></label>
        <label>Source commit<input type="text" value={commit} placeholder="fd29f8f" onChange={(e) => setCommit(e.target.value)} /></label>
        <button type="button" className="btn small" disabled={!sha.trim()} onClick={save}>Note</button>
      </div>
    </div>
  )
}
