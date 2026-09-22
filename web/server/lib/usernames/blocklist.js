'use strict'

// drops.ws's static reserved-username blocklist, MIRRORED (2026-09-22).
//
// Source: `csgo-server/src/utils/usernameBlocklist.js` and `src/data/reserved-usernames.csv`
// + `src/data/username-allowlist.txt` (the drops.ws repo, last touched in 4a0fa29,
// 2026-08-06). The two data files beside this one are byte-for-byte copies; the matcher
// below is that file's logic line for line, in this repo's style.
//
// WHY A COPY. drops.ws is the ENW name authority (CSGO-Matchmaker/server/lib/dropsNames.js).
// Movement does not carry this list — it asks drops.ws `GET /internal/name/check`, which
// needs the shared internal secret, and Zombies does not hold it (docs/kickstart/questions.md
// Q-id-1). Until it does, the only way a name picked HERE can never be one the authority
// would refuse is to refuse exactly what it refuses. Re-copy both files when drops.ws edits
// them; `test/run-all.js` checks a handful of known rows so a stale copy is not silent.
//
// Two match modes, as there:
//   exact    — the whole (normalised) username must equal the term.
//   contains — the term anywhere in the normalised username is blocked.
// Normalisation folds case, underscores/hyphens and leetspeak digits (the latter only on the
// CANDIDATE, so the handle `s1mple` is not folded to the word `simple`).

const fs = require('fs')
const path = require('path')

const LEET = { 4: 'a', 3: 'e', 1: 'i', 0: 'o', 5: 's', 7: 't', 8: 'b', 9: 'g', 6: 'g', 2: 'z' }
const normLeet = (s) => String(s).toLowerCase().replace(/[_-]/g, '').replace(/[0-9]/g, (c) => LEET[c] || c)
const normPlain = (s) => String(s).toLowerCase().replace(/[_-]/g, '')

function loadCsv (file) {
  const rows = []
  let text
  try { text = fs.readFileSync(path.join(__dirname, file), 'utf8') } catch (e) {
    console.error(`[names] username blocklist: could not read ${file} — ${e.message}`)
    return rows
  }
  for (const line of text.split(/\r?\n/).filter(Boolean).slice(1)) {
    const cells = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') inQ = false
        else cur += ch
      } else if (ch === '"') inQ = true
      else if (ch === ',') { cells.push(cur); cur = '' } else cur += ch
    }
    cells.push(cur)
    const [name, match, category] = cells
    if (name) rows.push({ name: name.trim(), match: (match || 'exact').trim(), category: (category || '').trim() })
  }
  return rows
}

function loadAllowlist () {
  try {
    return new Set(fs.readFileSync(path.join(__dirname, 'username-allowlist.txt'), 'utf8')
      .split(/\s+/).filter(Boolean).map(normLeet))
  } catch { return new Set() }
}

const ROWS = loadCsv('reserved-usernames.csv')
const EXACT = new Map(ROWS.filter((r) => r.match === 'exact').map((r) => [normPlain(r.name), r]))
const CONTAINS = ROWS.filter((r) => r.match === 'contains')
const ALLOW = loadAllowlist()

/** @returns {{blocked:boolean, term?:string, category?:string, mode?:string}} */
function checkBlocked (username) {
  const plain = normPlain(username)
  const leet = normLeet(username)
  if (!plain) return { blocked: false }
  if (ALLOW.has(leet)) return { blocked: false }
  const hit = EXACT.get(plain) || EXACT.get(leet)
  if (hit) return { blocked: true, term: hit.name, category: hit.category, mode: 'exact' }
  for (const r of CONTAINS) {
    if (leet.includes(r.name)) return { blocked: true, term: r.name, category: r.category, mode: 'contains' }
  }
  return { blocked: false }
}

module.exports = { checkBlocked, size: ROWS.length }
