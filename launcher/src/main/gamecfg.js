// The launch baseline: the dvars ENW sets so that "press Play" is a BETTER game than
// stock, the config.cfg we seed so the in-game menu agrees with them, and the parser
// that reads the player's in-game changes back out again.
//
// ----------------------------------------------------------------- why this exists
//
// Our copy runs with its own `fs_homepath` (paths.js), deliberately: B's Steam config
// is never read or written. The cost of that is that every launch started from the
// engine's own 2008 defaults, and they are bad:
//
//   * the image carries the literal `set r_mode 800x600` and `set r_fullscreen 0`
//     (measured in the decrypted 1.7 dump, and the one config.cfg on this box shows
//     `seta r_mode "800x600"` / `seta r_displayRefresh "60 Hz"`);
//   * `com_maxfps` defaults to 85 (PCGamingWiki; the dvar table in dedi.md §7 reads
//     0x55 = 85 out of the image);
//   * "Sync Every Frame" is on, and with vsync on the frame rate is clamped to the
//     monitor's refresh — 60 on B's display;
//   * `cg_fov` defaults to 65.
//
// So B pressed Play and got 800x600 at 60 fps with a 65 FOV. Nothing was broken; we
// simply never told the game anything about the display, and `settingsArgs` left
// `r_mode` empty by default ("leave it to the game") when "the game" had no opinion
// worth having.
//
// ------------------------------------------------------------------ two halves
//
// 1. **Command line** (`+set`) — what the engine runs with.
// 2. **A seeded `config.cfg`** — what the engine's own settings MENU shows. `+set`
//    alone leaves the menu lying: the player opens Video, sees 800x600 and 65 FOV,
//    and changing anything writes those stale values back. The seed is written once
//    per baseline version and never on top of a config the player has since changed.
//
// Everything here is a *setting*. Nothing that needs a DLL or an exe edit is in this
// file — that list lives in docs/kickstart/launcher.md and is the client lane's.
import fs from 'node:fs'
import path from 'node:path'
import { P, assertWritable } from './paths.js'
import { pickDisplay, resolutionOf, validResolution } from './display.js'

// Bump this when the baseline below changes: the seed is rewritten on the next
// launch, so a fix we add later reaches players who already have a config.cfg.
export const BASELINE_VERSION = 2

// The profile the engine uses when `players/profiles/active.txt` names one. We seed
// this name; the engine creates and uses it because active.txt points at it.
export const PROFILE = 'enw'

export const MODES = ['borderless', 'fullscreen', 'windowed']

// Spec §4.3: Borderless is the default. An account saved before Display settings
// existed has only `fullscreen: true`, which was the OLD default rather than a
// choice — so it does not pin the mode; only an explicit `fullscreen: false`
// (someone who went out of their way to be windowed) is honoured.
export function resolveMode(settings = {}) {
  if (MODES.includes(settings.mode)) return settings.mode
  return settings.fullscreen === false ? 'windowed' : 'borderless'
}

// ------------------------------------------------------------ the bundled fixes --
//
// Community fixes that are PURE CONFIG. Each one is a dvar this exe really has —
// every `dvar` below was grepped out of the decrypted 1.7 image (`r_noborder` is the
// one exception and is marked). Nothing here changes gameplay: no weapon, zombie,
// points, movement or physics dvar appears, and the only things a records rule cares
// about (FPS cap and FOV) are the ones the spec already fixes at <=250 and <=120.
export const COMMUNITY_FIXES = [
  {
    dvar: 'r_vsync', value: '0', name: 'Vsync off',
    why: 'Sync Every Frame is on by default and clamps the frame rate to the monitor refresh — this is the 60 in B\'s 60 FPS.',
    source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Vertical_sync_.28Vsync.29',
  },
  {
    dvar: 'com_maxfps', value: '250', name: 'FPS cap raised to the spec cap',
    why: 'The stock cap is 85. Spec §4.5 allows up to 250; THE SERVER STILL ENFORCES ALLOWED VALUES for a record game.',
    source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#120.2B_FPS',
  },
  {
    dvar: 'r_aspectRatio', value: 'auto', name: 'Widescreen aspect auto',
    why: 'Picks the aspect from the resolution instead of stretching a 16:9 display to a 4:3 frame.',
    source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Widescreen_resolution',
  },
  {
    dvar: 'cg_fov', value: '80', name: 'FOV 80',
    why: 'The stock FOV is 65. 80 is the top of the in-game slider and inside the spec\'s ~90–100 gun-model cap.',
    source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Field_of_view_.28FOV.29',
  },
  {
    dvar: 'm_filter', value: '0', name: 'Mouse smoothing off',
    why: '"Smooth Mouse" filters raw motion. Off is the default but the menu can flip it; pinning it keeps the DLL\'s raw-input fix meaningful.',
    source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Mouse_acceleration',
  },
  {
    dvar: 'cl_mouseAccel', value: '0', name: 'Mouse acceleration off',
    why: 'PCGW: turning Smooth Mouse off in the menu only writes m_filter — cl_mouseAccel has to be set separately or acceleration stays on.',
    source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Mouse_acceleration',
  },
  {
    dvar: 'r_texFilterAnisoMin', value: '16', name: 'Anisotropic filtering 16x (min)',
    why: 'The stock maximum is 4x. 16x costs nothing on any GPU made this decade.',
    source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Anisotropic_filtering_.28AF.29',
  },
  {
    dvar: 'r_texFilterAnisoMax', value: '16', name: 'Anisotropic filtering 16x (max)',
    why: 'The same setting\'s other half; PCGW says both lines must be raised.',
    source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Anisotropic_filtering_.28AF.29',
  },
  {
    dvar: 'r_picmip', value: '0', name: 'Texture quality high',
    why: '0 is full-resolution textures. Pinned because a "Set Optimal Settings?" pass or a safe-mode boot can leave it downscaled.',
    source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Video',
  },
  { dvar: 'r_picmip_bump', value: '0', name: 'Texture quality high (bump)', why: 'Same, for normal maps.', source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Video' },
  { dvar: 'r_picmip_spec', value: '0', name: 'Texture quality high (spec)', why: 'Same, for specular maps.', source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Video' },
  {
    dvar: 'r_multiGpu', value: '1', name: 'Dual video cards on',
    why: 'PCGW\'s named fix for "stuttering on modern systems despite a locked frame rate" — the setting is labelled Dual Video Cards and helps regardless of how many GPUs you have.',
    source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Stuttering_on_modern_systems',
  },
  {
    dvar: 'sm_enable', value: '1', name: 'Shadow maps on',
    why: 'Pinned at the stock value so a downgraded profile does not quietly ship a shadowless game.',
    source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Video',
  },
  {
    dvar: 'cl_maxpackets', value: '100', name: 'Client packet rate 100',
    why: 'The stock 30 is a 2008 dial-up default; the server clamps whatever it will not accept. Netcode only — nothing a client simulates changes.',
    source: 'https://plutonium.pw/docs/client/t4/',
  },
  {
    dvar: 'snaps', value: '30', name: 'Snapshot rate 30',
    why: 'Asks the server for 30 snapshots/s instead of 20. The server decides what it actually sends.',
    source: 'https://plutonium.pw/docs/client/t4/',
  },
  {
    dvar: 'rate', value: '25000', name: 'Rate 25000',
    why: 'The engine maximum, and already the value on this box. Pinned so a fresh profile does not start at a lower one.',
    source: 'https://plutonium.pw/docs/client/t4/',
  },
]

// Fixes that are real and are NOT ours: they need the DLL or an exe edit, so they are
// listed, not applied. The client lane owns them (docs/kickstart/client.md §2).
export const NEEDS_THE_DLL = [
  { name: 'Perfect borderless window', detail: '`r_noborder` does not exist in the vanilla 1.7 image (zero occurrences in the 78 MB dump; client.md §2c). We still pass it — a dvar the engine has never heard of is ignored — and the DLL strips the window style itself.', source: 'https://plutonium.pw/docs/client/t4/perfect-borderless-window/' },
  { name: 'LAA / 4 GB flag', detail: 'A PE header bit on a 32-bit exe. An exe edit, and dev-box rule 1 says we never modify the player\'s install; spec §4.5 explicitly excludes it.', source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Other_information' },
  { name: '25-day uptime timer', detail: 'An engine millisecond-counter overflow. Code, not config.', source: 'spec §4.5' },
  { name: 'Raised asset limits / memory', detail: 'What T4M does. A loaded module, not a dvar.', source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#Mods' },
  { name: 'The audio fix', detail: 'PCGW\'s workaround is "delete %LOCALAPPDATA%\\Activision\\CoDWaW\\players and let the game rebuild" — that is the PLAYER\'S profile folder, not ours, and we do not delete a player\'s files. Our fresh profile gets the effect for free.', source: 'https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War#No_sound' },
  { name: 'High-polling-rate mouse', detail: 'Already built, in the DLL: client.md §1.', source: 'docs/kickstart/client.md' },
  { name: 'In-game settings persistence UI', detail: 'The round trip below is launcher-side and done; drawing anything in game is the DLL\'s.', source: 'docs/kickstart/client.md §2b' },
]

// Deliberately NOT bundled, with the reason, so nobody re-adds them by accident:
//
//   r_aaSamples 16      PCGW records an alt-tab hang caused by AA above 2x on this
//                       game. A default that can freeze a player's game is not a fix.
//   sys_smp_allowed 0   PCGW's multi-core workaround. It disables the render thread;
//                       on most machines it costs frames. Worth an opt-in, not a
//                       default, and it is not a setting B has asked for.
//   snd_force51 / 71    Only correct when auto-detection fails. Forcing it is worse
//                       than leaving it for the people it breaks.
//   r_gamma / r_ignorehwgamma   A colour-profile preference, not a fix.
//   sensitivity         The player's. We never invent one.

// ------------------------------------------------------------------- the baseline --

// The ordered dvar list for a player-mode launch. `display` may be null (no Electron
// and no cache) — then the saved resolution is used, and if there is none either the
// resolution dvars are simply omitted and the game keeps its own, which is the old
// behaviour rather than a wrong guess.
export function baselineDvars(settings = {}, display = null) {
  const out = []
  const push = (dvar, v) => { if (v !== undefined && v !== null && v !== '') out.push([dvar, String(v)]) }

  const mode = resolveMode(settings)

  // Borderless ALWAYS uses the chosen display's native size (spec §4.3: resolution is
  // editable only once Fullscreen or Windowed is picked).
  const native = resolutionOf(display)
  const resolution = mode === 'borderless'
    ? (native || validResolution(settings.resolution))
    : (validResolution(settings.resolution) || native)

  push('r_fullscreen', mode === 'fullscreen' ? '1' : '0')
  push('r_mode', resolution)
  push('r_aspectRatio', 'auto')

  if (mode === 'borderless') {
    // Plutonium's recipe (https://plutonium.pw/docs/client/t4/perfect-borderless-window/).
    // `r_noborder` is NOT a vanilla dvar — the DLL does the window style — but an
    // unknown `+set` is harmless and it is the switch the DLL will read.
    push('r_noborder', '1')
  }
  if (mode !== 'fullscreen' && display) {
    // The chosen display's origin, in native pixels, so a borderless window lands on
    // the right monitor rather than always on the primary at 0,0.
    push('vid_xpos', display.x)
    push('vid_ypos', display.y)
  }
  if (display && Number.isInteger(display.index)) push('r_monitor', display.index)

  push('r_vsync', settings.vsync ? '1' : '0')
  push('com_maxfps', clampFps(settings.maxFps))
  push('cg_fov', clampFov(settings.fov))

  // The rest of the bundled fixes, minus the ones already placed above with a value
  // that depends on the account.
  const placed = new Set(out.map(([d]) => d))
  for (const f of COMMUNITY_FIXES) {
    if (placed.has(f.dvar)) continue
    push(f.dvar, f.value)
  }

  // The account's own, last, so they win.
  push('snd_volume', settings.volume)
  push('sensitivity', settings.sensitivity)
  if (settings.showFps) push('cg_drawFPS', '1')

  return out
}

export function clampFps(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '250' // spec §4.5 cap
  return String(Math.min(250, Math.max(30, Math.round(n))))
}

export function clampFov(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '80'
  // Spec §4.5: cap ~90–100 for the gun model, <=120 for speedruns. The server checks
  // a record game against the rule profile; this is only the launcher's sanity bound.
  return String(Math.min(120, Math.max(65, Math.round(n))))
}

export function dvarsToArgs(pairs) {
  const a = []
  for (const [d, v] of pairs) a.push('+set', d, String(v))
  return a
}

// ------------------------------------------------------------------ the seed --

export function renderConfigCfg(pairs, { version = BASELINE_VERSION } = {}) {
  const lines = [
    '// ENW Zombies launch baseline — written by the launcher, not by the game.',
    `// baseline version ${version}. The game rewrites this file on exit; whatever you`,
    '// change in the in-game menus wins, and the launcher reads it back afterwards.',
    '',
  ]
  for (const [d, v] of pairs) lines.push(`seta ${d} "${String(v).replace(/"/g, '')}"`)
  lines.push('')
  return lines.join('\r\n')
}

// Where the engine keeps the profile config. `%s/players/profiles/%s/config.cfg`
// (string at 0x883E64, client.md §2a) resolved against fs_homepath, plus the plain
// `config.cfg` beside it. We write both: which one a given boot reads depends on
// whether a profile is active, and a stale one is worse than a duplicate.
export function configPaths(homeDir = P.home, profile = PROFILE) {
  return {
    profileDir: path.join(homeDir, 'players', 'profiles', profile),
    profileCfg: path.join(homeDir, 'players', 'profiles', profile, 'config.cfg'),
    activeTxt: path.join(homeDir, 'players', 'profiles', 'active.txt'),
    plainCfg: path.join(homeDir, 'main', 'config.cfg'),
    stamp: path.join(homeDir, 'players', 'profiles', profile, '.enw-baseline.json'),
  }
}

export function seedState(homeDir = P.home, profile = PROFILE) {
  try { return JSON.parse(fs.readFileSync(configPaths(homeDir, profile).stamp, 'utf8')) } catch { return null }
}

// Write the baseline into the home folder so the in-game menu shows what we launch
// with. Idempotent and conservative:
//
//   * first launch (no config.cfg)            -> write it
//   * BASELINE_VERSION changed                -> write it (that is what the version is for)
//   * otherwise                               -> LEAVE IT ALONE
//
// The last line is rule 4 of the round trip: never override an in-game change with a
// stale saved value. Once the player has a config, the game owns it and we only read.
export function seedHome({ homeDir = P.home, profile = PROFILE, settings = {}, display = null, force = false } = {}) {
  const p = configPaths(homeDir, profile)
  const prev = seedState(homeDir, profile)
  const exists = fs.existsSync(p.profileCfg)
  const reason = !exists ? 'first launch: no config.cfg yet'
    : force ? 'forced'
      : (prev?.version !== BASELINE_VERSION) ? `the ENW baseline changed (${prev?.version ?? 'none'} -> ${BASELINE_VERSION})`
        : null
  if (!reason) return { written: false, reason: 'the player already has a config at this baseline version', paths: p }

  const pairs = baselineDvars(settings, display)
  const text = renderConfigCfg(pairs)
  fs.mkdirSync(assertWritable(p.profileDir), { recursive: true })
  fs.mkdirSync(assertWritable(path.join(homeDir, 'main')), { recursive: true })
  fs.writeFileSync(assertWritable(p.profileCfg), text)
  fs.writeFileSync(assertWritable(p.plainCfg), text)
  // active.txt names the profile the engine loads. Without it the engine invents one
  // and never reads the file we just wrote.
  fs.writeFileSync(assertWritable(p.activeTxt), profile)
  fs.writeFileSync(assertWritable(p.stamp), JSON.stringify({ version: BASELINE_VERSION, at: new Date().toISOString(), reason, dvars: Object.fromEntries(pairs) }, null, 2))
  return { written: true, reason, paths: p, dvars: pairs }
}

// ------------------------------------------------------------- the round trip --

// Parse a config.cfg. `seta r_mode "1920x1080"` and `set cg_fov 80` both count;
// bind lines are kept separately because the spec wants binds round-tripped too.
export function parseConfigCfg(text = '') {
  const dvars = new Map()
  const binds = new Map()
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('//')) continue
    let m = line.match(/^(?:seta|setu|set|sets)\s+(\S+)\s+"([^"]*)"\s*$/)
    if (!m) m = line.match(/^(?:seta|setu|set|sets)\s+(\S+)\s+(\S+)\s*$/)
    if (m) { dvars.set(m[1], m[2]); continue }
    let b = line.match(/^bind\s+(\S+)\s+"([^"]*)"\s*$/)
    if (!b) b = line.match(/^bind\s+(\S+)\s+(.+)$/)
    if (b) binds.set(b[1], b[2].replace(/^"|"$/g, ''))
  }
  return { dvars, binds }
}

// Read the config the game left behind. Newest of the two, because which one the
// engine wrote depends on whether the profile was active.
export function readConfig({ homeDir = P.home, profile = PROFILE } = {}) {
  const p = configPaths(homeDir, profile)
  let best = null
  for (const f of [p.profileCfg, p.plainCfg]) {
    try {
      const st = fs.statSync(f)
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, mtimeMs: st.mtimeMs }
    } catch {}
  }
  if (!best) return { found: false, file: null, dvars: new Map(), binds: new Map() }
  const parsed = parseConfigCfg(fs.readFileSync(best.file, 'utf8'))
  return { found: true, file: best.file, mtimeMs: best.mtimeMs, ...parsed }
}

// Turn a parsed config into a settings patch. Only keys the game actually wrote are
// returned — an absent dvar means "no opinion", and writing a default over a saved
// value is exactly the stale-override the spec forbids.
export function settingsFromConfig({ dvars, binds } = {}) {
  const patch = {}
  if (!dvars) return patch
  const g = (k) => (dvars.has(k) ? dvars.get(k) : undefined)

  const res = validResolution(g('r_mode') || '')
  if (res) patch.resolution = res

  const full = g('r_fullscreen')
  const noborder = g('r_noborder')
  if (full !== undefined) {
    // The DLL writes r_noborder when the player picks borderless in game; without it
    // windowed and borderless are indistinguishable in config.cfg, so a windowed
    // reading must NOT clobber a saved 'borderless'. That is handled by the caller
    // (applyReadBack) keeping the saved mode when only r_fullscreen 0 is seen.
    patch.mode = full === '1' ? 'fullscreen' : (noborder === '1' ? 'borderless' : 'windowed')
    patch.fullscreen = full === '1'
    if (noborder === undefined) patch._modeAmbiguous = full !== '1'
  }

  const fov = Number(g('cg_fov'))
  if (Number.isFinite(fov) && fov > 0) patch.fov = Number(clampFov(fov))

  const fps = Number(g('com_maxfps'))
  if (Number.isFinite(fps) && fps > 0) patch.maxFps = Number(clampFps(fps))

  const vs = g('r_vsync')
  if (vs !== undefined) patch.vsync = vs === '1'

  const sens = Number(g('sensitivity'))
  if (Number.isFinite(sens) && sens > 0) patch.sensitivity = sens

  const vol = Number(g('snd_volume'))
  if (Number.isFinite(vol)) patch.volume = vol

  const fpsHud = g('cg_drawFPS')
  if (fpsHud !== undefined) patch.showFps = fpsHud !== '0'

  const mon = Number(g('r_monitor'))
  if (Number.isInteger(mon) && mon >= 0) patch.display = String(mon)

  if (binds && binds.size) patch.binds = Object.fromEntries(binds)

  return patch
}

// The whole round trip, after the game has exited. Read-after-exit, not
// read-while-running: config.cfg is only complete once the process is gone
// (client.md §2b).
//
// `saved` is what the account held when we launched; `patch` is what the game says
// now. A key is only written back when the game actually wrote that dvar, so an
// in-game change is never overridden by a stale saved value — and equally, a setting
// the player changed in the launcher and the game did not touch survives.
export function applyReadBack({ homeDir = P.home, profile = PROFILE, saved = {} } = {}) {
  const cfg = readConfig({ homeDir, profile })
  if (!cfg.found) return { changed: {}, file: null, reason: 'the game wrote no config.cfg' }
  const patch = settingsFromConfig(cfg)
  const ambiguous = patch._modeAmbiguous
  delete patch._modeAmbiguous

  // Borderless and windowed both write `r_fullscreen 0`. If that is all we have, and
  // the account already said borderless, keep borderless — otherwise every single
  // launch would silently demote the default mode to plain windowed.
  if (ambiguous && saved.mode === 'borderless') { delete patch.mode; delete patch.fullscreen }

  const changed = {}
  for (const [k, v] of Object.entries(patch)) {
    const before = saved[k]
    const same = typeof v === 'object' ? JSON.stringify(before) === JSON.stringify(v) : String(before) === String(v)
    if (!same) changed[k] = v
  }
  return { changed, patch, file: cfg.file, reason: Object.keys(changed).length ? 'the player changed settings in game' : 'nothing changed in game' }
}
