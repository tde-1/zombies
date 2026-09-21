import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSession } from '../session'
import { Section, Empty, Loading, Untracked } from '../components/Bits'

// Custom games: the eight knob groups (13 §4c) and the presets.
//
// B's principle, and the reason this page exists at all: **the common knobs are toggles in
// the UI, so nobody needs the console.** "I'm trying to avoid people using the console as
// much as possible." The host still gets the full dev console as an escape hatch, because
// Custom is untracked anyway.
//
// The ranges are the server's (`routes/site.js` KNOB_GROUPS), not the client's. Defaults are
// World at War's stock values and the caps are wide but real, so a knob cannot be pushed
// somewhere the game will not go by editing the page.
//
// The four LOCKED presets are the Verified challenge brackets — No Power, No Perks, No Jug,
// First Room. They are not free-form knobs: each has its own board and its own badge, and
// they are the only custom-ish thing that counts.

export default function Custom() {
  const { signedIn, party, refresh } = useSession()
  const [d, setD] = useState(null)
  const [knobs, setKnobs] = useState({})
  const [msg, setMsg] = useState(null)
  const [code, setCode] = useState('')

  useEffect(() => { api.get('/api/presets').then(setD).catch(() => {}) }, [])
  useEffect(() => { if (party && party.settings) setKnobs(party.settings) }, [party])

  if (!d) return <div className="page"><Loading /></div>

  const set = (g, k, v) => setKnobs((s) => ({ ...s, [g]: { ...(s[g] || {}), [k]: v } }))
  const val = (g, k, dflt) => {
    const v = knobs[g] && knobs[g][k]
    return v === undefined || v === null ? dflt : v
  }

  const apply = async () => {
    setMsg(null)
    try { await api.post('/api/party/settings', { settings: knobs }); refresh(); setMsg('Applied to your party.') } catch (e) { setMsg(e.message) }
  }

  const save = async () => {
    const name = window.prompt('Name this preset')
    if (!name) return
    try { const r = await api.post('/api/presets', { name, knobs }); setMsg(`Saved. Share code: ${r.code}`) } catch (e) { setMsg(e.message) }
  }

  const load = async () => {
    try { const r = await api.get(`/api/presets/${encodeURIComponent(code.trim().toUpperCase())}`); setKnobs(r.preset.knobs); setMsg(`Loaded "${r.preset.name}".`) } catch (e) { setMsg(e.message) }
  }

  const locked = d.presets.filter((p) => p.locked)
  const shared = d.presets.filter((p) => !p.locked)

  return (
    <div className="page wide">
      <Section title="Verified challenge presets" right={<span className="tag good">Counts</span>}>
        <div className="grid c4">
          {locked.map((p) => (
            <div className="card" key={p.id}>
              <h3>{p.name}</h3>
              <p className="tiny">{p.blurb}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Custom knobs" right={<span className="row" style={{ gap: 6 }}><Untracked /><span className="tiny">quarter XP</span></span>}>
        {!signedIn && <Empty>Sign in to set up a custom game.</Empty>}
        <div className="grid c2" style={{ alignItems: 'start' }}>
          {d.groups.map((g) => (
            <div className="card" key={g.key}>
              <div className="section-label" style={{ marginBottom: 8 }}>{g.label}</div>
              {g.knobs.map((k) => (
                <label className="field" key={k.key} style={{ marginBottom: 8 }}>
                  <span>{k.label}{k.min != null ? ` (${k.min}–${k.max})` : ''}</span>
                  {k.type === 'bool' ? (
                    <select value={String(val(g.key, k.key, k.default))} onChange={(e) => set(g.key, k.key, e.target.value === 'true')}>
                      <option value="false">Off</option><option value="true">On</option>
                    </select>
                  ) : k.type === 'enum' ? (
                    <select value={val(g.key, k.key, k.default) || ''} onChange={(e) => set(g.key, k.key, e.target.value || null)}>
                      <option value="">Stock</option>
                      {k.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : k.type === 'string' ? (
                    <input type="text" value={val(g.key, k.key, k.default) || ''} onChange={(e) => set(g.key, k.key, e.target.value || null)} />
                  ) : (
                    <input type="number" min={k.min} max={k.max} step={k.type === 'float' ? 0.1 : 1}
                      value={val(g.key, k.key, k.default)} onChange={(e) => set(g.key, k.key, Number(e.target.value))} />
                  )}
                </label>
              ))}
            </div>
          ))}
        </div>

        <div className="row wrap" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={apply} disabled={!party || party.mode !== 'custom'}>
            {party && party.mode === 'custom' ? 'Apply to my party' : 'Party must be Custom'}
          </button>
          <button className="btn" onClick={save} disabled={!signedIn}>Save as a preset</button>
          <input type="text" placeholder="Share code" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 160 }} />
          <button className="btn ghost" onClick={load} disabled={!code.trim()}>Load</button>
          {msg && <span className="tiny">{msg}</span>}
        </div>
      </Section>

      {shared.length > 0 && (
        <Section title="Shared presets">
          <div className="listing">
            <table className="data">
              <tbody>
                {shared.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.name}</b> <span className="tiny">{p.blurb}</span></td>
                    <td className="mono tiny">{p.code}</td>
                    <td><button className="btn small ghost" onClick={() => { setKnobs(p.knobs); setMsg(`Loaded "${p.name}".`) }}>Use</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  )
}
