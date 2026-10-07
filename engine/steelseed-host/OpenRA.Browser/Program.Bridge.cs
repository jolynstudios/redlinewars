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
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using OpenRA.Steelseed;
using OpenRA.Traits;

namespace OpenRA
{
	[SupportedOSPlatform("browser")]
	public static partial class Program
	{
		const int OrderSubjectCapacity = 1024;
		static readonly byte[] OrderSubjectBuffer = new byte[OrderSubjectCapacity * sizeof(uint)];
		static readonly SnapshotEmitter SnapshotEmitter = new();
		static readonly GCHandle[] SnapshotPins = new GCHandle[2];
		static readonly int[] SnapshotPointers = new int[2];
		static int lastSnapshotTick = -1;
		static uint lastSnapshotState = uint.MaxValue;

		static void EnsureSnapshotPins()
		{
			for (var slot = 0; slot < SnapshotPins.Length; slot++)
			{
				if (SnapshotPins[slot].IsAllocated)
					continue;

				SnapshotPins[slot] = GCHandle.Alloc(SnapshotEmitter.BufferForSlot(slot), GCHandleType.Pinned);
				SnapshotPointers[slot] = SnapshotPins[slot].AddrOfPinnedObject().ToInt32();
			}
		}

		[JSExport]
		internal static int PollSnapshotToken()
		{
			var world = Game.OrderManager?.World;
			if (world == null)
			{
				SnapshotEmitter.UnbindWorld();
				lastSnapshotTick = -1;
				lastSnapshotState = uint.MaxValue;
				return 0;
			}

			var state = (world.Paused ? 1u : 0u) | (world.IsGameOver ? 2u : 0u);
			if (lastSnapshotTick == world.WorldTick && lastSnapshotState == state)
				return 0;

			var emitWatch = System.Diagnostics.Stopwatch.StartNew();
			var length = SnapshotEmitter.Emit(world, world.RenderPlayer ?? world.LocalPlayer);
			emitWatch.Stop();
			if (emitWatch.ElapsedMilliseconds >= 20)
				Console.WriteLine($"[steelseed-host] snapshot emit {emitWatch.ElapsedMilliseconds} ms (tick {world.WorldTick}, {length} bytes)");
			EnsureSnapshotPins();
			lastSnapshotTick = world.WorldTick;
			lastSnapshotState = state;
			return SnapshotEmitter.ReadSlot == 0 ? length : -length;
		}

		[JSExport]
		internal static int SnapshotBufferGeneration()
		{
			EnsureSnapshotPins();
			return 1;
		}

		[JSExport]
		internal static int SnapshotBufferPointer(int slot)
		{
			EnsureSnapshotPins();
			if (slot is < 0 or > 1)
				throw new ArgumentOutOfRangeException(nameof(slot));
			return SnapshotPointers[slot];
		}

		[JSExport]
		internal static int SnapshotBufferCapacity(int slot)
		{
			if (slot is < 0 or > 1)
				throw new ArgumentOutOfRangeException(nameof(slot));
			return SnapshotEmitter.BufferForSlot(slot).Length;
		}

		[JSExport]
		internal static string SnapshotTypeTable() => SnapshotEmitter.TypeTable();

		[JSExport]
		internal static void SnapshotInvalidateTerrain()
		{
			SnapshotEmitter.InvalidateTerrain();
			lastSnapshotTick = -1;
		}

		[JSExport]
		[return: JSMarshalAs<JSType.MemoryView>]
		internal static ArraySegment<byte> OrderSubjectScratch() => new(OrderSubjectBuffer);

		[JSExport]
		internal static string IssueOrderN(string orderString, int subjectCount, int targetActorId,
			int targetCellX, int targetCellY, bool queued, string targetString, int extraData,
			int extraCellX, int extraCellY)
		{
			// ExtraData is an OpenRA uint: JS sends its 32 bits as an int (uint.MaxValue arrives
			// as -1, which Airstrike and Paratroopers read as "no direction"). ExtraLocation is
			// the Chronoshift source cell; -1 leaves it unset.
			var resolvedExtraData = unchecked((uint)extraData);
			var extraLocation = extraCellX >= 0 && extraCellY >= 0 ? new CPos(extraCellX, extraCellY) : CPos.Zero;
			if (subjectCount is < 0 or > OrderSubjectCapacity)
				return $"error: subject count {subjectCount} exceeds {OrderSubjectCapacity}";

			try
			{
				var world = Game.OrderManager?.World;
				var localPlayer = world?.RenderPlayer ?? world?.LocalPlayer;
				if (world == null || localPlayer?.PlayerActor == null)
					return "error: no local skirmish world";

				if (subjectCount == 0)
				{
					var target = TargetFor(world, targetActorId, targetCellX, targetCellY);
					if (resolvedExtraData == 0 && orderString is "PlaceBuilding" or "LineBuild" or "PlacePlug")
						resolvedExtraData = localPlayer.PlayerActor.ActorID;

					world.IssueOrder(new Order(orderString, localPlayer.PlayerActor, target, queued)
					{
						TargetString = string.IsNullOrEmpty(targetString) ? null : targetString,
						ExtraData = resolvedExtraData,
						ExtraLocation = extraLocation
					});
					return "ok: issued local player order";
				}

				var issued = 0;
				for (var index = 0; index < subjectCount; index++)
				{
					var offset = index * sizeof(uint);
					var actorId = (uint)(OrderSubjectBuffer[offset]
						| OrderSubjectBuffer[offset + 1] << 8
						| OrderSubjectBuffer[offset + 2] << 16
						| OrderSubjectBuffer[offset + 3] << 24);
					var subject = world.GetActorById(actorId);
					if (subject == null || !subject.IsInWorld || subject.IsDead || subject.Owner != localPlayer)
						continue;

					world.IssueOrder(new Order(orderString, subject,
						TargetFor(world, targetActorId, targetCellX, targetCellY), queued)
					{
						TargetString = string.IsNullOrEmpty(targetString) ? null : targetString,
						ExtraData = resolvedExtraData,
						ExtraLocation = extraLocation
					});
					issued++;
				}

				return $"ok: issued {issued}/{subjectCount} local orders";
			}
			catch (Exception e)
			{
				return $"error: {e.Message}";
			}
		}

		[JSExport]
		internal static string IssueContextOrderN(int subjectCount, int targetActorId,
			int targetCellX, int targetCellY, bool targetFrozen, int modifierBits)
		{
			if (subjectCount is < 1 or > OrderSubjectCapacity)
				return $"error: contextual subject count {subjectCount} is outside 1..{OrderSubjectCapacity}";

			try
			{
				var world = Game.OrderManager?.World;
				var localPlayer = world?.RenderPlayer ?? world?.LocalPlayer;
				if (world == null || localPlayer?.PlayerActor == null)
					return "error: no local skirmish world";
				if (world.IsGameOver)
					return "ignored: game is over";

				var targetCell = targetCellX >= 0 && targetCellY >= 0
					? new CPos(targetCellX, targetCellY)
					: CPos.Zero;
				var target = ContextTargetOrCell(world, localPlayer, targetActorId, targetCellX, targetCellY, targetFrozen);
				if (target.Type == TargetType.Invalid)
					return "error: contextual target is invalid or hidden";

				var modifiers = (TargetModifiers)(modifierBits &
					(int)(TargetModifiers.ForceAttack | TargetModifiers.ForceQueue | TargetModifiers.ForceMove));
				var queued = modifiers.HasModifier(TargetModifiers.ForceQueue);
				var issued = 0;
				var resolved = new List<string>();
				for (var index = 0; index < subjectCount; index++)
				{
					var offset = index * sizeof(uint);
					var actorId = (uint)(OrderSubjectBuffer[offset]
						| OrderSubjectBuffer[offset + 1] << 8
						| OrderSubjectBuffer[offset + 2] << 16
						| OrderSubjectBuffer[offset + 3] << 24);
					var subject = world.GetActorById(actorId);
					if (subject == null || !subject.IsInWorld || subject.IsDead || subject.Owner != localPlayer)
						continue;

					var order = ContextOrderFor(subject, target, targetCell, modifiers, queued);
					if (order == null)
						continue;
					world.IssueOrder(order);
					issued++;
					if (!resolved.Contains(order.OrderString))
						resolved.Add(order.OrderString);
				}

				// The order names are diagnostics for the presentation layer and its gates: which
				// OpenRA targeter won (Attack, Move, Harvest, ...) is otherwise invisible to JS.
				return issued > 0
					? $"ok: issued {issued}/{subjectCount} OpenRA contextual orders ({string.Join(",", resolved)})"
					: $"ignored: OpenRA found no valid contextual order for {subjectCount} subjects";
			}
			catch (Exception e)
			{
				return $"error: {e.Message}";
			}
		}

		// A preview invokes CanTarget only: it must never issue/queue an order or change ownership.
		[JSExport]
		internal static string QueryContextOrderN(int subjectCount, int targetActorId,
			int targetCellX, int targetCellY, bool targetFrozen, int modifierBits)
		{
			if (subjectCount is < 1 or > OrderSubjectCapacity)
				return "";
			var world = Game.OrderManager?.World;
			var player = world?.RenderPlayer ?? world?.LocalPlayer;
			if (world == null || player?.PlayerActor == null || world.IsGameOver)
				return "";
			var target = ContextTargetOrCell(world, player, targetActorId, targetCellX, targetCellY, targetFrozen);
			if (target.Type == TargetType.Invalid)
				return "";
			var cell = new CPos(targetCellX, targetCellY);
			var modifiers = (TargetModifiers)(modifierBits &
				(int)(TargetModifiers.ForceAttack | TargetModifiers.ForceQueue | TargetModifiers.ForceMove));
			var priority = int.MinValue;
			var result = "";
			var attackPriority = int.MinValue;
			var attack = "";
			var subjects = 0;
			for (var index = 0; index < subjectCount; index++)
			{
				var actorId = BitConverter.ToUInt32(OrderSubjectBuffer, index * sizeof(uint));
				var subject = world.GetActorById(actorId);
				if (subject == null || !subject.IsInWorld || subject.IsDead || subject.Owner != player)
					continue;
				var candidate = ContextTargeterFor(subject, target, cell, modifiers);
				if (!candidate.HasValue)
					continue;
				subjects++;
				// Attack and C4 both have stock priority 6. A lone specialist is described by
				// its special action instead of whichever rifleman was selected first.
				var name = candidate.Value.Targeter.OrderID;
				var answer = candidate.Value.Targeter.OrderID + "\n" + candidate.Value.Cursor;
				var rank = candidate.Value.Targeter.OrderPriority * 4 +
					(name is "Move" ? 0 : name is "Attack" or "ForceAttack" ? 1 : 2);
				if (rank > priority)
				{
					priority = rank;
					result = answer;
				}
				if (name is "Attack" or "ForceAttack" && candidate.Value.Targeter.OrderPriority > attackPriority)
				{
					attackPriority = candidate.Value.Targeter.OrderPriority;
					attack = answer;
				}
			}
			// A group with anyone who attacks shows the attack: an engineer, spy or Tanya in it
			// still takes their own order on the click (each subject does, as in OpenRA), but
			// the player is aiming the group, and the cursor must say it will fight.
			return subjects > 1 && attack.Length > 0 ? attack : result;
		}

		static Order ContextOrderFor(Actor subject, Target requestedTarget, CPos targetCell,
			TargetModifiers modifiers, bool queued)
		{
			var choice = ContextTargeterFor(subject, requestedTarget, targetCell, modifiers);
			return choice.HasValue
				? choice.Value.Trait.IssueOrder(subject, choice.Value.Targeter, choice.Value.Target, queued)
				: null;
		}

		static (IIssueOrder Trait, IOrderTargeter Targeter, Target Target, string Cursor)? ContextTargeterFor(
			Actor subject, Target requestedTarget, CPos targetCell, TargetModifiers modifiers)
		{
			if (subject.Disposed)
				return null;
			var candidates = subject.TraitsImplementing<IIssueOrder>()
				.SelectMany(trait => trait.Orders.Select(targeter => (Trait: trait, Targeter: targeter)))
				.OrderByDescending(candidate => candidate.Targeter.OrderPriority)
				.ToArray();
			// An actor this subject cannot target (scenery, a crate) is a click on its cell: the
			// ground pass decides it, instead of refusing the whole order.
			var target = requestedTarget;
			var firstPass = 0;
			if (!requestedTarget.IsValidFor(subject))
			{
				if (!subject.World.Map.Contains(targetCell))
					return null;
				target = Target.FromCell(subject.World, targetCell);
				firstPass = 1;
			}
			for (var pass = firstPass; pass < 2; pass++)
			{
				foreach (var candidate in candidates)
				{
					var localModifiers = modifiers;
					string cursor = null;
					if (candidate.Targeter.CanTarget(subject, target, ref localModifiers, ref cursor))
						return (candidate.Trait, candidate.Targeter, target, cursor ?? "");
				}
				if (!subject.World.Map.Contains(targetCell))
					break;
				target = Target.FromCell(subject.World, targetCell);
			}
			return null;
		}

		static Target ContextTargetFor(World world, Player localPlayer, int actorId,
			int cellX, int cellY, bool frozen)
		{
			if (actorId > 0 && frozen)
			{
				var remembered = localPlayer.FrozenActorLayer?.FromID((uint)actorId);
				return remembered == null || !remembered.IsValid || !remembered.Visible ||
					remembered.Hidden || remembered.Shrouded
					? Target.Invalid
					: Target.FromFrozenActor(remembered);
			}

			if (actorId > 0)
			{
				var actor = world.GetActorById((uint)actorId);
				if (actor == null || actor.IsDead || !actor.IsInWorld)
					return Target.Invalid;
				// The rule the snapshot publishes by: a building counts as seen when any of its cells
				// is (its visibility modifier checks the footprint). Also testing the centre cell
				// refused half-seen enemy buildings, so only a Ctrl attack-ground reached them.
				if (actor.Owner != localPlayer && !actor.CanBeViewedByPlayer(localPlayer))
					return Target.Invalid;
				return Target.FromActor(actor);
			}

			return cellX >= 0 && cellY >= 0 && world.Map.Contains(new CPos(cellX, cellY))
				? Target.FromCell(world, new CPos(cellX, cellY))
				: Target.Invalid;
		}

		/// <summary>
		/// The contextual target for a click. An actor the local player cannot target (gone, not
		/// viewable, a stale frozen record) turns into the clicked cell, exactly like a ground
		/// click: the presentation may offer scenery, a crate or a fogged building under the
		/// cursor, and OpenRA's targeters decide what the click on that cell means.
		/// </summary>
		static Target ContextTargetOrCell(World world, Player localPlayer, int actorId,
			int cellX, int cellY, bool frozen)
		{
			var target = ContextTargetFor(world, localPlayer, actorId, cellX, cellY, frozen);
			if (target.Type != TargetType.Invalid || actorId <= 0)
				return target;
			return cellX >= 0 && cellY >= 0 && world.Map.Contains(new CPos(cellX, cellY))
				? Target.FromCell(world, new CPos(cellX, cellY))
				: Target.Invalid;
		}

		[JSExport]
		internal static string SetPaused(bool paused)
		{
			var world = Game.OrderManager?.World;
			if (world == null)
				return "error: no skirmish world";
			world.SetPauseState(paused);
			return paused ? "ok: pausing" : "ok: resuming";
		}

		static Target TargetFor(World world, int actorId, int cellX, int cellY)
		{
			if (actorId > 0)
			{
				var actor = world.GetActorById((uint)actorId);
				return actor == null || actor.IsDead ? Target.Invalid : Target.FromActor(actor);
			}

			return cellX >= 0 && cellY >= 0 ? Target.FromCell(world, new CPos(cellX, cellY)) : Target.Invalid;
		}
	}
}
