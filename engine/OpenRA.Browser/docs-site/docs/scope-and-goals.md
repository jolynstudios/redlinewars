---
id: scope-and-goals
title: Scope and goals
sidebar_position: 7
description: What OpenRA Browser and the Red Alert benchmark are trying to prove—and what they deliberately are not.
---

# Scope and goals

This project has three connected goals. It is a playable browser port of OpenRA Red Alert, a serious and auditable benchmark for language-model command, and a spectator experience that makes the contest understandable while it happens.

Those goals share one constraint: the game remains OpenRA. The browser, agent controller, and benchmark may add transport and control surfaces, but they do not replace the simulation, fog rules, order validation, victory conditions, or replay path.

## Goal 1: a playable browser port

The port should let a player boot the actual Red Alert main menu in a browser and play a normal skirmish with rendering, input, audio, settings persistence, fullscreen presentation, replays, and Modern controls. Multiplayer uses a browser-legal WebSocket transport while preserving OpenRA's normal lockstep protocol.

“Playable” does not mean a visual demo or streamed desktop process. The real .NET 8 engine and Red Alert rules run in WebAssembly. Browser and desktop replay streams provide the determinism check.

Current browser limitations remain part of the scope statement: campaigns wait on Lua, the drawing-buffer size is selected at boot rather than resized live, direct TCP is not available in browsers, and EA/Westwood game data is not bundled.

## Goal 2: a serious, auditable LLM-command benchmark

The benchmark asks whether a model can command under pressure: maintain an economy, follow or invent a plan, scout under fog, react to threats, control forces, and finish a real match while time and money continue to run.

For that comparison to be meaningful:

- the world never pauses for inference;
- each seat receives player-perspective, fog-safe structured state;
- every model action is typed, bounded, validated, and issued through the normal order pipeline;
- failures and repairs remain visible as no-ops, latency, fallback, and cost rather than being silently erased;
- winners come from OpenRA's resolved state, not an analyst's positional judgment;
- prompts, harness settings, thoughts, actions, results, metrics, and replays form an audit trail; and
- tracks and harness eras stay separate so a better controller is not mistaken for a better model.

The aim is not merely to produce dramatic matches. It is to produce results another person can inspect, reproduce as a protocol, and challenge using the recorded evidence.

## Goal 3: a useful spectator experience

A human should be able to understand both armies without opening a log file. The game remains central while sidebars show each model's identity, doctrine, thoughts, accepted and rejected actions, alerts, reflex activity, latency, no-ops, and spend. The operator can set budgets and stop the match; the spectator view does not leak its omniscient state back into either commander's fog-safe observation.

The spectator UI is also diagnostic. Live matches have exposed schema, vocabulary, faction, capability-advertisement, placement, and response-recovery defects that would have looked like “model stupidity” in a scoreboard alone.

## Deliberate non-goals

| Non-goal | Why it is out of scope |
| --- | --- |
| **Reinforcement learning or weight training** | The benchmark evaluates existing models through prompts and bounded cross-match lessons. It does not update model weights or operate a training cluster. Learned-series memory is in-context learning and must retain a fresh-context control. |
| **Per-tick LLM micromanagement** | Model latency and cost are far larger than an RTS tick. Strategic heartbeats, alert-triggered decisions, squads, build commitments, and deterministic reflexes provide a tractable hierarchy without pretending a provider can steer every unit every frame. |
| **An engine-bot/LLM hybrid as the measured contestant** | Letting OpenRA's strategic bot fill gaps would blur who earned the result. Narrow, declared reflexes may execute standing orders, and a deterministic fallback may be studied if it is labeled and metered. The real OpenRA bot belongs as a separate baseline opponent. |
| **Pausing for slow models** | Deliberation costing tempo is the benchmark's defining rule. Pausing would measure turn-based answer quality instead of real-time command. |
| **Default multi-LLM orchestration** | One model per seat is the clean comparison and remains the default. A two-tier command-staff experiment may be A/B tested later, but it is a separate harness configuration and earns promotion only through repeated evidence. |
| **Public hosting—yet** | Local and controlled research use comes first. A public service still needs a defensible Red Alert content-delivery decision, hardened key and sidecar operations, abuse and spend controls, and deployment support. Publishing documentation and leaderboard artifacts does not imply hosted gameplay. |
| **Campaigns before Lua works in Wasm** | Most official Red Alert missions depend on Lua scripts. Advertising campaigns before a compatible runtime exists would turn a visible menu path into a false promise. Agent mode therefore remains skirmish-only too. |

These are boundaries, not declarations that the ideas have no value. Moving one into scope requires a concrete design, an explicit benchmark-era change where relevant, and validation that it does not weaken determinism, fog safety, auditability, or honest attribution.

See [The roadmap](./roadmap.md) for the work that is in scope next.
