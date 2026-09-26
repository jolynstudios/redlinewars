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

using System.Collections.Generic;
using System.Linq;

namespace OpenRA.Browser
{
	// A deliberately small reliability floor for explicitly assisted matches.
	// It reads only the same fog-safe observation shown to the model and emits
	// one ordinary typed action that is validated by AgentModeHost.
	static class AgentFallbackController
	{
		static readonly string[] UnitPriority = ["e1", "e2", "3tnk", "2tnk", "1tnk", "ftrk"];

		internal static AgentAction ChooseAction(AgentObservation observation)
		{
			var alert = observation.Alerts
				.Where(a => a.StillActive && a.Cell != null)
				.OrderByDescending(a => a.Severity == "critical" ? 2 : a.Severity == "warning" ? 1 : 0)
				.ThenByDescending(a => a.FirstSeenTick)
				.FirstOrDefault();
			if (alert != null)
			{
				var defenders = observation.Actors
					.Where(a => a.Relationship == "self" && a.Idle && a.Capabilities.Contains("attackMove"))
					.OrderBy(a => DistanceSquared(a.CellX, a.CellY, alert.Cell.X, alert.Cell.Y))
					.ThenBy(a => a.ActorId)
					.Take(8)
					.Select(a => a.ActorId)
					.ToList();
				if (defenders.Count != 0)
					return ActorAction("attackMove", defenders, alert.Cell, false);
			}

			if (observation.HostTruth.BuildPlan?.Active != true)
			{
				var ready = observation.ProductionQueues
					.SelectMany(q => q.Items.Where(i => i.Placeable).Select(i => (Queue: q, Item: i)))
					.OrderBy(i => i.Queue.ProducerId)
					.ThenBy(i => i.Item.Item)
					.FirstOrDefault();
				if (ready.Item != null)
					return new AgentAction
					{
						Type = "placeBuildingAuto",
						ProducerId = ready.Queue.ProducerId,
						Item = ready.Item.Item
					};

				var desiredBuilding = DesiredBuilding(observation);
				var producer = FindProducer(observation, desiredBuilding);
				if (producer != null)
					return ProductionAction(producer.ProducerId, desiredBuilding, 1);

				foreach (var unit in UnitPriority)
				{
					producer = FindProducer(observation, unit);
					if (producer != null)
						return ProductionAction(producer.ProducerId, unit, unit is "e1" or "e2" ? 3 : 1);
				}
			}

			var deployable = observation.Actors
				.Where(a => a.Relationship == "self" && a.Capabilities.Contains("deploy"))
				.OrderBy(a => a.ActorId)
				.FirstOrDefault();
			if (deployable != null)
				return ActorAction("deploy", [deployable.ActorId], null, false);

			var frontier = observation.Scouting.Frontier.FirstOrDefault();
			var scout = observation.Actors
				.Where(a => a.Relationship == "self" && a.Idle && a.Capabilities.Contains("attackMove"))
				.OrderBy(a => a.ActorId)
				.FirstOrDefault();
			return frontier == null || scout == null ? null : ActorAction("attackMove", [scout.ActorId], frontier, false);
		}

		static string DesiredBuilding(AgentObservation observation)
		{
			if (!observation.HostTruth.BuildingCounts.TryGetValue("powr", out var powerPlants) || powerPlants == 0 ||
				observation.Player.PowerState != PowerState.Normal.ToString() ||
				observation.Player.PowerDrained > observation.Player.PowerProvided)
				return "powr";
			if (observation.HostTruth.RefineryCount < 1)
				return "proc";

			var infantryProduction = MissingBuildable(observation, ["barr", "tent"]);
			if (infantryProduction != null)
				return infantryProduction;
			if (observation.HostTruth.RefineryCount < 2)
				return "proc";

			return MissingBuildable(observation, ["weap"]);
		}

		static string MissingBuildable(AgentObservation observation, string[] alternatives)
		{
			var existing = alternatives.Any(type =>
				observation.HostTruth.BuildingCounts.TryGetValue(type, out var count) && count != 0);
			if (existing)
				return null;

			return alternatives.FirstOrDefault(type =>
				observation.ProductionQueues.Any(q => q.BuildableItems.Contains(type)));
		}

		static AgentProductionQueueObservation FindProducer(AgentObservation observation, string item)
		{
			if (item == null || observation.ProductionQueues.Any(q => q.Items.Any(i => i.Item == item)))
				return null;

			return observation.ProductionQueues
				.Where(q => q.BuildableItems.Contains(item))
				.OrderBy(q => q.ProducerId)
				.FirstOrDefault();
		}

		static AgentAction ProductionAction(uint producerId, string item, int count)
		{
			return new AgentAction
			{
				Type = "startProduction",
				ProducerId = producerId,
				Item = item,
				Count = count
			};
		}

		static AgentAction ActorAction(string type, List<uint> actorIds, AgentCellObservation cell, bool queued)
		{
			return new AgentAction
			{
				Type = type,
				ActorIds = actorIds,
				CellX = cell?.X ?? 0,
				CellY = cell?.Y ?? 0,
				Queued = queued
			};
		}

		static int DistanceSquared(int ax, int ay, int bx, int by)
		{
			var dx = ax - bx;
			var dy = ay - by;
			return dx * dx + dy * dy;
		}
	}
}
