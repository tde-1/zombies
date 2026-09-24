# ENW Zombies — agent rules for context (read once, keep)

The vault (`shared-notes/ENW COD Zombies`, repo `tde-1/shared-notes`) holds decisions and the story
(`19 - Build Log`, `00 - Status`). This repo holds the current state. Obsidian's auto-backup commits the
vault; agents never commit it by hand.

## Start of a session (the only required reading, ~10k tokens)

1. `docs/kickstart/README.md` — hard rules and who owns what.
2. `docs/kickstart/next-session.md` — top table = current truth; below it, how to run things and traps.
3. Your lane doc: **only its newest dated section.** `grep -n '^## ' docs/kickstart/<lane>.md`, then
   read from the last heading. Older sections are history; open one only when a pointer names it.

Never read in full: `docs/kickstart/board.md` (append-only, ~125k tokens; `tail -n 60`), any lane doc,
anything under `docs/kickstart/history/`.

## Saving tokens while working

`node tools/ctx/ctx.js` does the lookups below cheaply (skill `find-code`). Skills `remember` and
`handoff` fire on their own; `.claude/hooks/guard.cjs` blocks the unbreakable hard rules.

- **Find, then read a span.** `grep -n` / `rg -n` for the symbol or `§` number, then read that range —
  not the whole file. Big files: every lane doc, `shared/t4/addresses.hpp`, `docs/re/t4-sp-map.md`.
- **API before bodies.** To learn a file, list its signatures (`rg -n '^\s*(export |static |void |int |bool |function |class )' <file>`)
  before opening bodies.
- **Pointers, not copies.** Hand-offs and sub-agent prompts name `file:line` / `doc §N` and the one fact
  that matters; don't paste logs or doc sections into prompts. Sub-agents return conclusions, not dumps.
- **Don't re-derive** what the next-session table states as checked; cite it.
- **Blast radius before a change:** `rg -n '<symbol>'` across `shared/ server/ client-dll/ web/ launcher/ infra/`.

## Writing docs so the next agent pays less

- New facts go in a **new dated section at the bottom** of the lane doc; update the next-session top
  table in place (one row per thing, a pointer, no story). The story goes to the vault Build Log.
- At each handoff, move superseded next-session blocks into `docs/kickstart/history/next-session-history.md`
  so the top of the page stays short. `STATUS.md` stays a pointer.
- One line per bug or decision, with its pointer. Evidence lives in the lane doc, not in the table.

## Learned rules (skill `remember` appends here; one line each)

- 2026-09-24: No custom UIs for process/tooling — improvements land as skills, docs, hooks and CLI scripts that apply without B thinking about them.
- 2026-09-24: B's pronouns are she/her. (Older docs say "his"; don't copy that into new text.)
- 2026-09-24: In-game actions are UI buttons (e.g. "Continue without" on the pause screen), never chat commands like `!continue` — B: "instead of the chat command".
