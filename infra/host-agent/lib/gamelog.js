// Optional second output: a Call-of-Duty-shaped `games_mp.log` per instance.
//
// WHY, when we already have a perfectly good socket protocol: every existing CoD server
// tool reads the game log. IW4MAdmin (MIT) ships a Plutonium T4 CO-OP/Zombies parser and
// a `feature/zombie-stats` schema that is nearly our data model, and its GSC↔backend
// convention is `LogPrint("PREFIX;field;field")` lines into that log plus dvar polling —
// rcon-independent, and the only outbound channel T4 has natively (libcod does not
// support WaW). See vault Research/R12 §5b.
//
// Emitting it costs us a few hundred bytes a minute and buys:
//   * IW4MAdmin, B3-grammar tools and log tailers can read our servers unmodified;
//   * an ENW referee could later ship as an IW4MAdmin plugin without changing the game side;
//   * a human-readable second record when a replay is being argued about.
//
// It is NOT evidence. The signed replay is the evidence; this file is unsigned, plain text
// and trivially editable. Nothing in the host reads it back.
//
// GRAMMAR. The `J;`/`Q;`/`K;`/`D;`/`say;`/`InitGame:`/`ExitLevel:` lines follow B3's
// canonical cod5 grammar (b3/parsers/cod5.py), which is what IW4MAdmin's T4 parser
// expects. The zombies-specific lines carry a configurable PREFIX in IW4MAdmin's
// semicolon shape; the default is `ENWZombie` because their T4ZM stat emitter is a closed
// premium plugin whose exact prefixes we cannot match, and inventing lines under theirs
// would be worse than being distinct. The referee agent has proposed `GSE` (IW4MAdmin's
// generic game-script-event prefix) for the DLL side — whichever wins, both halves must
// use the same string, so it is one option here rather than a literal.
import fs from 'node:fs'
import path from 'node:path'
import { mkdirp } from './util.js'

const clean = (s) => String(s ?? '').replace(/[;\r\n]/g, ' ')

export class GameLog {
  constructor({ file, enabled = true, prefix = 'ENWZombie' }) {
    this.enabled = enabled
    this.file = file
    // The zombies-line prefix. Configurable because the referee agent has proposed `GSE`
    // (IW4MAdmin's own game-script-event prefix) for the DLL side — the two halves must
    // agree, and whichever we settle on, both ends use this one string. See the board.
    this.p = prefix
    if (!enabled) return
    mkdirp(path.dirname(file))
    this.fd = fs.openSync(file, 'a')
    this.t0 = null
  }

  stamp(ms) {
    if (this.t0 == null) this.t0 = ms || 0
    const s = Math.max(0, Math.round(((ms ?? 0) - this.t0) / 1000))
    return `${String(Math.floor(s / 60)).padStart(3, ' ')}:${String(s % 60).padStart(2, '0')}`
  }

  write(ms, line) {
    if (!this.enabled) return
    try { fs.writeSync(this.fd, `${this.stamp(ms)} ${line}\n`) } catch { /* log only */ }
  }

  /** Translate one game-link event into its log-grammar line, where one exists. */
  onEvent(ev, ref) {
    if (!this.enabled) return
    const p = (slot) => ref?.players?.get(slot)
    const guid = (slot) => clean(p(slot)?.steamid || `slot${slot}`)
    const name = (slot) => clean(p(slot)?.name || `slot${slot}`)
    switch (ev.t) {
      case 'map_loaded':
        this.t0 = ev.ms ?? 0
        this.write(ev.ms, `InitGame: \\g_gametype\\zombies\\mapname\\${clean(ev.map)}\\fs_game\\${clean(ev.fs_game || '')}\\sv_maxclients\\${ev.sv_maxclients ?? 4}\\protocol\\1\\shortversion\\1.7`)
        break
      case 'player_connect':
        this.write(ev.ms, `J;${clean(ev.steamid || ev.xuid || '')};${ev.slot};${clean(ev.name)}`)
        break
      case 'player_disconnect':
        this.write(ev.ms, `Q;${guid(ev.slot)};${ev.slot};${name(ev.slot)}`)
        break
      case 'chat':
        this.write(ev.ms, `say;${guid(ev.slot)};${ev.slot};${name(ev.slot)};${clean(ev.text)}`)
        break
      case 'round':
        this.write(ev.ms, `${this.p};round;${ev.n}`)
        break
      case 'down':
        this.write(ev.ms, `${this.p};down;${guid(ev.slot)};${ev.slot}`)
        break
      case 'revive':
        this.write(ev.ms, `${this.p};revive;${guid(ev.slot)};${ev.slot};${ev.by != null ? guid(ev.by) : ''}`)
        break
      case 'bleedout':
        // D;/K; is the damage/kill grammar; a bleedout is the zombies equivalent of a death.
        this.write(ev.ms, `K;${guid(ev.slot)};${ev.slot};allies;${name(ev.slot)};;-1;axis;zombie;none;0;MOD_UNKNOWN;none`)
        this.write(ev.ms, `${this.p};bleedout;${guid(ev.slot)};${ev.slot}`)
        break
      case 'points':
        this.write(ev.ms, `${this.p};points;${guid(ev.slot)};${ev.slot};${ev.score};${ev.delta ?? ''};${clean(ev.why || '')}`)
        break
      case 'notify':
        this.write(ev.ms, `${this.p};notify;${clean(ev.ent || 'level')};${clean(ev.name)}${ev.args ? ';' + clean(JSON.stringify(ev.args)) : ''}`)
        break
      case 'level_var':
        this.write(ev.ms, `${this.p};level_var;${clean(ev.name)};${clean(ev.value)}`)
        break
      case 'dvar':
        this.write(ev.ms, `${this.p};dvar;${clean(ev.name)};${clean(ev.value)}`)
        break
      case 'game_mode':
        // The map's own mode menu, answered by the server (game-modes.md).
        this.write(ev.ms, `${this.p};game_mode;${clean(ev.state)};${clean(ev.mode || '')};${clean(ev.menu || '')};${clean(ev.response || ev.note || '')}`)
        break
      case 'game_over':
        this.write(ev.ms, `${this.p};game_over;${ev.round ?? ''};${clean(ev.reason || '')}`)
        this.write(ev.ms, 'ExitLevel: executed')
        break
      default: break   // snap / input / perf / hello / reply have no log-grammar line
    }
  }

  /** One final line carrying the whole summary, so a tailer needs no other source. */
  onSummary(s) {
    if (!this.enabled) return
    this.write(s.duration_ms, `${this.p};match;${clean(s.match_id)};${clean(s.map)};${s.rounds};${clean(s.finish?.kind || 'none')};${s.duration_ms};${s.player_count};${clean(s.flags.join('+') || 'none')}`)
    for (const p of s.players) {
      this.write(s.duration_ms, `${this.p};client;${clean(p.steamid)};${clean(p.name)};${p.score};${p.kills};${p.downs};${p.revives};${p.rounds_played};${p.stats?.points_earned ?? ''};${p.stats?.points_spent ?? ''};${p.stats?.headshots ?? ''};${p.stats?.time_alive_ms ?? ''}`)
    }
  }

  close() { if (this.enabled && this.fd != null) { try { fs.closeSync(this.fd) } catch { /* ignore */ } this.fd = null } }
}
