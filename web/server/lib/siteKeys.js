'use strict'

// Ed25519 for the site. Two different keys live in this system and confusing them is the
// one mistake that would matter:
//
//   THE SITE KEY   signs invite tokens. The site holds the private half; a game box only
//                  ever holds the public half (GET /api/gs/keys). A stolen box therefore
//                  cannot mint a join for anyone.
//   A BOX KEY      signs replay footers. The box holds the private half; THE SITE PINS THE
//                  PUBLIC HALF (lib/boxes.js). This is the half that stops a valid-looking
//                  replay signed by a stranger being accepted as evidence.
//
// Everything here mirrors `infra/host-agent/lib/keys.js` exactly — the same raw-32-byte
// base64url representation, the same DER prefixes, the same key-id derivation — because the
// two halves of a signature check have to agree about what a key IS.
//
// node:crypto has Ed25519 built in. No dependency.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { b64u, unb64u } = require('./util')

const KEY_DIR = process.env.ZM_KEY_DIR || path.join(__dirname, '..', '..', 'keys')

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function publicFromRaw(raw) {
  const b = Buffer.isBuffer(raw) ? raw : unb64u(raw)
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, b]), format: 'der', type: 'spki' })
}

function privateFromRaw(raw) {
  const b = Buffer.isBuffer(raw) ? raw : unb64u(raw)
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, b]), format: 'der', type: 'pkcs8' })
}

const sign = (privateKey, data) => crypto.sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data), privateKey)

function verify(publicKey, data, sig) {
  try { return crypto.verify(null, Buffer.isBuffer(data) ? data : Buffer.from(data), publicKey, sig) } catch { return false }
}

const keyIdOf = (pubRaw) => crypto.createHash('sha256').update(unb64u(pubRaw)).digest('hex').slice(0, 16)

// The site's own invite-signing pair. Generated on first boot into web/keys/ (gitignored).
//
// THIS IS A DEVELOPMENT KEY. A production site is handed its key out of band; the private
// half must never live in the repo, and rotating it invalidates every outstanding invite,
// which is fine because an invite lives for five minutes.
function loadOrCreate(file) {
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { pub: j.pub, priv: j.priv, publicKey: publicFromRaw(j.pub), privateKey: privateFromRaw(j.priv), keyId: j.key_id }
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pub = b64u(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))
  const priv = b64u(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32))
  const keyId = keyIdOf(pub)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ key_id: keyId, pub, priv, created: new Date().toISOString() }, null, 2))
  try { fs.chmodSync(file, 0o600) } catch { /* Windows: best effort */ }
  return { pub, priv, publicKey, privateKey, keyId }
}

let cached = null
function site() {
  if (!cached) cached = loadOrCreate(path.join(KEY_DIR, 'site-invite.json'))
  return cached
}

module.exports = { site, publicFromRaw, privateFromRaw, sign, verify, keyIdOf, loadOrCreate, KEY_DIR }
