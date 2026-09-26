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
using OpenRA.Mods.Common.Traits;

namespace OpenRA.Test
{
	[TestFixture]
	sealed class AgentDoctrineExecutorTest
	{
		static AgentDoctrineProgram.Program SovietTankPressure()
		{
			Assert.That(AgentDoctrineProgram.TryGet("soviet-tank-pressure", out var program), Is.True,
				"soviet-tank-pressure fixture must exist");
			return program;
		}

		[Test]
		public void PhaseHasStanding_ReflectsTheProgram()
		{
			var program = SovietTankPressure();

			Assert.That(AgentDoctrineExecutor.PhaseHasStanding(program, "mobilize", "scoutSweep"), Is.True);
			Assert.That(AgentDoctrineExecutor.PhaseHasStanding(program, "mobilize", "streamUnits"), Is.True);
			Assert.That(AgentDoctrineExecutor.PhaseHasStanding(program, "mobilize", "maintainSquads"), Is.True);
			Assert.That(AgentDoctrineExecutor.PhaseHasStanding(program, "mobilize", "buildPlan"), Is.True);

			Assert.That(AgentDoctrineExecutor.PhaseHasStanding(program, "pressure", "strikeMain"), Is.False,
				"offensive commitments must remain model-selected or play-fallback attributed");
			Assert.That(AgentDoctrineExecutor.PhaseHasStanding(program, "pressure", "streamUnits"), Is.True);

			// pressure drops standing reconnaissance; the model must ask for more scouting itself.
			Assert.That(AgentDoctrineExecutor.PhaseHasStanding(program, "pressure", "scoutSweep"), Is.False);

			// Unknown phase / verb / null program are all false, never a throw.
			Assert.That(AgentDoctrineExecutor.PhaseHasStanding(program, "nope", "scoutSweep"), Is.False);
			Assert.That(AgentDoctrineExecutor.PhaseHasStanding(program, "mobilize", "nope"), Is.False);
			Assert.That(AgentDoctrineExecutor.PhaseHasStanding(null, "mobilize", "scoutSweep"), Is.False);
			Assert.That(AgentDoctrineExecutor.PhaseHasStanding(program, "mobilize", null), Is.False);
		}

		[Test]
		public void NextPhaseName_AdvancesThenTerminates()
		{
			var program = SovietTankPressure();

			// mobilize → pressure, then the terminal phase has no successor.
			Assert.That(AgentDoctrineExecutor.NextPhaseName(program, "mobilize"), Is.EqualTo("pressure"));
			Assert.That(AgentDoctrineExecutor.NextPhaseName(program, "pressure"), Is.Null);

			// Unknown phase / null program never step off the end.
			Assert.That(AgentDoctrineExecutor.NextPhaseName(program, "nope"), Is.Null);
			Assert.That(AgentDoctrineExecutor.NextPhaseName(null, "mobilize"), Is.Null);
		}

		[Test]
		public void ShouldLaunchScout_AllGatesMustHold()
		{
			// Every gate true → launch.
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(
				executorEnabled: true, bound: true, paused: false,
				phaseHasScoutSweep: true, scoutMissionActive: false, scoutSquadLiveCount: 2), Is.True);

			// Any single gate false → do not launch.
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(false, true, false, true, false, 2), Is.False,
				"executor off");
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(true, false, false, true, false, 2), Is.False,
				"not bound");
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(true, true, true, true, false, 2), Is.False,
				"paused");
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(true, true, false, false, false, 2), Is.False,
				"phase has no scoutSweep");
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(true, true, false, true, true, 2), Is.False,
				"a sweep is already active");
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(true, true, false, true, false, 0), Is.False,
				"no live scouts to carry it");
		}

		[Test]
		public void ShouldLaunchScout_CooldownIsInclusiveAndActiveMissionAlwaysSuppresses()
		{
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(
				true, true, false, true, false, 2, worldTick: 749, nextScoutEligibleTick: 750), Is.False);
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(
				true, true, false, true, false, 2, worldTick: 750, nextScoutEligibleTick: 750), Is.True);
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(
				true, true, false, true, true, 2, worldTick: 5000, nextScoutEligibleTick: 0), Is.False);

			var nextEligibleTick = AgentDoctrineExecutor.ScoutEligibleTickAfterActivityTransition(
				wasActive: true, active: false, worldTick: 100, currentEligibleTick: 0);
			Assert.That(nextEligibleTick, Is.EqualTo(850));
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(
				true, true, false, true, false, 2, 849, nextEligibleTick), Is.False,
				"a direct model override suppresses standing relaunch for all 749 following ticks");
			Assert.That(AgentDoctrineExecutor.ShouldLaunchScout(
				true, true, false, true, false, 2, 850, nextEligibleTick), Is.True);
		}

		[Test]
		public void HarvesterSoftCap_StopsIncomeSpam()
		{
			Assert.That(AgentDoctrineExecutor.HarvesterSoftCap(0), Is.EqualTo(1));
			Assert.That(AgentDoctrineExecutor.HarvesterSoftCap(1), Is.EqualTo(3));
			Assert.That(AgentDoctrineExecutor.HarvesterSoftCap(3), Is.EqualTo(7));
			Assert.That(AgentDoctrineExecutor.HarvesterSoftCap(10), Is.EqualTo(AgentDoctrineExecutor.AbsoluteHarvesterCap));

			Assert.That(AgentDoctrineExecutor.ShouldAllowMoreHarvesters(2, 0, 1, 1), Is.True);
			Assert.That(AgentDoctrineExecutor.ShouldAllowMoreHarvesters(3, 0, 1, 1), Is.False, "at cap for 1 refinery");
			Assert.That(AgentDoctrineExecutor.ShouldAllowMoreHarvesters(6, 1, 3, 1), Is.False, "live+queued at cap");
			Assert.That(AgentDoctrineExecutor.ShouldAllowMoreHarvesters(5, 0, 3, 1), Is.True);
		}

		[Test]
		public void StreamQuantity_HappyPathIsBatchBounded()
		{
			// spendable = 2000-500 = 1500, affordable = 2, room = 2, batch = 1 → 1.
			Assert.That(AgentDoctrineExecutor.StreamQuantity(
				executorEnabled: true, bound: true, paused: false, phaseHasStreamUnits: true,
				cash: 2000, reserveForPlan: 500, planWaitingCash: false,
				unitCost: 600, inFlight: 0, maxConcurrent: 2, batch: 1), Is.EqualTo(1));
		}

		[Test]
		public void StreamQuantity_ReservesCashForThePlan()
		{
			// cash only 600, reserve 500 → 100 spendable < 200 cost → 0. The plan is never starved.
			Assert.That(AgentDoctrineExecutor.StreamQuantity(
				true, true, false, true, 600, 500, false, 200, 0, 2, 1), Is.EqualTo(0));
		}

		[Test]
		public void StreamQuantity_DoesNotStreamWhileThePlanWaitsOnCash()
		{
			Assert.That(AgentDoctrineExecutor.StreamQuantity(
				true, true, false, true, 100000, 500, planWaitingCash: true, 200, 0, 2, 1), Is.EqualTo(0));
		}

		[Test]
		public void StreamQuantity_RespectsConcurrencyCap()
		{
			// At the cap → 0.
			Assert.That(AgentDoctrineExecutor.StreamQuantity(
				true, true, false, true, 100000, 0, false, 200, 2, 2, 5), Is.EqualTo(0));

			// One slot free, plenty of cash, big batch → bounded to the single free slot.
			Assert.That(AgentDoctrineExecutor.StreamQuantity(
				true, true, false, true, 100000, 0, false, 200, 1, 2, 5), Is.EqualTo(1));
		}

		[Test]
		public void StreamQuantity_BoundedByAffordability()
		{
			// spendable 1000, cost 600 → only one affordable even with room and batch to spare.
			Assert.That(AgentDoctrineExecutor.StreamQuantity(
				true, true, false, true, 1000, 0, false, 600, 0, 5, 5), Is.EqualTo(1));
		}

		[Test]
		public void StreamQuantity_ZeroWhenExecutorOrPhaseGatesFail()
		{
			Assert.That(AgentDoctrineExecutor.StreamQuantity(
				false, true, false, true, 100000, 0, false, 200, 0, 2, 1), Is.EqualTo(0), "executor off");
			Assert.That(AgentDoctrineExecutor.StreamQuantity(
				true, false, false, true, 100000, 0, false, 200, 0, 2, 1), Is.EqualTo(0), "not bound");
			Assert.That(AgentDoctrineExecutor.StreamQuantity(
				true, true, true, true, 100000, 0, false, 200, 0, 2, 1), Is.EqualTo(0), "paused");
			Assert.That(AgentDoctrineExecutor.StreamQuantity(
				true, true, false, false, 100000, 0, false, 200, 0, 2, 1), Is.EqualTo(0), "phase has no streamUnits");
			Assert.That(AgentDoctrineExecutor.StreamQuantity(
				true, true, false, true, 100000, 0, false, 0, 0, 2, 1), Is.EqualTo(0), "unknown unit cost");
		}

		[Test]
		public void EffectiveStreamBounds_UseProgramValueThenDefault()
		{
			var soviet = SovietTankPressure();
			Assert.That(AgentDoctrineExecutor.EffectiveStreamMaxConcurrent(soviet), Is.EqualTo(2));
			Assert.That(AgentDoctrineExecutor.EffectiveStreamBatchCount(soviet), Is.EqualTo(1));

			var unset = new AgentDoctrineProgram.Program { StreamMaxConcurrent = 0, StreamBatchCount = 0 };
			Assert.That(AgentDoctrineExecutor.EffectiveStreamMaxConcurrent(unset),
				Is.EqualTo(AgentDoctrineExecutor.DefaultStreamMaxConcurrent));
			Assert.That(AgentDoctrineExecutor.EffectiveStreamBatchCount(unset),
				Is.EqualTo(AgentDoctrineExecutor.DefaultStreamBatchCount));

			var custom = new AgentDoctrineProgram.Program { StreamMaxConcurrent = 7, StreamBatchCount = 3 };
			Assert.That(AgentDoctrineExecutor.EffectiveStreamMaxConcurrent(custom), Is.EqualTo(7));
			Assert.That(AgentDoctrineExecutor.EffectiveStreamBatchCount(custom), Is.EqualTo(3));

			Assert.That(AgentDoctrineExecutor.EffectiveStreamMaxConcurrent(null),
				Is.EqualTo(AgentDoctrineExecutor.DefaultStreamMaxConcurrent));
		}

		[Test]
		public void ArmyReadyForOrders_NeedsForceAndTargetAndNoCommitment()
		{
			// Enough force, a scouted target, nothing committed → ready.
			Assert.That(AgentDoctrineExecutor.ArmyReadyForOrders(
				mainBodyCount: AgentDoctrineExecutor.ArmyCommitMinUnits, knownEnemyStructureCount: 1,
				hasActiveOffensiveMission: false), Is.True);

			// Below the commit floor → not ready (still massing).
			Assert.That(AgentDoctrineExecutor.ArmyReadyForOrders(
				AgentDoctrineExecutor.ArmyCommitMinUnits - 1, 1, false), Is.False);

			// No scouted enemy structure → nothing to commit to.
			Assert.That(AgentDoctrineExecutor.ArmyReadyForOrders(5, 0, false), Is.False);

			// Already committed to an offensive → do not nag.
			Assert.That(AgentDoctrineExecutor.ArmyReadyForOrders(5, 1, true), Is.False);
		}

		[Test]
		public void NeedsDecisionWake_ArmyIdleGated()
		{
			// armyIdle (a scouted, uncommitted main body) outranks phaseReady when both hold.
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(
				executorEnabled: true, bound: true, paused: false,
				armyReadyForOrders: true, phaseHeldAtBoundary: true), Is.EqualTo("armyIdle"));

			// Holding at a satisfied boundary with no idle army wakes phaseReady.
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, false, false, true),
				Is.EqualTo("phaseReady"));

			// Nothing pending → no wake.
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, false, false, false), Is.Null);

			// Gates: never wake while executor off, unbound, or paused.
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(false, true, false, true, true), Is.Null);
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, false, false, true, true), Is.Null);
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, true, true, true), Is.Null);
		}

		[Test]
		public void NeedsDecisionWake_UsesSafeContinuityPriority()
		{
			// Base defense preempts every offensive/continuity wake (defense before offense).
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, false, true, true,
				reinforceAttack: true, regroupNeeded: true, enemyContact: true, scoutFailed: true,
				baseDefenseNeeded: true), Is.EqualTo("baseDefenseNeeded"));
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, false, true, true,
				reinforceAttack: true, regroupNeeded: true, enemyContact: true, scoutFailed: true),
				Is.EqualTo("reinforceAttack"));
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, false, true, true,
				regroupNeeded: true, enemyContact: true, scoutFailed: true), Is.EqualTo("regroupNeeded"));
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, false, true, true,
				enemyContact: true, scoutFailed: true), Is.EqualTo("enemyContact"));
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, false, true, true,
				scoutFailed: true), Is.EqualTo("scoutFailed"));
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, false, true, true),
				Is.EqualTo("armyIdle"));
		}

		[Test]
		public void LocalVictory_AndCounterAttackWindow()
		{
			Assert.That(AgentDoctrineExecutor.IsLocalVictory(3, 1), Is.True);
			Assert.That(AgentDoctrineExecutor.IsLocalVictory(1, 0), Is.False, "need min 2 enemy lost");
			Assert.That(AgentDoctrineExecutor.IsEnemyBaseExposed(2, 1), Is.True);
			Assert.That(AgentDoctrineExecutor.IsEnemyBaseExposed(2, 5), Is.False);
			Assert.That(AgentDoctrineExecutor.ShouldCounterAttackWindow(
				true, true, mainBodyCount: 6, minForce: 6, false, false), Is.True);
			Assert.That(AgentDoctrineExecutor.ShouldCounterAttackWindow(
				true, true, 6, 6, hasOffensiveMission: true, false), Is.False);
			Assert.That(AgentDoctrineExecutor.ShouldPressAttack(true, 4, 1), Is.True);
			Assert.That(AgentDoctrineExecutor.ShouldPressAttack(false, 4, 1), Is.False);
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(
				true, true, false, false, false, counterAttackWindow: true), Is.EqualTo("counterAttackWindow"));
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(
				true, true, false, false, false, pressAttack: true), Is.EqualTo("pressAttack"));

			// Our priority: base defense preempts momentum; momentum outranks reinforce/regroup/armyIdle.
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, false, true, true,
				reinforceAttack: true, baseDefenseNeeded: true, counterAttackWindow: true, pressAttack: true),
				Is.EqualTo("baseDefenseNeeded"));
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, false, true, true,
				reinforceAttack: true, counterAttackWindow: true, pressAttack: true),
				Is.EqualTo("counterAttackWindow"));
			Assert.That(AgentDoctrineExecutor.NeedsDecisionWake(true, true, false, true, true,
				reinforceAttack: true, pressAttack: true), Is.EqualTo("pressAttack"));
		}

		[Test]
		public void ContactRequiredSweep_ContinuesPastThresholdAndPatrolsSerpentine()
		{
			Assert.That(AgentDoctrineExecutor.SweepDisposition(true, false, 35, 35, 4),
				Is.EqualTo("contact-seeking"));
			Assert.That(AgentDoctrineExecutor.SweepDisposition(true, false, 100, 85, 0),
				Is.EqualTo("patrol"));
			Assert.That(AgentDoctrineExecutor.SweepDisposition(true, true, 85, 85, 4),
				Is.EqualTo("complete-contact"));
			Assert.That(AgentDoctrineExecutor.SweepDisposition(false, false, 85, 85, 4),
				Is.EqualTo("complete-threshold"), "ordinary model-authored sweeps retain threshold completion");

			var sectors = AgentDoctrineExecutor.SerpentineSectors(
				[new CPos(8, 8), new CPos(0, 0), new CPos(8, 0), new CPos(0, 8)]);
			Assert.That(sectors, Is.EqualTo(new[]
			{
				new CPos(0, 0), new CPos(8, 0), new CPos(8, 8), new CPos(0, 8)
			}));
		}

		[Test]
		public void SuggestedOptionsFor_AreNonEmptyPerWakeAndEmptyOtherwise()
		{
			Assert.That(AgentDoctrineExecutor.SuggestedOptionsFor("armyIdle"), Is.Not.Empty);
			Assert.That(AgentDoctrineExecutor.SuggestedOptionsFor("phaseReady"), Is.Not.Empty);
			Assert.That(AgentDoctrineExecutor.SuggestedOptionsFor(null), Is.Empty);
			Assert.That(AgentDoctrineExecutor.SuggestedOptionsFor("nope"), Is.Empty);
		}

		[Test]
		public void FallbackStrikeReady_RequiresBothMissAndTimeGates()
		{
			Assert.That(AgentDoctrineExecutor.FallbackStrikeReady(2, 375, true, false), Is.True);
			Assert.That(AgentDoctrineExecutor.FallbackStrikeReady(1, 1000, true, false), Is.False,
				"one miss is never sufficient");
			Assert.That(AgentDoctrineExecutor.FallbackStrikeReady(2, 374, true, false), Is.False,
				"the deterministic time floor is inclusive at 375 ticks");
			Assert.That(AgentDoctrineExecutor.FallbackStrikeReady(2, 1000, false, false), Is.False,
				"army-ready preconditions must still hold");
			Assert.That(AgentDoctrineExecutor.FallbackStrikeReady(2, 1000, true, true), Is.False,
				"an in-flight model request always suppresses fallback");
		}

		[Test]
		public void CombatRoster_ExplicitlyExcludesEconomyBuildingsAndBaseBuilders()
		{
			Assert.That(AgentCombatRoster.IsExplicitlyExcludedType(
				new ActorInfo("harvester", new HarvesterInfo())), Is.True);
			Assert.That(AgentCombatRoster.IsExplicitlyExcludedType(
				new ActorInfo("refinery", new RefineryInfo())), Is.True);
			Assert.That(AgentCombatRoster.IsExplicitlyExcludedType(
				new ActorInfo("building", new BuildingInfo())), Is.True);
			Assert.That(AgentCombatRoster.IsExplicitlyExcludedType(
				new ActorInfo("mcv", new BaseBuildingInfo())), Is.True,
				"deployable critical base-builders must never enter a host combat roster");
		}

		[Test]
		public void ProgramValidation_RejectsVersionUnknownStandingAndOverlappingRolesBeforeBinding()
		{
			var program = new AgentDoctrineProgram.Program
			{
				CardVersion = 2,
				Faction = "soviets",
				ScoutUnitTypes = ["e1"],
				MainUnitTypes = ["e1"],
				StreamUnits = [],
				CommitMinUnits = 1,
				Phases =
				[
					new AgentDoctrineProgram.Phase { Name = "opening", Standing = ["unsupportedVerb"] }
				]
			};

			Assert.That(AgentDoctrineProgram.Validate(program, 1, "soviets", null),
				Does.Contain("does not match card"));
			Assert.That(AgentDoctrineProgram.Validate(program, 2, "soviets", null),
				Does.Contain("unsupported standing verb"));

			program = new AgentDoctrineProgram.Program
			{
				CardVersion = 2,
				Faction = "soviets",
				ScoutUnitTypes = ["e1"],
				MainUnitTypes = ["e1"],
				StreamUnits = [],
				CommitMinUnits = 1,
				Phases = [new AgentDoctrineProgram.Phase { Name = "opening", Standing = ["maintainSquads"] }]
			};
			Assert.That(AgentDoctrineProgram.Validate(program, 2, "soviets", null),
				Does.Contain("overlapping roster type"));
		}

		[Test]
		public void PortedPrograms_HaveVersionTwoRolesAndCommitThresholds()
		{
			Assert.That(AgentDoctrineProgram.TryGet("soviet-grenadier-rush", out var grenadiers), Is.True);
			Assert.That(grenadiers.CardVersion, Is.EqualTo(2));
			Assert.That(grenadiers.ScoutTypeQuotas["e2"], Is.EqualTo(2));
			Assert.That(grenadiers.CommitUnitType, Is.EqualTo("e2"));
			Assert.That(grenadiers.CommitMinUnits, Is.EqualTo(8));

			Assert.That(AgentDoctrineProgram.TryGet("allied-fast-boom", out var boom), Is.True);
			Assert.That(boom.MainUnitTypes, Is.EquivalentTo(new[] { "2tnk", "e3" }));
			Assert.That(boom.CommitMinUnits, Is.EqualTo(8));

			Assert.That(AgentDoctrineProgram.TryGet("allied-e3-mass", out var rockets), Is.True);
			Assert.That(rockets.ScoutTypeQuotas["e1"], Is.EqualTo(4));
			Assert.That(rockets.MainUnitTypes, Does.Contain("medi"));
			Assert.That(rockets.CommitUnitType, Is.EqualTo("e3"));
			Assert.That(rockets.CommitMinUnits, Is.EqualTo(14));
		}
	}
}
