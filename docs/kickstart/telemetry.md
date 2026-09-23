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

(filled in below by the lane)

## 5. Flag rules

(filled in below by the lane)
