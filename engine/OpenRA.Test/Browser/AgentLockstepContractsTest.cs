#region Copyright & License Information
/*
 * Copyright (c) The OpenRA Developers and Contributors
 * This file is part of OpenRA, which is free software. It is made
 * available under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. For more information, see COPYING.
 */
#endregion

using System.Linq;
using System.Text.Json;
using NUnit.Framework;
using OpenRA.Browser;

namespace OpenRA.Test
{
	[TestFixture]
	sealed class AgentLockstepContractsTest
	{
		static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

		[Test]
		public void DisabledLockstepFields_AreOmittedFromExistingResults()
		{
			using var start = JsonDocument.Parse(JsonSerializer.Serialize(new AgentMatchStartResult(), JsonOptions));
			using var state = JsonDocument.Parse(JsonSerializer.Serialize(new AgentMatchState(), JsonOptions));

			Assert.That(start.RootElement.TryGetProperty("benchmarkLockstep", out _), Is.False);
			Assert.That(state.RootElement.TryGetProperty("benchmarkLockstep", out _), Is.False);
			Assert.That(state.RootElement.TryGetProperty("lockstepBarrier", out _), Is.False);
			Assert.That(state.RootElement.TryGetProperty("adjudication", out _), Is.False);
		}

		[Test]
		public void LockstepConfig_DefaultsPinTheFrozenSpecAndGenerousDeadline()
		{
			var config = new AgentMatchConfig();

			Assert.That(config.BenchmarkLockstepEnabled, Is.False);
			Assert.That(config.BenchmarkSpecVersion, Is.EqualTo(AgentModeLimits.BenchmarkSpecVersion));
			Assert.That(config.BenchmarkDecisionTimeoutMs,
				Is.EqualTo(AgentModeLimits.DefaultBenchmarkDecisionTimeoutMs));
			Assert.That(config.BenchmarkTickHorizon, Is.Zero);
			Assert.That(config.BenchmarkDecisionHorizon, Is.Zero);
			Assert.That(config.BenchmarkControlRegions, Is.Empty);
		}

		[Test]
		public void BarrierSnapshot_ReportsCachedIdentityAndNoScoreSurface()
		{
			var snapshot = new AgentLockstepBarrierSnapshot
			{
				BarrierId = 7,
				Phase = "Collecting",
				FrozenWorldTick = 125,
				FrozenNetFrame = 44,
				Seats =
				[
					new AgentLockstepSeatSnapshot
					{
						Ordinal = 0,
						AgentId = "agent-1",
						DecisionId = 7,
						ObservationSequence = 9,
						SnapshotDigest = "digest"
					}
				]
			};
			using var json = JsonDocument.Parse(JsonSerializer.Serialize(snapshot, JsonOptions));

			Assert.That(json.RootElement.GetProperty("specVersion").GetString(),
				Is.EqualTo(AgentModeLimits.BenchmarkSpecVersion));
			Assert.That(json.RootElement.GetProperty("seats")[0].GetProperty("snapshotDigest").GetString(),
				Is.EqualTo("digest"));
			Assert.That(json.RootElement.TryGetProperty("score", out _), Is.False,
				"Phase 2 telemetry must not grow an adjudication surface");
		}

		[Test]
		public void AdjudicationTelemetry_EmitsExactlySixRawComponentValues()
		{
			var telemetry = new AgentAdjudicationTelemetry
			{
				SampleCount = 1,
				Seats =
				[
					new AgentAdjudicationSeatTelemetry
					{
						Ordinal = 0,
						AgentId = "agent-1",
						Components = new AgentAdjudicationComponentValues
						{
							LiveHpAdjustedPower = 1,
							StructuresByValue = 2,
							Economy = 3,
							UnitReplacementValue = 4,
							Tech = 5,
							RegionControl = 6
						}
					}
				]
			};
			using var json = JsonDocument.Parse(JsonSerializer.Serialize(telemetry, JsonOptions));
			var components = json.RootElement.GetProperty("seats")[0].GetProperty("components");

			Assert.That(components.EnumerateObject().Count(), Is.EqualTo(6));
			Assert.That(components.GetProperty("liveHpAdjustedPower").GetDouble(), Is.EqualTo(1));
			Assert.That(components.GetProperty("structuresByValue").GetDouble(), Is.EqualTo(2));
			Assert.That(components.GetProperty("economy").GetDouble(), Is.EqualTo(3));
			Assert.That(components.GetProperty("unitReplacementValue").GetDouble(), Is.EqualTo(4));
			Assert.That(components.GetProperty("tech").GetDouble(), Is.EqualTo(5));
			Assert.That(components.GetProperty("regionControl").GetDouble(), Is.EqualTo(6));
		}
	}
}
