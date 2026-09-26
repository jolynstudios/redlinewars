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
using OpenRA.Mods.Common.Traits;

namespace OpenRA.Browser
{
	/// <summary>
	/// Machine-readable doctrine IR (not prose). Programs are version-matched to their strategy
	/// cards and validated against the live rules before binding. The host never parses prose.
	/// </summary>
	static class AgentDoctrineProgram
	{
		internal sealed class Program
		{
			public string StrategyId { get; init; }
			public int CardVersion { get; init; }
			public string Faction { get; init; }
			public int CashReserveForPlan { get; init; }
			public int MobilizeTankTarget { get; init; }
			public int ScoutExploredPercentTarget { get; init; }
			public string[] ScoutUnitTypes { get; init; }
			public Dictionary<string, int> ScoutTypeQuotas { get; init; } = new(StringComparer.Ordinal);
			public string[] MainUnitTypes { get; init; }
			public string[] StreamUnits { get; init; }

			// Standing unit-stream bounds. StreamMaxConcurrent caps how many of a streamed
			// type may be queued or in flight at once; StreamBatchCount is how many the host
			// queues per emission. Both keep the executor from monopolising cash or queues so
			// the model's decisions stay the measured variable (benchmark honesty).
			public int StreamMaxConcurrent { get; init; }
			public int StreamBatchCount { get; init; }
			public string MainSquadName { get; init; }
			public string ScoutSquadName { get; init; }
			public int CommitMinUnits { get; init; }
			public string CommitUnitType { get; init; }
			public string[] MainMissionOptions { get; init; } = [];
			public List<Phase> Phases { get; init; } = [];
			public string AbortSuggestStrategyId { get; init; }
		}

		internal sealed class Phase
		{
			public string Name { get; init; }
			public string Objective { get; init; }
			public int ExitMinUnitCount { get; init; }
			public int ExitMinExploredPercent { get; init; }
			public bool ExitRequiresEnemyStructureContact { get; init; }
			public string[] Standing { get; init; }
		}

		static readonly HashSet<string> SupportedStandingVerbs =
			new(["buildPlan", "streamUnits", "scoutSweep", "maintainSquads"], StringComparer.Ordinal);

		static readonly Dictionary<string, Program> Programs =
			new(StringComparer.Ordinal)
			{
				["soviet-tank-pressure"] = new Program
				{
					StrategyId = "soviet-tank-pressure",
					CardVersion = 2,
					Faction = "soviets",
					CashReserveForPlan = 500,
					MobilizeTankTarget = 6,
					ScoutExploredPercentTarget = 35,
					ScoutUnitTypes = ["ftrk", "e1"],
					ScoutTypeQuotas = new(StringComparer.Ordinal) { ["ftrk"] = 2, ["e1"] = 4 },
					MainUnitTypes = ["3tnk", "4tnk", "ftrk", "v2rl", "e3"],
					StreamUnits = ["3tnk", "ftrk"],
					StreamMaxConcurrent = 2,
					StreamBatchCount = 1,
					MainSquadName = "tanks",
					ScoutSquadName = "scouts",
					CommitMinUnits = 6,
					MainMissionOptions = ["strikeProduction", "raidEconomy", "scoutFrontier", "defer"],
					AbortSuggestStrategyId = "soviet-grenadier-rush",
					Phases =
					[
						new Phase
						{
							Name = "mobilize",
							Objective = "Reach a six-tank core without sacrificing scouting or anti-air coverage.",
							ExitMinUnitCount = 6,
							ExitMinExploredPercent = 35,
							ExitRequiresEnemyStructureContact = true,
							Standing = ["buildPlan", "streamUnits", "scoutSweep", "maintainSquads"]
						},
						new Phase
						{
							Name = "pressure",
							Objective = "Strike production with the main body; raid economy only with a bounded detachment.",
							ExitMinUnitCount = 0,
							ExitMinExploredPercent = 0,
							Standing = ["streamUnits", "maintainSquads"]
						}
					]
				},
				["soviet-grenadier-rush"] = new Program
				{
					StrategyId = "soviet-grenadier-rush",
					CardVersion = 2,
					Faction = "soviets",
					CashReserveForPlan = 300,
					MobilizeTankTarget = 8,
					ScoutExploredPercentTarget = 25,
					ScoutUnitTypes = ["e2"],
					ScoutTypeQuotas = new(StringComparer.Ordinal) { ["e2"] = 2 },
					MainUnitTypes = ["e2"],
					StreamUnits = ["e2"],
					StreamMaxConcurrent = 4,
					StreamBatchCount = 1,
					MainSquadName = "grenadiers",
					ScoutSquadName = "grenadier-scouts",
					CommitMinUnits = 8,
					CommitUnitType = "e2",
					MainMissionOptions = ["strikeProduction", "raidEconomy", "scoutFrontier", "defer"],
					AbortSuggestStrategyId = "soviet-tank-pressure",
					Phases =
					[
						new Phase
						{
							Name = "opening",
							Objective = "Scout with the first two grenadiers and mass eight more for the main body.",
							ExitMinUnitCount = 8,
							ExitMinExploredPercent = 25,
							ExitRequiresEnemyStructureContact = true,
							Standing = ["buildPlan", "streamUnits", "scoutSweep", "maintainSquads"]
						},
						new Phase
						{
							Name = "pressure",
							Objective = "Commit separated grenadier legs against known production or economy.",
							Standing = ["streamUnits", "maintainSquads"]
						}
					]
				},
				["allied-fast-boom"] = new Program
				{
					StrategyId = "allied-fast-boom",
					CardVersion = 2,
					Faction = "allies",
					CashReserveForPlan = 800,
					MobilizeTankTarget = 8,
					ScoutExploredPercentTarget = 35,
					ScoutUnitTypes = ["e1", "jeep"],
					ScoutTypeQuotas = new(StringComparer.Ordinal) { ["e1"] = 3, ["jeep"] = 2 },
					MainUnitTypes = ["2tnk", "e3"],
					StreamUnits = ["2tnk", "e3"],
					StreamMaxConcurrent = 2,
					StreamBatchCount = 1,
					MainSquadName = "boom-main",
					ScoutSquadName = "boom-raiders",
					CommitMinUnits = 8,
					MainMissionOptions = ["strikeProduction", "raidEconomy", "scoutFrontier", "defer"],
					AbortSuggestStrategyId = "allied-e3-mass",
					Phases =
					[
						new Phase
						{
							Name = "expand",
							Objective = "Establish two refineries while keeping a scout and raider screen.",
							ExitMinUnitCount = 8,
							ExitMinExploredPercent = 35,
							ExitRequiresEnemyStructureContact = true,
							Standing = ["buildPlan", "streamUnits", "scoutSweep", "maintainSquads"]
						},
						new Phase
						{
							Name = "convert",
							Objective = "Convert the income lead into sustained production pressure.",
							Standing = ["streamUnits", "maintainSquads"]
						}
					]
				},
				["allied-e3-mass"] = new Program
				{
					StrategyId = "allied-e3-mass",
					CardVersion = 2,
					Faction = "allies",
					CashReserveForPlan = 500,
					MobilizeTankTarget = 14,
					ScoutExploredPercentTarget = 30,
					ScoutUnitTypes = ["e1"],
					ScoutTypeQuotas = new(StringComparer.Ordinal) { ["e1"] = 4 },
					MainUnitTypes = ["e3", "e1", "medi"],
					StreamUnits = ["e3"],
					StreamMaxConcurrent = 4,
					StreamBatchCount = 1,
					MainSquadName = "rocket-main",
					ScoutSquadName = "rifle-scouts",
					CommitMinUnits = 14,
					CommitUnitType = "e3",
					MainMissionOptions = ["strikeProduction", "scoutFrontier", "defer"],
					AbortSuggestStrategyId = "allied-fast-boom",
					Phases =
					[
						new Phase
						{
							Name = "screen",
							Objective = "Scout with four riflemen and form a fourteen-rocket-soldier main screen.",
							ExitMinUnitCount = 14,
							ExitMinExploredPercent = 30,
							ExitRequiresEnemyStructureContact = true,
							Standing = ["buildPlan", "streamUnits", "scoutSweep", "maintainSquads"]
						},
						new Phase
						{
							Name = "pressure",
							Objective = "Advance the rocket screen in bounded, terrain-supported legs.",
							Standing = ["streamUnits", "maintainSquads"]
						}
					]
				}
			};

		internal static bool TryGet(string strategyId, out Program program)
		{
			return Programs.TryGetValue(strategyId ?? "", out program);
		}

		internal static IReadOnlyCollection<string> ProgramIds => Programs.Keys;

		internal static string Validate(Program program, int cardVersion, string factionSide, World world)
		{
			if (program == null)
				return "compiled doctrine program is missing";
			if (program.CardVersion != cardVersion)
				return $"compiled program v{program.CardVersion} does not match card v{cardVersion}";
			if (!string.Equals(program.Faction, factionSide, StringComparison.Ordinal))
				return $"compiled program faction '{program.Faction}' does not match '{factionSide}'";
			if (program.Phases == null || program.Phases.Count == 0 ||
				program.Phases.Any(phase => string.IsNullOrWhiteSpace(phase.Name)))
				return "compiled program must declare at least one named phase";
			if (program.Phases.Select(phase => phase.Name).Distinct(StringComparer.Ordinal).Count() != program.Phases.Count)
				return "compiled program phase names must be unique";

			var unknownVerb = program.Phases.SelectMany(phase => phase.Standing ?? [])
				.FirstOrDefault(verb => !SupportedStandingVerbs.Contains(verb));
			if (unknownVerb != null)
				return $"unsupported standing verb '{unknownVerb}'";

			var scoutTypes = (program.ScoutUnitTypes ?? []).Distinct(StringComparer.Ordinal).ToArray();
			var mainTypes = (program.MainUnitTypes ?? []).Distinct(StringComparer.Ordinal).ToArray();
			var streamTypes = (program.StreamUnits ?? []).Distinct(StringComparer.Ordinal).ToArray();
			if (scoutTypes.Length == 0 || mainTypes.Length == 0)
				return "compiled program must declare scout and main roster types";
			if (program.ScoutTypeQuotas.Any(quota => quota.Value <= 0 || !scoutTypes.Contains(quota.Key, StringComparer.Ordinal)))
				return "scout type quotas must be positive and reference scout roster types";
			foreach (var overlap in scoutTypes.Intersect(mainTypes, StringComparer.Ordinal))
				if (!program.ScoutTypeQuotas.ContainsKey(overlap))
					return $"overlapping roster type '{overlap}' requires an explicit scout quota";

			foreach (var type in scoutTypes.Concat(mainTypes).Concat(streamTypes).Distinct(StringComparer.Ordinal))
			{
				if (!world.Map.Rules.Actors.TryGetValue(type, out var actorInfo))
					return $"unknown doctrine actor type '{type}'";
				if (!AgentCombatRoster.IsEligibleType(actorInfo))
					return $"doctrine actor type '{type}' is economic, a building/base-builder, immobile, or unarmed";
				var prerequisites = actorInfo.TraitInfoOrDefault<BuildableInfo>()?.Prerequisites ?? [];
				var unavailable = factionSide == "allies"
					? prerequisites.Any(prerequisite => prerequisite is "~barr" || prerequisite.Contains(".soviet", StringComparison.Ordinal))
					: prerequisites.Any(prerequisite => prerequisite is "~tent" || prerequisite.Contains(".allies", StringComparison.Ordinal));
				if (unavailable)
					return $"doctrine actor type '{type}' is unavailable to faction '{factionSide}'";
			}

			if (program.CommitMinUnits <= 0 ||
				(program.CommitUnitType != null && !mainTypes.Contains(program.CommitUnitType, StringComparer.Ordinal)))
				return "compiled program commit threshold is invalid";
			return null;
		}
	}
}
