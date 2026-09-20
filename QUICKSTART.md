# Try it

Two things work end to end today: **the website**, and **the launcher playing a rescued map**.
Playing on *our* server does not work yet — one engine blocker remains (`docs/kickstart/dedi.md`).

## 1. The website — it may already be running

Open **http://127.0.0.1:3200**. If nothing answers, start it:

```powershell
cd C:\Users\b\Desktop\Zombies\web
npm install
npm start
```

Sign in from the top right. **It is not Steam** — it's a local dev page; click a name and you are
that person (Dexter is an admin). Nothing leaves this machine.

You should see 19 playable maps (the stock four, your `nazi_zombie_ali`, and 14 the archive
rescued), ~2,284 maps in the archive, and demo games, records and badges so nothing looks empty.

Worth a look: a map page, the records hub, the badges directory, `/archive` (including the dead
links), and the admin console if you signed in as Dexter.

## 2. The launcher — install a rescued map and play it

In a second terminal, with the site still running:

```powershell
cd C:\Users\b\Desktop\Zombies\launcher
npm install
npm start
```

First run shows a setup screen: it will already have found your World at War and graded it
`verified`, with the folder, version and hash it matched. Press **Install the ENW client** — about
8 MB into `%LOCALAPPDATA%\ENWZombies`. **Your Steam copy is not touched**; the screen lists exactly
what changed and the installer fingerprints the folder before and after.

Then pick a map and press **Play**. It installs the map (hash-checked), launches World at War, and
you play. It is labelled **Local — untracked: no badges, no records, no XP**, and the site refuses
to count it even if something claims otherwise.

Full detail, including what to do if Electron misbehaves: `launcher/README.md`, `web/README.md`.

## If you actually play for a few minutes, you finish something we couldn't
The one thing no agent could do is **be at the keyboard**. An unattended game sits at round 0 with
nobody spawning, so the zombies script never starts — every capture tonight was a player standing
still. If you press Play, load in and play a few rounds, the referee records it and the site should
show the game, the round, the live view and a signed replay. That would be the first complete run of
the whole chain, and the honest test of whether rounds and finishes are detected in a real game.

## What is real and what is not
- **Real**: map catalogue and archive, map pages, profiles, records, badges, playlists, parties,
  comments, admin/moderation, live spectating, signed replays and their verification, map install
  with hash checks, game launch, our code running inside the game.
- **Stubbed**: Steam sign-in (needs your API key), the ENW name and VIP links, map art.
- **Not working yet**: playing on our own dedicated server, in-game chat injection, reading round
  numbers live.

## If something goes wrong
Every area has notes in `docs/kickstart/` — `web.md`, `launcher.md`, `host.md`, `referee.md`,
`dedi.md`, `foundation.md`, `archive.md` — and `morning.md` is the plain-language summary.
