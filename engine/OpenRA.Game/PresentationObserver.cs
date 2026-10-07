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

namespace OpenRA
{
	/// <summary>
	/// Unsynced, presentation-only observations of simulation facts.
	///
	/// Every method is void and every argument is a value. Simulation code can therefore
	/// neither consume an observer result nor expose a mutable Actor to presentation. World
	/// owns the nullable observer and catches at each call boundary: a failing observer is
	/// disabled before its exception can change deterministic simulation control flow.
	/// </summary>
	public interface IPresentationObserver
	{
		void WeaponFired(in PresentationWeaponFire value);
		void ProjectileImpacted(in PresentationProjectileImpact value);
		void ActorDamaged(in PresentationActorDamage value);
		void ActorDestroyed(in PresentationActorDestroyed value);
		void ProductionCompleted(in PresentationProductionComplete value);
		void StructureBuilt(in PresentationStructureBuilt value);
	}

	public readonly record struct PresentationWeaponFire(
		uint ActorId,
		ushort Armament,
		WPos Muzzle,
		WAngle Facing,
		ushort WeaponClass,
		ushort Caliber,
		string Weapon);

	public readonly record struct PresentationProjectileImpact(
		WPos Source,
		WPos Position,
		byte WeaponClass,
		ushort Damage);

	public readonly record struct PresentationActorDamage(
		uint ActorId,
		byte HealthFraction,
		byte DamageType,
		uint SourceActorId);

	public readonly record struct PresentationActorDestroyed(
		uint ActorId,
		WPos Position,
		byte Kind,
		byte Violence);
	public readonly record struct PresentationProductionComplete(
		byte PlayerId,
		byte QueueId,
		uint ProducedActorId);

	/// <summary>Owner player id plus the type of the structure that finished building.</summary>
	public readonly record struct PresentationStructureBuilt(
		byte PlayerId,
		ushort TypeId,
		uint StructureActorId);
}
