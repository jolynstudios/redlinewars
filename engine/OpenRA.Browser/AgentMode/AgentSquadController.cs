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

namespace OpenRA.Browser
{
	static class AgentSquadController
	{
		internal const int MaxGroups = 16;
		internal const int MaxGroupNameLength = 24;

		internal sealed class State
		{
			internal Dictionary<string, SortedSet<uint>> Groups { get; } = new(StringComparer.Ordinal);
		}

		internal sealed class Snapshot
		{
			public string Name { get; init; }
			public int LiveCount { get; init; }
			public List<uint> ActorIds { get; init; } = [];
		}

		internal static string ValidateName(string name)
		{
			var normalized = name?.Trim();
			if (string.IsNullOrEmpty(normalized) || normalized.Length > MaxGroupNameLength)
				throw new InvalidDataException($"group name must be between 1 and {MaxGroupNameLength} characters");
			if (normalized.Any(char.IsControl))
				throw new InvalidDataException("group name must not contain control characters");

			return normalized;
		}

		internal static void Assign(State state, string name, IEnumerable<Actor> actors, Player owner)
		{
			var normalized = ValidateName(name);
			if (!state.Groups.ContainsKey(normalized) && state.Groups.Count >= MaxGroups)
				throw new InvalidDataException($"at most {MaxGroups} groups may be active");

			var actorIds = actors
				.Where(a => IsUsableOwnActor(a, owner))
				.Select(a => a.ActorID)
				.Distinct()
				.Order()
				.ToArray();
			if (actorIds.Length == 0)
				throw new InvalidDataException("group requires at least one live actor owned by this agent");

			state.Groups[normalized] = new SortedSet<uint>(actorIds);
		}

		internal static IReadOnlyList<uint> ResolveActorIds(State state, string name, World world, Player owner)
		{
			var normalized = ValidateName(name);
			Cull(state, world, owner);
			if (!state.Groups.TryGetValue(normalized, out var actorIds))
				throw new InvalidDataException($"group '{normalized}' does not exist or has no live actors");

			return actorIds.ToArray();
		}

		internal static IReadOnlyList<Snapshot> Observe(State state, World world, Player owner)
		{
			Cull(state, world, owner);
			return state.Groups
				.OrderBy(g => g.Key, StringComparer.Ordinal)
				.Select(g => new Snapshot
				{
					Name = g.Key,
					LiveCount = g.Value.Count,
					ActorIds = [.. g.Value]
				})
				.ToArray();
		}

		internal static void Clear(State state)
		{
			state.Groups.Clear();
		}

		static void Cull(State state, World world, Player owner)
		{
			foreach (var group in state.Groups.OrderBy(g => g.Key, StringComparer.Ordinal).ToArray())
			{
				group.Value.RemoveWhere(actorId => !IsUsableOwnActor(world.GetActorById(actorId), owner));
				if (group.Value.Count == 0)
					state.Groups.Remove(group.Key);
			}
		}

		static bool IsUsableOwnActor(Actor actor, Player owner)
		{
			return actor != null && actor.Owner == owner && actor.IsInWorld && !actor.IsDead && !actor.Disposed;
		}
	}
}
