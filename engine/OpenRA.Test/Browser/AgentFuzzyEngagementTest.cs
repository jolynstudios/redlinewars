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
	// BQ F4: the engine-independent port of AttackOrFleeFuzzy. These lock the flee-vs-trade verdict for the
	// compiled disengage decision (own/enemy health 0..100, relative power/speed 0..999, 100 == parity).
	[TestFixture]
	sealed class AgentFuzzyEngagementTest
	{
		[Test]
		public void CanAttack_OverwhelmingAdvantage_Trades()
		{
			// Full health vs a near-dead enemy with a strong, fast force: stand and fight.
			var chance = AgentFuzzyEngagement.AttackChance(100, 10, 150, 150);
			TestContext.Out.WriteLine($"overwhelming attackChance={chance}");
			Assert.That(chance, Is.InRange(0.0, 50.0));
			Assert.That(AgentFuzzyEngagement.CanAttack(100, 10, 150, 150), Is.True);
			Assert.That(AgentFuzzyEngagement.ShouldDisengage(100, 10, 150, 150), Is.False);
		}

		[Test]
		public void CanAttack_HealthyParity_Trades()
		{
			// Full health at rough parity: the Normal-own catch-all rule attacks.
			var chance = AgentFuzzyEngagement.AttackChance(100, 90, 100, 100);
			TestContext.Out.WriteLine($"parity attackChance={chance}");
			Assert.That(AgentFuzzyEngagement.CanAttack(100, 90, 100, 100), Is.True);
		}

		[Test]
		public void ShouldDisengage_NearDeadOutgunned_Flees()
		{
			// Near-dead, weak and outrun against a healthy enemy: flee.
			var chance = AgentFuzzyEngagement.AttackChance(10, 90, 50, 150);
			TestContext.Out.WriteLine($"nearDead attackChance={chance}");
			Assert.That(AgentFuzzyEngagement.ShouldDisengage(10, 90, 50, 150), Is.True);
			Assert.That(AgentFuzzyEngagement.CanAttack(10, 90, 50, 150), Is.False);
		}

		[Test]
		public void ShouldDisengage_InjuredWeakFast_Flees()
		{
			// Injured, weak and fast against a healthy enemy matches the injured-own Flee rule.
			var chance = AgentFuzzyEngagement.AttackChance(50, 90, 50, 150);
			TestContext.Out.WriteLine($"injured attackChance={chance}");
			Assert.That(AgentFuzzyEngagement.ShouldDisengage(50, 90, 50, 150), Is.True);
		}

		[Test]
		public void AttackChance_ClampsOutOfRangeInputsWithoutThrowing()
		{
			// Inputs outside the fuzzy variable domains are clamped, never thrown: (1000,-50,5000,-10) clamps
			// to (100 own, 0 enemy, 999 power, 0 speed) — full health vs a dead enemy → trade.
			var chance = double.NaN;
			Assert.DoesNotThrow(() => chance = AgentFuzzyEngagement.AttackChance(1000, -50, 5000, -10));
			Assert.That(chance, Is.InRange(0.0, 50.0));
			Assert.That(AgentFuzzyEngagement.CanAttack(1000, -50, 5000, -10), Is.True);
		}
	}
}
