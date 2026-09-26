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
using System.Runtime.CompilerServices;
using OpenRA.Effects;
using OpenRA.GameRules;
using OpenRA.Mods.Common.Pathfinder;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA.Steelseed
{
	/// <summary>
	/// Packs world state into the binary frame contract (ARCHITECTURE.md §4).
	///
	/// Two hard constraints shape every decision here:
	///
	/// 1. **Zero allocation per tick in steady state.** Buffers, scratch arrays and the
	///    type table are all sized once and reused. The bridge gate measures this; a
	///    per-tick allocation shows up as GC pauses inside the 40 ms sim budget.
	/// 2. **The simulation is never touched.** Everything here READS. No trait is mutated,
	///    no order is issued, and World.SharedRandom is never observed — reading it would
	///    not desync, but touching it would, and the distinction is too easy to lose.
	///    synccheck.mjs proves this by comparing sync-hash sequences with the bridge on
	///    and off.
	/// </summary>
	public sealed class SnapshotEmitter : IPresentationObserver
	{
		// Two buffers: JS reads one while the sim writes the other.
		byte[] bufferA;
		byte[] bufferB;
		bool writingA = true;

		SectionTable table;

		// Actor and trait references are captured when an actor enters the world, then kept
		// in ActorID order. Actor.TraitsImplementing<T>() allocates both an enumerable and a
		// boxed enumerator, so walking six interfaces per actor in Emit created 96 managed
		// objects for the pinned eight-actor workload. Actor trait sets are immutable after
		// construction in this engine, and the repository has no post-construction AddTrait
		// caller, which makes this event-owned cache sound.
		ActorCacheEntry[] actorCache = new ActorCacheEntry[512];
		int actorCount;
		World actorCacheWorld;
		ushort[] turretScratch = new ushort[512];
		PlayerCacheEntry[] playerCache = [];

		// Actor type name -> stable u16 id. Built once per map load; the web side receives
		// the same table so it can map typeId to a mesh generator.
		readonly Dictionary<string, ushort> typeIds = new();
		readonly List<string> typeNames = new();

		// Lifecycle is accumulated between emits by the bridge's trait observers and
		// drained each tick.
		readonly List<(uint actorId, ushort typeId, byte kind, byte owner)> lifecycle = new();

		// Presentation events arrive from World through a void, values-only, non-throwing
		// observer boundary. The fixed array is drained after each successful emission and
		// never grows inside a simulation tick. An exceptional burst is truncated rather
		// than allocating in the deterministic call path; ordinary gates stay far below it.
		/// <summary>
		/// Hard ceiling on published projectiles. A busy RA match carries single digits;
		/// a pathological volley degrades by dropping flights rather than growing the frame.
		/// </summary>
		const int MaxProjectiles = 512;

		readonly PendingEvent[] pendingEvents = new PendingEvent[4096];
		int pendingEventCount;
		readonly List<ProjectileRecord> projectileScratch = new(MaxProjectiles);

		/// <summary>
		/// WeaponInfo back to the name it was authored under. A projectile carries only its
		/// resolved WeaponInfo, and the client picks a rocket body or a cannon tracer from that
		/// name, so the reverse map is what turns a flight into the right picture.
		/// </summary>
		readonly Dictionary<WeaponInfo, string> weaponNames = [];

		readonly record struct ProjectileRecord(
			uint Id, uint SourceActorId, WPos Position, WPos Target, WVec Velocity,
			ushort TypeId, ushort RemainingTicks, byte Kind);

		bool terrainStaticPending = true;

		struct ActorCacheEntry
		{
			public readonly Actor Actor;
			public readonly ushort TypeId;
			public readonly IFacing Facing;
			public readonly Turreted[] Turrets;
			public readonly IDisabledTrait[] DisabledTraits;
			public readonly IMove Move;
			public readonly AttackBase[] Attacks;
			public readonly Production[] Productions;
			public readonly Health Health;
			public readonly Cargo Cargo;
			public readonly AmmoPool[] Ammo;
			public readonly Cloak[] Cloaks;
			public readonly IIssueDeployOrder[] Deploy;
			public Player ProductionOwner;
			public ProductionQueue[] ProductionQueues;
			public WPos LastPosition;
			public bool HasLastPosition;

			public ActorCacheEntry(
				Actor actor,
				ushort typeId,
				IFacing facing,
				Turreted[] turrets,
				IDisabledTrait[] disabledTraits,
				IMove move,
				AttackBase[] attacks,
				Production[] productions,
				Health health,
				Cargo cargo,
				AmmoPool[] ammo,
				Cloak[] cloaks,
				IIssueDeployOrder[] deploy,
				Player productionOwner,
				ProductionQueue[] productionQueues)
			{
				Actor = actor;
				TypeId = typeId;
				Facing = facing;
				Turrets = turrets;
				DisabledTraits = disabledTraits;
				Move = move;
				Attacks = attacks;
				Productions = productions;
				Health = health;
				Cargo = cargo;
				Ammo = ammo;
				Cloaks = cloaks;
				Deploy = deploy;
				ProductionOwner = productionOwner;
				ProductionQueues = productionQueues;
				LastPosition = actor.CenterPosition;
				HasLastPosition = false;
			}
		}

		readonly struct ProductionQueueCacheEntry
		{
			public readonly ProductionQueue Queue;
			public readonly byte QueueId;
			public readonly byte Kind;
			public readonly ActorInfo[] Items;
			public readonly ushort[] TypeIds;
			public readonly uint[] Costs;
			public readonly ushort[] BuildTicks;

			public ProductionQueueCacheEntry(ProductionQueue queue, byte queueId, byte kind, ActorInfo[] items,
				ushort[] typeIds, uint[] costs, ushort[] buildTicks)
			{
				Queue = queue;
				QueueId = queueId;
				Kind = kind;
				Items = items;
				TypeIds = typeIds;
				Costs = costs;
				BuildTicks = buildTicks;
			}
		}

		readonly struct PlayerCacheEntry
		{
			public readonly Player Player;
			public readonly PlayerResources Resources;
			public readonly PowerManager Power;
			public readonly ProductionQueueCacheEntry[] Queues;

			public PlayerCacheEntry(Player player, PlayerResources resources, PowerManager power,
				ProductionQueueCacheEntry[] queues)
			{
				Player = player;
				Resources = resources;
				Power = power;
				Queues = queues;
			}
		}

		struct PendingEvent
		{
			public ushort Kind;
			public uint ActorId;
			public uint SourceActorId;
			public WPos Position;
			public WPos SourcePosition;
			public ushort Armament;
			public ushort Facing;
			public ushort WeaponClass;
			public ushort Caliber;
			public byte ValueA;
			public byte ValueB;
		}

		public SnapshotEmitter(int initialBytes = 1 << 20)
		{
			bufferA = new byte[initialBytes];
			bufferB = new byte[initialBytes];
			table = SectionTable.Create();
		}

		/// <summary>The buffer JS should read after the most recent Emit.</summary>
		public byte[] ReadBuffer => writingA ? bufferB : bufferA;

		/// <summary>
		/// Stable slot identity for the raw browser bridge. Slot 0 is A and slot 1 is B;
		/// the bridge pins both and republishes their pointers when either array grows.
		/// </summary>
		internal byte[] BufferForSlot(int slot) => slot switch
		{
			0 => bufferA,
			1 => bufferB,
			_ => throw new ArgumentOutOfRangeException(nameof(slot)),
		};

		/// <summary>The slot containing the most recently completed emission.</summary>
		internal int ReadSlot => writingA ? 1 : 0;

		public int ReadLength { get; private set; }

		/// <summary>Force terrain.static to be re-emitted, e.g. after a map load.</summary>
		public void InvalidateTerrain() => terrainStaticPending = true;

		public void RecordLifecycle(uint actorId, ushort typeId, byte kind, byte owner)
			=> lifecycle.Add((actorId, typeId, kind, owner));

		/// <summary>
		/// Bind the cache to the current world. Returns true only when the world identity
		/// changed, so the bridge can invalidate its per-world last-tick sentinel too.
		/// </summary>
		internal bool BindWorld(World world)
		{
			if (ReferenceEquals(actorCacheWorld, world))
				return false;

			UnbindWorld();
			foreach (var actor in world.Actors)
				ActorAddedToWorld(actor);
			RebuildPlayerCache(world);
			BuildWeaponNames(world);

			// The browser host is single-threaded. No actor can enter between the synchronous
			// bootstrap above and these subscriptions.
			actorCacheWorld = world;
			world.ActorAdded += ActorAddedToWorld;
			world.ActorRemoved += ActorRemovedFromWorld;
			world.AttachPresentationObserver(this);
			return true;
		}

		/// <summary>Release a disconnected world and every trait reference owned by its cache.</summary>
		internal void UnbindWorld()
		{
			if (actorCacheWorld != null)
			{
				actorCacheWorld.DetachPresentationObserver(this);
				actorCacheWorld.ActorAdded -= ActorAddedToWorld;
				actorCacheWorld.ActorRemoved -= ActorRemovedFromWorld;
				actorCacheWorld = null;
			}

			Array.Clear(actorCache, 0, actorCount);
			actorCount = 0;
			playerCache = [];
			pendingEventCount = 0;
			weaponNames.Clear();
			projectileScratch.Clear();
		}

		void EnsurePlayerCache(World world)
		{
			var count = 0;
			foreach (var player in world.Players)
				if (!player.NonCombatant && player.PlayerActor != null)
					count++;

			if (count != playerCache.Length)
			{
				RebuildPlayerCache(world);
				return;
			}

			var index = 0;
			foreach (var player in world.Players)
			{
				if (player.NonCombatant || player.PlayerActor == null)
					continue;

				if (!ReferenceEquals(playerCache[index++].Player, player))
				{
					RebuildPlayerCache(world);
					return;
				}
			}
		}

		void RebuildPlayerCache(World world)
		{
			var count = 0;
			foreach (var player in world.Players)
				if (!player.NonCombatant && player.PlayerActor != null)
					count++;

			var next = new PlayerCacheEntry[count];
			var playerIndex = 0;
			foreach (var player in world.Players)
			{
				if (player.NonCombatant || player.PlayerActor == null)
					continue;

				var allQueues = AllImplementing<ProductionQueue>(player.PlayerActor);
				var validCount = 0;
				for (var i = 0; i < allQueues.Length; i++)
					if (allQueues[i].IsValidFaction)
						validCount++;

				var queues = new ProductionQueueCacheEntry[validCount];
				var queueIndex = 0;
				for (var i = 0; i < allQueues.Length; i++)
				{
					var queue = allQueues[i];
					if (!queue.IsValidFaction)
						continue;

					var itemCount = queue.PresentationItemCount;
					var items = new ActorInfo[itemCount];
					var typeIds = new ushort[itemCount];
					var costs = new uint[itemCount];
					var buildTicks = new ushort[itemCount];
					for (var itemIndex = 0; itemIndex < itemCount; itemIndex++)
					{
						var item = queue.PresentationItemAt(itemIndex);
						var buildable = item.TraitInfo<BuildableInfo>();
						items[itemIndex] = item;
						typeIds[itemIndex] = TypeIdFor(item.Name);
						costs[itemIndex] = (uint)Math.Max(0, queue.GetProductionCost(item));
						buildTicks[itemIndex] = (ushort)Math.Clamp(queue.GetBuildTime(item, buildable), 0, ushort.MaxValue);
					}

					queues[queueIndex++] = new ProductionQueueCacheEntry(
						queue,
						Production.StableQueueId(queue.Info.Type),
						ProductionQueueKind(queue.Info.Type),
						items,
						typeIds,
						costs,
						buildTicks);
				}

				next[playerIndex++] = new PlayerCacheEntry(
					player,
					player.PlayerActor.TraitOrDefault<PlayerResources>(),
					player.PlayerActor.TraitOrDefault<PowerManager>(),
					queues);
			}

			playerCache = next;
		}

		public void WeaponFired(in PresentationWeaponFire value)
		{
			// The fire event's u16 at offset 20 is a shared string-table id of the WEAPON name,
			// not the legacy FNV8 StableId. The client resolves it through actorTypeName the same
			// way it names actor types, then picks 120mm vs MammothTusk (or rifle vs rocket) from
			// the authored catalogue. Hashing the name collapsed every armament on a multi-gun
			// tank onto whatever actor happened to occupy that 1-255 slot.
			var weaponClass = string.IsNullOrEmpty(value.Weapon)
				? value.WeaponClass
				: TypeIdFor(value.Weapon);
			AppendEvent(new PendingEvent
			{
				Kind = EventKind.WeaponFire,
				ActorId = value.ActorId,
				Position = value.Muzzle,
				Armament = value.Armament,
				Facing = (ushort)(value.Facing.Angle & 1023),
				WeaponClass = weaponClass,
				Caliber = value.Caliber,
			});
		}

		public void ProjectileImpacted(in PresentationProjectileImpact value)
		{
			AppendEvent(new PendingEvent
			{
				Kind = EventKind.ProjectileImpact,
				Position = value.Position,
				SourcePosition = value.Source,
				WeaponClass = value.WeaponClass,
				Caliber = value.Damage,
			});
		}

		public void ActorDamaged(in PresentationActorDamage value)
		{
			AppendEvent(new PendingEvent
			{
				Kind = EventKind.ActorDamaged,
				ActorId = value.ActorId,
				SourceActorId = value.SourceActorId,
				ValueA = value.HealthFraction,
				ValueB = value.DamageType,
			});
		}

		public void ActorDestroyed(in PresentationActorDestroyed value)
		{
			AppendEvent(new PendingEvent
			{
				Kind = EventKind.ActorDestroyed,
				ActorId = value.ActorId,
				Position = value.Position,
				ValueA = value.Kind,
				ValueB = value.Violence,
			});
		}

		public void ProductionCompleted(in PresentationProductionComplete value)
		{
			var index = ActorCacheIndex(value.ProducedActorId);
			if (index >= actorCount || actorCache[index].Actor.ActorID != value.ProducedActorId)
				return;

			AppendEvent(new PendingEvent
			{
				Kind = EventKind.ProductionComplete,
				Caliber = actorCache[index].TypeId,
				ValueA = value.PlayerId,
				ValueB = value.QueueId,
			});
		}

		public void StructureBuilt(in PresentationStructureBuilt value)
		{
			// Same shape as ProductionCompleted: the structure has entered the world and
			// is already in the actor cache, so its type id comes from there and the
			// event carries owner + type for the presentation layer's build flashes.
			var index = ActorCacheIndex(value.StructureActorId);
			if (index >= actorCount || actorCache[index].Actor.ActorID != value.StructureActorId)
				return;

			AppendEvent(new PendingEvent
			{
				Kind = EventKind.StructureBuilt,
				Caliber = (ushort)value.TypeId,
				ValueA = value.PlayerId,
			});
		}

		void AppendEvent(in PendingEvent value)
		{
			if (pendingEventCount == pendingEvents.Length)
				return;

			pendingEvents[pendingEventCount++] = value;
		}

		void ActorAddedToWorld(Actor actor)
		{
			// The actors section describes renderable things that exist at a position. World
			// and player pseudo-actors are legitimately in-world without IOccupySpace.
			if (!actor.IsInWorld || actor.Disposed || actor.OccupiesSpace == null)
				return;

			var index = ActorCacheIndex(actor.ActorID);
			if (index < actorCount && actorCache[index].Actor.ActorID == actor.ActorID)
				throw new InvalidOperationException($"snapshot actor cache already contains ActorID {actor.ActorID}");

			if (actorCount == actorCache.Length)
				Array.Resize(ref actorCache, actorCache.Length * 2);

			if (index < actorCount)
				Array.Copy(actorCache, index, actorCache, index + 1, actorCount - index);

			var productions = AllImplementing<Production>(actor);
			var productionOwner = actor.Owner;
			var productionQueues = productions.Length == 0 || productionOwner?.PlayerActor == null
				? Array.Empty<ProductionQueue>()
				: AllImplementing<ProductionQueue>(productionOwner.PlayerActor);

			actorCache[index] = new ActorCacheEntry(
				actor,
				TypeIdFor(actor.Info.Name),
				FirstImplementing<IFacing>(actor),
				AllImplementing<Turreted>(actor),
				AllImplementing<IDisabledTrait>(actor),
				FirstImplementing<IMove>(actor),
				AllImplementing<AttackBase>(actor),
				productions,
				actor.TraitOrDefault<Health>(),
				actor.TraitOrDefault<Cargo>(),
				AllImplementing<AmmoPool>(actor),
				AllImplementing<Cloak>(actor),
				AllImplementing<IIssueDeployOrder>(actor),
				productionOwner,
				productionQueues);
			actorCount++;
		}

		void ActorRemovedFromWorld(Actor actor)
		{
			var index = ActorCacheIndex(actor.ActorID);
			if (index >= actorCount || actorCache[index].Actor.ActorID != actor.ActorID)
				return;

			actorCount--;
			if (index < actorCount)
				Array.Copy(actorCache, index + 1, actorCache, index, actorCount - index);

			actorCache[actorCount] = default;
		}

		int ActorCacheIndex(uint actorId)
		{
			var lo = 0;
			var hi = actorCount;
			while (lo < hi)
			{
				var mid = lo + (hi - lo) / 2;
				if (actorCache[mid].Actor.ActorID < actorId)
					lo = mid + 1;
				else
					hi = mid;
			}

			return lo;
		}

		static T[] AllImplementing<T>(Actor actor) where T : class
		{
			var count = 0;
			foreach (var _ in actor.TraitsImplementing<T>())
				count++;

			if (count == 0)
				return Array.Empty<T>();

			var result = new T[count];
			var index = 0;
			foreach (var trait in actor.TraitsImplementing<T>())
				result[index++] = trait;

			return result;
		}

		public ushort TypeIdFor(string name)
		{
			if (typeIds.TryGetValue(name, out var id))
				return id;

			id = (ushort)typeNames.Count;
			typeIds[name] = id;
			typeNames.Add(name);
			return id;
		}

		/// <summary>Type table as newline-separated names, index == typeId. Read once by JS.</summary>
		public string TypeTable() => string.Join("\n", typeNames);

		/// <summary>
		/// Number of actor types seen so far. Zero here while the world is live means the
		/// actor section never ran, which is a far more specific signal than an empty
		/// snapshot buffer.
		/// </summary>
		public int TypeCount => typeNames.Count;

		/// <summary>
		/// Pack one tick. Returns the number of bytes written.
		/// </summary>
		public int Emit(World world, Player renderPlayer)
		{
			BindWorld(world);
			EnsurePlayerCache(world);
			var buf = writingA ? bufferA : bufferB;

			EnsureCapacity(ref buf, EstimateBytes(world, actorCount));
			if (writingA) bufferA = buf; else bufferB = buf;

			table.Reset();
			var sectionCount = 7 + (terrainStaticPending ? 1 : 0); // + production catalogue
			var w = new BufferWriter(buf);
			w.Seek(SectionTable.PayloadStart(sectionCount));

			// Sections are bracketed with explicit Begin/End rather than a delegate: a
			// BufferWriter is a ref struct and cannot be captured by a lambda (CS8175),
			// which is precisely the property that keeps it off the heap.
			var s = BeginSection(ref w, "world");
			WriteWorld(ref w, world, renderPlayer);
			EndSection(ref w, SectionId.World, s);

			// Latched before the section is written and folded into the header below.
			// §4.1 pins bit 0 as "terrain.static present" and the web `terrain` node gates
			// its entire rebuild on it — an earlier revision emitted the SECTION but never
			// set the FLAG, so terrain stayed inert forever: zero chunks, heightAt 0,
			// camera never centred, nothing drawn. Declaring a contract flag and never
			// writing it is worse than omitting it, because every consumer trusts the pin.
			var emittedTerrainStatic = terrainStaticPending;
			if (terrainStaticPending)
			{
				s = BeginSection(ref w, "terrain.static");
				WriteTerrainStatic(ref w, world);
				EndSection(ref w, SectionId.TerrainStatic, s);
				terrainStaticPending = false;
			}

			s = BeginSection(ref w, "actors");
			WriteActors(ref w, actorCount);
			EndSection(ref w, SectionId.Actors, s);

			s = BeginSection(ref w, "lifecycle");
			WriteLifecycle(ref w);
			EndSection(ref w, SectionId.Lifecycle, s);

			s = BeginSection(ref w, "projectiles");
			CollectProjectiles(world, renderPlayer);
			WriteProjectiles(ref w);
			EndSection(ref w, SectionId.Projectiles, s);

			// Events (id 7) BEFORE player (id 8). ARCHITECTURE.md:306 requires the section
			// table to be "one per present section, ascending id", and this emitter wrote
			// player first, producing a live table ordered 0,1,3,4,8,7. Nothing noticed for
			// two reasons: the JS decoder reads each entry's own offset and length, so order
			// never affected decoding; and no tool validated the table against §4 until
			// tools/snapshotgate.mjs existed. Ascending order is not decoration — it is what
			// lets a validator verify complete byte coverage in a single forward pass, which
			// is exactly the check that found this.
			//
			// Events are collected by observers registered in SteelseedBridge. An empty
			// section is still emitted so consumers can rely on it existing.
			s = BeginSection(ref w, "events");
			WriteEvents(ref w);
			EndSection(ref w, SectionId.Events, s);

			s = BeginSection(ref w, "player");
			WritePlayers(ref w, renderPlayer);
			EndSection(ref w, SectionId.Player, s);

			s = BeginSection(ref w, "production");
			WriteProduction(ref w);
			EndSection(ref w, SectionId.Production, s);

			var flags = 0u;
			if (emittedTerrainStatic) flags |= HeaderFlag.TerrainStaticPresent;
			if (world.Paused) flags |= HeaderFlag.Paused;
			if (world.IsGameOver) flags |= HeaderFlag.GameOver;
			if (world.IsReplay) flags |= HeaderFlag.Replay;

			var length = w.Length;
			table.WriteHeader(buf, (uint)world.WorldTick, unchecked((uint)world.SyncHash()),
				(uint)(world.WorldTick * 40), flags, length);

			ReadLength = length;
			writingA = !writingA;
			lifecycle.Clear();
			pendingEventCount = 0;
			return length;
		}

		/// <summary>
		/// Name of the section currently being written. Read by the host's diagnostics when
		/// an emit throws: a bare stack trace from inside a BufferWriter says nothing about
		/// WHICH section overran, and that is the only fact worth having.
		/// </summary>
		public string CurrentSection { get; private set; } = "(none)";

		/// <summary>Align and return the section's start offset.</summary>
		int BeginSection(ref BufferWriter w, string name)
		{
			CurrentSection = name;
			w.Align4();
			return w.Position;
		}

		/// <summary>Align and record the section in the table.</summary>
		void EndSection(ref BufferWriter w, ushort id, int start)
		{
			w.Align4();
			table.Add(id, start, w.Position - start);
		}

		// -------------------------------------------------------------------
		// Sections
		// -------------------------------------------------------------------

		void WriteWorld(ref BufferWriter w, World world, Player renderPlayer)
		{
			var b = world.Map.Bounds;
			w.I32(b.Left);
			w.I32(b.Top);
			w.I32(b.Right);
			w.I32(b.Bottom);
			w.U32(1024); // WDist per cell
			w.U32((uint)(renderPlayer?.ClientIndex ?? 0));
			w.U16(720);  // time of day, minutes — owned by `sky` until weather lands
			w.U16(0);    // weather kind: clear
			w.U16(0);    // weather intensity
			w.U16(0);    // wind direction
			w.U16(0);    // wind speed
			w.U16(0);    // pad
		}

		void WriteTerrainStatic(ref BufferWriter w, World world)
		{
			var map = world.Map;
			var b = map.Bounds;
			var width = b.Width;
			var height = b.Height;
			w.U32((uint)width);
			w.U32((uint)height);

			// Once per emission, not per cell — see PassabilityBits.
			var (landLoco, waterLoco) = ResolveLocomotors(world);

			// Six parallel u8 planes, row-major, in the §4.3 order. Written as separate
			// passes rather than interleaved so the web side can take one typed-array view
			// per plane with no stride arithmetic.
			for (var plane = 0; plane < 6; plane++)
			{
				for (var y = 0; y < height; y++)
				{
					for (var x = 0; x < width; x++)
					{
						var cell = new MPos(b.Left + x, b.Top + y).ToCPos(map);
						byte v = 0;
						if (map.Contains(cell))
						{
							switch (plane)
							{
								case 0: v = map.GetTerrainIndex(cell); break;
								case 1: v = (byte)map.Height[cell]; break;
								case 2: v = map.Ramp[cell]; break;
								case 3: v = PassabilityBits(world, cell, landLoco, waterLoco); break;
								case 4: v = (byte)(map.Resources[cell].Type); break;
								case 5: v = SurfaceFor(map, cell); break;
							}
						}

						w.U8(v);
					}
				}

				w.Align4();
			}
		}

		/// <summary>
		/// §4.3 passability bits, derived from the simulation's OWN movement costs.
		///
		/// The previous implementation special-cased only `"Water"` by terrain-type STRING and
		/// declared everything else foot/wheeled/tracked passable — so the tileset's `Blocked`
		/// index, cliffs, and any future impassable type all reported as walkable. That is
		/// exactly the "terrain inventing its own passability" that §4.3 forbids, and the
		/// original comment said as much while the code did the opposite.
		///
		/// `Locomotor.MovementCostForCell` is the same call the pathfinder makes, so the
		/// overlay gate now compares terrain against the authority rather than against a
		/// parallel guess. Locomotors are resolved once per emission by the caller, not per
		/// cell — a `TraitsImplementing` walk inside the plane loop would be w*h lookups.
		/// </summary>
		static byte PassabilityBits(World world, CPos cell, Locomotor land, Locomotor water)
		{
			if (!world.Map.Contains(cell))
				return 1 << 4;

			byte bits = 0;

			var landOk = land != null && land.MovementCostForCell(cell) != PathGraph.MovementCostForUnreachableCell;
			var hoverOk = water != null && water.MovementCostForCell(cell) != PathGraph.MovementCostForUnreachableCell;

			// §4.3 bit 3 is WATER — a property of the cell, not "the hover locomotor can
			// enter it". Deriving it from the hover locomotor set it on ordinary clear
			// ground too, because hover traverses land and water alike: every clear cell
			// read 15 instead of 7. Consumers of this bit (water rendering, splash fx,
			// footstep audio) want to know whether the cell IS water.
			var ti = world.Map.GetTerrainInfo(cell);
			var isWater = ti != null && (ti.Type == "Water" || ti.Type == "Shallow");

			// §4.3 names three land classes (foot, wheeled, tracked) but the mod defines ONE
			// ground locomotor, so all three carry its answer. That is accurate rather than
			// lossy: with a single locomotor the three classes genuinely share a rule. If the
			// mod later splits them, resolve one Locomotor per class here — the bits already
			// have somewhere to put the difference.
			if (landOk)
			{
				bits |= 1 << 0;
				bits |= 1 << 1;
				bits |= 1 << 2;
			}

			if (isWater)
				bits |= 1 << 3;

			// Blocked means NOTHING may enter — not merely "not land-passable". A water cell
			// is not blocked; a cliff is. Hover is included here precisely because it is a
			// movement question, which is the one place the hover locomotor belongs.
			if (!landOk && !hoverOk)
				bits |= 1 << 4;

			return bits;
		}

		/// <summary>
		/// Resolve the locomotors once per terrain emission. Matched by the `Name` the mod's
		/// world rules declare, so adding a locomotor does not silently change these bits.
		/// </summary>
		static (Locomotor Land, Locomotor Water) ResolveLocomotors(World world)
		{
			Locomotor land = null;
			Locomotor water = null;
			foreach (var l in world.WorldActor.TraitsImplementing<Locomotor>())
			{
				var name = l.Info.Name;
				if (name == "ground" && land == null) land = l;
				else if ((name == "hover" || name == "naval" || name == "water") && water == null) water = l;
			}

			return (land, water);
		}

		static byte SurfaceFor(Map map, CPos cell)
		{
			var ti = map.GetTerrainInfo(cell);
			if (ti == null)
				return 0;

			// Maps the mod's tileset terrain names onto the shared surface enum
			// (ARCHITECTURE.md §8). Unknown names fall back to soil rather than throwing —
			// a missing surface should degrade the footstep sound, not the boot.
			return ti.Type switch
			{
				"Rock" => 1,
				"Sand" => 2,
				"Gravel" => 3,
				"Grass" => 4,
				"Road" => 5,
				"Metal" => 6,
				"Concrete" => 7,
				"Water" => 8,
				"Shallow" => 9,
				"Snow" => 10,
				"Ash" => 11,
				"Resource" => 12,
				_ => 0,
			};
		}

		void WriteActors(ref BufferWriter w, int n)
		{
			// Turret facings are gathered first so turretTotal is known before the header.
			var turretTotal = 0;
			for (var i = 0; i < n; i++)
			{
				var turrets = actorCache[i].Turrets;
				for (var j = 0; j < turrets.Length; j++)
				{
					if (turretTotal >= turretScratch.Length)
						Array.Resize(ref turretScratch, turretScratch.Length * 2);

					turretScratch[turretTotal++] = (ushort)(turrets[j].WorldOrientation.Yaw.Angle & 1023);
				}
			}

			w.U32((uint)n);
			w.U32((uint)turretTotal);

			// Widest arrays first so each stays naturally aligned with no interior padding.
			for (var i = 0; i < n; i++) w.U32(actorCache[i].Actor.ActorID);
			for (var i = 0; i < n; i++) w.I32(actorCache[i].Actor.CenterPosition.X);
			for (var i = 0; i < n; i++) w.I32(actorCache[i].Actor.CenterPosition.Y);
			for (var i = 0; i < n; i++) w.I32(actorCache[i].Actor.CenterPosition.Z);

			for (var i = 0; i < n; i++) w.U16(actorCache[i].TypeId);
			for (var i = 0; i < n; i++) w.U16((ushort)((actorCache[i].Facing?.Facing.Angle ?? 0) & 1023));

			for (var i = 0; i < n; i++) w.U16(0); // animState — owned by `anim`, driven from these fields
			for (var i = 0; i < n; i++) w.U16(ProductionPermille(ref actorCache[i]));

			// turretOffset: start index into turretFacing for each actor.
			var off = 0;
			for (var i = 0; i < n; i++)
			{
				w.U16((ushort)off);
				off += actorCache[i].Turrets.Length;
			}

			// speed (WDist/tick) is the exact distance travelled since the previous emitted
			// tick. It is derived from position instead of a locomotor trait so tracked,
			// wheeled, infantry, naval and airborne movement all obey the same contract.
			// Newly observed actors have no previous sample and therefore emit zero once.
			for (var i = 0; i < n; i++) w.U16(SpeedFor(ref actorCache[i]));

			w.Align4();

			for (var i = 0; i < n; i++) w.U8((byte)(actorCache[i].Actor.Owner?.ClientIndex ?? 0));
			for (var i = 0; i < n; i++)
			{
				var h = actorCache[i].Health;
				w.U8(h == null || h.MaxHP <= 0 ? (byte)255 : (byte)(255L * h.HP / h.MaxHP));
			}

			for (var i = 0; i < n; i++)
			{
				var c = actorCache[i].Cargo;
				w.U8((byte)Math.Clamp(c?.PassengerCount ?? 0, 0, 255));
			}

			for (var i = 0; i < n; i++) w.U8((byte)actorCache[i].Turrets.Length);
			for (var i = 0; i < n; i++) w.U8(FlagsFor(actorCache[i]));
			for (var i = 0; i < n; i++) w.U8(0); // surface under the actor — filled by terrain lookup
			for (var i = 0; i < n; i++) w.U8(AmmoFor(ref actorCache[i]));
			for (var i = 0; i < n; i++) w.U8(CargoReservedFor(ref actorCache[i]));

			w.Align4();
			for (var i = 0; i < turretTotal; i++) w.U16(turretScratch[i]);
		}

		/// <summary>
		/// First trait implementing <typeparamref name="T"/>, or null.
		///
		/// **Never use Actor.TraitOrDefault&lt;T&gt;() for an INTERFACE.** It throws
		/// `InvalidOperationException: Actor X has multiple traits of type T` the moment an
		/// actor legitimately implements that interface twice — and many do:
		/// `IDisabledTrait` is implemented by every conditionally-disabled trait, `IFacing`
		/// by both a body and a turret, `IMove` by more than one locomotion trait. The
		/// failure is data-dependent, so it appears only once a roster grows a unit that
		/// happens to trip it, which is exactly how it reached us: the emitter worked until
		/// `foundry_rivet` gained a second IDisabledTrait.
		///
		/// TraitOrDefault is safe for CONCRETE trait classes (Health, Cargo,
		/// PlayerResources, PowerManager) and those still use it.
		/// </summary>
		static T FirstImplementing<T>(Actor a) where T : class
		{
			foreach (var t in a.TraitsImplementing<T>())
				return t;

			return null;
		}

		ushort ProductionPermille(ref ActorCacheEntry entry)
		{
			if (entry.Productions.Length == 0)
				return 0;

			// Classic production queues live on the player actor, while this contract puts
			// progress on the structure that will produce the item. Refresh the cached queue
			// references only after capture; ownership is stable during normal ticks.
			if (entry.ProductionOwner != entry.Actor.Owner)
			{
				entry.ProductionOwner = entry.Actor.Owner;
				entry.ProductionQueues = entry.ProductionOwner?.PlayerActor == null
					? Array.Empty<ProductionQueue>()
					: AllImplementing<ProductionQueue>(entry.ProductionOwner.PlayerActor);
			}

			for (var i = 0; i < entry.ProductionQueues.Length; i++)
			{
				var queue = entry.ProductionQueues[i];
				if (!Produces(entry, queue.Info.Type) || queue.PresentationMostLikelyProducerActor != entry.Actor)
					continue;

				var item = queue.CurrentItem();
				if (item == null || !item.Started)
					continue;

				if (item.TotalTime <= 0)
					return 1000;

				return (ushort)Math.Clamp(1000L * (item.TotalTime - item.RemainingTime) / item.TotalTime, 0, 1000);
			}

			return 0;
		}

		static bool Produces(ActorCacheEntry entry, string type)
		{
			for (var i = 0; i < entry.Productions.Length; i++)
			{
				var production = entry.Productions[i];
				if (!production.IsTraitDisabled && production.Info.Produces.Contains(type))
					return true;
			}

			return false;
		}

		static ushort SpeedFor(ref ActorCacheEntry entry)
		{
			var current = entry.Actor.CenterPosition;
			var speed = entry.HasLastPosition ? (current - entry.LastPosition).Length : 0;
			entry.LastPosition = current;
			entry.HasLastPosition = true;
			return (ushort)Math.Clamp(speed, 0, ushort.MaxValue);
		}

		static byte FlagsFor(ActorCacheEntry entry)
		{
			byte f = 0;
			if (entry.Actor.IsDead) f |= ActorFlag.Husk;

			// ANY disabled trait marks the actor disabled, so this iterates rather than
			// taking the first — an actor with a live trait and a disabled one is disabled
			// in the sense the renderer cares about (greyed, inert, no muzzle flash).
			for (var i = 0; i < entry.DisabledTraits.Length; i++)
			{
				if (entry.DisabledTraits[i].IsTraitDisabled)
				{
					f |= ActorFlag.Disabled;
					break;
				}
			}

			var move = entry.Move;
			if (move != null && move.CurrentMovementTypes != MovementType.None) f |= ActorFlag.Moving;
			for (var i = 0; i < entry.Attacks.Length; i++)
			{
				if (entry.Attacks[i].IsAiming)
				{
					f |= ActorFlag.Firing;
					break;
				}
			}

			for (var i = 0; i < entry.Cloaks.Length; i++)
			{
				if (entry.Cloaks[i].Cloaked)
				{
					f |= ActorFlag.Cloaked;
					break;
				}
			}

			// Bit 4 is `Selected` in this writer and `deployable` in the JS decoder — the
			// Unload / DeployTransform HUD button keys off it.
			for (var i = 0; i < entry.Deploy.Length; i++)
			{
				if (entry.Deploy[i].CanIssueDeployOrder(entry.Actor, false))
				{
					f |= ActorFlag.Selected;
					break;
				}
			}

			return f;
		}

		static byte AmmoFor(ref ActorCacheEntry entry)
		{
			if (entry.Ammo.Length == 0)
				return 255;

			var n = 0;
			for (var i = 0; i < entry.Ammo.Length; i++)
				n += entry.Ammo[i].CurrentAmmoCount;
			return (byte)Math.Clamp(n, 0, 254);
		}

		static byte CargoReservedFor(ref ActorCacheEntry entry)
		{
			var cargo = entry.Cargo;
			if (cargo == null)
				return 0;

			var n = cargo.ReservedCount;
			if (cargo.IsUnloading && n == 0)
				n = 1;
			return (byte)Math.Clamp(n, 0, 255);
		}

		void WriteLifecycle(ref BufferWriter w)
		{
			w.U32((uint)lifecycle.Count);
			foreach (var (actorId, typeId, kind, owner) in lifecycle)
			{
				w.U32(actorId);
				w.U16(typeId);
				w.U8(kind);
				w.U8(owner);
			}
		}

		void WritePlayers(ref BufferWriter w, Player renderPlayer)
		{
			w.U32((uint)playerCache.Length);
			for (var playerIndex = 0; playerIndex < playerCache.Length; playerIndex++)
			{
				var cached = playerCache[playerIndex];
				var p = cached.Player;
				var res = cached.Resources;
				var pow = cached.Power;
				w.U32((uint)(res?.Cash ?? 0));
				w.U32((uint)(res?.Resources ?? 0));
				w.I16((short)Math.Clamp(pow?.PowerProvided ?? 0, short.MinValue, short.MaxValue));
				w.I16((short)Math.Clamp(pow?.PowerDrained ?? 0, short.MinValue, short.MaxValue));
				w.U8((byte)p.ClientIndex);
				w.U8(0); // factionId — resolved via the type table
				w.U8(0); // teamId
				byte flags = 0;
				if (p.WinState == WinState.Undefined) flags |= PlayerFlag.Alive;
				if (p == renderPlayer) flags |= PlayerFlag.IsRenderPlayer;
				if (p.IsBot) flags |= PlayerFlag.IsBot;
				if (p.WinState == WinState.Won) flags |= PlayerFlag.Won;
				if (p.WinState == WinState.Lost) flags |= PlayerFlag.Lost;
				w.U8(flags);
				w.U16((ushort)cached.Queues.Length);
				w.U32(0); // score

				for (var queueIndex = 0; queueIndex < cached.Queues.Length; queueIndex++)
				{
					var queue = cached.Queues[queueIndex];
					var current = queue.Queue.CurrentItem();
					w.U16(queue.QueueId);
					w.U16(CurrentTypeId(queue, current));
					w.U16(ProductionPermille(current));
					w.U16((ushort)Math.Min(queue.Queue.PresentationQueuedCount, ushort.MaxValue));
				}
			}
		}

		void WriteProduction(ref BufferWriter w)
		{
			var queueCount = 0;
			for (var playerIndex = 0; playerIndex < playerCache.Length; playerIndex++)
				queueCount += playerCache[playerIndex].Queues.Length;

			w.U32((uint)queueCount);
			for (var playerIndex = 0; playerIndex < playerCache.Length; playerIndex++)
			{
				var player = playerCache[playerIndex];
				for (var queueIndex = 0; queueIndex < player.Queues.Length; queueIndex++)
				{
					var cached = player.Queues[queueIndex];
					var queue = cached.Queue;
					var current = queue.CurrentItem();
					var visibleCount = 0;
					for (var itemIndex = 0; itemIndex < cached.Items.Length; itemIndex++)
						if (queue.PresentationItemVisible(cached.Items[itemIndex]))
							visibleCount++;

					byte flags = 0;
					if (queue.Enabled) flags |= 1 << 0;
					if (current?.Paused == true) flags |= 1 << 1;
					if (current?.Done == true) flags |= 1 << 2;

					w.U8((byte)Math.Clamp(player.Player.ClientIndex, 0, byte.MaxValue));
					w.U8(cached.QueueId);
					w.U8(flags);
					w.U8(cached.Kind);
					w.U16(CurrentTypeId(cached, current));
					w.U16(ProductionPermille(current));
					w.U16((ushort)Math.Min(queue.PresentationQueuedCount, ushort.MaxValue));
					w.U16((ushort)Math.Min(visibleCount, ushort.MaxValue));

					for (var itemIndex = 0; itemIndex < cached.Items.Length; itemIndex++)
					{
						var item = cached.Items[itemIndex];
						if (!queue.PresentationItemVisible(item))
							continue;

						ushort itemFlags = 1 << 0; // visible
						if (queue.PresentationItemBuildable(item)) itemFlags |= 1 << 1;
						var itemQueued = queue.PresentationQueuedCountFor(item);
						if (itemQueued > 0) itemFlags |= 1 << 2;
						if (current?.Item == item.Name) itemFlags |= 1 << 3;
						if (current?.Item == item.Name && current.Done) itemFlags |= 1 << 4;
						if (item.HasTraitInfo<BuildingInfo>()) itemFlags |= 1 << 5;

						w.U16(cached.TypeIds[itemIndex]);
						w.U16(itemFlags);
						w.U32(cached.Costs[itemIndex]);
						w.U16(cached.BuildTicks[itemIndex]);
						w.U16((ushort)Math.Min(itemQueued, ushort.MaxValue));
					}
				}
			}
		}

		static ushort CurrentTypeId(in ProductionQueueCacheEntry cached, ProductionItem current)
		{
			if (current == null)
				return ushort.MaxValue;

			for (var i = 0; i < cached.Items.Length; i++)
				if (cached.Items[i].Name == current.Item)
					return cached.TypeIds[i];

			return ushort.MaxValue;
		}

		static byte ProductionQueueKind(string type)
		{
			if (type.EndsWith("Building", StringComparison.Ordinal)) return 0;
			if (type.EndsWith("Infantry", StringComparison.Ordinal)) return 1;
			if (type.EndsWith("Vehicle", StringComparison.Ordinal)) return 2;
			if (type.EndsWith("Aircraft", StringComparison.Ordinal)) return 3;
			if (type.EndsWith("Naval", StringComparison.Ordinal)) return 4;
			return byte.MaxValue;
		}

		static ushort ProductionPermille(ProductionItem item)
		{
			if (item == null || !item.Started)
				return 0;
			if (item.Done || item.TotalTime <= 0)
				return 1000;

			return (ushort)Math.Clamp(1000L * (item.TotalTime - item.RemainingTime) / item.TotalTime, 0, 1000);
		}

		/// <summary>
		/// Map every WeaponInfo back to the name the RULES were authored with.
		///
		/// `Ruleset.Weapons` is keyed by `k.Key.ToLowerInvariant()`, while armament.Info.Weapon
		/// and the client's visual catalogue keep the authored casing. Publishing the dictionary
		/// key put a second, unmatchable name in the string table (a live match published a
		/// rocket soldier's missile as "dragon" against a catalogue holding "Dragon").
		/// </summary>
		void BuildWeaponNames(World world)
		{
			weaponNames.Clear();
			var authored = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
			foreach (var actor in world.Map.Rules.Actors.Values)
				foreach (var armament in actor.TraitInfos<ArmamentInfo>())
					if (!string.IsNullOrEmpty(armament.Weapon))
						authored[armament.Weapon] = armament.Weapon;

			foreach (var (name, info) in world.Map.Rules.Weapons)
			{
				var cased = authored.TryGetValue(name, out var resolved) ? resolved : name;
				weaponNames[info] = cased;
				TypeIdFor(cased);
			}
		}

		/// <summary>
		/// Gather every live projectile the render player is allowed to see.
		///
		/// OpenRA keeps projectiles in World.Effects. IProjectileFlight is the presentation-only
		/// read surface; without this walk a Mammoth Tusk, V2 or rocket soldier published only a
		/// muzzle flash and looked like the tank's cannon.
		/// </summary>
		void CollectProjectiles(World world, Player renderPlayer)
		{
			projectileScratch.Clear();
			var shroud = renderPlayer?.Shroud;
			if (shroud == null)
				return;

			var map = world.Map;
			foreach (var effect in world.Effects)
			{
				if (projectileScratch.Count >= MaxProjectiles)
					break;

				if (effect is not IProjectileFlight flight)
					continue;

				var position = flight.FlightPosition;
				if (!CellVisible(map, shroud, position))
					continue;

				var beam = flight.FlightIsBeam;
				var target = beam ? flight.FlightTarget : position;
				if (beam && !CellVisible(map, shroud, target))
					continue;

				var weapon = flight.FlightWeapon;
				var name = weapon != null && weaponNames.TryGetValue(weapon, out var resolved) ? resolved : "";
				var remaining = flight.FlightRemainingTicks;
				projectileScratch.Add(new ProjectileRecord(
					unchecked((uint)RuntimeHelpers.GetHashCode(effect)),
					flight.FlightSourceActorId,
					position,
					target,
					flight.FlightVelocity,
					TypeIdFor(name),
					remaining < 0 ? ushort.MaxValue : (ushort)Math.Min(remaining, ushort.MaxValue - 1),
					beam ? (byte)1 : (byte)0));
			}
		}

		static bool CellVisible(Map map, Shroud shroud, WPos position)
		{
			var cell = map.CellContaining(position);
			return map.Contains(cell) && shroud.IsVisible(cell) && shroud.IsExplored(cell);
		}

		void WriteProjectiles(ref BufferWriter w)
		{
			var count = projectileScratch.Count;
			w.U32((uint)count);
			for (var i = 0; i < count; i++)
				w.U32(projectileScratch[i].Id);
			for (var i = 0; i < count; i++)
				w.U32(projectileScratch[i].SourceActorId);
			for (var i = 0; i < count; i++)
				w.I32(projectileScratch[i].Position.X);
			for (var i = 0; i < count; i++)
				w.I32(projectileScratch[i].Position.Y);
			for (var i = 0; i < count; i++)
				w.I32(projectileScratch[i].Position.Z);
			for (var i = 0; i < count; i++)
				w.I32(projectileScratch[i].Target.X);
			for (var i = 0; i < count; i++)
				w.I32(projectileScratch[i].Target.Y);
			for (var i = 0; i < count; i++)
				w.I32(projectileScratch[i].Target.Z);
			for (var i = 0; i < count; i++)
				w.I16(TickVelocity(projectileScratch[i].Velocity.X));
			for (var i = 0; i < count; i++)
				w.I16(TickVelocity(projectileScratch[i].Velocity.Y));
			for (var i = 0; i < count; i++)
				w.I16(TickVelocity(projectileScratch[i].Velocity.Z));
			for (var i = 0; i < count; i++)
				w.U16(projectileScratch[i].TypeId);
			for (var i = 0; i < count; i++)
				w.U16(projectileScratch[i].RemainingTicks);
			for (var i = 0; i < count; i++)
				w.U8(projectileScratch[i].Kind);
		}

		static short TickVelocity(int component) =>
			(short)Math.Clamp(component, short.MinValue, short.MaxValue);

		void WriteEvents(ref BufferWriter w)
		{
			// Callback order is the simulation's deterministic emission order, but it is an
			// unsynced presentation ordering and is not part of the simulation sync contract.
			// Consumers may play the stream in order; simulation code may never consume it.
			w.U32((uint)pendingEventCount);
			for (var i = 0; i < pendingEventCount; i++)
			{
				var e = pendingEvents[i];
				switch (e.Kind)
				{
					case EventKind.WeaponFire:
						w.U16(e.Kind);
						w.U16(24);
						w.U32(e.ActorId);
						w.U16(e.Armament);
						w.I32(e.Position.X);
						w.I32(e.Position.Y);
						w.I32(e.Position.Z);
						w.U16(e.Facing);
						w.U16(e.WeaponClass);
						w.U16(e.Caliber);
						break;

					case EventKind.ProjectileImpact:
						w.U16(e.Kind);
						w.U16(22);
						w.I32(e.Position.X);
						w.I32(e.Position.Y);
						w.I32(e.Position.Z);
						WriteImpactIncidence(ref w, e.SourcePosition - e.Position);
						w.U8(SurfaceAt(e.Position));
						w.U8((byte)e.WeaponClass);
						w.U16(e.Caliber);
						break;

					case EventKind.ActorDamaged:
						w.U16(e.Kind);
						w.U16(10);
						w.U32(e.ActorId);
						w.U8(e.ValueA);
						w.U8(e.ValueB);
						w.U32(e.SourceActorId);
						break;

					case EventKind.ActorDestroyed:
						w.U16(e.Kind);
						w.U16(18);
						w.U32(e.ActorId);
						w.I32(e.Position.X);
						w.I32(e.Position.Y);
						w.I32(e.Position.Z);
						w.U8(e.ValueA);
						w.U8(e.ValueB);
						break;

					case EventKind.ProductionComplete:
						w.U16(e.Kind);
						w.U16(4);
						w.U8(e.ValueA);
						w.U8(e.ValueB);
						w.U16(e.Caliber);
						break;

					case EventKind.StructureBuilt:
						w.U16(e.Kind);
						w.U16(3);
						w.U8(e.ValueA);
						w.U16(e.Caliber);
						break;
				}

				w.Align4();
			}
		}

		static void WriteImpactIncidence(ref BufferWriter w, WVec incidence)
		{
			var length = incidence.Length;
			if (length == 0)
			{
				w.I16(0);
				w.I16(0);
				w.I16(short.MaxValue);
				return;
			}

			w.I16((short)Math.Clamp((long)incidence.X * short.MaxValue / length, short.MinValue, short.MaxValue));
			w.I16((short)Math.Clamp((long)incidence.Y * short.MaxValue / length, short.MinValue, short.MaxValue));
			w.I16((short)Math.Clamp((long)incidence.Z * short.MaxValue / length, short.MinValue, short.MaxValue));
		}

		byte SurfaceAt(WPos position)
		{
			if (actorCacheWorld == null)
				return 0;

			var cell = actorCacheWorld.Map.CellContaining(position);
			return actorCacheWorld.Map.Contains(cell) ? SurfaceFor(actorCacheWorld.Map, cell) : (byte)0;
		}

		// -------------------------------------------------------------------

		static int EstimateBytes(World world, int actorCount)
		{
			var b = world.Map.Bounds;
			var terrain = b.Width * b.Height * 6 + 64;
			var actors = actorCount * 40 + 4096;
			var projectiles = MaxProjectiles * 48 + 64;
			return SectionTable.PayloadStart(SectionTable.MaxSections) + terrain + actors + projectiles + 32768;
		}

		static void EnsureCapacity(ref byte[] buf, int needed)
		{
			if (buf.Length >= needed)
				return;

			// Grows only when the map or actor count demands it — at map load and on the
			// first few ticks, never in steady state.
			var cap = buf.Length;
			while (cap < needed)
				cap *= 2;

			buf = new byte[cap];
		}
	}
}
