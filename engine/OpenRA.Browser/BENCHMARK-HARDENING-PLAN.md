# Benchmark Hardening — Play-Skill Measurement Spec (v1 draft, 2026-07-19)

Derived from a Claude↔Codex convergence pass after a live Kimi-K3 / Grok-4.5 / Gemini-Flash session exposed the validity gaps. Status: **design consensus reached; spec to be versioned + frozen before leaderboard use.**

## Problem
The harness is **rigor-strong** (era-lock hash-pins every prompt-shaping source, `--seed`, `pureGeneralValid` honesty invariant, determinism/OOS checks, raw-byte pins, per-seat telemetry) but **validity-incomplete** as a *skill* benchmark. Confounds observed:
1. Timeout misclassification biased slow reasoners (Kimi lost 11/16 turns to a ~10s deadline, not to bad play). **Fixed; committing.**
2. Latency confounds skill — we had to force `--effort low` to let Kimi compete, which *changes what is measured*.
3. Dollar caps ($1.25/seat) left frontier matches unresolved (`winner=undetected`); only cheap Gemini Flash reached a base-kill.
4. Single-game high variance (the mirror was decided by a slight edge).

## Two tracks — never blended
1. **Skill track (lockstep)** — latency-invariant measure of strategic quality. **PRIMARY** leaderboard.
2. **Real-time track** — latency, reliability, cost. Separate leaderboard (the existing real-time profile).

## Skill track: host-authoritative GLOBAL-BARRIER lockstep
- **Union trigger**: when EITHER seat reaches a scheduled/alert decision point, freeze the world (`World.Paused = true`; `World.Tick` ticks actors only when unpaused — confirmed, so the freeze is lossless).
- **Atomic dual snapshot**: capture BOTH seats' fog-safe observations at the SAME `WorldTick`.
- **Concurrent calls** under ONE generous published deadline.
- **Equal opportunities**: the non-triggering seat gets a paired no-op-capable opportunity → equal decision counts.
- **Same-frame application**: validate/fallback, enqueue both batches on the SAME deterministic order frame (no seat-order advantage), then resume.
- Prematch planning = **barrier zero**.
- A timeout past the generous deadline is a **reliability** failure (recorded on the real-time track); ordinary response latency has **zero** score effect.
- Model config (prompt, output limit, provider route, declared effort) **pinned + reported**; **never** force `--effort low` in the skill track.
- **Stop condition**: fixed tick/decision horizon, **NOT dollars**. Spend is reported as an efficiency metric.
- **Primary engineering risk = barrier correctness**: no duplicate alert claims while paused; atomic both-seat snapshot; deterministic same-frame batch application; paired seat-swaps stay even after same-frame submission.

Note (Codex refinement): lockstep guarantees **equal opportunity count + same-tick observations within each barrier** — NOT "identical game-states across models" (divergent actions necessarily diverge future states). Paired seeds/swaps control the remaining path + seat variance.

## Resolution & adjudication
- **Terminal win/loss ALWAYS overrides** → ±1.
- **Capped/unresolved** → signed symmetric composite `S ∈ [-1,1]` from normalized margins `m = (A−B) / max(A+B, floor)`, clipped:

| Weight | Component |
|---|---|
| 25% | Live HP-adjusted combat power |
| 20% | Net replacement value of critical/production/tech **structures destroyed** |
| 20% | Productive economy (time-avg income + refinery/producer capacity; raw cash discounted + capped) |
| 15% | Net combat-unit **replacement value destroyed** |
| 10% | Tech capability |
| 10% | Time-avg **resource-region / chokepoint control** |

- **Draw band**: `|S| < 0.10` → **DRAW**, never a coin-flip winner.
- **Anti-gaming** (Codex): reward IRREVERSIBLE net replacement-value losses + remaining capability, NOT raw cumulative damage (gameable via repair/heal/HP-farming/inefficient trades). Structures count by VALUE of strategically-meaningful buildings, not raw count. Map control = sustained resource-region/chokepoint occupancy (AUC), NOT vision/explored-% (scout-spam gameable).

## Ranking: paired series only
- Never rank from one game. Run **paired seeds** with **seat/spawn/faction swaps**: same seed/map/factions played twice with seats+spawns swapped; **≥3 pairs** per matchup.
- Aggregate terminal results + adjudication margins across the series; report **mean score + confidence interval**.
- **Round-robin → Elo** across the model pool, with a fixed **anchor opponent** (built-in AI at a set difficulty) for absolute calibration + cross-era regression detection.

## New deterministic telemetry required
Replacement-value loss ledgers (structures + units, by value); HP-adjusted live combat power; income AUC; tech-capability index; resource-region occupancy AUC. (Existing: decisions, fallbacks, commitIntent, compiled strikes/reinforce, oos, spend.)

## Implementation phases
0. ✅ Commit the timeout fix (validity). *(in flight this session)*
1. **Write + VERSION this spec** (weights, floors, draw-band, region defs) — freeze before leaderboard use.
2. Implement the barrier behind a new `--benchmark-lockstep` profile (world freeze, atomic dual-snapshot, concurrent calls, same-frame apply). Add pause/resume + barrier-correctness gates.
3. Implement adjudication telemetry (6 ledgers) + the scoring function. Add deterministic **golden-score** gates on replay scenarios.
4. **Calibrate** floors/draw-band/region defs on golden replays — blind to model identity — then FREEZE weights.
5. Sweep runner: paired seeds × swaps × ≥3 pairs → aggregate → Elo vs anchor + the reporting layer.

## Guardrails
- Calibrate thresholds BEFORE seeing model identities; never change weights after seeing results.
- Skill and real-time tracks never blended.
- `era-lock` + a NEW frozen `benchmark-spec-version` pin everything for comparability.

## Phase-2 lock (barrier implementation) — Claude↔Codex, after a full trace of Program.Frame / GameStepper / World.Tick / OrderManager
- Benchmark host progression moves onto the **per-logic-tick path** (compose `stepper.LogicTickCompleted` → new `AgentModeHost.TickAfterLogic`; dedupe controller work by `WorldTick`, barrier phase transitions by `NetFrame`) — NOT a pause wrapped around the once-per-RAF poll (that leaks model latency into game state). The RAF path stays for real-time mode.
- **Pause = normal synced order** (`World.SetPauseState`, latch PausePending, wait for authoritative `World.Paused`). No `SetLocalPauseState`; no `World.cs`/`Game.cs`/`GameStepper.cs`/`OrderManager.cs` patches. Fence ALL controllers (build-plan/doctrine/missions/reflexes/due-polling/fallback/manual submit) while the barrier owns pause; cache frozen `WorldTick`+`SyncHash`, censor the run on synced drift.
- **Atomic dual snapshot**: one claim per barrier, both cadences advanced once, paired decision IDs, observations built from the frozen world, cached serialized snapshots (no re-query).
- **One combined JS→C# commit**: await both outcomes/deadline → prevalidate outer envelopes + barrierId → stable slot-ordinal seat order → apply both batches to the same `OrderManager` localOrders buffer → append `UnPause` LAST; reject stale/dup/late by barrierId; a fatal exception after partial controller mutation censors/aborts the run (no full rollback in P2).
- **State machine** Idle→PausePending→Frozen/Collecting→CommitReady→ResumePending→Idle with a barrierId ownership token (unpause only if this barrier paused; reject start if the world is already manually paused; terminal-while-frozen captures the outcome without an extra actor tick).
- Bypass adaptive cadence / near-miss retry / quiet-turn skip / alert fast-path / effort mutation — exactly one pinned-config opportunity per seat per barrier. Barrier zero = prematch (same barrier/spec identity + deterministic close); live play starts at paired decision 1. Reject `opponentBot` in P2.
- "Same frame" removes tick advantage, not every within-frame priority effect (`ProcessOrders` is sequential); rely on a frozen stable seat order + the required paired seat/spawn swaps to cancel residual ordering variance. Record `appliedNetFrame` + an order/commit digest for audit.

### OUTCOME POLICY (frozen)
A missing / timed-out / invalid seat contributes a **DETERMINISTIC NO-OP** (empty actions) on the skill track — **never advisor fallback**, which injects host competence and contaminates the skill measure. A fallback variant, if ever added, is a separately-versioned track computed from the **cached barrier snapshot**, never a fresh `SubmitFallback` `BuildObservation`.

### Phase boundary
Phase 2 emits ONLY barrier-correctness telemetry (ids, trigger/frozen/applied ticks + net frames, statuses, durations, digest) + a **golden barrier-trace** (not a score golden). The six adjudication ledgers + golden-score belong to Phase 3.

### Phase-2 surface (files / gates)
Code: new `AgentLockstepBarrier.cs` (state machine + pure transitions); `AgentModeContracts.cs` (config/spec + barrier DTOs); `AgentModeHost.cs` (per-logic-tick union detect, pause ownership, atomic claim/snapshot, controller fencing, combined commit, abort/resume, horizon; reject legacy due/submit/fallback while lockstep active; defer `SubmitBatch` issuing to the combined commit); `Program.cs` (compose `LogicTickCompleted`); `Program.AgentMode.cs` (`Get/Commit/AbortAgentLockstepBarrier` exports); `openra-agent-mode.js` + `agent-worker.js` (lockstep controller, barrierId correlation, one commit, no adaptive/retry/fast-path, always abort/unpause on teardown); `match-runner.mjs` (`--benchmark-lockstep`, tick/decision horizon, spec+config reporting, incompatible-flag checks). Byte-pin new manifest fields + `benchmark-spec-version`. No engine-file changes.
Gates: `AgentLockstepBarrierTest.cs`; `benchmark-lockstep-gate.mjs` (fast-vs-delayed, reversed); `benchmark-lockstep-determinism-gate.mjs` (inverted latency → identical trace, oos=false); cp3 barrier-zero extension; skills-gate manifest/spec-pin/lockstep-only-API; match-runner dry-run assertions; crash/stop cases (timeout, worker-fatal, page-stop, terminal-while-frozen each resolve once and leave the world unpaused).
