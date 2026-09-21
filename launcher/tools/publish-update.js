#!/usr/bin/env node
// Put the installer where a friend can actually get it, and REFUSE TO CALL IT DONE
// IF ANY PIECE IS MISSING.
//
// This is the same discipline stage-client.js applies to the DLL, for the same reason
// and after the same kind of failure: `web/public/updates/` contained one README.txt
// and nothing else, so
//
//   * a friend had no way to download the launcher except B sending them a file, and
//   * the auto-updater was wired up and pointed at an empty directory, which is
//     indistinguishable from "there is no update" and would have stayed that way for
//     weeks.
//
// electron-updater's generic provider needs exactly three files served as static
// bytes, and it fails in a confusing way if any of them is absent or stale:
//
//   latest.yml     the feed: version, path, sha512, releaseDate
//   <installer>    the file named by latest.yml's `path`
//   <installer>.blockmap  for differential downloads; without it the update still
//                  works but every friend re-downloads 94 MB each time
//
// Runs at the end of `npm run pack`. Set ENW_UPDATE_DIR to publish somewhere else —
// a bucket sync folder, say — because serving 94 MB per friend per update out of a
// home connection through a tunnel is not where this ends up.
//
//   node tools/publish-update.js
//   node tools/publish-update.js --to D:\r2-sync\updates
//   node tools/publish-update.js --check          # verify only, publish nothing
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LAUNCHER = path.resolve(HERE, '..')
const REPO = path.resolve(LAUNCHER, '..')
const DIST = path.join(LAUNCHER, 'dist')

const argv = process.argv.slice(2)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }
const CHECK_ONLY = argv.includes('--check')
const DEST = path.resolve(val('--to') || process.env.ENW_UPDATE_DIR || path.join(REPO, 'web', 'public', 'updates'))

const die = (...lines) => {
  console.error('')
  console.error('  publish-update: THE UPDATE FEED WOULD BE BROKEN.')
  console.error('')
  for (const l of lines) console.error(`  ${l}`)
  console.error('')
  console.error('  An empty or stale feed looks exactly like "you are up to date", so')
  console.error('  nobody finds out. Build first:')
  console.error('    cd launcher && npm run pack')
  console.error('')
  process.exit(1)
}

// 1. The feed electron-builder generated.
const feedFile = path.join(DIST, 'latest.yml')
if (!fs.existsSync(feedFile)) die(`No ${feedFile}.`)
const feed = fs.readFileSync(feedFile, 'utf8')
const field = (k) => (new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(feed) || [])[1]?.trim()
const version = field('version')
const installerName = field('path')
const sha512 = field('sha512')
if (!version || !installerName) die(`${feedFile} has no version/path — electron-builder did not finish.`)

// 2. The installer it names, and its blockmap.
const installer = path.join(DIST, installerName)
const blockmap = `${installer}.blockmap`
if (!fs.existsSync(installer)) die(`latest.yml names ${installerName}, which is not in ${DIST}.`)
if (!fs.existsSync(blockmap)) {
  die(`No ${path.basename(blockmap)}.`,
    'Without it every friend re-downloads the whole installer on every update.')
}

// 3. The hash in the feed must be the hash of the file. A stale latest.yml beside a
//    fresh installer is the one failure electron-updater reports as a corrupt
//    download, and the cause is never where people look.
const actual = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64')
if (sha512 && actual !== sha512) {
  die('latest.yml\'s sha512 does not match the installer beside it.',
    `feed says   ${String(sha512).slice(0, 24)}…`,
    `file hashes ${actual.slice(0, 24)}…`,
    'The feed is from an older build. Re-run `npm run pack`.')
}

const size = fs.statSync(installer).size
console.log(`publish-update: ${version}  ${installerName}  ${(size / 1e6).toFixed(1)} MB`)

if (CHECK_ONLY) {
  console.log('  --check: everything the feed needs is present and consistent. Nothing copied.')
  process.exit(0)
}

fs.mkdirSync(DEST, { recursive: true })
for (const src of [feedFile, installer, blockmap]) {
  const to = path.join(DEST, path.basename(src))
  fs.copyFileSync(src, to)
  console.log(`  -> ${to}  (${(fs.statSync(to).size / 1e6).toFixed(1)} MB)`)
}

// 4. Prove the published copy is the one the feed describes, from the destination's
//    point of view rather than the source's.
const pubInstaller = path.join(DEST, installerName)
const pubHash = crypto.createHash('sha512').update(fs.readFileSync(pubInstaller)).digest('base64')
if (sha512 && pubHash !== sha512) die('The copy that landed in the feed directory does not hash to what latest.yml says.')

console.log(`  feed ready in ${DEST}`)
console.log('')
console.log('  Serve it and check you get YAML, not a web page:')
console.log('    curl -u beta:<password> https://zombies.enw.gg/updates/latest.yml')
console.log('  A 200 with Content-Type: text/html is the React catch-all answering, and')
console.log('  electron-updater will try to parse the page as YAML.')
