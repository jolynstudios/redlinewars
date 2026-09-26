# OpenRA LLM Benchmark

This is the canonical operator and design guide for measuring LLM-agent play in
OpenRA. It covers the latency-invariant skill benchmark, the separate real-time
track, deterministic adjudication, calibration, paired sweeps, anchored Elo,
spend controls, commands, flags, evidence, and implementation paths.

Current implementation status: the benchmark machinery is complete through
commit `9f4fa1f697`. The current benchmark map pin is
`Siberian-Pass.oramap`; calibration still requires human review and freeze, and
real-provider calibration and leaderboard runs remain deliberately held behind
spend authorization.

## Scope and companion documents

This README is the operating authority for running the benchmark. Two companion
documents retain narrower historical and design detail:

- [BENCHMARK-HARDENING-PLAN.md](../BENCHMARK-HARDENING-PLAN.md) is the versioned
  design specification and decision record for lockstep fairness, adjudication,
  calibration, and ranking.
- [BENCHMARK.md](../BENCHMARK.md) records the learned-series and real-time
  harness. Its “world never pauses” behavior applies to the real-time track,
  not to the lockstep skill track described here.

Do not combine results from these two tracks into one score or leaderboard.

## What the benchmark measures

The harness deliberately separates strategic playing ability from operational
performance.

| Track | Primary question | Simulation while a model thinks | Latency in skill score | Timeout behavior |
| --- | --- | --- | --- | --- |
| **SKILL / lockstep** | Which policy makes better decisions from equal-opportunity, same-tick states? | Globally paused at each paired decision barrier | No | Deterministic no-op for that seat; reliability recorded separately |
| **REAL-TIME** | How effective is the full deployed agent, including responsiveness and reliability? | Continues advancing | Yes, through lost tempo and missed opportunities | Existing profile policy, which may include fallback when explicitly enabled |

Lockstep exists because model latency, provider load, retry behavior, reasoning
effort, and transient transport conditions are not strategy. A global barrier
gives both seats one paired opportunity from the same frozen simulation frame,
then applies both results together. Seat swaps, spawn swaps, factions, and seeds
still matter because the post-commit game path can diverge; paired series cancel
those systematic advantages rather than claiming that separate games reach
identical states.

The real-time track remains valuable. Report latency, spend, schema failures,
fallbacks, and timeouts there, but never use it as a substitute for the primary
skill ranking.

## The lockstep barrier

Enable the skill track with `--benchmark-lockstep`. It runs through a host-owned
state machine:

```text
Idle -> PausePending -> Frozen/Collecting -> CommitReady
     -> ResumePending -> Idle
```

For each global barrier:

1. The union of both seats' deterministic triggers opens one barrier on the
   per-logic-tick path. The host issues a normal synchronized pause order and
   waits until `World.Paused` is authoritative.
2. The host freezes and records the `WorldTick`, network frame, and sync hash.
   It builds both fog-safe observations once from that frozen world, assigns
   paired decision identities, and caches the serialized snapshots.
3. The browser requests both seats concurrently under one common deadline.
   Adaptive cadence, quiet-skip, near-miss retry, fast-path behavior, effort
   mutation, manual submission, and advisor fallback are fenced off.
4. The host validates both envelopes and their `barrierId` before applying
   anything. Missing, timed-out, or invalid responses become an empty action
   batch: a deterministic **no-op**, never an advisor-generated action.
5. Both batches are appended in stable seat-ordinal order to one local-order
   buffer, applied at the same frozen tick, and followed by the unpause order.
   Unpause is last. Duplicate, stale, late, or wrong-barrier responses are
   rejected.
6. The barrier closes once, advances paired decision counters once, and resumes
   the world. Teardown and fatal paths resolve the barrier once and leave the
   world unpaused when the barrier owned the pause.

Barrier zero is the deterministic prematch opportunity. It shares the same
specification and lifecycle but does not consume the live paired-decision IDs,
which begin at 1.

The host censors a run if the frozen tick or synchronized hash drifts while the
barrier waits. A fatal failure after a partial apply also censors the run; Phase
2 does not pretend to roll back issued engine orders.

### Horizons and cost

Ranked lockstep games stop on deterministic game progress:

- `--tick-horizon` caps logic ticks.
- `--decision-horizon` caps paired live decision opportunities.
- `--decision-timeout-ms` caps each common paired collection window.
- `--minutes` is only a wall-clock safety stop for a wedged process.

At least one tick or decision horizon must be positive. Dollar adjudication and
`--cap` are forbidden in benchmark mode. Provider spend is reported as an
operational metric and is indirectly bounded by the decision horizon; it never
decides who wins or stops one seat earlier than the other.

## Deterministic adjudication

A terminal engine result always wins: A win is `+1`, a loss is `-1`, and the
sign is from seat A's perspective. Only a tick- or decision-capped unresolved
game uses the composite score.

For each component with raw non-negative side values `A` and `B`, calibration
provides a positive denominator floor:

```text
margin = clip((A - B) / max(A + B, floor), -1, 1)
S      = sum(weight_i * margin_i), clipped to [-1, 1]
```

The six components and locked weights are:

| Component | Weight | What the ledger measures |
| --- | ---: | --- |
| Live HP-adjusted combat power | 25% | Remaining combat capability, adjusted for current health |
| Structures by replacement value | 20% | Irreversible loss of critical, production, and tech structures |
| Productive economy | 20% | Time-averaged income and refinery/producer capacity, with cash discounted and capped |
| Combat-unit replacement value | 15% | Irreversible net combat-unit value destroyed, deduplicated by actor identity |
| Tech capability | 10% | Available production and technology capability |
| Region control | 10% | Time-averaged occupancy AUC over calibrated resource regions and chokepoints |

The anti-gaming rule is important: the scorer uses irreversible replacement
loss and remaining capability, not raw damage that rewards inefficient trades.
Map control uses calibrated region occupancy, not vision percentage that can be
padded without holding useful ground.

Verdict policy for an unresolved game:

- `S >= 0.10`: seat A wins.
- `S <= -0.10`: seat B wins.
- `|S| < 0.10`: draw.

The draw boundary is strict: exactly `+0.10` or `-0.10` is a win/loss, not a
draw. Weights are already frozen. Floors and control-region cell sets are
map-specific calibration inputs and are intentionally not compiled as production
defaults.

## Paired series and anchored Elo

A leaderboard matchup is a series, not one game. The series scheduler produces
at least three seed-pairs and covers:

- seed variation;
- seat swap;
- spawn swap;
- faction swap/cycling where the matchup uses factions.

Each game contributes terminal `+1/-1` or its adjudicated composite margin.
The report includes win/draw/loss counts, mean score, and a confidence interval.
Swapped legs from one seed-pair are correlated, so confidence intervals cluster
by seed-pair; treating the legs as independent would report false precision.

The pool report fits an order-independent anchored batch-logistic Elo model with
ridge regularization `800` and a clustered bootstrap confidence interval. It
includes a fixed anchor in every pool:

- model ID: `benchmark-anchor/normal`;
- difficulty: `normal`;
- policy version: `1`;
- policy digest:
  `0669c055a2b6c0224df494ac8951662235fcc2c39b558e9f2121403eba1b3de7`;
- rating: `1200`, an arbitrary scale origin, not a claim about absolute playing
  strength.

The anchor is a versioned, deterministic, mid-strength scripted controller in a
**normal lockstep seat**. It does not reopen `opponentBot`. The
[anchor proxy](./benchmark-anchor-proxy.mjs) exposes the policy through a
loopback endpoint so it receives the same barriers, cached snapshots, deadlines,
and opportunities as an LLM seat. The policy itself lives in
[benchmark-scripted-anchor.mjs](./benchmark-scripted-anchor.mjs).

The first authorized pool should include an anchor-vs-known-model sanity check.
If the anchor is far outside the pool's useful range, Elo spacing can compress;
changing its policy, version, or digest creates a new benchmark lineage.

Each model row keeps playing skill separate from operations:

- skill Elo and clustered CI;
- the full six-component vector;
- latency;
- provider spend;
- timeout/schema/fallback counts.

Operational columns are diagnostic and must not be folded into skill Elo.

### Model and endpoint identity

Every successful decision carries response-derived identity evidence: the
requested model and optional route prefix, the canonical model ID returned by
the provider, the endpoint host, and the route that actually served each
strict/repair attempt. A route-pinned request such as
`grok:x-ai/grok-4.5` is compared against the canonical response ID
`x-ai/grok-4.5`; the `grok:` prefix is routing configuration, not part of the
competitor ID.

Before any match directory, browser, or game tick exists, the runner reads the
sidecar's resolved provider endpoint from `/health`. It refuses every
non-loopback endpoint, including direct `openrouter.ai`, and stamps the exact
resolved URL and host into `outcome.json`. A dry run does not contact a
sidecar; the fail-closed endpoint preflight applies when execution begins.

An explicit provider substitution, a mismatched or missing served-model ID, or
missing endpoint/route provenance is an infrastructure censor. It is never
scored as a loss for the requested model. `match-runner.mjs` records the
per-decision proof in `log.jsonl` and `outcome.json`, `a2a-metrics.mjs` carries
it and the resolved provider endpoint into `metrics.json`, and `scoreGame`
requires both the loopback endpoint stamp and a complete one-to-one match
between valid barrier-seat decisions and those records before a game may enter
the skill table. This prevents a direct metered endpoint from entering the
benchmark evidence at all.

## Maps and benchmark configuration

Maps are configurable in every mode.

- In benchmark mode, `--map` is required and must be pinned in the series
  manifest. The host asserts that the resolved map matches either the requested
  canonical UID or the exact package filename. There is no silent benchmark
  default.
- In demo/real-time mode, `--map` is optional. If omitted, the agent match uses
  **A Nuclear Winter**.
- `Siberian-Pass.oramap` is the current benchmark pin, not a code weld. A new
  benchmark lineage may select another map per run/manifest, then calibrate and
  freeze floors and control regions for that exact map.

Map choice, package hash, canonical UID, control-region hash, tick/decision
horizons, decision timeout, benchmark spec version, model configuration, anchor
version/digest, and calibration digest belong in the evidence. Never compare
ratings across changed benchmark identities as if they were one pool.

## Spend and execution gates

There are three distinct safety levels:

1. **Scripted/test** uses in-process or loopback fixtures and cannot reach a real
   provider.
2. **Dry run** resolves and validates all requested settings, emits JSON, and
   exits before launching the browser, sidecar work, or a provider request.
3. **Real sweep execution** requires all of the following:
   - `--execute`;
   - `--confirm-provider-spend`;
   - a calibration bundle whose status is exactly `frozen`;
   - a non-test bundle and non-test execution mode;
   - a positive manifest `budgetTotalUsd`.

The sweep runner rejects test vectors for real execution. Conversely,
`--scripted-fixture --test-fixture` is confined to test-only calibration and
cannot spawn real matches. Do not weaken or bypass these double gates.

Benchmark mode never passes a per-game `--cap`: dollars do not stop the
simulation or affect skill. The sweep enforces the authorized ceiling only
between games. Before each launch it obtains the scheduled seats' local
sidecar estimate for every decision opportunity, including prematch barrier
zero, reserves both the strict and repair envelopes, and writes that active
reservation atomically. The next game cannot start unless its whole
reservation fits. Final parseable spend replaces the estimate; missing or
non-final spend is charged at the full reservation. This intentionally stops
early rather than guessing low.

Provider keys belong only in the sidecar process environment. Never pass a key
to `match-runner.mjs`, put it in a manifest, or copy it into a result directory.

## Build and local prerequisites

Use Node.js 22 or newer for the sidecar and test runners. From the repository
root:

```bash
make browser

cd OpenRA.Browser/agent-sidecar
npm ci
npm run build
npm run check
npm test
```

For a real-provider demo or authorized sweep, export `OPENROUTER_API_KEY` only
in the terminal that starts the sidecar. If the repository-local `.env` is your
approved key source, load it into that shell without printing it:

```bash
cd OpenRA.Browser/agent-sidecar
set -a
source .env
set +a
PORT=4112 npm start
```

The runner accepts only an unauthenticated loopback sidecar URL. The browser
receives an environment-key sentinel, never the secret itself.

## How to run

All commands below start at the repository root unless a command explicitly
changes directory.

### A. Headed scripted lockstep acceptance run — no spend

This is the safest way to watch the barrier work. It starts its own loopback
scripted sidecar and makes no provider calls:

```bash
node OpenRA.Browser/tests/benchmark-lockstep-gate.mjs --headed
```

It runs the scripted barrier acceptance scenarios, including asymmetric latency
and failure/stop cases. It is an engineering acceptance run, not a leaderboard
series. The determinism variant is also provider-free:

```bash
node OpenRA.Browser/tests/benchmark-lockstep-determinism-gate.mjs --headed
```

### B. Headed real-LLM demo — real-time, provider spend

Start the key-bearing sidecar in terminal 1, as shown above. In terminal 2:

```bash
node OpenRA.Browser/tests/match-runner.mjs \
  --model1 moonshotai/kimi-k3 \
  --model2 x-ai/grok-4.5 \
  --play \
  --headed \
  --cap 2.50 \
  --minutes 30 \
  --game-speed fastest \
  --map Siberian-Pass.oramap \
  --sidecar http://127.0.0.1:4112 \
  --port 8379 \
  --label demo-kimi-vs-grok
```

This is a **demo/real-time** match. `--play` enables arsenal, executor, guided
control, and fallback strike; it is not the latency-invariant skill benchmark.
Remove `--map` to use the demo default, A Nuclear Winter. Use `--dry-run` first
to validate configuration without starting a match or spending:

```bash
node OpenRA.Browser/tests/match-runner.mjs \
  --model1 moonshotai/kimi-k3 \
  --model2 x-ai/grok-4.5 \
  --play --headed --cap 2.50 --minutes 30 \
  --game-speed fastest --map Siberian-Pass.oramap \
  --sidecar http://127.0.0.1:4112 --port 8379 \
  --label demo-kimi-vs-grok --dry-run
```

Omitting `--play` produces the raw real-time profile. The individual assist
flags are documented below.

### C. Real paired benchmark sweep — human-gated spend

Do not run this recipe until a human has approved the model pool, map, frozen
calibration, and provider spend.

Copy the checked-in manifest as an operator-owned run manifest, then change its
series ID, model pool, seeds, ports, and frozen calibration path. Keep the map
and calibration identity aligned:

```bash
cp OpenRA.Browser/tests/benchmark-sweep/benchmark-sweep-v1.fixture.json \
  OpenRA.Browser/tests/benchmark-sweep/my-authorized-pool.json
```

First resolve the complete schedule without launching a match:

```bash
node OpenRA.Browser/tests/benchmark-sweep-runner.mjs \
  --manifest OpenRA.Browser/tests/benchmark-sweep/my-authorized-pool.json \
  --dry-run \
  --output OpenRA.Browser/tests/benchmark-sweep/my-authorized-pool.dry-run.json
```

Review the dry-run artifact, calibration digest, anchor digest, exact map,
model configurations, seeds, swap coverage, horizons, ports, result paths,
`budget.ceilingUsd`, the conservative estimate assumptions, and the absence of
a dollar stop. Only after explicit spend approval:

```bash
node OpenRA.Browser/tests/benchmark-sweep-runner.mjs \
  --manifest OpenRA.Browser/tests/benchmark-sweep/my-authorized-pool.json \
  --execute \
  --confirm-provider-spend \
  --output OpenRA.Browser/tests/benchmark-sweep/my-authorized-pool.result.json
```

The first paid start atomically creates
`<manifest-directory>/<seriesId>.sweep-ledger.json` before launching a game.
The ledger is label-keyed and records every attempt as `resolved`,
`unfinished`, or `infrastructure-censored`. Resolved and valid horizon-capped
unfinished games are never replayed. A missing/invalid outcome, nonzero runner
exit, watchdog kill, desync, failed host state, or browser-page failure is
infrastructure-censored, excluded from model scores, and remains retryable.
Each attempt also records its estimate, observed spend when final, charged
spend, and whether the charge came from observation or the reservation. An
active reservation is written before process launch; after a parent crash,
resume censors and charges that reservation before retrying the label.

If execution is interrupted or reports pending labels, resume the same manifest
and ledger explicitly:

```bash
node OpenRA.Browser/tests/benchmark-sweep-runner.mjs \
  --manifest OpenRA.Browser/tests/benchmark-sweep/my-authorized-pool.json \
  --execute \
  --confirm-provider-spend \
  --resume \
  --output OpenRA.Browser/tests/benchmark-sweep/my-authorized-pool.result.json
```

Starting without `--resume` when that ledger exists is a hard error. Resuming
without the ledger is also a hard error; the runner never guesses at paid
history. Before retrying a censored label it atomically moves the prior evidence
directory under `match-results/.benchmark-sweep-superseded/<label>/`.
Preserve the manifest, dry-run, ledger, superseded evidence, and result artifact
together.

### D. Scripted sweep resolution — no spend

Use the test-only frozen vector to exercise scheduling and aggregation without
provider access:

```bash
node OpenRA.Browser/tests/benchmark-sweep-runner.mjs \
  --manifest OpenRA.Browser/tests/benchmark-sweep/benchmark-sweep-v1.fixture.json \
  --scripted-fixture \
  --test-fixture \
  --output OpenRA.Browser/tests/benchmark-sweep/scripted-result.json
```

This mode cannot be combined with `--execute`.

### E. Offline re-score of an existing sweep — no spend

Recompute the skill records and aggregate from the accepted raw
`outcome.json` files without launching a browser or contacting the sidecar:

```bash
node OpenRA.Browser/tests/benchmark-sweep-runner.mjs \
  --manifest OpenRA.Browser/tests/benchmark-sweep/my-authorized-pool.json \
  --score-only \
  --output OpenRA.Browser/tests/benchmark-sweep/my-authorized-pool.rescored.json
```

By default this reads
`<manifest-directory>/<seriesId>.sweep-ledger.json` and
`OpenRA.Browser/tests/match-results/`. For a transported evidence bundle,
override both explicitly:

```bash
node OpenRA.Browser/tests/benchmark-sweep-runner.mjs \
  --manifest /evidence/pool.json \
  --score-only \
  --ledger /evidence/pool.sweep-ledger.json \
  --match-results /evidence/match-results \
  --output /evidence/pool.rescored.json
```

Score-only requires one accepted, hash-matching outcome for every scheduled
label, rejects active reservations and budget overruns, ignores cached ledger
scores, and recomputes through the current `scoreGame` plus `aggregateSeries`.
It fails closed on incomplete or changed evidence. `--confirm-provider-spend`
and `--resume` remain execution-only. The checked-in test vector additionally
requires `--test-fixture`; production evidence must use its frozen non-test
calibration.

## Complete `match-runner.mjs` flag reference

`match-runner.mjs` intentionally has no permissive `--help` path: an unknown
flag is rejected, prints the usage synopsis, and exits before any provider work.
The tables below are the complete flag reference.

### Seats, models, and prompt configuration

| Flag | Default | Meaning and constraints |
| --- | --- | --- |
| `--model1 <slug>` | `openai/gpt-5-mini` | OpenRouter model slug for seat 1 |
| `--model2 <slug>` | `google/gemini-2.5-flash` | OpenRouter model slug for seat 2 |
| `--mirror` | off | Required when both seats use the same model slug |
| `--playbook1 <id>` | empty/neutral | Seat-1 playbook; letters, numbers, `_`, and `-` only |
| `--playbook2 <id>` | empty/neutral | Seat-2 playbook; same constraints |
| `--faction1 <id>` | `russia` | Seat-1 faction |
| `--faction2 <id>` | `russia` | Seat-2 faction |
| `--effort1 <level>` | provider default | Seat-1 effort: `low`, `medium`, or `high` |
| `--effort2 <level>` | provider default | Seat-2 effort: `low`, `medium`, or `high` |
| `--reaction-model1 <slug>` | unset | Staff-seat reaction model for seat 1 |
| `--reaction-model2 <slug>` | unset | Staff-seat reaction model for seat 2 |
| `--reaction-effort1 <level>` | unset | Staff-seat reaction effort for seat 1 |
| `--reaction-effort2 <level>` | unset | Staff-seat reaction effort for seat 2 |

Do not force a lower effort merely to fit a slow model into lockstep. Pin and
report the intended model configuration and give every seat the same generous
barrier deadline.

### Profiles and assists

| Flag | Default | Meaning and constraints |
| --- | --- | --- |
| `--arsenal` | off | Expose the broader action arsenal |
| `--executor` | off | Enable executor behaviors; requires `--arsenal` |
| `--guided` | off | Enable guided control |
| `--fallback-strike` | off | Enable advisor fallback strike in real time |
| `--play` | off | Expands to `--arsenal --executor --guided --fallback-strike` |
| `--staff-seat` | off | Enables arsenal/executor/guided plus both reaction-model seats, without fallback |
| `--lessons <mode>` | `off` | `off`, `on`, or `control`; `on` may inject/rewrite model lessons after a match; the flag is forbidden in lockstep |
| `--era-lock <path>` | unset | JSON era-lock file; rehash prompt-shaping sources and exit with code 3 on drift |

`--benchmark-lockstep` is a separate profile. It rejects `--play`,
`--fallback-strike`, and `--staff-seat`; benchmark action opportunities and
outcomes must not contain host advisor competence.

### Match, UI, transport, and evidence

| Flag | Default | Meaning and constraints |
| --- | --- | --- |
| `--label <name>` | `match` | Result label; letters, numbers, `.`, `_`, and `-` only |
| `--headed` | off | Show the browser so an operator can spectate |
| `--game-speed <speed>` | `fastest` | `slowest`, `slower`, `default`, `fast`, `faster`, or `fastest` |
| `--map <uid-or-file>` | A Nuclear Winter in non-benchmark mode | Map UID or exact package filename; required for lockstep |
| `--seed <int>` | generated/optional | Deterministic seed in `1..2147483647` |
| `--minutes <n>` | `45` | Real-time duration, or benchmark wall-clock safety timeout |
| `--port <n>` | `8379` | Loopback Browser HTTP port |
| `--sidecar <url>` | `http://127.0.0.1:4112` | Unauthenticated loopback HTTP sidecar only |
| `--cap <usd>` | `2.00` in real time | Dollar stop for real-time demos; explicitly forbidden in benchmark mode |
| `--dry-run` | off | Print resolved JSON and exit before browser/provider execution |

### Lockstep-only flags

| Flag | Default | Meaning and constraints |
| --- | --- | --- |
| `--benchmark-lockstep` | off | Select the primary latency-invariant skill profile |
| `--tick-horizon <n>` | `22500` | Fixed logic-tick horizon; lockstep only |
| `--decision-horizon <n>` | `40` | Fixed paired live-decision horizon; lockstep only |
| `--decision-timeout-ms <n>` | `120000` | One common barrier deadline, range `10000..120000` ms; lockstep only |
| `--benchmark-calibration <path>` | unset | Frozen calibration bundle for adjudication; lockstep only |

A direct lockstep engineering smoke may omit `--benchmark-calibration` and emit
barrier/ledger telemetry only. It is not rankable. A ranked sweep must supply a
human-frozen calibration bundle and preserve its digest in the evidence.
Benchmark lockstep is also mechanically raw: `--arsenal`, `--executor`,
`--guided`, `--play`, `--fallback-strike`, `--staff-seat`, and `--lessons` are
rejected, and the scorer refuses any outcome whose exact assistance stamp
(including lessons) is not all-false or whose recorded lessons mode is not
`off`.

## Sweep manifest

The checked-in test manifest is
[benchmark-sweep-v1.fixture.json](./benchmark-sweep/benchmark-sweep-v1.fixture.json).
It is a schema example and no-network fixture, not an authorized provider pool.
An operator manifest has this shape:

```json
{
  "schemaVersion": 1,
  "seriesSpecVersion": "benchmark-series-v1",
  "benchmarkSpecVersion": "benchmark-lockstep-v1",
  "seriesId": "benchmark-lockstep-v1-authorized-pool-YYYYMMDD",
  "map": "Siberian-Pass.oramap",
  "calibration": "../benchmark-calibration/siberian-pass-v1.frozen.json",
  "eraLock": "../benchmark-era-v1.lock.json",
  "pairCount": 3,
  "seeds": [17001, 17002, 17003],
  "factionCycle": [
    ["russia", "england"],
    ["england", "russia"]
  ],
  "tickHorizon": 22500,
  "decisionHorizon": 40,
  "decisionTimeoutMs": 120000,
  "decisionIntervalTicks": 250,
  "wallClockSafetyMinutes": 45,
  "budgetTotalUsd": 60,
  "dollarStop": false,
  "models": [
    {
      "id": "benchmark-anchor/normal",
      "label": "Pinned Normal Anchor",
      "anchor": true
    },
    {
      "id": "provider/model-a",
      "label": "Model A",
      "reasoningEffort": "medium"
    },
    {
      "id": "provider/model-b",
      "label": "Model B",
      "reasoningEffort": "medium"
    }
  ],
  "anchor": {
    "modelId": "benchmark-anchor/normal",
    "difficulty": "normal",
    "policyVersion": 1,
    "policyDigest": "0669c055a2b6c0224df494ac8951662235fcc2c39b558e9f2121403eba1b3de7",
    "rating": 1200
  },
  "runner": {
    "sidecarUrl": "http://127.0.0.1:4112",
    "matchPort": 8379,
    "anchorProxyPort": 4119
  }
}
```

Use the checked-in fixture and
[benchmark-series-lib.mjs](./benchmark-series-lib.mjs) as the schema authority.
The exact model-entry fields can evolve; always validate with `--dry-run` rather
than trusting a copied example. `calibration` and optional `eraLock` paths are
resolved relative to the manifest. Omitting `eraLock` is permitted for
engineering fixtures, but every resulting game and aggregate is explicitly
pre-era and excluded from rankings. A rankable sweep must supply the reviewed
era lock; every scheduled match receives that exact resolved path.

`decisionIntervalTicks` pins the expected barrier cadence. Each live outcome
stamps the effective value reported by the host after cadence resolution, and
scoring fails closed if it is absent or differs from the manifest; the runner
never substitutes the HTML default.

`budgetTotalUsd` is the hard between-game authorization ceiling. A benchmark
manifest must also use a finite decision horizon from 1 through 999 so every
game has a finite worst-case pricing envelope (the extra opportunity is
prematch barrier zero).

## Calibration and freeze pipeline

Calibration prevents tiny or inactive component totals from creating enormous
margins, and defines meaningful control areas for an exact map. It is a
human-governed stage, not a hidden runtime default.

### 1. Pin the calibration identity

Before generating calibration games, record:

- benchmark and series spec versions;
- exact map request, canonical UID, package hash, and map YAML hash;
- scorer/ledger source revision;
- tick horizon, decision horizon, and barrier timeout;
- seeds, spawns, factions, and scripted scenario identities;
- proposed control-region cell sets and their digest.

The current map choice is `Siberian-Pass.oramap`, but another explicit map is
valid if it gets its own calibration lineage.

### 2. Generate deterministic calibration evidence

Run an approved, representative, model-blind corpus that exercises all six
components at low, medium, and high totals. Every accepted replay must be on the
pinned map, reproduce its seed and swaps, and report `oos=false`. Real-provider
calibration games require the same human spend approval as a real sweep.

The checked-in calibration runner and fixtures exercise derivation without
provider spend:

```bash
node OpenRA.Browser/tests/benchmark-calibration-runner.mjs \
  --map Siberian-Pass.oramap \
  --check OpenRA.Browser/tests/benchmark-calibration/candidates/benchmark-calibration-v1.candidate.json
```

It writes/rechecks a **candidate** derived from deterministic synthetic golden
scenarios. That candidate proves the tooling; it is not enough by itself to
freeze production floors.

### 3. Derive and review candidates blind

For each component, derive the candidate floor as the nearest-rank 25th
percentile (`p25`) of positive paired `A + B` totals from eligible frozen
samples. Candidate control regions are explicit map cells representing resource
regions and chokepoints. They are not vision coverage.

The human reviewer must verify:

- status is `candidate-human-review-required` and
  `productionDefault` is `false`;
- all six floor values include ordered-sample provenance and eligible counts;
- weights remain exactly `25/20/20/15/10/10` and draw band remains `0.10`;
- region cells, map hashes, and `controlRegionHash` match the pinned map;
- scenario and scorer hashes match the reviewed evidence;
- no OOS, mixed-map, duplicate, post-outcome, or provider-fault sample entered
  the corpus;
- candidate values were calibrated blind, before looking at model rankings.

### 4. Human freeze

Only the human decision may promote a reviewed candidate to a versioned bundle
with `status: "frozen"`. The frozen bundle records at least:

```json
{
  "schemaVersion": 1,
  "calibrationId": "siberian-pass-v1",
  "status": "frozen",
  "specVersion": "benchmark-lockstep-v1",
  "weights": {
    "liveHpAdjustedPower": 0.25,
    "structuresByValue": 0.20,
    "economy": 0.20,
    "unitReplacementValue": 0.15,
    "tech": 0.10,
    "regionControl": 0.10
  },
  "drawBand": 0.10,
  "floors": {
    "liveHpAdjustedPower": "<reviewed-positive-value>",
    "structuresByValue": "<reviewed-positive-value>",
    "economy": "<reviewed-positive-value>",
    "unitReplacementValue": "<reviewed-positive-value>",
    "tech": "<reviewed-positive-value>",
    "regionControl": "<reviewed-positive-value>"
  },
  "map": {
    "mapId": "Siberian-Pass.oramap",
    "controlRegionHash": "<sha256-of-reviewed-cells>",
    "regions": ["<reviewed-region-records>"]
  }
}
```

The placeholders above are documentation only and are intentionally not valid
production calibration. The test-only bundle
[golden-score-v1.frozen-test.json](./benchmark-calibration/golden-score-v1.frozen-test.json)
has scope `golden-score-gate-only`, is not a production default, and must never
be supplied to `--execute`.

### 5. Validate, then sweep

Before authorizing the real pool:

```bash
node OpenRA.Browser/tests/golden-score-gate.mjs
node OpenRA.Browser/tests/benchmark-sweep-gate.mjs

node OpenRA.Browser/tests/benchmark-sweep-runner.mjs \
  --manifest OpenRA.Browser/tests/benchmark-sweep/my-authorized-pool.json \
  --dry-run
```

The golden-score gate proves that frozen spec, weights, floors, regions, ledger
outputs, C# scorer, and expected verdicts connect end to end. The sweep gate
proves schedule coverage, pair-clustered confidence intervals, anchored Elo,
component/operations separation, and spend-leak guards without provider calls.

## Evidence and reports

Each direct match writes under:

```text
OpenRA.Browser/tests/match-results/<label>/
```

Preserve at least:

- `log.jsonl`, containing thoughts, actions, barrier events, and state samples;
- `outcome.json`, containing terminal/capped outcome, OOS status, lockstep
  identity, barrier trace, adjudication, model configuration, map, and
  calibration metadata when present;
- screenshots produced by the headed runner;
- runner stdout/stderr redirected by the operator when an external process log
  is required;
- the exact invocation or dry-run JSON and read-only git revision/status.

Sweep output adds schedule identity, per-game evidence paths, pair clusters,
win/draw/loss and score summaries, six-component vectors, anchored Elo and
bootstrap CI, plus operational latency/spend/fallback columns. A result is not
publishable if its frozen calibration digest, map identity, anchor digest,
complete swap schedule, or OOS evidence is missing.

Checked-in evidence uses the `benchmark-lockstep-v1-*` series namespace under
`match-results/`. The publication set is deliberately narrow:
`LEADERBOARD.md`, series reports and ledgers, era stamps, `outcome.json`,
`metrics.json`, `scorecard.md`, `quarantine.json`, `winner.txt`, and
`log.jsonl`. Screenshots and process logs remain useful local diagnostics but
are never committed. Pre-era match directories are not retroactively
published. `publication-evidence-gate.mjs` verifies the real ignore rules,
requires every current-era publication artifact to appear in `git ls-files`,
and rejects bulk files or key-shaped credentials.

## Provider-free verification gates

These gates use scripted or synthetic fixtures and should make no real provider
calls:

```bash
node OpenRA.Browser/tests/benchmark-lockstep-gate.mjs
node OpenRA.Browser/tests/benchmark-lockstep-determinism-gate.mjs
node OpenRA.Browser/tests/golden-score-gate.mjs
node OpenRA.Browser/tests/benchmark-sweep-gate.mjs
node OpenRA.Browser/tests/cp3-planning-gate.mjs
node OpenRA.Browser/tests/skills-gate.mjs
```

The key invariants are:

- inverted response latency yields the same canonical barrier trace and
  `oos=false`;
- no seat applies early and both seats share one commit frame/order digest;
- timeout, worker fatal, page stop, and terminal-while-frozen resolve once and
  leave the world unpaused;
- barrier zero closes deterministically without consuming a live decision ID;
- contract manifests remain byte-identical at the exact skills fingerprint;
- a test calibration vector cannot leak into real execution.

Relevant NUnit coverage is in:

- [AgentLockstepBarrierTest.cs](../../OpenRA.Test/Browser/AgentLockstepBarrierTest.cs);
- [AgentAdjudicationTest.cs](../../OpenRA.Test/Browser/AgentAdjudicationTest.cs);
- [AgentAdjudicationGoldenTest.cs](../../OpenRA.Test/Browser/AgentAdjudicationGoldenTest.cs);
- [AgentAdjudicationLedgerTest.cs](../../OpenRA.Test/Browser/AgentAdjudicationLedgerTest.cs).

## Implementation map

The primary implementation surfaces are:

- [AgentModeHost.cs](../AgentMode/AgentModeHost.cs): benchmark configuration,
  per-logic-tick host progression, synchronized pause ownership, atomic frozen
  snapshots, combined commit, map assertion, barrier/outcome telemetry, and
  fences against real-time controllers.
- [AgentLockstepBarrier.cs](../AgentMode/AgentLockstepBarrier.cs): pure barrier
  state machine, identities, transitions, horizon counters, and canonical trace.
- [AgentAdjudication.cs](../AgentMode/AgentAdjudication.cs): pure composite score
  and verdict.
- [AgentAdjudicationLedger.cs](../AgentMode/AgentAdjudicationLedger.cs):
  deterministic six-component frozen-tick ledger.
- [openra-agent-mode.js](../wwwroot/openra-agent-mode.js) and
  [agent-worker.js](../wwwroot/agent-worker.js): concurrent paired requests,
  common deadline, and one combined browser-to-host commit.
- [match-runner.mjs](./match-runner.mjs): direct demo/lockstep runner, flag
  validation, dry-run resolution, evidence, and runtime safety policy.
- [benchmark-series-lib.mjs](./benchmark-series-lib.mjs): frozen calibration
  validation, paired scheduling, clustered confidence intervals, scoring, and
  anchored Elo.
- [benchmark-sweep-runner.mjs](./benchmark-sweep-runner.mjs): dry-run,
  provider-gated execution, scripted fixture execution, anchor proxy lifecycle,
  crash-safe resumable ledger, infrastructure classification, offline
  score-only replay, and aggregation.
- [benchmark-scripted-anchor.mjs](./benchmark-scripted-anchor.mjs) and
  [benchmark-anchor-proxy.mjs](./benchmark-anchor-proxy.mjs): versioned
  normal-seat scripted anchor and its loopback transport.
- [benchmark-lockstep-gate.mjs](./benchmark-lockstep-gate.mjs),
  [benchmark-lockstep-determinism-gate.mjs](./benchmark-lockstep-determinism-gate.mjs),
  [benchmark-sweep-gate.mjs](./benchmark-sweep-gate.mjs),
  [benchmark-sweep-resume-gate.mjs](./benchmark-sweep-resume-gate.mjs),
  [benchmark-sweep-budget-gate.mjs](./benchmark-sweep-budget-gate.mjs),
  [benchmark-sweep-score-only-gate.mjs](./benchmark-sweep-score-only-gate.mjs), and
  [golden-score-gate.mjs](./golden-score-gate.mjs): provider-free acceptance
  gates.

## Publication checklist

Before calling a leaderboard result comparable or publishing it, confirm:

- the skill track used `--benchmark-lockstep`, not `--play` or another
  real-time profile;
- map, spec, model settings, anchor identity, horizons, and frozen calibration
  are exact and digest-pinned;
- calibration was reviewed blind and has `status=frozen`;
- every scheduled seed/seat/spawn/faction leg completed or is explicitly marked
  censored;
- all accepted games report `oos=false` and canonical barriers close once;
- timeouts became deterministic no-ops, never advisor fallback;
- total charged spend stayed within the manifest ceiling and every unknown
  terminal spend was charged at its full stored reservation;
- CIs cluster swapped legs by seed-pair;
- Elo uses the pinned 1200 anchor, ridge 800, and the reviewed bootstrap method;
- components and latency/spend/fallback remain separate report columns;
- provider faults are reported as infrastructure/reliability evidence, not
  silently patched into playing skill;
- the exact dry-run, command, revision, results, and verification logs are
  archived.

Until a real calibration bundle is human-frozen and provider spend is approved,
the correct project state is: run scripted gates and dry-runs, preserve the
current map pin, and do not launch a real calibration or leaderboard sweep.
