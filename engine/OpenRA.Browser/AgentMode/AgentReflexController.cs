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

using System.Collections.Generic;
using System.Linq;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA.Browser
{
	static class AgentReflexController
	{
		const int EvaluationIntervalTicks = 5;
		const int ReflexCooldownTicks = 25;
		const int ActorLeaseTicks = 75;
		const int NewUnitRallyLifetimeTicks = 250;
		const int HarvesterThreatRadius = 6;
		const int CriticalDefenseRadius = 12;
		const int StructureDefenseRadius = 20;

		// Idle/busy combat at home must answer structureAttacked even if the fight is outside
		// StructureDefenseRadius (base raid while army holds a rally). Pure body, not war commit.
		// Wider than 24: parked tanks a screen away were invisible to the pull (live match bug).
		const int StructureDefenseHomePullRadius = 48;

		// Q4: faster / larger base defense (pure-safe body, not last-resort war).
		const int StructureDefenseDelayTicks = 5;
		const int StructureDefenseMaxUnits = 12;
		const int StructureDefenseMaxUnitsMulti = 16;
		const int MaxEvents = 64;

		// BQ C1 emergency: a structureAttacked alert that stays active past this many ticks is "sustained
		// fire" — new units then force-rally to auto-engage (attackMove) the burning structure instead of
		// passively moving to a base-defense rally. Pure-safe body, not a last-resort war path.
		const int EmergencyStructureFireTicks = 25;

		internal sealed class State
		{
			public AgentStandingPolicyObservation Policy { get; set; } = new();
			public bool Initialized { get; set; }
			public int LastEvaluationTick { get; set; } = -1;
			public long NextEventSequence { get; set; } = 1;
			public Dictionary<uint, int> ActorLeaseUntil { get; } = [];
			public Dictionary<uint, int> ReflexCooldownUntil { get; } = [];
			public Dictionary<uint, int> PreviousHealth { get; } = [];
			public HashSet<uint> KnownActors { get; } = [];
			public Dictionary<uint, int> PendingRallyActors { get; } = [];
			public Queue<AgentReflexEvent> Events { get; } = [];
		}

		internal sealed class Intent
		{
			public string Kind { get; init; }
			public AgentAction Action { get; init; }
			public uint DockActorId { get; init; }
			public uint DockTargetActorId { get; init; }
			public bool OverridesLease { get; init; }
			public List<uint> ActorIds { get; init; } = [];
			public uint TargetActorId { get; init; }
			public CPos? Cell { get; init; }
			public string Reason { get; init; }
		}

		internal static IReadOnlyList<Intent> Evaluate(World world, Player player,
			IEnumerable<AgentAlertObservation> alerts, State state, bool delayedStructureDefense = false,
			IReadOnlySet<uint> missionActorIds = null)
		{
			if (state.LastEvaluationTick >= 0 && world.WorldTick - state.LastEvaluationTick < EvaluationIntervalTicks)
				return [];

			state.LastEvaluationTick = world.WorldTick;
			var ownActors = world.Actors
				.Where(a => IsUsableActor(a, player))
				.OrderBy(a => a.ActorID)
				.ToArray();
			var visibleEnemies = GetVisibleEnemies(world, player);
			var alertArray = alerts.ToArray();
			var combatActors = ownActors.Where(actor => AgentCombatRoster.IsEligible(actor, player, "Attack")).ToArray();
			var initialized = state.Initialized;
			var damagedCombatActors = new HashSet<uint>();
			foreach (var actor in ownActors)
			{
				var health = actor.TraitOrDefault<Health>();
				if (health != null && state.PreviousHealth.TryGetValue(actor.ActorID, out var previous) && health.HP < previous)
					damagedCombatActors.Add(actor.ActorID);
				if (health != null)
					state.PreviousHealth[actor.ActorID] = health.HP;

				if (state.KnownActors.Add(actor.ActorID) && initialized &&
					AgentCombatRoster.IsEligible(actor, player, "Attack"))
					state.PendingRallyActors[actor.ActorID] = world.WorldTick + NewUnitRallyLifetimeTicks;
			}

			state.Initialized = true;

			var liveActorIds = ownActors.Select(a => a.ActorID).ToHashSet();
			RemoveStale(state.ActorLeaseUntil, liveActorIds, world.WorldTick);
			RemoveStale(state.ReflexCooldownUntil, liveActorIds, world.WorldTick);
			foreach (var actorId in state.PreviousHealth.Keys.Where(id => !liveActorIds.Contains(id)).ToArray())
				state.PreviousHealth.Remove(actorId);
			foreach (var actorId in state.KnownActors.Where(id => !liveActorIds.Contains(id)).ToArray())
				state.KnownActors.Remove(actorId);
			foreach (var actorId in state.PendingRallyActors
				.Where(a => !liveActorIds.Contains(a.Key) || a.Value < world.WorldTick).Select(a => a.Key).ToArray())
				state.PendingRallyActors.Remove(actorId);

			var selected = new HashSet<uint>();
			var intents = new List<Intent>();
			if (state.Policy.HarvesterFlee)
				AddHarvesterFleeIntents(world, ownActors, visibleEnemies, state, selected, intents);
			if (state.Policy.DefendCriticalAssets)
			{
				AddCriticalDefenseIntents(world, ownActors, combatActors, visibleEnemies, alertArray, state, selected, intents);
				if (delayedStructureDefense)
					AddStructureDefenseIntents(world, ownActors, combatActors, visibleEnemies, alertArray, state,
						selected, intents);
			}

			if (state.Policy.RetreatBelowHpPercent > 0)
				AddRetreatIntents(world, player, combatActors, state, selected, intents);
			if (state.Policy.AutoReturnFire)
				AddReturnFireIntents(combatActors, visibleEnemies, damagedCombatActors, state, selected, intents);
			if (state.Policy.RallyNewUnitsToDefense)
				AddRallyIntents(combatActors, alertArray, state, selected, intents, world.WorldTick);
			if (state.Policy.AutoRepairBuildings)
				AddAutoRepairIntents(world, player, ownActors, state, selected, intents);

			// Lowest-priority reflex: only after every defensive/return-fire/retreat claim has taken its
			// units does an otherwise-idle combat unit first-strike an enemy already in weapon range.
			if (state.Policy.ProactiveEngage)
				AddProactiveEngageIntents(combatActors, visibleEnemies, missionActorIds, state, selected, intents);

			return intents;
		}

		internal static void SetPolicy(State state, AgentAction action)
		{
			state.Policy = new AgentStandingPolicyObservation
			{
				AutoReturnFire = action.AutoReturnFire.Value,
				HarvesterFlee = action.HarvesterFlee.Value,
				RallyNewUnitsToDefense = action.RallyNewUnitsToDefense.Value,
				DefendCriticalAssets = action.DefendCriticalAssets.Value,
				RetreatBelowHpPercent = action.RetreatBelowHpPercent.Value,
				AutoRepairBuildings = action.AutoRepairBuildings.Value,

				// Optional field: absent preserves the current value so a complete-policy replacement never
				// silently disables the reactive preset's proactive-engage default.
				ProactiveEngage = action.ProactiveEngage ?? state.Policy.ProactiveEngage
			};
		}

		internal static AgentStandingPolicyObservation GetPolicy(State state)
		{
			return new AgentStandingPolicyObservation
			{
				AutoReturnFire = state.Policy.AutoReturnFire,
				HarvesterFlee = state.Policy.HarvesterFlee,
				RallyNewUnitsToDefense = state.Policy.RallyNewUnitsToDefense,
				DefendCriticalAssets = state.Policy.DefendCriticalAssets,
				RetreatBelowHpPercent = state.Policy.RetreatBelowHpPercent,
				AutoRepairBuildings = state.Policy.AutoRepairBuildings,
				ProactiveEngage = state.Policy.ProactiveEngage
			};
		}

		internal static void LeaseOrders(State state, World world, Player player, IEnumerable<Order> orders)
		{
			foreach (var actor in orders.Select(o => o.Subject).Where(a => a != null && a.Owner == player).Distinct())
				state.ActorLeaseUntil[actor.ActorID] = world.WorldTick + ActorLeaseTicks;
		}

		internal static void RecordIssued(State state, World world, Intent intent)
		{
			foreach (var actorId in intent.ActorIds)
				state.ReflexCooldownUntil[actorId] = world.WorldTick + ReflexCooldownTicks;
			if (intent.Kind is "rally" or "emergencyRally")
				foreach (var actorId in intent.ActorIds)
					state.PendingRallyActors.Remove(actorId);

			state.Events.Enqueue(new AgentReflexEvent
			{
				Sequence = state.NextEventSequence++,
				WorldTick = world.WorldTick,
				Kind = intent.Kind,
				ActorIds = [.. intent.ActorIds],
				TargetActorId = intent.TargetActorId,
				Cell = intent.Cell.HasValue ? new AgentCellObservation { X = intent.Cell.Value.X, Y = intent.Cell.Value.Y } : null,
				Reason = intent.Reason
			});
			while (state.Events.Count > MaxEvents)
				state.Events.Dequeue();
		}

		internal static AgentReflexEventBatch GetEvents(State state, long sinceSequence)
		{
			return new AgentReflexEventBatch
			{
				LatestSequence = state.NextEventSequence - 1,
				Events = state.Events.Where(e => e.Sequence > sinceSequence).ToList()
			};
		}

		static void AddHarvesterFleeIntents(World world, Actor[] ownActors, Actor[] visibleEnemies, State state,
			HashSet<uint> selected, List<Intent> intents)
		{
			foreach (var actor in ownActors.Where(a => a.Info.HasTraitInfo<HarvesterInfo>()))
			{
				if (!CanIssue(state, actor.ActorID, world.WorldTick, true))
					continue;

				var attacker = visibleEnemies
					.Where(e => (e.Location - actor.Location).LengthSquared <= HarvesterThreatRadius * HarvesterThreatRadius &&
						CanAttack(e, actor))
					.OrderBy(e => (e.Location - actor.Location).LengthSquared)
					.ThenBy(e => e.ActorID)
					.FirstOrDefault();
				if (attacker == null)
					continue;

				var dockClient = actor.TraitOrDefault<DockClientManager>();
				var refinery = ownActors
					.Where(a => a.Info.HasTraitInfo<RefineryInfo>() && dockClient?.CanDockAt(a, true, true) == true)
					.OrderBy(a => (a.Location - actor.Location).LengthSquared)
					.ThenBy(a => a.ActorID)
					.FirstOrDefault();
				if (refinery == null || !actor.AcceptsOrder("Dock"))
					continue;

				selected.Add(actor.ActorID);
				intents.Add(new Intent
				{
					Kind = "harvesterFlee",
					DockActorId = actor.ActorID,
					DockTargetActorId = refinery.ActorID,
					OverridesLease = true,
					ActorIds = [actor.ActorID],
					TargetActorId = attacker.ActorID,
					Cell = refinery.Location,
					Reason = $"harvester {actor.ActorID} fled visible threat {attacker.ActorID} to refinery {refinery.ActorID}"
				});
			}
		}

		static void AddCriticalDefenseIntents(World world, Actor[] ownActors, Actor[] combatActors, Actor[] visibleEnemies,
			IEnumerable<AgentAlertObservation> alerts, State state, HashSet<uint> selected, List<Intent> intents)
		{
			// Production buildings are already critical (ProductionInfo); pull home combat like structure defense.
			foreach (var alert in alerts.Where(a => a.Kind == "criticalAssetAttacked" && a.StillActive)
				.OrderByDescending(a => a.FirstSeenTick).ThenBy(a => a.AffectedActorId))
			{
				var asset = ownActors.FirstOrDefault(a => a.ActorID == alert.AffectedActorId);
				if (asset == null)
					continue;

				var home = FindBaseCell(world, asset.Owner);
				const int HomePullSq = StructureDefenseHomePullRadius * StructureDefenseHomePullRadius;
				const int RadiusSq = CriticalDefenseRadius * CriticalDefenseRadius;
				var attacker = visibleEnemies
					.Where(e => (e.Location - asset.Location).LengthSquared <= RadiusSq)
					.OrderBy(e => (e.Location - asset.Location).LengthSquared)
					.ThenBy(e => e.ActorID)
					.FirstOrDefault();

				var defenders = SelectBaseDefenders(world, combatActors, selected, state, asset, attacker,
					home, RadiusSq, HomePullSq, StructureDefenseMaxUnits);
				if (defenders.Count == 0)
					continue;

				selected.UnionWith(defenders);
				var useAttack = attacker != null && defenders.All(id =>
				{
					var a = world.GetActorById(id);
					return a != null && (a.Location - attacker.Location).LengthSquared <= RadiusSq;
				});
				intents.Add(new Intent
				{
					Kind = "criticalDefense",
					Action = useAttack
						? new AgentAction { Type = "attack", ActorIds = defenders, TargetActorId = attacker.ActorID }
						: new AgentAction
						{
							Type = "attackMove",
							ActorIds = defenders,
							CellX = asset.Location.X,
							CellY = asset.Location.Y
						},
					OverridesLease = true,
					ActorIds = defenders,
					TargetActorId = attacker?.ActorID ?? 0,
					Cell = asset.Location,
					Reason = useAttack
						? $"defending critical actor {asset.ActorID} from visible attacker {attacker.ActorID}"
						: $"critical garrison pull to {asset.ActorID} at {asset.Location.X},{asset.Location.Y}"
				});
			}
		}

		static void AddStructureDefenseIntents(World world, Actor[] ownActors, Actor[] combatActors, Actor[] visibleEnemies,
			IEnumerable<AgentAlertObservation> alerts, State state, HashSet<uint> selected, List<Intent> intents)
		{
			var activeStructureAlerts = alerts.Where(a => a.Kind == "structureAttacked" && a.StillActive).ToArray();
			var maxDefenders = activeStructureAlerts.Length >= 2
				? StructureDefenseMaxUnitsMulti
				: StructureDefenseMaxUnits;

			foreach (var alert in activeStructureAlerts
				.OrderBy(a => a.FirstSeenTick).ThenBy(a => a.AffectedActorId))
			{
				if (world.WorldTick - alert.FirstSeenTick < StructureDefenseDelayTicks)
					continue;

				var asset = ownActors.FirstOrDefault(a => a.ActorID == alert.AffectedActorId);
				if (asset == null)
					continue;

				const int RadiusSq = StructureDefenseRadius * StructureDefenseRadius;
				var attacker = visibleEnemies
					.Where(e => (e.Location - asset.Location).LengthSquared <= RadiusSq)
					.OrderBy(e => (e.Location - asset.Location).LengthSquared)
					.ThenBy(e => e.ActorID)
					.FirstOrDefault();

				var home = FindBaseCell(world, asset.Owner);
				const int HomePullSq = StructureDefenseHomePullRadius * StructureDefenseHomePullRadius;
				var defenders = SelectBaseDefenders(world, combatActors, selected, state, asset, attacker,
					home, RadiusSq, HomePullSq, maxDefenders);

				if (defenders.Count == 0)
				{
					intents.Add(new Intent
					{
						Kind = "structureDefenseEmpty",
						ActorIds = [],
						TargetActorId = attacker?.ActorID ?? 0,
						Cell = asset.Location,
						Reason = combatActors.Length == 0
							? $"structure {asset.ActorID} under attack; no combat units owned"
							: $"structure {asset.ActorID} under attack; zero combat defenders available " +
								$"(combatLive={combatActors.Length}, attackerVisible={attacker != null})"
					});
					continue;
				}

				var useAttack = attacker != null && defenders.All(id =>
				{
					var a = world.GetActorById(id);
					return a != null && (a.Location - attacker.Location).LengthSquared <= RadiusSq;
				});
				selected.UnionWith(defenders);
				intents.Add(new Intent
				{
					Kind = "structureDefense",
					Action = useAttack
						? new AgentAction { Type = "attack", ActorIds = defenders, TargetActorId = attacker.ActorID }
						: new AgentAction
						{
							Type = "attackMove",
							ActorIds = defenders,
							CellX = asset.Location.X,
							CellY = asset.Location.Y
						},
					OverridesLease = true,
					ActorIds = defenders,
					TargetActorId = attacker?.ActorID ?? 0,
					Cell = asset.Location,
					Reason = useAttack
						? $"defense of structure {asset.ActorID} vs attacker {attacker.ActorID} ({defenders.Count} units)"
						: $"garrison pull {defenders.Count} unit(s) to structure {asset.ActorID} at {asset.Location.X},{asset.Location.Y}"
				});
			}
		}

		/// <summary>
		/// Pick combat to answer a base raid. Prefer idle near the asset, then home-parked (busy OK),
		/// then any combat on the map. OverridesLease already true for defense — do not require IsIdle
		/// only, or tanks sitting on hold/rally never move.
		/// </summary>
		static List<uint> SelectBaseDefenders(World world, Actor[] combatActors, HashSet<uint> selected,
			State state, Actor asset, Actor attacker, CPos home, int radiusSq, int homePullSq, int maxDefenders)
		{
			var candidates = combatActors
				.Where(a => !selected.Contains(a.ActorID) &&
					CanIssue(state, a.ActorID, world.WorldTick, true))
				.ToArray();
			if (candidates.Length == 0)
				return [];

			var nearby = candidates
				.Where(a => (a.Location - asset.Location).LengthSquared <= radiusSq ||
					(a.Location - home).LengthSquared <= homePullSq)
				.OrderBy(a => a.IsIdle ? 0 : 1)
				.ThenBy(a => (a.Location - asset.Location).LengthSquared)
				.ThenBy(a => a.ActorID)
				.ToArray();

			List<uint> Pick(IEnumerable<Actor> pool, System.Func<Actor, bool> pred) =>
				pool.Where(pred).Select(a => a.ActorID).Take(maxDefenders).ToList();

			List<uint> defenders;
			if (attacker != null)
			{
				defenders = Pick(nearby, a => a.IsIdle && CanAttack(a, attacker));
				if (defenders.Count == 0)
					defenders = Pick(nearby, a => CanAttack(a, attacker));
				if (defenders.Count == 0)
					defenders = Pick(nearby, a => a.IsIdle);
				if (defenders.Count == 0)
					defenders = Pick(nearby, _ => true);
			}
			else
			{
				// No visible attacker (fog / range): still rush the building cell.
				defenders = Pick(nearby, a => a.IsIdle);
				if (defenders.Count == 0)
					defenders = Pick(nearby, _ => true);
			}

			if (defenders.Count == 0)
			{
				// Map-wide: any combat unit, idle preferred, busy allowed.
				defenders = candidates
					.OrderBy(a => a.IsIdle ? 0 : 1)
					.ThenBy(a => (a.Location - asset.Location).LengthSquared)
					.ThenBy(a => a.ActorID)
					.Select(a => a.ActorID)
					.Take(maxDefenders)
					.ToList();
			}

			return defenders;
		}

		static void AddRetreatIntents(World world, Player player, Actor[] combatActors, State state,
			HashSet<uint> selected, List<Intent> intents)
		{
			var baseCell = FindBaseCell(world, player);
			foreach (var actor in combatActors)
			{
				// Low-HP retreat is a last-ditch safety reflex: pulling a dying unit home overrides an active
				// model lease (overridesLease: true) so a just-issued order cannot strand it in the fire. Only
				// fires when RetreatBelowHpPercent > 0 (off on the benchmark default track unless the model sets it).
				var health = actor.TraitOrDefault<Health>();
				if (selected.Contains(actor.ActorID) || health == null ||
					health.HP * 100L >= health.MaxHP * state.Policy.RetreatBelowHpPercent ||
					!CanIssue(state, actor.ActorID, world.WorldTick, true))
					continue;

				selected.Add(actor.ActorID);
				intents.Add(new Intent
				{
					Kind = "retreat",
					Action = new AgentAction { Type = "move", ActorIds = [actor.ActorID], CellX = baseCell.X, CellY = baseCell.Y },
					OverridesLease = true,
					ActorIds = [actor.ActorID],
					Cell = baseCell,
					Reason = $"actor {actor.ActorID} retreated below {state.Policy.RetreatBelowHpPercent}% health"
				});
			}
		}

		static void AddReturnFireIntents(Actor[] combatActors, Actor[] visibleEnemies, HashSet<uint> damagedActorIds,
			State state, HashSet<uint> selected, List<Intent> intents)
		{
			foreach (var actor in combatActors.Where(a => damagedActorIds.Contains(a.ActorID)))
			{
				if (selected.Contains(actor.ActorID) || !CanIssue(state, actor.ActorID, actor.World.WorldTick, false))
					continue;

				var attacker = visibleEnemies.Where(e => CanAttack(actor, e))
					.OrderBy(e => (e.Location - actor.Location).LengthSquared)
					.ThenBy(e => e.ActorID)
					.FirstOrDefault();
				if (attacker == null)
					continue;

				selected.Add(actor.ActorID);
				intents.Add(new Intent
				{
					Kind = "returnFire",
					Action = new AgentAction { Type = "attack", ActorIds = [actor.ActorID], TargetActorId = attacker.ActorID },
					ActorIds = [actor.ActorID],
					TargetActorId = attacker.ActorID,
					Cell = attacker.Location,
					Reason = $"actor {actor.ActorID} returned fire on visible attacker {attacker.ActorID}"
				});
			}
		}

		/// <summary>
		/// R3 proactive in-weapon-range engage. An otherwise-idle combat unit first-strikes the nearest
		/// currently-visible enemy that is already inside its weapon range. This is the first-strike
		/// complement to return fire (which needs the unit to be hit first). Pure-safe reactive body:
		/// <list type="bullet">
		/// <item>Idle only — a unit already executing a model or mission order (non-idle) is left alone.</item>
		/// <item>Direct orders win — <see cref="CanIssue"/> respects the model lease (overridesLease: false).</item>
		/// <item>Mission membership wins — actors owned by an active mission are excluded outright.</item>
		/// <item>No chase — it issues a target attack only when the enemy is in current weapon range and never
		/// moves the unit, so it can never pull the army out and open war.</item>
		/// </list>
		/// </summary>
		static void AddProactiveEngageIntents(Actor[] combatActors, Actor[] visibleEnemies,
			IReadOnlySet<uint> missionActorIds, State state, HashSet<uint> selected, List<Intent> intents)
		{
			if (visibleEnemies.Length == 0)
				return;

			foreach (var actor in combatActors)
			{
				if (selected.Contains(actor.ActorID) || !actor.IsIdle ||
					(missionActorIds != null && missionActorIds.Contains(actor.ActorID)) ||
					!CanIssue(state, actor.ActorID, actor.World.WorldTick, false))
					continue;

				var target = visibleEnemies
					.Where(e => AgentCombatRoster.CanEngageInRange(actor, e))
					.OrderBy(e => (e.Location - actor.Location).LengthSquared)
					.ThenBy(e => e.ActorID)
					.FirstOrDefault();
				if (target == null)
					continue;

				selected.Add(actor.ActorID);
				intents.Add(new Intent
				{
					Kind = "proactiveEngage",
					Action = new AgentAction { Type = "attack", ActorIds = [actor.ActorID], TargetActorId = target.ActorID },
					ActorIds = [actor.ActorID],
					TargetActorId = target.ActorID,
					Cell = target.Location,
					Reason = $"idle actor {actor.ActorID} first-struck in-range visible enemy {target.ActorID}"
				});
			}
		}

		static void AddRallyIntents(Actor[] combatActors, IEnumerable<AgentAlertObservation> alerts, State state,
			HashSet<uint> selected, List<Intent> intents, int worldTick)
		{
			var alertArray = alerts as AgentAlertObservation[] ?? alerts.ToArray();

			// C1 emergency: a structure under sustained fire (its structureAttacked alert has stayed active past
			// the emergency threshold) force-rallies new units to AUTO-ENGAGE — an attackMove onto the burning
			// structure rather than a passive move — so fresh production fights the raid instead of idling on a
			// rally. Pure-safe body; supersedes the passive rally while the emergency is live.
			var emergency = alertArray
				.Where(a => a.StillActive && a.Kind == "structureAttacked" && a.Cell != null &&
					worldTick - a.FirstSeenTick >= EmergencyStructureFireTicks)
				.OrderBy(a => a.FirstSeenTick).ThenBy(a => a.AffectedActorId)
				.FirstOrDefault();
			if (emergency != null)
			{
				var cell = new CPos(emergency.Cell.X, emergency.Cell.Y);
				foreach (var actor in combatActors.Where(a => state.PendingRallyActors.ContainsKey(a.ActorID)))
				{
					if (selected.Contains(actor.ActorID) || !CanIssue(state, actor.ActorID, actor.World.WorldTick, false))
						continue;

					selected.Add(actor.ActorID);
					intents.Add(new Intent
					{
						Kind = "emergencyRally",
						Action = new AgentAction
						{
							Type = "attackMove",
							ActorIds = [actor.ActorID],
							CellX = cell.X,
							CellY = cell.Y
						},
						ActorIds = [actor.ActorID],
						Cell = cell,
						Reason = $"new combat actor {actor.ActorID} force-rallied to auto-engage sustained fire " +
							$"on structure {emergency.AffectedActorId}"
					});
				}

				return;
			}

			var alert = alertArray.Where(a => a.StillActive && a.Kind is "criticalAssetAttacked" or "enemyNearBase")
				.OrderByDescending(a => a.FirstSeenTick).ThenBy(a => a.AffectedActorId).FirstOrDefault();
			if (alert?.Cell == null)
				return;

			foreach (var actor in combatActors.Where(a => state.PendingRallyActors.ContainsKey(a.ActorID)))
			{
				if (selected.Contains(actor.ActorID) || !CanIssue(state, actor.ActorID, actor.World.WorldTick, false))
					continue;

				var cell = new CPos(alert.Cell.X, alert.Cell.Y);
				selected.Add(actor.ActorID);
				intents.Add(new Intent
				{
					Kind = "rally",
					Action = new AgentAction { Type = "move", ActorIds = [actor.ActorID], CellX = cell.X, CellY = cell.Y },
					ActorIds = [actor.ActorID],
					Cell = cell,
					Reason = $"new combat actor {actor.ActorID} rallied to active base defense"
				});
			}
		}

		static void AddAutoRepairIntents(World world, Player player, Actor[] ownActors, State state,
			HashSet<uint> selected, List<Intent> intents)
		{
			var resources = player.PlayerActor?.TraitOrDefault<PlayerResources>();
			if ((resources?.GetCashAndResources() ?? 0) < 500 ||
				player.PlayerActor?.AcceptsOrder("RepairBuilding") != true)
				return;

			foreach (var actor in ownActors.Where(a => a.Info.HasTraitInfo<BuildingInfo>()))
			{
				var health = actor.TraitOrDefault<Health>();
				var repairable = actor.TraitsImplementing<RepairableBuilding>()
					.FirstOrDefault(r => !r.IsTraitDisabled);
				if (selected.Contains(actor.ActorID) || health == null || health.HP >= health.MaxHP || repairable == null ||
					repairable.RepairActive || repairable.Repairers.Contains(player) ||
					!CanIssue(state, actor.ActorID, world.WorldTick, false))
					continue;

				selected.Add(actor.ActorID);
				intents.Add(new Intent
				{
					Kind = "autoRepair",
					Action = new AgentAction { Type = "repair", ActorIds = [actor.ActorID] },
					ActorIds = [actor.ActorID],
					Cell = actor.Location,
					Reason = $"damaged building {actor.ActorID} entered automatic repair"
				});
			}
		}

		static bool CanIssue(State state, uint actorId, int worldTick, bool overridesLease)
		{
			if (state.ReflexCooldownUntil.TryGetValue(actorId, out var cooldownUntil) && worldTick < cooldownUntil)
				return false;
			return overridesLease || !state.ActorLeaseUntil.TryGetValue(actorId, out var leaseUntil) || worldTick >= leaseUntil;
		}

		static bool IsUsableActor(Actor actor, Player owner)
		{
			return actor.Owner == owner && actor.IsInWorld && !actor.IsDead && !actor.Disposed && actor.OccupiesSpace != null;
		}

		static bool CanAttack(Actor attacker, Actor target)
		{
			return AgentCombatRoster.CanAttack(attacker, target);
		}

		static Actor[] GetVisibleEnemies(World world, Player player)
		{
			return world.Actors
				.Where(a => a.IsInWorld && !a.IsDead && !a.Disposed && a.OccupiesSpace != null && a.Owner != null &&
					player.RelationshipWith(a.Owner) == PlayerRelationship.Enemy && a.CanBeViewedByPlayer(player) &&
					(a.EffectiveOwner?.Disguised != true || (a.EffectiveOwner.Owner != null &&
						player.RelationshipWith(a.EffectiveOwner.Owner) == player.RelationshipWith(a.Owner))))
				.OrderBy(a => a.ActorID)
				.ToArray();
		}

		static CPos FindBaseCell(World world, Player player)
		{
			return world.Actors
				.Where(a => IsUsableActor(a, player) && a.Info.HasTraitInfo<GivesBuildableAreaInfo>())
				.OrderBy(a => a.ActorID)
				.FirstOrDefault()?.Location ?? player.HomeLocation;
		}

		static void RemoveStale(Dictionary<uint, int> values, HashSet<uint> liveActorIds, int worldTick)
		{
			foreach (var actorId in values.Where(a => !liveActorIds.Contains(a.Key) || a.Value <= worldTick)
				.Select(a => a.Key).ToArray())
				values.Remove(actorId);
		}
	}
}
