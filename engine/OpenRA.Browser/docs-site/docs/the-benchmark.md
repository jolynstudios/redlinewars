---
id: the-benchmark
title: The benchmark
sidebar_position: 5
description: The Red Alert benchmark protocol, tracks, metrics, eras, artifacts, and limits.
---

# The Red Alert benchmark

Most model evaluations score an answer. This benchmark scores command: building an economy, maintaining a plan, scouting under uncertainty, reacting to an opponent, and converting decisions into a win in a real-time strategy game.

Its defining rule is simple:

> **The world never pauses.** Thinking time costs game tempo.

A commander that deliberates for 40 seconds gives its opponent 40 seconds of income, production, movement, and combat. Latency is therefore part of intelligence-in-action, not an implementation detail hidden from the score.

## What a match compares

For a pairing, both seats use the same OpenRA engine build, map, factions, starting conditions, observation schema, action vocabulary, system prompt for the selected track, token ceiling, request timeout, spend cap, and reflex defaults. Models receive fog-filtered structured state and return validated typed actions. The variable under test is the model.

Illegal actions are rejected with a reason. A failed or late response does not earn a free retry or stop the simulation. The match artifacts preserve enough detail to audit what the model saw, thought, attempted, and achieved.

## Three separate tracks

Results from these tracks are never pooled:

1. **Raw** — a neutral prompt with no playbook or advisor hints. This tests native RTS reasoning.
2. **Assisted** — a doctrine playbook, hints, and a running-version knowledge sheet. This tests instruction-following and doctrine execution.
3. **Learned series** — after each game, the model reads its own report and rewrites a bounded lessons document for the next game. Every learned series must be reported beside a fresh-context control series before claiming in-context improvement.

The classic-doctrine playbook is the public assisted baseline: explicit priorities and phase transitions, not a hidden handicap. A raw-versus-assisted comparison measures how much that shared doctrine changes the same model's play.

## Harness eras

Every result is stamped with its **era**: engine commit, observation schema version, prompt and knowledge hashes, latency profile, and reflex defaults. A harness improvement starts a new era. Results from different eras do not share a ladder, because a better observation, validator, repair policy, or controller can materially improve a model's apparent skill.

This is particularly important here: live matches have exposed real harness defects, including mismatched production vocabulary, incorrect capability advertisement, unpinned factions, and response truncation. Fixing the measurement instrument is good; quietly mixing pre-fix and post-fix results is not.

Era 1 mechanizes the rule with a committed lock file, `era1.lock.json`. The match runner recomputes the era-defining values at startup and refuses to run when they drift from the lock; every result carries the lock's content hash, and the leaderboard partitions by `lockHash`. Games recorded before the lock existed are published as a research preview and are never ranked. The Era 1 pilot's analysis plan is fixed in advance in [Era 1 pre-registration](./era1-preregistration.md).

## Match protocol

- Run a round robin among entrants.
- Play each ordered pairing at least three times and swap sides or spawns.
- Use same-model mirror matches to estimate self-play variance; mirrors are calibration, not the default product battle.
- Hold temperature at 0.2. Output is still nondeterministic, so one game is evidence, not a ranking.
- Use the engine's resolved win state for winner detection before the world tears down.

Every run receives one outcome:

| Outcome | Treatment |
| --- | --- |
| **Win/loss** | The engine resolved victory, normally by base destruction. Counts toward skill statistics. |
| **Unfinished** | A spend cap or wall-clock limit stopped the game. Report it, but do not turn a positional impression into a win. |
| **Infrastructure-censored** | Provider, authentication, or harness failure prevented a valid contest. Exclude it from skill statistics and retain it for reliability analysis. |

## Ratings and scorecards

With small samples, the primary result is the W–L record with a 95% Wilson interval and the sample size displayed. A bare percentage from one or two games is misleading.

Elo activates only after at least ten finished games for a model within one era and track. It starts at 1200, uses K=32, and updates finished games chronologically. Elo is always shown with the underlying W–L and `n`.

Win rate is not enough. Each scorecard also reports:

| Metric | Precise meaning |
| --- | --- |
| **Action acceptance** | Accepted actions divided by submitted actions. Invalid targets, premature placement, and unaffordable or unsupported actions count as model errors. |
| **No-op rate** | Decision turns with no valid batch—such as timeout or unrepaired schema failure—divided by total turns. |
| **Reaction latency p50** | Time from an alert to the model's next accepted order. Host reflexes may defend meanwhile; this metric measures the strategist. |
| **Decision latency p50/p95** | Wall-clock time for a decision request, including reasoning. |
| **Milestone ticks** | World tick for first refinery, War Factory, tank, rush wave, or other doctrine milestones, compared with declared timing windows. |
| **Cost** | Provider-metered dollars per decision and per match, including billed failed or repair calls. |

The public comparison should headline **skill per dollar** alongside wins. A model that achieves nearly the same outcomes for a fraction of the cost is a substantive result.

## Self-filling artifacts and leaderboard

The unattended runner follows the real browser UI, records both thought feeds, polls match state, captures screenshots, enforces spend and wall-clock stops, and detects an engine winner before teardown. The metrics command then writes the scorecard; the leaderboard command discovers result directories and rebuilds the ladder.

Each match directory contains the available audit trail:

- `log.jsonl` with decisions, thoughts, actions, results, timing, and safe usage data;
- `outcome.json` with automatic winner detection and terminal state;
- `metrics.json` and `scorecard.md` from the metrics pass;
- periodic screenshots and a final screenshot; and
- the OpenRA replay and embedded prompt/thought metadata when captured by the run.

See [Battle your model](./battle-your-model.md) for the three-command workflow.

## Prior art and positioning

This project is neither the first browser OpenRA nor the first agent harness around the engine, and the design differences are the point:

- **Rosebud AI's browser port (April 2026)** is a substantial closed-source port: campaign missions run their Lua through MoonSharp and multiplayer uses WebRTC. Without public source, its behavior cannot be independently audited or reproduced, so it demonstrates feasibility rather than serving as an open measurement instrument.
- **A GitLab WebAssembly mirror from 2024** showed the engine crossing the wasm boundary earlier, but has been inactive since.
- **OpenRA-RL** wraps the engine for reinforcement-learning research. In its shipped design the world pauses while the agent decides (an `advance()`-style step loop), opponents are the built-in bots, fog and ownership limits are enforced on the wrapper side rather than by the engine, its leaderboard is self-reported, and daemon mode records no replays. Those are reasonable choices for RL training throughput; they are different choices from adversarial benchmarking.

This benchmark takes the opposite position on each axis: the world never pauses and latency is scored; matches are model versus model; every order is validated by the engine itself, not by a wrapper; every game yields a sync-hashed OpenRA replay with prompts and thoughts attached; and era discipline keeps results from different harness generations in different tables. The comparison above is drawn from each project's shipped code and public documentation as of this writing, and it is not a criticism of goals those projects never had.

## Known limitations

:::caution Read this before citing a number

- The sample set is still small. Confidence intervals and `n` are part of the result, not optional decoration.
- OpenRouter routing and provider load add variance. Repeated games and p50/p95 reporting reduce its impact but cannot remove it.
- The map pool is currently narrow. Map-specific build orders and pathing may not generalize.
- A learned-series result means little without its fresh-context control.
- Cap-limited and wall-clock-limited games do not establish who would eventually have won.
- A replay proves what happened in the engine; it does not prove a provider would return the same stochastic response in a new run.
- Better harness generations improve measurement and agent affordances. Era separation prevents those improvements from being mistaken for model progress.

:::

When a summary and an artifact disagree, inspect the replay and log. The normative protocol is `OpenRA.Browser/BENCHMARK.md`.
