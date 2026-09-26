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
	/// Pure decision helpers for the control harness war compiler.
	/// Host owns compile/execute; model owns commitIntent (pure) or host injects (assisted).
	/// </summary>
	static class AgentWarCompiler
	{
		internal const int DefaultMinForce = 6;
		internal const int DefaultMaxForce = 24;
		internal const int DefaultScoutCap = 4;
		internal const int ReinforceBatchMax = 8;
		internal const int CompiledStrikeCooldownTicks = 500;
		internal const int CompiledReinforceGraceTicks = 375;

		// R5 bug 1 staging: how far short of the target a compiled/doctrine strike stages. Kept larger than
		// the mission stage radius so the massed army sits clearly off the attack point, not on it.
		internal const int DefaultStagingHoldbackCells = 6;

		// Compiled fuzzy disengage (BQ F4): a model-committed strike squad that is locally outnumbered at the
		// front decides flee-vs-trade by the AttackOrFleeFuzzy verdict. Contact radius mirrors the engine squad
		// AI's local-bubble; the cooldown bounds re-issue/telemetry so a single flee is one order, not a stream.
		internal const int CompiledDisengageContactRadiusCells = 8;
		internal const int CompiledDisengageMaxUnits = 8;
		internal const int CompiledDisengageCooldownTicks = 125;

		internal const string CompilerStrikeMissionId = "compiler-strike";
		internal const string CompilerMainSquad = "main";

		internal static readonly string[] OpeningActions =
		[
			"deploy", "queueBuildPlan", "controlBuildPlan", "setPolicy", "adoptStrategy",
			"setProductionStrategy", "commitIntent", "reinforceIntent"
		];

		// adoptStrategy stays legal after MCV exists: warmup apply + mid-match switches.
		internal static readonly string[] EconomyActions =
		[
			"queueBuildPlan", "controlBuildPlan", "startProduction", "cancelProduction",
			"placeBuilding", "placeBuildingAuto", "setRallyPoint", "setPolicy", "setProductionStrategy",
			"adoptStrategy", "repair", "sell", "commitIntent", "reinforceIntent", "controlMission",
			"controlDoctrine", "deploy"
		];

		internal static readonly string[] ArmyActions =
		[
			"assignGroup", "startProduction", "cancelProduction", "setRallyPoint", "setProductionStrategy",
			"adoptStrategy", "setPolicy", "commitIntent", "reinforceIntent", "controlMission", "controlDoctrine",
			"queueMission", "controlBuildPlan", "queueBuildPlan", "placeBuildingAuto", "repair"
		];

		internal static readonly string[] WarActions =
		[
			"commitIntent", "reinforceIntent", "controlMission", "assignGroup", "setPolicy",
			"setProductionStrategy", "adoptStrategy", "startProduction", "controlDoctrine", "repair",
			"placeBuildingAuto", "placeBuilding", "controlBuildPlan", "queueBuildPlan", "setRallyPoint"
		];

		internal static readonly string[] EmergencyActions =
		[
			"commitIntent", "reinforceIntent", "controlMission", "assignGroup", "setPolicy",
			"adoptStrategy", "startProduction", "repair", "placeBuildingAuto", "attackMove", "attack",
			"move", "stop"
		];

		internal sealed class State
		{
			public string Intent { get; set; }
			public string Priority { get; set; } = "production";
			public string Squad { get; set; } = CompilerMainSquad;
			public int MinForce { get; set; } = DefaultMinForce;
			public string Status { get; set; } = "idle";
			public int MissionVersion { get; set; }
			public int NextLaunchEligibleTick { get; set; }
			public int NextReinforceEligibleTick { get; set; }
			public int NextDisengageEligibleTick { get; set; }

			// Standing cap on the compiled reinforce batch (model tunes it via reinforceIntent maxUnits,
			// clamped to ReinforceBatchMax). Defaults to the full batch so an untuned war reinforces at 8.
			public int ReinforceMaxUnits { get; set; } = ReinforceBatchMax;
			public int CommittedTick { get; set; } = -1;
			public CPos? TargetCell { get; set; }
			public CPos? ViaCell { get; set; }

			/// <summary>Why the compiler last skipped launch/reinforce (empty when healthy).</summary>
			public string LastSkipReason { get; set; }
		}

		internal static void Clear(State state)
		{
			if (state == null)
				return;
			state.Intent = null;
			state.Priority = "production";
			state.Squad = CompilerMainSquad;
			state.MinForce = DefaultMinForce;
			state.Status = "idle";
			state.MissionVersion = 0;
			state.NextLaunchEligibleTick = 0;
			state.NextReinforceEligibleTick = 0;
			state.NextDisengageEligibleTick = 0;
			state.ReinforceMaxUnits = ReinforceBatchMax;
			state.CommittedTick = -1;
			state.TargetCell = null;
			state.ViaCell = null;
			state.LastSkipReason = null;
		}

		internal static void SetSkip(State state, string reason)
		{
			if (state == null)
				return;
			state.LastSkipReason = reason;
		}

		internal static int ClampMinForce(int? requested)
		{
			var v = requested ?? DefaultMinForce;
			if (v < 1)
				v = 1;
			if (v > DefaultMaxForce)
				v = DefaultMaxForce;
			return v;
		}

		internal static string NormalizeIntent(string intent)
		{
			if (string.IsNullOrWhiteSpace(intent))
				throw new System.IO.InvalidDataException("commitIntent requires intent");
			var key = intent.Trim().ToLowerInvariant();
			return key switch
			{
				"strike" => "strike",
				"hold" => "hold",
				"defendbase" or "defend" => "defendBase",
				_ => throw new System.IO.InvalidDataException(
					"commitIntent.intent must be strike, hold, or defendBase")
			};
		}

		internal static string NormalizePriority(string priority)
		{
			if (string.IsNullOrWhiteSpace(priority))
				return "production";
			return priority.Trim().ToLowerInvariant() switch
			{
				"any" or "economy" or "production" or "power" or "defenses" => priority.Trim().ToLowerInvariant(),
				_ => throw new System.IO.InvalidDataException(
					"commitIntent.priority must be any|economy|production|power|defenses")
			};
		}

		/// <summary>
		/// Map host mission targetPriority (no separate "power" in engine — map power → economy).
		/// </summary>
		internal static string ToMissionTargetPriority(string priority)
		{
			return priority switch
			{
				"power" => "economy",
				"defenses" => "defenses",
				"economy" => "economy",
				"production" => "production",
				_ => "any"
			};
		}

		internal static string ResolveControlPhase(
			bool hasFactOrYard,
			bool hasRefinery,
			int combatCount,
			bool hasActiveOffensiveMission,
			bool structureUnderAttack,
			bool warCommitActive)
		{
			if (structureUnderAttack)
				return "emergency";
			if (warCommitActive || hasActiveOffensiveMission)
				return "war";
			if (!hasFactOrYard)
				return "opening";
			if (!hasRefinery || combatCount < 2)
				return "economy";
			return "army";
		}

		internal static IReadOnlyList<string> LegalActionsForPhase(string phase)
		{
			return phase switch
			{
				"opening" => OpeningActions,
				"economy" => EconomyActions,
				"army" => ArmyActions,
				"war" => WarActions,
				"emergency" => EmergencyActions,
				_ => EconomyActions
			};
		}

		internal static bool IsActionLegalInPhase(string phase, string actionType)
		{
			if (string.IsNullOrEmpty(actionType))
				return false;
			return LegalActionsForPhase(phase).Contains(actionType, StringComparer.Ordinal);
		}

		/// <summary>
		/// Freeform combat micro while a compiled war commit is active is thrash.
		/// </summary>
		internal static bool ShouldRejectDribbleCombatMove(bool warCommitActive, string actionType,
			bool subjectsAreCombat)
		{
			if (!warCommitActive || !subjectsAreCombat)
				return false;
			return actionType is "attackMove" or "attack" or "move";
		}

		internal static bool ShouldLaunchCompiledStrike(bool commitIsStrike, int mainLive, int minForce,
			bool hasTarget, bool offensiveMissionActive, int worldTick, int nextLaunchEligibleTick)
		{
			if (!commitIsStrike || !hasTarget || offensiveMissionActive)
				return false;
			if (mainLive < minForce)
				return false;
			return worldTick >= nextLaunchEligibleTick;
		}

		internal static bool ShouldCompiledReinforce(bool commitIsStrike, bool offensiveMissionActive,
			int idleCombatAtHome, int worldTick, int nextReinforceEligibleTick)
		{
			if (!commitIsStrike || !offensiveMissionActive || idleCombatAtHome < 1)
				return false;
			return worldTick >= nextReinforceEligibleTick;
		}

		/// <summary>
		/// BQ F4: a compiled war squad decides flee-vs-trade only while the model's war commit is live, a
		/// compiled offensive is active, and the squad is locally outnumbered by mobile enemy combat. When
		/// those hold, the fuzzy verdict (from <see cref="AgentFuzzyEngagement"/>) decides. This is pure
		/// staff-work under a model commit — it replaces relying on the quarantined assisted softDisengage and
		/// never increments a last-resort counter, so pureGeneralValid stays true. Not outnumbered means hold
		/// the commit and keep trading (the strike does not auto-abort just because it met resistance).
		/// </summary>
		internal static bool ShouldCompiledDisengage(bool warCommitActive, bool offensiveMissionActive,
			int forwardLive, int enemyNear, bool fuzzyWantsFlee)
		{
			if (!warCommitActive || !offensiveMissionActive)
				return false;
			if (forwardLive < 1 || enemyNear < 1)
				return false;
			if (enemyNear <= forwardLive)
				return false;
			return fuzzyWantsFlee;
		}

		internal static int CapScoutRoster(int availableScouts, int cap = DefaultScoutCap)
		{
			if (availableScouts < 0)
				return 0;
			return Math.Min(availableScouts, Math.Max(1, cap));
		}

		internal static string MassingStatus(int mainLive, int minForce)
		{
			return mainLive < minForce ? "massing" : "ready";
		}

		/// <summary>
		/// A home-biased staging cell on the approach from <paramref name="home"/> toward
		/// <paramref name="target"/>, held back short of the target so the army masses on its own side of
		/// the map instead of on the attack point (R5 bug 1: target-as-staging). Advances at most to the
		/// midpoint and always keeps a holdback margin, so it never returns the target cell when home and
		/// target differ. Pure integer math (host-side decision only, never simulation), so it is
		/// deterministic and unit-testable.
		/// </summary>
		internal static CPos StagingCell(CPos home, CPos target, int holdBackCells = DefaultStagingHoldbackCells)
		{
			var dx = target.X - home.X;
			var dy = target.Y - home.Y;
			var distSq = dx * dx + dy * dy;
			if (distSq == 0)
				return home;
			var dist = (int)Math.Sqrt(distSq);
			if (dist <= 1)
				return home;

			// Home-biased: never advance past the midpoint, and always hold back short of the target.
			var forward = Math.Min(dist / 2, dist - Math.Max(1, holdBackCells));
			if (forward <= 0)
				return home;
			var x = home.X + (int)((long)dx * forward / dist);
			var y = home.Y + (int)((long)dy * forward / dist);
			return new CPos(x, y);
		}

		/// <summary>
		/// The commitIntent target category of a known enemy structure by its actor type. Groups the RA
		/// structure zoo into the commitIntent priority buckets (economy|production|power|defenses) plus
		/// "other" so the target picker can rank by the model's stated intent.
		/// </summary>
		internal static string StructureCategory(string type)
		{
			if (string.IsNullOrEmpty(type))
				return "other";
			return type switch
			{
				"weap" or "barr" or "tent" or "afld" or "hpad" or "spen" or "syrd" or "fact" or "afac"
					or "dome" or "fix" or "kenn" => "production",
				"proc" or "silo" => "economy",
				"powr" or "apwr" => "power",
				"gun" or "ftur" or "tsla" or "sam" or "agun" or "gtwr" or "pbox" or "hbox" or "brik"
					or "sbag" or "fenc" or "gap" or "iron" or "mslo" or "pdox" => "defenses",
				_ => "other"
			};
		}

		/// <summary>
		/// Ranks a known enemy structure against the model's commitIntent <paramref name="commitPriority"/>
		/// (R5 bug 2: the picker used to sort alphabetically by type then cell, ignoring the intent). The
		/// requested category ranks first (0); otherwise a stable production-first default order applies, so
		/// an "economy" commit hits the refinery first but still falls through to production if none is
		/// known. any/blank/unknown priority uses the default order alone. Lower is better; callers break
		/// ties by distance from the army then cell.
		/// </summary>
		internal static int TargetPriorityRank(string commitPriority, string type)
		{
			var category = StructureCategory(type);
			var priority = PriorityOrAny(commitPriority);
			if (priority != "any" && string.Equals(category, priority, StringComparison.Ordinal))
				return 0;
			return category switch
			{
				"production" => 1,
				"economy" => 2,
				"power" => 3,
				"defenses" => 4,
				_ => 5
			};
		}

		static string PriorityOrAny(string priority)
		{
			if (string.IsNullOrWhiteSpace(priority))
				return "any";
			var key = priority.Trim().ToLowerInvariant();
			return key is "economy" or "production" or "power" or "defenses" or "any" ? key : "any";
		}
	}
}
