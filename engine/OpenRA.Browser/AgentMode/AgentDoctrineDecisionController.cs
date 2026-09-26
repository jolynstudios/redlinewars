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
	/// Persistent state for consequential doctrine choices. This controller is deliberately
	/// simulation-free: the host authors and revalidates exact options, while this class owns
	/// identity, miss, expiry, cooldown, and fallback timing semantics.
	/// </summary>
	static class AgentDoctrineDecisionController
	{
		internal const int DecisionLifetimeTicks = 1500;
		internal const int RearmCooldownTicks = 100;
		internal const int ResolutionCooldownTicks = 375;
		internal const int FallbackMinimumTicks = 375;
		internal const int FallbackMinimumMisses = 2;
		internal const int HomeRadiusSquared =
			AgentDoctrineExecutor.ReinforceRegroupHomeRadiusCells *
			AgentDoctrineExecutor.ReinforceRegroupHomeRadiusCells;

		// A base-defense wake admits a single defender (a lone tank still answers) and caps at the same
		// six-unit ceiling as reinforce/regroup so the host never offers to move the whole army.
		internal const int DefenseMinUnits = 1;
		internal const int DefenseMaxUnits = AgentDoctrineExecutor.ReinforceRegroupMaxUnits;

		internal sealed class Candidate
		{
			public uint ActorId;
			public bool AllowedRosterMember;
			public bool OwnedLiveCombat;
			public bool Idle;
			public bool InMission;
			public bool InterventionActive;
			public int DistanceFromHomeSquared;
		}

		internal sealed class Decision
		{
			public long DecisionId;
			public string Kind;
			public int IssuedTick;
			public int ExpiresTick;
			public int FirstWakeTick;
			public int RearmTick;
			public int MissCount;
			public List<AgentGuidanceOptionObservation> Options = [];
		}

		internal sealed class State
		{
			public long NextDecisionId = 1;
			public Decision Pending;
			public readonly Dictionary<string, int> KindCooldownUntil = new(StringComparer.Ordinal);
		}

		internal static Decision Issue(State state, string kind, int worldTick,
			List<AgentGuidanceOptionObservation> options)
		{
			if (state.Pending != null && state.Pending.Kind == kind && worldTick <= state.Pending.ExpiresTick)
			{
				foreach (var option in options)
					option.DecisionId = state.Pending.DecisionId;
				state.Pending.Options = options;
				return state.Pending;
			}

			state.Pending = new Decision
			{
				DecisionId = state.NextDecisionId++,
				Kind = kind,
				IssuedTick = worldTick,
				ExpiresTick = worldTick + DecisionLifetimeTicks,
				FirstWakeTick = worldTick,
				RearmTick = worldTick,
				Options = options
			};
			foreach (var option in state.Pending.Options)
				option.DecisionId = state.Pending.DecisionId;
			return state.Pending;
		}

		internal static bool IsKindCoolingDown(State state, string kind, int worldTick)
		{
			return state.KindCooldownUntil.TryGetValue(kind, out var until) && worldTick < until;
		}

		internal static bool RecordMiss(State state, int worldTick)
		{
			if (state.Pending == null)
				return false;

			state.Pending.MissCount++;
			state.Pending.RearmTick = worldTick + RearmCooldownTicks;
			return true;
		}

		internal static void Resolve(State state, int worldTick)
		{
			if (state.Pending == null)
				return;

			state.KindCooldownUntil[state.Pending.Kind] = worldTick + ResolutionCooldownTicks;
			state.Pending = null;
		}

		internal static bool DiscardStaleRejectionRepair(State state, long decisionId)
		{
			if (state.Pending?.Kind != "rejectionRepair" || state.Pending.DecisionId != decisionId)
				return false;

			state.Pending = null;
			return true;
		}

		internal static bool ShouldFallback(Decision decision, int worldTick, bool preconditionsStillTrue,
			bool requestInFlight)
		{
			return decision != null && AgentDoctrineExecutor.FallbackStrikeReady(decision.MissCount,
				worldTick - decision.FirstWakeTick, preconditionsStillTrue, requestInFlight,
				FallbackMinimumMisses, FallbackMinimumTicks);
		}

		internal static IReadOnlyList<uint> SelectReinforceCandidates(IEnumerable<Candidate> candidates,
			int maximum = AgentDoctrineExecutor.ReinforceRegroupMaxUnits)
		{
			return SelectCandidates(candidates, nearHome: true, maximum);
		}

		internal static IReadOnlyList<uint> SelectRegroupCandidates(IEnumerable<Candidate> candidates,
			int maximum = AgentDoctrineExecutor.ReinforceRegroupMaxUnits)
		{
			return SelectCandidates(candidates, nearHome: false, maximum);
		}

		/// <summary>
		/// Idle live defenders that may answer a base-defense wake: owned combat roster members not
		/// already in a mission, model lease, or active reflex intervention. Unlike reinforce/regroup
		/// this applies no home-radius filter (defenders attack-move to the threat from wherever they
		/// stand) and admits a single unit. Deterministic by actor-ID and capped so the host never
		/// offers to move the whole army for a skirmish. An empty result is the caller's defenseEmpty
		/// signal (surface telemetry, issue zero orders).
		/// </summary>
		internal static IReadOnlyList<uint> SelectDefenseCandidates(IEnumerable<Candidate> candidates,
			int minimum = DefenseMinUnits, int maximum = DefenseMaxUnits)
		{
			var selected = (candidates ?? []).Where(candidate => candidate.AllowedRosterMember &&
				candidate.OwnedLiveCombat && candidate.Idle && !candidate.InMission &&
				!candidate.InterventionActive)
				.Select(candidate => candidate.ActorId).Distinct().Order()
				.Take(Math.Max(0, maximum)).ToArray();
			return selected.Length >= Math.Max(1, minimum) ? selected : [];
		}

		static IReadOnlyList<uint> SelectCandidates(IEnumerable<Candidate> candidates, bool nearHome, int maximum)
		{
			var selected = (candidates ?? []).Where(candidate => candidate.AllowedRosterMember &&
				candidate.OwnedLiveCombat && candidate.Idle && !candidate.InMission &&
				!candidate.InterventionActive && (nearHome
					? candidate.DistanceFromHomeSquared <= HomeRadiusSquared
					: candidate.DistanceFromHomeSquared > HomeRadiusSquared))
				.Select(candidate => candidate.ActorId).Distinct().Order()
				.Take(Math.Max(0, maximum)).ToArray();
			return selected.Length >= AgentDoctrineExecutor.ReinforceRegroupMinUnits ? selected : [];
		}

		internal static bool ShouldOfferReinforce(bool hasNonPausedGroundOffensiveTarget,
			bool reinforceMissionActive, int candidateCount)
		{
			return hasNonPausedGroundOffensiveTarget && !reinforceMissionActive &&
				candidateCount >= AgentDoctrineExecutor.ReinforceRegroupMinUnits;
		}

		internal static bool ShouldOfferRegroup(bool groundOffensiveActive, int lastTerminalTick,
			int worldTick, int candidateCount)
		{
			var elapsed = worldTick - lastTerminalTick;
			return !groundOffensiveActive && lastTerminalTick >= 0 && elapsed >= 0 &&
				elapsed <= AgentDoctrineExecutor.RecentGroundOffensiveTicks &&
				candidateCount >= AgentDoctrineExecutor.ReinforceRegroupMinUnits;
		}

		internal static AgentGuidanceOptionObservation ExactAttackMoveOption(string optionId, string label,
			string kind, IEnumerable<uint> actorIds, int cellX, int cellY)
		{
			return new AgentGuidanceOptionObservation
			{
				OptionId = optionId,
				Label = label,
				Kind = kind,
				Actions =
				[
					new AgentAction
					{
						Type = "attackMove",
						ActorIds = [.. (actorIds ?? []).Distinct().Order()],
						CellX = cellX,
						CellY = cellY
					}
				]
			};
		}

		internal static AgentDoctrinePendingDecisionObservation Observe(State state)
		{
			var pending = state.Pending;
			return pending == null ? null : new AgentDoctrinePendingDecisionObservation
			{
				DecisionId = pending.DecisionId,
				Kind = pending.Kind,
				IssuedTick = pending.IssuedTick,
				ExpiresTick = pending.ExpiresTick,
				MissCount = pending.MissCount,
				Options = [.. pending.Options]
			};
		}
	}
}
