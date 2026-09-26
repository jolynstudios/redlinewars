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
using System.Collections.Immutable;
using System.Linq;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.Mods.Common.Traits
{
	[TraitLocation(SystemActors.Player)]
	[Desc("Attach this to the player actor (not a building!) to define a new shared build queue.",
		"Will only work together with the Production: trait on the actor that actually does the production.",
		"You will also want to add PrimaryBuildings: to let the user choose where new units should exit.")]
	public class ClassicProductionQueueInfo : ProductionQueueInfo, Requires<TechTreeInfo>, Requires<PlayerResourcesInfo>
	{
		[Desc("If you build more actors of the same type,", "the same queue will get its build time lowered for every actor produced there.")]
		public readonly bool SpeedUp = false;

		[Desc("Every time another production building of the same queue is",
			"constructed, the build times of all actors in the queue",
			"decreased by a percentage of the original time.")]
		public readonly ImmutableArray<int> BuildTimeSpeedReduction = [100, 86, 75, 67, 60, 55, 50];

		public override object Create(ActorInitializer init) { return new ClassicProductionQueue(init, this); }
	}

	public class ClassicProductionQueue : ProductionQueue
	{
		static readonly ActorInfo[] NoItems = [];

		readonly Actor self;
		readonly ClassicProductionQueueInfo info;
		Actor presentationProducer;

		public ClassicProductionQueue(ActorInitializer init, ClassicProductionQueueInfo info)
			: base(init, info)
		{
			self = init.Self;
			this.info = info;
		}

		protected override void Tick(Actor self)
		{
			// PERF: Avoid LINQ.
			Enabled = false;
			var isActive = false;
			Actor best = null;
			var bestPaused = true;
			var bestPrimary = false;
			foreach (var x in self.World.ActorsWithTrait<Production>())
			{
				if (x.Trait.IsTraitDisabled)
					continue;

				if (x.Actor.Owner != self.Owner || !x.Trait.Info.Produces.Contains(Info.Type))
					continue;

				Enabled |= IsValidFaction;
				isActive |= !x.Trait.IsTraitPaused;

				var paused = x.Trait.IsTraitPaused;
				var primary = x.Actor.IsPrimaryBuilding();
				if (best == null || paused != bestPaused && !paused ||
					paused == bestPaused && primary != bestPrimary && primary ||
					paused == bestPaused && primary == bestPrimary && x.Actor.ActorID > best.ActorID)
				{
					best = x.Actor;
					bestPaused = paused;
					bestPrimary = primary;
				}
			}
			presentationProducer = best;

			if (!Enabled)
				ClearQueue();

			TickInner(self, !isActive);
		}

		public override IEnumerable<ActorInfo> AllItems()
		{
			return Enabled ? base.AllItems() : NoItems;
		}

		public override IEnumerable<ActorInfo> BuildableItems()
		{
			return Enabled ? base.BuildableItems() : NoItems;
		}

		public override TraitPair<Production> MostLikelyProducer()
		{
			var best = default(TraitPair<Production>);
			var bestPaused = true;
			var bestPrimary = false;
			foreach (var candidate in self.World.ActorsWithTrait<Production>())
			{
				if (candidate.Actor.Owner != self.Owner || candidate.Trait.IsTraitDisabled ||
					!candidate.Trait.Info.Produces.Contains(Info.Type))
					continue;

				var paused = candidate.Trait.IsTraitPaused;
				var primary = candidate.Actor.IsPrimaryBuilding();
				bool replace;
				if (best.Actor == null)
					replace = true;
				else if (paused != bestPaused)
					replace = !paused;
				else if (primary != bestPrimary)
					replace = primary;
				else
					replace = candidate.Actor.ActorID > best.Actor.ActorID;

				if (replace)
				{
					best = candidate;
					bestPaused = paused;
					bestPrimary = primary;
				}
			}

			return best;
		}

		public override Actor PresentationMostLikelyProducerActor => presentationProducer;

		protected override bool BuildUnit(ActorInfo unit)
		{
			// Find a production structure to build this actor
			var bi = unit.TraitInfo<BuildableInfo>();

			// Some units may request a specific production type, which is ignored if the AllTech cheat is enabled
			var type = developerMode.AllTech ? Info.Type : (bi.BuildAtProductionType ?? Info.Type);

			var producers = self.World.ActorsWithTrait<Production>()
				.Where(x => x.Actor.Owner == self.Owner
					&& !x.Trait.IsTraitDisabled
					&& x.Trait.Info.Produces.Contains(type))
					.OrderByDescending(x => x.Actor.IsPrimaryBuilding())
					.ThenByDescending(x => x.Actor.ActorID);

			var anyProducers = false;
			foreach (var p in producers)
			{
				anyProducers = true;
				if (p.Trait.IsTraitPaused)
					continue;

				var inits = new TypeDictionary
				{
					new OwnerInit(self.Owner),
					new FactionInit(BuildableInfo.GetInitialFaction(unit, p.Trait.Faction))
				};

				var item = Queue.First(i => i.Done && i.Item == unit.Name);
				if (p.Trait.Produce(p.Actor, unit, type, inits, item.TotalCost))
				{
					EndProduction(item);
					return true;
				}
			}

			if (!anyProducers)
				CancelProduction(unit.Name, 1);

			return false;
		}

		public override int GetBuildTime(ActorInfo unit, BuildableInfo bi)
		{
			if (developerMode.FastBuild)
				return 0;

			var time = base.GetBuildTime(unit, bi);

			if (info.SpeedUp)
			{
				var type = bi.BuildAtProductionType ?? info.Type;

				var selfsameProductionsCount = self.World.ActorsWithTrait<Production>()
					.Count(p => !p.Trait.IsTraitDisabled && !p.Trait.IsTraitPaused && p.Actor.Owner == self.Owner && p.Trait.Info.Produces.Contains(type));

				var speedModifier = selfsameProductionsCount.Clamp(1, info.BuildTimeSpeedReduction.Length) - 1;
				time = time * info.BuildTimeSpeedReduction[speedModifier] / 100;
			}

			return time;
		}
	}
}
