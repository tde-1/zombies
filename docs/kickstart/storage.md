# storage — the two object-storage buckets

The site runs on B's PC and reaches the internet through a Cloudflare tunnel. Every byte a
player downloads through it leaves over B's home uplink, **measured at 6.0 MB/s (≈48 Mbit/s)**
(`vps.md` §"Rate"), shared by everyone downloading at that moment. That is fine for pages and
hopeless for a 94 MB installer or a 1 GB map. B, 2026-09-22 late evening: *"Open a Hetzner
storage bucket to put all the installer updates and all the maps on … maps on one bucket, the
files we serve on another, as cheaply as possible."*

So the big files are **also** in two public Hetzner Object Storage buckets, and the site
answers a download with a **302 to the bucket copy** when the bucket has it. The site's URLs
stay the stable ones — nothing a launcher already knows changes.

## 1. The buckets

| bucket | location | holds | key layout |
|---|---|---|---|
| `enw-zombies-files` | Nuremberg (`nbg1`) | the launcher update feed | `updates/<name>` — every file in `web/public/updates/` |
| `enw-zombies-maps` | Nuremberg (`nbg1`) | what a launcher installs, and the replay geometry | `mods/<bsp>/<path>` — exactly the files `/api/maps/<bsp>/files` lists<br>`mapdata/<bsp>/<bsp>.glb` and `.meta.json` |

Endpoint `https://nbg1.your-objectstorage.com`. Public URL form (virtual-hosted):
`https://<bucket>.nbg1.your-objectstorage.com/<key>`, e.g.
`https://enw-zombies-files.nbg1.your-objectstorage.com/updates/latest.yml`.

Created by B in the Hetzner console (project `enw-zombies`), **public** at the bucket level.
The key layout lives in one place, `web/server/lib/bucket.js` (`keys`), and the uploader
imports it, so the site and the uploader cannot disagree about where a file is.

## 2. What is public — say it plainly

**Everything in both buckets is readable by anyone with the URL, with no beta password.**

* The installers: the gate already exempted `/updates` (`middleware/gate.js`), so nothing new.
* **The map files** (`mods/…`): these were behind the beta password at `/api/maps/<bsp>/files/*`.
  They are community maps from the public archive, so the password was never protecting a
  secret, but it is a change: the bucket copy is open.
* **The replay `.glb`s** (`mapdata/…`): game-derived geometry. `/mapdata` was already
  gate-exempt, and the redistribution question on it is B's and is still open in
  `questions.md`. The bucket makes the same files public at a second address.

Bucket listing: whatever B set on the bucket. The uploader never deletes anything.

## 3. The cost model

**One base fee per Hetzner account, about €5/month net (≈€6/month gross at the account's 20 %
VAT), which includes 1 TB of storage and 1 TB of egress across all buckets.** Two buckets cost
the same as one. Beyond the included amounts Hetzner bills extra storage and extra egress per
use; those rates are from Hetzner's price list as briefed, not read from the API by the agent
that wrote this.

What we put in, 2026-09-22:

| | size |
|---|---|
| `updates/` (12 installers + blockmaps) | 1.13 GB |
| `mods/` (78 maps, 725 files) | **26.46 GB** — not the ~0.8 GB first estimated |
| `mapdata/` (2 exports) | 0.05 GB |

≈28 GB of the 1 TB. Egress: an update is 94 MB, a map 0.2–1 GB, so the 1 TB covers roughly
ten thousand launcher updates or a thousand map installs a month. The box (`vps.md`, €7.19)
plus this base fee is the Zombies cloud bill. **B created these buckets himself; kickstart
rule 8 still applies to anything that would raise the bill further.**

## 4. Commands

Keys: `infra\s3.env` (git-ignored; template `infra\s3.env.example`):

```
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
# optional overrides, these are the defaults
S3_ENDPOINT=https://nbg1.your-objectstorage.com
S3_BUCKET_FILES=enw-zombies-files
S3_BUCKET_MAPS=enw-zombies-maps
```

```
node tools\s3\sync.js --dry-run          # what would go up; works with no keys
node tools\s3\sync.js                    # everything (updates, then replay geometry, then maps)
node tools\s3\sync.js --only updates     # just the feed
node tools\s3\sync.js --only maps        # just mods/ and mapdata/
node tools\s3\check.js                   # HEAD latest.yml on the bucket + a timed 50 MB range read
node tools\s3\check.js --site https://zombies.enw.gg   # also HEAD the site's /updates routes
```

`sync.js` uploads only what is missing or different: a different size, or the same size with a
different sha256 in the object's `x-amz-meta-sha256` (every object it uploads carries one; the
map files use the archive's own recorded hash, so they are not re-hashed). A second run is a
no-op, and a run that is stopped halfway resumes where it stopped. It sets `Content-Type`,
`Cache-Control` (installers and map files immutable, `latest.yml` and `.meta.json` no-cache) and
asks for `public-read` on each object, dropping the ACL if the store refuses ACLs. `latest.yml`
uploads last, so the bucket's feed never names an installer that has not arrived.

**Publishing a launcher release is still one command**: `cd launcher && npm run pack` ends in
`tools/publish-update.js`, which now also uploads the installer, the blockmap and then
`latest.yml` to the files bucket when `infra\s3.env` has keys, and prints their public URLs.
Without keys it says so and carries on (the site still serves the feed locally).
`--no-bucket` skips it.

Implementation: `tools/s3/lib.cjs` (shared), `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` (web's
dependencies; resolved from `web/node_modules`), 16 MB multipart parts, 4 in flight. The SDK's
default CRC32 checksums are turned off (`WHEN_REQUIRED`) because not every S3-compatible store
accepts them.

## 5. How the site uses them

`web/server/lib/bucket.js`. **Off unless `S3_BUCKET_FILES` / `S3_BUCKET_MAPS` are in the site's
environment** (`infra\site.env`, loaded by `keepalive.ps1`). The site holds bucket **names**
only, never the keys: the buckets are public, so "does the bucket have it" is an anonymous
`HEAD` on the public URL (1.5 s timeout), **cached five minutes**, hit or miss.

| route | with the bucket configured |
|---|---|
| `/updates/latest.yml` | always served locally (400 bytes, no-cache; it is the feed) |
| `/updates/<installer>`, `/updates/<installer>.blockmap` | **302** to `updates/<name>` when the bucket copy exists **and has the local file's size**; else local |
| `/api/maps/<bsp>/files/<file>` | **302** to `mods/<bsp>/<file>`, same rule; still behind the beta gate, so only a signed-in-launcher / password holder is sent there. `x-enw-sha256` rides on the 302 |
| `/mapdata/<bsp>/<bsp>.glb` | **302** to `mapdata/…`, same rule; `.meta.json` stays local |

A miss, an error, a timeout, or a bucket copy of the wrong size serves the file from disk
exactly as before. Only files that exist locally are ever redirected.

`/api/maps/<bsp>/files` (and the launcher payload built from it) gains `mirror_url` per file:
the bucket URL, when a bucket is configured. It is a hint for a future launcher; `url` stays the
stable address. It is computed, not stored: `map_files` is the archive's record of
*provenance* (the original `.exe`/`.zip` a map came as, `launcher.js` explains the difference)
and is not what gets uploaded, so a bucket URL there would be false.

### Does the launcher follow the 302? (read from the installed sources)

* **Map files**: `launcher/src/main/siteapi.js` `fetchRaw` is `fetch(..., { redirect: 'follow' })`.
  On a cross-origin redirect it drops `Authorization` and `Cookie` and keeps `Range` — proven in
  `web/test/bucket.js` (a real cross-origin follow against an echoing server). The beta password
  never reaches Hetzner, and S3 would reject a request carrying `Authorization: Basic`.
* **The installer**: electron-updater 6.8.9 / builder-util-runtime 9.7.0 follow redirects —
  `builder-util-runtime/out/httpExecutor.js:169-176` (`handleResponse`: any 3xx with a
  `location` → `doApiRequest(prepareRedirectUrlOptions(...))`), and in Electron
  `electron-updater/out/electronHttpExecutor.js:64-75` (the `net` request's `redirect` event →
  the same `prepareRedirectUrlOptions`). That function strips `authorization`, `cookie` and
  friends on a cross-origin redirect (`httpExecutor.js:28-30, 286-300`), so the launcher's beta
  password header is not sent to the bucket.
* **The blockmap**: `AppUpdater.js:651-654` fetches it with `httpExecutor.downloadToBuffer` →
  `doApiRequest`, the same redirect path. The site 302s `.blockmap` too (test: *302 to the bucket
  for the installer AND the blockmap*).
* **Differential (ranged) downloads — the caveat.** With a generic feed on the site's URL,
  electron-updater uses *multi-range* requests (`providerFactory.js:53`; only
  `s3.amazonaws.com` URLs turn it off). S3-style stores do not answer multi-range requests
  with `multipart/byteranges`, so after the 302 the differential download can fail — and
  electron-updater then logs *"Cannot download differentially, fallback to full download"*
  (`NsisUpdater.js:170`) and downloads the whole installer, from the bucket. Worst case, an
  update is a full 94 MB from the bucket instead of a few MB through the tunnel. A launcher
  release could pass `useMultipleRangeRequest: false` to `setFeedURL` (`autoupdate.js`,
  `updatecheck.js`); not done here.

## 6. Results (2026-09-22, 21:46)

* Built and tested: site redirect (`web/test/bucket.js`, 12/12; web `npm test` and launcher
  `npm test` green), `sync.js --dry-run` (no keys), `publish-update.js --check`.
* **Not synced yet.** With B's keys in `infra\s3.env` the keys authenticate (ListBuckets
  succeeds in nbg1, fsn1 and hel1) but **the account those keys belong to has no buckets**:
  `HeadBucket enw-zombies-files` / `enw-zombies-maps` → 404, and an anonymous GET on the public
  URL answers `NoSuchBucket`. Either the buckets are not created yet, or the keys were made in a
  different Hetzner project from the buckets (Object Storage keys are per project). Nothing was
  uploaded and nothing was created.
* Baseline to beat: the site's `/updates` answers a HEAD in ~120 ms, and its bytes are capped by
  B's 6.0 MB/s uplink (`vps.md`), shared by everyone downloading.
