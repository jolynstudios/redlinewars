# OpenRA in the browser

This is the real OpenRA engine compiled for .NET 8 WebAssembly. It is not a
JavaScript rewrite, a video stream, or a simplified clone: Chromium boots the
actual Red Alert main menu, runs the normal rules and order pipeline, and draws
the game through WebGL2. The browser and desktop runtimes have also replayed the
same fixed-seed match with frame-for-frame identical orders and sync hashes.

That browser port became the foundation for something larger: a live
agent-versus-agent arena where two language models command normal Red Alert
armies under fog of war, while the simulation keeps running and a human watches
their thoughts, alerts, reflexes, spend, and actions.

The deeper references are:

- [Browser port boundary and validation](../BROWSER-PORT.md)
- [Agent Mode architecture and implementation findings](AGENT-MODE-DESIGN.md)
- [Benchmark protocol, metrics, and objections](BENCHMARK.md)

The documentation-site guides cover the same system as a shorter reading path:
[introduction](docs-site/docs/intro.md), [the port](docs-site/docs/the-port.md),
[playing locally](docs-site/docs/playing.md), [scope and goals](docs-site/docs/scope-and-goals.md),
[architecture decisions](docs-site/docs/architecture-decisions.md),
[agent architecture](docs-site/docs/agent-architecture.md),
[the benchmark](docs-site/docs/the-benchmark.md), and
[battle your model](docs-site/docs/battle-your-model.md), with the planned work in
[the roadmap](docs-site/docs/roadmap.md).

## The port

The port keeps browser-specific code in `OpenRA.Browser` and
`OpenRA.Platforms.Browser`. The engine changes are small, desktop-neutral seams:
a cooperative game/server stepper, an in-memory connection, platform and
connection factories, and pumps for transports that cannot own a thread. Core
gameplay remains the same C# simulation used on desktop.

What works today:

- the real Red Alert main menu and Lua-free shellmap;
- skirmish games on normal maps, including the built-in OpenRA bots;
- replay playback and desktop-to-Wasm determinism checks;
- WebGL2 rendering, mouse and keyboard input, Web Audio, and Modern controls;
- a full-window/fullscreen canvas, with the game resolution chosen from the
  browser size at boot;
- settings and installed content persisted in IndexedDB between visits; and
- multiplayer through the browser WebSocket transport and a WebSocket-to-TCP
  relay.

### Limitations

These are product boundaries, not footnotes:

- **No Lua runtime.** Most official Red Alert campaign missions attach Lua
  scripts, so campaigns are not playable yet even though their upstream menu
  paths exist. Agent Mode is skirmish-only for the same reason.
- **No live drawing-buffer resize.** The canvas fills the window, but its game
  resolution is selected at boot. Resize the window and reload to change that
  resolution.
- **No direct TCP from a browser.** Browser multiplayer is WebSocket-only. An
  original TCP OpenRA server needs the included WebSocket-to-TCP bridge, and a
  cross-build match still requires rules/simulation-compatible builds.
- **Red Alert game data is not bundled.** OpenRA's GPL/CC engine and authored
  assets ship; EA/Westwood's freeware data does not. For local use, provide the
  upstream quick-install archive when prompted or populate
  `Support/Content/ra/v2`. A public deployment must choose an appropriate
  user-supplied or CORS-enabled content-delivery path. See the legal boundary in
  [BROWSER-PORT.md](../BROWSER-PORT.md#assets--legal-boundary-verified).
- **Browser performance still varies.** Chromium is the canonical automation
  and determinism environment. Firefox and WebKit boot, render, accept input,
  and play audio, but interpreted Wasm is substantially slower on Firefox.

## Playing it

You need the .NET 8 SDK, the Wasm workload, Node.js, and Red Alert content. The
one-time SDK setup is:

```sh
dotnet workload install wasm-tools
```

From the repository root, publish and serve the bundle:

```sh
make browser
node OpenRA.Browser/tests/server.mjs --root bin-browser/AppBundle --port 8331
```

Then open the game:

```text
http://127.0.0.1:8331/?mode=game&platform=webgl2
```

The Node server uses the correct Wasm MIME type and serves local development
content directly from `Support/Content/ra/v2` when present. If content has not
already been installed into browser storage, the game asks for the upstream
quick-install ZIP. The manual example uses port 8331 because port 8321 is
reserved for the browser harness. `make serve-browser` remains the
build-and-serve shorthand and uses port 8321.

Useful URL parameters are passed straight through to the host or engine:

| Parameter | Effect |
| --- | --- |
| `mode=game&platform=webgl2` | Boot the playable engine instead of the headless rules probe. |
| `Launch.Map=Siberian-Pass.oramap` | Start through a specific map rather than stopping at the menu. |
| `Host.AgentMode=1` | Load the Agent Mode rules overlay and spectator console; this deliberately changes the rules checksum. |
| `Debug.ServerRandomSeed=23456` | Fix the local server seed for a reproducible test. |
| `Host.ContentSource=https://…/quick-install.zip` | Use a deployment-provided, CORS-enabled content source; there is no embedded default mirror. |
| `Host.WsEndpoint=ws://127.0.0.1:8322` | Select an explicit WebSocket relay endpoint for multiplayer. |
| `Host.ModId` / `Host.ModVersion` | Override handshake identity only; this does not make incompatible builds compatible. |

For example, the Agent Mode entry point is:

```text
http://127.0.0.1:8331/?mode=game&platform=webgl2&Host.AgentMode=1&Launch.Map=Siberian-Pass.oramap
```

## Agent Mode

Agent Mode is a hierarchical commander, not a model clicking pixels and not an
LLM with direct access to game objects. Two independent Mastra agents run in a
local Node sidecar. Each controls one inert OpenRA bot slot through an opaque
capability id. Every accepted model action becomes an ordinary, frame-stamped
OpenRA order, passes ownership and rules validation, enters the lockstep stream,
and is captured in the replay.

The hierarchy has four layers:

1. **Strategic commander.** The model sees a bounded structured observation,
   writes a short commander journal, chooses typed actions, and may commit an
   opening or production sequence as a build plan.
2. **Host-truth ledger and event bus.** The engine supplies current economy,
   power, building counts, production milestones, alerts, and plan state.
   Alerts compare only currently visible forces to give a fog-safe threat
   estimate. Events such as first contact, a base incursion, a critical asset
   under attack, low power, or an affordable idle queue can wake the commander
   before its heartbeat.
3. **Deterministic reflexes.** Persistent `setPolicy` standing orders handle
   return fire, harvester escape, critical-asset defense, rallying, and
   health-threshold retreat between model decisions. Actor leases and cooldowns
   keep reflex orders from fighting the commander's recent orders.
4. **Authoritative engine.** Strict adapters validate every move, attack,
   production request, placement, squad command, and policy change. The model
   never mutates world state and cannot submit raw engine order strings.

### What the commander can see

Normal observations use the commanding player's actual shroud and visibility.
Own actors, visible enemies, legal capabilities, queues, resources, and alerts
are serialized explicitly; hidden live actors are never exposed. Scouted enemy
structures may persist through OpenRA's frozen-actor layer as clearly marked
last-known beliefs, with a host-recorded age. They can be stale and are not
legal live targets.

A fog-safe 16×16 symbolic minimap, plus bounded `CONTACT` and `FRONT` lines,
gives models spatial context without leaking the hidden world. Named squads let
the commander address a persistent group instead of repeating long actor-id
lists; dead members are culled automatically.

### Pre-match planning

The interactive setup panel enables **Pre-match planning** by default. Before
the match world exists, both commanders concurrently receive the same public
map facts: bounds, all candidate spawn cells, and the two factions. Neither
commander receives its assigned spawn or any live-world state. Decision `0` can
contain only one opening `queueBuildPlan`, one complete `setPolicy`, and a
bounded journal memo; movement, combat, squads, and missions are not legal in
this phase.

Each planning request has a 30-second model budget and fails open per seat: a
timeout or invalid response launches that commander with the default policy and
no opening plan. The host validates every staged seat against one live warmup
snapshot before applying either seat, so a bad plan cannot give the other side
a partial head start. Normal decisions begin at `1`, and the world never waits
once it has launched. The host DTO remains backward-compatible with
`prematchPlanning: false`; `Host.PrematchPlanning=0` or `=1` overrides the
default-checked browser control. `Host.PlanningTimeoutMs` accepts 10000–120000
milliseconds and defaults to 30000.

### Build-plan commitment state machine

`queueBuildPlan` commits up to eight ordered production steps. The host waits
for prerequisites and cash, starts production, adopts and places the completed
item, confirms delivery by identity, then advances one step at a time. The
observation reports the exact commitment state (`planned`,
`waitingPrerequisites`, `waitingCash`, `producing`, `waitingPlaceable`,
`placing`, `confirmed`, `completed`, or `cancelled`) plus pause status and
reason. Critical alerts pause the plan for the commander to resume, replace, or
cancel. This lets the model spend scarce decisions on scouting, combat, and
adaptation instead of reissuing the same build instruction every turn.

Action batches are schema-limited to 12 actions. Production counts provide
batching inside an action, making giant panic replies impossible at the schema
boundary.

### Latency and failure are part of the system

The world does not wait for a model. Normal decision cadence adapts to measured
latency; alert turns use a smaller tactical observation, lower reasoning effort,
and a short budget. A timeout or unusable response becomes a no-op while the
reflex layer and simulation continue.

The sidecar's response pipeline was hardened against failures observed in live
matches: strict structured output, JSON salvage from otherwise valid raw text,
one bounded repair, a full-size repair budget when the first answer was cut off
for length, and a final JSON-only instruction placed immediately before the
model answers. A consecutive-failure circuit breaker quarantines the model's
possibly poisoned journal and failure context for a clean attempt. Per-attempt
outcome, duration, finish reason, reasoning-token count, output bytes, and
billed cost remain available for diagnosis without logging credentials. This
stack has recovered an agent in the middle of a real failure spiral without
pausing the match.

### Watching and operating a match

With `Host.AgentMode=1`, the game sits between two commander sidebars. Each
shows identity, live thoughts, accepted-action rate, no-ops, latency, and spend;
alerts and deterministic reflexes appear as separate bubbles and toasts. The
pre-match panel selects models, factions, reasoning profiles, prompts,
observation mode, and a hard spend cap.

Start the sidecar separately:

```sh
cd OpenRA.Browser/agent-sidecar
npm ci
npm run build
npm start
```

Its local endpoint is `http://127.0.0.1:4112`. For an interactive match, enter
the OpenRouter key in the password field. It stays in worker/request memory and
is cleared on stop; do not put keys in URLs, prompts, logs, replays, settings,
or committed files. The companion service necessarily sees the key during the
request, and a browser Worker is not a security boundary against a compromised
origin or extension. Use a dedicated, credit-limited key.

## Architectural choices

Several choices are deliberate and define what conclusions can be drawn from a
match:

- **Hierarchy instead of end-to-end reinforcement learning.** This is an
  inference-time command system, not an RL trainer. The model owns strategy and
  delegates explicit commitments and urgent reactions to bounded host
  controllers. There is no reward-shaping or policy-training loop hidden behind
  the benchmark; a learned policy could use the same public action boundary in
  future without changing that boundary.
- **A standing-order reflex, not a second ModularBot.** OpenRA's ModularBot is a
  complete unsynced strategic AI that happens to submit normal orders. Agent
  seats instead use an inert bot and a narrow reflex controller that executes
  only the model's declared `setPolicy`: immediate defense, escape, rally,
  return fire, and retreat. It cannot choose the economy or campaign, and its
  visible actions are separately logged and scored. Reusing a full bot would
  create contested control, ambiguous attribution, and an unsafe path from
  unsynchronized host code into modules that may consume `LocalRandom`.
- **The sync-order law.** Nondeterministic reasoning may observe and choose
  outside the synchronized simulation, but it may affect the world only by
  submitting an ordinary validated OpenRA order. Neither the model, sidecar,
  coordinator, nor reflex controller directly mutates synchronized state. That
  is why a recorded match replays without calling the model.
- **Journal and facts stay separate.** `memo` is the commander's self-authored
  intent and belief state, explicitly bounded and possibly stale. The
  host-truth ledger is authoritative current evidence about the commander's own
  economy, structures, milestones, policy, alerts, and commitments. The latter
  always wins when they disagree.
- **Schemas guide; the engine decides.** Zod is the sole response-shape
  authority. A sanitized, required-complete provider schema is guidance only;
  every returned object still passes Zod. Passing Zod does not make an action
  legal.
  Intuitive semantic APIs (`startProduction`, named squads, build plans, exact
  producer IDs) and concrete rejection reasons help a model correct itself;
  C# ownership, visibility, capability, and trait validation remain final.
- **Resilience follows observed failures.** The repair reserve, raw-JSON
  salvage, length-aware full-budget repair, trailing JSON-only order,
  consecutive-failure journal quarantine, and attempt forensics all answer
  failure modes seen in live matches. Recovery stays bounded, billed, and
  visible rather than creating silent free retries.
- **The unattended key never enters the browser.** The match runner sends the
  literal `use-env-key` sentinel. The sidecar replaces it with
  `OPENROUTER_API_KEY`, so the actual credential is absent from browser state,
  command arguments, and result files. This is operational containment, not a
  claim that environment variables are a general secrets vault.
- **Latency is tempo.** Per-model reasoning profiles make the depth/speed choice
  explicit, measured latency adjusts heartbeat cadence, and urgent events use a
  bounded fast path. The world still runs while either seat thinks; scheduling
  does not reimburse a slow model with paused time or catch-up turns.
- **Fixtures preserve invariants, not a scripted spectacle.** Sidecar fixtures
  use controlled providers to reproduce malformed, truncated, slow, and
  provider-rejected replies. Engine gates stage real production, placement,
  death, fog, scouting, and combat through synchronized orders. Live defects
  become regression cases that follow actor identity and plan ownership rather
  than brittle aggregate counts or a particular unit's survival; independent
  combat waves keep one phase's casualties from becoming the next phase's
  hidden prerequisite.

For the longer rationale and implementation findings, see
[Agent architecture](docs-site/docs/agent-architecture.md) and
[AGENT-MODE-DESIGN.md](AGENT-MODE-DESIGN.md).

## Scope, goals, and non-goals

Current scope is one browser-hosted Red Alert skirmish with two model-controlled
bot slots, one neutral human spectator, and one local or same-origin Mastra
sidecar talking to OpenRouter. Chromium/Release is the acceptance environment;
the benchmark records real engine outcomes and replayable orders.

The goals are to preserve OpenRA's authoritative simulation and fog, make model
command legal and auditable, keep the game responsive through slow or failed
calls, let a user battle any two models without a bespoke engine integration,
and report outcome, reliability, latency, doctrine execution, and cost without
mixing incompatible harness eras.

The project does not aim to:

- replace OpenRA's built-in bots or claim that host reflexes are model
  intelligence;
- provide an RL training loop, hidden reward shaping, or direct world-state
  access;
- pause or slow the game to equalize providers, infer a winner from a strong
  unfinished position, or turn one entertaining match into a ranking;
- advertise campaigns before Lua exists, make incompatible multiplayer builds
  compatible, or hide the WebSocket bridge requirement;
- expose raw order strings, silently repair illegal strategy, or grant retries
  that are absent from the score and spend cap;
- claim browser BYOK is safe against a compromised origin, extension, or local
  sidecar; or
- bundle EA/Westwood assets or treat local development content delivery as a
  public-hosting policy.

## The benchmark

The Red Alert Benchmark measures command rather than question answering. Its
signature rule is simple: **the world never pauses**. A model that thinks for
40 seconds gives its opponent 40 seconds to mine, build, scout, and attack.
Decision latency is therefore part of intelligence-in-action, alongside
planning quality, reaction, reliability, and cost.

The public protocol keeps separate tracks:

- **Raw:** neutral prompt, no doctrine or advisor hints.
- **Assisted:** the generated rules knowledge, deterministic hints, and a
  doctrine playbook.
- **Learned series:** after a match, the model reflects over its report and
  bounded prior lessons, then carries the rewritten lessons into the next game;
  results are paired with a fresh-context control series.

Every result is stamped with a harness era: engine commit, observation and
action schema, prompt and knowledge hashes, latency profile, and reflex defaults.
Results from different eras are not mixed. Finished games report W–L records
with sample sizes and Wilson intervals; Elo begins only after enough finished
games. Unfinished spend- or time-capped games are not quietly turned into wins,
and infrastructure failures are excluded from skill statistics.

The match runner detects OpenRA's resolved winner before world teardown. The
metrics pass writes machine-readable metrics and a human scorecard covering
acceptance and no-op rates, decision and alert-reaction latency, doctrine
milestones, tokens, cost per decision, and cost per match. The self-filling
leaderboard then aggregates compatible results, including skill-per-dollar.

### Battle any two OpenRouter models in three commands

After the browser bundle, Playwright test dependencies, and sidecar are ready,
start the sidecar with `OPENROUTER_API_KEY` set and run these from
`OpenRA.Browser`:

```sh
node tests/match-runner.mjs \
  --model1 <openrouter-id> --model2 <openrouter-id> \
  --playbook1 classic-doctrine --playbook2 classic-doctrine \
  --faction1 russia --faction2 russia \
  --effort1 low --effort2 low --cap 2.00 --label my-match-1 --headed \
  --sidecar http://127.0.0.1:4112
node tests/a2a-metrics.mjs tests/match-results/my-match-1
node tests/leaderboard.mjs tests/match-results
```

Drop `--headed` for an unattended run. The runner requires two different model
ids by default; deliberate same-model calibration uses `--mirror`. Each match
directory contains `log.jsonl`, screenshots, `outcome.json`, `metrics.json`,
`scorecard.md`, and the replay audit trail.

`--sidecar` accepts only an unauthenticated loopback HTTP URL. This makes a
live validation run easy to isolate from a long-lived service: start another
sidecar with `(cd agent-sidecar && PORT=4113 npm start)`, then pass
`--sidecar http://127.0.0.1:4113`. State samples in `log.jsonl` and the final
`outcome.json` also include diagnostic Web Audio telemetry (`state`, cumulative
`voicesStarted`, and `activeVoices`). These counters detect a suspended or
silent audio path; they do not record audio or prove that every game cue was
audible.

`classic-doctrine` is the baseline rather than a claim of optimal play. It
transcribes the shipped OpenRA Normal AI's priorities and thresholds into the
same standing-order, build-ladder, composition, protection, and attack-wave
language available to the model. It provides a concrete, repeatable floor for
assisted comparisons.

Benchmark results still need caution: current sample sizes are small, provider
routing adds variance, map pools are era-specific, and a cap-limited position
does not prove who would eventually win. The exact pairing rules, rating math,
artifact definitions, and answers to common fairness objections live in
[BENCHMARK.md](BENCHMARK.md).

## Roadmap

### Near term

- Run the full-stack validation match with two different models on the final
  reconciled browser, host, sidecar, and runner bundle.
- Establish the classic-AI baseline by putting an LLM following
  `classic-doctrine` against OpenRA's real built-in bot.
- Seed Era 1 with a pilot round robin between Gemini 2.5 Flash, GPT-5 mini, and
  Grok 4.5 in both raw and assisted tracks, with at least three side-swapped
  games per pairing.
- Add an explicitly labeled and metered deterministic doctrine fallback so a
  failed model turn need not become catatonia. Scorecards will expose
  `fallbackRate`; fallback play will not be presented as model output.
- Connect the existing reflection endpoint to runner-managed lessons injection
  for learned series, always paired with a fresh-context control.
- Add human-versus-agent matches with minutes survived as the first simple,
  observable human comparison measure.

### Mid term

- A/B test a two-tier command staff. Promote it only after repeated,
  same-era matches show measured outcome, latency, and cost gains without a
  reliability regression.
- Publish the era-stamped leaderboard and its underlying scorecards and replay
  evidence.
- Expand the map pool as Era 2 rather than silently mixing those results into
  Era 1.
- Add spend-normalized and latency-normalized divisions alongside the main
  real-time ladder, never pooled into one score.

### Long term

- Bring a compatible Lua runtime to Wasm so campaigns and Lua-authored maps can
  join the browser surface honestly.
- Turn the fixed-target WebSocket-to-TCP relay into a production-ready bridge
  for original OpenRA community servers while preserving build-compatibility
  checks.
- Accept community model submissions with reproducible configurations,
  era/track labeling, auditable artifacts, and the same key and spend safety
  boundaries.
