'use strict'
// THE SCRUBBER — what never leaves a machine inside a log bundle (docs/kickstart/telemetry.md §4).
//
// One file, three copies, byte-identical, and a test in each suite that says so:
//   shared/telemetry/scrub.cjs                  canonical; the site requires this one
//   launcher/src/main/telemetry/scrub.cjs       packaged into the launcher's asar
//   infra/host-agent/lib/telemetry/scrub.cjs    scp'd to the box with the agent
// `node tools/telemetry/sync-shared.js` copies the canonical file over the other two.
// CommonJS on purpose: the site is CJS, the launcher and the host agent are ESM, and ESM can
// import a .cjs file (named exports come through cjs-module-lexer for the literal below).
//
// What it redacts (each rule has a test in web/test/telemetry.js):
//   * literal secrets the caller hands in (the box secret, the beta password, S3 keys) —
//     the only rule that knows the VALUE rather than the shape, so it is the one that
//     cannot miss;
//   * our cvars and env names that carry identity: enw_token / enw_auth / enw_chat_pass …;
//   * signed tokens: invite tokens `b64u(body).b64u(sig)` and chat passes `gc1.body.sig`;
//   * `name = value` / `"name": "value"` where the name says secret, token, password, key,
//     cookie, session, authorization, match_key, shared_secret, identity_secret …;
//   * Authorization: Basic/Bearer headers; our cookies (zm.sid, zm_gate);
//   * the launcher's per-launch token pipe name;
//   * ?token= / ?key= / ?sig= / ?secret= in URLs, and enw-zombies:// join/invite links.
// Files it refuses outright, whatever they contain: isForbiddenFile().
//
// It does NOT touch binary files. A minidump is process memory and may hold a short-lived
// invite token or chat pass (5 min / hours); that is accepted and written down in
// telemetry.md, because the dump is the most useful thing a crash leaves behind.

const REDACTED = '<redacted>'

// Names whose VALUE is a secret. Matched case-insensitively as a whole word-ish token.
const SECRET_NAMES = [
  'enw_token', 'enw_auth', 'enw_chat_pass', 'enw_chat_bearer', 'enw_invite', 'enw_pass',
  'x-match-secret', 'match_key', 'match_secret', 'host_secret', 'ENW_SECRET', 'ENW_HOST_SECRET',
  'shared_secret', 'identity_secret', 'revocation_code',
  'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'aws_access_key_id', 'aws_secret_access_key', 'accessKeyId', 'secretAccessKey',
  'ZM_SITE_PASSWORD', 'ZM_SESSION_SECRET', 'ZM_ENW_TOKEN', 'STEAM_API_KEY',
  'password', 'passwd', 'secret', 'token', 'bearer', 'api_key', 'apikey', 'private_key', 'privateKey',
  'session_secret', 'cookie', 'authorization', 'invite_token', 'chat_token', 'chat_pass',
]
// Keys in a JSON object whose value is replaced (scrubJson). Broader than SECRET_NAMES,
// because a key name is unambiguous where free text is not.
const SECRET_KEY_RE = /(secret|token|password|passwd|cookie|authori[sz]ation|bearer|api_?key|private_?key|access_?key|match_key|shared_secret|identity_secret|revocation|session_?id|^sid$|^pass$|^uri$)/i
// …but these are not secrets, and redacting them would blind the flag rules.
const KEY_ALLOW = /^(map_key|key_id|keyId|key_pinned|token_ok|token_reason|tokens_seen|replay_key_id|pub|sha256|sha|hash)$/i

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NAMES_ALT = SECRET_NAMES.map(esc).join('|')
// A secret name, optionally with segments joined by _ - . on either side.
const NAME_WORD = `(?:[A-Za-z0-9]+[_.-])*(?:${NAMES_ALT})(?:[_-][A-Za-z0-9]+)*`
// Values that are plainly not secrets (booleans, counts, a redaction already made), and
// names on the allow list, are left alone so the flag rules can still read them.
const skipName = (name, v) => KEY_ALLOW.test(String(name).replace(/^["']|["']$/g, '')) ||
  /^["']?(<redacted|<token|<secret|basic|bearer|true|false|null|undefined|none|ok|missing|absent|set|unset|\d{1,6})["']?$/i.test(String(v))

// name=value, name: value, "name": "value", seta name "value", set name value
const RULES = [
  // Authorization headers first, so "Basic <b64>" goes as a unit.
  { id: 'auth_header', re: /\b(authorization\s*[:=]\s*)(basic|bearer)\s+[A-Za-z0-9+/=._~-]+/gi, to: (m, a, b) => `${a}${b} ${REDACTED}` },
  { id: 'bearer', re: /\b(bearer\s+)[A-Za-z0-9+/=._~-]{12,}/gi, to: (m, a) => `${a}${REDACTED}` },
  // WaW config lines: seta/set/setu <name> "<value>"
  { id: 'cvar', re: new RegExp(`\\b(set[asu]?\\s+(?:${NAMES_ALT})\\s+)("[^"\\r\\n]*"|\\S+)`, 'gi'), to: (m, a) => `${a}"${REDACTED}"` },
  // JSON-ish "name": "value". The name may carry a prefix/suffix joined by _ - or .
  // (s3_secret_key, x-match-secret) but not letters (security, tokens).
  { id: 'json', re: new RegExp(`("(${NAME_WORD})"\\s*:\\s*)("(?:[^"\\\\\\r\\n]|\\\\.)*"|[^,}\\s]+)`, 'gi'), to: (m, a, name, v) => (skipName(name, v) ? m : `${a}"${REDACTED}"`) },
  // name=value / name: value  (env files, query strings, log lines)
  { id: 'kv', re: new RegExp(`((?:^|[^\\w.-])(${NAME_WORD})\\s*[:=]\\s*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s&,;"')]+)`, 'gim'), to: (m, a, name, v) => (skipName(name, v) ? m : `${a}${REDACTED}`) },
  // Cookies by name.
  { id: 'cookie', re: /\b(zm\.sid|zm_gate|connect\.sid)=([^;\s"]+)/g, to: (m, a) => `${a}=${REDACTED}` },
  // The launcher's per-launch token pipe.
  { id: 'pipe', re: /(\\\\\.\\pipe\\enw-launch-)[0-9a-f]+/gi, to: (m, a) => `${a}${REDACTED}` },
  // Deep links that carry an invite.
  { id: 'deeplink', re: /\b(enw-zombies:\/\/(?:join|invite|accept|signin|auth)[/?][^\s"'<>]*)/gi, to: (m) => m.replace(/([/?=])[A-Za-z0-9_.~-]{16,}/g, `$1${REDACTED}`) },
  // Signed tokens: invite tokens (b64u.b64u(64-byte sig) = 86 chars) and gc1 chat passes.
  { id: 'chat_pass', re: /\bgc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/g, to: () => `<token ${REDACTED}>` },
  { id: 'signed_token', re: /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{40,}\b/g, to: () => `<token ${REDACTED}>` },
]

/**
 * Scrub free text. `secrets` is a list of literal values known to be secret on this
 * machine (anything shorter than 6 characters is ignored: it would redact half the log).
 * Returns { text, hits } where hits counts replacements per rule id.
 */
function scrubText (text, { secrets = [] } = {}) {
  let s = String(text == null ? '' : text)
  const hits = {}
  const count = (id, n) => { if (n) hits[id] = (hits[id] || 0) + n }
  for (const v of secrets) {
    const lit = String(v || '')
    if (lit.length < 6) continue
    let n = 0
    s = s.split(lit).join('\u0000') // count without a regex over an arbitrary literal
    n = (s.match(/\u0000/g) || []).length
    s = s.replace(/\u0000/g, `<secret ${REDACTED}>`)
    count('literal', n)
  }
  for (const r of RULES) {
    let n = 0
    s = s.replace(r.re, (...m) => { const out = r.to(...m); if (out !== m[0]) n++; return out })
    count(r.id, n)
  }
  return { text: s, hits }
}

// Deep-copy a JSON value with secret-named keys replaced and strings scrubbed as text.
function scrubJson (v, opts = {}, depth = 0) {
  if (v == null || depth > 12) return v
  if (Array.isArray(v)) return v.map((x) => scrubJson(x, opts, depth + 1))
  if (typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY_RE.test(k) && !KEY_ALLOW.test(k)) o[k] = x == null || x === '' ? x : REDACTED
      else o[k] = scrubJson(x, opts, depth + 1)
    }
    return o
  }
  if (typeof v === 'string') return scrubText(v, opts).text
  return v
}

// Files that are never bundled, whatever they hold. Basename, case-insensitive.
const FORBIDDEN_FILES = [
  /^enw_auth\.cfg$/i, /\.mafile$/i, /^s3\.env$/i, /^site\.env$/i, /^enw-host\.env$/i, /\.env$/i,
  /^session-secret$/i, /\.pem$/i, /\.key$/i, /^id_(rsa|ed25519|ecdsa)/i, /^manifest\.json$/i,
  /^cookies(-journal)?$/i, /^login data$/i,
]
function isForbiddenFile (name) {
  const base = String(name || '').split(/[\\/]/).pop()
  // manifest.json is forbidden as an INPUT file name only because the bundle's own
  // manifest.json is written by the bundler; a caller's file of that name is renamed.
  return FORBIDDEN_FILES.some((re) => re.test(base))
}

// Text or binary, by extension. Text files are scrubbed; binary files pass untouched.
const TEXT_EXT = /\.(log|txt|json|cfg|csv|yml|yaml|ini|md|gsc|csc|arena|xml|html?|jsonl|out|err)$/i
const isTextName = (name) => TEXT_EXT.test(String(name || ''))

const sumHits = (hits) => Object.values(hits || {}).reduce((a, b) => a + b, 0)

module.exports = { scrubText, scrubJson, isForbiddenFile, isTextName, sumHits, REDACTED, SECRET_NAMES }
