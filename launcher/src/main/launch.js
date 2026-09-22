// Launching the game and getting the player onto our server.
//
// The command line is the one from the brief:
//     +set com_introPlayed 1 +set fs_game mods/enw +connect <host>
// plus the settings the account owns (spec 13 §2: settings live in ENW, applied over
// the top at launch, the player's own WaW config never modified) and the handful of
// dvars that make an automated boot survivable.
//
// THE INVITE TOKEN IS NEVER ON THE COMMAND LINE. Any process on the machine can read
// another process's command line (and it lands in logs, crash dumps and screenshots),
// and the token is a bearer credential for a match. It goes over a named pipe; the env
// var is a fallback for a client build that cannot read the pipe yet.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { P, ensureDirs, isInside, protectedRoots, dirOfModule, unpacked } from './paths.js'
import { MOD_NAME } from './setup.js'
import * as lock from './gamelock.js'
import { listDisplays, pickDisplay } from './display.js'
import { baselineDvars, dvarsToArgs, seedHome, applyReadBack, resolveMode, migrateAdsBind, usePlayerProfile, PROFILE } from './gamecfg.js'
import { launchDvars, applyAccountToConfig, readBackAccount } from './wawcfg.js'
import * as settings from './settings.js'

// PACKAGED TRAP: this is handed to powershell.exe, which is not us and cannot read
// inside app.asar. `asarUnpack: ["tools/**"]` in package.json puts a real copy beside
// the archive and `unpacked()` addresses it. Without both, every packaged build loses
// the dialog answering silently — the spawn succeeds and powershell exits 1.
const NANNY = unpacked(path.resolve(dirOfModule(import.meta.url), '..', '..', 'tools', 'window-nanny.ps1'))
const PWSH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

// The boot screen's states, in order (spec 99 §4.3).
export const PHASES = ['reserving', 'loading', 'ready', 'launching', 'in_game', 'ended', 'failed']

// ------------------------------------------------------------- the token pipe --

// A one-shot named pipe. The game connects, we write the token, we close and delete.
// The pipe name is random per launch and passed in ENW_TOKEN_PIPE; the token itself
// never appears in the command line, and (unless the fallback is on) never in the
// environment either.
// The same pipe carries the in-game chat pass (`chat: {base, bearer}`) when there is
// one: the site mints it for the signed-in player (`POST /api/launcher/chat-token`),
// it is good for /api/game-chat/* only, and the DLL's chat overlay reads it here
// (client-dll/components/chat_link.hpp). Either half may be absent -- a Play Local
// game has no invite token and still chats.
export function serveToken(token, { timeoutMs = 120000, chat = null } = {}) {
  const name = `enw-launch-${crypto.randomBytes(8).toString('hex')}`
  const pipePath = `\\\\.\\pipe\\${name}`
  const state = { pipePath, delivered: false, connections: 0, closed: false }

  const server = net.createServer((sock) => {
    state.connections++
    sock.on('error', () => {})
    const line = { v: 0 }
    if (token) line.token = token
    if (chat && chat.base && chat.bearer) line.chat = { base: chat.base, bearer: chat.bearer }
    sock.end(`${JSON.stringify(line)}\n`, () => {
      state.delivered = true
    })
  })
  server.on('error', () => {})
  server.listen(pipePath)

  const timer = setTimeout(() => close(), timeoutMs)
  function close() {
    if (state.closed) return
    state.closed = true
    clearTimeout(timer)
    try { server.close() } catch {}
  }
  // Getters, not a spread of `state`. The first version spread it, which froze
  // `closed` at false forever while `close()` updated the inner object — a pipe that
  // reported itself open long after it had shut. Caught by test/launch-harness.js.
  return {
    pipePath,
    close,
    get delivered() { return state.delivered },
    get connections() { return state.connections },
    get closed() { return state.closed },
  }
}

// ------------------------------------------------------------- the safe-mode marker --

// %LOCALAPPDATA%\Activision\CoDWaW\__CoDWaW is 4 bytes holding the pid of the running
// instance. It survives a crash, and the next launch then shows a modal "Run In Safe
// Mode?" before any logging and blocks forever (dedi, board 00:37). We clear it only
// when the pid inside is dead — never out from under a live game.
export function clearStartupBlockers({ homeDir = P.home, gameDir = P.game } = {}) {
  const notes = []
  // OUR marker, in OUR LocalAppData — the DLL redirect means the game writes it
  // there. The player's own `__CoDWaW` is never read and never deleted: deleting it
  // would be touching their data, and the pid inside it is not ours to judge.
  const marker = path.join(P.localAppData, 'Activision', 'CoDWaW', '__CoDWaW')
  if (fs.existsSync(marker)) {
    let pid = -1
    try { const b = fs.readFileSync(marker); if (b.length === 4) pid = b.readInt32LE(0) } catch {}
    let live = false
    if (pid > 0) { try { process.kill(pid, 0); live = true } catch (e) { live = e.code === 'EPERM' } }
    if (live) {
      return { ok: false, notes, blockedBy: pid, reason: `World at War is already running (process ${pid}). Close it first.` }
    }
    try { fs.unlinkSync(marker); notes.push(`cleared a leftover crash marker (dead process ${pid}) that would have shown "Run In Safe Mode?"`) } catch {}
  }
  for (const root of [homeDir, gameDir, path.join(P.localAppData, 'Activision', 'CoDWaW')]) {
    for (const rel of ['main/safemode.cfg', 'players/safemode.cfg', 'safemode.cfg']) {
      const p = path.join(root, ...rel.split('/'))
      try { if (fs.existsSync(p)) { fs.unlinkSync(p); notes.push(`removed ${p}`) } } catch {}
    }
  }
  return { ok: true, notes }
}

// ------------------------------------------------------------------ arguments --

// The account's settings AND the launch baseline, applied over the top at launch. The
// player's own WaW config is never edited: these are command-line dvars on OUR copy,
// with OUR fs_homepath.
//
// RETRACTED 2026-09-22: this function used to push only `cg_fov`, `com_maxfps`,
// `r_fullscreen`, an empty-by-default `r_mode` and the volume, on the theory that an
// unset dvar means "leave it to the game". It does not. Our fs_homepath is fresh, so
// "the game" means the engine's built-in 2008 defaults — `set r_mode 800x600` and
// `set r_fullscreen 0` are literals in the image, vsync is on, `com_maxfps` is 85 and
// `cg_fov` is 65. B pressed Play and got 800x600 at 60 fps. The baseline is now
// explicit and lives in gamecfg.js, with every value sourced.
//
// 2026-09-22 (web /settings): the account's WaW-menu values (`settings.waw`) are laid over
// the baseline in place by wawcfg.launchDvars(); with none saved it is baselineDvars().
export function settingsArgs(s = {}, display = null) {
  return dvarsToArgs(s && s.waw && Object.keys(s.waw).length ? launchDvars(s, display) : baselineDvars(s, display))
}

// `ENW_BORDERLESS` for the DLL's borderless component, from the EFFECTIVE resolved
// mode — the one `baselineDvars` builds `r_noborder` from, so the env var and the
// command line can never disagree. Exported because the value is the whole of B's
// "borderless is not working": an account block with no `mode` used to discard the
// local `mode: "borderless"` wholesale (settings.js), and a dev window mode must
// never inherit a borderless flag, hence the explicit '0'.
export function borderlessEnv(settings = {}, playerMode = true) {
  return playerMode && resolveMode(settings) === 'borderless' ? '1' : '0'
}

export function buildArgs({
  host = null,
  map = null,
  fsGame = MOD_NAME,
  settings = {},
  display = undefined,
  homeDir = P.home,
  // Whether an invite token is being carried. Only its PRESENCE reaches the command line
  // (as `+exec enw_auth.cfg`); the token itself never does.
  token = null,
  // The player's ENW name, from the signed-in session. `+name` for every launch,
  // including Play Local. See the block where it is pushed for why this is a BELT and
  // not the lock.
  playerName = null,
  stealth = false,
  windowMode = null,
  extra = [],
} = {}) {
  // `stealth: true` is the old spelling of windowMode 'offscreen'.
  windowMode = windowMode || (stealth ? 'offscreen' : 'player')
  const a = []

  // Our own home path: profile, config and console.log land in the ENW folder.
  // (foundation.md §7: this moves main/, not players/ — so we also never write into
  // the player's game folder, only their Activision profile dir, which we do not edit.)
  a.push('+set', 'fs_homepath', homeDir)

  // The three from the brief.
  a.push('+set', 'com_introPlayed', '1')
  // `fsGame = MOD_NAME` only defaults an UNDEFINED argument, and every caller that
  // does not have a custom map passes an explicit null — so the engine was being told
  // `+set fs_game null`. MEASURED 2026-09-21: the game then wrote its console.log to
  // `<fs_homepath>\null\console.log` and loaded no mod at all, which is also exactly
  // where a custom map would have failed to load from.
  a.push('+set', 'fs_game', fsGame || MOD_NAME)

  // Startup dvars that make an unattended boot survivable. These are the launch.ps1
  // set, minus the dev-only ones.
  a.push('+set', 'com_startupIntroPlayed', '1')
  a.push('+set', 'ui_autoContinue', '1')
  a.push('+set', 'cl_allowDownload', '0')
  a.push('+set', 'logfile', '2')

  // The invite token's last mile. `client-dll/components/auth_token.cpp` reads the token
  // off our one-shot pipe in `post_load` — before any engine code — and writes a single
  // line, `setu enw_token "<token>"`, into `<fs_homepath>\main\enw_auth.cfg`; `setu` is
  // the engine's own front door for a USERINFO dvar, which is how the token ends up in
  // the userinfo blob the server reads at SV_DirectConnect. Only the FILENAME is in argv.
  //
  // Both halves are needed and BOTH WERE MISSING here until 2026-09-22 evening: no
  // `ENW_FS_HOMEPATH` (set in the environment below), so the DLL had nowhere to write the
  // file and said so — `Token NOT installed` — and no `+exec`, so nothing would have read
  // it anyway. `tools/dev/launch.ps1` has done both since the component landed, which is
  // why every proof so far went through the dev harness and none through the launcher.
  if (token) a.push('+exec', 'enw_auth.cfg')

  // ---- the ENW name (B, 2026-09-23) --------------------------------------------------
  //
  // "Right now it says Unknown Soldier, which is annoying." That string is the ENGINE's
  // stock default for the `name` dvar, and the reason every player had it is simply that
  // nothing ever passed `+name`. This is that line.
  //
  // Local games too, deliberately: a Play Local run never reaches a server, so the
  // server-side lock cannot apply, and this is the only thing standing between the
  // player and "Unknown Soldier" on their own screen.
  //
  // **It is a belt, not the lock.** `+name` runs in the player's own process and anybody
  // can pass a different one, or change it in the console. What stops a spoof is the
  // referee overwriting the SERVER's copy of the userinfo with the invite token's name
  // (`server/components/referee/name_lock.cpp`); this only makes the honest case right.
  //
  // Quoted as one argv entry by the spawn, never shell-interpolated. Backslashes and
  // quotes are stripped because the engine's infostring is backslash-delimited and a
  // name carrying one would split the key/value pairs; `Info_SetValueForKey` strips them
  // server-side too, so this only keeps the two sides agreeing.
  const enwName = String(playerName || '').replace(/[\\";]/g, '').trim().slice(0, 31)
  if (enwName) a.push('+set', 'name', enwName)

  // Three window modes, and the difference matters more than it looks.
  //
  //   'player'    the player's own settings. What ships.
  //   'small'     windowed 800x600 and muted, ON SCREEN. dev-box rule 6 without the
  //               off-screen part.
  //   'offscreen' 'small' plus parked at -4000,-4000 and never focused.
  //
  // **Prefer 'small' over 'offscreen' for anything that has to run for more than a
  // minute.** The referee measured the game's tick stopping at 65.2 s, twice, when its
  // window was off-screen and unfocused — Windows throttles it and it looks exactly
  // like a crash at the one-minute mark. foundation is fixing it in the DLL; until
  // then, a run that needs a live game needs a window on the screen.
  if (windowMode === 'offscreen' || windowMode === 'small') {
    a.push('+set', 'r_fullscreen', '0', '+set', 'r_mode', '800x600')
    a.push('+set', 'snd_volume', '0', '+set', 'snd_menu_master', '0')
    if (windowMode === 'offscreen') {
      a.push('+set', 'vid_xpos', '-4000', '+set', 'vid_ypos', '-4000')
    } else {
      // Bottom-right, out of the way of whatever B is doing, but on screen.
      a.push('+set', 'vid_xpos', '40', '+set', 'vid_ypos', '40')
    }
  } else {
    // `display === undefined` means "work it out"; `null` means "we know there is no
    // display information", which is what the test harness and a headless CLI pass.
    const d = display === undefined ? pickDisplay(listDisplays(), settings.display) : display
    a.push(...settingsArgs(settings, d))
  }

  a.push(...extra.filter(Boolean))

  // Last, because the engine runs +commands in order and connecting should be the
  // final thing it does.
  // `+map` is a LOCAL game. With a host to join, the map name is still needed — it is
  // what CL_ConnectLocal is called with — but it travels in the environment, and putting
  // it on the command line as well would boot the map on the player's own PC first.
  if (map && !host) a.push('+map', map)
  // `+connect <host>` USED TO BE HERE AND IT NEVER WORKED. Left as a retraction rather
  // than a silent deletion, because it looked right for weeks and cost tonight's first
  // real run: `CoDWaW.exe` is the SINGLE-PLAYER exe and `connect` is not one of its
  // client commands — only the server's out-of-band name (docs/re/t4-sp-map.md §5). The
  // game answers the line in its own console:
  //
  //     Unknown command "connect"
  //
  // …and then sits in the menu logging `Failed to log on.` forever, which reads exactly
  // like a network problem and is not one. Joining is armed through the ENVIRONMENT
  // instead — ENW_CLIENT_CONNECT + ENW_CONNECT_ADDR, see `connectEnv()` below — which is
  // what `tools/dev/jointest.ps1` and `infra/vps/join-remote.ps1` have always done.
  return a
}

/**
 * How a client actually joins a server, as three environment variables.
 *
 *   ENW_CLIENT_CONNECT=<map>   arms client-dll/components/connect_local.cpp, which calls
 *                              CL_ConnectLocal(map, 0) once from the frame tick. That
 *                              function hard-codes the string "localhost"…
 *   ENW_CONNECT_ADDR=<h:port>  …so shared/core/components/connect_address.cpp rewrites the
 *                              pushed "localhost" to the real address. This is the only
 *                              route to a remote box.
 *   ENW_RAW_SOCKETS=1          Sys_SendPacket otherwise routes through Demonware's
 *                              bdSocketRouter, which drops every packet with addrHandle=0
 *                              (dedi.md §7f wall 2). Both halves of a join need it.
 *
 * A local game passes no host and gets none of this, so solo play keeps stock behaviour.
 */
export function connectEnv({ host, map }) {
  if (!host) return {}
  if (!map) throw new Error('joining a server needs the map name: CL_ConnectLocal takes one')
  return { ENW_CLIENT_CONNECT: map, ENW_CONNECT_ADDR: host, ENW_RAW_SOCKETS: '1' }
}

// --------------------------------------------------------------------- launch --

export class GameLaunch extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.opts = opts
    this.phase = null
    this.pids = new Set()
    this.dialogs = []
    this.notes = []
    this.tokenPipe = null
    this.nanny = null
    this.child = null
    this.lockName = opts.lockName || 'launcher'
    this.holdsLock = false
    this.ended = false
  }

  setPhase(phase, detail) {
    this.phase = phase
    this.emit('phase', { phase, detail, at: Date.now() })
  }

  note(text) {
    this.notes.push(text)
    this.emit('note', text)
  }

  async start() {
    const o = this.opts
    const gameDir = o.gameDir || P.game
    const exe = path.join(gameDir, 'CoDWaW.exe')
    const homeDir = o.homeDir || P.home

    // Rule 1, enforced here too rather than trusted: we never RUN out of the player's
    // install either, because running implies writing (console.log, configs).
    for (const root of protectedRoots()) {
      if (isInside(exe, root)) throw new Error(`Refusing to launch out of ${root}. ENW runs its own copy.`)
    }
    if (!fs.existsSync(exe)) throw new Error(`No game to launch at ${exe}. Run setup first.`)
    if (path.basename(exe).toLowerCase() === 'codwawmp.exe') throw new Error('ENW never launches the multiplayer executable.')

    ensureDirs()
    // Pre-create both places the engine may open console.log in. foundation measured
    // that a missing <fs_homepath>\main gave no console log at all, and with fs_game
    // set the engine uses the mod folder instead (see watchConsoleLog).
    fs.mkdirSync(path.join(homeDir, 'main'), { recursive: true })
    // NOT an unconditional recursive mkdir. An installed custom map's mod folder is a
    // JUNCTION into the ENW map library, and `fs.mkdirSync(<junction>, {recursive:true})`
    // throws ENOENT on Windows rather than treating it as an existing directory — it
    // failed the first launch of a custom map outright. existsSync follows the link, so
    // check first and only create what is genuinely absent.
    const modDir = path.join(homeDir, ...String(o.fsGame || MOD_NAME).split('/'))
    if (!fs.existsSync(modDir)) fs.mkdirSync(modDir, { recursive: true })

    // The dev-box lock. A player's machine has none and this is a no-op.
    if (o.useGameLock !== false) {
      const got = lock.acquire(this.lockName, o.why || 'launcher: play')
      if (!got.ok) throw new Error(got.reason)
      this.holdsLock = lock.enabled()
      if (got.reason) this.note(got.reason)
    }

    try {
      const blockers = clearStartupBlockers({ homeDir, gameDir })
      if (!blockers.ok) throw new Error(blockers.reason)
      for (const n of blockers.notes) this.note(n)

      // Seed the home folder so the in-game settings MENU shows the same values we
      // launch with. `+set` alone leaves the menu lying: the player opens Video, sees
      // the 2008 defaults, and the first thing they change writes those back.
      // seedHome() writes only on a first launch or a baseline-version bump -- once
      // the player has a config, the game owns it and we only ever read it.
      const display = o.display === undefined ? pickDisplay(listDisplays(), o.settings?.display) : o.display
      this.display = display
      // THE effective mode, resolved ONCE, from the same settings object the command
      // line is built from. `o.settings` is `settings.get()`, which since 2026-09-22
      // layers defaults <- this computer <- the account and lets no layer shadow a key
      // it does not define (settings.js): B's account block carries no `mode` at all,
      // and before that fix the whole local block — `mode: "borderless"` included —
      // was discarded the moment he signed in. Everything below reads this, so the
      // env var, `+set r_noborder` and the seeded config.cfg can never disagree.
      this.effectiveMode = resolveMode(o.settings || {})
      // Dev window modes are left exactly as they were: 'small' and 'offscreen' force
      // 800x600 muted on the command line, and seeding a config.cfg (or reading one
      // back) from a dev run would put 800x600 into the player's account.
      this.playerMode = (o.windowMode || (o.stealth ? 'offscreen' : 'player')) === 'player'
      // The in-game name is the PROFILE's name, not the `name` dvar (0.2.10; gamecfg.js
      // usePlayerProfile). Before the seed, so the seed and the read-back follow it.
      if (this.playerMode) {
        try {
          const pr = usePlayerProfile({ homeDir, name: o.playerName || settings.session().name || '' })
          if (pr.profile && pr.changed) this.note(`player profile: now '${pr.profile}' (was '${pr.previous ?? 'none'}'${pr.copiedFrom ? `, binds and settings copied from '${pr.copiedFrom}'` : ''}) -- World at War shows the profile's name in game`)
          else if (!pr.profile) this.note(`player profile: ${pr.reason}`)
        } catch (e) {
          this.note(`player profile: could not switch to the ENW name (${e.message}); the game will show the current profile's name`)
        }
      }
      try {
        if (!this.playerMode) throw new Error('dev window mode: no baseline is seeded')
        const seed = seedHome({ homeDir, profile: o.profile || PROFILE, settings: o.settings || {}, display, force: !!o.reseed })
        if (seed.written) this.note(`wrote the ENW settings baseline into ${seed.paths.profileCfg} (${seed.reason})`)
        // One-time, and only when the config still holds the exact stock toggle bind.
        // seedHome() will not revisit a config at the current BASELINE_VERSION, so a
        // box that already took version 3 (B's) needs this to reach the toggle-ADS
        // bind sitting in the engine's own `$$$` profile.
        const ads = migrateAdsBind({ homeDir, profile: o.profile || PROFILE, log: (m) => this.note(m) })
        if (ads.ran && !ads.changed.length) this.note(`aim down sights: the bind is not the stock toggle one, so it was left alone (profile ${ads.profile})`)
        // The account's settings from the site's Settings page (WaW's Options menus),
        // merged into the config.cfg the engine reads on EVERY launch, so the in-game
        // menu shows them too. wawcfg.js says why this is not seed-once.
        const acct = applyAccountToConfig({ homeDir, profile: o.profile || PROFILE, settings: o.settings || {}, display })
        if (acct.wrote.length) this.note(`applied ${acct.pairs.length} account setting${acct.pairs.length === 1 ? '' : 's'}${acct.resets.length ? `, ${acct.resets.length} game default${acct.resets.length === 1 ? '' : 's'}` : ''} and ${Object.keys(acct.binds).length} bind${Object.keys(acct.binds).length === 1 ? '' : 's'} to ${acct.wrote[0]}`)
      } catch (e) {
        this.note(`could not write the settings baseline (${e.message}); the game will use its own config`)
      }

      const args = buildArgs({
        host: o.host,
        map: o.map,
        token: o.token || null,
        // Every launch carries the ENW name, without every caller having to remember:
        // it is a property of WHO IS SIGNED IN, not of this particular Play button.
        // `session().name` is what the site answered at sign-in (`users.pub().name`,
        // which is `enw_name` first), so an account that has picked gets its handle and
        // one that has not gets nothing rather than something invented.
        playerName: o.playerName || settings.session().name || null,
        fsGame: o.fsGame,
        settings: o.settings,
        display,
        homeDir,
        stealth: !!o.stealth,
        windowMode: o.windowMode || null,
        extra: o.extraArgs || [],
      })

      // The same name `buildArgs` put on the command line, sanitised the same way, so
      // the argv and the environment can never disagree about who this player is.
      const enwName = String(o.playerName || settings.session().name || '')
        .replace(/[\\";]/g, '').trim().slice(0, 31)

      // Environment: game-link v0 (ENW_HOST/INSTANCE/ROLE) plus the SteamStub hints,
      // without which a copied exe exits(0) after ~1.5 s (dedi, board 00:35).
      const env = {
        ...process.env,
        SteamAppId: '10090',
        SteamGameId: '10090',
        ENW_INSTANCE: o.instance || 'launcher',
        ENW_ROLE: o.role || 'client',
        ENW_LOGDIR: P.logs,
        // The LocalAppData redirect (client-dll/components/enw_localappdata.cpp).
        // Without this the engine puts profiles, config.cfg, saves, the mods list
        // and its own map-exists check in the PLAYER'S
        // %LOCALAPPDATA%\Activision\CoDWaW. With it all of that is ours, and
        // vanilla World at War sees nothing we did.
        ENW_LOCALAPPDATA: P.localAppData,
        // Where auth_token.cpp writes `main\enw_auth.cfg`. It has to be the SAME folder
        // the engine will exec from, i.e. the `fs_homepath` on the command line.
        ENW_FS_HOMEPATH: homeDir,
        // The player's ENW name, for the DLL's `name_pin` component. The command line
        // already carries `+set name`, which is what fixes the boot; this is what lets
        // the DLL put it BACK if something in game changes it. Same value, two places,
        // deliberately — the command line is read once and the environment is readable
        // for the life of the process. Belt only: the lock is the referee's.
        ...(enwName ? { ENW_PLAYER_NAME: enwName } : {}),
        // The map, so the DLL can say `map_loaded` without reading a dvar. It also
        // takes it off our command line, and this is the belt to that braces.
        ...(o.map ? { ENW_MAP: o.map } : {}),
        // The IW4MAdmin-shaped event mirror into the game's own console.log. It is
        // the only channel that works when the socket does not, and it is what turns
        // "the launcher says nothing happened" into a file with the round numbers in
        // it. The dvar that is supposed to control it cannot be read yet.
        ENW_LOGPRINT: o.logprint === false ? '0' : '1',
        // The DLL's borderless component (client-dll/components/borderless.cpp) takes
        // either this or a text-matched `+set r_noborder 1` on the command line, and
        // reads its geometry from the LAST `r_mode` / `vid_xpos` / `vid_ypos` on the
        // line. We pass both switches: the env var is unambiguous, and `r_noborder`
        // is what a future engine or a Plutonium-style client would read. In a dev
        // window mode it is explicitly '0' rather than absent, so a dev run can never
        // inherit a borderless flag from somewhere else.
        ENW_BORDERLESS: borderlessEnv(o.settings || {}, this.playerMode),
        // The DLL's raw-input mouse (mouse_polling.cpp reads `ENW_RAW_MOUSE=0` as off).
        // Only an explicit "off" in the account turns it off; the default stays the DLL's.
        ...(o.settings && o.settings.rawMouse === false ? { ENW_RAW_MOUSE: '0' } : {}),
        // Joining a server. Empty for a local game.
        ...connectEnv({ host: o.host, map: o.map }),
      }
      // Only point the game-link somewhere when there is something to point it at.
      // A local game has no host agent, and the DLL's documented behaviour for an
      // absent ENW_HOST is to stay dormant — better than 20 failed connects and a
      // backoff ladder in the log of every offline game.
      if (o.linkHost) env.ENW_HOST = o.linkHost
      else delete env.ENW_HOST

      // The token (and the chat pass). Pipe first; env only if explicitly allowed.
      const chat = o.chat && o.chat.base && o.chat.bearer ? o.chat : null
      if (o.token || chat) {
        this.tokenPipe = serveToken(o.token || null, { chat })
        env.ENW_TOKEN_PIPE = this.tokenPipe.pipePath
        if (chat) this.note('in-game chat pass offered over the same private pipe')
      }
      if (o.token) {
        if (o.tokenViaEnv) {
          env.ENW_TOKEN = o.token
          this.note('invite token passed in the environment (fallback) — never on the command line')
        } else {
          this.note(`invite token offered over a private pipe (${this.tokenPipe.pipePath}) — never on the command line`)
        }
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outLog = path.join(P.logs, `${stamp}-stdout.log`)
      const errLog = path.join(P.logs, `${stamp}-stderr.log`)
      const out = fs.openSync(outLog, 'a')
      const err = fs.openSync(errLog, 'a')

      const spawnAt = Date.now()
      this.setPhase('launching', `starting ${path.basename(exe)}`)
      this.child = spawn(exe, args, {
        cwd: gameDir,
        env,
        stdio: ['ignore', out, err],
        windowsHide: false,
        detached: false,
      })
      this.pids.add(this.child.pid)
      this.commandLine = `"${exe}" ${args.join(' ')}`
      this.emit('spawn', { pid: this.child.pid, exe, args, commandLine: this.commandLine, stdout: outLog, stderr: errLog })
      if (this.holdsLock) {
        lock.update(this.lockName, this.child.pid, o.why || 'launcher: play')
        this.startLockHeartbeat(o.why || 'launcher: play')
      }

      this.child.on('exit', (code, signal) => {
        this.emit('exit', { pid: this.child?.pid, code, signal })
        this.finish('ended', `the game exited (code ${code ?? signal})`)
      })
      this.child.on('error', (e) => {
        this.emit('error', e)
        this.finish('failed', e.message)
      })

      this.startNanny(spawnAt)
      this.watchConsoleLog(homeDir)
      return { pid: this.child.pid, commandLine: this.commandLine, args, stdout: outLog, stderr: errLog }
    } catch (e) {
      this.releaseLock()
      throw e
    }
  }

  // The dialog nanny. Answering "Set Optimal Settings?" is what turns a launch into a
  // game — every unattended run before it existed sat on that box forever.
  startNanny(spawnAt) {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', NANNY,
      '-WatchPids', String(this.child.pid),
      '-SinceUnixMs', String(spawnAt),
      '-Seconds', String(this.opts.nannySeconds || 300),
    ]
    if ((this.opts.windowMode || (this.opts.stealth ? 'offscreen' : 'player')) === 'offscreen') args.push('-Park')
    const n = spawn(PWSH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.nanny = n
    let buf = ''
    n.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        this.onNannyEvent(ev)
      }
    })
    n.stderr.on('data', (d) => this.emit('nanny_stderr', d.toString()))
    n.on('error', () => this.note('could not start the dialog helper; a Windows dialog may need a click'))
  }

  onNannyEvent(ev) {
    this.emit('nanny', ev)
    if (ev.t === 'adopt') {
      // SteamStub relaunched the game under a new pid. Track it so we can stop only
      // our own processes later (dev-box.md rule 4).
      this.pids.add(ev.pid)
      this.note(`Steam restarted the game as process ${ev.pid}`)
      if (this.holdsLock) lock.update(this.lockName, ev.pid, this.opts.why || 'launcher: play')
    } else if (ev.t === 'dialog') {
      this.dialogs.push(ev)
      const friendly = /optimal/i.test(ev.title)
        ? 'World at War asked to change your graphics settings; ENW answered No and kept yours.'
        : /safe mode/i.test(ev.title)
          ? 'World at War offered safe mode after its last crash; ENW answered No and started normally.'
          : `Answered a World at War dialog ("${ev.title}") with ${ev.answered}.`
      this.note(friendly)
      this.emit('dialog', { ...ev, friendly })
    } else if (ev.t === 'all_gone') {
      this.finish('ended', 'the game closed')
    }
  }

  // Follow the engine's own console.log to know when the map is up. This is the same
  // file foundation reads; it is the only signal available until the DLL's game-link
  // reports map_loaded.
  // Follow the engine's own console.log to know what the game is doing.
  //
  // TWO THINGS THAT COST A RUN EACH, both worth keeping written down:
  //
  //  1. **With `fs_game` set, the engine writes `console.log` under the MOD folder,
  //     not `main/`.** `<fs_homepath>\mods\enw\console.log` had 12,813 lines while
  //     `<fs_homepath>\main\console.log` sat at 0 bytes. Anything watching only
  //     `main\console.log` (tools/dev/launch.ps1 does) sees nothing whenever a mod is
  //     loaded — which for us is always. So we watch both and take whichever grows.
  //  2. **Never truncate it.** The first version wrote '' to get a clean read, after
  //     the engine had already opened the file; every subsequent line went past the
  //     truncation point and the file stayed empty for a whole 60 s run. Record the
  //     starting length instead.
  watchConsoleLog(homeDir) {
    const candidates = [
      path.join(homeDir, ...String(this.opts.fsGame || MOD_NAME).split('/'), 'console.log'),
      path.join(homeDir, 'main', 'console.log'),
    ]
    const pos = new Map()
    for (const f of candidates) {
      let n = 0
      try { n = fs.statSync(f).size } catch {}
      pos.set(f, n)
    }
    const tick = () => {
      if (this.ended) return
      for (const file of candidates) {
        try {
          const st = fs.statSync(file)
          let from = pos.get(file)
          // THE ENGINE TRUNCATES console.log ON EVERY LAUNCH ("logfile opened on …" is
          // always line 1). Remembering the previous run's length and reading forward
          // therefore skips the whole of this run: a launch that really did reach
          // `AUTOSAVE_LEVELSTART` at line 7,587 was reported as "no map yet" because
          // 7,587 lines was still fewer bytes than the file had before. A file that
          // has shrunk has been rewritten — start again from the beginning.
          if (st.size < from) { from = 0; pos.set(file, 0) }
          if (st.size <= from) continue
          const fd = fs.openSync(file, 'r')
          const buf = Buffer.alloc(st.size - from)
          fs.readSync(fd, buf, 0, buf.length, from)
          fs.closeSync(fd)
          pos.set(file, st.size)
          if (!this._logSource) { this._logSource = file; this.note(`reading the game's own log at ${file}`) }
          for (const line of buf.toString('latin1').split(/\r?\n/)) {
            if (line.trim()) this.onConsoleLine(line)
          }
        } catch {}
      }
      this._logTimer = setTimeout(tick, 400)
    }
    tick()
  }

  // The lines that actually mean something, verified against a real 12,813-line run of
  // nazi_zombie_prototype. "Loading fastfile <x>" is NOT one of them: the engine loads
  // a dozen (code_post_gfx, ui, common, patch…) long before any map, so matching it
  // reports a map that is not there yet.
  onConsoleLine(line) {
    this.emit('console', line)
    if (/^Server:\s*(\S+)/i.test(line)) {
      this.mapName = line.match(/^Server:\s*(\S+)/i)[1]
      this.sawServer = true
      this.setPhase('loading', `the server is bringing up ${this.mapName}`)
      this.checkMapUp(line)
    } else if (/Loading fastfile 'mod'/i.test(line)) {
      // dedi's marker: the mod ZONE loaded. If this never appears, the map is
      // installed somewhere World at War does not look — the commonest failure and
      // the one that looks like a broken map.
      this.note('the map mod loaded (Loading fastfile \'mod\')')
      this.sawMod = true
    } else if (/Waited .* for asset 'maps\/.*\.d3dbsp'/i.test(line) || /^LOADING\.\.\.\s*maps\//i.test(line)) {
      this.sawBsp = true
      this.setPhase('loading', line.trim().slice(0, 120))
      this.checkMapUp(line)
    } else if (/AUTOSAVE_LEVELSTART/i.test(line)) {
      this.sawAutosave = true
      this.checkMapUp(line)
    } else if (/enw_t4 (online|ready|loaded)/i.test(line)) {
      this.note('the ENW client is running inside the game')
    } else if (/Connecting to/i.test(line)) {
      this.setPhase('launching', line.trim().slice(0, 120))
    }
  }

  // "The map is up" needs a signal that works for stock AND custom maps.
  // `AUTOSAVE_LEVELSTART` is the cleanest but zombies-specific and not every custom
  // map reaches it; the pair (`Server: <map>` + the map's own `.d3dbsp` loading) is
  // what actually means the level is in. Either is enough.
  checkMapUp(line) {
    if (this.mapUp) return
    if (!this.sawAutosave && !(this.sawServer && this.sawBsp)) return
    this.mapUp = true
    this.emit('map_up', { map: this.mapName || null, line: String(line).trim() })
    this.setPhase('in_game', `the map is up${this.mapName ? `: ${this.mapName}` : ''}`)
  }

  // The silent failure dedi found, named. A custom map installed anywhere but
  // %LOCALAPPDATA%\Activision\CoDWaW\mods mounts its .iwd files and shows up in the
  // printed search path, so everything LOOKS right — but `mod.ff` is a zone, never
  // loads, and `+map` quietly does nothing. The tell is that `Loading fastfile 'mod'`
  // never appears. Anyone debugging this without knowing blames the map.
  diagnose() {
    const custom = this.opts.fsGame && this.opts.fsGame !== MOD_NAME
    if (!custom) return null
    if (this.sawMod) return null
    return {
      problem: 'the map mod never loaded',
      why: "World at War loads a custom map's mod only from %LOCALAPPDATA%\Activision\CoDWaW\mods. " +
        'Anywhere else the .iwd files still mount and the search path still looks right, but ' +
        "`Loading fastfile 'mod'` never happens and the map silently does not start.",
      check: this.opts.installDir || null,
    }
  }

  // Only ever stops processes we started or adopted (dev-box.md rule 4).
  stop(reason = 'stopped by the launcher') {
    for (const pid of this.pids) {
      try { process.kill(pid) } catch {}
    }
    this.finish('ended', reason)
  }

  // Spec §4.3 round trip: after the game exits, read config.cfg back out of our
  // fs_homepath so an in-game change is what the NEXT launch uses.
  //
  // Read-after-exit, not read-while-running: the engine writes the file on shutdown,
  // so anything read earlier is the previous run's (client.md §2b). And only keys the
  // game actually wrote come back -- a saved value is never overridden by a default.
  readBackSettings() {
    if (this.opts.readBack === false || !this.playerMode) return null
    try {
      const r = applyReadBack({
        homeDir: this.opts.homeDir || P.home,
        profile: this.opts.profile || PROFILE,
        saved: this.opts.settings || {},
      })
      // The WaW-menu settings (web /settings): what the player changed in game relative
      // to what this launch wrote. It wins over the older read-back for the same key,
      // because it compares against this launch rather than against the first seed.
      try {
        const acct = readBackAccount({ homeDir: this.opts.homeDir || P.home, profile: this.opts.profile || PROFILE })
        if (Object.keys(acct.changed).length) r.changed = { ...(r.changed || {}), ...acct.changed }
      } catch (e) {
        this.note(`could not read the account settings back (${e.message})`)
      }
      this.readBack = r
      const n = Object.keys(r.changed || {}).length
      if (n) this.note(`the player changed ${n} setting${n === 1 ? '' : 's'} in game; saving them to the account (${Object.keys(r.changed).join(', ')})`)
      this.emit('settings_readback', r)
      return r
    } catch (e) {
      this.note(`could not read the game's settings back (${e.message})`)
      return null
    }
  }

  finish(phase, detail) {
    if (this.ended) return
    this.ended = true
    clearTimeout(this._logTimer)
    this.readBackSettings()
    try { this.tokenPipe?.close() } catch {}
    try { this.nanny?.kill() } catch {}
    this.releaseLock()
    this.setPhase(phase, detail)
    this.emit('finished', { phase, detail, dialogs: this.dialogs, notes: this.notes })
  }

  // Keep the shared lock alive for as long as OUR game is. See gamelock.heartbeat():
  // a lock goes stale after 15 minutes and a real game runs for hours, so without this
  // another agent would rightly take it mid-game.
  startLockHeartbeat(why) {
    clearInterval(this._lockTimer)
    this._lockTimer = setInterval(() => {
      if (this.ended || !this.holdsLock) return
      const livePid = [...this.pids].find((p) => { try { process.kill(p, 0); return true } catch (e) { return e.code === 'EPERM' } })
      if (!livePid) return
      const r = lock.heartbeat(this.lockName, livePid, why)
      if (r.action === 'restored' || r.action === 'taken_by_other') this.note(r.detail)
      if (r.action === 'taken_by_other') this.emit('lock_conflict', r)
    }, 60_000)
    this._lockTimer.unref?.()
  }

  releaseLock() {
    clearInterval(this._lockTimer)
    if (!this.holdsLock) return
    this.holdsLock = false
    const r = lock.release(this.lockName)
    if (r.released) this.note('released the shared game lock')
    else if (r.reason) this.note(`game lock: ${r.reason}`)
  }
}

export function launch(opts) {
  const l = new GameLaunch(opts)
  return { launch: l, started: l.start() }
}
