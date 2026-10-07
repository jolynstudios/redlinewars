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
	sealed class AgentLockstepBarrierTest
	{
		const string Agent1 = "agent-1";
		const string Agent2 = "agent-2";

		static AgentLockstepBarrier.SeatTrigger[] Triggers(string trigger1 = "heartbeat", string trigger2 = null)
		{
			return
			[
				new AgentLockstepBarrier.SeatTrigger(0, Agent1, trigger1),
				new AgentLockstepBarrier.SeatTrigger(1, Agent2, trigger2)
			];
		}

		static AgentLockstepBarrier.BarrierState OpenFrozen(AgentLockstepBarrier.State state,
			string trigger1 = "heartbeat", string trigger2 = null, int worldTick = 100, int netFrame = 20)
		{
			var barrier = AgentLockstepBarrier.Open(state, worldTick, netFrame, Triggers(trigger1, trigger2));
			AgentLockstepBarrier.MarkPauseIssued(state, barrier.BarrierId);
			AgentLockstepBarrier.MarkFrozen(state, barrier.BarrierId, worldTick + 1, netFrame + 1,
				syncHash: 12345, worldPaused: true);
			AttachSnapshot(state, barrier, Agent1, 1, "snapshot-a");
			AttachSnapshot(state, barrier, Agent2, 2, "snapshot-b");
			return barrier;
		}

		static void AttachSnapshot(AgentLockstepBarrier.State state,
			AgentLockstepBarrier.BarrierState barrier, string agentId, long sequence, string digest)
		{
			var seat = barrier.Seat(agentId);
			AgentLockstepBarrier.AttachSnapshot(state, barrier.BarrierId, agentId, seat.DecisionId,
				new AgentLockstepBarrier.SnapshotMetadata(sequence, barrier.FrozenWorldTick,
					barrier.FrozenNetFrame, barrier.FrozenSyncHash, digest));
		}

		static void ResolveValid(AgentLockstepBarrier.State state,
			AgentLockstepBarrier.BarrierState barrier, string agentId, string digest)
		{
			var seat = barrier.Seat(agentId);
			AgentLockstepBarrier.ResolveSeat(state, barrier.BarrierId, agentId, seat.DecisionId,
				AgentLockstepBarrier.SeatOutcome.Valid, digest);
		}

		static void ApplyAndClose(AgentLockstepBarrier.State state,
			AgentLockstepBarrier.BarrierState barrier, int closeWorldTick = 102, int closeNetFrame = 23)
		{
			AgentLockstepBarrier.MarkApplied(state, barrier.BarrierId, barrier.FrozenWorldTick,
				barrier.FrozenNetFrame + 1, "commit");
			Assert.That(AgentLockstepBarrier.ShouldUnpause(state, barrier.BarrierId), Is.True);
			AgentLockstepBarrier.Close(state, barrier.BarrierId, closeWorldTick, closeNetFrame, worldPaused: false);
		}

		[Test]
		public void UnionTrigger_PairsBothSeatsAndClaimsExactlyOnce()
		{
			var state = new AgentLockstepBarrier.State();
			var barrier = AgentLockstepBarrier.Open(state, worldTick: 100, netFrame: 20,
				Triggers(trigger1: null, trigger2: "structureUnderAttack"));

			Assert.That(state.Phase, Is.EqualTo(AgentLockstepBarrier.Phase.PausePending));
			Assert.That(barrier.BarrierId, Is.EqualTo(1));
			Assert.That(barrier.Seat(Agent1).DecisionId, Is.EqualTo(1));
			Assert.That(barrier.Seat(Agent2).DecisionId, Is.EqualTo(1));
			Assert.That(barrier.Seat(Agent1).TriggerSource, Is.False);
			Assert.That(barrier.Seat(Agent1).Trigger, Is.EqualTo(AgentLockstepBarrier.PairedTrigger));
			Assert.That(barrier.Seat(Agent2).TriggerSource, Is.True);
			Assert.That(barrier.Seat(Agent2).Trigger, Is.EqualTo("structureUnderAttack"));
			Assert.That(state.OpenedLiveBarriers, Is.EqualTo(1));

			Assert.Throws<InvalidDataException>(() => AgentLockstepBarrier.Open(state, 100, 20, Triggers()),
				"polling again while pause is pending must not claim a second barrier");
			Assert.That(state.OpenedLiveBarriers, Is.EqualTo(1));
		}

		[Test]
		public void CompletedBarriers_UseMonotonicPairedIdentities()
		{
			var state = new AgentLockstepBarrier.State();
			var first = OpenFrozen(state);
			ResolveValid(state, first, Agent1, "response-a1");
			ResolveValid(state, first, Agent2, "response-a2");
			ApplyAndClose(state, first);

			var second = AgentLockstepBarrier.Open(state, worldTick: 200, netFrame: 40, Triggers());

			Assert.That(first.BarrierId, Is.EqualTo(1));
			Assert.That(first.Seats, Has.All.Property("DecisionId").EqualTo(1));
			Assert.That(second.BarrierId, Is.EqualTo(2));
			Assert.That(second.Seats, Has.All.Property("DecisionId").EqualTo(2));
			Assert.That(state.CompletedLiveBarriers, Is.EqualTo(1));
			Assert.That(state.DecisionOpportunitiesPerSeat, Is.EqualTo(1));
		}

		[Test]
		public void IdentityChecks_RejectDuplicateStaleAndUnknownResponses()
		{
			var state = new AgentLockstepBarrier.State();
			var barrier = OpenFrozen(state);
			ResolveValid(state, barrier, Agent1, "response-a");

			Assert.Throws<InvalidDataException>(() => ResolveValid(state, barrier, Agent1, "duplicate"));
			Assert.Throws<InvalidDataException>(() => AgentLockstepBarrier.ResolveSeat(state,
				barrier.BarrierId - 1, Agent2, barrier.Seat(Agent2).DecisionId,
				AgentLockstepBarrier.SeatOutcome.Valid, "stale"));
			Assert.Throws<InvalidDataException>(() => AgentLockstepBarrier.ResolveSeat(state,
				barrier.BarrierId, Agent2, barrier.Seat(Agent2).DecisionId + 1,
				AgentLockstepBarrier.SeatOutcome.Valid, "wrong-decision"));
			Assert.Throws<InvalidDataException>(() => AgentLockstepBarrier.ResolveSeat(state,
				barrier.BarrierId, "agent-3", barrier.Seat(Agent2).DecisionId,
				AgentLockstepBarrier.SeatOutcome.Valid, "wrong-agent"));

			Assert.That(state.Phase, Is.EqualTo(AgentLockstepBarrier.Phase.Collecting));
			Assert.That(barrier.Seat(Agent2).Outcome, Is.EqualTo(AgentLockstepBarrier.SeatOutcome.Pending));
		}

		[Test]
		public void ResponseArrivalOrder_DoesNotChangeCanonicalOutcome()
		{
			var firstState = new AgentLockstepBarrier.State();
			var first = OpenFrozen(firstState);
			ResolveValid(firstState, first, Agent1, "response-a");
			ResolveValid(firstState, first, Agent2, "response-b");

			var secondState = new AgentLockstepBarrier.State();
			var second = OpenFrozen(secondState);
			ResolveValid(secondState, second, Agent2, "response-b");
			ResolveValid(secondState, second, Agent1, "response-a");

			Assert.That(firstState.Phase, Is.EqualTo(AgentLockstepBarrier.Phase.CommitReady));
			Assert.That(secondState.Phase, Is.EqualTo(AgentLockstepBarrier.Phase.CommitReady));
			Assert.That(AgentLockstepBarrier.CanonicalOutcomeTrace(first),
				Is.EqualTo(AgentLockstepBarrier.CanonicalOutcomeTrace(second)));
		}

		[Test]
		public void CanonicalOutcomeTrace_UsesStableSeatOrdinalsNotGeneratedAgentIds()
		{
			static AgentLockstepBarrier.BarrierState Resolved(string firstId, string secondId)
			{
				var state = new AgentLockstepBarrier.State();
				var barrier = AgentLockstepBarrier.Open(state, 100, 20,
				[
					new AgentLockstepBarrier.SeatTrigger(0, firstId, "heartbeat"),
					new AgentLockstepBarrier.SeatTrigger(1, secondId, null)
				]);
				AgentLockstepBarrier.MarkPauseIssued(state, barrier.BarrierId);
				AgentLockstepBarrier.MarkFrozen(state, barrier.BarrierId, 101, 21, 12345, worldPaused: true);
				foreach (var seat in barrier.Seats)
				{
					AgentLockstepBarrier.AttachSnapshot(state, barrier.BarrierId, seat.AgentId, seat.DecisionId,
						new AgentLockstepBarrier.SnapshotMetadata(seat.Ordinal + 1, 101, 21, 12345,
							$"snapshot-{seat.Ordinal}"));
				}

				foreach (var seat in barrier.Seats)
				{
					AgentLockstepBarrier.ResolveSeat(state, barrier.BarrierId, seat.AgentId, seat.DecisionId,
						AgentLockstepBarrier.SeatOutcome.Valid, $"response-{seat.Ordinal}");
				}

				return barrier;
			}

			var first = Resolved("agent-1-generated-a", "agent-2-generated-a");
			var second = Resolved("agent-1-generated-b", "agent-2-generated-b");

			Assert.That(AgentLockstepBarrier.CanonicalOutcomeTrace(first),
				Is.EqualTo(AgentLockstepBarrier.CanonicalOutcomeTrace(second)));
		}

		[Test]
		public void Deadline_ConvertsOnlyMissingSeatsToDeterministicNoOp()
		{
			var state = new AgentLockstepBarrier.State();
			var barrier = OpenFrozen(state);
			ResolveValid(state, barrier, Agent2, "response-b");

			AgentLockstepBarrier.ResolveDeadline(state, barrier.BarrierId, "published deadline elapsed");

			Assert.That(state.Phase, Is.EqualTo(AgentLockstepBarrier.Phase.CommitReady));
			Assert.That(barrier.TimeoutReason, Is.EqualTo("published deadline elapsed"));
			Assert.That(barrier.Seat(Agent1).Outcome, Is.EqualTo(AgentLockstepBarrier.SeatOutcome.NoOpTimeout));
			Assert.That(barrier.Seat(Agent1).OutcomeDigest, Is.EqualTo("noop"));
			Assert.That(barrier.Seat(Agent2).Outcome, Is.EqualTo(AgentLockstepBarrier.SeatOutcome.Valid));
			Assert.Throws<InvalidDataException>(() =>
				AgentLockstepBarrier.ResolveDeadline(state, barrier.BarrierId, "duplicate deadline"));
		}

		[Test]
		public void InvalidResponse_IsDeterministicNoOpAndStillCompletesThePair()
		{
			var state = new AgentLockstepBarrier.State();
			var barrier = OpenFrozen(state);
			var first = barrier.Seat(Agent1);
			AgentLockstepBarrier.ResolveSeat(state, barrier.BarrierId, Agent1, first.DecisionId,
				AgentLockstepBarrier.SeatOutcome.NoOpInvalid, outcomeDigest: null,
				reason: "schema validation failed");
			ResolveValid(state, barrier, Agent2, "response-b");

			Assert.That(state.Phase, Is.EqualTo(AgentLockstepBarrier.Phase.CommitReady));
			Assert.That(first.Outcome, Is.EqualTo(AgentLockstepBarrier.SeatOutcome.NoOpInvalid));
			Assert.That(first.OutcomeDigest, Is.EqualTo("noop"));
			Assert.That(first.OutcomeReason, Is.EqualTo("schema validation failed"));
		}

		[Test]
		public void Abort_RecordsReasonAndRequiresOwnedPauseToResume()
		{
			var state = new AgentLockstepBarrier.State();
			var barrier = AgentLockstepBarrier.Open(state, 100, 20, Triggers());
			AgentLockstepBarrier.MarkPauseIssued(state, barrier.BarrierId);

			AgentLockstepBarrier.Abort(state, barrier.BarrierId, "worker stopped");

			Assert.That(state.Phase, Is.EqualTo(AgentLockstepBarrier.Phase.ResumePending));
			Assert.That(state.StopKind, Is.EqualTo(AgentLockstepBarrier.StopKind.Aborted));
			Assert.That(barrier.AbortReason, Is.EqualTo("worker stopped"));
			Assert.That(AgentLockstepBarrier.ShouldUnpause(state, barrier.BarrierId), Is.True);
			Assert.Throws<InvalidDataException>(() =>
				AgentLockstepBarrier.Close(state, barrier.BarrierId, 100, 21, worldPaused: true));

			AgentLockstepBarrier.Close(state, barrier.BarrierId, 100, 22, worldPaused: false);
			Assert.That(state.Phase, Is.EqualTo(AgentLockstepBarrier.Phase.Idle));
			Assert.That(state.LastClosed.AbortReason, Is.EqualTo("worker stopped"));
		}

		[Test]
		public void TerminalWhileFrozen_ClosesWithoutAnUnpauseTick()
		{
			var state = new AgentLockstepBarrier.State();
			var barrier = OpenFrozen(state);

			AgentLockstepBarrier.MarkTerminal(state, barrier.BarrierId, "agent-2 defeated");

			Assert.That(state.Phase, Is.EqualTo(AgentLockstepBarrier.Phase.ResumePending));
			Assert.That(state.StopKind, Is.EqualTo(AgentLockstepBarrier.StopKind.Terminal));
			Assert.That(barrier.TerminalReason, Is.EqualTo("agent-2 defeated"));
			Assert.That(AgentLockstepBarrier.ShouldUnpause(state, barrier.BarrierId), Is.False,
				"terminal capture must not resume into another actor tick");

			AgentLockstepBarrier.Close(state, barrier.BarrierId, barrier.FrozenWorldTick,
				barrier.FrozenNetFrame, worldPaused: true);
			Assert.That(state.Phase, Is.EqualTo(AgentLockstepBarrier.Phase.Idle));
			Assert.That(state.LastClosed.TerminalReason, Is.EqualTo("agent-2 defeated"));
		}

		[Test]
		public void TerminalAfterApplied_CancelsResumeAndClosesTheFrozenWorld()
		{
			var state = new AgentLockstepBarrier.State();
			var barrier = OpenFrozen(state);
			ResolveValid(state, barrier, Agent1, "response-a");
			ResolveValid(state, barrier, Agent2, "response-b");
			AgentLockstepBarrier.MarkApplied(state, barrier.BarrierId, barrier.FrozenWorldTick,
				barrier.FrozenNetFrame + 1, "surrender-commit");

			AgentLockstepBarrier.MarkTerminalAfterApplied(state, barrier.BarrierId, "win state resolved");

			Assert.That(state.StopKind, Is.EqualTo(AgentLockstepBarrier.StopKind.Terminal));
			Assert.That(barrier.ResumeRequired, Is.False);
			Assert.That(AgentLockstepBarrier.ShouldUnpause(state, barrier.BarrierId), Is.False);
			Assert.DoesNotThrow(() => AgentLockstepBarrier.Close(state, barrier.BarrierId,
				barrier.FrozenWorldTick, barrier.FrozenNetFrame + 2, worldPaused: true));
			Assert.That(state.Active, Is.Null);
		}

		[Test]
		public void PauseOwnership_IsBoundToTheActiveBarrierIdentity()
		{
			Assert.Throws<InvalidDataException>(() => AgentLockstepBarrier.Open(
				new AgentLockstepBarrier.State(), 100, 20, Triggers(), worldAlreadyPaused: true));

			var state = new AgentLockstepBarrier.State();
			var barrier = AgentLockstepBarrier.Open(state, 100, 20, Triggers());

			Assert.Throws<InvalidDataException>(() => AgentLockstepBarrier.MarkPauseIssued(state,
				barrier.BarrierId + 1));
			AgentLockstepBarrier.MarkPauseIssued(state, barrier.BarrierId);
			Assert.That(barrier.PauseOwned, Is.True);
			Assert.That(barrier.PauseOwnerBarrierId, Is.EqualTo(barrier.BarrierId));
			Assert.Throws<InvalidDataException>(() => AgentLockstepBarrier.MarkPauseIssued(state, barrier.BarrierId));
			Assert.Throws<InvalidDataException>(() => AgentLockstepBarrier.MarkFrozen(state,
				barrier.BarrierId, 101, 21, 12345, worldPaused: false));
			Assert.Throws<InvalidDataException>(() => AgentLockstepBarrier.MarkFrozen(state,
				barrier.BarrierId + 1, 101, 21, 12345, worldPaused: true));
		}

		[Test]
		public void Snapshots_MustAttachOnceAtTheFrozenClock()
		{
			var state = new AgentLockstepBarrier.State();
			var barrier = AgentLockstepBarrier.Open(state, 100, 20, Triggers());
			AgentLockstepBarrier.MarkPauseIssued(state, barrier.BarrierId);
			AgentLockstepBarrier.MarkFrozen(state, barrier.BarrierId, 101, 21, 12345, worldPaused: true);

			var first = barrier.Seat(Agent1);
			Assert.Throws<InvalidDataException>(() => AgentLockstepBarrier.AttachSnapshot(state,
				barrier.BarrierId, Agent1, first.DecisionId,
				new AgentLockstepBarrier.SnapshotMetadata(1, 102, 21, 12345, "wrong-tick")));
			AttachSnapshot(state, barrier, Agent1, 1, "snapshot-a");
			Assert.Throws<InvalidDataException>(() => AttachSnapshot(state, barrier, Agent1, 2, "duplicate"));

			AttachSnapshot(state, barrier, Agent2, 1, "snapshot-b");
			Assert.That(state.Phase, Is.EqualTo(AgentLockstepBarrier.Phase.Collecting));
			Assert.That(state.DecisionOpportunitiesPerSeat, Is.EqualTo(1));
		}

		[Test]
		public void FixedHorizon_StopsAtInclusiveTickOrCompletedDecisionBoundary()
		{
			var tickState = new AgentLockstepBarrier.State(tickHorizon: 500);
			Assert.That(AgentLockstepBarrier.EvaluateHorizon(tickState, 499),
				Is.EqualTo(AgentLockstepBarrier.StopKind.None));
			Assert.That(AgentLockstepBarrier.EvaluateHorizon(tickState, 500),
				Is.EqualTo(AgentLockstepBarrier.StopKind.TickHorizon));
			Assert.Throws<InvalidDataException>(() => AgentLockstepBarrier.Open(tickState, 500, 10, Triggers()));

			var decisionState = new AgentLockstepBarrier.State(decisionHorizon: 1);
			var barrier = OpenFrozen(decisionState);
			ResolveValid(decisionState, barrier, Agent1, "response-a");
			ResolveValid(decisionState, barrier, Agent2, "response-b");
			ApplyAndClose(decisionState, barrier);

			Assert.That(decisionState.CompletedLiveBarriers, Is.EqualTo(1));
			Assert.That(decisionState.StopKind, Is.EqualTo(AgentLockstepBarrier.StopKind.DecisionHorizon));
			Assert.Throws<InvalidDataException>(() =>
				AgentLockstepBarrier.Open(decisionState, 200, 40, Triggers()));
		}

		[Test]
		public void PrematchBarrierZero_DoesNotConsumeLiveBarrierOrDecisionIdentity()
		{
			var state = new AgentLockstepBarrier.State();
			var planning = AgentLockstepBarrier.OpenPrematch(state, [Agent1, Agent2]);
			AttachSnapshot(state, planning, Agent1, 1, "planning-a");
			AttachSnapshot(state, planning, Agent2, 1, "planning-b");
			ResolveValid(state, planning, Agent1, "plan-a");
			ResolveValid(state, planning, Agent2, "plan-b");
			AgentLockstepBarrier.MarkApplied(state, planning.BarrierId, 0, 0, "planning-commit");
			Assert.That(AgentLockstepBarrier.ShouldUnpause(state, planning.BarrierId), Is.False);
			AgentLockstepBarrier.Close(state, planning.BarrierId, 0, 0, worldPaused: false);

			var live = AgentLockstepBarrier.Open(state, 25, 1, Triggers());
			Assert.That(planning.BarrierId, Is.EqualTo(AgentLockstepBarrier.PrematchBarrierId));
			Assert.That(planning.Seats, Has.All.Property("DecisionId").EqualTo(
				AgentLockstepBarrier.PrematchDecisionId));
			Assert.That(state.PrematchCompleted, Is.True);
			Assert.That(live.BarrierId, Is.EqualTo(1));
			Assert.That(live.Seats, Has.All.Property("DecisionId").EqualTo(1));
			Assert.That(state.CompletedLiveBarriers, Is.Zero);
		}
	}
}
