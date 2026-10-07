# The Red Alert Benchmark

**AI models command opposing armies in a real RTS, in real time, under fog
of war — and every thought, tool call, and order is recorded, replayable,
and scored.**

Most benchmarks measure answers. This one measures *command*: long-horizon
planning, economy management, scouting under uncertainty, reacting to an
opponent who is actively trying to kill you — and doing all of it against
the clock, because of one signature rule:

> **The world never pauses.** Thinking time costs game tempo. A model that
> deliberates for 40 seconds pays 40 seconds of game time, exactly like a
> human player alt-tabbed mid-battle. Latency is not an implementation
> detail here; it is a scored dimension of intelligence-in-action.

---

## What is actually being compared

A **match** puts two models in identical seats: same engine, same map,
same faction, same starting units, same observation format, same action
vocabulary, same money and token budgets, same system prompt (per track).
The **only** difference between the seats is the model behind them. Every
match yields a machine-readable `metrics.json`; matches aggregate into a
leaderboard.

What the model receives each turn: a fog-of-war-filtered JSON observation
(own units, visible enemies, production state, an authoritative
"host-truth" ledger of its own building counts and milestones, alerts with
threat estimates, its own journal from last turn). What it returns: a
strict JSON batch of typed actions (move, attack, produce, place, set
standing orders, …), validated by the engine — illegal actions are
rejected with an explanatory reason, never silently fixed.

What the model does NOT get: hidden enemy state (observations are built
from the same fog its human opponent would see), free retries (a failed
response is a no-op turn and the world moves on), or a paused world.

## Fairness: what is held constant, what varies

| Held constant per pairing | Varies |
|---|---|
| Engine build + observation schema (the "era") | The model |
| Map, factions, starting positions (side-swapped across games) | — |
| System prompt + knowledge sheet (per track) | — |
| $ cap, token ceiling, request timeout | — |
| Reflex policy defaults, decision scheduling rules | — |

**Eras.** Every result is stamped with a harness version (engine commit,
observation schemaVersion, prompt/knowledge hash, latency-profile and
reflex defaults). Results from different eras are never mixed in one
ladder — improving the harness starts a new era rather than silently
advantaging late entrants.

**Era-boundary metadata.** The harness records three reliability/baseline
seams explicitly: `terminalStateStash=true` means the runner consumed the
durable pre-teardown terminal snapshot; `advisorFallbackEnabled` is false by
default and fallback-enabled runs are a separate configuration whose scorecard
must report `fallbackTurns / decisionOpportunities`; `opponentBot` is null for
model-vs-model or the shipped bot id (currently `normal`) for the classic-AI
baseline. A deterministic fallback is always labeled in the feed, log, and
replay—it is never scored as model output. These fields are part of the harness
version and results that differ on any of them are not pooled.

**Era lock (mechanized).** The era stamp is enforced by machinery, not by
discipline alone. Era 1's frozen configuration is captured in a committed
`era1.lock.json`; at startup the match runner recomputes the live
era-defining values and **refuses to run** when any of them drift from the
lock. Every result is stamped with the lock's content hash, and the
leaderboard partitions strictly by `lockHash` — results bearing different
lock hashes never share a table. Games recorded before the lock existed
are published as a research preview and are never ranked.

**Tracks** (compared separately, never pooled):

1. **Raw** — neutral prompt, no playbook, no advisor hints: native RTS
   reasoning.
2. **Assisted** — doctrine playbook + hints + knowledge sheet:
   instruction-following and doctrine execution. From the `era3-skills`
   era the assisted track is **arsenal-based**: the model reads a menu
   of ~10 reviewed strategy cards (rules-grounded, every claim labeled
   ruleFact / derivedComparison / curatedHeuristic with source
   references) and commits to one with a typed `adoptStrategy` action —
   at pre-match planning or any live decision. The host validates only
   facts (known card, faction, arsenal enabled) and records the
   model-stated reason; it never ranks cards, never auto-adopts, and
   the deterministic fallback can never adopt. Adoptions and switches
   are cursor-logged events, so *which strategy, when, and why* is a
   measured output, not vibes. The raw track's provider-visible schema
   and prompt bytes are unchanged by all of this — the arsenal is a
   separate schema mode, off by default.
3. **Learned series** — the model reads its own metrics after each game
   and writes lessons carried into the next: in-context learning, always
   reported against a fresh-context control series.

**Situation recognition (era3-skills).** The host names *what is
happening* — factually, from fog-safe arithmetic (base attacked with
attacker composition, harvester threatened with crush-compatibility,
enemy air/naval sighted, structure damaged with repair/sell economics,
power and funding state, superweapon sighted/launched) — as bounded
`situations` observation entries with stable ids. A situation manual
maps each id to its legitimate response options and when each fits; the
model picks. Both seats of both tracks see the same situations; the
manual and per-situation factual slices are assisted-track material.
The strategy layer's rules facts come from a deterministic,
rules-derived arsenal artifact (every actor, every armament,
condition-aware target profiles, a mechanical counter graph) whose
hashes are pinned end to end: sidecar preflight, host manifest, and a
generated in-engine catalog must agree byte-for-byte before any paid
request.

## The comparison method (exact)

**Pairing design.** Round-robin between entrant models. Each ordered
pairing plays **N ≥ 3 games with side/spawn swap**. Mirror matches (same
model in both seats) calibrate self-play variance. Sampling temperature is
fixed (0.2); model output is still nondeterministic, which is exactly why
single games are never treated as conclusive.

**Outcome taxonomy.** A game counts toward skill only if the engine
resolved a win state:
- *win/loss* — engine victory resolution (base destruction);
- *unfinished* — spend-cap or wall-clock stop: reported, never counted as
  a win, positional notes allowed;
- *infrastructure-censored* — provider/auth/harness failures: excluded
  from skill statistics entirely (they measure our plumbing, not the
  model).

**Ratings.**
- Primary while samples are small: **W-L record with a 95% Wilson score
  interval, sample size always displayed** (`60±40% (n=1)` is honest;
  `60%` alone is a lie).
- **Elo activates at ≥10 finished games per model** within an era/track:
  initial 1200, K=32, standard expected-score formula
  `E = 1 / (1 + 10^((R_b − R_a)/400))`, updated per finished game in
  chronological order. Elo is never shown without the underlying W-L and
  n.

**Beyond win rate — the scored dimensions** (each defined in the metric
glossary below): action acceptance, no-op rate, reaction latency,
decision latency, doctrine milestone timing, and **cost** ($/decision,
$/match) — headlined as *skill-per-dollar*, because a model that plays
90% as well for 10% of the price is a finding, not a footnote.

## "Isn't that unfair to…?" — objections, answered

- **Slow, deep models?** Deliberation costing tempo is the point — this
  measures command under pressure, not essay quality. But we *also*
  report pure-quality metrics (acceptance, milestones, win rate)
  separately from latency, so a reader can see both "how well it played"
  and "how fast it played". A model may also spend its speed budget
  differently via its reasoning-effort profile — that choice is part of
  the game.
- **Models that know Red Alert from training?** Game knowledge is
  legitimate skill (humans study build orders too). What models cannot
  have memorized is our harness, opponents' live behavior, or the fog
  state of a particular game. But be precise about what the
  raw-vs-assisted gap measures: **the value of the provided doctrine and
  knowledge sheet in context, relative to whatever the model already
  knows** — for models with Red Alert strategy content in their training
  corpus, it is *not* a clean "doctrine beyond prior knowledge"
  measurement. Two partial mitigations exist today: OpenRA's balance
  differs from the classic game the corpora describe (memorized 1996
  numbers are wrong here), and the assisted knowledge sheet carries
  exact running-version values with a pinned hash. A proper memorization
  control (an obscure or lightly-reskinned mod era) is future work.
- **Provider variance?** Models run through OpenRouter; routing and load
  vary. Mitigations: N≥3, latency reported as p50/p95 rather than single
  samples, infrastructure failures censored, and the era stamp records
  the provider-visible configuration. Residual provider variance is a
  known limitation and stated as such.
- **Cheating?** The observation builder is fog-gated at the engine level
  (same visibility rules as a human client); every action passes the same
  validator; the full replay — including every prompt and thought — is
  attached to every result. Anyone can audit any game.

## Metric glossary (what the numbers mean, precisely)

- **acceptance rate** — accepted actions ÷ submitted actions. Rejected
  actions (invalid target, not ready, can't afford) are the model's
  errors by definition: the rejection text always explains the rule.
- **no-op rate** — decision turns that produced no valid batch (schema
  failure, timeout) ÷ total turns. Measures output reliability under the
  game's time pressure.
- **reaction latency p50** — wall-clock from an ALERT (e.g. "refinery
  under attack") to the model's next *accepted* order. The deterministic
  reflex layer defends in the meantime; this measures the *strategist's*
  response.
- **decision latency p50/p95** — wall-clock per decision request,
  including reasoning time.
- **milestone ticks** — game tick of the first accepted key production
  (first refinery, War Factory, first tank / first rush wave), compared
  against the doctrine's stated timing windows.
- **$/decision, $/match** — metered provider cost, including billed
  failed calls (failures aren't free in real life either).

## Battle your model (how to enter)

Anything with an OpenRouter model id can fight.

**Casual (watch it live):** open the game with `?Host.AgentMode=1`, put
your OpenRouter key (or `use-env-key` with a sidecar env key) in the
panel, type any two model ids, pick factions/playbooks/effort profiles,
set a spend cap, Start — and watch the thought feeds, alerts, and
reflexes live.

**Benchmark run (counts for the ladder):**

```sh
node tests/match-runner.mjs \
  --model1 <openrouter-id> --model2 <openrouter-id> \
  --playbook1 soviet-armor --playbook2 soviet-grenadier-rush \
  --faction1 russia --faction2 russia \
  --effort1 low --effort2 low --cap 2.00 --label my-match-1
node tests/a2a-metrics.mjs tests/match-results/my-match-1   # scorecard
node tests/leaderboard.mjs tests/match-results              # ladder
```

Winner detection, metrics, and the ladder update are automatic. Artifacts
per match: `log.jsonl` (every thought/action), screenshots,
`metrics.json`, `scorecard.md`, `outcome.json`, and the OpenRA replay
with prompts/thoughts embedded — the complete audit trail.

## External audit responses & threats to validity (2026-07-17)

Two independent external reviews audited this benchmark's design. Points
we agree with, and their dispositions:

- **Reflex attribution.** The deterministic reflex layer is symmetric and
  model-configured (standing orders via `setPolicy`), so it cannot bias
  *between* seats — but absolute "model skill" includes riding a
  competent autopilot. Dispositions: (a) scorecards must report
  reflex-issued order counts per seat, and the counting path is under
  audit (one review observed suspicious zeros); (b) a **no-reflex
  ablation track** (all reflex defaults off) is planned as its own
  track/era so the model's marginal contribution is measurable before
  any public "model-only skill" claim.
- **Tempo vs quality.** Fast models win tempo by design — that is the
  thesis, not a bug. The commitment: every public scorecard keeps a
  **quality-only section** (acceptance, milestones, correct-counter
  rates, win rate) that is never collapsed into tempo-driven outcomes,
  so "played better" and "played faster" stay separately readable.
- **Action-surface thrash.** Early raw games partly measured schema
  literacy and rejection-loop recovery (placement-before-ready spam).
  Dispositions: build-plan commitment and host-run missions structurally
  remove the spam loops from the skills era onward, and the scorecard
  gains a **consecutive-identical-rejection streak** metric so residual
  thrash is visible rather than laundered into noise.
- **Provider routing bias.** p50/p95 reporting does not fix systematic
  routing differences between models. Disposition: future era locks
  record OpenRouter provider pinning per model where the API allows;
  residual variance remains a stated limitation.
- **Double constraint (token ceiling and $ cap).** The per-decision
  output-token ceiling is an infrastructure guard against truncation
  failures (not a scored resource); the **$ cap is the scored
  resource**. A relaxed-constraint sweep to check that neither
  constraint silently favors an entrant class is future ablation work.
- **Sample size.** Era 1 closes as a **13-game pilot** (8 + 5 by budget
  decision) and is labeled a pilot permanently. The primary claim of the
  program is the **era-over-era delta on identical pairings** (does the
  skills layer convert no-contact stalemates into resolved fights?), not
  a standalone model ranking. Ranking-grade sample sizes remain open to
  anyone under the same lock.
- **Host complexity.** The agent host began as one large class; the
  controllers are being carved into separate files (build plans,
  missions, situation engine, support-power observer). C# unit-test
  coverage of host logic is acknowledged debt; the compensating control
  is the adversarial gate suite that exercises the host through real
  browser matches.

Review asks that already landed before the audits were received:
per-seat spend caps (no shared-pool starvation), metrics from structured
telemetry rather than UI scraping, seeded side-swapped era-locked
pilot, and unfinished-slot retry policy.

## Known limitations (read before citing numbers)

Sample sizes are small until the community plays more games; OpenRouter
routing adds provider-side variance we report but cannot fully control;
one map pool era so far; the learned-series track needs its control
series before any in-context-learning claim; and cap-limited games say
nothing about who would have won. When in doubt, open the replay.
