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
using System.Globalization;
using System.Linq;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Warheads;

namespace OpenRA.Mods.Common.UtilityCommands
{
	sealed class ExtractAgentKnowledgeCommand : IUtilityCommand
	{
		static readonly string[] ArmorOrder = ["none", "wood", "light", "heavy", "concrete"];

		string IUtilityCommand.Name => "--extract-agent-knowledge";

		bool IUtilityCommand.ValidateArguments(string[] args)
		{
			return args.Length == 1 ||
				(args.Length == 2 && string.Equals(args[1], "arsenal", StringComparison.Ordinal));
		}

		[Desc("Generate compact, rules-derived knowledge for browser Agent mode.")]
		void IUtilityCommand.Run(Utility utility, string[] args)
		{
			// HACK: The engine code assumes that Game.modData is set.
			Game.ModData = utility.ModData;

			if (args.Length == 2)
			{
				Console.WriteLine(AgentArsenalExtractor.Extract(utility.ModData));
				return;
			}

			var actors = utility.ModData.DefaultRules.Actors.Values
				.Where(a => !a.Name.StartsWith(ActorInfo.AbstractActorPrefix) && a.HasTraitInfo<BuildableInfo>())
				.Select(a =>
				{
					var buildable = a.TraitInfo<BuildableInfo>();
					var cost = a.TraitInfoOrDefault<ValuedInfo>()?.Cost ?? 0;
					var queue = buildable.Queue.Order().JoinWith("/");
					return (Actor: a, Buildable: buildable, Cost: cost, Queue: queue);
				})
				.OrderBy(a => a.Queue, StringComparer.Ordinal)
				.ThenBy(a => a.Cost)
				.ThenBy(a => a.Actor.Name, StringComparer.Ordinal)
				.ToArray();

			Console.WriteLine("# OpenRA Red Alert rules reference");
			Console.WriteLine();
			Console.WriteLine("Generated from the exact RA rules loaded by OpenRA.Utility. Do not edit by hand.");
			Console.WriteLine("Legend: build time is approximately cost×0.6 ticks at 25 ticks/s; low power is 3× slower. " +
				"Build area: the Construction Yard provides a 16-cell radius; ordinary structures extend buildable area only 2 cells around themselves (walls 7, naval yards 8).");
			Console.WriteLine("Armor order in weapon versus values: none/wood/light/heavy/concrete. `~` marks faction/tech prerequisites.");
			Console.WriteLine("Rows: code|name|queue|cost|prerequisites|power|HP|armor|speed|primary damage; versus%; range cells.");
			Console.WriteLine();
			Console.WriteLine("## Buildable actors");
			Console.WriteLine();

			foreach (var actor in actors)
				Console.WriteLine(ActorLine(actor.Actor, actor.Buildable, actor.Cost, actor.Queue));

			Console.WriteLine();
			Console.WriteLine("## Strategy priors");
			Console.WriteLine();
			Console.WriteLine("- Deploy the MCV first; the resulting `fact` Construction Yard enables the building queue and build area.");
			Console.WriteLine("- Start with `powr`, then `proc`; avoid beginning a second structure until the first is placed.");
			Console.WriteLine("- A finished building queue item has `placeable:true`; use `placeBuildingAuto` instead of guessing a cell.");
			Console.WriteLine("- Keep power provided above power drained. Low power triples every remaining production ETA.");
			Console.WriteLine("- Two refineries support a stable economy; replace lost harvesters before expanding tech.");
			Console.WriteLine("- Add `barr` or `tent` for infantry and `weap` for vehicles after basic power and refining.");
			Console.WriteLine("- Production queues operate in parallel: structures, infantry, vehicles, aircraft, and naval can build simultaneously.");
			Console.WriteLine("- Spend excess cash on production capacity and units; add `silo` near resource capacity.");
			Console.WriteLine("- Infantry are cheap scouts and screens; rifle infantry are effective against other infantry.");
			Console.WriteLine("- Rockets and heavy anti-armor weapons counter light/heavy vehicles better than rifles do.");
			Console.WriteLine("- Tanks pressure vehicles and structures; protect them from concentrated anti-armor infantry and aircraft.");
			Console.WriteLine("- Use Yaks against infantry and light targets; their cannon is much weaker against heavy armor and concrete.");
			Console.WriteLine("- Use MiGs against structures and armored targets; their warhead is less effective against unarmored infantry.");
			Console.WriteLine("- An `airStrike` mission automatically returns aircraft to compatible rearm actors between sorties.");
			Console.WriteLine("- Scout a strike cell with `spyPlane` when ready before committing aircraft; otherwise reveal it with normal scouting.");
			Console.WriteLine("- Avoid committing aircraft into visible `sam` or `agun` coverage unless the trade is decisive.");
			Console.WriteLine("- Static defenses protect a known approach but do not replace scouting or a mobile army.");
			Console.WriteLine("- Start a `sweep` mission early with a small cheap group so later attacks use fresher map knowledge.");
			Console.WriteLine("- Raid visible economy targets first, especially harvesters and refineries, before shifting pressure to production.");
			Console.WriteLine("- Move toward `scouting.frontier` cells when the enemy is absent from the observation; absence under fog is not proof of safety.");
			Console.WriteLine("- Attack only visible enemy actor ids; use attack-move into unexplored territory to advance without inventing targets.");
			Console.WriteLine("- Preserve the MCV/Construction Yard, refineries, power, and production buildings; rebuild the economy before risky attacks.");
		}

		static string ActorLine(ActorInfo actor, BuildableInfo buildable, int cost, string queue)
		{
			var tooltip = actor.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.EnabledByDefault);
			var displayName = Clean(tooltip == null ? actor.Name : FluentProvider.GetMessage(tooltip.Name));
			var prerequisites = buildable.Prerequisites.Length == 0 ? "-" : buildable.Prerequisites.JoinWith(",");
			var power = actor.TraitInfos<PowerInfo>().Where(p => p.EnabledByDefault).Sum(p => p.Amount);
			var hp = actor.TraitInfoOrDefault<HealthInfo>()?.HP ?? 0;
			var armor = (actor.TraitInfos<ArmorInfo>().FirstOrDefault(a => a.EnabledByDefault)?.Type ?? "none").ToLowerInvariant();
			var mobile = actor.TraitInfos<MobileInfo>().FirstOrDefault(m => m.EnabledByDefault);
			var aircraft = actor.TraitInfos<AircraftInfo>().FirstOrDefault(a => a.EnabledByDefault);
			var speed = mobile?.Speed ?? aircraft?.Speed ?? 0;
			var weapon = PrimaryWeapon(actor);

			return $"- {actor.Name}|{displayName}|{EmptyAsDash(queue)}|{cost}|{prerequisites}|{power}|{hp}|{armor}|{speed}|{weapon}";
		}

		static string PrimaryWeapon(ActorInfo actor)
		{
			var armament = actor.TraitInfos<ArmamentInfo>()
				.Where(a => a.EnabledByDefault && a.WeaponInfo != null)
				.OrderBy(a => a.Name == "primary" ? 0 : 1)
				.ThenBy(a => a.Name, StringComparer.Ordinal)
				.FirstOrDefault();
			var weapon = armament?.WeaponInfo;
			var damage = weapon?.Warheads.OfType<DamageWarhead>().FirstOrDefault();
			if (weapon == null || damage == null)
				return "-";

			var versus = ArmorOrder.Select(type => VersusPercent(damage, type)).JoinWith("/");
			var range = (weapon.Range.Length / 1024d).ToString("0.##", CultureInfo.InvariantCulture);
			return $"{damage.Damage};{versus};{range}";
		}

		static int VersusPercent(DamageWarhead warhead, string armor)
		{
			foreach (var versus in warhead.Versus)
				if (string.Equals(versus.Key, armor, StringComparison.OrdinalIgnoreCase))
					return versus.Value;

			return 100;
		}

		static string Clean(string value)
		{
			return value.Replace('|', '/').Replace('\r', ' ').Replace('\n', ' ').Trim();
		}

		static string EmptyAsDash(string value)
		{
			return string.IsNullOrEmpty(value) ? "-" : value;
		}
	}
}
