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
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA.Browser
{
	/// <summary>
	/// Maintains long-running military commitments for one agent seat. This controller is
	/// deliberately unable to issue orders: it returns AgentAction intents that the browser
	/// host must pass through its normal BuildOrders and IssueAgentOrders boundary.
	/// </summary>
	static class AgentMissionController
	{
		internal const int MaxActiveMissions = 3;
		internal const int MaxMissionIdLength = 32;
		internal const int MaxRosterActors = 40;
		internal const int MaxOrdersPerEvaluation = 24;
		const int MaxEvents = 128;
		const int MaxSignals = 32;
		const int MaxVersionHistory = 128;
		const int EvaluationIntervalTicks = 10;
		const int ActorOrderIntervalTicks = 50;
		const int ReflexDetachPauseTicks = 250;
		const int SweepGridStride = 8;
		const int SweepWaypointChain = 4;
		const int SweepNoProgressTicks = 150;
		const int StrikeStagingTimeoutTicks = 750;
		const int RaidEngagementTicks = 750;
		const int StrikeNoProgressTicks = 189;
		const int StrikeQuietTicks = 250;
		const int StrikeRetreatTimeoutTicks = 500;
		const int StrikeStageRadiusSquared = 6 * 6;
		const int StrikeContactRadiusSquared = 12 * 12;
		const int StrikeConsolidationRadiusSquared = 8 * 8;
		const int StrikeQuietRadiusSquared = 10 * 10;
		const int PursueContactRadiusSquared = 15 * 15;
		const int PursueContactTimeoutTicks = 500;
		const int PursueExtrapolationCells = 8;
		const int ReinforceArrivalRadiusSquared = 6 * 6;
		const int AirTargetRadiusSquared = 10 * 10;
		const int AirRearmNoProgressTicks = 750;
		const int AirRearmTotalTimeoutTicks = 7500;
		const int AirAbortReturnTimeoutTicks = 750;

		internal sealed class State
		{
			public Dictionary<string, Mission> Active { get; } = new(StringComparer.Ordinal);
			public Dictionary<uint, string> ActorMission { get; } = [];
			public Dictionary<string, int> LatestVersions { get; } = new(StringComparer.Ordinal);
			public Queue<string> VersionHistory { get; } = [];
			public long NextEventSequence { get; set; } = 1;
			public Queue<Event> Events { get; } = [];
			public Queue<Signal> Signals { get; } = [];
			public int LastGroundOffensiveTerminalTick { get; set; } = -1;
			public SortedSet<uint> LastGroundOffensiveSurvivorIds { get; } = [];
		}

		internal sealed class Request
		{
			public string MissionId { get; init; }
			public int Version { get; init; }
			public string MissionType { get; init; }
			public string GroupName { get; init; }
			public CPos? TargetCell { get; init; }
			public CPos? ViaCell { get; init; }
			public string Posture { get; init; } = "assault";
			public string TargetPriority { get; init; } = "any";
			public int? ExploredPercentTarget { get; init; }
			public int? AbortLossPercent { get; init; }
			public int KnownEnemyStructureCount { get; init; }
			public IReadOnlyList<LegRequest> Legs { get; init; } = [];
			public string DestinationSquad { get; init; }
			public CPos? DestinationCell { get; init; }

			// For a destinationSquad the host supplies its current owned/live actor ids at commit.
			// The controller retains that snapshot, culls losses, and recomputes its live centroid each eval.
			public IReadOnlyList<uint> DestinationActorIds { get; init; } = [];
			public int? Sorties { get; init; }
			public int? MaxChaseCells { get; init; }

			// Internal doctrine-only policy. It is derived by the host from the active phase
			// and deliberately has no AgentAction/public schema field.
			public bool RequireEnemyStructureContact { get; init; }

			// Host integration hook: airStrike implies this even when the host leaves the flag false.
			// Validation still derives the authoritative capability from each actor's rules traits.
			public bool RequireAircraft { get; init; }
		}

		internal sealed class LegRequest
		{
			public string SquadName { get; init; }
			public CPos ViaCell { get; init; }
		}

		internal sealed class PreparedMission
		{
			internal Mission Candidate { get; init; }
			public string MissionId => Candidate.MissionId;
			public int Version => Candidate.Version;
			public IReadOnlyList<uint> StopActorIds { get; init; } = [];
		}

		internal sealed class PreparedControl
		{
			internal Mission Mission { get; init; }
			public string Command { get; init; }
			public IReadOnlyList<uint> StopActorIds { get; init; } = [];
			public IReadOnlyList<uint> SurvivingActorIds { get; init; } = [];
		}

		internal sealed class Mission
		{
			public string MissionId { get; init; }
			public int Version { get; init; }
			public string MissionType { get; init; }
			public string StepState { get; set; } = "planned";
			public int StateSinceTick { get; set; }
			public bool Paused { get; set; }
			public string PauseReason { get; set; }
			public CPos? TargetCell { get; init; }
			public string Posture { get; init; }
			public string TargetPriority { get; init; }
			public int ExploredPercentTarget { get; init; }
			public int AbortLossPercent { get; init; }
			public int InitialRosterCount { get; init; }

			// R5 bug 4: live units folded into the roster after creation (compiled reinforce). Lifts the
			// loss-abort denominator so a joined unit that dies is accounted against a roster that included it.
			public int ReinforcedCount { get; set; }
			public int LastEvaluationTick { get; set; } = -1;
			public int DetachedSinceTick { get; set; } = -1;
			public int LastExploredMilestone { get; set; }
			public int KnownEnemyStructureCount { get; set; }
			public bool DiscoveryReported { get; set; }
			public bool RequireEnemyStructureContact { get; init; }
			public int ContactPatrolIndex { get; set; }
			public bool RetreatWasAbort { get; set; }
			public string RetreatReason { get; set; }
			public int RetreatStartedTick { get; set; } = -1;
			public int QuietSinceTick { get; set; } = -1;
			public IReadOnlyList<Leg> Legs { get; init; } = [];
			public Leg Leg => Legs[0];
			public string DestinationSquad { get; init; }
			public CPos? DestinationCell { get; init; }
			public SortedSet<uint> DestinationActorIds { get; } = [];
			public int SortiesTarget { get; init; }
			public int SortiesCompleted { get; set; }
			public int AirEmptyAcquisitions { get; set; }
			public int AirReturnStartedTick { get; set; } = -1;
			public int AirLastAcquisitionTick { get; set; } = -1;
			public bool AirEndAfterReturn { get; set; }
			public bool AirSortieAttackIssued { get; set; }
			public bool AirReturnCountsSortie { get; set; }
			public string AirReturnReason { get; set; }
			public int AirRearmLastProgressTick { get; set; } = -1;
			public int AirRearmFullyRearmedCount { get; set; } = -1;
			public Dictionary<uint, int> AirRearmAmmoByActor { get; } = [];
			public Dictionary<uint, int> AirRearmBestDistanceSquaredByActor { get; } = [];
			public Dictionary<uint, string> AirRearmActorSetByActor { get; } = [];
			public HashSet<uint> AirRearmDockedActorIds { get; } = [];
			public HashSet<uint> AirReadyAtBaseActorIds { get; } = [];
			public int MaxChaseCells { get; init; }
			public CPos ChaseOriginCell { get; init; }
			public CPos? PreviousVisibleEnemyCentroid { get; set; }
			public CPos? LastVisibleEnemyCentroid { get; set; }
			public CPos? LastContactCell { get; set; }
			public CPos? ExtrapolatedWaypoint { get; set; }
			public int LastContactTick { get; set; } = -1;
			public bool PursuitExtrapolated { get; set; }
			public HashSet<uint> InitialRosterIds { get; } = [];
			public HashSet<uint> LostIds { get; } = [];
			public HashSet<uint> ReleasedIds { get; } = [];
			public HashSet<uint> DetachedIds { get; } = [];
			public Dictionary<uint, int> LastOrderTickByActor { get; } = [];
			public Dictionary<uint, SweepProgress> SweepProgressByActor { get; } = [];
			public Dictionary<CPos, int> SweepSectorFailures { get; } = [];
			public HashSet<CPos> UnreachableSweepSectors { get; } = [];
			public SortedSet<uint> PendingStopActorIds { get; } = [];
			public string PendingTerminalState { get; set; }
			public string PendingTerminalReason { get; set; }
			public string PendingTerminalSignalKind { get; set; }

			public IEnumerable<uint> RosterIds => Legs.SelectMany(leg => leg.RosterIds).Distinct();
			public bool Terminalizing => PendingTerminalState != null;
		}

		internal sealed class Leg
		{
			public string SquadName { get; init; }
			public CPos? ViaCell { get; init; }
			public SortedSet<uint> RosterIds { get; } = [];
			public bool Staged { get; set; }
			public CPos? RepathCell { get; set; }
			public bool RepathUsed { get; set; }
			public CPos WatchdogAnchor { get; set; }
			public int WatchdogBestDistanceSquared { get; set; } = int.MaxValue;
			public int WatchdogTick { get; set; } = -1;
			public int InitialRosterCount { get; init; }
		}

		internal sealed class SweepProgress
		{
			public CPos AnchorCell { get; set; }
			public int AnchorTick { get; set; }
			public CPos? AssignedSector { get; set; }
			public bool OrdersOutstanding { get; set; }
		}

		internal sealed class Intent
		{
			public string MissionId { get; init; }
			public int MissionVersion { get; init; }
			public string Kind { get; init; }
			public AgentAction Action { get; init; }
			public IReadOnlyList<uint> ActorIds { get; init; } = [];
			public CPos? Cell { get; init; }
			public string Reason { get; init; }
			public bool TerminalStop { get; init; }
			public bool PauseStop { get; init; }
			public bool CompleteReinforcementOnIssue { get; init; }

			// CP2 host contract: Type="returnToBase" must be translated to the raw synchronized
			// ReturnToBase order after owned/live/AircraftInfo/RearmableInfo/AcceptsOrder checks.
			public bool RequiresRawOrder { get; init; }
			public int ExpectedOrderCount => ActorIds.Count;
		}

		internal sealed class Event
		{
			public long Sequence { get; init; }
			public int WorldTick { get; init; }
			public string MissionId { get; init; }
			public int MissionVersion { get; init; }
			public string MissionType { get; init; }
			public string Kind { get; init; }
			public string State { get; init; }
			public uint ActorId { get; init; }
			public CPos? Cell { get; init; }
			public string Reason { get; init; }
		}

		internal sealed class EventBatch
		{
			public long LatestSequence { get; init; }
			public IReadOnlyList<Event> Events { get; init; } = [];
		}

		internal sealed class Signal
		{
			public string MissionId { get; init; }
			public int MissionVersion { get; init; }
			public string Kind { get; init; }
			public string Severity { get; init; }
			public CPos Cell { get; init; }
			public string Reason { get; init; }
		}

		internal sealed class Snapshot
		{
			public string MissionId { get; init; }
			public int MissionVersion { get; init; }
			public string MissionType { get; init; }
			public string State { get; init; }
			public bool Paused { get; init; }
			public string PauseReason { get; init; }
			public CPos? TargetCell { get; init; }
			public int Alive { get; init; }
			public int Initial { get; init; }
			public int LossesPercent { get; init; }
			public int DetachedCount { get; init; }
			public int SinceTick { get; init; }
			public IReadOnlyList<LegSnapshot> Legs { get; init; } = [];
		}

		internal sealed class LegSnapshot
		{
			public string Squad { get; init; }
			public bool Staged { get; init; }
			public int Alive { get; init; }
			public int Initial { get; init; }
		}

		internal delegate IReadOnlyList<uint> ResolveGroup(string groupName);

		// Prepare is read-only. The host must successfully build the replacement Stop orders before
		// Commit, then issue those prepared orders through the normal synchronized order boundary.
		internal static PreparedMission Prepare(State state, Request request, World world, Player owner,
			ResolveGroup resolveGroup)
		{
			ArgumentNullException.ThrowIfNull(state);
			ArgumentNullException.ThrowIfNull(request);
			ArgumentNullException.ThrowIfNull(world);
			ArgumentNullException.ThrowIfNull(owner);
			ArgumentNullException.ThrowIfNull(resolveGroup);
			ValidateMissionId(request.MissionId);
			if (request.Version < 1)
				throw new InvalidDataException("missionVersion must be at least 1");
			if (request.MissionType is not ("sweep" or "strike" or "pincer" or "airStrike" or "pursue" or "reinforce"))
				throw new InvalidDataException("missionType must be sweep, strike, pincer, airStrike, pursue, or reinforce");
			if (state.LatestVersions.TryGetValue(request.MissionId, out var latestVersion) && request.Version <= latestVersion)
				throw new InvalidDataException($"mission '{request.MissionId}' version must be greater than {latestVersion}");
			if (!state.Active.ContainsKey(request.MissionId) && state.Active.Count >= MaxActiveMissions)
				throw new InvalidDataException($"at most {MaxActiveMissions} missions may be active");

			var posture = request.Posture ?? "assault";
			var abortLossPercent = request.AbortLossPercent ??
				(request.MissionType is "sweep" or "airStrike" ? 50 :
				request.MissionType == "pursue" ? 30 : 40);
			if (abortLossPercent is < 10 or > 100)
				throw new InvalidDataException("abortLossPercent must be between 10 and 100");
			var exploredTarget = request.ExploredPercentTarget ?? 85;
			if (request.MissionType == "sweep" && !request.RequireEnemyStructureContact &&
				exploredTarget is < 50 or > 100)
				throw new InvalidDataException("exploredPercentTarget must be between 50 and 100");
			if (request.MissionType == "sweep" && request.RequireEnemyStructureContact &&
				exploredTarget is < 1 or > 100)
				throw new InvalidDataException("internal doctrine exploredPercentTarget must be between 1 and 100");

			var targetCell = request.TargetCell ?? request.DestinationCell;
			var targetPriority = request.TargetPriority ?? "any";
			if (request.MissionType is "strike" or "pincer" or "airStrike" or "pursue")
			{
				if (!targetCell.HasValue || !world.Map.Contains(targetCell.Value))
					throw new InvalidDataException($"{request.MissionType} target cell is outside the map");
			}

			if (request.MissionType is "strike" or "pincer")
			{
				if (posture is not ("assault" or "raid"))
					throw new InvalidDataException($"{request.MissionType} posture must be assault or raid");
				if (targetPriority is not ("any" or "economy" or "production" or "defenses"))
					throw new InvalidDataException("targetPriority must be any, economy, production, or defenses");
			}
			else if (request.MissionType == "airStrike" &&
				targetPriority is not ("any" or "economy" or "production" or "defenses"))
				throw new InvalidDataException("targetPriority must be any, economy, production, or defenses");

			var legRequests = new List<LegRequest>();
			if (request.MissionType is "strike" or "pincer")
			{
				if (request.Legs.Count != 0)
					legRequests.AddRange(request.Legs);
				else if (request.MissionType == "strike" && request.ViaCell.HasValue)
					legRequests.Add(new LegRequest { SquadName = request.GroupName, ViaCell = request.ViaCell.Value });

				var minLegs = request.MissionType == "pincer" ? 2 : 1;
				var maxLegs = request.MissionType == "pincer" ? 3 : 1;
				if (legRequests.Count < minLegs || legRequests.Count > maxLegs)
					throw new InvalidDataException($"{request.MissionType} requires between {minLegs} and {maxLegs} legs");
			}
			else
				legRequests.Add(new LegRequest { SquadName = request.GroupName, ViaCell = request.ViaCell ?? CPos.Zero });

			var normalizedNames = legRequests.Select(leg => AgentSquadController.ValidateName(leg.SquadName)).ToArray();
			if (normalizedNames.Distinct(StringComparer.Ordinal).Count() != normalizedNames.Length)
				throw new InvalidDataException("mission legs must name distinct squads");

			var legs = new List<Leg>();
			var allRosterIds = new SortedSet<uint>();
			for (var i = 0; i < legRequests.Count; i++)
			{
				var legRequest = legRequests[i];
				if (request.MissionType is "strike" or "pincer" && !world.Map.Contains(legRequest.ViaCell))
					throw new InvalidDataException($"{request.MissionType} via cell is outside the map");
				var roster = ResolveAndValidateRoster(resolveGroup(normalizedNames[i]), world, owner,
					request.MissionType, request.RequireAircraft || request.MissionType == "airStrike");
				if (request.MissionType == "airStrike")
					foreach (var actor in roster.Select(world.GetActorById))
						if (!HasCompatibleRearmActor(actor, world, owner))
							throw new InvalidDataException($"airStrike requires a compatible rearm actor for actor {actor.ActorID}");
				if (roster.Any(allRosterIds.Contains))
					throw new InvalidDataException("mission legs must not share actors");
				allRosterIds.UnionWith(roster);
				var leg = new Leg
				{
					SquadName = normalizedNames[i],
					ViaCell = request.MissionType is "strike" or "pincer" ? legRequest.ViaCell : null,
					InitialRosterCount = roster.Count
				};
				leg.RosterIds.UnionWith(roster);
				legs.Add(leg);
			}

			if (allRosterIds.Count > MaxRosterActors)
				throw new InvalidDataException($"mission roster must contain at most {MaxRosterActors} actors across all legs");
			foreach (var actorId in allRosterIds)
				if (state.ActorMission.TryGetValue(actorId, out var blocker) && blocker != request.MissionId)
					throw new InvalidDataException($"actor {actorId} is already committed to mission '{blocker}'");

			string destinationSquad = null;
			var destinationActorIds = Array.Empty<uint>();
			if (request.MissionType == "reinforce")
			{
				var hasSquad = !string.IsNullOrEmpty(request.DestinationSquad);
				if (hasSquad == targetCell.HasValue)
					throw new InvalidDataException("reinforce requires exactly one of destinationSquad or target cell");
				if (hasSquad)
				{
					destinationSquad = AgentSquadController.ValidateName(request.DestinationSquad);
					if (normalizedNames.Contains(destinationSquad, StringComparer.Ordinal))
						throw new InvalidDataException("reinforce source and destination squads must be different");
					var requestedDestination = request.DestinationActorIds.Count != 0 ?
						request.DestinationActorIds : resolveGroup(destinationSquad);
					destinationActorIds = requestedDestination.Distinct().Order()
						.Where(id => IsUsableOwnActor(world.GetActorById(id), owner)).ToArray();
					if (destinationActorIds.Length == 0)
						throw new InvalidDataException($"destination squad '{destinationSquad}' has no live actors");
					if (destinationActorIds.Any(allRosterIds.Contains))
						throw new InvalidDataException("reinforce source and destination squads must not share actors");
				}
				else if (!world.Map.Contains(targetCell.Value))
					throw new InvalidDataException("reinforce target cell is outside the map");
			}

			var sorties = request.Sorties ?? 3;
			if (request.MissionType == "airStrike" && sorties is < 1 or > 5)
				throw new InvalidDataException("sorties must be between 1 and 5");
			var maxChaseCells = request.MaxChaseCells ?? 25;
			if (request.MissionType == "pursue" && maxChaseCells is < 5 or > 60)
				throw new InvalidDataException("maxChaseCells must be between 5 and 60");

			var candidate = new Mission
			{
				MissionId = request.MissionId,
				Version = request.Version,
				MissionType = request.MissionType,
				StateSinceTick = world.WorldTick,
				TargetCell = targetCell,
				Posture = posture,
				TargetPriority = targetPriority,
				ExploredPercentTarget = exploredTarget,
				AbortLossPercent = abortLossPercent,
				InitialRosterCount = allRosterIds.Count,
				KnownEnemyStructureCount = request.KnownEnemyStructureCount,
				RequireEnemyStructureContact = request.RequireEnemyStructureContact,
				Legs = legs,
				DestinationSquad = destinationSquad,
				DestinationCell = request.MissionType == "reinforce" ? targetCell : null,
				SortiesTarget = request.MissionType == "airStrike" ? sorties : 0,
				MaxChaseCells = request.MissionType == "pursue" ? maxChaseCells : 0,
				ChaseOriginCell = request.MissionType == "pursue" ? targetCell.Value : CPos.Zero,
				LastVisibleEnemyCentroid = request.MissionType == "pursue" ? targetCell : null,
				LastContactCell = request.MissionType == "pursue" ? targetCell : null,
				LastContactTick = request.MissionType == "pursue" ? world.WorldTick : -1
			};
			candidate.DestinationActorIds.UnionWith(destinationActorIds);
			candidate.InitialRosterIds.UnionWith(allRosterIds);
			foreach (var actorId in allRosterIds)
			{
				var actor = world.GetActorById(actorId);
				candidate.SweepProgressByActor.Add(actorId, new SweepProgress
				{
					AnchorCell = actor.Location,
					AnchorTick = world.WorldTick
				});
			}

			var stopActorIds = state.Active.TryGetValue(request.MissionId, out var replaced)
				? LiveOrderableActorIds(replaced.RosterIds, world, owner, "Stop") : [];
			return new PreparedMission { Candidate = candidate, StopActorIds = stopActorIds };
		}

		internal static void Commit(State state, PreparedMission prepared, int worldTick)
		{
			var candidate = prepared.Candidate;
			if (state.Active.TryGetValue(candidate.MissionId, out var replaced))
			{
				Record(state, replaced, worldTick, replaced.StepState, 0, null,
					$"replaced by {candidate.MissionId} v{candidate.Version}", "replaced");
				RecordGroundOffensiveTerminal(state, replaced, worldTick, replaced.RosterIds);
				RemoveMembership(state, replaced);
			}

			state.Active[candidate.MissionId] = candidate;
			foreach (var actorId in candidate.RosterIds)
				state.ActorMission[actorId] = candidate.MissionId;
			RememberVersion(state, candidate.MissionId, candidate.Version);
			Record(state, candidate, worldTick, "planned", 0, candidate.TargetCell,
				$"accepted {candidate.MissionType} mission with {candidate.InitialRosterCount} actors");
		}

		// Control callers prebuild Stop orders from StopActorIds, commit the state change, issue the
		// orders, then report the subjects that survived validation with RecordControlStopsIssued.
		internal static PreparedControl PrepareControl(State state, string missionId, int missionVersion,
			string command, World world, Player owner)
		{
			ValidateMissionId(missionId);
			if (!state.Active.TryGetValue(missionId, out var mission) || mission.Version != missionVersion)
				throw new InvalidDataException($"mission '{missionId}' version {missionVersion} is not active");
			if (command is not ("pause" or "resume" or "cancel"))
				throw new InvalidDataException("mission command must be pause, resume, or cancel");
			if (command == "pause" && mission.Paused)
				throw new InvalidDataException($"mission '{missionId}' is already paused");
			if (command == "resume" && !mission.Paused)
				throw new InvalidDataException($"mission '{missionId}' is not paused");

			var stopActorIds = command is "pause" or "cancel"
				? LiveOrderableActorIds(mission.RosterIds.Where(id => !mission.DetachedIds.Contains(id)), world, owner, "Stop") : [];
			var survivors = mission.RosterIds.Where(id => IsUsableOwnActor(world.GetActorById(id), owner))
				.Distinct().Order().ToArray();
			return new PreparedControl
			{
				Mission = mission,
				Command = command,
				StopActorIds = stopActorIds,
				SurvivingActorIds = survivors
			};
		}

		internal static void CommitControl(State state, PreparedControl prepared, int worldTick)
		{
			var mission = prepared.Mission;
			switch (prepared.Command)
			{
				case "pause":
					mission.Paused = true;
					mission.PauseReason = "paused by commander";
					mission.PendingStopActorIds.UnionWith(prepared.StopActorIds);
					Record(state, mission, worldTick, mission.StepState, 0, mission.TargetCell, mission.PauseReason);
					break;
				case "resume":
					mission.Paused = false;
					mission.PauseReason = null;
					mission.PendingStopActorIds.Clear();
					mission.DetachedSinceTick = -1;
					Record(state, mission, worldTick, mission.StepState, 0, mission.TargetCell, "resumed by commander");
					break;
				case "cancel":
					mission.PendingStopActorIds.UnionWith(prepared.StopActorIds);
					BeginTerminal(state, mission, worldTick, "aborted", "cancelled by commander", "missionAborted",
						prepared.SurvivingActorIds);
					break;
			}
		}

		static void EvaluatePursue(State state, Mission mission, World world, Player owner, Actor[] visibleEnemies,
			List<Intent> intents)
		{
			var ordered = LiveMissionActors(mission, world, owner)
				.Where(actor => !mission.DetachedIds.Contains(actor.ActorID)).OrderBy(actor => actor.ActorID).ToArray();
			if (ordered.Length == 0)
				return;
			if (mission.StepState == "planned")
				Transition(state, mission, world.WorldTick, "chasing", "pursuit started from last visible contact");

			var centroid = Centroid(ordered);
			var leashSquared = mission.MaxChaseCells * mission.MaxChaseCells;
			var contacts = VisibleNear(visibleEnemies, centroid, PursueContactRadiusSquared)
				.Where(actor => (actor.Location - mission.ChaseOriginCell).LengthSquared <= leashSquared)
				.OrderBy(actor => actor.ActorID).ToArray();
			if (contacts.Length != 0)
			{
				var contactCentroid = Centroid(contacts);
				if (!mission.LastVisibleEnemyCentroid.HasValue ||
					mission.LastVisibleEnemyCentroid.Value != contactCentroid)
				{
					mission.PreviousVisibleEnemyCentroid = mission.LastVisibleEnemyCentroid;
					mission.LastVisibleEnemyCentroid = contactCentroid;
				}

				mission.LastContactCell = contactCentroid;
				mission.LastContactTick = world.WorldTick;
				mission.PursuitExtrapolated = false;
				mission.ExtrapolatedWaypoint = null;
				foreach (var actor in ordered.Where(actor => actor.IsIdle))
				{
					if (intents.Sum(i => i.ExpectedOrderCount) >= MaxOrdersPerEvaluation)
						break;
					if (!CanReorder(mission, actor.ActorID, world.WorldTick))
						continue;
					var target = RankTargets(contacts, "any", actor.Location, false)
						.FirstOrDefault(candidate => CanAttack(actor, candidate));
					if (target == null)
						continue;
					intents.Add(new Intent
					{
						MissionId = mission.MissionId,
						MissionVersion = mission.Version,
						Kind = "pursueContact",
						Action = new AgentAction
						{
							Type = "attack",
							ActorIds = [actor.ActorID],
							TargetActorId = target.ActorID
						},
						ActorIds = [actor.ActorID],
						Cell = target.Location,
						Reason = "attacking a currently visible retreating contact"
					});
				}

				return;
			}

			if (world.WorldTick - mission.LastContactTick >= PursueContactTimeoutTicks)
			{
				var reason = mission.LastContactCell.HasValue ?
					$"no re-contact for {PursueContactTimeoutTicks} ticks; last contact {mission.LastContactCell.Value.X},{mission.LastContactCell.Value.Y}" :
					$"no re-contact for {PursueContactTimeoutTicks} ticks";
				Record(state, mission, world.WorldTick, "chasing", 0, mission.LastContactCell, reason);
				BeginTerminal(state, mission, world.WorldTick, "completed", reason, "missionComplete");
				AddStopIntent(mission, intents, true, false);
				return;
			}

			if (!mission.PursuitExtrapolated)
			{
				var canExtrapolate = mission.PreviousVisibleEnemyCentroid.HasValue &&
					mission.LastVisibleEnemyCentroid.HasValue &&
					mission.PreviousVisibleEnemyCentroid.Value != mission.LastVisibleEnemyCentroid.Value;
				mission.ExtrapolatedWaypoint = canExtrapolate ? ExtrapolatedPursuitCell(world, mission) :
					ClampToLeash(world, mission, mission.LastContactCell ?? mission.TargetCell.Value);
				mission.PursuitExtrapolated = true;
				if (canExtrapolate)
					Record(state, mission, world.WorldTick, "chasing", 0, mission.ExtrapolatedWaypoint,
						"one fog-safe extrapolated chase waypoint selected");
			}

			var destination = mission.ExtrapolatedWaypoint ?? ClampToLeash(world, mission,
				mission.LastContactCell ?? mission.TargetCell.Value);
			AddMovementIntents(mission, ordered, destination, "attackMove", "chasing", intents);
		}

		static void EvaluateReinforce(State state, Mission mission, World world, Player owner, List<Intent> intents)
		{
			var ordered = LiveMissionActors(mission, world, owner)
				.Where(actor => !mission.DetachedIds.Contains(actor.ActorID)).OrderBy(actor => actor.ActorID).ToArray();
			if (ordered.Length == 0)
				return;
			if (mission.StepState == "planned")
				Transition(state, mission, world.WorldTick, "moving", "reinforcements moving to destination");

			Actor[] destinationActors = [];
			CPos destination;
			if (mission.DestinationSquad != null)
			{
				mission.DestinationActorIds.RemoveWhere(actorId =>
					!IsUsableOwnActor(world.GetActorById(actorId), owner));
				destinationActors = mission.DestinationActorIds.Select(world.GetActorById)
					.Where(actor => IsUsableOwnActor(actor, owner)).OrderBy(actor => actor.ActorID).ToArray();
				if (destinationActors.Length == 0)
				{
					BeginTerminal(state, mission, world.WorldTick, "completed", "destination lost", "missionComplete");
					AddStopIntent(mission, intents, true, false);
					return;
				}

				destination = Centroid(destinationActors);
			}
			else
				destination = mission.DestinationCell.Value;

			var arrived = ordered.Count(actor =>
				(actor.Location - destination).LengthSquared <= ReinforceArrivalRadiusSquared);

			// Guarding a destination squad naturally pulls stragglers toward its
			// leader, but a fixed-cell mission has no later convergence order. Do
			// not declare it complete and stop laggards short of the destination.
			var arrivalPercent = mission.DestinationSquad == null ? 100 : 60;
			if (arrived * 100 < ordered.Length * arrivalPercent)
			{
				AddMovementIntents(mission, ordered, destination, "attackMove", "reinforcing", intents);
				return;
			}

			if (mission.StepState != "arrived")
				Transition(state, mission, world.WorldTick, "arrived", "reinforcement reached destination");
			var guardTarget = destinationActors.FirstOrDefault(actor => actor.Info.HasTraitInfo<GuardableInfo>());
			var canAllGuard = guardTarget != null && ordered.All(actor =>
				actor.Info.HasTraitInfo<GuardInfo>() && actor.AcceptsOrder("Guard"));
			if (canAllGuard)
			{
				var guards = ordered.Select(actor => actor.ActorID).Order().ToArray();
				intents.Add(new Intent
				{
					MissionId = mission.MissionId,
					MissionVersion = mission.Version,
					Kind = "reinforcementGuard",
					Action = new AgentAction
					{
						Type = "guard",
						ActorIds = [.. guards],
						TargetActorId = guardTarget.ActorID
					},
					ActorIds = guards,
					Cell = destination,
					Reason = $"guarding destination squad leader {guardTarget.ActorID}",
					CompleteReinforcementOnIssue = true
				});
				return;
			}

			var stopActorIds = LiveOrderableActorIds(ordered.Select(actor => actor.ActorID), world, owner, "Stop");
			if (stopActorIds.Count == 0)
				return;
			intents.Add(new Intent
			{
				MissionId = mission.MissionId,
				MissionVersion = mission.Version,
				Kind = "reinforcementHold",
				Action = new AgentAction { Type = "stop", ActorIds = [.. stopActorIds] },
				ActorIds = stopActorIds,
				Cell = destination,
				Reason = "holding at reinforcement destination because no Guard target is available",
				CompleteReinforcementOnIssue = true
			});
		}

		static void EvaluateAirStrike(State state, Mission mission, World world, Player owner, Actor[] visibleEnemies,
			List<Intent> intents)
		{
			var aircraft = LiveMissionActors(mission, world, owner)
				.Where(actor => !mission.DetachedIds.Contains(actor.ActorID)).OrderBy(actor => actor.ActorID).ToArray();
			if (aircraft.Length == 0)
				return;
			if (mission.StepState == "planned")
				Transition(state, mission, world.WorldTick, "sortie(1)", "first air sortie launched");

			if (mission.StepState == "aborting")
			{
				if (AirReadyAtBase(mission, aircraft, world, owner) ||
					world.WorldTick - mission.AirReturnStartedTick >= AirAbortReturnTimeoutTicks)
				{
					BeginTerminal(state, mission, world.WorldTick, "aborted", mission.AirReturnReason, null);
					AddStopIntent(mission, intents, true, false);
					return;
				}

				AddReturnToBaseIntents(mission, aircraft, intents);
				return;
			}

			if (mission.StepState.StartsWith("rearming(", StringComparison.Ordinal))
			{
				if (AirReadyAtBase(mission, aircraft, world, owner))
				{
					if (mission.AirReturnCountsSortie)
					{
						mission.SortiesCompleted++;
						Record(state, mission, world.WorldTick, mission.StepState, 0, mission.TargetCell,
							$"sortie {mission.SortiesCompleted} rearmed");
					}
					else
						Record(state, mission, world.WorldTick, mission.StepState, 0, mission.TargetCell,
							$"aircraft rearmed before sortie {mission.SortiesCompleted + 1}");
					mission.AirReturnCountsSortie = false;
					mission.AirSortieAttackIssued = false;
					if (mission.AirEndAfterReturn || mission.SortiesCompleted >= mission.SortiesTarget)
					{
						var reason = mission.AirEndAfterReturn ? mission.AirReturnReason :
							$"completed {mission.SortiesCompleted} sorties";
						BeginTerminal(state, mission, world.WorldTick, "completed", reason, "missionComplete");
						AddStopIntent(mission, intents, true, false);
						return;
					}

					mission.AirEmptyAcquisitions = 0;
					mission.AirLastAcquisitionTick = -1;
					mission.AirReturnStartedTick = -1;
					ResetAirRearmProgress(mission, -1);
					Transition(state, mission, world.WorldTick, $"sortie({mission.SortiesCompleted + 1})",
						$"sortie {mission.SortiesCompleted + 1} launched after rearm");
					return;
				}

				ObserveAirRearmProgress(mission, aircraft, world, owner);
				if (world.WorldTick - mission.AirReturnStartedTick >= AirRearmTotalTimeoutTicks)
				{
					BeginAirReturn(state, mission, world.WorldTick, "rearm exceeded total cap", true, false);
					return;
				}

				if (world.WorldTick - mission.AirRearmLastProgressTick >= AirRearmNoProgressTicks)
				{
					BeginAirReturn(state, mission, world.WorldTick, "rearm stalled", true, false);
					return;
				}

				AddReturnToBaseIntents(mission, aircraft, intents);
				return;
			}

			if (aircraft.Any(NeedsRearm))
			{
				BeginAirReturn(state, mission, world.WorldTick, "sortie expended ordnance", false,
					mission.AirSortieAttackIssued);
				AddReturnToBaseIntents(mission, aircraft, intents);
				return;
			}

			var targets = visibleEnemies
				.Where(actor => (actor.Location - mission.TargetCell.Value).LengthSquared <= AirTargetRadiusSquared)
				.Where(target => aircraft.Any(attacker => CanAttack(attacker, target)))
				.OrderBy(actor => actor.ActorID).ToArray();
			if (targets.Length != 0)
			{
				mission.AirEmptyAcquisitions = 0;
				foreach (var actor in aircraft)
				{
					if (intents.Sum(i => i.ExpectedOrderCount) >= MaxOrdersPerEvaluation)
						break;
					if (NeedsRearm(actor) || !CanReorder(mission, actor.ActorID, world.WorldTick))
						continue;
					var target = RankTargets(targets, mission.TargetPriority, actor.Location, false)
						.FirstOrDefault(candidate => CanAttack(actor, candidate));
					if (target == null)
						continue;
					intents.Add(new Intent
					{
						MissionId = mission.MissionId,
						MissionVersion = mission.Version,
						Kind = "airAttack",
						Action = new AgentAction
						{
							Type = "attack",
							ActorIds = [actor.ActorID],
							TargetActorId = target.ActorID
						},
						ActorIds = [actor.ActorID],
						Cell = target.Location,
						Reason = "attacking a currently visible air-strike target"
					});
				}

				return;
			}

			var centroid = Centroid(aircraft);
			if ((centroid - mission.TargetCell.Value).LengthSquared > AirTargetRadiusSquared)
			{
				AddMovementIntents(mission, aircraft, mission.TargetCell.Value, "move", "airApproach", intents);
				return;
			}

			if (mission.AirLastAcquisitionTick < 0 ||
				world.WorldTick - mission.AirLastAcquisitionTick >= ActorOrderIntervalTicks)
			{
				mission.AirLastAcquisitionTick = world.WorldTick;
				mission.AirEmptyAcquisitions++;
			}

			if (mission.AirEmptyAcquisitions < 2)
				return;

			mission.AirEndAfterReturn = true;
			BeginAirReturn(state, mission, world.WorldTick, "no targets after two visible acquisitions", false, false);
			AddReturnToBaseIntents(mission, aircraft, intents);
		}

		internal static void RecordControlStopsIssued(State state, PreparedControl prepared,
			IEnumerable<uint> issuedActorIds)
		{
			var mission = prepared.Mission;
			if (!state.Active.TryGetValue(mission.MissionId, out var active) || active != mission)
				return;

			foreach (var actorId in issuedActorIds.Distinct().Order())
				mission.PendingStopActorIds.Remove(actorId);
			if (mission.Terminalizing && mission.PendingStopActorIds.Count == 0)
				FinalizeMission(state, mission);
		}

		internal static IReadOnlyList<Intent> Evaluate(State state, World world, Player owner,
			AgentReflexController.State reflexes, int knownEnemyStructureCount)
		{
			var result = new List<Intent>();
			var visibleEnemies = VisibleEnemies(world, owner);
			foreach (var mission in state.Active.Values.OrderBy(m => m.MissionId, StringComparer.Ordinal).ToArray())
			{
				CullRoster(state, mission, world, owner);
				UpdateDetached(mission, reflexes, world.WorldTick);
				if (mission.RosterIds.Any() && LossesPercent(mission) >= mission.AbortLossPercent && !mission.Terminalizing &&
					mission.StepState is not ("retreating" or "aborting"))
				{
					if (mission.MissionType is "strike" or "pincer")
						BeginRetreat(state, mission, world.WorldTick, "loss threshold reached", true);
					else if (mission.MissionType == "airStrike")
						BeginAirReturn(state, mission, world.WorldTick, "loss threshold reached", true, false);
					else
						BeginTerminal(state, mission, world.WorldTick, "aborted", "loss threshold reached", "missionAborted");
				}

				if (!mission.RosterIds.Any() && !mission.Terminalizing)
					BeginTerminal(state, mission, world.WorldTick, "aborted", "no remaining units", "missionAborted");

				if (mission.PendingStopActorIds.Count != 0)
				{
					AddStopIntent(mission, result, mission.Terminalizing, mission.Paused, TerminalRegroupCell(mission));
					continue;
				}

				if (mission.Terminalizing)
				{
					FinalizeMission(state, mission);
					continue;
				}

				if (mission.Paused)
					continue;
				if (mission.LastEvaluationTick >= 0 && world.WorldTick - mission.LastEvaluationTick < EvaluationIntervalTicks)
					continue;

				mission.LastEvaluationTick = world.WorldTick;
				if (mission.DetachedIds.Count * 2 > mission.RosterIds.Count())
				{
					if (mission.DetachedSinceTick < 0)
						mission.DetachedSinceTick = world.WorldTick;
					else if (world.WorldTick - mission.DetachedSinceTick >= ReflexDetachPauseTicks)
					{
						mission.Paused = true;
						mission.PauseReason = "base emergency pulled the force";
						mission.PendingStopActorIds.UnionWith(mission.RosterIds.Where(id => !mission.DetachedIds.Contains(id)));
						Record(state, mission, world.WorldTick, mission.StepState, 0, mission.TargetCell, mission.PauseReason);
						QueueSignal(state, mission, "missionMilestone", "warning", mission.TargetCell ?? owner.HomeLocation,
							mission.PauseReason);
						AddStopIntent(mission, result, false, true);
						continue;
					}
				}
				else
					mission.DetachedSinceTick = -1;

				switch (mission.MissionType)
				{
					case "sweep":
						EvaluateSweep(state, mission, world, owner, knownEnemyStructureCount, result);
						break;
					case "strike":
					case "pincer":
						EvaluateStrike(state, mission, world, owner, visibleEnemies, result);
						break;
					case "pursue":
						EvaluatePursue(state, mission, world, owner, visibleEnemies, result);
						break;
					case "reinforce":
						EvaluateReinforce(state, mission, world, owner, result);
						break;
					case "airStrike":
						EvaluateAirStrike(state, mission, world, owner, visibleEnemies, result);
						break;
				}
			}

			return result;
		}

		internal static void RecordIssued(State state, Intent intent, IEnumerable<uint> issuedActorIds, int worldTick)
		{
			if (!state.Active.TryGetValue(intent.MissionId, out var mission) || mission.Version != intent.MissionVersion)
				return;

			var issued = issuedActorIds.Distinct().Order().ToArray();
			if (intent.Kind == "airAttack" && issued.Length != 0)
				mission.AirSortieAttackIssued = true;
			foreach (var actorId in issued)
			{
				mission.LastOrderTickByActor[actorId] = worldTick;
				if (mission.SweepProgressByActor.TryGetValue(actorId, out var progress))
				{
					progress.OrdersOutstanding = true;
					if (intent.Cell.HasValue)
						progress.AssignedSector = intent.Cell;
				}

				if (intent.TerminalStop || intent.PauseStop)
					mission.PendingStopActorIds.Remove(actorId);
			}

			if (intent.CompleteReinforcementOnIssue && issued.Length != 0 && !mission.Terminalizing)
			{
				var cell = intent.Cell ?? mission.DestinationCell ?? mission.TargetCell ?? CPos.Zero;
				Record(state, mission, worldTick, "arrived", 0, cell, "reinforcement arrived", "reinforcementArrived");
				QueueSignal(state, mission, "missionMilestone", "info", cell, "reinforcementArrived");
				CompleteWithoutStop(state, mission, worldTick, "reinforcement arrived");
				return;
			}

			if (mission.Terminalizing && mission.PendingStopActorIds.Count == 0)
				FinalizeMission(state, mission);
		}

		internal static void ReleaseActors(State state, IEnumerable<uint> actorIds, int worldTick)
		{
			foreach (var actorId in actorIds.Distinct().Order())
			{
				if (!state.ActorMission.TryGetValue(actorId, out var missionId) ||
					!state.Active.TryGetValue(missionId, out var mission))
					continue;

				foreach (var leg in mission.Legs)
					leg.RosterIds.Remove(actorId);
				mission.ReleasedIds.Add(actorId);
				mission.DetachedIds.Remove(actorId);
				mission.PendingStopActorIds.Remove(actorId);
				state.ActorMission.Remove(actorId);
				Record(state, mission, worldTick, mission.StepState, actorId, null,
					"commander override released actor", "actorReleased");
				if (!mission.RosterIds.Any() && !mission.Terminalizing)
					BeginTerminal(state, mission, worldTick, "aborted", "no remaining units", "missionAborted",
						mission.ReleasedIds);
			}
		}

		/// <summary>
		/// R5 bug 4: fold fresh reinforcements into a live ground-offensive mission's primary leg so they
		/// advance, stage, consolidate and regroup as part of the wave instead of trickling in as loose
		/// attack-move units. Only absorbs usable, unassigned own actors up to the roster cap, and lifts the
		/// loss-abort denominator so a joined unit that dies is accounted against a roster that included it.
		/// Returns the actor ids actually absorbed; the mission's own evaluation issues their movement.
		/// </summary>
		internal static IReadOnlyList<uint> Reinforce(State state, string missionId, IEnumerable<uint> actorIds,
			World world, Player owner, int worldTick)
		{
			if (missionId == null || !state.Active.TryGetValue(missionId, out var mission) ||
				mission.Terminalizing || !IsGroundOffensive(mission.MissionType) || mission.Legs.Count == 0)
				return [];

			var leg = mission.Legs[0];
			var added = new List<uint>();
			foreach (var actorId in actorIds.Distinct().Order())
			{
				if (mission.RosterIds.Count() + added.Count >= MaxRosterActors)
					break;
				if (state.ActorMission.ContainsKey(actorId) || mission.RosterIds.Contains(actorId))
					continue;
				if (!IsUsableOwnActor(world.GetActorById(actorId), owner))
					continue;

				leg.RosterIds.Add(actorId);
				state.ActorMission[actorId] = missionId;
				mission.ReinforcedCount++;
				added.Add(actorId);
			}

			if (added.Count != 0)
				Record(state, mission, worldTick, mission.StepState, 0, mission.TargetCell,
					$"reinforced {added.Count} into the live wave", "reinforcementJoined");
			return added;
		}

		internal static IReadOnlyList<Snapshot> GetObservation(State state)
		{
			return state.Active.Values.OrderBy(m => m.MissionId, StringComparer.Ordinal)
				.Take(MaxActiveMissions)
				.Select(m => new Snapshot
				{
					MissionId = m.MissionId,
					MissionVersion = m.Version,
					MissionType = m.MissionType,
					State = m.StepState,
					Paused = m.Paused,
					PauseReason = m.PauseReason,
					TargetCell = m.TargetCell,
					Alive = m.RosterIds.Count(),
					Initial = m.InitialRosterCount,
					LossesPercent = LossesPercent(m),
					DetachedCount = m.DetachedIds.Count,
					SinceTick = m.StateSinceTick,
					Legs = m.Legs.Select(leg => new LegSnapshot
					{
						Squad = leg.SquadName,
						Staged = leg.Staged,
						Alive = leg.RosterIds.Count,
						Initial = leg.InitialRosterCount
					}).ToArray()
				})
				.ToArray();
		}

		internal static EventBatch GetEvents(State state, long sinceSequence)
		{
			return new EventBatch
			{
				LatestSequence = state.NextEventSequence - 1,
				Events = state.Events.Where(e => e.Sequence > sinceSequence).ToArray()
			};
		}

		internal static IReadOnlyList<Signal> DrainSignals(State state)
		{
			var result = state.Signals.ToArray();
			state.Signals.Clear();
			return result;
		}

		static void EvaluateSweep(State state, Mission mission, World world, Player owner,
			int knownEnemyStructureCount, List<Intent> intents)
		{
			if (mission.StepState == "planned")
				Transition(state, mission, world.WorldTick, "sweeping", "sweep started");

			var survey = Survey(world, owner);
			var milestone = survey.ExploredPercent / 25 * 25;
			while (mission.LastExploredMilestone < milestone)
			{
				mission.LastExploredMilestone += 25;
				Record(state, mission, world.WorldTick, mission.StepState, 0, null,
					$"map exploration reached {mission.LastExploredMilestone}%");
			}

			var enemyStructureContact = knownEnemyStructureCount > mission.KnownEnemyStructureCount;
			if (!mission.DiscoveryReported && enemyStructureContact)
			{
				mission.DiscoveryReported = true;
				mission.KnownEnemyStructureCount = knownEnemyStructureCount;
				Record(state, mission, world.WorldTick, mission.StepState, 0, null, "new enemy structure discovered");
				QueueSignal(state, mission, "missionMilestone", "info", owner.HomeLocation,
					"sweep discovered a new enemy structure");
			}

			if (mission.RequireEnemyStructureContact && enemyStructureContact)
			{
				BeginTerminal(state, mission, world.WorldTick, "completed",
					"enemy structure contact established", "missionComplete");
				AddStopIntent(mission, intents, true, false);
				return;
			}

			if (!mission.RequireEnemyStructureContact && survey.ExploredPercent >= mission.ExploredPercentTarget)
			{
				BeginTerminal(state, mission, world.WorldTick, "completed",
					$"explored {survey.ExploredPercent}% of the map", "missionComplete");
				AddStopIntent(mission, intents, true, false);
				return;
			}

			if (mission.RequireEnemyStructureContact &&
				survey.ExploredPercent >= mission.ExploredPercentTarget && mission.StepState != "contact-seeking")
				Transition(state, mission, world.WorldTick, "contact-seeking",
					"exploration target reached without enemy structure contact");

			var available = survey.Unexplored.Where(c => !mission.UnreachableSweepSectors.Contains(c)).ToHashSet();
			IReadOnlyList<CPos> patrol = [];
			if (available.Count == 0 && !mission.RequireEnemyStructureContact)
			{
				BeginTerminal(state, mission, world.WorldTick, "completed", "no reachable sectors remain", "missionComplete");
				AddStopIntent(mission, intents, true, false);
				return;
			}

			if (available.Count == 0)
			{
				patrol = AgentDoctrineExecutor.SerpentineSectors(survey.Explored);
				if (patrol.Count == 0)
					return;
			}

			var reserved = new HashSet<CPos>();
			foreach (var actorId in mission.RosterIds.Order())
			{
				if (intents.Sum(i => i.ExpectedOrderCount) >= MaxOrdersPerEvaluation)
					break;
				if (mission.DetachedIds.Contains(actorId))
					continue;
				var actor = world.GetActorById(actorId);
				if (!IsUsableOwnActor(actor, owner))
					continue;
				var progress = mission.SweepProgressByActor[actorId];
				if (actor.Location != progress.AnchorCell)
				{
					progress.AnchorCell = actor.Location;
					progress.AnchorTick = world.WorldTick;
				}

				var stalled = progress.OrdersOutstanding && world.WorldTick - progress.AnchorTick >= SweepNoProgressTicks;
				if (stalled)
				{
					if (progress.AssignedSector.HasValue)
					{
						mission.SweepSectorFailures.TryGetValue(progress.AssignedSector.Value, out var failures);
						failures++;
						mission.SweepSectorFailures[progress.AssignedSector.Value] = failures;
						if (failures >= 2)
							mission.UnreachableSweepSectors.Add(progress.AssignedSector.Value);
					}

					progress.OrdersOutstanding = false;
					progress.AssignedSector = null;
					progress.AnchorTick = world.WorldTick;
				}
				else if (!actor.IsIdle || !CanReorder(mission, actorId, world.WorldTick))
					continue;

				var chain = new List<CPos>();
				var cursor = actor.Location;
				for (var i = 0; i < SweepWaypointChain; i++)
				{
					CPos? next;
					if (available.Count != 0)
					{
						next = available.Where(c => !reserved.Contains(c))
							.OrderBy(c => (c - cursor).LengthSquared).ThenBy(c => c.Y).ThenBy(c => c.X)
							.Select(c => (CPos?)c).FirstOrDefault();
					}
					else
					{
						next = null;
						for (var attempt = 0; attempt < patrol.Count; attempt++)
						{
							var candidate = patrol[mission.ContactPatrolIndex % patrol.Count];
							mission.ContactPatrolIndex = (mission.ContactPatrolIndex + 1) % patrol.Count;
							if (!reserved.Contains(candidate))
							{
								next = candidate;
								break;
							}
						}
					}

					if (!next.HasValue)
						break;
					chain.Add(next.Value);
					reserved.Add(next.Value);
					cursor = next.Value;
				}

				foreach (var pair in chain.Select((cell, index) => (cell, index)))
				{
					if (intents.Sum(i => i.ExpectedOrderCount) >= MaxOrdersPerEvaluation)
						break;
					var reason = available.Count == 0
						? $"contact patrol toward explored sector {pair.cell.X},{pair.cell.Y}"
						: $"sweeping toward sector {pair.cell.X},{pair.cell.Y}";
					intents.Add(ActionIntent(mission, "sweep", actorId, "attackMove", pair.cell,
						pair.index != 0, reason));
				}
			}
		}

		static void EvaluateStrike(State state, Mission mission, World world, Player owner, Actor[] visibleEnemies,
			List<Intent> intents)
		{
			var activeLegs = mission.Legs.Select(leg => new
			{
				Leg = leg,
				Actors = LiveLegActors(leg, world, owner)
					.Where(a => !mission.DetachedIds.Contains(a.ActorID)).OrderBy(a => a.ActorID).ToArray()
			}).ToArray();
			var ordered = activeLegs.SelectMany(entry => entry.Actors).OrderBy(a => a.ActorID).ToArray();
			if (ordered.Length == 0)
				return;
			if (activeLegs.Any(entry => entry.Leg.RosterIds.Count == 0) && mission.Legs.Count > 1 &&
				mission.StepState is "planned" or "staging")
			{
				BeginRetreat(state, mission, world.WorldTick, "pincer leg lost before staging", true);
				return;
			}

			var centroid = Centroid(ordered);
			switch (mission.StepState)
			{
				case "planned":
					foreach (var entry in activeLegs.Where(entry => entry.Actors.Length != 0))
						ResetWatchdog(entry.Leg, Centroid(entry.Actors), entry.Leg.ViaCell.Value, world.WorldTick);
					Transition(state, mission, world.WorldTick, "staging", "moving to staging cell");
					break;
				case "staging":
				{
					foreach (var entry in activeLegs.Where(entry => !entry.Leg.Staged && entry.Actors.Length != 0))
					{
						var stagedCount = entry.Actors.Count(a =>
							(a.Location - entry.Leg.ViaCell.Value).LengthSquared <= StrikeStageRadiusSquared);
						if (stagedCount * 100 < entry.Actors.Length * 60)
							continue;
						entry.Leg.Staged = true;
						Record(state, mission, world.WorldTick, "staging", 0, entry.Leg.ViaCell,
							$"leg '{entry.Leg.SquadName}' staged");
					}

					var timedOut = world.WorldTick - mission.StateSinceTick >= StrikeStagingTimeoutTicks;
					if (mission.Legs.All(leg => leg.Staged) || timedOut)
					{
						foreach (var entry in activeLegs.Where(entry => entry.Actors.Length != 0))
						{
							ResetWatchdog(entry.Leg, Centroid(entry.Actors), mission.TargetCell.Value, world.WorldTick);
						}

						Transition(state, mission, world.WorldTick, "advancing",
							timedOut ? "staging timeout; all legs advancing together" : "all legs staged; advancing together");
						return;
					}

					foreach (var entry in activeLegs.Where(entry => !entry.Leg.Staged))
						AddMovementIntents(mission, entry.Actors, entry.Leg.ViaCell.Value,
							"attackMove", "staging", intents);
					break;
				}

				case "advancing":
				{
					var nearby = activeLegs.Where(entry => entry.Actors.Length != 0)
						.SelectMany(entry => VisibleNear(visibleEnemies, Centroid(entry.Actors), StrikeContactRadiusSquared))
						.DistinctBy(actor => actor.ActorID).OrderBy(actor => actor.ActorID).ToArray();
					if (nearby.Length != 0)
					{
						Transition(state, mission, world.WorldTick, "engaging", "visible enemy contact near strike force");
						return;
					}

					var arrived = ordered.Count(a => (a.Location - mission.TargetCell.Value).LengthSquared <= StrikeConsolidationRadiusSquared);
					if (arrived * 2 >= ordered.Length)
					{
						mission.QuietSinceTick = world.WorldTick;
						Transition(state, mission, world.WorldTick, "consolidating", "strike force reached target area");
						return;
					}

					foreach (var entry in activeLegs.Where(entry => entry.Actors.Length != 0))
					{
						if (ApplyStrikeWatchdog(state, mission, entry.Leg, world,
							Centroid(entry.Actors), entry.Actors, intents))
							return;
						AddMovementIntents(mission, entry.Actors, entry.Leg.RepathCell ?? mission.TargetCell.Value,
							"attackMove", "advancing", intents);
					}

					break;
				}

				case "engaging":
				{
					if (mission.Posture == "raid" && world.WorldTick - mission.StateSinceTick >= RaidEngagementTicks)
					{
						BeginRetreat(state, mission, world.WorldTick, "raid engagement window elapsed", false);
						return;
					}

					var nearby = activeLegs.Where(entry => entry.Actors.Length != 0)
						.SelectMany(entry => VisibleNear(visibleEnemies, Centroid(entry.Actors), StrikeContactRadiusSquared))
						.DistinctBy(actor => actor.ActorID).OrderBy(actor => actor.ActorID).ToArray();
					var priorityTargets = RankTargets(nearby, mission.TargetPriority, centroid,
						mission.Posture == "raid").ToArray();
					if (priorityTargets.Length == 0)
					{
						if (mission.QuietSinceTick < 0)
							mission.QuietSinceTick = world.WorldTick;
						if (mission.Posture == "raid")
						{
							if (world.WorldTick - mission.QuietSinceTick >= StrikeQuietTicks)
								BeginRetreat(state, mission, world.WorldTick, "no visible priority target", false);
							break;
						}

						Transition(state, mission, world.WorldTick, "consolidating", "no visible enemies remain nearby");
						return;
					}

					mission.QuietSinceTick = -1;
					foreach (var actor in ordered.Where(a => a.IsIdle))
					{
						if (intents.Sum(i => i.ExpectedOrderCount) >= MaxOrdersPerEvaluation)
							break;
						if (!CanReorder(mission, actor.ActorID, world.WorldTick))
							continue;
						var target = RankTargets(priorityTargets, mission.TargetPriority, actor.Location,
							mission.Posture == "raid").FirstOrDefault(t => CanAttack(actor, t));
						if (target == null)
							continue;
						intents.Add(new Intent
						{
							MissionId = mission.MissionId,
							MissionVersion = mission.Version,
							Kind = "engage",
							Action = new AgentAction { Type = "attack", ActorIds = [actor.ActorID], TargetActorId = target.ActorID },
							ActorIds = [actor.ActorID],
							Cell = target.Location,
							Reason = "attacking a currently visible target"
						});
					}

					break;
				}

				case "consolidating":
				{
					var nearby = visibleEnemies.Where(a => (a.Location - mission.TargetCell.Value).LengthSquared <= StrikeQuietRadiusSquared).ToArray();
					if (nearby.Length != 0)
					{
						mission.QuietSinceTick = -1;
						Transition(state, mission, world.WorldTick, "engaging", "enemy contact resumed near target");
						return;
					}

					if (mission.QuietSinceTick < 0)
						mission.QuietSinceTick = world.WorldTick;
					var present = ordered.Count(a => (a.Location - mission.TargetCell.Value).LengthSquared <= StrikeConsolidationRadiusSquared);
					if (present * 2 >= ordered.Length && world.WorldTick - mission.QuietSinceTick >= StrikeQuietTicks)
					{
						BeginTerminal(state, mission, world.WorldTick, "completed", "target area consolidated", "missionComplete");
						AddStopIntent(mission, intents, true, false, TerminalRegroupCell(mission));
						return;
					}

					AddMovementIntents(mission, ordered, mission.TargetCell.Value, "attackMove", "consolidating", intents);
					break;
				}

				case "retreating":
				{
					var home = activeLegs.Sum(entry => entry.Actors.Count(a =>
						(a.Location - entry.Leg.ViaCell.Value).LengthSquared <= StrikeStageRadiusSquared));
					if (home * 100 >= ordered.Length * 60 ||
						world.WorldTick - mission.RetreatStartedTick >= StrikeRetreatTimeoutTicks)
					{
						BeginTerminal(state, mission, world.WorldTick,
							mission.RetreatWasAbort ? "aborted" : "completed", mission.RetreatReason,
							mission.RetreatWasAbort ? null : "missionComplete");
						AddStopIntent(mission, intents, true, false, TerminalRegroupCell(mission));
						return;
					}

					foreach (var entry in activeLegs)
						AddMovementIntents(mission, entry.Actors, entry.Leg.ViaCell.Value, "move", "retreating", intents);
					break;
				}
			}
		}

		static bool ApplyStrikeWatchdog(State state, Mission mission, Leg leg, World world, CPos centroid,
			IReadOnlyList<Actor> actors, List<Intent> intents)
		{
			var destination = leg.RepathCell ?? mission.TargetCell.Value;
			var distance = (centroid - destination).LengthSquared;
			if (distance < leg.WatchdogBestDistanceSquared)
			{
				leg.WatchdogBestDistanceSquared = distance;
				leg.WatchdogAnchor = centroid;
				leg.WatchdogTick = world.WorldTick;
			}

			if (leg.RepathCell.HasValue && distance <= StrikeStageRadiusSquared)
			{
				leg.RepathCell = null;
				ResetWatchdog(leg, centroid, mission.TargetCell.Value, world.WorldTick);
				return false;
			}

			if (world.WorldTick - leg.WatchdogTick < StrikeNoProgressTicks)
				return false;
			if (leg.RepathUsed)
			{
				BeginRetreat(state, mission, world.WorldTick, "path blocked", true);
				return true;
			}

			leg.RepathUsed = true;
			leg.RepathCell = PerpendicularRepathCell(world, centroid, mission.TargetCell.Value);
			ResetWatchdog(leg, centroid, leg.RepathCell.Value, world.WorldTick);
			AddMovementIntents(mission, actors, leg.RepathCell.Value, "attackMove", "repath", intents);
			Record(state, mission, world.WorldTick, "advancing", 0, leg.RepathCell,
				$"leg '{leg.SquadName}' issued one deterministic path-block re-route");
			return true;
		}

		static void AddMovementIntents(Mission mission, IEnumerable<Actor> actors, CPos cell, string type,
			string kind, List<Intent> intents)
		{
			foreach (var actor in actors)
			{
				if (intents.Sum(i => i.ExpectedOrderCount) >= MaxOrdersPerEvaluation)
					return;
				if (!actor.IsIdle && (actor.Location - cell).LengthSquared <= StrikeStageRadiusSquared)
					continue;
				if (!CanReorder(mission, actor.ActorID, actor.World.WorldTick))
					continue;

				intents.Add(ActionIntent(mission, kind, actor.ActorID, type, cell, false,
					$"{kind} toward cell {cell.X},{cell.Y}"));
			}
		}

		static Intent ActionIntent(Mission mission, string kind, uint actorId, string actionType, CPos cell,
			bool queued, string reason)
		{
			return new Intent
			{
				MissionId = mission.MissionId,
				MissionVersion = mission.Version,
				Kind = kind,
				Action = new AgentAction
				{
					Type = actionType,
					ActorIds = [actorId],
					CellX = cell.X,
					CellY = cell.Y,
					Queued = queued
				},
				ActorIds = [actorId],
				Cell = cell,
				Reason = reason
			};
		}

		// R5 bug 3: home-biased cell to regroup ground-offensive survivors to on terminal release (the
		// primary leg's staging via), or null for mission types with no such cell (they fall back to a hard
		// stop, unchanged).
		static CPos? TerminalRegroupCell(Mission mission)
		{
			return IsGroundOffensive(mission.MissionType) && mission.Legs.Count != 0 && mission.Leg.ViaCell.HasValue
				? mission.Leg.ViaCell
				: null;
		}

		static void AddStopIntent(Mission mission, List<Intent> intents, bool terminal, bool pause,
			CPos? regroupCell = null)
		{
			var remainingBudget = MaxOrdersPerEvaluation - intents.Sum(i => i.ExpectedOrderCount);
			if (remainingBudget <= 0 || mission.PendingStopActorIds.Count == 0)
				return;
			var actorIds = mission.PendingStopActorIds.Take(remainingBudget).ToArray();

			// On terminal release of a ground offensive, regroup survivors to a home-biased cell so they pull
			// back and stay useful (attack-moving home, still engaging) instead of going inert at the attack
			// point. The intent still carries TerminalStop, so the drain/finalize bookkeeping is unchanged. A
			// paused mission keeps the hard stop (hold in place while paused).
			var regroup = terminal && !pause && regroupCell.HasValue;
			intents.Add(new Intent
			{
				MissionId = mission.MissionId,
				MissionVersion = mission.Version,
				Kind = terminal ? (regroup ? "terminalRegroup" : "terminalStop") : "pauseStop",
				Action = regroup
					? new AgentAction
					{
						Type = "attackMove",
						ActorIds = [.. actorIds],
						CellX = regroupCell.Value.X,
						CellY = regroupCell.Value.Y
					}
					: new AgentAction { Type = "stop", ActorIds = [.. actorIds] },
				ActorIds = actorIds,
				Cell = regroup ? regroupCell : null,
				Reason = regroup
					? $"regrouping mission survivors to {regroupCell.Value.X},{regroupCell.Value.Y} instead of going inert"
					: terminal ? "stopping mission roster before terminal release" : "stopping mission roster while paused",
				TerminalStop = terminal,
				PauseStop = pause
			});
		}

		static void BeginRetreat(State state, Mission mission, int worldTick, string reason, bool aborted)
		{
			mission.RetreatWasAbort = aborted;
			mission.RetreatReason = reason;
			mission.RetreatStartedTick = worldTick;
			Transition(state, mission, worldTick, "retreating", reason);
			if (aborted)
				QueueSignal(state, mission, "missionAborted", "warning", mission.TargetCell ?? mission.Leg.ViaCell.Value, reason);
		}

		static void BeginAirReturn(State state, Mission mission, int worldTick, string reason, bool aborted,
			bool countsSortie)
		{
			mission.AirReturnReason = reason;
			mission.AirReturnStartedTick = worldTick;
			mission.AirReturnCountsSortie = countsSortie;
			ResetAirRearmProgress(mission, worldTick);
			Transition(state, mission, worldTick, aborted ? "aborting" : $"rearming({mission.SortiesCompleted + 1})", reason);
			if (aborted)
				QueueSignal(state, mission, "missionAborted", "warning", mission.TargetCell ?? CPos.Zero, reason);
		}

		static void CompleteWithoutStop(State state, Mission mission, int worldTick, string reason)
		{
			mission.StepState = "completed";
			mission.StateSinceTick = worldTick;
			var cell = mission.DestinationCell ?? mission.TargetCell ?? CPos.Zero;
			Record(state, mission, worldTick, "completed", 0, cell, reason);
			QueueSignal(state, mission, "missionComplete", "warning", cell, reason);
			FinalizeMission(state, mission);
		}

		static void BeginTerminal(State state, Mission mission, int worldTick, string terminalState, string reason,
			string signalKind, IEnumerable<uint> survivingActorIds = null)
		{
			if (mission.Terminalizing)
				return;
			RecordGroundOffensiveTerminal(state, mission, worldTick, survivingActorIds ?? mission.RosterIds);
			mission.PendingTerminalState = terminalState;
			mission.PendingTerminalReason = reason;
			mission.PendingTerminalSignalKind = signalKind;
			mission.StepState = terminalState;
			mission.StateSinceTick = worldTick;
			mission.PendingStopActorIds.UnionWith(mission.RosterIds.Where(id => !mission.DetachedIds.Contains(id)));
			Record(state, mission, worldTick, terminalState, 0, mission.TargetCell, reason);
			if (signalKind != null)
				QueueSignal(state, mission, signalKind, "warning", mission.TargetCell ?? mission.Leg.ViaCell ?? CPos.Zero, reason);
			if (mission.PendingStopActorIds.Count == 0)
				FinalizeMission(state, mission);
		}

		internal static bool IsGroundOffensive(string missionType)
		{
			return AgentDoctrineExecutor.IsGroundOffensive(missionType);
		}

		internal static void RecordGroundOffensiveTerminal(State state, Mission mission, int worldTick,
			IEnumerable<uint> survivingActorIds)
		{
			if (!IsGroundOffensive(mission.MissionType))
				return;

			state.LastGroundOffensiveTerminalTick = worldTick;
			state.LastGroundOffensiveSurvivorIds.Clear();
			state.LastGroundOffensiveSurvivorIds.UnionWith((survivingActorIds ?? []).Distinct().Order());
		}

		static void FinalizeMission(State state, Mission mission)
		{
			RemoveMembership(state, mission);
			state.Active.Remove(mission.MissionId);
		}

		static void RemoveMembership(State state, Mission mission)
		{
			foreach (var actorId in mission.RosterIds)
				if (state.ActorMission.TryGetValue(actorId, out var missionId) && missionId == mission.MissionId)
					state.ActorMission.Remove(actorId);
		}

		static void CullRoster(State state, Mission mission, World world, Player owner)
		{
			foreach (var actorId in mission.RosterIds.ToArray())
			{
				var actor = world.GetActorById(actorId);
				if (IsUsableOwnActor(actor, owner))
					continue;
				foreach (var leg in mission.Legs)
					leg.RosterIds.Remove(actorId);
				mission.LostIds.Add(actorId);
				mission.DetachedIds.Remove(actorId);
				mission.PendingStopActorIds.Remove(actorId);
				state.ActorMission.Remove(actorId);
			}
		}

		static void UpdateDetached(Mission mission, AgentReflexController.State reflexes, int worldTick)
		{
			mission.DetachedIds.Clear();
			foreach (var actorId in mission.RosterIds)
				if (reflexes.ReflexCooldownUntil.TryGetValue(actorId, out var cooldownUntil) && worldTick <= cooldownUntil)
					mission.DetachedIds.Add(actorId);
		}

		static void Transition(State state, Mission mission, int worldTick, string nextState, string reason)
		{
			if (mission.StepState == nextState)
				return;
			mission.StepState = nextState;
			mission.StateSinceTick = worldTick;
			Record(state, mission, worldTick, nextState, 0, mission.TargetCell, reason);
		}

		static void Record(State state, Mission mission, int worldTick, string eventState, uint actorId,
			CPos? cell, string reason, string kind = null)
		{
			state.Events.Enqueue(new Event
			{
				Sequence = state.NextEventSequence++,
				WorldTick = worldTick,
				MissionId = mission.MissionId,
				MissionVersion = mission.Version,
				MissionType = mission.MissionType,
				Kind = kind ?? eventState,
				State = eventState,
				ActorId = actorId,
				Cell = cell,
				Reason = reason
			});
			while (state.Events.Count > MaxEvents)
				state.Events.Dequeue();
		}

		static void QueueSignal(State state, Mission mission, string kind, string severity, CPos cell, string reason)
		{
			state.Signals.Enqueue(new Signal
			{
				MissionId = mission.MissionId,
				MissionVersion = mission.Version,
				Kind = kind,
				Severity = severity,
				Cell = cell,
				Reason = reason
			});
			while (state.Signals.Count > MaxSignals)
				state.Signals.Dequeue();
		}

		static CPos ExtrapolatedPursuitCell(World world, Mission mission)
		{
			var last = mission.LastVisibleEnemyCentroid ?? mission.TargetCell.Value;
			var previous = mission.PreviousVisibleEnemyCentroid ?? mission.ChaseOriginCell;
			var delta = last - previous;
			var scale = Math.Max(Math.Abs(delta.X), Math.Abs(delta.Y));
			var extrapolated = scale == 0 ? last : last + new CVec(
				delta.X * PursueExtrapolationCells / scale,
				delta.Y * PursueExtrapolationCells / scale);
			return ClampToLeash(world, mission, extrapolated);
		}

		static CPos ClampToLeash(World world, Mission mission, CPos cell)
		{
			var delta = cell - mission.ChaseOriginCell;
			var scale = Math.Max(Math.Abs(delta.X), Math.Abs(delta.Y));
			if (scale > mission.MaxChaseCells)
				delta = new CVec(
					delta.X * mission.MaxChaseCells / scale,
					delta.Y * mission.MaxChaseCells / scale);
			var maxDistanceSquared = mission.MaxChaseCells * mission.MaxChaseCells;
			while (delta.LengthSquared > maxDistanceSquared)
			{
				if (Math.Abs(delta.X) >= Math.Abs(delta.Y) && delta.X != 0)
					delta = new CVec(delta.X - Math.Sign(delta.X), delta.Y);
				else if (delta.Y != 0)
					delta = new CVec(delta.X, delta.Y - Math.Sign(delta.Y));
			}

			cell = mission.ChaseOriginCell + delta;
			return world.Map.Clamp(cell);
		}

		static void AddReturnToBaseIntents(Mission mission, IEnumerable<Actor> aircraft, List<Intent> intents)
		{
			foreach (var actor in aircraft.OrderBy(actor => actor.ActorID))
			{
				if (intents.Sum(i => i.ExpectedOrderCount) >= MaxOrdersPerEvaluation)
					return;
				if (!CanReorder(mission, actor.ActorID, actor.World.WorldTick) || !actor.AcceptsOrder("ReturnToBase"))
					continue;
				intents.Add(new Intent
				{
					MissionId = mission.MissionId,
					MissionVersion = mission.Version,
					Kind = "returnToBase",
					Action = new AgentAction { Type = "returnToBase", ActorIds = [actor.ActorID] },
					ActorIds = [actor.ActorID],
					Reason = "returning aircraft to a compatible rearm actor",
					RequiresRawOrder = true
				});
			}
		}

		static bool AirReadyAtBase(Mission mission, IEnumerable<Actor> aircraft, World world, Player owner)
		{
			var ordered = aircraft.OrderBy(actor => actor.ActorID).ToArray();
			var liveActorIds = ordered.Select(actor => actor.ActorID).ToHashSet();
			mission.AirReadyAtBaseActorIds.RemoveWhere(actorId => !liveActorIds.Contains(actorId));
			foreach (var actor in ordered)
			{
				if (!FullyRearmed(actor))
				{
					mission.AirReadyAtBaseActorIds.Remove(actor.ActorID);
					continue;
				}

				var rearmableInfo = actor.Info.TraitInfoOrDefault<RearmableInfo>();
				if (rearmableInfo == null)
					continue;
				var aircraftTrait = actor.TraitOrDefault<Aircraft>();
				if (aircraftTrait?.GetActorBelow() is Actor actorBelow && IsUsableOwnActor(actorBelow, owner) &&
					rearmableInfo.RearmActors.Contains(actorBelow.Info.Name))
				{
					mission.AirReadyAtBaseActorIds.Add(actor.ActorID);
					continue;
				}

				if (world.Actors.Any(candidate =>
					IsUsableOwnActor(candidate, owner) && rearmableInfo.RearmActors.Contains(candidate.Info.Name) &&
					(candidate.Location - actor.Location).LengthSquared <= ReinforceArrivalRadiusSquared))
					mission.AirReadyAtBaseActorIds.Add(actor.ActorID);
			}

			return ordered.All(actor => mission.AirReadyAtBaseActorIds.Contains(actor.ActorID));
		}

		static void ResetAirRearmProgress(Mission mission, int worldTick)
		{
			mission.AirRearmLastProgressTick = worldTick;
			mission.AirRearmFullyRearmedCount = -1;
			mission.AirRearmAmmoByActor.Clear();
			mission.AirRearmBestDistanceSquaredByActor.Clear();
			mission.AirRearmActorSetByActor.Clear();
			mission.AirRearmDockedActorIds.Clear();
			mission.AirReadyAtBaseActorIds.Clear();
		}

		static void ObserveAirRearmProgress(Mission mission, IEnumerable<Actor> aircraft, World world, Player owner)
		{
			var ordered = aircraft.OrderBy(actor => actor.ActorID).ToArray();
			var firstSample = mission.AirRearmFullyRearmedCount < 0;
			var progressed = false;
			var fullyRearmedCount = 0;
			var dockedActorIds = new HashSet<uint>();

			foreach (var actor in ordered)
			{
				var rearmable = actor.TraitOrDefault<Rearmable>();
				var ammoCount = rearmable?.RearmableAmmoPools.Sum(pool => pool.CurrentAmmoCount) ?? 0;
				if (!firstSample && mission.AirRearmAmmoByActor.TryGetValue(actor.ActorID, out var previousAmmo) &&
					ammoCount > previousAmmo)
					progressed = true;
				mission.AirRearmAmmoByActor[actor.ActorID] = ammoCount;

				var rearmableInfo = actor.Info.TraitInfoOrDefault<RearmableInfo>();
				var compatibleRearmActors = rearmableInfo == null ? [] : world.Actors
					.Where(candidate => IsUsableOwnActor(candidate, owner) &&
						rearmableInfo.RearmActors.Contains(candidate.Info.Name))
					.OrderBy(candidate => candidate.ActorID).ToArray();
				var rearmActorSet = string.Join(",", compatibleRearmActors.Select(candidate => candidate.ActorID));
				var rearmActorSetChanged = !firstSample &&
					mission.AirRearmActorSetByActor.TryGetValue(actor.ActorID, out var previousRearmActorSet) &&
					!string.Equals(rearmActorSet, previousRearmActorSet, StringComparison.Ordinal);
				mission.AirRearmActorSetByActor[actor.ActorID] = rearmActorSet;
				var distanceSquared = compatibleRearmActors
					.Select(candidate => (candidate.Location - actor.Location).LengthSquared)
					.DefaultIfEmpty(int.MaxValue).Min();
				var hasBestDistance = mission.AirRearmBestDistanceSquaredByActor
					.TryGetValue(actor.ActorID, out var bestDistanceSquared);
				if (rearmActorSetChanged)
				{
					mission.AirRearmBestDistanceSquaredByActor[actor.ActorID] = distanceSquared;
					progressed = true;
				}
				else
				{
					if (!firstSample && hasBestDistance && distanceSquared < bestDistanceSquared)
						progressed = true;
					if (!hasBestDistance || distanceSquared < bestDistanceSquared)
						mission.AirRearmBestDistanceSquaredByActor[actor.ActorID] = distanceSquared;
				}

				if (FullyRearmed(actor))
					fullyRearmedCount++;

				var aircraftTrait = actor.TraitOrDefault<Aircraft>();
				if (rearmableInfo != null &&
					aircraftTrait?.GetActorBelow() is Actor actorBelow &&
					IsUsableOwnActor(actorBelow, owner) && rearmableInfo.RearmActors.Contains(actorBelow.Info.Name))
				{
					dockedActorIds.Add(actor.ActorID);
					if (!firstSample && !mission.AirRearmDockedActorIds.Contains(actor.ActorID))
						progressed = true;
				}
			}

			if (!firstSample && fullyRearmedCount > mission.AirRearmFullyRearmedCount)
				progressed = true;
			mission.AirRearmFullyRearmedCount = fullyRearmedCount;
			mission.AirRearmDockedActorIds.Clear();
			mission.AirRearmDockedActorIds.UnionWith(dockedActorIds);
			if (progressed)
				mission.AirRearmLastProgressTick = world.WorldTick;
		}

		static bool HasCompatibleRearmActor(Actor aircraft, World world, Player owner)
		{
			var rearmableInfo = aircraft.Info.TraitInfoOrDefault<RearmableInfo>();
			return rearmableInfo != null && world.Actors.Any(candidate =>
				IsUsableOwnActor(candidate, owner) && rearmableInfo.RearmActors.Contains(candidate.Info.Name));
		}

		static bool NeedsRearm(Actor actor)
		{
			var rearmable = actor.TraitOrDefault<Rearmable>();
			return rearmable != null && rearmable.RearmableAmmoPools.Any(pool => !pool.HasFullAmmo);
		}

		static bool FullyRearmed(Actor actor)
		{
			var rearmable = actor.TraitOrDefault<Rearmable>();
			return rearmable == null || rearmable.RearmableAmmoPools.All(pool => pool.HasFullAmmo);
		}

		static IReadOnlyList<uint> ResolveAndValidateRoster(IReadOnlyList<uint> actorIds, World world, Player owner,
			string missionType, bool requireAircraft)
		{
			if (actorIds == null)
				throw new InvalidDataException("mission group does not exist");
			var roster = actorIds.Distinct().Order().ToArray();
			if (roster.Length is < 1 or > MaxRosterActors)
				throw new InvalidDataException($"mission roster must contain between 1 and {MaxRosterActors} actors");
			foreach (var actorId in roster)
			{
				var actor = world.GetActorById(actorId);
				if (!IsUsableOwnActor(actor, owner))
					throw new InvalidDataException($"actor {actorId} is stale, missing, or not owned by this agent");
				if (requireAircraft)
				{
					if (!actor.Info.HasTraitInfo<AircraftInfo>() || !actor.Info.HasTraitInfo<RearmableInfo>() ||
						!AgentCombatRoster.IsEligible(actor, owner, "Move", "ReturnToBase", "Stop"))
						throw new InvalidDataException($"actor {actorId} cannot participate in airStrike; an aircraft is required");
				}
				else if (!actor.Info.HasTraitInfo<AttackMoveInfo>() ||
					!AgentCombatRoster.IsEligible(actor, owner, "Move", "AttackMove", "Stop"))
					throw new InvalidDataException($"actor {actorId} cannot participate in {missionType}; a mobile attack-move unit is required");
			}

			return roster;
		}

		static IReadOnlyList<uint> LiveOrderableActorIds(IEnumerable<uint> actorIds, World world, Player owner, string orderName)
		{
			return actorIds.Select(world.GetActorById)
				.Where(a => IsUsableOwnActor(a, owner) && a.AcceptsOrder(orderName))
				.Select(a => a.ActorID).Distinct().Order().ToArray();
		}

		static IEnumerable<Actor> LiveMissionActors(Mission mission, World world, Player owner)
		{
			return mission.RosterIds.Select(world.GetActorById)
				.Where(a => a != null && a.IsInWorld && !a.IsDead && !a.Disposed && a.OccupiesSpace != null &&
					(owner == null || a.Owner == owner));
		}

		static IEnumerable<Actor> LiveLegActors(Leg leg, World world, Player owner)
		{
			return leg.RosterIds.Select(world.GetActorById)
				.Where(actor => actor != null && actor.IsInWorld && !actor.IsDead && !actor.Disposed &&
					actor.OccupiesSpace != null && actor.Owner == owner);
		}

		static Actor[] VisibleEnemies(World world, Player owner)
		{
			return world.Actors.Where(a => a.IsInWorld && !a.IsDead && !a.Disposed && a.OccupiesSpace != null &&
				a.Owner != null && owner.RelationshipWith(a.Owner) == PlayerRelationship.Enemy && a.CanBeViewedByPlayer(owner) &&
				(a.EffectiveOwner?.Disguised != true || (a.EffectiveOwner.Owner != null &&
					owner.RelationshipWith(a.EffectiveOwner.Owner) == owner.RelationshipWith(a.Owner))))
				.OrderBy(a => a.ActorID).ToArray();
		}

		static Actor[] VisibleNear(IEnumerable<Actor> visibleEnemies, CPos cell, int radiusSquared)
		{
			return visibleEnemies.Where(a => (a.Location - cell).LengthSquared <= radiusSquared)
				.OrderBy(a => a.ActorID).ToArray();
		}

		static IEnumerable<Actor> RankTargets(IEnumerable<Actor> actors, string priority, CPos origin, bool priorityOnly)
		{
			var ranked = actors.Select(actor => (Actor: actor, Rank: TargetRank(actor, priority)))
				.Where(item => !priorityOnly || item.Rank == 0)
				.OrderBy(item => item.Rank).ThenBy(item => (item.Actor.Location - origin).LengthSquared)
				.ThenBy(item => item.Actor.ActorID).Select(item => item.Actor);
			return ranked;
		}

		static int TargetRank(Actor actor, string priority)
		{
			var preferred = priority switch
			{
				"economy" => actor.Info.HasTraitInfo<HarvesterInfo>() || actor.Info.HasTraitInfo<RefineryInfo>(),
				"production" => actor.Info.HasTraitInfo<BuildingInfo>() && actor.Info.HasTraitInfo<ProductionInfo>(),
				"defenses" => actor.Info.HasTraitInfo<BuildingInfo>() && actor.Info.TraitInfos<AttackBaseInfo>().Count != 0,
				_ => true
			};
			return preferred ? 0 : 1;
		}

		static bool CanAttack(Actor attacker, Actor target)
		{
			var actorTarget = Target.FromActor(target);
			return attacker.TraitsImplementing<AttackBase>()
				.Any(a => !a.IsTraitDisabled && a.HasAnyValidWeapons(actorTarget));
		}

		static bool CanReorder(Mission mission, uint actorId, int worldTick)
		{
			return !mission.LastOrderTickByActor.TryGetValue(actorId, out var lastOrderTick) ||
				worldTick - lastOrderTick >= ActorOrderIntervalTicks;
		}

		static int LossesPercent(Mission mission)
		{
			var denominator = Math.Max(1,
				mission.InitialRosterCount + mission.ReinforcedCount - mission.ReleasedIds.Count);
			return mission.LostIds.Count * 100 / denominator;
		}

		static void ResetWatchdog(Leg leg, CPos anchor, CPos destination, int worldTick)
		{
			leg.WatchdogAnchor = anchor;
			leg.WatchdogBestDistanceSquared = (anchor - destination).LengthSquared;
			leg.WatchdogTick = worldTick;
		}

		static CPos PerpendicularRepathCell(World world, CPos origin, CPos target)
		{
			var delta = target - origin;
			var sx = Math.Sign(delta.X);
			var sy = Math.Sign(delta.Y);
			if (sx == 0 && sy == 0)
				sx = 1;
			var candidates = new[]
			{
				origin + new CVec(-sy * 8, sx * 8),
				origin + new CVec(sy * 8, -sx * 8)
			};
			return candidates.Where(world.Map.Contains)
				.OrderBy(c => (c - target).LengthSquared).ThenBy(c => c.Y).ThenBy(c => c.X)
				.FirstOrDefault(world.Map.Clamp(origin));
		}

		static CPos Centroid(IReadOnlyCollection<Actor> actors)
		{
			return new CPos(actors.Sum(a => a.Location.X) / actors.Count, actors.Sum(a => a.Location.Y) / actors.Count);
		}

		static SurveyResult Survey(World world, Player owner)
		{
			var sampled = 0;
			var explored = 0;
			var exploredSectors = new List<CPos>();
			var unexplored = new List<CPos>();
			for (var y = world.Map.Bounds.Top; y < world.Map.Bounds.Bottom; y += SweepGridStride)
				for (var x = world.Map.Bounds.Left; x < world.Map.Bounds.Right; x += SweepGridStride)
				{
					var cell = new CPos(x, y);
					if (!world.Map.Contains(cell))
						continue;
					sampled++;
					if (owner.Shroud.IsExplored(cell))
					{
						explored++;
						exploredSectors.Add(cell);
					}
					else
						unexplored.Add(cell);
				}

			return new SurveyResult
			{
				ExploredPercent = sampled == 0 ? 0 : explored * 100 / sampled,
				Explored = exploredSectors.ToArray(),
				Unexplored = unexplored.OrderBy(c => c.Y).ThenBy(c => c.X).ToArray()
			};
		}

		sealed class SurveyResult
		{
			public int ExploredPercent { get; init; }
			public IReadOnlyList<CPos> Explored { get; init; } = [];
			public IReadOnlyList<CPos> Unexplored { get; init; } = [];
		}

		static bool IsUsableOwnActor(Actor actor, Player owner)
		{
			return actor != null && actor.Owner == owner && actor.IsInWorld && !actor.IsDead && !actor.Disposed &&
				actor.OccupiesSpace != null;
		}

		static void ValidateMissionId(string missionId)
		{
			if (string.IsNullOrEmpty(missionId) || missionId.Length > MaxMissionIdLength ||
				missionId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_')))
				throw new InvalidDataException($"missionId must be 1-{MaxMissionIdLength} ASCII letters, digits, '-' or '_'");
		}

		static void RememberVersion(State state, string missionId, int version)
		{
			if (!state.LatestVersions.ContainsKey(missionId))
				state.VersionHistory.Enqueue(missionId);
			state.LatestVersions[missionId] = version;
			while (state.VersionHistory.Count > MaxVersionHistory)
			{
				var oldest = state.VersionHistory.Dequeue();
				if (!state.Active.ContainsKey(oldest))
					state.LatestVersions.Remove(oldest);
				else
					state.VersionHistory.Enqueue(oldest);
			}
		}
	}
}
