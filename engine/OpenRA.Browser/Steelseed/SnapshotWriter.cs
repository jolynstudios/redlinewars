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
	/// <summary>
	/// Little-endian cursor over a preallocated buffer, with the 4-byte alignment the
	/// frame contract requires. ARCHITECTURE.md §4 is the specification; if this file and
	/// §4 disagree the bug is here, and it is the worst class available to this project —
	/// a misread binary layout produces plausible geometry, not a crash.
	///
	/// A ref struct so it cannot escape to the heap or be captured in a closure: the whole
	/// point is that emitting a snapshot allocates nothing.
	/// </summary>
	public ref struct BufferWriter
	{
		readonly Span<byte> buffer;
		int pos;

		public BufferWriter(Span<byte> buffer)
		{
			this.buffer = buffer;
			pos = 0;
		}

		public int Position => pos;

		/// <summary>Bytes written so far, which is the snapshot's byteLength.</summary>
		public int Length => pos;

		public void Seek(int p) => pos = p;

		/// <summary>Pad to the next 4-byte boundary. Every section and array is aligned.</summary>
		public void Align4()
		{
			var target = (pos + 3) & ~3;
			while (pos < target)
				buffer[pos++] = 0;
		}

		public void U8(byte v) => buffer[pos++] = v;

		public void U16(ushort v)
		{
			BinaryPrimitives.WriteUInt16LittleEndian(buffer[pos..], v);
			pos += 2;
		}

		public void I16(short v)
		{
			BinaryPrimitives.WriteInt16LittleEndian(buffer[pos..], v);
			pos += 2;
		}

		public void U32(uint v)
		{
			BinaryPrimitives.WriteUInt32LittleEndian(buffer[pos..], v);
			pos += 4;
		}

		public void I32(int v)
		{
			BinaryPrimitives.WriteInt32LittleEndian(buffer[pos..], v);
			pos += 4;
		}

		/// <summary>Patch a u32 already written at an earlier offset (section lengths).</summary>
		public void PatchU32(int at, uint v) => BinaryPrimitives.WriteUInt32LittleEndian(buffer[at..], v);
	}

	/// <summary>
	/// Section ids, mirroring ARCHITECTURE.md §4.1. Values are contract — never renumber.
	/// </summary>
	public static class SectionId
	{
		public const ushort World = 0;
		public const ushort TerrainStatic = 1;
		public const ushort TerrainDelta = 2;
		public const ushort Actors = 3;
		public const ushort Lifecycle = 4;
		public const ushort Projectiles = 5;
		public const ushort Shroud = 6;
		public const ushort Events = 7;
		public const ushort Player = 8;
		public const ushort Production = 9;
	}

	public static class HeaderFlag
	{
		public const uint TerrainStaticPresent = 1 << 0;
		public const uint Paused = 1 << 1;
		public const uint Replay = 1 << 2;
		public const uint GameOver = 1 << 3;
	}

	public static class PlayerFlag
	{
		public const byte Alive = 1 << 0;
		public const byte IsRenderPlayer = 1 << 1;
		public const byte IsBot = 1 << 2;
		public const byte Won = 1 << 3;
		public const byte Lost = 1 << 4;
	}

	public static class ActorFlag
	{
		public const byte Disabled = 1 << 0;
		public const byte Cloaked = 1 << 1;
		public const byte Parachuting = 1 << 2;
		public const byte Husk = 1 << 3;
		public const byte Selected = 1 << 4;
		public const byte Firing = 1 << 5;
		public const byte Moving = 1 << 6;
		public const byte Submerged = 1 << 7;
	}

	public static class EventKind
	{
		public const ushort WeaponFire = 1;
		public const ushort ProjectileImpact = 2;
		public const ushort Explosion = 3;
		public const ushort ActorDamaged = 4;
		public const ushort ActorDestroyed = 5;
		public const ushort UnitMoving = 6;
		public const ushort StructureBuilt = 7;
		public const ushort ProductionComplete = 8;
		public const ushort ResourceHarvested = 9;
		public const ushort PowerState = 10;
		public const ushort OrderAccepted = 11;
		public const ushort Notify = 12;
	}

	public static class LifecycleKind
	{
		public const byte Created = 0;
		public const byte Destroyed = 1;
		public const byte Captured = 2;
		public const byte Sold = 3;
		public const byte HuskSpawned = 4;
	}

	/// <summary>
	/// Builds the section table as sections are written, then patches it into the header.
	/// Section count is bounded and small, so the table is a fixed inline array rather than
	/// a list — again, no per-tick allocation.
	/// </summary>
	public struct SectionTable
	{
		public const int MaxSections = 16;
		public const int HeaderBytes = 32;
		public const int EntryBytes = 12;

		ushort[] ids;
		int[] offsets;
		int[] lengths;
		int count;

		public static SectionTable Create() => new()
		{
			ids = new ushort[MaxSections],
			offsets = new int[MaxSections],
			lengths = new int[MaxSections],
			count = 0,
		};

		public readonly int Count => count;

		public void Reset() => count = 0;

		public void Add(ushort id, int offset, int length)
		{
			if (count >= MaxSections)
				throw new InvalidOperationException($"snapshot: more than {MaxSections} sections");

			ids[count] = id;
			offsets[count] = offset;
			lengths[count] = length;
			count++;
		}

		/// <summary>Bytes the header plus table occupy, i.e. where section payloads start.</summary>
		public static int PayloadStart(int sectionCount) => HeaderBytes + sectionCount * EntryBytes;

		/// <summary>
		/// Write header + table into the front of the buffer. Called last, once the real
		/// offsets and total length are known.
		/// </summary>
		public readonly void WriteHeader(Span<byte> buffer, uint tick, uint syncHash, uint gameTimeMs, uint flags, int byteLength)
		{
			var w = new BufferWriter(buffer);
			w.U32(SteelseedSnapshot.Magic);
			w.U16(SteelseedSnapshot.Version);
			w.U16((ushort)count);
			w.U32((uint)byteLength);
			w.U32(tick);
			w.U32(syncHash);
			w.U32(gameTimeMs);
			w.U32(flags);
			w.U32(0); // reserved

			for (var i = 0; i < count; i++)
			{
				w.U16(ids[i]);
				w.U16(0); // sectionFlags, unused at v1
				w.U32((uint)offsets[i]);
				w.U32((uint)lengths[i]);
			}
		}
	}

	public static class SteelseedSnapshot
	{
		/// <summary>'SSNP' little-endian. Asserted by the decoder on every snapshot.</summary>
		public const uint Magic = 0x504E5353;

		/// <summary>
		/// Bump on any layout change that is not a purely additive new section or event
		/// kind. The web decoder fails loudly on mismatch — see ARCHITECTURE.md §4.12.
		/// </summary>
		public const ushort Version = 1;
	}
}
