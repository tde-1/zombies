#!/usr/bin/env node
// lease-cli — press Start for a party, from a shell.
//
//   node web/tools/lease-cli.js --map nazi_zombie_prototype --player 76561198126330106
//   node web/tools/lease-cli.js --match m_1234abcd --watch        # follow a lease to ready
//   node web/tools/lease-cli.js --match m_1234abcd --cancel
//   node web/tools/lease-cli.js --map <bsp> --player 76561198000000001 --proof   # a map not yet in SERVER_PROVEN
//   node web/tools/lease-cli.js --map <bsp> --player 76561198000000003 --dev-god  # soak: Custom + test god mode
//   node web/tools/lease-cli.js --map <bsp> --player 76561198000000003 --dev-god --dev-bots 2  # + 2 soak bots (dedi.md §26)
//
// WHY THIS EXISTS, and what it is NOT. The real Start button is `POST /api/launcher/play`
// -> `parties.launch()`, and it needs a signed-in SESSION. On the live site a session can
// only come from Steam OpenID in a browser, which is a credential an agent must not have
// and a person an agent must not pretend to be (`register-box.js` says the same thing about
// the admin routes, for the same reason).
//
// So this is the same call, from a shell, run by an operator on the machine that owns the
// database: it creates the party, sets the map and the mode, marks the members ready and
// calls `parties.launch()` — the site's own code, the site's own invite key, the site's own
// assignment row. Nothing here mints a token, forges a session or writes a table by hand.
//
// What it does NOT prove: the sign-in, the party UI, the ready check as a player drives it,
// and the launcher's `/api/launcher/play` poll. A run that uses this must say so.
//
// BACK THE DATABASE UP FIRST — this writes to the live `web/data/zombies.db`. `--backup`
// does it, into `web/data/backup-<ISO>/`, which is the convention already in that folder.
const fs = require('fs')
const path = require('path')

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const mapKey = arg('map')
const players = String(arg('player', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
// --dev-bots N (1..4, dedi.md §26): server-side soak bots that kill zombies so rounds advance.
// Agent leases only, like --dev-god, and it implies Custom mode the same way.
const devBots = arg('dev-bots') === null ? 0 : Number(arg('dev-bots'))
if (devBots && !(Number.isInteger(devBots) && devBots >= 1 && devBots <= 4)) {
  console.error('--dev-bots takes a whole number 1..4'); process.exit(2)
}
const mode = (arg('dev-god') === true || devBots > 0) ? 'custom' : arg('mode', 'verified')
const watchId = arg('match')
const wantCancel = arg('cancel') === true
const wantWatch = arg('watch') === true || (!!watchId && !wantCancel)
// --dev-god (dedi.md §23): an agent's SOAK lease. Forces Custom mode (a Verified lease can
// never carry it) and puts `settings.dev.god` on the lease; the host turns that into
// ENW_DEV_KNOBS=1 + ENW_DEV_GOD=1 for this one game only because the lease is an agent's
// (the site drops `dev` from every other lease, the host requires `agent` + custom), and
// the DLL's referee reports `enw_dev_knobs 1`, so the run can never be a record.
const devGod = arg('dev-god') === true

if (!mapKey && !watchId) {
  console.error('usage: lease-cli.js --map <bsp> --player <id64>[,<id64>...] [--mode verified|custom] [--game-mode <id>] [--dev-god]')
  console.error('       lease-cli.js --match <match_id> [--watch | --cancel]')
  process.exit(2)
}

// --proof: boot a map that is not (yet) in maps.js SERVER_PROVEN, to prove whether it loads
// on the box at all. Only this process sees the override; see maps.js PROOF_MAPS.
if (arg('proof') === true && mapKey) process.env.ZM_PROOF_MAPS = String(mapKey)

// AN AGENT LEASE (lib/assignments.js "SEVERAL GAMES PER BOX"). Everything this tool leases
// is an agent's unless `--real` says a person is going to play it: it may use the box's
// reserve slot, it never takes the last slot a real player is entitled to, and a real
// player's Play supersedes it when the box is full. `--real` is for leasing on B's behalf.
if (arg('real') !== true) process.env.ZM_AGENT_LEASE = '1'

const DATA_DIR = process.env.ZM_DATA_DIR || path.join(__dirname, '..', 'data')
const DB_PATH = process.env.ZM_DB_PATH || path.join(DATA_DIR, 'zombies.db')
if (!fs.existsSync(DB_PATH)) { console.error(`no database at ${DB_PATH}`); process.exit(1) }

if (arg('backup') === true) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')
  const dir = path.join(DATA_DIR, `backup-${stamp}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['zombies.db', 'zombies.db-wal', 'zombies.db-shm']) {
    const src = path.join(DATA_DIR, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f))
  }
  console.log(`backed up to ${dir}`)
}

const { db } = require('../server/db/database')
const parties = require('../server/lib/parties')
const assignments = require('../server/lib/assignments')

// ---- --match: watch or cancel an existing lease ----------------------------------------
if (watchId && wantCancel) {
  const r = assignments.cancel(String(watchId), 'lease-cli')
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
}

async function watch(matchId, leaderId) {
  const until = Date.now() + 180_000
  let last = null
  while (Date.now() < until) {
    const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(String(matchId))
    if (!a) { console.log(`${matchId}: gone`); return 1 }
    const info = leaderId ? parties.launchInfo(String(leaderId)) : null
    const line = `${a.state}${info && info.connect ? ` connect=${info.connect}` : ''}`
    if (line !== last) { console.log(`${matchId}: ${line}`); last = line }
    if (info && info.connect) {
      // The one thing a caller actually needs, on one line it can parse.
      console.log(JSON.stringify({
        match_id: info.match_id, map: info.map, fs_game: info.fs_game,
        mode: info.mode, connect: info.connect, token: info.token,
      }))
      return 0
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.error(`${matchId}: the box never reported ready`)
  return 1
}

if (watchId && wantWatch) {
  const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(String(watchId))
  if (!a) { console.error('no such lease'); process.exit(1) }
  const p = a.party_id ? db.prepare('SELECT leader FROM parties WHERE id=?').get(a.party_id) : null
  watch(String(watchId), p && p.leader).then((c) => process.exit(c))
} else {
  // ---- the Start press -------------------------------------------------------------
  const leader = players[0]
  if (!leader) { console.error('--player is required'); process.exit(2) }

  // Leave whatever party each player is in, so a stale one from an earlier run cannot
  // silently be the thing we launch.
  for (const p of players) parties.leave(p)

  const party = parties.create(leader, { mode, mapKey, visibility: 'private' })
  for (const p of players.slice(1)) {
    db.prepare('INSERT OR IGNORE INTO party_members (party_id, steam_id, ready, joined_at) VALUES (?,?,0,?)')
      .run(party.id, String(p), Date.now())
  }
  parties.setMap(leader, mapKey)
  parties.setMode(leader, mode)
  // --game-mode gungame: the map's own mode (game-modes.md), as a leader would pick it.
  if (arg('game-mode') && arg('game-mode') !== true) {
    const gm = parties.setGameMode(leader, String(arg('game-mode')))
    if (!gm.ok) { console.error(`--game-mode: ${gm.error}`); process.exit(1) }
  }
  if (devGod || devBots) {
    if (arg('real') === true) { console.error('--dev-god / --dev-bots are for agent leases only (drop --real)'); process.exit(2) }
    const dev = {}
    if (devGod) dev.god = true
    if (devBots) dev.bots = devBots
    const st = parties.setSettings(leader, { dev })
    if (!st.ok) { console.error(`--dev-god/--dev-bots: ${st.error}`); process.exit(1) }
    console.log(`dev lease: Custom mode, settings.dev ${JSON.stringify(dev)} (TEST ONLY: never a record)`)
  }
  // `force` on the ready check is the leader's own override — it is there because nobody's
  // launcher has reported a map download for a party this CLI just invented.
  const rc = parties.startReadyCheck(leader, { force: true })
  if (!rc.ok) { console.error(rc.error); process.exit(1) }
  for (const p of players) parties.setReady(p, true)

  const r = parties.launch(leader, {})
  if (!r.ok) { console.error(`launch refused: ${r.error}`); process.exit(1) }
  console.log(`leased ${r.match_id} on ${r.box} — ${mapKey} (${mode}), ${players.length} player(s)`)
  watch(r.match_id, leader).then((c) => process.exit(c))
}
