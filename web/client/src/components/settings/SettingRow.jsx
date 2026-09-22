import { shownValue, valueOf } from '../../data/wawSettings'
import { labelOf, HINTS, OPTION_WORDS } from '../../data/settingsLayout'

// One setting row, drawn the way Gaff's settings screen draws its rows
// (WatchGame/app/src/components/SettingsScreen.jsx):
//   on/off                -> a checkbox, then the label           (Gaff's `check-field`)
//   a few choices         -> label, then segmented buttons on the right (`ss-seg-row` + `seg-ctl`)
//   a long list           -> label, then a select                  (`ss-theme-row` + `theme-select`)
//   a number              -> label, slider, value on the right     (the volume rows)
//   a key                 -> label, then Key and Alt capture boxes (ours: Gaff has no binds)
// and a one-line hint under the row only when data/settingsLayout.js has one.
//
// An item whose game default is "the game picks" (`def: null`, written as `reset <dvar>`)
// gets an explicit `auto` choice instead of a checkbox, because a checkbox cannot say it.

const SEG_MAX = 6 // more choices than this and it is a select, as in Gaff

const word = (it, o) => {
  const w = OPTION_WORDS[it.id]
  if (w && w[String(o.value)] !== undefined) return w[String(o.value)]
  return String(o.label).toLowerCase()
}

function readout(it, v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (it.max <= 1) return `${Math.round(n * 100)}%`
  if (it.id === 'r_texFilterAnisoMin') return `${n}x`
  if (it.step < 1) return it.step < 0.1 ? n.toFixed(2) : n.toFixed(1)
  return String(n)
}

export default function SettingRow({ it, game, change, ctx }) {
  const v = shownValue(game, it)
  const title = [it.dvar || it.command || it.to.replace('key:', ''), it.src].filter(Boolean).join(' · ')
  const label = labelOf(it)
  let hint = HINTS[it.id] || null
  let disabled = false

  if (it.kind === 'bind') return <KeyRow it={it} game={game} label={label} title={title} ctx={ctx} />

  // Texture detail rows only apply with Texture Quality on Manual, as in the game.
  if (it.needsManual && String(ctx.picmipManual) !== '1') disabled = true
  if (it.kind === 'mode' && ctx.mode === 'borderless') { disabled = true; hint = 'borderless uses the monitor\'s own size' }

  const hintEl = hint ? <div className="set-hint">{hint}</div> : null

  // on / off
  if (it.kind === 'toggle' && it.def !== null) {
    const on = it.to === 'waw' ? String(v) === '1' : !!v
    return (
      <div className="set-item" title={title}>
        <label className="set-check">
          <input type="checkbox" checked={on}
                 onChange={(e) => change(it, it.to === 'waw' ? (e.target.checked ? '1' : '0') : e.target.checked)} />
          <span>{label}</span>
        </label>
        {hintEl}
      </div>
    )
  }

  // a number
  if (it.kind === 'slider') {
    const n = Number(v)
    return (
      <div className="set-item" title={title}>
        <div className="set-row">
          <span className="set-label">{label}</span>
          <input type="range" className="set-range" min={it.min} max={it.max} step={it.step}
                 value={Number.isFinite(n) ? n : it.min} aria-label={label}
                 onChange={(e) => change(it, it.to === 'waw' ? String(e.target.value) : Number(e.target.value))} />
          <span className="set-readout">{readout(it, v)}</span>
        </div>
        {hintEl}
      </div>
    )
  }

  // resolution and monitor: long lists
  if (it.kind === 'mode' || it.kind === 'monitor') {
    const opts = it.kind === 'mode'
      ? [{ value: '', label: disabled ? 'native' : 'monitor\'s own size' }, ...ctx.modes.map((m) => ({ value: m, label: m }))]
      : [{ value: 'primary', label: 'main display' }, ...ctx.displays.map((d) => ({ value: String(d.id), label: `${d.label} · ${d.width}x${d.height}${d.primary ? ' (main)' : ''}` }))]
    const cur = it.kind === 'mode' ? (disabled ? '' : String(v || '')) : String(v || 'primary')
    return (
      <div className="set-item" title={title}>
        <div className="set-row">
          <span className="set-label">{label}</span>
          <select className="set-select" value={cur} disabled={disabled} aria-label={label} onChange={(e) => change(it, e.target.value)}>
            {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {hintEl}
      </div>
    )
  }

  // choices: toggles with a game-picked default, and every select
  let opts = it.kind === 'toggle'
    ? [{ label: 'off', value: '0' }, { label: 'on', value: '1' }]
    : it.options
  if (it.def === null) opts = [{ label: 'auto', value: null }, ...opts]
  const same = (a, b) => (a === null || b === null ? a === b : String(a) === String(b))

  if (opts.length > SEG_MAX) {
    const idx = opts.findIndex((o) => same(o.value, v))
    return (
      <div className="set-item" title={title}>
        <div className="set-row">
          <span className="set-label">{label}</span>
          <select className="set-select" value={idx < 0 ? '' : String(idx)} aria-label={label}
                  onChange={(e) => change(it, opts[Number(e.target.value)].value)}>
            {idx < 0 && <option value="">{String(v)}</option>}
            {opts.map((o, i) => <option key={i} value={String(i)}>{word(it, o)}</option>)}
          </select>
        </div>
        {hintEl}
      </div>
    )
  }

  return (
    <div className={`set-item ${disabled ? 'is-off' : ''}`} title={title}>
      <div className="set-row set-seg-row">
        <span className="set-label">{label}</span>
        <div className="set-seg" role="group" aria-label={label}>
          {opts.map((o, i) => (
            <button key={i} type="button" disabled={disabled} aria-pressed={same(o.value, v)}
                    className={`set-seg-btn ${same(o.value, v) ? 'on' : ''}`} onClick={() => change(it, o.value)}>
              {word(it, o)}
            </button>
          ))}
        </div>
      </div>
      {hintEl}
    </div>
  )
}

function KeyRow({ it, game, label, title, ctx }) {
  const chosen = valueOf(game, it)
  const keys = (chosen !== undefined ? chosen : it.def) || []
  const { capture, setCapture } = ctx
  return (
    <div className="set-item" title={title}>
      <div className="set-row set-key-row">
        <span className="set-label">{label}</span>
        {[0, 1].map((slot) => {
          const on = capture && capture.command === it.command && capture.slot === slot
          return (
            <button key={slot} type="button" className={`set-key ${on ? 'capturing' : ''} ${keys[slot] ? '' : 'empty'}`}
                    onClick={(e) => { e.stopPropagation(); setCapture(on ? null : { command: it.command, slot }) }}
                    aria-label={`${label}, ${slot ? 'alternate' : 'key'}: ${keys[slot] || 'unbound'}`}>
              {on ? 'press a key' : (keys[slot] || '—')}
            </button>
          )
        })}
      </div>
    </div>
  )
}
