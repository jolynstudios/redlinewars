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

using System.IO;
using System.Text.Json;
using NUnit.Framework;
using OpenRA.Browser;

namespace OpenRA.Test
{
	[TestFixture]
	sealed class AgentWarCompilerTest
	{
		[Test]
		public void ClampMinForce_DefaultsAndBounds()
		{
			Assert.That(AgentWarCompiler.ClampMinForce(null), Is.EqualTo(AgentWarCompiler.DefaultMinForce));
			Assert.That(AgentWarCompiler.ClampMinForce(0), Is.EqualTo(1));
			Assert.That(AgentWarCompiler.ClampMinForce(100), Is.EqualTo(AgentWarCompiler.DefaultMaxForce));
			Assert.That(AgentWarCompiler.ClampMinForce(8), Is.EqualTo(8));
		}

		[Test]
		public void NormalizeIntent_AcceptsStrikeHoldDefend()
		{
			Assert.That(AgentWarCompiler.NormalizeIntent("strike"), Is.EqualTo("strike"));
			Assert.That(AgentWarCompiler.NormalizeIntent("HOLD"), Is.EqualTo("hold"));
			Assert.That(AgentWarCompiler.NormalizeIntent("defendBase"), Is.EqualTo("defendBase"));
			Assert.That(AgentWarCompiler.NormalizeIntent("defend"), Is.EqualTo("defendBase"));
			Assert.Throws<InvalidDataException>(() => AgentWarCompiler.NormalizeIntent("raid"));
			Assert.Throws<InvalidDataException>(() => AgentWarCompiler.NormalizeIntent(""));
		}

		[Test]
		public void OutcomeDelta_OmittedFromRawObservationUntilGatedSet()
		{
			// FIX-1 outcome-delta rides the executor/guided surface only: [JsonIgnore]-null so the raw
			// benchmark observation stays byte-identical (the field never appears until the host sets it,
			// which only happens inside the actionGuidance/doctrineExecutor gate).
			var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);

			var raw = new AgentHostTruthObservation();
			Assert.That(JsonSerializer.Serialize(raw, options), Does.Not.Contain("outcomeDelta"),
				"raw benchmark observation must omit outcomeDelta entirely");

			raw.OutcomeDelta = new AgentOutcomeDeltaObservation { Summary = "since last decision" };
			Assert.That(JsonSerializer.Serialize(raw, options), Does.Contain("outcomeDelta"),
				"guided/executor observation surfaces outcomeDelta once the host sets it");
		}

		[Test]
		public void ResolveControlPhase_PriorityOrder()
		{
			Assert.That(AgentWarCompiler.ResolveControlPhase(true, true, 10, false, structureUnderAttack: true, false),
				Is.EqualTo("emergency"));
			Assert.That(AgentWarCompiler.ResolveControlPhase(true, true, 10, false, false, warCommitActive: true),
				Is.EqualTo("war"));
			Assert.That(AgentWarCompiler.ResolveControlPhase(true, true, 10, hasActiveOffensiveMission: true, false, false),
				Is.EqualTo("war"));
			Assert.That(AgentWarCompiler.ResolveControlPhase(false, false, 0, false, false, false),
				Is.EqualTo("opening"));
			Assert.That(AgentWarCompiler.ResolveControlPhase(true, false, 5, false, false, false),
				Is.EqualTo("economy"));
			Assert.That(AgentWarCompiler.ResolveControlPhase(true, true, 1, false, false, false),
				Is.EqualTo("economy"));
			Assert.That(AgentWarCompiler.ResolveControlPhase(true, true, 6, false, false, false),
				Is.EqualTo("army"));
		}

		[Test]
		public void LegalActions_WarPhaseIncludesCommitNotFreeformMicro()
		{
			var war = AgentWarCompiler.LegalActionsForPhase("war");
			Assert.That(war, Does.Contain("commitIntent"));
			Assert.That(war, Does.Contain("reinforceIntent"));
			Assert.That(war, Does.Not.Contain("attackMove"));

			// Phase D: power/place allowed mid-war so economy is not soft-locked.
			Assert.That(war, Does.Contain("placeBuildingAuto"));
			Assert.That(AgentWarCompiler.IsActionLegalInPhase("army", "commitIntent"), Is.True);
			Assert.That(AgentWarCompiler.IsActionLegalInPhase("opening", "attackMove"), Is.False);
		}

		[Test]
		public void ShouldLaunchCompiledStrike_MinForceAndCooldown()
		{
			Assert.That(AgentWarCompiler.ShouldLaunchCompiledStrike(
				true, mainLive: 5, minForce: 6, true, false, 1000, 0), Is.False, "under minForce");
			Assert.That(AgentWarCompiler.ShouldLaunchCompiledStrike(
				true, mainLive: 6, minForce: 6, true, false, 1000, 0), Is.True);
			Assert.That(AgentWarCompiler.ShouldLaunchCompiledStrike(
				true, mainLive: 6, minForce: 6, true, false, 100, nextLaunchEligibleTick: 200), Is.False, "cooldown");
			Assert.That(AgentWarCompiler.ShouldLaunchCompiledStrike(
				true, mainLive: 6, minForce: 6, true, offensiveMissionActive: true, 1000, 0), Is.False);
			Assert.That(AgentWarCompiler.ShouldLaunchCompiledStrike(
				commitIsStrike: false, 10, 6, true, false, 1000, 0), Is.False);
		}

		[Test]
		public void ShouldCompiledReinforce_OnlyWhileStrikeLive()
		{
			Assert.That(AgentWarCompiler.ShouldCompiledReinforce(true, true, idleCombatAtHome: 3, 500, 0), Is.True);
			Assert.That(AgentWarCompiler.ShouldCompiledReinforce(true, true, idleCombatAtHome: 0, 500, 0), Is.False);
			Assert.That(AgentWarCompiler.ShouldCompiledReinforce(true, offensiveMissionActive: false, 3, 500, 0), Is.False);
			Assert.That(AgentWarCompiler.ShouldCompiledReinforce(true, true, 3, 100, nextReinforceEligibleTick: 400), Is.False);
		}

		[Test]
		public void CapScoutRoster_AndMassingStatus()
		{
			Assert.That(AgentWarCompiler.CapScoutRoster(22), Is.EqualTo(AgentWarCompiler.DefaultScoutCap));
			Assert.That(AgentWarCompiler.CapScoutRoster(2), Is.EqualTo(2));
			Assert.That(AgentWarCompiler.MassingStatus(3, 6), Is.EqualTo("massing"));
			Assert.That(AgentWarCompiler.MassingStatus(6, 6), Is.EqualTo("ready"));
		}

		[Test]
		public void ShouldRejectDribbleCombatMove_WhenWarActive()
		{
			Assert.That(AgentWarCompiler.ShouldRejectDribbleCombatMove(true, "attackMove", true), Is.True);
			Assert.That(AgentWarCompiler.ShouldRejectDribbleCombatMove(true, "move", true), Is.True);
			Assert.That(AgentWarCompiler.ShouldRejectDribbleCombatMove(true, "attackMove", subjectsAreCombat: false), Is.False);
			Assert.That(AgentWarCompiler.ShouldRejectDribbleCombatMove(false, "attackMove", true), Is.False);
			Assert.That(AgentWarCompiler.ShouldRejectDribbleCombatMove(true, "commitIntent", true), Is.False);
		}

		[Test]
		public void ToMissionTargetPriority_MapsPower()
		{
			Assert.That(AgentWarCompiler.ToMissionTargetPriority("power"), Is.EqualTo("economy"));
			Assert.That(AgentWarCompiler.ToMissionTargetPriority("defenses"), Is.EqualTo("defenses"));
			Assert.That(AgentWarCompiler.ToMissionTargetPriority("any"), Is.EqualTo("any"));
		}

		[Test]
		public void TargetPriorityRank_RanksCommitPriorityFirstThenDefault()
		{
			// R5 bug 2: the picker must honour the model's commitIntent priority, not sort alphabetically.
			// any/blank priority keeps a stable production-first default order.
			Assert.That(AgentWarCompiler.TargetPriorityRank("any", "weap"),
				Is.LessThan(AgentWarCompiler.TargetPriorityRank("any", "proc")), "default ranks production over economy");
			Assert.That(AgentWarCompiler.TargetPriorityRank("", "proc"),
				Is.LessThan(AgentWarCompiler.TargetPriorityRank("", "powr")), "default ranks economy over power");

			// economy commit lifts the refinery above production.
			Assert.That(AgentWarCompiler.TargetPriorityRank("economy", "proc"), Is.EqualTo(0));
			Assert.That(AgentWarCompiler.TargetPriorityRank("economy", "proc"),
				Is.LessThan(AgentWarCompiler.TargetPriorityRank("economy", "weap")), "economy commit hits the refinery first");

			// production commit keeps production first even when a refinery is known.
			Assert.That(AgentWarCompiler.TargetPriorityRank("production", "weap"), Is.EqualTo(0));
			Assert.That(AgentWarCompiler.TargetPriorityRank("production", "weap"),
				Is.LessThan(AgentWarCompiler.TargetPriorityRank("production", "proc")));

			// power and defenses commits promote their own category to the front.
			Assert.That(AgentWarCompiler.TargetPriorityRank("power", "powr"), Is.EqualTo(0));
			Assert.That(AgentWarCompiler.TargetPriorityRank("power", "powr"),
				Is.LessThan(AgentWarCompiler.TargetPriorityRank("power", "weap")));
			Assert.That(AgentWarCompiler.TargetPriorityRank("defenses", "gun"), Is.EqualTo(0));
			Assert.That(AgentWarCompiler.TargetPriorityRank("defenses", "gun"),
				Is.LessThan(AgentWarCompiler.TargetPriorityRank("defenses", "proc")));

			// Unknown structure types sort behind every known category.
			Assert.That(AgentWarCompiler.TargetPriorityRank("any", "civ1"),
				Is.GreaterThan(AgentWarCompiler.TargetPriorityRank("any", "gun")));
		}

		[Test]
		public void StagingCell_IsHomeBiasedAndNeverOnTarget()
		{
			// R5 bug 1: a compiled/doctrine strike must stage short of the target, on the home side, not on
			// the attack point.
			var home = new CPos(10, 10);
			var target = new CPos(50, 10);
			var staging = AgentWarCompiler.StagingCell(home, target);

			Assert.That(staging, Is.Not.EqualTo(target), "the army must not stage on the attack point");
			Assert.That(staging.X, Is.GreaterThan(home.X), "staging advances off home toward the target");
			Assert.That(staging.X, Is.LessThanOrEqualTo((home.X + target.X) / 2), "staging stays home-biased (<= midpoint)");
			Assert.That((staging - target).LengthSquared, Is.GreaterThan(0), "staging keeps a margin from the target");

			// Degenerate and very-near targets fall back to home (mass at home rather than crawl onto the target).
			Assert.That(AgentWarCompiler.StagingCell(home, home), Is.EqualTo(home));
			Assert.That(AgentWarCompiler.StagingCell(home, new CPos(12, 10)), Is.EqualTo(home));
		}

		[Test]
		public void ShouldCompiledDisengage_OnlyUnderCommitWhenOutnumberedAndFuzzyFlees()
		{
			// BQ F4: pure gate for the compiled fuzzy disengage. It only fires under a live model war commit
			// with a compiled offensive active — never a host last-resort path.
			Assert.That(AgentWarCompiler.ShouldCompiledDisengage(
				warCommitActive: false, true, 3, 6, true), Is.False, "no war commit");
			Assert.That(AgentWarCompiler.ShouldCompiledDisengage(
				true, offensiveMissionActive: false, 3, 6, true), Is.False, "no live offensive");

			// Nothing to decide without a forward squad or without enemy contact.
			Assert.That(AgentWarCompiler.ShouldCompiledDisengage(true, true, forwardLive: 0, 6, true), Is.False);
			Assert.That(AgentWarCompiler.ShouldCompiledDisengage(true, true, 3, enemyNear: 0, true), Is.False);

			// Not locally outnumbered (enemy <= own): hold the commit and keep trading, ignore the fuzzy flee.
			Assert.That(AgentWarCompiler.ShouldCompiledDisengage(true, true, 6, 6, true), Is.False, "parity");
			Assert.That(AgentWarCompiler.ShouldCompiledDisengage(true, true, 6, 3, true), Is.False, "outnumbering");

			// Locally outnumbered: the fuzzy verdict decides flee-vs-trade.
			Assert.That(AgentWarCompiler.ShouldCompiledDisengage(true, true, 3, 6, fuzzyWantsFlee: true), Is.True);
			Assert.That(AgentWarCompiler.ShouldCompiledDisengage(true, true, 3, 6, fuzzyWantsFlee: false), Is.False);
		}
	}
}
