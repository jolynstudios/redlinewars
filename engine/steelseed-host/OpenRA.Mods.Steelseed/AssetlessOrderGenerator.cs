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
using OpenRA.Graphics;
using OpenRA.Orders;

namespace OpenRA.Mods.Steelseed
{
	/// <summary>
	/// Browser input crosses the explicit binary/order bridge, so the OpenRA sprite UI
	/// order generator must not construct or read chrome metrics.
	/// </summary>
	public sealed class AssetlessOrderGenerator : IOrderGenerator
	{
		public AssetlessOrderGenerator(World world) { }

		public MouseButton ActionButton => MouseButton.Left;

		public IEnumerable<Order> Order(World world, CPos cell, int2 worldPixel, MouseInput mi) => [];

		public void Tick(World world) { }

		public IEnumerable<IRenderable> Render(WorldRenderer wr, World world) => [];

		public IEnumerable<IRenderable> RenderAboveShroud(WorldRenderer wr, World world) => [];

		public IEnumerable<IRenderable> RenderAnnotations(WorldRenderer wr, World world) => [];

		public string GetCursor(World world, CPos cell, int2 worldPixel, MouseInput mi) => null;

		public void Deactivate() { }

		public bool HandleKeyPress(KeyInput e) => false;

		public void SelectionChanged(World world, IEnumerable<Actor> selected) { }
	}
}
