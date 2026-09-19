# T4 (WaW 1.7) server security audit — Huffman bound + OOB handlers

*re agent, 2026-09-20. Answers vault R11 items 1–2 on our own decrypted dump
(`codwaw-1.7-a.exe`, VA = 0x400000 + file offset). Addresses are for turning into patches.
This documents facts about attack surface for **defensive hardening**; no exploit is provided.*

## 1. The Huffman / compressed-message bound (CVE-2018-10718 class)

**Verdict: the class bug is PRESENT on the server receive path. The decompressor does not
bound its output by the destination capacity, and the server caller adds no input-length
guard. Must be patched before any WaW box faces untrusted clients.**

### The decoder — `MSG_ReadBitsCompress`-equivalent at **0x6751D0**
- Dispatches on the first byte of the block (compression method): method 0 → raw `memcpy`
  (0x7AFFC0); method 1 → the Huffman decode loop at **0x675230**; method 2 → 0x675150.
- The Huffman loop (0x675230) is bounded **only by the input**: it computes
  `total_bits = 8 * input_len` and loops decoding one symbol per iteration (inner bit reader
  **0x5A2970**), writing one output byte each time (`mov [esi], dl; add esi, 1`) until the
  consumed-bit counter reaches `total_bits`. **There is no comparison of the output pointer
  against the destination buffer end.** The function receives a capacity argument (`0x20000`)
  from both callers but **ignores it**. Since the shortest Huffman codes are a few bits, the
  decoded output can exceed the input, and nothing stops it exceeding the 0x20000 buffer.

### Client caller — `CL_ParseServerMessage` at **0x64D1A0** (has a guard)
- Computes `len = msg.cursize - msg.readcount`, compares `len > 0x20000`, and calls
  `Com_Error` ("Compressed msg overflow in CL_ParseServerMessage", string 0x88C32C) if so.
- Decodes into a fixed **0x20000-byte** static buffer at **0x4E337C0** (the very next
  referenced global sits at 0x4E537C0 = 0x4E337C0 + 0x20000, confirming the size).
- So the client at least bounds the *input*; it still relies on the input bound rather than an
  output bound, but it is not the exposed side for us.

### Server caller — `SV_ExecuteClientMessage` at **0x630F70** (NO guard)
- Reached by a tail-`jmp` from **`SV_PacketEvent` 0x635540** (site 0x6357AA) after netchan
  reassembly, i.e. it runs on **every message from a connected client**.
- Sets up the decode dst as a rotating **0x20000 window** carved from a `.data` pool at
  **0x212B2F8** (`ptr = [0x46E5054]; [0x46E5054] += 0x20000; dst = 0x212B2F8 + ptr`).
- Passes `len = client_msg.cursize - readcount` (attacker-controlled) straight into 0x6751D0
  as the input length, with capacity `0x20000` — and performs **no `len ≤ 0x20000` check** and
  no other sanity check. The decode then writes an output bounded only by `8*len` bits worth of
  symbols into the 0x20000 window. **A crafted compressed client message whose decoded length
  exceeds 0x20000 overruns the pool window into adjacent `.data`** (a global/pool overflow;
  note it is a 0x20000 `.data` buffer here, not the 1024-byte stack buffer of the original
  MW-family CVE, but the missing-output-bound condition is the same and it is reachable from
  untrusted client input).
- Upstream cap: `cursize` is limited by the netchan incoming reassembly buffer
  (`client_s.netchanIncomingBuffer` at +0x523F4, 0x20000 bytes), so `len ≤ ~0x20000`. That
  bounds the *input* to ~128 KB but the *output* can still be several times larger — the
  overflow does not require an oversized packet, only a compressible payload that expands.

### Patch (mirror iw4x `Huffman.cpp`, GPL-3.0 — port, don't copy addresses)
1. **Bound the decoder's output.** In 0x6751D0 / the 0x675230 loop, stop when the output
   pointer reaches `dst + capacity` (the 0x20000 arg the function already receives). This is
   the single robust fix and protects both client and server.
2. **Belt-and-braces on the server path.** In `SV_ExecuteClientMessage` (0x630F70) add the
   same `len ≤ 0x20000` guard the client has, erroring/dropping the client instead of
   decoding. Do this via our DLL hook, not by editing the exe.
3. Add index checks on the subsequent clc/gamestate/configstring parsing in the same function
   (the classic Q3 lineage bugs), per iw4x/h1-mod `security.cpp`.

## 2. Connectionless / out-of-band (OOB) handlers

`NET_OutOfBandPrint`/`*_ConnectionlessPacket` messages are the `\xff\xff\xff\xff`-prefixed
datagrams processed before a client is connected. Two dispatchers:

### Server: `SV_ConnectionlessPacket` at **0x634E90** (called from SV_PacketEvent 0x635540)
Command → handler (verified from the dispatch chain, strings at 0x888A00+):

| OOB command | handler | keep? |
|---|---|---|
| `getstatus` | 0x634260 | **disable** (server-browser/DoS-amplification surface) |
| `getinfo` (`v`/version tail) | 0x6341F0 | **disable** |
| `getchallenge` | `SVC_GetChallenge` 0x62DB60 (`challengeResponse %i %s`) | replace with ENW-signed challenge |
| `connect` | `SV_DirectConnect` 0x62E3A0 (`protocol`/`challenge`/`qport`/`password`/`connectResponse %s`) | **gate on ENW invite token** |
| `stats` | 0x62DD30 | disable |
| `disconnect` | 0x634D60 | keep (validate source) |
| `rcon` | 0x6477D0 (`rcon` string 0x88B8D0) | **disable** or lock to localhost + strong password |
| (LAN loopback `localhost` fast-path at 0x678F10) | — | keep for local host only |

### Client: `CL_ConnectionlessPacket` at **0x643380**
Handles: `challengeResponse`, `connectResponse`, `infoResponse`, `statusResponse`,
`getserversResponse`, `echo`, `print` (server→client console print, sender-spoofable — handled
around 0x633FA0), `motd` (0x64657A), `disconnect`. This is the function to lock down per iw4x
`Network.cpp`: drop any OOB packet whose source isn't the current ENW server/relay, and disable
`echo`/`getserversResponse`/`print`-from-stranger. Removing LAN-broadcast discovery and blocking
`cod5master.activision.com` (vault) also happens here.

### Recommended OOB lockdown (server side, our DLL)
- Reject every connectionless command except `getchallenge`/`connect`/`disconnect`, and make
  `connect` require a valid short-lived ENW token (bind to SteamID + match id).
- Rate-limit connectionless queries (CoD4x `sv_floodProtect` pattern).
- Disable `rcon` over the network entirely on ENW hosts.

## 3. Related notes
- `sv_maxclients` read/clamped in many funcs (e.g. 0x631A60, 0x634660); player cap is 4
  (arrays sized [4]). Enforce ≤4 and reject a would-be 5th before `SV_DirectConnect` allocates.
- Force `cl_allowDownload 0` / disable in-game downloads (vault R11 item 6); the download
  command handlers live in the CL command table (see t4-sp-map.md).
- CVE-2018-20817 (`SV_SteamAuthClient`) does not apply to WaW; no matching code path found.

## Status
Huffman answer: **class bug present, output not capped, server path unguarded** — high
confidence, from the disassembly above. OOB table: verified from the dispatchers. Turn items
1–2 into DLL patches; keep addresses in `shared/t4/addresses.hpp` in sync.
