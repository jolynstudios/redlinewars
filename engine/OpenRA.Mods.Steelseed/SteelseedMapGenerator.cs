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
using OpenRA.Mods.Common.MapGenerator;
using OpenRA.Mods.Common.Traits;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.Mods.Steelseed
{
	[TraitLocation(SystemActors.EditorWorld)]
	public sealed class SteelseedMapGeneratorInfo : MapGeneratorBaseInfo
	{
		sealed class Parameters
		{
			[FieldLoader.Require]
			public readonly int Seed = default;

			[FieldLoader.Require]
			public readonly int Players = default;

			[FieldLoader.Require]
			public readonly int MapWidth = default;

			[FieldLoader.Require]
			public readonly int MapHeight = default;

			[FieldLoader.Require]
			public readonly string Biome = null;

			[FieldLoader.Require]
			public readonly string Symmetry = null;

			[FieldLoader.Require]
			public readonly int ResourceDensity = default;

			[FieldLoader.Require]
			public readonly int ChokepointBias = default;

			public Parameters(MiniYaml yaml)
			{
				FieldLoader.Load(this, yaml);

				if (Players is not (2 or 4))
					throw new YamlException("Players must be 2 or 4.");

				if (MapWidth < 24 || MapWidth > 128 || MapHeight < 24 || MapHeight > 128)
					throw new YamlException("Map dimensions must be between 24 and 128 cells.");

				if (MapWidth != MapHeight)
					throw new YamlException("Milestone 1 presets must use square maps.");

				if (ResourceDensity is < 0 or > 100)
					throw new YamlException("ResourceDensity must be between 0 and 100.");

				if (ChokepointBias is < 0 or > 100)
					throw new YamlException("ChokepointBias must be between 0 and 100.");
			}
		}

		protected override int GetPlayerCount(MapGenerationArgs args)
		{
			if (args.Options.TryGetValue("Preset", out var preset))
				return preset is "ceramic-quadrant" or "foundry-cross" ? 4 : 2;

			return args.Options.TryGetValue("Players", out var players) &&
				Exts.TryParseInt32Invariant(players, out var parsed) ? parsed : 2;
		}

		public override Map Generate(ModData modData, MapGenerationArgs args)
		{
			var parameters = new Parameters(GenerateParameterYaml(modData, args));
			var terrainInfo = modData.DefaultTerrainInfo[args.Tileset];
			var generationArgs = new MapGenerationArgs
			{
				Uid = args.Uid,
				Generator = args.Generator,
				Tileset = args.Tileset,
				Size = new Size(parameters.MapWidth, parameters.MapHeight),
				Title = args.Title ?? MapTitle,
				Author = args.Author ?? "STEELSEED",
				Options = args.Options
			};

			var map = new Map(modData, terrainInfo, generationArgs.Size);
			var actorPlans = new List<ActorPlan>();
			var terraformer = new Terraformer(
				generationArgs,
				map,
				modData,
				actorPlans,
				Symmetry.Mirror.None,
				parameters.Players);

			terraformer.InitMap();

			var spawnPoints = CreateSpawnPoints(parameters);
			GenerateTerrain(map, parameters, spawnPoints);
			AddSpawnPoints(map, actorPlans, spawnPoints);
			AddStartingForces(map, actorPlans, spawnPoints);
			terraformer.BakeMap();

			return map;
		}

		static ImmutableArray<CPos> CreateSpawnPoints(Parameters parameters)
		{
			var width = parameters.MapWidth;
			var height = parameters.MapHeight;
			var margin = Math.Max(5, Math.Min(width, height) / 6);

			if (parameters.Players == 2)
			{
				if (parameters.Symmetry == "Vertical")
					return [new CPos(width / 2, margin), new CPos(width / 2, height - margin - 1)];

				return [new CPos(margin, height / 2), new CPos(width - margin - 1, height / 2)];
			}

			return
			[
				new CPos(margin, margin),
				new CPos(width - margin - 1, margin),
				new CPos(width - margin - 1, height - margin - 1),
				new CPos(margin, height - margin - 1)
			];
		}

		static void GenerateTerrain(Map map, Parameters parameters, ImmutableArray<CPos> spawnPoints)
		{
			var width = parameters.MapWidth;
			var height = parameters.MapHeight;
			var biomeSalt = StableHash(parameters.Biome);

			foreach (var mpos in map.AllCells.MapCoords)
			{
				var x = mpos.U;
				var y = mpos.V;
				var canonical = CanonicalCell(x, y, width, height, parameters.Players, parameters.Symmetry);
				var terrainHash = Hash(parameters.Seed ^ biomeSalt, canonical.X, canonical.Y);
				var nearSpawn = IsNearSpawn(x, y, spawnPoints, 5);
				var centerLane = Math.Abs(x - width / 2) <= 1 || Math.Abs(y - height / 2) <= 1;
				var blocked = !nearSpawn && !centerLane &&
					terrainHash % 100 < (uint)(parameters.ChokepointBias / 4);

				map.Tiles[mpos] = new TerrainTile(blocked ? (ushort)1 : (ushort)0, 0);
				map.Height[mpos] = (byte)(Hash(parameters.Seed + 17, canonical.X / 6, canonical.Y / 6) % 2);

				if (blocked || nearSpawn)
					continue;

				var resourceHash = Hash(parameters.Seed + 31, canonical.X, canonical.Y);
				if (resourceHash % 100 < parameters.ResourceDensity)
					map.Resources[mpos] = new ResourceTile(1, (byte)(1 + resourceHash / 100 % 8));
			}
		}

		static int2 CanonicalCell(int x, int y, int width, int height, int players, string symmetry)
		{
			if (players == 4)
			{
				var candidates = new[]
				{
					new int2(x, y),
					new int2(width - y - 1, x),
					new int2(width - x - 1, height - y - 1),
					new int2(y, height - x - 1)
				};

				var best = candidates[0];
				for (var i = 1; i < candidates.Length; i++)
					if (candidates[i].X < best.X ||
						(candidates[i].X == best.X && candidates[i].Y < best.Y))
						best = candidates[i];

				return best;
			}

			if (symmetry == "Vertical")
				return new int2(x, Math.Min(y, height - y - 1));

			return new int2(Math.Min(x, width - x - 1), y);
		}

		static bool IsNearSpawn(int x, int y, ImmutableArray<CPos> spawnPoints, int radius)
		{
			foreach (var spawn in spawnPoints)
			{
				var dx = x - spawn.X;
				var dy = y - spawn.Y;
				if (dx * dx + dy * dy <= radius * radius)
					return true;
			}

			return false;
		}

		static void AddSpawnPoints(Map map, List<ActorPlan> actorPlans, ImmutableArray<CPos> spawnPoints)
		{
			foreach (var spawn in spawnPoints)
				actorPlans.Add(new ActorPlan(map, "mpspawn") { Location = spawn });
		}

		static void AddStartingForces(Map map, List<ActorPlan> actorPlans, ImmutableArray<CPos> spawnPoints)
		{
			for (var i = 0; i < spawnPoints.Length; i++)
			{
				var spawn = spawnPoints[i];
				var towardCenterX = Math.Sign(map.MapSize.Width / 2 - spawn.X);
				var towardCenterY = Math.Sign(map.MapSize.Height / 2 - spawn.Y);
				var foundry = i % 2 == 0;
				var infantryType = foundry ? "foundry_rivet" : "lattice_shard";
				var vehicleType = foundry ? "foundry_tread" : "lattice_skimmer";
				var owner = $"Multi{i}";

				// The faction HQ, ON the spawn cell.
				//
				// Without it there is no economy at all, and the failure is silent rather
				// than loud: `ClassicProductionQueue` scans the player's owned world actors
				// for a `Production` trait, finds none, disables itself and clears the queue
				// every tick — so `StartProduction` is accepted and discarded. And since the
				// HQ is what every other structure requires, a match with no HQ cannot build
				// its way out: there is no first producer to build the first producer with.
				//
				// Starting forces were infantry + vehicle only, which is why a headless
				// skirmish still reached a decision (units can fight) while production had
				// never once been exercised end to end.
				actorPlans.Add(OwnedActorPlan(
					map,
					foundry ? "foundry_crucible" : "lattice_nexus",
					owner,
					spawn));

				actorPlans.Add(OwnedActorPlan(
					map,
					infantryType,
					owner,
					new CPos(spawn.X + towardCenterX, spawn.Y + towardCenterY)));
				actorPlans.Add(OwnedActorPlan(
					map,
					vehicleType,
					owner,
					new CPos(spawn.X + towardCenterX * 2, spawn.Y + towardCenterY * 2)));
			}
		}

		static ActorPlan OwnedActorPlan(Map map, string type, string owner, CPos location)
		{
			return new ActorPlan(map, new ActorReference(type)
			{
				new LocationInit(location),
				new OwnerInit(owner)
			});
		}

		static uint Hash(int seed, int x, int y)
		{
			unchecked
			{
				var value = (uint)seed;
				value ^= (uint)x * 0x9E3779B9u;
				value = (value << 13) | (value >> 19);
				value ^= (uint)y * 0x85EBCA6Bu;
				value ^= value >> 16;
				value *= 0x7FEB352Du;
				value ^= value >> 15;
				return value;
			}
		}

		static int StableHash(string value)
		{
			unchecked
			{
				var hash = 17;
				foreach (var c in value)
					hash = hash * 31 + c;

				return hash;
			}
		}

		public override object Create(ActorInitializer init)
		{
			return new SteelseedMapGenerator(init, this);
		}
	}

	public sealed class SteelseedMapGenerator : MapGeneratorBase
	{
		public SteelseedMapGenerator(ActorInitializer init, SteelseedMapGeneratorInfo info)
			: base(init, info) { }
	}
}
