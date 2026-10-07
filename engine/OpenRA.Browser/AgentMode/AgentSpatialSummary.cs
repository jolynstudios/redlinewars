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
using System.Linq;

namespace OpenRA.Browser
{
	public sealed class AgentSpatialMarker
	{
		public uint ActorId { get; init; }
		public string Type { get; init; }
		public CPos Cell { get; init; }
		public bool IsBase { get; init; }
	}

	public sealed class AgentKnownStructureMarker
	{
		public uint ActorId { get; init; }
		public string Type { get; init; }
		public CPos Cell { get; init; }
		public int LastSeenTick { get; init; }
	}

	public sealed class AgentSpatialAxisRange
	{
		public int Index { get; init; }
		public int CellStartInclusive { get; init; }
		public int CellEndExclusive { get; init; }
	}

	public sealed class AgentSpatialSummaryResult
	{
		public int GridWidth { get; init; }
		public int GridHeight { get; init; }
		public int MapMinX { get; init; }
		public int MapMinY { get; init; }
		public int MapMaxX { get; init; }
		public int MapMaxY { get; init; }
		public string Legend { get; init; }
		public List<AgentSpatialAxisRange> Columns { get; init; } = [];
		public List<AgentSpatialAxisRange> Rows { get; init; } = [];
		public List<string> Grid { get; init; } = [];
		public List<string> ContactLines { get; init; } = [];
		public List<string> FrontLines { get; init; } = [];
	}

	/// <summary>
	/// Builds a deterministic, fog-safe spatial summary from caller-sanitized knowledge.
	/// This helper deliberately accepts value-only markers instead of Actor or FrozenActor
	/// instances so that it cannot inspect hidden live state.
	/// </summary>
	public static class AgentSpatialSummary
	{
		public const int GridWidth = 16;
		public const int GridHeight = 16;
		public const int MaxContactLines = 6;
		public const int MaxFrontLines = 3;
		public const int MaxLineLength = 120;
		public const string Legend = "? unexplored; . explored; F frontier; $ explored resource; K known enemy structure; " +
			"A ally; B own base; O own force; E visible enemy; ! contact";

		[Flags]
		enum CellContents : ushort
		{
			None = 0,
			Explored = 1,
			Frontier = 2,
			Resource = 4,
			KnownEnemyStructure = 8,
			Ally = 16,
			OwnForce = 32,
			OwnBase = 64,
			VisibleEnemy = 128
		}

		public static AgentSpatialSummaryResult Build(
			World world,
			Player player,
			IEnumerable<AgentSpatialMarker> ownActors,
			IEnumerable<AgentSpatialMarker> alliedActors,
			IEnumerable<AgentSpatialMarker> visibleEnemies,
			IEnumerable<AgentKnownStructureMarker> knownEnemyStructures)
		{
			ArgumentNullException.ThrowIfNull(world);
			ArgumentNullException.ThrowIfNull(player);

			var bounds = world.Map.Bounds;
			var mapWidth = Math.Max(1, bounds.Width);
			var mapHeight = Math.Max(1, bounds.Height);
			var own = NormalizeMarkers(world, ownActors);
			var allies = NormalizeMarkers(world, alliedActors);
			var enemies = NormalizeMarkers(world, visibleEnemies);
			var known = NormalizeKnownStructures(world, knownEnemyStructures);
			var contents = new CellContents[GridHeight, GridWidth];

			foreach (var cell in world.Map.AllCells)
			{
				if (!world.Map.Contains(cell) || !player.Shroud.IsExplored(cell))
					continue;

				var (gridX, gridY) = ToGrid(cell, bounds.Left, bounds.Top, mapWidth, mapHeight);
				contents[gridY, gridX] |= CellContents.Explored;

				// Use immutable map-start resources as explored memory. Querying the live
				// resource layer under fog would leak an enemy harvester's depletion.
				if (world.Map.Resources[cell].Type != 0)
					contents[gridY, gridX] |= CellContents.Resource;
			}

			var frontiers = FindFrontiers(world, player, own.Select(a => a.Cell).ToArray());
			foreach (var cell in frontiers)
				Mark(contents, cell, bounds.Left, bounds.Top, mapWidth, mapHeight, CellContents.Frontier);

			foreach (var marker in known)
				Mark(contents, marker.Cell, bounds.Left, bounds.Top, mapWidth, mapHeight, CellContents.KnownEnemyStructure);

			foreach (var marker in allies)
				Mark(contents, marker.Cell, bounds.Left, bounds.Top, mapWidth, mapHeight, CellContents.Ally);

			foreach (var marker in own)
				Mark(contents, marker.Cell, bounds.Left, bounds.Top, mapWidth, mapHeight,
					marker.IsBase ? CellContents.OwnBase : CellContents.OwnForce);

			foreach (var marker in enemies)
				Mark(contents, marker.Cell, bounds.Left, bounds.Top, mapWidth, mapHeight, CellContents.VisibleEnemy);

			return new AgentSpatialSummaryResult
			{
				GridWidth = GridWidth,
				GridHeight = GridHeight,
				MapMinX = bounds.Left,
				MapMinY = bounds.Top,
				MapMaxX = bounds.Right - 1,
				MapMaxY = bounds.Bottom - 1,
				Legend = Legend,
				Columns = BuildRanges(bounds.Left, mapWidth, GridWidth),
				Rows = BuildRanges(bounds.Top, mapHeight, GridHeight),
				Grid = Render(contents),
				ContactLines = BuildContactLines(own, enemies, known, bounds.Left, bounds.Top, mapWidth, mapHeight),
				FrontLines = BuildFrontLines(own, frontiers)
			};
		}

		static AgentSpatialMarker[] NormalizeMarkers(World world, IEnumerable<AgentSpatialMarker> markers)
		{
			return (markers ?? [])
				.Where(m => m != null && world.Map.Contains(m.Cell))
				.OrderBy(m => m.Cell.Y)
				.ThenBy(m => m.Cell.X)
				.ThenBy(m => m.ActorId)
				.ToArray();
		}

		static AgentKnownStructureMarker[] NormalizeKnownStructures(
			World world,
			IEnumerable<AgentKnownStructureMarker> markers)
		{
			return (markers ?? [])
				.Where(m => m != null && world.Map.Contains(m.Cell))
				.OrderByDescending(m => m.LastSeenTick)
				.ThenBy(m => m.Cell.Y)
				.ThenBy(m => m.Cell.X)
				.ThenBy(m => m.ActorId)
				.ToArray();
		}

		static List<AgentSpatialAxisRange> BuildRanges(int start, int size, int count)
		{
			return Enumerable.Range(0, count)
				.Select(i => new AgentSpatialAxisRange
				{
					Index = i,
					CellStartInclusive = start + i * size / count,
					CellEndExclusive = start + (i + 1) * size / count
				})
				.ToList();
		}

		static List<CPos> FindFrontiers(World world, Player player, CPos[] ownCells)
		{
			var bounds = world.Map.Bounds;
			var center = new CPos((bounds.Left + bounds.Right - 1) / 2, (bounds.Top + bounds.Bottom - 1) / 2);
			var candidates = world.Map.AllCells
				.Where(c => world.Map.Contains(c) && !player.Shroud.IsExplored(c) &&
					AdjacentCells(c).Any(a => world.Map.Contains(a) && player.Shroud.IsExplored(a)))
				.OrderBy(c => ownCells.Length == 0 ? (c - center).LengthSquared : ownCells.Min(o => (c - o).LengthSquared))
				.ThenBy(c => c.Y)
				.ThenBy(c => c.X);

			var result = new List<CPos>();
			foreach (var candidate in candidates)
			{
				if (result.Any(c => (candidate - c).LengthSquared < 64))
					continue;

				result.Add(candidate);
				if (result.Count == MaxFrontLines)
					break;
			}

			return result;
		}

		static IEnumerable<CPos> AdjacentCells(CPos cell)
		{
			yield return new CPos(cell.X - 1, cell.Y);
			yield return new CPos(cell.X + 1, cell.Y);
			yield return new CPos(cell.X, cell.Y - 1);
			yield return new CPos(cell.X, cell.Y + 1);
		}

		static (int X, int Y) ToGrid(CPos cell, int left, int top, int mapWidth, int mapHeight)
		{
			var x = Math.Clamp((cell.X - left) * GridWidth / mapWidth, 0, GridWidth - 1);
			var y = Math.Clamp((cell.Y - top) * GridHeight / mapHeight, 0, GridHeight - 1);
			return (x, y);
		}

		static void Mark(
			CellContents[,] contents,
			CPos cell,
			int left,
			int top,
			int mapWidth,
			int mapHeight,
			CellContents marker)
		{
			var (x, y) = ToGrid(cell, left, top, mapWidth, mapHeight);
			contents[y, x] |= marker;
		}

		static List<string> Render(CellContents[,] contents)
		{
			var result = new List<string>(GridHeight);
			for (var y = 0; y < GridHeight; y++)
			{
				var row = new char[GridWidth];
				for (var x = 0; x < GridWidth; x++)
					row[x] = Render(contents[y, x]);

				result.Add(new string(row));
			}

			return result;
		}

		static char Render(CellContents contents)
		{
			if ((contents & CellContents.VisibleEnemy) != 0 &&
				(contents & (CellContents.OwnBase | CellContents.OwnForce | CellContents.Ally)) != 0)
				return '!';

			if ((contents & CellContents.VisibleEnemy) != 0)
				return 'E';

			if ((contents & CellContents.OwnBase) != 0)
				return 'B';

			if ((contents & CellContents.OwnForce) != 0)
				return 'O';

			if ((contents & CellContents.Ally) != 0)
				return 'A';

			if ((contents & CellContents.KnownEnemyStructure) != 0)
				return 'K';

			if ((contents & CellContents.Resource) != 0)
				return '$';

			if ((contents & CellContents.Frontier) != 0)
				return 'F';

			return (contents & CellContents.Explored) != 0 ? '.' : '?';
		}

		static List<string> BuildContactLines(
			AgentSpatialMarker[] own,
			AgentSpatialMarker[] enemies,
			AgentKnownStructureMarker[] known,
			int left,
			int top,
			int mapWidth,
			int mapHeight)
		{
			var lines = enemies
				.GroupBy(e => ToGrid(e.Cell, left, top, mapWidth, mapHeight))
				.Select(g => new
				{
					Grid = g.Key,
					Markers = g.OrderBy(e => e.Cell.Y).ThenBy(e => e.Cell.X).ThenBy(e => e.ActorId).ToArray(),
					NearestOwn = own.Length == 0 ? int.MaxValue : g.Min(e => own.Min(o => (e.Cell - o.Cell).LengthSquared))
				})
				.OrderBy(g => g.NearestOwn)
				.ThenBy(g => g.Grid.Y)
				.ThenBy(g => g.Grid.X)
				.Select(g => FormatVisibleContact(g.Markers, g.NearestOwn))
				.Take(MaxContactLines)
				.ToList();

			foreach (var marker in known)
			{
				if (lines.Count == MaxContactLines)
					break;

				var type = SafeType(marker.Type);
				lines.Add(Truncate($"CONTACT: remembered enemy structure {type} near cell {marker.Cell.X},{marker.Cell.Y}; last seen tick {marker.LastSeenTick}."));
			}

			return lines;
		}

		static string FormatVisibleContact(AgentSpatialMarker[] enemies, int nearestOwnSquared)
		{
			var representative = enemies[0].Cell;
			var types = enemies
				.GroupBy(e => SafeType(e.Type))
				.OrderByDescending(g => g.Count())
				.ThenBy(g => g.Key, StringComparer.Ordinal)
				.Take(3)
				.Select(g => $"{g.Key} x{g.Count()}");
			var distance = nearestOwnSquared == int.MaxValue ? "no own actor nearby" : $"nearest own {IntegerSquareRoot(nearestOwnSquared)} cells";
			return Truncate($"CONTACT: {enemies.Length} visible enemy actor(s) " +
				$"({string.Join(", ", types)}) near cell {representative.X},{representative.Y}; {distance}.");
		}

		static List<string> BuildFrontLines(AgentSpatialMarker[] own, IEnumerable<CPos> frontiers)
		{
			return frontiers
				.Select(cell =>
				{
					var nearest = own.Length == 0 ? -1 : IntegerSquareRoot(own.Min(o => (cell - o.Cell).LengthSquared));
					var distance = nearest < 0 ? "no own actor reference" : $"nearest own {nearest} cells";
					return Truncate($"FRONT: unexplored boundary near cell {cell.X},{cell.Y}; {distance}.");
				})
				.Take(MaxFrontLines)
				.ToList();
		}

		static int IntegerSquareRoot(int value)
		{
			if (value <= 0)
				return 0;

			return (int)Math.Sqrt(value);
		}

		static string SafeType(string type)
		{
			if (string.IsNullOrWhiteSpace(type))
				return "unknown";

			return type.Length <= 24 ? type : type[..24];
		}

		static string Truncate(string value)
		{
			return value.Length <= MaxLineLength ? value : value[..(MaxLineLength - 3)] + "...";
		}
	}
}
