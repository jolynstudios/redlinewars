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
using System.Buffers.Binary;

namespace OpenRA.Steelseed
{
	public ref struct BufferWriter
	{
		readonly Span<byte> buffer;
		int position;

		public BufferWriter(Span<byte> buffer, int position = 0)
		{
			this.buffer = buffer;
			this.position = position;
		}

		public readonly int Position => position;

		public void Align4()
		{
			while ((position & 3) != 0)
				buffer[position++] = 0;
		}

		public void U8(byte value) => buffer[position++] = value;

		/// <summary>Bulk copy. One intrinsic call instead of one interpreted call per byte.</summary>
		public void Bytes(byte[] source, int count)
		{
			source.AsSpan(0, count).CopyTo(buffer.Slice(position, count));
			position += count;
		}

		public void I8(sbyte value) => buffer[position++] = unchecked((byte)value);

		public void U16(ushort value)
		{
			BinaryPrimitives.WriteUInt16LittleEndian(buffer[position..], value);
			position += sizeof(ushort);
		}

		public void I16(short value)
		{
			BinaryPrimitives.WriteInt16LittleEndian(buffer[position..], value);
			position += sizeof(short);
		}

		public void U32(uint value)
		{
			BinaryPrimitives.WriteUInt32LittleEndian(buffer[position..], value);
			position += sizeof(uint);
		}

		public void I32(int value)
		{
			BinaryPrimitives.WriteInt32LittleEndian(buffer[position..], value);
			position += sizeof(int);
		}

		/// <summary>Overwrite a u32 already written at `at` (a count known only after its records).</summary>
		public readonly void PatchU32(int at, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(buffer[at..], value);
	}

	public static class SnapshotContract
	{
		public const uint Magic = 0x504E5353;
		public const ushort Version = 2;
		public const int HeaderBytes = 32;
		public const int SectionEntryBytes = 12;

		public static class Section
		{
			public const ushort World = 0;
			public const ushort TerrainStatic = 1;
			public const ushort Actors = 3;
			public const ushort Lifecycle = 4;

			/// <summary>Live projectile flights and instantaneous beams. See WriteProjectiles.</summary>
			public const ushort Projectiles = 5;
			public const ushort Events = 7;
			public const ushort Shroud = 6;
			public const ushort Players = 8;
			public const ushort Production = 9;
			public const ushort FrozenActors = 10;
			public const ushort Resources = 11;
			public const ushort Deployments = 12;

			/// <summary>Timed states a visible unit carries (Iron Curtain, chronoshift return). See WriteActorStatus.</summary>
			public const ushort ActorStatus = 13;
		}

		public static class HeaderFlag
		{
			public const uint TerrainStaticPresent = 1 << 0;
			public const uint Paused = 1 << 1;
			public const uint Replay = 1 << 2;
			public const uint GameOver = 1 << 3;
		}

		// Semantic values in the existing Actors.animState u16; never authored clip indices.
		public static class AnimationState
		{
			public const ushort Prone = 2;
		}

		public static class ActorFlag
		{
			public const byte Disabled = 1 << 0;
			public const byte Cloaked = 1 << 1;
			public const byte Parachuting = 1 << 2;
			public const byte Husk = 1 << 3;
			public const byte Deployable = 1 << 4;
			public const byte Firing = 1 << 5;
			public const byte Moving = 1 << 6;
		}

		public static class PlayerFlag
		{
			public const byte Alive = 1 << 0;
			public const byte IsRenderPlayer = 1 << 1;
			public const byte IsBot = 1 << 2;
			public const byte Won = 1 << 3;
			public const byte Lost = 1 << 4;
		}
	}
}
