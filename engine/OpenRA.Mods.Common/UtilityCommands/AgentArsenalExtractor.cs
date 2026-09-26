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
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using OpenRA.FileSystem;
using OpenRA.GameRules;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Warheads;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.Mods.Common.UtilityCommands
{
	static class AgentArsenalExtractor
	{
		const int MaxActors = 128;
		const int MaxArmaments = 256;
		const int MaxCounterEdges = 4096;
		const int MaxSourceRefs = 2048;
		const int MaxSourceRefsPerObject = 5;
		const int MaxWeaponSourceRefsPerArmament = 16;
		const int MaxTargetConditionVariables = 8;
		const int MaxArtifactBytes = 256 * 1024;
		static readonly string[] ArmorOrder = ["none", "wood", "light", "heavy", "concrete"];
		static readonly HashSet<string> ActorSourceTraits = new(StringComparer.OrdinalIgnoreCase)
		{
			"Buildable", "Valued", "Power", "Health", "Armor", "Mobile", "Aircraft", "Targetable",
			"Crushable", "Building", "RequiresBuildableArea", "BaseProvider", "AmmoPool", "Armament"
		};
		static readonly HashSet<string> WeaponSourceFields = new(StringComparer.OrdinalIgnoreCase)
		{
			"Inherits", "Range", "MinRange", "ReloadDelay", "Burst", "BurstDelays", "ValidTargets", "InvalidTargets"
		};
		static readonly JsonSerializerOptions JsonOptions = new()
		{
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
			DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
		};

		public static string Extract(ModData modData)
		{
			var manifest = modData.Manifest;
			var sourceFiles = ReadSourceFiles(modData, manifest.Rules, manifest.Weapons);
			var sourceOrdinals = sourceFiles
				.Select((source, index) => (source.Path, index))
				.ToDictionary(x => x.Path, x => x.index, StringComparer.Ordinal);
			var resolvedActors = MiniYaml.Load(modData.DefaultFileSystem, manifest.Rules, null)
				.ToDictionary(n => n.Key, StringComparer.OrdinalIgnoreCase);
			var sourceWeapons = LoadSourceDefinitions(modData.DefaultFileSystem, manifest.Weapons);
			var sourceRefs = new SourceRefIndex(sourceOrdinals);

			var actors = modData.DefaultRules.Actors.Values
				.Where(a => !a.Name.StartsWith(ActorInfo.AbstractActorPrefix) && a.HasTraitInfo<BuildableInfo>())
				.OrderBy(a => a.Name, StringComparer.Ordinal)
				.Select(a => ExtractActor(a, resolvedActors.GetValueOrDefault(a.Name), sourceRefs))
				.ToArray();
			var actorArmamentCount = actors.Sum(a => a.Armaments.Length);
			if (actors.Length > MaxActors || actorArmamentCount > MaxArmaments)
				throw new InvalidDataException($"Agent arsenal exceeds bounds: {actors.Length} actors, {actorArmamentCount} armaments.");

			foreach (var actor in actors)
			{
				foreach (var armament in actor.Armaments)
				{
					if (sourceWeapons.TryGetValue(armament.WeaponId, out var weaponNode))
						armament.AddWeaponSourceLocations(RelevantWeaponSourceLocations(weaponNode), sourceRefs);
				}
			}

			var targetProfiles = ExtractTargetProfiles(actors);
			var edges = ExtractCounterEdges(actors, targetProfiles);
			if (edges.Length > MaxCounterEdges)
				throw new InvalidDataException($"Agent arsenal exceeds bound of {MaxCounterEdges} counter edges.");

			var queues = ExtractProductionQueues(modData.DefaultRules, sourceRefs, resolvedActors);
			var resources = ExtractResourceValues(modData.DefaultRules);
			sourceRefs.FinalizeReferences(actors, queues);
			if (sourceRefs.Count > MaxSourceRefs)
				throw new InvalidDataException($"Agent arsenal has {sourceRefs.Count} source references, exceeding bound of {MaxSourceRefs}.");

			var artifact = new ArsenalArtifact
			{
				SchemaVersion = 1,
				ModId = manifest.Id,
				ActorScope = "buildable-default-rules",
				RulesHash = RulesHash(sourceFiles),
				ArtifactHash = string.Empty,
				ArmorOrder = ArmorOrder,
				SourceFiles = sourceFiles,
				SourceRefs = sourceRefs.References,
				Globals = new ArsenalGlobals { ProductionQueues = queues, ResourceValues = resources },
				Actors = actors,
				TargetProfiles = targetProfiles,
				TargetStateModel = "boolean-condition-enumerated possible enabled-type unions",
				CounterGraphEpistemic = "derived-comparison",
				CounterEdgeRateFormula = "peakDamagePerSalvo * 100 / armament.cycleTicks",
				CounterEdges = edges
			};

			var canonical = JsonSerializer.Serialize(artifact, JsonOptions);
			artifact.ArtifactHash = Sha256(Encoding.UTF8.GetBytes(canonical));
			var json = JsonSerializer.Serialize(artifact, JsonOptions);
			var artifactBytes = Encoding.UTF8.GetByteCount(json);
			if (artifactBytes > MaxArtifactBytes)
				throw new InvalidDataException($"Agent arsenal has {artifactBytes} bytes, exceeding bound of {MaxArtifactBytes}.");

			return json;
		}

		static SourceFile[] ReadSourceFiles(ModData modData, IEnumerable<string> ruleFiles, IEnumerable<string> weaponFiles)
		{
			return ruleFiles.Select(path => ReadSourceFile(modData, "rules", path))
				.Concat(weaponFiles.Select(path => ReadSourceFile(modData, "weapons", path)))
				.ToArray();
		}

		static IReadOnlyDictionary<string, MiniYamlNode> LoadSourceDefinitions(IReadOnlyFileSystem fileSystem,
			IEnumerable<string> files)
		{
			var definitions = new Dictionary<string, MiniYamlNode>(StringComparer.OrdinalIgnoreCase);
			foreach (var path in files)
			{
				using var stream = fileSystem.Open(path);
				foreach (var node in MiniYaml.FromStream(stream, path))
					definitions[node.Key] = node;
			}

			return definitions;
		}

		static SourceFile ReadSourceFile(ModData modData, string category, string path)
		{
			using var stream = modData.DefaultFileSystem.Open(path);
			using var output = new MemoryStream();
			stream.CopyTo(output);
			var bytes = output.ToArray();
			return new SourceFile
			{
				Category = category,
				Path = path,
				ByteLength = bytes.Length,
				Sha256 = Sha256(bytes),
				Bytes = bytes
			};
		}

		static string RulesHash(IEnumerable<SourceFile> sources)
		{
			using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
			hash.AppendData(Encoding.UTF8.GetBytes("openra-agent-rules-v1\0"));
			foreach (var source in sources)
			{
				hash.AppendData(Encoding.UTF8.GetBytes($"{source.Category}\0{source.Path}\0{source.ByteLength.ToString(CultureInfo.InvariantCulture)}\0"));
				hash.AppendData(source.Bytes);
			}

			return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
		}

		static ActorArsenal ExtractActor(ActorInfo actor, MiniYamlNode actorNode, SourceRefIndex sourceRefs)
		{
			var buildable = actor.TraitInfo<BuildableInfo>();
			var tooltip = actor.TraitInfos<TooltipInfo>().FirstOrDefault(t => t.EnabledByDefault);
			var displayName = tooltip == null ? actor.Name : FluentProvider.GetMessage(tooltip.Name);
			var mobile = actor.TraitInfos<MobileInfo>().FirstOrDefault(m => m.EnabledByDefault);
			var aircraft = actor.TraitInfos<AircraftInfo>().FirstOrDefault(a => a.EnabledByDefault);
			var armor = actor.TraitInfos<ArmorInfo>().FirstOrDefault(a => a.EnabledByDefault)?.Type ?? "none";
			var targetTypeSets = ExtractTargetTypeStates(actor);
			var targetTypes = targetTypeSets.SelectMany(t => t)
				.Distinct(StringComparer.OrdinalIgnoreCase)
				.OrderBy(t => t, StringComparer.Ordinal)
				.ToArray();
			var crushable = actor.TraitInfos<CrushableInfo>().FirstOrDefault(c => c.EnabledByDefault);
			var building = actor.TraitInfoOrDefault<BuildingInfo>();
			var requiresArea = actor.TraitInfoOrDefault<RequiresBuildableAreaInfo>();
			var baseProvider = actor.TraitInfos<BaseProviderInfo>().FirstOrDefault(b => b.EnabledByDefault);
			var prerequisites = buildable.Prerequisites.Order(StringComparer.Ordinal).ToArray();
			var actorSources = RelevantActorSourceLocations(actorNode).ToArray();

			var result = new ActorArsenal
			{
				Id = actor.Name,
				DisplayName = Clean(displayName),
				Availability = prerequisites.Contains("~disabled") ? "disabled" : prerequisites.Contains("~bio") ? "conditional" : "standard",
				Queues = buildable.Queue.Order(StringComparer.Ordinal).ToArray(),
				BuildAtProductionType = buildable.BuildAtProductionType,
				Prerequisites = prerequisites,
				Cost = actor.TraitInfoOrDefault<ValuedInfo>()?.Cost ?? 0,
				BaseBuildTicks = Util.ApplyPercentageModifiers(
					buildable.BuildDuration < 0 ? actor.TraitInfoOrDefault<ValuedInfo>()?.Cost ?? 0 : buildable.BuildDuration,
					[buildable.BuildDurationModifier]),
				Power = actor.TraitInfos<PowerInfo>().Where(p => p.EnabledByDefault).Sum(p => p.Amount),
				Hp = actor.TraitInfoOrDefault<HealthInfo>()?.HP ?? 0,
				Armor = armor.ToLowerInvariant(),
				TargetTypes = targetTypes,
				TargetTypeSets = targetTypeSets,
				Movement = ExtractMovement(mobile, aircraft),
				Crushable = crushable == null ? null : new CrushableData
				{
					Classes = crushable.CrushClasses.Order(StringComparer.Ordinal).ToArray(),
					WarnProbabilityPct = crushable.WarnProbability
				},
				Placement = building == null ? null : new PlacementData
				{
					AdjacentCells = requiresArea?.Adjacent,
					RequiresBaseProvider = building.RequiresBaseProvider,
					BaseProviderRange1024 = baseProvider?.Range.Length
				},
				AmmoPools = actor.TraitInfos<AmmoPoolInfo>()
					.OrderBy(a => a.Name, StringComparer.Ordinal)
					.Select(a => new AmmoPoolData
					{
						Name = a.Name,
						Armaments = a.Armaments.Order(StringComparer.Ordinal).ToArray(),
						Capacity = a.Ammo,
						InitialAmmo = a.InitialAmmo < 0 ? a.Ammo : a.InitialAmmo,
						ReloadCount = a.ReloadCount,
						ReloadDelayTicks = a.ReloadDelay
					}).ToArray(),
				Armaments = actor.TraitInfos<ArmamentInfo>()
					.Where(a => a.EnabledByDefault && a.WeaponInfo != null)
					.OrderBy(a => a.InstanceName ?? string.Empty, StringComparer.Ordinal)
					.ThenBy(a => a.Name, StringComparer.Ordinal)
					.ThenBy(a => a.Weapon, StringComparer.Ordinal)
					.Select(a => ExtractArmament(actor.Name, a, actorNode, sourceRefs))
					.ToArray()
			};
			result.AddSourceLocations(actorSources, sourceRefs);
			return result;
		}

		static MovementData ExtractMovement(MobileInfo mobile, AircraftInfo aircraft)
		{
			if (aircraft != null)
				return new MovementData
				{
					Domain = "air",
					Speed = aircraft.Speed,
					Crushes = aircraft.Crushes.Order(StringComparer.Ordinal).ToArray()
				};

			if (mobile == null)
				return null;

			var locomotor = mobile.Locomotor;
			var domain = locomotor.Equals("naval", StringComparison.OrdinalIgnoreCase) ? "water" :
				locomotor.Equals("lcraft", StringComparison.OrdinalIgnoreCase) ? "amphibious" : "ground";
			return new MovementData
			{
				Domain = domain,
				Locomotor = locomotor,
				Speed = mobile.Speed,
				Crushes = mobile.LocomotorInfo.Crushes.Order(StringComparer.Ordinal).ToArray()
			};
		}

		static string[][] ExtractTargetTypeStates(ActorInfo actor)
		{
			var targetables = actor.TraitInfos<TargetableInfo>().ToArray();
			var variables = targetables.Where(t => t.RequiresCondition != null)
				.SelectMany(t => t.RequiresCondition.Variables)
				.Distinct(StringComparer.Ordinal)
				.Order(StringComparer.Ordinal)
				.ToArray();
			if (variables.Length > MaxTargetConditionVariables)
				throw new InvalidDataException($"Actor '{actor.Name}' target-state model has {variables.Length} condition variables.");

			var states = new Dictionary<string, string[]>(StringComparer.Ordinal);
			for (var mask = 0; mask < 1 << variables.Length; mask++)
			{
				var conditions = variables.Select((variable, index) => (variable, value: (mask >> index) & 1))
					.ToDictionary(x => x.variable, x => x.value, StringComparer.Ordinal);
				var types = targetables
					.Where(t => t.RequiresCondition == null || t.RequiresCondition.Evaluate(conditions))
					.SelectMany(t => t.TargetTypes)
					.Distinct(StringComparer.OrdinalIgnoreCase)
					.Order(StringComparer.Ordinal)
					.ToArray();
				if (types.Length > 0)
					states.TryAdd(string.Join(",", types), types);
			}

			return states.OrderBy(state => state.Key, StringComparer.Ordinal).Select(state => state.Value).ToArray();
		}

		static ArmamentData ExtractArmament(string actorId, ArmamentInfo armament, MiniYamlNode actorNode, SourceRefIndex sourceRefs)
		{
			var instance = string.IsNullOrEmpty(armament.InstanceName) ? armament.Name : armament.InstanceName;
			var actorTraitKey = string.IsNullOrEmpty(armament.InstanceName) ? "Armament" : $"Armament@{armament.InstanceName}";
			var armamentNode = actorNode?.Value.Nodes.FirstOrDefault(n => string.Equals(n.Key, actorTraitKey, StringComparison.OrdinalIgnoreCase));
			var weapon = armament.WeaponInfo;
			var result = new ArmamentData
			{
				Id = $"{actorId}:{instance.ToLowerInvariant()}",
				ActorId = actorId,
				InstanceName = instance,
				WeaponId = armament.Weapon,
				MinRange1024 = weapon.MinRange.Length,
				MaxRange1024 = armament.ModifiedRange.Length,
				ReloadTicks = weapon.ReloadDelay,
				Burst = weapon.Burst,
				BurstDelays = weapon.BurstDelays.ToArray(),
				CycleTicks = weapon.ReloadDelay + BurstDelayTotal(weapon),
				ValidTargets = weapon.ValidTargets.Order(StringComparer.Ordinal).ToArray(),
				InvalidTargets = weapon.InvalidTargets.Order(StringComparer.Ordinal).ToArray(),
				DamageWarheads = weapon.Warheads.OfType<DamageWarhead>()
					.Select(ExtractDamageWarhead)
					.ToArray()
			};
			result.AddSourceLocations(SourceLocations(armamentNode), sourceRefs);
			return result;
		}

		static DamageWarheadData ExtractDamageWarhead(DamageWarhead warhead)
		{
			var spread = warhead as SpreadDamageWarhead;
			return new DamageWarheadData
			{
				Damage = warhead.Damage,
				DelayTicks = warhead.Delay,
				ValidTargets = warhead.ValidTargets.Order(StringComparer.Ordinal).ToArray(),
				InvalidTargets = warhead.InvalidTargets.Order(StringComparer.Ordinal).ToArray(),
				EnemyValid = warhead.ValidRelationships.HasRelationship(PlayerRelationship.Enemy),
				VersusPct = ArmorOrder.Select(a => VersusPercent(warhead, a)).ToArray(),
				FalloffPct = spread?.Falloff.ToArray(),
				Spread1024 = spread?.Spread.Length
			};
		}

		static TargetProfile[] ExtractTargetProfiles(ActorArsenal[] actors)
		{
			var states = actors.Where(a => a.Hp > 0)
				.SelectMany(a => a.TargetTypeSets.Select(types => (Actor: a, TargetTypes: types)));
			var profiles = states
				.GroupBy(state => $"{state.Actor.Armor}|{string.Join(",", state.TargetTypes)}", StringComparer.Ordinal)
				.OrderBy(g => g.Key, StringComparer.Ordinal)
				.Select((group, index) => new TargetProfile
				{
					Id = $"p{index + 1}",
					Armor = group.First().Actor.Armor,
					TargetTypes = group.First().TargetTypes,
					MemberActorIds = group.Select(state => state.Actor.Id).Distinct(StringComparer.Ordinal)
						.Order(StringComparer.Ordinal).ToArray()
				}).ToArray();
			foreach (var actor in actors)
				actor.TargetProfileIds = profiles.Where(profile => profile.MemberActorIds.Contains(actor.Id, StringComparer.Ordinal))
					.Select(profile => profile.Id).ToArray();
			return profiles;
		}

		static CounterEdge[] ExtractCounterEdges(ActorArsenal[] actors, TargetProfile[] targetProfiles)
		{
			var edges = new List<CounterEdge>();
			foreach (var attacker in actors.Where(a => a.Availability != "disabled"))
			{
				foreach (var armament in attacker.Armaments)
				{
					foreach (var target in targetProfiles)
					{
						var salvo = PeakDamage(armament, target);
						if (salvo <= 0)
							continue;

						var edge = new CounterEdge
						{
							ArmamentId = armament.Id,
							TargetProfileId = target.Id,
							PeakDamagePerSalvo = salvo
						};
						edges.Add(edge);
					}
				}
			}

			return edges.OrderBy(e => e.ArmamentId, StringComparer.Ordinal)
				.ThenBy(e => e.TargetProfileId, StringComparer.Ordinal)
				.ToArray();
		}

		static int PeakDamage(ArmamentData armament, TargetProfile target)
		{
			var targetTypes = new BitSet<TargetableType>(target.TargetTypes);
			var validTargets = new BitSet<TargetableType>(armament.ValidTargets);
			var invalidTargets = new BitSet<TargetableType>(armament.InvalidTargets);
			if (!validTargets.Overlaps(targetTypes) || invalidTargets.Overlaps(targetTypes))
				return 0;

			var damage = 0;
			foreach (var warhead in armament.DamageWarheads)
			{
				var warheadValidTargets = new BitSet<TargetableType>(warhead.ValidTargets);
				var warheadInvalidTargets = new BitSet<TargetableType>(warhead.InvalidTargets);
				if (!warhead.EnemyValid || warhead.Damage <= 0 ||
					!warheadValidTargets.Overlaps(targetTypes) || warheadInvalidTargets.Overlaps(targetTypes))
					continue;

				var armorIndex = Array.FindIndex(ArmorOrder, a => string.Equals(a, target.Armor, StringComparison.OrdinalIgnoreCase));
				var versus = armorIndex < 0 ? 100 : warhead.VersusPct[armorIndex];
				var falloff = warhead.FalloffPct?.FirstOrDefault() ?? 100;
				damage += Util.ApplyPercentageModifiers(warhead.Damage, [versus, falloff]);
			}

			return damage * armament.Burst;
		}

		static QueueData[] ExtractProductionQueues(Ruleset rules, SourceRefIndex sourceRefs,
			IReadOnlyDictionary<string, MiniYamlNode> resolvedActors)
		{
			var player = rules.Actors[SystemActors.Player];
			resolvedActors.TryGetValue(SystemActors.Player.ToString().ToLowerInvariant(), out var playerNode);
			var queues = player.TraitInfos<ProductionQueueInfo>()
				.OrderBy(q => q.Type, StringComparer.Ordinal)
				.Select(q =>
				{
					var result = new QueueData
					{
						Type = q.Type,
						BuildDurationModifierPct = q.BuildDurationModifier,
						LowPowerModifierPct = q.LowPowerModifier,
						BuildTimeSpeedReductionPct = (q as ClassicProductionQueueInfo)?.BuildTimeSpeedReduction.ToArray(),
						BuildingCountMultipliersPct = (q as ClassicParallelProductionQueueInfo)?.BuildingCountBuildTimeMultipliers.ToArray(),
						ParallelPenaltyMultipliersPct = (q as ClassicParallelProductionQueueInfo)?.ParallelPenaltyBuildTimeMultipliers.ToArray()
					};
					var traitName = q.GetType().Name;
					if (traitName.EndsWith("Info", StringComparison.Ordinal))
						traitName = traitName[..^4];
					var traitKey = string.IsNullOrEmpty(q.InstanceName) ? traitName : $"{traitName}@{q.InstanceName}";
					var queueNode = playerNode?.Value.Nodes.FirstOrDefault(n =>
						string.Equals(n.Key, traitKey, StringComparison.OrdinalIgnoreCase));
					result.AddSourceLocations(SourceLocations(queueNode), sourceRefs);
					return result;
				}).ToArray();
			return queues;
		}

		static ResourceValue[] ExtractResourceValues(Ruleset rules)
		{
			var resources = rules.Actors[SystemActors.Player].TraitInfoOrDefault<PlayerResourcesInfo>();
			return resources?.ResourceValues.OrderBy(r => r.Key, StringComparer.Ordinal)
				.Select(r => new ResourceValue { Type = r.Key, Value = r.Value }).ToArray() ?? [];
		}

		static int BurstDelayTotal(WeaponInfo weapon)
		{
			if (weapon.Burst <= 1 || weapon.BurstDelays.Length == 0)
				return 0;
			if (weapon.BurstDelays.Length == 1)
				return weapon.BurstDelays[0] * (weapon.Burst - 1);
			return weapon.BurstDelays.Sum();
		}

		static int VersusPercent(DamageWarhead warhead, string armor)
		{
			foreach (var versus in warhead.Versus)
				if (string.Equals(versus.Key, armor, StringComparison.OrdinalIgnoreCase))
					return versus.Value;
			return 100;
		}

		static IEnumerable<MiniYamlNode.SourceLocation> SourceLocations(MiniYamlNode node)
		{
			if (node == null)
				yield break;
			if (!string.IsNullOrEmpty(node.Location.Name) && node.Location.Line > 0)
				yield return node.Location;
			foreach (var child in node.Value.Nodes)
				foreach (var source in SourceLocations(child))
					yield return source;
		}

		static IEnumerable<MiniYamlNode.SourceLocation> RelevantActorSourceLocations(MiniYamlNode node)
		{
			if (node == null)
				yield break;
			foreach (var child in node.Value.Nodes)
			{
				var trait = child.Key.Split(ActorInfo.TraitInstanceSeparator)[0];
				if (!ActorSourceTraits.Contains(trait))
					continue;
				foreach (var source in SourceLocations(child))
					yield return source;
			}
		}

		static IEnumerable<MiniYamlNode.SourceLocation> RelevantWeaponSourceLocations(MiniYamlNode node)
		{
			if (node == null)
				yield break;
			var locations = new HashSet<MiniYamlNode.SourceLocation>();
			foreach (var child in node.Value.Nodes)
			{
				var field = child.Key.Split(ActorInfo.TraitInstanceSeparator)[0];
				if (!WeaponSourceFields.Contains(field) && !field.Equals("Warhead", StringComparison.OrdinalIgnoreCase))
					continue;
				foreach (var source in SourceLocations(child))
					locations.Add(source);
			}

			if (!string.IsNullOrEmpty(node.Location.Name) && node.Location.Line > 0)
				yield return node.Location;
			foreach (var source in locations
				.OrderBy(source => source.Name == node.Location.Name && source.Line >= node.Location.Line ? 0 : 1)
				.ThenBy(source => source.Name, StringComparer.Ordinal)
				.ThenBy(source => source.Line))
				yield return source;
		}

		static string Clean(string value)
		{
			return value.Replace('|', '/').Replace('\r', ' ').Replace('\n', ' ').Trim();
		}

		static string Sha256(byte[] bytes)
		{
			return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
		}

		sealed class SourceRefIndex
		{
			readonly IReadOnlyDictionary<string, int> sourceOrdinals;
			readonly HashSet<SourceKey> keys = [];

			public SourceRefIndex(IReadOnlyDictionary<string, int> sourceOrdinals)
			{
				this.sourceOrdinals = sourceOrdinals;
			}

			public SourceReference[] References { get; private set; } = [];
			public int Count => References.Length;

			public void Add(IEnumerable<MiniYamlNode.SourceLocation> locations)
			{
				foreach (var location in locations)
					if (!string.IsNullOrEmpty(location.Name) && location.Line > 0)
						keys.Add(new SourceKey(location.Name, location.Line));
			}

			public void FinalizeReferences(ActorArsenal[] actors, QueueData[] queues)
			{
				var ordered = keys.OrderBy(k => sourceOrdinals.GetValueOrDefault(k.Path, int.MaxValue))
					.ThenBy(k => k.Path, StringComparer.Ordinal)
					.ThenBy(k => k.Line)
					.ToArray();
				var ids = ordered.Select((key, index) => (key, id: $"s{index + 1}"))
					.ToDictionary(x => x.key, x => x.id);
				References = ordered.Select((key, index) => new SourceReference
				{
					Id = $"s{index + 1}",
					SourceFileIndex = sourceOrdinals[key.Path],
					Line = key.Line
				}).ToArray();

				foreach (var actor in actors)
				{
					actor.FinalizeSourceRefs(ids);
					foreach (var armament in actor.Armaments)
						armament.FinalizeSourceRefs(ids);
				}

				foreach (var queue in queues)
					queue.FinalizeSourceRefs(ids);
			}
		}

		readonly record struct SourceKey(string Path, int Line);

		abstract class SourceLinked
		{
			[JsonIgnore]
			public HashSet<SourceKey> SourceLocations { get; } = [];
			public string[] SourceRefIds { get; set; } = [];

			public void AddSourceLocations(IEnumerable<MiniYamlNode.SourceLocation> locations, SourceRefIndex index)
			{
				foreach (var location in locations.Where(l => !string.IsNullOrEmpty(l.Name) && l.Line > 0))
				{
					var key = new SourceKey(location.Name, location.Line);
					if (SourceLocations.Contains(key))
						continue;
					if (SourceLocations.Count >= MaxSourceRefsPerObject)
						break;
					SourceLocations.Add(key);
					index.Add([location]);
				}
			}

			public virtual void FinalizeSourceRefs(IReadOnlyDictionary<SourceKey, string> ids)
			{
				SourceRefIds = SourceLocations.Select(location => ids[location]).Order(StringComparer.Ordinal).ToArray();
			}
		}

		sealed class ArsenalArtifact
		{
			public int SchemaVersion { get; set; }
			public string ModId { get; set; }
			public string ActorScope { get; set; }
			public string RulesHash { get; set; }
			public string ArtifactHash { get; set; }
			public string[] ArmorOrder { get; set; }
			public SourceFile[] SourceFiles { get; set; }
			public SourceReference[] SourceRefs { get; set; }
			public ArsenalGlobals Globals { get; set; }
			public ActorArsenal[] Actors { get; set; }
			public TargetProfile[] TargetProfiles { get; set; }
			public string TargetStateModel { get; set; }
			public string CounterGraphEpistemic { get; set; }
			public string CounterEdgeRateFormula { get; set; }
			public CounterEdge[] CounterEdges { get; set; }
		}

		sealed class SourceFile
		{
			public string Category { get; set; }
			public string Path { get; set; }
			public int ByteLength { get; set; }
			public string Sha256 { get; set; }
			[JsonIgnore]
			public byte[] Bytes { get; set; }
		}

		sealed class SourceReference
		{
			public string Id { get; set; }
			public int SourceFileIndex { get; set; }
			public int Line { get; set; }
		}

		sealed class ArsenalGlobals
		{
			public QueueData[] ProductionQueues { get; set; }
			public ResourceValue[] ResourceValues { get; set; }
		}

		sealed class QueueData : SourceLinked
		{
			public string Type { get; set; }
			public int BuildDurationModifierPct { get; set; }
			public int LowPowerModifierPct { get; set; }
			public int[] BuildTimeSpeedReductionPct { get; set; }
			public int[] BuildingCountMultipliersPct { get; set; }
			public int[] ParallelPenaltyMultipliersPct { get; set; }
		}

		sealed class ResourceValue
		{
			public string Type { get; set; }
			public int Value { get; set; }
		}

		sealed class ActorArsenal : SourceLinked
		{
			public string Id { get; set; }
			public string DisplayName { get; set; }
			public string Availability { get; set; }
			public string[] Queues { get; set; }
			public string BuildAtProductionType { get; set; }
			public string[] Prerequisites { get; set; }
			public int Cost { get; set; }
			public int BaseBuildTicks { get; set; }
			public int Power { get; set; }
			public int Hp { get; set; }
			public string Armor { get; set; }
			public string[] TargetTypes { get; set; }
			public string[] TargetProfileIds { get; set; }
			[JsonIgnore]
			public string[][] TargetTypeSets { get; set; }
			public MovementData Movement { get; set; }
			public CrushableData Crushable { get; set; }
			public PlacementData Placement { get; set; }
			public AmmoPoolData[] AmmoPools { get; set; }
			public ArmamentData[] Armaments { get; set; }
		}

		sealed class MovementData
		{
			public string Domain { get; set; }
			public string Locomotor { get; set; }
			public int Speed { get; set; }
			public string[] Crushes { get; set; }
		}

		sealed class CrushableData
		{
			public string[] Classes { get; set; }
			public int WarnProbabilityPct { get; set; }
		}

		sealed class PlacementData
		{
			public int? AdjacentCells { get; set; }
			public bool RequiresBaseProvider { get; set; }
			public int? BaseProviderRange1024 { get; set; }
		}

		sealed class AmmoPoolData
		{
			public string Name { get; set; }
			public string[] Armaments { get; set; }
			public int Capacity { get; set; }
			public int InitialAmmo { get; set; }
			public int ReloadCount { get; set; }
			public int ReloadDelayTicks { get; set; }
		}

		sealed class ArmamentData : SourceLinked
		{
			[JsonIgnore]
			public HashSet<SourceKey> WeaponSourceLocations { get; } = [];
			public string[] WeaponSourceRefIds { get; set; } = [];
			public string Id { get; set; }
			public string ActorId { get; set; }
			public string InstanceName { get; set; }
			public string WeaponId { get; set; }
			public int MinRange1024 { get; set; }
			public int MaxRange1024 { get; set; }
			public int ReloadTicks { get; set; }
			public int Burst { get; set; }
			public int[] BurstDelays { get; set; }
			public int CycleTicks { get; set; }
			public string[] ValidTargets { get; set; }
			public string[] InvalidTargets { get; set; }
			public DamageWarheadData[] DamageWarheads { get; set; }

			public void AddWeaponSourceLocations(IEnumerable<MiniYamlNode.SourceLocation> locations, SourceRefIndex index)
			{
				foreach (var location in locations.Where(l => !string.IsNullOrEmpty(l.Name) && l.Line > 0))
				{
					var key = new SourceKey(location.Name, location.Line);
					if (WeaponSourceLocations.Contains(key))
						continue;
					if (WeaponSourceLocations.Count >= MaxWeaponSourceRefsPerArmament)
						break;
					WeaponSourceLocations.Add(key);
					index.Add([location]);
				}
			}

			public override void FinalizeSourceRefs(IReadOnlyDictionary<SourceKey, string> ids)
			{
				base.FinalizeSourceRefs(ids);
				WeaponSourceRefIds = WeaponSourceLocations.Select(location => ids[location]).Order(StringComparer.Ordinal).ToArray();
			}
		}

		sealed class DamageWarheadData
		{
			public int Damage { get; set; }
			public int DelayTicks { get; set; }
			public string[] ValidTargets { get; set; }
			public string[] InvalidTargets { get; set; }
			public bool EnemyValid { get; set; }
			public int[] VersusPct { get; set; }
			public int[] FalloffPct { get; set; }
			public int? Spread1024 { get; set; }
		}

		sealed class CounterEdge
		{
			public string ArmamentId { get; set; }
			public string TargetProfileId { get; set; }
			public int PeakDamagePerSalvo { get; set; }
		}

		sealed class TargetProfile
		{
			public string Id { get; set; }
			public string Armor { get; set; }
			public string[] TargetTypes { get; set; }
			public string[] MemberActorIds { get; set; }
		}
	}
}
