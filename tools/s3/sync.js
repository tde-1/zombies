#!/usr/bin/env node
'use strict'
// Mirror the big downloads into the two public Hetzner buckets (docs/kickstart/storage.md).
//
//   node tools/s3/sync.js --dry-run            what would go up (works with no keys at all)
//   node tools/s3/sync.js                      everything
//   node tools/s3/sync.js --only updates       just web/public/updates -> files bucket
//   node tools/s3/sync.js --only maps          just the map files -> maps bucket
//   node tools/s3/sync.js --with-replay-geometry   ALSO the replay .glb/.meta.json (mapdata/).
//                                              Off by default: they are game-derived and B has
//                                              not cleared them for a public bucket.
//
// S3_BUCKET_FILES and S3_BUCKET_MAPS may be the same bucket (they are: `enw-zombies`); the
// prefixes updates/, mods/ and mapdata/ keep the sets apart, and every listing is per prefix.
//
//   web/public/updates/*                   -> <files>/updates/<name>
//   ZombiesDev\archive\mods\<bsp>\<files>  -> <maps>/mods/<bsp>/<path>   (what /api/maps/<bsp>/files serves)
//   ZombiesDev\maps\<bsp>\<bsp>.glb|.meta.json -> <maps>/mapdata/<bsp>/<file>
//
// Uploads only what is missing or different (size, then the sha256 kept in each object's
// metadata). Never deletes anything from a bucket. Keys: infra/s3.env.

const s3 = require('./lib.cjs')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run') || argv.includes('-n')
const withGlb = argv.includes('--with-replay-geometry')
const only = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null })()

async function main () {
  const cfg = s3.loadConfig()
  console.log(`s3 sync${dryRun ? ' (dry run)' : ''}: ${cfg.endpoint}  files=${cfg.files}  maps=${cfg.maps}`)
  if (!s3.hasKeys(cfg)) {
    console.log(`  no keys (${cfg.envFile} ${cfg.envFilePresent ? 'lacks S3_ACCESS_KEY/S3_SECRET_KEY' : 'does not exist'})` +
      (dryRun ? ': listing local files only, the bucket is not compared' : ''))
    if (!dryRun) process.exit(2)
  }

  let failed = 0
  if (!only || only === 'updates') {
    const st = await s3.sync(cfg, cfg.files, s3.updatesEntries(), { dryRun, prefix: 'updates/' })
    failed += st.failed
  }
  if (!only || only === 'maps') {
    if (withGlb) {
      const md = await s3.sync(cfg, cfg.maps, s3.mapdataEntries(), { dryRun, prefix: 'mapdata/' })
      failed += md.failed
    } else {
      console.log('  replay geometry (mapdata/*.glb) skipped: not cleared for public; --with-replay-geometry')
    }
    const mf = await s3.sync(cfg, cfg.maps, s3.mapEntries(), { dryRun, prefix: 'mods/' })
    failed += mf.failed
  }
  console.log(failed ? `  ${failed} upload(s) FAILED - run it again; it resumes where it stopped` : '  done')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(`s3 sync: ${e.name || 'error'}: ${e.message}`); process.exit(1) })
