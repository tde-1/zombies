# ENW Zombies

Every World at War custom zombies map, archived and playable. `zombies.enw.gg`.

The spec is in the shared vault: `shared-notes/ENW COD Zombies/99 - Build Spec (for Fable).md`.

Status: **kickstart prototype** (server-side viability). See `docs/kickstart/`.

| Folder | What | Licence |
|---|---|---|
| `shared/` | T4 addresses/structs, DLL core | follows the including target |
| `server/` | game-server DLL components (dedicated, referee, replay, chat…) | AGPL-3.0 |
| `client-dll/` | player client DLL (later) | GPL-3.0 |
| `referee/` | GSC overlays, per-map manifests | AGPL-3.0 |
| `infra/host-agent/` | runs game instances, replays, chat hub | AGPL-3.0 |
| `tools/` | dev and RE scripts | AGPL-3.0 |
| `thirdparty/` | vendored dependencies only (MinHook, BSD-2-Clause) | upstream's |

No game files, dumps or Activision code are ever committed.
