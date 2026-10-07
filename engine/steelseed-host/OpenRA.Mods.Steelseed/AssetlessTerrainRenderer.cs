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
using OpenRA.Graphics;
using OpenRA.Mods.Common.Terrain;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA.Mods.Steelseed
{
	[TraitLocation(SystemActors.World | SystemActors.EditorWorld)]
	public sealed class AssetlessTerrainRendererInfo : TraitInfo<AssetlessTerrainRenderer>, ITiledTerrainRendererInfo
	{
		bool ITiledTerrainRendererInfo.ValidateTileSprites(ITemplatedTerrainInfo terrainInfo, Action<string> onError) => false;
	}

	/// <summary>
	/// Satisfies the terrain-renderer contract used by bridge rules, while deliberately
	/// emitting nothing.  Terrain cells are exported through the binary snapshot and are
	/// rendered procedurally by STEELSEED.
	/// </summary>
	public sealed class AssetlessTerrainRenderer : IRenderTerrain
	{
		public AssetlessTerrainRenderer() { }

		void IRenderTerrain.RenderTerrain(WorldRenderer wr, Viewport viewport) { }
	}
}
