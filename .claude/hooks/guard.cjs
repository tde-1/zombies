#!/usr/bin/env node
// PreToolUse guard: the hard rules that must never break get a block, not a note.
// Rules: guard-rules.json (regex + reason). Add one when a correction is unbreakable
// (skill `remember`). Checks Bash commands and text written by Write/Edit.
const fs = require('fs'), path = require('path');
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const t = input.tool_input || {};
const text = [t.command, t.content, t.new_string].filter(Boolean).join('\n');
// Write/Edit straight into the Steam install (hard rule 1), whatever the text.
const file = String(t.file_path || '');
if (/steamapps[\\/]+common[\\/]+Call of Duty World at War/i.test(file)) {
  process.stderr.write("Blocked by .claude/hooks/guard.cjs — Hard rule 1: B's Steam install is read-only. Copy out, never write in.");
  process.exit(2);
}
if (!text) process.exit(0);
let rules = [];
try { rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'guard-rules.json'), 'utf8')); } catch { process.exit(0); }
// Docs may quote the rules themselves; only enforce CoolGombies there.
// Docs may quote the rules themselves; only enforce CoolGombies there.
const isDoc = /\.(md|json)$/i.test(file);
for (const r of rules) {
  if (isDoc && r.re !== 'CoolGombies') continue;
  if (new RegExp(r.re, 'i').test(text)) {
    process.stderr.write(`Blocked by .claude/hooks/guard.cjs — ${r.why}`);
    process.exit(2);
  }
}
