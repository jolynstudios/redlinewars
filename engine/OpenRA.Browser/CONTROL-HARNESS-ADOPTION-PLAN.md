# Control Harness / War Compiler — adoption plan for wasm-port

**Status (2026-07-18, autonomous night session):** discovered fully-wired + tested in the `acl-autonomous-play` worktree; **the pure `AgentWarCompiler.cs` helper + its 8 NUnit tests are already consumed into `wasm-port`** (this tree). The full wiring below is documented for a go-ahead — it is an architecture-level change that also touches the sidecar provider surface, so it is staged rather than run unattended.

## Why this is the real answer to "why does the AI play dumb"

The acl `CONTROL-HARNESS-PLAN.md` problem statement is nearly verbatim the dumbness diagnosis from earlier this session:

> *"war still depends on rare freeform LLM micro (attackMove, tiny strikes, no reinforce), so play looks AFK/stupid even when the architecture claims 'general + body'."*

The fix is not "give the LLM more info" — it is to change the **shape of what the LLM is asked to output**:

1. **Phase-gated legal actions.** The host publishes `hostTruth.controlPhase` (opening/economy/army/war/emergency) and `legalActionTypes[]`; the sidecar narrows the provider schema to that phase's small union → far fewer schema failures (directly attacks the "dumb no-op / knowing-doing loop" symptom).
2. **`commitIntent` — one decision = a campaign.** The model issues `{intent: strike|hold|defendBase, priority, minForce, squad}`; the **host resolves the target** from fog-safe known structures and **compiles** the intent into assignGroup + staging + `queueMission` + a reinforce loop. A slow model deciding every ~15–35 s no longer needs to micro — it commits intent.
3. **`reinforceIntent {to: activeStrike|base, maxUnits}`** — sustain/garrison without new micro.
4. **Dribble rejection.** Freeform `attackMove`/`move` of combat while a commit is active is rejected ("use commitIntent/reinforceIntent") — kills the thrash.

## The benchmark-integrity line (the crux — keep it exact)

| Host war action | Trigger | `pureGeneralValid` | Adopt? |
|---|---|---|---|
| **War compiler** — `compiledStrike`/`compiledReinforce`/`compiledDefend` | AFTER model `commitIntent` | stays **true** (staff work) | **YES** |
| **Last-resort** — `strikeMain`/`softReinforce`/`softRegroup`/`softDisengage` | host, WITHOUT a model commit, past grace | set **false** | **QUARANTINE** (assisted-only, behind `hostCombatLastResortEnabled`) |

`pureGeneralValid === true` **only** when all four last-resort counters are 0. Compiled counters (`hostCompiledStrikeCount`/`hostCompiledReinforceCount`) do **not** invalidate pure — the model made the strategic decision, the host did the clerical execution. This is the whole reason the war compiler is legitimate on the skill track where my earlier "model authors the exact pincer package" (SAFE-COMBAT-ORCHESTRATION-PLAN §3) was over-asking the model.

## Already consumed into wasm-port (this tree)

- `OpenRA.Browser/AgentMode/AgentWarCompiler.cs` — pure, simulation-free decision helpers: `ResolveControlPhase`, `LegalActionsForPhase`/`IsActionLegalInPhase`, `NormalizeIntent`/`NormalizePriority`/`ToMissionTargetPriority`, `ShouldLaunchCompiledStrike`, `ShouldCompiledReinforce`, `ShouldRejectDribbleCombatMove`, `CapScoutRoster`, `MassingStatus`, `ClampMinForce`, and the `State` struct. Constants: `DefaultMinForce=6`, `DefaultMaxForce=24`, `DefaultScoutCap=4`, `CompiledStrikeCooldownTicks=500`.
- `OpenRA.Test/Browser/AgentWarCompilerTest.cs` — 8 tests (clamp, intent normalize, phase order, war-phase legal actions exclude attackMove, compiled-strike minForce/cooldown, compiled-reinforce while-live, scout cap + massing, dribble rejection, power→economy mapping). Source-linked via `OpenRA.Test.csproj`.

This is behaviour-neutral: the helper is not yet called by the host, so nothing changes at runtime and raw stays byte-identical.

## Remaining wiring (port from acl `acl-autonomous-play`; keep pure/compiled, quarantine last-resort)

acl has this fully wired — use it as the reference port source (do not port its `hostCombatLastResortEnabled` last-resort block):

1. **Contracts** (`AgentModeContracts.cs`): add `commitIntent` + `reinforceIntent` action DTOs; add `ControlPhase` + `LegalActionTypes` + `AgentWarCommitObservation` to hostTruth (gated + `[JsonIgnore(WhenWritingNull)]` so raw stays null); add metrics fields `HostCompiledStrikeCount`/`HostCompiledReinforceCount`/`ModelCommitIntentCount`/`TimeToFirstCommitIntentTicks`/`DribbleAttackMoveCount`. (acl `AgentModeContracts.cs`, symbols verified via `control-harness-gate.mjs`.)
2. **Host** (`AgentModeHost.cs`, ~31 acl call sites): compiler tick (accept `commitIntent` → `AgentWarCompiler.State`; massing gate; target pick from fog-safe known structures; `queueMission` strike; auto-reinforce labeled `source=warCompiler`/`kind=compiledReinforce`; regroup-on-wipe; `defendBase` pull); publish `controlPhase`/`legalActionTypes` in the observation; reject dribble combat moves while a commit is active; wire metrics.
3. **Doctrine executor** (`AgentDoctrineExecutor.cs`, ~13 acl mentions): the pure inject/minForce rules already partly live in `AgentWarCompiler`; reconcile with the existing `NeedsDecisionWake` (the `baseDefenseNeeded` wake from the partial PR-A can suggest `commitIntent defendBase` instead of a separate defend-home package).
4. **Sidecar** (`agent-sidecar/src/contracts.ts` + `contract-manifest.ts` + `instructions.ts` + `provider-schema.ts`): add `commitIntent`/`reinforceIntent` to the guided/executor/arsenal schema union (NOT raw); intersect the provider schema with `legalActionTypes` per phase; primer rewrite ("You are a general. Prefer commitIntent; do not micro units. Empty actions OK while massing."). **Assert raw provider-request bytes unchanged.**
5. **Metrics + gates** (`a2a-metrics.mjs`, `match-runner.mjs`): surface pure vs compiled vs last-resort per seat; adopt `control-harness-gate.mjs` (phases 0–6 static checks) and `generalship-pure-gate.mjs`.
6. **Execution-quality borrows** (optional, Phase 5): port `AttackOrFleeFuzzy` (compiled disengage), `ChooseBuildLocation` refinery annulus (proc placement), and the scout-roster cap (fixes the "22 scouts" pathology).

## Guardrails (unchanged from the safe-combat plan)

- **raw byte-identical**: every new hostTruth field executor-gated + `JsonIgnore(WhenWritingNull)`; new actions only in guided/executor/arsenal schema; pin + assert raw hashes.
- **Pure = compiled only after model commit.** Never a host war action without a model `commitIntent` on the pure track. Last-resort stays behind `hostCombatLastResortEnabled` (assisted demo), which we do **not** enable by default and do **not** port as an autonomous default.
- **Safety reflexes** (critical-defense, return-fire, harvester-flee, retreat) unchanged.
- **`PureGeneralValid` CI guard**: all four last-resort counters 0 on the skill track.

## Relationship to SAFE-COMBAT-ORCHESTRATION-PLAN.md

This **supersedes** that plan's §3 (model-authored pincer package): open-war commitment becomes `commitIntent` → host war compiler, which is both easier for the model and pure-benchmark-valid. That plan's PR-A (enemy-assessment DTO — already landed, same shape acl uses) and PR-D (batch-coerce, `PureGeneralValid` guard) remain compatible and are folded in here. The `baseDefenseNeeded` wake (partial PR-A) is kept but re-pointed to suggest `commitIntent defendBase`.

## Sequencing (recommended)

0. ✅ Consume `AgentWarCompiler.cs` + tests (done, behaviour-neutral).
1. Metrics + docs + gate names (Phase 0) — low risk.
2. `controlPhase`/`legalActionTypes` in observation + sidecar phase-narrowing (Phase 1) — medium (schema churn; assert raw unchanged).
3. `commitIntent` + war-compiler tick (Phase 2) — **core value**, high risk; unit-test minForce hold / target pick / reinforce-while-live first.
4. `reinforceIntent` + defend continuity (Phase 3).
5. Primer/wakes rewrite (Phase 4).
6. Flee/place/scout-cap borrows (Phase 5).
7. Smokes + gates (Phase 6): `pure-control-1` (arsenal+executor, no last-resort → `pureGeneralValid` true), `assisted-control-1` (+ last-resort), `regression-body`.

## Verification

- `make check-browser` (-warnaserror), `make tests` (incl. the 8 `AgentWarCompilerTest` cases), sidecar `npm run check && npm test`.
- `node OpenRA.Browser/tests/control-harness-gate.mjs` (phases 0–6), `generalship-pure-gate.mjs`, existing doctrine + arsenal + safe-acl-continuity gates.
- Raw hash-unchanged assertion after any sidecar/contract change.
- Headed pure smoke on the existing `.env` key, small cap, key never logged.
