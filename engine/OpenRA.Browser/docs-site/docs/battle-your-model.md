---
id: battle-your-model
title: Battle your model
sidebar_position: 6
description: Run two OpenRouter models, generate a scorecard, and update the benchmark ladder.
---

# Battle your model

Anything with an OpenRouter model ID can take a seat. Cross-model battles are the normal path; same-model mirrors require `--mirror` because they calibrate variance rather than compare entrants.

## Before the three commands

You need Node.js 22+, the browser bundle already published to `bin-browser/AppBundle`, Playwright's Chromium dependency installed, and the agent sidecar running on its default `http://127.0.0.1:4112` endpoint.

For unattended matches, give the sidecar the key. The match runner sends only the `use-env-key` sentinel to the browser; it does not put the credential in its command line or result files.

```sh
cd OpenRA.Browser/agent-sidecar
OPENROUTER_API_KEY='your-dedicated-capped-key' npm start
```

Use a dedicated, credit-limited key. Environment variables are convenient for a local unattended runner, but other processes owned by the same user may be able to inspect them. For an interactive match, enter the key in the browser's password field instead.

### Or run it on a subscription

A match costs roughly $0.65–$1.53 in OpenRouter credits. [sublet](https://github.com/proofofwork-agency/sublet) answers the same wire format from Claude Max, ChatGPT/Codex, z.ai and Grok coding plans, so a ladder can run against subscriptions you already pay for instead:

```sh
cd /path/to/sublet && SUBLET_DEFAULT_MODEL= SUBLET_METERED_FALLBACK=0 bun run serve
cd OpenRA.Browser/agent-sidecar && ./run-with-sublet.sh   # 127.0.0.1:4199
```

Then pass `--sidecar http://127.0.0.1:4199` to the match runner and use the proxy's model ids (`x-ai/grok-4.5`, `z-ai/glm-5.2`, `anthropic/claude-opus-5`, `openai/gpt-5.6-sol`, …). No key is needed; pointing the sidecar at the proxy is just its `OPENROUTER_BASE_URL`. Benchmark runs additionally refuse to start unless the sidecar reports a loopback provider endpoint, and every recorded decision carries the model and route that actually answered — a proxy that quietly substituted a model would otherwise publish a rating for a model that never played.

The two environment variables matter. Left at their defaults, the proxy answers an unknown model id with a substitute and reports `substituted_for` — which the sidecar never reads, so a match could be attributed to the wrong model. Emptying `SUBLET_DEFAULT_MODEL` makes that a 400 instead, and `run-with-sublet.sh` refuses to start unless it has confirmed exactly that.

**`--sidecar` defaults to port 4112.** If another sidecar is running there against the real openrouter.ai, omitting the flag bills credits for a run you believed was free.

`usage.cost` still reports what the call would have cost metered, so `--cap` keeps working as a runaway-loop brake even though the spend is zero. That also means a subscription ladder's costs stay comparable with earlier metered runs — but they are modelled figures, not amounts billed.

## Run, score, rank

From `OpenRA.Browser/`, these are the three commands:

```sh
# 1. Run the real match. Add --headed to watch it.
node tests/match-runner.mjs \
  --model1 <openrouter-id> --model2 <openrouter-id> \
  --playbook1 soviet-armor --playbook2 soviet-grenadier-rush \
  --faction1 russia --faction2 russia \
  --effort1 low --effort2 low --cap 2.00 --label my-match-1 \
  --sidecar http://127.0.0.1:4112

# 2. Turn that match into metrics.json and scorecard.md.
node tests/a2a-metrics.mjs tests/match-results/my-match-1

# 3. Discover all result directories and rebuild the ladder.
node tests/leaderboard.mjs tests/match-results
```

Replace both model IDs with any two OpenRouter IDs. Choose a unique label so a later run does not mix artifacts with an earlier one. `--headed` opens the spectator view; omit it for headless automation. The runner starts and stops its own static file server, but the sidecar remains a separate process.

`--sidecar` accepts only an unauthenticated loopback HTTP URL. To keep a live
validation run isolated from another match service, start a second sidecar with
`(cd agent-sidecar && PORT=4113 npm start)` and pass
`--sidecar http://127.0.0.1:4113`. The result's
`log.jsonl` state records and `outcome.json` include the last Web Audio debug
snapshot: context `state`, cumulative `voicesStarted`, and `activeVoices`.
These are diagnostics for unlock/playback regressions, not an audio recording
or proof that every cue was perceptible.

The default runner limit is 45 wall-clock minutes and the example hard cap is $2. A terminal line reports state, tick, spend, and the detected winner. Spend-cap and time-limit stops remain unfinished outcomes, not inferred victories.

## Watch a casual match

Serve the published bundle and open:

```text
http://127.0.0.1:8331/?mode=game&platform=webgl2&Host.AgentMode=1&Launch.Map=Siberian-Pass.oramap
```

In the setup panel, enter one shared OpenRouter key or one key per side, choose models, factions, prompts or playbooks, reasoning effort, token budget, and spend cap, then start. The center is the live OpenRA match. Each side panel shows that commander's thoughts, action results, alerts, reflexes, acceptance, no-ops, latency, and spend.

**Pre-match planning** is checked by default for a human-started match. Before
the world starts, each model gets 30 seconds to return a memo plus at most one
opening build plan and one complete standing policy. It sees every candidate
spawn but not either assigned spawn. A timeout or invalid reply fails open for
that seat, and staged actions are atomically revalidated when the live world
reaches its warmup boundary. Use `Host.PrematchPlanning=0` to disable the UI
default, or `=1` to force it; programmatic host configs default to false for
backward compatibility.

## Reliability fallback and the classic-AI baseline

The **Assisted advisor fallback** checkbox is deliberately off by default. When
enabled, a timeout, unrepaired schema failure, upstream failure, or open circuit
may trigger one deterministic, fog-safe advisor action through the same typed
validator as a model action. The feed labels it `FALLBACK` and `fallback:true`;
the replay and scorecard count `fallbackTurns / decisionOpportunities`. It does
not activate for a deliberate empty action batch, bad credentials, the spend
cap, or an operator stop. Fallback-enabled and fallback-disabled results are
different harness configurations and must not share a ladder.

For local automation, `Host.AdvisorFallback=1` preselects the checkbox. The
setup panel remains the source of the match config, so the operator can review
it before spending money.

The **Opponent seat** selector can replace Agent 2 with **OpenRA Normal AI**.
This is the shipped synchronized engine bot—not a prompt, imitation, or Agent
host shortcut. Only Agent 1 calls OpenRouter; the Normal AI follows its ordinary
engine bot path. This provides the classic-doctrine baseline: can an LLM
commander beat the deterministic opponent whose heuristics informed the public
playbook? `Host.OpponentBot=normal` preselects this mode. The terminal artifact
records the bot separately with `controllerType=normal`; its LLM latency, token,
and spend fields are N/A rather than zero.

These controls are also era-stamped. Record `advisorFallbackEnabled`,
`fallbackTurns`, `decisionOpportunities`, and `opponentBot` with any published
result. The page saves the complete resolved host state before teardown so a
fast victory transition cannot erase the winner before the runner reads it.

## Reading the result

Do not promote a single entertaining game into a model ranking. A benchmark pairing needs at least three games with sides or spawns swapped, and each result belongs to one harness era and one track. The ladder distinguishes resolved wins, unfinished games, and infrastructure-censored runs.

The match directory under `tests/match-results/<label>/` is the evidence. Start with `scorecard.md`, then inspect `metrics.json`, `outcome.json`, `log.jsonl`, screenshots, and the replay if the headline needs explanation.

## FAQ

### Isn't real-time play unfair to slow, deep models?

It is intentionally a test of command under pressure rather than essay quality. Deliberation costs tempo for a human commander too. The scorecard still separates decision latency from acceptance, milestone, cost, and outcome metrics, so readers can see whether a slower model played better when it did act. Reasoning-effort profiles let a model trade depth for tempo explicitly.

### What if a model already knows Red Alert?

Prior game knowledge is legitimate skill; humans study build orders as well. A model cannot know the live opponent's behavior or current fog state from training. The raw and assisted tracks are reported separately so the effect of the supplied knowledge sheet and doctrine remains visible.

### Doesn't OpenRouter routing make latency noisy?

Yes. Provider routing and load are residual sources of variance. The protocol mitigates them with repeated games, side swaps, p50/p95 latency, infrastructure censoring, and an era stamp that records the visible configuration. It does not claim to eliminate them.

### Can an agent cheat because the whole game is in one Wasm process?

The engine may hold the lockstep world, but the observation builder exposes only that player's fog-safe DTO. Direct attacks require visible target IDs, and every action passes typed ownership and legality checks before becoming a normal OpenRA order. Match logs and replays make the control path auditable. Omniscient research observations require explicit opt-in and are labeled; do not mix them into a fog-safe ladder.

### What happens when a model returns bad JSON or times out?

The sidecar may salvage valid raw JSON or make one bounded repair attempt. If recovery fails, that decision is a no-op and the game continues. The no-op, latency, billed cost, and redacted attempt diagnostics are recorded. There are no unlimited free retries.

### Does the deterministic reflex layer play the game for the model?

No. It executes declared standing orders for immediate defense, such as returning fire or moving a harvester away from visible danger. The model still owns economy, build commitments, scouting, force composition, and attacks. Reaction latency measures when the strategist next issues an accepted order, even if a reflex acted first.

### Why did a clearly stronger position count as unfinished?

Because the engine did not resolve a win. A cap- or time-limited position can be described, but converting an analyst's judgment into a victory would make the benchmark subjective. Increase the cap or limit and run again.

### Can I compare an old result with a new one?

Only if both share the same harness era and track. Changes to observations, prompts, knowledge, repair behavior, latency scheduling, or reflex defaults can change results. A new era gets a new ladder.

For definitions and reporting rules, read [The benchmark](./the-benchmark.md).
