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
export const BASELINE_VERSION = 3

// The profile the engine uses when `players/profiles/active.txt` names one. We seed
// this name; the engine creates and uses it because active.txt points at it.
export const PROFILE = 'enw'

export const MODES = ['borderless', 'fullscreen', 'windowed']

// The account's `volume` (0..1). See baselineDvars for why it is not `snd_volume`.
export const VOLUME_DVAR = 'snd_menu_master'

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
    // WAS '1' from afc6276 (2026-09-22) to 2026-09-23, on PCGW's "stuttering on modern
    // systems" advice. Wrong for us: B confirmed 2026-09-23 13:35 that turning it OFF
    // fixed the invisible/garbled zombies on nazi_zombie_fear_mc_2 and most of the mouse
    // stutter. On a single GPU it double-buffers skinned vertex data for alternate-frame
    // rendering (mod-compat.md §10.4). Still a player toggle for someone with two GPUs;
    // migrateMultiGpu() below repairs configs that carry the old '1'.
    dvar: 'r_multiGpu', value: '0', name: 'Dual video cards off',
    why: 'Pinned at the stock 0, reversing PCGW\'s "turn it on for stutter" fix (the source below): with it on, a single GPU breaks skinned models (invisible or garbled zombies) and stutters — B, 2026-09-23. Turn it on yourself only if you really run two GPUs. Evidence: docs/kickstart/mod-compat.md §10.4.',
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
  {
    dvar: 'r_autopriority', value: '1', name: 'Raise the game\'s process priority while it has focus',
    why: 'A real vanilla T4 dvar — it is in the config.cfg the engine itself writes on this box, at its stock 0. iw4x-client ships the same feature in the same component as its raw-mouse fix: the game goes to a higher priority class while focused so a background process cannot take the frame the input arrived on. Costs nothing when nothing else is busy.',
    source: 'https://github.com/iw4x/iw4x-client/blob/develop/src/Components/Modules/RawMouse.cpp',
  },
]

// The binds ENW seeds. Same rules as the dvars: written once per baseline
// version, then the player owns them — changing the key in the in-game Controls
// menu rewrites config.cfg and `applyReadBack` picks the new bind up.
//
// `+speed_throw` vs `+toggleads_throw` IS the aim-down-sights Hold/Toggle
// setting on T4. There is no `cl_ads_toggle`-style dvar: `ads_toggle`,
// `cl_ads`, `cg_ads` and `ads_button` are all ZERO occurrences in the
// decrypted 1.7 image, and what the game's own Controls menu writes when you
// pick Hold or Toggle is which of these two commands MOUSE2 is bound to. Both
// command pairs are in the image (`+speed_throw`/`-speed_throw` at 0x44D40D
// and 0x489A91, `+toggleads_throw`/`-toggleads_throw` beside them).
//
// B's own profile on this box was `bind MOUSE2 "+toggleads_throw"` — the stock
// default, and the toggle he is complaining about.
export const BASELINE_BINDS = [
  {
    key: 'MOUSE2', command: '+speed_throw', name: 'Aim down sights: HOLD',
    why: 'Stock WaW binds MOUSE2 to +toggleads_throw, i.e. press once to enter ADS and again to leave. B wants hold. This is exactly what the in-game Controls menu writes for "Aim Down Sight: Hold", so the player can change it back in game and the read-back keeps their choice.',
    source: 'the decrypted 1.7 image: +speed_throw / +toggleads_throw are the two ADS commands and there is no ADS dvar',
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

  // `r_displayRefresh` is a STRING with a unit, not a number: the config the
  // engine writes on this box reads `seta r_displayRefresh "60 Hz"` — on a
  // 240 Hz panel. Left at 60 it caps a fullscreen game to 60 and gives DWM the
  // wrong idea about a borderless one. Written in the engine's own format.
  if (display && Number.isFinite(Number(display.refresh)) && Number(display.refresh) > 0) {
    push('r_displayRefresh', `${Math.round(Number(display.refresh))} Hz`)
  }

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
  // Volume is `snd_menu_master` (Options > Sound > Master Volume), NOT `snd_volume`: the
  // name `snd_volume` sits in the image only in a string table (0x8819CC, referenced from
  // data at 0x8E4DC0) and is never registered, so `+set snd_volume` made an inert
  // external dvar and the setting did nothing (client.md §10b, bug 15). The six sound
  // dvars the site writes are all registered by the sound init (mov edi,<name> at
  // 0x6B4963..0x6B4EC1, Dvar_RegisterFloat 0x5EEF10).
  push(VOLUME_DVAR, settings.volume)
  push('sensitivity', settings.sensitivity)
  // `cg_drawFPS` is a string ENUM on T4, not a bool: the engine's own config
  // writes `seta cg_drawFPS "Off"`. `1` is not one of its values.
  push('cg_drawFPS', settings.showFps ? 'Simple' : 'Off')

  return out
}

// The FPS cap every records board we checked agrees on (docs/kickstart/verified-rules.md §2),
// and the value the DLL's fps_guard holds the game to mid-game (ENW_FPS_CAP, launch.js).
export const FPS_CAP = 250

export function clampFps(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return String(FPS_CAP) // spec §4.5 cap
  return String(Math.min(FPS_CAP, Math.max(30, Math.round(n))))
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
  for (const b of BASELINE_BINDS) lines.push(`bind ${b.key} "${b.command}"`)
  lines.push('')
  return lines.join('\r\n')
}

// Fold the baseline into a config the GAME wrote, instead of replacing it.
//
// The engine's own config.cfg is ~500 lines: `unbindall`, every bind, every
// seta it knows about, and a trailing `con_hidechannel ...` line. Overwriting
// that with our 30-line seed would throw away the player's key bindings and
// everything the engine expects to find — so each baseline line is substituted
// in place where it already exists, and appended only when it does not.
// Anything we have no opinion about is passed through untouched.
export function mergeConfigCfg(existing = '', pairs = [], binds = BASELINE_BINDS) {
  const want = new Map(pairs.map(([d, v]) => [d, String(v).replace(/"/g, '')]))
  const wantBind = new Map(binds.map((b) => [b.key.toUpperCase(), b.command]))
  const seen = new Set()
  const seenBind = new Set()
  const out = []
  let tail = []

  for (const raw of String(existing).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const m = line.match(/^(\s*)(?:seta|setu|set|sets)\s+(\S+)\s+/)
    if (m && want.has(m[2])) {
      if (!seen.has(m[2])) { out.push(`${m[1]}seta ${m[2]} "${want.get(m[2])}"`); seen.add(m[2]) }
      continue
    }
    const b = line.match(/^(\s*)bind\s+(\S+)\s+/)
    if (b && wantBind.has(b[2].toUpperCase())) {
      const k = b[2].toUpperCase()
      if (!seenBind.has(k)) { out.push(`${b[1]}bind ${b[2]} "${wantBind.get(k)}"`); seenBind.add(k) }
      continue
    }
    out.push(line)
  }

  // `con_hidechannel ...` is the last line the engine writes and it is a
  // command, not a setting; anything we append has to go before it or the
  // engine's own rewrite moves it anyway. Peel it off, append, put it back.
  while (out.length && (out[out.length - 1] === '' || /^con_(hide|show)channel\b/.test(out[out.length - 1]))) {
    tail.unshift(out.pop())
  }

  const added = []
  for (const [d, v] of want) if (!seen.has(d)) added.push(`seta ${d} "${v}"`)
  for (const [k, cmd] of wantBind) if (!seenBind.has(k)) added.push(`bind ${k} "${cmd}"`)
  if (added.length) {
    out.push('// --- ENW Zombies baseline (the launcher added these; change them in game and they stay changed)')
    out.push(...added)
  }

  return [...out, ...tail].join('\r\n').replace(/\r\n*$/, '') + '\r\n'
}

// Where the engine keeps the profile config. `%s/players/profiles/%s/config.cfg`
// (string at 0x883E64, client.md §2a) resolved against fs_homepath, plus the plain
// `config.cfg` beside it. We write both: which one a given boot reads depends on
// whether a profile is active, and a stale one is worse than a duplicate.
// CORRECTION 2026-09-22, and it is why none of this reached the game.
//
// `%s/players/profiles/%s/config.cfg` (0x883E64) is resolved against the
// engine's LOCAL APP DATA folder, not against `fs_homepath` — and since
// `enw_localappdata.cpp` landed, that folder is
// `<ENW>\home\localappdata\Activision\CoDWaW`. So the launcher was seeding
// `<ENW>\home\players\profiles\enw\config.cfg`, a path the engine has never
// opened; `<ENW>\home\players` did not even exist on this box after a night of
// play. The file the engine really reads and rewrites is
// `<ENW>\home\localappdata\Activision\CoDWaW\players\profiles\<active>\config.cfg`,
// and `active.txt` beside it said `$$$` — the engine's own default profile,
// because our `active.txt` was written somewhere it could not see.
//
// Consequence, measured: that profile still held `seta r_mode "800x600"`,
// `seta r_displayRefresh "60 Hz"`, `seta vid_xpos "40"` and
// `bind MOUSE2 "+toggleads_throw"` after a session launched with
// `+set r_mode 2560x1440 +set vid_xpos 0`. `config.cfg` is exec'd during
// Com_Init, AFTER the command line's early `+set`s, so it wins.
//
// The old `fs_homepath` locations are kept and still written: they cost
// nothing, and a build without the LocalAppData redirect (a dev run with
// ENW_LOCALAPPDATA unset) does use them.
const LOCALAPPDATA_SUFFIX = ['Activision', 'CoDWaW']

// Whatever `active.txt` names is the profile the engine is actually using. We
// read it rather than impose one: the engine creates `$$$` by itself and
// renaming it out from under a player loses their binds.
export function activeProfile(dir, fallback = PROFILE) {
  try {
    const name = fs.readFileSync(path.join(dir, 'active.txt'), 'utf8').trim()
    if (name && !/[\\/]/.test(name)) return name
  } catch {}
  return fallback
}

export function configPaths(homeDir = P.home, profile = PROFILE, localAppData = null) {
  localAppData = localAppData || path.join(homeDir, 'localappdata')
  const engineRoot = path.join(localAppData, ...LOCALAPPDATA_SUFFIX)
  const engineProfiles = path.join(engineRoot, 'players', 'profiles')
  const engineProfile = activeProfile(engineProfiles, profile)
  return {
    // What the ENGINE reads and writes. First in every list below.
    engineProfile,
    engineProfileDir: path.join(engineProfiles, engineProfile),
    engineCfg: path.join(engineProfiles, engineProfile, 'config.cfg'),
    engineActiveTxt: path.join(engineProfiles, 'active.txt'),
    // The fs_homepath tree, kept for a run with no LocalAppData redirect.
    profileDir: path.join(homeDir, 'players', 'profiles', profile),
    profileCfg: path.join(homeDir, 'players', 'profiles', profile, 'config.cfg'),
    activeTxt: path.join(homeDir, 'players', 'profiles', 'active.txt'),
    plainCfg: path.join(homeDir, 'main', 'config.cfg'),
    stamp: path.join(homeDir, 'players', 'profiles', profile, '.enw-baseline.json'),
    // Markers. They live beside the baseline stamp (the fs_homepath tree always
    // exists; the engine's localappdata tree may not on a dev run).
    readbackStamp: path.join(homeDir, 'players', 'profiles', profile, '.enw-readback.json'),
    migrations: path.join(homeDir, 'players', 'profiles', profile, '.enw-migrations.json'),
  }
}

// ------------------------------------------------ the profile IS the name --
//
// 0.2.10, B: "my name in game shows as ENW". It was the PROFILE. With a named profile
// active, World at War sends the profile's name as the userinfo `name` and ignores the
// `name` dvar: B's dedi connects (zombies-dev, 2026-09-22 18:20Z/18:26Z/18:28Z) all read
// `player_connect slot 0 name='enw'` although his command line carried `+set name myu`,
// `name_pin` had pinned `myu`, and the profile's own config.cfg said `seta name "myu"`.
// The dedi counted 0 userinfo commands, so the client never sent `myu` at all. Same
// shape as referee.md §14.4, where B's `anna-jpg` profile beat `+set name spoofer`.
// Only the engine's `$$$` ("no profile") state honours the dvar (15:45 run: 'Unknown
// Soldier', the dvar's stock value). So the active profile is named after the ENW
// name: a first launch copies the current profile (binds, settings, mpdata) into
// `profiles/<name>/`, and active.txt points at it. A second account on the same PC
// gets its own profile the same way.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i
export function profileNameFor(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9 _.-]/g, '').trim().replace(/[. ]+$/, '').slice(0, 31)
  if (!s || RESERVED.test(s)) return null
  return s
}

export function usePlayerProfile({ homeDir = P.home, name, localAppData = null } = {}) {
  const profile = profileNameFor(name)
  if (!profile) return { changed: false, profile: null, reason: 'no usable ENW name; the profile is left as it is' }
  const engineProfiles = path.join(localAppData || path.join(homeDir, 'localappdata'), ...LOCALAPPDATA_SUFFIX, 'players', 'profiles')
  const current = activeProfile(engineProfiles, null)
  const dir = path.join(engineProfiles, profile)
  const cfgFile = path.join(dir, 'config.cfg')
  let copiedFrom = null
  if (!fs.existsSync(cfgFile)) {
    const from = [current, PROFILE, '$$$'].find((c) => c && c.toLowerCase() !== profile.toLowerCase() && fs.existsSync(path.join(engineProfiles, c, 'config.cfg')))
    fs.mkdirSync(assertWritable(dir), { recursive: true })
    if (from) { fs.cpSync(path.join(engineProfiles, from), dir, { recursive: true, force: false, errorOnExist: false }); copiedFrom = from }
  }
  // The dvar too, so the in-game menu agrees with the profile.
  try {
    const text = fs.readFileSync(cfgFile, 'utf8')
    if (text.trim()) fs.writeFileSync(assertWritable(cfgFile), mergeConfigCfg(text, [['name', profile]], []))
  } catch {}
  const changed = current !== profile
  fs.writeFileSync(assertWritable(path.join(engineProfiles, 'active.txt')), profile)
  return { changed, profile, previous: current, copiedFrom, dir }
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
export function seedHome({ homeDir = P.home, profile = PROFILE, settings = {}, display = null, localAppData = null, force = false } = {}) {
  const p = configPaths(homeDir, profile, localAppData)
  const prev = seedState(homeDir, profile)
  const exists = fs.existsSync(p.engineCfg) || fs.existsSync(p.profileCfg)
  const reason = !exists ? 'first launch: no config.cfg yet'
    : force ? 'forced'
      : (prev?.version !== BASELINE_VERSION) ? `the ENW baseline changed (${prev?.version ?? 'none'} -> ${BASELINE_VERSION})`
        : null
  if (!reason) return { written: false, reason: 'the player already has a config at this baseline version', paths: p }

  const pairs = baselineDvars(settings, display)
  const fresh = renderConfigCfg(pairs)
  const wrote = []

  // 1. The file the ENGINE actually reads. MERGED, never replaced: it holds the
  //    player's binds and several hundred setas the engine expects to find.
  try {
    fs.mkdirSync(assertWritable(p.engineProfileDir), { recursive: true })
    let text = fresh
    try {
      const existing = fs.readFileSync(p.engineCfg, 'utf8')
      if (existing.trim()) text = mergeConfigCfg(existing, pairs)
    } catch {}
    fs.writeFileSync(assertWritable(p.engineCfg), text)
    wrote.push(p.engineCfg)
    // Only claim the active profile when the engine has not already picked one.
    if (!fs.existsSync(p.engineActiveTxt)) {
      fs.writeFileSync(assertWritable(p.engineActiveTxt), p.engineProfile)
    }
  } catch (e) {
    // Not fatal: a dev run with no LocalAppData redirect has no such tree.
    wrote.push(`(engine profile not written: ${e.message})`)
  }

  // 2. The fs_homepath tree, for a run without the redirect.
  fs.mkdirSync(assertWritable(p.profileDir), { recursive: true })
  fs.mkdirSync(assertWritable(path.join(homeDir, 'main')), { recursive: true })
  fs.writeFileSync(assertWritable(p.profileCfg), fresh)
  fs.writeFileSync(assertWritable(p.plainCfg), fresh)
  fs.writeFileSync(assertWritable(p.activeTxt), profile)
  wrote.push(p.profileCfg, p.plainCfg)

  fs.writeFileSync(assertWritable(p.stamp), JSON.stringify({ version: BASELINE_VERSION, at: new Date().toISOString(), reason, wrote, dvars: Object.fromEntries(pairs), binds: Object.fromEntries(BASELINE_BINDS.map((b) => [b.key, b.command])) }, null, 2))
  return { written: true, reason, paths: p, dvars: pairs, wrote }
}

// ------------------------------------------------------------- migrations --

function readMigrations(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { done: [] } }
}

// One-time rewrite of the aim-down-sights bind in the config the ENGINE reads.
//
// Evidence: the profile the engine is really using is whatever `active.txt` names —
// `$$$` on B's box, not our `enw` — and it held the stock `bind MOUSE2
// "+toggleads_throw"`, i.e. toggle ADS, which is exactly what B reported. `seedHome`
// only rewrites a config once per BASELINE_VERSION, and B's box has already taken
// version 3, so the seed will not revisit it; this does, once.
//
// It only ever replaces the EXACT stock toggle bind. A player who has since bound
// MOUSE2 to anything else — including back to toggle on purpose after our baseline —
// is left alone, because we cannot tell "still stock" from "chose toggle" except by
// the fact that we have never touched this file before, which the marker records.
export function migrateAdsBind({ homeDir = P.home, profile = PROFILE, localAppData = null, log = () => {} } = {}) {
  const NAME = 'ads-hold-2026-09-22'
  const p = configPaths(homeDir, profile, localAppData)
  const m = readMigrations(p.migrations)
  const done = new Set(m.done || [])
  if (done.has(NAME)) return { ran: false, reason: 'already run for this profile', changed: [] }

  const changed = []
  for (const file of [p.engineCfg, p.profileCfg, p.plainCfg]) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    // `bind MOUSE2 "+toggleads_throw"`, quoted or bare, and nothing else.
    const re = /^([ \t]*)bind[ \t]+MOUSE2[ \t]+"?\+toggleads_throw"?[ \t]*$/gim
    if (!re.test(text)) continue
    re.lastIndex = 0
    fs.writeFileSync(assertWritable(file), text.replace(re, '$1bind MOUSE2 "+speed_throw"'))
    changed.push(file)
  }

  done.add(NAME)
  try {
    fs.mkdirSync(assertWritable(path.dirname(p.migrations)), { recursive: true })
    fs.writeFileSync(assertWritable(p.migrations), JSON.stringify({ done: [...done], at: new Date().toISOString() }, null, 2))
  } catch {}

  if (changed.length) {
    log(`aim down sights: rewrote bind MOUSE2 "+toggleads_throw" -> "+speed_throw" in ${changed.join(', ')} — the engine's active profile (${p.engineProfile}) still held the stock TOGGLE bind, which is the toggle-ADS B reported; T4 has no ADS dvar, the bind IS the setting`)
  }
  return { ran: true, changed, profile: p.engineProfile, paths: p }
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
export function readConfig({ homeDir = P.home, profile = PROFILE, localAppData = null } = {}) {
  const p = configPaths(homeDir, profile, localAppData)
  let best = null
  // `engineCfg` first: with the LocalAppData redirect on, it is the only one
  // the game ever writes.
  for (const f of [p.engineCfg, p.profileCfg, p.plainCfg]) {
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

  const volRaw = g(VOLUME_DVAR)
  const vol = Number(volRaw)
  if (volRaw !== undefined && volRaw !== '' && Number.isFinite(vol)) patch.volume = Math.min(1, Math.max(0, vol))

  const fpsHud = g('cg_drawFPS')
  if (fpsHud !== undefined) patch.showFps = fpsHud !== '0' && fpsHud.toLowerCase() !== 'off'

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
// Which dvar each settings key is READ from, so a value coming back out of
// config.cfg can be compared against the one we seeded for the same key.
const SETTING_DVAR = {
  resolution: 'r_mode',
  fov: 'cg_fov',
  maxFps: 'com_maxfps',
  vsync: 'r_vsync',
  volume: VOLUME_DVAR,
  sensitivity: 'sensitivity',
  showFps: 'cg_drawFPS',
  display: 'r_monitor',
}

// The engine's own 2008 defaults, in the engine's own formats, as they appear in the
// untouched `$$$` profile on this box. Used only as the belt to the diff-vs-seed
// braces below.
const STOCK_DEFAULTS = {
  com_maxfps: ['60', '85'],
  cg_fov: ['65'],
  r_mode: ['800x600'],
  r_displayRefresh: ['60 Hz'],
}

export function applyReadBack({ homeDir = P.home, profile = PROFILE, saved = {} } = {}) {
  const cfg = readConfig({ homeDir, profile })
  if (!cfg.found) return { changed: {}, file: null, reason: 'the game wrote no config.cfg' }
  const patch = settingsFromConfig(cfg)
  const ambiguous = patch._modeAmbiguous
  delete patch._modeAmbiguous

  // THE READ-BACK MUST ONLY PERSIST WHAT THE PLAYER CHANGED IN GAME.
  //
  // Evidence: B's account ended up holding `maxFps: 60` and `fov: 65` — the engine's
  // 2008 stock defaults, not anything he picked. Until 0.2.3 the config.cfg we seeded
  // went to a folder the engine never opens (launcher.md 0.2.3 §1), so this function
  // read the engine's untouched profile and dutifully saved ITS defaults into his
  // account; every launch since re-applied them, which is the live "60 FPS" report.
  //
  // CHOSEN APPROACH: **diff against what we seeded**. `seedState()` records the exact
  // dvar pairs written for this home+profile, so a value identical to the one we wrote
  // means the player did not touch it and there is nothing to save. This is exact and
  // has no false positives.
  //
  // FALLBACK, for a home with no stamp (pre-0.2.3, or a profile the engine made on its
  // own): on the FIRST read-back for that profile only, refuse a value that equals a
  // stock 2008 default. First-read-back only, because a player who really does choose
  // 65 FOV later must be believed — and a marker file records that first read.
  const seed = seedState(homeDir, profile)
  const seededDvars = seed?.dvars || null
  const p = configPaths(homeDir, profile)
  const firstReadBack = !fs.existsSync(p.readbackStamp)
  const held = []
  for (const key of Object.keys(patch)) {
    const dvar = SETTING_DVAR[key]
    if (!dvar || !cfg.dvars.has(dvar)) continue
    const raw = cfg.dvars.get(dvar)
    if (seededDvars && seededDvars[dvar] !== undefined && String(seededDvars[dvar]) === String(raw)) {
      held.push(`${key} (${dvar} is still the ${raw} we seeded)`)
      delete patch[key]
      continue
    }
    if (firstReadBack && (STOCK_DEFAULTS[dvar] || []).includes(String(raw))) {
      held.push(`${key} (${dvar} "${raw}" is the engine's stock default on a first read-back)`)
      delete patch[key]
    }
  }
  try {
    fs.mkdirSync(assertWritable(path.dirname(p.readbackStamp)), { recursive: true })
    fs.writeFileSync(assertWritable(p.readbackStamp), JSON.stringify({ at: new Date().toISOString(), file: cfg.file, held }, null, 2))
  } catch {}

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
