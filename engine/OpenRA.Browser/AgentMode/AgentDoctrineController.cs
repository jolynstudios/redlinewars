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

namespace OpenRA.Browser
{
	/// <summary>
	/// Binds a machine-readable doctrine program to an adopted strategy card and
	/// exposes hostTruth.doctrine. PR1 is observation-only: no host order emission
	/// until doctrineExecutorEnabled is turned on (PR2+).
	/// </summary>
	static class AgentDoctrineController
	{
		internal const int ProgramVersion = 2;
		internal const int ScoutFailureTicks = 1500;

		// Rolling window of the most recent standing actions the executor took on the model's
		// behalf. Surfaced in hostTruth.doctrine so the model can see what was automated and the
		// scorecard can attribute host-driven vs model-driven play (benchmark honesty).
		internal const int MaxRecentActions = 8;

		internal sealed class State
		{
			public string StrategyId { get; set; }
			public int CardVersion { get; set; }
			public string Phase { get; set; }
			public int PhaseSinceTick { get; set; } = -1;
			public bool Paused { get; set; }
			public string PauseReason { get; set; }

			// Sticky model veto on auto phase-advance (decision D2). Cleared only by advancePhase
			// or a strategy switch, so a no-opping model cannot accidentally stall on it.
			public bool Held { get; set; }
			public bool Bound { get; set; }
			public AgentDoctrineProgram.Program Program { get; set; }
			public bool ExecutorSupported { get; set; }
			public string ValidationError { get; set; }
			public int ContactlessThresholdSinceTick { get; set; } = -1;
			public bool ScoutFailed { get; set; }

			// Highest doctrine-scout mission version launched so far. The host bumps this to
			// relaunch a fresh sweep once the previous one ends (standing reconnaissance).
			public int ScoutMissionVersion { get; set; }
			public int NextScoutEligibleTick { get; set; }
			public bool ScoutMissionWasActive { get; set; }
			public List<AgentDoctrineActionRecord> RecentActions { get; } = [];

			// Per-streamed-unit next-eligible tick. The host sets a cooldown after each stream
			// emission so order latency (an order is not applied the same tick) cannot make the
			// executor re-issue during the gap and overshoot StreamMaxConcurrent or the reserve.
			public Dictionary<string, int> StreamNextTick { get; } = new(StringComparer.Ordinal);
		}

		internal static void Clear(State state)
		{
			state.StrategyId = null;
			state.CardVersion = 0;
			state.Phase = null;
			state.PhaseSinceTick = -1;
			state.Paused = false;
			state.PauseReason = null;
			state.Held = false;
			state.Bound = false;
			state.Program = null;
			state.ExecutorSupported = false;
			state.ValidationError = null;
			state.ContactlessThresholdSinceTick = -1;
			state.ScoutFailed = false;
			state.ScoutMissionVersion = 0;
			state.NextScoutEligibleTick = 0;
			state.ScoutMissionWasActive = false;
			state.RecentActions.Clear();
			state.StreamNextTick.Clear();
		}

		/// <summary>
		/// Record a standing action the executor issued this tick (source=doctrine). Kept as a
		/// bounded rolling window so the observation stays small and deterministic.
		/// </summary>
		internal static void RecordAction(State state, string kind, string detail, int worldTick,
			string source = "doctrine", long decisionId = 0, string missionId = null,
			List<uint> actorIds = null, string reason = null)
		{
			state.RecentActions.Add(new AgentDoctrineActionRecord
			{
				Kind = kind,
				Detail = detail,
				Tick = worldTick,
				Source = source,
				DecisionId = decisionId,
				MissionId = missionId,
				ActorIds = actorIds,
				Reason = reason
			});
			while (state.RecentActions.Count > MaxRecentActions)
				state.RecentActions.RemoveAt(0);
		}

		/// <summary>
		/// Bind or rebind after adoptStrategy. Re-adopt of the same card is idempotent.
		/// </summary>
		internal static void Bind(State state, string strategyId, int cardVersion, int worldTick,
			string factionSide, World world)
		{
			if (string.IsNullOrEmpty(strategyId))
			{
				Clear(state);
				return;
			}

			if (state.Bound && state.StrategyId == strategyId && state.CardVersion == cardVersion &&
				state.Program != null)
			{
				// Idempotent re-adopt: keep phase/progress, clear accidental pause from thrash.
				return;
			}

			if (!AgentDoctrineProgram.TryGet(strategyId, out var program))
			{
				// Arsenal card without a doctrine program yet: observation reports unbound.
				Clear(state);
				state.StrategyId = strategyId;
				state.CardVersion = cardVersion;
				state.Bound = false;
				state.ExecutorSupported = false;
				state.ValidationError = "no compiled doctrine program is registered for this card";
				return;
			}

			var validationError = AgentDoctrineProgram.Validate(program, cardVersion, factionSide, world);
			if (validationError != null)
			{
				Clear(state);
				state.StrategyId = strategyId;
				state.CardVersion = cardVersion;
				state.ValidationError = validationError;
				return;
			}

			// A different card resets phase + standing telemetry, but ScoutMissionVersion stays
			// monotonic so a fresh sweep never collides with the mission controller's version guard.
			state.Held = false;
			state.RecentActions.Clear();
			state.StreamNextTick.Clear();
			state.StrategyId = strategyId;
			state.CardVersion = cardVersion;
			state.Program = program;
			state.Bound = true;
			state.ExecutorSupported = true;
			state.ValidationError = null;
			state.Paused = false;
			state.PauseReason = null;
			state.Phase = program.Phases.Count > 0 ? program.Phases[0].Name : "idle";
			state.PhaseSinceTick = worldTick;
			state.ContactlessThresholdSinceTick = -1;
			state.ScoutFailed = false;
		}

		internal static void Pause(State state, string reason)
		{
			if (!state.Bound)
				return;

			state.Paused = true;
			state.PauseReason = string.IsNullOrWhiteSpace(reason) ? "paused" : reason.Trim();
		}

		internal static void Resume(State state)
		{
			if (!state.Bound)
				return;

			state.Paused = false;
			state.PauseReason = null;
		}

		internal static void Hold(State state)
		{
			if (state.Bound)
				state.Held = true;
		}

		internal static void ObserveScoutActivity(State state, bool active, int worldTick,
			int cooldownTicks = AgentDoctrineExecutor.DefaultScoutRelaunchCooldownTicks)
		{
			state.NextScoutEligibleTick = AgentDoctrineExecutor.ScoutEligibleTickAfterActivityTransition(
				state.ScoutMissionWasActive, active, worldTick, state.NextScoutEligibleTick, cooldownTicks);
			state.ScoutMissionWasActive = active;
		}

		internal static bool PhaseRequiresEnemyStructureContact(State state)
		{
			return state?.Program?.Phases.FirstOrDefault(phase => phase.Name == state.Phase)?.ExitRequiresEnemyStructureContact == true;
		}

		/// <summary>
		/// Model-driven phase advance: clears the hold and steps to the next phase (no-op at the
		/// terminal phase). Lets the model take a boundary the host would auto-advance, or commit early.
		/// </summary>
		internal static void AdvancePhase(State state, int worldTick)
		{
			state.Held = false;
			if (!state.Bound || state.Program == null)
				return;

			var next = AgentDoctrineExecutor.NextPhaseName(state.Program, state.Phase);
			if (next == null)
				return;

			state.Phase = next;
			state.PhaseSinceTick = worldTick;
		}

		/// <summary>
		/// Refresh phase progress from fog-safe world facts. Does not issue orders (PR1).
		/// Auto-advances on exitWhen when not paused (decision panel D2).
		/// </summary>
		internal static void EvaluateProgress(State state, AgentDoctrineProgressFacts facts, int worldTick,
			bool autoAdvance)
		{
			if (!state.Bound || state.Program == null || state.Paused)
				return;

			var phase = state.Program.Phases.FirstOrDefault(p => p.Name == state.Phase);
			if (phase == null)
				return;

			if (phase.ExitRequiresEnemyStructureContact && phase.ExitMinExploredPercent > 0 &&
				facts.ExploredPercent >= phase.ExitMinExploredPercent && facts.KnownEnemyStructureCount == 0)
			{
				if (state.ContactlessThresholdSinceTick < 0)
					state.ContactlessThresholdSinceTick = worldTick;
				state.ScoutFailed = worldTick - state.ContactlessThresholdSinceTick >= ScoutFailureTicks;
			}
			else
			{
				state.ContactlessThresholdSinceTick = -1;
				state.ScoutFailed = false;
			}

			// A model holdPhase veto (D2) suppresses auto-advance until advancePhase or a switch.
			if (!autoAdvance || state.Held || !PhaseExitSatisfied(phase, facts))
				return;

			var next = AgentDoctrineExecutor.NextPhaseName(state.Program, state.Phase);
			if (next == null)
				return;

			state.Phase = next;
			state.PhaseSinceTick = worldTick;
		}

		internal static AgentDoctrineObservation Observe(State state, bool arsenalEnabled, bool executorEnabled,
			AgentDoctrineProgressFacts facts)
		{
			if (!arsenalEnabled)
			{
				return new AgentDoctrineObservation
				{
					Enabled = false,
					ExecutorEnabled = false,
					Bound = false,
					ExecutorSupported = false
				};
			}

			var phase = state.Program?.Phases.FirstOrDefault(p => p.Name == state.Phase);
			var tanksNeed = phase?.ExitMinUnitCount ?? state.Program?.MobilizeTankTarget ?? 0;
			var exploreNeed = phase?.ExitMinExploredPercent ?? state.Program?.ScoutExploredPercentTarget ?? 0;

			// Wake the model for the consequential decisions the executor does not make itself.
			// armyIdle (commit the scouted main body) is backed by queueMission; phaseReady fires only
			// while the model is holding at a satisfied boundary (controlDoctrine holdPhase/advancePhase).
			var armyReady = AgentDoctrineExecutor.ArmyReadyForOrders(
				facts.CommitUnitCount, facts.KnownEnemyStructureCount, facts.HasActiveOffensiveMission,
				state.Program?.CommitMinUnits ?? AgentDoctrineExecutor.ArmyCommitMinUnits);
			var phaseHeldAtBoundary = state.Held && phase != null && PhaseExitSatisfied(phase, facts);
			var needsDecision = AgentDoctrineExecutor.NeedsDecisionWake(
				executorEnabled, state.Bound, state.Paused, armyReady, phaseHeldAtBoundary,
				counterAttackWindow: facts.CounterAttackWindow, pressAttack: facts.PressAttack);

			var nextAuto = new List<string>();
			if (state.Bound && state.Program != null && !state.Paused)
			{
				if (executorEnabled)
				{
					var standing = phase?.Standing != null && phase.Standing.Length > 0
						? string.Join(", ", phase.Standing)
						: "none";
					nextAuto.Add($"executor-on: host runs standing [{standing}] for phase '{state.Phase}' " +
						"and advances phases automatically (controlDoctrine holdPhase to veto); you still own " +
						"targeting and commitment (queueMission), strategy switch, and any direct override");
				}
				else
				{
					nextAuto.Add("executor-off: observation only; host will not emit doctrine orders");
					if (phase != null)
						nextAuto.Add($"phase '{phase.Name}': {phase.Objective}");
				}
			}

			return new AgentDoctrineObservation
			{
				Enabled = arsenalEnabled,
				ExecutorEnabled = executorEnabled,
				Bound = state.Bound,
				ExecutorSupported = state.ExecutorSupported,
				ValidationError = state.ValidationError,
				StrategyId = state.StrategyId,
				CardVersion = state.CardVersion,
				ProgramVersion = ProgramVersion,
				Phase = state.Phase,
				PhaseSinceTick = state.PhaseSinceTick,
				Paused = state.Paused,
				PauseReason = state.PauseReason,
				PhaseHeld = state.Held,
				Progress = new AgentDoctrineProgressObservation
				{
					TanksLive = facts.CommitUnitCount,
					TanksNeed = tanksNeed,
					ExploredPercent = facts.ExploredPercent,
					ExploredNeed = exploreNeed,
					WavesFailed = 0
				},
				ScoutFailed = state.ScoutFailed,
				NextAutoActions = nextAuto,
				NeedsDecision = needsDecision,
				SuggestedOptions = [.. AgentDoctrineExecutor.SuggestedOptionsFor(needsDecision)],
				RecentActions = [.. state.RecentActions]
			};
		}

		static bool PhaseExitSatisfied(AgentDoctrineProgram.Phase phase, AgentDoctrineProgressFacts facts)
		{
			if (phase.ExitMinUnitCount > 0 && facts.TankCount < phase.ExitMinUnitCount)
				return false;
			if (phase.ExitMinExploredPercent > 0 && facts.ExploredPercent < phase.ExitMinExploredPercent)
				return false;
			if (phase.ExitRequiresEnemyStructureContact && facts.KnownEnemyStructureCount == 0)
				return false;
			return phase.ExitMinUnitCount > 0 || phase.ExitMinExploredPercent > 0 ||
				phase.ExitRequiresEnemyStructureContact;
		}
	}

	sealed class AgentDoctrineProgressFacts
	{
		public int TankCount { get; init; }
		public int CommitUnitCount { get; init; }
		public int ExploredPercent { get; init; }
		public int ScoutCount { get; init; }
		public int KnownEnemyStructureCount { get; init; }
		public bool HasActiveOffensiveMission { get; init; }

		// FIX-1 outcome-delta momentum flags (host-computed from fog-safe combat losses since last decision).
		public bool CounterAttackWindow { get; init; }
		public bool PressAttack { get; init; }
	}
}
