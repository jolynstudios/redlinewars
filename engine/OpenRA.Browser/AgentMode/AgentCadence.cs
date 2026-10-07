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

namespace OpenRA.Browser
{
	/// <summary>
	/// R1 cadence + staleness policy for the play/RTS-Agent preset. Pure, engine-independent decision
	/// boundaries so the reactive cadence floor and the tactical stale-order guard can be unit-tested
	/// without the browser-only host. The raw pure-benchmark track never opts in (playCadenceEnabled
	/// stays false), so its tempo-as-score cadence and order acceptance are byte-for-byte unchanged.
	/// </summary>
	static class AgentCadence
	{
		/// <summary>Reactive play cadence heartbeat floor (~4s at 25 ticks/s). The benchmark keeps its configured interval.</summary>
		internal const int PlayCadenceIntervalTicks = 100;

		/// <summary>
		/// Tactical micro-orders computed on an observation older than this (in world ticks) are rejected
		/// under the play cadence profile so a reactive seat never fires move/attack into a stale position
		/// or target. Macro actions stay lenient regardless of age.
		/// </summary>
		internal const int TacticalStaleMaxAgeTicks = 250;

		/// <summary>
		/// Play cadence floors the effective heartbeat toward <see cref="PlayCadenceIntervalTicks"/>; the
		/// benchmark (and every non-play track) keeps its configured interval clamped to the contract range.
		/// </summary>
		internal static int EffectiveDecisionInterval(int configuredInterval, bool playCadenceEnabled)
		{
			var clamped = Math.Clamp(configuredInterval, 25, 2500);
			return playCadenceEnabled ? Math.Min(clamped, PlayCadenceIntervalTicks) : clamped;
		}

		/// <summary>
		/// Tactical (position/target-sensitive) micro-orders whose correctness depends on the live enemy
		/// position or target actor, so a stale observation makes them dangerous. Macro actions
		/// (production, missions, strategy, policy, deploy, rally, stop) are intentionally excluded.
		/// </summary>
		internal static bool IsTacticalOrderType(string actionType) =>
			actionType is "move" or "attackMove" or "attack" or "guard" or "capture" or "spyPlane";

		/// <summary>
		/// True only when the play cadence profile is active AND a tactical order was computed on an
		/// observation older than the strict tactical age budget. Macro orders and the benchmark track are
		/// never rejected for age, so pure-benchmark order acceptance is unchanged.
		/// </summary>
		internal static bool ShouldRejectStaleTacticalOrder(string actionType, int observationAgeTicks, bool playCadenceEnabled) =>
			playCadenceEnabled && observationAgeTicks > TacticalStaleMaxAgeTicks && IsTacticalOrderType(actionType);
	}
}
