# Launcher: how long the nav stays dead after a game (2026-09-23)

A dev launcher window (the real `main.js`, invisible: opacity 0, click-through, not focusable, no
taskbar button; own `userData`, `ENW_ROOT`, lock dir and `LOCALAPPDATA`) on a scratch site on
:3419 with a test account and a fake update (`ENW_FAKE_UPDATE=0.2.99`, which puts the chip in the nav).
The "game" is a stand-in `node` that sleeps for 6 s. It is swapped in at `spawn()` so it runs through
`GameLaunch` → `BootFlow` → `main.js` `ended`. After the game exits the launcher shows its boot screen
(`-1-boot-screen.png`). **Back to the site** is pressed with a CDP mouse click, which goes through
Chromium's own input pipeline. The nav is probed by sending `WM_NCHITTEST` to the window's HWND
about every 3 ms (1 = HTCLIENT, the page gets the click; 2 = HTCAPTION, the click becomes a window
drag). Probe points: the logo (421), Maps (493), Records (576), **Update now** (929), Later (1006),
Discord (1075), the **account chip** (1238), and Minimise (1379), all at y 31.

*shown* is the time from the click until the site view is made visible. *live* is the time until the
probed control answers 1 with the site visible. *dead* is live minus shown: how long the player can
see the nav but not click it. The figures below are for Maps; Update now and the account chip gave
the same numbers in every run.

| build | path | trials | shown | dead (Maps / Update now / account) |
|---|---|---|---|---|
| HEAD (0.2.13) | settings screen → Back | 10 | 4–6 ms | **never recovered within 2.4 s, 10/10** (all three) |
| HEAD (0.2.13) | game exits → boot screen → Back | 5 | 3–8 ms | **never recovered within 2.4 s, 5/5** |
| HEAD (0.2.13) | settings → Back, probed for 30 s | 1 | 6 ms | **still HTCAPTION at +30 s** |
| HEAD, native occlusion ON | settings → Back | 6 | 4–6 ms | never recovered within 4.9 s, 6/6 |
| shell `backgroundThrottling: false` only | settings → Back | 10 | ~5 ms | 24–37 ms, median 29 |
| **fix** (strip first, 2 frames + 40 ms, then site; shell keeps painting) | settings → Back | 10 | 50–58 ms | **0 / 0 / 0** (30/30) |
| **fix** | game exits → boot screen → Back | 5 | 54–56 ms | **0 / 0 / 0** (15/15) |
| **fix**, native occlusion ON | settings → Back | 10 | 50–55 ms | **0 / 0 / 0** |
| **fix**, native occlusion ON | game exits → Back | 3 | 55–57 ms | **0 / 0 / 0** |

Also measured: HEAD made the site visible 6 ms after the game exited and hid it again 14 ms later
(the `ended` handler shows the site, then `boot_done` reopens the boot screen). The fix does not flash.
`-2-nav-live-account-menu.png`: the account chip was clicked 150 ms after Back, and the menu is open
with the update chip in the nav.

Not measured: B's real mouse. `WM_NCHITTEST` is the question Windows asks before it routes a real
click, so it is the closest evidence available. Also not measured: why B's window recovers "after a
moment" when the dev window never did. See launcher.md, same date.
