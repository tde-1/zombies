// Which exe the launcher starts, and why it is not called CoDWaW.exe (lane DP1, 2026-09-23;
// launcher.md "Discord shows ENW Zombies").
//
// B: when he plays through the launcher, Discord must say "Playing ENW Zombies", never
// "Playing Call of Duty: World at War". What Discord actually does (read from its own client
// code, LocalActivityStore, and watched on B's PC; launcher.md has the sources):
//   * it detects a game by EXE FILE NAME from its detectable list. World at War's entry
//     (application 363412728888557568) is `codwaw.exe` / `codwawmp.exe`, any folder: our dev
//     copies under ZombiesDev\waw-*\ are detected like the Steam one;
//   * an activity set over IPC (ours) is listed BEFORE the detected game, so ours is the
//     primary one ("Playing ENW Zombies" under the name). Resending it changes nothing;
//     there is no "last set wins";
//   * but the detected game is STILL listed as a second activity (profile, popout, Friends
//     "Active Now", Discord's own game panel), unless an IPC activity has the same `name`
//     or Discord links the two applications. The `pid` we send does not hide it.
// So the only way to never show "Call of Duty: World at War" without asking every player to
// change a Discord setting is for Discord not to recognise the process: we start a byte copy
// of our own CoDWaW.exe named ENWZombies.exe. The game does not care what its exe is called
// (SteamStub runs in place because steam_appid.txt is beside it; the DLL is loaded by import
// name, binkw32.dll; nothing in the DLL reads the exe's name).
//
// The copy lives only in OUR folder (`<ENW>\game\`), beside our CoDWaW.exe, never in the
// player's Steam install (hard rule 1). It is refreshed whenever it differs from CoDWaW.exe,
// so the 4 GB flag (setup.js, written into CoDWaW.exe) and "Install it again" reach it at the
// next Play. If the copy cannot be made, the launch falls back to CoDWaW.exe and says so: a
// Play is never refused over a Discord label.
//
// Opt-out: ENW_GAME_EXE=CoDWaW.exe (environment) or `"gameExe": "CoDWaW.exe"` in
// state/config.json.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const STOCK_EXE = 'CoDWaW.exe'
export const ENW_EXE = 'ENWZombies.exe'
// Every image name one of our games (or the player's own World at War) can run under. The
// "already running" checks look for all of them.
export const GAME_IMAGES = [STOCK_EXE, ENW_EXE]

// The name to launch: ENW_EXE unless opted out. Anything else is ignored (never the MP exe,
// never an arbitrary file).
export function exeName({ env = process.env, config = {} } = {}) {
  for (const v of [env.ENW_GAME_EXE, config.gameExe]) {
    const s = String(v || '').trim().toLowerCase()
    if (s === STOCK_EXE.toLowerCase()) return STOCK_EXE
    if (s === ENW_EXE.toLowerCase()) return ENW_EXE
  }
  return ENW_EXE
}

const sha1 = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')

// Make sure `<gameDir>\<name>` is a current copy of `<gameDir>\CoDWaW.exe`.
// -> { exe, name, copied, fallback, reason }
//   exe       the full path to start
//   copied    the copy was (re)written now
//   fallback  the copy could not be made; `exe` is CoDWaW.exe
// Never throws for a copy problem (only fs.existsSync-level problems of the stock exe are
// left to the caller, which already refuses "No game to launch").
export function ensureGameExe(gameDir, name = ENW_EXE, { fsx = fs } = {}) {
  const stock = path.join(gameDir, STOCK_EXE)
  if (name === STOCK_EXE) return { exe: stock, name, copied: false, fallback: false, reason: 'the stock name was asked for' }
  const dst = path.join(gameDir, name)
  const fallback = (why) => ({ exe: stock, name: STOCK_EXE, copied: false, fallback: true, reason: why })
  try {
    if (!fsx.existsSync(stock)) return fallback(`no ${STOCK_EXE} in ${gameDir}`)
    const s = fsx.statSync(stock)
    let same = false
    if (fsx.existsSync(dst)) {
      const d = fsx.statSync(dst)
      same = d.size === s.size && sha1(dst) === sha1(stock)
    }
    if (same) return { exe: dst, name, copied: false, fallback: false, reason: `${name} matches ${STOCK_EXE}` }
    // Write beside it and rename over, so a failed copy never leaves a half exe to start.
    const tmp = `${dst}.tmp-${process.pid}`
    try {
      fsx.copyFileSync(stock, tmp)
      fsx.renameSync(tmp, dst)
    } catch (e) {
      try { fsx.rmSync(tmp, { force: true }) } catch {}
      return fallback(`could not write ${name} (${e.code || e.message}); starting ${STOCK_EXE}, so Discord may also list World at War`)
    }
    return { exe: dst, name, copied: true, fallback: false, reason: `${name} copied from ${STOCK_EXE}` }
  } catch (e) {
    return fallback(`could not check ${name} (${e.code || e.message}); starting ${STOCK_EXE}`)
  }
}

// A WER dump / Windows event names the exe that crashed: either of ours.
export const dumpNamesFor = (pid) => GAME_IMAGES.map((n) => `${n}.${pid}.dmp`)
export const IMAGE_RE = /(?:CoDWaW|ENWZombies)\.exe/i
