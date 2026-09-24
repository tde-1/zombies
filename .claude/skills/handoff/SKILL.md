---
name: handoff
description: Use at the end of a session or lane, when writing a handoff, updating next-session.md, a lane doc or the board, or when B says she's stopping for the night.
---
# Handoff that keeps the next session cheap

1. **Lane doc:** a new dated `## N. YYYY-MM-DD <when> — lane X: <headline>` section at the bottom:
   what changed, the proof (commands, shas, run tags), what is unproven, the next step. Nothing older is edited
   except a one-line *(Update …)* note on a line that became false.
2. **`docs/kickstart/next-session.md` top table:** update rows in place — one row per thing, a pointer, no story.
   Move superseded blocks into `docs/kickstart/history/next-session-history.md` (append, as written).
   Keep the page top under ~40 lines. `STATUS.md` stays a pointer; never grow it.
3. **Board:** one `- HH:MM <lane>: <fact>` line. **Questions for B:** `questions.md`, one line each.
4. **Vault:** the story goes to `19 - Build Log` (Obsidian auto-backup commits it; never commit the vault by hand).
   If you can't reach the vault, say so in the handoff instead of skipping silently.
5. **Lessons:** any correction or trap from this session goes through the `remember` skill.
6. Commit docs with `--only` on your own files; say plainly what is pushed and what is not.
