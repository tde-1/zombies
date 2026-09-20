// Minimal Valve KeyValues (text VDF) reader.
//
// Used for libraryfolders.vdf, appmanifest_10090.acf and loginusers.vdf. Zero
// dependencies on purpose: this runs on a player's machine at first launch and a
// parser is not worth a supply chain.
//
// Handles: quoted keys/values, nested braces, // comments, \" \\ \n \t escapes,
// unquoted tokens, and the #base/#include directives (ignored — Steam does not use
// them in the three files we read).

export function parse(text) {
  const s = String(text)
  let i = 0

  function skip() {
    for (;;) {
      while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r' || s[i] === '\n')) i++
      if (s[i] === '/' && s[i + 1] === '/') {
        while (i < s.length && s[i] !== '\n') i++
        continue
      }
      return
    }
  }

  function token() {
    skip()
    if (i >= s.length) return null
    if (s[i] === '{' || s[i] === '}') return s[i++]
    if (s[i] === '"') {
      i++
      let out = ''
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const c = s[++i]
          out += c === 'n' ? '\n' : c === 't' ? '\t' : c === '\\' ? '\\' : c === '"' ? '"' : c
          i++
        } else {
          out += s[i++]
        }
      }
      i++ // closing quote
      return { str: out }
    }
    let out = ''
    while (i < s.length && !' \t\r\n{}"'.includes(s[i])) out += s[i++]
    return out.length ? { str: out } : null
  }

  function object() {
    const o = {}
    for (;;) {
      const k = token()
      if (k === null || k === '}') return o
      if (k === '{') continue // stray
      const key = k.str
      const v = token()
      if (v === null) return o
      if (v === '{') {
        const child = object()
        // Duplicate keys: keep the first, stash the rest under key#N (Steam does not
        // produce these in our files, but silently losing data is worse than ugly keys).
        if (key in o) o[`${key}#${Object.keys(o).filter((x) => x.startsWith(key)).length}`] = child
        else o[key] = child
      } else if (v === '}') {
        o[key] = ''
        return o
      } else {
        o[key] = v.str
      }
    }
  }

  // A VDF file is <rootkey> { ... }; return the whole thing including the root key.
  return object()
}

// Case-insensitive lookup, because Steam's own files are inconsistent
// ("LibraryFolders" vs "libraryfolders", "AppState" vs "appstate").
export function get(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined
  if (key in obj) return obj[key]
  const lk = String(key).toLowerCase()
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lk) return obj[k]
  return undefined
}

export function getPath(obj, ...keys) {
  let cur = obj
  for (const k of keys) {
    cur = get(cur, k)
    if (cur === undefined) return undefined
  }
  return cur
}
