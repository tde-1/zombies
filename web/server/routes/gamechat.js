'use strict'

// `/api/game-chat/*` — what the in-game chat overlay speaks (lib/gameChat.js says why it
// exists and what the pass is). Authenticated by the CHAT PASS in `Authorization: Bearer`,
// never by the session cookie: the game holds a pass the launcher minted for it and
// nothing else. Exempt from the beta gate for the same reason /api/gs is — the game cannot
// type a password — and it costs nothing, because every route here refuses without a pass.
//
//   GET  /api/game-chat/me                      who the pass is for, party, DM contacts,
//                                               and pause_on_chat (the pause contract's enw_pchat)
//   GET  /api/game-chat/feed?g=&p=&wait=20      long-poll: global ring + party/DM lines
//   POST /api/game-chat/send {channel,to?,text} channel = global | party | dm

const express = require('express')
const gameChat = require('../lib/gameChat')

function bearer(req, res, next) {
  const h = String(req.headers.authorization || '')
  const m = /^Bearer\s+(\S+)$/i.exec(h)
  const u = m ? gameChat.verifyPass(m[1]) : null
  if (!u) return res.status(401).json({ error: 'no valid chat pass' })
  req.chatUser = u
  next()
}

function router() {
  const r = express.Router()
  r.use(bearer)

  r.get('/me', (req, res) => res.json(gameChat.meFor(req.chatUser)))

  r.get('/feed', async (req, res) => {
    let closed = false
    req.on('close', () => { closed = true })
    const out = await gameChat.feed(req.chatUser, {
      g: req.query.g, p: req.query.p, wait: req.query.wait, isClosed: () => closed,
    })
    if (!out || closed) return
    res.json(out)
  })

  r.post('/send', (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const text = typeof b.text === 'string' ? b.text : ''
    const channel = typeof b.channel === 'string' ? b.channel : 'global'
    const to = typeof b.to === 'string' ? b.to : null
    const out = gameChat.send(req.chatUser, { channel, to, text })
    res.status(out.ok ? 200 : 400).json(out)
  })

  return r
}

module.exports = { router }
