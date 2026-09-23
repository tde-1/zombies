'use strict'

// Party invites over HTTP, through the real router: Movement's party invites (by ENW name,
// accept / decline / withdraw, the socket notices) plus what zombies adds (half-hour
// expiry, the invite link). Sessions are stood in by a header the harness turns into
// `req.session.steam_id`, then the real `attach` and guards run.
//
//   node test/invites.js

const fs = require('fs')
const os = require('os')
const path = require('path')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-inv-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')

let pass = 0
let fail = 0
const out = []
async function check(name, fn) {
  try { await fn(); pass++; out.push(['ok  ', name]) } catch (e) { fail++; out.push(['FAIL', `${name} — ${e.message}`]) }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }

const { db } = require('../server/db/database')
const users = require('../server/lib/users')
const parties = require('../server/lib/parties')

const LEAD = '76561198000000401'   // tinned_peaches, leads
const GUEST = '76561198000000402'  // mule_kicker, a stranger to LEAD
const THIRD = '76561198000000403'  // staminup
const WAIT = '76561198000000404'   // on the waiting list
users.ensure(LEAD, { enw_name: 'tinned_peaches' })
users.ensure(GUEST, { enw_name: 'mule_kicker' })
users.ensure(THIRD, { enw_name: 'staminup' })
users.ensure(WAIT, { enw_name: 'waiting_one' })
db.prepare('UPDATE users SET approved=1 WHERE steam_id<>?').run(WAIT)
db.prepare('UPDATE users SET approved=0 WHERE steam_id=?').run(WAIT)

// What the sockets would have carried: [to, event, payload].
const sent = []
parties.setEmitter((ids, event, payload) => { for (const id of ids) sent.push([id, event, payload]) })
const got = (to, event) => sent.filter((s) => s[0] === to && s[1] === event)

async function main() {
  const express = require('express')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.session = { steam_id: req.headers['x-sid'] || null }; next() })
  app.use(require('../server/middleware/auth').attach)
  app.use('/api', require('../server/routes/site').router())
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (as, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...(as ? { 'x-sid': as } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    let j = null
    try { j = await r.json() } catch { /* empty */ }
    return { status: r.status, body: j }
  }

  let inviteId = 0
  await check('invite by ENW name: a party is made from the stage, the invitee is told', async () => {
    const r = await call(LEAD, 'POST', '/api/party/invite', { username: 'mule_kicker', stage: { visibility: 'private' } })
    eq(r.status, 200, 'status')
    inviteId = r.body.invite_id
    truthy(inviteId, 'invite id')
    eq(r.body.party.visibility, 'private', 'the stage came across')
    const rx = got(GUEST, 'invite_received')
    eq(rx.length, 1, 'invite_received to the invitee')
    eq(rx[0][2].invite.from.name, 'tinned_peaches', 'the toast can name who')
    truthy(rx[0][2].invite.expires_at > Date.now(), 'and when it runs out')
  })
  await check('pressing invite twice is one invite and one toast', async () => {
    await call(LEAD, 'POST', '/api/party/invite', { username: 'mule_kicker' })
    eq(got(GUEST, 'invite_received').length, 1, 'toasts')
    eq((await call(GUEST, 'GET', '/api/party')).body.invites.length, 1, 'cards')
  })
  await check('unknown name, yourself, signed out, waiting list: all refused', async () => {
    eq((await call(LEAD, 'POST', '/api/party/invite', { username: 'nobody_by_that_name' })).status, 400, 'unknown')
    eq((await call(LEAD, 'POST', '/api/party/invite', { steam_id: LEAD })).status, 400, 'self')
    eq((await call(null, 'POST', '/api/party/invite', { username: 'mule_kicker' })).status, 401, 'signed out')
    eq((await call(WAIT, 'POST', '/api/party/invite', { username: 'mule_kicker' })).status, 403, 'waiting list')
  })
  await check('only the invitee can accept; accept opens a private lobby; the party hears', async () => {
    eq((await call(THIRD, 'POST', `/api/party/invites/${inviteId}/accept`)).status, 400, 'somebody else')
    sent.length = 0
    const r = await call(GUEST, 'POST', `/api/party/invites/${inviteId}/accept`)
    eq(r.status, 200, `status ${JSON.stringify(r.body)}`)
    eq(r.body.party.members.length, 2, 'in the party')
    const n = got(LEAD, 'party_updated')
    eq(n.length, 1, 'leader told')
    eq(n[0][2].notice.kind, 'joined')
    eq(n[0][2].notice.username, 'mule_kicker')
    const again = await call(GUEST, 'POST', `/api/party/invites/${inviteId}/accept`)
    eq(again.body.error, 'that invite is gone', 'an invite is used once')
  })
  await check('a used invite cannot be accepted by anyone else later', async () => {
    eq((await call(GUEST, 'GET', '/api/party')).body.invites.length, 0, 'card gone')
  })

  await check('decline: only the invitee; the party gets "<name> declined."', async () => {
    const r = await call(LEAD, 'POST', '/api/party/invite', { steam_id: THIRD })
    const id = r.body.invite_id
    eq((await call(GUEST, 'POST', `/api/party/invites/${id}/decline`)).status, 400, 'not theirs')
    sent.length = 0
    eq((await call(THIRD, 'POST', `/api/party/invites/${id}/decline`)).status, 200, 'declined')
    const n = got(LEAD, 'party_updated').find((s) => s[2].notice)
    eq(n && n[2].notice.kind, 'declined', 'notice')
    eq((await call(THIRD, 'POST', `/api/party/invites/${id}/accept`)).status, 400, 'a declined invite is gone')
  })
  await check('withdraw: the invitee is told and the card goes', async () => {
    const id = (await call(LEAD, 'POST', '/api/party/invite', { steam_id: THIRD })).body.invite_id
    sent.length = 0
    eq((await call(LEAD, 'POST', `/api/party/invites/${id}/cancel`)).status, 200, 'withdrawn')
    const w = got(THIRD, 'invite_withdrawn')
    eq(w.length, 1, 'told')
    eq(w[0][2].notice.kind, 'withdrawn')
    eq((await call(THIRD, 'GET', '/api/party')).body.invites.length, 0, 'card gone')
  })
  await check('an invite runs out after half an hour: hidden, refused, and re-inviting restarts it', async () => {
    const id = (await call(LEAD, 'POST', '/api/party/invite', { steam_id: THIRD })).body.invite_id
    db.prepare('UPDATE party_invites SET created_at=? WHERE id=?').run(Date.now() - parties.INVITE_TTL_MS - 1000, id)
    eq((await call(THIRD, 'GET', '/api/party')).body.invites.length, 0, 'not listed')
    const a = await call(THIRD, 'POST', `/api/party/invites/${id}/accept`)
    eq(a.status, 400, 'refused')
    eq(a.body.error, 'that invite expired')
    eq(parties.join(THIRD, parties.forPlayer(LEAD).id).ok, false, 'and it no longer opens the private lobby')
    const again = await call(LEAD, 'POST', '/api/party/invite', { steam_id: THIRD })
    truthy(again.body.invite_id !== id, 'a fresh invite')
    eq((await call(THIRD, 'GET', '/api/party')).body.invites.length, 1, 'listed again')
    await call(LEAD, 'POST', `/api/party/invites/${again.body.invite_id}/cancel`)
  })

  let code = ''
  await check('the invite link: any member gets the same one, it opens the private lobby', async () => {
    const a = await call(LEAD, 'POST', '/api/party/link', {})
    eq(a.status, 200, 'status')
    code = a.body.code
    truthy(/^[A-Z2-9]{8}$/.test(code), `code ${code}`)
    eq(a.body.path, `/party/${code}`)
    eq(a.body.deeplink, `enw-zombies://party/${code}`)
    eq((await call(GUEST, 'POST', '/api/party/link', {})).body.code, code, 'a member shares the same link')
    const pv = await call(THIRD, 'GET', `/api/party/link/${code.toLowerCase()}`)
    eq(pv.status, 200, 'preview, any case')
    eq(pv.body.party.leader.name, 'tinned_peaches')
    eq(pv.body.party.size, 2)
    eq(pv.body.party.mine, false)
    const j = await call(THIRD, 'POST', `/api/party/link/${code}/join`)
    eq(j.status, 200, `join ${JSON.stringify(j.body)}`)
    eq(j.body.party.members.length, 3)
  })
  await check('the link does not reveal itself in the party the public sees', async () => {
    const p = parties.forPlayer(LEAD)
    eq(JSON.stringify(p).includes(code), false, 'link code in the projection')
  })
  await check('the leader can change the link; the old one is dead; a member cannot', async () => {
    eq((await call(GUEST, 'POST', '/api/party/link/reset')).status, 400, 'member')
    const r = await call(LEAD, 'POST', '/api/party/link/reset')
    eq(r.status, 200)
    truthy(r.body.code !== code, 'new code')
    eq((await call(WAIT, 'GET', `/api/party/link/${code}`)).status, 404, 'old link dead')
    eq((await call(WAIT, 'POST', `/api/party/link/${r.body.code}/join`)).status, 403, 'waiting list cannot join by link')
  })
  await check('a full party refuses the link', async () => {
    const fourth = '76561198000000405'
    users.ensure(fourth, { enw_name: 'fourth_one' })
    db.prepare('UPDATE users SET approved=1 WHERE steam_id=?').run(fourth)
    const c = (await call(LEAD, 'POST', '/api/party/link', {})).body.code
    eq((await call(fourth, 'POST', `/api/party/link/${c}/join`)).status, 200, 'fourth fits')
    const fifth = '76561198000000406'
    users.ensure(fifth, { enw_name: 'fifth_one' })
    db.prepare('UPDATE users SET approved=1 WHERE steam_id=?').run(fifth)
    const r = await call(fifth, 'POST', `/api/party/link/${c}/join`)
    eq(r.status, 400)
    eq(r.body.error, 'that lobby is full')
  })
  await check('link lookups are rate-limited', async () => {
    const who = '76561198000000407'
    users.ensure(who, { enw_name: 'guesser' })
    let limited = 0
    for (let i = 0; i < 25; i++) if ((await call(who, 'GET', '/api/party/link/AAAAAAAA')).status === 429) limited++
    truthy(limited >= 4, `429s: ${limited}`)
  })
  await check('leaving empties the party: every pending invitee is told it closed', async () => {
    const solo = '76561198000000408'
    const target = '76561198000000409'
    users.ensure(solo, { enw_name: 'solo_host' })
    users.ensure(target, { enw_name: 'target_one' })
    db.prepare('UPDATE users SET approved=1 WHERE steam_id IN (?,?)').run(solo, target)
    await call(solo, 'POST', '/api/party/invite', { steam_id: target })
    sent.length = 0
    await call(solo, 'POST', '/api/party/leave')
    const w = got(target, 'invite_withdrawn')
    eq(w.length, 1, 'told')
    eq(w[0][2].notice.kind, 'closed')
    eq((await call(target, 'GET', '/api/party')).body.invites.length, 0, 'card gone')
  })
  await check('kick: the kicked player hears it, the rest hear who went', async () => {
    sent.length = 0
    eq((await call(LEAD, 'POST', '/api/party/kick', { steam_id: THIRD })).status, 200)
    eq(got(THIRD, 'party_updated')[0][2].notice.kind, 'kicked')
    eq(got(GUEST, 'party_updated')[0][2].notice.kind, 'removed')
  })

  server.close()
  for (const [a, b] of out) console.log(a, b)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
