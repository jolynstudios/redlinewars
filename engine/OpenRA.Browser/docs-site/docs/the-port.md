---
sidebar_position: 2
title: The browser port
description: How OpenRA crosses the WebAssembly boundary, what is proven, and what remains unsupported.
---

# The browser port

OpenRA Browser is the upstream engine compiled for the `browser-wasm` runtime, with a browser-owned platform backend. The port deliberately avoids putting web-service or model-provider behavior into gameplay code. Generic engine seams—platform factories, a cooperative game stepper, in-memory networking, and transport pumping—remain useful outside the browser; WebGL, Web Audio, IndexedDB, JavaScript interop, and agent UI stay under the browser projects.

## Limitations, up front

### Campaigns and Lua maps do not work

OpenRA's Red Alert campaigns are present in the menus, but most missions attach Lua scripts. The Wasm build has no compatible `lua51` runtime. The browser therefore substitutes a script-free shellmap so the real main menu can boot and survive a return from a game, but that does not make the campaigns playable. The same restriction applies to Lua-driven custom maps.

### Resize requires a reload

The WebGL2 drawing buffer is sized from the canvas when the graphics context starts. The page fills the viewport, but changing the window dimensions later does not resize the engine surface. Reload at the desired size. WebGL context loss also requires a reload.

### Multiplayer needs a bridge

Web pages cannot open OpenRA's raw TCP sockets. The browser client speaks binary WebSocket to a small, protocol-agnostic relay, which forwards bytes to one fixed TCP server. This changes transport only: the engine still frames and validates the normal OpenRA protocol.

The `Host.ModId` and `Host.ModVersion` overrides change only the identity sent during the handshake. They do not make incompatible builds compatible. Rules and simulation must match the target server; otherwise OpenRA's synchronization hashes report an out-of-sync game.

### Game assets are user-supplied

The repository commits tens of megabytes of OpenRA's own GPL/CC-licensed content — roughly 50 MB across the four official mods. The Red Alert deployable bundles about 15 MB of it (around 18 MB on disk, roughly 1,100 files) into the browser's virtual filesystem: rules, sequences, UI chrome, tilesets, OpenRA-authored artwork and audio, and the stock map pool including Siberian Pass — byte-for-byte upstream OpenRA data apart from the port's script-free shellmap copy. Earlier notes that counted only the port-added artwork slices understated this committed footprint. The deployable does **not** include EA/Westwood's Red Alert unit art, voices, music, or `.mix` packages. Those files are freeware for personal download and play, not public-domain or GPL assets.

For local use, the first-run installer accepts the standard OpenRA quick-install ZIP, verifies its checksum and path allowlist, rejects unsafe archives, and stores the extracted files in IndexedDB. A public deployment must choose a lawful delivery model—typically user-supplied files, openly licensed game content, or a separately reviewed content source.

### Performance is not yet the desktop profile

The current project disables Wasm threads and AOT compilation. Chromium is the determinism and acceptance target. WebKit boots and plays in the recorded support matrix, while interpreted Firefox is much slower; the long determinism oracle is therefore Chromium-only.

## How the real engine runs

The .NET host initializes OpenRA once and hands control to the browser's animation-frame loop. A `GameStepper` advances the existing simulation without a blocking desktop loop. Local skirmishes use OpenRA's normal server in cooperative, thread-free mode and connect through an in-memory transport with the same framing as the network path.

The browser platform supplies:

- a WebGL2 graphics context and the OpenRA renderer's expected graphics operations;
- DOM mouse and keyboard events translated to OpenRA input;
- Web Audio output, unlocked by the first user gesture as browsers require;
- a virtual support directory synchronized to IndexedDB;
- WebSocket networking for remote games; and
- JavaScript exports for boot, replays, tests, and the typed agent-mode boundary.

The host remains a thin boundary. OpenRA still owns maps, actors, orders, shroud, production, victory conditions, replay recording, and sync hashes.

## What is working

| Area | Current state |
| --- | --- |
| Main menu | Boots the real RA UI over a browser-only, script-free shellmap. |
| Skirmish | Playable through the normal local lobby and in-process server. |
| Rendering | WebGL2, full-viewport at boot, normal shroud and UI composition. |
| Input | Mouse and keyboard, including the default Modern control style. |
| Audio | Web Audio for game sound; first interaction unlocks playback. |
| Persistence | Settings, installed content, and replays survive reloads in IndexedDB. Logs are intentionally excluded. |
| Replays | Record and play through OpenRA's normal replay machinery. |
| Multiplayer | Browser-to-desktop and multi-client paths work through the WebSocket/TCP relay when builds match. |
| Agent mode | Two fog-limited model commanders issue typed, validated normal orders in a live skirmish. |

## Lockstep proof

OpenRA multiplayer depends on every client producing the same state from the same order stream. The port checks this across runtimes rather than relying on a browser-only self-test:

1. Desktop and browser run the same fixed-seed game.
2. Their replay streams are read offline frame by frame.
3. Orders and synchronization hashes must agree for the full comparison window.

The committed 200-frame oracle passes in Chromium. Separately, the in-memory and TCP transports are checked for byte-identical framing, and live browser/desktop matches exchange normal orders and per-frame sync hashes. Any disagreement blocks multiplayer work.

## Browser support observed by the test harness

| Engine | Boot and render | Input and audio | Persistence | Determinism oracle |
| --- | --- | --- | --- | --- |
| Chromium | Yes | Yes | Yes | Yes |
| WebKit / Safari engine | Yes | Yes | Not yet recorded in the matrix | Not run |
| Firefox | Yes, but slow in interpreted Wasm | Yes | Yes | Too slow for the current test budget |

These are development-harness results, not a claim that every browser/device combination is supported.

Next: [build and play locally](./playing), or read how the browser boundary is used by [Agent mode](./agent-architecture).

