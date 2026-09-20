// The launcher chrome. Everything here talks to the main process through window.enw
// (see src/preload/preload.cjs) and to nothing else.
//
// Tone rule (vault 06): plain, dry, no selling, no hype. Functional words only —
// error states, empty states, and why a control is disabled.

const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }

const S = {
  status: null,
  map: null,
  mode: 'custom',
  boot: null,
  screen: null,
}

// The map list. Real, from the archive agent's normalised maps via window.enw.maps().
//
// THE BSP NAME IS NOT THE TITLE. `water` is "Alcatraz", `nazi_zombie_test` is "Project
// Viking". The player sees the title everywhere; the bsp is engine detail, shown small
// and only because it is what a map's folder and its old download are called.
let MAPS = []

// Stock maps ship with World at War, so they are always playable and never installed.
const STOCK = [
  { bsp: 'nazi_zombie_prototype', title: 'Nacht der Untoten', author: 'Treyarch', stock: true, installed: true, available: true, bytes: 0, fsGame: null },
  { bsp: 'nazi_zombie_asylum', title: 'Verrückt', author: 'Treyarch', stock: true, installed: true, available: true, bytes: 0, fsGame: null },
  { bsp: 'nazi_zombie_sumpf', title: 'Shi No Numa', author: 'Treyarch', stock: true, installed: true, available: true, bytes: 0, fsGame: null },
  { bsp: 'nazi_zombie_factory', title: 'Der Riese', author: 'Treyarch', stock: true, installed: true, available: true, bytes: 0, fsGame: null },
]

// ------------------------------------------------------------------- screens --

function show(name) {
  S.screen = name
  for (const id of ['firstRun', 'boot', 'settings', 'detail']) $(id).classList.toggle('on', id === name)
}
function hideAll() { show(null) }

function toast(text, kind = 'info') {
  const t = el('div', `toast ${kind === 'error' ? 'error' : ''}`, text)
  $('toasts').append(t)
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 450) }, 7000)
}

// ------------------------------------------------------------------ the rail --

const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`)

async function loadMaps() {
  let cat = { maps: [] }
  try { cat = await window.enw.maps() } catch {}
  // Stock first (always playable), then the archive by title.
  MAPS = [...STOCK, ...cat.maps]
  renderMaps()
  if (!S.map) selectMap(MAPS[0]?.bsp)
  return cat
}

function renderMaps() {
  const list = $('mapList')
  list.replaceChildren()
  for (const m of MAPS) {
    const b = el('button', S.map === m.bsp ? 'sel' : '')
    const name = el('span', 'mapname', m.title)
    b.append(name)
    // The state a player cares about: can I press Play, and if not what is in the way.
    // "not on this PC" is a real state and has to look different from "download me":
    // nothing serves the rescued map files yet, so on a friend's machine most of this
    // list cannot be installed at all. Saying "453 MB" there would be a lie.
    const tag = el('span', 'tag',
      m.stock ? 'stock' : m.installed ? 'installed' : m.available ? mb(m.bytes) : 'not available yet')
    if (!m.stock && !m.installed) tag.classList.add(m.available ? 'needs' : 'absent')
    b.append(tag)
    // The bsp, small — it is what the folder and the original download are called, and
    // people searching for a map will have seen it.
    b.append(el('span', 'bsp', m.bsp))
    b.title = `${m.title}
${m.bsp}${m.author ? `
by ${m.author}` : ''}`
    b.onclick = () => selectMap(m.bsp)
    list.append(b)
  }
  if (!MAPS.length) list.append(el('div', 'card-note', 'No maps yet.'))
}

function selectMap(bsp) {
  if (!bsp) return
  S.map = bsp
  const m = MAPS.find((x) => x.bsp === bsp)
  S.selected = m || null
  $('cardMap').textContent = m ? m.title : bsp
  $('cardSub').textContent = m && m.author ? `${m.bsp}  ·  by ${m.author}` : bsp
  renderMaps()
  updatePlay()
}

function updatePlay() {
  const ready = !!S.status?.setup?.installed
  const busy = !!S.boot && !S.boot.done && !S.boot.failed
  const m = S.selected
  const needsInstall = !!m && !m.stock && !m.installed && m.available
  const unavailable = !!m && !m.stock && !m.installed && !m.available
  const installing = !!S.installing

  $('modeBtn').textContent = S.mode === 'verified' ? 'Verified' : 'Custom'
  $('cardMode').textContent = S.mode === 'verified' ? 'Verified' : 'Custom'

  // One button, three jobs, and it says which. A map you have not downloaded cannot be
  // played, so offering Play and failing would be the wrong thing.
  const play = $('playBtn')
  if (unavailable) {
    play.textContent = 'Not available yet'
    play.disabled = true
    play.onclick = null
  } else if (needsInstall) {
    play.textContent = installing ? `Installing… ${S.installPct || 0}%` : `Install (${mb(m.bytes)})`
    play.disabled = !ready || installing
    play.onclick = () => installSelected()
  } else {
    play.textContent = 'Play'
    play.disabled = !S.map || !ready || busy || installing
    play.onclick = () => play_(false)
  }
  $('playLocalBtn').disabled = !S.map || !ready || busy || needsInstall || unavailable || installing
  $('cardNote').textContent =
    !ready ? 'The ENW client is not installed yet.'
      : installing ? (S.installFile || 'Copying the map into your ENW library.')
        : busy ? 'A game is starting.'
          : !S.map ? 'Pick a map.'
            : unavailable ? `${m.title} is in the archive, but the files are not on this PC and nothing serves them yet. The four stock maps work.`
              : needsInstall ? `${m.title} is in the archive but not on this PC yet.`
              : S.mode === 'verified' ? 'Stock settings. Records and badges count.'
                : 'Any settings. Nothing is tracked.'
}

async function installSelected() {
  const m = S.selected
  if (!m) return
  S.installing = m.bsp
  S.installPct = 0
  S.installFile = null
  updatePlay()
  try {
    const rec = await window.enw.installMap(m.bsp)
    toast(`${rec.title} installed — ${rec.files.length} files, every one checked against the archive's hash.`)
    await loadMaps()
    selectMap(m.bsp)
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    S.installing = null
    S.installFile = null
    updatePlay()
  }
}

function renderStatus() {
  const b = $('statusBody')
  b.replaceChildren()
  const kv = (k, v, cls) => {
    const row = el('div', 'kv')
    row.append(el('span', 'k', k))
    row.append(el('span', `v ${cls || ''}`, v))
    b.append(row)
  }
  const st = S.status
  if (!st) { kv('Loading', '…'); return }
  // Once installed the manifest is the record; before that, whatever the detector just
  // found. Reading only the manifest made the rail say "not found" on the very screen
  // that was showing the game it had found.
  const g = st.setup?.manifest?.source || (S.detection?.ok ? { grade: S.detection.game.grade } : null)
  kv('World at War', g ? (g.grade === 'verified' ? 'verified' : g.grade) : 'not found', g ? (g.grade === 'verified' ? 'good' : '') : 'bad')
  kv('ENW client', st.setup?.installed ? 'installed' : 'not installed', st.setup?.installed ? 'good' : 'bad')
  kv('Signed in', st.session?.signedIn ? (st.session.name || st.session.steamid) : 'no')
  kv('Site', st.site?.placeholder ? 'placeholder' : 'connected', st.site?.placeholder ? '' : 'good')
  if (st.pendingUpdate) kv('Update', `${st.pendingUpdate.version} on next start`)
  if (st.gameLock?.held) kv('Game lock', `${st.gameLock.name}${st.gameLock.stale ? ' (stale)' : ''}`, st.gameLock.stale ? '' : 'bad')

  const det = el('button', 'ghost', 'What did we find?')
  det.style.marginTop = '8px'
  det.style.width = '100%'
  det.onclick = showDetection
  b.append(det)
}

// --------------------------------------------------------------- first run --

async function renderFirstRun(result) {
  const body = $('frBody')
  const actions = $('frActions')
  body.replaceChildren()
  actions.replaceChildren()

  const r = result || (await window.enw.detect({}))
  S.detection = r
  renderStatus()

  if (r.ok) {
    const c = el('div', 'card good')
    c.append(el('div', 'head', `Found World at War — ${r.game.grade === 'verified' ? 'verified' : 'accepted'}`))
    const bd = el('div', 'body')
    bd.append(el('div', null, r.game.dir))
    bd.append(el('div', 'mono', `version ${r.game.version || '?'}${r.game.sha256 ? ` · sha256 ${r.game.sha256.slice(0, 16)}…` : ''}`))
    bd.append(el('div', null, r.candidates[0]?.reason || ''))
    if (r.game.via) bd.append(el('div', 'muted', r.game.via))
    c.append(bd)
    body.append(c)

    const what = el('div', 'card')
    what.append(el('div', 'head', 'What setting up will change'))
    const ul = el('ul', 'changed')
    for (const line of [
      `Create ${S.status?.enwRoot || 'an ENW folder'} and put a small copy of the game in it (about 8 MB — the big folders are links, not copies).`,
      'Install the ENW client there as binkw32.dll, keeping the original beside it.',
      'Keep ENW\'s game settings and logs in that folder.',
    ]) ul.append(el('li', null, line))
    const kept = el('li', 'kept', 'Your Steam copy of World at War is not touched, and nothing is written to it. Ever.')
    ul.append(kept)
    what.append(ul)
    body.append(what)

    const go = el('button', 'primary', 'Install the ENW client')
    go.onclick = () => doSetup(r.game.dir)
    actions.append(go)
  } else if (r.state === 'owned_not_installed') {
    const c = el('div', 'card')
    c.append(el('div', 'head', 'You own World at War, but it is not installed'))
    c.append(el('div', 'body', 'Install it through Steam and we will carry on from there.'))
    body.append(c)
    const b1 = el('button', 'primary', 'Install via Steam')
    b1.onclick = () => window.enw.installViaSteam()
    actions.append(b1)
  } else {
    const c = el('div', 'card bad')
    c.append(el('div', 'head', 'We could not find World at War'))
    c.append(el('div', 'body', 'We checked the Steam registry, every Steam library on this PC, and Steam\'s own records for app 10090.'))
    body.append(c)
    const b1 = el('button', null, 'Get World at War on Steam')
    b1.onclick = () => window.enw.getOnSteam()
    actions.append(b1)
  }

  const browse = el('button', r.ok ? 'ghost' : 'primary', r.ok ? 'It is somewhere else' : 'Find it myself')
  browse.onclick = doBrowse
  actions.append(browse)

  const why = el('button', 'ghost', 'Show everything we checked')
  why.onclick = showDetection
  actions.append(why)
}

async function doBrowse() {
  const r = await window.enw.browse()
  if (r.cancelled) return
  if (r.ok) {
    if (r.corrected) toast(`That was not quite the right folder — we found the game ${r.how}.`)
    await renderFirstRun({ ok: true, game: r.game, candidates: r.candidates, routes: [], state: 'installed' })
  } else {
    toast(r.reason, 'error')
    showDetection({ browse: r })
  }
}

async function doSetup(gameDir) {
  show('firstRun')
  const body = $('frBody')
  body.replaceChildren()
  const card = el('div', 'card')
  card.append(el('div', 'head', 'Installing'))
  const steps = el('div', 'steps')
  card.append(steps)
  body.append(card)
  $('frActions').replaceChildren()

  const off = window.enw.onSetup((s) => {
    const row = el('div', `step ${s.ok ? 'done' : 'failed'}`)
    row.append(el('div', 'dot', s.ok ? '✓' : '✕'))
    const b = el('div', 'body')
    b.append(el('div', 'title', s.name))
    b.append(el('div', 'detail', s.detail))
    row.append(b)
    steps.append(row)
  })

  try {
    const m = await window.enw.setup({ gameDir })
    off()
    const done = el('div', `card ${m.sourceUnchanged ? 'good' : 'bad'}`)
    done.append(el('div', 'head', m.sourceUnchanged ? 'Done. Your copy of World at War was not changed.' : 'Done, but something in your install changed — check the log.'))
    done.append(el('div', 'body', `ENW lives in ${m.gameDir}. Removing it later puts everything back.`))
    body.append(done)
    const close = el('button', 'primary', 'Continue')
    close.onclick = async () => { await refresh(); hideAll() }
    $('frActions').append(close)
  } catch (e) {
    off()
    toast(e.message, 'error')
    const again = el('button', null, 'Try again')
    again.onclick = () => renderFirstRun()
    $('frActions').append(again)
  }
}

// --------------------------------------------------------------- detection --

function showDetection(extra) {
  show('detail')
  $('detailTitle').textContent = 'What we checked'
  const b = $('detailBody')
  b.replaceChildren()
  const r = extra?.browse || S.detection
  if (!r) { b.append(el('p', 'lede', 'Nothing yet.')); return }

  if (r.routes?.length) {
    b.append(el('h2', null, 'Routes'))
    const box = el('div', 'checks')
    for (const rt of r.routes) {
      const row = el('div', 'check')
      row.append(el('div', `mark ${rt.found ? 'ok' : 'no'}`, rt.found ? '✓' : '·'))
      row.append(el('div', 'id', rt.route))
      row.append(el('div', 'detail', rt.detail))
      box.append(row)
    }
    b.append(box)
  }

  if (r.tried?.length) {
    b.append(el('h2', null, `Folders looked at (${r.tried.length})`))
    const sc = el('div', 'scroller mono')
    for (const t of r.tried.slice(0, 200)) sc.append(el('div', t.hit ? '' : 'muted', `${t.hit ? 'FOUND ' : '      '}${t.dir}   (${t.how})`))
    b.append(sc)
  }

  b.append(el('h2', null, 'Candidates'))
  for (const c of r.candidates || []) {
    const card = el('div', `card ${c.ok ? 'good' : 'bad'}`)
    card.append(el('div', 'head', `${c.ok ? 'Accepted' : 'Rejected'} — ${c.dir}`))
    card.append(el('div', 'body', c.reason))
    const box = el('div', 'checks')
    box.style.marginTop = '10px'
    for (const ch of c.checks || []) {
      const row = el('div', 'check')
      row.append(el('div', `mark ${ch.ok ? 'ok' : 'no'}`, ch.ok ? '✓' : '✕'))
      row.append(el('div', 'id', ch.id))
      row.append(el('div', 'detail', ch.detail))
      box.append(row)
    }
    card.append(box)
    b.append(card)
  }
}

// ------------------------------------------------------------------- boot --

function renderBoot(snap) {
  S.boot = snap
  show('boot')
  $('bootCancel').classList.remove('off')
  $('bootClose').classList.remove('on')
  const m = MAPS.find((x) => x.bsp === snap.map)
  $('bootMap').textContent = m ? m.title : snap.map || '—'
  $('bootMode').textContent = snap.mode === 'verified' ? 'Verified' : 'Custom'

  const order = ['reserving', 'loading', 'ready', 'launching', 'in_game']
  const wrap = $('bootSteps')
  wrap.replaceChildren()
  for (const id of order) {
    const s = snap.steps.find((x) => x.id === id)
    const row = el('div', `step ${s ? s.state : ''}`)
    row.append(el('div', 'dot', !s ? '·' : s.state === 'done' ? '✓' : s.state === 'failed' ? '✕' : '›'))
    const body = el('div', 'body')
    const t = el('div', 'title')
    // The step's own label when it has one: Play Local relabels these, because
    // "Reserving server" is a lie on a game that runs on your own PC.
    t.append(document.createTextNode(s?.label || ({ reserving: 'Reserving server', loading: 'Loading map', ready: 'Ready', launching: 'Launching World at War', in_game: 'In game' })[id]))
    if (s?.simulated) t.append(el('span', 'sim', 'simulated'))
    body.append(t)
    body.append(el('div', 'detail', s ? s.detail : 'waiting'))
    row.append(body)
    wrap.append(row)
  }

  const notes = $('bootNotes')
  notes.replaceChildren()
  if (snap.notes?.length) {
    notes.append(el('h2', null, 'What the launcher did'))
    const sc = el('div', 'scroller')
    for (const n of snap.notes) sc.append(el('div', 'muted', n))
    notes.append(sc)
  }
  if (snap.simulated?.length) {
    const c = el('div', 'card')
    c.style.marginTop = '12px'
    c.append(el('div', 'head', 'Some of this was not real'))
    c.append(el('div', 'body', `No host agent answered, so these steps were simulated: ${snap.simulated.join(', ')}.`))
    notes.append(c)
  }
  updatePlay()
}

async function play_(local) {
  if (!S.map) return
  try {
    const snap = await window.enw.play({ map: S.map, mode: S.mode, local, fsGame: S.selected?.fsGame || null })
    renderBoot(snap)
  } catch (e) { toast(e.message, 'error') }
}

// --------------------------------------------------------------- settings --

function renderSettings() {
  show('settings')
  const b = $('settingsBody')
  b.replaceChildren()
  const s = S.status?.settings || {}
  const field = (label, node, hint) => {
    const f = el('div', 'field')
    f.append(el('label', null, label))
    f.append(node)
    if (hint) { const h = el('div', 'hint', hint); f.append(h) }
    b.append(f)
  }
  const num = (key, min, max) => {
    const i = document.createElement('input')
    i.type = 'number'; i.min = min; i.max = max; i.value = s[key] ?? ''
    i.onchange = () => window.enw.setSettings({ [key]: Number(i.value) }).then(refresh)
    return i
  }
  const check = (key) => {
    const i = document.createElement('input')
    i.type = 'checkbox'; i.checked = !!s[key]; i.style.width = 'auto'
    i.onchange = () => window.enw.setSettings({ [key]: i.checked }).then(refresh)
    return i
  }
  field('Field of view', num('fov', 65, 120), 'Records allow up to 120. The gun model looks wrong much above 100.')
  field('Max FPS', num('maxFps', 60, 250), 'Records allow up to 250, and the server checks the value.')
  field('Fullscreen', check('fullscreen'))
  field('Show FPS', check('showFps'))
  field('Streamer mode', check('streamerMode'), 'Hides join codes and incoming invite details.')
  field('Remove unplayed maps', check('autoRemoveUnplayedMaps'), 'Off by default.')
  const scope = el('div', 'muted', s._scope ? `Saved to: ${s._scope}` : '')
  b.append(scope)

  const p = $('pathsBody')
  p.replaceChildren()
  renderStorage()
  const st = S.status
  const row = (k, v) => { const d = el('div', 'kv'); d.append(el('span', 'k', k)); d.append(el('span', 'v mono', v || '—')); p.append(d) }
  row('ENW folder', st?.enwRoot)
  row('Game copy', st?.setup?.gameDir)
  row('Your install', st?.setup?.manifest?.source?.dir)
  row('Site', st?.site?.url)
  const siteIn = document.createElement('input')
  siteIn.value = st?.config?.siteUrl || ''
  siteIn.placeholder = 'http://127.0.0.1:3200 — leave blank to detect'
  siteIn.onchange = () => window.enw.setConfig({ siteUrl: siteIn.value || null }).then(refresh)
  const f = el('div', 'field')
  f.append(el('label', null, 'Site URL'))
  f.append(siteIn)
  f.append(el('div', 'hint', 'Where the launcher loads the site from. Blank means: try the usual local ports.'))
  p.append(f)
}

async function renderStorage() {
  const box = $('storageBody')
  box.replaceChildren()
  let st
  try { st = await window.enw.storage() } catch { return }
  const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`)
  const row = (k, v, sub) => {
    const d = el('div', 'kv')
    d.append(el('span', 'k', k))
    d.append(el('span', 'v', v))
    box.append(d)
    if (sub) box.append(el('div', 'muted mono', sub))
  }
  for (const [name, f] of Object.entries(st.folders)) {
    if (!f.exists) continue
    row(name, `${mb(f.bytes)}${f.links ? ` + ${f.links} linked folder(s)` : ''}`)
  }
  row('total', mb(st.total))
  box.append(el('div', 'muted', st.note))
  if (st.maps.length) {
    box.append(el('h2', null, 'Maps'))
    for (const m of st.maps) row(m.id, mb(m.bytes))
  } else {
    box.append(el('div', 'muted', 'No maps downloaded yet. Map downloads are not built.'))
  }
}

// ------------------------------------------------------------------- wiring --

async function refresh() {
  S.status = await window.enw.status()
  renderStatus()
  updatePlay()
  const st = S.status
  $('sitePill').textContent = `site: ${st.site?.placeholder ? 'placeholder' : new URL(st.site?.url || 'about:blank').host || 'file'}`
  $('sitePill').className = `pill ${st.site?.placeholder ? 'warn' : 'ok'}`
  $('setupPill').textContent = st.setup?.installed ? 'client: installed' : 'client: not installed'
  $('setupPill').className = `pill ${st.setup?.installed ? 'ok' : 'warn'}`
  $('accountPill').textContent = st.session?.signedIn ? `${st.session.name || st.session.steamid}${st.session.mock ? ' (mock)' : ''}` : 'Sign in'
  return st
}

function wire() {
  $('navBack').onclick = () => window.enw.siteNav('back')
  $('navFwd').onclick = () => window.enw.siteNav('forward')
  $('navReload').onclick = () => window.enw.siteNav('reload')
  $('sitePill').onclick = () => renderSettings()
  $('setupPill').onclick = () => renderFirstRun().then(() => show('firstRun'))
  $('settingsPill').onclick = renderSettings
  $('accountPill').onclick = async () => {
    const st = await window.enw.status()
    if (st.session?.signedIn) { await window.enw.signOut(); toast('Signed out.') }
    else {
      try { const s = await window.enw.signIn(); toast(`Signed in as ${s.name} (mock sign-in — Steam OpenID needs the site).`) }
      catch (e) { toast(e.message, 'error') }
    }
    refresh()
  }
  $('playLocalBtn').onclick = () => play_(true)
  $('modeBtn').onclick = () => { S.mode = S.mode === 'verified' ? 'custom' : 'verified'; updatePlay() }
  $('bootCancel').onclick = () => window.enw.cancelPlay()
  $('bootClose').onclick = () => { window.enw.closeBoot(); hideAll() }
  $('settingsClose').onclick = hideAll
  $('detailClose').onclick = hideAll
  $('openRoot').onclick = () => window.enw.openFolder('root')
  $('openLogs').onclick = () => window.enw.openFolder('logs')
  $('btnUninstall').onclick = async () => {
    // No keepMaps: the main process asks the player, which is B's rule for uninstall.
    const lines = await window.enw.uninstall({})
    if (lines[0] === 'cancelled') return
    toast(lines.join(' '))
    refresh()
  }

  window.enw.onBoot(renderBoot)
  window.enw.onBootDone((snap) => {
    renderBoot(snap)
    $('bootCancel').classList.add('off')
    $('bootClose').classList.add('on')
  })
  window.enw.onMapProgress((p) => {
    if (p.bsp !== S.installing) return
    S.installPct = p.total ? Math.round((p.done / p.total) * 100) : 0
    S.installFile = `${p.file} (${S.installPct}%)`
    updatePlay()
  })
  window.enw.onToast((t) => toast(t.text, t.kind))
  window.enw.onSession(() => refresh())
  window.enw.onSettings(() => refresh())
  window.enw.onSite(() => refresh())
  window.enw.onDeepLink((link) => {
    if (link.kind === 'map' || link.kind === 'play') {
      if (!MAPS.some((m) => m.bsp === link.map)) MAPS.unshift({ bsp: link.map, title: link.map, stock: false, installed: false, available: false, bytes: 0 })
      selectMap(link.map)
      toast(`Opened from a link: ${link.map}`)
      if (link.kind === 'play') play_(false)
    }
  })
}

;(async () => {
  wire()
  const st = await refresh()
  await loadMaps()
  if (!st.setup?.installed) { await renderFirstRun(); show('firstRun') }
})()
