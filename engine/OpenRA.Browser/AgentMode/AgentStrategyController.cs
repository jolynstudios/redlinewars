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
using System.IO;
using System.Linq;

namespace OpenRA.Browser
{
	static class AgentStrategyController
	{
		const int MaxEvents = 128;

		internal sealed class State
		{
			public string StrategyId { get; set; }
			public int CardVersion { get; set; }
			public int AdoptedTick { get; set; } = -1;
			public int LastSwitchTick { get; set; } = -1;
			public int SwitchCount { get; set; }
			public string ModelReason { get; set; }
			public long NextEventSequence { get; set; } = 1;
			public Queue<AgentStrategyEvent> Events { get; } = [];
		}

		internal static void ValidateMetadata(State state, AgentAction action, string factionSide)
		{
			if (string.IsNullOrWhiteSpace(action.StrategyId) ||
				!AgentStrategyCatalog.Entries.TryGetValue(action.StrategyId, out var strategy))
				throw new InvalidDataException($"unknown strategyId '{action.StrategyId}'");
			if (string.IsNullOrWhiteSpace(action.Reason) || action.Reason.Trim().Length > AgentModeLimits.MaxStrategyReasonChars)
				throw new InvalidDataException($"strategy reason must contain 1-{AgentModeLimits.MaxStrategyReasonChars} characters");
			if (action.Reason != action.Reason.Trim())
				throw new InvalidDataException("strategy reason must be trimmed");
			if (strategy.Faction != "both" && strategy.Faction != factionSide)
				throw new InvalidDataException($"strategy '{strategy.Id}' requires faction '{strategy.Faction}', not '{factionSide}'");
			if (state.StrategyId == strategy.Id)
				throw new InvalidDataException($"strategy '{strategy.Id}' is already active; update memo instead");
		}

		internal static void Adopt(State state, AgentAction action, int worldTick)
		{
			var strategy = AgentStrategyCatalog.Entries[action.StrategyId];
			var previous = state.StrategyId;
			if (previous == null)
				state.AdoptedTick = worldTick;
			else
			{
				state.SwitchCount++;
				state.LastSwitchTick = worldTick;
			}

			state.StrategyId = strategy.Id;
			state.CardVersion = strategy.Version;
			state.ModelReason = action.Reason;
			state.Events.Enqueue(new AgentStrategyEvent
			{
				Sequence = state.NextEventSequence++,
				WorldTick = worldTick,
				Kind = previous == null ? "adopted" : "switched",
				StrategyId = strategy.Id,
				CardVersion = strategy.Version,
				PreviousStrategyId = previous,
				CatalogVersion = AgentStrategyCatalog.CatalogVersion,
				ModelReason = action.Reason
			});
			while (state.Events.Count > MaxEvents)
				state.Events.Dequeue();
		}

		internal static AgentStrategyObservation Observe(State state, bool enabled)
		{
			return new AgentStrategyObservation
			{
				Enabled = enabled,
				StrategyId = state.StrategyId,
				CardVersion = state.CardVersion,
				CatalogVersion = AgentStrategyCatalog.CatalogVersion,
				AdoptedTick = state.AdoptedTick,
				LastSwitchTick = state.LastSwitchTick,
				SwitchCount = state.SwitchCount,
				ModelReason = state.ModelReason
			};
		}

		internal static AgentStrategyEventBatch GetEvents(State state, long sinceSequence)
		{
			return new AgentStrategyEventBatch
			{
				LatestSequence = state.NextEventSequence - 1,
				Events = state.Events.Where(entry => entry.Sequence > sinceSequence).ToList()
			};
		}

		internal static string NormalizeFactionSide(string side)
		{
			if (string.Equals(side, "Allies", StringComparison.OrdinalIgnoreCase))
				return "allies";
			if (string.Equals(side, "Soviet", StringComparison.OrdinalIgnoreCase))
				return "soviets";
			return side?.Trim().ToLowerInvariant() ?? "";
		}
	}
}
