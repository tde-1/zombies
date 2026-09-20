# host-agent — cold start

The server software that runs on an ENW Zombies game box: it starts game-server instances, talks
to them over `docs/protocol/game-link-v0.md`, referees them, records a signed replay of every
game, bridges chat, checks invite tokens at connect, and reports to the website.

**Node 24, zero dependencies. There is nothing to install.** No `npm install`, no build step —
`package.json` has an empty `dependencies` block and it stays that way.

```bash
cd infra/host-agent
node test/run-all.js          # 41 checks of the rules and the replay format, a few seconds
```

If that prints `41 passed, 0 failed`, everything below will work.

---

## The five things you are most likely to want

### 1. Just watch a game
No website, no setup. Boots two simulated games and opens a dashboard with a live 2D view of
players and zombies, the event log, chat, and replay playback.

```bash
node host.js --boot 2 --sim-players 4 --sim-max-round 30 --sim-ee-round 12 --map nazi_zombie_factory
```

Then open **<http://127.0.0.1:8787>**. Ctrl-C stops it and everything it started.

### 2. A box against the real website
Two terminals. The site must be running first.

```bash
# terminal 1 — the website
cd web && npm run dev                       # http://127.0.0.1:3200

# terminal 2 — the box
cd infra/host-agent
node host.js --site http://127.0.0.1:3200 --secret devkey-a --box box-a
```

The box will poll for work and do nothing until the site gives it a game. To give it one: sign in
at <http://127.0.0.1:3200/auth/mock>, make a party, pick a map, ready up, press **Start**. The box
boots a game, checks each player's invite token, referees it, records a signed replay, and posts
the result back.

**To do all of that in one command instead**, with assertions at every step:

```bash
node test/integration-site.js                       # uses box-a / devkey-a
node test/integration-site.js --box box-b --secret devkey-b   # if box-a is already in use
```

The seeded boxes are `box-a`/`devkey-a` and `box-b`/`devkey-b`. **One box per secret** — two agents
sharing `devkey-a` will race for the same lease.

> **The box's replay key is its identity.** It lives in `C:\Users\b\ZombiesDev\keys\host-<box>.json`
> and must not be regenerated: the site pins it on first sight, and a box that turns up with a
> different key is treated as an impostor — its replays are stored *unpinned*, which means record
> review will not count them. If that happens the box logs `KEY MISMATCH`, and an admin accepts the
> new key at **Admin → Boxes**. Never point `--key-dir` at a temporary directory.

### 3. Play Local (what the launcher uses)
On a player's own PC the **launcher owns the game process** and the host agent runs beside it as
referee and replay writer. This is the inverse of a game box and is **off by default**.

```bash
# the agent, with NO --site (a box attached to the site refuses to start in local mode)
node host.js --local --box local --link-port 38905 --dash-port 8905
```

The launcher then registers the game it is about to start, launches it with the returned `link` as
`ENW_HOST` and the same id as `ENW_INSTANCE`:

```bash
curl -s -X POST http://127.0.0.1:8905/api/local/expect \
  -H 'content-type: application/json' \
  -d '{"instance":"l_21a50db2","match_id":"l_21a50db2","map":"nazi_zombie_leviathan"}'
# -> {"ok":true,"instance":"l_21a50db2","link":"127.0.0.1:38905","expires_in_ms":600000}
```

Add `--adopt-local` instead of `--local` to accept a game that is *already running* and was never
registered; it is logged as `BLIND`. Either way the game is stamped **`self_reported`** — no XP, no
records, no badges — and the stamp is inside the signed replay header, so it cannot be removed
afterwards.

```bash
node test/demo-local.js       # proves all of it, including the refusals
```

### 4. Verify a replay
This is the whole point of the replay format, and the command a board admin runs.

```bash
node tools/verify.js "C:\Users\b\ZombiesDev\replays\<match>.enwr" --pub <the box's pinned key>
```

**Always pass `--pub`.** Without it you prove the file has not been modified, which is not the same
as proving *this box* recorded it — anyone can re-sign a doctored file with their own key. The
pinned key is on the site (Admin → Boxes), and in `keys/host-<box>.json` on the box itself.

```bash
node tools/verify.js <file> --tamper    # flips one bit and shows verification failing
node tools/recover.js <file>            # salvage a replay whose host was killed mid-game
```

A recovered replay says **VALID BUT RECOVERED**: good enough for a badge, not record-grade, because
it was signed after the fact.

### 5. Two boxes, a mock site, and everything at once
No real website needed. Proves the pull protocol, invite tokens (including a forged and an expired
one being refused), cross-server chat in both directions, the 24-hour cap and AFK ladder on a short
clock, and signed replays.

```bash
node test/demo-network.js
```

---

## Measuring

```bash
node tools/measure-replay.js --hours 1 --players 1,2,4    # MB per game-hour and the R2 cost
node tools/density.js --to 20 --step 4 --players 4        # how many games one agent carries
node tools/soak.js --dash http://127.0.0.1:8787 --every 60 --out soak.csv   # drift over hours
```

## The real game

Everything above runs against a **simulator** (`sim/`) that speaks the same protocol, so none of it
waits for the game. To boot a real `CoDWaW.exe` instead:

```bash
node host.js --boot 1 --game --map nazi_zombie_prototype --dry-run   # prints the launch line, starts nothing
node host.js --boot 1 --game --map nazi_zombie_prototype             # for real
```

That needs a game copy (`tools\dev\new-copy.ps1 host`) and the DLL deployed into it
(`tools\dev\deploy.ps1 host -From <build>`). **`launch.ps1` takes `game.lock`, not the host agent** —
the agent checks the lock, refuses if another agent holds it, and adopts the PID the launcher
prints. Several agents share this machine; take the lock, use it, release it.

## Where things go

| | |
|---|---|
| Replays | `C:\Users\b\ZombiesDev\replays\<match>.enwr` |
| Per-instance logs | `C:\Users\b\ZombiesDev\logs\host\<instance>.log` (+ a `games_mp.log` mirror) |
| Keys | `C:\Users\b\ZombiesDev\keys\host-<box>.json` — **do not regenerate** |
| Unsent results | `C:\Users\b\ZombiesDev\spool\` — a box with a non-empty spool must not be destroyed |

All overridable: `--replay-dir --log-dir --key-dir --spool-dir`. Nothing is ever written inside the
Steam install.

## Ports

Defaults are game link `38700`, dashboard `8787`. Several agents run tools on this machine, so if
something else has your port: the **dashboard** port being busy only disables the dashboard (the box
carries on refereeing), but the **game link** port being busy stops the box, deliberately. Move them
with `--link-port` and `--dash-port`.

---

Design, the measured numbers and every verdict: **`../../docs/kickstart/host.md`**.
The contract with the game DLL: **`../../docs/protocol/game-link-v0.md`**.
