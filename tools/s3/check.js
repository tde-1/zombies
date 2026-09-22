#!/usr/bin/env node
'use strict'
// Is the files bucket serving the update feed, and how fast? Anonymous — no keys needed,
// because that is exactly what a player's launcher gets.
//
//   node tools/s3/check.js                     HEAD latest.yml, 50 MB range read of the installer
//   node tools/s3/check.js --mb 20             a smaller read
//   node tools/s3/check.js --site https://zombies.enw.gg   also HEAD the site's routes (HEAD only)
//
// The site is only ever HEADed here: a timed download through it would need the beta
// password on a command line, and HEAD is enough to show whether it now answers 302.

const s3 = require('./lib.cjs')

const argv = process.argv.slice(2)
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
const MB = Number(arg('--mb', 50))
const SITE = arg('--site', null)

async function timed (fn) { const t = process.hrtime.bigint(); const r = await fn(); return [r, Number(process.hrtime.bigint() - t) / 1e9] }

async function main () {
  const cfg = s3.loadConfig()
  const feedUrl = s3.publicUrl(cfg, cfg.files, s3.bucketLib.keys.update('latest.yml'))
  const [h, hs] = await timed(() => fetch(feedUrl, { method: 'HEAD' }))
  console.log(`HEAD ${feedUrl}\n  ${h.status} ${h.headers.get('content-type') || ''}  ${(hs * 1000).toFixed(0)} ms`)
  if (h.status !== 200) { console.log('  the feed is not on the bucket (not synced yet, or the bucket is not public)'); process.exit(1) }

  const yml = await (await fetch(feedUrl)).text()
  const name = (/^path:\s*(.+)$/m.exec(yml) || [])[1]?.trim()
  const version = (/^version:\s*(.+)$/m.exec(yml) || [])[1]?.trim()
  console.log(`  feed: version ${version}, installer ${name}`)
  const instUrl = s3.publicUrl(cfg, cfg.files, s3.bucketLib.keys.update(name))
  const bm = await fetch(`${instUrl}.blockmap`, { method: 'HEAD' })
  console.log(`  blockmap: ${bm.status}  ${instUrl}.blockmap`)

  const want = Math.round(MB * 1024 * 1024)
  const t0 = process.hrtime.bigint()
  const r = await fetch(instUrl, { headers: { range: `bytes=0-${want - 1}` } })
  let got = 0
  let ttfb = null
  for await (const chunk of r.body) { if (ttfb == null) ttfb = Number(process.hrtime.bigint() - t0) / 1e9; got += chunk.length }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9
  console.log(`GET ${instUrl}  Range bytes=0-${want - 1}`)
  console.log(`  ${r.status} ${r.headers.get('content-range') || ''}  ${(got / 1e6).toFixed(1)} MB in ${secs.toFixed(2)} s` +
    `  = ${(got / 1e6 / secs).toFixed(1)} MB/s (${(got * 8 / 1e6 / secs).toFixed(0)} Mbit/s), first byte ${((ttfb || 0) * 1000).toFixed(0)} ms`)
  if (r.status !== 206) console.log('  WARNING: expected 206 Partial Content - ranges would not survive a redirect')

  if (SITE) {
    for (const p of ['/updates/latest.yml', `/updates/${name}`]) {
      const [s, ss] = await timed(() => fetch(`${SITE.replace(/\/+$/, '')}${p}`, { method: 'HEAD', redirect: 'manual' }))
      console.log(`HEAD ${SITE}${p}\n  ${s.status}${s.headers.get('location') ? ` -> ${s.headers.get('location')}` : ''}  ${(ss * 1000).toFixed(0)} ms`)
    }
  }
}

main().catch((e) => { console.error(`s3 check: ${e.name || 'error'}: ${e.message}`); process.exit(1) })
