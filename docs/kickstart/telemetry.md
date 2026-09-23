# telemetry — every crash, every error, in the bucket, flagged

Lane **telemetry** (T1, 2026-09-23). Owns `shared/telemetry/`, `web/server/lib/telemetry/`,
`web/server/routes/telemetry.js`, `web/client/src/pages/admin/Issues.jsx`,
`launcher/src/main/telemetry/`, `infra/host-agent/lib/telemetry*`, `tools/telemetry/`.
Touches the launcher, host and web lanes at their edges; each of those docs has a dated
pointer back here.

B, 2026-09-23 13:05: *"Add logging to the entire thing and make it save on our storage bucket.
Any time the client crashes, any time a user has an issue with the launcher or the game, I want
as much logging as possible. Beta testers are trusted friends; data collection is fine. Crash
logs always automatically upload, including mine … also whenever the server goes wrong. Don't
sacrifice performance. Store more logs rather than less. I want it automatically flagging so I
can review it later with AI, probably in the admin panel."*

## 1. The pipeline in one picture

```
 player's PC                              B's PC (the site)                        bucket enw-zombies
 ───────────                              ─────────────────                        ──────────────────
 game exits / crashes / hangs ─┐
 launcher error / uncaught ────┤ launcher builds a bundle (.tar.gz,
 "Send logs now" ──────────────┤ scrubbed) into ENWZombies\telemetry\outbox,
 launcher start (backlog) ─────┘ uploads it after the game has exited ──►  POST /api/telemetry/upload
                                                                          (session cookie + beta pw)
 the box (zombies-dev)                                                     │  size cap, rate limit
 ─────────────────────                                                     ▼
 instance ends (over/retire/crash/                                        stream to data/telemetry/
 refused lease/pull failure) ───┐ host agent bundles, uploads ──►  POST /api/gs/telemetry   incoming,
 once a day: the journal ───────┘                                  (x-match-secret)         read it, flag it,
                                                                                            re-scrub if needed ──► logs/<kind>/<date>/<who>/<id>.tar.gz
 the site itself: uncaught, 5xx, console.error ──────────────────► incidents (kind=site)
 nightly: the day's site log ─────────────────────────────────────────────────────────────► logs/site/<date>/site/<id>.tar.gz
 nightly: the digest ─────────────────────────────────────────────────────────────────────► logs/digest/<date>.json
                                                                   admin → Issues page (table, detail, AI brief)
```

**Players never hold bucket keys.** The site holds them (read from `infra\s3.env` through
`tools/s3/lib.cjs`, the same file the publish tools use), so the site can write `logs/`.
This is a change from storage.md §5 ("the site holds bucket names only"), made on B's decision
of 2026-09-23; storage.md has a dated line pointing here.

## 2. The bundle

A `.tar.gz`, written by `shared/telemetry/bundle.cjs` (`writeBundle`). No dependency: ustar
headers by hand (`tar.cjs`).

```
manifest.json          what, who, when, versions; see below
files/<name>           the logs, dumps and state files; text ones scrubbed
```

`manifest.json`:

| field | meaning |
|---|---|
| `v` | 1 |
| `bundle_id` | 32 hex, random, made by the bundler. The site de-duplicates on it (a retry is not a second incident). It is NOT the bucket key id: the site mints its own |
| `kind` | `client` (a game session), `launcher` (the launcher itself), `host` (one box instance), `journal` (the box's daily journal), `site` |
| `reason` | `game_exit`, `game_crash`, `game_hang`, `launcher_error`, `uncaught`, `manual`, `backlog`, `instance_end`, `lease_refused`, `pull_failed`, `daily_journal`, `site_daily` |
| `created_at` | ISO time the bundle was made |
| `launcher_version`, `dll_sha`, `dll_version`, `build` | what was running |
| `map`, `match_id`, `mode`, `box`, `instance`, `pid` | where |
| `exit_code`, `exit_reason`, `duration_ms` | how the game ended (launcher: from the process; host: from the referee) |
| `machine` | `{ os, cpu, cores, ram_gb, ram_free_gb, gpus[] }` |
| `launch_line` | the game's command line, scrubbed |
| `session` | the DLL's `session-<pid>.json`, when there is one |
| `wer` | `{ local_dumps: 'hklm'|'hkcu-ours'|'hkcu'|'off', dump_folder }` |
| `events` | Windows Application-log events 1000/1001/1002 for CoDWaW.exe in the last hour |
| `host` | box health: `{ disk_free_gb, mem_free_mb, load }` |
| `summary_line` | the host's `SUMMARY` line for the instance |
| `files[]` | `{ name, size, original_size, truncated, scrubbed, binary }` per file, or `{ name, refused }` |
| `scrub_hits` | per scrub rule, how many replacements the bundler made |

## 3. The routes

### `POST /api/telemetry/upload` — a launcher's bundle

* Auth: the launcher's **session cookie** (the same one `siteapi.js` sends) and the beta
  gate's Basic password. Signed in is enough; a nameless or unapproved account may still send
  logs (the first crash is often before approval). Signed out → **401**: the launcher keeps the
  bundle and tries again after sign-in.
* Body: the raw `.tar.gz`, `content-type: application/gzip`. Headers: `x-enw-bundle-id`,
  `x-enw-bundle-kind` (`client`|`launcher`), `x-enw-bundle-reason`, `content-length`.
* Cap: **200 MB** per bundle (`ZM_TELEMETRY_MAX_MB`) → **413**. Rate: **40 bundles and 2 GB
  per account per 24 h** (`ZM_TELEMETRY_PER_DAY`, `ZM_TELEMETRY_GB_PER_DAY`) → **429** with
  `Retry-After`.
* **400** = not a bundle (bad gzip, bad tar, no manifest). The launcher must not retry a 400.
* **200** `{ ok, id, duplicate, severity, flags }`. `duplicate: true` when that `bundle_id`
  was already received from this account: the launcher treats it as sent.

### `POST /api/gs/telemetry` — the box's bundle

The same body and answers; auth is the box's `x-match-secret` like every `/api/gs` route. Kinds
`host` and `journal`. Rate: 500 bundles / 10 GB a day per box.

### Admin (`/api/admin/incidents…`, moderators and admins)

| route | |
|---|---|
| `GET /incidents` | the table: `?severity=1,2&flag=&kind=&who=&version=&map=&reviewed=0|1&q=&sort=at|severity|size|who|kind&dir=&page=&size=` → `{ total, page, size, rows, facets: { flags, kinds, versions, maps, people }, unreviewed: { p1, p2 } }` |
| `GET /incidents/:id` | one incident: metadata, flags, summary, `hits` (per flag: count and log excerpts), files, `download` URL, review state |
| `GET /incidents/:id/brief` | `text/plain`: the AI brief (metadata + flags + the lines around each hit), ≤ ~60 KB |
| `GET /incidents/:id/bundle` | 302 to the bucket copy, or the file from the site's disk while it is not uploaded |
| `POST /incidents/:id/review` | `{ reviewed: bool, bug: 'next-session line', note }`; audit-logged `incident.review` |
| `POST /incidents/digest` | (admin) build and upload today's digest now |

## 4. Scrubbing

`shared/telemetry/scrub.cjs`, three byte-identical copies (`shared/`, the launcher's
`src/main/telemetry/`, the host agent's `lib/telemetry/`). `node tools/telemetry/sync-shared.js`
copies the canonical one over the others; the web, launcher and host suites each fail when a
copy differs (`--check` does the same by hand). The same goes for `tar.cjs` and `bundle.cjs`.

**Scrubbed three times:** by the sender (every text file, and the manifest, before the tar is
written), by the site at ingest with its own secrets (and if that finds anything, the bundle is
rebuilt from the scrubbed text and the original deleted, `manifest.server_rescrubbed`), and
the excerpts and the AI brief are built from the scrubbed text only.

| rule | what goes |
|---|---|
| `literal` | exact values the caller passes: the box secret, the beta password, the site's own session secret, S3 keys, the ENW token, the Steam API key (anything ≥ 6 characters) |
| `cvar` | `set/seta/setu enw_token|enw_auth|enw_chat_pass|… "<value>"` |
| `json`, `kv` | `"name": "value"` and `name=value` / `name: value` where the name is a secret name or has one as a `_`/`-`/`.`-joined part (`S3_SECRET_KEY`, `x-match-secret`, `password`, `token`, `cookie`, `shared_secret`, `identity_secret` …). Booleans, small numbers and `map_key`/`key_id`/`token_ok`/`sha256` are left alone so the rules can still read them |
| `auth_header`, `bearer` | `Authorization: Basic …`, `Bearer …` |
| `cookie` | `zm.sid=`, `zm_gate=` |
| `pipe` | `\\.\pipe\enw-launch-<hex>` |
| `deeplink` | `enw-zombies://join/<token>` and friends |
| `chat_pass`, `signed_token` | `gc1.<body>.<sig>` and the invite token `b64u(body).b64u(sig)` |

**Never bundled at all** (`isForbiddenFile`): `enw_auth.cfg`, `*.maFile`, `*.env` (`s3.env`,
`site.env`, `enw-host.env`), `session-secret`, `*.pem`, `*.key`, `id_rsa*`, browser cookie stores.

**What is NOT scrubbed, on purpose:** binary files. A crash dump is process memory; it may
hold a live invite token (5-minute life) or chat pass. B's call (2026-09-23): the testers are
trusted friends and the dump is the single most useful thing a crash leaves, so it goes up.
Steam IDs, persona names, map names, IPs of our own box and the player's Windows user name in
paths are not secrets and are kept — they are what makes a log diagnosable.

## 5. Flag rules

`web/server/lib/telemetry/rules.js` (the table), `flags.js` (the runner and the excerpts).
Deterministic, at ingest, over the manifest and the text files (their last 32 MB each, 128 MB
per bundle). No model and no network: B reviews with AI himself, from the brief. Severity is
the worst flag's; no flags is P4.

| flag | P | fires on | source of the string |
|---|---|---|---|
| `crash` | 1 | a non-empty `*.dmp` that is not `hang-*`; `overlay_guard: UNHANDLED EXCEPTION`; `Unhandled exception caught`; `=== Sys_Error TRAPPED ===`; host `instance exited unexpectedly`; Windows event 1000; `session.exit == 'crash'`; reason `game_crash` | overlay_guard.cpp, error_trap.cpp, host.js |
| `hang` | 1 | `hang-*.dmp` (an empty one is called out: MiniDumpWriteDump failed); `hang_watchdog: the MAIN THREAD`; event 1002; `session.exit == 'hang'` | hang_watchdog.cpp |
| `oom_kill` | 1 | box: `Out of memory: Killed process`, `oom-kill` in the kernel journal | journalctl -k |
| `site_crash` | 1 | the site's own uncaught exception | siteLog.js |
| `com_error` | 2 | `=== Com_Error TRAPPED ===`, detail lists the `EXE_…` codes in its argument dump | error_trap (DLL log) |
| `script_error` | 2 | `script runtime error`, `script compile error` | console log |
| `disconnect` | 2 | `PLATFORM_DISCONNECTED_FROM_SERVER`, `EXE_ERR_SERVER_TIMEOUT`, `EXE_PLAYERKICKED`, `Connection timed out` … | DLL / console |
| `join_failed` | 2 | `join_retry: GIVING UP`, `join_retry: the server refused`, the quoted `"EXE_ERR_CANNOTJOININPROGRESS"` (not the harmless "would have been refused" warning) | join_retry.cpp |
| `auth_deny` | 2 | `DENY`, `wrong_match`, `bad_signature`, token expired/refused | host.js auth lines |
| `lease_refused` | 2 | `lease … refused/failed`, `no free instance slot`, a refused Play on the site | host.js, siteLog.js |
| `host_pull_failed` | 2 | `could not prepare`, `prepare failed`, `sha256 mismatch`, reason `pull_failed` | host.js, mapcache.js |
| `host_error` | 2 | host `error`-level lines, `KEY MISMATCH`, `instance failed:` | util.js makeLog |
| `launcher_error` | 2 | launcher bundle with reason `launcher_error` / `uncaught` | launcher main.js |
| `exit_abnormal` | 2 | non-zero exit code with no crash/hang seen | launcher |
| `site_5xx` | 2 | a 5xx answer or a `console.error` on the site | siteLog.js |
| `asset_missing` | 3 | `Could not load <type> "…"` / `unable to find secondary alias` / `Could not find zone` for an asset **not** on the map's known-chronic list | console log |
| `record_refused` | 3 | `verified env:`, `no-records`, `is outside the Verified rule`, `profile_ok=false` | referee.js, fps_guard.cpp |
| `fps_low` | 3 | a `frametime:` window of ≥ 120 frames under 55 fps avg or > 5 % of frames over 33 ms | frametime.cpp |
| `low_address_space` | 3 | overlay_guard's largest free block under 64 MB (or `session.largest_free_block_mb`) | overlay_guard.cpp |
| `launcher_update_failed` | 3 | update/feed/download errors in launcher.log | autoupdate.js |
| `box_resources` | 3 | manifest `host.disk_free_gb < 2` or `mem_free_mb < 300`, reason `box_warning` | host agent |
| `manual_report` | 3 | the player pressed **Send logs now** — ask them what happened | launcher |
| `result_spooled` | 3 | `result post failed` | host.js |
| `asset_missing_known` | 4 | asset errors that ARE on the chronic list | — |
| `discord_refused` | 4 | overlay_guard refused DiscordHook.dll | overlay_guard.cpp |

**The known-chronic list** is `web/server/data/chronic-assets.json`, built by
`node tools/telemetry/build-chronic.js` from the archive's boot logs
(`ZombiesDev\archive\mods\<map>\console.log`, `archive\logs\box-console\**\*.console.log`):
24 maps, 151 engine-wide keys (`"*"`, seen in half the maps), 4,098 per-map keys on
2026-09-23. Keys are `<type>:<name>` (`xanim:ai_zombie_walk_v1`). Re-run it after a boot
sweep; the site reads it at the first bundle after a restart.

**Excerpts.** For every flag the lines that fired plus a window around them (3 before / 8 after;
30 / 40 for crash, hang, oom, site and launcher crashes), windows merged, the newest kept,
**300 lines per flag, 1,500 per incident**, each line cut at 400 characters. A crash with no
line to anchor on gets the last 120 lines of the game's own log. They are stored on the row
(`hits`), so the sheet and the brief never open the bundle.

**Adding a rule.** One object in `RULES` (`id`, `label`, `severity`, `description`, and either
`line` + `files` or a `test(ctx)`); a case in `web/test/telemetry.js` using a real line copied
from a real log; a row in the table above. Name the source file of the string in a comment, so
a reworded log line can be found. Rules run at ingest only: an old incident keeps the flags it
was given (re-flagging old bundles is a tool nobody has written yet).

## 6. The launcher side

Code `launcher/src/main/telemetry/` (queue `index.js`, contents `collect.js`, `outbox.js`,
`probe.js`, `wer.js`), `SiteApi.uploadBundle`, wiring in `main.js`, **Send logs now** in Settings.
Detail, disk layout, the WER finding on B's PC and what is unproven: `launcher.md`, section
*2026-09-23 — telemetry: what the launcher uploads*. Tests `launcher/test/telemetry.js` (20).

| Trigger | kind / reason | Notable contents |
|---|---|---|
| every game exit (any phase, a game process was spawned) | `client` / `game_crash`, `game_hang`, `game_exit` | `enw-`, `console-`, `session-<pid>` for every pid of the launch (Steam's relaunch too), `hang-<pid>-*.dmp`, WER `CoDWaW.exe.<pid>.dmp`, the launch's stdout/stderr, `launcher.log` (4 MB tail), settings, the map's `.enw-installed.json`; manifest `events` (1000/1001/1002 for CoDWaW.exe, last hour), `session`, `launch_line`, `exit_code`, `dll_sha` |
| launcher error, `uncaughtException`, `unhandledRejection` | `launcher` / `launcher_error`, `uncaught` | `error.txt`, config/settings/detection (scrubbed by key), the last session's logs; one per message per 10 min |
| start, `crashes\*.json` not yet bundled | `launcher` / `backlog` | those reports, once each |
| Settings → Send logs now | `launcher` / `manual` | the last 3 sessions, events, ≤ 2 dumps newer than 24 h; sent at once |

Classification: a WER/our dump for the pid → `game_crash`; a hang-watchdog dump → `game_hang`; an
exit code ≠ 0 the launcher did not cause, or `session.exit_reason` naming a crash → `game_crash`;
else `game_exit`.

Upload rules (the launcher's reading of §3): nothing is built or sent while a game this launcher
started is alive, nor for 5 s after it exits; an upload in flight is aborted (not counted) if a game
starts; one bundle at a time, streamed. 200 / `duplicate` → deleted; 5xx or network → 1 min, 5 min,
30 min, 2 h, 6 h, then every 6 h; 429 → `Retry-After`; 401 → until the next sign-in or 30 min;
400 → `ENW_ROOT\telemetry\rejected\`, never retried; 413 → rebuilt once without dumps, then dropped.
Outbox `ENW_ROOT\telemetry\outbox\`, at most 30 days / 2 GB, oldest first. First automatic upload
ever: one toast, *Logs sent*. `manifest.wer.local_dumps`: `hklm` (B's PC: the global HKLM key with
default values, dumps in `%LOCALAPPDATA%\CrashDumps`), `hkcu`, `hkcu-ours` (the launcher made
`HKCU\...\LocalDumps\CoDWaW.exe` → `ENW_ROOT\crashes\dumps`, minidump, 10; only when nothing else
covered the exe; per exe name, so it also covers Steam-launched vanilla WaW for that Windows user),
or `off`.
