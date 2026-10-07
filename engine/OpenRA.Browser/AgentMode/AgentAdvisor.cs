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
using OpenRA.Traits;

namespace OpenRA.Browser
{
	public static class AgentAdvisor
	{
		const int DefaultMinBaseRadius = 2;
		const int DefaultMaxBaseRadius = 20;
		const int MaxHints = 6;
		const int MaxHintLength = 120;

		public static CPos? ChoosePlacementCell(World world, Player player, ActorInfo actorInfo, BuildingInfo buildingInfo)
		{
			var baseBuilder = GetBaseBuilderInfo(world);
			var anchors = GetConstructionYards(world, player, baseBuilder).ToArray();
			if (anchors.Length == 0)
			{
				anchors = world.Actors
					.Where(a => IsUsableOwnActor(a, player) &&
						a.TraitsImplementing<GivesBuildableArea>().Any(g => g.AreaTypes.Count != 0))
					.OrderBy(a => a.ActorID)
					.ToArray();
			}

			var minRadius = baseBuilder?.MinBaseRadius ?? DefaultMinBaseRadius;
			var maxRadius = baseBuilder?.MaxBaseRadius ?? DefaultMaxBaseRadius;
			foreach (var anchor in anchors)
			{
				var bias = anchor.Location;
				if (actorInfo.TraitInfoOrDefault<RefineryInfo>() != null)
					bias = FindNearestExploredResource(world, player, anchor.Location) ?? bias;
				else if (baseBuilder?.DefenseTypes.Contains(actorInfo.Name) == true)
					bias = FindNearestVisibleEnemy(world, player, anchor.Location) ?? bias;

				var candidate = world.Map.FindTilesInAnnulus(anchor.Location, minRadius, maxRadius)
					.OrderBy(c => (c - bias).LengthSquared)
					.ThenBy(c => c.Y)
					.ThenBy(c => c.X)
					.Where(c => player.Shroud.IsVisible(c) &&
						world.CanPlaceBuilding(c, actorInfo, buildingInfo, null) &&
						buildingInfo.IsCloseEnoughToBase(world, player, actorInfo, c))
					.Select(c => (CPos?)c)
					.FirstOrDefault();
				if (candidate.HasValue)
					return candidate.Value;
			}

			return null;
		}

		public static int GetMaxBaseRadius(World world)
		{
			return GetBaseBuilderInfo(world)?.MaxBaseRadius ?? DefaultMaxBaseRadius;
		}

		public static AgentBaseObservation BuildBaseObservation(World world, Player player)
		{
			var baseBuilder = GetBaseBuilderInfo(world);
			var navalTypes = baseBuilder?.NavalProductionTypes;
			var buildRadius = world.Map.Rules.Actors.Values
				.Where(a => navalTypes == null || !navalTypes.Contains(a.Name))
				.Select(a => a.TraitInfoOrDefault<RequiresBuildableAreaInfo>())
				.Where(r => r != null && r.AreaTypes.Contains("building"))
				.Select(r => r.Adjacent)
				.DefaultIfEmpty(2)
				.Max();

			return new AgentBaseObservation
			{
				BuildRadius = buildRadius,
				Yards = GetConstructionYards(world, player, baseBuilder)
					.Select(a => new AgentBaseYardObservation
					{
						ActorId = a.ActorID,
						X = a.Location.X,
						Y = a.Location.Y
					})
					.ToList()
			};
		}

		public static AgentScoutingObservation SurveyShroud(World world, Player player)
		{
			var sampled = new List<CPos>();
			var unexplored = new List<CPos>();
			foreach (var cell in world.Map.AllCells)
			{
				if (!world.Map.Contains(cell))
					continue;

				if (((cell.X - world.Map.Bounds.Left) & 1) != 0 || ((cell.Y - world.Map.Bounds.Top) & 1) != 0)
					continue;

				sampled.Add(cell);
				if (!player.Shroud.IsExplored(cell))
					unexplored.Add(cell);
			}

			var ownCells = world.Actors
				.Where(a => IsUsableOwnActor(a, player))
				.OrderBy(a => a.ActorID)
				.Select(a => a.Location)
				.ToArray();
			var mapCenter = new CPos(
				(world.Map.Bounds.Left + world.Map.Bounds.Right - 1) / 2,
				(world.Map.Bounds.Top + world.Map.Bounds.Bottom - 1) / 2);
			var frontierCandidates = unexplored
				.Where(c => world.Map.Contains(c) &&
					AdjacentCells(c).Any(a => world.Map.Contains(a) && player.Shroud.IsExplored(a)))
				.OrderBy(c => ownCells.Length == 0 ? (c - mapCenter).LengthSquared : ownCells.Min(o => (c - o).LengthSquared))
				.ThenBy(c => c.Y)
				.ThenBy(c => c.X);

			var frontier = new List<AgentCellObservation>();
			foreach (var candidate in frontierCandidates)
			{
				if (frontier.Any(f => (candidate - new CPos(f.X, f.Y)).LengthSquared < 64))
					continue;

				frontier.Add(new AgentCellObservation { X = candidate.X, Y = candidate.Y });
				if (frontier.Count == 3)
					break;
			}

			var explored = sampled.Count - unexplored.Count;
			return new AgentScoutingObservation
			{
				ExploredPercent = sampled.Count == 0 ? 0 : explored * 100 / sampled.Count,
				Frontier = frontier
			};
		}

		public static List<string> BuildHints(World world, Player player, AgentObservation observation)
		{
			var hints = new List<string>();
			var baseBuilder = GetBaseBuilderInfo(world);
			var ready = observation.ProductionQueues
				.SelectMany(q => q.Items.Select(i => (Queue: q, Item: i)))
				.FirstOrDefault(i => i.Item.Placeable);
			if (ready.Item != null)
				AddHint(hints, $"READY: place {ready.Item.Item} from producer {ready.Queue.ProducerId} with placeBuildingAuto.");

			var deployable = observation.Actors.FirstOrDefault(a => a.Relationship == "self" && a.Capabilities.Contains("deploy"));
			if (deployable != null)
				AddHint(hints, $"Deploy actor {deployable.ActorId} to establish a Construction Yard before producing buildings.");

			if (observation.Player.PowerState != PowerState.Normal.ToString() ||
				observation.Player.PowerDrained > observation.Player.PowerProvided)
			{
				// A power plant the player cannot pay for never completes: under
				// the combined broke+low-power state the honest priority is
				// income, not the plant. 300 is powr's rules cost.
				if (observation.Player.Cash + observation.Player.Resources < 300)
					AddHint(hints, "Low power AND cash below a power plant's cost: restore income first — a plant you cannot afford never completes.");
				else
					AddHint(hints, "Low power slows production by 3x; prioritize a power plant before other structures.");
			}

			var refineryTypes = baseBuilder?.RefineryTypes;
			var refineryCount = world.Actors.Count(a => IsUsableOwnActor(a, player) &&
				(refineryTypes?.Contains(a.Info.Name) == true || a.Info.HasTraitInfo<RefineryInfo>()));
			if (refineryCount < 2)
				AddHint(hints, $"Economy has {refineryCount}/2 refineries; produce and auto-place a refinery when possible.");

			var harvesterCount = world.Actors.Count(a => IsUsableOwnActor(a, player) && a.Info.HasTraitInfo<HarvesterInfo>());
			var hasVehicleQueue = observation.ProductionQueues.Any(q => q.BuildableItems.Contains("harv"));
			var harvCap = AgentDoctrineExecutor.HarvesterSoftCap(refineryCount);
			if (refineryCount > 0 && harvesterCount < Math.Min(refineryCount + 1, harvCap) && hasVehicleQueue)
				AddHint(hints, $"Income depends on harvesters: {harvesterCount} for {refineryCount} refineries; produce a harvester.");
			else if (refineryCount > 0 && harvesterCount >= harvCap)
				AddHint(hints,
					$"Harvester soft cap reached ({harvesterCount}/{harvCap}). Do NOT queue more harv — " +
					"produce combat units and commitIntent strike/hold when army is ready.");

			var cashThreshold = baseBuilder?.NewProductionCashThreshold ?? 5000;
			var productionTypes = baseBuilder?.ProductionTypes;
			var hasIdleProductionQueue = observation.ProductionQueues.Any(q => q.Items.Count == 0 &&
				(productionTypes == null || q.BuildableItems.Any(productionTypes.Contains)));
			if (cashThreshold > 0 && observation.Player.Cash + observation.Player.Resources > cashThreshold && hasIdleProductionQueue)
				AddHint(hints, $"Cash exceeds {cashThreshold} with an idle queue; add a production structure or produce units.");

			if (observation.Player.ResourceCapacity > 0 &&
				observation.Player.Resources * 100 >= observation.Player.ResourceCapacity * 80)
				AddHint(hints, "Resource storage is at least 80% full; build a silo or spend resources before capacity is lost.");

			if (observation.Scouting.ExploredPercent < 60)
				AddHint(hints, "Under 60% of the map is explored; send a cheap fast unit toward a scouting.frontier cell.");

			return hints;
		}

		static BaseBuilderBotModuleInfo GetBaseBuilderInfo(World world)
		{
			return world.Map.Rules.Actors[SystemActors.Player]
				.TraitInfos<BaseBuilderBotModuleInfo>()
				.FirstOrDefault(i => i.InstanceName == "normal");
		}

		static IEnumerable<Actor> GetConstructionYards(World world, Player player, BaseBuilderBotModuleInfo baseBuilder)
		{
			if (baseBuilder == null)
				return [];

			return world.Actors
				.Where(a => IsUsableOwnActor(a, player) && baseBuilder.ConstructionYardTypes.Contains(a.Info.Name))
				.OrderBy(a => a.ActorID);
		}

		static CPos? FindNearestExploredResource(World world, Player player, CPos anchor)
		{
			var resourceLayer = world.WorldActor.TraitOrDefault<IResourceLayer>();
			if (resourceLayer == null)
				return null;

			return world.Map.AllCells
				.Where(c => player.Shroud.IsExplored(c) && resourceLayer.GetResource(c).Type != null)
				.OrderBy(c => (c - anchor).LengthSquared)
				.ThenBy(c => c.Y)
				.ThenBy(c => c.X)
				.Cast<CPos?>()
				.FirstOrDefault();
		}

		static CPos? FindNearestVisibleEnemy(World world, Player player, CPos anchor)
		{
			return world.Actors
				.Where(a => a.IsInWorld && !a.IsDead && !a.Disposed && a.Owner != null && a.OccupiesSpace != null &&
					player.RelationshipWith(a.Owner) == PlayerRelationship.Enemy && a.CanBeViewedByPlayer(player))
				.OrderBy(a => (a.Location - anchor).LengthSquared)
				.ThenBy(a => a.Location.Y)
				.ThenBy(a => a.Location.X)
				.Select(a => (CPos?)a.Location)
				.FirstOrDefault();
		}

		static IEnumerable<CPos> AdjacentCells(CPos cell)
		{
			yield return cell + new CVec(-1, 0);
			yield return cell + new CVec(1, 0);
			yield return cell + new CVec(0, -1);
			yield return cell + new CVec(0, 1);
		}

		static bool IsUsableOwnActor(Actor actor, Player player)
		{
			return actor.Owner == player && actor.IsInWorld && !actor.IsDead && !actor.Disposed && actor.OccupiesSpace != null;
		}

		static void AddHint(List<string> hints, string hint)
		{
			if (hints.Count == MaxHints)
				return;

			hints.Add(hint.Length <= MaxHintLength ? hint : hint[..(MaxHintLength - 1)] + "…");
		}
	}
}
