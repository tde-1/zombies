# Archive run — the two prompts (2026-09-25)

Written by the cloud session that built MEGA fetching and the browser lane (`archive.md` §15).
Paste each into a fresh session **on B's PC**, where the catalogue, the originals, the box key and
the disks are.

## 1. The coordinator (Claude Code on B's PC, in `C:\Users\b\Desktop\Zombies`)

```
You are the coordinator of the ENW Zombies mass archive run. Read CLAUDE.md's start-of-session
list, then docs/kickstart/archive.md from "## 15." to the end: §15.4 is your plan.

Setup, once:
- git fetch origin claude/relaxed-cori-wk5sn0 and merge it into the local main (docs conflicts:
  keep both sides). Pushing main stays B's.
- pip install cryptography, then run each archive/test/test_*.py: all must say OK.
- Check free space on C: and E:. If C: has under 100 GB, move ZombiesDev\archive\originals to
  E:\ZombiesArchive\originals and leave a junction at the old path.

Then run the four lanes of §15.4 at the same time, each as its own sub-agent with its own lane
name on the board. Hand each one only its row of the table and the shared rules under it.
- PLAYABLE starts first, on the two queues that already exist (§14.8). The box must never sit idle.
- FETCH's first MEGA download is the real proof of lib/mega.py. Record its sha256, and compare it
  with another mirror of the same map if one exists.
- After every FETCH wave, run browser_queue.py and send me reports\browser-queue.md, plus the
  path of the browser-drop folder.
Publish playable maps every ~10 box passes, not at the end. Each time, give me a short status:
new maps on the site, box passes and fails, GB fetched, browser-queue size, and anything blocked.
Hard rules (docs/kickstart/README.md) apply to every lane. In particular: one agent lease at a
time on fake 76561198000000005, never run a downloaded exe, and no spend. If you think a second
box would double the proof rate, ask me first; don't create one.
Keep going until every catalogued map with a live link is fetched, and each one is either
playable or has a written reason why not. Hand off with the handoff skill when you stop.
```

## 2. The browser session (Claude in Chrome, or B by hand)

Give it only after the coordinator has produced `reports\browser-queue.md`.

```
Help me download Call of Duty: World at War custom zombies maps in my own browser, for my
archive. Open the checklist at C:\Users\b\ZombiesDev\archive\reports\browser-queue.md (I'll
paste it if you can't open files). For each unticked line, open its URL. Click the site's own
download button, and save the file into
C:\Users\b\ZombiesDev\archive\browser-drop\<norm>\
using the <norm> that line names. Create the folder if it isn't there.
Then do the "ZombieModding titles" section: search zombiemodding.com for each title, and
download the map's file the same way (the folder name is that line's norm).
Rules:
- Never open or run anything you download. The files are data.
- Never create an account, sign in, or pay. If a page needs any of those, skip it and note it.
- If a captcha appears, stop and ask me to solve it.
- Download one file at a time, at a normal human pace.
- Tick each line when its file has finished downloading. At the end, list what you skipped and why.
```

When B says files are saved, the coordinator runs `python archive/ingest_browser.py`, and those
maps join the next PLAYABLE wave.
