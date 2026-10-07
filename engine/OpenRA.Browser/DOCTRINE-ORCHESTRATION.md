# Doctrine Executor — Orchestration Panel

**Orchestrator:** Grok (this session)  
**Subject:** `OpenRA-Web-cp1` / `era3-skills-cp1`  
**Executors:** Claude + Codex (headless write)  
**Backup advisor:** OpenCode (read-only)  
**Status:** PR0 hygiene landed; PR1 doctrine IR + hostTruth.doctrine observation landed; **PR2 standing execution landed** (scout sweep + bounded unit stream + squad maintain behind `doctrineExecutorEnabled`, source=doctrine attribution, cleanup on switch); executor flag default off; baseline still **missing** (headed era3.1 crash, deterministic tests green)  

---

## Baseline status (web)

| Run | Result | Use as baseline? |
|-----|--------|------------------|
| `era3-validation-2` (log-only) | credit stop, no contact | partial smoke / metric plumbing only |
| headed era3.1 validation | **crashed** — `page.evaluate: Target page, context or browser has been closed` (`match-runner.mjs:739`); wrapper exit 0, **no terminal artifact** | **No** — rerun required |

If the headed window was closed by hand, crash is expected. If not, headed runs are currently unreliable and must be re-run for a usable PR0 re-baseline.

Mid-game probe (~tick 8–11k) still matches the plan: `visible enemies = 0`, agent2 decision rejected with **group missing** (below).

---

## Decision panel (LOCKED)

| # | Decision | Locked semantics |
|---|----------|------------------|
| D1 | **Raw vs hygiene** | Hygiene fixes (MCV continuity, idle-mute, metrics plumbing) are **track-agnostic**. “Raw ongewijzigd” means **no doctrine/executor/arsenal behavior** on raw — not that raw observation bytes never change from correctness fixes. PR0 re-baseline is required after hygiene. |
| D2 | **Phase advance** | **`exitWhen` auto-advances** into the next phase. Model `holdPhase` is a **sticky veto until clear or strategy switch** (not a short timeout). `phaseReady` is an informational wake (model may react) but **not required** for advance. Rationale: requiring model ack reintroduces no-contact stalemates when the model no-ops. |
| D3 | **Metric schema** | Frozen **in PR0** (see below). Rate claims use **N ≥ 5 seeds** (not one val-2 anecdote). Single-seed runs are smoke only. |
| D4 | **“Model speelde”** | Model-commanded match if **any** of: (a) ≥1 non-default response to a `needsDecision` wake, (b) ≥1 strategy switch with reason, (c) ≥1 direct override of a doctrine-owned actor/mission. Else label **harness-led**. Report always: `needsDecisionResponseRate`, `needsDecisionLatencyMs`, `doctrineActionRate`, `overrideRate`. Thresholds for ladder claims are fixed before publish, not post-hoc. |
| D5 | **Cash precedence** | Stream/doctrine production **must reserve cash for the active build plan** (IR field `cashReserveForPlan` or host default: do not stream if plan is `waitingCash` / would starve next plan step). Orders precedence ≠ cash precedence. |
| D6 | **MCV continuity** | Prefer **true transform/replacement continuity** (old actor gone, yard appears as successor) over pure near-cell heuristic. Near-cell may assist; transform event is source of truth. |
| D7 | **Pause/resume/re-adopt tests** | Required: `controlDoctrine pause` stops emissions immediately; `resume` restores standing **without duplicate** scout missions; re-adopt same card is **idempotent**. |

### Group-reference sequencing (metered in PR0; fixed in PR2)

> `group 'E1 Scouts' does not exist or has no live actors`

**Cause class: `groupMissing`.** The model issues `move` / `attackMove` / `queueMission` with `groupName` **before** a successful `assignGroup` (or after the host culled all members). Host reject is correct; the thrash is **sequencing**, not fog.

- **PR0:** count under `noopByCause.groupMissing` (+ raw rejectionCauses / same-rejection streak).  
- **PR2:** standing scout squad maintain so the name exists with live actors when doctrine wants scouts.  
- Related knowing-doing: prose **mission mentions** ≫ typed `queueMission` accepts (`missionMentions` vs `missionActionsAccepted` / host mission events).

---

## Metric schema (PR0 deliverable — freeze)

Every finished match metrics/outcome must be able to carry (null-safe if not yet filled):

```json
{
  "metricsVersion": 1,
  "explorePercentFinal": null,
  "timeToFirstScoutTick": null,
  "timeToFirstContactTick": null,
  "missionCommitsModel": 0,
  "missionCommitsHost": 0,
  "missionMentions": 0,
  "missionActionsAccepted": 0,
  "noopByCause": {
    "emptyBatch": 0,
    "allRejected": 0,
    "groupMissing": 0,
    "planOwnsQueues": 0,
    "placeNotReady": 0,
    "timeout": 0,
    "schemaFailure": 0,
    "budget": 0,
    "other": 0
  },
  "rejectionStreakMax": 0,
  "identicalRejectionStreakMax": 0,
  "criticalAssetLostCount": 0,
  "criticalAssetLostAfterDeployCount": 0,
  "productionIdleAffordableWakeCount": 0,
  "doctrineActionRate": null,
  "overrideRate": null,
  "needsDecisionResponseRate": null,
  "needsDecisionLatencyMsP50": null,
  "seed": null,
  "track": null
}
```

**Seed set for rate claims (PR3+):** `tests/era3-seed-set.json` (5 seeds, includes `31415926`). Single-seed = smoke. Crashed headed runs do **not** count toward N.

---

## PR3 scope (landed — needsDecision wake framework)

Benchmark-honest choice: instead of a host auto-strike (`strikeMain`), PR3 makes the host **wake the model** for the consequential offensive decision, so targeting and commitment stay the measured play.

- `AgentDoctrineExecutor` (pure, +3 helpers, +3 NUnit cases → 12 total): `ArmyReadyForOrders` (main body ≥ `ArmyCommitMinUnits`, an enemy structure scouted, nothing committed), `NeedsDecisionWake` (gated on executor/bound/paused → `armyIdle`), `SuggestedOptionsFor` (non-ranked hints, each mapping to a real model order).
- Controller `Observe` populates `hostTruth.doctrine.needsDecision` + `suggestedOptions` from fog-safe facts (`TankCount`, `KnownEnemyStructureCount`, `HasActiveOffensiveMission`). Raw/executor-off never gets a wake.
- Host `BuildDoctrineObservation` feeds the two new facts (`slot.KnownEnemyStructureCount`; any active strike/pincer/airStrike/pursue mission).
- Primer lists `needsDecision` + `suggestedOptions`; the model owns targeting/commitment (queueMission), card switch, and direct override, and is told the host advances phases automatically.
- Gate: `tests/doctrine-pr3-gate.mjs` (wake wired; **asserts the host does NOT auto-launch a doctrine strike**).

**Review fix (own validator):** PR3 first also shipped a `phaseReady` wake, but the review proved it inert — `EvaluateProgress` auto-advances (decision D2) *before* `Observe`, consuming the only phase boundary, and the terminal phase has a `0/0` exit that never satisfies; worse, its options and the primer claimed an "advance/hold the phase" control the model has no order for. Removed `phaseReady` + the overstated guidance so the surface matches behavior (armyIdle is backed by a real `queueMission`). `phaseReady` + a real hold then returned with the `controlDoctrine` action (below).

## controlDoctrine scope (landed — model command surface over the doctrine, plan §8)

- Action `controlDoctrine` with `doctrineCommand` ∈ pause / resume / holdPhase / advancePhase. Arsenal-only (defined as a separate schema object added to `ArsenalActionSchema`, never the base `AgentActionSchema`) so the raw track's provider-visible schemas stay byte-identical.
- `holdPhase` sets a sticky `Held` veto; `EvaluateProgress` suppresses auto-advance while `Held` (decision D2). `advancePhase` clears the hold and takes the boundary (or commits early); a card switch also clears it, so a no-opping model can never wedge on the veto. `pause`/`resume` gate standing emission (existing controller methods).
- Host: `case "controlDoctrine"` + `HasDoctrineFields` field-gate + `ValidateDoctrineActionPurity`; controller: `Hold`/`AdvancePhase` + `Held` state; contracts: `DoctrineCommand` (action) + `PhaseHeld` (observation).
- With a real hold order in hand, the **`phaseReady` wake returns** — it fires only while the model is holding at a satisfied boundary, and its options map to `advancePhase`/`holdPhase`. Primer teaches the action.
- Gate: `tests/doctrine-control-gate.mjs` (dispatch + purity + hold veto + PhaseHeld + **arsenal-only / raw byte-identical** + phaseReady-backed).

**Review (own validator):** verdict correct + benchmark-honest (hold veto can't wedge a no-opping model — the veto is only ever set by the model's own holdPhase and always clears via advancePhase or a card switch; purity airtight; determinism preserved; raw track byte-identical). Fixed two LOW findings: (F1) require `doctrineExecutorEnabled` so the command can't relabel observation phase on the executor-off track; (F3) the gate now fails (not silently passes) if it can't locate the base union to prove exclusion. (F2) the phase-advance off-by-one/terminal logic was extracted to a pure `AgentDoctrineExecutor.NextPhaseName` (shared by auto-advance + advancePhase) and unit-tested; a full behavioural NUnit suite for the controller hold state machine remains a follow-up (the controller isn't source-linked into OpenRA.Test).

**Deferred:** a bounded default `strikeMain` host offensive (with model-override + `waveFailed`), left out on purpose so v1 measures the model's own offensive decisions; the LOW note that `armyIdle` counts tanks not the full main body (fine for this tank card, would miss an infantry-bodied card); PR4 (situation binding); PR5 (era-lock three-track scorecard); the live seeded re-baseline (needs browser stack + API budget).

## PR2 scope (landed — standing execution, flag-gated)

- `AgentDoctrineExecutor` (new): pure, dependency-free decision layer (`StreamQuantity`, `ShouldLaunchScout`, `PhaseHasStanding`, effective stream bounds). Source-linked into `OpenRA.Test`; 9 NUnit cases (stream cash-reserve/concurrency/affordability bounds, scout gates, phase-standing lookup).
- `TickDoctrine` (host): runs only when `doctrineExecutorEnabled`, bound, not paused. Per active phase's `Standing[]`:
  - **maintainSquads** — re-`Assign`s scout squad (scout unit types) + main squad (mobile attack-move non-scouts) each tick, so a named roster always exists with live actors (kills the `groupMissing` thrash for doctrine missions).
  - **scoutSweep** — (re)launches a fog-safe `sweep` via `AgentMissionController` under mission id `doctrine-scout`, bumping version when the previous sweep ends. Inherits existing precedence: a direct model order releases the roster, safety reflexes detach it.
  - **streamUnits** — bounded `startProduction` (planOwned) into a queue the build plan is **not** driving; reserves `CashReserveForPlan` (D5), respects `StreamMaxConcurrent` in-queue, skips while the plan is `waitingCash`.
- **Attribution (benchmark honesty):** every emission → `AgentDoctrineController.RecordAction` → `hostTruth.doctrine.recentActions` (source=doctrine), plus a `doctrine` telemetry kind. Squad maintenance is bookkeeping (no orders) so it is not counted as an action.
- **Cleanup on switch:** `adoptStrategy` to a different card cancels the standing `doctrine-scout` sweep before rebinding.
- **Flag producer:** `doctrineExecutorEnabled` registered in the sidecar + C# config manifests (default false). Launcher UI toggle is a separate live-deploy task; test harness injects the flag via config JSON.
- Primer: executor-on guidance added (host runs standing behaviours; model still owns targeting/phase/switch/override; answer `needsDecision`).
- Gate: `tests/doctrine-pr2-gate.mjs`.

**Adversarial review (own validator; Codex bridge was session-blocked):** found + fixed two HIGH integration bugs the pure tests/gate could not see — (1) the unit stream re-issued every tick across the order-latency window (`AllQueued()` lags), overshooting `StreamMaxConcurrent` and transiently the cash reserve → added a per-unit `StreamNextTick` cooldown (`DoctrineStreamCooldownTicks`); (2) host stream production tripped `ValidateNoUnmanagedQueuedProduction`, blocking the model from authoring its own build plan → the check now tolerates doctrine `StreamUnits`, and `FindDoctrineStreamQueue` excludes the plan's bound producer for any step state. Plus two LOW fixes (ordinal queue tie-break; clear `RecentActions`/`StreamNextTick` on a card→card switch while keeping `ScoutMissionVersion` monotonic). Gate `doctrine-pr2-gate.mjs` now locks the cooldown + tolerance against regression.

**Not in PR2:** offensive templates + `needsDecision` wakes (PR3), situation binding (PR4), live seeded re-baseline (needs browser stack + API budget).

**Incidental fix:** the committed branch did not pass the Browser Debug `-warnaserror` build — 5 latent analyzer errors from PR0/PR1 (2×CA1851 double-enumeration in `IsCriticalAssetContinuity`, 2×IDE0005 unused usings in the doctrine controller, 1×SA1514 doc-comment blank line) that Release builds strip. Fixed as part of PR2 so `make check` on the Browser project is green.

## PR1 scope (landed — observation only)

- `AgentDoctrineProgram`: machine IR for `soviet-tank-pressure` (phases, cash reserve, squad names, stream/scout types).
- `AgentDoctrineController`: Bind on `adoptStrategy`, Observe progress, optional auto-advance **only** if `DoctrineExecutorEnabled`.
- `hostTruth.doctrine` on every observation when arsenal enabled.
- Match config: `DoctrineExecutorEnabled` (default **false**).
- Arsenal primer only: how to read doctrine; empty actions ≠ pass-through until executor on.
- Gate: `tests/doctrine-pr1-gate.mjs`.

**Not in PR1:** standing scout/stream/missions (PR2+).

---

## PR0 scope (done)

Files of interest: `AgentMode/AgentModeHost.cs` (~1941–2035, AutoPause path), metrics pipeline (`tests/a2a-metrics*.mjs`, outcome stash), optional small host unit tests.

### Must ship

1. **MCV→yard:** no false `criticalAssetLost`; no build-plan auto-pause on MCV deploy transform. Prefer transform continuity.  
2. **Idle mute:** do not raise / do not wake fast-path on `productionIdleAffordable` while build plan is active (and owns production).  
3. **Metrics:** schema above wired as far as existing telemetry allows; document gaps.  
4. **Baseline note:** how to re-run val-2 seed smoke (script path); no paid full ladder required in PR0 if key unavailable — still unit/host tests.  
5. **Tests:** MCV continuity; idle not raised under active plan; pause/resume/re-adopt only if controlDoctrine already exists — else mark deferred to PR1 with TODO.  

### Out of scope for PR0

Doctrine IR, executor, missions, scouting auto, phase advance, strategy cards.

---

## Track honesty reminder

| Track | Arsenal | Executor | Hygiene (PR0) |
|-------|---------|----------|---------------|
| raw | off | off | **on** (correctness) |
| assisted-arsenal | on | off | on |
| assisted-arsenal+executor | on | on | on |

---

## Work split

| Agent | Role |
|-------|------|
| **Claude** | Implement MCV continuity + productionIdle mute + host tests |
| **Codex** | Metric schema wiring + outcome fields + rejection/noop cause counters + seed list doc |
| **OpenCode** | Read-only review of PR0 diff after implementation |
| **Grok** | Orchestrate, resolve conflicts, integrate, report |

---

## Acceptance (PR0)

- [x] Deploy MCV does not emit criticalAssetLost / does not auto-pause plan  
      (`IsCriticalAssetContinuity` deployable→construction within radius 3)  
- [x] Active build plan: productionIdleAffordable muted (edge preserved for post-plan)  
- [x] Metric schema present (`metricsVersion: 1` in a2a-metrics.mjs + seed set)  
- [ ] Live a2a-gate re-run when browser stack available  
- [x] No doctrine executor code  
- [ ] Commit(s) on `era3-skills-cp1` with clear messages  

### Re-baseline smoke

```sh
# From OpenRA.Browser/tests with sidecar + browser harness as usual:
# node match-runner.mjs ... --seed 31415926 --arsenal ...
node a2a-metrics.mjs match-results/<label> --print
# Compare criticalAssetLostCount / productionIdleAffordableWakeCount / noopByCause
# vs pre-PR0 era3-validation-2 metrics.
```

Rate claims: use all 5 seeds in `era3-seed-set.json`.
