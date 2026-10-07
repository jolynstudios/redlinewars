# Safe Combat Orchestration — Model-Chosen Tactical Wings (v1)

Adoption & implementation plan for the `wasm-port` tree.

**Provenance.** Derived from a 4-agent investigation (2 on the agent "dumbness" diagnosis of `wasm-port`; 2 read-only on the `acl-autonomous-play` worktree), plus direct reads. All `file:line` refs are labelled **(cur)** = this `wasm-port` tree or **(acl)** = the `OpenRA-Web-acl` worktree. acl refs in the quarantine list mark code we deliberately do NOT port.

---

## The one-paragraph shape

`wasm-port` (CURRENT) and `acl-autonomous-play` (ACL) are two divergent descendants of the doctrine-executor work. CURRENT built the **safe model-choice scaffolding** (`AgentDoctrineDecisionController.cs`, `AgentDamageObserver.cs`, `AgentCombatRoster.cs`, and the `rejection-repair-gate` / `safe-acl-continuity-gate` tests — none of which exist in ACL). ACL built the **autonomous continuity layer** (host plays consequential combat) behind a single boolean `hostCombatLastResortEnabled` (default false = "pure generalship"). **This plan ports ACL's fact-predicate + opportunity-surfacing layer onto CURRENT's safe scaffolding, and quarantines every autonomous-combat pathway.** It is effectively PR4/PR5 on top of CURRENT's uncommitted PR2 (standing scout/stream/squad) + PR3 (needsDecision wakes).

---

## 0. Guardrails (non-negotiable; every task honors these)

- **raw stays byte-identical.** No doctrine/host-combat and no new provider-visible action or prompt bytes on the raw track or ordinary-Arsenal mode. Pincer / reinforce / regroup / defense options appear ONLY in guided/executor prompts and commit-schemas. Assert via raw schema/prompt/request hashes.
- **Executor detects, never commits consequential combat.** It may surface EXACT model choices and revalidate them; it never auto-runs a strike / pincer / reinforcement / regroup / ordinary-defense.
- **play keeps ONLY the existing single-squad strike-fallback** after 2 misses + 375 ticks (`AgentDoctrineDecisionController.ShouldFallback` (cur:123-129), `FallbackMinimumMisses=2`, `FallbackMinimumTicks=375` (cur:28-29)). Never an automatic pincer/reinforce/regroup/defense.
- **Safety reflexes stay** (model-enabled standing policies, bounded, reactive): critical-defense, return-fire, harvester-flee, retreat-below-HP. Keep `AgentReflexController` (acl:232-273,388-438,191-230) behaviors AS-IS.
- **No new public action type, no new CLI flag.** Only `baseDefenseNeeded` is added to assisted `pendingDecision.kind`; `reinforceAttack`/`regroupNeeded` remain additive.
- **Benchmark-era integrity.** No silent change to an old benchmark era; gate/exclude raw-affecting fast-path changes.
- **Direct model orders always win** over any doctrine/host path (`AgentCombatRoster.IsEligible` deliberately not applied to direct orders (cur:23)).

**CI guard for the whole subset:** adopt ACL's `PureGeneralValid` invariant — `HostStrikeMainCount == HostSoftReinforceCount == HostSoftRegroupCount == HostSoftDisengageCount == 0` (acl `AgentModeHost.cs:533-534`). In the safe subset those counters must never leave zero, because the code paths that increment them are never ported. A gate asserting this is the cheapest proof the host never fought.

---

## 1. Foundation already in the wasm-port tree (build on this)

| File (cur) | Role | v1 use |
|---|---|---|
| `AgentMode/AgentDoctrineDecisionController.cs` | Simulation-free decision lifecycle: `Decision{DecisionId,Kind,miss,expiry,rearm,cooldown}`, `Issue/RecordMiss/Resolve/ShouldFallback`, `Select{Reinforce,Regroup}Candidates` (deterministic actor-ID `.Order()`, near/far-home via `HomeRadiusSquared`), `ShouldOffer{Reinforce,Regroup}`, `ExactAttackMoveOption`, `DiscardStaleRejectionRepair`. Lifetime 1500, rearm 100, resolution/fallback 375, fallback ≥2 misses. | Add `baseDefenseNeeded` + pincer package construction here; reuse the exact lifecycle/miss/fallback semantics unchanged. **CURRENT already has the reinforce/regroup OFFER gates** — only the fact/context inputs and a `SuggestedCommit` draft need adding. |
| `AgentMode/AgentCombatRoster.cs` | Host-combat admission gate: mobile (Mobile/Aircraft) + live AttackBase; excludes Building/Harvester/Refinery/BaseBuilding. | This IS the `CommitUnitType`/main-body eligibility predicate. Wing-split and base-defense selection both filter through it. |
| `AgentMode/AgentDamageObserver.cs` | `INotifyDamage` → `AgentModeHost.NotifyDamage(self, attacker)`. **CURRENT-only; not in ACL.** | KEEP as the ONLY sensor for the `baseDefenseNeeded` model choice; never let it drive an automatic order. |
| `tests/rejection-repair-gate.mjs`, `tests/safe-acl-continuity-gate.mjs` (cur, untracked) | CURRENT is already assembling the safe-adoption harness. | Extend these gates for pincer/base-defense rather than starting new ones. |

---

## 2. acl adoption map (include / gate / quarantine)

| acl change (file:line) | What it does | Decision | Reason |
|---|---|---|---|
| **Opportunity surfacing** — `NeedsDecisionWake` (acl `AgentDoctrineExecutor.cs:233-270`), `SuggestedOptionsFor` (acl:346-419), `AgentSuggestedCommitObservation` + `BuildSuggested*Commit` (acl `AgentModeContracts.cs:509-520`, `AgentModeHost.cs:4200-4370`) | Priority-ordered wake string → 3 plain-text options → one editable legal mission draft. Pure observation, issues no orders. | **ADOPT-AS-IS** | This is the core mechanism; "suggest not command". |
| **Fog-safe context DTOs** — `AgentEnemyAssessmentObservation` (acl `AgentModeContracts.cs:444`), `AgentTacticalContactObservation` (acl:522-532) | Enemy-strength estimate + tactical-contact context on the observation. | **ADOPT-AS-IS** | `AgentEnemyAssessmentObservation` = diagnosis **FIX-2** (enemy estimate) — free win; the model is otherwise blind on the enemy. |
| **Fact predicates** — `ShouldReinforceAttack`/`ShouldRegroup` (acl `AgentDoctrineExecutor.cs:275-292`), `IsOutnumbered`/`ShouldDisengage` (acl:320-338, as a WAKE only), `IsStrengthMismatch`, `ArmyReadyForOrders` (acl:182-187); 12-cell home radius (acl `AgentModeHost.cs:4042-4052`), 750-tick recent-offensive window (acl:4054-4055) | Pure boolean facts feeding wakes. | **ADOPT** | Feed CURRENT's existing wakes + a new `SuggestedCommit`. Drop the 375/250 grace + soft executors that consume them. |
| **Model `pincer` mission** — 2-3 legs, distinct pre-existing squads, `viaX/viaY`, stage-independent-then-advance-together (acl `AgentMissionController.cs:345-392,1178-1207`), perpendicular repath (acl:1905) | Executes a model-committed pincer. | **ADOPT-BUT-GATE** | Already model-driven; keep. Wing-BUILDING is net-new (§3). |
| **Scout-storm fix** — `ShouldLaunchScout` 750-tick relaunch cooldown + explored cutoff (acl `AgentDoctrineExecutor.cs:104-121`, `DefaultScoutRelaunchCooldownTicks:45`) | Stops relaunch/complete thrash. | **ADOPT-AS-IS** | Recon, not consequential combat. Spec §3 scout-continuity. |
| **Economy** — all-in rush spend `IsAllInPush`/`StreamQuantity(allowUnitStream)` (acl `AgentDoctrineExecutor.cs:130-161`); force-refinery `ShouldPrioritizeBaseEconomy` + `buildBase` wake + `EnsureProc` (acl:167-175, `AgentModeHost.cs:2360-2455`) | Spending-permission gate + auto-refinery. | **ADOPT** (spend gate AS-IS; `EnsureProc` **GATE** — it auto-places a building) | Safe economy; but keep host auto-placement optional to honor "executor never auto-places if we forbid it". |
| **`batch-coerce.ts`** — `coercePartialBatch` (acl, new file) | Unwraps nested batch, fills missing thoughts (`"no-op (schema salvage)"`), ensures `actions[]`, trims memo/thoughts. Zod still authoritative. | **ADOPT-AS-IS** | Salvages a decision instead of burning it → fewer dumb no-op turns; complements FIX-3. |
| **`RecentActions` attribution** — `source=doctrine` (acl `AgentModeContracts.cs:503-506`) | Labels every host emission. | **ADOPT-AS-IS** | Proves the safe subset never fought; feeds telemetry + `PureGeneralValid`. |
| **Production as LLM calls** — `AgentProductionStrategy.cs` (acl, +151), `techGate`/`strengthMismatch` wakes + `setProductionStrategy` (acl `AgentDoctrineController.cs`, `instructions.ts +34`, `contracts.ts +21`) | Moves tank/air production choice to the model. | **GATE** | Verify it changes NO raw/ordinary-Arsenal bytes before adopting. Assisted-only. |
| **Pure-generalship default** (acl commit `a1b1757b5d`) | Makes the pure track the default skill track. | **GATE** | Behavioral default change; adopt as an explicit config, not a silent default flip. |
| **Build-plan auto-place + stop thrash** (acl `AgentBuildPlanController.cs +76`, commit `d765263a70`) | Host auto-places completed buildings; de-thrashes the plan. | **ADOPT-BUT-GATE** | Directly attacks the documented "15× premature proc placement" loop, but it IS host auto-placement — keep behind the executor profile, never on raw. |
| **Fast-path output cap** — `maxOutputTokens: executor ? Math.max(x, 8192) : x` (acl `openra-agent-mode.js:125`) | Raises output budget only when executor on. | **ADOPT-AS-IS** | Executor-gated → raw bytes unaffected. |
| **`AddStructureDefenseIntents` auto-pull** (acl `AgentReflexController.cs:275-386`, gated at `AgentModeHost.cs:1728`) | Auto-pulls ≤6 combat to a threatened structure — **on the pure track**, can override scout leases. | **QUARANTINE** | Moves combat with no model choice. Replace with model-choice `baseDefenseNeeded` (§4). This is where we are STRICTER than acl's own "pure" track. |
| **Soft-combat layer** — `hostCombatLastResortEnabled` flag + `LaunchDoctrineStrike`/`MaybeSoftReinforceAttack`/`MaybeSoftRegroup`/`MaybeSoftDisengage` | Host commits/moves combat autonomously. | **QUARANTINE** | See §6 master list. |

> Not present in ACL at all (so: net-new engineering, nothing to port): `MainMissionOptions` per strategy, `CommitUnitType`, host-side wing-splitter, temporary groups (`p3-a/-b`), atomic `assignGroup+queueMission` packaging, route-offset/snap staging geometry, `baseDefenseNeeded` wake, `Play`-autopilot, counterattack-state, line/wedge/column formations. (The last three are spec exclusions; they don't exist anywhere and stay out of v1.)

---

## 3. Workstream A — Groups, strikes & pincers (spec §1)

acl gives us the pincer *executor* and the `SuggestedCommit` surface; the wing-BUILDING is net-new. Build it as **host-side deterministic helpers that emit an exact `SuggestedCommit` (two `assignGroup` + one `queueMission pincer`) the model adopts** — never as auto-execution.

- **A1. Real `MainMissionOptions` per strategy** (net-new). Remove generic hardcoded strike/raid; each doctrine consumes its own set:
  - soviet-tank-pressure: strike production, pincer economy, scout, defer
  - soviet-grenadier-rush: pincer production, raid economy, scout, defer
  - allied-fast-boom: strike production, raid economy, scout, defer
  - allied-e3-mass: pincer production, strike production, scout, defer
- **A2. Commit-readiness.** Count only `CommitUnitType` when the strategy defines it; else the full valid main roster via `AgentCombatRoster`. (Base on acl `ArmyReadyForOrders`.)
- **A3. Pincer offer gate.** Offer ONLY when ≥6 free main-body units, splittable into two wings of ≥3.
- **A4. Deterministic wing split.** Sort by actor-ID; alternate assign left/right. Temporary groups named `p{decisionId}-a`/`-b`; drop when the mission ends.
- **A5. Atomic package.** One exact package = two `assignGroup` + one existing `queueMission pincer`. Preflight the WHOLE package against temporary group-state; on any error persist nothing. (acl requires squads to pre-exist — `groupName = Legs[0].Squad` acl `AgentModeHost.cs:5306`; our helper builds them atomically instead.)
- **A6. Staging geometry.** Two routes home→target: 10 cells before target, 8 cells left/right of the attack axis; snap within 6 cells to distinct, valid, reachable staging cells. If not safely possible → OMIT the pincer option. (acl only validates `Map.Contains` acl:5301; reachability/offset is net-new.)
- **A7. Visibility & staleness.** At most two tactical options + defer visible. A stale selection is rejected with the SAME decisionId + refreshed rosters/routes (reuse `Issue` same-kind refresh, cur `AgentDoctrineDecisionController.cs:67-73`).
- **A8. play-fallback constraint.** Fallback picks only a single-squad strike/raid — never a pincer.

Code: `AgentDoctrineDecisionController.cs` (package construction), `AgentMissionController.cs` (pincer exec, already present), `AgentDoctrineController.cs` (MainMissionOptions), `AgentModeContracts.cs` (option DTO).

---

## 4. Workstream B — Backup, regroup & defense (spec §2)

- **B1. Keep reinforceAttack** — active non-paused ground offensive w/ target; no active reinforce mission; 2–6 free main-body reserves within 12 cells of home. CURRENT `ShouldOfferReinforce` + `SelectReinforceCandidates` already exist; feed them acl's `ShouldReinforceAttack` fact + 12-cell radius; add a `SuggestedCommit` draft.
- **B2. Keep regroupNeeded** — no active offensive; ended ≤750 ticks ago; ≥2 registered idle survivors >12 cells from home. CURRENT `ShouldOfferRegroup` + `SelectRegroupCandidates` present; feed acl's `ShouldRegroup` + recent-end window.
- **B3. `reinforcementNeeded`** enriches reason/urgency only; eligibility unchanged.
- **B4. NEW assisted-only `baseDefenseNeeded`** (net-new):
  - Trigger: `enemyNearBase`, OR an ordinary attacked structure with a visible attacker within 20 cells — sensor = `AgentDamageObserver` (cur).
  - Select 1–6 owned/live/idle/target-capable defenders, outside missions/model-leases/active reflex interventions, deterministic by actor-ID (reuse `AgentCombatRoster` + `Candidate` filter).
  - `defend-home` attack-moves ONLY the offered IDs to the current threat cell.
  - `defer` → existing 375-tick cooldown.
  - No suitable defenders → emit `defenseEmpty` telemetry only; zero orders.
- **B5. Priority** (existing rejectionRepair first): `rejectionRepair → baseDefenseNeeded → reinforceAttack → regroupNeeded → enemyContact → scoutFailed → armyIdle → phaseReady`.
- **B6. enemyContact** actionable only with commit-size + a known structure target; sticky mobile contact prevents repeat wakes.
- **B7. QUARANTINE the acl auto ordinary-defense backstop** (`AddStructureDefenseIntents`, acl `AgentReflexController.cs:275-386`). Keep `AgentDamageObserver` as sensor only.
- **B8. Retreat** stays the existing mission loss-threshold + standing HP policy. Counter-attack = a normal next strike/pincer choice, not a separate automatic flow.

Code: `AgentDoctrineDecisionController.cs`, `AgentDoctrineExecutor.cs` (detection + priority), `AgentDamageObserver.cs` (sensor), `AgentReflexController.cs` (keep safety reflexes; ensure no auto ordinary-defense).

---

## 5. Workstream C — Contracts, visibility & stability (spec §3)

- **C1.** Only `baseDefenseNeeded` added to assisted `pendingDecision.kind`; options named ONLY in guided/executor/commit surfaces; raw + ordinary-Arsenal bytes unchanged (assert via hashes).
- **C2.** Structured, deduplicated squad-roster logging: name, actor-IDs, live count, source (build on acl `RecentActions`). Throttled browser summary of main/scout/wings — NOT counted as a host action or strike.
- **C3.** Restore executor material-signature with real fields (`buildPlan.state`, `producerId`, `queueType`, `items`) + include group actor-IDs and pending decision-ID so new wings/reserves trigger a model turn.
- **C4.** Keep the stale rejection-repair fix (cur `DiscardStaleRejectionRepair`); make group+mission exact packages transactional (A5).
- **C5.** Scout continuity: do NOT reset `ScoutMissionVersion` on same-match strategy switch; filter previously-unreachable sectors out of the contact patrol too.
- **C6.** Fix the era-lock validator to read the existing files-map; pin the full raw provider-request bytes.
- **C7.** Gate/exclude raw-affecting fast-path changes (the "1024→4096" output cap + actor-coordinate correction). The executor-gated `Math.max(x,8192)` is raw-safe and may stay; any UNGATED cap/coordinate change must be excluded from this patch or its raw-byte impact proven nil.

---

## 6. QUARANTINE master list (safety — do NOT port; acl refs)

1. `hostCombatLastResortEnabled` flag end-to-end: `AgentModeHost.cs:191`; config `AgentModeContracts.cs:133,165,186`; JS `openra-agent-mode.js:642-653,1319,1419`, `agent-worker.js:197,340`; checkbox `index.html:238`; gate `AgentDoctrineExecutor.cs:441-444`.
2. The `if (hostCombatLastResortEnabled){…}` block — `AgentModeHost.cs:2101-2110`.
3. `LaunchDoctrineStrike` + `ShouldHostStrikeMain` (strikeMain) — `AgentModeHost.cs:2560-2635`, `AgentDoctrineExecutor.cs:452-476`.
4. `MaybeSoftReinforceAttack` — `AgentModeHost.cs:2113-2179`.
5. `MaybeSoftRegroup` — `AgentModeHost.cs:2181-2248`.
6. `MaybeSoftDisengage` + `ShouldSoftDisengage` executor half — `AgentModeHost.cs:2254-2335`, `AgentDoctrineExecutor.cs:330-338`.
7. `AddStructureDefenseIntents` auto-pull — `AgentReflexController.cs:275-386` (gated `AgentModeHost.cs:1728`) → replace with `baseDefenseNeeded`.
8. Soft-combat constants `AgentDoctrineExecutor.cs:47-54` + counters `Host{StrikeMain,SoftReinforce,SoftRegroup,SoftDisengage}Count` `AgentModeHost.cs:94-97`.

**Keep the fact predicates these call** (`ShouldReinforceAttack`, `ShouldRegroup`, `IsOutnumbered`, `ShouldDisengage` as a wake-trigger, `IsStrengthMismatch`, `ArmyReadyForOrders`) — pure, feed only the model-facing surface.

---

## 7. Complementary information layer (dumbness diagnosis) — fold in cheaply

The separate "plays dumb" diagnosis found the LLM decides only ~2–10×/game-minute from a memoryless single-frame snapshot. Two of the three fixes arrive nearly free with this adoption:

- **FIX-2 enemy estimate — PROMOTE TO v1.** `AgentEnemyAssessmentObservation` already exists in acl (§2); adopting it lets the model pick strike/pincer/defer with real enemy context.
- **FIX-3 repeated-rejection resilience — PARTLY PRESENT.** CURRENT's `DiscardStaleRejectionRepair` + `batch-coerce.ts` salvage attack the knowing-doing loop; verify coverage, extend if needed.
- **FIX-1 per-decision delta/outcome block — FAST-FOLLOW (verify first).** "since last decision: lost/killed/cash Δ/damage/mission result." Not confirmed present in either tree (the info-side agent crashed before finishing). Highest single ROI for strategic play; schedule as PR-E if a quick check shows it absent.

---

## 8. Sequencing (PR breakdown)

- **PR-A — contracts + scaffold:** `baseDefenseNeeded` kind, option/context DTOs (incl. `AgentEnemyAssessmentObservation`), priority order, material-signature restore (C1,C3,B5; FIX-2). Pure NUnit; no behavior yet.
- **PR-B — defense + continuity:** baseDefenseNeeded detection/selection, reinforce/regroup fact-predicate wiring + `SuggestedCommit`, scout-storm fix, quarantine auto ordinary-defense (B1–B8, §2 continuity rows). NUnit + browser gate.
- **PR-C — pincer / wings:** MainMissionOptions per strategy, wing-split, staging geometry, atomic package, play-fallback constraint (A1–A8). NUnit (geometry/determinism) + browser gate.
- **PR-D — stability + salvage:** squad telemetry, scout continuity, era-lock validator, transactional packages, `batch-coerce.ts`, raw-byte pins, fast-path gating, `PureGeneralValid` CI guard (C2,C4–C7, §0 guard). Compatibility gates.
- **PR-E — info layer (optional):** FIX-1 delta block; GATE-decision on production-as-LLM + build-plan auto-place + pure-generalship default (§2 GATE rows) once raw-byte impact is proven nil.

Each PR ends green on: warnings-as-errors Browser build; relevant NUnit + sidecar suites; contract/doctrine/arsenal/skills gates; raw hash-unchanged assertions.

---

## 9. Test plan (from spec — mapped to PRs)

**Pure NUnit:** mission-option filtering + order per strategy (A1); CommitUnitType readiness (A2); deterministic wing splits, ≥3/wing, temp-group cleanup (A3,A4); distinct reachable pincer staging + omission on impossible geometry (A6); base-defense min/cap/radius/missions/leases/targeting/actor-ID order (B4); reinforce/regroup bounds, 750-tick expiry, stale refresh (B1,B2); atomic assignGroup+queueMission failure (A5); scout version on strategy switch + unreachable patrol sectors (C5).

**Browser gate (no external API):** form 6 units → visible main roster; show strike + pincer exact options with zero movement; select pincer → two rosters, separate staging, joint advance; two idle home reserves → reinforcement → only offered IDs move; end distant offensive → regroup → survivor IDs verified; ordinary base threat → zero auto movement → select defend-home; critical-defense still immediate; fallback never runs pincer/reinforce/regroup/defense.

**Page→worker→mock-sidecar gate:** guidanceMode=exact + decisionMode=commit; exactly one acceptDoctrineDecision; refreshed options on stale rosters/targets; correct squad+decision telemetry.

**Compatibility:** raw schema/prompt/request hashes unchanged; ordinary model-sweep still completes on exploration %; science/executor without fallback keeps `hostStrikeRate=0` and `PureGeneralValid`; assisted contract/manifest hashes refresh only where intended.

**End gate:** warnings-as-errors Browser build; full NUnit + sidecar suites; contract/doctrine/arsenal/skills gates; headed no-OOS Play-smoke on existing `.env` key, ≤ $0.25, key never logged.

---

## 10. Assumptions, exclusions & handoff

- Tickrate 25/s; decision cooldown 375 ticks; regroup window 750 ticks.
- NO host-combat-last-resort, softReinforce, softDisengage, full Play-autopilot; NO line/wedge/column formations; NO separate counter-attack state in v1.
- Out of adoption: staff-seat/reaction models, build-plan watchdogs, automatic ordinary defense, infra-censored artifacts, the loose project-audit file.
- Existing user changes preserved; this file's §2 + the list below is the include/quarantine handoff for the git-coordinator.

### acl file inventory (for the include/quarantine handoff)

Committed `wasm-port..acl-autonomous-play` (28 files, +3047/−165) and uncommitted acl working-tree (16 files, +653/−76). Adopt selectively per §2; the large-churn files are cherry-pick sources, NOT wholesale merges:

- **Cherry-pick surfacing/facts from:** `AgentDoctrineExecutor.cs` (+311/+63u), `AgentModeContracts.cs` (+92/+8u), `AgentDoctrineController.cs` (+115/+4u), `AgentMissionController.cs` (+80), `AgentDoctrineProgram.cs` (+70).
- **New files to evaluate:** `AgentProductionStrategy.cs` (+151, GATE §2), `agent-sidecar/src/batch-coerce.ts` (ADOPT §2), `AgentCombatRoster.cs` (acl variant — CURRENT already has its own; keep CURRENT's).
- **Quarantine-heavy (contains the soft-combat layer):** `AgentModeHost.cs` (+1331/+339u), `AgentReflexController.cs` (+90/+68u) — port only the named fact predicates / surfacing, per §6.
- **Reusable tests:** `acl-strike-gate.mjs`, `acl-plan-gate.mjs`, `generalship-pure-gate.mjs`, `GENERALSHIP-BENCHMARK.md`, `doctrine-pr{1,2,3}-gate.mjs` deltas.
- **Gate/verify before adopting:** `openra-agent-mode.js` (+60/+15u), `agent-worker.js` (+10), `index.html` (+15 — contains the quarantined checkbox), `contracts.ts` (+21), `instructions.ts` (+34/+8u), `server.ts` (+26/+64u).
- **Do NOT port:** `ACL-PLAN.md` (acl's own doc), the `hostCombatLastResortEnabled` wiring across host/JS/html.
