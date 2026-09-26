#region Copyright & License Information
/*
 * Copyright (c) The OpenRA Developers and Contributors
 * This file is part of OpenRA, which is free software. It is made
 * available under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. For more information, see COPYING.
 */
#endregion

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NUnit.Framework;
using OpenRA.Browser;

namespace OpenRA.Test
{
	[TestFixture]
	sealed class AgentAdjudicationGoldenTest
	{
		sealed class GoldenFixture
		{
			public int SchemaVersion { get; set; }
			public string SpecVersion { get; set; }
			public List<GoldenScenario> Scenarios { get; set; } = [];
		}

		sealed class GoldenScenario
		{
			public string Id { get; set; }
			public int Seed { get; set; }
			public bool Oos { get; set; }
			public bool CalibrationEligible { get; set; }
			public string TerminalOutcome { get; set; }
			public int ControlRegionCount { get; set; }
			public List<GoldenEvent> Events { get; set; } = [];
		}

		sealed class GoldenEvent
		{
			public string Kind { get; set; }
			public uint ActorId { get; set; }
			public int VictimOrdinal { get; set; }
			public string DestroyedKind { get; set; }
			public long ReplacementValue { get; set; }
			public long BarrierId { get; set; }
			public int WorldTick { get; set; }
			public List<GoldenSeatSample> Seats { get; set; } = [];
		}

		sealed class GoldenSeatSample
		{
			public int Ordinal { get; set; }
			public long LiveHpAdjustedPower { get; set; }
			public long IncomePerMinute { get; set; }
			public long RefineryCapacity { get; set; }
			public long ProducerCapacity { get; set; }
			public long LiquidResources { get; set; }
			public long TechCapability { get; set; }
			public int OccupiedRegionCount { get; set; }
		}

		sealed class FrozenCalibration
		{
			public int SchemaVersion { get; set; }
			public string Status { get; set; }
			public string Scope { get; set; }
			public bool ProductionDefault { get; set; }
			public string SpecVersion { get; set; }
			public GoldenComponents Weights { get; set; }
			public double DrawBand { get; set; }
			public GoldenComponents Floors { get; set; }
			public string ControlRegionHash { get; set; }
			public List<GoldenRegion> Regions { get; set; } = [];
			public List<GoldenExpectedScenario> ExpectedScenarios { get; set; } = [];
		}

		sealed class GoldenRegion
		{
			public string Id { get; set; }
			public List<GoldenCell> Cells { get; set; } = [];
		}

		sealed class GoldenCell
		{
			public int X { get; set; }
			public int Y { get; set; }
		}

		sealed class GoldenExpectedScenario
		{
			public string Id { get; set; }
			public List<GoldenExpectedSeat> Seats { get; set; } = [];
			public double Score { get; set; }
			public string Verdict { get; set; }
			public bool TerminalOverride { get; set; }
		}

		sealed class GoldenExpectedSeat
		{
			public int Ordinal { get; set; }
			public GoldenComponents Components { get; set; }
			public long OwnStructureLossValue { get; set; }
			public long OwnCombatUnitLossValue { get; set; }
		}

		sealed class GoldenComponents
		{
			public double LiveHpAdjustedPower { get; set; }
			public double StructuresByValue { get; set; }
			public double Economy { get; set; }
			public double UnitReplacementValue { get; set; }
			public double Tech { get; set; }
			public double RegionControl { get; set; }
		}

		static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

		[Test]
		public void FrozenGoldenCalibration_ReplaysLedgerAndScoresEveryScenario()
		{
			var fixture = ReadFixture<GoldenFixture>("golden-adjudication-scenarios.json");
			var calibration = ReadFixture<FrozenCalibration>("golden-score-v1.frozen-test.json");
			Assert.Multiple(() =>
			{
				Assert.That(fixture.SchemaVersion, Is.EqualTo(1));
				Assert.That(fixture.SpecVersion, Is.EqualTo(AgentModeLimits.BenchmarkSpecVersion));
				Assert.That(calibration.SchemaVersion, Is.EqualTo(1));
				Assert.That(calibration.Status, Is.EqualTo("frozen-test-vector"));
				Assert.That(calibration.Scope, Is.EqualTo("golden-score-gate-only"));
				Assert.That(calibration.ProductionDefault, Is.False);
				Assert.That(calibration.SpecVersion, Is.EqualTo(AgentModeLimits.BenchmarkSpecVersion));
				Assert.That(fixture.Scenarios.Select(scenario => scenario.Seed), Is.Unique);
				Assert.That(fixture.Scenarios, Has.All.Property(nameof(GoldenScenario.Oos)).False);
				Assert.That(calibration.ExpectedScenarios.Select(scenario => scenario.Id), Is.Unique);
			});
			AssertLockedWeights(calibration);
			AssertFrozenRegions(calibration);

			var floors = ToFloors(calibration.Floors);
			foreach (var scenario in fixture.Scenarios)
			{
				var expected = calibration.ExpectedScenarios.Single(candidate => candidate.Id == scenario.Id);
				var state = new AgentAdjudicationLedger.State(
					scenario.ControlRegionCount, calibration.ControlRegionHash);
				foreach (var goldenEvent in scenario.Events)
					ReplayEvent(state, goldenEvent);

				var snapshot = state.BuildSnapshot();
				Assert.That(snapshot, Is.Not.Null, scenario.Id);
				Assert.That(snapshot.ControlRegionCount, Is.EqualTo(calibration.Regions.Count), scenario.Id);
				Assert.That(snapshot.ControlRegionHash, Is.EqualTo(calibration.ControlRegionHash), scenario.Id);
				foreach (var expectedSeat in expected.Seats)
				{
					var actual = snapshot.Seats.Single(seat => seat.Ordinal == expectedSeat.Ordinal);
					AssertComponents(actual.Components, expectedSeat.Components, scenario.Id, expectedSeat.Ordinal);
					Assert.That(actual.OwnStructureLossValue,
						Is.EqualTo(expectedSeat.OwnStructureLossValue), $"{scenario.Id} seat {expectedSeat.Ordinal}");
					Assert.That(actual.OwnCombatUnitLossValue,
						Is.EqualTo(expectedSeat.OwnCombatUnitLossValue), $"{scenario.Id} seat {expectedSeat.Ordinal}");
				}

				var result = AgentAdjudication.Evaluate(snapshot.Seats[0].Components, snapshot.Seats[1].Components,
					floors, Enum.Parse<AgentAdjudication.TerminalOutcome>(scenario.TerminalOutcome));
				Assert.Multiple(() =>
				{
					Assert.That(result.Score, Is.EqualTo(expected.Score).Within(1e-12), scenario.Id);
					Assert.That(result.Verdict.ToString(), Is.EqualTo(expected.Verdict), scenario.Id);
					Assert.That(result.TerminalOverride, Is.EqualTo(expected.TerminalOverride), scenario.Id);
				});
			}
		}

		static void ReplayEvent(AgentAdjudicationLedger.State state, GoldenEvent goldenEvent)
		{
			if (goldenEvent.Kind == "destroyed")
			{
				Assert.That(state.RecordDestroyed(goldenEvent.ActorId, goldenEvent.VictimOrdinal,
					Enum.Parse<AgentAdjudicationLedger.DestroyedKind>(goldenEvent.DestroyedKind),
					goldenEvent.ReplacementValue), Is.True);
				return;
			}

			Assert.That(goldenEvent.Kind, Is.EqualTo("frozen"));
			state.RecordFrozen(goldenEvent.BarrierId, goldenEvent.WorldTick, goldenEvent.Seats.Select(sample =>
				new AgentAdjudicationLedger.SeatSample(sample.Ordinal, sample.LiveHpAdjustedPower,
					sample.IncomePerMinute, sample.RefineryCapacity, sample.ProducerCapacity,
					sample.LiquidResources, sample.TechCapability, sample.OccupiedRegionCount)).ToArray());
		}

		static void AssertLockedWeights(FrozenCalibration calibration)
		{
			Assert.Multiple(() =>
			{
				Assert.That(calibration.Weights.LiveHpAdjustedPower, Is.EqualTo(0.25));
				Assert.That(calibration.Weights.StructuresByValue, Is.EqualTo(0.20));
				Assert.That(calibration.Weights.Economy, Is.EqualTo(0.20));
				Assert.That(calibration.Weights.UnitReplacementValue, Is.EqualTo(0.15));
				Assert.That(calibration.Weights.Tech, Is.EqualTo(0.10));
				Assert.That(calibration.Weights.RegionControl, Is.EqualTo(0.10));
				Assert.That(calibration.DrawBand, Is.EqualTo(AgentAdjudication.DrawBand));
				Assert.That(calibration.Weights.LiveHpAdjustedPower + calibration.Weights.StructuresByValue +
					calibration.Weights.Economy + calibration.Weights.UnitReplacementValue +
					calibration.Weights.Tech + calibration.Weights.RegionControl, Is.EqualTo(1.0).Within(1e-12));
			});
		}

		static void AssertFrozenRegions(FrozenCalibration calibration)
		{
			var cells = new HashSet<(int X, int Y)>();
			foreach (var region in calibration.Regions)
				foreach (var cell in region.Cells)
					Assert.That(cells.Add((cell.X, cell.Y)), Is.True, $"frozen regions overlap at {cell.X},{cell.Y}");
			var canonical = string.Join("|", calibration.Regions.OrderBy(region => region.Id, StringComparer.Ordinal)
				.Select(region => $"{region.Id}:{string.Join(';', region.Cells.OrderBy(cell => cell.X)
					.ThenBy(cell => cell.Y).Select(cell => $"{cell.X},{cell.Y}"))}"));
			var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
			Assert.That(hash, Is.EqualTo(calibration.ControlRegionHash));
		}

		static AgentAdjudication.ComponentFloors ToFloors(GoldenComponents floors)
		{
			return new AgentAdjudication.ComponentFloors(floors.LiveHpAdjustedPower, floors.StructuresByValue,
				floors.Economy, floors.UnitReplacementValue, floors.Tech, floors.RegionControl);
		}

		static void AssertComponents(AgentAdjudication.Components actual, GoldenComponents expected,
			string scenarioId, int ordinal)
		{
			Assert.Multiple(() =>
			{
				Assert.That(actual.LiveHpAdjustedPower,
					Is.EqualTo(expected.LiveHpAdjustedPower).Within(1e-12), $"{scenarioId} seat {ordinal}");
				Assert.That(actual.StructuresByValue,
					Is.EqualTo(expected.StructuresByValue).Within(1e-12), $"{scenarioId} seat {ordinal}");
				Assert.That(actual.Economy,
					Is.EqualTo(expected.Economy).Within(1e-12), $"{scenarioId} seat {ordinal}");
				Assert.That(actual.UnitReplacementValue,
					Is.EqualTo(expected.UnitReplacementValue).Within(1e-12), $"{scenarioId} seat {ordinal}");
				Assert.That(actual.Tech, Is.EqualTo(expected.Tech).Within(1e-12), $"{scenarioId} seat {ordinal}");
				Assert.That(actual.RegionControl,
					Is.EqualTo(expected.RegionControl).Within(1e-12), $"{scenarioId} seat {ordinal}");
			});
		}

		static T ReadFixture<T>(string fileName)
		{
			var path = Path.Combine(TestContext.CurrentContext.TestDirectory, "Browser", "benchmark-calibration", fileName);
			return JsonSerializer.Deserialize<T>(File.ReadAllText(path), JsonOptions);
		}
	}
}
