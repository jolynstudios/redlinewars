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

using NUnit.Framework;
using OpenRA.Browser;

namespace OpenRA.Test
{
	[TestFixture]
	sealed class AgentCombatRosterTest
	{
		// One RA cell is 1024 world units; a rifle infantryman's ~3-cell reach is roughly this squared range.
		const long ThreeCellsSquared = 3072L * 3072L;

		[Test]
		public void ShouldEngageInRange_EngagesInRangeTargetWithValidWeapon()
		{
			// Enemy one cell away, well inside a three-cell weapon reach: first-strike.
			Assert.That(AgentCombatRoster.ShouldEngageInRange(true, 1024L * 1024L, ThreeCellsSquared), Is.True);
		}

		[Test]
		public void ShouldEngageInRange_HoldsFireOnOutOfRangeTarget()
		{
			// Enemy five cells away, outside the three-cell reach: do not engage (and never chase).
			Assert.That(AgentCombatRoster.ShouldEngageInRange(true, 5120L * 5120L, ThreeCellsSquared), Is.False);
		}

		[Test]
		public void ShouldEngageInRange_EngagesExactlyAtMaximumRange()
		{
			// Separation exactly equal to the weapon range is still reachable without moving (<=, per IsInRange).
			Assert.That(AgentCombatRoster.ShouldEngageInRange(true, ThreeCellsSquared, ThreeCellsSquared), Is.True);

			// One unit beyond the range boundary is out of range.
			Assert.That(AgentCombatRoster.ShouldEngageInRange(true, ThreeCellsSquared + 1, ThreeCellsSquared), Is.False);
		}

		[Test]
		public void ShouldEngageInRange_NeverEngagesWithoutAValidWeapon()
		{
			// No valid weapon for this target: hold fire even when the enemy is point-blank.
			Assert.That(AgentCombatRoster.ShouldEngageInRange(false, 0L, ThreeCellsSquared), Is.False);
			Assert.That(AgentCombatRoster.ShouldEngageInRange(false, 1024L * 1024L, ThreeCellsSquared), Is.False);

			// A unit with no armament resolves to a zero range, so even a co-located enemy is not engaged.
			Assert.That(AgentCombatRoster.ShouldEngageInRange(false, 0L, 0L), Is.False);
		}
	}
}
