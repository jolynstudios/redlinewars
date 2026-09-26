---
id: architecture-decisions
title: Architecture decisions
sidebar_position: 4
description: The product choices, rejected alternatives, live-match evidence, and fixture philosophy behind OpenRA Browser and Agent mode.
---

# Architecture decisions

This page records why the system has its present shape. Some choices are product decisions made explicitly by the project owner; others are engineering consequences needed to keep those decisions honest. They are recorded because changing one can change both the safety boundary and what a benchmark result means.

## Foundation: use OpenRA, not an approximation

**Decision.** The browser runs the real OpenRA engine. Agents control ordinary bot-owned actors by submitting typed actions that become normal OpenRA orders. OpenRA remains authoritative for fog, ownership, buildability, placement, combat, victory, replays, and synchronization.

**Why.** The point is to evaluate command in a real RTS, not in a simplified environment written for models. Normal orders preserve validation, lockstep, and replayability. A model call can be nondeterministic; once accepted, its frame-stamped orders replay without calling the model again.

**Rejected alternatives.** A JavaScript game imitation, direct Wasm-world mutation, and a generic `IssueOrder(orderName, rawFields)` export. All three would make the environment easier to cheat, harder to audit, and less representative of OpenRA.

## Controller topology: one match, two isolated commanders

**Decision.** The first proven mode puts two agent bot slots, one human spectator/controller, and both decision loops in one browser match. Each seat has a separate model, prompt, observation stream, journal, budget, and request state. The browser coordinator lives in a Worker; the main thread alone calls .NET exports.

**Why.** This exercises a normal two-player game without making public networking, reconnect policy, cross-client credentials, or distributed trust prerequisites. The Worker keeps provider latency and coordinator work away from rendering, but it is treated as a responsiveness boundary—not a security sandbox.

**Rejected alternative.** One browser or remote process per model for the first release. Distributed tournament mode remains useful, but it needs explicit disconnect, forfeit, spectator, and anti-cheat rules before it can be rated.

## Owner decision 1: player-perspective fog by default

**Decision.** Each model receives only its own fog-safe observation. Omniscient input is an explicit research option and is marked in the UI and match metadata.

**Why.** Scouting and uncertainty are part of Red Alert. The observation builder applies engine visibility rules before serialization. Fog memory retains only last-known enemy structures with a last-seen tick and never turns them into live target IDs. The 16×16 spatial summary, contact lines, threat estimates, and alerts are derived from the same permitted information.

**Rejected alternatives.** Omniscient-by-default agents, screenshots as the primary input, and exposing the complete Wasm world because it already exists in client memory. Screenshots are expensive and layout-dependent; raw world access is a cheat surface.

## Owner decision 2: a companion Mastra service is acceptable

**Decision.** The first release uses a local or same-origin Node/Mastra sidecar. The Worker sends it bounded observations and ephemeral credentials; the sidecar handles provider calls, schema validation, repair, redaction, usage, and cost.

**Why.** Mastra documents a browser client talking to Mastra Server, not `@mastra/core` as a supported in-browser Worker runtime. A sidecar also gives provider-specific failure handling one narrow, testable home without adding OpenRouter or Mastra code to `OpenRA.Game`.

**Rejected alternative.** A static-site-only bundle with Mastra core in the Worker was not accepted as the MVP foundation. It remains an experiment, not a claimed deployment mode.

## Owner decision 3: shared key by default, separate keys when needed

**Decision.** Both agents share one OpenRouter key by default. A second optional field supports separate credentials for tournaments.

**Why.** One key makes a casual local match easy; separate keys preserve independent accounting and failure domains when organizers need them. Normal browser use keeps credentials in Worker/request memory and clears them on stop.

**Rejected alternatives.** Requiring two keys for every match, or persisting a convenient long-lived key. Keys do not belong in URLs, logs, prompts, replay metadata, settings, IndexedDB, or `localStorage`. A Worker cannot protect a key from a compromised origin or extension, and the sidecar necessarily sees it during a request; the UI says so plainly.

## Owner decision 4: a visible, enforced spend ceiling

**Decision.** A match defaults to a **$2 hard cap**, adjustable before start. The UI estimates cost and the runner stops when the cap is reached.

**Why.** Provider calls are nondeterministic and sometimes fail after consuming billable tokens. A warning is not a budget. Cost includes repairs and failed billed calls, and the benchmark reports both dollars per decision and dollars per match.

**Rejected alternatives.** An unlimited default, a soft warning, or pretending failed calls are free. Match 2 (`match2-grok-vs-flash`) stopped at the cap and was recorded as an unfinished draw despite grok's stronger position; the cap must not manufacture a win.

## Owner decision 5: editable prompts, reproducible records, no recorded secrets

**Decision.** Each agent's system prompt is editable. Prompt text and model IDs are embedded in match/replay metadata; credentials are not.

**Why.** Prompting is part of the experimental condition. A result is not reproducible or auditable if the doctrine and instructions are missing. Separating prompts from keys preserves that record without turning a replay into a credential leak.

**Rejected alternatives.** One hidden fixed prompt, unversioned prompt changes, and recording raw request headers. Benchmark eras additionally stamp the engine commit, schema version, prompt/knowledge hash, model profile, and reflex defaults so later harness improvements do not silently advantage new entrants.

## Owner decision 6: the human spectator is omniscient

**Decision.** The operator sees the standard neutral OpenRA spectator view. Per-agent perspective switching may come later; it is not required for the first release.

**Why.** The human is judging the match and needs to understand both plans, threats, and outcomes. The spectator layout puts the game between two identity cards, thought feeds, metric strips, and alert/reflex toasts. Spectator visibility never enters either model's observation.

**Rejected alternatives.** Forcing the operator to one agent's fog view, or using the spectator's omniscient state to enrich agent prompts.

## Owner decision 7: Agent mode is skirmish-only

**Decision.** Agent mode uses skirmish maps. Campaign support waits for a compatible browser Lua runtime.

**Why.** The browser can boot the real menu over a script-free shellmap, but most official Red Alert missions and many custom maps attach Lua. A working menu and direct non-Lua map launch are not evidence that campaigns work.

**Rejected alternative.** Advertising campaigns and failing after launch, or selectively bypassing mission scripts. That would be both misleading and a different game.

## Owner decision 8: reasoning must be observable live

**Decision.** The operator gets two live feeds covering `observing`, `thinking`, `decided`, `result`, and `error`. Every action batch carries a short required `thoughts` rationale. Provider-native reasoning can be shown when available, but portable structured thoughts are the baseline.

**Why.** A final action log does not let a human follow a commander during a live match. The lifecycle exposes latency, intent, validation results, and failures while the world continues. Thoughts are bounded, untrusted model output and are rendered as plain text only.

**Rejected alternatives.** Post-match-only explanations, raw hidden chain-of-thought as a dependency, Markdown/HTML rendering, or feeds that include credentials and request headers.

## The world never pauses

**Decision.** Simulation time continues during model inference, timeout, repair, and failure. A malformed or late response can become a no-op turn; there is no catch-up burst.

**Why.** Latency is part of command. In the first completed baseline, `match1f-mini-vs-flash`, Gemini made 118 decisions to GPT-5 mini's 65 and won naturally after about 22 minutes. Mini's deeper 12–22 second decisions were not free: Flash achieved 1.82 times the decision tempo.

**Rejected alternatives.** Pausing the game for each model, scheduling from animation frames, or issuing several immediate requests after a slow response. Those designs hide the central speed-versus-depth tradeoff and can overload a provider.

## Typed, bounded actions instead of prose or raw orders

**Decision.** Responses are strict action batches. The model-facing schema allows at most **12 actions** and 256 addressed actor IDs per decision. Counts, squads, standing policy, and build plans express repeated or long-lived intent compactly.

**Why.** Typed actions are validated twice—first for shape, then against live engine facts. Explicit rejection reasons become useful feedback. The 12-action ceiling makes the observed giant-batch panic failure schema-impossible: a model cannot waste its output budget narrating and issuing dozens of individual cancellations when one counted action is enough.

**Rejected alternatives.** Parsing actions out of prose, accepting unlimited batches, silently repairing illegal game choices, and exposing arbitrary order strings. Schema repair may correct representation; it must never invent strategy or turn an illegal action into a legal one.

## Hierarchy: strategy above commitments above reflexes

**Decision.** The model owns strategy. A host-owned build-plan state machine executes an explicitly committed sequence. A deterministic reflex layer implements model-set standing orders between decisions. Actor leases keep routine reflexes from immediately undoing fresh model orders. This hierarchy, event-driven decisions, and better observations are the intelligence program; the project does not train or fine-tune model weights.

**Why.** Match 3 supplied the decisive pattern: Grok could form and follow a strategy but felt turn-based, while GPT-5 mini often did nothing and neither reacted between fixed decision ticks as the classic AI did. That was evidence of missing event wakeups, tactical reflexes, and latency-aware scheduling—not evidence that another weight-training pass would solve the interface. The compared models are closed services in any case; this project does not own weights to train. Eval-driven prompt, policy, and controller iteration is the available and auditable learning loop.

Language models are slow and conversational memory is not a reliable scheduler. The host-truth ledger therefore reports economy, buildings, milestones, policy, and build-plan state; the bounded commander journal can express beliefs but is always subordinate to current host facts.

Build plans advance only after observing concrete results. They wait for prerequisites and cash, own their production queue while active, auto-place their building, and expose every transition. Critical alerts pause a plan for commander review. Replacement during `placing` must adopt or cancel the old plan-owned ready item; rejecting it as “unmanaged” would strand real production. Unit completion tracks newly delivered **actor IDs**, not aggregate counts, because a same-type casualty during production can otherwise make a delivery appear to disappear.

**Rejected alternatives.** Reinforcement learning or fine-tuning as the immediate answer; letting the model reissue every production step from memory; allowing direct production to race an active plan; measuring delivery only by counts; or allowing reflexes to override all explicit orders. The hierarchy reduces execution mistakes without choosing the strategy for the model.

The reflex controller deliberately lives in the browser host rather than activating OpenRA's full `ModularBot`. Existing bot modules are useful **read-only** sources for placement and economy heuristics, but a second strategic controller would create contested ownership of the same actors. Some modules also use synchronized random state such as `LocalRandom`; invoking them from an unsynchronized host path would enlarge the desync surface and make replay attribution ambiguous. The host may nondeterministically choose **when** to propose a reflex, but only its validated, synchronized order can change the world.

## Provider schemas guide; Zod is the response authority

**Decision.** The sidecar's Zod `ActionBatch` schema is the sole structural authority over model output. A provider-facing JSON schema is generated as guidance, then normalized for the provider's restricted structured-output dialect. The live engine remains the separate authority over whether a structurally valid action is legal now.

**Why.** OpenRouter routes to providers with incompatible schema subsets. The sanitizer removes unsupported validation keywords and non-string enums, fills the strict provider's required-property list, and preserves property maps even when a property happens to share a keyword name. Responses still pass the full Zod schema afterward; JSON salvage and repair never bypass it.

**Rejected alternatives.** Trusting provider schema acceptance as validation, weakening Zod to the least-capable provider, or letting a schema-repair call invent a legal strategy. Provider schemas improve conformance; they do not define the contract.

This same principle drives **producer aliasing and squads**. Humans point at a barracks to make infantry and command a named force; they do not think in terms of the hidden player-actor queue owner or repeatedly rebuild actor-id arrays. The host accepts those intuitive references, resolves them deterministically to the canonical engine subject, and then runs the unchanged validator. A semantic alias improves legibility without becoming a bypass.

## Bounded response recovery, never an infinite retry loop

**Decision.** The sidecar reserves time for one repair path, validates every candidate with the same schema, and records redacted attempt forensics. It can salvage a JSON object from raw provider text, give a length-truncated repair the full token budget, append the JSON-only instruction after all context, and quarantine the self-written memo after consecutive schema failures.

**Why.** The July 16 live showcase produced a visible schema-failure spiral. Valid JSON was sometimes present in raw text even when the extraction layer returned no object; apology/failure context then poisoned later turns. The combined salvage, length-aware repair, trailing format order, and consecutive-failure circuit breaker broke the spiral and the agent recovered during the same match.

**Rejected alternatives.** Trusting the SDK extraction result over raw text, retrying forever, using a smaller budget after length truncation, or feeding poisoned memory back indefinitely. If bounded recovery fails, the turn remains a visible no-op and play continues.

## Why live matches changed the architecture

The early match ladder is treated as engineering evidence, not a story about model intelligence:

| Evidence | What it showed | Architectural consequence |
| --- | --- | --- |
| Match 1 reasoning truncation | GPT-5 mini used about 1,088 reasoning tokens against an 800-token output setting, leaving no complete action JSON. | Larger default budget, reserved repair time, length-aware full-budget repair, and brevity instructions. |
| Match 1 MCV/Yard loop | Gemini repeatedly undeployed the Construction Yard because `deploy` was advertised and accepted. | Buildings are excluded from deploy; validation, capability advertisement, advisor hints, and fixtures share the same predicate. |
| Match 1 usage and comma-cap bugs | Paid calls displayed zero usage, and `2,00` parsed as no number. | Usage accepts actual SDK shapes; spend input uses numeric/localized parsing and the cap is gate-tested. |
| Matches 1b–1e vocabulary ladder | `actorId` versus `producerId`, random factions, and invisible queue-owner addressing made models guess or deadlock. | One vocabulary end to end, pinned factions, exact usable IDs in errors, and deterministic building-to-queue aliases. |
| `match1f-mini-vs-flash` | A natural, desync-free result made decision tempo visibly decisive. | Latency remains scored game time; it is not normalized away. |
| `match2-grok-vs-flash` | The spend guard stopped the game with no engine winner; Flash repeated 15 premature refinery placements despite explicit rejections. | Cap stops remain unfinished, never inferred wins; the repeated placement loop is reported as an intelligence gap, not silently fixed. |
| Live showcase failure spiral | Structured extraction and poisoned conversational context caused consecutive invalid turns. | JSON salvage, memo quarantine, trailing JSON-only order, bounded repair, and attempt forensics. |
| M2.5 production edge cases | Same-type deaths defeated aggregate completion counts; replacing a plan in `placing` could orphan a ready item. | Correlate delivered actor IDs and make queue ownership/replacement state-aware. |

The recurring lesson is simple: when two capable models both fail on the same interface seam, investigate the harness before calling the models stupid. The live probe is a debugger. Once the interface is coherent, remaining knowing-versus-doing failures belong in the scorecard.

## Fixture philosophy

Fixtures and live matches answer different questions; neither substitutes for the other.

### Deterministic fixtures prove contracts

The browser gate runs a real two-agent match with a fixed seed and a deterministic scripted policy. It builds its scenarios through the public host API and normal orders. It does not spawn units by mutating the world or bypass the action validator.

That rule matters. A refinery-loss alert fixture first builds and places the refinery normally. Combat fixtures produce fresh infantry waves, march them through fog, acquire legal visible targets, and then assert alert/reflex timing. The build-plan fixture records baseline actor IDs, commits eight real steps, verifies every state transition exactly once, destroys a plan-created critical building, proves the automatic pause holds without polling, resumes, and checks final delivered IDs.

Fixtures are deliberately isolated. Variance-sensitive combat runs before the build-plan scenario; surviving attackers withdraw and visible combat must remain clear before the plan begins. The combat gate uses two independent waves—one for a real critical-asset HP drop and defense alert, a second produced afterward for harvester flight—so one wave's survival cannot become the next phase's hidden prerequisite. Assertions fail immediately on desync, oversized observations, fog leaks, ambiguous field names, or schema drift between C#, TypeScript, and the primer.

### Live matches find unknown unknowns

Fake agents cannot reproduce provider finish reasons, hidden reasoning budgets, localized browser input, apology loops, SDK usage-shape changes, or a model repeatedly choosing a legal but bad action. Real paid matches expose those interactions. Their logs, replay, thoughts, attempt diagnostics, and screenshots make the failure inspectable.

A live anecdote is not automatically a benchmark result. Infrastructure failures are censored; spend- or time-limited games are unfinished; only engine-resolved outcomes count as wins. Ratings require repeated side-swapped games within one harness era.

### Acceptance follows the shipping environment

The canonical gate is run twice consecutively against the Release bundle in headless Chromium, with every exit code captured. Headless is deliberate: headed gate windows on a shared desktop have been invalidated by operator-environment interference (a mid-run reload or closed window), which is not evidence about the product. Headed runs remain the human-observation path for real matches. A diagnosed Debug-only combat-timing flake does not redefine the shipping acceptance environment, but it remains documented as fixture work rather than being mislabeled a model or engine failure.

This layered method gives each claim an appropriate proof:

- unit and schema tests for pure boundaries;
- deterministic browser fixtures for real engine interactions;
- desktop/browser replay and sync hashes for portability;
- headed and headless Release gates for the shipped path; and
- real two-model matches for provider behavior and benchmark evidence.

For the runtime hierarchy, see [Agent architecture](./agent-architecture). For how match evidence becomes a score rather than an anecdote, see [The benchmark](./the-benchmark). The browser's platform and legal boundaries are recorded in [The browser port](./the-port).
