#region Copyright & License Information
/*
 * Copyright (c) The OpenRA Developers and Contributors
 * This file is part of OpenRA, which is free software under the terms of
 * the GNU General Public License, available in the engine source tree.
 */
#endregion

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using OpenRA.Effects;
using OpenRA.Mods.Common.Effects;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA
{
	[SupportedOSPlatform("browser")]
	public static partial class Program
	{
		/// <summary>
		/// Charge status of every support power the local player owns, for the browser's
		/// SUPPORT tab, and every player's public superweapon timers. Firing is deliberately NOT exported here: an activation is the
		/// plain OpenRA order whose OrderString is the power key, issued on the player
		/// actor — exactly what the generic IssueOrderN already produces with zero
		/// subjects and a cell target (SelectGenericPowerTarget.OrderInner issues the
		/// same order in the original game).
		/// </summary>
		[JSExport]
		internal static string GetSupportPowers()
		{
			try
			{
				var world = Game.OrderManager?.World;
				var localPlayer = world?.RenderPlayer ?? world?.LocalPlayer;
				var manager = localPlayer?.PlayerActor?.TraitOrDefault<SupportPowerManager>();
				if (world == null || localPlayer == null || manager == null)
					return ErrorJson("no-support-powers", "No local skirmish player owns a support power manager.");

				// A disabled power is off the palette, as OpenRA's own palette shows only
				// `!Disabled` powers: a one-shot that has fired (the GPS satellite), one whose
				// prerequisite is gone, a lost player's. Left in, it read as "paused: too little
				// power", because Active is false for it too. What remains inactive IS paused.
				var powers = manager.Powers
					.Where(pair => !pair.Value.Disabled)
					.OrderBy(pair => pair.Value.Info?.SupportPowerPaletteOrder ?? int.MaxValue)
					.ThenBy(pair => pair.Key, StringComparer.Ordinal)
					.Select(pair => new SupportPowerDto(
						pair.Key,
						PowerTitle(pair.Key, pair.Value),
						pair.Value.Active,
						pair.Value.Ready,
						pair.Value.RemainingTicks,
						pair.Value.TotalTicks,
						// Chronoshift takes two cells: the source footprint (Order.ExtraLocation)
						// and the destination (the order target). Its info type is internal to
						// OpenRA.Mods.Cnc, so it is recognised by name.
						pair.Value.Info?.GetType().Name == "ChronoshiftPowerInfo",
						BeaconTicks(pair.Value.Info),
						BeaconUnit(pair.Value.Info),
						BeaconRangeCells(pair.Value.Info),
						EffectTicks(pair.Value.Info)))
					.ToArray();

				// Ticks become seconds at the match's own speed, never a wall-clock guess. A spy in
				// one of the local player's power plants stops the grid for the outage's ticks.
				var power = localPlayer.PlayerActor.TraitOrDefault<PowerManager>();
				return JsonSerializer.Serialize(
					new SupportPowersDto(SupportPowersSchemaVersion, world.Timestep,
						power?.PowerOutageRemainingTicks ?? 0, power?.PowerOutageTotalTicks ?? 0, powers,
						PublicTimers(world, localPlayer),
						Launches(world, localPlayer),
						Revealed(world, localPlayer)),
					SkirmishJsonContext.Default.SupportPowersDto);
			}
			catch (Exception e)
			{
				return ErrorJson("support-powers-failed", $"Could not read support powers: {e.Message}");
			}
		}

		// 2: every power carries its beacon (ticks, or the delivering aircraft), and the status
		// carries every player's public superweapon timers. `revealed` is additive within 2.
		const int SupportPowersSchemaVersion = 2;

		// InfiltrateForDecoration's own record of who has been inside (OpenRA.Mods.Cnc, internal;
		// the assembly is a trimmer root, so the field survives publishing).
		static System.Reflection.FieldInfo infiltratorsField;
		static bool infiltratorsResolved;

		/// <summary>
		/// Structures whose infiltration decoration OpenRA shows the viewer: a fake a spy of the
		/// viewer's side has been inside (InfiltrateForDecoration, rendered for the infiltrator's
		/// allies). The same test as the trait's own ShouldRender; only visible actors are named.
		/// </summary>
		static uint[] Revealed(World world, Player viewer)
		{
			var ids = new List<uint>();
			foreach (var pair in world.ActorsWithTrait<OpenRA.Mods.Common.Traits.Render.WithDecoration>())
			{
				var decoration = pair.Trait;
				if (decoration.GetType().Name != "InfiltrateForDecoration" || !pair.Actor.IsInWorld || pair.Actor.IsDead)
					continue;
				if (!infiltratorsResolved)
				{
					infiltratorsField = decoration.GetType().GetField("infiltrators",
						System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
					infiltratorsResolved = true;
				}

				if (infiltratorsField?.GetValue(decoration) is not HashSet<Player> infiltrators || infiltrators.Count == 0)
					continue;
				var relationships = decoration.Info.ValidRelationships;
				if (infiltrators.Any(p => relationships.HasRelationship(p.RelationshipWith(viewer))) && pair.Actor.CanBeViewedByPlayer(viewer))
					ids.Add(pair.Actor.ActorID);
			}

			return ids.Distinct().ToArray();
		}

		/// <summary>
		/// The timers OpenRA's SupportPowerTimerWidget draws: every living, combatant player's
		/// powers that have an instance, are not disabled and whose DisplayTimerRelationships
		/// include the viewer's relationship to their owner (RA: the Atom Bomb and the GPS
		/// satellite, for everyone). Player is the snapshot's player index (ClientIndex order).
		/// </summary>
		static SupportPowerTimerDto[] PublicTimers(World world, Player viewer)
		{
			var players = world.Players.OrderBy(p => p.ClientIndex).ToArray();
			return world.ActorsWithTrait<SupportPowerManager>()
				.Where(p => !p.Actor.IsDead && !p.Actor.Owner.NonCombatant)
				.SelectMany(p => p.Trait.Powers.Values)
				.Where(p => p.Instances.Count > 0 && p.Info.DisplayTimerRelationships != PlayerRelationship.None && !p.Disabled)
				.Where(p => p.Info.DisplayTimerRelationships.HasRelationship(p.Instances[0].Self.Owner.RelationshipWith(viewer)))
				.Select(p =>
				{
					var owner = p.Instances[0].Self.Owner;
					var color = owner.Color;
					return new SupportPowerTimerDto(
						p.Key,
						PowerTitle(p.Key, p),
						Array.IndexOf(players, owner),
						owner.ResolvedPlayerName,
						$"#{color.R:x2}{color.G:x2}{color.B:x2}",
						owner.IsAlliedWith(viewer),
						p.Ready,
						p.Active,
						p.RemainingTicks,
						p.TotalTicks,
						Message(p.Info.LaunchTextNotification),
						Message(p.Info.IncomingTextNotification));
				})
				.OrderBy(t => t.Player)
				.ThenBy(t => t.Key, StringComparer.Ordinal)
				.ToArray();
		}

		// Nuclear launches, announced from the missile itself: a timer that restarts is no proof of
		// a launch, because a spy's InfiltrateForSupportPowerReset restarts it too.
		static readonly Dictionary<IEffect, int> SeenLaunches = new(ReferenceEqualityComparer.Instance);
		static readonly List<SupportLaunchDto> RecentLaunches = new();
		static World launchWorld;
		static int launchSequence;

		/// <summary>
		/// Every NukeLaunch the host has seen in the last 250 ticks (about ten seconds), the way
		/// OpenRA announces it (SupportPower.PlayLaunchSounds): allies of the launcher get the rules'
		/// launch line, everyone else the incoming one. Only an ally may learn the target, as only
		/// an ally sees OpenRA's beacon (Beacon: owner.IsAlliedWith(RenderPlayer)).
		/// </summary>
		// A presentation read of private engine state (.NET 8 UnsafeAccessor, as SnapshotEmitter's).
		[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "firedBy")]
		static extern ref Player FiredByField(NukeLaunch launch);

		static Player FiredBy(NukeLaunch launch) => FiredByField(launch);

		static SupportLaunchDto[] Launches(World world, Player viewer)
		{
			if (launchWorld != world)
			{
				SeenLaunches.Clear();
				RecentLaunches.Clear();
				launchWorld = world;
			}

			var players = world.Players.OrderBy(p => p.ClientIndex).ToArray();
			var live = new HashSet<IEffect>(ReferenceEqualityComparer.Instance);
			foreach (var effect in world.Effects)
			{
				if (effect is not NukeLaunch launch)
					continue;
				live.Add(effect);
				if (SeenLaunches.ContainsKey(effect))
					continue;
				SeenLaunches[effect] = ++launchSequence;
				// The missile is no armament's shot, so its flight names no source actor; its
				// owner is the player it was fired by.
				var owner = FiredBy(launch);
				if (owner == null)
					continue;
				var flight = (IProjectileFlight)launch;
				var power = owner.PlayerActor.TraitOrDefault<SupportPowerManager>()?.Powers
					.FirstOrDefault(p => p.Value.Info is NukePowerInfo);
				var info = power?.Value.Info;
				var allied = owner.IsAlliedWith(viewer);
				var target = flight.FlightTarget;
				RecentLaunches.Add(new SupportLaunchDto(
					launchSequence,
					power?.Key ?? "NukePowerInfoOrder",
					Array.IndexOf(players, owner),
					allied,
					world.WorldTick,
					allied ? Message(info?.LaunchTextNotification) : Message(info?.IncomingTextNotification),
					allied ? target.X : 0,
					allied ? target.Y : 0,
					allied && info != null ? BeaconTicks(info) : 0));
			}

			foreach (var gone in SeenLaunches.Keys.Where(e => !live.Contains(e)).ToArray())
				SeenLaunches.Remove(gone);
			RecentLaunches.RemoveAll(l => world.WorldTick - l.Tick > 250);
			return RecentLaunches.ToArray();
		}

		/// <summary>
		/// A nuke's beacon stands from launch until BeaconRemoveAdvance ticks before the missile
		/// lands (NukePower.Activate: FlightDelay - BeaconRemoveAdvance).
		/// </summary>
		static int BeaconTicks(SupportPowerInfo info) =>
			info is NukePowerInfo nuke && nuke.DisplayBeacon ? Math.Max(0, nuke.FlightDelay - nuke.BeaconRemoveAdvance) : 0;

		/// <summary>
		/// An airstrike's or a paradrop's beacon stands until the first delivering aircraft enters
		/// the target area (AirstrikePower/ParatroopersPower OnEnterRange, BeaconDistanceOffset).
		/// </summary>
		static string BeaconUnit(SupportPowerInfo info) => info switch
		{
			AirstrikePowerInfo a when a.DisplayBeacon => a.UnitType,
			ParatroopersPowerInfo p when p.DisplayBeacon => p.UnitType,
			_ => null,
		};

		static int BeaconRangeCells(SupportPowerInfo info) => info switch
		{
			AirstrikePowerInfo a when a.DisplayBeacon => a.BeaconDistanceOffset.Length / 1024,
			ParatroopersPowerInfo p when p.DisplayBeacon => p.BeaconDistanceOffset.Length / 1024,
			_ => 0,
		};

		/// <summary>
		/// How long a spawned support actor lives: the sonar pulse's detector (SpawnActorPower
		/// LifeTime) reveals submarines for these ticks, and the browser draws the pulse as long.
		/// </summary>
		static int EffectTicks(SupportPowerInfo info) => info is SpawnActorPowerInfo spawn ? Math.Max(0, spawn.LifeTime) : 0;

		static string Message(string key)
		{
			if (string.IsNullOrEmpty(key))
				return null;
			try
			{
				return FluentProvider.GetMessage(key);
			}
			catch
			{
				return null;
			}
		}

		static string PowerTitle(string key, SupportPowerInstance instance)
		{
			var title = instance.Info?.Name;
			return string.IsNullOrEmpty(title) ? key : FluentProvider.GetMessage(title);
		}
	}
}
