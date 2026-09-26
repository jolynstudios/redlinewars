---
id: agent-architecture
title: Agent architecture
sidebar_position: 4
description: How model commanders observe, decide, delegate, recover, and issue legal orders without pausing OpenRA.
---

# Agent architecture

Agent mode does not replace OpenRA's simulation with an AI approximation. Two model-backed commanders occupy ordinary bot slots in one real match. Their choices become normal, frame-stamped OpenRA orders and pass through the same ownership and trait validation as any other order. The match remains lockstep-safe and produces a normal replay; replaying it does not call either model again.

The architecture is deliberately hierarchical. The model handles strategy. Host-owned controllers handle commitments and time-critical reactions. OpenRA remains the final authority.

```text
OpenRA Wasm simulation (authoritative world, fog, validation, replay)
        |
        | bounded observations / typed action results
        v
Browser coordinator (two independent loops, event scheduling, telemetry)
        |
        | one request in flight per agent
        v
Node/Mastra sidecar (schema validation, repair, usage and cost accounting)
        |
        | HTTPS
        v
OpenRouter model selected for that seat
```

## What each commander can see

An observation is structured JSON built for one player. It includes the player's economy and power state, owned actors, currently visible enemies, legal capabilities, production queues, alerts, and bounded strategic summaries. It does not serialize the world or expose arbitrary engine objects.

The observation has several layers:

- **Fog-safe current state.** Enemy actors appear only while OpenRA says that player can view them. Direct attacks require a currently visible target ID.
- **Host-truth ledger.** Authoritative own-side facts—economy, building counts, milestones, standing policy, and build-plan state—override the model's fallible narrative memory.
- **Commander journal.** Every response can carry a bounded `memo` containing intent, beliefs, phase, and next steps. It returns on the next decision as explicitly possibly stale.
- **Events and alerts.** The host reports important changes such as critical assets under attack. Threat estimates compare only visible attackers and defenders; they do not reveal forces under fog.
- **Fog memory.** A previously scouted enemy structure can remain as `last-known`, with its last observed cell and tick. It is a belief, not a live target: the structure may since have been sold, destroyed, or rebuilt.
- **Spatial summary.** A fog-safe 16×16 minimap gives broad orientation. `CONTACT` and `FRONT` lines summarize fighting and known enemy positions, while exact cells remain available for legal orders.
- **Named squads.** Persistent groups let a commander address an army by name. The host removes dead or no-longer-owned members and drops empty squads.

Default observations obey player-perspective fog. Omniscient research mode is an explicit option and is marked in the UI and match metadata. The human spectator uses OpenRA's neutral, omniscient spectator view; that does not change either agent's input.

## Typed actions, not a cheat console

The model returns one strict action batch. The vocabulary covers movement, attack, capture, production, placement, rally points, repair, sell, surrender, policies, squads, and build plans. There is no export for arbitrary order strings and no direct world mutation.

The boundary enforces:

- an opaque, per-match agent capability rather than a caller-supplied player index;
- ownership, target visibility, map bounds, actor capability, prerequisites, buildability, and legal placement;
- monotonic decision identity and explicit stale or duplicate rejection;
- at most **12 actions** and 256 addressed subject IDs per decision; and
- per-action accepted or rejected results with concrete reasons.

The 12-action ceiling is intentional. It makes giant panic batches schema-impossible, encourages production counts and squads instead of repetition, and leaves enough room for every sound tactical turn.

## The command hierarchy

### Strategic model loop

Each seat has its own prompt, doctrine, model, reasoning-effort profile, budget, journal, and decision history. A model sets priorities, commits an opening, scouts, chooses attacks, and revises its policy. A compact Red Alert rules sheet grounds it in the running mod rather than asking it to guess unit names or prerequisites.

Before tick 0, the interactive UI runs a bounded planning phase by default. The
match world has not been created: each seat sees only the map bounds, all
candidate spawn cells, and both public factions, not either assigned spawn.
The planning schema can express at most one `queueBuildPlan`, one complete
`setPolicy`, and a memo. It cannot address actors, squads, missions, or combat.
Both seats plan concurrently. A missing or invalid response fails open after a
30-second request budget, leaving that seat on defaults; the other seat is not
held hostage.

Staging is not authority. At the first safe live warmup boundary, the host
prevalidates every staged batch against the same world snapshot before mutating
either controller, then applies the accepted plans and policies before normal
host controllers run. Decision `0` remains reserved even for a timed-out seat,
so live play starts at decision `1` symmetrically. The browser checkbox is
checked by default, while the versioned host config deliberately defaults
`prematchPlanning` to `false` for older/programmatic callers. URL parameters
`Host.PrematchPlanning=0|1` and `Host.PlanningTimeoutMs=10000..120000` provide
explicit automation overrides.

For learned series, a separate bounded reflection endpoint accepts the completed match report and that model's prior lessons, then rewrites the lessons carried into its next match. Reflection is not allowed to mutate a finished score or the game state, and it uses the same timeout, key-sentinel, redaction, cost, and output-size controls as live decisions.

Decisions are driven by world ticks and the event bus, not render frames. A regular heartbeat follows measured model latency—fast models can decide more often, while slow models leave wider gaps. Important alerts can wake a tactical fast path with a trimmed local observation. Only one request per agent may be in flight, and there is no catch-up burst after a slow response.

Most importantly, **the world never pauses**. A timeout or invalid response is a no-op turn while units, income, production, and combat continue.

### Build-plan commitments

`queueBuildPlan` hands the host an ordered plan of up to eight production steps. The host executes one outstanding step at a time, waits for prerequisites and cash, starts production, auto-places completed buildings, and advances only after observing the result.

The visible state machine reports states such as `planned`, `waitingPrerequisites`, `waitingCash`, `producing`, `waitingPlaceable`, `placing`, `confirmed`, `completed`, and `cancelled`. A new plan ID, or a higher version of the same plan, replaces the old commitment atomically. Replacement reconciles any plan-owned in-flight or ready item instead of abandoning it as unmanaged. `controlBuildPlan` pauses, resumes, or cancels the active plan. Critical alerts auto-pause it so the commander can consciously resume or replace it.

This moves fragile multi-minute build sequencing out of the model's conversational memory without deciding strategy on its behalf.

### Deterministic reflexes

`setPolicy` configures standing orders below the model: return fire, harvester flight, defense of critical assets, rallying new units to defense, and health-based retreat. The reflex controller can react between model turns, which is essential when a provider takes tens of seconds to answer.

Model-issued orders lease their actors for a bounded period. Reflexes respect those leases unless an emergency policy explicitly permits an override, so the tactical layer does not immediately undo the commander's attack or movement order. Reflex activity is emitted as events and shown to the spectator rather than hidden.

## Response resilience

Models and provider routes do not all obey structured-output requests equally. The sidecar therefore treats generated text as untrusted input and uses a bounded recovery pipeline:

1. Ask for a strict, schema-guided action batch while reserving deadline for repair.
2. If the extraction layer returns no object but the raw text contains JSON, salvage the outer JSON object and run the same Zod validation.
3. On a repairable schema failure or provider schema rejection, make one JSON-only repair attempt. A reply truncated for length receives the full output-token budget plus a stronger brevity instruction.
4. Put the final “JSON only” order after the observation and repair context to prevent conversational apology loops.
5. After consecutive schema failures, quarantine the agent's self-written memo and failure-echoing previous result for a fresh-start turn.
6. Record redacted attempt forensics—attempt kind, outcome, finish reason, reasoning-token count, output size, and duration—without logging credentials.

There are no unlimited retries. Timeouts, credit errors, rate limits, and unrepaired malformed output remain no-op turns, and spend accounting includes billed repair calls. The operator can see that a failure happened without exposing the OpenRouter key or raw request headers.

## Spectator and audit surface

Agent mode lays out the game between two sidebars. Each side shows model, doctrine, faction, a live thought lifecycle (`observing`, `thinking`, `decided`, `result`, or `error`), and a compact strip for decisions, acceptance, no-ops, latency, and spend. Alert and reflex events also appear as short-lived toasts next to the relevant army.

Thought text is model output, so the UI renders it as bounded plain text—never HTML or Markdown. Prompts, thoughts, actions, results, usage, and safe telemetry are available to the match artifacts and replay metadata; credentials are not.

Planning failures, timeouts, staged results, and late discarded responses use
the same bounded plain-text feed and replay telemetry path. This makes an
unplanned opening attributable without confusing it with a deliberate empty
live turn.

## Boundaries and limitations

:::warning Honest limits

- Agent mode is currently for skirmish maps. Most Red Alert campaigns depend on Lua, which this browser port does not yet provide.
- Browser bring-your-own-key cannot make a key secret from a compromised origin, browser extension, or sidecar. Use a dedicated, credit-limited key; the normal path keeps it in memory and clears it on stop.
- Fog filtering reduces the information surface, but every new observation field still needs adversarial leak testing.
- Structured actions prevent direct cheating; they do not prevent poor plans, stale decisions, provider outages, or hallucinated IDs. Those become explicit rejections or no-op turns.
- The single-browser controller is the proven mode. Distributed tournament agents introduce separate disconnect, trust, and anti-cheat questions.

:::

For the benchmark protocol and what these mechanisms do—and do not—make fair, see [The benchmark](./the-benchmark.md). The deeper implementation rationale remains in `OpenRA.Browser/AGENT-MODE-DESIGN.md`.
