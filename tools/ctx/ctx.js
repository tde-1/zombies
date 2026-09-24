#!/usr/bin/env node
// ctx — cheap code/doc lookups for agents (Graft's ideas, no install, no index, no network).
//   node tools/ctx/ctx.js skeleton <file>          signatures only, with line numbers
//   node tools/ctx/ctx.js callers <symbol> [path…] who references a symbol, grouped by file
//   node tools/ctx/ctx.js newest <doc.md>          the newest dated/last '## ' section of a lane doc
//   node tools/ctx/ctx.js heads <doc.md>           the '## ' headings with line numbers (a doc's map)
//   node tools/ctx/ctx.js map                      files and lines per top-level folder
const fs = require('fs'), { execFileSync } = require('child_process');
const [cmd, arg, ...rest] = process.argv.slice(2);
const git = (a) => { try { return execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch (e) { return e.stdout || ''; } };
const lines = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/);
const SIG = {
  js: /^\s*(export\s+)?(default\s+)?(async\s+)?(function\*?\s+\w+|class\s+\w+|(const|let)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>|module\.exports|router\.(get|post|put|patch|delete)\(|app\.(get|post|put|delete|use)\()/,
  cpp: /^\s*(namespace\s+\w+|(class|struct|enum)\s+\w+|(static\s+|inline\s+|virtual\s+|constexpr\s+)*[\w:<>,*&\s]+\s+[\w:~]+\s*\([^;]*\)\s*(const)?\s*(\{|$)|#define\s+\w+)/,
  py: /^\s*(async\s+)?(def|class)\s+\w+/,
  gsc: /^\s*\w+\s*\([^)]*\)\s*$/,
  ps1: /^\s*(function|filter)\s+[\w-]+|^\s*param\s*\(/i,
};
const kind = (f) => /\.(c?js|mjs|jsx|tsx?)$/.test(f) ? 'js' : /\.(c|cc|cpp|h|hpp)$/.test(f) ? 'cpp' : /\.py$/.test(f) ? 'py' : /\.gsc$/.test(f) ? 'gsc' : /\.ps1$/.test(f) ? 'ps1' : null;
function sections(f) { const L = lines(f), h = []; L.forEach((l, i) => { if (/^#{1,2} /.test(l)) h.push(i); }); return { L, h }; }
if (cmd === 'skeleton' && arg) {
  const re = SIG[kind(arg)]; if (!re) { console.error('unknown file type'); process.exit(1); }
  lines(arg).forEach((l, i) => { if (re.test(l) && !/^\s*(if|for|while|switch|return|else)\b/.test(l)) console.log(`${i + 1}: ${l.trim().slice(0, 160)}`); });
} else if (cmd === 'callers' && arg) {
  const out = git(['grep', '-n', '-w', '-I', '--', arg, ...rest]).trim().split('\n').filter(Boolean);
  const by = {}; for (const o of out) { const [f, n, ...t] = o.split(':'); if (/\.md$/.test(f)) continue; (by[f] = by[f] || []).push(`  L${n}: ${t.join(':').trim().slice(0, 140)}`); }
  const fs_ = Object.keys(by).sort((a, b) => by[b].length - by[a].length);
  console.log(`${arg} — ${fs_.reduce((s, f) => s + by[f].length, 0)} hits in ${fs_.length} files (docs excluded)`);
  for (const f of fs_) { console.log(f); console.log(by[f].slice(0, 12).join('\n')); if (by[f].length > 12) console.log(`  … ${by[f].length - 12} more`); }
} else if (cmd === 'heads' && arg) {
  const { L, h } = sections(arg); h.forEach((i) => console.log(`${i + 1}: ${L[i].slice(0, 150)}`));
} else if (cmd === 'newest' && arg) {
  const { L, h } = sections(arg);
  // Lane docs append dated sections at the bottom; pick the heading with the latest date, else the last one.
  const date = (s) => (s.match(/20\d\d-\d\d-\d\d/) || [''])[0];
  let best = h[h.length - 1]; for (const i of h) if (date(L[i]) && date(L[i]) >= date(L[best])) best = i;
  const end = h.find((i) => i > best) ?? L.length;
  console.log(`# ${arg} lines ${best + 1}-${end}`); console.log(L.slice(best, end).join('\n'));
} else if (cmd === 'map') {
  const files = git(['ls-files']).trim().split('\n'); const by = {};
  for (const f of files) { const top = f.includes('/') ? f.split('/')[0] + '/' : '.'; by[top] = by[top] || { n: 0, ext: {} }; by[top].n++; const e = (f.match(/\.\w+$/) || ['-'])[0]; by[top].ext[e] = (by[top].ext[e] || 0) + 1; }
  for (const [d, v] of Object.entries(by).sort((a, b) => b[1].n - a[1].n)) console.log(`${d.padEnd(14)} ${String(v.n).padStart(5)} files  ${Object.entries(v.ext).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e, n]) => e + ' ' + n).join(', ')}`);
} else {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 8).join('\n').replace(/^\/\/ ?/gm, ''));
}
