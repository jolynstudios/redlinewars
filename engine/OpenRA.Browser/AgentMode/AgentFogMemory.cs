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
	/// <summary>
	/// Maintains the enemy structure memory that a player could derive from their own shroud.
	/// This deliberately reads only FrozenActor snapshot fields and never dereferences the
	/// mutable backing Actor, which may be hidden under fog.
	/// </summary>
	public static class AgentFogMemory
	{
		public sealed class State
		{
			internal readonly Dictionary<uint, int> LastSeenTicks = [];
		}

		public sealed class KnownStructure
		{
			public string Type { get; init; }
			public int CellX { get; init; }
			public int CellY { get; init; }
			public int LastSeenTick { get; init; }
		}

		public static IReadOnlyList<KnownStructure> Update(World world, Player viewer, State state)
		{
			ArgumentNullException.ThrowIfNull(world);
			ArgumentNullException.ThrowIfNull(viewer);
			ArgumentNullException.ThrowIfNull(state);

			var layer = viewer.FrozenActorLayer;
			if (layer == null)
			{
				state.LastSeenTicks.Clear();
				return [];
			}

			// FrozenActorsInRegion treats BottomRight as the exclusive spatial-partition edge,
			// so use the map bounds' exclusive Right/Bottom values here.
			var bounds = world.Map.Bounds;
			var region = new CellRegion(world.Map.Grid.Type,
				new CPos(bounds.Left, bounds.Top), new CPos(bounds.Right, bounds.Bottom));
			var frozenStructures = layer.FrozenActorsInRegion(region, false)
				.Where(fa => fa.Info.HasTraitInfo<BuildingInfo>() &&
					viewer.RelationshipWith(fa.Owner) == PlayerRelationship.Enemy)
				.OrderBy(fa => fa.ID)
				.ToArray();
			var presentIds = frozenStructures.Select(fa => fa.ID).ToHashSet();

			foreach (var staleId in state.LastSeenTicks.Keys.Where(id => !presentIds.Contains(id)).ToArray())
				state.LastSeenTicks.Remove(staleId);

			var result = new List<KnownStructure>();
			foreach (var frozen in frozenStructures)
			{
				var cell = world.Map.CellContaining(frozen.CenterPosition);
				if (!world.Map.Contains(cell))
					continue;

				// A visibility modifier can hide the backing actor even in a visible cell.
				// Do not refresh or expose memory from that state.
				if (frozen.Hidden)
					continue;

				// Visible == false means the live actor is currently visible to this player.
				// Recording the tick from that flag keeps lastSeenTick current without reading
				// the backing actor. Once it enters fog, the timestamp remains frozen.
				if (!frozen.Visible)
				{
					state.LastSeenTicks[frozen.ID] = world.WorldTick;
					continue;
				}

				// Shrouded snapshots have never been observed. Exposing them would leak
				// structures that this player has not discovered.
				if (frozen.Shrouded)
					continue;

				if (!state.LastSeenTicks.TryGetValue(frozen.ID, out var lastSeenTick))
				{
					lastSeenTick = world.WorldTick;
					state.LastSeenTicks.Add(frozen.ID, lastSeenTick);
				}

				result.Add(new KnownStructure
				{
					Type = frozen.Info.Name,
					CellX = cell.X,
					CellY = cell.Y,
					LastSeenTick = lastSeenTick
				});
			}

			return result
				.OrderByDescending(s => s.LastSeenTick)
				.ThenBy(s => s.Type, StringComparer.Ordinal)
				.ThenBy(s => s.CellY)
				.ThenBy(s => s.CellX)
				.ToArray();
		}
	}
}
