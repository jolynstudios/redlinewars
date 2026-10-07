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
using OpenRA.Graphics;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA.Mods.Steelseed
{
	[TraitLocation(SystemActors.World)]
	[Desc("Answers the resource queries upstream ResourceRenderer answers — which ore a cell shows — " +
		"without drawing anything. Harvester order targeting reads IResourceRenderer, so the assetless " +
		"mod needs one or a right-click on ore degrades to a plain move.")]
	public sealed class AssetlessResourceRendererInfo : TraitInfo, Requires<IResourceLayerInfo>
	{
		public override object Create(ActorInitializer init) { return new AssetlessResourceRenderer(init.Self); }
	}

	public sealed class AssetlessResourceRenderer : IResourceRenderer
	{
		readonly IResourceLayer layer;
		readonly string[] resourceTypes;

		public AssetlessResourceRenderer(Actor self)
		{
			layer = self.Trait<IResourceLayer>();
			resourceTypes = layer.Info is ResourceLayerInfo info
				? info.ResourceTypes.Keys.ToArray()
				: Array.Empty<string>();
		}

		IEnumerable<string> IResourceRenderer.ResourceTypes => resourceTypes;

		// The authoritative layer, read directly: upstream tracks it one tick late for its
		// sprite cache, and STEELSEED draws the same layer through snapshot section 11.
		string IResourceRenderer.GetRenderedResourceType(CPos cell)
		{
			var contents = layer.GetResource(cell);
			return contents.Density > 0 ? contents.Type : null;
		}

		string IResourceRenderer.GetRenderedResourceTooltip(CPos cell) { return null; }

		IEnumerable<IRenderable> IResourceRenderer.RenderUIPreview(WorldRenderer wr, string resourceType, int2 origin, float scale)
		{
			return Enumerable.Empty<IRenderable>();
		}

		IEnumerable<IRenderable> IResourceRenderer.RenderPreview(WorldRenderer wr, string resourceType, WPos origin)
		{
			return Enumerable.Empty<IRenderable>();
		}
	}
}
