# The in-game chat overlay — the plan

> **Status: a plan, not code.** Nothing in this file is built. Written 2026-09-23 alongside the
> site half of cross-server chat, which **is** built and live (`web.md` §12). Lane: **client**
> (`client-dll/components/`), with one dependency on **referee** (`server/components/pause/`).
> The short version of this already exists as `client.md` §2d; this is that note turned into a
> plan with an estimate, and it does not contradict it.

B's ask, in his words in substance: *later an in-game overlay where T opens chat, pauses the game
if solo, and lets you type, replacing the game's own chat.*

---

## 0. The one fact that makes this easy, and it is verified

**World at War's single-player / co-op game has no in-game text chat to replace.** There is
nothing to take away, no key already bound, and no existing chat HUD our overlay would have to
fight or hide. So "replacing the game's own chat" is, in the SP exe, simply *providing* it.

The evidence is already written down and is a retraction, which is the strongest kind we keep:

* `docs/re/t4-sp-map.md`, *Chat — CORRECTED*: **"T4 co-op has no classic `say`→`G_Say`"**. The
  function the referee originally bound as `G_Say` (`0x473F10`) fires at ~60 Hz with empty text
  while the game sits idle — it is a per-frame HUD/notify formatter, and its only caller
  (`0x4388A0`, once taken for `ClientCommand`) is on the frame path. Both are **RETRACTED** in
  the address table.
* What T4 has instead is the **party/lobby reliable-command system**: the client sends
  `0clientchat %s` (`0x655C80`), the host relays `0hostchat %s %s` (`0x65B630`). That is lobby
  chat, not in-game chat, and it is the multiplayer lobby's.
* `board.md` 02:40 (re) is where both of those were established.

And the exe we run is the single-player one. `docs/kickstart/README.md` hard rule 2:
**`CoDWaWmp.exe` is never launched.** So the multiplayer chat UI is not merely unused — it is in
a binary this project does not start. The overlay has the screen and the keyboard to itself.

**What this does NOT mean.** It does not mean T is free — `T` is `+talk` in the stock key
bindings and the exe may still consume it somewhere. The overlay must swallow the key rather than
assume nothing is listening, which it has to do anyway (§3).

---

## 1. The four pieces

| Piece | Where | State |
|---|---|---|
| A 2D draw hook, to put a box on the screen | `client-dll/components/chat_overlay.cpp`, new | **not located** — the one real unknown |
| Input capture while typing | the existing WndProc subclass in `mouse_polling.cpp` | mapped, extend it |
| Solo pause | `server/components/pause/pause.cpp` | **built and working** |
| The channel | `game_link` `say` / `chat`, to the site's ring | **built and live tonight** |

Three of the four exist. The estimate is almost entirely the first one.

---

## 2. The draw hook — the whole risk, and the trap to avoid

**Do not use `SV_GameSendServerCommand` (`0x648490`) or `SV_SendServerCommand` (`0x6F5F10`) as a
text renderer.** They were bound for exactly that, reported green because the call returned, and
then killed a capture ~3 s after the second injected message while a bare launch survived 210 s
(`ac4e884`, *"chat injection withdrawn as proven and suspected harmful"*). Reading their prologues
afterwards showed a **HUD/debug coloured-text pair** that resolves an RGBA via `0x47A450`, passes
four floats, and `strlen`s into a ring buffer at `0x3DCB4C0`. The addresses in the table are
annotated with this. It is the reason `t4-sp-map.md` carries the sentence about two independent
signals.

So the plan is to find the real one, and the rule is **two independent signals before binding**:

1. **A call-graph signal.** `tools/re/t4map.py` over the decrypted dump, from the frame path
   (`Com_Frame` → `SV_Frame` / the client frame) down to whatever runs once per rendered frame and
   takes material + rect + text.
2. **A behavioural signal.** A candidate is bound behind a dvar, called with a fixed string at a
   fixed rect, and the *game is looked at*. A call returning without error is not evidence — that
   is exactly the mistake above.

Two starting points worth trying first, in this order:

* **The console.** The game already draws text over everything with its own font when the console
  is open. Whatever the console's draw function calls IS a 2D text renderer with a working font
  handle, a colour and a rect, and it is reachable from a code path we can trigger on demand (open
  the console, breakpoint, walk up). This is much cheaper than a cold search and gives the
  behavioural signal for free: the thing you are looking at is text on the screen.
* **`R_AddCmdDrawText`-family by material.** T4 draws 2D through the render-command list, so the
  other end is a `Material_RegisterHandle` for a font and a command that takes it.

Note in passing: `CoDWaW.exe` imports **no** `ExtTextOut`/`TextOut`/`DrawText` (`t4-sp-map.md`).
Text on the game surface is the engine's own, not GDI's — there is no OS shortcut here.

**If the draw hook cannot be found in the budget**, there is a degraded mode that is honest and
useful: draw nothing, and let the overlay be **input + pause + the link**, with the conversation
shown by the launcher's own window over the game rather than inside it. B sees his friends' lines
and can type; what he does not get is them on the game surface. That is worth shipping and it is
worth saying out loud that it is the fallback, because a half-found draw hook is how the last
chat attempt cost three days.

---

## 3. Input capture — mapped, and one rule

Everything needed is already in `client.md` §3's address list, added by this lane and `[V]` from
our own dump: the game WndProc `0x606BE0`, `Sys_QueEvent` `0x5FEB30`, `Sys_GetEvent` `0x5FEC60`,
`Com_EventLoop` `0x5FEDE0` `[C]`.

**The rule, and it is a hard one: `mouse_polling` already subclasses that WndProc. A second
consumer extends the one subclass; it does not add another.** This is hard rule 9 in
`README.md` wearing different clothes — one hook per target address, and the loser finds out from
a log line.

The behaviour:

* Closed, the overlay consumes nothing at all and costs one branch per message.
* `T` (the open key, dvar `enw_chat_key`, default `T`) opens it and from that instant every
  `WM_KEYDOWN`/`WM_CHAR` is **swallowed** — not forwarded, not also forwarded. A chat box that
  lets `W` through walks the player into a horde while they type.
* `Enter` sends and closes, `Escape` closes without sending, `Backspace` edits. Nothing else is
  bound in v0.
* The mouse is left exactly alone. Capturing it would fight `mouse_polling`'s raw-input path for
  no gain, and a chat box does not need a pointer.

---

## 4. Solo pause — already built

`server/components/pause/pause.cpp` does this today and its header comment is the list of traps it
was built around: never `timescale 0` (it stalls every GSC `wait` and the client says "Connection
Interrupted"); freeze in the engine, not from script, because map scripts re-enable player
controls and lose the race; make frozen players invulnerable; push the bleedout, powerup, box and
round-timer deadlines forward by the paused duration; suppress `round_spawn_failsafe()` for the
window, because a frozen zombie looks exactly like a stuck one.

The overlay uses it through the link it already speaks: `pause` on open, `resume` on close.

**And only when solo.** Pausing a co-op game because one person is typing is a griefing tool with
a key bound to it. The referee knows the player count; the overlay asks and does not decide. The
honest consequence is that in co-op you type while the game runs, which is what every other game
does.

One thing this does not solve and the pause component already says so: **spawning can only be
delayed, not cancelled**, so a zombie already queued to rise will rise on resume.

---

## 5. The channel — built and live as of tonight

Nothing new is needed. The overlay is the fourth client of a channel that already has three:

```
  game DLL  ──chat──▶  host agent  ──POST /api/gs/chat──▶  site ring (chat_network)
     ▲                                                          │
     └────say───── host agent ◀──GET /api/gs/chat-feed──────────┘
                                                                │
                            the website / the launcher ◀──socket 'chat'
```

A line typed in the overlay is a `chat` message on the game link, exactly as if the player had
typed it in a game that had chat. A line from anywhere else arrives as `say` and is drawn. The
site composes the system lines ("*mule_kicker just went down on round 30 on Verrückt*") from the
new `player_down` event and the roster events (`docs/protocol/game-link-v0.md`), so the overlay
gets those for free — it draws whatever the ring hands it.

**The `say`/`tell` INJECTION path is the one thing not to build on.** `game-link-v0` lists `say`
and `tell` host→game, and `server/components/chat/chat.cpp` implements them against
`SV_SendServerCommand` — which is the withdrawn pair from §2. Until a real renderer is bound,
**`say` arriving at the game is unproven and suspected harmful**, and the overlay must draw
incoming lines itself rather than hand them to that path. Fixing `say` and building the overlay
are the same piece of work: both need the draw hook, and once it exists `chat.cpp` is rebound to
it and both are true at once.

---

## 6. Estimate, honestly

| | |
|---|---|
| Find and verify the 2D text draw (two signals, console route first) | **1–3 days**, and it is the whole risk. It could be an afternoon if the console route lands; it could be a week if T4's 2D path is built the way the withdrawn pair suggests |
| Draw the box (background, history, input line, caret, wrap) | 0.5 day once something draws at all |
| Input capture, extending the one WndProc subclass | 0.5 day |
| Solo pause + the co-op refusal | 0.5 day, it is two link messages and a player count |
| Wire the link both ways, rebind `chat.cpp`'s `say` to the found renderer | 0.5 day |
| Prove it: a real game, two players, a line each way, no crash over a 300 s run on the harness | 0.5 day |

**Total 3.5–5.5 days, with the spread living entirely in the first row.** The fallback of §2 —
input + pause + link, launcher window instead of a game-surface box — is **1.5 days** and has no
unknowns in it at all.

What would make the estimate worse: the draw path turning out to be per-frame render-command
construction with no stable seam, which would push us to a D3D9 `EndScene` hook instead. That is a
different and larger job, it fights `borderless.cpp`'s window handling, and it is the point at
which to stop and ask B whether the launcher-window fallback is enough.

---

## 7. What is decided and what is not

**Decided**: T opens it (rebindable); solo pauses and co-op does not; input is swallowed whole
while open; one global channel, the same ring the site uses; the overlay draws incoming lines
itself and does not depend on `say`.

**Not decided**: where the box sits and how many lines it keeps; whether a system line looks
different in game the way it does on the site; whether the key is swallowed on the way in or on
the way out of the event queue; whether the overlay is on for Verified games at all, which is a
referee question and not a client one — a chat box is an input path into a recorded run.
