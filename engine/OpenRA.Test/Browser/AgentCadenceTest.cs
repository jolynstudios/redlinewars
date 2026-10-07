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
	sealed class AgentCadenceTest
	{
		[Test]
		public void EffectiveDecisionInterval_BenchmarkKeepsClampedConfiguredInterval()
		{
			// Pure-benchmark track (playCadenceEnabled false): identical to the pre-R1 clamp(25, 2500).
			Assert.That(AgentCadence.EffectiveDecisionInterval(500, false), Is.EqualTo(500));
			Assert.That(AgentCadence.EffectiveDecisionInterval(250, false), Is.EqualTo(250));
			Assert.That(AgentCadence.EffectiveDecisionInterval(100, false), Is.EqualTo(100));
			Assert.That(AgentCadence.EffectiveDecisionInterval(10, false), Is.EqualTo(25));
			Assert.That(AgentCadence.EffectiveDecisionInterval(9000, false), Is.EqualTo(2500));
		}

		[Test]
		public void EffectiveDecisionInterval_PlayCadenceFloorsTowardReactiveInterval()
		{
			// Play/RTS-Agent preset floors the effective interval toward ~100 ticks (~4s) but never raises it.
			Assert.That(AgentCadence.EffectiveDecisionInterval(500, true), Is.EqualTo(AgentCadence.PlayCadenceIntervalTicks));
			Assert.That(AgentCadence.EffectiveDecisionInterval(250, true), Is.EqualTo(AgentCadence.PlayCadenceIntervalTicks));
			Assert.That(AgentCadence.EffectiveDecisionInterval(100, true), Is.EqualTo(100));
			Assert.That(AgentCadence.EffectiveDecisionInterval(9000, true), Is.EqualTo(AgentCadence.PlayCadenceIntervalTicks));

			// A seat configured even faster than the play floor keeps its faster cadence.
			Assert.That(AgentCadence.EffectiveDecisionInterval(50, true), Is.EqualTo(50));
			Assert.That(AgentCadence.EffectiveDecisionInterval(10, true), Is.EqualTo(25));
		}

		[Test]
		public void IsTacticalOrderType_ClassifiesMicroOrdersStrictAndMacroLenient()
		{
			foreach (var tactical in new[] { "move", "attackMove", "attack", "guard", "capture", "spyPlane" })
				Assert.That(AgentCadence.IsTacticalOrderType(tactical), Is.True, tactical);

			foreach (var macro in new[]
			{
				"queueMission", "controlMission", "queueBuildPlan", "controlBuildPlan", "startProduction",
				"cancelProduction", "placeBuilding", "placeBuildingAuto", "adoptStrategy", "controlDoctrine",
				"acceptDoctrineDecision", "setPolicy", "assignGroup", "commitIntent", "reinforceIntent",
				"deploy", "stop", "setRallyPoint", "repair", "sell", "surrender", null
			})
				Assert.That(AgentCadence.IsTacticalOrderType(macro), Is.False, macro ?? "null");
		}

		[Test]
		public void ShouldRejectStaleTacticalOrder_StrictForTacticalOnlyUnderPlayCadence()
		{
			// Strict for tactical: rejected once the observation age passes the tactical budget.
			Assert.That(AgentCadence.ShouldRejectStaleTacticalOrder("move",
				AgentCadence.TacticalStaleMaxAgeTicks + 1, true), Is.True);
			Assert.That(AgentCadence.ShouldRejectStaleTacticalOrder("attack", 5000, true), Is.True);

			// Boundary: exactly at the budget is still accepted (not yet stale).
			Assert.That(AgentCadence.ShouldRejectStaleTacticalOrder("move",
				AgentCadence.TacticalStaleMaxAgeTicks, true), Is.False);
			Assert.That(AgentCadence.ShouldRejectStaleTacticalOrder("move", 0, true), Is.False);

			// Lenient for macro: never rejected for age, no matter how stale.
			Assert.That(AgentCadence.ShouldRejectStaleTacticalOrder("queueMission", 100000, true), Is.False);
			Assert.That(AgentCadence.ShouldRejectStaleTacticalOrder("startProduction", 100000, true), Is.False);

			// Pure-benchmark track never opts in: even a very stale tactical order is accepted (unchanged).
			Assert.That(AgentCadence.ShouldRejectStaleTacticalOrder("move", 100000, false), Is.False);
			Assert.That(AgentCadence.ShouldRejectStaleTacticalOrder("attack", 100000, false), Is.False);
		}
	}
}
