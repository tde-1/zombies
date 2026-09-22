# Morning brief for B (drafted overnight, 2026-09-20)

> **This is a snapshot of 2026-09-20 and it is kept as written. For where things stand now, read
> `STATUS.md`.** Two items under "What is still not proven" below have since been settled and are
> marked in place: a client joining our server (item 1) and several games on one box (item 3).

Plain summary of what happened while B slept. Detail: `docs/kickstart/*.md`, and the vault's
`17 - Kickstart- Server Viability Prototype.md`.

## The short version
The thesis holds. **World at War's own exe already contains a dedicated mode**, and by morning it
boots headless, loads a zombies map, runs the zombies script and **reads connection packets**. A real
rescued custom map plays through our launcher. The website, the game-box software, signed replays,
invite tokens and live spectating all work together on real data.

## What you can actually see
- **A rescued map, playing.** From the launcher: sign in → pick **Leviathan** from the archive →
  453 MB installed with every file hash-checked → the game reports it playable. Labelled *"Local game
  — untracked. No badges, no records and no XP"* throughout.
- **The website**, serving locally: maps, map pages, profiles, records, badges, playlists, parties
  with a ready check, comments, admin and moderation tools, the zombies palette and logo A.
- **A live game watched from a web page** — round, players, points, downs, and a top-down view of
  players and zombies, at 4 Hz.
- **The full chain, green**: party → ready check → lease → a game box takes it → site-signed invite
  tokens verified at the box → a played game → a signed replay stored and confirmed record-grade.
- **A replay that verifies, and fails when one bit is flipped**, naming the broken chunk.

## The numbers we now have (measured, not estimated)
| | Figure |
|---|---|
| Maps catalogued | **2,276** distinct, **2,810** download links |
| Link rot | **13.7% of checkable community links are dead**, and a further **508 sit behind sign-in walls** nobody can verify — so 13.7–33.4%. **MEGA is 35.4% dead** and is the one host we can't download from; **MediaFire is 1.4% dead** after fifteen years |
| Whole archive | **1,363 maps recoverable, 280 GB measured**; ~**0.6 TB** with originals plus installs — the **top** of the 0.2–0.6 TB estimate, and a floor rather than a ceiling |
| Replay size | **3.0 / 6.4 / 8.0 MB per game-hour** at 1 / 2 / 4 players (from the simulator, corrected upward once its zombies behaved realistically; a live-game measurement is still owed) |
| Replay storage | **$6.36/month** for 90 days at 25 concurrent games |
| Headless server idle | **~0% CPU, 186 MB** with a zombies map loaded |
| Map scanner | **10/12** on real custom maps (0/14 before it was fixed) |

## What is still not proven
1. ~~**A client joining our server.**~~ **Done 2026-09-22**: a client connects to the headless
   dedicated server and spawns in, and the referee logs round 1 (`dedi.md` §7h, runs
   `join12`–`join18`). The server then stops about ten seconds later, which is the open blocker now
   (`dedi.md` §7j). *As written on 2026-09-20:* The test is staged and runs on the first green
   build; one blocker remains (the engine parks in a hidden console window's text drawing, which a
   server doesn't need).
2. **Performance under load** — only idle numbers exist.
3. ~~**Several games on one box** — the engine binds a fixed party socket that may cap it.~~
   **Measured 2026-09-22 and the fear was unfounded**: two headless servers ran at once, the second
   taking UDP 3075 when 3074 was busy (`host.md` §10.5). The one-game-per-box limit that remains is
   ours (a shared game copy, homepath and lock), not the engine's.
4. **Rounds, score and custom-game knobs**, which need script-variable reads; the published layout was
   disproved rather than guessed at.
5. **Sending text into a running game** — withdrawn, not merely unproven. It was reported working on
   the strength of the call returning without error; nobody had seen text appear, and the game now
   looks like it crashes seconds after the second injected message. That path also carries the
   game-length warnings and every referee message, so it matters beyond chat. Disabled until the
   calling convention is verified.

## Things only B can do
- **Verify integrity of game files** on World at War in Steam: `main\iw_13.iwd` is damaged in the
  Steam install itself.
- **Quit Steam for a minute** so we can test whether a headless server runs without the client — that
  decides whether every rented box needs its own Steam account.
- Decide: **who may download whose replay** (assumption in use: your own always, someone else's full
  tracks need VIP or a public game, summaries always public).
- Provide, when convenient: a **Steam Web API key** (real sign-in) and the two **ENW endpoints** (name
  and VIP). Everything is stubbed behind a seam; nothing has left this machine.
- **ZombieModding** blocks all crawlers but Google, and hosts the most-downloaded maps in existence.
  Asking them for permission or an export is outreach, which needs you.

## Judgement calls made without you
- **MediaFire downloads**: robots.txt obeyed absolutely for crawling; a file is fetched only when it's
  on a written shortlist *and* the link came from a page that host permits. One flag reverses it.
- **Decompiled third-party sources** (KisakCOD and similar) are read to locate and understand, never
  copied. Nothing of theirs is in our code.
- **Box loses the site** → spool to disk and retry; a box is never destroyed holding unreported games.
- **A box with no invite key refuses everyone** rather than becoming an open server.
- Badges are minted by a map's **main finish only**; other finishes tick.
