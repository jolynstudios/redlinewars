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
using System.Collections.ObjectModel;
using OpenRA.Graphics;
using OpenRA.Primitives;

namespace OpenRA.Mods.Steelseed
{
	/// <summary>
	/// Parses only the sequence metadata that can affect synchronized RA gameplay.  It
	/// deliberately never reserves or opens a sprite file.  STEELSEED draws actors from
	/// its procedural visual manifest; these transparent one-pixel sprites exist only so
	/// upstream traits can query facings and animation duration without an EA asset pack.
	/// </summary>
	public sealed class AssetlessSpriteSequenceLoader : ISpriteSequenceLoader
	{
		static readonly MiniYaml Empty = new(null);

		public IReadOnlyDictionary<string, ISpriteSequence> ParseSequences(
			ModData modData, string tileSet, SpriteCache cache, MiniYamlNode imageNode)
		{
			var result = new Dictionary<string, ISpriteSequence>();
			var defaultsNode = imageNode.Value.NodeWithKeyOrDefault("Defaults");
			var defaults = defaultsNode?.Value ?? Empty;

			foreach (var sequenceNode in imageNode.Value.Nodes)
			{
				if (sequenceNode.Key == "Defaults")
					continue;

				result.Add(sequenceNode.Key, new AssetlessSpriteSequence(
					imageNode.Key, sequenceNode.Key, sequenceNode.Value, defaults));
			}

			return new ReadOnlyDictionary<string, ISpriteSequence>(result);
		}
	}

	sealed class AssetlessSpriteSequence : ISpriteSequence
	{
		readonly string image;
		readonly int facings;
		readonly int? interpolatedFacings;
		readonly bool reverses;
		Sprite sprite;

		public string Name { get; }
		public int Length { get; private set; }
		public int Facings => interpolatedFacings ?? facings;
		public int Tick { get; }
		public int ZOffset { get; }
		public int ShadowZOffset { get; }
		public Rectangle Bounds { get; private set; }
		public bool IgnoreWorldTint => true;
		public float Scale => 1;

		public AssetlessSpriteSequence(string image, string name, MiniYaml data, MiniYaml defaults)
		{
			this.image = image;
			Name = name;
			Length = Load("Length", 1, data, defaults);
			facings = Math.Abs(Load("Facings", 1, data, defaults));
			interpolatedFacings = LoadNullableInt("InterpolatedFacings", data, defaults);
			Tick = Load("Tick", 40, data, defaults);
			ZOffset = Load("ZOffset", WDist.Zero, data, defaults).Length;
			ShadowZOffset = Load("ShadowZOffset", new WDist(-5), data, defaults).Length;
			reverses = Load("Reverses", false, data, defaults);

			if (Length <= 0)
				throw new YamlException($"Assetless sequence {image}.{name} must have a positive Length.");
			if (facings == 0 || facings > 1024 || !Exts.IsPowerOf2(facings))
				throw new YamlException($"Assetless sequence {image}.{name} has invalid Facings: {facings}.");
			if (interpolatedFacings != null &&
				(interpolatedFacings <= facings || interpolatedFacings > 1024 ||
					!Exts.IsPowerOf2(interpolatedFacings.Value)))
				throw new YamlException(
					$"Assetless sequence {image}.{name} has invalid InterpolatedFacings: {interpolatedFacings}.");
		}

		static T Load<T>(string key, T fallback, MiniYaml data, MiniYaml defaults)
		{
			var node = data.NodeWithKeyOrDefault(key) ?? defaults.NodeWithKeyOrDefault(key);
			return node == null ? fallback : FieldLoader.GetValue<T>(key, node.Value.Value);
		}

		static int? LoadNullableInt(string key, MiniYaml data, MiniYaml defaults)
		{
			var node = data.NodeWithKeyOrDefault(key) ?? defaults.NodeWithKeyOrDefault(key);
			return node == null ? null : FieldLoader.GetValue<int>(key, node.Value.Value);
		}

		public void ResolveSprites(SpriteCache cache)
		{
			if (sprite != null)
				return;

			var sheet = new Sheet(SheetType.BGRA, new Size(1, 1));
			sprite = new Sprite(sheet, new Rectangle(0, 0, 1, 1), TextureChannel.RGBA);
			Bounds = new Rectangle(0, 0, 1, 1);
			if (reverses && Length > 1)
				Length = 2 * Length - 2;
		}

		public Sprite GetSprite(int frame) => GetSprite(frame, WAngle.Zero);

		public Sprite GetSprite(int frame, WAngle facing)
		{
			if (sprite == null)
				throw new InvalidOperationException($"Assetless sequence {image}.{Name} has not been resolved.");
			return sprite;
		}

		public (Sprite Sprite, WAngle Rotation) GetSpriteWithRotation(int frame, WAngle facing)
		{
			var rotation = interpolatedFacings == null ? WAngle.Zero :
				Common.Util.GetInterpolatedFacingRotation(facing, facings, interpolatedFacings.Value);
			return (GetSprite(frame, facing), rotation);
		}

		public Sprite GetShadow(int frame, WAngle facing) => null;

		public float GetAlpha(int frame) => 0;
	}
}
