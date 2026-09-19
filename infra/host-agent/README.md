# host-agent

The server software that runs on an ENW Zombies game box. Node 24, **zero dependencies**.

Full design, how to run it and the measured numbers: **`../../docs/kickstart/host.md`**.
The contract with the game DLL: **`../../docs/protocol/game-link-v0.md`**.

```bash
node test/demo-network.js     # mock site + 2 boxes + 2 games, end to end
node test/run-all.js          # 37 in-process checks of the rules and the replay format
node host.js --boot 2         # one box, two simulated games, dashboard on :8787
node tools/verify.js <f.enwr> --tamper
node tools/measure-replay.js --hours 1 --players 1,2,4
```

`sim/` is a fake game that speaks the protocol, so nothing here waits for the DLL. When the real
thing lands, `node host.js --game --map <map>` boots it through the same code path.
