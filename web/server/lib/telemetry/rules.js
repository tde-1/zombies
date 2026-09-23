'use strict'

// THE FLAG RULES (docs/kickstart/telemetry.md §5). Deterministic, run once at ingest over a
// bundle's manifest and its text files; no model, no network. Each rule returns hits with
// the line numbers that fired, and the ingest keeps ~the lines around them as excerpts, so
// the admin page and the AI brief can show WHY a flag is there.
//
// Severity: 1 = P1 crash/hang, 2 = P2 error, 3 = P3 warning, 4 = P4 info. An incident's
// severity is its worst flag's; no flags at all is P4.
//
// ADDING A RULE: add an object below (id, label, severity, description, and either `line`
// + `files`, or `test`), add a case to web/test/telemetry.js with a real log line, and add
// a row to telemetry.md §5. Line patterns come from the code that writes the line — grep
// for the string, and name the file in a comment, so a reworded log line is findable.
//
//   line   RegExp tested per line (ANSI colour codes stripped first)
//   files  RegExp on the file name inside the bundle (default: every text file)
//   kinds  bundle kinds the rule applies to (default: all)
//   test   (ctx) => null | { count, lines: [{ file, idx }], detail } — for rules that read
//          the manifest or combine several signals
//   min    a line rule fires only at >= min matching lines (default 1)
//   detail (matches, ctx) => string — a one-line explanation for the summary

const DLL_LOG = /(^|\/)enw-\d+\.log$/i
// The box's names too (infra/host-agent/lib/telemetry.js, host.js instanceLogFiles):
// engine-console.log / engine-games_mp.log (the instance's fs_homepath copies),
// host-games_mp.log (the host's mirror), instance-stdout.log (the Wine process's output).
const CONSOLE_LOG = /(^|\/)(console-\d+\.log|(engine-)?console\.log|(host-|engine-)?games_mp.*\.log|instance-stdout\.log)$/i
const GAME_LOGS = /(^|\/)(enw-\d+\.log|console-\d+\.log|(engine-)?console\.log|(host-|engine-)?games_mp.*\.log|instance-stdout\.log)$/i
const LAUNCHER_LOG = /(^|\/)(launcher\.log|.*-std(out|err)\.log)$/i
// host-instance.log (this instance's own agent lines), host-lease.log (a failed pull's),
// journal-unit*.log / journal-kernel.log (the daily journal). NOT host-box-context.log nor
// host-recent.log (a box warning's): they hold every instance's lines, so an error in them
// belongs to some other game and must not flag this bundle.
const HOST_LOG = /(^|\/)(host\.log|host-lines\.log|host-agent\.log|host-(instance|lease)\.log|journal.*\.log|journal.*\.txt)$/i
const KERNEL_LOG = /(^|\/)(kernel.*\.(log|txt))$/i

const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null }

const RULES = [
  // ---- P1 ----------------------------------------------------------------------------
  {
    id: 'crash', label: 'Crash', severity: 1,
    description: 'The game or the box instance crashed: a Windows crash dump, an unhandled exception named by overlay_guard, a trapped Sys_Error, Windows event 1000, a session that ended in "crash", or the host saw the instance exit unexpectedly.',
    test (ctx) {
      const lines = ctx.grep(/overlay_guard: UNHANDLED EXCEPTION|Unhandled exception caught|=== Sys_Error TRAPPED ===|instance exited unexpectedly/i, GAME_LOGS.source + '|' + HOST_LOG.source)
      const dumps = ctx.files.filter((f) => f.binary && /\.dmp$/i.test(f.name) && !/(^|\/)hang-/i.test(f.name) && f.size > 0)
      const ev = (ctx.manifest.events || []).filter((e) => Number(e.id || e.Id) === 1000)
      const m = ctx.manifest
      const said = (m.session && m.session.exit === 'crash') || m.reason === 'game_crash' || /crash/i.test(String(m.exit_reason || ''))
      if (!lines.length && !dumps.length && !ev.length && !said) return null
      const parts = []
      if (dumps.length) parts.push(`${dumps.length} crash dump${dumps.length > 1 ? 's' : ''} (${dumps.map((d) => d.name).join(', ')})`)
      if (m.session && m.session.exception) parts.push(`exception ${m.session.exception.code || ''} at ${m.session.exception.address || m.session.exception.module || '?'}`)
      if (ev.length) parts.push(`Windows event 1000 ×${ev.length}`)
      if (lines.length) parts.push(firstText(ctx, lines))
      return { count: Math.max(1, lines.length, dumps.length, ev.length), lines, detail: parts.join('; ') || 'reported as a crash' }
    },
  },
  {
    id: 'hang', label: 'Hang', severity: 1,
    description: 'The main thread stopped: a hang-*.dmp from hang_watchdog, its "MAIN THREAD … has not ticked" line, Windows event 1002 (stopped interacting), or a session that ended in "hang".',
    test (ctx) {
      const lines = ctx.grep(/hang_watchdog: the MAIN THREAD|stopped interacting with Windows/i, GAME_LOGS.source)
      const dumps = ctx.files.filter((f) => /(^|\/)hang-.*\.dmp$/i.test(f.name))
      const ev = (ctx.manifest.events || []).filter((e) => Number(e.id || e.Id) === 1002)
      const m = ctx.manifest
      const said = (m.session && m.session.exit === 'hang') || m.reason === 'game_hang'
      if (!lines.length && !dumps.length && !ev.length && !said) return null
      const empty = dumps.filter((d) => !d.size).length
      return {
        count: Math.max(1, lines.length, dumps.length, ev.length),
        lines,
        detail: [dumps.length ? `${dumps.length} hang dump${dumps.length > 1 ? 's' : ''}${empty ? ` (${empty} empty: MiniDumpWriteDump failed)` : ''}` : null, ev.length ? `Windows event 1002 ×${ev.length}` : null, lines.length ? firstText(ctx, lines) : null].filter(Boolean).join('; '),
      }
    },
  },
  {
    id: 'oom_kill', label: 'Out of memory', severity: 1, kinds: ['journal', 'host'],
    description: 'The Linux kernel killed a process for memory (the box).',
    line: /Out of memory: Killed process|oom-kill|invoked oom-killer/i, files: new RegExp(KERNEL_LOG.source + '|' + HOST_LOG.source, 'i'),
  },
  {
    id: 'site_crash', label: 'Site crashed', severity: 1, kinds: ['site'],
    description: 'An uncaught exception in the site process (it is restarted by the keepalive loop).',
    test: (ctx) => (ctx.manifest.reason === 'uncaught' ? { count: 1, lines: [], detail: String(ctx.manifest.notes || '').split('\n')[0] } : null),
  },

  // ---- P2 ----------------------------------------------------------------------------
  {
    id: 'com_error', label: 'Com_Error', severity: 2,
    description: 'The engine raised Com_Error (the DLL traps and logs it: "=== Com_Error TRAPPED ==="). The EXE_ string in its arguments says which.',
    line: /=== Com_Error TRAPPED ===/, files: DLL_LOG,
    detail (m, ctx) {
      const codes = new Set()
      for (const h of m) for (let i = h.idx; i < Math.min(h.idx + 12, ctx.text(h.file).length); i++) { const x = /"((?:EXE|PLATFORM|MENU|GAME)_[A-Z0-9_]+)"/.exec(ctx.text(h.file)[i]); if (x) codes.add(x[1]) }
      return `${m.length}×${codes.size ? ` (${[...codes].slice(0, 6).join(', ')})` : ''}`
    },
  },
  {
    id: 'script_error', label: 'Script errors', severity: 2,
    description: 'GSC script runtime errors in the game console.',
    line: /script runtime error|\*{3,} script (runtime )?error|^\s*script compile error/i, files: GAME_LOGS,
  },
  {
    id: 'disconnect', label: 'Disconnect', severity: 2,
    description: 'The client lost the server: PLATFORM_DISCONNECTED_FROM_SERVER, a timeout, a kick.',
    line: /PLATFORM_DISCONNECTED_FROM_SERVER|EXE_SERVERDISCONNECTED|EXE_TIMEDOUT|EXE_ERR_SERVER_TIMEOUT|EXE_SERVER_TIMEOUT|Connection timed out|Server disconnected|EXE_PLAYERKICKED|EXE_DISCONNECTEDFROMOWNLISTENSERVER|\bCL_Disconnect\b.*(timeout|timed out)/i, files: GAME_LOGS,
  },
  {
    id: 'join_failed', label: 'Join failed', severity: 2,
    description: 'join_retry gave up, or the server refused the join (EXE_ERR_CANNOTJOININPROGRESS, a refused token).',
    // Quoted: the Com_Error argument dump. The bare word also appears in the harmless
    // dedi_join_in_progress warning ("joins WOULD HAVE BEEN refused with …").
    line: /join_retry: GIVING UP|"EXE_ERR_CANNOTJOININPROGRESS"|join_retry: the server refused/i, files: GAME_LOGS,
  },
  {
    id: 'auth_deny', label: 'Token refused', severity: 2,
    description: 'An invite token or chat pass was refused (DENY, wrong_match, bad_signature, expired).',
    line: /\bDENY\b|wrong_match|bad_signature|token (was )?(refused|rejected|expired)|reason[=:] ?'?(expired|wrong_match|bad_signature|malformed)/i,
  },
  {
    id: 'lease_refused', label: 'Lease refused', severity: 2,
    description: 'A lease was refused or failed: the box posted failed, the lease dvars were refused, no slot, or the bundle was sent for a refused lease.',
    test (ctx) {
      const lines = ctx.grep(/lease .*(refused|failed)|refused .*lease|lease dvars refused|no free instance slot|REFUSING to adopt/i)
      if (!lines.length && ctx.manifest.reason !== 'lease_refused') return null
      return { count: Math.max(1, lines.length), lines, detail: lines.length ? firstText(ctx, lines) : 'the bundle was sent for a refused lease' }
    },
  },
  {
    id: 'host_pull_failed', label: 'Map pull failed', severity: 2, kinds: ['host', 'journal'],
    description: 'The box could not pull or verify a leased map from the bucket.',
    test (ctx) {
      const lines = ctx.grep(/could not prepare|prepare failed|pull(ed)? .*fail|sha256 mismatch|stalled .*abort|missing or wrong/i, HOST_LOG.source)
      if (!lines.length && ctx.manifest.reason !== 'pull_failed') return null
      return { count: Math.max(1, lines.length), lines, detail: lines.length ? firstText(ctx, lines) : 'the bundle was sent for a failed pull' }
    },
  },
  {
    id: 'host_error', label: 'Host errors', severity: 2, kinds: ['host', 'journal'],
    description: 'error-level lines from the host agent (instance failed, finish failed, KEY MISMATCH, could not retire …).',
    line: /\d\d:\d\d:\d\d\.\d{3}Z? error\b|KEY MISMATCH|instance failed:/i, files: HOST_LOG,
  },
  {
    id: 'launcher_error', label: 'Launcher error', severity: 2, kinds: ['launcher'],
    description: 'The launcher reported an error or an uncaught exception.',
    test (ctx) {
      const m = ctx.manifest
      if (!['launcher_error', 'uncaught'].includes(m.reason)) return null
      const lines = ctx.grep(/uncaught|unhandled|Error:|TypeError|ReferenceError/i, LAUNCHER_LOG.source).slice(-20)
      return { count: Math.max(1, lines.length), lines, detail: String(m.notes || (m.exit_reason) || m.reason).split('\n')[0].slice(0, 200) }
    },
  },
  {
    id: 'exit_abnormal', label: 'Abnormal exit', severity: 2, kinds: ['client'],
    description: 'The game exited with a non-zero code and no crash was otherwise seen.',
    test (ctx) {
      const c = ctx.manifest.exit_code
      if (c == null || Number(c) === 0) return null
      if (ctx.flagged('crash') || ctx.flagged('hang')) return null
      return { count: 1, lines: [], detail: `exit code ${c}${ctx.manifest.exit_reason ? ` (${ctx.manifest.exit_reason})` : ''}` }
    },
  },
  {
    id: 'site_5xx', label: 'Site 5xx', severity: 2, kinds: ['site'],
    description: 'The site answered 5xx or logged an error (console.error / an Express error).',
    test: (ctx) => (['site_5xx', 'site_error'].includes(ctx.manifest.reason) ? { count: Number(ctx.manifest.count) || 1, lines: [], detail: String(ctx.manifest.notes || '').split('\n')[0].slice(0, 200) } : null),
  },

  // ---- P3 ----------------------------------------------------------------------------
  {
    id: 'asset_missing', label: 'Missing assets (new)', severity: 3,
    description: '"Could not load" / "unable to find" asset errors that are NOT on the map\'s known-chronic list (data/chronic-assets.json).',
    test: (ctx) => assets(ctx, true),
  },
  {
    id: 'asset_missing_known', label: 'Missing assets (known)', severity: 4,
    description: 'Asset errors that every run of this map has (the known-chronic list). Info only.',
    test: (ctx) => assets(ctx, false),
  },
  {
    id: 'record_refused', label: 'Record refused', severity: 3,
    description: 'A Verified rule refused the run (verified env, fps rule, late join, profile).',
    line: /verified env:|no-records|records_eligible[=:] ?false|profile_ok[=:] ?false|is outside the Verified rule|record refused/i,
  },
  {
    id: 'fps_low', label: 'Low FPS', severity: 3, kinds: ['client'],
    description: 'A frametime window averaged under 55 fps while in a map, or over 5 % of frames took longer than 33 ms.',
    test (ctx) {
      const lines = []
      let worst = null
      for (const h of ctx.grep(/frametime: .* frames, [\d.]+ fps avg/i, DLL_LOG.source)) {
        const t = ctx.text(h.file)[h.idx]
        const fps = num((/([\d.]+) fps avg/.exec(t) || [])[1])
        const over33 = num((/over 33\.3ms: \d+ \(([\d.]+)%\)/.exec(t) || [])[1])
        const frames = num((/-- (\d+) frames/.exec(t) || [])[1])
        if (frames != null && frames < 120) continue // loading screens and menus
        if ((fps != null && fps < 55) || (over33 != null && over33 > 5)) { lines.push(h); if (worst == null || fps < worst) worst = fps }
      }
      return lines.length ? { count: lines.length, lines, detail: `${lines.length} window${lines.length > 1 ? 's' : ''}, worst ${worst} fps avg` } : null
    },
  },
  {
    id: 'low_address_space', label: 'Low address space', severity: 3, kinds: ['client'],
    description: 'overlay_guard measured the largest free address block under 64 MB (32-bit WaW; Discord\'s capture needs ~50 MB in one piece).',
    test (ctx) {
      let min = null
      const lines = []
      for (const h of ctx.grep(/largest free (address )?block [\d.]+ MB/i, DLL_LOG.source)) {
        const v = num((/largest free (?:address )?block ([\d.]+) MB/i.exec(ctx.text(h.file)[h.idx]) || [])[1])
        if (v != null && v < 64) { lines.push(h); if (min == null || v < min) min = v }
      }
      const s = ctx.manifest.session && num(ctx.manifest.session.largest_free_block_mb)
      if (s != null && s < 64 && (min == null || s < min)) min = s
      if (min == null) return null
      return { count: Math.max(1, lines.length), lines, detail: `smallest largest-free-block ${min} MB` }
    },
  },
  {
    id: 'launcher_update_failed', label: 'Update failed', severity: 3, kinds: ['launcher', 'client'],
    description: 'The launcher\'s self-update failed (a feed error, a download error, an install error).',
    line: /\bupdate\b.*(fail|error)|Cannot download|error code: 5\d\d|ERR_UPDATER|latest\.yml.*(404|5\d\d)/i, files: LAUNCHER_LOG,
  },
  {
    id: 'box_resources', label: 'Box low on disk/RAM', severity: 3, kinds: ['host', 'journal'],
    description: 'The box reported under 2 GB disk or under 300 MB available memory.',
    test (ctx) {
      const h = ctx.manifest.host || {}
      const disk = num(h.disk_free_gb)
      const mem = num(h.mem_free_mb != null ? h.mem_free_mb : h.mem_available_mb)
      const low = []
      if (disk != null && disk < 2) low.push(`${disk} GB disk free`)
      if (mem != null && mem < 300) low.push(`${mem} MB memory free`)
      if (!low.length && ctx.manifest.reason !== 'box_warning') return null
      return { count: 1, lines: [], detail: low.join(', ') || 'box warning' }
    },
  },
  {
    id: 'manual_report', label: 'Sent by hand', severity: 3,
    description: 'A player pressed "Send logs now": they probably had a problem worth asking them about.',
    test: (ctx) => (ctx.manifest.reason === 'manual' ? { count: 1, lines: [], detail: 'the player sent these logs themselves' } : null),
  },
  {
    id: 'result_spooled', label: 'Result post failed', severity: 3, kinds: ['host', 'journal'],
    description: 'The box could not post a result and spooled it.',
    line: /result post failed/i, files: HOST_LOG,
  },

  // ---- P4 ----------------------------------------------------------------------------
  {
    id: 'discord_refused', label: 'Discord hook refused', severity: 4, kinds: ['client'],
    description: 'overlay_guard refused DiscordHook.dll (not enough address space on this map).',
    test (ctx) {
      const lines = ctx.grep(/Discord overlay off|DiscordHook loads refused [1-9]|overlay_guard: .*refus(ed|ing) .*DiscordHook/i, DLL_LOG.source)
      const n = ctx.manifest.session && num(ctx.manifest.session.discord_hook_refused)
      if (!lines.length && !n) return null
      return { count: Math.max(lines.length, n || 0), lines, detail: n ? `${n} load(s) refused` : firstText(ctx, lines) }
    },
  },
]

// Asset errors: the lines, normalised to the asset name, split by the per-map known list.
// Real lines (console-<pid>.log, 2026-09-23): `Error: Could not load xanim "…".` (also fx,
// xmodel, material, menufile, rawfile), `Error: unable to find secondary alias '…'`,
// `WARNING: Could not find zone '…'`. The key is `<type>:<name>`, lower case, which is also
// the form of data/chronic-assets.json (tools/telemetry/build-chronic.js).
const ASSET_RE = /(?:Could not load|couldn't load|unable to (?:find|load)|can't find|could not find|Couldn't find)\s+(secondary alias|alias|xanim|fx|xmodel|material|menufile|rawfile|zone|image|sound|weapon|techset|file|localized string)?\s*['"]([^'"\r\n]+)['"]/i
const assetKey = (line) => { const m = ASSET_RE.exec(String(line || '')); return m ? `${(m[1] || 'asset').toLowerCase().replace(/\s+/g, '_')}:${m[2].toLowerCase()}` : null }
function assets (ctx, wantNew) {
  const seen = new Map() // key -> first hit
  for (const h of ctx.grep(ASSET_RE, CONSOLE_LOG.source + '|' + DLL_LOG.source)) {
    const key = assetKey(ctx.text(h.file)[h.idx])
    if (key && !seen.has(key)) seen.set(key, h)
  }
  if (!seen.size) return null
  const known = ctx.knownAssets()
  const pick = [...seen.entries()].filter(([n]) => (known.has(n) ? !wantNew : wantNew))
  if (!pick.length) return null
  const names = pick.map(([n]) => n)
  return { count: pick.length, lines: pick.map(([, h]) => h), detail: `${pick.length} distinct: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}` }
}

function firstText (ctx, lines) {
  const h = lines[0]
  return h ? String(ctx.text(h.file)[h.idx] || '').replace(/^\[[\d:.]+\] (\[\w+\] )?/, '').trim().slice(0, 200) : ''
}

const byId = new Map(RULES.map((r) => [r.id, r]))
const catalogue = () => RULES.map((r) => ({ id: r.id, label: r.label, severity: r.severity, description: r.description, kinds: r.kinds || null }))
const SEVERITY_NAMES = { 1: 'P1 crash/hang', 2: 'P2 error', 3: 'P3 warning', 4: 'P4 info' }

module.exports = { ASSET_RE, assetKey, RULES, byId, catalogue, SEVERITY_NAMES, GAME_LOGS, DLL_LOG, CONSOLE_LOG, LAUNCHER_LOG, HOST_LOG }
