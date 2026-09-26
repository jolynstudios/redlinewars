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
	sealed class AgentAutopilotRecoveryTest
	{
		static AgentBuildPlanController.State ActivePlan(string blockedOn = "cash")
		{
			return new AgentBuildPlanController.State
			{
				PlanId = "opening",
				Version = 2,
				Steps = [new AgentBuildPlanStep { Item = "weap", Count = 1 }],
				StepState = "waitingCash",
				LastProgressTick = 100,
				BlockedOn = blockedOn
			};
		}

		[Test]
		public void BuildPlanWatchdog_ReleasesOnlyAtConfiguredStallBoundary()
		{
			var state = ActivePlan("cash");
			Assert.That(AgentBuildPlanController.ShouldWatchdogRelease(state, 849, 750, 250, out _), Is.False);
			Assert.That(AgentBuildPlanController.ShouldWatchdogRelease(state, 850, 750, 250, out var cause), Is.True);
			Assert.That(cause, Is.EqualTo("cash"));

			AgentBuildPlanController.WatchdogRelease(state, 850, cause);
			Assert.That(state.StepState, Is.EqualTo("cancelled"));
			Assert.That(AgentBuildPlanController.GetEvents(state, 0).Events[^1].Reason,
				Is.EqualTo("watchdogRelease: cash"));
		}

		[Test]
		public void BuildPlanWatchdog_ProgressResetsAndCommanderOrAlertPausesNeverRelease()
		{
			var state = ActivePlan("queue");
			AgentBuildPlanController.MarkProgress(state, 700, "queue advanced");
			Assert.That(AgentBuildPlanController.ShouldWatchdogRelease(state, 1400, 750, 250, out _), Is.False);
			Assert.That(AgentBuildPlanController.ShouldWatchdogRelease(state, 1450, 750, 250, out var cause), Is.True);
			Assert.That(cause, Is.EqualTo("queue"));

			foreach (var source in new[] { "commander", "criticalAlert" })
			{
				var paused = ActivePlan();
				paused.Paused = true;
				paused.PauseSource = source;
				Assert.That(AgentBuildPlanController.ShouldWatchdogRelease(paused, 10000, 750, 250, out _), Is.False);
			}
		}

		[Test]
		public void BuildPlanWatchdog_InternalFailureUsesShortBoundary()
		{
			var state = ActivePlan("internalFailure");
			state.Paused = true;
			state.PauseSource = "internalFailure";
			Assert.That(AgentBuildPlanController.ShouldWatchdogRelease(state, 349, 750, 250, out _), Is.False);
			Assert.That(AgentBuildPlanController.ShouldWatchdogRelease(state, 350, 750, 250, out var cause), Is.True);
			Assert.That(cause, Is.EqualTo("internalFailure"));
		}

		[Test]
		public void BuildPlanReservation_IsQueueLocalAndCashFloorIsExact()
		{
			Assert.That(AgentBuildPlanController.IsProducerReserved(true, 41, 41), Is.True);
			Assert.That(AgentBuildPlanController.IsProducerReserved(true, 41, 42), Is.False,
				"another producer remains available");
			Assert.That(AgentBuildPlanController.DirectSpendLeavesPlanFloor(
				cash: 2500, directSpend: 500, currentStepCost: 1500, reserveCash: 500), Is.True);
			Assert.That(AgentBuildPlanController.DirectSpendLeavesPlanFloor(
				cash: 2499, directSpend: 500, currentStepCost: 1500, reserveCash: 500), Is.False);
		}

		[Test]
		public void EmergencyHarvester_AllowsExactlyOneOnlyWhenNoneIsUsableOrQueued()
		{
			Assert.That(AgentBuildPlanController.EmergencyHarvesterAllowed(1, false, false), Is.True);
			Assert.That(AgentBuildPlanController.EmergencyHarvesterAllowed(2, false, false), Is.False);
			Assert.That(AgentBuildPlanController.EmergencyHarvesterAllowed(1, true, false), Is.False);
			Assert.That(AgentBuildPlanController.EmergencyHarvesterAllowed(1, false, true), Is.False);
		}

		[Test]
		public void CancelFirstBatch_RequiresExecutorAndExactFirstAction()
		{
			var cancel = new AgentAction { Type = "controlBuildPlan", Command = "cancel" };
			var produce = new AgentAction { Type = "startProduction", Item = "e1", ProducerId = 1, Count = 1 };
			Assert.That(AgentBuildPlanController.IsExecutorCancelFirstBatch(true, [cancel, produce]), Is.True);
			Assert.That(AgentBuildPlanController.IsExecutorCancelFirstBatch(false, [cancel, produce]), Is.False);
			Assert.That(AgentBuildPlanController.IsExecutorCancelFirstBatch(true, [produce, cancel]), Is.False);
			Assert.That(AgentBuildPlanController.IsExecutorCancelFirstBatch(true, [cancel]), Is.False);
		}

		[Test]
		public void DoctrineDecision_PersistsIdentityTracksMissesAndRearms()
		{
			var state = new AgentDoctrineDecisionController.State();
			var first = AgentDoctrineDecisionController.Issue(state, "armyIdle", 100,
				[new AgentGuidanceOptionObservation { OptionId = "defer", Kind = "defer" }]);
			var refreshed = AgentDoctrineDecisionController.Issue(state, "armyIdle", 150,
				[new AgentGuidanceOptionObservation { OptionId = "strike", Kind = "strike" }]);
			Assert.That(refreshed.DecisionId, Is.EqualTo(first.DecisionId));
			Assert.That(refreshed.Options[0].DecisionId, Is.EqualTo(first.DecisionId));

			Assert.That(AgentDoctrineDecisionController.RecordMiss(state, 175), Is.True);
			Assert.That(refreshed.MissCount, Is.EqualTo(1));
			Assert.That(refreshed.RearmTick, Is.EqualTo(275));
		}

		[Test]
		public void DoctrineDecision_DiscardsOnlyTheCurrentStaleRejectionRepair()
		{
			var state = new AgentDoctrineDecisionController.State();
			var repair = AgentDoctrineDecisionController.Issue(state, "rejectionRepair", 100,
				[new AgentGuidanceOptionObservation { OptionId = "repair-cancel-plan-first", Kind = "repair" }]);

			Assert.That(AgentDoctrineDecisionController.DiscardStaleRejectionRepair(
				state, repair.DecisionId + 1), Is.False);
			Assert.That(state.Pending, Is.SameAs(repair));
			Assert.That(AgentDoctrineDecisionController.DiscardStaleRejectionRepair(
				state, repair.DecisionId), Is.True);
			Assert.That(state.Pending, Is.Null);

			var offensive = AgentDoctrineDecisionController.Issue(state, "armyIdle", 200,
				[new AgentGuidanceOptionObservation { OptionId = "strike", Kind = "strike" }]);
			Assert.That(AgentDoctrineDecisionController.DiscardStaleRejectionRepair(
				state, offensive.DecisionId), Is.False);
			Assert.That(state.Pending, Is.SameAs(offensive));
		}

		[Test]
		public void DoctrineDecision_FallbackRequiresMissTimePreconditionsAndNoRequest()
		{
			var state = new AgentDoctrineDecisionController.State();
			var decision = AgentDoctrineDecisionController.Issue(state, "armyIdle", 100,
				[new AgentGuidanceOptionObservation { OptionId = "strike", Kind = "strike" }]);
			AgentDoctrineDecisionController.RecordMiss(state, 125);
			AgentDoctrineDecisionController.RecordMiss(state, 225);

			Assert.That(AgentDoctrineDecisionController.ShouldFallback(decision, 474, true, false), Is.False);
			Assert.That(AgentDoctrineDecisionController.ShouldFallback(decision, 475, true, false), Is.True);
			Assert.That(AgentDoctrineDecisionController.ShouldFallback(decision, 1000, false, false), Is.False);
			Assert.That(AgentDoctrineDecisionController.ShouldFallback(decision, 1000, true, true), Is.False);
		}

		static AgentDoctrineDecisionController.Candidate Candidate(uint actorId, int distanceSquared,
			bool allowed = true, bool eligible = true, bool idle = true, bool inMission = false,
			bool intervention = false)
		{
			return new AgentDoctrineDecisionController.Candidate
			{
				ActorId = actorId,
				AllowedRosterMember = allowed,
				OwnedLiveCombat = eligible,
				Idle = idle,
				InMission = inMission,
				InterventionActive = intervention,
				DistanceFromHomeSquared = distanceSquared
			};
		}

		[Test]
		public void ReinforceCandidates_RequireTwoCapAtSixAndSortByActorId()
		{
			var selected = AgentDoctrineDecisionController.SelectReinforceCandidates(
			[
				Candidate(9, 4), Candidate(2, 4), Candidate(8, 4), Candidate(1, 4),
				Candidate(7, 4), Candidate(3, 4), Candidate(6, 4), Candidate(5, 4),
				Candidate(4, 4, intervention: true), Candidate(10, 4, inMission: true)
			]);
			Assert.That(selected, Is.EqualTo(new uint[] { 1, 2, 3, 5, 6, 7 }));

			Assert.That(AgentDoctrineDecisionController.SelectReinforceCandidates(
				[Candidate(1, 4), Candidate(2, 4, idle: false)]), Is.Empty,
				"one eligible unit never opens a reinforce decision");
			Assert.That(AgentDoctrineDecisionController.ShouldOfferReinforce(true, false, 2), Is.True);
			Assert.That(AgentDoctrineDecisionController.ShouldOfferReinforce(true, true, 6), Is.False,
				"an active reinforce mission suppresses another wave");
		}

		[Test]
		public void ReinforceAndRegroup_UseExactTwelveCellBoundaryAndExcludeLeases()
		{
			var candidates = new[]
			{
				Candidate(1, 144), Candidate(2, 143), Candidate(3, 145),
				Candidate(4, 200, intervention: true), Candidate(5, 200, allowed: false)
			};
			Assert.That(AgentDoctrineDecisionController.SelectReinforceCandidates(candidates),
				Is.EqualTo(new uint[] { 1, 2 }), "twelve cells is still at home");
			Assert.That(AgentDoctrineDecisionController.SelectRegroupCandidates(candidates), Is.Empty,
				"only one unleased recorded survivor is strictly farther than twelve cells");

			var regroup = AgentDoctrineDecisionController.SelectRegroupCandidates(
				[Candidate(3, 145), Candidate(6, 200)]);
			Assert.That(regroup, Is.EqualTo(new uint[] { 3, 6 }));
		}

		[Test]
		public void RegroupOffer_ExpiresAfterTheSevenHundredFiftyTickWindow()
		{
			Assert.That(AgentDoctrineDecisionController.ShouldOfferRegroup(false, 100, 850, 2), Is.True);
			Assert.That(AgentDoctrineDecisionController.ShouldOfferRegroup(false, 100, 851, 2), Is.False);
			Assert.That(AgentDoctrineDecisionController.ShouldOfferRegroup(true, 100, 200, 2), Is.False);
			Assert.That(AgentDoctrineDecisionController.ShouldOfferRegroup(false, 100, 200, 1), Is.False);
		}

		[Test]
		public void ReinforceAndRegroupOptions_DiscloseOnlyExactSortedActorsAndTarget()
		{
			var option = AgentDoctrineDecisionController.ExactAttackMoveOption("reinforce-wave", "reinforce",
				"reinforceAttack", [9, 2, 9, 5], 30, 40);
			Assert.That(option.OptionId, Is.EqualTo("reinforce-wave"));
			Assert.That(option.Kind, Is.EqualTo("reinforceAttack"));
			Assert.That(option.Actions, Has.Count.EqualTo(1));
			Assert.That(option.Actions[0].Type, Is.EqualTo("attackMove"));
			Assert.That(option.Actions[0].ActorIds, Is.EqualTo(new uint[] { 2, 5, 9 }));
			Assert.That(option.Actions[0].CellX, Is.EqualTo(30));
			Assert.That(option.Actions[0].CellY, Is.EqualTo(40));
		}

		[Test]
		public void GroundOffensiveClassification_ExcludesAirStrikeAndReinforce()
		{
			Assert.That(AgentDoctrineExecutor.IsGroundOffensive("strike"), Is.True);
			Assert.That(AgentDoctrineExecutor.IsGroundOffensive("pincer"), Is.True);
			Assert.That(AgentDoctrineExecutor.IsGroundOffensive("pursue"), Is.True);
			Assert.That(AgentDoctrineExecutor.IsGroundOffensive("airStrike"), Is.False);
			Assert.That(AgentDoctrineExecutor.IsGroundOffensive("reinforce"), Is.False);
		}
	}
}
