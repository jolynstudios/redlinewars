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

using System.Collections.Generic;
using System.Linq;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA.Browser
{
	/// <summary>
	/// Authoritative admission rule for host-owned ground combat rosters. Doctrine squad
	/// maintenance, missions, and reflexes all call this helper so economic and critical
	/// base-building actors cannot enter a host-controlled combat path through a looser gate.
	/// Direct model orders deliberately do not use this predicate.
	/// </summary>
	static class AgentCombatRoster
	{
		internal static bool IsEligible(Actor actor, Player owner, params string[] requiredOrders)
		{
			var mobile = actor?.Info.HasTraitInfo<MobileInfo>() == true ||
				actor?.Info.HasTraitInfo<AircraftInfo>() == true;
			if (actor == null || actor.Owner != owner || !actor.IsInWorld || actor.IsDead || actor.Disposed ||
				actor.OccupiesSpace == null || IsExplicitlyExcludedType(actor.Info) || !mobile ||
				actor.TraitsImplementing<AttackBase>().All(attack => attack.IsTraitDisabled))
				return false;

			return requiredOrders == null || requiredOrders.All(actor.AcceptsOrder);
		}

		internal static bool IsEligibleType(ActorInfo actorInfo)
		{
			var mobile = actorInfo?.HasTraitInfo<MobileInfo>() == true || actorInfo?.HasTraitInfo<AircraftInfo>() == true;
			return actorInfo != null && !IsExplicitlyExcludedType(actorInfo) && mobile &&
				actorInfo.TraitInfos<AttackBaseInfo>().Count != 0;
		}

		internal static bool IsExplicitlyExcludedType(ActorInfo actorInfo)
		{
			return actorInfo == null || actorInfo.HasTraitInfo<BuildingInfo>() ||
				actorInfo.HasTraitInfo<HarvesterInfo>() || actorInfo.HasTraitInfo<RefineryInfo>() ||
				actorInfo.HasTraitInfo<BaseBuildingInfo>();
		}

		internal static bool CanAttack(Actor attacker, Actor target)
		{
			if (attacker == null || target == null)
				return false;

			var actorTarget = Target.FromActor(target);
			return attacker.TraitsImplementing<AttackBase>()
				.Any(attack => !attack.IsTraitDisabled && attack.HasAnyValidWeapons(actorTarget));
		}

		/// <summary>
		/// Pure in-weapon-range engage decision: first-strike a target only when the attacker already has a
		/// valid weapon against it AND the target sits inside the attacker's current maximum weapon range —
		/// no movement, so the unit never chases and the reflex never opens war. Mirrors the engine's
		/// <c>AttackBase.IsReachableTarget(target, allowMove: false)</c> on already-resolved scalars so the
		/// decision boundary can be unit-tested without the browser-only host. Ranges/separation are the
		/// engine's 2D horizontal world-distance squares (see <see cref="CanEngageInRange"/>).
		/// </summary>
		internal static bool ShouldEngageInRange(bool hasValidWeapon, long horizontalSeparationSquared,
			long maxWeaponRangeSquared)
		{
			return hasValidWeapon && horizontalSeparationSquared <= maxWeaponRangeSquared;
		}

		/// <summary>
		/// True when <paramref name="attacker"/> can first-strike <paramref name="target"/> from where it
		/// currently stands: an enabled attack trait has a valid weapon for the target and the target is
		/// already within that trait's maximum range (no move). Resolves the engine facts and defers the
		/// verdict to <see cref="ShouldEngageInRange"/>, matching <c>Target.IsInRange</c>'s 2D test.
		/// </summary>
		internal static bool CanEngageInRange(Actor attacker, Actor target)
		{
			if (attacker == null || target == null)
				return false;

			var actorTarget = Target.FromActor(target);
			if (actorTarget.Type == TargetType.Invalid)
				return false;

			var origin = attacker.CenterPosition;
			var separationSquared = long.MaxValue;
			foreach (var position in actorTarget.Positions)
			{
				var candidate = (position - origin).HorizontalLengthSquared;
				if (candidate < separationSquared)
					separationSquared = candidate;
			}

			foreach (var attack in attacker.TraitsImplementing<AttackBase>())
			{
				if (attack.IsTraitDisabled)
					continue;
				if (ShouldEngageInRange(attack.HasAnyValidWeapons(actorTarget), separationSquared,
					attack.GetMaximumRangeVersusTarget(actorTarget).LengthSquared))
					return true;
			}

			return false;
		}

		internal static IReadOnlyList<uint> EligibleActorIds(IEnumerable<Actor> actors, Player owner,
			params string[] requiredOrders)
		{
			return actors.Where(actor => IsEligible(actor, owner, requiredOrders))
				.Select(actor => actor.ActorID).Distinct().Order().ToArray();
		}
	}
}
