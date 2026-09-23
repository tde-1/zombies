// The launcher chrome. Everything here talks to the main process through window.enw
// (see src/preload/preload.cjs) and to nothing else.
//
// Tone rule (vault 06): plain, dry, no selling, no hype. Functional words only —
// error states, empty states, and why a control is disabled. A thing is said once: the
// Play button already says what it is about to do, so the note under it only speaks when
// it has something the button does not.

const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }

const S = {
  status: null,
  boot: null,
  screen: null,
}

// ---------------------------------------------------------------------------
// THE MAP LIST, THE MAP CARD AND THE PLAY BUTTON ARE NOT HERE ANY MORE (2026-09-22)
// ---------------------------------------------------------------------------
// They were: a `STOCK` constant naming the four Treyarch maps, a catalogue fetch, a rail
// of map rows, a selected-map card, Play / Play Local / a Verified-Custom toggle, and a
// status block. Every one of them is on the site's own home, in the LEFT column B decided
// is the one place a party is managed and a map is picked - `PartyPanel` (Start, Verified /
// Custom, the per-member download bars) and `MapListPanel`, with the selected map's page
// filling the rest and its own **Play Local** on it.
//
// Two copies of that is not redundancy, it is a disagreement waiting to happen. The rail
// had its own stock list, its own idea of "installed" and its own mode - and the rail's
// mode was the one that reached `POST /api/launcher/play`, which is how B's Nacht der
// Untoten lease came out `mode: custom` while the site's party said Verified. The site
// defaults a party to Verified (`parties.js :: create`), so Verified-by-default survives
// this deletion; it just has one owner now instead of two.
//
// And the rail's 320 px is what pushed the site view to 1080 px, which is exactly the
// width at which `theme.css` folds the home into ONE column - so the left column B asked
// for was invisible in the launcher, and only in the launcher. main.js has the numbers.
//
// Pressing **Start** on the site already launches the game here: `main.js :: onPlay`
// follows any match the site hands this player, in its own words "a game was started for
// you". That is the party path, so it is the same one a friend's Start goes through.
//
// What the shell keeps is what only a native app can do: finding World at War, installing
// the client, the boot screen, settings and the tray.

// ------------------------------------------------------------------- screens --

// THE SITE IS A NATIVE VIEW. It sits ON TOP of this page, so a screen that is merely
// `display:block` is drawn UNDERNEATH it and cannot be seen or clicked. For months only
// the boot screen worked, because the PLAY path in the main process happened to hide
// the site itself; `firstRun`, `settings` and `detail` rendered into the dark and every
// click on them landed on a web page. That is exactly what "I can't install the client"
// was. Every screen now asks for the site to be hidden, and closing gives it back.
function show(name) {
  S.screen = name
  for (const id of ['firstRun', 'boot', 'settings', 'detail']) $(id).classList.toggle('on', id === name)
  window.enw.screen(name).catch(() => {})
}
function hideAll() { show(null) }

function toast(text, kind = 'info', action = null) {
  const t = el('div', `toast ${kind === 'error' ? 'error' : ''}`, text)
  // One small action, when the main process offers it (the "already running" toast's
  // End game). Only calls the main process allows from a toast.
  if (action && action.call === 'endGame' && window.enw.endGame) {
    const b = el('button', 'toast-action', action.label || 'End game')
    b.onclick = () => { b.disabled = true; window.enw.endGame(action.arg).then(() => t.remove()).catch((e) => { b.disabled = false; toast(e.message, 'error') }) }
    t.append(b)
  }
  $('toasts').append(t)
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 450) }, 7000)
}

// ------------------------------------------------------------------ the rail --

const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`)

// One spelling of the mode, everywhere it is drawn. `local` is its own answer: a game
// on your own PC is neither Verified nor Custom, and calling it "Custom" on the boot
// screen was the screen guessing.
const modeLabel = (m) => (m === 'verified' ? 'Verified' : m === 'local' ? 'Untracked' : 'Custom')

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
  kv('Signed in', st.session?.signedIn ? `${st.session.name || st.session.steamid}${st.session.mock ? ' (mock)' : ''}` : 'no')
  kv('Site', st.site?.placeholder ? 'placeholder' : 'connected', st.site?.placeholder ? '' : 'good')
  const u = st.updates || {}
  kv('Version', u.current || st.appVersion || '?')
  if (u.downloaded) kv('Update', `${u.downloaded} on next start`, 'good')
  else if (u.available) kv('Update', `downloading ${u.available}`)
  else if (!u.enabled) kv('Updates', 'not configured')
  else if (u.error) kv('Updates', 'could not check')
  if (st.gameLock?.held) kv('Game lock', `${st.gameLock.name}${st.gameLock.stale ? ' (stale)' : ''}`, st.gameLock.stale ? '' : 'bad')
  // Two things that used to fail in total silence. A status field that threw took the
  // whole object with it and read as "not installed"; a log that could not be written
  // made every later diagnosis an argument about missing evidence.
  if (st.errors) kv('Status', `could not read: ${Object.keys(st.errors).join(', ')}`, 'bad')
  if (st.logging && st.logging.writable === false) kv('Log', `cannot write ${st.logging.file}`, 'bad')

  const det = el('button', 'ghost', 'What we checked')
  det.id = 'detBtn'
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

  // ALREADY INSTALLED IS ITS OWN SCREEN.
  //
  // This screen used to offer "Install the ENW client" the moment World at War was
  // found, whether or not the client was already there -- so the one screen a player
  // opens to ask "is it installed?" answered by offering to install it again. Say what
  // is true, and name the folder: a "not installed" that does not say WHERE is what
  // sent us looking for a renderer bug when the real answer was a different folder.
  const st = S.status
  if (st?.setup?.installed) {
    const c = el('div', 'card good')
    c.append(el('div', 'head', 'The ENW client is installed'))
    const bd = el('div', 'body')
    bd.append(el('div', 'mono', st.setup.gameDir || st.paths?.game || ''))
    if (st.setup.clientDll) bd.append(el('div', 'muted mono', `binkw32.dll · ${st.setup.clientDll.size.toLocaleString()} bytes`))
    const laa = st.setup.largeAddressAware
    if (laa?.present) bd.append(el('div', 'muted mono', `CoDWaW.exe · ${laa.laa ? '4 GB memory (large address aware)' : '2 GB memory (stock)'}${laa.characteristics != null ? ` · Characteristics 0x${laa.characteristics.toString(16).padStart(4, '0')}` : ''}`))
    bd.append(el('div', null, 'Press Play on a map.'))
    c.append(bd)
    body.append(c)
    const close = el('button', 'primary', 'Back to the site')
    close.onclick = hideAll
    actions.append(close)
    const again = el('button', 'ghost', 'Install it again')
    again.onclick = () => doSetup(r.ok ? r.game.dir : st.setup.manifest?.source?.dir)
    actions.append(again)
    const why2 = el('button', 'ghost', 'What we checked')
    why2.onclick = showDetection
    actions.append(why2)
    return
  }

  if (r.ok) {
    const c = el('div', 'card good')
    c.append(el('div', 'head', `World at War found · ${r.game.grade === 'verified' ? 'verified' : 'accepted'}`))
    const bd = el('div', 'body')
    bd.append(el('div', null, r.game.dir))
    bd.append(el('div', 'mono', `version ${r.game.version || '?'}${r.game.sha256 ? ` · sha256 ${r.game.sha256.slice(0, 16)}…` : ''}`))
    bd.append(el('div', null, r.candidates[0]?.reason || ''))
    if (r.game.via) bd.append(el('div', 'muted', r.game.via))
    c.append(bd)
    body.append(c)

    const what = el('div', 'card')
    what.append(el('div', 'head', 'What this does'))
    const ul = el('ul', 'changed')
    for (const line of [
      `Create ${S.status?.enwRoot || 'an ENW folder'} with a small copy of the game (about 8 MB).`,
      'Install the ENW client there as binkw32.dll. The original is kept.',
      'Keep ENW maps, saves, profiles, settings and logs in that folder.',
    ]) ul.append(el('li', null, line))
    const kept = el('li', 'kept', 'Your Steam copy is not touched.')
    ul.append(kept)
    what.append(ul)
    body.append(what)

    const go = el('button', 'primary', 'Install the ENW client')
    go.onclick = () => doSetup(r.game.dir)
    actions.append(go)
  } else if (r.state === 'owned_not_installed') {
    const c = el('div', 'card')
    c.append(el('div', 'head', 'World at War is not installed'))
    body.append(c)
    const b1 = el('button', 'primary', 'Install via Steam')
    b1.onclick = () => window.enw.installViaSteam()
    actions.append(b1)
  } else {
    const c = el('div', 'card bad')
    c.append(el('div', 'head', 'World at War not found'))
    body.append(c)
    const b1 = el('button', null, 'Get World at War on Steam')
    b1.onclick = () => window.enw.getOnSteam()
    actions.append(b1)
  }

  const browse = el('button', r.ok ? 'ghost' : 'primary', r.ok ? 'Choose another folder' : 'Choose folder')
  browse.onclick = doBrowse
  actions.append(browse)

  const why = el('button', 'ghost', 'What we checked')
  why.onclick = showDetection
  actions.append(why)
}

async function doBrowse() {
  const r = await window.enw.browse()
  if (r.cancelled) return
  if (r.ok) {
    if (r.corrected) toast(`Found the game ${r.how}.`)
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
    done.append(el('div', 'head', m.sourceUnchanged ? 'Done' : 'Done, but your install changed. Check the log.'))
    done.append(el('div', 'body', m.gameDir))
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
    card.append(el('div', 'head', `${c.ok ? 'Accepted' : 'Rejected'} · ${c.dir}`))
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
  $('bootRetry').classList.remove('on')
  // The title when the site told us one, the bsp when it did not. Never a blank.
  $('bootMap').textContent = snap.title || snap.map || '—'
  $('bootMode').textContent = modeLabel(snap.mode)

  // `download` is the party/late-joiner map install, and it is the one step that is
  // only drawn when it happened: most launches have the map already and a permanently
  // greyed "Downloading the map" row would be noise on every one of them.
  // `steam` is drawn only when Steam had to be started or signed in to (steam.js). When
  // it failed nothing else ran, so it is the only row: one line and Retry.
  const order = snap.steamFailed ? ['steam'] : ['steam', 'download', 'reserving', 'loading', 'ready', 'launching', 'in_game']
  const wrap = $('bootSteps')
  wrap.replaceChildren()
  for (const id of order) {
    const s = snap.steps.find((x) => x.id === id)
    if ((id === 'download' || id === 'steam') && !s) continue
    const row = el('div', `step ${s ? s.state : ''}`)
    if (id === 'steam' && s?.state === 'active') row.append(el('div', 'dot spin', ''))
    else row.append(el('div', 'dot', !s ? '·' : s.state === 'done' ? '✓' : s.state === 'failed' ? '✕' : '›'))
    const body = el('div', 'body')
    const t = el('div', 'title')
    // The step's own label when it has one: Play Local relabels these, because
    // "Reserving server" is a lie on a game that runs on your own PC.
    t.append(document.createTextNode(s?.label || ({ steam: 'Steam', download:'Downloading the map', reserving: 'Reserving server', loading: 'Loading map', ready: 'Ready', launching: 'Launching World at War', in_game: 'In game' })[id]))
    if (s?.simulated) t.append(el('span', 'sim', 'simulated'))
    body.append(t)
    body.append(el('div', 'detail', s ? s.detail : 'waiting'))
    row.append(body)
    wrap.append(row)
  }

  const notes = $('bootNotes')
  notes.replaceChildren()
  if (snap.notes?.length) {
    notes.append(el('h2', null, 'Log'))
    const sc = el('div', 'scroller')
    for (const n of snap.notes) sc.append(el('div', 'muted', n))
    notes.append(sc)
  }
  if (snap.simulated?.length) {
    const c = el('div', 'card')
    c.style.marginTop = '12px'
    c.append(el('div', 'head', 'Simulated'))
    c.append(el('div', 'body', `No host agent answered: ${snap.simulated.join(', ')}.`))
    notes.append(c)
  }
}

// --------------------------------------------------------------- settings --

async function renderSettings() {
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
  const sel = (key, options, onset) => {
    const i = document.createElement('select')
    for (const [value, label] of options) {
      const o = document.createElement('option')
      o.value = value; o.textContent = label
      if (String(s[key] ?? '') === String(value)) o.selected = true
      i.append(o)
    }
    i.onchange = () => (onset ? onset(i.value) : window.enw.setSettings({ [key]: i.value })).then(refresh)
    return i
  }
  const text = (key, placeholder) => {
    const i = document.createElement('input')
    i.value = s[key] || ''
    i.placeholder = placeholder
    i.onchange = () => window.enw.setSettings({ [key]: i.value.trim() }).then(refresh)
    return i
  }

  // ------------------------------------------------------------------ display --
  // Spec 4.3: borderless windowed at the chosen display's native resolution is the
  // default, and resolution is only editable once Fullscreen or Windowed is picked.
  let displays = []
  try { displays = (await window.enw.getDisplays()).displays || [] } catch {}
  const mode = s.mode || 'borderless'
  if (displays.length) {
    field('Monitor', sel('display', [
      ['primary', 'Main display'],
      ...displays.map((d) => [d.id, `${d.label} · ${d.width}x${d.height}${d.primary ? ' (main)' : ''}`]),
    ]))
  }
  field('Window mode', sel('mode', [
    ['borderless', 'Borderless windowed (recommended)'],
    ['fullscreen', 'Fullscreen'],
    ['windowed', 'Windowed'],
  ]))
  if (mode !== 'borderless') {
    field('Resolution', text('resolution', displays.find((d) => d.primary) ? `${displays.find((d) => d.primary).width}x${displays.find((d) => d.primary).height}` : '1920x1080'), 'WxH. Blank for native.')
  }
  field('Field of view', num('fov', 65, 120), 'Records allow up to 120.')
  field('Max FPS', num('maxFps', 60, 250), 'Records allow up to 250.')
  field('Vsync', check('vsync'), 'Caps FPS to your refresh rate.')
  field('Show FPS', check('showFps'))
  field('4 GB memory for big maps', check('largeAddressAware'),
    "Needed for ORBiT and UGX Requiem. Only changes ENW's copy of the game.")
  field('Streamer mode', check('streamerMode'), 'Hides join codes and incoming invite details.')
  field('Remove unplayed maps', check('autoRemoveUnplayedMaps'))
  const scope = el('div', 'muted', s._scope ? `Saved to: ${s._scope}` : '')
  b.append(scope)

  const p = $('pathsBody')
  p.replaceChildren()
  renderStorage()
  const st = S.status
  const row = (k, v) => { const d = el('div', 'kv'); d.append(el('span', 'k', k)); d.append(el('span', 'v mono', v || '—')); p.append(d) }
  row('ENW folder', st?.enwRoot)
  row('Game copy', st?.setup?.gameDir)
  row('Game exe memory', st?.setup?.largeAddressAware?.present ? (st.setup.largeAddressAware.laa ? '4 GB (large address aware)' : '2 GB (stock header)') : null)
  row('Your install', st?.setup?.manifest?.source?.dir)
  row('Site', st?.site?.url)
  const siteIn = document.createElement('input')
  siteIn.value = st?.config?.siteUrl || ''
  siteIn.placeholder = 'http://127.0.0.1:3200'
  siteIn.onchange = () => window.enw.setConfig({ siteUrl: siteIn.value || null }).then(refresh)
  const f = el('div', 'field')
  f.append(el('label', null, 'Site URL'))
  f.append(siteIn)
  f.append(el('div', 'hint', 'Blank to detect.'))
  p.append(f)

  renderUpdateCheck(p)
}

// ------------------------------------------------------------- check for updates --
//
// This sits with the install facts rather than with the game settings, because it is
// one: which launcher this is, and whether it is the current one. Everything it can say
// is one line, and the line comes from the MAIN process (`updatecheck.js` owns the
// wording) so the log and the screen can never disagree about what happened.
//
// "Restart and update" only exists when something is actually downloaded. A greyed
// Restart button on every visit would train people to ignore it, and pressing one with
// nothing staged closes the launcher and opens nothing.
function renderUpdateCheck(p) {
  const ver = S.status?.appVersion || '—'
  const vrow = el('div', 'kv')
  vrow.append(el('span', 'k', 'Launcher version'))
  vrow.append(el('span', 'v mono', ver))
  p.append(vrow)

  const box = el('div', 'field')
  box.append(el('label', null, 'Updates'))

  const btn = el('button', null, 'Check for updates')
  btn.onclick = async () => {
    btn.disabled = true
    // The main process emits `Checking…` itself, but only once it has started; saying it
    // here too means the button never looks dead between the click and the first event.
    S.update = { phase: 'checking', message: 'Checking…' }
    paintUpdate()
    try { S.update = await window.enw.checkForUpdates() }
    catch (e) { S.update = { phase: 'failed', message: `Update check failed: ${e.message}` } }
    paintUpdate()
  }
  const restart = el('button', null, 'Restart now')
  restart.onclick = () => window.enw.restartAndUpdate().catch((e) => toast(e.message, 'error'))
  // 0.2.11: a check finds the update; downloading it is the player's Update now.
  const now = el('button', null, 'Update now')
  now.onclick = async () => {
    try { S.update = await window.enw.updateNow() } catch (e) { toast(e.message, 'error') }
    paintUpdate()
  }

  const line = el('div', 'hint update-line', '')
  const bar = el('div', 'update-row')
  bar.append(btn)
  bar.append(now)
  bar.append(restart)
  box.append(bar)
  box.append(line)
  p.append(box)

  S.updateNodes = { btn, now, restart, line }
  paintUpdate()
}

function paintUpdate() {
  const n = S.updateNodes
  if (!n || !n.line.isConnected) return
  const u = S.update || {}
  n.line.textContent = u.message || ''
  n.line.classList.toggle('bad', u.phase === 'failed' || u.phase === 'unreachable')
  // Busy only while we are genuinely mid-check or mid-download; a finished check must
  // be repeatable without closing the page.
  n.btn.disabled = u.phase === 'checking' || u.phase === 'downloading'
  n.restart.classList.toggle('hidden', !u.canInstall)
  n.now.classList.toggle('hidden', !(u.available && !u.canInstall && u.phase !== 'downloading'))
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
    box.append(el('div', 'muted', 'No maps downloaded.'))
  }
}

// ------------------------------------------------------------------- wiring --

async function refresh() {
  S.status = await window.enw.status()
  renderStatus()
  const st = S.status
  return st
}

function wire() {
  // The old top bar's back / forward / reload / site pill / client pill / account pill
  // are gone with the bar (2026-09-22): reload is Ctrl+R / F5 (main.js), Settings, the
  // client status, sign-in and sign-out are in the site's account menu. What is left
  // here is the screens' own strip: the way back, and the frameless window's buttons.
  $('chromeBack').onclick = () => {
    if (S.screen === 'boot') window.enw.closeBoot()
    hideAll()
  }
  $('wcMin').onclick = () => window.enw.win.minimize()
  $('wcMax').onclick = () => window.enw.win.maximize()
  $('wcClose').onclick = () => window.enw.win.close()
  const paintMax = (m) => {
    $('wcMax').title = m ? 'Restore' : 'Maximise'
    $('wcMax').innerHTML = m
      ? '<svg viewBox="0 0 10 10"><path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" fill="none" stroke="currentColor" stroke-width="1"/></svg>'
      : '<svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>'
  }
  window.enw.win.isMaximized().then(paintMax).catch(() => {})
  window.enw.win.onState((s) => paintMax(!!s?.maximized))
  // The site's account menu asks for Settings or the client install.
  window.enw.onOpenScreen((name) => {
    if (name === 'settings') renderSettings()
    else if (name === 'firstRun') renderFirstRun().then(() => show('firstRun'))
  })
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
    $('bootRetry').classList.toggle('on', !!snap.retry)
  })
  $('bootRetry').onclick = () => {
    $('bootRetry').classList.remove('on')
    window.enw.retryPlay().catch((e) => toast(e.message, 'error'))
  }
  // A map install still reports, and the one place it can be seen from the chrome is a
  // toast on the terminal states: the bar itself belongs to the page that started it
  // (the site's party panel and its map page both draw one).
  window.enw.onMapProgress((p) => {
    if (!p.done || !p.total || p.done < p.total) return
    if (p.file) toast(`${p.bsp}: ${p.file}`)
  })
  window.enw.onToast((t) => toast(t.text, t.kind, t.action))
  window.enw.onSession(() => refresh())
  window.enw.onSettings(() => refresh())
  window.enw.onSite(() => refresh())
  window.enw.onDeepLink((link) => {
    // A map lives in the wrapped site now, exactly as a party always did: the main
    // process has already navigated the site view to /m/<key>, and the chrome's only job
    // is to get out of the way. It deliberately does NOT press Play - the player presses
    // it, on the site, having seen what they are about to download (launcher-v0 §7).
    if (link.kind === 'map' || link.kind === 'play') {
      hideAll()
      toast(`Opened from a link: ${link.map}`)
      return
    }
    // A party lives in the wrapped site, and the main process has already navigated the
    // site view to it. The chrome's only job is to get out of the way: a Settings or
    // first-run screen still up would hide the page the link just opened.
    if (link.kind === 'party') { hideAll(); toast(`Opened from a link: party ${link.party}`); return }
    // `home` is a real outcome, not a silent no-op — a link that pointed at nothing we
    // recognise still opens a working launcher, and says so rather than seeming ignored.
    if (link.kind === 'home') { hideAll(); toast('That link has no map or party.') }
  })
  // Progress is PUSHED (main.js `push('update_status', …)`), never polled, so the
  // percentage moves smoothly and nothing keeps ticking after Settings is closed.
  window.enw.onUpdateStatus((s) => { S.update = s; paintUpdate() })
}

;(async () => {
  wire()
  const st = await refresh()
  if (!st.setup?.installed) { await renderFirstRun(); show('firstRun') }
})()
