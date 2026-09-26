# Agent vs Agent Mode Design

Status: A0–A2 implemented; pre-match planning implemented; distributed A3 remains future work

## Goal

Add a browser-only mode in which two LLM-driven agents play a normal OpenRA
match against each other. Mastra provides the TypeScript agent runtime and the
user supplies an OpenRouter API key and model selection.

The mode must preserve OpenRA's normal simulation, validation, replay, shroud,
and order paths. An LLM may choose orders, but it must never mutate the world
directly.

## Existing game modes: what is actually present

| Mode | Upstream path | Browser-port status |
| --- | --- | --- |
| Campaign / missions | **Yes.** RA declares `ra|missions.yaml` in `mods/ra/mod.yaml`. `MissionBrowserLogic` lets the player choose a mission, applies mission options plus `state Ready`, and calls `Game.CreateAndStartLocalServer`. `Launch.Map` is a second direct mission/map path through `BlankLoadScreen` and `Game.LoadMap`. | The mode exists, but most official RA campaign maps attach `LuaScript` rules. Until the browser port supplies a compatible Lua runtime, campaign support is incomplete and should not be advertised as playable. |
| Skirmish | Main-menu skirmish opens a local lobby. The browser host's `StartSkirmish` export creates an in-process local server, adds ModularBot slots, and starts the game. | Playable. |
| Multiplayer | A normal dedicated server and normal lockstep orders. The browser uses `WebSocketConnection` through the TCP/WebSocket relay. | Implemented; live multi-client validation is the remaining milestone at the time of this design. |
| Replay | `Game.JoinReplay`; the browser host exposes `StartReplay`. | Playable and used for desktop-to-Wasm determinism validation. It is a playback facility, not a fourth competitive game mode. |

Useful source paths:

- [`mods/ra/missions.yaml`](../mods/ra/missions.yaml)
- [`MissionBrowserLogic.cs`](../OpenRA.Mods.Common/Widgets/Logic/MissionBrowserLogic.cs)
- [`BlankLoadScreen.cs`](../OpenRA.Mods.Common/LoadScreens/BlankLoadScreen.cs)
- [`Game.LoadMap`](../OpenRA.Game/Game.cs)
- [`Program.StartSkirmish`](Program.cs)

## Recommended first version

Run both LLM agents in **one browser match**:

1. The local human client is the admin and spectator/controller.
2. Two playable slots use a browser-only `agent` bot type backed by OpenRA's
   existing inert `DummyBot` trait.
3. Each slot has its own Mastra agent, prompt, model, observation stream, and
   decision state.
4. The browser host maps each opaque agent id to exactly one bot player.
5. Accepted actions are converted to ordinary `Order` objects and submitted by
   the local admin, which is already the bots' `BotControllerClientIndex`.

This is simpler than one browser per agent: it needs no public server, relay,
reconnection policy, or cross-client key setup. It still exercises the real
game, produces normal replays, and preserves lockstep. A distributed mode can
follow after the single-browser control and fairness boundaries are proven.

The `agent` bot must be a valid lobby bot type. Do not use an invalid bot name
as a shortcut. The clean implementation is a browser-port rules overlay that
adds `DummyBot@AgentAI` to the RA player actor without modifying upstream RA
rules. How that overlay is injected should be spiked before implementation;
the fallback is a small, upstreamable rule-extension seam rather than an
OpenRouter or Mastra conditional in `OpenRA.Game`.

## Why the normal order pipeline is the control boundary

OpenRA's ModularBot already establishes the correct model:

- `IBot` exposes `QueueOrder`.
- `ModularBot` runs strategic modules unsynced, then submits queued orders with
  `World.IssueOrder`.
- The source explicitly forbids bot code from mutating world state and notes
  that issued orders are recorded in replays.
- `ValidateOrder` permits a bot-owned subject only when the sending client is
  its `BotControllerClientIndex` and the actor accepts the order.

Agent mode should follow the same contract. LLM calls are nondeterministic, but
their results become deterministic, frame-stamped network orders. A recorded
match can therefore replay without calling the model. This preserves lockstep;
it does not make two fresh LLM runs produce the same decisions.

Relevant source:

- [`IBot`](../OpenRA.Game/Traits/TraitsInterfaces.cs)
- [`ModularBot`](../OpenRA.Mods.Common/Traits/Player/ModularBot.cs)
- [`DummyBot`](../OpenRA.Mods.Common/Traits/Player/DummyBot.cs)
- [`ValidateOrder`](../OpenRA.Mods.Common/Traits/World/ValidateOrder.cs)

## Architecture

```text
OpenRA Wasm game (authoritative simulation)
    |  JSExport: observation / validated action submission
    v
Browser agent coordinator (Web Worker, two independent loops)
    |  HTTPS: observation + ephemeral key + agent configuration
    v
Mastra Server / Node sidecar (Mastra agents and schema validation)
    |  OpenRouter chat-completions request
    v
OpenRouter-selected model
```

### Runtime placement

Mastra core should run in a small TypeScript server/sidecar, not in the render
thread. Mastra's documented browser architecture is a browser-capable
`@mastra/client-js` talking to Mastra Server; Mastra Server exposes agents,
workflows, and tools as APIs. The primary documentation does not promise that
`@mastra/core` itself is a supported browser/Web Worker runtime. Therefore a
browser-bundled core is a future experiment, not the MVP foundation.

The browser-side coordinator should run in a Web Worker. It owns the two
decision state machines, request timeouts, safe telemetry, and the in-memory
keys. The main thread remains the only code that calls .NET exports; it sends
observations to the worker and receives action batches with `postMessage`.
The worker is a responsiveness and code-isolation boundary, **not a security
boundary** against same-origin scripts or browser extensions.

For local development the Mastra server can be a companion Node process. A
public deployment needs a same-origin or explicitly CORS-enabled HTTPS service.
Keep this service under the port-owned browser tree; neither Mastra nor
OpenRouter belongs in core engine projects.

Primary references:

- [Mastra Client SDK](https://mastra.ai/en/docs/deployment/client)
- [Mastra Server deployment model](https://mastra.ai/ai-agent-deployment)
- [Mastra agents and typed tools](https://mastra.ai/docs/agents/mcp-guide)
- [Mastra dynamic agents / runtime context](https://mastra.ai/blog/dynamic-agents)
- [Mastra model-router OpenRouter example](https://mastra.ai/blog/model-router)

## Browser host control surface

Expose a small capability API, not raw engine objects or arbitrary order
strings. The exact DTOs should be versioned and covered by serialization tests.

| Proposed export | Purpose |
| --- | --- |
| `StartAgentMatch(string mapUid, string configJson)` | Start an in-process match with a spectator/controller and two `agent` bot slots. Returns match id, agent ids, player/faction assignment, and schema version. |
| `PrepareAgentMatch(string mapUid, string configJson)` | Validate and stage a match without disconnecting the current world or starting the new simulation. |
| `StageAgentPlanningActions(string agentId, string batchJson)` | Stage decision `0` using the restricted planning vocabulary; live-world validation happens atomically at warmup. |
| `LaunchPreparedAgentMatch(string matchId)` | Launch exactly the currently prepared match; stale ids are rejected. |
| `GetAgentMatchState()` | Return lifecycle state, world tick, net frame, winning/defeated players, and terminal reason. |
| `GetAgentObservation(string agentId, int sinceSequence)` | Return that agent's fog-safe, bounded observation snapshot as JSON. |
| `SubmitAgentActions(string agentId, string actionsJson)` | Validate and enqueue a bounded batch (including its monotonic `decisionId`) through `Game.OrderManager.IssueOrder`; return per-action accepted/rejected results. |
| `StopAgentMatch()` | Disconnect and clear agent/session mappings and pending decisions. |
| `GetAgentActionSchema()` | Return the versioned action schema and limits for the coordinator and diagnostics. |

`agentId` must be an opaque per-match capability mapped internally to one
player. The caller must not be able to substitute a player index or client id.
Each submission includes the observation sequence/world tick and a monotonic
decision id. Duplicate decision ids are idempotently rejected, and stale actor
or target ids produce explicit rejections rather than exceptions.

### Pre-match planning lifecycle

The human setup panel checks pre-match planning by default, but the host DTO
defaults `prematchPlanning` to `false` so existing one-shot callers remain
unchanged. `Host.PrematchPlanning=0|1` is the explicit browser override;
`planningTimeoutMs` is clamped to 10000–120000 and defaults to 30000.

`PrepareAgentMatch` does not claim or tick a game world. It returns a dedicated
sequence-1/tick-0 observation containing map bounds, all candidate spawn cells,
and public factions. It intentionally contains no assigned spawn, actors,
queues, fog state, or live targets. The only legal planning actions are at most
one `queueBuildPlan` and one complete `setPolicy`, plus the bounded thoughts and
memo fields. Both seats request these concurrently.

Provider, schema, observation, or deadline failures fail open per seat; the
browser records a planning bubble and seat-attributed telemetry, then launches
that seat with defaults. Authentication failure remains match-fatal. At the
first safe live warmup boundary, all staged batches are prevalidated against
one snapshot before either controller changes. Only then are decision-0 plans
and policies applied, after which normal decisions begin at `1`. This preserves
the world-never-pauses rule after launch and prevents a bad second-seat plan
from granting the first seat a partial head start.

### Observation schema

Start with one bounded snapshot per decision. At the expected cadence this is
simpler and safer than maintaining a second event system. The worker can derive
"created", "lost", and "changed" deltas from consecutive snapshots. Add an
engine event stream only if profiling proves snapshots too expensive.

The snapshot should contain:

- `schemaVersion`, match id, agent id, observation sequence, world tick, and net
  frame;
- the agent's faction, spawn, team relationships, cash/resources, power state,
  and win/loss state;
- own actors with stable `ActorID`, type, cell, health fraction, coarse status,
  and advertised capabilities;
- allied actors at an intentionally chosen detail level;
- enemy actors only while `Actor.CanBeViewedByPlayer(agentPlayer)` is true;
- optionally, remembered enemy structures from that player's
  `FrozenActorLayer`, marked `frozen` with last-known data and never represented
  as a live target;
- cells/resources only according to `Shroud.GetVisibility`; hidden cells must
  not disclose enemy units, resource changes, or live occupancy;
- production queues, current items/progress, and currently buildable choices;
- a bounded list of important changes since the prior observation when cheaply
  derivable; and
- action limits and capability names supported by this host version.

Do not serialize `World`, `Actor`, trait instances, hidden enemy data, local
random state, or arbitrary reflection output. Cap a snapshot (proposed 256 KiB)
and truncate low-value entities with a reported truncation flag rather than
silently exceeding the bound.

The honest default is player-perspective fog. A full-map/omniscient observation
may be useful for research, but must be an explicit match option shown in the
UI and replay metadata.

### Action schema

Use a strict tagged union such as:

```json
{
  "schemaVersion": 1,
  "decisionId": 42,
  "observedWorldTick": 1250,
  "thoughts": "Rushing two rifle squads to the ore field chokepoint while teching to war factory.",
  "actions": [
    { "type": "move", "actorIds": [101, 102], "cell": [44, 27] },
    { "type": "startProduction", "producerId": 17, "item": "e1", "count": 3 }
  ]
}
```

Initial action adapters should cover:

- `move`, `attackMove`, `stop`, and `deploy` for owned actors;
- `attack` and `capture` against a currently legal, visible target actor;
- `startProduction` and `cancelProduction` using a real owned queue actor and a
  currently buildable item;
- `placeBuilding` using a completed queue item and a legal cell, mirroring the
  normal `PlaceBuilding` order fields;
- `setRallyPoint`, `repair`, and `sell` where the subject advertises support.

Support powers, transports, engineer edge cases, and specialized mod orders can
be added after the core action vocabulary is playable.

The host must enforce ownership, visibility, map bounds, order capability,
buildability, and placement validity before creating an `Order`. Trait/order
resolvers remain the final authority. Proposed safety limits are 64 actions per
decision and 256 total subject ids. Never expose a generic
`IssueOrder(orderString, subjectId, rawFields)` export.

## Mastra agent loop

Create two Mastra `Agent` instances (or two isolated runtime contexts) with
separate system prompts, conversation threads, model selections, token/cost
budgets, and observations. The output is a Zod-validated `ActionBatch`; do not
extract actions from prose. Models without reliable schema/tool support should
be rejected by capability validation or allowed one bounded repair attempt.

The game must never wait for a model:

1. When the world is `Regular`, the coordinator checks the world tick.
2. At `nextDecisionTick`, if that agent has no request in flight, the main
   thread captures one observation and sends it to the worker.
3. The worker calls the Mastra endpoint with that observation, recent strategic
   intent, model, and ephemeral OpenRouter credential.
4. Mastra asks the model for a strict action batch and returns validated JSON.
5. The main thread submits the batch. The host returns accepted/rejected action
   results, which become context for the next decision.
6. The next decision is scheduled from game time, not animation frames or wall
   clock.

RA's default timestep is 40 ms (25 world ticks/second). Start with a configurable
250-tick interval, approximately ten game seconds. Each agent may have only one
request in flight. A late response may still submit non-stale actions, but it
must not cause catch-up request bursts. Timeout, malformed response, insufficient
credit, and rate-limit failures become a no-op turn; the simulation continues.
Honor OpenRouter `Retry-After` for 429/503 responses and show the failure safely
in the operator UI.

Keep prompt context bounded: the current observation, the last accepted/rejected
result, a short rolling strategic summary, and a small number of prior decisions.
Do not send screenshots in the MVP; structured state is cheaper, testable, and
not vulnerable to layout differences.

## OpenRouter integration and key handling

OpenRouter uses Bearer API keys. The normalized raw contract is an HTTPS `POST`
to `https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer
<key>`, `Content-Type: application/json`, and a body containing `model`,
`messages`, and preferably a strict `response_format`. `HTTP-Referer` and
`X-OpenRouter-Title` are optional attribution headers. Mastra's model router
supports an `openrouter/<provider>/<model>` shape, but the exact Mastra/provider
versions must be pinned and smoke-tested before implementation.

References:

- [OpenRouter authentication](https://openrouter.ai/docs/api/reference/authentication)
- [OpenRouter chat-completions request and structured output](https://openrouter.ai/docs/api/reference/overview)
- [OpenRouter errors and `Retry-After`](https://openrouter.ai/docs/api/reference/errors-and-debugging)

### Entry and lifetime

The Agent Match setup panel should provide:

- a password-style OpenRouter key field with reveal/copy disabled by default;
- one model selector per agent, with an option to use the same model;
- optional independent keys per side for tournaments;
- decision interval, maximum output tokens, and per-agent request/cost limits;
- a clear disclosure that model calls cost money and are nondeterministic; and
- a recommendation to create a dedicated, credit-limited OpenRouter key.

Key policy:

- default: worker memory only;
- optional "remember for this tab" only: `sessionStorage`;
- never: URL/query parameters, logs, console, replay, settings YAML, IndexedDB,
  `localStorage`, telemetry, error text, or committed files;
- send only over HTTPS to the configured same-origin Mastra service and onward
  to OpenRouter;
- keep the key in request-scoped Mastra context only and explicitly redact it
  from traces and tool/model metadata; and
- clear worker and session state on Stop, pagehide, logout, or authentication
  failure.

A Web Worker does not protect a key from XSS, extensions, or a compromised
origin. A hosted Mastra service also sees the key for the duration of a request.
The UI must say this plainly. A later production option can use OpenRouter OAuth
or a local user-run Mastra sidecar so the static game host never receives a raw
long-lived key.

## Separation from upstream OpenRA

Keep the feature port-owned:

- browser UI, worker, Mastra client, and agent schemas under `OpenRA.Browser/`;
- Mastra Server/sidecar in a separate TypeScript subproject under that tree;
- browser match DTOs and `[JSExport]` entry points in `OpenRA.Browser`, which
  already references `OpenRA.Game` and `OpenRA.Mods.Common`;
- a browser-only RA rules overlay for the `DummyBot` agent type; and
- no OpenRouter, Mastra, prompt, key, or model conditionals in `OpenRA.Game`.

The rules overlay is an explicit pre-initialization boot profile, enabled with
`Host.AgentMode=1`. `StartAgentMatch` rejects cleanly if the host was not
started with that flag. It must not be loaded in ordinary browser sessions:
changing the RA manifest would change the multiplayer compatibility hash and
break browser-to-unmodified-desktop multiplayer. Entering or leaving Agent mode
therefore requires a host reload until a checksum-neutral dynamic rules seam
exists.

If implementation discovers a missing generic engine capability, propose a
small transport- and AI-agnostic seam suitable for upstream review before
editing core.

## Phased implementation

### A0 — contracts and fake-agent proof

- Finalize versioned observation/action JSON schemas and hard limits.
- Spike the clean browser rules-overlay mechanism for `DummyBot@AgentAI`.
- Add a deterministic fake agent that returns scripted batches without network
  access.
- Prove two agent slots can start, issue bot-owned orders, finish, and replay
  without a sync error.
- Add fog-leak, ownership, malformed JSON, duplicate decision, stale id, and
  oversized-batch tests.

Gate: a fake-agent match is playable and its replay is deterministic; no hidden
enemy state appears in either observation.

### A1 — minimal Mastra match

- Add the TypeScript Mastra Server/sidecar with two agents and strict structured
  output (including the required `thoughts` rationale field).
- Add the browser Worker coordinator and in-memory key flow.
- Add setup/start/stop/status UI with model and cost controls ($2 default cap,
  pre-start cost estimate, auto-stop at cap).
- Add the per-agent live thought-stream feeds (decision 8): observing /
  thinking / decided / result / error bubbles for each agent, plain-text
  rendering only.
- Support movement, combat, production, and building placement.
- Log only safe timing, token, cost, decision, rejection, and thought
  summaries.

Gate: two real OpenRouter-backed agents complete a match without blocking the
render/simulation loop, leaking a key, or bypassing normal orders.

### A2 — robustness and agent quality

- Add bounded strategic memory, richer production/power observations, support
  powers, retries/backoff, and operator pause/replace-agent controls.
- Add model capability discovery and a curated default model list.
- Build evaluation fixtures: economy growth, first production, scouting,
  combat, legal fog behavior, cost per game, and action rejection rate.
- Persist prompts and match metadata only with explicit user consent; never
  persist keys.

### A3 — distributed and tournament modes

- Put one agent behind each multiplayer client or a trusted server controller.
- Define disconnect, timeout, pause, forfeit, spectator, and anti-cheat rules.
- Support separate credentials/budgets and public match observability.
- Reuse the existing WebSocket transport and determinism oracle before enabling
  rated or unattended matches.

## Risks and required tests

- **Information leakage:** the Wasm client has the full lockstep world. Every
  observation field needs explicit player-perspective filtering and adversarial
  tests under shroud/fog.
- **Privileged action surface:** a raw order export would become a cheat API.
  Use typed adapters, opaque agent ids, ownership checks, and hard bounds.
- **Stale decisions:** LLM latency is much longer than an RTS tick. Results must
  tolerate missing/dead actors and reject stale targets without retry storms.
- **Cost runaway:** cap requests, tokens, concurrency, duration, and optionally
  estimated spend per match. Stop automatically at the configured budget.
- **Key exposure:** browser BYOK is inherently exposed to the origin. Apply the
  lifetime/redaction policy and recommend capped keys.
- **Prompt injection through game text:** treat map titles, player names, chat,
  and custom content as untrusted data; delimit it and exclude chat from the MVP
  observation.
- **Model/schema variance:** require structured-output support, validate every
  response, and make invalid output a no-op.
- **Simulation pressure:** snapshot generation and JSON must be measured with
  large late-game worlds; generate only at decision cadence and enforce bounds.

## Product decisions (resolved 2026-07-15)

All seven open questions were answered by the project owner; an eighth
requirement (the live thought stream) was added at the same time.

1. **Fog:** strict player-perspective fog is the default. An omniscient
   research mode exists but must be explicitly enabled, and is labelled in the
   UI and in replay metadata.
2. **Deployment:** a companion/same-origin Mastra service is acceptable for the
   first release (local Node sidecar in development). A static-site-only Worker
   bundle remains a future experiment, not an A1 requirement.
3. **Keys:** both agents share one OpenRouter key by default; an optional
   second key field allows one key per side for tournaments.
4. **Spend:** default hard cap of **$2 per match**, adjustable in the setup
   panel; a cost estimate is shown before Start and the match auto-stops at the
   cap.
5. **Prompts:** system prompts are freely editable per agent, and prompts plus
   model ids are embedded in replay metadata for reproducibility. Keys are
   never stored anywhere.
6. **Spectator:** the human view is neutral/omniscient (standard OpenRA
   spectator behavior). Per-agent fog perspective switching may come later.
7. **Campaign:** Agent mode is skirmish-map only for now; revisit after a
   browser Lua runtime makes campaign missions playable.
8. **Thought stream (new requirement):** the operator must be able to follow
   each agent's reasoning at every moment — before, during, and after each
   decision — as two live chat-bubble feeds (one per agent) alongside the
   match.

### Thought-stream design (decision 8)

- The `ActionBatch` schema gains a required `thoughts` field: a short
  free-text rationale the model must produce with every decision (Zod-schema
  enforced, bounded length, e.g. 1000 characters). Models that expose native
  reasoning tokens through OpenRouter may additionally stream those, but the
  portable baseline is the structured `thoughts` field.
- Each agent's feed shows the full decision lifecycle as bubbles:
  1. *observing* — observation snapshot captured (tick, summary counts);
  2. *thinking* — request in flight (model id, elapsed time, streamed
     reasoning tokens when available);
  3. *decided* — the `thoughts` text plus the action list;
  4. *result* — per-action accepted/rejected outcomes from the host;
  5. *errors* — timeouts, budget stops, and malformed-output no-op turns.
- Thoughts are model output and therefore untrusted: render as plain text
  only (no markdown/HTML interpretation), bounded and truncated with an
  indicator.
- Thoughts are included in the safe telemetry/match log and, consistent with
  decision 5, embedded in replay metadata alongside prompts and model ids.
- The feed must never display the OpenRouter key, raw request headers, or
  another agent's fog-hidden information (the rationale text itself is the
  agent's own output and is shown to the spectator, who is omniscient per
  decision 6).

## Recommendation

Proceed with A0 after review. The key architectural choice is one-browser,
two-DummyBot hotseat control through typed normal-order adapters, with Mastra
core in a TypeScript sidecar and a browser Worker coordinating decisions. This
delivers the requested mode with the smallest trusted surface and leaves the
distributed multiplayer form as an incremental extension rather than a
prerequisite.

## A2a live-match findings (2026-07-16 overnight)

Match 1 (openai/gpt-5-mini + soviet-armor vs google/gemini-2.5-flash +
soviet-grenadier-rush, $2 caps, Siberian Pass) was aborted at six minutes by
the early probe: both agents were degenerate, for different reasons. Total
probe cost: $0.04.

1. **Reasoning-token truncation (sidecar/panel).** gpt-5-mini produced two
   valid openers (deploy, startProduction) then failed Zod on every later
   decision. Live repro through `/api/decide` showed 1088 reasoning tokens on
   a mid-game decision against the panel's 800 `maxOutputTokens` default —
   the JSON never fit. Fixes: default raised to 2048; `errorStrategy: 'warn'`
   so Mastra hands back the raw object instead of demanding the model echo
   identity fields we overwrite; one `json_object` retry when our own Zod
   parse fails (previously only on provider HTTP 400); 422s now include Zod
   issue paths. Verified: gpt-5-mini $0.0027/12s, gemini $0.0024/1.6s, both
   valid.
2. **Construction-Yard undeploy trap (host).** RA's `fact` has `Transforms`,
   so `deploy` on the yard was accepted and undeployed it back into an MCV;
   gemini toggled MCV↔yard for ~8 decisions. Fix: `deploy` rejects any
   `BuildingInfo` actor with wording that points at
   startProduction + placeBuildingAuto; a2a-gate asserts the rejection.
3. **Unactionable production rejections (host).** "actor 791 cannot build
   'powr'" led models to guess actor ids. Fix: rejection now names a queue
   that *can* build the item (or says prerequisites are missing).
4. **Usage display (sidecar).** The AI SDK normalises usage to plain numbers;
   our reader expected nested groups — bubbles showed "0 in / 0 out" on paid
   calls. Reader now accepts both shapes; retry costs accumulate.
5. **Comma-locale spend cap (panel).** `Number("2,00")` is NaN; inputs are
   now read via `valueAsNumber` with a comma-tolerant fallback.

Baseline numbers for future evals: gemini-2.5-flash waits correctly on an
in-progress build (empty action batch), reasons ~1.5s/decision; gpt-5-mini
reasons 10–14s/decision with ~1k hidden reasoning tokens; both cite playbook
build orders in their thoughts.

Follow-up findings from the relaunch ladder (matches 1b-1e, same night):

6. **Advertised-forbidden contradiction.** WP3's undeploy guard rejected
   yard deploys, but the observation still advertised "deploy" capability
   on the yard, so the advisor recommended the forbidden action every
   observation and both agents kept retrying it. Capability advertisement
   (and the startup self-tests) now exclude BuildingInfo actors; the gate
   asserts the yard advertises no deploy and no deploy hint names it.
   Lesson: validation, advertisement, and advice must share one predicate.
7. **Vocabulary mismatch.** productionQueues serialized its owner as
   actorId while schema, primer, hints, and rejections said producerId —
   models translated by guessing. Renamed to producerId end to end;
   rejections name the exact usable id.
8. **Unpinned factions.** slot_bot never set factions, so agents rolled
   Random — match 1c handed an Allied roster to a Soviet doctrine (the
   agent built tent while its playbook demanded barr). Factions are now
   config-carried, validated against the map, pinned via lobby orders,
   and gate-asserted from both agents' observations.
9. **Addressing semantics.** RA's classic queues hang off the invisible
   player actor; setRallyPoint addresses the physical building. Gemini
   deadlocked five decisions running on that inconsistency — its thoughts
   named the right id while its actions used the barracks. Production
   verbs now accept an own production building and remap deterministically
   to the owning queue (validation unchanged); proven live at 1e d8 when
   gemini's barracks-addressed e2 was accepted.

Meta-lesson: every abort was a port defect surfaced by the live
probe+analyst loop, not model stupidity — the eval harness is the
debugger. gpt-5-mini at 4096 tokens shows no empty-object no-ops and
follows doctrine; reasoning bursts price at ~$0.004/decision.

## Official overnight match results (2026-07-16, baselines)

**Match 1 — match1f-mini-vs-flash ($0.93, natural completion, no desync):**
gemini-2.5-flash (SOVIET FIRESTORM, russia) defeated gpt-5-mini (SOVIET
IRON SPINE, russia) by production-base destruction at ~22:16 game time.
Tallies: mini 65 decisions, 208 actions, 96.15% accepted, $0.36; flash
118 decisions, 488 actions, 95.08% accepted, $0.57. Tempo decided it:
flash played 1.82x the decisions while mini spent 12-22s/decision on
deeper reasoning and never made the weap->fix->3tnk transition.

**Match 2 — match2-grok-vs-flash ($1.87, cap-limited draw, no desync):**
x-ai/grok-4.5 (IRON SPINE) vs gemini-2.5-flash (FIRESTORM) stopped by
the $2 spend guard at ~17:10 game time; no winner declared. Position at
cap: decisively grok — 111 own actors and the complete doctrine base
(2 proc, powr chain, barr/kenn, weap, fix, dome, ftrk, one 3tnk) vs
flash's 7 surviving actors at cash=1 with an unplaced second refinery.
Grok proved the full armor phase transition is executable on this
observation/action surface (weap d21->placed d24, fix d31, 3tnk+dome
d33), self-correcting a cash-starvation loop on the way. Tallies: grok
38 decisions, 187 actions, 95.19% accepted, ~$1.48 (~$0.04-0.07 and
25-54s per decision); flash 91 requests, 288 actions, 88.54% accepted,
~$0.39, one schema no-op, and a terminal knowing-doing loop of 15
consecutive premature proc placements despite explicit "not ready"
rejections (the clearest remaining intelligence gap alongside phase
tracking).

Night total across all attempts and repro calls: ~$2.96. Engine verdict
after both matches: zero desyncs, zero validation deadlocks, cap
enforcement correct — remaining work is agent intelligence, not port.
