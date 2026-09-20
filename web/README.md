# web — zombies.enw.gg

The ENW Zombies website: a port of ENW Movement with the nouns changed. Express +
better-sqlite3 + socket.io + React/Vite.

```bash
npm install
npm run seed -- --reset --demo    # build the database from referee/manifests/*.json
npm run build                     # build the client
npm run dev                       # http://127.0.0.1:3200
npm run check                     # 40 in-process checks
```

Sign in at `/auth/mock` (loopback only; real Steam OpenID turns on with `STEAM_API_KEY`,
`ZM_PUBLIC_URL` and `ZM_AUTH=steam`).

**Design, what runs, what is stubbed, and how the game boxes talk to it:
[`../docs/kickstart/web.md`](../docs/kickstart/web.md).**

Licence: AGPL-3.0-or-later (vault 99 §0.3 — the server is open-sourced under AGPL because of
its network use).
