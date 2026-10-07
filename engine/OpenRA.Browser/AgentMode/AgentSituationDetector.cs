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
using OpenRA.Traits;

namespace OpenRA.Browser
{
	/// <summary>
	/// Derives CP2 situation signals from information that is already visible to an agent player.
	/// This detector never issues orders or reads hidden actors, and only mutates its own State.
	/// </summary>
	static class AgentSituationDetector
	{
		const int RetreatContactRadiusSquared = 15 * 15;
		const int RetreatDistanceCells = 6;
		const int RetreatScanCount = 3;
		const int RetreatSampleIntervalTicks = 25;
		const int ReinforcementWindowTicks = 250;
		const int ReinforcementEnemyRadiusSquared = 10 * 10;

		internal sealed class State
		{
			internal CPos? ContactAnchor;
			internal int LastRetreatScanTick = -1;
			internal Queue<RetreatSample> RetreatSamples { get; } = [];
			internal Dictionary<string, SquadState> Squads { get; } = new(StringComparer.Ordinal);
		}

		internal sealed class SquadSnapshot
		{
			public string Name { get; init; }
			public IReadOnlyList<uint> ActorIds { get; init; } = [];
		}

		internal sealed class Signal
		{
			public string Kind { get; init; }
			public string Severity { get; init; }
			public string SquadName { get; init; }
			public CPos Cell { get; init; }
		}

		internal static Signal EvaluateEnemyRetreating(State state, World world, Player owner,
			Actor[] visibleEnemies, bool materialForceActive, CPos? contactAnchor)
		{
			ArgumentNullException.ThrowIfNull(state);
			ArgumentNullException.ThrowIfNull(world);
			ArgumentNullException.ThrowIfNull(owner);
			ArgumentNullException.ThrowIfNull(visibleEnemies);

			if (!materialForceActive)
			{
				ResetRetreat(state);
				return null;
			}

			// Keep one stable, fog-visible anchor for the duration of this material-contact
			// episode. ResetRetreat clears it when contact ends so a later engagement starts
			// from its own location instead of the first contact of the match.
			if (contactAnchor.HasValue && !state.ContactAnchor.HasValue)
			{
				state.ContactAnchor = contactAnchor;
				state.RetreatSamples.Clear();
				state.LastRetreatScanTick = -1;
			}

			if (!state.ContactAnchor.HasValue || (state.LastRetreatScanTick >= 0 &&
				world.WorldTick - state.LastRetreatScanTick < RetreatSampleIntervalTicks))
				return null;

			state.LastRetreatScanTick = world.WorldTick;
			var enemies = NormalizeVisibleEnemies(world, owner, visibleEnemies)
				.Where(enemy => (enemy.Location - state.ContactAnchor.Value).LengthSquared <= RetreatContactRadiusSquared)
				.ToArray();
			state.RetreatSamples.Enqueue(new RetreatSample(enemies
				.ToDictionary(enemy => enemy.ActorID, enemy => enemy.Location)));
			while (state.RetreatSamples.Count > RetreatScanCount)
				state.RetreatSamples.Dequeue();

			if (state.RetreatSamples.Count != RetreatScanCount)
				return null;

			var samples = state.RetreatSamples.ToArray();
			var stableActorIds = samples[0].ActorLocations.Keys
				.Where(id => samples[1].ActorLocations.ContainsKey(id) && samples[2].ActorLocations.ContainsKey(id))
				.Order()
				.ToArray();
			if (stableActorIds.Length < 2)
				return null;

			var centroids = samples
				.Select(sample => Centroid(stableActorIds.Select(id => sample.ActorLocations[id]).ToArray()))
				.ToArray();
			var distances = centroids
				.Select(cell => (cell - state.ContactAnchor.Value).Length)
				.ToArray();
			if (distances[1] <= distances[0] || distances[2] <= distances[1] ||
				distances[2] - distances[0] < RetreatDistanceCells)
				return null;

			return new Signal
			{
				Kind = "enemyRetreating",
				Severity = "warning",
				Cell = centroids[2]
			};
		}

		internal static IReadOnlyList<Signal> EvaluateReinforcementNeeded(State state, World world, Player owner,
			Actor[] visibleEnemies, IEnumerable<SquadSnapshot> squads)
		{
			ArgumentNullException.ThrowIfNull(state);
			ArgumentNullException.ThrowIfNull(world);
			ArgumentNullException.ThrowIfNull(owner);
			ArgumentNullException.ThrowIfNull(visibleEnemies);
			ArgumentNullException.ThrowIfNull(squads);

			var enemies = NormalizeVisibleEnemies(world, owner, visibleEnemies);
			var snapshots = squads
				.Where(s => s != null && !string.IsNullOrEmpty(s.Name))
				.GroupBy(s => s.Name, StringComparer.Ordinal)
				.Select(group => new SquadSnapshot
				{
					Name = group.Key,
					ActorIds = group.SelectMany(s => s.ActorIds ?? [])
						.Distinct().Order().ToArray()
				})
				.OrderBy(s => s.Name, StringComparer.Ordinal)
				.ToArray();
			var activeNames = snapshots.Select(s => s.Name).ToHashSet(StringComparer.Ordinal);
			foreach (var stale in state.Squads.Keys.Where(name => !activeNames.Contains(name)).ToArray())
				state.Squads.Remove(stale);

			var result = new List<Signal>();
			foreach (var snapshot in snapshots)
			{
				var actors = snapshot.ActorIds.Select(world.GetActorById)
					.Where(actor => IsUsableOwnActor(actor, world, owner))
					.OrderBy(actor => actor.ActorID)
					.ToArray();
				var liveCount = actors.Length;
				if (!state.Squads.TryGetValue(snapshot.Name, out var squadState))
				{
					squadState = new SquadState(liveCount, world.WorldTick);
					state.Squads.Add(snapshot.Name, squadState);
				}
				else if (liveCount >= squadState.HighWaterCount ||
					world.WorldTick - squadState.HighWaterTick > ReinforcementWindowTicks)
				{
					squadState.HighWaterCount = liveCount;
					squadState.HighWaterTick = world.WorldTick;
				}

				if (liveCount == 0 || squadState.HighWaterCount == 0 ||
					world.WorldTick - squadState.HighWaterTick > ReinforcementWindowTicks ||
					liveCount * 100 > squadState.HighWaterCount * 60)
					continue;

				var centroid = Centroid(actors);
				if (!enemies.Any(enemy => (enemy.Location - centroid).LengthSquared <= ReinforcementEnemyRadiusSquared))
					continue;

				result.Add(new Signal
				{
					Kind = "reinforcementNeeded",
					Severity = "critical",
					SquadName = snapshot.Name,
					Cell = centroid
				});
			}

			return result;
		}

		static Actor[] NormalizeVisibleEnemies(World world, Player owner, IEnumerable<Actor> visibleEnemies)
		{
			return visibleEnemies
				.Where(actor => actor != null && actor.World == world && actor.IsInWorld && !actor.IsDead &&
					!actor.Disposed && actor.OccupiesSpace != null && actor.Owner != null &&
					owner.RelationshipWith(actor.Owner) == PlayerRelationship.Enemy && actor.CanBeViewedByPlayer(owner) &&
					(actor.EffectiveOwner?.Disguised != true || (actor.EffectiveOwner.Owner != null &&
						owner.RelationshipWith(actor.EffectiveOwner.Owner) == owner.RelationshipWith(actor.Owner))))
				.GroupBy(actor => actor.ActorID)
				.Select(group => group.First())
				.OrderBy(actor => actor.ActorID)
				.ToArray();
		}

		static bool IsUsableOwnActor(Actor actor, World world, Player owner)
		{
			return actor != null && actor.World == world && actor.Owner == owner && actor.IsInWorld &&
				!actor.IsDead && !actor.Disposed && actor.OccupiesSpace != null;
		}

		static CPos Centroid(IReadOnlyCollection<Actor> actors)
		{
			return new CPos((int)(actors.Sum(actor => (long)actor.Location.X) / actors.Count),
				(int)(actors.Sum(actor => (long)actor.Location.Y) / actors.Count));
		}

		static CPos Centroid(IReadOnlyCollection<CPos> cells)
		{
			return new CPos((int)(cells.Sum(cell => (long)cell.X) / cells.Count),
				(int)(cells.Sum(cell => (long)cell.Y) / cells.Count));
		}

		static void ResetRetreat(State state)
		{
			state.ContactAnchor = null;
			state.RetreatSamples.Clear();
			state.LastRetreatScanTick = -1;
		}

		internal readonly record struct RetreatSample(IReadOnlyDictionary<uint, CPos> ActorLocations);

		internal sealed class SquadState(int highWaterCount, int highWaterTick)
		{
			public int HighWaterCount { get; set; } = highWaterCount;
			public int HighWaterTick { get; set; } = highWaterTick;
		}
	}
}
