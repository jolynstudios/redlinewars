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

using System.IO;
using OpenRA.Graphics;
using OpenRA.Primitives;

namespace OpenRA.Mods.Steelseed
{
	/// <summary>Supplies one transparent cursor frame without decoding an image asset.</summary>
	public sealed class AssetlessSpriteLoader : ISpriteLoader
	{
		public bool TryParseSprite(Stream stream, string filename, out ISpriteFrame[] frames, out TypeDictionary metadata)
		{
			metadata = new TypeDictionary();
			frames = [new AssetlessSpriteFrame()];
			return true;
		}

		sealed class AssetlessSpriteFrame : ISpriteFrame
		{
			public SpriteFrameType Type => SpriteFrameType.Bgra32;
			public Size Size => new(1, 1);
			public Size FrameSize => Size;
			public float2 Offset => float2.Zero;
			public byte[] Data { get; } = [0, 0, 0, 0];
			public bool DisableExportPadding => true;
		}
	}
}
