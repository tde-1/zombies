'use strict'

// infra/discord.env -- the one place B pastes Discord values (lane INT, 2026-09-23).
//
// The site's environment normally comes only from infra/site.env, which keepalive.ps1 loads
// once at ITS own start (README rule 15: a site.env change needs the detached loop restarted).
// Discord's application id is public and B wants to paste it without that dance, so the server
// itself reads this one named file at start: a plain node restart (which the keepalive loop
// does on its own) picks it up.
//
// Deliberately narrow, so this never becomes a dotenv by the back door:
//   * one fixed path (infra/discord.env next to site.env), never the cwd or the repo root;
//   * only keys named ZM_DISCORD_* or ENW_DISCORD_* are taken, anything else is ignored;
//   * a value already in the environment (site.env via keepalive, or the shell) wins, except
//     an empty one.
// infra/discord.env.example is the committed template; the real file is gitignored (*.env).

const fs = require('fs')
const path = require('path')

const DEFAULT_FILE = path.join(__dirname, '..', '..', '..', 'infra', 'discord.env')
const KEY_RE = /^(ZM|ENW)_DISCORD_[A-Z0-9_]+$/

function parse(text) {
  const out = {}
  for (const raw of String(text || '').split(/\r?\n/)) {
    const t = raw.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const name = t.slice(0, eq).trim()
    const value = t.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2')
    if (!KEY_RE.test(name) || !value) continue
    out[name] = value
  }
  return out
}

// Returns the names it set (never the values).
function load(file = DEFAULT_FILE, env = process.env) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const set = []
  for (const [k, v] of Object.entries(parse(text))) {
    if (env[k]) continue
    env[k] = v
    set.push(k)
  }
  return set
}

module.exports = { load, parse, DEFAULT_FILE }
