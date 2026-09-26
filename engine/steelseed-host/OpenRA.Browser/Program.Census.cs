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
using System.IO;
using System.Linq;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using OpenRA.FileSystem;
using OpenRA.GameRules;
using OpenRA.Traits;

namespace OpenRA
{
	[SupportedOSPlatform("browser")]
	public static partial class Program
	{
		const int RulesCensusSchemaVersion = 1;

		/// <summary>
		/// The rules the game actually runs, resolved by this engine, for the VFX census (vfx.md
		/// Epic 1). Every actor with every trait info and its loaded fields, and every weapon with
		/// its projectile and warheads, all through FieldSaver: the values FieldLoader read,
		/// after inheritance and removals. Per map, the placed actors and, for a map that defines
		/// its own rules, every actor or weapon whose resolved form differs from the defaults.
		///
		/// Read-only and off the simulation path. The game never calls it; web/tools/vfxcensus.mjs
		/// does, in a Node-hosted runtime.
		/// </summary>
		[JSExport]
		internal static string GetRulesCensus()
		{
			try
			{
				var modData = Game.ModData;
				if (modData == null)
					return ErrorJson("not-initialized", "The Red Alert runtime is not initialized.");

				var defaults = modData.DefaultRules;
				using var stream = new MemoryStream();
				using (var json = new Utf8JsonWriter(stream))
				{
					json.WriteStartObject();
					json.WriteNumber("schemaVersion", RulesCensusSchemaVersion);
					json.WriteString("engine", "7eabcfe1c9fc3ad5f510227496cfc2766c07f5fb");
					json.WritePropertyName("actors");
					json.WriteStartObject();
					foreach (var actor in defaults.Actors.Values.OrderBy(a => a.Name, StringComparer.Ordinal))
					{
						json.WritePropertyName(actor.Name);
						WriteCensusActor(json, actor);
					}

					json.WriteEndObject();
					json.WritePropertyName("weapons");
					json.WriteStartObject();
					foreach (var pair in defaults.Weapons.OrderBy(p => p.Key, StringComparer.Ordinal))
					{
						json.WritePropertyName(pair.Key);
						WriteCensusWeapon(json, pair.Value);
					}

					json.WriteEndObject();
					json.WritePropertyName("maps");
					json.WriteStartArray();
					foreach (var map in modData.MapCache
						.Where(m => m.Status == MapStatus.Available)
						.OrderBy(m => m.Title, StringComparer.Ordinal)
						.ThenBy(m => m.Uid, StringComparer.Ordinal))
						WriteCensusMap(json, defaults, map);

					json.WriteEndArray();
					json.WriteEndObject();
				}

				return Encoding.UTF8.GetString(stream.ToArray());
			}
			catch (Exception e)
			{
				return ErrorJson("census-failed", $"Could not export the rules census: {e.Message}");
			}
		}

		static void WriteCensusActor(Utf8JsonWriter json, ActorInfo actor)
		{
			json.WriteStartArray();
			foreach (var trait in actor.TraitInfos<TraitInfo>())
				WriteCensusObject(json, trait, trait.InstanceName);

			json.WriteEndArray();
		}

		static void WriteCensusWeapon(Utf8JsonWriter json, WeaponInfo weapon)
		{
			json.WriteStartObject();
			json.WritePropertyName("fields");
			WriteCensusFields(json, weapon);
			json.WritePropertyName("projectile");
			if (weapon.Projectile == null)
				json.WriteNullValue();
			else
				WriteCensusObject(json, weapon.Projectile, null);

			json.WritePropertyName("warheads");
			json.WriteStartArray();
			foreach (var warhead in weapon.Warheads)
				WriteCensusObject(json, warhead, null);

			json.WriteEndArray();
			json.WriteEndObject();
		}

		/// <summary>{ type, instance?, fields }. The type drops OpenRA's "Info" suffix.</summary>
		static void WriteCensusObject(Utf8JsonWriter json, object value, string instance)
		{
			var type = value.GetType().Name;
			if (type.EndsWith("Info", StringComparison.Ordinal))
				type = type[..^4];

			json.WriteStartObject();
			json.WriteString("type", type);
			if (!string.IsNullOrEmpty(instance))
				json.WriteString("instance", instance);

			json.WritePropertyName("fields");
			WriteCensusFields(json, value);
			json.WriteEndObject();
		}

		static void WriteCensusFields(Utf8JsonWriter json, object value)
		{
			MiniYaml saved;
			try
			{
				saved = FieldSaver.Save(value);
			}
			catch (Exception e)
			{
				json.WriteStartObject();
				json.WriteString("$error", e.Message);
				json.WriteEndObject();
				return;
			}

			WriteCensusYaml(json, saved);
		}

		static void WriteCensusYaml(Utf8JsonWriter json, MiniYaml yaml)
		{
			json.WriteStartObject();
			foreach (var node in yaml.Nodes)
			{
				if (node.Value.Nodes.Length > 0)
				{
					json.WritePropertyName(node.Key);
					WriteCensusYaml(json, node.Value);
				}
				else
					json.WriteString(node.Key, node.Value.Value ?? "");
			}

			json.WriteEndObject();
		}

		static void WriteCensusMap(Utf8JsonWriter json, Ruleset defaults, MapPreview map)
		{
			json.WriteStartObject();
			json.WriteString("uid", map.Uid);
			json.WriteString("title", map.Title);
			json.WritePropertyName("placed");
			json.WriteStartObject();
			foreach (var placed in PlacedActors(map).OrderBy(p => p.Key, StringComparer.Ordinal))
			{
				json.WritePropertyName(placed.Key);
				json.WriteStartObject();
				foreach (var owner in placed.Value.OrderBy(o => o.Key, StringComparer.Ordinal))
					json.WriteNumber(owner.Key, owner.Value);

				json.WriteEndObject();
			}

			json.WriteEndObject();

			var customRules = DefinesRules(map.RuleDefinitions) || DefinesRules(map.WeaponDefinitions);
			json.WriteBoolean("customRules", customRules);
			if (customRules)
			{
				var rules = map.LoadRuleset();
				json.WritePropertyName("actorOverrides");
				json.WriteStartObject();
				foreach (var actor in rules.Actors.Values.OrderBy(a => a.Name, StringComparer.Ordinal))
				{
					if (defaults.Actors.TryGetValue(actor.Name, out var standard) &&
						CensusSignature(w => WriteCensusActor(w, actor)) == CensusSignature(w => WriteCensusActor(w, standard)))
						continue;

					json.WritePropertyName(actor.Name);
					WriteCensusActor(json, actor);
				}

				json.WriteEndObject();
				json.WritePropertyName("weaponOverrides");
				json.WriteStartObject();
				foreach (var pair in rules.Weapons.OrderBy(p => p.Key, StringComparer.Ordinal))
				{
					if (defaults.Weapons.TryGetValue(pair.Key, out var standard) &&
						CensusSignature(w => WriteCensusWeapon(w, pair.Value)) == CensusSignature(w => WriteCensusWeapon(w, standard)))
						continue;

					json.WritePropertyName(pair.Key);
					WriteCensusWeapon(json, pair.Value);
				}

				json.WriteEndObject();
			}

			json.WriteEndObject();
		}

		static bool DefinesRules(MiniYaml section) => section != null && (section.Value != null || section.Nodes.Length > 0);

		static string CensusSignature(Action<Utf8JsonWriter> write)
		{
			using var stream = new MemoryStream();
			using (var json = new Utf8JsonWriter(stream))
				write(json);

			return Encoding.UTF8.GetString(stream.ToArray());
		}

		/// <summary>Actor type → owner → count, read from the map's own map.yaml.</summary>
		static Dictionary<string, Dictionary<string, int>> PlacedActors(MapPreview map)
		{
			var placed = new Dictionary<string, Dictionary<string, int>>();
			using var stream = ((IReadOnlyFileSystem)map).Open("map.yaml");
			var actors = MiniYaml.FromStream(stream, "map.yaml").FirstOrDefault(n => n.Key == "Actors");
			if (actors == null)
				return placed;

			foreach (var node in actors.Value.Nodes)
			{
				var type = node.Value.Value;
				if (string.IsNullOrEmpty(type))
					continue;

				var owner = node.Value.Nodes.FirstOrDefault(n => n.Key == "Owner")?.Value.Value ?? "";
				if (!placed.TryGetValue(type, out var owners))
					placed[type] = owners = new Dictionary<string, int>();

				owners[owner] = owners.GetValueOrDefault(owner) + 1;
			}

			return placed;
		}
	}
}
