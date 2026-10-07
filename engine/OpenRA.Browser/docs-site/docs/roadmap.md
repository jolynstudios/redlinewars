---
id: roadmap
title: Roadmap
sidebar_position: 8
description: Near-, mid-, and long-term work, with evidence gates for promoting experimental agent architectures.
---

# Roadmap

The roadmap distinguishes shipped mechanisms from planned evaluation. A checked-in schema or endpoint is not a benchmark result, and a compelling showcase match is not enough to promote a new architecture.

## Near term: validate and establish Era 1

### Complete the full-stack validation match

Run two different models through the reconciled sidecar, published browser bundle, real OpenRA host, spectator controller, result capture, metrics pass, and replay path. The acceptance evidence must include terminal state, per-gate exit codes, no out-of-sync result, bounded spend, and usable artifacts. This closes the gap between component gates and the exact public workflow.

### Establish the classic-AI baseline

Pit an LLM using `classic-doctrine` against the real shipped OpenRA bot. This is not an LLM-versus-LLM ladder entry: it calibrates whether the typed interface and doctrine can reach the behavior of a known in-engine baseline. Keep the model's spend, no-ops, fallback use, and survival or victory result visible.

### Run the Era 1 pilot round robin

Run `google/gemini-2.5-flash`, `openai/gpt-5-mini`, and `x-ai/grok-4.5` in both **raw** and **assisted** tracks, with at least three games per ordered pairing and side or spawn swaps. Hold the Era 1 engine, schemas, map pool, prompt and knowledge hashes, budgets, latency profiles, and reflex defaults constant. Report resolved W–L with sample size and intervals; do not promote unfinished positional leads into wins.

### Add a labeled deterministic advisor fallback

When a model produces no usable action batch, a bounded classic-doctrine advisor may be tested as a fallback. It must never masquerade as model output. Every fallback action must be labeled in the thought/action log and replay metadata, and scorecards must report `fallbackRate` as fallback turns divided by decision opportunities.

This fallback is separate from the standing-order reflex layer: reflexes execute an already declared policy between decisions, while fallback doctrine supplies a decision the model failed to supply. Results with fallback enabled require their own harness configuration and cannot be pooled with raw single-model results.

### Finish learned-series runner wiring

The bounded reflection endpoint already exists: it accepts a match report plus prior lessons and returns rewritten lessons under the same key, timeout, cost, and redaction controls. The next step is runner-managed storage and injection of those lessons into the following match, with a fresh-context control series and the lesson hash included in the era metadata.

### Add human-versus-agent survival trials

Add a human-versus-agent format whose primary descriptive metric is **minutes survived**, alongside the engine outcome and normal cost, latency, acceptance, and no-op measures. Treat it as a separate track: human skill varies too much for these trials to enter the model round-robin ladder without a stronger player-rating protocol.

## Mid term: compare architectures and widen publication

### A/B test a two-tier command staff

Evaluate an optional two-model seat: a slower strategic commander sets intent and commitments while a faster staff model handles bounded operational responses. The single-model commander remains the control and the default product path. Both tiers' calls, costs, thoughts, actions, and attribution must remain independently visible.

The two-tier system is promoted only when repeated, matched A/B games in the **same harness era** show a useful improvement in at least one of these outcomes:

- resolved win rate;
- alert reaction latency;
- doctrine milestone timing; or
- total cost for equivalent or better results.

That improvement is disqualified if the candidate worsens any guardrail:

- out-of-sync incidence;
- action acceptance rate; or
- deterministic `fallbackRate`.

Use repeated side-swapped games and declare the comparison and thresholds before running it. One showcase, an unfinished positional lead, or gains caused by a new observation/prompt era do not satisfy the promotion gate. A promoted design still remains a labeled benchmark configuration rather than silently replacing historical single-model results.

### Publish the leaderboard and evidence

Publish the era- and track-partitioned leaderboard with W–L, sample size, uncertainty, Elo only after its activation threshold, latency, milestones, acceptance, no-ops, fallback, and skill-per-dollar. Link scorecards and auditable artifacts. A static public leaderboard can ship before public game hosting because it does not accept keys or run paid matches for visitors.

### Expand the map pool as Era 2

Add maps that exercise different rush distances, resource shapes, chokepoints, and expansion pressure. Because map knowledge and spatial affordances can change rankings, the expanded pool begins **Era 2** rather than being mixed into Era 1.

### Add spend- and latency-normalized divisions

Publish separate divisions with declared spend and latency or reasoning budgets so comparisons answer more than “who won with any amount of time and money?” Keep the unrestricted headline and normalized divisions separate, and retain raw dollars, tokens, and p50/p95 latency underneath every normalized summary.

## Long term: remove platform boundaries and open participation

### Bring Lua to Wasm

Supply a compatible Lua runtime, validate mission scripting under the browser scheduler, and then test official campaigns individually. Campaign support is not complete merely because the mission menu opens.

### Productize the community-server bridge

The browser already has a WebSocket transport and a local WebSocket-to-TCP relay foundation. Long-term work is to harden, deploy, document, and validate that bridge for original community TCP servers, including compatibility checks, discovery, operational ownership, and clear failure reporting. A handshake identity override cannot make rules-incompatible builds compatible.

### Accept community model submissions

Define a submission format for model IDs, track, era, prompts or doctrine, budgets, and artifacts; validate results before aggregation; and publish rejection reasons. Community entry must not require contributors to disclose credentials, and submitted games must meet the same replay, metrics, winner, censoring, and anti-mixing rules as project-run matches.

## What can change the order

Determinism, fog leaks, credential exposure, incorrect winner detection, or an action path that bypasses validation blocks benchmark expansion until fixed. New features that alter observations, instructions, latency scheduling, fallback, or reflex behavior start a new era even if their code change looks small. The roadmap favors trustworthy evidence over a larger but incomparable ladder.

The measurement rules behind these milestones are in [The benchmark](./the-benchmark.md); the fixed boundaries are in [Scope and goals](./scope-and-goals.md).
