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

using System;
using System.Collections.Generic;
using AI.Fuzzy.Library;

namespace OpenRA.Browser
{
	/// <summary>
	/// Engine-independent port of OpenRA.Mods.Common's AttackOrFleeFuzzy decision logic. The Mods.Common
	/// squad AI reads live Actor / Health / Armament / Mobile traits; this helper instead takes the four
	/// already-normalized scalar inputs so the war compiler can decide flee-vs-trade for a committed squad
	/// without coupling to the engine (Actor / World / Traits never appear here — only doubles). Same Mamdani
	/// variables, terms and default rule set as <c>AttackOrFleeFuzzy.Default</c>; the defuzzified attack
	/// chance below 30 means "trade" (stand and fight), matching the engine's <c>CanAttack</c>.
	/// <para>Inputs: ownHealthPercent / enemyHealthPercent are aggregate health 0..100 (100 == full);
	/// relativeAttackPower is own effective combat weight vs the enemy's (0..999, 100 == parity); relativeSpeed
	/// is own average speed vs the enemy's (0..999, 100 == parity).</para>
	/// <para>Pure staff-work: this is not a host last-resort path. It only informs a decision the model already
	/// authorized by committing a war, so pureGeneralValid stays true.</para>
	/// </summary>
	static class AgentFuzzyEngagement
	{
		// Threshold at which the defuzzified output tips from trade to flee — matches AttackOrFleeFuzzy.CanAttack.
		const double AttackThreshold = 30.0;

		// Copied verbatim from AttackOrFleeFuzzy.DefaultRulesNormalOwnHealth (Mods.Common) so the compiled
		// disengage verdict matches the engine's squad AI when the model-committed squad is at full health.
		static readonly string[] RulesNormalOwnHealth =
		[
			"if ((OwnHealth is Normal) " +
			"and ((EnemyHealth is NearDead) or (EnemyHealth is Injured) or (EnemyHealth is Normal)) " +
			"and ((RelativeAttackPower is Weak) or (RelativeAttackPower is Equal) or (RelativeAttackPower is Strong)) " +
			"and ((RelativeSpeed is Slow) or (RelativeSpeed is Equal) or (RelativeSpeed is Fast))) " +
			"then AttackOrFlee is Attack"
		];

		// Copied verbatim from AttackOrFleeFuzzy.DefaultRulesInjuredOwnHealth (Mods.Common).
		static readonly string[] RulesInjuredOwnHealth =
		[
			"if ((OwnHealth is Injured) " +
			"and (EnemyHealth is NearDead) " +
			"and ((RelativeAttackPower is Weak) or (RelativeAttackPower is Equal) or (RelativeAttackPower is Strong)) " +
			"and ((RelativeSpeed is Slow) or (RelativeSpeed is Equal) or (RelativeSpeed is Fast))) " +
			"then AttackOrFlee is Attack",

			"if ((OwnHealth is Injured) " +
			"and ((EnemyHealth is Injured) or (EnemyHealth is Normal)) " +
			"and ((RelativeAttackPower is Equal) or (RelativeAttackPower is Strong)) " +
			"and ((RelativeSpeed is Slow) or (RelativeSpeed is Equal) or (RelativeSpeed is Fast))) " +
			"then AttackOrFlee is Attack",

			"if ((OwnHealth is Injured) " +
			"and ((EnemyHealth is Injured) or (EnemyHealth is Normal)) " +
			"and (RelativeAttackPower is Weak) " +
			"and (RelativeSpeed is Slow)) " +
			"then AttackOrFlee is Attack",

			"if ((OwnHealth is Injured) " +
			"and ((EnemyHealth is Injured) or (EnemyHealth is Normal)) " +
			"and (RelativeAttackPower is Weak) " +
			"and ((RelativeSpeed is Equal) or (RelativeSpeed is Fast))) " +
			"then AttackOrFlee is Flee",

			"if ((OwnHealth is Injured) " +
			"and ((EnemyHealth is NearDead) or (EnemyHealth is Injured) or (EnemyHealth is Normal)) " +
			"and ((RelativeAttackPower is Weak) or (RelativeAttackPower is Equal) or (RelativeAttackPower is Strong)) " +
			"and (RelativeSpeed is Slow)) " +
			"then AttackOrFlee is Attack"
		];

		// Copied verbatim from AttackOrFleeFuzzy.DefaultRulesNearDeadOwnHealth (Mods.Common).
		static readonly string[] RulesNearDeadOwnHealth =
		[
			"if ((OwnHealth is NearDead) " +
			"and ((EnemyHealth is NearDead) or (EnemyHealth is Injured)) " +
			"and ((RelativeAttackPower is Equal) or (RelativeAttackPower is Strong)) " +
			"and ((RelativeSpeed is Slow) or (RelativeSpeed is Equal))) " +
			"then AttackOrFlee is Attack",

			"if ((OwnHealth is NearDead) " +
			"and ((EnemyHealth is NearDead) or (EnemyHealth is Injured)) " +
			"and (RelativeAttackPower is Weak) " +
			"and ((RelativeSpeed is Equal) or (RelativeSpeed is Fast))) " +
			"then AttackOrFlee is Flee",

			"if ((OwnHealth is NearDead) " +
			"and (EnemyHealth is Normal) " +
			"and (RelativeAttackPower is Weak) " +
			"and ((RelativeSpeed is Equal) or (RelativeSpeed is Fast))) " +
			"then AttackOrFlee is Flee",

			"if (OwnHealth is NearDead) " +
			"and (EnemyHealth is Normal) " +
			"and ((RelativeAttackPower is Equal) or (RelativeAttackPower is Strong)) " +
			"and (RelativeSpeed is Fast) " +
			"then AttackOrFlee is Flee",

			"if (OwnHealth is NearDead) " +
			"and (EnemyHealth is Injured) " +
			"and (RelativeAttackPower is Equal) " +
			"and (RelativeSpeed is Fast) " +
			"then AttackOrFlee is Flee"
		];

		static readonly MamdaniFuzzySystem FuzzyEngine = BuildEngine();

		static MamdaniFuzzySystem BuildEngine()
		{
			// Same variables/terms as AttackOrFleeFuzzy so the trapezoid membership functions line up exactly.
			var engine = new MamdaniFuzzySystem();

			var ownHealth = new FuzzyVariable("OwnHealth", 0.0, 100.0);
			ownHealth.Terms.Add(new FuzzyTerm("NearDead", new TrapezoidMembershipFunction(0, 0, 20, 40)));
			ownHealth.Terms.Add(new FuzzyTerm("Injured", new TrapezoidMembershipFunction(30, 50, 50, 70)));
			ownHealth.Terms.Add(new FuzzyTerm("Normal", new TrapezoidMembershipFunction(50, 80, 100, 100)));
			engine.Input.Add(ownHealth);

			var enemyHealth = new FuzzyVariable("EnemyHealth", 0.0, 100.0);
			enemyHealth.Terms.Add(new FuzzyTerm("NearDead", new TrapezoidMembershipFunction(0, 0, 20, 40)));
			enemyHealth.Terms.Add(new FuzzyTerm("Injured", new TrapezoidMembershipFunction(30, 50, 50, 70)));
			enemyHealth.Terms.Add(new FuzzyTerm("Normal", new TrapezoidMembershipFunction(50, 80, 100, 100)));
			engine.Input.Add(enemyHealth);

			var relativeAttackPower = new FuzzyVariable("RelativeAttackPower", 0.0, 1000.0);
			relativeAttackPower.Terms.Add(new FuzzyTerm("Weak", new TrapezoidMembershipFunction(0, 0, 70, 90)));
			relativeAttackPower.Terms.Add(new FuzzyTerm("Equal", new TrapezoidMembershipFunction(85, 100, 100, 115)));
			relativeAttackPower.Terms.Add(new FuzzyTerm("Strong", new TrapezoidMembershipFunction(110, 150, 150, 1000)));
			engine.Input.Add(relativeAttackPower);

			var relativeSpeed = new FuzzyVariable("RelativeSpeed", 0.0, 1000.0);
			relativeSpeed.Terms.Add(new FuzzyTerm("Slow", new TrapezoidMembershipFunction(0, 0, 70, 90)));
			relativeSpeed.Terms.Add(new FuzzyTerm("Equal", new TrapezoidMembershipFunction(85, 100, 100, 115)));
			relativeSpeed.Terms.Add(new FuzzyTerm("Fast", new TrapezoidMembershipFunction(110, 150, 150, 1000)));
			engine.Input.Add(relativeSpeed);

			var attackOrFlee = new FuzzyVariable("AttackOrFlee", 0.0, 50.0);
			attackOrFlee.Terms.Add(new FuzzyTerm("Attack", new TrapezoidMembershipFunction(0, 15, 15, 30)));
			attackOrFlee.Terms.Add(new FuzzyTerm("Flee", new TrapezoidMembershipFunction(25, 35, 35, 50)));
			engine.Output.Add(attackOrFlee);

			foreach (var rule in RulesNormalOwnHealth)
				engine.Rules.Add(engine.ParseRule(rule));
			foreach (var rule in RulesInjuredOwnHealth)
				engine.Rules.Add(engine.ParseRule(rule));
			foreach (var rule in RulesNearDeadOwnHealth)
				engine.Rules.Add(engine.ParseRule(rule));

			return engine;
		}

		/// <summary>
		/// Defuzzified attack chance (0..50) for the four scalar inputs. Lower means attack; per the engine's
		/// AttackOrFleeFuzzy, a value below 30 trades and 30+ (or NaN when no rule fires) flees.
		/// </summary>
		internal static double AttackChance(double ownHealthPercent, double enemyHealthPercent,
			double relativeAttackPower, double relativeSpeed)
		{
			// The library mutates shared engine state during Calculate; the browser is single-threaded but the
			// lock keeps the static engine safe if a test fixture ever exercises it concurrently.
			lock (FuzzyEngine)
			{
				var inputs = new Dictionary<FuzzyVariable, double>
				{
					[FuzzyEngine.InputByName("OwnHealth")] = Clamp(ownHealthPercent, 0.0, 100.0),
					[FuzzyEngine.InputByName("EnemyHealth")] = Clamp(enemyHealthPercent, 0.0, 100.0),
					[FuzzyEngine.InputByName("RelativeAttackPower")] = Clamp(relativeAttackPower, 0.0, 999.0),
					[FuzzyEngine.InputByName("RelativeSpeed")] = Clamp(relativeSpeed, 0.0, 999.0)
				};

				var result = FuzzyEngine.Calculate(inputs);
				return result[FuzzyEngine.OutputByName("AttackOrFlee")];
			}
		}

		/// <summary>
		/// True when the fuzzy verdict is to stand and fight (trade). Mirrors AttackOrFleeFuzzy.CanAttack:
		/// an attack chance below 30 (and not NaN) trades.
		/// </summary>
		internal static bool CanAttack(double ownHealthPercent, double enemyHealthPercent,
			double relativeAttackPower, double relativeSpeed)
		{
			var chance = AttackChance(ownHealthPercent, enemyHealthPercent, relativeAttackPower, relativeSpeed);
			return !double.IsNaN(chance) && chance < AttackThreshold;
		}

		/// <summary>
		/// True when the fuzzy verdict is to flee (disengage) — the inverse of <see cref="CanAttack"/>. An
		/// ambiguous verdict (no rule fires → NaN) flees, which is the conservative choice for a squad that is
		/// already locally outnumbered.
		/// </summary>
		internal static bool ShouldDisengage(double ownHealthPercent, double enemyHealthPercent,
			double relativeAttackPower, double relativeSpeed)
		{
			return !CanAttack(ownHealthPercent, enemyHealthPercent, relativeAttackPower, relativeSpeed);
		}

		static double Clamp(double value, double min, double max)
		{
			return Math.Max(min, Math.Min(max, value));
		}
	}
}
