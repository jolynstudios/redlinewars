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
using System.Runtime.CompilerServices;
using OpenRA.Effects;
using OpenRA.GameRules;
using OpenRA.Mods.Cnc.Traits;
using OpenRA.Mods.Common.Pathfinder;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Steelseed;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.Steelseed
{
	public sealed class SnapshotEmitter
	{
		const int BufferCapacity = 8 * 1024 * 1024;
		const int MaxSections = 13;

		/// <summary>
		/// Hard ceiling on published projectiles, so a pathological volley degrades by dropping
		/// flights rather than by growing the frame. A busy RA match carries single digits.
		/// </summary>
		const int MaxProjectiles = 512;

		readonly byte[][] buffers = [new byte[BufferCapacity], new byte[BufferCapacity]];
		readonly Dictionary<string, ushort> typeIds = new(StringComparer.Ordinal);
		readonly Dictionary<ActorInfo, bool> editorOnlyActorTypes = [];
		readonly List<string> typeNames = [];
		readonly Dictionary<uint, (WPos Position, int Tick)> lastPositions = [];
		readonly HashSet<uint> lastVisibleActors = [];
		readonly List<LifecycleRecord> pendingLifecycle = [];
		readonly List<ProjectileRecord> projectileScratch = new(MaxProjectiles);

		/// <summary>
		/// WeaponInfo back to the name it was authored under. A projectile carries only its
		/// resolved WeaponInfo, and the client picks a rocket body or an electric arc from the
		/// authored name, so the reverse map is what turns a flight into the right picture.
		/// Built once per world; the ruleset is immutable for the life of a match.
		/// </summary>
		readonly Dictionary<WeaponInfo, string> weaponNames = [];
		World boundWorld;
		ResourceSnapshot resourceSnapshot;
		Rectangle renderBounds;
		bool terrainPending = true;
		int writeSlot;

		readonly record struct SectionRecord(ushort Id, int Offset, int Length);
		readonly record struct LifecycleRecord(uint ActorId, ushort TypeId, byte Kind, Player Owner);
		readonly record struct ProjectileRecord(
			uint Id, uint SourceActorId, WPos Position, WPos Target, WVec Velocity,
			ushort TypeId, ushort RemainingTicks, byte Kind, WPos Launch, ushort Armament, ushort Barrel, uint Shot);

		public int ReadSlot { get; private set; }
		public int ReadLength { get; private set; }

		public byte[] BufferForSlot(int slot) => buffers[slot];

		bool rulesPrepopulated;

		public string TypeTable() => string.Join('\n', typeNames);

		public void InvalidateTerrain() => terrainPending = true;

		void TerrainCellChanged(CPos cell) => terrainPending = true;

		public bool BindWorld(World world)
		{
			if (ReferenceEquals(boundWorld, world))
				return false;

			UnbindWorld();
			boundWorld = world;
			renderBounds = CalculateRenderBounds(world.Map);
			resourceSnapshot = new ResourceSnapshot(world, renderBounds);
			BuildWeaponNames(world);
			boundWorld.ActorAdded += ActorAdded;
			boundWorld.ActorRemoved += ActorRemoved;
			boundWorld.Map.Tiles.CellEntryChanged += TerrainCellChanged;
			terrainPending = true;
			return true;
		}

		public void UnbindWorld()
		{
			if (boundWorld != null)
			{
				boundWorld.ActorAdded -= ActorAdded;
				boundWorld.ActorRemoved -= ActorRemoved;
				boundWorld.Map.Tiles.CellEntryChanged -= TerrainCellChanged;
			}

			boundWorld = null;
			resourceSnapshot = null;
			renderBounds = Rectangle.Empty;
			lastPositions.Clear();
			lastVisibleActors.Clear();
			pendingLifecycle.Clear();
			editorOnlyActorTypes.Clear();
			weaponNames.Clear();
			projectileScratch.Clear();
		}

		void ActorAdded(Actor actor)
		{
			if (actor.OccupiesSpace != null)
				pendingLifecycle.Add(new LifecycleRecord(actor.ActorID, TypeId(actor.Info.Name), 0, actor.Owner));
		}

		void ActorRemoved(Actor actor)
		{
			if (lastVisibleActors.Contains(actor.ActorID))
				pendingLifecycle.Add(new LifecycleRecord(actor.ActorID, TypeId(actor.Info.Name), 1, actor.Owner));

			lastPositions.Remove(actor.ActorID);
			lastVisibleActors.Remove(actor.ActorID);
		}

		public int Emit(World world, Player renderPlayer)
		{
			BindWorld(world);
			// The table is otherwise lazy (an entry appears when its actor is first
			// written to a snapshot), which leaves the presentation unable to name
			// production items for actor types that have not spawned yet. By the
			// first emit the world and its rules are fully loaded, so register every
			// ruleset actor type before the snapshot bytes leave; ids match the lazy
			// path because both funnel through TypeId.
			if (!rulesPrepopulated)
			{
				rulesPrepopulated = true;
				var rules = world.Map.Rules;
				foreach (var actorType in rules.Actors.Keys)
					TypeId(actorType);

				// Weapons too. Events name their weapon through this table, and a weapon first
				// used mid-match (the Atomic on the first launch) reached the browser as an id
				// past the table it had already fetched: the lookup answered "" for the one
				// event that mattered, and the nuke's staged cloud never started. Impacts name
				// the ruleset key, fire events the armament's authored spelling; both register.
				foreach (var weapon in rules.Weapons.Keys)
					TypeId(weapon);
				foreach (var actor in rules.Actors.Values)
					foreach (var armament in actor.TraitInfos<ArmamentInfo>())
						TypeId(armament.Weapon);
			}
			var players = world.Players.OrderBy(p => p.ClientIndex).ToArray();
			var playerIndexes = new Dictionary<Player, byte>();
			for (var i = 0; i < players.Length && i < byte.MaxValue; i++)
				playerIndexes[players[i]] = (byte)i;

			var actors = world.Actors
				.Where(a => ActorVisible(a, world, renderPlayer))
				.OrderBy(a => a.ActorID)
				.ToArray();
			var frozenActors = FrozenActors(world, renderPlayer)
				.OrderBy(a => a.ID)
				.ToArray();
			lastVisibleActors.Clear();
			foreach (var actor in actors)
				lastVisibleActors.Add(actor.ActorID);

			var buffer = buffers[writeSlot];
			var sections = new List<SectionRecord>(MaxSections);
			var writer = new BufferWriter(buffer, SnapshotContract.HeaderBytes + MaxSections * SnapshotContract.SectionEntryBytes);

			WriteSection(SnapshotContract.Section.World, ref writer, sections,
				(ref BufferWriter w) => WriteWorld(ref w, world, renderPlayer, players, renderBounds));
			if (terrainPending)
			{
				WriteSection(SnapshotContract.Section.TerrainStatic, ref writer, sections,
					(ref BufferWriter w) => WriteTerrain(ref w, world, renderBounds));
				terrainPending = false;
			}

			WriteSection(SnapshotContract.Section.Actors, ref writer, sections,
				(ref BufferWriter w) => WriteActors(ref w, actors, playerIndexes));
			WriteSection(SnapshotContract.Section.Lifecycle, ref writer, sections,
				(ref BufferWriter w) => WriteLifecycle(ref w, playerIndexes));
			WriteSection(SnapshotContract.Section.Shroud, ref writer, sections,
				(ref BufferWriter w) => WriteShroud(ref w, world.Map, renderPlayer, renderBounds));
			var eventSink = world.WorldActor.TraitOrDefault<SteelseedEventSink>();
			WriteSection(SnapshotContract.Section.Events, ref writer, sections,
				(ref BufferWriter w) => WriteEvents(ref w, world.Map, renderPlayer, playerIndexes, eventSink));
			WriteSection(SnapshotContract.Section.Players, ref writer, sections,
				(ref BufferWriter w) => WritePlayers(ref w, players, renderPlayer));
			WriteSection(SnapshotContract.Section.Production, ref writer, sections,
				(ref BufferWriter w) => WriteProduction(ref w, players, renderPlayer));
			WriteSection(SnapshotContract.Section.FrozenActors, ref writer, sections,
				(ref BufferWriter w) => WriteFrozenActors(ref w, frozenActors, playerIndexes));
			WriteSection(SnapshotContract.Section.Resources, ref writer, sections,
				(ref BufferWriter w) => resourceSnapshot.Write(ref w, renderPlayer));
			CollectProjectiles(world, renderPlayer);
			WriteSection(SnapshotContract.Section.Projectiles, ref writer, sections,
				(ref BufferWriter w) => WriteProjectiles(ref w));

			WriteSection(SnapshotContract.Section.Deployments, ref writer, sections,
				(ref BufferWriter w) => WriteDeployments(ref w, actors));
			WriteSection(SnapshotContract.Section.ActorStatus, ref writer, sections,
				(ref BufferWriter w) => WriteActorStatus(ref w, actors, world, renderPlayer));

			ReadLength = writer.Position;
			WriteHeader(buffer, sections, world, ReadLength);
			ReadSlot = writeSlot;
			writeSlot ^= 1;
			pendingLifecycle.Clear();
			eventSink?.Clear();
			return ReadLength;
		}

		delegate void SectionWriter(ref BufferWriter writer);

		static void WriteSection(ushort id, ref BufferWriter writer, List<SectionRecord> sections, SectionWriter write)
		{
			writer.Align4();
			var start = writer.Position;
			write(ref writer);
			writer.Align4();
			sections.Add(new SectionRecord(id, start, writer.Position - start));
		}

		static void WriteHeader(byte[] buffer, List<SectionRecord> sections, World world, int length)
		{
			var flags = 0u;
			if (sections.Any(s => s.Id == SnapshotContract.Section.TerrainStatic))
				flags |= SnapshotContract.HeaderFlag.TerrainStaticPresent;
			if (world.Paused)
				flags |= SnapshotContract.HeaderFlag.Paused;
			if (world.IsReplay)
				flags |= SnapshotContract.HeaderFlag.Replay;
			if (world.IsGameOver)
				flags |= SnapshotContract.HeaderFlag.GameOver;

			var writer = new BufferWriter(buffer);
			writer.U32(SnapshotContract.Magic);
			writer.U16(SnapshotContract.Version);
			writer.U16((ushort)sections.Count);
			writer.U32((uint)length);
			writer.U32((uint)world.WorldTick);
			writer.U32(unchecked((uint)world.SyncHash()));
			writer.U32((uint)Math.Clamp((long)world.WorldTick * world.Timestep, 0, uint.MaxValue));
			writer.U32(flags);
			writer.U32(0);

			foreach (var section in sections)
			{
				writer.U16(section.Id);
				writer.U16(0);
				writer.U32((uint)section.Offset);
				writer.U32((uint)section.Length);
			}
		}

		bool ActorVisible(Actor actor, World world, Player renderPlayer)
		{
			if (!actor.IsInWorld || actor.Disposed || actor.OccupiesSpace == null || renderPlayer == null)
				return false;

			// RenderSpritesEditorOnly is deliberately retained because marker/camera actors need
			// its construction-time contract, but upstream renders it as SpriteRenderable.None in
			// a match. Keep that exact visibility boundary: publishing mpspawn/waypoint as normal
			// actors draws a fake structure over the MCV and steals the player's first click.
			if (!editorOnlyActorTypes.TryGetValue(actor.Info, out var editorOnly))
			{
				editorOnly = actor.Info.TraitsInConstructOrder()
					.Any(info => info.GetType().Name == "RenderSpritesEditorOnlyInfo");
				editorOnlyActorTypes.Add(actor.Info, editorOnly);
			}

			if (editorOnly)
				return false;
			if (actor.Owner == renderPlayer)
				return true;

			// Upstream decides "may the local player see this actor" with World.FogObscures(a),
			// which is exactly !CanBeViewedByPlayer(RenderPlayer) and NOTHING else. Each actor
			// already carries the right rule for its own class: HiddenUnderFog tests AnyVisible
			// over the FOOTPRINT, FrozenUnderFog defers to the remembered record the frozen
			// section publishes, and HiddenUnderShroud — which ^Tree, ^TreeHusk and ^Rock all
			// carry — tests AnyExplored and has no fog term at all, because a tree you have
			// walked past does not stop existing when you look away.
			//
			// ANDing Shroud.IsVisible(CenterPosition) onto that was wrong twice over: it applied
			// FOG to actors whose contract is shroud-only, and it demanded the single CENTRE cell
			// where every one of those contracts asks for ANY footprint cell. Measured on Jungle
			// Law (699 authored actors) with the whole map explored and fog on, the snapshot
			// carried 12 actors — the player's own. With fog off, where Shroud.IsVisible
			// short-circuits to the whole map, the same match carried all 699. So this one term
			// suppressed 687 of them. Driving units across the map, a tree was present in 4%-25%
			// of samples and cycled in and out repeatedly as vision swept past: assets that are
			// there, not drawn, and flickering as they come into view.
			return actor.CanBeViewedByPlayer(renderPlayer);
		}

		static IEnumerable<FrozenActor> FrozenActors(World world, Player renderPlayer)
		{
			if (renderPlayer?.FrozenActorLayer == null || world.Map.MapSize.Width <= 0 || world.Map.MapSize.Height <= 0)
				return [];

			var region = new CellRegion(world.Map.Grid.Type, MPos.Zero,
				new MPos(world.Map.MapSize.Width - 1, world.Map.MapSize.Height - 1));
			return renderPlayer.FrozenActorLayer.FrozenActorsInRegion(region)
				.Where(a => a.IsValid && a.Visible && !a.Shrouded && !a.Hidden)
				.Distinct();
		}

		static Rectangle CalculateRenderBounds(Map map)
		{
			if (map.Grid.Type == MapGridType.Rectangular)
				return map.Bounds;

			var minX = int.MaxValue;
			var minY = int.MaxValue;
			var maxX = int.MinValue;
			var maxY = int.MinValue;
			for (var v = map.Bounds.Top; v < map.Bounds.Bottom; v++)
			{
				for (var u = map.Bounds.Left; u < map.Bounds.Right; u++)
				{
					var cell = new MPos(u, v).ToCPos(map);
					if (!map.Contains(cell))
						continue;
					minX = Math.Min(minX, cell.X);
					minY = Math.Min(minY, cell.Y);
					maxX = Math.Max(maxX, cell.X);
					maxY = Math.Max(maxY, cell.Y);
				}
			}

			return minX == int.MaxValue
				? map.Bounds
				: Rectangle.FromLTRB(minX, minY, maxX + 1, maxY + 1);
		}

		static void WriteWorld(ref BufferWriter writer, World world, Player renderPlayer, Player[] players,
			Rectangle bounds)
		{
			writer.I32(bounds.Left);
			writer.I32(bounds.Top);
			writer.I32(bounds.Right);
			writer.I32(bounds.Bottom);
			writer.U32(1024);
			var renderPlayerIndex = Array.IndexOf(players, renderPlayer);
			writer.U16(renderPlayerIndex < 0 ? ushort.MaxValue : (ushort)renderPlayerIndex);
			writer.U8(world.IsGameOver ? (byte)3 : (byte)2);
			writer.U8(world.Paused ? (byte)2 : (byte)1);
			writer.U32(0); // No simulation-authored environment data is available.
		}

		static void WriteTerrain(ref BufferWriter writer, World world, Rectangle bounds)
		{
			var map = world.Map;
			var locomotors = world.WorldActor.TraitsImplementing<Locomotor>()
				.ToDictionary(l => l.Info.Name, StringComparer.Ordinal);
			writer.U32((uint)bounds.Width);
			writer.U32((uint)bounds.Height);
			for (var plane = 0; plane < 6; plane++)
			{
				for (var y = 0; y < bounds.Height; y++)
				{
					for (var x = 0; x < bounds.Width; x++)
					{
						var cell = new CPos(bounds.Left + x, bounds.Top + y);
						byte value = plane == 3 ? (byte)(1 << 4) : (byte)0;
						if (map.Contains(cell))
						{
							value = plane switch
							{
								0 => map.GetTerrainIndex(cell),
								1 => (byte)map.Height[cell],
								2 => map.Ramp[cell],
								3 => PassabilityFor(map, cell, locomotors),
								4 => (byte)map.Resources[cell].Type,
								5 => SurfaceFor(map, cell),
								_ => 0
							};
						}

						writer.U8(value);
					}
				}

				writer.Align4();
			}
		}

		static byte PassabilityFor(Map map, CPos cell, Dictionary<string, Locomotor> locomotors)
		{
			if (!map.Contains(cell))
				return 1 << 4;

			bool Passable(string name) => locomotors.TryGetValue(name, out var locomotor) &&
				locomotor.MovementCostForCell(cell) != PathGraph.MovementCostForUnreachableCell;

			var foot = Passable("foot");
			var wheeled = Passable("wheeled");
			var tracked = Passable("tracked");
			var naval = Passable("naval");
			var terrain = map.GetTerrainInfo(cell)?.Type;
			byte bits = 0;
			if (foot) bits |= 1 << 0;
			if (wheeled) bits |= 1 << 1;
			if (tracked) bits |= 1 << 2;
			if (terrain is "Water" or "Shallow") bits |= 1 << 3;
			if (!foot && !wheeled && !tracked && !naval) bits |= 1 << 4;
			return bits;
		}

		// Optional presentation provenance.32-byte records, drawn actors only; no hidden transforms.
		static void WriteDeployments(ref BufferWriter writer, Actor[] actors)
		{
			uint count = 0;
			foreach (var actor in actors)
				if (actor.TraitOrDefault<SteelseedDeployment>()?.TryMakeFrame(actor, out _, out _, out _) == true) count++;
			writer.U32(count);
			foreach (var actor in actors)
			{
				var deployment = actor.TraitOrDefault<SteelseedDeployment>();
				if (deployment == null || !deployment.TryMakeFrame(actor, out var frame, out var frames, out var frameMs)) continue;
				writer.U32(actor.ActorID);
				writer.U32(deployment.SourceActorId);
				writer.I32(deployment.SourcePosition.X);
				writer.I32(deployment.SourcePosition.Y);
				writer.I32(deployment.SourcePosition.Z);
				writer.U16((ushort)(deployment.SourceFacing.Angle & 1023));
				writer.U16(frame);
				writer.U16(frames);
				writer.U16(frameMs);
				writer.I32(deployment.CreatedTick);
			}
		}

		void WriteActors(ref BufferWriter writer, Actor[] actors, Dictionary<Player, byte> playerIndexes)
		{
			var turrets = actors.Select(a => a.TraitsImplementing<Turreted>().ToArray()).ToArray();
			var turretTotal = turrets.Sum(t => t.Length);
			writer.U32((uint)actors.Length);
			writer.U32((uint)turretTotal);

			foreach (var actor in actors) writer.U32(actor.ActorID);
			foreach (var actor in actors) writer.I32(actor.CenterPosition.X);
			foreach (var actor in actors) writer.I32(actor.CenterPosition.Y);
			foreach (var actor in actors) writer.I32(actor.CenterPosition.Z);
			foreach (var actor in actors) writer.U16(TypeId(actor.Info.Name));
			foreach (var actor in actors) writer.U16((ushort)(FirstTrait<IFacing>(actor)?.Facing.Angle & 1023 ?? 0));

			// Preserve the existing ABI v2 u16 animation slot. TakeCover exposes its exact
			// prone state through the infantry sequence modifier; no browser damage timer.
			// This is not a clip index. Other animation/production facts remain absent.
			foreach (var actor in actors) writer.U16(ActorAnimationState(actor));
			foreach (var actor in actors) writer.U16(ushort.MaxValue);

			var turretOffset = 0;
			for (var i = 0; i < actors.Length; i++)
			{
				writer.U16((ushort)turretOffset);
				turretOffset += turrets[i].Length;
			}

			foreach (var actor in actors)
			{
				var hasPrevious = lastPositions.TryGetValue(actor.ActorID, out var previous);
				var speed = hasPrevious
					? (actor.CenterPosition - previous.Position).Length /
						Math.Max(1, actor.World.WorldTick - previous.Tick)
					: 0;
				lastPositions[actor.ActorID] = (actor.CenterPosition, actor.World.WorldTick);
				writer.U16(hasPrevious ? (ushort)Math.Clamp(speed, 0, ushort.MaxValue - 1) : ushort.MaxValue);
			}

			writer.Align4();
			foreach (var actor in actors)
				writer.U8(actor.Owner != null && playerIndexes.TryGetValue(actor.Owner, out var owner) ? owner : byte.MaxValue);
			foreach (var actor in actors)
			{
				var health = actor.TraitOrDefault<Health>();
				writer.U8(health == null ? byte.MaxValue : (byte)Math.Clamp(255L * health.HP / Math.Max(1, health.MaxHP), 0, 255));
			}

			foreach (var actor in actors)
				writer.U8((byte)Math.Clamp(actor.TraitOrDefault<Cargo>()?.PassengerCount ?? 0, 0, byte.MaxValue));
			for (var i = 0; i < actors.Length; i++) writer.U8((byte)Math.Min(turrets[i].Length, byte.MaxValue));
			foreach (var actor in actors) writer.U8(ActorFlags(actor));
			foreach (var actor in actors)
			{
				var cell = actor.World.Map.CellContaining(actor.CenterPosition);
				writer.U8(actor.World.Map.Contains(cell) ? SurfaceFor(actor.World.Map, cell) : (byte)0);
			}

			foreach (var actor in actors)
			{
				var pools = actor.TraitsImplementing<AmmoPool>();
				var ammo = 0;
				var any = false;
				foreach (var pool in pools)
				{
					any = true;
					ammo += pool.CurrentAmmoCount;
				}

				writer.U8(any ? (byte)Math.Clamp(ammo, 0, 254) : (byte)255);
			}

			foreach (var actor in actors)
			{
				var cargo = actor.TraitOrDefault<Cargo>();
				writer.U8((byte)Math.Clamp(cargo?.ReservedCount ?? 0, 0, 255));
			}
			// Veterancy level of the actor's GainsExperience trait, 0 when the actor has no
			// experience track. Additive section field: the decoder reads the same trailing
			// U8 array before the turret facings (both sides change together).
			foreach (var actor in actors)
			{
				var veteran = actor.TraitOrDefault<GainsExperience>();
				writer.U8(veteran == null ? (byte)0 : (byte)Math.Clamp(veteran.Level, 0, byte.MaxValue));
			}

			writer.Align4();
			foreach (var actor in actors)
			{
				writer.U16(TypeId(DisplayInfo(actor).Name));
			}

			writer.Align4();
			foreach (var actorTurrets in turrets)
				foreach (var turret in actorTurrets)
					writer.U16((ushort)(turret.WorldOrientation.Yaw.Angle & 1023));

			// Optional aligned tail: exact parent of an authoritative falling aircraft husk.
			writer.Align4();
			foreach (var actor in actors)
				writer.U32(actor.TraitOrDefault<FallsToEarth>()?.PresentationParentId ?? 0);
		}

		void WriteFrozenActors(ref BufferWriter writer, FrozenActor[] actors,
			Dictionary<Player, byte> playerIndexes)
		{
			writer.U32((uint)actors.Length);
			foreach (var actor in actors) writer.U32(actor.ID);
			foreach (var actor in actors) writer.I32(actor.CenterPosition.X);
			foreach (var actor in actors) writer.I32(actor.CenterPosition.Y);
			foreach (var actor in actors) writer.I32(actor.CenterPosition.Z);
			foreach (var actor in actors) writer.U16(TypeId(actor.Info.Name));
			writer.Align4();
			foreach (var actor in actors)
				writer.U8(actor.Owner != null && playerIndexes.TryGetValue(actor.Owner, out var owner) ? owner : byte.MaxValue);
			foreach (var actor in actors)
			{
				var health = actor.Info.TraitInfoOrDefault<HealthInfo>();
				writer.U8(health == null ? byte.MaxValue :
					(byte)Math.Clamp(255L * actor.HP / Math.Max(1, health.HP), 0, 255));
			}
		}

		static ushort ActorAnimationState(Actor actor)
		{
			return actor.TraitsImplementing<TakeCover>()
				.Any(t => ((IRenderInfantrySequenceModifier)t).IsModifyingSequence)
				? SnapshotContract.AnimationState.Prone : ushort.MaxValue;
		}

		static byte ActorFlags(Actor actor)
		{
			byte flags = 0;
			if (actor.IsDead || actor.TraitOrDefault<FallsToEarth>() != null)
				flags |= SnapshotContract.ActorFlag.Husk;
			// Inoperative is the rules' own `disabled` condition (low power, a spy's outage, a
			// player's power-down). This used to test whether ANY conditional trait was off, and
			// ^IronCurtainable's damage multiplier is off on every unit that is not curtained, so
			// the flag was set on nearly every actor and meant nothing.
			if (HasCondition(actor, "disabled"))
				flags |= SnapshotContract.ActorFlag.Disabled;
			if (actor.TraitOrDefault<Parachutable>()?.IsInAir == true)
				flags |= SnapshotContract.ActorFlag.Parachuting;
			if (actor.TraitsImplementing<Cloak>().Any(t => t.Cloaked))
				flags |= SnapshotContract.ActorFlag.Cloaked;
			if (actor.TraitsImplementing<IMove>().Any(t => t.CurrentMovementTypes != MovementType.None))
				flags |= SnapshotContract.ActorFlag.Moving;
			if (actor.TraitsImplementing<IIssueDeployOrder>().Any(t => t.CanIssueDeployOrder(actor, false)))
				flags |= SnapshotContract.ActorFlag.Deployable;
			if (actor.TraitsImplementing<AttackBase>().Any(t => t.IsAiming))
				flags |= SnapshotContract.ActorFlag.Firing;
			return flags;
		}

		// Presentation reads of private engine state, compiled to direct field access (.NET 8
		// UnsafeAccessor: no reflection per tick, and the trimmer keeps the fields). Read only.
		[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "conditionCache")]
		static extern ref Dictionary<string, int> ConditionCache(Actor actor);
		[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "expires")]
		static extern ref int ExternalExpires(ExternalCondition condition);
		[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "duration")]
		static extern ref int ExternalDuration(ExternalCondition condition);
		[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "duration")]
		static extern ref int ChronoshiftDuration(Chronoshiftable chronoshiftable);

		/// <summary>True while at least one token grants the named condition to the actor.</summary>
		static bool HasCondition(Actor actor, string condition) =>
			ConditionCache(actor).TryGetValue(condition, out var count) && count > 0;

		/// <summary>
		/// Section 13, `actors.status` (additive, ABI v2): timed states a visible unit carries.
		/// u32 count, then 12-byte records {u32 actorId, u8 kind, u8 0, u16 remainingTicks,
		/// u16 totalTicks, u16 0}. Kind 1: invulnerable (the Iron Curtain, or the crate), shown to
		/// every viewer as OpenRA's red overlay is. Kind 2: chronoshifted and due to return to its
		/// origin, only for the render player's allies, as OpenRA's own return bar. Remaining 0
		/// means unknown (a permanent grant). Only actors in this snapshot's visible set.
		/// </summary>
		static void WriteActorStatus(ref BufferWriter writer, Actor[] actors, World world, Player renderPlayer)
		{
			var countAt = writer.Position;
			writer.U32(0);
			uint count = 0;
			foreach (var actor in actors)
			{
				if (actor.IsDead || !actor.IsInWorld)
					continue;
				if (HasCondition(actor, "invulnerability"))
				{
					var curtain = actor.TraitsImplementing<ExternalCondition>().FirstOrDefault(c => c.Info.Condition == "invulnerability");
					var remaining = curtain == null ? 0 : Math.Max(0, ExternalExpires(curtain) - world.WorldTick);
					var total = curtain == null ? 0 : ExternalDuration(curtain);
					WriteStatus(ref writer, actor.ActorID, 1, remaining, total);
					count++;
				}
				var chrono = actor.TraitOrDefault<Chronoshiftable>();
				if (chrono != null && chrono.ReturnTicks > 0 && renderPlayer != null && actor.Owner.IsAlliedWith(renderPlayer))
				{
					WriteStatus(ref writer, actor.ActorID, 2, chrono.ReturnTicks, ChronoshiftDuration(chrono));
					count++;
				}
			}
			writer.PatchU32(countAt, count);
		}

		static void WriteStatus(ref BufferWriter writer, uint actorId, byte kind, int remaining, int total)
		{
			writer.U32(actorId);
			writer.U8(kind);
			writer.U8(0);
			writer.U16((ushort)Math.Clamp(remaining, 0, ushort.MaxValue));
			writer.U16((ushort)Math.Clamp(total, 0, ushort.MaxValue));
			writer.U16(0);
		}

		static ActorInfo DisplayInfo(Actor actor)
		{
			var effectiveOwner = actor.EffectiveOwner;
			if (effectiveOwner == null || !effectiveOwner.Disguised)
				return actor.Info;

			var asActor = effectiveOwner.GetType()
				.GetProperty("AsActor", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)
				?.GetValue(effectiveOwner) as ActorInfo;
			return asActor ?? actor.Info;
		}

		void WriteLifecycle(ref BufferWriter writer, Dictionary<Player, byte> playerIndexes)
		{
			var visible = pendingLifecycle.Where(record => record.Kind == 1 || lastVisibleActors.Contains(record.ActorId)).ToArray();
			writer.U32((uint)visible.Length);
			foreach (var record in visible)
			{
				writer.U32(record.ActorId);
				writer.U16(record.TypeId);
				writer.U8(record.Kind);
				writer.U8(record.Owner != null && playerIndexes.TryGetValue(record.Owner, out var owner) ? owner : byte.MaxValue);
			}
		}

		// The shroud section is the single most expensive thing the emitter does under the
		// interpreter: three lookups per cell over the whole playable area, every tick. The
		// shroud publishes a change counter, so a tick on which nothing was revealed re-emits
		// the previous encoding with one block copy instead of re-walking the map.
		Player shroudCachePlayer;
		int shroudCacheHash = int.MinValue;
		bool shroudCacheDisabled;
		byte[] shroudCache = new byte[16];
		int shroudCacheLength;

		void WriteShroud(ref BufferWriter writer, Map map, Player renderPlayer, Rectangle bounds)
		{
			if (renderPlayer?.Shroud == null || bounds.Width <= 0 || bounds.Height <= 0)
			{
				writer.U32(0);
				return;
			}

			var shroud = renderPlayer.Shroud;
			if (ReferenceEquals(renderPlayer, shroudCachePlayer) && shroud.Hash == shroudCacheHash &&
				shroud.Disabled == shroudCacheDisabled && shroudCacheLength > 0)
			{
				writer.Bytes(shroudCache, shroudCacheLength);
				return;
			}

			var runs = new List<(uint Start, ushort Length, byte State)>();
			var cellCount = bounds.Width * bounds.Height;
			// Rectangular grids (every RA tileset) map CPos and MPos one to one, so the walk
			// can index the shroud layers directly and skip the per-cell containment test,
			// which the render bounds already guarantee.
			var rectangular = map.Grid.Type == MapGridType.Rectangular;

			// FOG OFF IS NOT SHROUD OFF, and this grid used to claim otherwise.
			//
			// Shroud.IsVisible short-circuits to "every cell of the map" the moment the lobby's
			// fog option is unticked, because with no fog there is nothing between the player and
			// ground they have already uncovered. Actor visibility does NOT follow it there:
			// HiddenUnderFog.IsVisibleInner falls back to EXPLORATION when fog is disabled, so an
			// enemy standing in ground the player has never uncovered stays hidden and never
			// reaches ActorVisible below. Building the published grid from IsVisible alone
			// therefore painted the whole map as fully seen while the same snapshot withheld every
			// actor on it — a lit, empty world, which is exactly what "the fog is off and I still
			// cannot see the enemy" looks like.
			//
			// State 2 is the client's licence to draw a LIVE actor, so it has to mean what the
			// simulation means: visible AND explored. With fog on, Shroud.UpdateCell only resolves
			// Visible for cells it has already marked explored, so that pair is already IsVisible
			// and nothing changes; only the fog-off case moves, and it moves onto the exploration
			// layer the actor traits are reading. Shroud.Disabled (observer/dev reveal) reports
			// explored everywhere and still resolves to 2.
			var fogless = !shroud.FogEnabled;
			byte StateAt(int index)
			{
				var x = index % bounds.Width;
				var y = index / bounds.Width;
				if (rectangular)
				{
					var uv = new MPos(bounds.Left + x, bounds.Top + y);
					if (fogless)
						return shroud.IsExplored(uv) ? (byte)2 : (byte)0;
					if (shroud.IsVisible(uv))
						return 2;
					return shroud.IsExplored(uv) ? (byte)1 : (byte)0;
				}

				var cell = new CPos(bounds.Left + x, bounds.Top + y);
				if (!map.Contains(cell))
					return 0;
				if (fogless)
					return shroud.IsExplored(cell) ? (byte)2 : (byte)0;
				if (shroud.IsVisible(cell))
					return 2;
				return shroud.IsExplored(cell) ? (byte)1 : (byte)0;
			}

			var runStart = 0;
			var runState = StateAt(0);
			var runLength = 1;
			for (var index = 1; index < cellCount; index++)
			{
				var state = StateAt(index);
				if (state == runState && runLength < ushort.MaxValue)
				{
					runLength++;
					continue;
				}

				runs.Add(((uint)runStart, (ushort)runLength, runState));
				runStart = index;
				runLength = 1;
				runState = state;
			}

			runs.Add(((uint)runStart, (ushort)runLength, runState));

			var needed = 4 + runs.Count * 8;
			if (shroudCache.Length < needed)
				shroudCache = new byte[Math.Max(needed, shroudCache.Length * 2)];
			var cache = new BufferWriter(shroudCache, 0);
			cache.U32((uint)runs.Count);
			foreach (var run in runs)
			{
				cache.U32(run.Start);
				cache.U16(run.Length);
				cache.U8(run.State);
				cache.U8(0);
			}

			shroudCacheLength = cache.Position;
			shroudCachePlayer = renderPlayer;
			shroudCacheHash = shroud.Hash;
			shroudCacheDisabled = shroud.Disabled;
			writer.Bytes(shroudCache, shroudCacheLength);
		}

		/// <summary>
		/// Map every WeaponInfo back to the name the RULES were authored with.
		///
		/// MEASURED, not assumed. `Ruleset.Weapons` is keyed by `k.Key.ToLowerInvariant()`
		/// (Ruleset.MergeOrDefault), while the only other weapon name on the wire — the fire
		/// event's `armament.Info.Weapon` — carries the authored casing, and the client's visual
		/// catalogue (`web/src/weapon-visual-manifest.json`) is keyed on that. Publishing the
		/// dictionary key put a SECOND, unmatchable name in the string table: a live match
		/// published a rocket soldier's missile as "dragon", the catalogue holds "Dragon", the
		/// lookup missed, and the client classified a real in-flight missile as a weapon with no
		/// visible body and drew nothing at all. The casing survives on the armaments, so it is
		/// recovered from there and the same string reaches the client from both paths.
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
				weaponNames[info] = authored.TryGetValue(name, out var cased) ? cased : name;
		}

		/// <summary>
		/// Gather every live projectile the render player is allowed to see.
		///
		/// OpenRA keeps projectiles in World.Effects, not in World.Actors, and every one of them
		/// holds its position privately and publishes it only through IEffect.Render — which needs
		/// a WorldRenderer, sprite sequences and a palette that the browser host does not have.
		/// IProjectileFlight is the presentation-only read surface added for exactly this walk;
		/// see engine/openra/OpenRA.Game/Effects/IProjectileFlight.cs.
		///
		/// The walk mirrors the actor pass's discipline: one linear scan into a reused list, the
		/// same visible-AND-explored shroud rule the event feed uses, and a hard count ceiling so
		/// a saturated battlefield degrades by dropping flights rather than by growing the frame.
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

				if (effect is not IProjectileFlight flight || !flight.FlightLaunched)
					continue;

				var position = flight.FlightPosition;
				if (!CellVisible(map, shroud, position))
					continue;

				// A beam's far end IS the position of whatever it is holding. Publishing it over
				// ground the player has not uncovered would draw an arc pointing straight at an
				// enemy the same snapshot deliberately withholds, so a beam needs BOTH ends
				// visible. A travelling flight publishes its own position as its target, which
				// carries no intelligence the client does not already have.
				var beam = flight.FlightIsBeam;
				var target = beam ? flight.FlightTarget : position;
				if (beam && !CellVisible(map, shroud, target))
					continue;

				var weapon = flight.FlightWeapon;
				var name = weapon != null && weaponNames.TryGetValue(weapon, out var resolved) ? resolved : "";
				var remaining = flight.FlightRemainingTicks;
				// A projectile entering vision must never reveal its hidden launch point or actor.
				var launchVisible = lastVisibleActors.Contains(flight.FlightSourceActorId) &&
					CellVisible(map, shroud, flight.FlightLaunchPosition);
				projectileScratch.Add(new ProjectileRecord(
					// A projectile has no simulation identity, and a synthetic one that persisted
					// across frames would have to be swept when a flight is removed. The runtime
					// object hash is stable for the object's lifetime and free; the client uses it
					// only to keep a trail and a jitter seed attached to the same flight, so a
					// collision between two simultaneous flights costs a shared seed, not a bug.
					unchecked((uint)RuntimeHelpers.GetHashCode(effect)),
					launchVisible ? flight.FlightSourceActorId : 0,
					position,
					target,
					flight.FlightVelocity,
					TypeId(name),
					remaining < 0 ? ushort.MaxValue : (ushort)Math.Min(remaining, ushort.MaxValue - 1),
					beam ? (byte)1 : (byte)0,
					launchVisible ? flight.FlightLaunchPosition : WPos.Zero,
					launchVisible ? flight.FlightArmament : ushort.MaxValue,
					launchVisible ? flight.FlightBarrel : ushort.MaxValue,
					launchVisible ? flight.FlightShot : 0));
			}
		}

		/// <summary>
		/// The exact visibility rule the event feed uses, for the reason EventVisible spells out:
		/// with the fog option off IsVisible answers yes for the whole map, including ground the
		/// player has never uncovered, so visibility alone would leak.
		/// </summary>
		static bool CellVisible(Map map, Shroud shroud, WPos position)
		{
			var cell = map.CellContaining(position);
			return map.Contains(cell) && shroud.IsVisible(cell) && shroud.IsExplored(cell);
		}

		/// <summary>
		/// Section 5, structure of arrays, 43 bytes per projectile:
		/// u32 count, then u32 id, u32 sourceActorId, i32 posX/posY/posZ, i32 tgtX/tgtY/tgtZ,
		/// i16 velX/velY/velZ, u16 typeId, u16 remainingTicks, u8 kind.
		///
		/// Positions are WPos, 1024 per cell, exactly like every other position in the contract.
		/// `kind` is 0 for a body travelling through the air and 1 for an instantaneous beam;
		/// `remainingTicks` is 65535 when the projectile homes and cannot know its own arrival.
		/// </summary>
		void WriteProjectiles(ref BufferWriter writer)
		{
			var count = projectileScratch.Count;
			writer.U32((uint)count);
			for (var i = 0; i < count; i++)
				writer.U32(projectileScratch[i].Id);
			for (var i = 0; i < count; i++)
				writer.U32(projectileScratch[i].SourceActorId);
			for (var i = 0; i < count; i++)
				writer.I32(projectileScratch[i].Position.X);
			for (var i = 0; i < count; i++)
				writer.I32(projectileScratch[i].Position.Y);
			for (var i = 0; i < count; i++)
				writer.I32(projectileScratch[i].Position.Z);
			for (var i = 0; i < count; i++)
				writer.I32(projectileScratch[i].Target.X);
			for (var i = 0; i < count; i++)
				writer.I32(projectileScratch[i].Target.Y);
			for (var i = 0; i < count; i++)
				writer.I32(projectileScratch[i].Target.Z);
			for (var i = 0; i < count; i++)
				writer.I16(TickVelocity(projectileScratch[i].Velocity.X));
			for (var i = 0; i < count; i++)
				writer.I16(TickVelocity(projectileScratch[i].Velocity.Y));
			for (var i = 0; i < count; i++)
				writer.I16(TickVelocity(projectileScratch[i].Velocity.Z));
			for (var i = 0; i < count; i++)
				writer.U16(projectileScratch[i].TypeId);
			for (var i = 0; i < count; i++)
				writer.U16(projectileScratch[i].RemainingTicks);
			for (var i = 0; i < count; i++)
				writer.U8(projectileScratch[i].Kind);
			// Optional versioned extension. Keep the legacy 43n-byte prefix unchanged.
			while ((writer.Position & 3) != 0) writer.U8(0);
			for (var i = 0; i < count; i++) writer.I32(projectileScratch[i].Launch.X);
			for (var i = 0; i < count; i++) writer.I32(projectileScratch[i].Launch.Y);
			for (var i = 0; i < count; i++) writer.I32(projectileScratch[i].Launch.Z);
			for (var i = 0; i < count; i++) writer.U32(projectileScratch[i].Shot);
			for (var i = 0; i < count; i++) writer.U16(projectileScratch[i].Armament);
			for (var i = 0; i < count; i++) writer.U16(projectileScratch[i].Barrel);
		}

		/// <summary>
		/// Velocity is WDist PER SIMULATION TICK, unscaled, clamped into Int16.
		///
		/// The scale is 1 because the field cannot overflow at 1. The fastest Projectile Speed in
		/// the whole RA ruleset is 1c682 = 1706 WDist/tick, and it belongs to the medic's Heal and
		/// the dog's Claw rather than to anything that flies; the fastest ballistic weapon is 853.
		/// Int16 holds 32767, so the field carries 19x headroom over the fastest thing in the game
		/// and the clamp can only ever fire on a modded ruleset. Keeping the scale at 1 also means
		/// the client converts velocity with exactly the WPos-to-metres constant it already uses
		/// for positions, so there is no second unit to get wrong.
		/// </summary>
		static short TickVelocity(int component) =>
			(short)Math.Clamp(component, short.MinValue, short.MaxValue);

		void WriteEvents(ref BufferWriter writer, Map map, Player renderPlayer,
			Dictionary<Player, byte> playerIndexes, SteelseedEventSink sink)
		{
			var source = sink?.Events ?? Array.Empty<SteelseedPresentationEvent>();
			var visible = source.Where(record => EventVisible(record, map, renderPlayer) &&
				(record.Kind != SteelseedEventKind.WeaponFire || lastVisibleActors.Contains(record.ActorId)))
				.OrderBy(record => record.Kind == SteelseedEventKind.WeaponFire ? 0 : 1).ToArray();
			// A full sink refuses records; say so rather than let the presentation assume it saw
			// every shot. The count covers all refused records, visible or not.
			var dropped = sink?.Dropped ?? 0;
			writer.U32((uint)(visible.Length + (dropped > 0 ? 1 : 0)));
			if (dropped > 0)
			{
				writer.U16((ushort)SteelseedEventKind.EventsDropped);
				writer.U16(4);
				writer.U32((uint)dropped);
			}
			foreach (var record in visible)
			{
				writer.U16((ushort)record.Kind);
				writer.U16(record.Kind switch
				{
					SteelseedEventKind.WeaponFire => 30,
					SteelseedEventKind.ActorDamaged => 22,
					SteelseedEventKind.ProjectileImpact => 34,
					SteelseedEventKind.ActorDestroyed => 19,
					SteelseedEventKind.ProductionComplete => 4,
					_ => 0
				});
				switch (record.Kind)
				{
					case SteelseedEventKind.WeaponFire:
						writer.U32(record.ActorId);
						writer.U16(record.Armament);
						WritePosition(ref writer, record.Position);
						writer.U16((ushort)(record.Incidence.Yaw.Angle & 1023));
						writer.U16(TypeId(record.Weapon));
						writer.U16(record.Magnitude);
						writer.U16(record.Barrel);
						writer.U32(record.Shot);
						break;
					case SteelseedEventKind.ProjectileImpact:
						WritePosition(ref writer, record.Position);
						WriteDirection(ref writer, record.Incidence);
						var impactCell = map.CellContaining(record.Position);
						writer.U8(map.Contains(impactCell) ? SurfaceFor(map, impactCell) : (byte)0);
						writer.U8(0);
						writer.U16(record.Magnitude);
						writer.U16(TypeId(record.Weapon));
						var visibleSource = lastVisibleActors.Contains(record.ActorId);
						writer.U32(visibleSource ? record.ActorId : 0);
						writer.U16(visibleSource ? record.Armament : ushort.MaxValue);
						writer.U32(visibleSource ? record.Shot : 0);
						break;
					case SteelseedEventKind.ActorDamaged:
						WritePosition(ref writer, record.Position);
						WriteDirection(ref writer, record.Incidence);
						var damageCell = map.CellContaining(record.Position);
						writer.U8(map.Contains(damageCell) ? SurfaceFor(map, damageCell) : (byte)0);
						writer.U8(255); // Impact observer owns combat FX/audio; keep damage for other consumers.
						writer.U16(record.Magnitude);
						break;
					case SteelseedEventKind.ActorDestroyed:
						writer.U32(record.ActorId);
						WritePosition(ref writer, record.Position);
						writer.U8(record.Player != null && playerIndexes.TryGetValue(record.Player, out var owner)
							? owner : byte.MaxValue);
					writer.U8(record.Violence);
					writer.U8(record.VoiceKind); // rules-resolved death voice: 0 none, 1 normal, 2 burned, 3 zapped
						break;
					case SteelseedEventKind.ProductionComplete:
						writer.U8(record.Player != null && playerIndexes.TryGetValue(record.Player, out var player)
							? player : byte.MaxValue);
						writer.U8(byte.MaxValue); // Queue identity is not exposed by INotifyProduction.
						writer.U16(TypeId(record.ProducedType));
						break;
				}

				writer.Align4();
			}
		}

		static bool EventVisible(in SteelseedPresentationEvent record, Map map, Player renderPlayer)
		{
			if (renderPlayer?.Shroud == null)
				return false;
			if (record.Kind == SteelseedEventKind.ProductionComplete)
				return record.Player == renderPlayer;
			var cell = map.CellContaining(record.Position);
			// Explored as well as visible, for the reason WriteShroud spells out: with the fog
			// option off IsVisible answers "yes" for the whole map, including ground the player
			// has never uncovered, and a muzzle flash or an explosion crossing from there is the
			// same intelligence leak as drawing the actor that caused it. With fog on, a visible
			// cell is always an explored one and this reads exactly as it did before.
			return map.Contains(cell) && renderPlayer.Shroud.IsVisible(cell) && renderPlayer.Shroud.IsExplored(cell);
		}

		static void WritePosition(ref BufferWriter writer, WPos position)
		{
			writer.I32(position.X);
			writer.I32(position.Y);
			writer.I32(position.Z);
		}

		static void WriteDirection(ref BufferWriter writer, WVec direction)
		{
			var length = Math.Max(1, direction.Length);
			writer.I16((short)Math.Clamp(32767L * direction.X / length, short.MinValue, short.MaxValue));
			writer.I16((short)Math.Clamp(32767L * direction.Y / length, short.MinValue, short.MaxValue));
			writer.I16((short)Math.Clamp(32767L * direction.Z / length, short.MinValue, short.MaxValue));
		}

		/// <summary>
		/// A client sees its own and its allies' economy; an enemy's cash, power and production are
		/// withheld (fog fairness, vfx.md S07). A spectator, with no render player, sees everyone's.
		/// </summary>
		static bool EconomyVisible(Player renderPlayer, Player player) =>
			renderPlayer == null || renderPlayer.Spectating || player == renderPlayer || renderPlayer.IsAlliedWith(player);

		void WritePlayers(ref BufferWriter writer, Player[] players, Player renderPlayer)
		{
			writer.U32((uint)players.Length);
			for (var playerIndex = 0; playerIndex < players.Length; playerIndex++)
			{
				var player = players[playerIndex];
				var open = EconomyVisible(renderPlayer, player);
				var resources = open ? player.PlayerActor?.TraitOrDefault<PlayerResources>() : null;
				var power = open ? player.PlayerActor?.TraitOrDefault<PowerManager>() : null;
				var queues = open ? PlayerQueues(player) : [];
				var color = Player.GetColor(player);
				writer.U32((uint)Math.Max(0, resources?.Cash ?? 0));
				writer.U32((uint)Math.Max(0, resources?.Resources ?? 0));
				writer.I16((short)Math.Clamp(power?.PowerProvided ?? 0, short.MinValue, short.MaxValue));
				writer.I16((short)Math.Clamp(power?.PowerDrained ?? 0, short.MinValue, short.MaxValue));
				writer.I32(player.ClientIndex);
				writer.U16(TypeId(player.Faction?.InternalName ?? ""));
				var lobbyTeam = player.World.LobbyInfo.ClientWithIndex(player.ClientIndex)?.Team;
				writer.I16((short)Math.Clamp(lobbyTeam ?? player.PlayerReference?.Team ?? 0, short.MinValue, short.MaxValue));
				writer.U8(Relationship(renderPlayer, player));
				writer.U8(PlayerFlags(player, renderPlayer));
				writer.U8(color.R);
				writer.U8(color.G);
				writer.U8(color.B);
				writer.U8(color.A);

				// The RA player model does not expose a canonical synchronized score. Mark it
				// absent instead of reporting an invented score of zero.
				writer.U32(uint.MaxValue);
				writer.U16((ushort)Math.Min(queues.Length, ushort.MaxValue));
				writer.U16(0);
				writer.U16(0);

				for (var queueIndex = 0; queueIndex < queues.Length; queueIndex++)
				{
					var queue = queues[queueIndex];
					var current = queue.CurrentItem();
					writer.U16((ushort)queueIndex);
					writer.U16(current == null ? ushort.MaxValue : TypeId(current.Item));
					writer.U16(ProductionProgress(current));
					writer.U16((ushort)Math.Min(queue.AllQueued().Count(), ushort.MaxValue));
				}
			}
		}

		void WriteProduction(ref BufferWriter writer, Player[] players, Player renderPlayer)
		{
			var queues = players.SelectMany((player, playerIndex) => (EconomyVisible(renderPlayer, player) ? PlayerQueues(player) : [])
				.Select((queue, queueIndex) => (PlayerIndex: playerIndex, QueueIndex: queueIndex, Queue: queue))).ToArray();
			writer.U32((uint)queues.Length);
			foreach (var entry in queues)
			{
				var queue = entry.Queue;
				var current = queue.CurrentItem();
				var items = queue.AllItems().ToArray();
				var buildable = queue.BuildableItems().Select(i => i.Name).ToHashSet(StringComparer.Ordinal);
				var queued = queue.AllQueued().GroupBy(i => i.Item).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
				byte flags = 0;
				if (queue.Enabled) flags |= 1 << 0;
				if (current?.Paused == true) flags |= 1 << 1;
				if (current?.Done == true) flags |= 1 << 2;
				writer.U8((byte)Math.Min(entry.PlayerIndex, byte.MaxValue));
				writer.U8((byte)Math.Min(entry.QueueIndex, byte.MaxValue));
				writer.U8(flags);
				writer.U8(ProductionKind(queue.Info.Type));
				writer.U16(current == null ? ushort.MaxValue : TypeId(current.Item));
				writer.U16(ProductionProgress(current));
				writer.U16((ushort)Math.Min(queue.AllQueued().Count(), ushort.MaxValue));
				writer.U16((ushort)Math.Min(items.Length, ushort.MaxValue));

				foreach (var item in items)
				{
					ushort itemFlags = 1 << 0;
					if (buildable.Contains(item.Name)) itemFlags |= 1 << 1;
					if (queued.ContainsKey(item.Name)) itemFlags |= 1 << 2;
					if (current?.Item == item.Name) itemFlags |= 1 << 3;
					if (current?.Item == item.Name && current.Done) itemFlags |= 1 << 4;
					if (item.HasTraitInfo<BuildingInfo>()) itemFlags |= 1 << 5;
					writer.U16(TypeId(item.Name));
					writer.U16(itemFlags);
					writer.U32((uint)Math.Max(0, queue.GetProductionCost(item)));
					writer.U16((ushort)Math.Clamp(queue.GetBuildTime(item, item.TraitInfo<BuildableInfo>()), 0, ushort.MaxValue));
					writer.U16((ushort)Math.Min(queued.GetValueOrDefault(item.Name), ushort.MaxValue));
				}
			}
		}

		static ProductionQueue[] PlayerQueues(Player player)
		{
			if (player.PlayerActor == null)
				return [];

			return player.PlayerActor.TraitsImplementing<ProductionQueue>().Where(q => q.IsValidFaction).ToArray();
		}

		static byte Relationship(Player renderPlayer, Player player)
		{
			if (renderPlayer == player)
				return 0;
			if (renderPlayer == null)
				return 3;
			return renderPlayer.RelationshipWith(player) switch
			{
				PlayerRelationship.Ally => 1,
				PlayerRelationship.Enemy => 2,
				_ => 3
			};
		}

		static byte PlayerFlags(Player player, Player renderPlayer)
		{
			byte flags = 0;
			if (player.WinState == WinState.Undefined) flags |= SnapshotContract.PlayerFlag.Alive;
			if (player == renderPlayer) flags |= SnapshotContract.PlayerFlag.IsRenderPlayer;
			if (player.IsBot) flags |= SnapshotContract.PlayerFlag.IsBot;
			if (player.WinState == WinState.Won) flags |= SnapshotContract.PlayerFlag.Won;
			if (player.WinState == WinState.Lost) flags |= SnapshotContract.PlayerFlag.Lost;
			return flags;
		}

		static ushort ProductionProgress(ProductionItem item)
		{
			if (item == null || !item.Started)
				return 0;
			if (item.Done || item.TotalTime <= 0)
				return 1000;
			return (ushort)Math.Clamp(1000L * (item.TotalTime - item.RemainingTime) / item.TotalTime, 0, 1000);
		}

		static byte ProductionKind(string type)
		{
			// RA splits each palette across concrete OpenRA queue types (Building/Defense,
			// Infantry/Soldier, Aircraft/Plane/Helicopter and Ship/Boat/Submarine). The
			// browser ABI exposes five player-facing categories, so every resolved synonym
			// must map explicitly instead of leaking an opaque "Queue N" label into the HUD.
			if (type.EndsWith("Building", StringComparison.Ordinal) || type == "Defense") return 0;
			if (type.EndsWith("Infantry", StringComparison.Ordinal) || type == "Soldier") return 1;
			if (type.EndsWith("Vehicle", StringComparison.Ordinal)) return 2;
			if (type.EndsWith("Aircraft", StringComparison.Ordinal) || type is "Plane" or "Helicopter") return 3;
			if (type.EndsWith("Naval", StringComparison.Ordinal) || type is "Ship" or "Boat" or "Submarine") return 4;
			return byte.MaxValue;
		}

		ushort TypeId(string name)
		{
			name ??= "";
			if (typeIds.TryGetValue(name, out var id))
				return id;

			if (typeNames.Count >= ushort.MaxValue)
				throw new InvalidOperationException("Snapshot string table exhausted.");
			id = (ushort)typeNames.Count;
			typeIds.Add(name, id);
			typeNames.Add(name);
			return id;
		}

		static T FirstTrait<T>(Actor actor) where T : class
		{
			foreach (var trait in actor.TraitsImplementing<T>())
				return trait;
			return null;
		}

		static byte SurfaceFor(Map map, CPos cell)
		{
			var type = map.GetTerrainInfo(cell)?.Type;

			// RA "Clear" is the tileset's ground, not a missing surface. Mapping it to soil
			// painted temperate maps as dirt squares. Desert stays sand; snow stays snow.
			if (type is "Clear" or "Tree")
				return map.Tileset switch
				{
					"DESERT" => 2,
					"SNOW" => 10,
					_ => 4
				};

			return type switch
			{
				"Beach" => 2,
				"Bridge" => 6,
				"ClearNoSmudges" => 7,
				"Gems" => 12,
				"Ore" => 12,
				"River" => 9,
				"Rock" => 1,
				"Rough" => 3,
				"Sand" => 2,
				"Gravel" => 3,
				"Grass" => 4,
				"Road" => 5,
				"Metal" => 6,
				"Concrete" => 7,
				"Wall" => 7,
				"Water" => 8,
				"Shallow" => 9,
				"Snow" => 10,
				"Ash" => 11,
				"Resource" => 12,
				_ => 0
			};
		}
	}
}
