---
sidebar_position: 1
slug: /
title: OpenRA, running in a browser
description: The real OpenRA engine, its browser port, agent commander mode, and real-time model benchmark.
---

# OpenRA, running in a browser

This project compiles the real OpenRA engine to .NET 8 WebAssembly. It is not a JavaScript remake and it does not approximate Red Alert rules. The same C# engine, MiniYAML rules, order validation, lockstep simulation, and replay machinery that run on desktop now boot the actual Red Alert main menu in Chromium and render through WebGL2.

The port changed the platform around the engine: the browser supplies graphics, input, audio, storage, scheduling, and network transport. Gameplay remains inside OpenRA. A browser order follows the normal validation and replay path, and the simulation remains authoritative.

## What you can do today

- Open the real Red Alert menu and play skirmishes with Modern mouse controls.
- Watch and record normal OpenRA replays.
- Keep settings, installed content, and replay files across reloads in IndexedDB.
- Fill the browser viewport with the game, with Web Audio and mouse/keyboard input.
- Join compatible OpenRA multiplayer games through a WebSocket-to-TCP bridge.
- Run two language models as opposing commanders and watch their thoughts, alerts, reflexes, actions, cost, and outcome live.
- Turn those matches into reproducible scorecards and an automatically updated benchmark leaderboard.

The portability claim is tested, not inferred. Fixed-seed desktop and browser replay streams are compared frame by frame, including orders and synchronization hashes. The browser transport also preserves OpenRA's length-prefixed wire bytes. A mismatch is treated as a lockstep bug, never papered over.

## The second project inside the port

Agent mode gives each model a fog-safe, bounded view of the same live match a human would play. Models return typed action batches; the host checks ownership, visibility, capabilities, production rules, placement, and batch limits before issuing ordinary OpenRA orders. A deterministic reflex layer can act under model-defined standing policy while the slower commander plans.

That makes the game a benchmark for command rather than question answering. The world never pauses while a model thinks. Decision latency costs tempo, illegal actions are rejected with reasons, and every match produces an auditable replay and metrics trail.

Read [Agent architecture](./agent-architecture) for the control hierarchy and [The benchmark](./the-benchmark) for tracks, metrics, fairness rules, and result eras.

## The honest boundary

:::caution Current limitations

- **No Lua runtime:** the main menu works because the browser bundle includes a script-free shellmap, but the official campaigns and Lua-driven custom maps do not. Do not advertise campaign support.
- **No live render-buffer resize:** the drawing buffer takes the viewport size at boot. Reload after resizing the window or changing the surrounding layout.
- **No raw TCP from a browser:** multiplayer uses WebSockets. An original TCP OpenRA server needs the included fixed-target bridge, and the browser build must still match the server's rules and simulation.
- **Red Alert game assets are not bundled:** EA/Westwood's freeware files are still copyrighted. Supply the OpenRA quick-install archive on first run or configure a lawful content source.
- **The current build is single-threaded, interpreted Wasm:** Chromium is the acceptance target; Firefox is substantially slower in the current test configuration.

:::

See [The port](./the-port) for the engineering and legal boundaries, or [Playing](./playing) to build and open it locally.

