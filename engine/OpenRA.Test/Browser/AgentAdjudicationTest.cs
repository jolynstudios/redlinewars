#region Copyright & License Information
/*
 * Copyright (c) The OpenRA Developers and Contributors
 * This file is part of OpenRA, which is free software. It is made
 * available under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. For more information, see COPYING.
 */
#endregion

using NUnit.Framework;
using OpenRA.Browser;

namespace OpenRA.Test
{
	[TestFixture]
	sealed class AgentAdjudicationTest
	{
		static readonly AgentAdjudication.ComponentFloors UnitFloors = new(1, 1, 1, 1, 1, 1);

		[Test]
		public void UnresolvedScore_IsSymmetricWhenSidesAreSwapped()
		{
			var sideA = new AgentAdjudication.Components(80, 60, 75, 70, 4, 50);
			var sideB = new AgentAdjudication.Components(50, 90, 45, 30, 2, 30);

			var forward = AgentAdjudication.Evaluate(sideA, sideB, UnitFloors);
			var reversed = AgentAdjudication.Evaluate(sideB, sideA, UnitFloors);

			Assert.That(reversed.Score, Is.EqualTo(-forward.Score).Within(1e-12));
			Assert.That(forward.Verdict, Is.EqualTo(AgentAdjudication.Verdict.SideA));
			Assert.That(reversed.Verdict, Is.EqualTo(AgentAdjudication.Verdict.SideB));
		}

		[Test]
		public void CompositeScore_IsClippedToClosedUnitInterval()
		{
			var maximum = AgentAdjudication.Evaluate(
				new AgentAdjudication.Components(10, 10, 10, 10, 10, 10), default, UnitFloors);
			var minimum = AgentAdjudication.Evaluate(
				default, new AgentAdjudication.Components(10, 10, 10, 10, 10, 10), UnitFloors);

			Assert.That(maximum.Score, Is.EqualTo(1.0).Within(1e-12));
			Assert.That(minimum.Score, Is.EqualTo(-1.0).Within(1e-12));
			Assert.That(maximum.Score, Is.InRange(-1.0, 1.0));
			Assert.That(minimum.Score, Is.InRange(-1.0, 1.0));
		}

		[Test]
		public void ComponentFloors_GuardZeroTotalsWithoutBias()
		{
			var result = AgentAdjudication.Evaluate(default, default, UnitFloors);

			Assert.That(result.Score, Is.Zero);
			Assert.That(double.IsFinite(result.Score), Is.True);
			Assert.That(result.Verdict, Is.EqualTo(AgentAdjudication.Verdict.Draw));
		}

		[Test]
		public void DrawBand_IsStrictAtExactPositiveAndNegativeBoundary()
		{
			var positive = AgentAdjudication.Evaluate(
				new AgentAdjudication.Components(0, 0, 0, 0, 0, 1), default, UnitFloors);
			var negative = AgentAdjudication.Evaluate(
				default, new AgentAdjudication.Components(0, 0, 0, 0, 0, 1), UnitFloors);
			var inside = AgentAdjudication.Evaluate(
				new AgentAdjudication.Components(0, 0, 0, 0, 0, 199),
				new AgentAdjudication.Components(0, 0, 0, 0, 0, 1), UnitFloors);

			Assert.That(positive.Score, Is.EqualTo(0.10).Within(1e-12));
			Assert.That(positive.Verdict, Is.EqualTo(AgentAdjudication.Verdict.SideA));
			Assert.That(negative.Score, Is.EqualTo(-0.10).Within(1e-12));
			Assert.That(negative.Verdict, Is.EqualTo(AgentAdjudication.Verdict.SideB));
			Assert.That(inside.Score, Is.EqualTo(0.099).Within(1e-12));
			Assert.That(inside.Verdict, Is.EqualTo(AgentAdjudication.Verdict.Draw));
		}

		[Test]
		public void TerminalOutcome_OverridesContradictoryComposite()
		{
			var sideA = default(AgentAdjudication.Components);
			var sideB = new AgentAdjudication.Components(10, 10, 10, 10, 10, 10);

			var terminalA = AgentAdjudication.Evaluate(
				sideA, sideB, UnitFloors, AgentAdjudication.TerminalOutcome.SideAWin);
			var terminalB = AgentAdjudication.Evaluate(
				sideB, sideA, UnitFloors, AgentAdjudication.TerminalOutcome.SideBWin);

			Assert.That(terminalA, Is.EqualTo(new AgentAdjudication.Result(
				1.0, AgentAdjudication.Verdict.SideA, true)));
			Assert.That(terminalB, Is.EqualTo(new AgentAdjudication.Result(
				-1.0, AgentAdjudication.Verdict.SideB, true)));
		}

		[Test]
		public void GoldenComposite_UniformThreeToOneAdvantage_EqualsOneHalf()
		{
			var sideA = new AgentAdjudication.Components(3, 3, 3, 3, 3, 3);
			var sideB = new AgentAdjudication.Components(1, 1, 1, 1, 1, 1);

			var result = AgentAdjudication.Evaluate(sideA, sideB, UnitFloors);

			Assert.That(result.Score, Is.EqualTo(0.5).Within(1e-12));
			Assert.That(result.Verdict, Is.EqualTo(AgentAdjudication.Verdict.SideA));
		}

		[Test]
		public void GoldenComposite_MixedMarginsUseLockedWeights()
		{
			var sideA = new AgentAdjudication.Components(3, 1, 4, 0, 2, 3);
			var sideB = new AgentAdjudication.Components(1, 3, 0, 4, 2, 1);

			var result = AgentAdjudication.Evaluate(sideA, sideB, UnitFloors);

			Assert.That(result.Score, Is.EqualTo(0.125).Within(1e-12));
			Assert.That(result.Verdict, Is.EqualTo(AgentAdjudication.Verdict.SideA));
			Assert.That(result.TerminalOverride, Is.False);
		}
	}
}
