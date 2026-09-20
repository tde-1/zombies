# Overnight plan (B asleep, 2026-09-20 ~01:30 → morning)

B: *"keep seeing this through to completion… keep iterating until I wake up… develop this and make a
minimum viable product with all the little systems you're building right now, and just expand it."*

So the target moves from "prove it's viable" to **"the smallest thing a friend could actually use"**,
built as far as it can go without B awake.

## What counts as the MVP here
Ordered by how much it proves:
1. **A game hosted by us, refereed end to end**: dedicated server boots → a client joins → rounds,
   downs, Easter-egg flags observed → a signed replay written → a summary posted to the site.
2. **The site**: a Movement port at `web/` — sign-in (mocked until B wires SSO), profiles, map pages,
   records, badges, party rail, admin. Runs locally on SQLite.
3. **The launcher**: Electron wrapping the site, finds World at War, installs the DLL, launches and
   connects.
4. **The archive**: crawler + catalogue + a link report; the ~10 MVP maps installed locally.

## Standing rules while B is asleep (on top of `dev-box.md`)
- **No spending. No accounts. No purchases. No cloud anything.** Everything runs on this PC.
- **Nothing leaves the machine**: no pushes to GitHub, no deploys, no posting, no outreach, no
  contacting authors, no publishing. Local git commits only (the coordinator commits).
- **Don't touch the Steam client** — not the account, not offline mode, not the settings. If a test
  needs Steam closed, write it down for B.
- **No video playback.** Read pages as text.
- **The game lock still applies** and is now contended by three agents — take it, use it, release it.
  `SetWindowPos` on another process can block for minutes; never hold the lock across a blocking call.
- **Never run an executable that came with a map**, ever, whatever the readme says.
- Clean room unchanged: GPL/AGPL/MIT code may be copied under its licence; unlicensed or decompiled
  work is read for understanding and **re-implemented**, never pasted. Check
  `18 - Reuse Register (projects to mine)` in the vault **before writing anything new** — B's standing
  instruction is to exhaust what already exists first.
- If something needs B, write it in `questions.md`, assume the most reversible option, carry on.

## Who is doing what
| Agent | Overnight goal |
|---|---|
| foundation | shared `on_frame` dispatcher · kill the "Set Optimal Settings?" modal so a game actually reaches play · per-instance `players/` redirect |
| dedi | stub the renderer bring-up → clean headless boot → **a client connects** → CPU/RAM per game → instances per box |
| referee | real capture on a live game: rounds, flags, positions, chat, AFK, pause |
| host | (reported) — reopens for integration once a real game runs |
| web | port ENW Movement into `web/` and get it serving zombies pages locally |
| launcher | Electron shell: detect WaW, install the DLL, launch, connect, deep links |
| archive | crawler + catalogue + link report; fetch and normalise the MVP maps only |

Integration is the coordinator's job: the first end-to-end run (site → launcher → game → referee →
replay → site) is the night's finish line.
