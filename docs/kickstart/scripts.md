# scripts — custom-map GSC on our stack

Owns: `shared/core/components/script_error_retail.cpp`, and the script-error arms of
`tools/dev/maptest.ps1`. Started 2026-09-23. Read `dedi.md` §16 for the one-paragraph
version; this page is the working.

> **The headline.** A GSC runtime error is **not** fatal in Call of Duty: World at War.
> It is fatal in *our* game because every ENW launch line passes **`+set logfile 2`**,
> and `logfile` is what puts the script VM into developer mode. Four popular custom
> maps, and the three sessions of "the maps are broken by their own scripts" that
> preceded this one, are that one dvar.

---

## 1. What was believed, and what is true

`dedi.md` §14.2 and `archive.md` §9 left six maps marked `status: "broken"`, four of
them on the same shape — a map script calling `flag_wait` before `maps/_load::main()`
has run `flag_init` — and closed with the honest admission that **why the community
plays them anyway was not established**. Three separate experiments had taken our code
out of the process (samplers off, listen server, stock `CoDWaW.exe` with the binkw32
proxy reverted, add-on IWDs excluded) and the error had not moved.

Every one of those runs passed `+set logfile 2`, because `tools\dev\launch.ps1` does it
for every launch and `maptest.ps1` does it again. **Including `-NoEnw`.** The control
that was supposed to represent a community launch differed from one in exactly the way
that mattered.

Both halves of the old claim need restating precisely:

| Claim | Status |
|---|---|
| The four maps raise a GSC runtime error before `flag_init` | **Still true.** Their `main()` really does thread flag-dependent code before `maps\_zombiemode::main()`. |
| That error kills the game | **Retracted.** It kills a game launched with `logfile` (or `developer`) set. On a retail launch the VM reports nothing, repairs the thread's stack and carries on. |
| The maps are "broken" | **Retracted.** They play. |

## 2. The mechanism, instruction by instruction

All addresses read off our own decrypted dump (`ZombiesDev\dumps\codwaw-1.7-a.exe`,
`tools/re/t4map.py`). KisakCOD (CoD4 SP, the parent engine) was read only to *name*
`Scr_ErrorInternal`, `RuntimeError` and the `terminal_error` field; no code was copied.

### 2.1 `logfile` is not a passive dvar

`Com_SetScriptSettings` **0x59C840** — called from `Com_Init` and again whenever the
dvars are re-applied — is three lines of source and it is the whole story:

```
0059C840  mov eax, [0x1F55288]      ; the `developer` dvar_s*
0059C846  mov esi, [eax + 0x10]     ;   its int value
0059C84B  jne 0x59C85C              ; developer != 0        -> eax = 1
0059C84D  mov ecx, [0x1F552BC]      ; the `logfile` dvar_s*
0059C853  cmp [ecx + 0x10], esi     ; logfile  != 0         -> eax = 1
0059C877  mov byte [0x3882B77], cl  ; scrVarPub.developer_script  = developer_script
0059C880  mov byte [0x3882B76], al  ; scrVarPub.developer         = developer || logfile
0059C885  mov byte [0x3BD4715], cl  ; scrVmPub.abort_on_error     = developer
```

(also mirrored to the second script instance at 0x389ABBE / 0x3BD8A35.)

**`scrVarPub.developer` is set by `logfile`, not only by `developer`.** That is the
fact this whole page turns on, and nothing in three sessions of notes had it.

### 2.2 The promotion

`Scr_ErrorInternal` **0x693CF0**, which every `Scr_Error` (0x69AB70) tail-calls:

```
00693CF9  cmp byte [edx + 0x3882B78], 0   ; scrVarPub.evaluate            -> skip
00693D0A  cmp byte [ecx + 0x36DFF94], 0   ; scrCompilePub.script_loading  -> skip
00693D13  cmp byte [edx + 0x3882B76], 0   ; scrVarPub.developer
00693D1A  je  0x693D3C                    ;   RETAIL (0): nothing happens here
00693D24  cmp dword [ecx + 0x3BDDE0C], 0
00693D2B  je  0x693D3C
00693D35  mov byte [ecx + 0x3BD4716], 1   ; <<< scrVmPub.terminal_error = 1
00693D3C  cmp dword [ecx + 0x3BD4708], 0  ; scrVmPub.function_count
00693D4B  jne 0x693D56                    ;   in a thread -> longjmp to VM_Execute's catch
00693D91  call 0x5FE8C0                   ;   otherwise Sys_Error
```

The raiser itself never asks for a terminal error: `%s is not an array, string, or
vector` at **0x6926C4** pushes a literal `0` as `Scr_Error`'s terminal flag, and so do
`unknown item '%s'` (0x522D89) and `entity already has linkTo enabled` (0x519C77). The
only thing that makes these errors terminal is the store at **0x693D35**, and that
store is unreachable unless `scrVarPub.developer` is set.

### 2.3 The kill

`RuntimeError` **0x68B790**, called from `VM_Execute`'s catch:

```
0068B7A1  cmp byte [eax + 0x3882B76], 0   ; scrVarPub.developer -> report
0068B7B2  cmp byte [ecx + 0x3BD4716], 0   ; else terminal_error?
0068B7B9  je  0x68B85A                    ;   RETAIL PATH: return, in silence
0068B7EF  cmp byte [esi + 0x3BD4715], 0   ; bl = abort_on_error (= `developer`)
0068B7F8  cmp byte [esi + 0x3BD4716], 0   ;    || terminal_error
0068B820  call 0x68B6D0                   ; RuntimeErrorInternal -- prints the trace
0068B82A  je  0x68B85A                    ; bl == 0 -> return: reported, not fatal
0068B83D  cmp byte [esi + 0x3BD4716], dl
0068B84E  add edx, 4                      ; errParm = terminal_error + 4
0068B852  call 0x59AC50                   ; Com_Error(5 = ERR_SCRIPT_DROP, ...)
```

When `RuntimeError` returns without erroring, the VM at **0x6971D6** repairs its own
operand stack for the faulting opcode and **the thread continues**. `flag_wait`'s
`while( !level.flag[ msg ] )` simply spins, raising and swallowing the same error, until
`maps/_load::main()` creates `level.flag` a few frames later. Then the map plays.

Three states, and only the third is ours:

| `developer` | `logfile` | what a script runtime error does |
|---|---|---|
| 0 | 0 | nothing at all. Not printed, not fatal. **This is retail, and the community.** |
| 1 | any | printed, and fatal (`abort_on_error` is `developer`). |
| 0 | 2 | printed **and fatal**, via the promotion at 0x693D35. **This is every ENW run ever made.** |

The middle row is the one `README.md` rule 5 warns about. The bottom row is the same
trap wearing a different dvar, and nobody had noticed it was the same trap.

## 3. The fix

`shared/core/components/script_error_retail.cpp` NOPs the seven bytes at **0x693D35**
(`C6 81 16 47 BD 03 01`) after verifying them and checking `RuntimeError`'s own
prologue as a second signature.

It is the smallest change that makes a logging game behave like a retail one:

- the store is reachable **only** when `scrVarPub.developer` is set, so a real retail
  launch never executes it. Removing it cannot change retail behaviour; it can only
  stop `logfile` from changing it.
- `terminal_error`'s other four writers are untouched — `failed memory allocation for
  script usage` (0x68A5BA), the two `exceeded maximum number of script variables` sites
  (0x68FD16, 0x68FE56) and `Scr_TerminalError` (0x69ABEB) — so a genuinely
  unrecoverable VM state still ends the game exactly as before.
- `scrVarPub.developer` itself is left alone, so `RuntimeErrorInternal` still writes the
  whole `******* script runtime error *******` block with its call stack into
  `console.log`. **We keep the diagnostics and lose only the kill.**

It lives in `shared/core/components/`, not `server/components/dedicated/`, because the
player's client needs it as much as the dedicated server does — a listen game and
Play Local die in exactly the same place.

`ENW_NO_SCRIPT_ERROR_RETAIL=1` leaves the store in place. That is the control arm.

Dropping `+set logfile` would also work and is strictly worse: it takes `console.log`
away from every lane that depends on it. `maptest.ps1 -LogFile 0` exists to *measure*
that, not to ship it.

## 4. The runs

All dedicated, `-BigHeap`, private LocalAppData, `ZombiesDev\logs\dedi\scr*`.

| tag | arms | result |
|---|---|---|
| `scr01` | Zombie Desert, `logfile 2`, `ENW_NO_SCRIPT_ERROR_RETAIL=1` | **reproduces.** `Com_Error TRAPPED … arg1 = 00000005 … "undefined is not an array, string, or vector"`, then `----- Server Shutdown -----`. `getstatus` never answered |
| `scr02` | identical, **only `logfile 0`**, still no patch | **does not reproduce.** `alive=True getstatus=True`, `com_frameTime +35,001 ms over 8 probes`. Zero patches in the process |
| `scr03` | `logfile 2` + the component | `nazi_zombie_test1` **+34,994 ms**, `nazi_zombie_test` **+35,007 ms**, `mw2rust` **+35,002 ms**, `sanatorium` **+34,994 ms** — all four alive, all four answering `getstatus`, all four with the full script-runtime-error trace still in `console.log` |

`scr01` is the run that reproduces it and `scr02` is the run that does not, with one
dvar between them and no code change in either. That is the root cause.

## 5. What this does and does not reach

The engine-limit failures are a different class and this fix does nothing for them.

| Map | bsp | first cause | does this fix it? |
|---|---|---|---|
| Zombie Desert | `nazi_zombie_test1` | `flag_wait` before `flag_init` | **yes** (`scr03`) |
| Project Viking | `nazi_zombie_test` | same | **yes** (`scr03`) |
| MW2 Rust | `mw2rust` | same | **yes** (`scr03`) |
| Clinic of Evil | `sanatorium` | same | **yes** (`scr03`) |
| Leviathan | `nazi_zombie_leviathan` | `unknown item 'napalmblob'` — raised at 0x522D89 through `Scr_Error` with terminal flag 0 | **expected yes**, see the run table |
| DT2 | `nazi_zombie_dt2` | `entity already has linkTo enabled` — 0x519C77, same shape | **expected yes** |
| Zombie School / Hijacked | `nazi_zombie_school`, `nazi_zombie_hijacked` | `cannot cast undefined to string`, `_zombiemode_weapons.gsc` | **expected yes** |
| Der Berg | `nazi_zombie_derberg` | `scrVmPub.localVars` overrun at 0x697B60, a wild write into `.bss` | **no.** An engine-limit job (`dedi.md` §13.2) |
| Octogonal | `nazi_zombie_octogonal` | `Exceeded limit of 1 'snddriverglobals' assets` | **no.** Asset-limit class (T4M territory) |
| Water | `water` | `Need 89174697 more bytes of 'main' physical ram` | **no.** Memory-reserve class |

"Expected yes" means the raiser was read and passes terminal flag 0; it is not a run
and must not be written down as one until it is.

## 6. Independent corroboration (vault `Research/R15`, 2026-09-22)

Found separately, and it agrees line for line. Recorded because a mechanism read out of a
dump and a mechanism observed by the community are two different kinds of evidence and we
now have both.

- **UGX-Mods, "Tutorial: Debugging Scripts"**: a script runtime error is fatal *in
  developer mode*; for a normal player the error **"is still happening in the
  background"** and the game carries on. That is §2.3's retail path, described by people
  who have never opened a disassembler.
- **The trawl reached the same conclusion about `mapA`** — that the stock-exe control
  passed `+set logfile 2` and was therefore never a clean control — from the forums, on
  the same day this lane reached it from the exe.
- **Plutonium shipped exactly this fix, twice.** r3321 added a dvar
  **`all_gsc_errors_non_terminal`**; r5106 made it unconditional — *"Script errors only
  show in the console, now they will never cause the game to end or show a popup"* — and
  **removed the dvar "because it serves no useful purpose now"**.

`script_error_retail.cpp` is the r5106 end state, not the r3321 one, and for their reason:
a knob that every correct configuration sets the same way is not a knob. The bisect
control (`ENW_NO_SCRIPT_ERROR_RETAIL=1`) exists so the claim stays falsifiable, not so
anyone can choose the fatal behaviour in a real game.

Three more facts from R15 that belong to other lanes but must not be lost here:

- r5106 also fixed **"the GSC VM not freeing the current running stack upon a
  `Com_Error`" — a vanilla bug**. Our fix stops script errors from reaching `Com_Error` at
  all, so that leak no longer has an occasion on this path; it is still open for every
  *other* `Com_Error`. Not measured by us.
- **A dedicated custom-map launch needs the mod folder *and* the short bsp name**
  (`mod="mods/<folder>"` plus `sv_mapRotation "map <bsp>"` in the community's recipe).
  Ours passes `+set fs_game mods/<bsp> +map <bsp>`, which is the same two facts and is
  proven working; a host agent that ever splits them must carry both. `host.md`'s lane.
- **Plutonium's own T4 FAQ says custom zombie maps "were never coded with the ability for
  players to join mid game in mind"**, and that solo customs can misbehave when treated as
  an online game. Booting and surviving 300 s is therefore *not* the same acceptance bar
  as "four people can join whenever they like": late joins on a custom map are an open
  question for the referee/host lanes, not something this fix settles.
- The engine-limit half is separate and unstarted: T4M's ceilings are **FX 600, Image
  4096, LoadedSound 2400, Material 4096, Stringtable 80, Weapon 320, XModel 1500**, zone
  memory **425,721,856** bytes. That is the Der Berg / Water / Octogonal class, and
  `listassetpool` / `listassetcounts` equivalents are the instrument to build first.

## 7. The next wall, and it is not the script VM (`scr10`, 2026-09-23)

`jointest-proof.ps1 -Tag scr10 -Map nazi_zombie_test1 -BigHeap -Watch 300` — **FAIL**, and
the failure is a different one from every previous Zombie Desert run.

The **server was fine**. It loaded the map, answered `getstatus`, took the client's
`SV_DirectConnect`, logged `player_connect slot 0`, and held 49.2 Hz with
`com_frameTime` advancing. No `Com_Error` on the server at all. The map got further than
it has ever got.

**The client died.** 23 seconds after it launched:

```
scr10.client.enw.log
  17:28:33.006  === Com_Error TRAPPED ===  called from 0046BCB4
                arg1 = 00000001 (ERR_DROP)
                arg2 = "Weapon index mismatch for '%s'"
                arg3 = "kar98k"
  17:28:36.393  Unhandled exception caught  ->  Sys_Error
```

and the server, having lost its only client, went `CS_ZOMBIE` -> `ShutdownGame` at
17:28:33.018 — the same second. The `Exceeded limit of 1 'snddriverglobals' assets`
80 seconds later is the restart symptom (§14.6's trap), not a cause.

**0x46BC80** is the client's post-gamestate weapon check:

```
0046BC92  mov  esi, [ebx + eax*4]      ; the server's weapon name at index i
0046BC9B  call 0x41D4C0               ; the client's own index for that name
0046BCA3  cmp  eax, edi               ; must equal i + 1
0046BCAF  call 0x59AC50               ; else Com_Error(ERR_DROP, "Weapon index mismatch for '%s'")
```

i.e. the client's weapon list and the server's have diverged, and Zombie Desert's
`console.log` in `scr03` says why it might: among its 24 swallowed script errors is

```
cannot cast undefined to string: (file 'maps/_zombiemode_weapons.gsc', line 397)
```

**This is not a regression and it is not the fix misbehaving.** That script error is
swallowed on retail too — so the same weapon registration fails on a community listen
game — but on a *listen* server there is one process, one weapon list and nothing to
compare, so nobody ever sees it. A dedicated server is the first configuration in which
the two lists exist separately and can disagree. Plutonium's own T4 FAQ says the same
thing in the other direction: *"Some custom zombie maps may not function as expected on
the new dedicated servers as these maps were never coded with the ability for players to
join mid game in mind."*

So the honest state of Zombie Desert is: **the script-error wall is gone, a weapon-list
wall is next, and it belongs to whoever owns weapon/asset registration on a dedicated
server — not to this page.** No manifest verdict has been changed for it.

### 7.1 The four maps' script health after the fix, which is not equal

Error counts over the 30-second `scr03` holds, from each map's own `console.log`:

| Map | swallowed script errors in 30 s | shape |
|---|---|---|
| `mw2rust` | **2** | clean: the two `flag_wait`s, then nothing |
| `nazi_zombie_test1` | **24** | settles, but includes `_zombiemode_weapons.gsc:397` — see above |
| `sanatorium` | 2,720 | a steady trickle from `_zombiemode_gondola.gsc` and the shield script |
| `nazi_zombie_test` | **52,922** | an error storm — a thread raising and being repaired every frame |

"Boots and simulates for 35 s" is therefore **not** the same claim for all four, and the
five-gate runs are the only thing that can separate them. Do not promote any of these to
the site's playable set on the strength of `scr03`.
