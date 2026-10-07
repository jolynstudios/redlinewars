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
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA
{
	[SupportedOSPlatform("browser")]
	public static partial class Program
	{
		// Placement ABI v1. Header is 40 bytes; each cell is x:i32, y:i32, flags:u8 + pad.
		const uint PlacementMagic = 0x4C505353; // "SSPL" little-endian
		const int PlacementHeaderBytes = 40;
		const int PlacementCellBytes = 12;
		const int PlacementShiftModifier = 1;
		static readonly byte[] PlacementBuffer = new byte[64 * 1024];
		static GCHandle PlacementPin;
		static int placementPointer;

		enum PlacementStatus : byte
		{
			Valid = 0,
			NoWorld = 1,
			Paused = 2,
			InvalidQueue = 3,
			UnknownActor = 4,
			NotBuilding = 5,
			QueueCannotBuild = 6,
			NotReady = 7,
			InvalidVariant = 8,
			OutsideMap = 9,
			Blocked = 10,
			OutOfBaseRadius = 11,
			NoPlugTarget = 12,
			InternalError = 255
		}

		enum PlacementOrderType : byte
		{
			None = 0,
			PlaceBuilding = 1,
			LineBuild = 2,
			PlacePlug = 3
		}

		readonly record struct PlacementCell(CPos Cell, byte Flags);

		sealed class PlacementQuery
		{
			public PlacementStatus Status;
			public PlacementOrderType OrderType;
			public World World;
			public Player Player;
			public ProductionQueue Queue;
			public ActorInfo BaseActorInfo;
			public ActorInfo ActorInfo;
			public BuildingInfo BuildingInfo;
			public CPos TopLeft;
			public int QueueId;
			public int Variant;
			public int Modifiers;
			public readonly List<PlacementCell> Cells = [];
		}

		static void EnsurePlacementPin()
		{
			if (PlacementPin.IsAllocated)
				return;

			PlacementPin = GCHandle.Alloc(PlacementBuffer, GCHandleType.Pinned);
			placementPointer = PlacementPin.AddrOfPinnedObject().ToInt32();
		}

		[JSExport]
		internal static int PlacementBufferPointer()
		{
			EnsurePlacementPin();
			return placementPointer;
		}

		[JSExport]
		internal static int PlacementBufferCapacity() => PlacementBuffer.Length;

		[JSExport]
		internal static int QueryBuildingPlacement(
			int queueId, string actorType, int cellX, int cellY, int variant, int modifiers)
		{
			try
			{
				return EncodePlacement(QueryPlacement(queueId, actorType, cellX, cellY, variant, modifiers));
			}
			catch
			{
				return EncodePlacement(new PlacementQuery { Status = PlacementStatus.InternalError });
			}
		}

		[JSExport]
		internal static int PlaceBuildingValidated(
			int queueId, string actorType, int cellX, int cellY, int variant, int modifiers)
		{
			try
			{
				// Never trust a preview result. The synchronized world, queue readiness, variant,
				// footprint, blockers and base radius are all recomputed at click time.
				var query = QueryPlacement(queueId, actorType, cellX, cellY, variant, modifiers);
				if (query.Status != PlacementStatus.Valid)
					return EncodePlacement(query);

				var orderString = query.OrderType switch
				{
					PlacementOrderType.LineBuild => "LineBuild",
					PlacementOrderType.PlacePlug => "PlacePlug",
					_ => "PlaceBuilding"
				};
				query.World.IssueOrder(new Order(
					orderString,
					query.Player.PlayerActor,
					Target.FromCell(query.World, query.TopLeft),
					false)
				{
					TargetString = query.BaseActorInfo.Name,
					ExtraData = query.Queue.Actor.ActorID,
					ExtraLocation = new CPos(query.Variant, 0),
					SuppressVisualFeedback = true
				});
				return EncodePlacement(query);
			}
			catch
			{
				return EncodePlacement(new PlacementQuery { Status = PlacementStatus.InternalError });
			}
		}

		static PlacementQuery QueryPlacement(
			int queueId, string actorType, int cellX, int cellY, int variant, int modifiers)
		{
			var result = new PlacementQuery
			{
				Status = PlacementStatus.NoWorld,
				OrderType = PlacementOrderType.None,
				QueueId = queueId,
				Variant = variant,
				Modifiers = modifiers,
				TopLeft = new CPos(cellX, cellY)
			};
			var world = Game.OrderManager?.World;
			var player = world?.RenderPlayer ?? world?.LocalPlayer;
			result.World = world;
			result.Player = player;
			if (world == null || player?.PlayerActor == null)
				return result;
			if (world.Paused || world.IsGameOver)
			{
				result.Status = PlacementStatus.Paused;
				return result;
			}

			var queues = player.PlayerActor.TraitsImplementing<ProductionQueue>()
				.Where(queue => queue.IsValidFaction).ToArray();
			if (queueId < 0 || queueId >= queues.Length)
			{
				result.Status = PlacementStatus.InvalidQueue;
				return result;
			}

			var queue = queues[queueId];
			result.Queue = queue;
			if (queue.Actor == null || queue.Actor.IsDead || !queue.Actor.IsInWorld || queue.Actor.Owner != player)
			{
				result.Status = PlacementStatus.InvalidQueue;
				return result;
			}

			if (string.IsNullOrEmpty(actorType) || !world.Map.Rules.Actors.TryGetValue(actorType, out var baseActorInfo))
			{
				result.Status = PlacementStatus.UnknownActor;
				return result;
			}

			result.BaseActorInfo = baseActorInfo;
			if (!baseActorInfo.HasTraitInfo<BuildingInfo>())
			{
				result.Status = PlacementStatus.NotBuilding;
				return result;
			}

			if (!queue.CanBuild(baseActorInfo))
			{
				result.Status = PlacementStatus.QueueCannotBuild;
				return result;
			}

			if (!queue.AllQueued().Any(item => item.Done && item.Item == baseActorInfo.Name))
			{
				result.Status = PlacementStatus.NotReady;
				return result;
			}

			var actorInfo = baseActorInfo;
			if (variant < 0)
			{
				result.Status = PlacementStatus.InvalidVariant;
				return result;
			}

			if (variant > 0)
			{
				var variantName = baseActorInfo.TraitInfos<PlaceBuildingVariantsInfo>()
					.SelectMany(info => info.Actors).Skip(variant - 1).FirstOrDefault();
				if (variantName == null || !world.Map.Rules.Actors.TryGetValue(variantName, out actorInfo))
				{
					result.Status = PlacementStatus.InvalidVariant;
					return result;
				}
			}

			result.ActorInfo = actorInfo;
			var buildingInfo = actorInfo.TraitInfoOrDefault<BuildingInfo>();
			if (buildingInfo == null)
			{
				result.Status = PlacementStatus.NotBuilding;
				return result;
			}

			result.BuildingInfo = buildingInfo;
			if (!world.Map.Contains(result.TopLeft))
			{
				result.Status = PlacementStatus.OutsideMap;
				return result;
			}

			var plugInfo = actorInfo.TraitInfoOrDefault<PlugInfo>();
			var lineInfo = actorInfo.TraitInfoOrDefault<LineBuildInfo>();
			if (plugInfo != null)
			{
				result.OrderType = PlacementOrderType.PlacePlug;
				var accepts = AcceptsPlug(world, result.TopLeft, plugInfo);
				result.Cells.Add(new PlacementCell(result.TopLeft, CellFlags(accepts, false)));
				result.Status = accepts ? PlacementStatus.Valid : PlacementStatus.NoPlugTarget;
				return result;
			}

			var closeEnough = buildingInfo.IsCloseEnoughToBase(world, player, actorInfo, result.TopLeft);
			var canPlace = world.CanPlaceBuilding(result.TopLeft, actorInfo, buildingInfo, null);
			var lineBuild = lineInfo != null && (modifiers & PlacementShiftModifier) == 0;
			result.OrderType = lineBuild ? PlacementOrderType.LineBuild : PlacementOrderType.PlaceBuilding;
			if (lineBuild && player.Shroud.IsExplored(result.TopLeft))
			{
				var segmentInfo = actorInfo;
				var segmentBuildingInfo = buildingInfo;
				if (!string.IsNullOrEmpty(lineInfo.SegmentType))
				{
					segmentInfo = world.Map.Rules.Actors[lineInfo.SegmentType];
					segmentBuildingInfo = segmentInfo.TraitInfo<BuildingInfo>();
				}

				foreach (var target in BuildingUtils.GetLineBuildCells(world, result.TopLeft, actorInfo, buildingInfo, player))
				{
					var valid = world.IsCellBuildable(target.Cell, segmentInfo, segmentBuildingInfo) &&
						segmentBuildingInfo.IsCloseEnoughToBase(world, player, segmentInfo, target.Cell);
					result.Cells.Add(new PlacementCell(target.Cell, CellFlags(valid, true)));
				}
			}

			if (result.Cells.All(cell => cell.Cell != result.TopLeft))
				result.Cells.Add(new PlacementCell(result.TopLeft,
					CellFlags(world.IsCellBuildable(result.TopLeft, actorInfo, buildingInfo) && closeEnough, false)));
			if (!lineBuild)
			{
				result.Cells.Clear();
				foreach (var tile in buildingInfo.Tiles(result.TopLeft))
					result.Cells.Add(new PlacementCell(tile,
						CellFlags(closeEnough && world.IsCellBuildable(tile, actorInfo, buildingInfo), false)));
			}

			result.Status = !closeEnough
				? PlacementStatus.OutOfBaseRadius
				: canPlace ? PlacementStatus.Valid : PlacementStatus.Blocked;
			return result;
		}

		static bool AcceptsPlug(World world, CPos cell, PlugInfo plug)
		{
			return world.ActorMap.GetActorsAt(cell)
				.SelectMany(actor => actor.TraitsImplementing<Pluggable>())
				.Any(pluggable => pluggable.AcceptsPlug(plug.Type));
		}

		static byte CellFlags(bool valid, bool lineBuild)
		{
			return (byte)((valid ? 1 : 2) | (lineBuild ? 4 : 0));
		}

		static int EncodePlacement(PlacementQuery query)
		{
			Array.Clear(PlacementBuffer);
			var maxCells = (PlacementBuffer.Length - PlacementHeaderBytes) / PlacementCellBytes;
			var cellCount = Math.Min(query.Cells.Count, maxCells);
			var length = PlacementHeaderBytes + cellCount * PlacementCellBytes;
			BinaryPrimitives.WriteUInt32LittleEndian(PlacementBuffer.AsSpan(0, 4), PlacementMagic);
			BinaryPrimitives.WriteUInt16LittleEndian(PlacementBuffer.AsSpan(4, 2), 1);
			PlacementBuffer[6] = (byte)query.Status;
			PlacementBuffer[7] = (byte)query.OrderType;
			BinaryPrimitives.WriteUInt32LittleEndian(PlacementBuffer.AsSpan(8, 4), (uint)length);
			BinaryPrimitives.WriteInt32LittleEndian(PlacementBuffer.AsSpan(12, 4), query.World?.WorldTick ?? -1);
			BinaryPrimitives.WriteUInt32LittleEndian(PlacementBuffer.AsSpan(16, 4), query.Queue?.Actor?.ActorID ?? 0);
			BinaryPrimitives.WriteUInt16LittleEndian(PlacementBuffer.AsSpan(20, 2), (ushort)Math.Clamp(query.QueueId, 0, ushort.MaxValue));
			BinaryPrimitives.WriteUInt16LittleEndian(PlacementBuffer.AsSpan(22, 2), (ushort)Math.Clamp(query.Variant, 0, ushort.MaxValue));
			BinaryPrimitives.WriteInt32LittleEndian(PlacementBuffer.AsSpan(24, 4), query.TopLeft.X);
			BinaryPrimitives.WriteInt32LittleEndian(PlacementBuffer.AsSpan(28, 4), query.TopLeft.Y);
			BinaryPrimitives.WriteUInt16LittleEndian(PlacementBuffer.AsSpan(32, 2), (ushort)Math.Clamp(query.BuildingInfo?.Dimensions.X ?? 0, 0, ushort.MaxValue));
			BinaryPrimitives.WriteUInt16LittleEndian(PlacementBuffer.AsSpan(34, 2), (ushort)Math.Clamp(query.BuildingInfo?.Dimensions.Y ?? 0, 0, ushort.MaxValue));
			BinaryPrimitives.WriteUInt16LittleEndian(PlacementBuffer.AsSpan(36, 2), (ushort)cellCount);
			BinaryPrimitives.WriteUInt16LittleEndian(PlacementBuffer.AsSpan(38, 2), (ushort)(query.Modifiers & ushort.MaxValue));
			for (var index = 0; index < cellCount; index++)
			{
				var offset = PlacementHeaderBytes + index * PlacementCellBytes;
				var cell = query.Cells[index];
				BinaryPrimitives.WriteInt32LittleEndian(PlacementBuffer.AsSpan(offset, 4), cell.Cell.X);
				BinaryPrimitives.WriteInt32LittleEndian(PlacementBuffer.AsSpan(offset + 4, 4), cell.Cell.Y);
				PlacementBuffer[offset + 8] = cell.Flags;
			}

			return length;
		}
	}
}
