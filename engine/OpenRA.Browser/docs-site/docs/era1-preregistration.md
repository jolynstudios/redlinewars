---
id: era1-preregistration
title: Era 1 pre-registration
sidebar_position: 9
displayed_sidebar: guideSidebar
description: The pre-registered analysis plan for the Era 1 pilot — entrants, match design, budgets, metrics, exclusions, and falsification criteria, frozen before the first game.
---

# Era 1 pre-registration

:::info Frozen before data
This analysis plan was written **before** the Era 1 pilot run (registered 2026-07-16) and is published **unchanged** alongside the results. Deviations that occur during the pilot are disclosed in a dated *Deviations* appendix in the results report; this page is never edited to fit the data. A changed plan is a new pre-registration.
:::

Benchmarks drift toward flattery when the analysis is chosen after the games are played. This page fixes the entrants, match design, budgets, primary and secondary metrics, exclusion rules, and falsification criteria for the Era 1 pilot in advance. The protocol it instantiates is described in [The benchmark](./the-benchmark.md); the mechanics of running a match are in [Battle your model](./battle-your-model.md). The normative protocol document is `OpenRA.Browser/BENCHMARK.md`.

## Entrants

Three OpenRouter model ids, selected for availability and price coverage rather than expected strength:

- `google/gemini-2.5-flash`
- `openai/gpt-5-mini`
- `x-ai/grok-4.5`

## Tracks

The pilot runs two tracks and reports them in **separate tables that are never pooled**:

- **Raw** — neutral prompt, no playbook, no advisor hints.
- **Assisted** — doctrine playbook, hints, and knowledge sheet.

The learned-series track is out of scope for this pilot.

## Match design

- **Full ordered-pair round robin.** With three entrants there are six ordered pairs; both orderings of every pairing are scheduled, so seat assignment is balanced by design.
- **N ≥ 3 games per ordered pair.** Side/spawn assignment is swapped between the repeats of a pair, and every game's seed and spawn assignment are recorded in its artifacts.
- **Map.** All pilot games are played on **Siberian Pass** (`Siberian-Pass.oramap`), the map already used by the harness checks. A one-map pool is a stated limitation of the pilot, not a hidden choice.
- **Temperature** is fixed at 0.2 per the protocol; model output remains nondeterministic, which is why no single game is treated as conclusive.
- **Scheduling under the budget.** Games are played in rotating order across the six ordered pairs (every pair's first game before any pair's second game, and so on), so a budget stop leaves balanced coverage instead of favoring whichever pairs were scheduled first.

## Caps and budget

| Limit | Value |
| --- | --- |
| Per-game spend cap | $2.50 |
| Per-game wall-clock cap | 60 minutes |
| Total pilot budget | $20.00 |

A game stopped by a cap is **unfinished** (see exclusions below). The pilot ends when the schedule completes or the total budget is exhausted, whichever comes first.

## Primary metric

**Resolved W–L record per model, per track, with a 95% Wilson score interval and the sample size always displayed.** Only games in which the engine resolved a win state count. Elo follows the protocol's activation rule (at least ten finished games per model within the era and track) and is not promised as a pilot deliverable.

## Secondary metrics

Reported alongside the primary metric, never in place of it:

- **Skill-per-dollar** — resolved results set against metered provider cost, as $/game and $/decision.
- **Decision latency p50/p95** — wall-clock per decision request, including reasoning time.
- **Action acceptance rate** — accepted actions ÷ submitted actions.
- **No-op rate** — decision turns that produced no valid batch ÷ total decision turns.
- **Milestone ticks** — computed from **accepted orders only**; production that was submitted but rejected never counts toward a milestone.

## Exclusions

- **Unfinished games** (spend-cap or wall-clock stops) never enter skill statistics. They are reported separately with counts and stop reasons, and positional impressions are not converted into wins.
- **Infrastructure-censored games** (provider, authentication, or harness failure) never enter skill statistics. They are reported separately as reliability data — they measure the plumbing, not the models.
- **Classic-bot baseline games** (a model versus the shipped classic AI) are calibration context only. They are reported apart from the ladder and are never mixed into model-versus-model standings.

## Falsification criteria

Pre-registered examples of outcomes that would invalidate claims rather than decorate them:

- **If raw and assisted rankings invert across eras** — the model ordering measured under one harness era reverses under the next — then harness affordances, not model skill, dominate the measurement, and cross-era narrative claims must be withdrawn.
- **If mirror-match variance exceeds cross-model gaps** — same-model mirror games vary by more than the observed differences between models — then the samples are insufficient for ranking claims, and the pilot reports intervals only, with no ordering.

## Publication commitment

This plan, the per-game artifacts (logs, replays, screenshots, `metrics.json`, scorecards), and the results report are published together. The plan is published unchanged; anything that had to differ is disclosed, dated, and justified in the results report — not silently reconciled.
