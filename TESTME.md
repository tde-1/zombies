# TESTME — five minutes, and the MVP is either proven or instrumented

Everything in the chain from "you kill a zombie" to "a round on the website" is now
green **except one link**, and that link needs a human at the keyboard: an unattended
game sits at round 1 with nobody killing anything, so the script that advances the
round never runs. You playing for five minutes is the only way to test it.

---

## 1. Install the launcher

Run `launcher\dist\ENW-Zombies-Launcher-Setup-0.1.0.exe`.

It will close the old ENW Zombies if it is running. No prompts, about 20 seconds.

## 2. Open it and check two things on the first screen

* **World at War — verified**
* **ENW client — installed** (if it says *not installed*, press **Install the ENW
  client** and wait; it takes about 10 seconds)

If either fails, stop and send me what the screen says. It now names every path it
looked in.

## 3. Play Nacht der Untoten, locally

In the rail pick **Nacht der Untoten** (`nazi_zombie_prototype`) and press
**Play Local**.

Use Nacht for this first test and nothing else. It is a stock map, so nothing
downloads and nothing can be wrong with it. Custom maps come after this works.

## 4. Play. Get past round 1.

**This is the whole test.** Survive round 1 so the game advances to round 2.
Round 3 or 4 is better — it proves the count, not just the transition.

Then either die, or quit to the menu. Both are fine.

## 5. Read the verdict

Open a terminal in `C:\Users\b\Desktop\Zombies` and run:

```
node launcher\tools\last-run.js
```

It prints, in order: whether the game reached the referee, **every round it reported**,
what the game's scripts said, whether the referee closed the game, and whether the
replay on disk verifies.

---

## What a pass looks like

```
2. rounds reported                1, 2, 3
   highest round                  3
4. the referee called the game    YES
5. replay                         C:\Users\b\AppData\Local\ENWZombies\replays\l_....enwr
   verified                       VALID — every chunk hashes to its index entry ...
```

and on the site, `http://127.0.0.1:3200/game/<match id>` shows the run with that round
number, marked **Local — no badge, no record, no XP**. That marking is correct and
deliberate: a game refereed on your own PC is honest, and it is not evidence.

## What a fail looks like, and what each one means

| `last-run.js` says | What is actually wrong |
|---|---|
| `rounds reported  NONE` or `1` only, and you definitely got to round 2 | **The thing this test exists to find.** The client never saw `between_round_over`. Send me the two log files named at the bottom of the output. |
| `the game reached the referee   NO` | The referee was not running or the game was not told where it was. `launcher.log` will have a `hostagent` line saying why. |
| `ENW_HOST WAS NOT SET` | The launcher did not prepare the run before launching — a launcher bug, not a game one. |
| `the referee called the game    NO` | The game is still running, or it vanished and nothing noticed. Wait 30 seconds and run it again. |
| `replay  NONE` | The client never said `map_loaded`, which means the server script died at map load. The client log will have a `Com_Error TRAPPED` line with the GSC error in it. |

---

## If the button does not work, the same test from a terminal

This is the identical chain with no Electron in it, so it tells a launcher bug apart
from a game one:

```
cd C:\Users\b\Desktop\Zombies\launcher
node src\main\play-cli.js --map nazi_zombie_prototype --local --track --visible --seconds 300
```

It starts the referee itself, prints `ROUND n` as they happen, and at the end prints
the round, the finish, the replay path and the command to verify it.

---

## Two things worth knowing before you start

* **Rounds are counted, not read.** The client counts the script notify
  `between_round_over`, which `maps/_zombiemode.gsc` fires immediately after
  `level.round_number++`. Reading `level.round_number` directly needs script-variable
  access we do not have yet. The counter is right for a game watched from the start,
  which is every game the launcher starts.
* **Your run is recorded even with no internet.** The referee and the replay writer
  both run on your PC. If the site is unreachable the run still gets a round count and
  a signed replay; it simply is not posted. `last-run.js` reads the local copy.
