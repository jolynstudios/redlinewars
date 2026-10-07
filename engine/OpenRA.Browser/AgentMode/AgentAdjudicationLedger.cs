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

namespace OpenRA.Browser
{
	/// <summary>
	/// Engine-independent paired telemetry ledger for benchmark adjudication. Destruction is recorded once
	/// when it becomes irreversible; instantaneous facts are sampled atomically for both seats at each frozen
	/// barrier. Time-varying economy and region control use trapezoidal tick-weighted averages.
	/// </summary>
	static class AgentAdjudicationLedger
	{
		internal enum DestroyedKind
		{
			Structure,
			CombatUnit
		}

		internal readonly record struct SeatSample(
			int Ordinal,
			long LiveHpAdjustedPower,
			long IncomePerMinute,
			long RefineryCapacity,
			long ProducerCapacity,
			long LiquidResources,
			long TechCapability,
			int OccupiedRegionCount);

		internal sealed class SeatState
		{
			public int Ordinal { get; init; }
			public long StructureLossValue { get; set; }
			public long CombatUnitLossValue { get; set; }
			public SeatSample Current { get; set; }
			public decimal EconomyTwiceArea { get; set; }
			public decimal IncomeTwiceArea { get; set; }
			public decimal RefineryCapacityTwiceArea { get; set; }
			public decimal ProducerCapacityTwiceArea { get; set; }
			public decimal LiquidResourcesTwiceArea { get; set; }
			public decimal RegionControlTwiceArea { get; set; }
		}

		internal sealed class SeatSnapshot
		{
			public int Ordinal { get; init; }
			public AgentAdjudication.Components Components { get; init; }
			public long OwnStructureLossValue { get; init; }
			public long OwnCombatUnitLossValue { get; init; }
			public SeatSample Current { get; init; }
			public double AverageIncomePerMinute { get; init; }
			public double AverageRefineryCapacity { get; init; }
			public double AverageProducerCapacity { get; init; }
			public double AverageLiquidResources { get; init; }
		}

		internal sealed class FrozenSample
		{
			public long BarrierId { get; init; }
			public int WorldTick { get; init; }
			public IReadOnlyList<SeatSnapshot> Seats { get; init; }
		}

		internal sealed class Snapshot
		{
			public int SampleCount { get; init; }
			public int FirstFrozenWorldTick { get; init; }
			public int LastFrozenWorldTick { get; init; }
			public int DurationTicks { get; init; }
			public int ControlRegionCount { get; init; }
			public string ControlRegionHash { get; init; }
			public IReadOnlyList<SeatSnapshot> Seats { get; init; }
			public IReadOnlyList<FrozenSample> Samples { get; init; }
		}

		internal sealed class State
		{
			readonly HashSet<uint> destroyedActorIds = [];
			readonly List<FrozenSample> samples = [];

			public State(int controlRegionCount, string controlRegionHash)
			{
				ArgumentOutOfRangeException.ThrowIfNegative(controlRegionCount);
				if (controlRegionCount == 0 && !string.IsNullOrEmpty(controlRegionHash))
					throw new ArgumentException("an empty control-region set cannot have a hash", nameof(controlRegionHash));
				if (controlRegionCount > 0 && string.IsNullOrWhiteSpace(controlRegionHash))
					throw new ArgumentException("a non-empty control-region set requires a hash", nameof(controlRegionHash));

				ControlRegionCount = controlRegionCount;
				ControlRegionHash = controlRegionHash;
				Seats = [new SeatState { Ordinal = 0 }, new SeatState { Ordinal = 1 }];
			}

			public int SampleCount { get; private set; }
			public int FirstFrozenWorldTick { get; private set; } = -1;
			public int LastFrozenWorldTick { get; private set; } = -1;
			public long LastBarrierId { get; private set; } = -1;
			public int ControlRegionCount { get; }
			public string ControlRegionHash { get; }
			public SeatState[] Seats { get; }

			public bool RecordDestroyed(uint actorId, int victimOrdinal, DestroyedKind kind, long replacementValue)
			{
				ArgumentOutOfRangeException.ThrowIfZero(actorId);
				if (victimOrdinal is < 0 or > 1)
					throw new ArgumentOutOfRangeException(nameof(victimOrdinal));
				ArgumentOutOfRangeException.ThrowIfNegative(replacementValue);
				if (!Enum.IsDefined(kind))
					throw new ArgumentOutOfRangeException(nameof(kind));
				if (!destroyedActorIds.Add(actorId))
					return false;

				var victim = Seats[victimOrdinal];
				if (kind == DestroyedKind.Structure)
					victim.StructureLossValue = checked(victim.StructureLossValue + replacementValue);
				else
					victim.CombatUnitLossValue = checked(victim.CombatUnitLossValue + replacementValue);
				return true;
			}

			public void RecordFrozen(long barrierId, int worldTick, IReadOnlyList<SeatSample> seatSamples)
			{
				ArgumentOutOfRangeException.ThrowIfNegativeOrZero(barrierId);
				ArgumentOutOfRangeException.ThrowIfNegative(worldTick);
				if (barrierId <= LastBarrierId)
					throw new InvalidDataException("adjudication barrier ids must increase monotonically");
				if (worldTick <= LastFrozenWorldTick)
					throw new InvalidDataException("adjudication frozen ticks must increase monotonically");

				var ordered = seatSamples?.OrderBy(sample => sample.Ordinal).ToArray() ?? [];
				if (ordered.Length != 2 || ordered[0].Ordinal != 0 || ordered[1].Ordinal != 1)
					throw new InvalidDataException("adjudication sampling requires seat ordinals 0 and 1 exactly once");
				foreach (var sample in ordered)
					ValidateSample(sample, ControlRegionCount);

				if (SampleCount == 0)
					FirstFrozenWorldTick = worldTick;
				else
				{
					var tickDelta = worldTick - LastFrozenWorldTick;
					foreach (var sample in ordered)
						Accumulate(Seats[sample.Ordinal], sample, tickDelta);
				}

				foreach (var sample in ordered)
					Seats[sample.Ordinal].Current = sample;
				SampleCount++;
				LastBarrierId = barrierId;
				LastFrozenWorldTick = worldTick;
				samples.Add(new FrozenSample
				{
					BarrierId = barrierId,
					WorldTick = worldTick,
					Seats = Array.AsReadOnly(Seats.Select(BuildSeatSnapshot).ToArray())
				});
			}

			public Snapshot BuildSnapshot()
			{
				if (SampleCount == 0)
					return null;

				return new Snapshot
				{
					SampleCount = SampleCount,
					FirstFrozenWorldTick = FirstFrozenWorldTick,
					LastFrozenWorldTick = LastFrozenWorldTick,
					DurationTicks = LastFrozenWorldTick - FirstFrozenWorldTick,
					ControlRegionCount = ControlRegionCount,
					ControlRegionHash = ControlRegionHash,
					Seats = Array.AsReadOnly(Seats.Select(BuildSeatSnapshot).ToArray()),
					Samples = samples.AsReadOnly()
				};
			}

			SeatSnapshot BuildSeatSnapshot(SeatState seat)
			{
				var opponent = Seats[1 - seat.Ordinal];
				var duration = LastFrozenWorldTick - FirstFrozenWorldTick;
				return new SeatSnapshot
				{
					Ordinal = seat.Ordinal,
					Components = new AgentAdjudication.Components(
						seat.Current.LiveHpAdjustedPower,
						opponent.StructureLossValue,
						Average(seat.EconomyTwiceArea, ProductiveEconomy(seat.Current), duration),
						opponent.CombatUnitLossValue,
						seat.Current.TechCapability,
						Average(seat.RegionControlTwiceArea, seat.Current.OccupiedRegionCount, duration)),
					OwnStructureLossValue = seat.StructureLossValue,
					OwnCombatUnitLossValue = seat.CombatUnitLossValue,
					Current = seat.Current,
					AverageIncomePerMinute = Average(seat.IncomeTwiceArea, seat.Current.IncomePerMinute, duration),
					AverageRefineryCapacity = Average(
						seat.RefineryCapacityTwiceArea, seat.Current.RefineryCapacity, duration),
					AverageProducerCapacity = Average(
						seat.ProducerCapacityTwiceArea, seat.Current.ProducerCapacity, duration),
					AverageLiquidResources = Average(
						seat.LiquidResourcesTwiceArea, seat.Current.LiquidResources, duration)
				};
			}
		}

		internal static long ProductiveEconomy(SeatSample sample)
		{
			ValidateSample(sample, int.MaxValue);
			var productiveBase = checked(sample.IncomePerMinute + sample.RefineryCapacity + sample.ProducerCapacity);
			if (productiveBase == 0 || sample.LiquidResources == 0)
				return productiveBase;

			// Parameter-free harmonic discount: liquid resources contribute less than either the stockpile or
			// productive base and asymptotically cap at the productive base. This prevents cash hoarding from
			// dominating without baking a calibration constant into the ledger.
			var discountedCash = (long)Math.Floor(
				(decimal)productiveBase * sample.LiquidResources / (productiveBase + sample.LiquidResources));
			return checked(productiveBase + discountedCash);
		}

		static void Accumulate(SeatState seat, SeatSample current, int tickDelta)
		{
			seat.EconomyTwiceArea += (decimal)(ProductiveEconomy(seat.Current) + ProductiveEconomy(current)) * tickDelta;
			seat.IncomeTwiceArea += (decimal)(seat.Current.IncomePerMinute + current.IncomePerMinute) * tickDelta;
			seat.RefineryCapacityTwiceArea +=
				(decimal)(seat.Current.RefineryCapacity + current.RefineryCapacity) * tickDelta;
			seat.ProducerCapacityTwiceArea +=
				(decimal)(seat.Current.ProducerCapacity + current.ProducerCapacity) * tickDelta;
			seat.LiquidResourcesTwiceArea +=
				(decimal)(seat.Current.LiquidResources + current.LiquidResources) * tickDelta;
			seat.RegionControlTwiceArea +=
				(decimal)(seat.Current.OccupiedRegionCount + current.OccupiedRegionCount) * tickDelta;
		}

		static double Average(decimal twiceArea, long current, int durationTicks)
		{
			return durationTicks == 0 ? current : (double)(twiceArea / (2m * durationTicks));
		}

		static void ValidateSample(SeatSample sample, int controlRegionCount)
		{
			if (sample.Ordinal is < 0 or > 1)
				throw new ArgumentOutOfRangeException(nameof(sample), "sample ordinal must be 0 or 1");
			if (sample.LiveHpAdjustedPower < 0 || sample.IncomePerMinute < 0 || sample.RefineryCapacity < 0 ||
				sample.ProducerCapacity < 0 || sample.LiquidResources < 0 || sample.TechCapability < 0 ||
				sample.OccupiedRegionCount < 0 || sample.OccupiedRegionCount > controlRegionCount)
				throw new ArgumentOutOfRangeException(nameof(sample), "adjudication sample values are out of range");
		}
	}
}
