#!/usr/bin/env node
'use strict'
// Create THE ONE bucket (docs/kickstart/storage.md §1) and make its objects public-read.
// Creating a bucket starts Hetzner's Object Storage base fee on the account, so this is
// run by hand, once, with B's say-so - never from sync.js or publish-update.js.
//
//   node tools/s3/create-bucket.js enw-zombies            # nbg1 (S3_ENDPOINT)
//   node tools/s3/create-bucket.js enw-zombies --policy-only
//
// Steps: CreateBucket (an existing bucket we own is fine) -> PutBucketPolicy granting
// s3:GetObject on <bucket>/* to everyone -> put a tiny test object -> an ANONYMOUS GET of
// its public URL must return 200 with the same bytes. Exit 0 only if all of that holds.
// If the store refuses the policy over the API, it says so: public must then be set in
// the Hetzner console.

const path = require('node:path')
const { createRequire } = require('node:module')
const s3 = require('./lib.cjs')
const sdk = createRequire(path.join(s3.REPO, 'web', 'package.json'))('@aws-sdk/client-s3')

const argv = process.argv.slice(2)
const name = argv.find((a) => !a.startsWith('--'))
const policyOnly = argv.includes('--policy-only')

async function main () {
  if (!name) { console.error('usage: create-bucket.js <name> [--policy-only]'); process.exit(2) }
  const cfg = s3.loadConfig()
  if (!s3.hasKeys(cfg)) { console.error(`no keys in ${cfg.envFile}`); process.exit(2) }
  const c = s3.client(cfg)
  console.log(`bucket ${name} at ${cfg.endpoint} (region ${cfg.region})`)

  if (!policyOnly) {
    try {
      await c.send(new sdk.CreateBucketCommand({ Bucket: name }))
      console.log('  CreateBucket: created')
    } catch (e) {
      if (e.name === 'BucketAlreadyOwnedByYou') console.log('  CreateBucket: already ours')
      else { console.error(`  CreateBucket REFUSED: ${e.name} ${e.message}`); process.exit(3) }
    }
  }

  const policy = {
    Version: '2012-10-17',
    Statement: [{ Sid: 'PublicRead', Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${name}/*`] }],
  }
  try {
    await c.send(new sdk.PutBucketPolicyCommand({ Bucket: name, Policy: JSON.stringify(policy) }))
    console.log('  PutBucketPolicy: public-read on objects')
  } catch (e) {
    console.error(`  PutBucketPolicy REFUSED: ${e.name} ${e.message}`)
    console.error('  -> make the bucket public in the Hetzner console instead.')
    process.exit(4)
  }

  const key = 'healthcheck.txt'
  const body = `enw-zombies public-read check ${new Date().toISOString()}\n`
  await c.send(new sdk.PutObjectCommand({ Bucket: name, Key: key, Body: body, ContentType: 'text/plain; charset=utf-8', CacheControl: 'no-cache' }))
  const url = s3.publicUrl(cfg, name, key)
  const r = await fetch(url)
  const got = await r.text()
  console.log(`  anonymous GET ${url} -> ${r.status}`)
  if (r.status !== 200 || got !== body) { console.error('  NOT PUBLIC: the anonymous read failed'); process.exit(5) }
  console.log('  public read: OK')
}

main().catch((e) => { console.error(`create-bucket: ${e.name}: ${e.message}`); process.exit(1) })
