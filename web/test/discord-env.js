'use strict'
// infra/discord.env loader (web/server/lib/discordEnv.js): only Discord keys, env wins.
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const D = require('../server/lib/discordEnv')

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); pass++; console.log(`ok   ${name}`) } catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`) }
}

check('parse: comments, blanks, quotes; only the keys code reads (never the public key or bot token)', () => {
  const p = D.parse('# c\n\nZM_DISCORD_CLIENT_ID=1453044191826415736\r\nENW_DISCORD_INVITE="https://x"\nZM_SITE_PASSWORD=nope\nSTEAM_API_KEY=nope\nZM_DISCORD_PUBLIC_KEY=abcd\nZM_DISCORD_BOT_TOKEN=secret\n# ENW_DISCORD_X=commented\n')
  assert.deepStrictEqual(p, { ZM_DISCORD_CLIENT_ID: '1453044191826415736', ENW_DISCORD_INVITE: 'https://x' })
})

check('load: sets missing or empty keys, never overrides a set one, missing file = nothing', () => {
  const f = path.join(os.tmpdir(), `discord-env-test-${process.pid}.env`)
  fs.writeFileSync(f, 'ZM_DISCORD_CLIENT_ID=111111111111111111\nENW_DISCORD_INVITE=https://a\n')
  try {
    const env = { ZM_DISCORD_CLIENT_ID: '', ENW_DISCORD_INVITE: 'https://site-env-wins' }
    assert.deepStrictEqual(D.load(f, env), ['ZM_DISCORD_CLIENT_ID'])
    assert.strictEqual(env.ZM_DISCORD_CLIENT_ID, '111111111111111111')
    assert.strictEqual(env.ENW_DISCORD_INVITE, 'https://site-env-wins')
    assert.deepStrictEqual(D.load(f + '.missing', {}), [])
  } finally { fs.unlinkSync(f) }
})

check('the default path is infra/discord.env and the committed example parses to nothing set', () => {
  assert.ok(D.DEFAULT_FILE.replace(/\\/g, '/').endsWith('/infra/discord.env'))
  const ex = fs.readFileSync(path.join(__dirname, '..', '..', 'infra', 'discord.env.example'), 'utf8')
  assert.deepStrictEqual(D.parse(ex), {})
})

console.log(`discord-env: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
