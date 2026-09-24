---
name: find-code
description: Use before reading or changing code or lane docs in this repo — to locate a symbol, see a file's API, check what depends on something (blast radius), or read a lane doc's current state without paying for the whole file.
---
# Find, then read a span

`tools/ctx/ctx.js` (Node, no install, works on B's PC and in the cloud):

| Need | Command |
|---|---|
| Orientation | `node tools/ctx/ctx.js map` |
| A file's API before its bodies | `node tools/ctx/ctx.js skeleton <file>` (js/cpp/py/gsc/ps1) |
| What breaks if I change X | `node tools/ctx/ctx.js callers <symbol> [path…]` (grouped by file, docs excluded) |
| A lane doc's current state | `node tools/ctx/ctx.js newest docs/kickstart/<lane>.md` |
| A doc's map | `node tools/ctx/ctx.js heads <doc>` then read only the section you need |

Rules:
- Then read only the line range you need. Never read a lane doc, `board.md` or `history/` in full.
- Before changing a signature, config key, dvar, route or address: run `callers` and name every
  site in your plan. Shared code (`shared/`, `web/server/lib/`, `infra/host-agent/lib/`) crosses lanes.
- Sub-agents: give them `file:line` / `doc §N` pointers and ask for conclusions, not dumps.
