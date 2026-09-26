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
using OpenRA.GameRules;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Traits.Sound;
using OpenRA.Mods.Common.Warheads;
using OpenRA.Traits;

namespace OpenRA.Mods.Steelseed
{
	public enum SteelseedEventKind : ushort
	{
		WeaponFire = 1,
		ProjectileImpact = 2,
		ActorDamaged = 4,
		ActorDestroyed = 5,
		ProductionComplete = 8,
		// Written by the emitter, never queued: how many records the sink refused this frame.
		EventsDropped = 13
	}

	public readonly record struct SteelseedPresentationEvent(
		SteelseedEventKind Kind,
		uint ActorId,
		ushort Armament,
		WPos Position,
		WVec Incidence,
		string Weapon,
		ushort Magnitude,
		byte Violence,
		Player Player,
		string ProducedType,
		ushort Barrel = ushort.MaxValue,
		uint Shot = 0,
		// 0 = no death voice (the rules give this actor none), 1 = normal,
		// 2 = burned (FireDeath), 3 = zapped (ElectricityDeath). Resolved in
		// Killed() by the same DeathSounds matching the real trait uses.
		byte VoiceKind = 0);
	[TraitLocation(SystemActors.World)]
	public sealed class SteelseedEventSinkInfo : TraitInfo<SteelseedEventSink> { }

	/// <summary>
	/// Presentation-only event queue. It deliberately implements no tick or sync interface, so
	/// observing combat cannot participate in simulation state or alter the OpenRA sync hash.
	/// </summary>
	// WeaponInfo.Impact notifies every world trait implementing INotifyWeaponImpact. The
	// interface lives in both engine trees: the legacy engine/OpenRA.Game, which the native
	// server and utility build this file against, lacked it, and 0b4ccdf dropped it here to
	// fix that build, which silenced every impact event from 19 Sep on.
	public sealed class SteelseedEventSink : INotifyWeaponImpact
	{
		const int Capacity = 4096;
		readonly List<SteelseedPresentationEvent> events = new(Capacity);

		public IReadOnlyList<SteelseedPresentationEvent> Events => events;

		/// <summary>Records refused since the last Clear because the queue was full.</summary>
		public int Dropped { get; private set; }

		public void Add(in SteelseedPresentationEvent presentationEvent)
		{
			if (events.Count < Capacity)
				events.Add(presentationEvent);
			else
				Dropped++;
		}

		readonly Dictionary<WeaponInfo, string> weaponNames = new();
		public void ObserveImpact(WeaponInfo weapon, WPos position, WVec direction, Actor source, ushort armament, ushort barrel, uint shot)
		{
			if (!weaponNames.TryGetValue(weapon, out var name))
			{
				name = source.World.Map.Rules.Weapons.FirstOrDefault(p => ReferenceEquals(p.Value, weapon)).Key;
				weaponNames[weapon] = name;
			}
			var damage = weapon.Warheads.OfType<DamageWarhead>().Sum(w => Math.Max(0, w.Damage));
			// A heal or a repair is a negative-damage weapon: it lands on a friend, and the presentation
			// shows the mend there, so it is sent with damage 0 instead of being dropped (a medic used
			// to heal with nothing on screen at all). Other zero-damage weapons, the death explosions
			// drawn by the destroyed-actor event, stay silent as before.
			if (damage == 0 && !weapon.Warheads.OfType<DamageWarhead>().Any(w => w.Damage < 0)) return;
			Add(new SteelseedPresentationEvent(SteelseedEventKind.ProjectileImpact, source.ActorID, armament,
				position, direction.Length == 0 ? new WVec(0, 0, -1024) : direction, name,
				(ushort)Math.Clamp(damage, 0, ushort.MaxValue), 0, source.Owner, null, barrel, shot));
		}

		public void Clear()
		{
			events.Clear();
			Dropped = 0;
		}
	}

	public sealed class SteelseedEventObserverInfo : TraitInfo<SteelseedEventObserver> { }

	/// <summary>
	/// Converts OpenRA's real trait notifications into an asset-independent presentation feed.
	/// The observer never issues orders and never feeds derived values back into the simulation.
	/// </summary>
	public sealed class SteelseedEventObserver : INotifyAttack, INotifyDamage, INotifyKilled, INotifyProduction
	{
		uint presentationShot;

		static SteelseedEventSink Sink(Actor self) => self.World.WorldActor.Trait<SteelseedEventSink>();

		void INotifyAttack.PreparingAttack(Actor self, in Target target, Armament armament, Barrel barrel) { }

		void INotifyAttack.Attacking(Actor self, in Target target, Armament armament, Barrel barrel)
		{
			var armamentIndex = 0;
			foreach (var candidate in self.TraitsImplementing<Armament>())
			{
				if (ReferenceEquals(candidate, armament))
					break;
				armamentIndex++;
			}

			var baseDamage = armament.Weapon.Warheads.OfType<DamageWarhead>()
				.Sum(warhead => Math.Max(0, warhead.Damage));
			// The Armament.Presentation* members the air/naval commit referenced were
			// never landed in the vendored engine; compute their equivalents here from
			// the same public muzzle API, keeping the mod self-contained.
			presentationShot++;
			var muzzlePosition = self.CenterPosition + armament.MuzzleOffset(self, barrel);
			Sink(self).Add(new SteelseedPresentationEvent(
				SteelseedEventKind.WeaponFire,
				self.ActorID,
				(ushort)Math.Clamp(armamentIndex, 0, ushort.MaxValue),
				muzzlePosition,
				new WVec(0, -1024, 0).Rotate(armament.MuzzleOrientation(self, barrel)),
				armament.Info.Weapon,
				(ushort)Math.Clamp(baseDamage, 0, ushort.MaxValue),
				0,
				self.Owner,
				null,
				(ushort)Array.IndexOf(armament.Barrels, barrel),
				presentationShot));
		}

		void INotifyDamage.Damaged(Actor self, AttackInfo attack)
		{
			if (attack.Damage?.Value <= 0)
				return;

			// Environmental/self-less damage has no truthful incidence direction for the current
			// ABI, so mark that presentation fact absent by omitting the directional event.
			// A player actor is in the world but occupies no space (a nuke's warheads are fired
			// by firedBy.PlayerActor): reading its position threw inside Health.InflictDamage and
			// halted the whole simulation at the first detonation.
			if (attack.Attacker == null || !attack.Attacker.IsInWorld || attack.Attacker.OccupiesSpace == null)
				return;
			var incidence = attack.Attacker.CenterPosition - self.CenterPosition;
			if (incidence.Length == 0)
				return;
			Sink(self).Add(new SteelseedPresentationEvent(
				SteelseedEventKind.ActorDamaged,
				self.ActorID,
				ushort.MaxValue,
				self.CenterPosition,
				incidence,
				null,
				(ushort)Math.Clamp(attack.Damage.Value, 0, ushort.MaxValue),
				0,
				self.Owner,
				null));
		}

		void INotifyKilled.Killed(Actor self, AttackInfo attack)
		{
			var health = self.TraitOrDefault<Health>();
			var damage = Math.Max(0, attack.Damage?.Value ?? 0);
			var violence = health == null
				? (byte)0
				: (byte)Math.Clamp(255L * damage / Math.Max(1, health.MaxHP), 0, byte.MaxValue);

			// The death VOICE reflex lives in the rules, not the presentation: resolve
			// it exactly the way the real DeathSounds trait does (first enabled instance
			// whose DeathTypes is empty or overlaps the attack's damage types) and hand
			// the presentation a category byte. The browser cannot sample OpenRA voices,
			// so it renders the category with its own bank — but WHICH actor speaks and
			// under which death type remains engine/rule data.
			byte voiceKind = 0;
			if (attack.Damage != null)
			{
				foreach (var sounds in self.TraitsImplementing<DeathSounds>())
				{
					if (sounds.IsTraitDisabled)
						continue;
					if (sounds.Info.DeathTypes.IsEmpty || attack.Damage.DamageTypes.Overlaps(sounds.Info.DeathTypes))
					{
						voiceKind = sounds.Info.Voice == "Burned" ? (byte)2
							: sounds.Info.Voice == "Zapped" ? (byte)3
							: (byte)1;
						break;
					}
				}
			}

			Sink(self).Add(new SteelseedPresentationEvent(
				SteelseedEventKind.ActorDestroyed,
				self.ActorID,
				ushort.MaxValue,
				self.CenterPosition,
				WVec.Zero,
				null,
				(ushort)Math.Clamp(damage, 0, ushort.MaxValue),
				violence,
				self.Owner,
				null,
				VoiceKind: voiceKind));
		}

		void INotifyProduction.UnitProduced(Actor self, Actor produced, CPos exit)
		{
			Sink(self).Add(new SteelseedPresentationEvent(
				SteelseedEventKind.ProductionComplete,
				produced.ActorID,
				ushort.MaxValue,
				produced.CenterPosition,
				WVec.Zero,
				null,
				0,
				0,
				produced.Owner,
				produced.Info.Name));
		}
	}
}
