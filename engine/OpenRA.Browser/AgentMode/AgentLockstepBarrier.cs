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
	/// Engine-independent state and identity rules for the benchmark lockstep barrier.
	/// The browser host owns pause orders, observations, and action application; this class
	/// only accepts explicit facts and advances a deterministic state machine.
	/// </summary>
	static class AgentLockstepBarrier
	{
		internal const long PrematchBarrierId = 0;
		internal const long PrematchDecisionId = 0;
		internal const string PairedTrigger = "paired";
		internal const string PlanningTrigger = "planning";

		internal enum Phase
		{
			Idle,
			PausePending,
			Frozen,
			Collecting,
			CommitReady,
			ResumePending
		}

		internal enum SeatOutcome
		{
			Pending,
			Valid,
			NoOpTimeout,
			NoOpInvalid
		}

		internal enum StopKind
		{
			None,
			TickHorizon,
			DecisionHorizon,
			Terminal,
			Aborted,
			Censored
		}

		internal readonly record struct SeatTrigger(int Ordinal, string AgentId, string Trigger);

		internal readonly record struct SnapshotMetadata(
			long ObservationSequence,
			int WorldTick,
			int NetFrame,
			int SyncHash,
			string PayloadDigest);

		internal sealed class SeatState
		{
			public int Ordinal { get; init; }
			public string AgentId { get; init; }
			public long DecisionId { get; init; }
			public bool TriggerSource { get; init; }
			public string Trigger { get; init; }
			public SnapshotMetadata? Snapshot { get; set; }
			public SeatOutcome Outcome { get; set; }
			public string OutcomeDigest { get; set; }
			public string OutcomeReason { get; set; }
			public int DurationMs { get; set; }
		}

		internal sealed class BarrierState
		{
			public long BarrierId { get; init; }
			public bool Prematch { get; init; }
			public Phase Phase { get; set; }
			public int TriggerWorldTick { get; init; }
			public int TriggerNetFrame { get; init; }
			public int FrozenWorldTick { get; set; } = -1;
			public int FrozenNetFrame { get; set; } = -1;
			public int FrozenSyncHash { get; set; }
			public int AppliedWorldTick { get; set; } = -1;
			public int AppliedNetFrame { get; set; } = -1;
			public int ClosedWorldTick { get; set; } = -1;
			public int ClosedNetFrame { get; set; } = -1;
			public string CommitDigest { get; set; }
			public string TimeoutReason { get; set; }
			public string AbortReason { get; set; }
			public string TerminalReason { get; set; }
			public bool PauseOwned { get; set; }
			public long PauseOwnerBarrierId { get; set; } = -1;
			public bool ResumeRequired { get; set; }
			public IReadOnlyList<SeatState> Seats { get; init; }

			public SeatState Seat(string agentId)
			{
				return Seats.SingleOrDefault(seat => seat.AgentId == agentId);
			}
		}

		internal sealed class State
		{
			public State(int tickHorizon = 0, int decisionHorizon = 0)
			{
				ArgumentOutOfRangeException.ThrowIfNegative(tickHorizon);
				ArgumentOutOfRangeException.ThrowIfNegative(decisionHorizon);

				TickHorizon = tickHorizon;
				DecisionHorizon = decisionHorizon;
			}

			public Phase Phase => Active?.Phase ?? Phase.Idle;
			public BarrierState Active { get; set; }
			public BarrierState LastClosed { get; set; }
			public long NextBarrierId { get; set; } = 1;
			public long NextDecisionId { get; set; } = 1;
			public int OpenedLiveBarriers { get; set; }
			public int CompletedLiveBarriers { get; set; }
			public int DecisionOpportunitiesPerSeat { get; set; }
			public bool PrematchOpened { get; set; }
			public bool PrematchCompleted { get; set; }
			public int TickHorizon { get; }
			public int DecisionHorizon { get; }
			public StopKind StopKind { get; set; }
			public string StopReason { get; set; }
		}

		internal static BarrierState Open(State state, int worldTick, int netFrame,
			IReadOnlyList<SeatTrigger> seatTriggers, bool worldAlreadyPaused = false)
		{
			RequireIdleRun(state, worldTick);
			ValidateClock(worldTick, netFrame);
			if (worldAlreadyPaused)
				throw new InvalidDataException("benchmark lockstep cannot claim an already-paused world");

			var normalized = ValidateSeats(seatTriggers, requireUnionTrigger: true);
			var barrierId = state.NextBarrierId++;
			var decisionId = state.NextDecisionId++;
			var barrier = new BarrierState
			{
				BarrierId = barrierId,
				Phase = Phase.PausePending,
				TriggerWorldTick = worldTick,
				TriggerNetFrame = netFrame,
				Seats = Array.AsReadOnly(normalized.Select(trigger => new SeatState
				{
					Ordinal = trigger.Ordinal,
					AgentId = trigger.AgentId,
					DecisionId = decisionId,
					TriggerSource = !string.IsNullOrEmpty(trigger.Trigger),
					Trigger = string.IsNullOrEmpty(trigger.Trigger) ? PairedTrigger : trigger.Trigger,
					Outcome = SeatOutcome.Pending
				}).ToArray())
			};

			state.Active = barrier;
			state.OpenedLiveBarriers++;
			return barrier;
		}

		internal static BarrierState OpenPrematch(State state, IReadOnlyList<string> agentIds)
		{
			RequireState(state);
			if (state.Active != null)
				throw new InvalidDataException("a lockstep barrier is already active");
			if (state.StopKind != StopKind.None)
				throw new InvalidDataException($"lockstep run is already stopped: {state.StopKind}");
			if (state.PrematchOpened)
				throw new InvalidDataException("prematch barrier zero has already been claimed");

			var triggers = (agentIds ?? []).Select((agentId, ordinal) =>
				new SeatTrigger(ordinal, agentId, PlanningTrigger)).ToArray();
			var normalized = ValidateSeats(triggers, requireUnionTrigger: true);
			var barrier = new BarrierState
			{
				BarrierId = PrematchBarrierId,
				Prematch = true,
				Phase = Phase.Frozen,
				TriggerWorldTick = 0,
				TriggerNetFrame = 0,
				FrozenWorldTick = 0,
				FrozenNetFrame = 0,
				Seats = Array.AsReadOnly(normalized.Select(trigger => new SeatState
				{
					Ordinal = trigger.Ordinal,
					AgentId = trigger.AgentId,
					DecisionId = PrematchDecisionId,
					TriggerSource = true,
					Trigger = PlanningTrigger,
					Outcome = SeatOutcome.Pending
				}).ToArray())
			};

			state.PrematchOpened = true;
			state.Active = barrier;
			return barrier;
		}

		internal static void MarkPauseIssued(State state, long barrierId)
		{
			var barrier = RequireActive(state, barrierId, Phase.PausePending);
			if (barrier.Prematch)
				throw new InvalidDataException("prematch barrier zero never owns world pause");
			if (barrier.PauseOwned)
				throw new InvalidDataException($"barrier {barrierId} already owns world pause");

			barrier.PauseOwned = true;
			barrier.PauseOwnerBarrierId = barrierId;
		}

		internal static void MarkFrozen(State state, long barrierId, int worldTick, int netFrame,
			int syncHash, bool worldPaused)
		{
			var barrier = RequireActive(state, barrierId, Phase.PausePending);
			ValidateClock(worldTick, netFrame);
			if (!worldPaused)
				throw new InvalidDataException("lockstep snapshot requires authoritative world pause");
			if (!barrier.PauseOwned || barrier.PauseOwnerBarrierId != barrierId)
				throw new InvalidDataException($"barrier {barrierId} does not own world pause");
			if (worldTick < barrier.TriggerWorldTick || netFrame < barrier.TriggerNetFrame)
				throw new InvalidDataException("frozen clock precedes the barrier trigger");

			barrier.FrozenWorldTick = worldTick;
			barrier.FrozenNetFrame = netFrame;
			barrier.FrozenSyncHash = syncHash;
			barrier.Phase = Phase.Frozen;
		}

		internal static void AttachSnapshot(State state, long barrierId, string agentId, long decisionId,
			SnapshotMetadata snapshot)
		{
			var barrier = RequireActive(state, barrierId, Phase.Frozen);
			var seat = RequireSeat(barrier, agentId, decisionId);
			if (seat.Snapshot.HasValue)
				throw new InvalidDataException($"snapshot for {agentId} was already attached to barrier {barrierId}");
			if (snapshot.ObservationSequence <= 0)
				throw new InvalidDataException("snapshot observation sequence must be positive");
			if (snapshot.WorldTick != barrier.FrozenWorldTick || snapshot.NetFrame != barrier.FrozenNetFrame ||
				snapshot.SyncHash != barrier.FrozenSyncHash)
				throw new InvalidDataException("snapshot metadata does not match the frozen barrier clock");
			if (string.IsNullOrWhiteSpace(snapshot.PayloadDigest))
				throw new InvalidDataException("snapshot payload digest is required");

			seat.Snapshot = snapshot;
			if (barrier.Seats.All(candidate => candidate.Snapshot.HasValue))
			{
				barrier.Phase = Phase.Collecting;
				if (!barrier.Prematch)
					state.DecisionOpportunitiesPerSeat++;
			}
		}

		internal static void ResolveSeat(State state, long barrierId, string agentId, long decisionId,
			SeatOutcome outcome, string outcomeDigest, string reason = null, int durationMs = 0)
		{
			var barrier = RequireActive(state, barrierId, Phase.Collecting);
			var seat = RequireSeat(barrier, agentId, decisionId);
			if (seat.Outcome != SeatOutcome.Pending)
				throw new InvalidDataException($"seat {agentId} already resolved barrier {barrierId}");
			if (outcome is not (SeatOutcome.Valid or SeatOutcome.NoOpInvalid))
				throw new InvalidDataException("direct seat resolution must be valid or deterministic invalid no-op");
			if (outcome == SeatOutcome.Valid && string.IsNullOrWhiteSpace(outcomeDigest))
				throw new InvalidDataException("valid seat outcome digest is required");
			if (outcome == SeatOutcome.NoOpInvalid && string.IsNullOrWhiteSpace(reason))
				throw new InvalidDataException("invalid seat no-op reason is required");
			if (durationMs < 0)
				throw new InvalidDataException("seat duration cannot be negative");

			seat.Outcome = outcome;
			seat.OutcomeDigest = outcome == SeatOutcome.Valid ? outcomeDigest : "noop";
			seat.OutcomeReason = reason;
			seat.DurationMs = durationMs;
			AdvanceIfCollected(barrier);
		}

		internal static void ResolveDeadline(State state, long barrierId, string reason)
		{
			var barrier = RequireActive(state, barrierId, Phase.Collecting);
			if (string.IsNullOrWhiteSpace(reason))
				throw new InvalidDataException("deadline reason is required");

			var pending = barrier.Seats.Where(seat => seat.Outcome == SeatOutcome.Pending).ToArray();
			if (pending.Length == 0)
				throw new InvalidDataException($"barrier {barrierId} has no unresolved seats");

			barrier.TimeoutReason = reason;
			foreach (var seat in pending)
			{
				seat.Outcome = SeatOutcome.NoOpTimeout;
				seat.OutcomeDigest = "noop";
				seat.OutcomeReason = reason;
			}

			AdvanceIfCollected(barrier);
		}

		internal static void MarkApplied(State state, long barrierId, int worldTick, int netFrame,
			string commitDigest)
		{
			var barrier = RequireActive(state, barrierId, Phase.CommitReady);
			ValidateClock(worldTick, netFrame);
			if (worldTick != barrier.FrozenWorldTick)
				throw new InvalidDataException("combined lockstep commit must be issued at the frozen world tick");
			if (netFrame < barrier.FrozenNetFrame)
				throw new InvalidDataException("combined lockstep commit frame precedes the frozen frame");
			if (string.IsNullOrWhiteSpace(commitDigest))
				throw new InvalidDataException("combined lockstep commit digest is required");

			barrier.AppliedWorldTick = worldTick;
			barrier.AppliedNetFrame = netFrame;
			barrier.CommitDigest = commitDigest;
			barrier.ResumeRequired = barrier.PauseOwned;
			barrier.Phase = Phase.ResumePending;
		}

		internal static void Abort(State state, long barrierId, string reason)
		{
			TransitionToStop(state, barrierId, StopKind.Aborted, reason, resumeIfOwned: true);
		}

		internal static void Censor(State state, long barrierId, string reason)
		{
			TransitionToStop(state, barrierId, StopKind.Censored, reason, resumeIfOwned: true);
		}

		internal static void MarkTerminal(State state, long barrierId, string reason)
		{
			TransitionToStop(state, barrierId, StopKind.Terminal, reason, resumeIfOwned: false);
		}

		/// <summary>
		/// Seals a terminal result discovered while the combined order frame is being applied. The engine
		/// suppresses an UnPause ordered after a game-ending order, so the barrier must close the frozen
		/// world without requiring an extra actor tick.
		/// </summary>
		internal static void MarkTerminalAfterApplied(State state, long barrierId, string reason)
		{
			var barrier = RequireActive(state, barrierId, Phase.ResumePending);
			if (barrier.AppliedWorldTick < 0)
				throw new InvalidDataException("terminal-after-apply requires an applied combined commit");
			if (string.IsNullOrWhiteSpace(reason))
				throw new InvalidDataException("barrier terminal reason is required");

			state.StopKind = StopKind.Terminal;
			state.StopReason = reason;
			barrier.TerminalReason = reason;
			barrier.ResumeRequired = false;
		}

		internal static bool ShouldUnpause(State state, long barrierId)
		{
			var barrier = RequireActive(state, barrierId, Phase.ResumePending);
			return barrier.ResumeRequired && barrier.PauseOwned && barrier.PauseOwnerBarrierId == barrierId;
		}

		internal static void Close(State state, long barrierId, int worldTick, int netFrame, bool worldPaused)
		{
			var barrier = RequireActive(state, barrierId, Phase.ResumePending);
			ValidateClock(worldTick, netFrame);
			if (barrier.ResumeRequired && worldPaused)
				throw new InvalidDataException($"barrier {barrierId} cannot close before authoritative unpause");
			if (barrier.PauseOwned && barrier.PauseOwnerBarrierId != barrierId)
				throw new InvalidDataException($"barrier {barrierId} does not own the pause it is closing");

			barrier.PauseOwned = false;
			barrier.PauseOwnerBarrierId = -1;
			barrier.ResumeRequired = false;
			barrier.ClosedWorldTick = worldTick;
			barrier.ClosedNetFrame = netFrame;
			barrier.Phase = Phase.Idle;
			state.Active = null;
			state.LastClosed = barrier;

			if (barrier.Prematch)
				state.PrematchCompleted = barrier.AppliedWorldTick >= 0;
			else if (barrier.AppliedWorldTick >= 0)
			{
				state.CompletedLiveBarriers++;
				EvaluateHorizon(state, worldTick);
			}
		}

		internal static StopKind EvaluateHorizon(State state, int worldTick)
		{
			RequireState(state);
			ArgumentOutOfRangeException.ThrowIfNegative(worldTick);
			if (state.StopKind != StopKind.None)
				return state.StopKind;

			if (state.TickHorizon > 0 && worldTick >= state.TickHorizon)
			{
				state.StopKind = StopKind.TickHorizon;
				state.StopReason = $"tick horizon {state.TickHorizon} reached at tick {worldTick}";
			}
			else if (state.DecisionHorizon > 0 && state.CompletedLiveBarriers >= state.DecisionHorizon)
			{
				state.StopKind = StopKind.DecisionHorizon;
				state.StopReason = $"decision horizon {state.DecisionHorizon} reached";
			}

			return state.StopKind;
		}

		internal static string CanonicalOutcomeTrace(BarrierState barrier)
		{
			ArgumentNullException.ThrowIfNull(barrier);

			return string.Join("|", barrier.Seats.OrderBy(seat => seat.Ordinal).Select(seat =>
				$"{seat.Ordinal}:{seat.DecisionId}:{seat.Outcome}:{seat.OutcomeDigest ?? ""}"));
		}

		static void AdvanceIfCollected(BarrierState barrier)
		{
			if (barrier.Seats.All(seat => seat.Outcome != SeatOutcome.Pending))
				barrier.Phase = Phase.CommitReady;
		}

		static void TransitionToStop(State state, long barrierId, StopKind stopKind, string reason,
			bool resumeIfOwned)
		{
			var barrier = RequireActive(state, barrierId);
			if (barrier.Phase == Phase.ResumePending)
				throw new InvalidDataException($"barrier {barrierId} is already awaiting resume");
			if (string.IsNullOrWhiteSpace(reason))
				throw new InvalidDataException("barrier stop reason is required");

			state.StopKind = stopKind;
			state.StopReason = reason;
			if (stopKind is StopKind.Aborted or StopKind.Censored)
				barrier.AbortReason = reason;
			else
				barrier.TerminalReason = reason;
			barrier.ResumeRequired = resumeIfOwned && barrier.PauseOwned;
			barrier.Phase = Phase.ResumePending;
		}

		static BarrierState RequireActive(State state, long barrierId, params Phase[] phases)
		{
			RequireState(state);
			var barrier = state.Active;
			if (barrier == null)
				throw new InvalidDataException("no lockstep barrier is active");
			if (barrier.BarrierId != barrierId)
				throw new InvalidDataException($"stale or unknown barrierId {barrierId}; active barrier is {barrier.BarrierId}");
			if (phases.Length != 0 && !phases.Contains(barrier.Phase))
				throw new InvalidDataException(
					$"barrier {barrierId} is {barrier.Phase}, expected {string.Join(" or ", phases)}");

			return barrier;
		}

		static SeatState RequireSeat(BarrierState barrier, string agentId, long decisionId)
		{
			var seat = barrier.Seat(agentId);
			if (seat == null)
				throw new InvalidDataException($"agent {agentId ?? "<null>"} is not part of barrier {barrier.BarrierId}");
			if (seat.DecisionId != decisionId)
				throw new InvalidDataException(
					$"stale or unknown decisionId {decisionId} for {agentId}; expected {seat.DecisionId}");

			return seat;
		}

		static SeatTrigger[] ValidateSeats(IReadOnlyList<SeatTrigger> seatTriggers, bool requireUnionTrigger)
		{
			var seats = seatTriggers?.OrderBy(seat => seat.Ordinal).ToArray() ?? [];
			if (seats.Length != 2 || seats[0].Ordinal != 0 || seats[1].Ordinal != 1)
				throw new InvalidDataException("benchmark lockstep requires exactly seat ordinals 0 and 1");
			if (seats.Any(seat => string.IsNullOrWhiteSpace(seat.AgentId)))
				throw new InvalidDataException("benchmark lockstep agent ids are required");

			seats = seats.Select(seat => new SeatTrigger(seat.Ordinal, seat.AgentId.Trim(),
				string.IsNullOrWhiteSpace(seat.Trigger) ? null : seat.Trigger.Trim())).ToArray();
			if (seats.Select(seat => seat.AgentId).Distinct(StringComparer.Ordinal).Count() != 2)
				throw new InvalidDataException("benchmark lockstep agent ids must be unique");
			if (requireUnionTrigger && seats.All(seat => seat.Trigger == null))
				throw new InvalidDataException("a lockstep barrier requires at least one seat trigger");

			return seats;
		}

		static void RequireIdleRun(State state, int worldTick)
		{
			RequireState(state);
			if (state.Active != null)
				throw new InvalidDataException("a lockstep barrier is already active");
			if (EvaluateHorizon(state, worldTick) != StopKind.None)
				throw new InvalidDataException($"lockstep run is already stopped: {state.StopKind}");
		}

		static void RequireState(State state)
		{
			ArgumentNullException.ThrowIfNull(state);
		}

		static void ValidateClock(int worldTick, int netFrame)
		{
			ArgumentOutOfRangeException.ThrowIfNegative(worldTick);
			ArgumentOutOfRangeException.ThrowIfNegative(netFrame);
		}
	}
}
