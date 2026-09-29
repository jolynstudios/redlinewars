# What this repository contributes

The game is the product; the code below is the contribution. Everything listed here ships in this
repository, builds with the documented steps in the [README](README.md), and is free software under
the GNU GPL v3 or later. Jolyn Studios maintains it as part of releasing Redline Wars — and as
working, tested reference implementations of things the OpenRA ecosystem did not have before.

## 1. An OpenRA port to the browser (WebAssembly)

The full engine — simulation, rules, networking — compiled to WebAssembly and running in a browser,
driven from a dedicated Web Worker.

- `engine/OpenRA.Browser/` — the wasm host: boot modes, the requestAnimationFrame pump, tick
  telemetry, JS probes, and the multiplayer WebSocket bridge that lets the C# engine speak through
  a browser socket;
- `engine/OpenRA.Platforms.Browser/` — the browser platform backend;
- the port discipline: **no browser conditionals in core gameplay code**. The engine gains
  desktop-neutral capability seams only, so every seam is an upstream candidate;
- `engine/BROWSER-PORT.md` — a mechanical inventory of the whole port boundary against the pinned
  upstream base;
- `engine/OpenRA.Browser/tests/` — a Playwright regression harness and the static server used for
  local serving.

## 2. A WebGPU client for OpenRA

A complete TypeScript client that renders the game in the browser on modern GPU APIs.

- `web/src/` — 180+ source files: renderer, material system, camera, effects, animation, audio,
  UI scaffolding;
- `openra-gl.js` (under `engine/*/OpenRA.Browser/wwwroot/`) — the engine-side bridge that
  translates the engine's GL-style command stream into browser GPU calls, including context,
  buffer, program, texture and framebuffer pooling;
- the client speaks the same protocol as the native engine and renders the same replays and live
  matches, including spectators.

## 3. Procedural art and audio pipelines

The repository builds and plays a complete game **without any separately-licensed asset**: art,
visuals and sound are synthesised by code, and gates hold that output to contracts.

- `tools/fallback-art.mjs` — procedural stand-in art for everything the official build sources
  elsewhere;
- `web/tools/roleportraits.mjs` — generated role portraits;
- `web/tools/weaponvisual-forge.mjs` with `web/tools/forgegate.mjs` — weapon visuals synthesised
  from the mod's own rules data, verified by a gate;
- `web/tools/weapon-audio.mjs` — synthesised weapon audio;
- `web/tools/locomotion-audio.mjs` — synthesised vehicle-locomotion audio;
- `web/tools/render-*-elevenlabs.mjs` — the voice-bank rendering harnesses that produce the game's
  voice packs from line banks.

## 4. The multiplayer relay federation

The code that lets anyone host: a relay ("spine"), community and donated nodes, and a browser
desktop flow that creates rooms on them.

- `engine/steelseed-host/tools/spine.mjs` — the central relay: room directory, placement, WebSocket
  tunneling between players and nodes behind NAT, per-IP budgets, rate limits, drain behaviour and
  hardened request handling;
- `engine/steelseed-host/tools/roomhost.mjs` with `node-cli.mjs` — the node: standing community
  rooms, own/donate modes, player-created rooms through an explicit placement opt-in, idle-admin
  demotion, capacity sampling;
- `placement-policy.mjs`, `ranked-claims.mjs` and `protocol.json` — placement policy, ranked
  admission claims, and the documented wire protocol with its limits and close codes;
- `pack-node.mjs` / `pack-npm.mjs` — self-contained node packages for Windows, macOS and Linux;
- `lan-beacon.mjs` / `lan-listener.mjs` — LAN discovery;
- the suites behind it: `placement-policy.test.mjs`, `roomhost-capacity.test.mjs`,
  `tunnel-rotation.test.mjs`, `mp-socket.test.mjs`, `network-status.test.mjs` and more.

## 5. The Electron desktop shell

The complete desktop application wrapper, with its packagers — open-sourced, including how to
build it.

- `desktop/` — the shell: window management, settings, GPU capability detection, account brokering,
  and the own/donate hosting integration (`donate-hosting.mjs`);
- `desktop/package.mjs` — packages the same AppBundle for macOS, Windows and Linux (build steps in
  the [README](README.md#the-desktop-app));
- `desktop/*.test.mjs` — the shell's own unit tests.

## 6. The gate suite

The automated proof that all of the above still works — the same suite the official release runs.

- 170+ gates in `web/tools/`, and another 38 gates plus 21 unit suites in
  `engine/steelseed-host/tools/`: visual, performance, gameplay, audio, deployment, naval,
  infantry, AI, and multiplayer;
- `web/tools/mpgates.mjs` with `multiplayer-sync-samples.mjs` — end-to-end multiplayer gates and
  tick-hash comparison that catches desyncs between clients;
- `engine/OpenRA.Browser/tests/` — browser E2E, including the community-room gate that boots real
  browser clients against a real relay and nodes;
- `tools/build.mjs` and `tools/verify-release.mjs` — the one-command build, and the verifier that
  proves a distributed artifact against its source.

## What is not here

The game interface (setup screens, lobby, HUD, tutorial, companion) and the separately-licensed
art and audio are withheld from current exports; see
[What is not in this repository](README.md#what-is-not-in-this-repository). Everything else needed
to build, run, host, package and verify the game is in this list.

---

Redline Wars: Fractured Order © 2026 Jolyn Studios. Code licensed GNU GPL v3 or later.
