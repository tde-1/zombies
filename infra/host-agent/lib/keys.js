// Ed25519 key handling. node:crypto has Ed25519 built in — no dependency.
//
// Two key pairs exist in this system and they are NOT the same:
//   * the SITE key   — signs invite tokens. Hosts only ever hold the PUBLIC half.
//   * the HOST key   — signs replay footers. One per game box; the site/verifier holds
//                      the public half so anyone can prove a replay is unmodified.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDirOf, b64u, unb64u } from './util.js'

export function generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { publicKey, privateKey }
}

export function exportPair(pair) {
  return {
    // raw 32-byte keys, base64url — small enough to paste into a JSON header.
    pub: b64u(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)),
    priv: b64u(pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)),
  }
}

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function publicFromRaw(raw) {
  const b = Buffer.isBuffer(raw) ? raw : unb64u(raw)
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, b]), format: 'der', type: 'spki' })
}

export function privateFromRaw(raw) {
  const b = Buffer.isBuffer(raw) ? raw : unb64u(raw)
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, b]), format: 'der', type: 'pkcs8' })
}

export function sign(privateKey, data) {
  return crypto.sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data), privateKey)
}

export function verify(publicKey, data, sig) {
  try {
    return crypto.verify(null, Buffer.isBuffer(data) ? data : Buffer.from(data), publicKey, sig)
  } catch { return false }
}

// Load (or create on first run) a key pair on disk. Dev convenience only — a real box
// gets its key provisioned, and the private half never leaves it.
export function loadOrCreate(file) {
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { pub: j.pub, priv: j.priv, publicKey: publicFromRaw(j.pub), privateKey: privateFromRaw(j.priv), keyId: j.key_id }
  }
  const pair = generate()
  const raw = exportPair(pair)
  const keyId = crypto.createHash('sha256').update(unb64u(raw.pub)).digest('hex').slice(0, 16)
  ensureDirOf(file)
  fs.writeFileSync(file, JSON.stringify({ key_id: keyId, ...raw, created: new Date().toISOString() }, null, 2))
  try { fs.chmodSync(file, 0o600) } catch { /* Windows: best effort */ }
  return { ...raw, publicKey: pair.publicKey, privateKey: pair.privateKey, keyId }
}

export function keyIdOf(pubRaw) {
  return crypto.createHash('sha256').update(unb64u(pubRaw)).digest('hex').slice(0, 16)
}

export const defaultKeyDir = () => path.join(process.env.LOCALAPPDATA || process.env.HOME || '.', 'enw-zombies', 'keys')
