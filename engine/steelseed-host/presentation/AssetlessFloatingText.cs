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
using OpenRA.Effects;
using OpenRA.Graphics;
using OpenRA.Mods.Common.Graphics;
using OpenRA.Primitives;

namespace OpenRA.Mods.Common.Effects
{
	/// <summary>
	/// Host-only presentation adapter for upstream FloatingText. Retains effect timing
	/// and formatting while the 3D client owns text display. The assetless renderer has
	/// no TinyBold font; looking it up during a refinery delivery used to stop World.Tick.
	/// No income, storage, spending, harvesting, or production rules are changed here.
	/// </summary>
	public class FloatingText : IEffect, IEffectAnnotation
	{
		static readonly WVec Velocity = new(0, 0, 86);

		int remaining;
		WPos pos;

		public FloatingText(WPos pos, Color color, string text, int duration)
		{
			this.pos = pos;
			remaining = duration;
		}

		void IEffect.Tick(World world)
		{
			if (--remaining <= 0)
				world.AddFrameEndTask(w => w.Remove(this));

			pos += Velocity;
		}

		IEnumerable<IRenderable> IEffect.Render(WorldRenderer wr) { return SpriteRenderable.None; }

		IEnumerable<IRenderable> IEffectAnnotation.RenderAnnotation(WorldRenderer wr) { return SpriteRenderable.None; }

		public static string FormatCashTick(int cashAmount)
		{
			return $"{(cashAmount < 0 ? "-" : "+")}${Math.Abs(cashAmount)}";
		}
	}
}
