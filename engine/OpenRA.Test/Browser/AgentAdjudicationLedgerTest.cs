#region Copyright & License Information
/*
 * Copyright (c) The OpenRA Developers and Contributors
 * This file is part of OpenRA, which is free software. It is made
 * available under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. For more information, see COPYING.
 */
#endregion

using System.IO;
using NUnit.Framework;
using OpenRA.Browser;

namespace OpenRA.Test
{
	[TestFixture]
	sealed class AgentAdjudicationLedgerTest
	{
		static AgentAdjudicationLedger.SeatSample Sample(int ordinal, long livePower = 100,
			long income = 100, long refinery = 200, long producer = 300, long liquid = 600,
			long tech = 400, int regions = 1)
		{
			return new AgentAdjudicationLedger.SeatSample(
				ordinal, livePower, income, refinery, producer, liquid, tech, regions);
		}

		[Test]
		public void FirstFrozenSample_EmitsSixRawComponentsForBothSeats()
		{
			var state = new AgentAdjudicationLedger.State(2, "regions");
			state.RecordFrozen(1, 100, [Sample(0), Sample(1, livePower: 80, tech: 250, regions: 2)]);

			var snapshot = state.BuildSnapshot();
			Assert.That(snapshot.SampleCount, Is.EqualTo(1));
			Assert.That(snapshot.FirstFrozenWorldTick, Is.EqualTo(100));
			Assert.That(snapshot.LastFrozenWorldTick, Is.EqualTo(100));
			Assert.That(snapshot.DurationTicks, Is.Zero);
			Assert.That(snapshot.Seats[0].Components, Is.EqualTo(
				new AgentAdjudication.Components(100, 0, 900, 0, 400, 1)));
			Assert.That(snapshot.Seats[1].Components, Is.EqualTo(
				new AgentAdjudication.Components(80, 0, 900, 0, 250, 2)));
		}

		[Test]
		public void FrozenSamples_UseTickWeightedTrapezoidalEconomyAndRegionAverages()
		{
			var state = new AgentAdjudicationLedger.State(4, "regions");
			state.RecordFrozen(1, 100,
				[Sample(0, income: 0, refinery: 0, producer: 100, liquid: 0, regions: 1), Sample(1)]);
			state.RecordFrozen(2, 300,
				[Sample(0, income: 100, refinery: 100, producer: 200, liquid: 0, regions: 3), Sample(1)]);

			var seat = state.BuildSnapshot().Seats[0];
			Assert.That(seat.Components.Economy, Is.EqualTo(250).Within(1e-12));
			Assert.That(seat.Components.RegionControl, Is.EqualTo(2).Within(1e-12));
			Assert.That(seat.AverageIncomePerMinute, Is.EqualTo(50).Within(1e-12));
			Assert.That(seat.AverageRefineryCapacity, Is.EqualTo(50).Within(1e-12));
			Assert.That(seat.AverageProducerCapacity, Is.EqualTo(150).Within(1e-12));
		}

		[Test]
		public void IrreversibleLosses_AreDeduplicatedAndCreditedToTheOpposingSeat()
		{
			var state = new AgentAdjudicationLedger.State(0, null);
			Assert.That(state.RecordDestroyed(10, 0, AgentAdjudicationLedger.DestroyedKind.Structure, 700), Is.True);
			Assert.That(state.RecordDestroyed(10, 0, AgentAdjudicationLedger.DestroyedKind.Structure, 700), Is.False);
			Assert.That(state.RecordDestroyed(11, 1, AgentAdjudicationLedger.DestroyedKind.CombatUnit, 450), Is.True);
			state.RecordFrozen(1, 100, [Sample(0, regions: 0), Sample(1, regions: 0)]);

			var snapshot = state.BuildSnapshot();
			Assert.That(snapshot.Seats[0].OwnStructureLossValue, Is.EqualTo(700));
			Assert.That(snapshot.Seats[0].Components.UnitReplacementValue, Is.EqualTo(450));
			Assert.That(snapshot.Seats[1].OwnCombatUnitLossValue, Is.EqualTo(450));
			Assert.That(snapshot.Seats[1].Components.StructuresByValue, Is.EqualTo(700));
		}

		[Test]
		public void ProductiveEconomy_HarmonicallyDiscountsAndCapsLiquidResourcesWithoutParameters()
		{
			var balanced = Sample(0);
			var hoarded = Sample(0, liquid: 6000);
			var noCapacity = Sample(0, income: 0, refinery: 0, producer: 0, liquid: 6000);

			Assert.That(AgentAdjudicationLedger.ProductiveEconomy(balanced), Is.EqualTo(900));
			Assert.That(AgentAdjudicationLedger.ProductiveEconomy(hoarded), Is.EqualTo(1145));
			Assert.That(AgentAdjudicationLedger.ProductiveEconomy(noCapacity), Is.Zero);
		}

		[Test]
		public void FrozenIdentity_RejectsDuplicateStaleAndMalformedPairs()
		{
			var state = new AgentAdjudicationLedger.State(1, "regions");
			state.RecordFrozen(1, 100, [Sample(0), Sample(1)]);

			Assert.Throws<InvalidDataException>(() => state.RecordFrozen(1, 200, [Sample(0), Sample(1)]));
			Assert.Throws<InvalidDataException>(() => state.RecordFrozen(2, 100, [Sample(0), Sample(1)]));
			Assert.Throws<InvalidDataException>(() => state.RecordFrozen(2, 200, [Sample(0), Sample(0)]));
		}

		[Test]
		public void EmptyLedger_HasNoOutcomeSnapshot()
		{
			var state = new AgentAdjudicationLedger.State(0, null);

			Assert.That(state.BuildSnapshot(), Is.Null);
		}
	}
}
