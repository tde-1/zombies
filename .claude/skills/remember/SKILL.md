---
name: remember
description: Use whenever B corrects you, repeats an instruction, says "I told you", "always", "never", "from now on", or states a preference or decision — so she never has to say it twice. Also use when a mistake of yours cost a retry.
---
# Make a correction stick

B should never repeat herself. When she corrects you or states a rule:

1. **Say it back in one line** and apply it now.
2. **Pick where it lives** (the smallest place that every future agent will actually see):
   - Always-true rule for agents in this repo → one line under `## Learned rules` in the root `CLAUDE.md`
     (date + the rule + why, in B's words where short). Check it isn't already there; sharpen, don't duplicate.
   - Hard safety rule (breaking it hurts B, the box, the site or her install) → also add a regex to
     `.claude/hooks/guard-rules.json` so the harness **blocks** it (`{ "re": ..., "why": "..." }`),
     then test: `echo '{"tool_input":{"command":"<bad>"}}' | node .claude/hooks/guard.cjs` exits 2.
   - A lane fact or trap → the lane doc's newest section and the next-session "Traps" list.
   - A product decision or preference → `docs/kickstart/questions.md` (answered) and the vault note
     via the handoff (the vault is Obsidian's; don't commit it by hand).
3. Commit it with the work (`docs: learned rule — <short>`). No UI, no asking permission for this.

Keep every rule one line. If `## Learned rules` passes ~40 lines, fold duplicates.
