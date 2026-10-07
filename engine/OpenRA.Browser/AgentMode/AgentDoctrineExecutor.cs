#region Copyright & License Information
/*
 * Copyright (c) The OpenRA Developers and Contributors
 * This file is part of OpenRA, which is free software. It is made
 * available to you under the terms of the GNU General Public License
 * as published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version. For more
 * information, see COPYING.
 */
#endregion

using System;
using System.Collections.Generic;
using System.Linq;

namespace OpenRA.Browser
{
	/// <summary>
	/// Pure decision layer for the doctrine executor. Given fog-safe facts (already gathered by
	/// the host) it decides whether standing behaviours are due and how far they may go. It
	/// touches no simulation state, issues no orders, and holds no state of its own, so it is
	/// unit testable without the browser runtime. Bounds here keep the executor from playing the
	/// match for the model: the model's choices stay the measured variable (benchmark honesty).
	/// </summary>
	static class AgentDoctrineExecutor
	{
		internal const int DefaultStreamMaxConcurrent = 2;
		internal const int DefaultStreamBatchCount = 1;
		internal const int DefaultScoutRelaunchCooldownTicks = 750;
		internal const int ReinforceRegroupMinUnits = 2;
		internal const int ReinforceRegroupMaxUnits = 6;
		internal const int ReinforceRegroupHomeRadiusCells = 12;
		internal const int RecentGroundOffensiveTicks = 750;

		// A main body of at least this many combat units, with an enemy structure already scouted
		// and nothing committed, is worth waking the model to commit — below it, the standing
		// stream is still massing and a prompt would only nag.
		internal const int ArmyCommitMinUnits = 3;

		internal static int EffectiveStreamMaxConcurrent(AgentDoctrineProgram.Program program)
		{
			return program != null && program.StreamMaxConcurrent > 0
				? program.StreamMaxConcurrent
				: DefaultStreamMaxConcurrent;
		}

		internal static int EffectiveStreamBatchCount(AgentDoctrineProgram.Program program)
		{
			return program != null && program.StreamBatchCount > 0
				? program.StreamBatchCount
				: DefaultStreamBatchCount;
		}

		/// <summary>
		/// True when the named phase lists <paramref name="verb"/> among its standing behaviours.
		/// </summary>
		internal static bool PhaseHasStanding(AgentDoctrineProgram.Program program, string phaseName, string verb)
		{
			if (program == null || string.IsNullOrEmpty(phaseName) || string.IsNullOrEmpty(verb))
				return false;

			var phase = program.Phases?.FirstOrDefault(p => string.Equals(p.Name, phaseName, StringComparison.Ordinal));
			return phase?.Standing != null && phase.Standing.Contains(verb, StringComparer.Ordinal);
		}

		/// <summary>
		/// The phase after <paramref name="currentPhase"/>, or null at the terminal phase or when the
		/// phase is unknown. Shared by host auto-advance and model advancePhase so the two agree on
		/// the boundary (and neither can step off the end of the phase list).
		/// </summary>
		internal static string NextPhaseName(AgentDoctrineProgram.Program program, string currentPhase)
		{
			if (program?.Phases == null)
				return null;

			var index = program.Phases.FindIndex(p => string.Equals(p.Name, currentPhase, StringComparison.Ordinal));
			if (index < 0 || index + 1 >= program.Phases.Count)
				return null;

			return program.Phases[index + 1].Name;
		}

		/// <summary>
		/// Whether the host should (re)launch the standing scout sweep. The executor only launches
		/// a fresh sweep when none is already active and there are live scouts to carry it, so it
		/// never fights an in-flight mission or the model's own reconnaissance.
		/// </summary>
		internal static bool ShouldLaunchScout(bool executorEnabled, bool bound, bool paused,
			bool phaseHasScoutSweep, bool scoutMissionActive, int scoutSquadLiveCount,
			int worldTick = 0, int nextScoutEligibleTick = 0)
		{
			return executorEnabled && bound && !paused && phaseHasScoutSweep &&
				!scoutMissionActive && scoutSquadLiveCount > 0 && worldTick >= nextScoutEligibleTick;
		}

		internal static int ScoutEligibleTickAfterActivityTransition(bool wasActive, bool active,
			int worldTick, int currentEligibleTick,
			int cooldownTicks = DefaultScoutRelaunchCooldownTicks)
		{
			return wasActive && !active
				? Math.Max(currentEligibleTick, worldTick + cooldownTicks)
				: currentEligibleTick;
		}

		internal static string SweepDisposition(bool requireEnemyStructureContact, bool enemyStructureContact,
			int exploredPercent, int exploredTarget, int reachableUnexploredSectors)
		{
			if (requireEnemyStructureContact && enemyStructureContact)
				return "complete-contact";
			if (!requireEnemyStructureContact && exploredPercent >= exploredTarget)
				return "complete-threshold";
			if (!requireEnemyStructureContact && reachableUnexploredSectors == 0)
				return "complete-exhausted";
			if (requireEnemyStructureContact && reachableUnexploredSectors == 0)
				return "patrol";
			return requireEnemyStructureContact && exploredPercent >= exploredTarget
				? "contact-seeking" : "sweeping";
		}

		internal static IReadOnlyList<CPos> SerpentineSectors(IEnumerable<CPos> sectors)
		{
			return sectors.Distinct().GroupBy(cell => cell.Y).OrderBy(row => row.Key)
				.SelectMany((row, index) => index % 2 == 0
					? row.OrderBy(cell => cell.X)
					: row.OrderByDescending(cell => cell.X))
				.ToArray();
		}

		internal static bool IsGroundOffensive(string missionType)
		{
			return missionType is "strike" or "pincer" or "pursue";
		}

		/// <summary>
		/// How many of a streamed unit type the host may queue this tick. Zero unless the executor
		/// is live for this phase, the plan is not itself starved for cash, the concurrency cap has
		/// room, and the reserve-protected balance can pay for at least one. The reserve keeps the
		/// model-authored (or doctrine) build plan solvent (decision D5) and the concurrency cap
		/// stops the stream from monopolising a queue.
		/// </summary>
		internal static int StreamQuantity(bool executorEnabled, bool bound, bool paused, bool phaseHasStreamUnits,
			int cash, int reserveForPlan, bool planWaitingCash, int unitCost, int inFlight, int maxConcurrent, int batch)
		{
			if (!executorEnabled || !bound || paused || !phaseHasStreamUnits || planWaitingCash ||
				unitCost <= 0 || inFlight >= maxConcurrent)
				return 0;

			var spendable = cash - reserveForPlan;
			if (spendable < unitCost)
				return 0;

			var affordable = spendable / unitCost;
			var room = maxConcurrent - inFlight;
			return Math.Max(0, Math.Min(Math.Min(batch, room), affordable));
		}

		/// <summary>
		/// True when a scouted, uncommitted main body is worth waking the model to commit. The
		/// executor deliberately does NOT launch the strike itself — targeting and commitment are
		/// consequential decisions the benchmark measures, so the host only surfaces the opportunity.
		/// </summary>
		internal static bool ArmyReadyForOrders(int mainBodyCount, int knownEnemyStructureCount,
			bool hasActiveOffensiveMission, int commitMinUnits = ArmyCommitMinUnits)
		{
			return mainBodyCount >= Math.Max(1, commitMinUnits) && knownEnemyStructureCount > 0 &&
				!hasActiveOffensiveMission;
		}

		/// <summary>
		/// Soft cap so models cannot spend every cash tick on harvesters (income tunnel thrash).
		/// Roughly 2 harvs per refinery, absolute max 8. One harv is allowed with zero refineries
		/// so opening can queue while the first proc places.
		/// </summary>
		internal const int AbsoluteHarvesterCap = 8;

		internal static int HarvesterSoftCap(int refineryCount)
		{
			if (refineryCount <= 0)
				return 1;
			return Math.Min(AbsoluteHarvesterCap, refineryCount * 2 + 1);
		}

		/// <summary>
		/// False when live+queued (+this request) would exceed the soft cap.
		/// </summary>
		internal static bool ShouldAllowMoreHarvesters(int liveHarvesters, int queuedHarvesters,
			int refineryCount, int requestedCount = 1)
		{
			if (requestedCount < 1)
				requestedCount = 1;
			var total = liveHarvesters + Math.Max(0, queuedHarvesters) + requestedCount;
			return total <= HarvesterSoftCap(refineryCount);
		}

		/// <summary>
		/// Which decision the model is being woken for, or null. Only wakes while the executor is
		/// live and the doctrine is bound and not paused. baseDefenseNeeded takes top priority (defense
		/// preempts offense) and is backed by a commitIntent defendBase option (the war compiler recalls
		/// the roster and aborts the offense), gated on at least one disclosed idle defender being free.
		/// armyIdle (a scouted, uncommitted main body) is backed by a real queueMission.
		/// phaseReady fires only when the model is holding at a satisfied phase boundary (controlDoctrine
		/// holdPhase) — backed by real advancePhase/holdPhase orders; without a hold the host
		/// auto-advances (D2) and there is nothing for the model to do.
		/// </summary>
		internal static string NeedsDecisionWake(bool executorEnabled, bool bound, bool paused,
			bool armyReadyForOrders, bool phaseHeldAtBoundary, bool reinforceAttack = false,
			bool regroupNeeded = false, bool enemyContact = false, bool scoutFailed = false,
			bool baseDefenseNeeded = false, bool counterAttackWindow = false, bool pressAttack = false)
		{
			if (!executorEnabled || !bound || paused)
				return null;
			if (baseDefenseNeeded)
				return "baseDefenseNeeded";

			// Momentum (FIX-1 outcome-delta): local win + thin enemy base → counter; winning live front → press.
			// Defense still preempts; momentum outranks plain reinforce/regroup/armyIdle continuity.
			if (counterAttackWindow)
				return "counterAttackWindow";
			if (pressAttack)
				return "pressAttack";
			if (reinforceAttack)
				return "reinforceAttack";
			if (regroupNeeded)
				return "regroupNeeded";
			if (enemyContact)
				return "enemyContact";
			if (scoutFailed)
				return "scoutFailed";
			if (armyReadyForOrders)
				return "armyIdle";
			if (phaseHeldAtBoundary)
				return "phaseReady";
			return null;
		}

		/// <summary>
		/// Fog-safe: enemy combat pressure dropped hard while own losses stayed lower.
		/// </summary>
		internal static bool IsLocalVictory(int enemyCombatLost, int ownCombatLost, int minEnemyLost = 2)
		{
			return enemyCombatLost >= minEnemyLost && ownCombatLost <= enemyCombatLost;
		}

		/// <summary>
		/// Known enemy structures exist and few visible guards near them (base looks thin).
		/// </summary>
		internal static bool IsEnemyBaseExposed(int knownEnemyStructureCount, int visibleGuardsNearKnownBase,
			int maxGuards = 2)
		{
			return knownEnemyStructureCount > 0 && visibleGuardsNearKnownBase <= maxGuards;
		}

		/// <summary>
		/// After a local win, base looks thin, army has force — surface counter-attack (model decides).
		/// </summary>
		internal static bool ShouldCounterAttackWindow(bool localVictory, bool enemyBaseExposed,
			int mainBodyCount, int minForce, bool hasOffensiveMission, bool prioritizeBaseEconomy)
		{
			if (!localVictory || !enemyBaseExposed || hasOffensiveMission || prioritizeBaseEconomy)
				return false;
			return mainBodyCount >= Math.Max(3, minForce / 2);
		}

		/// <summary>
		/// Live offensive and exchange favors us — press (harder reinforce / push), model may re-commit.
		/// </summary>
		internal static bool ShouldPressAttack(bool hasOffensiveMission, int enemyCombatLost, int ownCombatLost)
		{
			if (!hasOffensiveMission)
				return false;
			return enemyCombatLost >= 2 && enemyCombatLost > ownCombatLost;
		}

		/// <summary>
		/// Non-ranked options to show the model for a wake. Suggestions, not instructions — the
		/// model picks (or does something else entirely). Every option maps to an order the model
		/// can actually issue, so the surface never overstates the model's control.
		/// </summary>
		internal static IReadOnlyList<string> SuggestedOptionsFor(string wake)
		{
			return wake switch
			{
				"armyIdle" =>
				[
					"commit the main body: queueMission strike or pincer at a known enemy structure",
					"hold and reinforce until the force is larger",
					"raid the enemy economy with a bounded detachment"
				],
				"phaseReady" =>
				[
					"advancePhase: take the boundary and commit to the next phase (controlDoctrine)",
					"keep holding to mass more (you are holding; the host will not auto-advance)",
					"switch to a different card if the matchup changed"
				],

				"baseDefenseNeeded" =>
				[
					"defend home: attack-move the disclosed idle defenders to the threatened cell",
					"defer and let the standing safety reflexes cover it (bounded 375-tick defer)"
				],
				"counterAttackWindow" =>
				[
					"MOMENTUM: you just won a local fight and the enemy base looks thin — commitIntent strike now",
					"if under force: hold and mass (the host scouts) — do not suicide a small force",
					"commitIntent hold if you deliberately decline the window"
				],
				"pressAttack" =>
				[
					"MOMENTUM: your live strike is winning — reinforceIntent activeStrike and keep producing combat",
					"empty actions OK while the compiled reinforce feeds the wave",
					"commitIntent hold or controlMission cancel only if the trade turns bad"
				],
				_ => []
			};
		}

		internal static bool FallbackStrikeReady(int missCount, int ticksSinceFirstWake,
			bool preconditionsStillTrue, bool requestInFlight, int minimumMisses = 2, int minimumTicks = 375)
		{
			return preconditionsStillTrue && !requestInFlight && missCount >= minimumMisses &&
				ticksSinceFirstWake >= minimumTicks;
		}
	}
}
