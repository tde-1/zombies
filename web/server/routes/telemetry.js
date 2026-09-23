'use strict'

// `POST /api/telemetry/upload` — a launcher's log bundle (docs/kickstart/telemetry.md §3).
//
// Auth is the launcher's own session cookie, behind the beta gate like the rest of /api.
// Signed in is enough: a player who crashed before being approved is exactly who we want
// logs from. The body is the raw .tar.gz; lib/telemetry/ingest.js does the rest. The box's
// twin is `POST /api/gs/telemetry` in routes/gameserver.js (x-match-secret).

const express = require('express')
const ingest = require('../lib/telemetry/ingest')

function router () {
  const r = express.Router()
  r.post('/upload', async (req, res) => {
    if (!req.me) { req.resume(); return res.status(401).json({ error: 'sign in first; the launcher keeps the logs until you do' }) }
    try {
      const out = await ingest.receive(req, { who: { steam_id: req.me.steam_id }, source: 'launcher' })
      if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v)
      res.status(out.status).json(out.body)
    } catch (e) {
      console.error(`[telemetry] upload from ${req.me.steam_id} failed: ${e.stack || e.message}`)
      if (!res.headersSent) res.status(500).json({ error: 'the site could not store that bundle; the launcher will try again' })
    }
  })
  return r
}

module.exports = { router }
