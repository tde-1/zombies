// Telling the party where your copy of the map has got to.
//
// `POST /api/party/:id/progress` (docs/protocol/launcher-v0.md §2), with the ordinary
// session cookie the launcher already shares with the wrapped page. The site keeps it
// in memory, draws a bar per member on the party panel, and — the reason the feature
// exists — **stands the leader's Start button down while any member is still
// downloading**. A party of four where one person is still pulling 600 MB used to
// press Start and boot a game three of them could join.
//
// Three rules, and the first one is the one that is easy to get wrong:
//
// 1. **NOTHING IS SENT WHEN THERE IS NO PARTY GAME.** A player installing a map from
//    the library rail, or playing locally, is not reporting to anybody. The gate is a
//    party id, and the only thing that produces one is the site saying (in
//    `/api/launcher/play`) that there is a party AND that the map being installed is
//    the map the leader staged. No party, a different map, or signed out → this class
//    is never constructed and not one request leaves the machine. `attach()` below is
//    the single place that decision is made, so it cannot drift.
//
// 2. **~1 Hz while downloading, and always at a state change.** The site's floor is
//    400 ms per member and it drops what arrives too fast rather than refusing it, so
//    a bit over that costs nothing and 1 Hz is what a bar needs. `installed` and
//    `failed` are terminal, are never throttled, and are never sent twice.
//
// 3. **Never a reason the install fails.** Every post is fire-and-forget: a 4xx, a
//    dead tunnel or a site restart in the middle of a 600 MB download must not take
//    the download with it. The worst case is a bar that stops moving.
//
// `installed` means the hash check passed — it is sent from the success path of
// `library.install` / `installFromSite`, both of which throw rather than return when a
// file does not match what the archive recorded.

const MIN_MS = 900          // ~1 Hz. The site's own floor is 400 ms.

export class PartyProgress {
  /**
   * @param {object}  o
   * @param {object}  o.api      a SiteApi (its `req` carries the session cookie)
   * @param {number}  o.partyId  the party this download belongs to
   * @param {string}  o.map      the bsp the leader staged
   */
  constructor({ api, partyId, map, minMs = MIN_MS, log = null } = {}) {
    this.api = api
    this.partyId = Number(partyId)
    this.map = String(map || '')
    this.minMs = minMs
    this.log = log
    this.lastAt = 0
    this.total = 0
    this.bytes = 0
    this.done = false          // a terminal state was sent; nothing follows it
    this.sent = 0
    this.failedPosts = 0
  }

  get live() { return !!this.api && Number.isFinite(this.partyId) && this.partyId > 0 && !this.done }

  /** One progress tick from the installer. Throttled; safe to call per chunk. */
  downloading(bytes, total) {
    if (Number.isFinite(total) && total > 0) this.total = Math.floor(total)
    if (Number.isFinite(bytes) && bytes >= 0) this.bytes = Math.floor(bytes)
    const now = Date.now()
    if (now - this.lastAt < this.minMs) return null
    this.lastAt = now
    return this.post({ state: 'downloading', bytes: this.bytes, total: this.total })
  }

  /** The hash check passed and the map is on disk. Terminal, never throttled. */
  installed(bytes = null) {
    const b = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : this.bytes || this.total
    const p = this.post({ state: 'installed', bytes: b, total: this.total || b })
    this.done = true
    return p
  }

  /** The download or the hash check failed. Terminal, never throttled. */
  failed(error) {
    const p = this.post({ state: 'failed', bytes: this.bytes, total: this.total, error: String(error?.message || error || '').slice(0, 200) })
    this.done = true
    return p
  }

  // Fire and forget, always. Rule 3.
  post(body) {
    if (!this.live && !body.state.match(/^(installed|failed)$/)) return null
    if (!this.api || !(this.partyId > 0)) return null
    this.sent++
    return this.api
      .req(`/api/party/${this.partyId}/progress`, { method: 'POST', body: { map: this.map, ...body }, timeoutMs: 4000 })
      .then((r) => {
        if (!r.ok) {
          this.failedPosts++
          this.log?.(`party progress: the site answered ${r.status}${r.data?.error ? ` (${r.data.error})` : ''}`)
        }
        return r
      })
      .catch((e) => { this.failedPosts++; this.log?.(`party progress: ${e.message}`); return null })
  }
}

/**
 * The gate (rule 1). Returns a reporter only when this install really is a party
 * member's copy of the party's map; otherwise null, and nothing is ever sent.
 *
 * `play` is the last `/api/launcher/play` body. It is the site's own view of the
 * party, which is why it — and not anything the launcher guessed — decides this.
 */
export function attach(api, play, bsp, { log = null } = {}) {
  if (!api || !play || play.signedOut) return null
  const partyId = Number(play.party?.id || 0)
  if (!(partyId > 0)) return null                       // not in a party: say nothing
  const staged = play.map?.key || play.map?.bsp || null
  // The map the leader is switching to while a game runs (`pending_map`) is the party's too.
  const pending = play.pending_map?.key || null
  if ((!staged || String(staged) !== String(bsp)) && (!pending || String(pending) !== String(bsp))) return null   // a different map: not this party's business
  return new PartyProgress({ api, partyId, map: bsp, log })
}
