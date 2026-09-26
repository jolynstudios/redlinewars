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
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using OpenRA.Steelseed;
using OpenRA.Traits;

namespace OpenRA
{
	/// <summary>
	/// The STEELSEED bridge's interop surface — the only channel between simulation and
	/// presentation (ARCHITECTURE.md §4). No side channels, no reaching into traits from
	/// JS, no reflection.
	///
	/// Exports live here beside the other [JSExport]s rather than on the emitter class so
	/// the whole interop seam is greppable in one place, and so the emitter stays a plain
	/// testable object with no browser dependency.
	/// </summary>
	[SupportedOSPlatform("browser")]
	public static partial class Program
	{
		const int OrderSubjectCapacity = 1024;

		static SnapshotEmitter emitter;
		static int lastEmittedTick = -1;
		static uint lastEmittedWorldState = uint.MaxValue;

		// Snapshot arrays are raw-addressed by the JS adapter. They stay pinned until a
		// rare growth transaction replaces them, at which point both slots are republished
		// and the generation changes before PollSnapshotToken returns the new slot.
		static byte[] pinnedSnapshotA;
		static byte[] pinnedSnapshotB;
		static GCHandle snapshotPinA;
		static GCHandle snapshotPinB;
		static int snapshotPointerA;
		static int snapshotPointerB;
		static int snapshotCapacityA;
		static int snapshotCapacityB;
		static int snapshotBufferGeneration;

		// Lent to JS once as a writable MemoryView. Every order then crosses the hot
		// boundary as primitives/strings only; a JS-owned typed array never enters a
		// [JSExport] parameter.
		static readonly byte[] OrderSubjectScratchBuffer = new byte[OrderSubjectCapacity * sizeof(uint)];

		/// <summary>
		/// Last failure from the emit path, surfaced through BridgeDiagnostics().
		///
		/// This exists because the first revision caught emit exceptions into a
		/// Log.Write and returned an empty view, which is indistinguishable from
		/// "no world yet" on the JS side — the harness saw byteLength 0 and had
		/// nothing to go on. A swallowed error in the one channel between simulation
		/// and presentation is the worst place to hide information.
		/// </summary>
		static string lastEmitError;
		static int emitCount;
		static int emitFailures;
		static long lastEmitAllocatedBytes = -1;
		static int snapshotAllocationProbeBytes;

		static SnapshotEmitter Emitter => emitter ??= new SnapshotEmitter();

		static uint WorldStateFlags(World world)
		{
			uint flags = 0;
			if (world.Paused)
				flags |= HeaderFlag.Paused;
			if (world.IsGameOver)
				flags |= HeaderFlag.GameOver;
			if (world.IsReplay)
				flags |= HeaderFlag.Replay;
			return flags;
		}

		static void EnsureSnapshotPins()
		{
			var bufferA = Emitter.BufferForSlot(0);
			var bufferB = Emitter.BufferForSlot(1);
			if (ReferenceEquals(bufferA, pinnedSnapshotA) &&
				ReferenceEquals(bufferB, pinnedSnapshotB) &&
				snapshotPinA.IsAllocated && snapshotPinB.IsAllocated)
				return;

			// Pin the replacement pair before releasing the old handles. The host is
			// single-threaded, but this also keeps the old JS aliases valid until every
			// replacement address is known and ready to publish as one generation.
			GCHandle nextPinA = default;
			GCHandle nextPinB = default;
			int nextPointerA;
			int nextPointerB;
			try
			{
				nextPinA = GCHandle.Alloc(bufferA, GCHandleType.Pinned);
				nextPinB = GCHandle.Alloc(bufferB, GCHandleType.Pinned);
				nextPointerA = nextPinA.AddrOfPinnedObject().ToInt32();
				nextPointerB = nextPinB.AddrOfPinnedObject().ToInt32();
			}
			catch
			{
				if (nextPinA.IsAllocated)
					nextPinA.Free();
				if (nextPinB.IsAllocated)
					nextPinB.Free();
				throw;
			}

			if (snapshotPinA.IsAllocated)
				snapshotPinA.Free();
			if (snapshotPinB.IsAllocated)
				snapshotPinB.Free();

			pinnedSnapshotA = bufferA;
			pinnedSnapshotB = bufferB;
			snapshotPinA = nextPinA;
			snapshotPinB = nextPinB;
			snapshotPointerA = nextPointerA;
			snapshotPointerB = nextPointerB;
			snapshotCapacityA = bufferA.Length;
			snapshotCapacityB = bufferB.Length;

			unchecked
			{
				snapshotBufferGeneration++;
				if (snapshotBufferGeneration == 0)
					snapshotBufferGeneration = 1;
			}
		}

		/// <summary>
		/// Why the last PollSnapshot produced nothing, plus counters. Diagnostic only —
		/// never used to drive rendering.
		/// </summary>
		[JSExport]
		internal static string BridgeDiagnostics()
		{
			var world = Game.OrderManager?.World;
			return string.Join("\n",
				$"world={(world == null ? "null" : "live")}",
				$"worldTick={world?.WorldTick.ToString() ?? "-"}",
				$"lastEmittedTick={lastEmittedTick}",
				$"lastEmittedWorldState={lastEmittedWorldState}",
				$"emitCount={emitCount}",
				$"emitFailures={emitFailures}",
				$"readLength={(emitter?.ReadLength ?? 0)}",
				$"bufferGeneration={snapshotBufferGeneration}",
				$"typeCount={(emitter?.TypeCount ?? 0)}",
				$"lastSection={emitter?.CurrentSection ?? "-"}",
				$"lastError={lastEmitError ?? "(none)"}");
		}

		/// <summary>
		/// Raw managed bytes allocated by the most recent successful snapshot emission,
		/// including steady-state pin validation. Diagnostic only: the external harness
		/// owns workload pinning and comparison so the value cannot grade itself.
		/// </summary>
		[JSExport]
		internal static double SnapshotLastEmitAllocatedBytes() => lastEmitAllocatedBytes;

		/// <summary>
		/// Deliberate falsification hook for the external allocation gate. A positive value
		/// allocates one byte array inside the measured snapshot boundary on every emitted
		/// tick. Production and the normal gate path leave this at zero.
		/// </summary>
		[JSExport]
		internal static void SnapshotSetAllocationProbeBytes(int bytes)
		{
			if (bytes < 0 || bytes > 1 << 20)
				throw new ArgumentOutOfRangeException(nameof(bytes));

			snapshotAllocationProbeBytes = bytes;
		}

		/// <summary>
		/// Run one line of an ARCHITECTURE.md §1.4 text order-script.
		///
		/// §1.4 rules that replays are generated from committed TEXT order-scripts and never
		/// from committed `.orarep` binaries (rule 13). This is the export that consumes one,
		/// so `playtest.mjs` can drive a whole match — build, expand, engage, defend — from a
		/// file a human can read and diff, rather than from an opaque recording.
		///
		/// One line per call rather than a whole script in one go, deliberately: a script runs
		/// ACROSS ticks, and swallowing the whole file here would either block the sim thread
		/// or need a scheduler inside the bridge. Sequencing belongs to the harness, which
		/// already knows the tick from the snapshot header.
		///
		/// Grammar — whitespace-separated, `#` starts a comment:
		/// <code>
		///   order &lt;OrderString&gt; [subject=&lt;actorId&gt;[,&lt;actorId&gt;...]] [cell=&lt;x&gt;,&lt;y&gt;]
		///                        [actor=&lt;targetActorId&gt;] [str=&lt;TargetString&gt;] [n=&lt;ExtraData&gt;] [queued]
		/// </code>
		/// Omitting <c>subject=</c> issues on the player actor, which is how production and
		/// building placement are expressed.
		///
		/// Returns a human-readable result string; anything starting with "failed" or "bad"
		/// is an error the harness must surface rather than skip.
		/// </summary>
		[JSExport]
		internal static string RunOrderScriptLine(string line)
		{
			try
			{
				if (string.IsNullOrWhiteSpace(line))
					return "skipped: blank";

				var hash = line.IndexOf('#');
				if (hash >= 0)
					line = line[..hash];
				line = line.Trim();
				if (line.Length == 0)
					return "skipped: comment";

				var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
				if (parts.Length < 2 || parts[0] != "order")
					return $"bad line (expected 'order <OrderString> ...'): {line}";

				var orderString = parts[1];
				var subjects = Array.Empty<uint>();
				var targetActorId = 0;
				var cellX = -1;
				var cellY = -1;
				string targetString = null;
				var extra = 0;
				var queued = false;

				for (var i = 2; i < parts.Length; i++)
				{
					var p = parts[i];
					if (p == "queued") { queued = true; continue; }

					var eq = p.IndexOf('=');
					if (eq <= 0)
						return $"bad token '{p}' in: {line}";

					var key = p[..eq];
					var val = p[(eq + 1)..];

					switch (key)
					{
						case "subject":
							var ids = val.Split(',', StringSplitOptions.RemoveEmptyEntries);
							subjects = new uint[ids.Length];
							for (var k = 0; k < ids.Length; k++)
							{
								if (!uint.TryParse(ids[k], out subjects[k]))
									return $"bad actor id '{ids[k]}' in: {line}";
							}

							break;
						case "cell":
							var xy = val.Split(',');
							if (xy.Length != 2 || !int.TryParse(xy[0], out cellX) || !int.TryParse(xy[1], out cellY))
								return $"bad cell '{val}' in: {line}";
							break;
						case "actor":
							if (!int.TryParse(val, out targetActorId))
								return $"bad target actor '{val}' in: {line}";
							break;
						case "str":
							targetString = val;
							break;
						case "n":
							if (!int.TryParse(val, out extra))
								return $"bad extra data '{val}' in: {line}";
							break;
						default:
							return $"unknown key '{key}' in: {line}";
					}
				}

				// Reuses IssueOrder so the script path and the UI path cannot diverge — two
				// implementations of "issue an order" is exactly how a harness ends up
				// proving something the game does not actually do.
				var bytes = new byte[subjects.Length * 4];
				for (var i = 0; i < subjects.Length; i++)
				{
					var id = subjects[i];
					bytes[i * 4] = (byte)(id & 0xff);
					bytes[i * 4 + 1] = (byte)((id >> 8) & 0xff);
					bytes[i * 4 + 2] = (byte)((id >> 16) & 0xff);
					bytes[i * 4 + 3] = (byte)((id >> 24) & 0xff);
				}

				return IssueOrderCore(orderString, new ArraySegment<byte>(bytes), targetActorId, cellX, cellY, queued, targetString, extra);
			}
			catch (Exception e)
			{
				return $"failed: {e.Message}";
			}
		}

		/// <summary>
		/// The simulation's own tick and sync hash, observed WITHOUT touching the snapshot
		/// emitter. This is the measurement seam for `synccheck.mjs`: the
		/// gate compares the per-tick hash sequence with the emitter on and off, and it can
		/// only do that honestly if the emitter-off run has some way to read a hash that is
		/// not the emitter itself.
		///
		/// Safe to call at any cadence. <see cref="World.SyncHash"/> is a pure read — it
		/// folds actor state, ISync fields and synced effects, and it reads
		/// <c>SharedRandom.Last</c> rather than calling <c>Next()</c>, so it observes the
		/// lockstep RNG without advancing it. A probe that perturbed the sim would
		/// contaminate both runs and make the gate meaningless.
		///
		/// Returned as one atomic string so tick and hash cannot be read from either side
		/// of a tick boundary.
		/// </summary>
		[JSExport]
		internal static string GetSyncProbe()
		{
			var world = Game.OrderManager?.World;
			if (world == null)
				return "tick=- hash=- world=null";

			return $"tick={world.WorldTick} hash={unchecked((uint)world.SyncHash())}";
		}

		/// <summary>
		/// Pack the current world into the back buffer and return a primitive token.
		///
		/// Zero is exact "no new tick". Positive values name slot 0 and negative values
		/// name slot 1; the absolute value is the payload length. The JS host aliases the
		/// separately exported pinned pointer/capacity pair, so no per-poll proxy or copy
		/// crosses the boundary.
		/// </summary>
		[JSExport]
		internal static int PollSnapshotToken()
		{
			try
			{
				var world = Game.OrderManager?.World;
				if (world == null)
				{
					emitter?.UnbindWorld();
					lastEmittedTick = -1;
					lastEmittedWorldState = uint.MaxValue;
					lastEmitAllocatedBytes = -1;
					return 0;
				}

				var activeEmitter = Emitter;
				if (activeEmitter.BindWorld(world))
				{
					lastEmittedTick = -1;
					lastEmittedWorldState = uint.MaxValue;
				}

				// One snapshot per changed presentation state. Polling faster than the sim is
				// normal and must not repack, but pause/game-over can change while WorldTick is
				// held. Dedupe on both or the UI can never observe a pause at the held tick.
				var worldState = WorldStateFlags(world);
				if (world.WorldTick == lastEmittedTick && worldState == lastEmittedWorldState)
					return 0;

				lastEmitAllocatedBytes = -1;
				var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
				if (snapshotAllocationProbeBytes != 0)
					GC.KeepAlive(new byte[snapshotAllocationProbeBytes]);

				var length = activeEmitter.Emit(world, world.RenderPlayer ?? world.LocalPlayer);
				EnsureSnapshotPins();
				lastEmitAllocatedBytes = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
				lastEmittedTick = world.WorldTick;
				lastEmittedWorldState = worldState;
				emitCount++;
				lastEmitError = null;
				return activeEmitter.ReadSlot == 0 ? length : -length;
			}
			catch (Exception e)
			{
				emitFailures++;
				lastEmitError = e.ToString();
				Log.Write("debug", $"STEELSEED: snapshot emit failed: {e}");
				throw new InvalidOperationException(
					"STEELSEED snapshot emission failed; inspect BridgeDiagnostics().", e);
			}
		}

		[JSExport]
		internal static int SnapshotBufferGeneration()
		{
			EnsureSnapshotPins();
			return snapshotBufferGeneration;
		}

		[JSExport]
		internal static int SnapshotBufferPointer(int slot)
		{
			EnsureSnapshotPins();
			return slot switch
			{
				0 => snapshotPointerA,
				1 => snapshotPointerB,
				_ => throw new ArgumentOutOfRangeException(nameof(slot)),
			};
		}

		[JSExport]
		internal static int SnapshotBufferCapacity(int slot)
		{
			EnsureSnapshotPins();
			return slot switch
			{
				0 => snapshotCapacityA,
				1 => snapshotCapacityB,
				_ => throw new ArgumentOutOfRangeException(nameof(slot)),
			};
		}

		/// <summary>
		/// Actor type names, newline separated, index == the typeId in the actor section.
		/// Read once after map load; the table only grows, and ids are stable within a run.
		/// </summary>
		[JSExport]
		internal static string SnapshotTypeTable() => Emitter.TypeTable();

		/// <summary>
		/// Tell the emitter to re-send terrain.static, which is otherwise emitted once.
		/// Called after a map load or a mod reload.
		/// </summary>
		[JSExport]
		internal static void SnapshotInvalidateTerrain()
		{
			Emitter.InvalidateTerrain();
			lastEmittedTick = -1;
			lastEmittedWorldState = uint.MaxValue;
		}

		/// <summary>
		/// Issue a real Order through the OrderManager. JS does the 3D picking and sends
		/// intent; the simulation stays authoritative (§4.11). JS never mutates actor
		/// state, never fabricates an actor id, and never predicts an order's outcome.
		///
		/// Unknown or dead subject ids are skipped rather than throwing — by the time a
		/// click resolves, the sim may already have destroyed the unit, and that race is
		/// normal rather than exceptional.
		/// </summary>
		[JSExport]
		[return: JSMarshalAs<JSType.MemoryView>]
		internal static ArraySegment<byte> OrderSubjectScratch()
			=> new(OrderSubjectScratchBuffer);

		[JSExport]
		internal static string IssueOrderN(
			string orderString,
			int subjectCount,
			int targetActorId,
			int targetCellX,
			int targetCellY,
			bool queued,
			string targetString,
			int extraData)
		{
			if (subjectCount < 0 || subjectCount > OrderSubjectCapacity)
				return $"failed: subject count {subjectCount} exceeds capacity {OrderSubjectCapacity}";

			return IssueOrderCore(
				orderString,
				new ArraySegment<byte>(OrderSubjectScratchBuffer, 0, subjectCount * sizeof(uint)),
				targetActorId,
				targetCellX,
				targetCellY,
				queued,
				targetString,
				extraData);
		}

		static string IssueOrderCore(
			string orderString,
			ArraySegment<byte> subjectIds,
			int targetActorId,
			int targetCellX,
			int targetCellY,
			bool queued,
			string targetString,
			int extraData)
		{
			try
			{
				var world = Game.OrderManager?.World;
				if (world == null)
					return "no world";

				var count = subjectIds.Count / 4;

				// No subjects means a PLAYER-level order, not an empty one. Production and
				// building placement are issued on the player actor rather than on a selected
				// unit — `StartProduction` and `PlaceBuilding` both carry the item in
				// TargetString and are subject-less from the UI's point of view. Rejecting
				// count == 0 outright made the entire economy inexpressible across this seam,
				// which is what blocked playtest.mjs from scripting build -> expand -> engage.
				var playerActor = world.RenderPlayer?.PlayerActor ?? world.LocalPlayer?.PlayerActor;
				if (count == 0)
				{
					if (playerActor == null)
						return "no subjects and no player actor";

					Target pTarget;
					if (targetActorId > 0)
					{
						var ta = world.GetActorById((uint)targetActorId);
						pTarget = ta == null || ta.IsDead ? Target.Invalid : Target.FromActor(ta);
					}
					else if (targetCellX >= 0 && targetCellY >= 0)
						pTarget = Target.FromCell(world, new CPos(targetCellX, targetCellY));
					else
						pTarget = Target.Invalid;

					// Building placement resolves its production queue through ExtraData as an
					// ACTOR ID, not as a count: PlaceBuilding.cs:71 does
					// `w.GetActorById(order.ExtraData)` and returns silently when it is null.
					// So a player-level placement with ExtraData 0 always no-ops while this
					// method still reports success — which is exactly how it presented, as
					// "issued 1/1" with no building.
					//
					// The caller cannot supply the id itself: the queue lives on the player
					// pseudo-actor, and those are correctly excluded from snapshots (they have
					// no IOccupySpace, which is the same filter that fixed the emitter's
					// NullReferenceException). Defaulting it here is the only place that knows
					// both facts. An explicit non-zero extraData still wins, so a queue hosted
					// on a structure remains addressable.
					//
					// Scoped to the three orders PlaceBuilding.cs actually handles. It must NOT
					// leak to StartProduction, where ExtraData is genuinely the item count.
					var pExtra = (uint)Math.Max(0, extraData);
					if (pExtra == 0 && (orderString == "PlaceBuilding" || orderString == "LineBuild" || orderString == "PlacePlug"))
						pExtra = playerActor.ActorID;

					world.IssueOrder(new Order(orderString, playerActor, pTarget, queued)
					{
						TargetString = string.IsNullOrEmpty(targetString) ? null : targetString,
						ExtraData = pExtra,
					});

					return $"issued 1/1 (player, extraData={pExtra})";
				}

				var issued = 0;
				for (var i = 0; i < count; i++)
				{
					var id = (uint)(subjectIds[i * 4]
						| (subjectIds[i * 4 + 1] << 8)
						| (subjectIds[i * 4 + 2] << 16)
						| (subjectIds[i * 4 + 3] << 24));

					var subject = world.GetActorById(id);
					if (subject == null || subject.IsDead || !subject.IsInWorld)
						continue;

					Target target;
					if (targetActorId > 0)
					{
						var ta = world.GetActorById((uint)targetActorId);
						if (ta == null || ta.IsDead)
							continue;

						target = Target.FromActor(ta);
					}
					else if (targetCellX >= 0 && targetCellY >= 0)
						target = Target.FromCell(world, new CPos(targetCellX, targetCellY));
					else
						target = Target.Invalid;

					world.IssueOrder(new Order(orderString, subject, target, queued)
					{
						TargetString = string.IsNullOrEmpty(targetString) ? null : targetString,
						ExtraData = (uint)Math.Max(0, extraData),
					});
					issued++;
				}

				return $"issued {issued}/{count}";
			}
			catch (Exception e)
			{
				return $"failed: {e}";
			}
		}
	}
}
