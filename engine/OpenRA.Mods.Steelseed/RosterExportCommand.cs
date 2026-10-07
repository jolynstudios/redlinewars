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
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using OpenRA.GameRules;
using OpenRA.Mods.Common.HitShapes;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Warheads;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.Mods.Steelseed
{
	/// <summary>
	/// Emits the complete resolved actor roster in one deterministic JSON document.
	/// Simulation values come from ActorInfo and WeaponInfo so inherited values and
	/// RulesetLoaded references match the simulation. Resolved MiniYaml is read only to
	/// distinguish an absent weapon field from an explicitly authored default value.
	/// </summary>
	sealed class RosterExportCommand : IUtilityCommand
	{
		static readonly BitSet<TargetableType> AirTargetType = new("Air");

		string IUtilityCommand.Name => "--steelseed-roster";

		bool IUtilityCommand.ValidateArguments(string[] args) => args.Length == 1;

		[Desc("Dump every fully-resolved actor's visual/gameplay kernel as deterministic JSON.")]
		void IUtilityCommand.Run(Utility utility, string[] args)
		{
			// Several RulesetLoaded hooks assume this global is populated by the host.
			Game.ModData = utility.ModData;
			var rules = utility.ModData.DefaultRules;
			var actors = rules.Actors.Values
				.OrderBy(actor => actor.Name, StringComparer.Ordinal)
				.ToArray();
			var sourceWeapons = MiniYaml.Load(
				utility.ModData.DefaultFileSystem, utility.ModData.Manifest.Weapons, null)
				.ToDictionary(node => node.Key, node => node, StringComparer.OrdinalIgnoreCase);
			var weapons = ResolveReferencedWeapons(actors, rules, sourceWeapons);

			using var output = new MemoryStream();
			using (var writer = new Utf8JsonWriter(output, new JsonWriterOptions { Indented = true }))
			{
				writer.WriteStartObject();
				writer.WriteNumber("schemaVersion", 2);
				writer.WriteStartArray("actors");
				foreach (var actor in actors)
					WriteActor(writer, actor);

				writer.WriteEndArray();
				WriteWeapons(writer, weapons);
				writer.WriteEndObject();
			}

			Console.Write(Encoding.UTF8.GetString(output.GetBuffer(), 0, checked((int)output.Length)));
			Console.WriteLine();
		}

		static void WriteActor(Utf8JsonWriter writer, ActorInfo actor)
		{
			var building = SingleTrait<BuildingInfo>(actor);
			var hitShape = SingleTrait<HitShapeInfo>(actor);
			var health = SingleTrait<HealthInfo>(actor);
			var armor = SingleTrait<ArmorInfo>(actor);
			var mobile = SingleTrait<MobileInfo>(actor);
			var turrets = actor.TraitInfos<TurretedInfo>()
				.OrderBy(turret => turret.Turret, StringComparer.Ordinal)
				.ThenBy(turret => turret.InstanceName ?? string.Empty, StringComparer.Ordinal)
				.ToArray();
			var armaments = actor.TraitInfos<ArmamentInfo>()
				.OrderBy(armament => armament.InstanceName ?? string.Empty, StringComparer.Ordinal)
				.ThenBy(armament => armament.Name, StringComparer.Ordinal)
				.ThenBy(armament => armament.Weapon, StringComparer.Ordinal)
				.ToArray();
			var selectable = SingleTrait<SelectableInfo>(actor);
			var valued = SingleTrait<ValuedInfo>(actor);
			var power = SingleTrait<PowerInfo>(actor);
			var revealsShroud = SingleTrait<RevealsShroudInfo>(actor);
			var buildable = SingleTrait<BuildableInfo>(actor);

			writer.WriteStartObject();
			writer.WriteString("name", actor.Name);
			writer.WriteString("displayName", ActorDisplayName(actor));
			WriteResolvedTraits(writer, actor);
			WriteBuilding(writer, building);
			WriteBuildingRoles(writer, actor);
			WriteTargeting(writer, actor);
				WriteAircraft(writer, actor);
			WriteHitShape(writer, actor, hitShape);
			WriteHealth(writer, health);
			WriteArmor(writer, armor);
			WriteMobile(writer, mobile);
			WriteTurreted(writer, turrets.FirstOrDefault());
			WriteTurrets(writer, turrets);
			WriteArmaments(writer, armaments);
			WriteSelectable(writer, selectable);
			WriteValued(writer, valued);
			WritePower(writer, power);
			WriteRevealsShroud(writer, revealsShroud);
			WriteBuildable(writer, buildable);
			if (buildable == null)
				writer.WriteNull("BuildDuration");
			else
				writer.WriteNumber("BuildDuration", buildable.BuildDuration);

			writer.WriteEndObject();
		}

		static string ActorDisplayName(ActorInfo actor)
		{
			// Use the same fully-resolved TooltipInfo and Fluent bundle that OpenRA's own
			// production palette uses. This includes inherited names and specialized tooltip
			// implementations such as DisguiseTooltipInfo; the browser must never invent a
			// second alias like "3tnk" or "foundry_anvil" for a known actor.
			var tooltip = actor.TraitInfos<TooltipInfo>()
				.OrderByDescending(info => info.EnabledByDefault)
				.ThenBy(info => info.InstanceName ?? string.Empty, StringComparer.Ordinal)
				.FirstOrDefault();
			if (tooltip != null && FluentProvider.TryGetMessage(tooltip.Name, out var tooltipName))
				return tooltipName;

			var editorTooltip = actor.TraitInfos<EditorOnlyTooltipInfo>()
				.OrderByDescending(info => info.EnabledByDefault)
				.ThenBy(info => info.InstanceName ?? string.Empty, StringComparer.Ordinal)
				.FirstOrDefault();
			if (editorTooltip != null && FluentProvider.TryGetMessage(editorTooltip.Name, out var editorName))
				return editorName;

			// A few explicit system/proxy actors intentionally have no Tooltip trait, but the
			// upstream Fluent catalogue still gives them descriptive names. Keep those names
			// too so every exported actor has a readable audit/debug label.
			var actorKey = $"actor-{actor.Name.Replace('.', '-')}";
			if (FluentProvider.TryGetMessage($"{actorKey}-name", out var directName))
				return directName;
			if (FluentProvider.TryGetMessage($"{actorKey}.name", out var attributeName))
				return attributeName;

			return actor.Name.Replace('.', ' ').Replace('_', ' ');
		}

		static void WriteResolvedTraits(Utf8JsonWriter writer, ActorInfo actor)
		{
			writer.WriteStartArray("Traits");
			foreach (var trait in actor.TraitInfos<TraitInfo>()
				.OrderBy(trait => trait.GetType().Name, StringComparer.Ordinal)
				.ThenBy(trait => trait.InstanceName ?? string.Empty, StringComparer.Ordinal))
			{
				var type = trait.GetType().Name;
				if (type.EndsWith("Info", StringComparison.Ordinal))
					type = type[..^4];
				writer.WriteStartObject();
				writer.WriteString("Name", type);
				writer.WriteString("Instance", trait.InstanceName ?? string.Empty);
				writer.WriteStartObject("Fields");
				foreach (var field in FieldLoader.GetTypeLoadInfo(trait.GetType())
					.OrderBy(field => field.YamlName, StringComparer.Ordinal))
					writer.WriteString(field.YamlName, FieldSaver.FormatValue(trait, field.Field) ?? string.Empty);
				writer.WriteEndObject();
				writer.WriteEndObject();
			}
			writer.WriteEndArray();
		}

		static (string Name, WeaponInfo Info, MiniYaml Source)[] ResolveReferencedWeapons(
			IReadOnlyCollection<ActorInfo> actors,
			Ruleset rules,
			IReadOnlyDictionary<string, MiniYamlNode> sourceWeapons)
		{
			var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
			foreach (var armament in actors.SelectMany(actor => actor.TraitInfos<ArmamentInfo>()))
			{
				if (string.IsNullOrEmpty(armament.Weapon))
					throw new InvalidDataException("An Armament has no weapon name.");

				if (names.TryGetValue(armament.Weapon, out var existing))
				{
					if (!string.Equals(existing, armament.Weapon, StringComparison.Ordinal))
						throw new InvalidDataException(
							$"Weapon '{existing}' is also referenced as '{armament.Weapon}'; roster keys require one stable casing.");
				}
				else
					names.Add(armament.Weapon, armament.Weapon);
			}

			return names.Values
				.OrderBy(name => name, StringComparer.Ordinal)
				.Select(name =>
				{
					if (!rules.Weapons.TryGetValue(name.ToLowerInvariant(), out var info))
						throw new InvalidDataException($"Armament references unresolved weapon '{name}'.");
					if (!sourceWeapons.TryGetValue(name, out var source))
						throw new InvalidDataException($"Weapon '{name}' has no resolved source definition.");

					return (Name: name, Info: info, Source: source.Value);
				})
				.ToArray();
		}

		static T SingleTrait<T>(ActorInfo actor) where T : class, ITraitInfoInterface
		{
			// The compact compatibility summary keeps the first deterministic instance. ABI v2's
			// Traits array above remains the lossless source and carries every named/conditional
				// instance; the pinned upstream rules legitimately have several named trait instances.
			return actor.TraitInfos<T>()
				.OrderBy(trait => (trait as TraitInfo)?.InstanceName ?? string.Empty, StringComparer.Ordinal)
				.FirstOrDefault();
		}

		static void WriteBuilding(Utf8JsonWriter writer, BuildingInfo building)
		{
			writer.WritePropertyName("Building");
			if (building == null)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartObject();
			writer.WriteStartArray("Footprint");
			for (var y = 0; y < building.Dimensions.Y; y++)
			{
				var row = new StringBuilder(building.Dimensions.X);
				for (var x = 0; x < building.Dimensions.X; x++)
				{
					if (!building.Footprint.TryGetValue(new CVec(x, y), out var cell))
						throw new InvalidDataException($"Building footprint is missing cell {x},{y}.");

					row.Append((char)cell);
				}

				writer.WriteStringValue(row.ToString());
			}

			writer.WriteEndArray();
			writer.WritePropertyName("Dimensions");
			WriteCVec(writer, building.Dimensions);
			writer.WritePropertyName("LocalCenterOffset");
			WriteWVec(writer, building.LocalCenterOffset);
			writer.WriteEndObject();
		}

		// What a building DOES, and it took a rostergate collision to notice this was reporting
		// false for every structure in the mod.
		//
		// The two role flags here were reading traits NO STEELSEED STRUCTURE HAS.
		// `ProductionQueueInfo` lives on the PLAYER actor in OpenRA, not on the factory; the
		// building-side trait is `ProductionInfo` (`Production:` in yaml). And the mod stores
		// resources with `StoresResources:` — `StoresResourcesInfo` — while this checked
		// `StoresPlayerResourcesInfo`, a different class. So `lattice_extruder`, which produces
		// LatticeInfantry, and `lattice_reservoir`, which holds 5000 resources, exported as an
		// identical pair of falses and generated as the same building.
		//
		// Emitted as QUANTITIES rather than booleans, per §14.13a: the mod may describe an
		// actor's function more precisely, and "how much does it hold" is a better axis for a
		// generator than "does it hold anything". Both storage traits are read because either
		// is a legitimate way to author a silo.
		static void WriteBuildingRoles(Utf8JsonWriter writer, ActorInfo actor)
		{
			writer.WriteBoolean("Refinery", actor.TraitInfos<RefineryInfo>().Count != 0);
			writer.WriteNumber("Produces", actor.TraitInfos<ProductionInfo>().Count);
			writer.WriteNumber("Cargo", actor.TraitInfos<CargoInfo>().Sum(c => c.MaxWeight));
			var capacity = actor.TraitInfos<StoresResourcesInfo>().Sum(s => s.Capacity)
				+ actor.TraitInfos<StoresPlayerResourcesInfo>().Sum(s => s.Capacity);
			writer.WriteNumber("StorageCapacity", capacity);
		}

		static void WriteTargeting(Utf8JsonWriter writer, ActorInfo actor)
		{
			var targetsAir = actor.TraitInfos<AutoTargetPriorityInfo>()
				.Any(priority => priority.ValidTargets.Overlaps(AirTargetType));
			writer.WriteBoolean("TargetsAir", targetsAir);
		}

		// Whether the aircraft holds station under its own lift, i.e. a rotorcraft.
		//
		// The generator has been INFERRING this from the actor's bounding box — `isWing =
		// span / len >= WING_RATIO` — and the inference is wrong in both directions on the live
		// roster: foundry_flywheel is not VTOL and was drawn as a helicopter, while lattice_helix
		// is VTOL and was drawn as a fixed-wing plane. The proxy only looked plausible because
		// Foundry aircraft happen to be authored longer-than-wide and Lattice ones wider-than-
		// long, which is a coincidence of their selection boxes rather than a fact about the
		// machines.
		//
		// This is the same shape as the old "Burst > 1 means anti-air" proxy that `plant.ts`
		// records being wrong in both directions, and it has the same remedy: the mod states the
		// truth outright, so export it and stop guessing from a correlate.
		//
		// Absent for every non-aircraft, so the adapter can tell "not an aircraft" from
		// "an aircraft that cannot hover" rather than reading a default as a fact.
		static void WriteAircraft(Utf8JsonWriter writer, ActorInfo actor)
		{
			var aircraft = actor.TraitInfoOrDefault<AircraftInfo>();
			if (aircraft == null)
				return;

			writer.WritePropertyName("Aircraft");
			writer.WriteStartObject();
			writer.WriteBoolean("VTOL", aircraft.VTOL);
			writer.WriteBoolean("CanHover", aircraft.CanHover);
			writer.WriteEndObject();
		}

		static void WriteHitShape(Utf8JsonWriter writer, ActorInfo actor, HitShapeInfo hitShape)
		{
			writer.WritePropertyName("HitShape");
			if (hitShape == null)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartObject();
			switch (hitShape.Type)
			{
				case CircleShape circle:
					writer.WriteString("Type", "Circle");
					writer.WriteNumber("Radius", circle.Radius.Length);
					WriteVerticalOffsets(writer, circle.VerticalTopOffset, circle.VerticalBottomOffset);
					break;

				case CapsuleShape capsule:
					writer.WriteString("Type", "Capsule");
					writer.WritePropertyName("PointA");
					WriteInt2(writer, capsule.PointA);
					writer.WritePropertyName("PointB");
					WriteInt2(writer, capsule.PointB);
					writer.WriteNumber("Radius", capsule.Radius.Length);
					WriteVerticalOffsets(writer, capsule.VerticalTopOffset, capsule.VerticalBottomOffset);
					break;

				case PolygonShape polygon:
					writer.WriteString("Type", "Polygon");
					writer.WriteStartArray("Points");
					foreach (var point in polygon.Points)
						WriteInt2(writer, point);

					writer.WriteEndArray();
					WriteVerticalOffsets(writer, polygon.VerticalTopOffset, polygon.VerticalBottomOffset);
					writer.WriteNumber("LocalYaw", polygon.LocalYaw.Angle);
					break;

				case RectangleShape rectangle:
					writer.WriteString("Type", "Rectangle");
					writer.WritePropertyName("TopLeft");
					WriteInt2(writer, rectangle.TopLeft);
					writer.WritePropertyName("BottomRight");
					WriteInt2(writer, rectangle.BottomRight);
					WriteVerticalOffsets(writer, rectangle.VerticalTopOffset, rectangle.VerticalBottomOffset);
					writer.WriteNumber("LocalYaw", rectangle.LocalYaw.Angle);
					break;

				default:
					throw new InvalidDataException(
						$"Actor '{actor.Name}' uses unsupported hit shape '{hitShape.Type?.GetType().FullName ?? "null"}'.");
			}

			writer.WriteEndObject();
		}

		static void WriteVerticalOffsets(Utf8JsonWriter writer, int top, int bottom)
		{
			writer.WriteNumber("VerticalTopOffset", top);
			writer.WriteNumber("VerticalBottomOffset", bottom);
		}

		static void WriteHealth(Utf8JsonWriter writer, HealthInfo health)
		{
			writer.WritePropertyName("Health");
			if (health == null)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartObject();
			writer.WriteNumber("HP", health.HP);
			writer.WriteEndObject();
		}

		static void WriteArmor(Utf8JsonWriter writer, ArmorInfo armor)
		{
			writer.WritePropertyName("Armor");
			if (armor == null)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartObject();
			writer.WriteString("Type", armor.Type);
			writer.WriteEndObject();
		}

		static void WriteMobile(Utf8JsonWriter writer, MobileInfo mobile)
		{
			writer.WritePropertyName("Mobile");
			if (mobile == null)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartObject();
			writer.WriteNumber("Speed", mobile.Speed);
			writer.WriteString("Locomotor", mobile.Locomotor);
			writer.WriteEndObject();
		}

		static void WriteTurreted(Utf8JsonWriter writer, TurretedInfo turreted)
		{
			writer.WritePropertyName("Turreted");
			if (turreted == null)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartObject();
			writer.WriteString("Name", turreted.Turret);
			writer.WriteNumber("TurnSpeed", turreted.TurnSpeed.Angle);
			writer.WriteNumber("InitialFacing", turreted.InitialFacing.Angle);
			writer.WriteNumber("RealignDelay", turreted.RealignDelay);
			writer.WritePropertyName("Offset");
			WriteWVec(writer, turreted.Offset);
			writer.WriteEndObject();
		}

		static void WriteTurrets(Utf8JsonWriter writer, IReadOnlyCollection<TurretedInfo> turrets)
		{
			writer.WriteStartArray("Turrets");
			foreach (var turret in turrets)
			{
				writer.WriteStartObject();
				writer.WriteString("Name", turret.Turret);
				writer.WriteString("Instance", turret.InstanceName ?? string.Empty);
				writer.WriteNumber("TurnSpeed", turret.TurnSpeed.Angle);
				writer.WriteNumber("InitialFacing", turret.InitialFacing.Angle);
				writer.WriteNumber("RealignDelay", turret.RealignDelay);
				writer.WritePropertyName("Offset");
				WriteWVec(writer, turret.Offset);
				writer.WriteEndObject();
			}
			writer.WriteEndArray();
		}

		static void WriteArmaments(Utf8JsonWriter writer, IReadOnlyCollection<ArmamentInfo> armaments)
		{
			writer.WritePropertyName("Armament");
			if (armaments.Count == 0)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartArray();
			foreach (var armament in armaments)
			{
				writer.WriteStartObject();
				writer.WriteString("Name", armament.Name);
				writer.WriteString("Instance", armament.InstanceName ?? string.Empty);
				writer.WriteString("Turret", armament.Turret);
				writer.WriteString("Weapon", armament.Weapon);
				writer.WriteStartArray("LocalOffset");
				foreach (var offset in armament.LocalOffset)
					WriteWVec(writer, offset);

				writer.WriteEndArray();
				writer.WriteNumber("Recoil", armament.Recoil.Length);
				writer.WriteNumber("Burst", armament.WeaponInfo.Burst);
				writer.WriteEndObject();
			}

			writer.WriteEndArray();
		}

		static void WriteWeapons(
			Utf8JsonWriter writer,
			IReadOnlyCollection<(string Name, WeaponInfo Info, MiniYaml Source)> weapons)
		{
			writer.WriteStartObject("weapons");
			foreach (var weapon in weapons)
			{
				writer.WriteStartObject(weapon.Name);
				writer.WriteNumber("Range", weapon.Info.Range.Length);
				writer.WriteNumber("MinRange", weapon.Info.MinRange.Length);
				writer.WriteNumber("ReloadDelay", weapon.Info.ReloadDelay);
				writer.WriteNumber("Burst", weapon.Info.Burst);
				writer.WriteStartArray("BurstDelays");
				foreach (var delay in weapon.Info.BurstDelays)
					writer.WriteNumberValue(delay);
				writer.WriteEndArray();

				var projectile = weapon.Source.NodeWithKeyOrDefault("Projectile");
				if (projectile == null)
					writer.WriteNull("Projectile");
				else
					writer.WriteString("Projectile", projectile.Value.Value);
				writer.WriteString("ResolvedProjectile", weapon.Info.Projectile?.GetType().Name ?? string.Empty);

				WriteWarheads(writer, weapon.Name, weapon.Info, weapon.Source);
				writer.WriteEndObject();
			}

			writer.WriteEndObject();
		}

		static void WriteOptionalNumber(Utf8JsonWriter writer, string property, MiniYamlNode source, int value)
		{
			if (source == null)
				writer.WriteNull(property);
			else
				writer.WriteNumber(property, value);
		}

		static void WriteWarheads(Utf8JsonWriter writer, string weaponName, WeaponInfo weapon, MiniYaml source)
		{
			var sourceWarheads = source.Nodes
				.Where(node => node.Key.StartsWith("Warhead", StringComparison.Ordinal))
				.ToArray();
			if (sourceWarheads.Length != weapon.Warheads.Length)
				throw new InvalidDataException(
					$"Weapon '{weaponName}' resolved {weapon.Warheads.Length} warheads from {sourceWarheads.Length} source nodes.");

			writer.WriteStartArray("Warheads");
			for (var i = 0; i < weapon.Warheads.Length; i++)
			{
				if (weapon.Warheads[i] is not DamageWarhead damage)
					continue;

				var damageSource = sourceWarheads[i].Value;
				writer.WriteStartObject();
				writer.WriteNumber("Damage", damage.Damage);

				if (damageSource.NodeWithKeyOrDefault("Spread") == null)
					writer.WriteNull("Spread");
				else
					writer.WriteNumber("Spread", DamageSpread(weaponName, damage));

				writer.WriteStartObject("Versus");
				foreach (var versus in damage.Versus.OrderBy(entry => entry.Key, StringComparer.Ordinal))
					writer.WriteNumber(versus.Key, versus.Value);
				writer.WriteEndObject();

				writer.WriteEndObject();
			}

			writer.WriteEndArray();
		}

		static int DamageSpread(string weaponName, DamageWarhead damage)
		{
			return damage switch
			{
				SpreadDamageWarhead spread => spread.Spread.Length,
				TargetDamageWarhead target => target.Spread.Length,
				_ => throw new InvalidDataException(
					$"Weapon '{weaponName}' authors Spread on unsupported damage warhead '{damage.GetType().Name}'.")
			};
		}

		static void WriteSelectable(Utf8JsonWriter writer, SelectableInfo selectable)
		{
			writer.WritePropertyName("Selectable");
			if (selectable == null)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartObject();
			writer.WritePropertyName("Bounds");
			WriteWDistArray(writer, selectable.Bounds);
			writer.WritePropertyName("DecorationBounds");
			WriteWDistArray(writer, selectable.DecorationBounds);
			writer.WriteEndObject();
		}

		static void WriteValued(Utf8JsonWriter writer, ValuedInfo valued)
		{
			writer.WritePropertyName("Valued");
			if (valued == null)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartObject();
			writer.WriteNumber("Cost", valued.Cost);
			writer.WriteEndObject();
		}

		static void WritePower(Utf8JsonWriter writer, PowerInfo power)
		{
			writer.WritePropertyName("Power");
			if (power == null)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartObject();
			writer.WriteNumber("Amount", power.Amount);
			writer.WriteEndObject();
		}

		static void WriteRevealsShroud(Utf8JsonWriter writer, RevealsShroudInfo revealsShroud)
		{
			writer.WritePropertyName("RevealsShroud");
			if (revealsShroud == null)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartObject();
			writer.WriteNumber("Range", revealsShroud.Range.Length);
			writer.WriteEndObject();
		}

		static void WriteBuildable(Utf8JsonWriter writer, BuildableInfo buildable)
		{
			writer.WritePropertyName("Buildable");
			if (buildable == null)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartObject();
			writer.WriteStartArray("Queue");
			foreach (var queue in buildable.Queue.OrderBy(queue => queue, StringComparer.Ordinal))
				writer.WriteStringValue(queue);

			writer.WriteEndArray();
			writer.WriteStartArray("Prerequisites");
			foreach (var prerequisite in buildable.Prerequisites.OrderBy(prerequisite => prerequisite, StringComparer.Ordinal))
				writer.WriteStringValue(prerequisite);

			writer.WriteEndArray();
			writer.WriteString("ForceFaction", buildable.ForceFaction ?? string.Empty);
			writer.WriteEndObject();
		}

		static void WriteWDistArray(Utf8JsonWriter writer, ImmutableArray<WDist> values)
		{
			if (values.IsDefault)
			{
				writer.WriteNullValue();
				return;
			}

			writer.WriteStartArray();
			foreach (var value in values)
				writer.WriteNumberValue(value.Length);

			writer.WriteEndArray();
		}

		static void WriteCVec(Utf8JsonWriter writer, CVec value)
		{
			writer.WriteStartArray();
			writer.WriteNumberValue(value.X);
			writer.WriteNumberValue(value.Y);
			writer.WriteEndArray();
		}

		static void WriteInt2(Utf8JsonWriter writer, int2 value)
		{
			writer.WriteStartArray();
			writer.WriteNumberValue(value.X);
			writer.WriteNumberValue(value.Y);
			writer.WriteEndArray();
		}

		static void WriteWVec(Utf8JsonWriter writer, WVec value)
		{
			writer.WriteStartArray();
			writer.WriteNumberValue(value.X);
			writer.WriteNumberValue(value.Y);
			writer.WriteNumberValue(value.Z);
			writer.WriteEndArray();
		}
	}
}
