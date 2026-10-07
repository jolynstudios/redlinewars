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
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.Steelseed
{
	/// <summary>Read-only resource presentation, with the same fog memory as ResourceRenderer.</summary>
	sealed class ResourceSnapshot
	{
		readonly World world;
		readonly Rectangle bounds;
		readonly IResourceLayer layer;
		readonly ResourceLayerContents[] initial;
		readonly Dictionary<Player, ResourceLayerContents[]> remembered = [];
		readonly byte[] types;
		readonly byte[] densities;
		readonly byte[] maxima;
		Player lastPlayer;
		uint revision;
		int lastWalkTick = int.MinValue;
		int lastShroudHash = int.MinValue;

		/// <summary>Ore changes at harvester pace. Under the interpreter a full walk costs tens of milliseconds, so it runs at most this often.</summary>
		const int RescanTicks = 5;

		public ResourceSnapshot(World world, Rectangle bounds)
		{
			this.world = world;
			this.bounds = bounds;
			layer = world.WorldActor.TraitOrDefault<IResourceLayer>();
			var count = bounds.Width * bounds.Height;
			initial = new ResourceLayerContents[count];
			types = new byte[count];
			densities = new byte[count];
			maxima = new byte[count];
			if (layer == null)
				return;

			// Upstream initializes its fogged render cache from the initial ResourceLayer,
			// including recalculated densities, so Explored Map reveals the original ore.
			for (var y = 0; y < bounds.Height; y++)
				for (var x = 0; x < bounds.Width; x++)
					initial[y * bounds.Width + x] = layer.GetResource(new CPos(bounds.Left + x, bounds.Top + y));
		}

		public void Write(ref BufferWriter writer, Player player)
		{
			ResourceLayerContents[] known = null;
			if (player != null && !remembered.TryGetValue(player, out known))
			{
				known = (ResourceLayerContents[])initial.Clone();
				remembered.Add(player, known);
			}

			var changed = player != lastPlayer;
			var shroudHash = player?.Shroud?.Hash ?? 0;
			// Re-walk on a player change, when the shroud revealed something, or every
			// RescanTicks ticks for harvesting; every other tick re-emits the last planes.
			var walk = changed || known == null || shroudHash != lastShroudHash ||
				world.WorldTick - lastWalkTick >= RescanTicks;
			lastPlayer = player;
			if (walk)
			{
				lastWalkTick = world.WorldTick;
				lastShroudHash = shroudHash;
				var rectangular = world.Map.Grid.Type == MapGridType.Rectangular;
				for (var y = 0; y < bounds.Height; y++)
				{
					for (var x = 0; x < bounds.Width; x++)
					{
						var index = y * bounds.Width + x;
						var cell = new CPos(bounds.Left + x, bounds.Top + y);
						byte type = 0, density = 0, maximum = 0;
						if (known != null && layer != null && (rectangular || world.Map.Contains(cell)))
						{
							var visible = rectangular
								? player.Shroud.IsVisible(new MPos(cell.X, cell.Y))
								: player.Shroud.IsVisible(cell);
							if (visible)
								known[index] = layer.GetResource(cell);

							var resource = known[index];
							// Cheap tests first: most cells hold no ore, and the explored
							// lookup is the expensive one under the interpreter.
							if (resource.Type != null && resource.Density > 0 &&
								(visible || player.Shroud.IsExplored(cell)) &&
								layer.Info.TryGetResourceIndex(resource.Type, out type))
							{
								density = resource.Density;
								maximum = layer.GetMaxDensity(resource.Type);
							}
						}

						if (types[index] != type || densities[index] != density || maxima[index] != maximum)
						{
							types[index] = type;
							densities[index] = density;
							maxima[index] = maximum;
							changed = true;
						}
					}
				}
			}

			if (changed)
				revision++;

			writer.U16((ushort)bounds.Width);
			writer.U16((ushort)bounds.Height);
			writer.U32(revision);
			writer.Bytes(types, types.Length);
			writer.Bytes(densities, densities.Length);
			writer.Bytes(maxima, maxima.Length);
		}
	}
}
