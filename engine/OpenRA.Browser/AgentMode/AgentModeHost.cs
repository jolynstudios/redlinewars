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
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using OpenRA.Mods.Common.Traits;
using OpenRA.Network;
using OpenRA.Primitives;
using OpenRA.Traits;
using OpenRA.Widgets;

namespace OpenRA.Browser
{
	public static class AgentModeHost
	{
		const string AgentBotType = "agent";
		const string OverlaySource = "/openra/browser/agent-rules.yaml";
		const string OverlayTarget = "/openra/engine/mods/ra/rules/browser-agent.yaml";
		const string ManifestPath = "/openra/engine/mods/ra/mod.yaml";
		const string ManifestRule = "ra|rules/browser-agent.yaml";
		const string BrowserAssembly = "OpenRA.Browser.dll";
		const int MaxProductionCount = 5;
		const int ObservationWarmupTicks = 25;
		const int GlobalDecisionCooldownTicks = 100;
		const int EventKeyCooldownTicks = 250;
		const int AlertLifetimeTicks = 500;
		const int MaxAlertStates = 64;
		const int AttackActiveTicks = 100;
		const int BaseThreatRadius = 12;
		const int BaseDefenseAttackerRadius = 20;
		const int MaterialEnemyValue = 500;
		const int MaxBenchmarkControlRegions = 64;
		const int MaxBenchmarkControlRegionCells = 4096;
		const string ReplayMetadataOrder = "AgentMatchMetadata";
		const string ConnectionFailedPanel = "CONNECTIONFAILED_PANEL";
		const string DoctrineScoutMissionId = "doctrine-scout";
		const int DoctrineStreamCooldownTicks = 50;

		// R3 reactive play/RTS-Agent preset standing-policy default: retreat a combat unit home once it drops
		// below this share of max HP. The pure-benchmark track keeps its as-is default (0 = off).
		const int PlayPresetRetreatBelowHpPercent = 25;
		static readonly string[] MilestoneTypes = ["powr", "proc", "barr", "weap", "fix", "dome"];

		sealed class CriticalActorSnapshot
		{
			public uint ActorId;
			public string Type;
			public CPos Cell;
			public int Health;
			public int MaxHealth;

			// Captured at scan time so continuity checks do not re-query disposed actors.
			public bool IsDeployableCritical;
			public bool IsConstructionCritical;
			public CPos? TransformCell;
			public string TransformIntoActor;
		}

		sealed class StaleDeployProof
		{
			public uint SourceActorId;
			public uint SuccessorActorId;
			public CPos TransformCell;
			public string SuccessorType;
			public int Tick;
		}

		sealed class ProductionEventState
		{
			public bool Ready;
			public bool IdleAffordable;
		}

		sealed class AlertState
		{
			public string Key;
			public AgentAlertObservation Alert;
			public int LastUpdatedTick;
		}

		sealed class AdjudicationControlRegion
		{
			public string Id;
			public HashSet<CPos> Cells;
		}

		sealed class AgentSlot
		{
			public readonly string Id;
			public readonly int Ordinal;
			public readonly string PlannedFaction;
			public readonly string PlannedFactionSide;
			public readonly string OpponentFaction;
			public Player Player;
			public AgentActionBatch StagedPlanningBatch;
			public bool StagedPlanningApplied;
			public long LastDecisionId = -1;
			public long LastOpportunityDecisionId = -1;
			public long LastFailureRequestDecisionId = -1;
			public int DecisionOpportunities;
			public int FallbackTurns;
			public double SpentUsd;
			public double SpendCapUsd;
			public long ObservationSequence;
			public uint FakeActorId;
			public CPos FakeStartCell;
			public bool EventStateInitialized;
			public bool EverSawEnemy;
			public bool EnemyContactSeen;
			public int LastEventScanTick = -1;
			public int LastDecisionTick = ObservationWarmupTicks - GlobalDecisionCooldownTicks;
			public int NextHeartbeatTick = ObservationWarmupTicks;
			public string PendingTrigger;
			public string PendingAlertKey;
			public int PendingPriority;
			public string ClaimedTrigger;
			public readonly Dictionary<uint, CriticalActorSnapshot> CriticalActors = [];
			public readonly Dictionary<uint, StaleDeployProof> StaleDeployProofs = [];
			public readonly Dictionary<string, ProductionEventState> ProductionStates = [];
			public readonly Dictionary<string, int> EventCooldownUntil = [];
			public readonly Dictionary<string, AlertState> AlertStates = [];
			public readonly Queue<AgentCriticalEventObservation> RecentCriticalEvents = [];
			public readonly Dictionary<string, int> CompletedMilestones = [];
			public PowerState LastPowerState = PowerState.Normal;
			public int LastVisibleEnemyValue;
			public int LastVisibleEnemyCount;
			public int LastNearbyEnemyCount;
			public readonly AgentReflexController.State Reflexes = new();
			public readonly AgentFogMemory.State FogMemory = new();
			public int KnownEnemyStructureCount;
			public readonly AgentSquadController.State Squads = new();
			public readonly AgentBuildPlanController.State BuildPlan = new();
			public readonly AgentMissionController.State Missions = new();
			public readonly AgentSituationDetector.State Situations = new();
			public readonly AgentSituationEngine.State SituationEngine = new();
			public readonly AgentStrategyController.State Strategy = new();
			public readonly AgentDoctrineController.State Doctrine = new();
			public readonly AgentDoctrineDecisionController.State DoctrineDecisions = new();
			public bool RequestInFlight;
			public long RequestDecisionId = -1;
			public string FallbackMissionId;
			public int FallbackMissionVersion;
			public IReadOnlyList<AgentSituationObservation> ActiveSituations = [];
			public long LastSupportPowerLaunchSequence;

			// War compiler (control harness): model commits (commitIntent/reinforceIntent); host
			// compiles the commit into missions + reinforce. Compiled counters fire ONLY after a
			// model commit, so the pure-generalship benchmark stays valid (no host last-resort path).
			public readonly AgentWarCompiler.State War = new();
			public int HostCompiledStrikeCount;
			public int HostCompiledReinforceCount;

			// BQ F4: compiled fuzzy disengage fires only under a live model war commit (a compiled counter,
			// not a last-resort one), so it does not break pureGeneralValid.
			public int HostCompiledDisengageCount;

			// BQ C1: reactive base defense (pure-safe body). EmergencyRally counts new units force-rallied to
			// auto-engage under sustained structure fire; StructureDefenseOrders counts garrison pulls issued.
			public int HostEmergencyRallyOrders;
			public int HostStructureDefenseOrders;

			// R3: proactive in-weapon-range first-strikes issued by the reactive play preset (pure-safe body).
			public int HostProactiveEngageOrders;
			public int HostScoutSweepCount;
			public int ModelCommitIntentCount;
			public int TimeToFirstCommitIntentTicks = -1;
			public int DribbleAttackMoveCount;

			// FIX-1 outcome-delta: fog-safe combat-loss tracking since the last model decision. Own/enemy
			// combat ids that leave the world OR fog count as lost (a momentum heuristic, advisory only —
			// the host never acts on it). Cleared by CountDecisionOpportunity so the delta is "since last
			// decision".
			public readonly HashSet<uint> TrackedOwnCombatIds = [];
			public readonly HashSet<uint> TrackedEnemyCombatIds = [];
			public int OutcomeEnemyCombatLost;
			public int OutcomeOwnCombatLost;

			// Explored-percent sampling is a whole-map walk; cache it on a slow
			// cadence for the situation scan (the observation's scouting block
			// keeps its own live survey).
			public int SituationExploredPercent;
			public int SituationExploredSampleTick = -10000;

			public AgentSlot(string id, int ordinal, string plannedFaction, string plannedFactionSide,
				string opponentFaction)
			{
				Id = id;
				Ordinal = ordinal;
				PlannedFaction = plannedFaction;
				PlannedFactionSide = plannedFactionSide;
				OpponentFaction = opponentFaction;
			}
		}

		static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
		{
			PropertyNameCaseInsensitive = false,
			UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
		};
		static readonly JsonSerializerOptions CanonicalJsonOptions = new(JsonOptions)
		{
			Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
		};

		static readonly List<AgentSlot> AgentSlots = [];
		static readonly Queue<string> PendingReplayTelemetry = [];
		static string matchId;
		static bool fakeAgents;
		static bool omniscientObservations;
		static bool advisorFallbackEnabled;
		static bool spectatorCameraCentered;
		static string opponentBotType;
		static Player opponentPlayer;
		static int decisionIntervalTicks;
		static double matchSpendCapUsd;
		static int fakePhase;
		static int nextFakeTick;
		static string fakeAgentStatus = "disabled";
		static bool rulesOverlayInstalled;
		static bool matchLaunched;
		static bool prematchPlanningEnabled;
		static bool strategyArsenalEnabled;
		static bool doctrineExecutorEnabled;
		static bool actionGuidanceEnabled;
		static bool doctrineFallbackStrikeEnabled;
		static bool staffSeatEnabled;
		static bool playCadenceEnabled;
		static bool benchmarkLockstepEnabled;
		static int benchmarkDecisionTimeoutMs;
		static AgentLockstepBarrier.State lockstepState;
		static AgentAdjudicationLedger.State adjudicationLedger;
		static readonly List<AdjudicationControlRegion> AdjudicationControlRegions = [];
		static readonly Dictionary<CPos, int> AdjudicationControlRegionByCell = [];
		static readonly HashSet<string> AdjudicationStructureTypes = new(StringComparer.Ordinal);
		static string adjudicationControlRegionHash;
		static bool adjudicationStructureCatalogInitialized;
		static readonly Dictionary<string, string> LockstepSnapshots = [];
		static int lockstepLastControllerWorldTick = -1;
		static bool lockstepStopPauseIssued;
		static string resolvedProfile;
		static int buildPlanStallWatchdogTicks;
		static int buildPlanInternalFailureWatchdogTicks;
		static bool planningWarmupResolved;
		static string planningFailureReason;
		static int planningTimeoutMs;
		static string preparedMapUid;
		static string preparedMapTitle;
		static Rectangle preparedMapBounds;
		static List<CPos> preparedSpawnPoints = [];
		static List<Order> preparedLaunchOrders = [];

		public static bool UsesBenchmarkLockstep()
		{
			return benchmarkLockstepEnabled;
		}

		public static void InstallRulesOverlay()
		{
			if (!File.Exists(OverlaySource))
				throw new FileNotFoundException("Agent mode rules overlay is missing.", OverlaySource);

			Directory.CreateDirectory(Path.GetDirectoryName(OverlayTarget));
			File.Copy(OverlaySource, OverlayTarget, true);

			var manifest = File.ReadAllText(ManifestPath);
			const string AssembliesMarker = "Assemblies:";
			var assembliesAt = manifest.IndexOf(AssembliesMarker, StringComparison.Ordinal);
			if (assembliesAt < 0)
				throw new InvalidDataException("Could not find the RA assembly manifest entry for the Agent mode trait.");
			var assembliesEnd = manifest.IndexOf('\n', assembliesAt);
			if (assembliesEnd < 0)
				assembliesEnd = manifest.Length;
			var assembliesLine = manifest[assembliesAt..assembliesEnd];
			if (!assembliesLine.Contains(BrowserAssembly, StringComparison.Ordinal))
				manifest = manifest.Insert(assembliesEnd, $", {BrowserAssembly}");

			if (!manifest.Contains($"\t{ManifestRule}\n", StringComparison.Ordinal))
			{
				const string Marker = "\nSequences:";
				var insertAt = manifest.IndexOf(Marker, StringComparison.Ordinal);
				if (insertAt < 0)
					throw new InvalidDataException("Could not find the RA Rules manifest boundary for the Agent mode overlay.");

				manifest = manifest.Insert(insertAt, $"\t{ManifestRule}\n");
			}

			File.WriteAllText(ManifestPath, manifest);
			rulesOverlayInstalled = true;
			Console.WriteLine($"[AGENT-A0] installed rules overlay {ManifestRule}");
		}

		public static string StartMatch(string requestedMapUid, string configJson)
		{
			var prepared = PrepareMatch(requestedMapUid, configJson);
			if (IsErrorResult(prepared))
				return prepared;

			using var document = JsonDocument.Parse(prepared);
			var preparedMatchId = document.RootElement.GetProperty("matchId").GetString();
			var launched = LaunchPreparedMatch(preparedMatchId);
			return IsErrorResult(launched) ? launched : prepared;
		}

		internal static void NotifyDamage(Actor damaged, Actor attacker)
		{
			var world = damaged?.World;
			if (!doctrineExecutorEnabled || matchId == null || !matchLaunched || world?.Type != WorldType.Regular ||
				damaged.Owner == null ||
				!damaged.IsInWorld || damaged.IsDead || damaged.Disposed || !damaged.Info.HasTraitInfo<BuildingInfo>() ||
				IsCriticalAsset(damaged))
				return;

			var slot = AgentSlots.FirstOrDefault(candidate => candidate.Player == damaged.Owner);
			if (slot == null)
				return;
			var visibleEnemies = GetVisibleEnemies(world, slot.Player);
			var key = $"structureAttacked:{damaged.ActorID}";
			RaiseAlert(slot, world, key, "structureAttacked", "warning", damaged.ActorID,
				damaged.Location, visibleEnemies, false);
			if (slot.AlertStates.TryGetValue(key, out var alert))
				alert.Alert.Detail = attacker != null && attacker.CanBeViewedByPlayer(slot.Player)
					? $"structure {damaged.ActorID} damaged by visible attacker {attacker.ActorID}"
					: $"structure {damaged.ActorID} took damage";
		}

		internal static void NotifyKilled(Actor destroyed)
		{
			if (!benchmarkLockstepEnabled || adjudicationLedger == null || matchId == null || !matchLaunched ||
				destroyed?.Owner == null)
				return;

			var victim = AgentSlots.FirstOrDefault(candidate => candidate.Player == destroyed.Owner);
			if (victim == null)
				return;
			InitializeAdjudicationStructureTypes(destroyed.World);

			var replacementValue = ActorValue(destroyed);
			if (replacementValue <= 0)
				return;

			AgentAdjudicationLedger.DestroyedKind? kind = null;
			if (destroyed.Info.HasTraitInfo<BuildingInfo>() &&
				AdjudicationStructureTypes.Contains(destroyed.Info.Name))
				kind = AgentAdjudicationLedger.DestroyedKind.Structure;
			else if (AgentCombatRoster.IsEligibleType(destroyed.Info))
				kind = AgentAdjudicationLedger.DestroyedKind.CombatUnit;

			if (kind.HasValue)
				adjudicationLedger.RecordDestroyed(destroyed.ActorID, victim.Ordinal, kind.Value, replacementValue);
		}

		public static string PrepareMatch(string requestedMapUid, string configJson)
		{
			try
			{
				if (Game.ModData == null)
					return Error("not initialized");
				if (!rulesOverlayInstalled)
					return Error("Agent mode requires booting with Host.AgentMode=1");

				if (matchId != null)
					return Error("an Agent mode match is already active");

				if (Encoding.UTF8.GetByteCount(configJson ?? "") > AgentModeLimits.MaxJsonBytes)
					return Error("config exceeds 256 KiB");

				var config = JsonSerializer.Deserialize<AgentMatchConfig>(
					string.IsNullOrWhiteSpace(configJson) ? "{}" : configJson, JsonOptions) ?? new AgentMatchConfig();
				if (config.SchemaVersion != AgentModeLimits.SchemaVersion)
					return Error($"unsupported schemaVersion {config.SchemaVersion}");
				if (!ValidSpendCap(config.MatchSpendCapUsd))
					return Error("match spend cap must be between 0.01 and 1000 USD");
				if (!ValidSpendCap(config.Agent1SpendCapUsd) || config.Agent1SpendCapUsd > config.MatchSpendCapUsd ||
					!ValidSpendCap(config.Agent2SpendCapUsd) || config.Agent2SpendCapUsd > config.MatchSpendCapUsd)
					return Error("each agent spend cap must be between 0.01 and the match spend cap");
				if (config.BenchmarkLockstepEnabled)
				{
					if (string.IsNullOrWhiteSpace(requestedMapUid))
						return Error("benchmark lockstep requires an explicit map uid");
					if (!string.Equals(config.BenchmarkSpecVersion, AgentModeLimits.BenchmarkSpecVersion,
						StringComparison.Ordinal))
						return Error($"unsupported benchmarkSpecVersion '{config.BenchmarkSpecVersion}'");
					if (config.BenchmarkDecisionTimeoutMs is < AgentModeLimits.MinPlanningTimeoutMs or
						> AgentModeLimits.MaxPlanningTimeoutMs)
						return Error("benchmarkDecisionTimeoutMs must be between 10000 and 120000");
					if (config.BenchmarkTickHorizon < 0 || config.BenchmarkDecisionHorizon < 0 ||
						(config.BenchmarkTickHorizon == 0 && config.BenchmarkDecisionHorizon == 0))
						return Error("benchmark lockstep requires a positive tick or decision horizon");
					if (!config.PrematchPlanning)
						return Error("benchmark lockstep requires prematchPlanning=true for barrier zero");
					if (config.AdvisorFallbackEnabled)
						return Error("benchmark lockstep forbids advisor fallback; failed seats are deterministic no-ops");
					if (config.FakeAgents)
						return Error("benchmark lockstep cannot be combined with fakeAgents");
					if (config.PlayCadenceEnabled)
						return Error("benchmark lockstep cannot be combined with playCadenceEnabled");
				}

				var opponentBot = config.OpponentBot?.Trim();
				if (string.IsNullOrEmpty(opponentBot))
					opponentBot = null;
				if (config.FakeAgents && !string.IsNullOrEmpty(opponentBot))
					return Error("fakeAgents cannot be combined with opponentBot");
				if (config.BenchmarkLockstepEnabled && !string.IsNullOrEmpty(opponentBot))
					return Error("benchmark lockstep requires two LLM-controlled seats and forbids opponentBot");
				if (opponentBot == AgentBotType)
					return Error($"opponentBot '{AgentBotType}' is reserved for LLM-controlled agent seats");
				if ((opponentBot?.Length ?? 0) > 64 || opponentBot?.Any(c => !char.IsLetterOrDigit(c) && c is not ('-' or '_')) == true)
					return Error("opponentBot must be a bot id containing only letters, digits, '-' or '_'");

				var candidates = Game.ModData.MapCache
					.Where(m => m.Status == MapStatus.Available && m.Visibility == MapVisibility.Lobby &&
						m.PlayerCount >= 2 && m.Players.Players.Count(p => p.Value.Playable && p.Value.AllowBots) >= 2)
					.ToArray();
				var map = !string.IsNullOrEmpty(requestedMapUid)
					? candidates.FirstOrDefault(m => m.Uid == requestedMapUid || Path.GetFileName(m.Path) == requestedMapUid)
					: candidates.FirstOrDefault(m => m.Title == "A Nuclear Winter") ?? candidates.FirstOrDefault();
				if (map == null)
					return Error($"no suitable two-player lobby map found for '{requestedMapUid}'");
				if (config.BenchmarkLockstepEnabled &&
					!string.Equals(map.Uid, requestedMapUid, StringComparison.Ordinal) &&
					!string.Equals(Path.GetFileName(map.Path), requestedMapUid, StringComparison.Ordinal))
					return Error($"benchmark map resolution drifted: requested '{requestedMapUid}', resolved '{map.Uid}'");
				if (opponentBot != null && map.PlayerActorInfo.TraitInfos<IBotInfo>().All(b => b.Type != opponentBot))
					return Error($"unknown opponentBot '{opponentBot}' for this map");
				ConfigureAdjudicationRegions(config, map.Bounds);

				var factionInfos = map.WorldActorInfo.TraitInfos<FactionInfo>().ToArray();
				var factions = factionInfos
					.Where(f => f.Selectable)
					.Select(f => f.InternalName)
					.ToHashSet(StringComparer.Ordinal);
				var faction1 = string.IsNullOrWhiteSpace(config.Faction1) ? "russia" : config.Faction1.Trim();
				var faction2 = string.IsNullOrWhiteSpace(config.Faction2) ? "russia" : config.Faction2.Trim();
				if (!factions.Contains(faction1))
					return Error($"unknown or unplayable Agent 1 faction '{faction1}'");
				if (!factions.Contains(faction2))
					return Error($"unknown or unplayable Agent 2 faction '{faction2}'");

				var playerSlots = map.Players.Players
					.Where(p => p.Value.Playable && p.Value.AllowBots)
					.Select(p => p.Key)
					.Take(2)
					.ToArray();
				var playerReferences = playerSlots.Select(slot => map.Players.Players[slot]).ToArray();
				var plannedFactions = new[]
				{
					playerReferences[0].LockFaction ? playerReferences[0].Faction : faction1,
					playerReferences[1].LockFaction ? playerReferences[1].Faction : faction2
				};
				var plannedFactionSides = plannedFactions.Select(faction => AgentStrategyController.NormalizeFactionSide(
					factionInfos.First(info => info.InternalName == faction).Side)).ToArray();

				matchId = Guid.NewGuid().ToString("N");
				matchLaunched = false;
				fakeAgents = config.FakeAgents;
				omniscientObservations = config.OmniscientObservations;
				advisorFallbackEnabled = config.AdvisorFallbackEnabled;
				prematchPlanningEnabled = config.PrematchPlanning;
				strategyArsenalEnabled = config.StrategyArsenalEnabled;
				doctrineExecutorEnabled = config.DoctrineExecutorEnabled;
				actionGuidanceEnabled = config.ActionGuidanceEnabled;
				doctrineFallbackStrikeEnabled = config.DoctrineFallbackStrikeEnabled;
				staffSeatEnabled = config.StaffSeatEnabled;
				playCadenceEnabled = config.PlayCadenceEnabled;
				benchmarkLockstepEnabled = config.BenchmarkLockstepEnabled;
				benchmarkDecisionTimeoutMs = config.BenchmarkDecisionTimeoutMs;
				lockstepState = benchmarkLockstepEnabled
					? new AgentLockstepBarrier.State(config.BenchmarkTickHorizon, config.BenchmarkDecisionHorizon)
					: null;
				adjudicationLedger = benchmarkLockstepEnabled
					? new AgentAdjudicationLedger.State(AdjudicationControlRegions.Count, adjudicationControlRegionHash)
					: null;
				LockstepSnapshots.Clear();
				lockstepLastControllerWorldTick = -1;
				lockstepStopPauseIssued = false;
				resolvedProfile = ResolveProfile(config);
				buildPlanStallWatchdogTicks = config.BuildPlanStallWatchdogTicks.Clamp(100, 10000);
				buildPlanInternalFailureWatchdogTicks = config.BuildPlanInternalFailureWatchdogTicks.Clamp(25, 2500);
				var gameSpeed = NormalizeGameSpeed(config.GameSpeed);
				planningWarmupResolved = !prematchPlanningEnabled;
				planningFailureReason = null;
				planningTimeoutMs = config.PlanningTimeoutMs.Clamp(
					AgentModeLimits.MinPlanningTimeoutMs, AgentModeLimits.MaxPlanningTimeoutMs);
				spectatorCameraCentered = false;
				opponentBotType = opponentBot;
				opponentPlayer = null;
				decisionIntervalTicks = AgentCadence.EffectiveDecisionInterval(config.DecisionIntervalTicks, playCadenceEnabled);
				matchSpendCapUsd = config.MatchSpendCapUsd;
				fakePhase = 0;
				nextFakeTick = 0;
				fakeAgentStatus = fakeAgents ? "waiting for world" : "disabled";
				preparedMapUid = map.Uid;
				preparedMapTitle = map.Title;
				preparedMapBounds = map.Bounds;
				preparedSpawnPoints = [.. map.SpawnPoints];
				AgentSlots.Clear();
				AgentSlots.Add(new AgentSlot($"agent-1-{Guid.NewGuid():N}", 0,
					plannedFactions[0], plannedFactionSides[0], plannedFactions[1]));
				if (string.IsNullOrEmpty(opponentBot))
					AgentSlots.Add(new AgentSlot($"agent-2-{Guid.NewGuid():N}", 1,
						plannedFactions[1], plannedFactionSides[1], plannedFactions[0]));
				AgentSlots[0].SpendCapUsd = config.Agent1SpendCapUsd;
				if (AgentSlots.Count > 1)
					AgentSlots[1].SpendCapUsd = config.Agent2SpendCapUsd;

				// R3 reactive play/RTS-Agent preset: turn low-HP retreat on and let idle combat first-strike
				// in-range enemies by default. Gated on playCadenceEnabled so the pure-benchmark track keeps
				// its as-is standing-policy defaults (retreat off, proactive engage off) unless the model sets
				// them. The model can still fully replace the policy at runtime.
				if (playCadenceEnabled)
					foreach (var slot in AgentSlots)
					{
						slot.Reflexes.Policy.RetreatBelowHpPercent = PlayPresetRetreatBelowHpPercent;
						slot.Reflexes.Policy.ProactiveEngage = true;
					}

				if (prematchPlanningEnabled)
				{
					if (benchmarkLockstepEnabled)
						OpenPrematchLockstepBarrier();
					else
						foreach (var slot in AgentSlots)
							_ = SerializePlanningObservationBounded(BuildPlanningObservation(slot));
				}

				preparedLaunchOrders =
				[
					Order.Command($"option gamespeed {gameSpeed}"),
					Order.Command("option explored False"),
					Order.Command("option fog True"),
					Order.Command("spectate"),
					Order.Command($"slot_bot {playerSlots[0]} 0 {AgentBotType}"),
					Order.Command($"faction 1 {faction1}"),
					Order.Command($"slot_bot {playerSlots[1]} 0 {opponentBot ?? AgentBotType}"),
					Order.Command($"faction 2 {faction2}"),
					Order.Command($"state {Session.ClientState.Ready}")
				];

				return Serialize(new AgentMatchStartResult
				{
					MatchId = matchId,
					MapUid = map.Uid,
					GameSpeed = gameSpeed,
					MapTitle = map.Title,
					AgentIds = AgentSlots.ConvertAll(a => a.Id),
					FakeAgents = fakeAgents,
					OmniscientObservations = omniscientObservations,
					AdvisorFallbackEnabled = advisorFallbackEnabled,
					PrematchPlanning = prematchPlanningEnabled,
					StrategyArsenalEnabled = strategyArsenalEnabled,
					DoctrineExecutorEnabled = doctrineExecutorEnabled,
					ActionGuidanceEnabled = actionGuidanceEnabled,
					DoctrineFallbackStrikeEnabled = doctrineFallbackStrikeEnabled,
					StaffSeatEnabled = staffSeatEnabled,
					PlayCadenceEnabled = playCadenceEnabled,
					BenchmarkLockstep = BenchmarkLockstepSpec(),
					ResolvedProfile = resolvedProfile,
					BuildPlanStallWatchdogTicks = buildPlanStallWatchdogTicks,
					BuildPlanInternalFailureWatchdogTicks = buildPlanInternalFailureWatchdogTicks,
					PlanningTimeoutMs = planningTimeoutMs,
					OpponentBot = opponentBotType
				});
			}
			catch (Exception e)
			{
				Reset();
				return Error(e.Message);
			}
		}

		/// <summary>
		/// Lobby gamespeed keys from mods/ra/mod.yaml GameSpeeds.Speeds. Default fastest for agent smokes.
		/// </summary>
		static string NormalizeGameSpeed(string requested)
		{
			var speed = string.IsNullOrWhiteSpace(requested) ? "fastest" : requested.Trim().ToLowerInvariant();
			return speed switch
			{
				"slowest" or "slower" or "default" or "fast" or "faster" or "fastest" => speed,
				_ => throw new InvalidDataException(
					$"unknown gameSpeed '{requested}'; use slowest|slower|default|fast|faster|fastest")
			};
		}

		static void ConfigureAdjudicationRegions(AgentMatchConfig config, Rectangle mapBounds)
		{
			AdjudicationControlRegions.Clear();
			AdjudicationControlRegionByCell.Clear();
			adjudicationControlRegionHash = null;
			var definitions = config.BenchmarkControlRegions ?? [];
			if (!config.BenchmarkLockstepEnabled && definitions.Count != 0)
				throw new InvalidDataException("benchmarkControlRegions require benchmark lockstep");
			if (definitions.Count > MaxBenchmarkControlRegions)
				throw new InvalidDataException(
					$"benchmarkControlRegions exceeds {MaxBenchmarkControlRegions} regions");

			var ids = new HashSet<string>(StringComparer.Ordinal);
			var totalCells = 0;
			foreach (var definition in definitions.OrderBy(region => region?.Id, StringComparer.Ordinal))
			{
				var id = definition?.Id?.Trim();
				if (string.IsNullOrEmpty(id) || id.Length > 64 ||
					id.Any(c => !char.IsLetterOrDigit(c) && c is not ('-' or '_')))
					throw new InvalidDataException(
						"benchmark control-region ids must contain 1-64 letters, digits, '-' or '_'");
				if (!ids.Add(id))
					throw new InvalidDataException($"duplicate benchmark control-region id '{id}'");

				var cells = new HashSet<CPos>();
				foreach (var definedCell in definition.Cells ?? [])
				{
					var cell = new CPos(definedCell.X, definedCell.Y);
					if (!mapBounds.Contains(cell.X, cell.Y))
						throw new InvalidDataException($"benchmark control-region cell {cell} is outside the map");
					if (!cells.Add(cell))
						throw new InvalidDataException($"benchmark control-region '{id}' repeats cell {cell}");
					if (AdjudicationControlRegionByCell.ContainsKey(cell))
						throw new InvalidDataException($"benchmark control-region cell {cell} belongs to multiple regions");

					AdjudicationControlRegionByCell.Add(cell, AdjudicationControlRegions.Count);
					totalCells++;
					if (totalCells > MaxBenchmarkControlRegionCells)
						throw new InvalidDataException(
							$"benchmarkControlRegions exceeds {MaxBenchmarkControlRegionCells} total cells");
				}

				if (cells.Count == 0)
					throw new InvalidDataException($"benchmark control-region '{id}' has no cells");
				AdjudicationControlRegions.Add(new AdjudicationControlRegion { Id = id, Cells = cells });
			}

			if (AdjudicationControlRegions.Count == 0)
				return;

			var canonical = string.Join("|", AdjudicationControlRegions.Select(region =>
				$"{region.Id}:{string.Join(';', region.Cells.OrderBy(cell => cell.X).ThenBy(cell => cell.Y)
					.Select(cell => $"{cell.X},{cell.Y}"))}"));
			adjudicationControlRegionHash = Digest(canonical);
		}

		public static string LaunchPreparedMatch(string preparedMatchId)
		{
			if (matchId == null)
				return Error("no prepared Agent mode match is active");
			if (!string.Equals(preparedMatchId, matchId, StringComparison.Ordinal))
				return Error("stale prepared match id");
			if (matchLaunched)
				return Error("the prepared Agent mode match has already launched");
			if (string.IsNullOrEmpty(preparedMapUid) || preparedLaunchOrders.Count == 0)
				return Error("the prepared Agent mode match is incomplete");
			if (benchmarkLockstepEnabled && lockstepState?.PrematchCompleted != true)
				return Error("benchmark lockstep barrier zero must commit before match launch");

			try
			{
				var mapUid = preparedMapUid;
				var launchOrders = preparedLaunchOrders.ToArray();

				// Preparation is deliberately side-effect free with respect to the current
				// world. Claim the engine only when this exact prepared match launches.
				if (Game.OrderManager?.World != null)
					Game.Disconnect();

				matchLaunched = true;
				Game.CreateAndStartLocalServer(mapUid, launchOrders);

				// Every host export answers JSON: the page's strict parser
				// treats a bare string as a malformed launch response.
				return "{\"launched\":true}";
			}
			catch (Exception e)
			{
				Reset();
				return Error(e.Message);
			}
		}

		public static string GetMatchState()
		{
			if (matchId == null)
				return Serialize(new AgentMatchState { State = "inactive", FakeAgentStatus = "disabled" });
			if (!matchLaunched)
				return Serialize(new AgentMatchState
				{
					MatchId = matchId,
					MapUid = preparedMapUid,
					MapTitle = preparedMapTitle,
					State = "planning",
					WorldTick = 0,
					NetFrame = 0,
					TotalSpentUsd = AgentSlots.Sum(a => a.SpentUsd),
					MatchSpendCapUsd = matchSpendCapUsd,
					FakeAgentStatus = fakeAgentStatus,
					AdvisorFallbackEnabled = advisorFallbackEnabled,
					StrategyArsenalEnabled = strategyArsenalEnabled,
					DoctrineExecutorEnabled = doctrineExecutorEnabled,
					ActionGuidanceEnabled = actionGuidanceEnabled,
					DoctrineFallbackStrikeEnabled = doctrineFallbackStrikeEnabled,
					StaffSeatEnabled = staffSeatEnabled,
					PlayCadenceEnabled = playCadenceEnabled,
					DecisionIntervalTicks = decisionIntervalTicks,
					BenchmarkLockstep = BenchmarkLockstepSpec(),
					LockstepBarrier = BuildLockstepBarrierSnapshot(),
					Adjudication = BuildAdjudicationTelemetry(),
					ResolvedProfile = resolvedProfile,
					BuildPlanStallWatchdogTicks = buildPlanStallWatchdogTicks,
					BuildPlanInternalFailureWatchdogTicks = buildPlanInternalFailureWatchdogTicks,
					OpponentBot = opponentBotType,
					Opponent = opponentBotType == null ? null : new AgentPlayerState
					{
						ControllerType = opponentBotType,
						Faction = AgentSlots[0].OpponentFaction,
						WinState = "Pending"
					},
					Agents = AgentSlots.ConvertAll(a => new AgentPlayerState
					{
						AgentId = a.Id,
						ControllerType = "llm",
						Faction = a.PlannedFaction,
						WinState = "Pending",
						SpentUsd = a.SpentUsd,
						SpendCapUsd = a.SpendCapUsd
					})
				});

			EnsurePlayersMapped();
			var orderManager = Game.OrderManager;
			var world = orderManager?.World;
			var state = world == null ? "starting" : "running";
			var participantsResolved = AgentSlots.Count != 0 &&
				AgentSlots.All(a => a.Player != null && a.Player.WinState != WinState.Undefined) &&
				(opponentBotType == null || opponentPlayer?.WinState != WinState.Undefined);
			if (planningFailureReason != null)
				state = "failed";
			else if (lockstepState?.StopKind is AgentLockstepBarrier.StopKind.Aborted or
				AgentLockstepBarrier.StopKind.Censored)
				state = "failed";
			else if (lockstepState?.StopKind is AgentLockstepBarrier.StopKind.TickHorizon or
				AgentLockstepBarrier.StopKind.DecisionHorizon or AgentLockstepBarrier.StopKind.Terminal)
				state = "finished";
			else if (participantsResolved)
				state = "finished";
			else if (fakeAgentStatus.StartsWith("FAILED:", StringComparison.Ordinal))
				state = "failed";

			return Serialize(new AgentMatchState
			{
				MatchId = matchId,
				MapUid = preparedMapUid,
				MapTitle = preparedMapTitle,
				State = state,
				WorldTick = world?.WorldTick ?? -1,
				NetFrame = orderManager?.NetFrameNumber ?? -1,
				OutOfSync = orderManager?.IsOutOfSync ?? false,
				TotalSpentUsd = AgentSlots.Sum(a => a.SpentUsd),
				MatchSpendCapUsd = matchSpendCapUsd,
				FakeAgentStatus = fakeAgentStatus,
				AdvisorFallbackEnabled = advisorFallbackEnabled,
				StrategyArsenalEnabled = strategyArsenalEnabled,
				DoctrineExecutorEnabled = doctrineExecutorEnabled,
				ActionGuidanceEnabled = actionGuidanceEnabled,
				DoctrineFallbackStrikeEnabled = doctrineFallbackStrikeEnabled,
				StaffSeatEnabled = staffSeatEnabled,
				PlayCadenceEnabled = playCadenceEnabled,
				DecisionIntervalTicks = decisionIntervalTicks,
				BenchmarkLockstep = BenchmarkLockstepSpec(),
				LockstepBarrier = BuildLockstepBarrierSnapshot(),
				Adjudication = BuildAdjudicationTelemetry(),
				ResolvedProfile = resolvedProfile,
				BuildPlanStallWatchdogTicks = buildPlanStallWatchdogTicks,
				BuildPlanInternalFailureWatchdogTicks = buildPlanInternalFailureWatchdogTicks,
				OpponentBot = opponentBotType,
				Opponent = ToPlayerState(opponentPlayer, null, opponentBotType),
				TerminalReason = lockstepState?.StopReason ?? (state == "finished" ? "win states resolved" :
					planningFailureReason ?? (state == "failed" ? fakeAgentStatus : null)),
				Agents = AgentSlots.ConvertAll(a => new AgentPlayerState
				{
					AgentId = a.Id,
					ControllerType = "llm",
					ClientIndex = a.Player?.ClientIndex ?? -1,
					PlayerName = a.Player?.ResolvedPlayerName,
					Faction = a.Player?.Faction.InternalName,
					WinState = a.Player?.WinState.ToString() ?? "Pending",
					SpentUsd = a.SpentUsd,
					SpendCapUsd = a.SpendCapUsd,
					FallbackTurns = a.FallbackTurns,
					DecisionOpportunities = a.DecisionOpportunities,
					PlayerColor = PlayerColorHex(a.Player),
					SeatIdentity = $"agent{a.Ordinal + 1}:{a.Id}",
					HostCompiledStrikeCount = a.HostCompiledStrikeCount,
					HostCompiledReinforceCount = a.HostCompiledReinforceCount,
					HostCompiledDisengageCount = a.HostCompiledDisengageCount,
					HostEmergencyRallyOrders = a.HostEmergencyRallyOrders,
					HostStructureDefenseOrders = a.HostStructureDefenseOrders,
					HostProactiveEngageOrders = a.HostProactiveEngageOrders,
					ModelCommitIntentCount = a.ModelCommitIntentCount,
					TimeToFirstCommitIntentTicks = a.TimeToFirstCommitIntentTicks,
					DribbleAttackMoveCount = a.DribbleAttackMoveCount
				})
			});
		}

		static string ResolveProfile(AgentMatchConfig config)
		{
			if (config.BenchmarkLockstepEnabled)
				return "benchmark-lockstep";
			if (config.StaffSeatEnabled && config.StrategyArsenalEnabled && config.DoctrineExecutorEnabled &&
				config.ActionGuidanceEnabled && !config.DoctrineFallbackStrikeEnabled && !config.AdvisorFallbackEnabled)
				return "staff-seat";
			if (config.StrategyArsenalEnabled && config.DoctrineExecutorEnabled && config.ActionGuidanceEnabled &&
				config.DoctrineFallbackStrikeEnabled && config.AdvisorFallbackEnabled && !config.StaffSeatEnabled)
				return "play";
			if (config.StrategyArsenalEnabled && config.DoctrineExecutorEnabled && !config.ActionGuidanceEnabled &&
				!config.DoctrineFallbackStrikeEnabled && !config.StaffSeatEnabled && !config.AdvisorFallbackEnabled)
				return "executor";
			if (!config.StrategyArsenalEnabled && !config.DoctrineExecutorEnabled && config.ActionGuidanceEnabled &&
				!config.DoctrineFallbackStrikeEnabled && !config.StaffSeatEnabled && !config.AdvisorFallbackEnabled)
				return "guided";
			if (config.StrategyArsenalEnabled && !config.DoctrineExecutorEnabled && !config.ActionGuidanceEnabled &&
				!config.DoctrineFallbackStrikeEnabled && !config.StaffSeatEnabled && !config.AdvisorFallbackEnabled)
				return "arsenal";
			if (!config.StrategyArsenalEnabled && !config.DoctrineExecutorEnabled && !config.ActionGuidanceEnabled &&
				!config.DoctrineFallbackStrikeEnabled && !config.StaffSeatEnabled && !config.AdvisorFallbackEnabled)
				return "raw";
			return "custom";
		}

		static AgentBenchmarkLockstepSpec BenchmarkLockstepSpec()
		{
			return !benchmarkLockstepEnabled || lockstepState == null ? null : new AgentBenchmarkLockstepSpec
			{
				DecisionTimeoutMs = benchmarkDecisionTimeoutMs,
				TickHorizon = lockstepState.TickHorizon,
				DecisionHorizon = lockstepState.DecisionHorizon,
				ControlRegionCount = AdjudicationControlRegions.Count,
				ControlRegionHash = adjudicationControlRegionHash
			};
		}

		static AgentAdjudicationTelemetry BuildAdjudicationTelemetry()
		{
			var snapshot = adjudicationLedger?.BuildSnapshot();
			if (!benchmarkLockstepEnabled || snapshot == null)
				return null;

			return new AgentAdjudicationTelemetry
			{
				SampleCount = snapshot.SampleCount,
				FirstFrozenWorldTick = snapshot.FirstFrozenWorldTick,
				LastFrozenWorldTick = snapshot.LastFrozenWorldTick,
				DurationTicks = snapshot.DurationTicks,
				ControlRegionCount = snapshot.ControlRegionCount,
				ControlRegionHash = snapshot.ControlRegionHash,
				Seats = snapshot.Seats.Select(ToAdjudicationSeatTelemetry).ToList(),
				FrozenSamples = snapshot.Samples.Select(sample => new AgentAdjudicationFrozenSampleTelemetry
				{
					BarrierId = sample.BarrierId,
					WorldTick = sample.WorldTick,
					Seats = sample.Seats.Select(ToAdjudicationSeatTelemetry).ToList()
				}).ToList()
			};
		}

		static AgentAdjudicationSeatTelemetry ToAdjudicationSeatTelemetry(
			AgentAdjudicationLedger.SeatSnapshot seat)
		{
			var components = seat.Components;
			return new AgentAdjudicationSeatTelemetry
			{
				Ordinal = seat.Ordinal,
				AgentId = AgentSlots.FirstOrDefault(slot => slot.Ordinal == seat.Ordinal)?.Id,
				Components = new AgentAdjudicationComponentValues
				{
					LiveHpAdjustedPower = components.LiveHpAdjustedPower,
					StructuresByValue = components.StructuresByValue,
					Economy = components.Economy,
					UnitReplacementValue = components.UnitReplacementValue,
					Tech = components.Tech,
					RegionControl = components.RegionControl
				},
				OwnStructureLossValue = seat.OwnStructureLossValue,
				OwnCombatUnitLossValue = seat.OwnCombatUnitLossValue,
				IncomePerMinute = seat.Current.IncomePerMinute,
				RefineryCapacity = seat.Current.RefineryCapacity,
				ProducerCapacity = seat.Current.ProducerCapacity,
				LiquidResources = seat.Current.LiquidResources,
				AverageIncomePerMinute = seat.AverageIncomePerMinute,
				AverageRefineryCapacity = seat.AverageRefineryCapacity,
				AverageProducerCapacity = seat.AverageProducerCapacity,
				AverageLiquidResources = seat.AverageLiquidResources,
				OccupiedRegionCount = seat.Current.OccupiedRegionCount
			};
		}

		static void OpenPrematchLockstepBarrier()
		{
			var barrier = AgentLockstepBarrier.OpenPrematch(lockstepState, AgentSlots.Select(slot => slot.Id).ToArray());
			LockstepSnapshots.Clear();
			foreach (var seat in barrier.Seats.OrderBy(seat => seat.Ordinal))
			{
				var slot = AgentSlots.Single(candidate => candidate.Id == seat.AgentId);
				var snapshot = SerializePlanningObservationBounded(BuildPlanningObservation(slot));
				LockstepSnapshots.Add(slot.Id, snapshot);
				AgentLockstepBarrier.AttachSnapshot(lockstepState, barrier.BarrierId, slot.Id, seat.DecisionId,
					new AgentLockstepBarrier.SnapshotMetadata(1, 0, 0, 0, Digest(snapshot)));
			}
		}

		static string Digest(string value)
		{
			return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value ?? ""))).ToLowerInvariant();
		}

		static AgentLockstepBarrierSnapshot BuildLockstepBarrierSnapshot()
		{
			if (!benchmarkLockstepEnabled || lockstepState == null)
				return null;

			var barrier = lockstepState.Active ?? lockstepState.LastClosed;
			var world = Game.OrderManager?.World;
			return new AgentLockstepBarrierSnapshot
			{
				BarrierId = barrier?.BarrierId ?? -1,
				Prematch = barrier?.Prematch ?? false,
				Phase = lockstepState.Phase.ToString(),
				TriggerWorldTick = barrier?.TriggerWorldTick ?? -1,
				TriggerNetFrame = barrier?.TriggerNetFrame ?? -1,
				FrozenWorldTick = barrier?.FrozenWorldTick ?? -1,
				FrozenNetFrame = barrier?.FrozenNetFrame ?? -1,
				FrozenSyncHash = barrier?.FrozenSyncHash ?? 0,
				AppliedWorldTick = barrier?.AppliedWorldTick ?? -1,
				AppliedNetFrame = barrier?.AppliedNetFrame ?? -1,
				ClosedWorldTick = barrier?.ClosedWorldTick ?? -1,
				ClosedNetFrame = barrier?.ClosedNetFrame ?? -1,
				DecisionTimeoutMs = benchmarkDecisionTimeoutMs,
				OpenedLiveBarriers = lockstepState.OpenedLiveBarriers,
				CompletedLiveBarriers = lockstepState.CompletedLiveBarriers,
				DecisionOpportunitiesPerSeat = lockstepState.DecisionOpportunitiesPerSeat,
				TickHorizon = lockstepState.TickHorizon,
				DecisionHorizon = lockstepState.DecisionHorizon,
				StopKind = lockstepState.StopKind.ToString(),
				PauseOwned = barrier?.PauseOwned ?? false,
				ResumeRequired = barrier?.ResumeRequired ?? false,
				AuthoritativeWorldPaused = world?.Type == WorldType.Regular && world.Paused,
				PredictedWorldPaused = world?.Type == WorldType.Regular && world.PredictedPaused,
				StopReason = lockstepState.StopReason,
				TimeoutReason = barrier?.TimeoutReason,
				AbortReason = barrier?.AbortReason,
				TerminalReason = barrier?.TerminalReason,
				CommitDigest = barrier?.CommitDigest,
				Adjudication = BuildAdjudicationTelemetry(),
				Seats = barrier?.Seats.OrderBy(seat => seat.Ordinal).Select(seat =>
				{
					JsonElement? observation = null;
					if (lockstepState.Active == barrier && LockstepSnapshots.TryGetValue(seat.AgentId, out var json))
						observation = JsonSerializer.Deserialize<JsonElement>(json, JsonOptions);
					return new AgentLockstepSeatSnapshot
					{
						Ordinal = seat.Ordinal,
						AgentId = seat.AgentId,
						DecisionId = seat.DecisionId,
						TriggerSource = seat.TriggerSource,
						Trigger = seat.Trigger,
						ObservationSequence = seat.Snapshot?.ObservationSequence ?? 0,
						SnapshotDigest = seat.Snapshot?.PayloadDigest,
						Observation = observation,
						Outcome = seat.Outcome.ToString(),
						OutcomeReason = seat.OutcomeReason,
						DurationMs = seat.DurationMs
					};
				}).ToList() ?? []
			};
		}

		public static string GetLockstepBarrier()
		{
			try
			{
				return benchmarkLockstepEnabled
					? Serialize(BuildLockstepBarrierSnapshot())
					: Error("benchmark lockstep is not active for this match");
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string CommitLockstepBarrier(string requestJson)
		{
			var applying = false;
			try
			{
				if (!benchmarkLockstepEnabled || lockstepState?.Active == null)
					return Error("no benchmark lockstep barrier is active");
				if (Encoding.UTF8.GetByteCount(requestJson ?? "") > AgentModeLimits.MaxJsonBytes)
					return Error("lockstep commit exceeds 256 KiB");

				var request = JsonSerializer.Deserialize<AgentLockstepCommitRequest>(requestJson ?? "", JsonOptions);
				if (request == null)
					return Error("lockstep commit is empty");
				var barrier = PrevalidateLockstepCommit(request);

				var byAgent = request.Seats.ToDictionary(seat => seat.AgentId, StringComparer.Ordinal);
				var timedOut = false;
				foreach (var seat in barrier.Seats.OrderBy(seat => seat.Ordinal))
				{
					var submitted = byAgent[seat.AgentId];
					if (submitted.Status == "valid")
						AgentLockstepBarrier.ResolveSeat(lockstepState, barrier.BarrierId, seat.AgentId,
							seat.DecisionId, AgentLockstepBarrier.SeatOutcome.Valid, Digest(Serialize(submitted.Batch)),
							durationMs: submitted.DurationMs);
					else if (submitted.Status == "invalid")
						AgentLockstepBarrier.ResolveSeat(lockstepState, barrier.BarrierId, seat.AgentId,
							seat.DecisionId, AgentLockstepBarrier.SeatOutcome.NoOpInvalid, null,
							submitted.Reason.Trim(), submitted.DurationMs);
					else
						timedOut = true;
				}

				if (timedOut)
				{
					var timeoutReason = string.Join("; ", request.Seats.Where(seat => seat.Status == "timeout")
						.OrderBy(seat => barrier.Seat(seat.AgentId).Ordinal)
						.Select(seat => $"{seat.AgentId}: {seat.Reason.Trim()}"));
					AgentLockstepBarrier.ResolveDeadline(lockstepState, barrier.BarrierId, timeoutReason);
					foreach (var seat in barrier.Seats.Where(seat => seat.Outcome == AgentLockstepBarrier.SeatOutcome.NoOpTimeout))
						seat.DurationMs = byAgent[seat.AgentId].DurationMs;
				}

				applying = true;
				if (barrier.Prematch)
					return CommitPrematchLockstepBarrier(barrier, byAgent);

				return CommitLiveLockstepBarrier(barrier, byAgent);
			}
			catch (JsonException e)
			{
				return Error($"malformed lockstep commit JSON: {e.Message}");
			}
			catch (Exception e)
			{
				if (applying)
					CensorLockstepFromHostFailure($"combined commit failed: {e.Message}");
				return Error(e.Message);
			}
		}

		static AgentLockstepBarrier.BarrierState PrevalidateLockstepCommit(AgentLockstepCommitRequest request)
		{
			if (request.SchemaVersion != AgentModeLimits.SchemaVersion)
				throw new InvalidDataException($"unsupported schemaVersion {request.SchemaVersion}");
			if (!string.Equals(request.SpecVersion, AgentModeLimits.BenchmarkSpecVersion, StringComparison.Ordinal))
				throw new InvalidDataException($"unsupported benchmark specVersion '{request.SpecVersion}'");
			var barrier = lockstepState.Active;
			if (request.BarrierId != barrier.BarrierId)
				throw new InvalidDataException(
					$"stale or unknown barrierId {request.BarrierId}; active barrier is {barrier.BarrierId}");
			if (barrier.Phase != AgentLockstepBarrier.Phase.Collecting)
				throw new InvalidDataException($"barrier {barrier.BarrierId} is {barrier.Phase}, expected Collecting");
			if (request.Seats?.Count != 2 || request.Seats.Any(seat => seat == null || string.IsNullOrWhiteSpace(seat.AgentId)) ||
				request.Seats.Select(seat => seat.AgentId).Distinct(StringComparer.Ordinal).Count() != 2)
				throw new InvalidDataException("lockstep commit requires exactly two unique seat outcomes");
			if (request.Seats.Any(seat => seat.DurationMs < 0))
				throw new InvalidDataException("lockstep seat duration cannot be negative");

			foreach (var submitted in request.Seats)
			{
				var seat = barrier.Seat(submitted.AgentId) ??
					throw new InvalidDataException($"agent {submitted.AgentId} is not part of barrier {barrier.BarrierId}");
				if (submitted.DecisionId != seat.DecisionId)
					throw new InvalidDataException($"stale decisionId {submitted.DecisionId} for {submitted.AgentId}");
				if (submitted.Status is not ("valid" or "invalid" or "timeout"))
					throw new InvalidDataException("lockstep seat status must be valid, invalid, or timeout");
				if (submitted.Status == "valid")
				{
					if (submitted.Batch == null)
						throw new InvalidDataException($"valid seat {submitted.AgentId} requires an action batch");
					if (submitted.Batch.DecisionId != seat.DecisionId ||
						submitted.Batch.ObservedSequence != seat.Snapshot?.ObservationSequence ||
						submitted.Batch.ObservedWorldTick != seat.Snapshot?.WorldTick)
						throw new InvalidDataException($"batch identity does not match the cached snapshot for {submitted.AgentId}");
					if (barrier.Prematch)
						ValidatePlanningBatch(AgentSlots.Single(slot => slot.Id == seat.AgentId), submitted.Batch);
				}
				else if (submitted.Batch != null)
					throw new InvalidDataException($"{submitted.Status} seat {submitted.AgentId} must not include an action batch");
				if (submitted.Status != "valid" && string.IsNullOrWhiteSpace(submitted.Reason))
					throw new InvalidDataException($"{submitted.Status} seat {submitted.AgentId} requires a reason");
				if ((submitted.Reason?.Length ?? 0) > 500)
					throw new InvalidDataException("lockstep seat reason exceeds 500 characters");
			}

			return barrier;
		}

		static string CommitPrematchLockstepBarrier(AgentLockstepBarrier.BarrierState barrier,
			IReadOnlyDictionary<string, AgentLockstepSeatCommit> byAgent)
		{
			foreach (var seat in barrier.Seats.OrderBy(seat => seat.Ordinal))
			{
				var slot = AgentSlots.Single(candidate => candidate.Id == seat.AgentId);
				if (seat.Outcome == AgentLockstepBarrier.SeatOutcome.Valid)
				{
					var batch = byAgent[seat.AgentId].Batch;
					batch.Memo ??= "";
					slot.StagedPlanningBatch = batch;
				}
			}

			var digest = Digest(AgentLockstepBarrier.CanonicalOutcomeTrace(barrier));
			AgentLockstepBarrier.MarkApplied(lockstepState, barrier.BarrierId, 0, 0, digest);
			var result = BuildLockstepCommitResult(barrier,
				new Dictionary<string, AgentActionBatchResult>(StringComparer.Ordinal));
			CloseLockstepBarrier(barrier, 0, 0, false);
			return Serialize(result);
		}

		static string CommitLiveLockstepBarrier(AgentLockstepBarrier.BarrierState barrier,
			IReadOnlyDictionary<string, AgentLockstepSeatCommit> byAgent)
		{
			var world = GetRegularWorld();
			var netFrame = Game.OrderManager.NetFrameNumber;
			if (!world.Paused || world.WorldTick != barrier.FrozenWorldTick || world.SyncHash() != barrier.FrozenSyncHash)
				throw new InvalidDataException("combined commit rejected because the frozen world drifted");

			var combinedOrders = new List<Order>();
			var results = new Dictionary<string, AgentActionBatchResult>(StringComparer.Ordinal);
			foreach (var seat in barrier.Seats.OrderBy(seat => seat.Ordinal))
			{
				var slot = AgentSlots.Single(candidate => candidate.Id == seat.AgentId);
				AgentActionBatchResult actionResult;
				if (seat.Outcome == AgentLockstepBarrier.SeatOutcome.Valid)
					actionResult = SubmitBatch(slot, byAgent[seat.AgentId].Batch, combinedOrders);
				else
					actionResult = new AgentActionBatchResult { DecisionId = seat.DecisionId };

				CountDecisionOpportunity(slot, seat.DecisionId);
				SetFallbackCounters(slot, actionResult);
				results.Add(seat.AgentId, actionResult);
			}

			var digest = Digest(AgentLockstepBarrier.CanonicalOutcomeTrace(barrier));
			AgentLockstepBarrier.MarkApplied(lockstepState, barrier.BarrierId, world.WorldTick, netFrame, digest);
			if (combinedOrders.Count != 0)
				Game.OrderManager.IssueOrders(combinedOrders.ToArray());
			IssueLockstepUnpauseIfOwned(world, barrier.BarrierId);
			return Serialize(BuildLockstepCommitResult(barrier, results));
		}

		static AgentLockstepCommitResult BuildLockstepCommitResult(AgentLockstepBarrier.BarrierState barrier,
			IReadOnlyDictionary<string, AgentActionBatchResult> actionResults)
		{
			return new AgentLockstepCommitResult
			{
				BarrierId = barrier.BarrierId,
				Phase = barrier.Phase.ToString(),
				AppliedWorldTick = barrier.AppliedWorldTick,
				AppliedNetFrame = barrier.AppliedNetFrame,
				CommitDigest = barrier.CommitDigest,
				Adjudication = BuildAdjudicationTelemetry(),
				Seats = barrier.Seats.OrderBy(seat => seat.Ordinal).Select(seat => new AgentLockstepSeatResult
				{
					Ordinal = seat.Ordinal,
					AgentId = seat.AgentId,
					DecisionId = seat.DecisionId,
					Outcome = seat.Outcome.ToString(),
					Reason = seat.OutcomeReason,
					ActionResult = actionResults.TryGetValue(seat.AgentId, out var result) ? result : null
				}).ToList()
			};
		}

		public static string AbortLockstepBarrier(string requestJson)
		{
			try
			{
				if (!benchmarkLockstepEnabled || lockstepState?.Active == null)
					return Error("no benchmark lockstep barrier is active");
				if (Encoding.UTF8.GetByteCount(requestJson ?? "") > AgentModeLimits.MaxJsonBytes)
					return Error("lockstep abort exceeds 256 KiB");
				var request = JsonSerializer.Deserialize<AgentLockstepAbortRequest>(requestJson ?? "", JsonOptions);
				if (request == null || request.SchemaVersion != AgentModeLimits.SchemaVersion ||
					!string.Equals(request.SpecVersion, AgentModeLimits.BenchmarkSpecVersion, StringComparison.Ordinal))
					return Error("lockstep abort identity is invalid");
				if (request.BarrierId != lockstepState.Active.BarrierId)
					return Error($"stale or unknown barrierId {request.BarrierId}");
				if (string.IsNullOrWhiteSpace(request.Reason) || request.Reason.Length > 500)
					return Error("lockstep abort reason must contain 1-500 characters");

				var barrier = lockstepState.Active;
				AgentLockstepBarrier.Abort(lockstepState, barrier.BarrierId, request.Reason.Trim());
				if (barrier.Prematch)
				{
					planningFailureReason = $"benchmark lockstep prematch aborted: {request.Reason.Trim()}";
					CloseLockstepBarrier(barrier, 0, 0, false);
				}
				else
				{
					var world = GetRegularWorld();
					IssueLockstepUnpauseIfOwned(world, barrier.BarrierId);
				}

				return Serialize(BuildLockstepBarrierSnapshot());
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string RecordSpend(string agentId, double spentUsd, double spendCapUsd)
		{
			try
			{
				if (matchId == null)
					throw new InvalidOperationException("no Agent mode match is active");
				var slot = AgentSlots.FirstOrDefault(a => a.Id == agentId);
				if (slot == null)
					throw new InvalidDataException("unknown agent id");
				if (double.IsNaN(spentUsd) || double.IsInfinity(spentUsd) || spentUsd < 0 || spentUsd > 1000)
					throw new InvalidDataException("agent spent USD must be between 0 and 1000");
				if (double.IsNaN(spendCapUsd) || double.IsInfinity(spendCapUsd) || spendCapUsd <= 0 || spendCapUsd > 1000)
					throw new InvalidDataException("agent spend cap must be between 0.01 and 1000 USD");
				if (spentUsd + 1e-9 < slot.SpentUsd)
					throw new InvalidDataException("agent spent USD cannot decrease during a match");
				if (slot.SpendCapUsd > 0 && Math.Abs(slot.SpendCapUsd - spendCapUsd) > 1e-9)
					throw new InvalidDataException("agent spend cap cannot change during a match");

				slot.SpentUsd = spentUsd;
				slot.SpendCapUsd = spendCapUsd;
				return "recorded";
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string StopMatch()
		{
			if (matchId == null)
				return "inactive";
			if (!matchLaunched)
			{
				// Preparation never claimed a world or server, so stopping it must not
				// disconnect the shellmap or another host-owned session.
				Reset();
				return "stopped";
			}

			try
			{
				Game.Disconnect();
				Ui.ResetAll();
				Game.LoadShellMap();

				// The in-game disconnect watcher may have queued its failure dialog one tick
				// before the Agent mode controller observed the stop condition. Dispose the
				// old UI above, then remove only that stale dialog after delayed actions run.
				Game.RunAfterTick(() =>
				{
					if (Ui.CurrentWindow()?.Id == ConnectionFailedPanel)
						Ui.CloseWindow();
				});
				return "stopped";
			}
			catch (Exception e)
			{
				return $"failed: {e.Message}";
			}
			finally
			{
				Reset();
			}
		}

		public static string GetActionSchema()
		{
			var contract = BuildContractManifestEnvelope();
			return Serialize(new
			{
				era = AgentModeLimits.Era,
				schemaVersion = AgentModeLimits.SchemaVersion,
				maxJsonBytes = AgentModeLimits.MaxJsonBytes,
				maxActionsPerDecision = AgentModeLimits.MaxActionsPerDecision,
				maxSubjectIdsPerDecision = AgentModeLimits.MaxSubjectIdsPerDecision,
				maxProductionCount = MaxProductionCount,
				contractManifest = contract.Manifest,
				contractFingerprint = contract.Fingerprint,
				batch = new
				{
					type = "object",
					required = new[] { "schemaVersion", "decisionId", "observedSequence", "observedWorldTick", "thoughts", "actions" },
					additionalProperties = false,
					fields = new
					{
						schemaVersion = "integer; const 1",
						decisionId = "integer; strictly increasing per agent",
						observedSequence = "integer; a sequence previously returned for this agent",
						observedWorldTick = "integer; not in the future",
						thoughts = $"plain text; required; 1-{AgentModeLimits.MaxThoughtChars} characters",
						memo = $"plain text; optional; 0-{AgentModeLimits.MaxMemoChars} characters; defaults empty",
						actions = $"array; maxItems {AgentModeLimits.MaxActionsPerDecision}"
					}
				},
				actions = new object[]
				{
					new
					{
						type = "queueMission",
						variant = "sweep",
						required = new[] { "missionId", "missionType=sweep", "missionVersion", "groupName" },
						optional = new[] { "exploredPercentTarget", "abortLossPercent" },
						note = "deterministic fog-safe map sweep; max 3 active missions; version replacement is atomic"
					},
					new
					{
						type = "queueMission",
						variant = "strike",
						required = new[]
						{
							"missionId", "missionType=strike", "missionVersion", "cellX", "cellY", "legs[1]"
						},
						optional = new[] { "posture", "targetPriority", "abortLossPercent" },
						note = "one-leg staged strike; enemy actors are acquired only while currently visible"
					},
					new
					{
						type = "queueMission",
						variant = "pincer",
						required = new[] { "missionId", "missionType=pincer", "missionVersion", "cellX", "cellY", "legs[2-3]" },
						optional = new[] { "posture", "targetPriority", "abortLossPercent" },
						note = "all legs stage behind a synchronization barrier before advancing"
					},
					new
					{
						type = "queueMission",
						variant = "airStrike",
						required = new[] { "missionId", "missionType=airStrike", "missionVersion", "groupName", "cellX", "cellY" },
						optional = new[] { "sorties", "targetPriority", "abortLossPercent" },
						note = "aircraft-only sorties with normal attack and return-to-base orders"
					},
					new
					{
						type = "queueMission",
						variant = "pursue",
						required = new[] { "missionId", "missionType=pursue", "missionVersion", "groupName", "cellX", "cellY" },
						optional = new[] { "maxChaseCells", "abortLossPercent" },
						note = "bounded pursuit using only current and remembered visible enemy centroids"
					},
					new
					{
						type = "queueMission",
						variant = "reinforce",
						required = new[] { "missionId", "missionType=reinforce", "missionVersion", "groupName", "destinationSquad or cellX+cellY" },
						optional = Array.Empty<string>(),
						note = "moves a reserve group to a squad or fixed cell, then guards or holds"
					},
					new
					{
						type = "controlMission",
						required = new[] { "missionId", "missionVersion", "missionCommand" },
						optional = Array.Empty<string>(),
						note = "missionCommand is pause, resume, or cancel and must match the active mission identity"
					},
					new
					{
						type = "queueBuildPlan",
						required = new[] { "planId", "version", "steps" },
						optional = new[] { "reserveCash" },
						note = "1-8 ordered {item,count} steps; buildings require count 1; different id or higher version replaces"
					},
					new
					{
						type = "controlBuildPlan",
						required = new[] { "planId", "version", "command" },
						optional = Array.Empty<string>(),
						note = "command is pause, resume, or cancel and must match the active plan identity"
					},
					new
					{
						type = "assignGroup",
						required = new[] { "name", "actorIds" },
						optional = Array.Empty<string>(),
						note = "name is 1-24 characters; replaces membership; at most 16 groups"
					},
					new
					{
						type = "move",
						required = new[] { "cellX", "cellY", "exactly one of actorIds or groupName" },
						optional = new[] { "queued" }
					},
					new
					{
						type = "attackMove",
						required = new[] { "cellX", "cellY", "exactly one of actorIds or groupName" },
						optional = new[] { "queued" }
					},
					new { type = "attack", required = new[] { "actorIds", "targetActorId" }, optional = new[] { "queued" } },
					new { type = "deploy", required = new[] { "actorIds" }, optional = Array.Empty<string>() },
					new
					{
						type = "stop",
						required = new[] { "exactly one of actorIds or groupName" },
						optional = Array.Empty<string>()
					},
					new { type = "startProduction", required = new[] { "producerId", "item", "count" }, optional = new[] { "queued" } },
					new { type = "placeBuilding", required = new[] { "producerId", "item", "cellX", "cellY" }, optional = Array.Empty<string>() },
					new { type = "placeBuildingAuto", required = new[] { "producerId", "item" }, optional = Array.Empty<string>() },
					new
					{
						type = "capture",
						required = new[] { "actorIds", "targetActorId" },
						optional = new[] { "queued" },
						note = "target must be currently visible to the agent, including in omniscient research mode"
					},
					new { type = "cancelProduction", required = new[] { "producerId", "item", "count" }, optional = Array.Empty<string>() },
					new { type = "setRallyPoint", required = new[] { "producerId", "cellX", "cellY" }, optional = Array.Empty<string>() },
					new { type = "repair", required = new[] { "actorIds" }, optional = Array.Empty<string>() },
					new { type = "sell", required = new[] { "actorIds" }, optional = Array.Empty<string>() },
					new
					{
						type = "setPolicy",
						required = new[]
						{
							"autoReturnFire", "harvesterFlee", "rallyNewUnitsToDefense",
							"defendCriticalAssets", "autoRepairBuildings", "retreatBelowHpPercent"
						},
						optional = Array.Empty<string>(),
						note = "replaces the complete standing-order policy; retreatBelowHpPercent must be 0-75"
					},
					new
					{
						type = "guard",
						required = new[] { "targetActorId", "exactly one of actorIds or groupName" },
						optional = Array.Empty<string>()
					},
					new { type = "spyPlane", required = new[] { "cellX", "cellY" }, optional = Array.Empty<string>() },
					new { type = "surrender", required = Array.Empty<string>(), optional = Array.Empty<string>() }
				},
				arsenal = new
				{
					enabled = strategyArsenalEnabled,
					config = "strategyArsenalEnabled=true",
					catalogVersion = AgentStrategyCatalog.CatalogVersion,
					catalogFileHash = AgentStrategyCatalog.CatalogFileHash,
					manualFileHash = AgentStrategyCatalog.ManualFileHash,
					rulesHash = AgentStrategyCatalog.RulesHash,
					rulesArtifactHash = AgentStrategyCatalog.RulesArtifactHash,
					rulesGraphHash = AgentStrategyCatalog.RulesGraphHash,
					action = new
					{
						type = "adoptStrategy",
						required = new[] { "strategyId", "reason" },
						strategyIds = AgentStrategyCatalog.StrategyIds,
						note = "the model selects or switches strategy; the host validates facts but never ranks or auto-adopts"
					}
				},
				guidance = new
				{
					enabled = actionGuidanceEnabled || doctrineExecutorEnabled,
					fallbackStrikeEnabled = doctrineFallbackStrikeEnabled,
					action = new
					{
						type = "acceptDoctrineDecision",
						required = new[] { "decisionId", "optionId" },
						note = "selects one exact host-authored batch; the host revalidates every actor, target memory, and cell"
					}
				},
				observation = new
				{
					schemaVersion = AgentModeLimits.SchemaVersion,
					visibility = omniscientObservations ? "omniscient (explicit research opt-in)" :
						"self/allies plus enemies currently viewable by the agent player",
					truncation = "actors are removed from the tail and truncated=true is reported before 256 KiB"
				}
			});
		}

		public static string GetContractManifest()
		{
			return Serialize(BuildContractManifestEnvelope());
		}

		static AgentContractManifestEnvelope BuildContractManifestEnvelope()
		{
			var manifest = new AgentContractManifest
			{
				FieldRules =
				[
					ContractRule("action.actorIds", "array<uint>; minItems=1; maxItems=256; every id > 0"),
					ContractRule("action.commitIntent", "guided/executor surface only; intent=strike|hold|defendBase; " +
						"priority=any|economy|production|power|defenses default=production; minForce 1-24 default 6; optional groupName"),
					ContractRule("action.reinforceIntent", "guided/executor surface only; to=activeStrike|base " +
						"default=activeStrike; maxUnits 1-24 default 8"),
					ContractRule("action.cellX", "int32; must be inside the running map when used as a target"),
					ContractRule("action.cellY", "int32; must be inside the running map when used as a target"),
					ContractRule("action.count", "integer; min=1; max=5"),
					ContractRule("action.groupName", "trimmed string; minLength=1; maxLength=24; no control characters"),
					ContractRule("action.item", "string; minLength=1; maxLength=128"),
					ContractRule("action.decisionId", "acceptDoctrineDecision only; positive current host decision id"),
					ContractRule("action.optionId", "acceptDoctrineDecision only; exact host-authored option token; maxLength=64"),
					ContractRule("action.missionId", "string; pattern=^[A-Za-z0-9_-]{1,32}$"),
					ContractRule("action.missionVersion", "int32; min=1"),
					ContractRule("action.name", "trimmed string; minLength=1; maxLength=24; no control characters"),
					ContractRule("action.planId", "string; pattern=^[A-Za-z0-9_-]{1,32}$"),
					ContractRule("action.producerId", "uint; value > 0"),
					ContractRule("action.reason", $"adoptStrategy only; trimmed string; minLength=1; maxLength={AgentModeLimits.MaxStrategyReasonChars}"),
					ContractRule("action.strategyId", "adoptStrategy only; generated catalog enum"),
					ContractRule("action.targetActorId", "uint; value > 0"),
					ContractRule("action.version", "int32; min=1"),
					ContractRule("batch.actions", "array<strict AgentAction variant>; maxItems=12"),
					ContractRule("batch.decisionId", "integer; min=0"),
					ContractRule("batch.memo", "trimmed string; maxLength=600; default empty"),
					ContractRule("batch.observedSequence", "integer; min=1; cannot be ahead of current observation sequence"),
					ContractRule("batch.observedWorldTick", "int32; min=0; cannot be ahead of current world tick"),
					ContractRule("batch.schemaVersion", "literal integer 1"),
					ContractRule("batch.thoughts", "trimmed string; minLength=1; maxLength=1000"),
					ContractRule("queueBuildPlan.reserveCash", "integer; min=0; max=1000000; default=0"),
					ContractRule("queueBuildPlan.steps", "array<{item,count}>; minItems=1; maxItems=8"),
					ContractRule("queueBuildPlan.steps[].count", "integer; min=1; max=5"),
					ContractRule("queueBuildPlan.steps[].item", "string; minLength=1; maxLength=128"),
					ContractRule("queueMission.abortLossPercent", "integer; min=10; max=100; sweep=50; strike=40; " +
						"pincer=40; airStrike=50; pursue=30"),
					ContractRule("queueMission.airStrike.sorties", "integer; min=1; max=5; default=3"),
					ContractRule("queueMission.pincer.legs", "array<{squad,viaX,viaY}>; minItems=2; maxItems=3; squads distinct"),
					ContractRule("queueMission.pursue.maxChaseCells", "integer; min=5; max=60; default=25"),
					ContractRule("queueMission.reinforce.destination", "exactly one of destinationSquad or cellX+cellY"),
					ContractRule("queueMission.strike.legs", "array<{squad,viaX,viaY}>; length=1"),
					ContractRule("queueMission.strike.legs[].squad", "trimmed string; minLength=1; maxLength=24; " +
						"no control characters"),
					ContractRule("queueMission.strike.legs[].viaX", "integer; must be inside the running map"),
					ContractRule("queueMission.strike.legs[].viaY", "integer; must be inside the running map"),
					ContractRule("queueMission.sweep.exploredPercentTarget", "integer; min=50; max=100; default=85"),
					ContractRule("setPolicy.autoRepairBuildings", "boolean; complete-policy field; default=false"),
					ContractRule("setPolicy.retreatBelowHpPercent", "integer; min=0; max=75")
				],
				BatchInvariants =
				[
					"action objects reject unknown fields and must match exactly one variant",
					"at most one build-plan action per batch",
					"at most one mission action per batch",
					"build-plan actions cannot share a batch with direct production actions",
					"sum(explicit actor ids + resolved group and mission-leg rosters + producer and target references) <= 256"
				],
				ConfigSurface =
				[
					"advisorFallbackEnabled:boolean default=false",
					"actionGuidanceEnabled:boolean default=false",
					"agent1SpendCapUsd:number range=0.01..matchSpendCapUsd default=1",
					"agent2SpendCapUsd:number range=0.01..matchSpendCapUsd default=1",
					"benchmarkControlRegions:array<{id,cells[{x,y}]}> maxRegions=64 maxCells=4096 default=[]",
					"benchmarkDecisionHorizon:integer min=0 default=0",
					"benchmarkDecisionTimeoutMs:integer range=10000..120000 default=120000",
					"benchmarkLockstepEnabled:boolean default=false",
					"benchmarkSpecVersion:literal benchmark-lockstep-v1",
					"benchmarkTickHorizon:integer min=0 default=0",
					"buildPlanInternalFailureWatchdogTicks:integer clamp=25..2500 default=250",
					"buildPlanStallWatchdogTicks:integer clamp=100..10000 default=750",
					"decisionIntervalTicks:integer clamp=25..2500 default=500",
					"doctrineExecutorEnabled:boolean default=false",
					"doctrineFallbackStrikeEnabled:boolean default=false",
					"faction1:string playable-faction default=russia",
					"faction2:string playable-faction default=russia",
					"fakeAgents:boolean default=false",
					"matchSpendCapUsd:number range=0.01..1000 default=2",
					"omniscientObservations:boolean default=false",
					"opponentBot:null-or-safe-id maxLength=64",
					"planningTimeoutMs:integer clamp=10000..120000 default=30000",
					"playCadenceEnabled:boolean default=false",
					"prematchPlanning:boolean default=false",
					"strategyArsenalEnabled:boolean default=false",
					"staffSeatEnabled:boolean default=false",
					"schemaVersion:literal integer 1"
				],
				ObservationFields =
				[
					"actors", "advisorHints", "agentId", "alerts", "base", "decisionTrigger",
					"groups", "hostTruth", "knownEnemyStructures", "mapMaxX", "mapMaxY", "mapMinX",
					"mapMinY", "matchId", "netFrame", "player", "productionQueues", "schemaVersion",
					"scouting", "sequence", "situations", "spatial", "truncated", "visibility", "worldTick"
				],
				ObservationRules =
				[
					ContractRule("observation", "UTF-8 JSON; maxBytes=262144; camelCase"),
					ContractRule("observation.actors", "relationship caps self=64 enemy=48 ally=16; " +
						"fields=actorId,type,relationship,cellX,cellY,health,maxHealth,idle,capabilities"),
					ContractRule("observation.alerts", "maxItems=6; fields=kind,severity,firstSeenTick," +
						"affectedActorId,cell,visibleAttackerSummary,detail,stillActive,buildPlanAutoPaused,threat; " +
						"enemy facts visible-only"),
					ContractRule("observation.groups", "maxItems=16; fields=name,liveCount,actorIds; dead or unowned actors culled"),
					ContractRule("observation.hostTruth", "fields=buildingCounts,completedMilestones,refineryCount," +
						"knownEnemyStructureCount,economy,standingPolicy,buildPlan,missions,advisorFallback," +
						"supportPowers,strategy,doctrine,recentCriticalEvents,legalNextSteps,enemyAssessment," +
						"controlPhase,legalActionTypes,warCommit"),
					ContractRule("observation.hostTruth.controlPhase", "opening|economy|army|war|emergency; " +
						"guided/executor surface only (omitted on the raw track)"),
					ContractRule("observation.hostTruth.legalActionTypes", "array of action type strings legal in the current " +
						"controlPhase; guided/executor surface only (omitted on the raw track)"),
					ContractRule("observation.hostTruth.warCommit", "fields=intent,status,priority,squad,minForce," +
						"mainLiveCount,active; present once a war commit is active"),
						ContractRule("observation.hostTruth.doctrine", "fields=enabled,executorEnabled,bound,strategyId," +
							"cardVersion,programVersion,phase,phaseSinceTick,paused,pauseReason,progress,nextAutoActions," +
							"needsDecision,suggestedOptions,pendingDecision; progress fields=tanksLive,tanksNeed,exploredPercent," +
							"exploredNeed,wavesFailed; executorEnabled=false means observation-only (PR1)"),
						ContractRule("observation.hostTruth.doctrine.pendingDecision.kind",
							"rejectionRepair|reinforceAttack|regroupNeeded|enemyContact|scoutFailed|armyIdle|phaseReady|baseDefenseNeeded"),
					ContractRule("observation.hostTruth.strategy", "fields=enabled,strategyId,cardVersion," +
						"catalogVersion,adoptedTick,lastSwitchTick,switchCount,modelReason; requirements are advisory"),
					ContractRule("observation.hostTruth.supportPowers", "fields=orderName,ready,remainingSeconds; " +
						"owned player support powers only"),
					ContractRule("observation.hostTruth.missions", "maxItems=3; fields=missionId,missionVersion," +
						"type,state,paused,pauseReason,targetCell,legs,lossesPercent,detachedCount,sinceTick"),
					ContractRule("observation.hostTruth.missions[].legs", "maxItems=3; fields=squad,staged,alive,initial"),
					ContractRule("observation.knownEnemyStructures", "remembered structures only; fields=type,cell,lastSeenTick,status; status=last-known"),
					ContractRule("observation.player", "fields=clientIndex,name,faction,spawnPoint,team," +
						"alliedClientIndexes,winState,cash,resources,resourceCapacity,powerProvided,powerDrained,powerState," +
						"color,seatIdentity"),
					ContractRule("observation.productionQueues", "fields=producerId,queueType,buildableItems,items; " +
						"items fields=item,remainingTime,totalTime,paused,done,etaSeconds,placeable"),
					ContractRule("observation.situations", "maxItems=5; factual persistent states; " +
						"fields=id,key,severity,sinceTick,lastUpdatedTick,cell,evidence,fromAlerts; enemy facts visible or last-known only"),
					ContractRule("observation.spatial", "gridWidth=16; gridHeight=16; grid rows=16x16; fog-safe legend and contact lines"),
					ContractRule("observation.visibility", "player-fog default; omniscient only by explicit config")
				],
				MissionEventFields =
				[
					"actorIds", "cell", "kind", "missionId", "missionType", "missionVersion", "reason",
					"sequence", "source", "state", "worldTick"
				],
				MatchStateFields =
				[
					"advisorFallbackEnabled", "agents", "era", "fakeAgentStatus", "matchId", "matchSpendCapUsd",
					"netFrame", "opponent", "opponentBot", "outOfSync", "schemaVersion", "state", "terminalReason",
					"actionGuidanceEnabled", "doctrineExecutorEnabled", "doctrineFallbackStrikeEnabled",
					"buildPlanInternalFailureWatchdogTicks", "buildPlanStallWatchdogTicks", "resolvedProfile",
					"adjudication", "benchmarkLockstep", "lockstepBarrier",
					"staffSeatEnabled", "strategyArsenalEnabled", "totalSpentUsd", "worldTick"
				],
				StrategyEventFields =
				[
					"cardVersion", "catalogVersion", "kind", "modelReason", "previousStrategyId", "sequence",
					"strategyId", "worldTick"
				],
				Planning = new AgentPlanningContractManifest
				{
					BatchInvariants =
					[
						"at most one queueBuildPlan",
						"at most one setPolicy",
						"identity literals decisionId=0 observedSequence=1 observedWorldTick=0"
					],
					Variants =
					[
						ContractVariant("queueBuildPlan", "queueBuildPlan",
							["planId", "reserveCash", "steps", "version"]),
						ContractVariant("setPolicy", "setPolicy",
							["autoRepairBuildings", "autoReturnFire", "defendCriticalAssets", "harvesterFlee",
								"rallyNewUnitsToDefense", "retreatBelowHpPercent"])
					]
				},
				Arsenal = new AgentArsenalContractManifest
				{
					CatalogVersion = AgentStrategyCatalog.CatalogVersion,
					CatalogFileHash = AgentStrategyCatalog.CatalogFileHash,
					ManualFileHash = AgentStrategyCatalog.ManualFileHash,
					RulesGraphHash = AgentStrategyCatalog.RulesGraphHash,
					RulesArtifactHash = AgentStrategyCatalog.RulesArtifactHash,
					RulesHash = AgentStrategyCatalog.RulesHash,
					StrategyIds = AgentStrategyCatalog.StrategyIds.ToList(),
					BatchInvariants = ["at most one adoptStrategy action per batch"],
					PlanningBatchInvariants =
					[
						"at most one adoptStrategy",
						"at most one queueBuildPlan",
						"at most one setPolicy",
						"identity literals decisionId=0 observedSequence=1 observedWorldTick=0"
					],
					Variants =
					[
						ContractVariant("adoptStrategy", "adoptStrategy", ["reason", "strategyId"],
							("strategyId", AgentStrategyCatalog.StrategyIds.ToArray()))
					]
				},
				SituationKinds =
				[
					"E1.funding", "E1.power", "O1.retreat", "O2", "S1.water", "S2.recon", "T1.air", "T1.base",
					"T1.naval", "T1.sw", "T2.reinforcement", "T3.harv", "T4"
				],
				Variants =
				[
					ContractVariant("assignGroup", "assignGroup", ["actorIds", "name"]),
					ContractVariant("attack", "attack", ["actorIds", "queued", "targetActorId"]),
					ContractVariant("attackMove.actorIds", "attackMove", ["actorIds", "cellX", "cellY", "queued"]),
					ContractVariant("attackMove.groupName", "attackMove", ["cellX", "cellY", "groupName", "queued"]),
					ContractVariant("cancelProduction", "cancelProduction", ["count", "item", "producerId"]),
					ContractVariant("capture", "capture", ["actorIds", "queued", "targetActorId"]),
					ContractVariant("controlBuildPlan", "controlBuildPlan", ["command", "planId", "version"],
						("command", ["cancel", "pause", "resume"])),
					ContractVariant("controlMission", "controlMission", ["missionCommand", "missionId", "missionVersion"],
						("missionCommand", ["cancel", "pause", "resume"])),
					ContractVariant("deploy", "deploy", ["actorIds"]),
					ContractVariant("guard.actorIds", "guard", ["actorIds", "targetActorId"]),
					ContractVariant("guard.groupName", "guard", ["groupName", "targetActorId"]),
					ContractVariant("move.actorIds", "move", ["actorIds", "cellX", "cellY", "queued"]),
					ContractVariant("move.groupName", "move", ["cellX", "cellY", "groupName", "queued"]),
					ContractVariant("placeBuilding", "placeBuilding", ["cellX", "cellY", "item", "producerId"]),
					ContractVariant("placeBuildingAuto", "placeBuildingAuto", ["item", "producerId"]),
					ContractVariant("queueBuildPlan", "queueBuildPlan", ["planId", "reserveCash", "steps", "version"]),
					ContractVariant("queueMission.strike", "queueMission",
						["abortLossPercent", "cellX", "cellY", "legs", "missionId", "missionType", "missionVersion", "posture", "targetPriority"],
						("missionType", ["strike"]), ("posture", ["assault", "raid"]),
						("targetPriority", ["any", "defenses", "economy", "production"])),
					ContractVariant("queueMission.pincer", "queueMission",
						["abortLossPercent", "cellX", "cellY", "legs", "missionId", "missionType", "missionVersion", "posture", "targetPriority"],
						("missionType", ["pincer"]), ("posture", ["assault", "raid"]),
						("targetPriority", ["any", "defenses", "economy", "production"])),
					ContractVariant("queueMission.airStrike", "queueMission",
						["abortLossPercent", "cellX", "cellY", "groupName", "missionId", "missionType", "missionVersion", "sorties", "targetPriority"],
						("missionType", ["airStrike"]),
						("targetPriority", ["any", "defenses", "economy", "production"])),
					ContractVariant("queueMission.pursue", "queueMission",
						["abortLossPercent", "cellX", "cellY", "groupName", "maxChaseCells", "missionId", "missionType", "missionVersion"],
						("missionType", ["pursue"])),
					ContractVariant("queueMission.reinforce.destinationSquad", "queueMission",
						["destinationSquad", "groupName", "missionId", "missionType", "missionVersion"],
						("missionType", ["reinforce"])),
					ContractVariant("queueMission.reinforce.cell", "queueMission",
						["cellX", "cellY", "groupName", "missionId", "missionType", "missionVersion"],
						("missionType", ["reinforce"])),
					ContractVariant("queueMission.sweep", "queueMission",
						["abortLossPercent", "exploredPercentTarget", "groupName", "missionId", "missionType", "missionVersion"],
						("missionType", ["sweep"])),
					ContractVariant("repair", "repair", ["actorIds"]),
					ContractVariant("sell", "sell", ["actorIds"]),
					ContractVariant("setPolicy", "setPolicy",
						["autoRepairBuildings", "autoReturnFire", "defendCriticalAssets", "harvesterFlee", "rallyNewUnitsToDefense", "retreatBelowHpPercent"]),
					ContractVariant("setRallyPoint", "setRallyPoint", ["cellX", "cellY", "producerId"]),
					ContractVariant("startProduction", "startProduction", ["count", "item", "producerId", "queued"]),
					ContractVariant("stop.actorIds", "stop", ["actorIds"]),
					ContractVariant("stop.groupName", "stop", ["groupName"]),
					ContractVariant("spyPlane", "spyPlane", ["cellX", "cellY"]),
					ContractVariant("surrender", "surrender", [])
				]
			};
			manifest.FieldRules = manifest.FieldRules.OrderBy(rule => rule.Path, StringComparer.Ordinal).ToList();
			manifest.BatchInvariants = manifest.BatchInvariants.Order(StringComparer.Ordinal).ToList();
			manifest.ConfigSurface = manifest.ConfigSurface.Order(StringComparer.Ordinal).ToList();
			manifest.ObservationFields = manifest.ObservationFields.Order(StringComparer.Ordinal).ToList();
			manifest.ObservationRules = manifest.ObservationRules.OrderBy(rule => rule.Path, StringComparer.Ordinal).ToList();
			manifest.MissionEventFields = manifest.MissionEventFields.Order(StringComparer.Ordinal).ToList();
			manifest.StrategyEventFields = manifest.StrategyEventFields.Order(StringComparer.Ordinal).ToList();
			manifest.MatchStateFields = manifest.MatchStateFields.Order(StringComparer.Ordinal).ToList();
			manifest.Planning.BatchInvariants = manifest.Planning.BatchInvariants.Order(StringComparer.Ordinal).ToList();
			manifest.Planning.Variants = manifest.Planning.Variants
				.OrderBy(v => v.VariantId, StringComparer.Ordinal).ToList();
			manifest.Arsenal.StrategyIds = manifest.Arsenal.StrategyIds.Order(StringComparer.Ordinal).ToList();
			manifest.Arsenal.BatchInvariants = manifest.Arsenal.BatchInvariants.Order(StringComparer.Ordinal).ToList();
			manifest.Arsenal.PlanningBatchInvariants = manifest.Arsenal.PlanningBatchInvariants.Order(StringComparer.Ordinal).ToList();
			manifest.Arsenal.Variants = manifest.Arsenal.Variants.OrderBy(v => v.VariantId, StringComparer.Ordinal).ToList();
			manifest.SituationKinds = manifest.SituationKinds.Order(StringComparer.Ordinal).ToList();
			manifest.Variants = manifest.Variants.OrderBy(v => v.VariantId, StringComparer.Ordinal).ToList();
			var canonical = JsonSerializer.Serialize(manifest, CanonicalJsonOptions);
			return new AgentContractManifestEnvelope
			{
				Manifest = manifest,
				Fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant()
			};
		}

		static AgentContractRule ContractRule(string path, string rule)
		{
			return new AgentContractRule { Path = path, Rule = rule };
		}

		static AgentContractVariant ContractVariant(string variantId, string type, IEnumerable<string> fields,
			params (string Field, string[] Values)[] stringEnums)
		{
			var enums = new List<AgentContractStringEnum>
			{
				new() { Field = "type", Values = [type] }
			};
			enums.AddRange(stringEnums.Select(item => new AgentContractStringEnum
			{
				Field = item.Field,
				Values = item.Values.Order(StringComparer.Ordinal).ToList()
			}));
			return new AgentContractVariant
			{
				VariantId = variantId,
				Type = type,
				Fields = fields.Append("type").Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList(),
				StringEnums = enums.OrderBy(item => item.Field, StringComparer.Ordinal).ToList()
			};
		}

		public static string GetObservation(string agentId, int sinceSequence)
		{
			try
			{
				EnsureLegacyDecisionApiAllowed();
				if (matchId != null && !matchLaunched)
				{
					if (!prematchPlanningEnabled)
						return Error("prematch planning is disabled for this match");
					if (sinceSequence > 1)
						return Error("sinceSequence is ahead of the current planning observation sequence");

					return SerializePlanningObservationBounded(BuildPlanningObservation(GetPreparedSlot(agentId)));
				}

				var slot = GetActiveSlot(agentId);
				var observation = BuildObservation(slot);
				if (sinceSequence > observation.Sequence)
					return Error("sinceSequence is ahead of the current observation sequence");

				return SerializeBounded(observation);
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		static AgentPlanningObservation BuildPlanningObservation(AgentSlot slot)
		{
			return new AgentPlanningObservation
			{
				MatchId = matchId,
				AgentId = slot.Id,
				Map = new AgentPlanningMapObservation
				{
					Uid = preparedMapUid,
					Title = preparedMapTitle,
					MinX = preparedMapBounds.Left,
					MinY = preparedMapBounds.Top,
					MaxX = preparedMapBounds.Right - 1,
					MaxY = preparedMapBounds.Bottom - 1,
					CandidateSpawnPoints = preparedSpawnPoints.Select((cell, index) =>
						new AgentPlanningSpawnObservation
						{
							SpawnPoint = index + 1,
							Cell = new AgentCellObservation { X = cell.X, Y = cell.Y }
						}).ToList()
				},
				Player = new AgentPlanningSelfObservation { Faction = slot.PlannedFaction },

				// The factions and complete candidate list are lobby-public. Neither seat has
				// an assigned spawn before launch, and no assignment is synthesized here.
				Opponent = new AgentPlanningOpponentObservation { Faction = slot.OpponentFaction }
			};
		}

		public static string GetDecisionDue(string agentId)
		{
			try
			{
				EnsureLegacyDecisionApiAllowed();
				EnsurePlanningWarmupAllowsGameplay();
				var slot = GetActiveSlot(agentId);
				var world = GetRegularWorld();
				UpdateEventBus(slot, world);
				if (slot.ClaimedTrigger != null || world.WorldTick < ObservationWarmupTicks)
					return Serialize(new AgentDecisionDue { WorldTick = world.WorldTick });

				if (slot.PendingTrigger == null && world.WorldTick >= slot.NextHeartbeatTick)
				{
					slot.PendingTrigger = "heartbeat";
					slot.PendingAlertKey = null;
					slot.PendingPriority = 0;
				}

				if (slot.PendingTrigger == null || world.WorldTick - slot.LastDecisionTick < GlobalDecisionCooldownTicks)
					return Serialize(new AgentDecisionDue { WorldTick = world.WorldTick });

				if (slot.PendingAlertKey != null &&
					(!slot.AlertStates.TryGetValue(slot.PendingAlertKey, out var pendingAlert) || !pendingAlert.Alert.StillActive))
				{
					slot.PendingTrigger = null;
					slot.PendingAlertKey = null;
					slot.PendingPriority = 0;
					if (world.WorldTick < slot.NextHeartbeatTick)
						return Serialize(new AgentDecisionDue { WorldTick = world.WorldTick });

					slot.PendingTrigger = "heartbeat";
				}

				slot.ClaimedTrigger = slot.PendingTrigger;
				slot.PendingTrigger = null;
				slot.PendingAlertKey = null;
				slot.PendingPriority = 0;
				slot.LastDecisionTick = world.WorldTick;
				slot.NextHeartbeatTick = world.WorldTick + decisionIntervalTicks;
				return Serialize(new AgentDecisionDue
				{
					Due = true,
					Trigger = slot.ClaimedTrigger,
					WorldTick = world.WorldTick
				});
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string SubmitActions(string agentId, string actionsJson)
		{
			try
			{
				EnsureLegacyDecisionApiAllowed();
				EnsurePlanningWarmupAllowsGameplay();
				if (Encoding.UTF8.GetByteCount(actionsJson ?? "") > AgentModeLimits.MaxJsonBytes)
					return Error("action batch exceeds 256 KiB");

				var batch = JsonSerializer.Deserialize<AgentActionBatch>(actionsJson ?? "", JsonOptions);
				if (batch == null)
					return Error("action batch is empty");

				var slot = GetActiveSlot(agentId);
				var result = SubmitBatch(slot, batch);
				CountDecisionOpportunity(slot, batch.DecisionId);
				SetFallbackCounters(slot, result);
				return Serialize(result);
			}
			catch (JsonException e)
			{
				return Error($"malformed action JSON: {e.Message}");
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string SetDecisionRequestState(string agentId, long decisionId, bool inFlight)
		{
			try
			{
				EnsureLegacyDecisionApiAllowed();
				if (decisionId < 0)
					return Error("request decisionId must be non-negative");
				var slot = GetActiveSlot(agentId);
				if (inFlight && slot.RequestInFlight && slot.RequestDecisionId != decisionId)
					return Error("a request is already in flight for this seat");
				slot.RequestInFlight = inFlight;
				slot.RequestDecisionId = inFlight ? decisionId : -1;
				return "recorded";
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string RecordDecisionFailure(string agentId, string requestJson)
		{
			try
			{
				EnsureLegacyDecisionApiAllowed();
				if (Encoding.UTF8.GetByteCount(requestJson ?? "") > AgentModeLimits.MaxJsonBytes)
					return Error("decision failure exceeds 256 KiB");
				var request = JsonSerializer.Deserialize<AgentDecisionFailureRequest>(requestJson ?? "", JsonOptions);
				if (request == null || request.SchemaVersion != AgentModeLimits.SchemaVersion)
					return Error("decision failure requires schemaVersion 1");
				if (request.RequestDecisionId < 0 || request.Kind is not
					("timeout" or "schema" or "upstream" or "circuit" or "empty" or "irrelevant"))
					return Error("decision failure kind or identity is invalid");
				if ((request.Reason?.Length ?? 0) > 500)
					return Error("decision failure reason exceeds 500 characters");

				var slot = GetActiveSlot(agentId);
				slot.RequestInFlight = false;
				slot.RequestDecisionId = -1;
				if (!request.Terminal || slot.LastFailureRequestDecisionId == request.RequestDecisionId)
					return "recorded";

				slot.LastFailureRequestDecisionId = request.RequestDecisionId;
				CountDecisionOpportunity(slot, request.RequestDecisionId);
				var pending = slot.DoctrineDecisions.Pending;
				if (pending != null && AgentDoctrineDecisionController.RecordMiss(slot.DoctrineDecisions,
					GetRegularWorld().WorldTick))
					AgentDoctrineController.RecordAction(slot.Doctrine, "decisionMissed", request.Kind,
						GetRegularWorld().WorldTick, "model", pending.DecisionId,
						reason: request.Reason ?? request.Kind);
				return "recorded";
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string StagePlanningActions(string agentId, string actionsJson)
		{
			try
			{
				EnsureLegacyDecisionApiAllowed();
				if (matchId == null || matchLaunched)
					return Error("match is not accepting prematch planning actions");
				if (!prematchPlanningEnabled)
					return Error("prematch planning is disabled for this match");
				if (Encoding.UTF8.GetByteCount(actionsJson ?? "") > AgentModeLimits.MaxJsonBytes)
					return Error("planning action batch exceeds 256 KiB");
				var slot = GetPreparedSlot(agentId);
				if (slot.StagedPlanningBatch != null)
					return Error("planning decision 0 has already been staged for this agent");

				using var document = JsonDocument.Parse(actionsJson ?? "");
				ValidatePlanningJsonShape(document.RootElement);
				var batch = JsonSerializer.Deserialize<AgentActionBatch>(document.RootElement.GetRawText(), JsonOptions);
				if (batch == null)
					return Error("planning action batch is empty");

				ValidatePlanningBatch(slot, batch);

				batch.Memo ??= "";
				slot.StagedPlanningBatch = batch;
				return Serialize(new AgentActionBatchResult
				{
					DecisionId = 0,
					Accepted = batch.Actions.Count,
					Results = batch.Actions.Select((action, index) => new AgentActionResult
					{
						Index = index,
						Type = action.Type,
						Accepted = true,
						Reason = "staged for warmup"
					}).ToList()
				});
			}
			catch (JsonException e)
			{
				return Error($"malformed planning action JSON: {e.Message}");
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		static void ValidatePlanningJsonShape(JsonElement root)
		{
			ValidateJsonObject(root,
				["schemaVersion", "decisionId", "observedSequence", "observedWorldTick", "thoughts", "memo", "actions"],
				["schemaVersion", "decisionId", "observedSequence", "observedWorldTick", "thoughts", "actions"],
				"planning batch");
			var actions = root.GetProperty("actions");
			if (actions.ValueKind != JsonValueKind.Array)
				throw new InvalidDataException("planning actions must be an array");

			foreach (var action in actions.EnumerateArray())
			{
				if (action.ValueKind != JsonValueKind.Object || !action.TryGetProperty("type", out var typeElement) ||
					typeElement.ValueKind != JsonValueKind.String)
					throw new InvalidDataException("planning action type is required");
				var type = typeElement.GetString();
				if (type == "queueBuildPlan")
				{
					ValidateJsonObject(action, ["type", "planId", "version", "reserveCash", "steps"],
						["type", "planId", "version", "steps"], "queueBuildPlan action");
					var steps = action.GetProperty("steps");
					if (steps.ValueKind != JsonValueKind.Array)
						throw new InvalidDataException("queueBuildPlan steps must be an array");
					foreach (var step in steps.EnumerateArray())
						ValidateJsonObject(step, ["item", "count"], ["item", "count"], "queueBuildPlan step");
				}
				else if (type == "setPolicy")
					ValidateJsonObject(action,
						["type", "autoReturnFire", "harvesterFlee", "rallyNewUnitsToDefense",
							"defendCriticalAssets", "autoRepairBuildings", "retreatBelowHpPercent", "proactiveEngage"],
						["type", "autoReturnFire", "harvesterFlee", "rallyNewUnitsToDefense",
							"defendCriticalAssets", "autoRepairBuildings", "retreatBelowHpPercent"],
						"setPolicy action");
				else if (type == "adoptStrategy")
					ValidateJsonObject(action, ["type", "strategyId", "reason"],
						["type", "strategyId", "reason"], "adoptStrategy action");
				else
					throw new InvalidDataException($"planning does not support action type '{type}'");
			}
		}

		static void ValidateJsonObject(JsonElement element, IEnumerable<string> allowedFields,
			IEnumerable<string> requiredFields, string description)
		{
			if (element.ValueKind != JsonValueKind.Object)
				throw new InvalidDataException($"{description} must be an object");
			var allowed = allowedFields.ToHashSet(StringComparer.Ordinal);
			var seen = new HashSet<string>(StringComparer.Ordinal);
			foreach (var property in element.EnumerateObject())
			{
				if (!allowed.Contains(property.Name))
					throw new InvalidDataException($"{description} contains unknown field '{property.Name}'");
				if (!seen.Add(property.Name))
					throw new InvalidDataException($"{description} contains duplicate field '{property.Name}'");
			}

			var missing = requiredFields.FirstOrDefault(field => !seen.Contains(field));
			if (missing != null)
				throw new InvalidDataException($"{description} requires field '{missing}'");
		}

		static void ValidatePlanningBatch(AgentSlot slot, AgentActionBatch batch)
		{
			if (batch.SchemaVersion != AgentModeLimits.SchemaVersion || batch.DecisionId != 0 ||
				batch.ObservedSequence != 1 || batch.ObservedWorldTick != 0)
				throw new InvalidDataException("planning identity must be schemaVersion=1, decisionId=0, " +
					"observedSequence=1, observedWorldTick=0");
			if (string.IsNullOrWhiteSpace(batch.Thoughts) || batch.Thoughts.Length > AgentModeLimits.MaxThoughtChars)
				throw new InvalidDataException($"planning thoughts must contain 1-{AgentModeLimits.MaxThoughtChars} characters");
			if ((batch.Memo?.Length ?? 0) > AgentModeLimits.MaxMemoChars)
				throw new InvalidDataException($"planning memo exceeds {AgentModeLimits.MaxMemoChars} characters");
			var hasStrategy = batch.Actions?.Any(action => action?.Type == "adoptStrategy") == true;
			if (hasStrategy && !strategyArsenalEnabled)
				throw new InvalidDataException("strategy arsenal is disabled for this match");
			var maxActions = hasStrategy ? AgentModeLimits.MaxActionsPerArsenalPlanning : AgentModeLimits.MaxActionsPerPlanning;
			if (batch.Actions == null || batch.Actions.Count > maxActions ||
				batch.Actions.Any(action => action == null))
				throw new InvalidDataException($"planning actions must contain at most {maxActions} non-null entries");
			if (batch.Actions.Count(action => action.Type == "queueBuildPlan") > 1)
				throw new InvalidDataException("planning may contain at most one queueBuildPlan");
			if (batch.Actions.Count(action => action.Type == "setPolicy") > 1)
				throw new InvalidDataException("planning may contain at most one setPolicy");
			if (batch.Actions.Count(action => action.Type == "adoptStrategy") > 1)
				throw new InvalidDataException("planning may contain at most one adoptStrategy");

			foreach (var action in batch.Actions)
			{
				if (action.Type == "queueBuildPlan")
				{
					if (string.IsNullOrEmpty(action.PlanId) || action.PlanId.Length > AgentBuildPlanController.MaxPlanIdLength ||
						action.PlanId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_')))
						throw new InvalidDataException($"planId must be 1-{AgentBuildPlanController.MaxPlanIdLength} ASCII letters, digits, '-' or '_'");
					if (action.Version < 1)
						throw new InvalidDataException("build-plan version must be at least 1");
					if (action.ReserveCash is < 0 or > AgentBuildPlanController.MaxReserveCash)
						throw new InvalidDataException($"reserveCash must be between 0 and {AgentBuildPlanController.MaxReserveCash}");
					if (action.Steps == null || action.Steps.Count is < 1 or > AgentBuildPlanController.MaxSteps)
						throw new InvalidDataException($"build plan must contain between 1 and {AgentBuildPlanController.MaxSteps} steps");
					foreach (var step in action.Steps)
					{
						if (step == null || string.IsNullOrWhiteSpace(step.Item) || step.Item.Length > 128)
							throw new InvalidDataException("build-plan item must contain 1-128 characters");
						if (step.Count is < 1 or > 5)
							throw new InvalidDataException("build-plan step count must be between 1 and 5");
					}
				}
				else if (action.Type == "setPolicy")
				{
					if (!action.AutoReturnFire.HasValue || !action.HarvesterFlee.HasValue ||
						!action.RallyNewUnitsToDefense.HasValue || !action.DefendCriticalAssets.HasValue ||
						!action.AutoRepairBuildings.HasValue || !action.RetreatBelowHpPercent.HasValue)
						throw new InvalidDataException("setPolicy requires a complete standing-order policy");
					if (action.RetreatBelowHpPercent is < 0 or > 75)
						throw new InvalidDataException("retreatBelowHpPercent must be between 0 and 75");
				}
				else if (action.Type == "adoptStrategy")
					AgentStrategyController.ValidateMetadata(slot.Strategy, action, slot.PlannedFactionSide);
				else
					throw new InvalidDataException($"planning does not support action type '{action.Type}'");
			}
		}

		public static string SubmitFallback(string agentId, string requestJson)
		{
			try
			{
				EnsureLegacyDecisionApiAllowed();
				EnsurePlanningWarmupAllowsGameplay();
				if (Encoding.UTF8.GetByteCount(requestJson ?? "") > AgentModeLimits.MaxJsonBytes)
					return Error("fallback request exceeds 256 KiB");

				var request = JsonSerializer.Deserialize<AgentFallbackRequest>(requestJson ?? "", JsonOptions);
				if (request == null)
					return Error("fallback request is empty");
				if (!advisorFallbackEnabled)
					return Error("advisor fallback is disabled for this match");
				if (request.SchemaVersion != AgentModeLimits.SchemaVersion)
					return Error($"unsupported schemaVersion {request.SchemaVersion}");
				if (request.DecisionId < 0)
					return Error("fallback decisionId must be non-negative");
				if (request.Kind is not ("timeout" or "schema" or "upstream" or "circuit"))
					return Error("unsupported fallback kind");
				if ((request.Reason?.Length ?? 0) > 500)
					return Error("fallback reason exceeds 500 characters");

				var slot = GetActiveSlot(agentId);
				var world = GetRegularWorld();
				if (slot.Player.WinState != WinState.Undefined)
					return Error("agent seat is already terminal");
				if (request.ObservedSequence <= 0 || request.ObservedSequence > slot.ObservationSequence)
					return Error($"unknown observation sequence {request.ObservedSequence}");
				if (request.ObservedWorldTick < 0 || request.ObservedWorldTick > world.WorldTick)
					return Error("fallback observedWorldTick is invalid");

				var observation = BuildObservation(slot);
				var action = AgentFallbackController.ChooseAction(observation);
				var batch = new AgentActionBatch
				{
					SchemaVersion = AgentModeLimits.SchemaVersion,
					DecisionId = request.DecisionId,
					ObservedSequence = observation.Sequence,
					ObservedWorldTick = observation.WorldTick,
					Thoughts = "Deterministic advisor fallback decision.",
					Actions = action == null ? [] : [action]
				};
				var result = SubmitBatch(slot, batch);
				CountDecisionOpportunity(slot, request.DecisionId);
				slot.FallbackTurns++;
				result.Fallback = true;
				result.FallbackReason = string.IsNullOrWhiteSpace(request.Reason) ? request.Kind : request.Reason.Trim();
				SetFallbackCounters(slot, result);

				var actionSummary = result.Results.Count == 0 ? "no useful action" :
					string.Join("; ", result.Results.Select(r => $"{r.Type}: {r.Reason}"));
				PendingReplayTelemetry.Enqueue(Serialize(new AgentReplayTelemetry
				{
					MatchId = matchId,
					Kind = "fallback",
					AgentId = slot.Id,
					DecisionId = request.DecisionId,
					WorldTick = world.WorldTick,
					Summary = $"{request.Kind}: {actionSummary}",
					Fallback = true,
					OmniscientObservations = omniscientObservations,
					ResolvedProfile = resolvedProfile,
					StrategyArsenalEnabled = strategyArsenalEnabled,
					ActionGuidanceEnabled = actionGuidanceEnabled,
					DoctrineExecutorEnabled = doctrineExecutorEnabled,
					DoctrineFallbackStrikeEnabled = doctrineFallbackStrikeEnabled,
					AdvisorFallbackEnabled = advisorFallbackEnabled,
					StaffSeatEnabled = staffSeatEnabled,
					SeatIdentity = $"agent{slot.Ordinal + 1}:{slot.Id}",
					PlayerColor = PlayerColorHex(slot.Player)
				}));
				FlushReplayTelemetry();
				return Serialize(result);
			}
			catch (JsonException e)
			{
				return Error($"malformed fallback JSON: {e.Message}");
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string GetReflexEvents(string agentId, long sinceSequence)
		{
			try
			{
				if (sinceSequence < 0)
					return Error("sinceSequence must be non-negative");

				return Serialize(AgentReflexController.GetEvents(GetActiveSlot(agentId).Reflexes, sinceSequence));
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string GetBuildPlanEvents(string agentId, long sinceSequence)
		{
			try
			{
				if (sinceSequence < 0)
					return Error("sinceSequence must be non-negative");

				return Serialize(AgentBuildPlanController.GetEvents(GetActiveSlot(agentId).BuildPlan, sinceSequence));
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string GetMissionEvents(string agentId, long sinceSequence)
		{
			try
			{
				if (sinceSequence < 0)
					return Error("sinceSequence must be non-negative");

				var batch = AgentMissionController.GetEvents(GetActiveSlot(agentId).Missions, sinceSequence);
				if (sinceSequence > batch.LatestSequence)
					return Error("sinceSequence is ahead of the latest mission event");

				return Serialize(ToMissionEventBatch(batch));
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string GetStrategyEvents(string agentId, long sinceSequence)
		{
			try
			{
				if (sinceSequence < 0)
					return Error("sinceSequence must be non-negative");

				var batch = AgentStrategyController.GetEvents(GetActiveSlot(agentId).Strategy, sinceSequence);
				if (sinceSequence > batch.LatestSequence)
					return Error("sinceSequence is ahead of the latest strategy event");

				return Serialize(batch);
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static string RecordReplayTelemetry(string telemetryJson)
		{
			try
			{
				if (Encoding.UTF8.GetByteCount(telemetryJson ?? "") > AgentModeLimits.MaxJsonBytes)
					return Error("telemetry exceeds 256 KiB");

				var telemetry = JsonSerializer.Deserialize<AgentReplayTelemetry>(telemetryJson ?? "", JsonOptions);
				if (telemetry == null)
					return Error("telemetry is empty");

				StampReplayTelemetry(telemetry);
				ValidateReplayTelemetry(telemetry);
				PendingReplayTelemetry.Enqueue(Serialize(telemetry));
				FlushReplayTelemetry();
				return "recorded";
			}
			catch (Exception e)
			{
				return Error(e.Message);
			}
		}

		public static void Tick()
		{
			if (matchId == null || !matchLaunched || benchmarkLockstepEnabled)
				return;

			EnsurePlayersMapped();
			var world = Game.OrderManager?.World;
			if (world?.Type == WorldType.Regular)
			{
				ApplyStagedPlanningActions(world);
				if (planningFailureReason == null && (!prematchPlanningEnabled || planningWarmupResolved))
					foreach (var slot in AgentSlots.Where(a => a.Player != null))
					{
						UpdateEventBus(slot, world);
						TickBuildPlan(slot, world);
						TickDoctrine(slot, world);
						TickDoctrineDecisions(slot, world);
						TickMissions(slot, world);
						TickReflexes(slot, world);
					}
			}

			CenterSpectatorCamera();
			FlushReplayTelemetry();
			if (fakeAgents && planningFailureReason == null && (!prematchPlanningEnabled || planningWarmupResolved))
				TickFakeAgents();
		}

		/// <summary>
		/// Benchmark-only host progression composed onto GameStepper.LogicTickCompleted. The normal
		/// RAF path above remains the sole controller clock for every real-time profile.
		/// </summary>
		public static void TickAfterLogic()
		{
			if (!benchmarkLockstepEnabled || matchId == null || !matchLaunched || lockstepState == null)
				return;

			try
			{
				EnsurePlayersMapped();
				var orderManager = Game.OrderManager;
				var world = orderManager?.World;
				if (world?.Type != WorldType.Regular || AgentSlots.Count != 2 || AgentSlots.Any(slot => slot.Player == null))
					return;

				AdvanceLockstepBarrier(world, orderManager.NetFrameNumber);
				if (lockstepState.Active != null)
					return;
				if (world.IsGameOver || AgentSlots.Any(slot => slot.Player.WinState != WinState.Undefined))
				{
					StopLockstepForTerminal(world, orderManager.NetFrameNumber, "participant win state resolved");
					return;
				}

				if (lockstepState.StopKind != AgentLockstepBarrier.StopKind.None ||
					AgentLockstepBarrier.EvaluateHorizon(lockstepState, world.WorldTick) != AgentLockstepBarrier.StopKind.None)
				{
					PauseStoppedLockstepRun(world);
					return;
				}

				// Controllers and trigger polling run at most once for a world tick, even if the scheduler
				// services multiple net frames while paused or catches up within one render frame.
				if (world.WorldTick == lockstepLastControllerWorldTick)
					return;
				lockstepLastControllerWorldTick = world.WorldTick;

				ApplyStagedPlanningActions(world);
				if (planningFailureReason == null && (!prematchPlanningEnabled || planningWarmupResolved))
				{
					foreach (var slot in AgentSlots.OrderBy(slot => slot.Ordinal))
					{
						UpdateEventBus(slot, world);
						TickBuildPlan(slot, world);
						TickDoctrine(slot, world);
						TickDoctrineDecisions(slot, world);
						TickMissions(slot, world);
						TickReflexes(slot, world);
					}

					TryOpenLockstepBarrier(world, orderManager.NetFrameNumber);
				}

				CenterSpectatorCamera();
				FlushReplayTelemetry();
			}
			catch (Exception e)
			{
				CensorLockstepFromHostFailure($"host logic-tick failure: {e.Message}");
				Console.WriteLine($"[AGENT-LOCKSTEP] censored: {e}");
			}
		}

		static void AdvanceLockstepBarrier(World world, int netFrame)
		{
			var barrier = lockstepState.Active;
			if (barrier == null)
				return;

			if (barrier.Prematch)
				throw new InvalidDataException("prematch barrier zero must close before match launch");
			if (world.IsGameOver || AgentSlots.Any(slot => slot.Player.WinState != WinState.Undefined))
			{
				const string Reason = "participant win state resolved";
				if (barrier.Phase == AgentLockstepBarrier.Phase.ResumePending)
					AgentLockstepBarrier.MarkTerminalAfterApplied(lockstepState, barrier.BarrierId, Reason);
				else
					AgentLockstepBarrier.MarkTerminal(lockstepState, barrier.BarrierId, Reason);
				CloseLockstepBarrier(barrier, world.WorldTick, netFrame, world.Paused);
				return;
			}

			if (barrier.Phase == AgentLockstepBarrier.Phase.PausePending && world.Paused)
			{
				var syncHash = world.SyncHash();
				AgentLockstepBarrier.MarkFrozen(lockstepState, barrier.BarrierId, world.WorldTick, netFrame,
					syncHash, world.Paused);
				RecordAdjudicationFrozenSample(world, barrier.BarrierId);
				LockstepSnapshots.Clear();
				foreach (var seat in barrier.Seats.OrderBy(seat => seat.Ordinal))
				{
					var slot = AgentSlots.Single(candidate => candidate.Id == seat.AgentId);
					var serialized = SerializeBounded(BuildObservation(slot));
					LockstepSnapshots.Add(slot.Id, serialized);
					AgentLockstepBarrier.AttachSnapshot(lockstepState, barrier.BarrierId, slot.Id, seat.DecisionId,
						new AgentLockstepBarrier.SnapshotMetadata(slot.ObservationSequence, world.WorldTick,
							netFrame, syncHash, Digest(serialized)));
				}
			}

			barrier = lockstepState.Active;
			if (barrier == null)
				return;

			if (barrier.Phase is AgentLockstepBarrier.Phase.Collecting or AgentLockstepBarrier.Phase.CommitReady)
			{
				if (!world.Paused || world.WorldTick != barrier.FrozenWorldTick || world.SyncHash() != barrier.FrozenSyncHash)
				{
					AgentLockstepBarrier.Censor(lockstepState, barrier.BarrierId,
						"frozen world tick or sync hash drifted while collecting barrier outcomes");
					IssueLockstepUnpauseIfOwned(world, barrier.BarrierId);
				}
			}

			barrier = lockstepState.Active;
			if (barrier?.Phase == AgentLockstepBarrier.Phase.ResumePending)
			{
				if (barrier.ResumeRequired)
				{
					if (!world.Paused)
						CloseLockstepBarrier(barrier, world.WorldTick, netFrame, false);
				}
				else
					CloseLockstepBarrier(barrier, world.WorldTick, netFrame, world.Paused);
			}
		}

		static void RecordAdjudicationFrozenSample(World world, long barrierId)
		{
			if (adjudicationLedger == null)
				throw new InvalidOperationException("benchmark adjudication ledger is not initialized");

			InitializeAdjudicationStructureTypes(world);
			var samples = AgentSlots.OrderBy(slot => slot.Ordinal)
				.Select(slot => BuildAdjudicationSeatSample(world, slot))
				.ToArray();
			adjudicationLedger.RecordFrozen(barrierId, world.WorldTick, samples);
		}

		static AgentAdjudicationLedger.SeatSample BuildAdjudicationSeatSample(World world, AgentSlot slot)
		{
			var player = slot.Player ?? throw new InvalidOperationException("adjudication player is not mapped");
			var actors = world.Actors
				.Where(actor => IsUsableActor(actor, player))
				.OrderBy(actor => actor.ActorID)
				.ToArray();
			var livePower = actors
				.Where(actor => actor.TraitsImplementing<AttackBase>().Any(attack => !attack.IsTraitDisabled))
				.Sum(HpAdjustedActorValue);
			var refineryCapacity = actors
				.Where(actor => actor.Info.HasTraitInfo<BuildingInfo>() && actor.Info.HasTraitInfo<RefineryInfo>())
				.Sum(actor => (long)ActorValue(actor));
			var producerCapacity = actors
				.Where(actor => actor.Info.HasTraitInfo<BuildingInfo>() &&
					actor.TraitsImplementing<Production>().Any(production => !production.IsTraitDisabled))
				.Sum(actor => (long)ActorValue(actor));
			var resources = player.PlayerActor?.TraitOrDefault<PlayerResources>();
			var statistics = player.PlayerActor?.TraitOrDefault<PlayerStatistics>();
			var liquidResources = resources == null ? 0L :
				(long)Math.Max(0, resources.Cash) + Math.Max(0, resources.Resources);
			var incomePerMinute = Math.Max(0, statistics?.DisplayIncome ?? 0);
			var techCapability = world.ActorsWithTrait<ProductionQueue>()
				.Where(queue => queue.Actor.Owner == player && queue.Actor.IsInWorld && !queue.Actor.IsDead)
				.SelectMany(queue => queue.Trait.AllItems()
					.Where(queue.Trait.CanBuild))
				.GroupBy(info => info.Name, StringComparer.Ordinal)
				.Select(group => group.First().TraitInfoOrDefault<ValuedInfo>()?.Cost ?? 0)
				.Sum(cost => (long)Math.Max(0, cost));

			var occupiedRegions = new bool[AdjudicationControlRegions.Count];
			foreach (var actor in actors.Where(actor => AgentCombatRoster.IsEligible(actor, player)))
				if (AdjudicationControlRegionByCell.TryGetValue(actor.Location, out var region))
					occupiedRegions[region] = true;

			return new AgentAdjudicationLedger.SeatSample(
				slot.Ordinal,
				livePower,
				incomePerMinute,
				refineryCapacity,
				producerCapacity,
				liquidResources,
				techCapability,
				occupiedRegions.Count(occupied => occupied));
		}

		static long HpAdjustedActorValue(Actor actor)
		{
			var value = ActorValue(actor);
			var health = actor.TraitOrDefault<Health>();
			if (value <= 0 || health == null || health.MaxHP <= 0)
				return Math.Max(0, value);

			return (long)value * Math.Clamp(health.HP, 0, health.MaxHP) / health.MaxHP;
		}

		static void InitializeAdjudicationStructureTypes(World world)
		{
			if (!benchmarkLockstepEnabled || adjudicationStructureCatalogInitialized || world?.Type != WorldType.Regular)
				return;

			var consumedPrerequisites = world.Map.Rules.Actors.Values
				.SelectMany(info => info.TraitInfos<BuildableInfo>()
					.SelectMany(buildable => buildable.Prerequisites)
					.Concat(info.TraitInfos<SupportPowerInfo>().SelectMany(power => power.Prerequisites)))
				.Select(NormalizePrerequisite)
				.Where(prerequisite => prerequisite.Length != 0)
				.ToHashSet(StringComparer.Ordinal);

			AdjudicationStructureTypes.Clear();
			foreach (var info in world.Map.Rules.Actors.Values.OrderBy(info => info.Name))
			{
				if (!info.HasTraitInfo<BuildingInfo>())
					continue;

				var critical = info.HasTraitInfo<BaseBuildingInfo>() || info.HasTraitInfo<GivesBuildableAreaInfo>() ||
					info.HasTraitInfo<RefineryInfo>() || info.HasTraitInfo<ProductionInfo>();
				var unlocksConsumedTech = info.TraitInfos<ITechTreePrerequisiteInfo>()
					.SelectMany(prerequisite => prerequisite.Prerequisites(info))
					.Select(NormalizePrerequisite)
					.Any(consumedPrerequisites.Contains);
				if (critical || unlocksConsumedTech)
					AdjudicationStructureTypes.Add(info.Name);
			}

			adjudicationStructureCatalogInitialized = true;
		}

		static string NormalizePrerequisite(string prerequisite)
		{
			return (prerequisite ?? "").Replace("~", "", StringComparison.Ordinal)
				.Replace("!", "", StringComparison.Ordinal);
		}

		static void TryOpenLockstepBarrier(World world, int netFrame)
		{
			if (world.WorldTick < ObservationWarmupTicks || world.Paused || world.PredictedPaused || world.IsGameOver ||
				AgentSlots.Any(slot => slot.Player.WinState != WinState.Undefined))
			{
				if (world.IsGameOver || AgentSlots.Any(slot => slot.Player.WinState != WinState.Undefined))
					StopLockstepForTerminal(world, netFrame, "participant win state resolved");
				return;
			}

			var triggers = new List<AgentLockstepBarrier.SeatTrigger>();
			foreach (var slot in AgentSlots.OrderBy(slot => slot.Ordinal))
			{
				if (slot.PendingTrigger == null && world.WorldTick >= slot.NextHeartbeatTick)
				{
					slot.PendingTrigger = "heartbeat";
					slot.PendingAlertKey = null;
					slot.PendingPriority = 0;
				}

				if (slot.PendingAlertKey != null &&
					(!slot.AlertStates.TryGetValue(slot.PendingAlertKey, out var pendingAlert) || !pendingAlert.Alert.StillActive))
				{
					slot.PendingTrigger = null;
					slot.PendingAlertKey = null;
					slot.PendingPriority = 0;
					if (world.WorldTick >= slot.NextHeartbeatTick)
						slot.PendingTrigger = "heartbeat";
				}

				var trigger = slot.PendingTrigger != null &&
					world.WorldTick - slot.LastDecisionTick >= GlobalDecisionCooldownTicks
					? slot.PendingTrigger : null;
				triggers.Add(new AgentLockstepBarrier.SeatTrigger(slot.Ordinal, slot.Id, trigger));
			}

			if (triggers.All(trigger => trigger.Trigger == null))
				return;

			var barrier = AgentLockstepBarrier.Open(lockstepState, world.WorldTick, netFrame, triggers,
				world.Paused || world.PredictedPaused);
			foreach (var seat in barrier.Seats.OrderBy(seat => seat.Ordinal))
			{
				var slot = AgentSlots.Single(candidate => candidate.Id == seat.AgentId);
				slot.ClaimedTrigger = seat.Trigger;
				slot.PendingTrigger = null;
				slot.PendingAlertKey = null;
				slot.PendingPriority = 0;
				slot.LastDecisionTick = world.WorldTick;
				slot.NextHeartbeatTick = world.WorldTick + decisionIntervalTicks;
			}

			world.SetPauseState(true);
			AgentLockstepBarrier.MarkPauseIssued(lockstepState, barrier.BarrierId);
		}

		static void StopLockstepForTerminal(World world, int netFrame, string reason)
		{
			var barrier = lockstepState.Active;
			if (barrier != null && barrier.Phase != AgentLockstepBarrier.Phase.ResumePending)
			{
				AgentLockstepBarrier.MarkTerminal(lockstepState, barrier.BarrierId, reason);
				CloseLockstepBarrier(barrier, world.WorldTick, netFrame, world.Paused);
			}
			else if (barrier == null)
			{
				lockstepState.StopKind = AgentLockstepBarrier.StopKind.Terminal;
				lockstepState.StopReason = reason;
			}
		}

		static void PauseStoppedLockstepRun(World world)
		{
			if (lockstepStopPauseIssued || world.Paused || world.IsGameOver)
				return;
			world.SetPauseState(true);
			lockstepStopPauseIssued = true;
		}

		static void CloseLockstepBarrier(AgentLockstepBarrier.BarrierState barrier, int worldTick,
			int netFrame, bool worldPaused)
		{
			AgentLockstepBarrier.Close(lockstepState, barrier.BarrierId, worldTick, netFrame, worldPaused);
			LockstepSnapshots.Clear();
			foreach (var slot in AgentSlots)
				slot.ClaimedTrigger = null;
		}

		static void IssueLockstepUnpauseIfOwned(World world, long barrierId)
		{
			if (AgentLockstepBarrier.ShouldUnpause(lockstepState, barrierId))
				world.SetPauseState(false);
		}

		static void CensorLockstepFromHostFailure(string reason)
		{
			if (!benchmarkLockstepEnabled || lockstepState == null)
				return;
			if (lockstepState.Active == null)
			{
				lockstepState.StopKind = AgentLockstepBarrier.StopKind.Censored;
				lockstepState.StopReason = reason;
				var stoppedWorld = Game.OrderManager?.World;
				if (stoppedWorld?.Type == WorldType.Regular)
					PauseStoppedLockstepRun(stoppedWorld);
				return;
			}

			if (lockstepState.Active.Phase == AgentLockstepBarrier.Phase.ResumePending)
				return;

			var barrierId = lockstepState.Active.BarrierId;
			AgentLockstepBarrier.Censor(lockstepState, barrierId, reason);
			var world = Game.OrderManager?.World;
			if (world?.Type == WorldType.Regular)
				IssueLockstepUnpauseIfOwned(world, barrierId);
		}

		static void ApplyStagedPlanningActions(World world)
		{
			if (!prematchPlanningEnabled || planningWarmupResolved || world.WorldTick < ObservationWarmupTicks ||
				AgentSlots.Any(slot => slot.Player == null))
				return;

			try
			{
				var stagedSlots = AgentSlots.Where(slot => slot.StagedPlanningBatch != null).ToArray();

				// Validate every seat against the same live world before mutating either
				// controller. A bad batch therefore cannot create a one-seat head start.
				foreach (var slot in stagedSlots)
					ValidateStagedPlanningActions(slot, slot.StagedPlanningBatch, world);

				var rewrittenBatches = new List<(AgentSlot Slot, AgentActionBatch Batch)>();
				foreach (var slot in stagedSlots)
				{
					var observation = BuildObservation(slot);
					var staged = slot.StagedPlanningBatch;
					rewrittenBatches.Add((slot, new AgentActionBatch
					{
						SchemaVersion = staged.SchemaVersion,
						DecisionId = staged.DecisionId,
						ObservedSequence = observation.Sequence,
						ObservedWorldTick = observation.WorldTick,
						Thoughts = staged.Thoughts,
						Memo = staged.Memo,
						Actions = staged.Actions
					}));
				}

				// The synthetic 0/1/0 planning identity is rebound to the real warmup
				// observation. Commit only after the cross-seat prevalidation above.
				var combinedOrders = benchmarkLockstepEnabled ? new List<Order>() : null;
				foreach (var (slot, batch) in rewrittenBatches)
				{
					var result = SubmitBatch(slot, batch, combinedOrders);
					if (result.Rejected != 0 || result.Accepted != batch.Actions.Count)
						throw new InvalidDataException($"planning decision 0 was rejected for {slot.Id}");

					CountDecisionOpportunity(slot, batch.DecisionId);
					slot.StagedPlanningApplied = true;
					slot.StagedPlanningBatch = null;
				}

				if (combinedOrders?.Count > 0)
					Game.OrderManager.IssueOrders(combinedOrders.ToArray());

				// Planning owns synthetic decision 0 even when a seat times out or elects
				// not to stage actions. Live gameplay therefore starts at decision 1 for
				// every seat without attributing a successful model turn to the timeout.
				foreach (var slot in AgentSlots)
					slot.LastDecisionId = Math.Max(slot.LastDecisionId, 0);

				planningWarmupResolved = true;
			}
			catch (Exception e)
			{
				planningWarmupResolved = true;
				planningFailureReason = $"prematch planning failed at warmup: {e.Message}";
				Console.WriteLine($"[AGENT-PLANNING] {planningFailureReason}");
			}
		}

		static void ValidateStagedPlanningActions(AgentSlot slot, AgentActionBatch batch, World world)
		{
			ValidatePlanningBatch(slot, batch);
			foreach (var action in batch.Actions)
			{
				switch (action.Type)
				{
					case "queueBuildPlan":
						ValidateBuildPlanActionPurity(action, false);
						AgentBuildPlanController.Validate(slot.BuildPlan, action, world);
						ValidateNoUnmanagedQueuedProduction(slot);
						break;
					case "setPolicy":
						ValidatePolicyAction(action);
						break;
					case "adoptStrategy":
						ValidateStrategyAction(slot, action);
						break;
					default:
						throw new InvalidDataException($"planning does not support action type '{action.Type}'");
				}
			}
		}

		static void TickReflexes(AgentSlot slot, World world)
		{
			var alerts = slot.AlertStates.Values.Select(a => a.Alert).ToArray();

			// Keep the delayed structure-defense backstop assisted-only so raw profiles retain
			// the pre-doctrine reflex behavior used by benchmark comparisons. Mission-owned actors are
			// passed so proactive-engage leaves active mission membership alone (mission membership wins).
			var missionActorIds = slot.Missions.ActorMission.Keys.ToHashSet();
			foreach (var intent in AgentReflexController.Evaluate(world, slot.Player, alerts, slot.Reflexes,
				delayedStructureDefense: doctrineExecutorEnabled, missionActorIds: missionActorIds))
			{
				try
				{
					var orders = new List<Order>();
					if (intent.DockActorId != 0)
					{
						var actor = ValidateOwnedActor(slot, intent.DockActorId);
						var target = ValidateOwnedActor(slot, intent.DockTargetActorId);
						var dockClient = actor.TraitOrDefault<DockClientManager>();
						if (dockClient == null || !actor.AcceptsOrder("Dock") || !dockClient.CanDockAt(target, true, true))
							continue;

						orders.Add(new Order("Dock", actor, Target.FromActor(target), false));
					}
					else
					{
						if (intent.Action == null)
						{
							AgentReflexController.RecordIssued(slot.Reflexes, world, intent);
							continue;
						}

						BuildOrders(slot, intent.Action, orders);
					}

					IssueAgentOrders(slot, orders, false);
					AgentReflexController.RecordIssued(slot.Reflexes, world, intent);

					// BQ C1 reactive-defense telemetry (pure-safe body): count emergency force-rallies and
					// structure-defense garrison pulls that were actually issued.
					if (intent.Kind == "emergencyRally")
						slot.HostEmergencyRallyOrders++;
					else if (intent.Kind == "structureDefense")
						slot.HostStructureDefenseOrders++;
					else if (intent.Kind == "proactiveEngage")
						slot.HostProactiveEngageOrders++;
				}
				catch (InvalidDataException)
				{
					// World state may change after detection and before validation. A stale reflex
					// is safely dropped instead of bypassing the normal action validation boundary.
				}
			}
		}

		static void TickMissions(AgentSlot slot, World world)
		{
			var knownEnemyStructureCount = slot.KnownEnemyStructureCount;
			var orders = new List<Order>();
			var issuedIntents = new List<(AgentMissionController.Intent Intent, uint[] ActorIds)>();
			foreach (var intent in AgentMissionController.Evaluate(
				slot.Missions, world, slot.Player, slot.Reflexes, knownEnemyStructureCount))
			{
				try
				{
					var intentOrders = new List<Order>();
					if (intent.RequiresRawOrder)
					{
						if (intent.Action?.Type != "returnToBase")
							throw new InvalidDataException("unsupported raw mission order");
						var skippedActorIds = new List<uint>();
						foreach (var actor in ValidateSubjects(slot, intent.Action, "ReturnToBase", skippedActorIds))
						{
							if (!actor.Info.HasTraitInfo<AircraftInfo>() ||
								!actor.Info.HasTraitInfo<RearmableInfo>())
								throw new InvalidDataException($"actor {actor.ActorID} cannot return to base");

							intentOrders.Add(new Order("ReturnToBase", actor, false));
						}
					}
					else
						BuildOrders(slot, intent.Action, intentOrders, true);
					var issuedActorIds = intentOrders
						.Select(o => o.Subject)
						.Where(a => a != null && a.Owner == slot.Player)
						.Select(a => a.ActorID)
						.Distinct()
						.Order()
						.ToArray();
					orders.AddRange(intentOrders);
					issuedIntents.Add((intent, issuedActorIds));
				}
				catch (InvalidDataException)
				{
					// A target or subject may become stale after the read-only mission evaluation.
					// Drop that intent; the controller will retry or watchdog it on a later tick.
				}
			}

			IssueAgentOrders(slot, orders, false);
			foreach (var (intent, actorIds) in issuedIntents)
				AgentMissionController.RecordIssued(slot.Missions, intent, actorIds, world.WorldTick);

			var visibleEnemies = GetVisibleEnemies(world, slot.Player);
			foreach (var signal in AgentMissionController.DrainSignals(slot.Missions))
			{
				var detail = signal.Reason ?? signal.Kind;
				var key = $"mission:{signal.Kind}:{signal.MissionId}:v{signal.MissionVersion}:{detail}";
				RaiseAlert(slot, world, key, signal.Kind, signal.Severity, 0,
					world.Map.Contains(signal.Cell) ? signal.Cell : slot.Player.HomeLocation,
					visibleEnemies, false);
				if (slot.AlertStates.TryGetValue(key, out var alert))
					alert.Alert.Detail = detail.Length <= 120 ? detail : detail[..117] + "...";

				// Mission lifecycle wakes are edges, not durable world-state predicates. Keep
				// the trigger claimable after UpdateEventBus marks the observation alert stale.
				if (slot.PendingAlertKey == key)
					slot.PendingAlertKey = null;
			}
		}

		static void TickBuildPlan(AgentSlot slot, World world)
		{
			var state = slot.BuildPlan;
			var step = state.CurrentStep;
			if (!state.Active || step == null)
				return;
			if (doctrineExecutorEnabled && AgentBuildPlanController.ShouldWatchdogRelease(state, world.WorldTick,
				buildPlanStallWatchdogTicks, buildPlanInternalFailureWatchdogTicks, out var watchdogCause))
			{
				var cancellationOrders = new List<Order>();
				CancelOutstandingBuildPlanProduction(slot, cancellationOrders);
				IssueAgentOrders(slot, cancellationOrders, false);
				AgentBuildPlanController.WatchdogRelease(state, world.WorldTick, watchdogCause);
				return;
			}

			if (state.Paused)
				return;
			if (state.LastEvaluationTick == world.WorldTick)
				return;

			state.LastEvaluationTick = world.WorldTick;
			if (!world.Map.Rules.Actors.TryGetValue(step.Item, out var actorInfo))
			{
				AgentBuildPlanController.PauseForFailure(state, world.WorldTick,
					$"build-plan item '{step.Item}' is no longer available");
				return;
			}

			var isBuilding = actorInfo.HasTraitInfo<BuildingInfo>();
			switch (state.StepState)
			{
				case "planned":
					state.BlockedOn = "prerequisites";
					AgentBuildPlanController.Transition(state, world.WorldTick, "waitingPrerequisites",
						$"checking prerequisites for {step.Item}");
					break;
				case "waitingPrerequisites":
				{
					state.BlockedOn = "prerequisites";
					var queue = FindBuildPlanQueue(world, slot.Player, actorInfo);
					if (queue.Actor == null || !queue.Trait.CanBuild(actorInfo))
						return;

					state.ProducerId = queue.Actor.ActorID;
					AgentBuildPlanController.Transition(state, world.WorldTick, "waitingCash",
						$"prerequisites met for {step.Item}");
					break;
				}

				case "waitingCash":
				{
					var queue = FindBuildPlanQueue(world, slot.Player, actorInfo, state.ProducerId);
					if (queue.Actor == null || !queue.Trait.CanBuild(actorInfo))
					{
						state.ProducerId = 0;
						AgentBuildPlanController.Transition(state, world.WorldTick, "waitingPrerequisites",
							$"prerequisites changed for {step.Item}");
						return;
					}

					var resources = slot.Player.PlayerActor?.TraitOrDefault<PlayerResources>();
					var cash = resources?.GetCashAndResources() ?? 0;
					if (state.LastObservedCash >= 0 && cash > state.LastObservedCash)
						AgentBuildPlanController.MarkProgress(state, world.WorldTick, "cash increased while waiting");
					state.LastObservedCash = cash;
					var requiredCash = queue.Trait.GetProductionCost(actorInfo) * step.Count + state.ReserveCash;
					if (cash < requiredCash)
					{
						state.BlockedOn = "cash";
						return;
					}

					if (queue.Trait.AllQueued().Any() || !queue.Trait.CanQueue(actorInfo, out _, out _))
					{
						state.BlockedOn = "queue";
						return;
					}

					var orders = new List<Order>();
					try
					{
						BuildOrders(slot, new AgentAction
						{
							Type = "startProduction",
							ProducerId = queue.Actor.ActorID,
							Item = actorInfo.Name,
							Count = step.Count
						}, orders, true);
					}
					catch (InvalidDataException e)
					{
						AgentBuildPlanController.PauseForFailure(state, world.WorldTick,
							$"build plan paused: {e.Message}");
						return;
					}

					state.ProducerId = queue.Actor.ActorID;
					state.BaselineActorIds.Clear();
					foreach (var actorId in OwnedActorIds(world, slot.Player, actorInfo.Name))
						state.BaselineActorIds.Add(actorId);
					state.DeliveredActorIds.Clear();
					state.LastOrderTick = world.WorldTick;
					state.LastObservedQueueRemaining = -1;
					state.LastObservedQueueCount = -1;
					state.BlockedOn = "queue";
					IssueAgentOrders(slot, orders, false);
					AgentBuildPlanController.Transition(state, world.WorldTick, "producing",
						$"producing {step.Count} {step.Item}");
					break;
				}

				case "producing":
				{
					var deliveredBefore = state.DeliveredActorIds.Count;
					foreach (var actorId in OwnedActorIds(world, slot.Player, actorInfo.Name))
						if (!state.BaselineActorIds.Contains(actorId))
							state.DeliveredActorIds.Add(actorId);
					if (state.DeliveredActorIds.Count > deliveredBefore)
						AgentBuildPlanController.MarkProgress(state, world.WorldTick, "production delivery observed");
					var producer = world.GetActorById(state.ProducerId);
					var queued = producer?.TraitsImplementing<ProductionQueue>()
						.SelectMany(q => q.AllQueued()).Where(i => i.Item == actorInfo.Name).ToArray() ?? [];
					var remaining = queued.Sum(item => item.RemainingTime);
					if ((state.LastObservedQueueRemaining >= 0 && remaining < state.LastObservedQueueRemaining) ||
						(state.LastObservedQueueCount >= 0 && queued.Length != state.LastObservedQueueCount))
						AgentBuildPlanController.MarkProgress(state, world.WorldTick, "production queue advanced");
					state.LastObservedQueueRemaining = remaining;
					state.LastObservedQueueCount = queued.Length;
					state.BlockedOn = "queue";
					if (!isBuilding && queued.Length == 0 && state.DeliveredActorIds.Count >= step.Count)
					{
						AgentBuildPlanController.Transition(state, world.WorldTick, "confirmed",
							$"confirmed {step.Count} {step.Item}");
						return;
					}

					if (isBuilding && queued.Any(i => i.Done))
					{
						AgentBuildPlanController.Transition(state, world.WorldTick, "waitingPlaceable",
							$"{step.Item} is ready to place");
						return;
					}

					// Orders are projected through the normal order-latency pipeline. Wait well beyond
					// the configured latency before treating an empty queue as a failed result.
					if (queued.Length == 0 && world.WorldTick - state.LastOrderTick > 50)
						AgentBuildPlanController.PauseForFailure(state, world.WorldTick,
							$"build plan paused: production of '{step.Item}' disappeared");
					break;
				}

				case "waitingPlaceable":
				{
					state.BlockedOn = "placement";
					var buildingInfo = actorInfo.TraitInfoOrDefault<BuildingInfo>();
					var placementCell = buildingInfo == null ? null :
						AgentAdvisor.ChoosePlacementCell(world, slot.Player, actorInfo, buildingInfo);
					if (!placementCell.HasValue)
						return;

					var orders = new List<Order>();
					try
					{
						BuildOrders(slot, new AgentAction
						{
							Type = "placeBuildingAuto",
							ProducerId = state.ProducerId,
							Item = actorInfo.Name
						}, orders, true);
					}
					catch (InvalidDataException e)
					{
						AgentBuildPlanController.PauseForFailure(state, world.WorldTick,
							$"build plan paused: {e.Message}");
						return;
					}

					state.PlacementCell = placementCell;
					state.LastOrderTick = world.WorldTick;
					IssueAgentOrders(slot, orders, false);
					AgentBuildPlanController.Transition(state, world.WorldTick, "placing",
						$"placing {step.Item}");
					break;
				}

				case "placing":
				{
					state.BlockedOn = "placement";
					var producer = world.GetActorById(state.ProducerId);
					var readyItemRemains = producer?.TraitsImplementing<ProductionQueue>()
						.SelectMany(q => q.AllQueued()).Any(i => i.Item == actorInfo.Name) == true;
					var placed = state.PlacementCell.HasValue && world.Actors.Any(a => a.Owner == slot.Player &&
						a.IsInWorld && !a.IsDead && !a.Disposed && a.Info.Name == actorInfo.Name &&
						a.OccupiesSpace != null && a.Location == state.PlacementCell.Value);
					if (placed && !readyItemRemains)
					{
						AgentBuildPlanController.Transition(state, world.WorldTick, "confirmed",
							$"confirmed placed {step.Item}");
					}
					else if (world.WorldTick - state.LastOrderTick > 25)
					{
						AgentBuildPlanController.PauseForFailure(state, world.WorldTick,
							$"build plan paused: placement of '{step.Item}' did not complete");
					}

					break;
				}

				case "confirmed":
					AgentBuildPlanController.Advance(state, world.WorldTick);
					break;
			}
		}

		static TraitPair<ProductionQueue> FindBuildPlanQueue(World world, Player player, ActorInfo actorInfo,
			uint preferredActorId = 0)
		{
			var queues = world.ActorsWithTrait<ProductionQueue>()
				.Where(q => q.Actor.Owner == player && q.Actor.IsInWorld && !q.Actor.IsDead && !q.Actor.Disposed &&
					q.Trait.AllItems().Contains(actorInfo))
				.OrderBy(q => q.Actor.ActorID == preferredActorId ? 0 : 1)
				.ThenBy(q => q.Actor.ActorID)
				.ThenBy(q => q.Trait.Info.Type);
			return queues.FirstOrDefault();
		}

		static IEnumerable<uint> OwnedActorIds(World world, Player player, string actorType)
		{
			return world.Actors.Where(a => a.Owner == player && a.IsInWorld && !a.IsDead && !a.Disposed &&
				a.Info.Name == actorType).Select(a => a.ActorID).Order();
		}

		// Standing execution for an adopted doctrine card (PR2). Runs only when the executor flag
		// is on; the model still owns targeting, phase advance/hold, strategy switch, and direct
		// override. Every emission is attributed source=doctrine (RecentActions) so the scorecard
		// can separate host-driven from model-driven play — the benchmark measures the model.
		static void TickDoctrine(AgentSlot slot, World world)
		{
			if (!doctrineExecutorEnabled)
				return;

			var state = slot.Doctrine;
			var doctrineScoutActive = AgentMissionController.GetObservation(slot.Missions)
				.Any(mission => mission.MissionId == DoctrineScoutMissionId);
			AgentDoctrineController.ObserveScoutActivity(state, doctrineScoutActive, world.WorldTick);
			var program = state.Program;
			if (!state.Bound || program == null || state.Paused)
				return;

			var phase = state.Phase;

			// maintainSquads first so the named rosters exist with live actors before a scout or
			// strike mission resolves them (this is the fix for the "group does not exist" thrash).
			if (AgentDoctrineExecutor.PhaseHasStanding(program, phase, "maintainSquads"))
				MaintainDoctrineSquads(slot, world, program);

			if (AgentDoctrineExecutor.PhaseHasStanding(program, phase, "scoutSweep"))
				LaunchDoctrineScout(slot, world, program);

			if (AgentDoctrineExecutor.PhaseHasStanding(program, phase, "streamUnits"))
				StreamDoctrineUnits(slot, world, program);

			// Control harness: compile the model's war commit (commitIntent/reinforceIntent) into
			// missions + auto-reinforce. Pure-safe: only runs after a model commit; no host last-resort
			// path (no strikeMain/softReinforce/softRegroup/softDisengage) is ported.
			TickWarCompiler(slot, world, program);

			// FIX-1: accumulate fog-safe combat losses since the last decision for the momentum wakes.
			// Pure detection only — the host surfaces the delta and never acts on it.
			TickOutcomeDelta(slot, world);
		}

		// War compiler tick. Compiles the standing war commit into a labelled strike mission and, while
		// that strike is live, feeds idle home combat into it. defendBase pulls combat home. Every path
		// is attributed source=warCompiler in recentActions and counted so pure scorecards separate host
		// staff-work from model agency. The compiler never opens a war on its own — the model must commit.
		static void TickWarCompiler(AgentSlot slot, World world, AgentDoctrineProgram.Program program)
		{
			var war = slot.War;
			if (war == null || string.IsNullOrEmpty(war.Intent) || war.Intent == "hold")
			{
				if (war != null && war.Intent == "hold")
				{
					war.Status = "hold";
					AgentWarCompiler.SetSkip(war, null);
				}

				return;
			}

			var mainName = string.IsNullOrEmpty(war.Squad)
				? (program?.MainSquadName ?? AgentWarCompiler.CompilerMainSquad)
				: war.Squad;
			war.Squad = mainName;

			if (war.Intent == "defendBase")
			{
				TickWarCompilerDefendBase(slot, world);
				AgentWarCompiler.SetSkip(war, null);
				return;
			}

			if (war.Intent != "strike")
			{
				AgentWarCompiler.SetSkip(war, $"unknownIntent:{war.Intent}");
				return;
			}

			var mainLive = 0;
			try
			{
				mainLive = AgentSquadController.ResolveActorIds(slot.Squads, mainName, world, slot.Player).Count;
			}
			catch (InvalidDataException)
			{
				mainLive = 0;
			}

			var offensive = AgentMissionController.GetObservation(slot.Missions)
				.Any(m => m.MissionType is "strike" or "pincer" or "airStrike" or "pursue");
			if (offensive)
			{
				war.Status = "assaulting";
				AgentWarCompiler.SetSkip(war, null);

				// BQ F4: if the committed squad is locally outnumbered at the front and the fuzzy verdict is
				// to flee, disengage home this tick and skip reinforcing into a losing fight.
				if (MaybeCompiledDisengage(slot, world))
					return;
				MaybeCompiledReinforce(slot, world);
				return;
			}

			war.Status = AgentWarCompiler.MassingStatus(mainLive, war.MinForce);
			if (mainLive < war.MinForce)
			{
				AgentWarCompiler.SetSkip(war, $"massing:{mainLive}<{war.MinForce}");
				return;
			}

			if (!TryPickDoctrineStrikeTarget(slot, world, out var targetCell, out var viaCell))
			{
				war.Status = "waitingTarget";
				AgentWarCompiler.SetSkip(war, "waitingTarget:noKnownEnemyStructure");
				return;
			}

			war.TargetCell = targetCell;
			war.ViaCell = viaCell;
			if (!AgentWarCompiler.ShouldLaunchCompiledStrike(
				true, mainLive, war.MinForce, true, false, world.WorldTick, war.NextLaunchEligibleTick))
			{
				AgentWarCompiler.SetSkip(war,
					world.WorldTick < war.NextLaunchEligibleTick
						? $"cooldown:until{war.NextLaunchEligibleTick}"
						: $"notReady:mainLive={mainLive}");
				return;
			}

			if (AgentMissionController.GetObservation(slot.Missions)
				.Any(m => m.MissionId == AgentWarCompiler.CompilerStrikeMissionId))
			{
				AgentWarCompiler.SetSkip(war, "missionIdBusy:compiler-strike");
				return;
			}

			war.MissionVersion++;
			var orders = new List<Order>();
			try
			{
				BuildOrders(slot, new AgentAction
				{
					Type = "queueMission",
					MissionType = "strike",
					MissionId = AgentWarCompiler.CompilerStrikeMissionId,
					MissionVersion = war.MissionVersion,
					CellX = targetCell.X,
					CellY = targetCell.Y,
					TargetPriority = AgentWarCompiler.ToMissionTargetPriority(war.Priority),
					Posture = "assault",
					Legs =
					[
						new AgentMissionLegInput
						{
							Squad = mainName,
							ViaX = viaCell.X,
							ViaY = viaCell.Y
						}
					]
				}, orders, true);
			}
			catch (InvalidDataException e)
			{
				AgentWarCompiler.SetSkip(war, $"queueMissionRejected:{e.Message}");
				return;
			}

			IssueAgentOrders(slot, orders, false);
			war.Status = "launched";
			AgentWarCompiler.SetSkip(war, null);
			war.NextLaunchEligibleTick = world.WorldTick + AgentWarCompiler.CompiledStrikeCooldownTicks;
			war.NextReinforceEligibleTick = world.WorldTick + AgentWarCompiler.CompiledReinforceGraceTicks;
			AgentDoctrineController.RecordAction(slot.Doctrine, "compiledStrike",
				$"{mainName} -> {targetCell.X},{targetCell.Y} v{war.MissionVersion}", world.WorldTick, "warCompiler");
			slot.HostCompiledStrikeCount++;
		}

		// Compile-sustain (PURE-SAFE, not last-resort): while a compiled strike is live, fold idle combat at
		// home into the live mission roster so the assault does not bleed out one unit at a time. The mission
		// then advances/stages/regroups them with the wave (R5 bug 4: they used to be loose attack-move units
		// aimed at the target cell, outside the roster, so they trickled in and were left behind on retreat).
		static void MaybeCompiledReinforce(AgentSlot slot, World world)
		{
			var war = slot.War;
			var player = slot.Player;
			if (player == null || war == null)
				return;

			var home = player.HomeLocation;
			const int NearBase = 12 * 12;
			var idleHome = world.Actors
				.Where(a => AgentCombatRoster.IsEligible(a, player, "Move", "AttackMove", "Stop") && a.IsIdle &&
					(a.Location - home).LengthSquared <= NearBase)
				.OrderBy(a => a.ActorID)
				.Take(Math.Max(1, war.ReinforceMaxUnits))
				.ToArray();
			if (!AgentWarCompiler.ShouldCompiledReinforce(true, true, idleHome.Length,
				world.WorldTick, war.NextReinforceEligibleTick))
			{
				if (idleHome.Length < 1)
					AgentWarCompiler.SetSkip(war, "reinforce:noIdleHomeCombat");
				else if (world.WorldTick < war.NextReinforceEligibleTick)
					AgentWarCompiler.SetSkip(war, $"reinforce:cooldown:until{war.NextReinforceEligibleTick}");

				return;
			}

			var missions = AgentMissionController.GetObservation(slot.Missions);
			var offensive = missions.FirstOrDefault(m =>
					m.MissionId == AgentWarCompiler.CompilerStrikeMissionId &&
					AgentMissionController.IsGroundOffensive(m.MissionType))
				?? missions.FirstOrDefault(m => AgentMissionController.IsGroundOffensive(m.MissionType));
			if (offensive == null)
				return;

			var joined = AgentMissionController.Reinforce(slot.Missions, offensive.MissionId,
				idleHome.Select(a => a.ActorID), world, player, world.WorldTick);
			if (joined.Count == 0)
			{
				AgentWarCompiler.SetSkip(war, "reinforce:noJoinableRoster");
				return;
			}

			war.NextReinforceEligibleTick = world.WorldTick + AgentWarCompiler.CompiledReinforceGraceTicks;
			AgentDoctrineController.RecordAction(slot.Doctrine, "compiledReinforce",
				$"{joined.Count} joined {offensive.MissionId}", world.WorldTick, "warCompiler");
			slot.HostCompiledReinforceCount++;
		}

		// BQ F4 compiled fuzzy disengage (PURE-SAFE, not last-resort): while a compiled strike is live, find
		// our combat in contact with mobile enemy combat and, when the local bubble is outnumbered, borrow the
		// engine's AttackOrFleeFuzzy verdict (via AgentFuzzyEngagement) to decide flee-vs-trade. On flee, recall
		// the threatened batch home. Runs only under an active model war commit, so it replaces the quarantined
		// assisted softDisengage without a last-resort flag and without breaking pureGeneralValid. Returns true
		// when it disengaged this tick (so the caller skips reinforcing into a losing fight). The outnumber test
		// counts only mobile enemy combat, never base defenses/buildings, so a strike into a defended base is
		// not auto-aborted merely because the target is fortified.
		static bool MaybeCompiledDisengage(AgentSlot slot, World world)
		{
			var war = slot.War;
			var player = slot.Player;
			if (player == null || war == null || world.WorldTick < war.NextDisengageEligibleTick)
				return false;

			var combat = world.Actors
				.Where(a => AgentCombatRoster.IsEligible(a, player, "Move", "AttackMove", "Stop"))
				.OrderBy(a => a.ActorID)
				.ToArray();
			if (combat.Length == 0)
				return false;

			var enemies = GetVisibleEnemies(world, player)
				.Where(e => !e.Info.HasTraitInfo<BuildingInfo>() &&
					(e.Info.HasTraitInfo<MobileInfo>() || e.Info.HasTraitInfo<AircraftInfo>()))
				.ToArray();
			if (enemies.Length == 0)
				return false;

			const int RadiusSq = AgentWarCompiler.CompiledDisengageContactRadiusCells *
				AgentWarCompiler.CompiledDisengageContactRadiusCells;
			var threatened = combat
				.Where(a => enemies.Any(e => (e.Location - a.Location).LengthSquared <= RadiusSq))
				.OrderBy(a => a.ActorID)
				.ToArray();
			if (threatened.Length == 0)
				return false;

			// Local bubble around the threatened cluster center — the same shape the engine squad AI uses.
			var center = new CPos(
				threatened.Sum(a => a.Location.X) / threatened.Length,
				threatened.Sum(a => a.Location.Y) / threatened.Length);
			var ownNear = combat.Where(a => (a.Location - center).LengthSquared <= RadiusSq).ToArray();
			var enemyNear = enemies.Where(e => (e.Location - center).LengthSquared <= RadiusSq).ToArray();

			var ownHealth = NormalizedHealthPercent(ownNear);
			var enemyHealth = NormalizedHealthPercent(enemyNear);

			// Count-based power proxy keeps the fuzzy input pure and fog-safe (no Armament/warhead/Mobile scan,
			// which is the deep engine coupling); speed defaults to parity for the same reason.
			var relativePower = enemyNear.Length == 0
				? 999.0
				: Math.Clamp(100.0 * ownNear.Length / enemyNear.Length, 0.0, 999.0);
			const double RelativeSpeedParity = 100.0;

			var fuzzyWantsFlee = AgentFuzzyEngagement.ShouldDisengage(
				ownHealth, enemyHealth, relativePower, RelativeSpeedParity);
			if (!AgentWarCompiler.ShouldCompiledDisengage(true, true, ownNear.Length, enemyNear.Length, fuzzyWantsFlee))
				return false;

			var batch = threatened.Take(AgentWarCompiler.CompiledDisengageMaxUnits).ToArray();
			var home = player.HomeLocation;
			var orders = new List<Order>();
			try
			{
				BuildOrders(slot, new AgentAction
				{
					Type = "attackMove",
					ActorIds = batch.Select(a => a.ActorID).ToList(),
					CellX = home.X,
					CellY = home.Y
				}, orders, true);
			}
			catch (InvalidDataException)
			{
				return false;
			}

			IssueAgentOrders(slot, orders, false);
			war.Status = "disengaging";
			war.NextDisengageEligibleTick = world.WorldTick + AgentWarCompiler.CompiledDisengageCooldownTicks;
			AgentDoctrineController.RecordAction(slot.Doctrine, "compiledDisengage",
				$"{batch.Length} combat -> home (fuzzy flee, local {ownNear.Length}v{enemyNear.Length})",
				world.WorldTick, "warCompiler");
			slot.HostCompiledDisengageCount++;
			return true;
		}

		// Aggregate health percent (0..100) of a set of actors, summing HP over MaxHP. Actors without a Health
		// trait contribute nothing. Used to feed the fuzzy engagement helper; visible-only, so it is fog-safe.
		static double NormalizedHealthPercent(IReadOnlyCollection<Actor> actors)
		{
			long sumHp = 0;
			long sumMaxHp = 0;
			foreach (var a in actors)
			{
				var health = a.TraitOrDefault<Health>();
				if (health == null)
					continue;
				sumHp += health.HP;
				sumMaxHp += health.MaxHP;
			}

			return sumMaxHp == 0 ? 0.0 : sumHp * 100.0 / sumMaxHp;
		}

		// Track own/enemy combat ids that leave the world or fog since the previous decision. Pure fog-safe
		// detection for the outcome-delta momentum wakes — the host never acts on this, it only surfaces it.
		static void TickOutcomeDelta(AgentSlot slot, World world)
		{
			var player = slot.Player;
			if (player == null || world == null)
				return;

			var ownCombat = world.Actors
				.Where(a => AgentCombatRoster.IsEligible(a, player))
				.Select(a => a.ActorID)
				.ToHashSet();
			var enemyCombat = GetVisibleEnemies(world, player)
				.Where(a => !a.Info.HasTraitInfo<BuildingInfo>() &&
					(a.Info.HasTraitInfo<MobileInfo>() || a.Info.HasTraitInfo<AircraftInfo>()))
				.Select(a => a.ActorID)
				.ToHashSet();

			foreach (var id in slot.TrackedOwnCombatIds)
			{
				if (!ownCombat.Contains(id))
					slot.OutcomeOwnCombatLost++;
			}

			foreach (var id in slot.TrackedEnemyCombatIds)
			{
				if (!enemyCombat.Contains(id))
					slot.OutcomeEnemyCombatLost++;
			}

			slot.TrackedOwnCombatIds.Clear();
			foreach (var id in ownCombat)
				slot.TrackedOwnCombatIds.Add(id);
			slot.TrackedEnemyCombatIds.Clear();
			foreach (var id in enemyCombat)
				slot.TrackedEnemyCombatIds.Add(id);
		}

		// Build the fog-safe outcome-delta observation (combat exchange since the last decision) plus the
		// momentum flags the model may act on. Host detects; the model decides press / counter / hold.
		static AgentOutcomeDeltaObservation BuildOutcomeDelta(AgentSlot slot, World world, Player player,
			int mainBody, bool offensive)
		{
			var enemyLost = slot.OutcomeEnemyCombatLost;
			var ownLost = slot.OutcomeOwnCombatLost;
			var localVictory = AgentDoctrineExecutor.IsLocalVictory(enemyLost, ownLost);
			var guardsNearBase = 0;
			if (slot.KnownEnemyStructureCount > 0 && player != null && world != null)
			{
				// Cheap proxy: any visible enemy combat counts as "guards" when we know structures.
				guardsNearBase = GetVisibleEnemies(world, player)
					.Count(a => !a.Info.HasTraitInfo<BuildingInfo>() &&
						(a.Info.HasTraitInfo<MobileInfo>() || a.Info.HasTraitInfo<AircraftInfo>()));
			}

			var exposed = AgentDoctrineExecutor.IsEnemyBaseExposed(slot.KnownEnemyStructureCount, guardsNearBase);
			var counter = AgentDoctrineExecutor.ShouldCounterAttackWindow(
				localVictory, exposed, mainBody, AgentWarCompiler.DefaultMinForce, offensive, false);
			var press = AgentDoctrineExecutor.ShouldPressAttack(offensive, enemyLost, ownLost);
			var summary = enemyLost == 0 && ownLost == 0
				? "no combat exchange since last decision"
				: $"since last decision: enemy combat lost ~{enemyLost}, own combat lost ~{ownLost}" +
					(localVictory ? " (local victory)" : "") +
					(exposed ? "; enemy base looks exposed" : "") +
					(counter ? "; counter-attack window open" : "") +
					(press ? "; press the attack" : "");
			return new AgentOutcomeDeltaObservation
			{
				EnemyCombatLost = enemyLost,
				OwnCombatLost = ownLost,
				LocalVictory = localVictory,
				EnemyBaseExposed = exposed,
				CounterAttackWindow = counter,
				PressAttack = press,
				Summary = summary
			};
		}

		// Fog-safe momentum flags (FIX-1 outcome-delta) shared by the wake path (DoctrineDecisionKind) and
		// the doctrine facts (BuildDoctrineObservation) so both surfaces agree. Single source of truth is
		// BuildOutcomeDelta; advisory only, never an autonomous host action.
		static (bool CounterAttackWindow, bool PressAttack) DoctrineMomentumWakes(AgentSlot slot, World world)
		{
			var delta = BuildOutcomeDelta(slot, world, slot.Player,
				DoctrineMainActorIds(slot, world).Count, HasActiveOffensiveMission(slot));
			return (delta.CounterAttackWindow, delta.PressAttack);
		}

		// defendBase commit: cancel any live offensive mission so the strike actually disengages, then
		// pull the live combat roster home to the base. Pure-safe (model committed defendBase); every
		// order is host staff-work attributed to warCompiler.
		static void TickWarCompilerDefendBase(AgentSlot slot, World world)
		{
			var player = slot.Player;
			if (player == null)
				return;

			// Abort any offensive mission first — otherwise the mission controller keeps re-ordering the
			// roster forward and fights the recall. Idempotent: once aborted, later ticks find nothing.
			CancelCompiledOffensiveMissions(slot, world);

			var home = player.HomeLocation;
			var combat = world.Actors
				.Where(a => AgentCombatRoster.IsEligible(a, player, "Move", "AttackMove", "Stop"))
				.OrderBy(a => a.ActorID)
				.Take(AgentWarCompiler.DefaultMaxForce)
				.ToArray();
			if (combat.Length == 0)
			{
				slot.War.Status = "defendEmpty";
				return;
			}

			var orders = new List<Order>();
			try
			{
				BuildOrders(slot, new AgentAction
				{
					Type = "attackMove",
					ActorIds = combat.Select(a => a.ActorID).ToList(),
					CellX = home.X,
					CellY = home.Y
				}, orders, true);
			}
			catch (InvalidDataException)
			{
				return;
			}

			IssueAgentOrders(slot, orders, false);
			slot.War.Status = "defending";
			AgentDoctrineController.RecordAction(slot.Doctrine, "compiledDefend",
				$"{combat.Length} -> home", world.WorldTick, "warCompiler");
		}

		// Cancel every live offensive mission (strike/pincer/airStrike/pursue) via the standard
		// controlMission cancel path. Used by the compiled defendBase recall so the model's defend commit
		// actually stops the offense. Pure-safe: the model committed defendBase. Silently skips a mission
		// whose version already moved on (PrepareControl throws) so a stale snapshot never wedges the tick.
		static void CancelCompiledOffensiveMissions(AgentSlot slot, World world)
		{
			var offensives = AgentMissionController.GetObservation(slot.Missions)
				.Where(mission => mission.MissionType is "strike" or "pincer" or "airStrike" or "pursue")
				.ToArray();
			foreach (var mission in offensives)
			{
				var orders = new List<Order>();
				try
				{
					BuildOrders(slot, new AgentAction
					{
						Type = "controlMission",
						MissionId = mission.MissionId,
						MissionVersion = mission.MissionVersion,
						MissionCommand = "cancel"
					}, orders, true);
				}
				catch (InvalidDataException)
				{
					continue;
				}

				IssueAgentOrders(slot, orders, false);
				AgentDoctrineController.RecordAction(slot.Doctrine, "compiledDefendCancel",
					$"aborted {mission.MissionId} v{mission.MissionVersion}", world.WorldTick, "warCompiler");
			}
		}

		// reinforceIntent base: attack-move up to `cap` idle reserve defenders home as a garrison, selected
		// through the shared structure-defense gate (never economy/base actors, never mission- or reflex-held
		// units). Returns the count moved. Pure-safe: the model authored the reinforceIntent, and planOwned
		// orders keep the dribble guard from rejecting the host's own compiled garrison move.
		static int CompileBaseGarrison(AgentSlot slot, World world, int cap, List<Order> orders)
		{
			var player = slot.Player;
			if (player == null)
				return 0;

			var defenderIds = DoctrineBaseDefenseActorIds(slot, world).Take(Math.Max(1, cap)).ToList();
			if (defenderIds.Count == 0)
				return 0;

			var home = player.HomeLocation;
			BuildOrders(slot, new AgentAction
			{
				Type = "attackMove",
				ActorIds = defenderIds,
				CellX = home.X,
				CellY = home.Y
			}, orders, true);
			AgentDoctrineController.RecordAction(slot.Doctrine, "compiledGarrison",
				$"{defenderIds.Count} -> home", world.WorldTick, "warCompiler");
			return defenderIds.Count;
		}

		// Centroid of the doctrine main squad's live actors, or null when the squad is empty/unresolved.
		// Shared by the compiled strike picker (distance ranking + staging) and the doctrine commit options.
		static CPos? MainSquadCentroid(AgentSlot slot, World world)
		{
			try
			{
				var ids = AgentSquadController.ResolveActorIds(
					slot.Squads, slot.Doctrine.Program?.MainSquadName, world, slot.Player);
				var actors = ids.Select(world.GetActorById)
					.Where(a => a != null && a.IsInWorld && !a.IsDead && !a.Disposed)
					.ToArray();
				if (actors.Length == 0)
					return null;
				var candidate = new CPos((int)actors.Average(a => a.Location.X), (int)actors.Average(a => a.Location.Y));
				return world.Map.Contains(candidate) ? candidate : actors.OrderBy(a => a.ActorID).First().Location;
			}
			catch (InvalidDataException)
			{
				return null;
			}
		}

		// Resolve a fog-safe known-enemy-structure target for a compiled strike. Prefers remembered
		// structures (fog memory), else a currently visible enemy building. Ranks candidates by the model's
		// commitIntent priority then distance from the army (R5 bug 2: the old picker sorted alphabetically
		// by type then cell, ignoring commitIntent priority). viaCell is the main squad's centroid so the
		// mission stages from where the army actually is.
		static bool TryPickDoctrineStrikeTarget(AgentSlot slot, World world, out CPos targetCell, out CPos viaCell)
		{
			targetCell = CPos.Zero;

			var centroid = MainSquadCentroid(slot, world);
			viaCell = centroid ?? slot.Player.HomeLocation;
			var reference = viaCell;
			var priority = slot.War?.Priority ?? "any";

			var known = AgentFogMemory.Update(world, slot.Player, slot.FogMemory)
				.OrderBy(k => AgentWarCompiler.TargetPriorityRank(priority, k.Type))
				.ThenBy(k => (new CPos(k.CellX, k.CellY) - reference).LengthSquared)
				.ThenBy(k => k.CellY)
				.ThenBy(k => k.CellX)
				.FirstOrDefault();
			if (known != null)
				targetCell = new CPos(known.CellX, known.CellY);
			else
			{
				var visible = world.Actors
					.Where(a => a.IsInWorld && !a.IsDead && !a.Disposed && a.OccupiesSpace != null &&
						a.Owner != null &&
						slot.Player.RelationshipWith(a.Owner) == PlayerRelationship.Enemy &&
						a.Info.HasTraitInfo<BuildingInfo>() &&
						a.CanBeViewedByPlayer(slot.Player))
					.OrderBy(a => AgentWarCompiler.TargetPriorityRank(priority, a.Info.Name))
					.ThenBy(a => (a.Location - reference).LengthSquared)
					.ThenBy(a => a.ActorID)
					.FirstOrDefault();
				if (visible == null)
					return false;
				targetCell = visible.Location;
			}

			return world.Map.Contains(targetCell) && world.Map.Contains(viaCell);
		}

		static void TickDoctrineDecisions(AgentSlot slot, World world)
		{
			if (!doctrineExecutorEnabled || !slot.Doctrine.Bound || slot.Doctrine.Paused || slot.Doctrine.Program == null)
				return;

			var decisionState = slot.DoctrineDecisions;
			var pending = decisionState.Pending;
			if (pending != null && world.WorldTick > pending.ExpiresTick)
			{
				decisionState.Pending = null;
				pending = null;
			}

			if (pending?.Kind == "rejectionRepair")
			{
				WakeForDoctrineDecision(slot, pending);
				return;
			}

			var kind = DoctrineDecisionKind(slot, world);
			if (kind == null)
			{
				if (pending != null)
					decisionState.Pending = null;
				return;
			}

			if (pending == null && AgentDoctrineDecisionController.IsKindCoolingDown(decisionState, kind, world.WorldTick))
				return;

			var decisionId = pending?.Kind == kind ? pending.DecisionId : decisionState.NextDecisionId;
			var options = BuildDoctrineDecisionOptions(slot, world, kind, decisionId);
			if (options.Count == 0)
				return;

			pending = AgentDoctrineDecisionController.Issue(decisionState, kind, world.WorldTick, options);
			if (doctrineFallbackStrikeEnabled &&
				AgentDoctrineDecisionController.ShouldFallback(pending, world.WorldTick,
					DoctrineOffensePreconditions(slot, world), slot.RequestInFlight))
			{
				var fallback = pending.Options.FirstOrDefault(option => option.Kind is "strike" or "raid");
				if (fallback != null && TryExecuteDoctrineOption(slot, world, pending, fallback,
					"doctrineFallback", out var fallbackOrders, out var fallbackReason))
				{
					IssueAgentOrders(slot, fallbackOrders, false);
					AgentDoctrineController.RecordAction(slot.Doctrine, "fallbackStrike", fallback.Label,
						world.WorldTick, "doctrineFallback", pending.DecisionId,
						MissionIdFromOption(fallback), OrderActorIds(fallbackOrders), fallbackReason);
					slot.FallbackMissionId = MissionIdFromOption(fallback);
					slot.FallbackMissionVersion = fallback.Actions
						.FirstOrDefault(action => action.Type == "queueMission")?.MissionVersion ?? 0;
					AgentDoctrineDecisionController.Resolve(decisionState, world.WorldTick);
					return;
				}
			}

			WakeForDoctrineDecision(slot, pending);
		}

		static void WakeForDoctrineDecision(AgentSlot slot, AgentDoctrineDecisionController.Decision pending)
		{
			var world = GetRegularWorld();
			if (world.WorldTick >= pending.RearmTick && !slot.RequestInFlight && slot.ClaimedTrigger == null)
			{
				var trigger = $"doctrine:{pending.Kind}:{pending.DecisionId}";
				if (slot.PendingTrigger == null || slot.PendingPriority < 2)
				{
					slot.PendingTrigger = trigger;
					slot.PendingAlertKey = null;
					slot.PendingPriority = 2;
				}
			}
		}

		static string DoctrineDecisionKind(AgentSlot slot, World world)
		{
			var reinforceActors = DoctrineReinforceActorIds(slot, world);
			var offensive = ActiveGroundOffensiveTarget(slot);
			var reinforce = AgentDoctrineDecisionController.ShouldOfferReinforce(
				offensive != null, HasActiveReinforceMission(slot), reinforceActors.Count);
			var regroupActors = DoctrineRegroupActorIds(slot, world);
			var regroup = AgentDoctrineDecisionController.ShouldOfferRegroup(
				HasActiveGroundOffensiveMission(slot), slot.Missions.LastGroundOffensiveTerminalTick,
				world.WorldTick, regroupActors.Count);
			var enemyContact = slot.EnemyContactSeen && DoctrineMainActorIds(slot, world).Count != 0 &&
				!HasActiveOffensiveMission(slot);
			var baseDefense = TryGetBaseDefenseThreatCell(slot, world, out _);
			var phase = slot.Doctrine.Program?.Phases.FirstOrDefault(item => item.Name == slot.Doctrine.Phase);
			var (counterAttackWindow, pressAttack) = DoctrineMomentumWakes(slot, world);
			return AgentDoctrineExecutor.NeedsDecisionWake(doctrineExecutorEnabled, slot.Doctrine.Bound,
				slot.Doctrine.Paused, DoctrineOffensePreconditions(slot, world),
				slot.Doctrine.Held && phase != null, reinforce, regroup, enemyContact, slot.Doctrine.ScoutFailed,
				baseDefense, counterAttackWindow, pressAttack);
		}

		static bool DoctrineOffensePreconditions(AgentSlot slot, World world)
		{
			var program = slot.Doctrine.Program;
			return program != null && DoctrineMainActorIds(slot, world).Count >= Math.Max(1, program.CommitMinUnits) &&
				slot.KnownEnemyStructureCount > 0 && !HasActiveOffensiveMission(slot);
		}

		static bool HasActiveOffensiveMission(AgentSlot slot)
		{
			return AgentMissionController.GetObservation(slot.Missions)
				.Any(mission => mission.MissionType is "strike" or "pincer" or "airStrike" or "pursue");
		}

		static AgentMissionController.Snapshot ActiveGroundOffensiveTarget(AgentSlot slot)
		{
			return AgentMissionController.GetObservation(slot.Missions)
				.Where(mission => AgentMissionController.IsGroundOffensive(mission.MissionType) &&
					!mission.Paused && mission.TargetCell.HasValue)
				.OrderBy(mission => mission.MissionId, StringComparer.Ordinal).FirstOrDefault();
		}

		static bool HasActiveGroundOffensiveMission(AgentSlot slot)
		{
			return AgentMissionController.GetObservation(slot.Missions)
				.Any(mission => AgentMissionController.IsGroundOffensive(mission.MissionType));
		}

		static bool HasActiveReinforceMission(AgentSlot slot)
		{
			return AgentMissionController.GetObservation(slot.Missions)
				.Any(mission => mission.MissionType == "reinforce");
		}

		static IReadOnlyList<uint> DoctrineReinforceActorIds(AgentSlot slot, World world)
		{
			return AgentDoctrineDecisionController.SelectReinforceCandidates(
				DoctrineDecisionCandidates(slot, world, DoctrineMainActorIds(slot, world)));
		}

		static IReadOnlyList<uint> DoctrineRegroupActorIds(AgentSlot slot, World world)
		{
			return AgentDoctrineDecisionController.SelectRegroupCandidates(
				DoctrineDecisionCandidates(slot, world, slot.Missions.LastGroundOffensiveSurvivorIds));
		}

		static IEnumerable<AgentDoctrineDecisionController.Candidate> DoctrineDecisionCandidates(
			AgentSlot slot, World world, IEnumerable<uint> allowedActorIds)
		{
			foreach (var actorId in (allowedActorIds ?? []).Distinct().Order())
			{
				var actor = world.GetActorById(actorId);
				var modelLeased = slot.Reflexes.ActorLeaseUntil.TryGetValue(actorId, out var leaseUntil) &&
					world.WorldTick <= leaseUntil;
				var reflexActive = slot.Reflexes.ReflexCooldownUntil.TryGetValue(actorId, out var reflexUntil) &&
					world.WorldTick <= reflexUntil;
				yield return new AgentDoctrineDecisionController.Candidate
				{
					ActorId = actorId,
					AllowedRosterMember = true,
					OwnedLiveCombat = AgentCombatRoster.IsEligible(actor, slot.Player, "Move", "AttackMove", "Stop"),
					Idle = actor?.IsIdle == true,
					InMission = slot.Missions.ActorMission.ContainsKey(actorId),
					InterventionActive = modelLeased || reflexActive,
					DistanceFromHomeSquared = actor == null ? int.MaxValue :
						(actor.Location - slot.Player.HomeLocation).LengthSquared
				};
			}
		}

		static IReadOnlyList<uint> DoctrineMainActorIds(AgentSlot slot, World world)
		{
			var name = slot.Doctrine.Program?.MainSquadName;
			if (string.IsNullOrEmpty(name))
				return [];
			try
			{
				return AgentSquadController.ResolveActorIds(slot.Squads, name, world, slot.Player);
			}
			catch (InvalidDataException)
			{
				return [];
			}
		}

		// Base-defense sensor for the assisted/executor baseDefenseNeeded wake (spec §2 B4). Fires on a
		// visible enemy already inside the base-threat radius, OR an ordinary structure under recent
		// attack (AgentDamageObserver → NotifyDamage) with a visible attacker within 20 cells. Fog-safe:
		// only GetVisibleEnemies actors are considered, and the threat cell is a live enemy location so a
		// defendBase offer never chases a hidden or stale ghost. Detection only — it issues no orders and
		// the host never auto-defends; it only lets the host OFFER commitIntent defendBase.
		static bool TryGetBaseDefenseThreatCell(AgentSlot slot, World world, out CPos threatCell)
		{
			threatCell = default;
			if (!doctrineExecutorEnabled || slot.Doctrine.Program == null)
				return false;

			var visibleEnemies = GetVisibleEnemies(world, slot.Player);
			if (visibleEnemies.Length == 0)
				return false;

			var baseCell = FindBaseCell(world, slot.Player, slot.CriticalActors.Values);
			var nearBase = visibleEnemies
				.Where(enemy => (enemy.Location - baseCell).LengthSquared <= BaseThreatRadius * BaseThreatRadius)
				.OrderBy(enemy => (enemy.Location - baseCell).LengthSquared)
				.ThenBy(enemy => enemy.ActorID)
				.FirstOrDefault();
			if (nearBase != null)
			{
				threatCell = nearBase.Location;
				return true;
			}

			const int AttackerRadiusSquared = BaseDefenseAttackerRadius * BaseDefenseAttackerRadius;
			foreach (var attacked in slot.AlertStates.Values
				.Where(alert => alert.Alert.Kind == "structureAttacked" && alert.Alert.Cell != null &&
					world.WorldTick - alert.LastUpdatedTick <= AttackActiveTicks)
				.OrderBy(alert => alert.Alert.AffectedActorId))
			{
				var structureCell = new CPos(attacked.Alert.Cell.X, attacked.Alert.Cell.Y);
				var attacker = visibleEnemies
					.Where(enemy => (enemy.Location - structureCell).LengthSquared <= AttackerRadiusSquared)
					.OrderBy(enemy => (enemy.Location - structureCell).LengthSquared)
					.ThenBy(enemy => enemy.ActorID)
					.FirstOrDefault();
				if (attacker != null)
				{
					threatCell = attacker.Location;
					return true;
				}
			}

			return false;
		}

		// Idle, target-capable defenders the model may commit to a base-defense threat: every owned combat
		// roster member (via AgentCombatRoster, so economy/base-builders can never be pulled), filtered
		// through the shared candidate gate that excludes mission/model-lease/reflex-held actors.
		static IReadOnlyList<uint> DoctrineBaseDefenseActorIds(AgentSlot slot, World world)
		{
			var ownedCombatIds = world.Actors
				.Where(actor => AgentCombatRoster.IsEligible(actor, slot.Player, "Move", "AttackMove", "Stop"))
				.Select(actor => actor.ActorID);
			return AgentDoctrineDecisionController.SelectDefenseCandidates(
				DoctrineDecisionCandidates(slot, world, ownedCombatIds));
		}

		static List<AgentGuidanceOptionObservation> BuildDoctrineDecisionOptions(AgentSlot slot, World world,
			string kind, long decisionId)
		{
			var options = new List<AgentGuidanceOptionObservation>();
			var program = slot.Doctrine.Program;
			if (program == null)
				return options;

			if (kind == "baseDefenseNeeded")
			{
				if (!TryGetBaseDefenseThreatCell(slot, world, out var threatCell))
					return options;

				var defenderIds = DoctrineBaseDefenseActorIds(slot, world);
				if (defenderIds.Count == 0)
				{
					// No live idle defender is free to answer the threat: surface throttled telemetry
					// only (once per resolution cooldown) and issue zero orders. The empty option list
					// means the wake is never offered, so the host neither moves a force that is not
					// there nor auto-issues a defense order.
					var decisions = slot.DoctrineDecisions;
					if (!AgentDoctrineDecisionController.IsKindCoolingDown(decisions, "defenseEmpty", world.WorldTick))
					{
						AgentDoctrineController.RecordAction(slot.Doctrine, "defenseEmpty",
							$"threat at {threatCell.X},{threatCell.Y}; no eligible idle defender",
							world.WorldTick, "doctrine", decisionId,
							reason: "base-defense wake with an empty defender roster");
						decisions.KindCooldownUntil["defenseEmpty"] =
							world.WorldTick + AgentDoctrineDecisionController.ResolutionCooldownTicks;
					}

					return options;
				}

				// Offer the commit, not a one-shot attack-move: selecting this executes commitIntent
				// defendBase, and the war compiler recalls the roster and aborts the offense (consistent
				// with the commit architecture, still a model choice with no auto orders). The defender
				// roster above only gates the offer — someone must be free to answer before we surface it.
				// The commitIntent action is stable across re-authoring, so acceptDoctrineDecision's exact
				// option match never trips on a shifting actor list the way the old defend-home option could.
				options.Add(new AgentGuidanceOptionObservation
				{
					OptionId = "commit-defend-base",
					Label = "Commit defendBase: recall the army to defend the base " +
						$"(threat near {threatCell.X},{threatCell.Y})",
					Kind = "baseDefenseNeeded",
					Actions = [new AgentAction { Type = "commitIntent", Intent = "defendBase" }]
				});
				options.Add(DeferOption());
				return options;
			}

			if (kind == "reinforceAttack")
			{
				var offensive = ActiveGroundOffensiveTarget(slot);
				var actorIds = DoctrineReinforceActorIds(slot, world);
				if (!AgentDoctrineDecisionController.ShouldOfferReinforce(offensive != null,
					HasActiveReinforceMission(slot), actorIds.Count))
					return options;

				var target = offensive.TargetCell.Value;
				options.Add(AgentDoctrineDecisionController.ExactAttackMoveOption("reinforce-wave",
					$"Attack-move {actorIds.Count} disclosed reserves to {target.X},{target.Y}",
					"reinforceAttack", actorIds, target.X, target.Y));
				options.Add(DeferOption());
				return options;
			}

			if (kind == "regroupNeeded")
			{
				var actorIds = DoctrineRegroupActorIds(slot, world);
				if (!AgentDoctrineDecisionController.ShouldOfferRegroup(HasActiveGroundOffensiveMission(slot),
					slot.Missions.LastGroundOffensiveTerminalTick, world.WorldTick, actorIds.Count))
					return options;

				var home = slot.Player.HomeLocation;
				options.Add(AgentDoctrineDecisionController.ExactAttackMoveOption("regroup-home",
					$"Attack-move {actorIds.Count} disclosed survivors home to {home.X},{home.Y}",
					"regroupNeeded", actorIds, home.X, home.Y));
				options.Add(DeferOption());
				return options;
			}

			if (kind == "phaseReady")
			{
				options.Add(new AgentGuidanceOptionObservation
				{
					OptionId = "advance",
					Label = "Advance to the next doctrine phase",
					Kind = "advance",
					Actions = [new AgentAction { Type = "controlDoctrine", DoctrineCommand = "advancePhase" }]
				});
				options.Add(DeferOption());
				return options;
			}

			if (kind == "counterAttackWindow")
			{
				// Momentum (FIX-1 outcome-delta): local win + thin enemy base. Offer a war-compiler-native
				// strike commit — the compiler stages and launches at a known structure. A real model choice,
				// never auto-fired (Kind is neither "strike" nor "raid", so the fallback path never runs it).
				if (DoctrineMainActorIds(slot, world).Count == 0)
					return options;
				options.Add(new AgentGuidanceOptionObservation
				{
					OptionId = "counter-commit-strike",
					Label = "Counter-attack: commitIntent strike now while the enemy base is thin",
					Kind = "counterAttackWindow",
					Actions = [new AgentAction { Type = "commitIntent", Intent = "strike", Priority = "production" }]
				});
				options.Add(DeferOption());
				return options;
			}

			if (kind == "pressAttack")
			{
				// Momentum (FIX-1 outcome-delta): our live offensive is winning. Offer reinforceIntent
				// activeStrike (the compiler feeds idle home combat into the live wave). A real model choice,
				// never auto-fired.
				options.Add(new AgentGuidanceOptionObservation
				{
					OptionId = "press-reinforce-strike",
					Label = "Press the attack: reinforceIntent activeStrike to feed the live wave",
					Kind = "pressAttack",
					Actions = [new AgentAction { Type = "reinforceIntent", To = "activeStrike" }]
				});
				options.Add(DeferOption());
				return options;
			}

			var targets = KnownDoctrineTargets(slot, world);
			var production = targets.FirstOrDefault(target => DoctrineTargetPriority(target.Type) == 0);
			if (production.Cell.HasValue)
				options.Add(MissionOption("strike-production", "Strike known production", "strike",
					program.MainSquadName, production.Cell.Value,
					DoctrineStagingVia(slot, world, production.Cell.Value), decisionId, "production", "assault"));

			var refinery = targets.FirstOrDefault(target => DoctrineTargetPriority(target.Type) == 1);
			if (refinery.Cell.HasValue)
				options.Add(MissionOption("raid-economy", "Raid the known refinery", "raid",
					program.MainSquadName, refinery.Cell.Value,
					DoctrineStagingVia(slot, world, refinery.Cell.Value), decisionId, "economy", "raid"));

			if (options.Count == 0 && targets.FirstOrDefault().Cell is { } otherCell)
				options.Add(MissionOption("strike-structure", "Strike a known enemy structure", "strike",
					program.MainSquadName, otherCell,
					DoctrineStagingVia(slot, world, otherCell), decisionId, "any", "assault"));

			if (options.Count < 2)
			{
				var frontier = AgentAdvisor.SurveyShroud(world, slot.Player).Frontier.FirstOrDefault();
				var actorIds = kind == "scoutFailed" ? DoctrineScoutActorIds(slot, world) : DoctrineMainActorIds(slot, world);
				if (frontier != null && actorIds.Count != 0)
					options.Add(new AgentGuidanceOptionObservation
					{
						OptionId = "scout-frontier",
						Label = $"Continue scouting frontier {frontier.X},{frontier.Y}",
						Kind = "scout",
						Actions =
						[
							new AgentAction
							{
								Type = "attackMove",
								ActorIds = [.. actorIds],
								CellX = frontier.X,
								CellY = frontier.Y
							}
						]
					});
			}

			options.Add(DeferOption());
			return options.Take(3).ToList();
		}

		static IReadOnlyList<uint> DoctrineScoutActorIds(AgentSlot slot, World world)
		{
			var name = slot.Doctrine.Program?.ScoutSquadName;
			if (string.IsNullOrEmpty(name))
				return [];
			try
			{
				return AgentSquadController.ResolveActorIds(slot.Squads, name, world, slot.Player);
			}
			catch (InvalidDataException)
			{
				return [];
			}
		}

		static List<(string Type, CPos? Cell, int LastSeenTick)> KnownDoctrineTargets(AgentSlot slot, World world)
		{
			var remembered = AgentFogMemory.Update(world, slot.Player, slot.FogMemory)
				.Select(item => (Type: item.Type, Cell: (CPos?)new CPos(item.CellX, item.CellY),
					LastSeenTick: item.LastSeenTick));
			var visible = GetVisibleEnemies(world, slot.Player)
				.Where(actor => actor.Info.HasTraitInfo<BuildingInfo>())
				.Select(actor => (Type: actor.Info.Name, Cell: (CPos?)actor.Location, LastSeenTick: world.WorldTick));
			return remembered.Concat(visible)
				.GroupBy(item => (item.Type, item.Cell))
				.Select(group => group.OrderByDescending(item => item.LastSeenTick).First())
				.OrderBy(item => DoctrineTargetPriority(item.Type))
				.ThenByDescending(item => item.LastSeenTick)
				.ThenBy(item => item.Cell.Value.Y)
				.ThenBy(item => item.Cell.Value.X)
				.ToList();
		}

		static int DoctrineTargetPriority(string type)
		{
			if (type is "weap" or "barr" or "tent" or "afld" or "hpad" or "spen" or "syrd")
				return 0;
			if (type == "proc")
				return 1;
			if (type is "fact" or "afac")
				return 2;
			return 3;
		}

		// Home-biased staging cell for a doctrine commit option so the committed army masses short of the
		// target instead of on the attack point (R5 bug 1: the commit option used to stage on the target).
		// Falls back to the reference/home, then the target, when the map rejects the staged cell.
		static CPos DoctrineStagingVia(AgentSlot slot, World world, CPos target)
		{
			var reference = MainSquadCentroid(slot, world) ?? slot.Player.HomeLocation;
			var staging = AgentWarCompiler.StagingCell(reference, target);
			if (world.Map.Contains(staging))
				return staging;
			return world.Map.Contains(reference) ? reference : target;
		}

		static AgentGuidanceOptionObservation MissionOption(string optionId, string label, string kind,
			string squad, CPos target, CPos via, long decisionId, string priority, string posture)
		{
			return new AgentGuidanceOptionObservation
			{
				OptionId = optionId,
				Label = label,
				Kind = kind,
				Actions =
				[
					new AgentAction
					{
						Type = "queueMission",
						MissionId = $"commit-{decisionId}",
						MissionType = "strike",
						MissionVersion = 1,
						CellX = target.X,
						CellY = target.Y,
						Legs = [new AgentMissionLegInput { Squad = squad, ViaX = via.X, ViaY = via.Y }],
						Posture = posture,
						TargetPriority = priority,
						AbortLossPercent = 40
					}
				]
			};
		}

		static AgentGuidanceOptionObservation DeferOption()
		{
			return new AgentGuidanceOptionObservation
			{
				OptionId = "defer",
				Label = "Explicitly defer for 375 ticks",
				Kind = "defer"
			};
		}

		static bool TryExecuteDoctrineOption(AgentSlot slot, World world,
			AgentDoctrineDecisionController.Decision decision, AgentGuidanceOptionObservation option,
			string source, out List<Order> orders, out string reason)
		{
			orders = [];
			reason = null;
			if (decision == null || option == null || world.WorldTick > decision.ExpiresTick)
				return false;
			if (option.Kind == "defer")
			{
				reason = "explicit bounded defer";
				return true;
			}

			try
			{
				if (AgentBuildPlanController.IsExecutorCancelFirstBatch(doctrineExecutorEnabled, option.Actions))
				{
					// Validate and materialize the retry before cancelling the plan. Direct production
					// validation is side-effect free here; planOwned only bypasses the reservation that
					// this exact cancel-first option is about. This prevents a failed retry from leaving
					// the plan cancelled even though the enclosing exact option was rejected.
					var retryOrders = new List<Order>();
					foreach (var exactAction in option.Actions.Skip(1))
					{
						if (exactAction.Type == "acceptDoctrineDecision")
							throw new InvalidDataException("guidance options cannot recursively select guidance");
						BuildOrders(slot, exactAction, retryOrders, true);
					}

					BuildOrders(slot, option.Actions[0], orders);
					orders.AddRange(retryOrders);
				}
				else
				{
					foreach (var exactAction in option.Actions)
					{
						if (exactAction.Type == "acceptDoctrineDecision")
							throw new InvalidDataException("guidance options cannot recursively select guidance");
						BuildOrders(slot, exactAction, orders);
					}
				}

				reason = $"{source} selected exact option '{option.OptionId}'";
				return true;
			}
			catch (InvalidDataException e)
			{
				orders.Clear();
				reason = e.Message;
				return false;
			}
		}

		static string MissionIdFromOption(AgentGuidanceOptionObservation option)
		{
			return option?.Actions.FirstOrDefault(action => action.Type == "queueMission")?.MissionId;
		}

		static List<uint> OrderActorIds(IEnumerable<Order> orders)
		{
			return orders.Select(order => order.Subject)
				.Where(actor => actor != null)
				.Select(actor => actor.ActorID)
				.Distinct().Order().ToList();
		}

		static IEnumerable<uint> PendingDecisionActorIds(AgentDoctrineDecisionController.Decision decision)
		{
			if (decision == null)
				return [];

			return decision.Options.SelectMany(option => option.Actions ?? [])
				.SelectMany(action => action.ActorIds ?? []).Distinct().Order();
		}

		static bool ExactOptionActionsMatch(AgentGuidanceOptionObservation offered,
			AgentGuidanceOptionObservation refreshed)
		{
			return offered.OptionId == refreshed.OptionId && offered.Kind == refreshed.Kind &&
				JsonSerializer.Serialize(offered.Actions, CanonicalJsonOptions) ==
				JsonSerializer.Serialize(refreshed.Actions, CanonicalJsonOptions);
		}

		static void MaintainDoctrineSquads(AgentSlot slot, World world, AgentDoctrineProgram.Program program)
		{
			var scoutTypes = new HashSet<string>(program.ScoutUnitTypes ?? [], StringComparer.Ordinal);
			var mainTypes = new HashSet<string>(program.MainUnitTypes ?? [], StringComparer.Ordinal);
			var eligible = world.Actors
				.Where(a => a.Info.HasTraitInfo<AttackMoveInfo>() &&
					AgentCombatRoster.IsEligible(a, slot.Player, "Move", "AttackMove", "Stop"))
				.OrderBy(a => a.ActorID)
				.ToArray();

			// Scout quotas are applied first by type and actor id. If a type is also a main type,
			// only the quota enters the scout role and the remaining actors stay available to main.
			var scouts = eligible
				.Where(a => scoutTypes.Contains(a.Info.Name))
				.GroupBy(a => a.Info.Name, StringComparer.Ordinal)
				.OrderBy(group => group.Key, StringComparer.Ordinal)
				.SelectMany(group => group.Take(program.ScoutTypeQuotas.GetValueOrDefault(group.Key, int.MaxValue)))
				.OrderBy(a => a.ActorID)
				.ToArray();
			MaintainDoctrineSquad(slot, program.ScoutSquadName, scouts);

			var scoutIds = scouts.Select(a => a.ActorID).ToHashSet();
			var main = eligible
				.Where(a => mainTypes.Contains(a.Info.Name) && !scoutIds.Contains(a.ActorID))
				.OrderBy(a => a.ActorID)
				.ToArray();
			MaintainDoctrineSquad(slot, program.MainSquadName, main);
		}

		static void MaintainDoctrineSquad(AgentSlot slot, string name, Actor[] actors)
		{
			// Squad maintenance emits no orders and is invisible to the simulation, so it is not
			// recorded as a doctrine action (that would drown out real interventions in the
			// attribution window). Assign throws on an empty set, so skip when there is nothing live.
			if (string.IsNullOrEmpty(name) || actors.Length == 0)
				return;

			try
			{
				AgentSquadController.Assign(slot.Squads, name, actors, slot.Player);
			}
			catch (InvalidDataException)
			{
				// Membership can change between enumeration and assignment; a stale set is dropped.
			}
		}

		static void LaunchDoctrineScout(AgentSlot slot, World world, AgentDoctrineProgram.Program program)
		{
			var state = slot.Doctrine;
			var scoutMissionActive = AgentMissionController.GetObservation(slot.Missions)
				.Any(m => m.MissionId == DoctrineScoutMissionId);

			var scoutLive = 0;
			try
			{
				scoutLive = AgentSquadController
					.ResolveActorIds(slot.Squads, program.ScoutSquadName, world, slot.Player).Count;
			}
			catch (InvalidDataException)
			{
				scoutLive = 0;
			}

			if (AgentDoctrineController.PhaseRequiresEnemyStructureContact(state) &&
				slot.KnownEnemyStructureCount > 0)
				return;

			if (!AgentDoctrineExecutor.ShouldLaunchScout(doctrineExecutorEnabled, state.Bound, state.Paused,
				phaseHasScoutSweep: true, scoutMissionActive, scoutLive,
				world.WorldTick, state.NextScoutEligibleTick))
				return;

			var nextMissionVersion = state.ScoutMissionVersion + 1;
			var activePhase = program.Phases.FirstOrDefault(phase => phase.Name == state.Phase);
			var exploredTarget = activePhase?.ExitMinExploredPercent > 0
				? activePhase.ExitMinExploredPercent
				: program.ScoutExploredPercentTarget > 0 ? program.ScoutExploredPercentTarget : 85;
			var orders = new List<Order>();
			try
			{
				// Reuse the model's own mission path: a sweep queued through AgentMissionController
				// inherits the existing precedence (a direct model order releases its roster, safety
				// reflexes detach it) for free, so doctrine sits below model and reflex by construction.
				BuildOrders(slot, new AgentAction
				{
					Type = "queueMission",
					MissionType = "sweep",
					MissionId = DoctrineScoutMissionId,
					MissionVersion = nextMissionVersion,
					GroupName = program.ScoutSquadName,
					ExploredPercentTarget = exploredTarget
				}, orders, true);
			}
			catch (InvalidDataException)
			{
				// No free mission slot, or the squad emptied since maintenance: retry next tick.
				return;
			}

			IssueAgentOrders(slot, orders, false);
			state.ScoutMissionVersion = nextMissionVersion;
			state.NextScoutEligibleTick = world.WorldTick +
				AgentDoctrineExecutor.DefaultScoutRelaunchCooldownTicks;
			state.ScoutMissionWasActive = true;
			AgentDoctrineController.RecordAction(state, "scoutSweep",
				$"{program.ScoutSquadName} v{state.ScoutMissionVersion}", world.WorldTick);
			slot.HostScoutSweepCount++;
		}

		static void StreamDoctrineUnits(AgentSlot slot, World world, AgentDoctrineProgram.Program program)
		{
			var state = slot.Doctrine;
			if (program.StreamUnits == null)
				return;

			var resources = slot.Player.PlayerActor?.TraitOrDefault<PlayerResources>();
			var cash = resources?.GetCashAndResources() ?? 0;
			var planWaitingCash = slot.BuildPlan.Active && slot.BuildPlan.StepState == "waitingCash";
			var maxConcurrent = AgentDoctrineExecutor.EffectiveStreamMaxConcurrent(program);
			var batch = AgentDoctrineExecutor.EffectiveStreamBatchCount(program);

			foreach (var unit in program.StreamUnits)
			{
				// Order latency: a just-issued production order is not reflected in AllQueued() for
				// several ticks. Without this cooldown the executor would re-issue every tick during
				// the gap and overshoot StreamMaxConcurrent / the plan cash reserve — over-playing
				// for the model. The cooldown exceeds order latency so a prior emission lands first.
				if (world.WorldTick < state.StreamNextTick.GetValueOrDefault(unit))
					continue;

				if (!world.Map.Rules.Actors.TryGetValue(unit, out var actorInfo))
					continue;

				var queue = FindDoctrineStreamQueue(slot, world, actorInfo);
				if (queue.Actor == null)
					continue;

				var unitCost = queue.Trait.GetProductionCost(actorInfo);
				var inFlight = queue.Trait.AllQueued().Count(i => i.Item == actorInfo.Name);
				var quantity = AgentDoctrineExecutor.StreamQuantity(doctrineExecutorEnabled, state.Bound, state.Paused,
					phaseHasStreamUnits: true, cash, program.CashReserveForPlan, planWaitingCash, unitCost, inFlight,
					maxConcurrent, batch);
				if (quantity <= 0)
					continue;

				var orders = new List<Order>();
				try
				{
					BuildOrders(slot, new AgentAction
					{
						Type = "startProduction",
						ProducerId = queue.Actor.ActorID,
						Item = actorInfo.Name,
						Count = quantity
					}, orders, true);
				}
				catch (InvalidDataException)
				{
					continue;
				}

				IssueAgentOrders(slot, orders, false);
				state.StreamNextTick[unit] = world.WorldTick + DoctrineStreamCooldownTicks;
				AgentDoctrineController.RecordAction(state, "streamUnits",
					$"{actorInfo.Name}x{quantity}", world.WorldTick);

				// Reflect the projected spend so a second stream type in the same tick does not
				// overcommit the reserve-protected balance.
				cash -= unitCost * quantity;
			}
		}

		// A queue owned by this player that can build the item and is not the one the build plan is
		// actively driving, so the stream never dual-owns the plan's queue (decision D5 / no thrash).
		static TraitPair<ProductionQueue> FindDoctrineStreamQueue(AgentSlot slot, World world, ActorInfo actorInfo)
		{
			// Never stream into the producer the build plan has bound (any step state): the plan's
			// waitingCash gate stalls on a busy queue, so the model's own production stays first.
			var plan = slot.BuildPlan;
			var planProducer = plan.Active && plan.ProducerId != 0 ? plan.ProducerId : 0u;

			return world.ActorsWithTrait<ProductionQueue>()
				.Where(q => q.Actor.Owner == slot.Player && q.Actor.IsInWorld && !q.Actor.IsDead && !q.Actor.Disposed &&
					q.Actor.ActorID != planProducer &&
					q.Trait.CanBuild(actorInfo) && q.Trait.BuildableItems().Contains(actorInfo))
				.OrderBy(q => q.Actor.ActorID)
				.ThenBy(q => q.Trait.Info.Type, StringComparer.Ordinal)
				.FirstOrDefault();
		}

		// Tear down standing doctrine emissions when the model switches to a different card, so a
		// stale scout sweep does not keep issuing orders under the new strategy.
		static void CleanupDoctrineStanding(AgentSlot slot, List<Order> orders)
		{
			var scout = AgentMissionController.GetObservation(slot.Missions)
				.FirstOrDefault(m => m.MissionId == DoctrineScoutMissionId);
			if (scout == null)
				return;

			try
			{
				BuildOrders(slot, new AgentAction
				{
					Type = "controlMission",
					MissionId = DoctrineScoutMissionId,
					MissionVersion = scout.MissionVersion,
					MissionCommand = "cancel"
				}, orders, true);
			}
			catch (InvalidDataException)
			{
				// The mission may have terminated between observation and cancel; nothing to tear down.
			}
		}

		static void UpdateEventBus(AgentSlot slot, World world)
		{
			if (world.WorldTick < ObservationWarmupTicks || slot.LastEventScanTick == world.WorldTick)
				return;

			slot.LastEventScanTick = world.WorldTick;
			var criticalActors = GetCriticalActors(world, slot.Player);
			var visibleEnemies = GetVisibleEnemies(world, slot.Player);
			var knownStructures = AgentFogMemory.Update(world, slot.Player, slot.FogMemory);
			slot.KnownEnemyStructureCount = knownStructures.Count +
				visibleEnemies.Count(actor => actor.Info.HasTraitInfo<BuildingInfo>());
			var baseCell = FindBaseCell(world, slot.Player, criticalActors.Values);
			var nearbyEnemies = visibleEnemies
				.Where(a => (a.Location - baseCell).LengthSquared <= BaseThreatRadius * BaseThreatRadius)
				.ToArray();
			var visibleEnemyValue = visibleEnemies.Sum(ActorValue);
			var materialEnemyContact = knownStructures.Count != 0 ||
				visibleEnemies.Any(actor => actor.Info.HasTraitInfo<BuildingInfo>()) ||
				visibleEnemyValue >= MaterialEnemyValue;
			var productionStates = GetProductionStates(world, slot.Player);
			var powerState = slot.Player.PlayerActor?.TraitOrDefault<PowerManager>()?.PowerState ?? PowerState.Normal;
			UpdateMilestones(slot, world);

			if (!slot.EventStateInitialized)
			{
				slot.EventStateInitialized = true;
				slot.LastPowerState = powerState;
				slot.LastVisibleEnemyValue = visibleEnemyValue;
				slot.LastVisibleEnemyCount = visibleEnemies.Length;
				slot.LastNearbyEnemyCount = nearbyEnemies.Length;
				ReplaceDictionary(slot.CriticalActors, criticalActors);
				ReplaceDictionary(slot.ProductionStates, productionStates);
				if (visibleEnemies.Length != 0)
				{
					slot.EverSawEnemy = true;
					RaiseAlert(slot, world, "firstContact", "firstContact", "warning", visibleEnemies[0].ActorID,
						visibleEnemies[0].Location, visibleEnemies, false);
					if (nearbyEnemies.Length != 0)
						RaiseAlert(slot, world, "enemyNearBase", "enemyNearBase", "critical", nearbyEnemies[0].ActorID,
							nearbyEnemies[0].Location, nearbyEnemies, false);
				}

				if (materialEnemyContact)
				{
					slot.EnemyContactSeen = true;
					var contact = visibleEnemies.FirstOrDefault(actor => actor.Info.HasTraitInfo<BuildingInfo>()) ??
						visibleEnemies.FirstOrDefault();
					RaiseAlert(slot, world, "enemyContact", "enemyContact", "warning", contact?.ActorID ?? 0,
						contact?.Location ?? new CPos(knownStructures[0].CellX, knownStructures[0].CellY), visibleEnemies, false);
				}

				UpdateSituationEngine(slot, world, baseCell, visibleEnemies, knownStructures, powerState);
				return;
			}

			var activeKeys = new HashSet<string>();
			if (materialEnemyContact)
			{
				activeKeys.Add("enemyContact");
				if (!slot.EnemyContactSeen)
				{
					slot.EnemyContactSeen = true;
					var contact = visibleEnemies.FirstOrDefault(actor => actor.Info.HasTraitInfo<BuildingInfo>()) ??
						visibleEnemies.FirstOrDefault();
					RaiseAlert(slot, world, "enemyContact", "enemyContact", "warning", contact?.ActorID ?? 0,
						contact?.Location ?? new CPos(knownStructures[0].CellX, knownStructures[0].CellY), visibleEnemies, false);
				}
			}

			foreach (var ordinaryDamage in slot.AlertStates.Values.Where(alert =>
				alert.Alert.Kind == "structureAttacked" && world.WorldTick - alert.LastUpdatedTick <= AttackActiveTicks))
				activeKeys.Add(ordinaryDamage.Key);
			foreach (var actor in criticalActors.Values)
			{
				var attackedKey = $"criticalAssetAttacked:{actor.ActorId}";
				if (slot.AlertStates.TryGetValue(attackedKey, out var attacked) &&
					world.WorldTick - attacked.LastUpdatedTick <= AttackActiveTicks)
					activeKeys.Add(attackedKey);

				if (slot.CriticalActors.TryGetValue(actor.ActorId, out var previous) && actor.Health < previous.Health)
				{
					activeKeys.Add(attackedKey);
					RaiseAlert(slot, world, attackedKey, "criticalAssetAttacked", "critical", actor.ActorId,
						actor.Cell, visibleEnemies, false);
				}
			}

			foreach (var lost in slot.CriticalActors.Values.Where(a => !criticalActors.ContainsKey(a.ActorId)))
			{
				if (TryRecordStaleDeployProof(slot, world, lost))
					continue;

				// Transforming an MCV into its Construction Yard replaces the actor id. Prefer true
				// deployable→construction continuity (successor yard / production building near the
				// old cell) over pure same-cell matching — footprints can shift on deploy.
				if (IsCriticalAssetContinuity(lost, criticalActors.Values))
					continue;

				var key = $"criticalAssetLost:{lost.ActorId}";
				activeKeys.Add(key);
				RaiseAlert(slot, world, key, "criticalAssetLost", "critical", lost.ActorId,
					lost.Cell, visibleEnemies, true);
			}

			foreach (var expiredProof in slot.StaleDeployProofs
				.Where(proof => world.WorldTick - proof.Value.Tick > 1500).Select(proof => proof.Key).ToArray())
				slot.StaleDeployProofs.Remove(expiredProof);

			if (!slot.EverSawEnemy && visibleEnemies.Length != 0)
			{
				slot.EverSawEnemy = true;
				const string Key = "firstContact";
				activeKeys.Add(Key);
				RaiseAlert(slot, world, Key, "firstContact", "warning", visibleEnemies[0].ActorID,
					visibleEnemies[0].Location, visibleEnemies, false);
			}
			else if (visibleEnemies.Length != 0)
				activeKeys.Add("firstContact");

			if (nearbyEnemies.Length != 0)
			{
				const string Key = "enemyNearBase";
				activeKeys.Add(Key);
				if (slot.LastNearbyEnemyCount == 0)
					RaiseAlert(slot, world, Key, "enemyNearBase", "critical", nearbyEnemies[0].ActorID,
						nearbyEnemies[0].Location, nearbyEnemies, false);
			}

			var materiallyNewForce = visibleEnemies.Length >= slot.LastVisibleEnemyCount + 3 ||
				visibleEnemyValue >= slot.LastVisibleEnemyValue + Math.Max(MaterialEnemyValue, slot.LastVisibleEnemyValue / 2);
			var materialForceStillActive = visibleEnemies.Length >= 3 || visibleEnemyValue >= MaterialEnemyValue;
			if (materialForceStillActive)
			{
				const string Key = "materialEnemyForce";
				activeKeys.Add(Key);
				if (materiallyNewForce)
					RaiseAlert(slot, world, Key, "materialEnemyForce", "warning", visibleEnemies[0].ActorID,
						visibleEnemies[0].Location, visibleEnemies, false);
			}

			var materialContactCell = materialForceStillActive && visibleEnemies.Length != 0
				? visibleEnemies.OrderBy(actor => (actor.Location - baseCell).LengthSquared)
					.ThenBy(actor => actor.ActorID).Select(actor => (CPos?)actor.Location).First()
				: null;
			var retreating = AgentSituationDetector.EvaluateEnemyRetreating(slot.Situations, world, slot.Player,
				visibleEnemies, materialForceStillActive, materialContactCell);
			if (retreating != null)
				RaiseSituationAlert(slot, world, retreating, visibleEnemies);

			var squadSnapshots = AgentSquadController.Observe(slot.Squads, world, slot.Player)
				.Select(squad => new AgentSituationDetector.SquadSnapshot
				{
					Name = squad.Name,
					ActorIds = squad.ActorIds
				});
			foreach (var reinforcement in AgentSituationDetector.EvaluateReinforcementNeeded(
				slot.Situations, world, slot.Player, visibleEnemies, squadSnapshots))
				RaiseSituationAlert(slot, world, reinforcement, visibleEnemies);

			if (powerState is PowerState.Low or PowerState.Critical)
			{
				var key = $"power:{powerState}";
				activeKeys.Add(key);
				if (powerState != slot.LastPowerState)
					RaiseAlert(slot, world, key, powerState == PowerState.Critical ? "criticalPower" : "lowPower",
						powerState == PowerState.Critical ? "critical" : "warning", 0, baseCell, visibleEnemies, false);
			}

			// While a build plan is active it exclusively owns production. Idle-affordable
			// alerts would only thrash the model into no-op / placeBuilding spam. Store the
			// muted edge so re-arming after plan completion still fires a clean rising edge.
			var planOwnsProduction = slot.BuildPlan.Active;
			var effectiveProductionStates = new Dictionary<string, ProductionEventState>(StringComparer.Ordinal);
			foreach (var (key, state) in productionStates)
			{
				var effective = new ProductionEventState
				{
					Ready = state.Ready,
					IdleAffordable = state.IdleAffordable && !planOwnsProduction
				};
				effectiveProductionStates[key] = effective;

				slot.ProductionStates.TryGetValue(key, out var previous);
				if (effective.Ready)
				{
					var alertKey = $"productionReady:{key}";
					activeKeys.Add(alertKey);
					if (previous?.Ready != true)
						RaiseProductionAlert(slot, world, alertKey, "productionReady", key, visibleEnemies);
				}

				if (effective.IdleAffordable)
				{
					var alertKey = $"productionIdle:{key}";
					activeKeys.Add(alertKey);
					if (previous?.IdleAffordable != true)
						RaiseProductionAlert(slot, world, alertKey, "productionIdleAffordable", key, visibleEnemies);
				}
			}

			foreach (var alert in slot.AlertStates.Values)
				alert.Alert.StillActive = alert.Alert.Kind == "criticalAssetLost" || activeKeys.Contains(alert.Key);
			foreach (var stale in slot.AlertStates
				.Where(a => world.WorldTick - a.Value.Alert.FirstSeenTick > AlertLifetimeTicks)
				.Select(a => a.Key).ToArray())
			{
				slot.AlertStates.Remove(stale);
				slot.EventCooldownUntil.Remove(stale);
			}

			foreach (var expired in slot.EventCooldownUntil
				.Where(cooldown => cooldown.Value <= world.WorldTick)
				.Select(cooldown => cooldown.Key).ToArray())
				slot.EventCooldownUntil.Remove(expired);

			UpdateSituationEngine(slot, world, baseCell, visibleEnemies, knownStructures, powerState);

			slot.LastPowerState = powerState;
			slot.LastVisibleEnemyValue = visibleEnemyValue;
			slot.LastVisibleEnemyCount = visibleEnemies.Length;
			slot.LastNearbyEnemyCount = nearbyEnemies.Length;
			ReplaceDictionary(slot.CriticalActors, criticalActors);
			ReplaceDictionary(slot.ProductionStates, effectiveProductionStates);
		}

		static void RaiseSituationAlert(AgentSlot slot, World world, AgentSituationDetector.Signal signal,
			Actor[] visibleEnemies)
		{
			var key = signal.Kind == "reinforcementNeeded"
				? $"reinforcementNeeded:{signal.SquadName}"
				: signal.Kind;
			RaiseAlert(slot, world, key, signal.Kind, signal.Severity, 0, signal.Cell, visibleEnemies, false);
			if (slot.AlertStates.TryGetValue(key, out var alert))
				alert.Alert.Detail = signal.SquadName == null ? signal.Kind :
					$"squad '{signal.SquadName}' needs reinforcement";

			// Situation detections are edge notifications, not durable target facts. Do not
			// discard their wake merely because the next scan has already moved on.
			if (slot.PendingAlertKey == key)
				slot.PendingAlertKey = null;
		}

		static void UpdateSituationEngine(AgentSlot slot, World world, CPos baseCell, Actor[] visibleEnemies,
			IReadOnlyList<AgentFogMemory.KnownStructure> knownStructures, PowerState powerState)
		{
			const int ContactRadiusSquared = BaseThreatRadius * BaseThreatRadius;
			const int HarvesterThreatRadiusSquared = 6 * 6;
			var ownActors = world.Actors
				.Where(actor => IsUsableActor(actor, slot.Player))
				.OrderBy(actor => actor.ActorID)
				.ToArray();
			var baseThreat = BuildThreat(world, slot.Player, baseCell, visibleEnemies);
			var nearbyEnemies = visibleEnemies
				.Where(actor => (actor.Location - baseCell).LengthSquared <= ContactRadiusSquared)
				.OrderBy(actor => actor.ActorID)
				.ToArray();
			var classCounts = CountSituationClasses(nearbyEnemies);
			var attackerClass = DominantSituationClass(nearbyEnemies);
			var dogCount = nearbyEnemies.Count(actor => actor.Info.Name == "dog");

			var airContacts = visibleEnemies
				.Where(actor => actor.Info.HasTraitInfo<AircraftInfo>())
				.Select(actor => new AgentSituationEngine.ContactSnapshot
				{
					ActorId = actor.ActorID,
					Type = actor.Info.Name,
					Cell = actor.Location,
					Value = ActorValue(actor),
					NearBase = (actor.Location - baseCell).LengthSquared <= ContactRadiusSquared
				})
				.ToArray();
			var navalContacts = visibleEnemies
				.Where(IsNavalActor)
				.Select(actor => new AgentSituationEngine.ContactSnapshot
				{
					ActorId = actor.ActorID,
					Type = actor.Info.Name,
					Cell = actor.Location,
					Value = ActorValue(actor),
					NearBase = (actor.Location - baseCell).LengthSquared <= ContactRadiusSquared,
					ThreatensOwnedAsset = ThreatensOwnedAsset(actor, ownActors)
				})
				.ToArray();

			var harvesterThreats = ownActors
				.Where(actor => actor.Info.HasTraitInfo<HarvesterInfo>())
				.Select(harvester =>
				{
					var underAttack = slot.AlertStates.TryGetValue(
						$"criticalAssetAttacked:{harvester.ActorID}", out var attacked) &&
						world.WorldTick - attacked.LastUpdatedTick <= AttackActiveTicks;
					var attackers = visibleEnemies
						.Where(enemy => enemy.Info.TraitInfos<AttackBaseInfo>().Count != 0 &&
							(enemy.Location - harvester.Location).LengthSquared <= HarvesterThreatRadiusSquared)
						.OrderBy(enemy => enemy.ActorID)
						.ToArray();
					if (attackers.Length == 0 && !underAttack)
						return null;

					var mobile = harvester.TraitOrDefault<Mobile>();
					var crushes = mobile?.Info.LocomotorInfo.Crushes;
					var crushableAll = attackers.Length != 0 && crushes.HasValue && attackers.All(enemy =>
						enemy.TraitsImplementing<ICrushable>().Any(crushable =>
							crushable.CrushableBy(enemy, harvester, crushes.Value)));
					var threatCounts = CountSituationClasses(attackers);
					var health = harvester.TraitOrDefault<Health>();
					return new AgentSituationEngine.HarvesterThreatSnapshot
					{
						HarvesterId = harvester.ActorID,
						Cell = harvester.Location,
						HpPercent = Percent(health?.HP ?? 0, health?.MaxHP ?? 0),
						VisibleEnemyCount = attackers.Length,
						VisibleEnemyValue = attackers.Sum(ActorValue),
						CrushableAll = crushableAll,
						CanDamageCount = attackers.Count(enemy => enemy.TraitsImplementing<Armament>()
							.Any(armament => armament.Weapon.IsValidAgainst(harvester, enemy))),
						UnderAttack = underAttack,
						AttackerClass = DominantSituationClass(attackers),
						ClassCounts = threatCounts
					};
				})
				.Where(threat => threat != null)
				.ToArray();

			var structures = ownActors
				.Where(actor => actor.Info.HasTraitInfo<BuildingInfo>())
				.Select(actor =>
				{
					var health = actor.TraitOrDefault<Health>();
					var repairable = actor.Info.TraitInfoOrDefault<RepairableBuildingInfo>();
					var sellable = actor.Info.TraitInfoOrDefault<SellableInfo>();
					var sellValue = actor.GetSellValue();
					var hp = health?.HP ?? 0;
					var maxHp = health?.MaxHP ?? 0;
					return new AgentSituationEngine.StructureSnapshot
					{
						ActorId = actor.ActorID,
						Type = actor.Info.Name,
						Cell = actor.Location,
						Health = hp,
						MaxHealth = maxHp,
						Critical = IsCriticalAsset(actor),
						RepairCostEstimate = repairable == null || maxHp <= 0 ? 0 :
							Math.Max(1, (int)((long)(maxHp - hp) * repairable.RepairPercent * sellValue / (maxHp * 100L))),
						SellRefundEstimate = sellable == null || maxHp <= 0 ? 0 :
							(int)((long)sellValue * sellable.RefundPercent * hp / (100L * maxHp))
					};
				})
				.ToArray();
			var ecoExposures = visibleEnemies
				.Where(actor => (actor.Info.HasTraitInfo<HarvesterInfo>() || actor.Info.HasTraitInfo<RefineryInfo>() ||
					actor.Info.Name == "fact") && !visibleEnemies.Any(cover => cover.ActorID != actor.ActorID &&
					cover.Info.TraitInfos<AttackBaseInfo>().Count != 0 &&
					(cover.Location - actor.Location).LengthSquared <= HarvesterThreatRadiusSquared))
				.Select(actor => new AgentSituationEngine.EcoExposureSnapshot
				{
					ActorId = actor.ActorID,
					Type = actor.Info.Name,
					Cell = actor.Location
				})
				.ToArray();

			var knownSuperweapons = knownStructures
				.Select(known => new AgentKnownEnemyStructureObservation
				{
					Type = known.Type,
					Cell = new AgentCellObservation { X = known.CellX, Y = known.CellY },
					LastSeenTick = known.LastSeenTick,
					Status = "last-known"
				})
				.Concat(visibleEnemies
					.Where(actor => actor.Info.HasTraitInfo<BuildingInfo>() &&
						actor.Info.Name is "mslo" or "iron" or "pdox")
					.Select(actor => new AgentKnownEnemyStructureObservation
					{
						Type = actor.Info.Name,
						Cell = new AgentCellObservation { X = actor.Location.X, Y = actor.Location.Y },
						LastSeenTick = world.WorldTick,
						Status = "visible"
					}))
				.GroupBy(known => (known.Type, known.Cell.X, known.Cell.Y))
				.Select(group => group.OrderBy(known => known.Status == "visible" ? 0 : 1).First())
				.OrderBy(known => known.Type, StringComparer.Ordinal)
				.ThenBy(known => known.Cell.Y)
				.ThenBy(known => known.Cell.X)
				.ToArray();
			var supportPowerObserver = world.WorldActor.TraitOrDefault<AgentSupportPowerObserver>();
			var launches = supportPowerObserver?.Since(slot.LastSupportPowerLaunchSequence) ?? [];
			if (launches.Count != 0)
				slot.LastSupportPowerLaunchSequence = launches[^1].Sequence;
			var enemySuperweaponLaunches = launches
				.Where(launch => IsStrategicSupportPower(launch.OrderName) && world.Players.Any(player =>
					player.ClientIndex == launch.OwnerClientIndex &&
					slot.Player.RelationshipWith(player) == PlayerRelationship.Enemy))
				.Select(launch => new AgentSituationEngine.SupportPowerLaunchSnapshot
				{
					Sequence = launch.Sequence,
					OrderName = launch.OrderName,
					AlertCell = launch.TargetCell
				})
				.ToArray();

			if (world.WorldTick - slot.SituationExploredSampleTick >= 250)
			{
				slot.SituationExploredPercent = AgentAdvisor.SurveyShroud(world, slot.Player).ExploredPercent;
				slot.SituationExploredSampleTick = world.WorldTick;
			}

			var result = AgentSituationEngine.Update(slot.SituationEngine, new AgentSituationEngine.Scan
			{
				WorldTick = world.WorldTick,
				PowerState = powerState.ToString(),
				Funds = slot.Player.PlayerActor?.TraitOrDefault<PlayerResources>()?.GetCashAndResources() ?? 0,
				WaterAdjacent = HasNearbyWater(world, baseCell, 8),
				ExploredPercent = slot.SituationExploredPercent,
				ActiveSweepMissions = slot.Missions.Active.Values.Count(m => m.MissionType == "sweep"),
				BaseThreat = new AgentSituationEngine.ThreatSnapshot
				{
					Cell = baseCell,
					VisibleEnemyCount = baseThreat.VisibleEnemyCount,
					VisibleEnemyValue = baseThreat.VisibleEnemyValue,
					DefenderCount = baseThreat.DefenderCount,
					DefenderValue = baseThreat.DefenderValue,
					Verdict = baseThreat.Verdict,
					AttackerClass = attackerClass,
					ClassCounts = classCounts,
					DogRush = dogCount > 0 && dogCount * 2 >= nearbyEnemies.Length
				},
				AirContacts = airContacts,
				NavalContacts = navalContacts,
				HarvesterThreats = harvesterThreats,
				Structures = structures,
				EcoExposures = ecoExposures,
				KnownEnemyStructures = knownSuperweapons,
				EnemySupportPowerLaunches = enemySuperweaponLaunches,
				Alerts = slot.AlertStates.Values.Where(alert => alert.Alert.StillActive ||
					alert.LastUpdatedTick == world.WorldTick)
					.OrderBy(alert => alert.Key, StringComparer.Ordinal).Select(alert => alert.Alert).ToArray()
			});

			slot.ActiveSituations = result.Situations;
			foreach (var transition in result.Transitions.OrderBy(transition => transition.Key, StringComparer.Ordinal))
			{
				var key = $"situation:{transition.Key}";
				RaiseAlert(slot, world, key, transition.AlertKind, transition.Severity, 0,
					transition.Cell, visibleEnemies, transition.BypassKeyCooldown);
				if (slot.AlertStates.TryGetValue(key, out var alert))
					alert.Alert.Detail = transition.Detail;
			}
		}

		static AgentSituationClassCountsObservation CountSituationClasses(IEnumerable<Actor> actors)
		{
			var counts = new AgentSituationClassCountsObservation();
			foreach (var actor in actors.OrderBy(actor => actor.ActorID))
			{
				if (actor.Info.HasTraitInfo<AircraftInfo>())
					counts.Air++;
				else if (IsNavalActor(actor))
					counts.Naval++;
				else if (actor.Info.HasTraitInfo<BuildingInfo>())
					counts.Buildings++;
				else if (actor.Info.TraitInfoOrDefault<MobileInfo>()?.Locomotor == "foot")
				{
					counts.Infantry++;
					if (actor.Info.Name == "dog")
						counts.Dogs++;
				}
				else if (actor.Info.HasTraitInfo<MobileInfo>())
					counts.Armor++;
			}

			return counts;
		}

		static string DominantSituationClass(Actor[] actors)
		{
			if (actors.Length == 0)
				return null;
			var (dominantClass, dominantValue) = actors.GroupBy(SituationClass, StringComparer.Ordinal)
				.Select(group => (Class: group.Key, Value: group.Sum(ActorValue)))
				.OrderByDescending(item => item.Value)
				.ThenBy(item => item.Class, StringComparer.Ordinal)
				.First();
			var totalValue = actors.Sum(ActorValue);
			return totalValue == 0 || dominantValue * 5L >= totalValue * 3L ? dominantClass : "mixed";
		}

		static string SituationClass(Actor actor)
		{
			if (actor.Info.HasTraitInfo<AircraftInfo>())
				return "air";
			if (IsNavalActor(actor))
				return "naval";
			if (actor.Info.HasTraitInfo<BuildingInfo>())
				return "building";
			if (actor.Info.TraitInfoOrDefault<MobileInfo>()?.Locomotor == "foot")
				return "infantry";
			return actor.Info.HasTraitInfo<MobileInfo>() ? "armor" : "other";
		}

		static bool IsNavalActor(Actor actor)
		{
			return actor.Info.TraitInfoOrDefault<MobileInfo>()?.Locomotor is "naval" or "lcraft";
		}

		static bool ThreatensOwnedAsset(Actor attacker, IEnumerable<Actor> ownActors)
		{
			var armaments = attacker.TraitsImplementing<Armament>()
				.Where(armament => !armament.IsTraitDisabled)
				.ToArray();
			if (armaments.Length == 0)
				return false;

			return ownActors
				.OrderBy(actor => actor.ActorID)
				.Any(target => armaments.Any(armament =>
				{
					var range = armament.Weapon.Range + WDist.FromCells(2);
					return armament.Weapon.IsValidAgainst(target, attacker) &&
						(target.CenterPosition - attacker.CenterPosition).HorizontalLengthSquared <= range.LengthSquared;
				}));
		}

		static bool IsStrategicSupportPower(string orderName)
		{
			// RA globally announces the nuclear launch and displays its target beacon.
			// Chronoshift and Iron Curtain activations are private unless independently observed,
			// so recording them here would leak hidden synchronized orders across the fog boundary.
			return orderName == "NukePowerInfoOrder";
		}

		static bool HasNearbyWater(World world, CPos center, int radius)
		{
			for (var y = center.Y - radius; y <= center.Y + radius; y++)
				for (var x = center.X - radius; x <= center.X + radius; x++)
				{
					var cell = new CPos(x, y);
					if (world.Map.Contains(cell) && (cell - center).LengthSquared <= radius * radius &&
						world.Map.GetTerrainInfo(cell).Type == "Water")
						return true;
				}

			return false;
		}

		static int Percent(int value, int maximum)
		{
			return maximum <= 0 ? 0 : Math.Clamp((int)(100L * value / maximum), 0, 100);
		}

		static void RaiseProductionAlert(AgentSlot slot, World world, string alertKey, string kind, string queueKey,
			Actor[] visibleEnemies)
		{
			var actorIdText = queueKey.AsSpan(0, queueKey.IndexOf(':'));
			uint.TryParse(actorIdText, out var actorId);
			var actor = world.GetActorById(actorId);
			var cell = actor?.OccupiesSpace != null ? actor.Location : FindBaseCell(world, slot.Player, []);
			RaiseAlert(slot, world, alertKey, kind, "info", actorId, cell, visibleEnemies, false);
		}

		static void RaiseAlert(AgentSlot slot, World world, string key, string kind, string severity,
			uint actorId, CPos cell, Actor[] visibleEnemies, bool bypassKeyCooldown)
		{
			var threat = BuildThreat(world, slot.Player, cell, visibleEnemies);
			var summary = BuildVisibleEnemySummary(visibleEnemies, cell);
			if (slot.AlertStates.TryGetValue(key, out var existing))
			{
				existing.Alert.AffectedActorId = actorId;
				existing.Alert.Cell = new AgentCellObservation { X = cell.X, Y = cell.Y };
				existing.Alert.VisibleAttackerSummary = summary;
				existing.Alert.Threat = threat;
				existing.Alert.StillActive = true;
				existing.LastUpdatedTick = world.WorldTick;
			}

			if (!bypassKeyCooldown && slot.EventCooldownUntil.TryGetValue(key, out var cooldown) && world.WorldTick < cooldown)
				return;

			var state = new AlertState
			{
				Key = key,
				LastUpdatedTick = world.WorldTick,
				Alert = new AgentAlertObservation
				{
					Kind = kind,
					Severity = severity,
					FirstSeenTick = world.WorldTick,
					AffectedActorId = actorId,
					Cell = new AgentCellObservation { X = cell.X, Y = cell.Y },
					VisibleAttackerSummary = summary,
					StillActive = true,
					Threat = threat
				}
			};
			slot.AlertStates[key] = state;
			slot.EventCooldownUntil[key] = world.WorldTick + EventKeyCooldownTicks;
			var priority = severity == "critical" ? 3 : severity == "warning" ? 2 : 1;
			if (priority >= slot.PendingPriority)
			{
				slot.PendingTrigger = kind;
				slot.PendingAlertKey = key;
				slot.PendingPriority = priority;
			}

			if (severity == "critical")
			{
				state.Alert.BuildPlanAutoPaused = AgentBuildPlanController.AutoPause(
					slot.BuildPlan, world.WorldTick, kind);
				slot.RecentCriticalEvents.Enqueue(new AgentCriticalEventObservation
				{
					Kind = kind,
					Tick = world.WorldTick,
					ActorId = actorId,
					Cell = new AgentCellObservation { X = cell.X, Y = cell.Y }
				});
				while (slot.RecentCriticalEvents.Count > 3)
					slot.RecentCriticalEvents.Dequeue();
			}

			foreach (var staleKey in slot.AlertStates.Values
				.OrderByDescending(alert => alert.LastUpdatedTick)
				.ThenByDescending(alert => alert.Alert.FirstSeenTick)
				.ThenBy(alert => alert.Key, StringComparer.Ordinal)
				.Skip(MaxAlertStates)
				.Select(alert => alert.Key)
				.ToArray())
			{
				slot.AlertStates.Remove(staleKey);
				slot.EventCooldownUntil.Remove(staleKey);
			}
		}

		static Dictionary<uint, CriticalActorSnapshot> GetCriticalActors(World world, Player player)
		{
			return world.Actors
				.Where(a => IsUsableActor(a, player) && IsCriticalAsset(a))
				.OrderBy(a => a.ActorID)
				.ToDictionary(a => a.ActorID, a =>
				{
					var health = a.TraitOrDefault<Health>();
					return new CriticalActorSnapshot
					{
						ActorId = a.ActorID,
						Type = a.Info.Name,
						Cell = a.Location,
						Health = health?.HP ?? 0,
						MaxHealth = health?.MaxHP ?? 0,
						IsDeployableCritical = IsDeployableCriticalAsset(a),
						IsConstructionCritical = IsConstructionCriticalAsset(a),
						TransformCell = a.Info.TraitInfoOrDefault<TransformsInfo>() is { } transform
							? a.Location + transform.Offset : null,
						TransformIntoActor = a.Info.TraitInfoOrDefault<TransformsInfo>()?.IntoActor
					};
				});
		}

		static bool TryRecordStaleDeployProof(AgentSlot slot, World world, CriticalActorSnapshot lost)
		{
			if (!lost.IsDeployableCritical || !lost.TransformCell.HasValue || string.IsNullOrEmpty(lost.TransformIntoActor))
				return false;

			var successors = world.Actors.Where(actor => IsUsableActor(actor, slot.Player) &&
				actor.ActorID != lost.ActorId && actor.Info.Name == lost.TransformIntoActor &&
				actor.Location == lost.TransformCell.Value).OrderBy(actor => actor.ActorID).ToArray();
			if (successors.Length != 1)
				return false;

			slot.StaleDeployProofs[lost.ActorId] = new StaleDeployProof
			{
				SourceActorId = lost.ActorId,
				SuccessorActorId = successors[0].ActorID,
				TransformCell = lost.TransformCell.Value,
				SuccessorType = successors[0].Info.Name,
				Tick = world.WorldTick
			};
			return true;
		}

		/// <summary>
		/// True when a disappeared critical asset is explained by MCV→yard (or similar)
		/// deploy transform rather than combat loss.
		/// </summary>
		static bool IsCriticalAssetContinuity(CriticalActorSnapshot lost,
			IEnumerable<CriticalActorSnapshot> currentCritical)
		{
			var current = currentCritical as IReadOnlyCollection<CriticalActorSnapshot> ?? currentCritical.ToArray();

			// Same-cell successor (historical path).
			if (current.Any(a => a.Cell == lost.Cell))
				return true;

			// Deployable mobile critical (MCV) replaced by a construction/production
			// building within a small footprint radius.
			if (!lost.IsDeployableCritical)
				return false;

			const int ContinuityRadius = 3;
			return current.Any(a => a.IsConstructionCritical &&
				Math.Max(Math.Abs(a.Cell.X - lost.Cell.X), Math.Abs(a.Cell.Y - lost.Cell.Y)) <= ContinuityRadius);
		}

		static bool IsDeployableCriticalAsset(Actor actor)
		{
			return !actor.Info.HasTraitInfo<BuildingInfo>() &&
				actor.TraitOrDefault<Transforms>() is IIssueDeployOrder deploy &&
				deploy.CanIssueDeployOrder(actor, false);
		}

		static bool IsConstructionCriticalAsset(Actor actor)
		{
			return actor.Info.HasTraitInfo<GivesBuildableAreaInfo>() ||
				(actor.Info.HasTraitInfo<BuildingInfo>() && actor.Info.HasTraitInfo<ProductionInfo>());
		}

		static Dictionary<string, ProductionEventState> GetProductionStates(World world, Player player)
		{
			var resources = player.PlayerActor?.TraitOrDefault<PlayerResources>();
			var funds = resources?.GetCashAndResources() ?? 0;
			return world.ActorsWithTrait<ProductionQueue>()
				.Where(q => q.Actor.Owner == player && q.Actor.IsInWorld && !q.Actor.IsDead && !q.Actor.Disposed)
				.OrderBy(q => q.Actor.ActorID)
				.ThenBy(q => q.Trait.Info.Type)
				.ToDictionary(q => $"{q.Actor.ActorID}:{q.Trait.Info.Type}", q =>
				{
					var queued = q.Trait.AllQueued().ToArray();
					return new ProductionEventState
					{
						Ready = queued.Any(i => i.Done),
						IdleAffordable = queued.Length == 0 && q.Trait.BuildableItems()
							.Any(i => q.Trait.GetProductionCost(i) <= funds)
					};
				});
		}

		static Actor[] GetVisibleEnemies(World world, Player player)
		{
			return world.Actors
				.Where(a => IsUsableActor(a, null) && a.Owner != null &&
					player.RelationshipWith(a.Owner) == PlayerRelationship.Enemy && a.CanBeViewedByPlayer(player) &&
					(a.EffectiveOwner?.Disguised != true ||
						player.RelationshipWith(a.EffectiveOwner.Owner) == player.RelationshipWith(a.Owner)))
				.OrderBy(a => a.ActorID)
				.ToArray();
		}

		static AgentThreatObservation BuildThreat(World world, Player player, CPos cell, Actor[] visibleEnemies)
		{
			const int RadiusSquared = BaseThreatRadius * BaseThreatRadius;
			var enemies = visibleEnemies.Where(a => (a.Location - cell).LengthSquared <= RadiusSquared).ToArray();
			var defenders = world.Actors
				.Where(a => IsUsableActor(a, player) && (a.Location - cell).LengthSquared <= RadiusSquared &&
					a.Info.TraitInfos<AttackBaseInfo>().Count != 0)
				.ToArray();
			var enemyValue = enemies.Sum(ActorValue);
			var defenderValue = defenders.Sum(ActorValue);
			var verdict = enemyValue * 4L > defenderValue * 5L ? "strong" :
				enemyValue * 5L < defenderValue * 4L ? "weak" : "even";
			var distance = enemies.Length == 0 ? -1 : (int)Math.Sqrt(enemies.Min(a => (a.Location - cell).LengthSquared));
			return new AgentThreatObservation
			{
				VisibleEnemyCount = enemies.Length,
				VisibleEnemyValue = enemyValue,
				DefenderCount = defenders.Length,
				DefenderValue = defenderValue,
				NearestEnemyDistanceCells = distance,
				Verdict = verdict,
				Summary = $"visible estimate: enemy {enemies.Length} (~${enemyValue}) vs defenders " +
					$"{defenders.Length} (~${defenderValue}); enemy threat {verdict}"
			};
		}

		// Fog-safe, map-wide enemy strength estimate for the assisted/executor surface (diagnosis FIX-2).
		// Counts only currently-visible enemy actors (GetVisibleEnemies already applies fog + disguise
		// rules) so no hidden actor ever leaks; the verdict reuses BuildThreat's coarse ratio against the
		// player's own attack-capable force. knownEnemyStructureCount carries the last-known structure tally.
		static AgentEnemyAssessmentObservation BuildEnemyAssessment(World world, Player player,
			Actor[] visibleEnemies, int knownEnemyStructureCount)
		{
			var enemyValue = visibleEnemies.Sum(ActorValue);
			var ownCombatValue = world.Actors
				.Where(a => IsUsableActor(a, player) && a.Info.TraitInfos<AttackBaseInfo>().Count != 0)
				.Sum(ActorValue);
			var verdict = enemyValue * 4L > ownCombatValue * 5L ? "strong" :
				enemyValue * 5L < ownCombatValue * 4L ? "weak" : "even";
			return new AgentEnemyAssessmentObservation
			{
				VisibleEnemyCount = visibleEnemies.Length,
				VisibleEnemyValue = enemyValue,
				KnownEnemyStructureCount = knownEnemyStructureCount,
				Verdict = verdict
			};
		}

		static string BuildVisibleEnemySummary(Actor[] visibleEnemies, CPos cell)
		{
			var nearby = visibleEnemies
				.Where(a => (a.Location - cell).LengthSquared <= BaseThreatRadius * BaseThreatRadius)
				.GroupBy(a => a.Info.Name)
				.OrderByDescending(g => g.Count())
				.ThenBy(g => g.Key)
				.Take(5)
				.Select(g => $"{g.Key}×{g.Count()}")
				.ToArray();
			return nearby.Length == 0 ? "no visible attacker identified" : $"visible nearby: {string.Join(", ", nearby)}";
		}

		static CPos FindBaseCell(World world, Player player, IEnumerable<CriticalActorSnapshot> criticalActors)
		{
			var anchor = world.Actors
				.Where(a => IsUsableActor(a, player) && a.Info.HasTraitInfo<GivesBuildableAreaInfo>())
				.OrderBy(a => a.ActorID)
				.FirstOrDefault();
			return anchor?.Location ?? criticalActors.OrderBy(a => a.ActorId).FirstOrDefault()?.Cell ?? player.HomeLocation;
		}

		static bool IsCriticalAsset(Actor actor)
		{
			if (actor.Info.HasTraitInfo<RefineryInfo>() || actor.Info.HasTraitInfo<HarvesterInfo>())
				return true;
			if (actor.Info.HasTraitInfo<BuildingInfo>() && actor.Info.HasTraitInfo<ProductionInfo>())
				return true;
			return !actor.Info.HasTraitInfo<BuildingInfo>() && actor.TraitOrDefault<Transforms>() is IIssueDeployOrder deploy &&
				deploy.CanIssueDeployOrder(actor, false);
		}

		static bool IsUsableActor(Actor actor, Player owner)
		{
			return actor.IsInWorld && !actor.IsDead && !actor.Disposed && actor.OccupiesSpace != null &&
				(owner == null || actor.Owner == owner);
		}

		static int ActorValue(Actor actor)
		{
			return actor.Info.TraitInfoOrDefault<ValuedInfo>()?.Cost ?? 0;
		}

		static void UpdateMilestones(AgentSlot slot, World world)
		{
			var buildingTypes = world.Actors
				.Where(a => IsUsableActor(a, slot.Player) && a.Info.HasTraitInfo<BuildingInfo>())
				.Select(a => a.Info.Name)
				.ToHashSet(StringComparer.Ordinal);
			foreach (var type in MilestoneTypes.Where(buildingTypes.Contains))
				slot.CompletedMilestones.TryAdd(type, world.WorldTick);
		}

		static void ReplaceDictionary<TKey, TValue>(Dictionary<TKey, TValue> target, Dictionary<TKey, TValue> source)
		{
			target.Clear();
			foreach (var pair in source)
				target.Add(pair.Key, pair.Value);
		}

		static AgentObservation BuildObservation(AgentSlot slot)
		{
			var world = GetRegularWorld();
			var player = slot.Player ?? throw new InvalidOperationException("agent player is not mapped yet");
			UpdateEventBus(slot, world);
			var decisionTrigger = slot.ClaimedTrigger ?? "manual";
			slot.ClaimedTrigger = null;
			var lobbyClient = Game.OrderManager.LobbyInfo.ClientWithIndex(player.ClientIndex);

			// The regular world becomes visible to the host before its startup ticks have initialized
			// every trait. Keep early observations useful, but limit them to stable player metadata and
			// the agent's own actors until the first supported decision interval has elapsed.
			var traitsReady = world.WorldTick >= ObservationWarmupTicks;
			var playerActor = player.PlayerActor;
			var resources = traitsReady && playerActor != null ? playerActor.TraitOrDefault<PlayerResources>() : null;
			var power = traitsReady && playerActor != null ? playerActor.TraitOrDefault<PowerManager>() : null;
			var knownStructures = AgentFogMemory.Update(world, player, slot.FogMemory);
			slot.KnownEnemyStructureCount = knownStructures.Count +
				GetVisibleEnemies(world, player).Count(a => a.Info.HasTraitInfo<BuildingInfo>());
			var alliedClientIndexes = !traitsReady ? [] : world.Players
				.Where(p => p != player && p.Playable && player.RelationshipWith(p) == PlayerRelationship.Ally)
				.Select(p => p.ClientIndex).Order().ToList();
			var observation = new AgentObservation
			{
				MatchId = matchId,
				AgentId = slot.Id,
				Sequence = ++slot.ObservationSequence,
				WorldTick = world.WorldTick,
				NetFrame = Game.OrderManager.NetFrameNumber,
				MapMinX = world.Map.Bounds.Left,
				MapMinY = world.Map.Bounds.Top,
				MapMaxX = world.Map.Bounds.Right - 1,
				MapMaxY = world.Map.Bounds.Bottom - 1,
				Visibility = omniscientObservations ? "omniscient" : "player-fog",
				DecisionTrigger = decisionTrigger,
				Player = new AgentPlayerObservation
				{
					ClientIndex = player.ClientIndex,
					Name = player.ResolvedPlayerName,
					Faction = player.Faction.InternalName,
					SpawnPoint = player.SpawnPoint,
					Team = lobbyClient?.Team ?? 0,
					AlliedClientIndexes = alliedClientIndexes,
					WinState = player.WinState.ToString(),
					Cash = resources?.Cash ?? 0,
					Resources = resources?.Resources ?? 0,
					ResourceCapacity = resources?.ResourceCapacity ?? 0,
					PowerProvided = power?.PowerProvided ?? 0,
					PowerDrained = power?.PowerDrained ?? 0,
					PowerState = power?.PowerState.ToString() ?? PowerState.Normal.ToString(),
					Color = PlayerColorHex(player),
					SeatIdentity = $"agent{slot.Ordinal + 1}:{slot.Id}"
				}
			};

			var playerActors = world.Players.Select(p => p.PlayerActor).ToHashSet();
			var observableActors = world.Actors
				.Where(a => a.IsInWorld && !a.IsDead && !a.Disposed && a.Owner != null && a.OccupiesSpace != null &&
					!playerActors.Contains(a));
			if (!traitsReady)
				observableActors = observableActors.Where(a => a.Owner == player);

			foreach (var actor in observableActors
				.OrderBy(a => a.Owner == player ? 0 : player.RelationshipWith(a.Owner) == PlayerRelationship.Ally ? 1 : 2)
				.ThenBy(a => a.ActorID))
			{
				var relationship = actor.Owner == player ? "self" : player.RelationshipWith(actor.Owner).ToString().ToLowerInvariant();
				if (!omniscientObservations && relationship is not ("self" or "ally") && actor.EffectiveOwner?.Disguised == true &&
					player.RelationshipWith(actor.EffectiveOwner.Owner) != player.RelationshipWith(actor.Owner))
					continue;
				if (!omniscientObservations && relationship is not ("self" or "ally") && !actor.CanBeViewedByPlayer(player))
					continue;

				var health = actor.TraitOrDefault<Health>();
				var capabilities = new List<string>();
				if (traitsReady && actor.Owner == player)
				{
					if ((actor.Info.HasTraitInfo<MobileInfo>() || actor.Info.HasTraitInfo<AircraftInfo>()) &&
						actor.AcceptsOrder("Move"))
						capabilities.Add("move");
					if (actor.Info.HasTraitInfo<AttackMoveInfo>() && actor.AcceptsOrder("AttackMove"))
						capabilities.Add("attackMove");
					if (actor.AcceptsOrder("Attack"))
						capabilities.Add("attack");
					if (!actor.Info.HasTraitInfo<BuildingInfo>() &&
						actor.TraitOrDefault<Transforms>() is IIssueDeployOrder deploy &&
						deploy.CanIssueDeployOrder(actor, false) && actor.AcceptsOrder("DeployTransform"))
						capabilities.Add("deploy");
					if (actor.AcceptsOrder("Stop"))
						capabilities.Add("stop");
					if (actor.TraitsImplementing<Captures>().Any(c => !c.IsTraitDisabled) && actor.AcceptsOrder("CaptureActor"))
						capabilities.Add("capture");
					if (actor.TraitOrDefault<RallyPoint>() != null && actor.AcceptsOrder("SetRallyPoint"))
						capabilities.Add("setRallyPoint");
					if (health != null && health.HP < health.MaxHP &&
						actor.TraitsImplementing<RepairableBuilding>().Any(r => !r.IsTraitDisabled) &&
						player.PlayerActor?.AcceptsOrder("RepairBuilding") == true)
						capabilities.Add("repair");
					if (actor.TraitsImplementing<Sellable>().Any(s => !s.IsTraitDisabled) && actor.AcceptsOrder("Sell"))
						capabilities.Add("sell");

					var productionQueues = actor.TraitsImplementing<ProductionQueue>().ToArray();
					if (productionQueues.Any(q => q.BuildableItems().Any()))
						capabilities.Add("startProduction");
					if (productionQueues.Any(q => q.AllQueued().Any()) && actor.AcceptsOrder("CancelProduction"))
						capabilities.Add("cancelProduction");
					if (productionQueues.Any(q => q.AllQueued().Any(i => i.Done &&
						world.Map.Rules.Actors.TryGetValue(i.Item, out var item) && item.HasTraitInfo<BuildingInfo>())))
						capabilities.Add("placeBuilding");
				}

				observation.Actors.Add(new AgentActorObservation
				{
					ActorId = actor.ActorID,
					Type = actor.Info.Name,
					Relationship = relationship,
					CellX = actor.Location.X,
					CellY = actor.Location.Y,
					Health = health?.HP ?? 0,
					MaxHealth = health?.MaxHP ?? 0,
					Idle = relationship == "self" && actor.IsIdle,
					Capabilities = capabilities
				});
			}

			if (traitsReady)
			{
				foreach (var queue in world.ActorsWithTrait<ProductionQueue>()
					.Where(q => q.Actor.Owner == player && q.Actor.IsInWorld && !q.Actor.IsDead)
					.OrderBy(q => q.Actor.ActorID))
				{
					observation.ProductionQueues.Add(new AgentProductionQueueObservation
					{
						ProducerId = queue.Actor.ActorID,
						QueueType = queue.Trait.Info.Type,
						BuildableItems = queue.Trait.BuildableItems().Select(i => i.Name).Order().ToList(),
						Items = queue.Trait.AllQueued().Select(i => new AgentProductionItemObservation
						{
							Item = i.Item,
							RemainingTime = i.RemainingTime,
							TotalTime = i.TotalTime,
							Paused = i.Paused,
							Done = i.Done,
							EtaSeconds = (i.RemainingTime + 24) / 25,
							Placeable = i.Done && world.Map.Rules.Actors.TryGetValue(i.Item, out var item) &&
								item.HasTraitInfo<BuildingInfo>()
						}).ToList()
					});
				}

				observation.Base = AgentAdvisor.BuildBaseObservation(world, player);
				observation.Scouting = AgentAdvisor.SurveyShroud(world, player);
				observation.AdvisorHints = AgentAdvisor.BuildHints(world, player, observation);
				observation.Alerts = slot.AlertStates.Values
					.Where(a => world.WorldTick - a.Alert.FirstSeenTick <= AlertLifetimeTicks)
					.OrderByDescending(a => a.Alert.FirstSeenTick)
					.ThenBy(a => a.Alert.Kind)
					.Take(6)
					.Select(a => a.Alert)
					.ToList();
				observation.Situations = slot.ActiveSituations.ToList();
				observation.KnownEnemyStructures = knownStructures.Select(known =>
					new AgentKnownEnemyStructureObservation
					{
						Type = known.Type,
						Cell = new AgentCellObservation { X = known.CellX, Y = known.CellY },
						LastSeenTick = known.LastSeenTick
					}).ToList();
				observation.Groups = AgentSquadController.Observe(slot.Squads, world, player)
					.Select(group => new AgentGroupObservation
					{
						Name = group.Name,
						LiveCount = group.LiveCount,
						ActorIds = group.ActorIds
					}).ToList();
				observation.Spatial = BuildSpatialSummary(world, player, observation);
				observation.HostTruth = BuildHostTruth(slot, world, player, resources, power);
				observation.HostTruth.KnownEnemyStructureCount = knownStructures.Count;
			}

			ApplyActorObservationCaps(observation);

			return observation;
		}

		static AgentSpatialSummaryResult BuildSpatialSummary(World world, Player player, AgentObservation observation)
		{
			var own = observation.Actors
				.Where(a => a.Relationship == "self")
				.Select(a => new AgentSpatialMarker
				{
					ActorId = a.ActorId,
					Type = a.Type,
					Cell = new CPos(a.CellX, a.CellY),
					IsBase = world.Map.Rules.Actors.TryGetValue(a.Type, out var info) && info.HasTraitInfo<BuildingInfo>()
				});
			var allies = observation.Actors
				.Where(a => a.Relationship == "ally")
				.Select(a => new AgentSpatialMarker
				{
					ActorId = a.ActorId,
					Type = a.Type,
					Cell = new CPos(a.CellX, a.CellY)
				});
			var visibleEnemies = observation.Actors
				.Where(a => a.Relationship == "enemy")
				.Select(a => new AgentSpatialMarker
				{
					ActorId = a.ActorId,
					Type = a.Type,
					Cell = new CPos(a.CellX, a.CellY)
				});
			var known = observation.KnownEnemyStructures.Select(a => new AgentKnownStructureMarker
			{
				Type = a.Type,
				Cell = new CPos(a.Cell.X, a.Cell.Y),
				LastSeenTick = a.LastSeenTick
			});

			return AgentSpatialSummary.Build(world, player, own, allies, visibleEnemies, known);
		}

		static void ApplyActorObservationCaps(AgentObservation observation)
		{
			const int MaxSelfActors = 64;
			const int MaxEnemyActors = 48;
			const int MaxAllyActors = 16;

			var originalCount = observation.Actors.Count;
			var self = observation.Actors
				.Where(a => a.Relationship == "self")
				.OrderBy(SelfActorPriority)
				.ThenBy(a => a.ActorId)
				.Take(MaxSelfActors);
			var ally = observation.Actors
				.Where(a => a.Relationship == "ally")
				.OrderBy(a => a.ActorId)
				.Take(MaxAllyActors);
			var enemy = observation.Actors
				.Where(a => a.Relationship == "enemy")
				.OrderBy(a => DistanceToClosestYardSquared(observation.Base, a))
				.ThenBy(a => a.ActorId)
				.Take(MaxEnemyActors);
			var other = observation.Actors
				.Where(a => a.Relationship is not ("self" or "ally" or "enemy"))
				.OrderBy(a => a.Relationship)
				.ThenBy(a => a.ActorId);

			observation.Actors = self.Concat(ally).Concat(enemy).Concat(other).ToList();
			if (observation.Actors.Count != originalCount)
				observation.Truncated = true;
		}

		static int SelfActorPriority(AgentActorObservation actor)
		{
			var combat = actor.Capabilities.Contains("attack") || actor.Capabilities.Contains("attackMove");
			return (actor.Idle ? 0 : 2) + (combat ? 0 : 1);
		}

		static long DistanceToClosestYardSquared(AgentBaseObservation agentBase, AgentActorObservation actor)
		{
			if (agentBase?.Yards == null || agentBase.Yards.Count == 0)
				return long.MaxValue;

			return agentBase.Yards.Min(yard =>
			{
				var dx = (long)actor.CellX - yard.X;
				var dy = (long)actor.CellY - yard.Y;
				return dx * dx + dy * dy;
			});
		}

		static AgentHostTruthObservation BuildHostTruth(AgentSlot slot, World world, Player player,
			PlayerResources resources, PowerManager power)
		{
			var ownActors = world.Actors
				.Where(a => IsUsableActor(a, player))
				.OrderBy(a => a.ActorID)
				.ToArray();
			var buildings = ownActors.Where(a => a.Info.HasTraitInfo<BuildingInfo>()).ToArray();
			var buildingCounts = buildings
				.GroupBy(a => a.Info.Name)
				.OrderBy(g => g.Key)
				.ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
			var refineryCount = buildings.Count(a => a.Info.HasTraitInfo<RefineryInfo>());
			var statistics = player.PlayerActor?.TraitOrDefault<PlayerStatistics>();
			var hostTruth = new AgentHostTruthObservation
			{
				BuildingCounts = buildingCounts,
				CompletedMilestones = slot.CompletedMilestones
					.OrderBy(m => m.Key)
					.ToDictionary(m => m.Key, m => m.Value, StringComparer.Ordinal),
				RefineryCount = refineryCount,
				KnownEnemyStructureCount = slot.KnownEnemyStructureCount,
				StandingPolicy = AgentReflexController.GetPolicy(slot.Reflexes),
				BuildPlan = AgentBuildPlanController.GetObservation(slot.BuildPlan),
				Missions = AgentMissionController.GetObservation(slot.Missions).Select(ToMissionObservation).ToList(),
				SupportPowers = GetSupportPowerObservations(player),
				Strategy = AgentStrategyController.Observe(slot.Strategy, strategyArsenalEnabled),
				Doctrine = BuildDoctrineObservation(slot, world, player, ownActors),
				AdvisorFallback = new AgentFallbackObservation
				{
					Enabled = advisorFallbackEnabled,
					FallbackTurns = slot.FallbackTurns,
					DecisionOpportunities = slot.DecisionOpportunities
				},
				Economy = new AgentEconomyObservation
				{
					Cash = resources?.Cash ?? 0,
					Resources = resources?.Resources ?? 0,
					ResourceCapacity = resources?.ResourceCapacity ?? 0,
					IncomePerMinute = statistics?.DisplayIncome ?? 0,
					HarvesterCount = ownActors.Count(a => a.Info.HasTraitInfo<HarvesterInfo>()),
					PowerProvided = power?.PowerProvided ?? 0,
					PowerDrained = power?.PowerDrained ?? 0,
					PowerState = power?.PowerState.ToString() ?? PowerState.Normal.ToString()
				},
				RecentCriticalEvents = slot.RecentCriticalEvents.Reverse().ToList()
			};
			hostTruth.Doctrine.PendingDecision = AgentDoctrineDecisionController.Observe(slot.DoctrineDecisions);
			if (hostTruth.Doctrine.PendingDecision != null)
				hostTruth.Doctrine.NeedsDecision = hostTruth.Doctrine.PendingDecision.Kind;
			if (actionGuidanceEnabled || doctrineExecutorEnabled)
			{
				hostTruth.LegalNextSteps = BuildLegalNextSteps(slot, world);
				hostTruth.EnemyAssessment = BuildEnemyAssessment(world, player,
					GetVisibleEnemies(world, player), slot.KnownEnemyStructureCount);

				// FIX-1 outcome-delta: fog-safe combat exchange + momentum since the last decision. Gated
				// here (guided/executor only) and [JsonIgnore]-null so the raw benchmark observation omits it.
				hostTruth.OutcomeDelta = BuildOutcomeDelta(slot, world, player,
					DoctrineMainActorIds(slot, world).Count, HasActiveOffensiveMission(slot));

				// Control harness phase gate: fog-safe, advisory. The war compiler drives warCommit off
				// the model's live commitIntent state (WC-2). WarCommit is set only while a commit is
				// active, so it stays null (omitted) otherwise. Only emitted on the guided/executor
				// surface so the raw benchmark track's observation bytes stay identical.
				var hasFactOrYard = buildings.Any(a =>
					a.Info.HasTraitInfo<BaseBuildingInfo>() || a.Info.Name is "fact" or "afac" or "afact");
				if (!hasFactOrYard)
					hasFactOrYard = ownActors.Any(a =>
						a.Info.HasTraitInfo<TransformsInfo>() || a.Info.Name is "mcv" or "amcv");
				var combatCount = ownActors.Count(a => AgentCombatRoster.IsEligibleType(a.Info));
				var structureUnderAttack = slot.AlertStates.Values.Any(alert =>
					alert.Alert.StillActive &&
					alert.Alert.Kind is "structureAttacked" or "criticalAssetAttacked");
				var warActive = slot.War != null && !string.IsNullOrEmpty(slot.War.Intent) &&
					slot.War.Intent is "strike" or "defendBase";
				var controlPhase = AgentWarCompiler.ResolveControlPhase(
					hasFactOrYard, refineryCount > 0, combatCount,
					HasActiveOffensiveMission(slot), structureUnderAttack, warActive);
				hostTruth.ControlPhase = controlPhase;
				hostTruth.LegalActionTypes = AgentWarCompiler.LegalActionsForPhase(controlPhase).ToList();
				if (warActive)
				{
					var warMainName = string.IsNullOrEmpty(slot.War.Squad)
						? (slot.Doctrine.Program?.MainSquadName ?? AgentWarCompiler.CompilerMainSquad)
						: slot.War.Squad;
					var mainLive = combatCount;
					try
					{
						mainLive = AgentSquadController.ResolveActorIds(slot.Squads, warMainName, world, player).Count;
					}
					catch (InvalidDataException)
					{
						mainLive = combatCount;
					}

					hostTruth.WarCommit = new AgentWarCommitObservation
					{
						Intent = slot.War.Intent,
						Status = slot.War.Status,
						Priority = slot.War.Priority,
						Squad = slot.War.Squad,
						MinForce = slot.War.MinForce,
						MainLiveCount = mainLive,
						Active = warActive,
						LastSkipReason = slot.War.LastSkipReason
					};
				}
			}

			return hostTruth;
		}

		static List<AgentGuidanceOptionObservation> BuildLegalNextSteps(AgentSlot slot, World world)
		{
			var result = new List<AgentGuidanceOptionObservation>();
			if (slot.DoctrineDecisions.Pending != null)
				result.AddRange(slot.DoctrineDecisions.Pending.Options);

			var plan = slot.BuildPlan;
			if (result.Count < 3 && plan.Active && plan.CurrentStep != null && plan.ProducerId != 0 &&
				plan.StepState is "producing" or "waitingPlaceable" or "placing")
			{
				var producer = world.GetActorById(plan.ProducerId);
				var ready = producer?.TraitsImplementing<ProductionQueue>()
					.SelectMany(queue => queue.AllQueued()).Any(item => item.Item == plan.CurrentStep.Item && item.Done) == true;
				if (ready)
					result.Add(new AgentGuidanceOptionObservation
					{
						OptionId = "place-ready-plan-building",
						Label = $"Place ready plan building {plan.CurrentStep.Item}",
						Kind = "readyPlacement",
						Actions =
						[
							new AgentAction
							{
								Type = "placeBuildingAuto",
								ProducerId = plan.ProducerId,
								Item = plan.CurrentStep.Item
							}
						]
					});
			}

			return result.Take(3).ToList();
		}

		static List<AgentGuidanceOptionObservation> BuildRejectionLegalNextSteps(AgentSlot slot, World world,
			AgentAction rejectedAction, string rejectionReason)
		{
			var repair = BuildRejectionRepairOption(slot, world, rejectedAction, rejectionReason);
			if (repair != null)
			{
				var state = slot.DoctrineDecisions;
				if (state.Pending?.Kind != "rejectionRepair")
					state.Pending = null;

				if (state.Pending == null)
					AgentDoctrineDecisionController.Issue(state, "rejectionRepair", world.WorldTick, [repair]);
				else
				{
					var options = state.Pending.Options
						.Where(option => option.OptionId != repair.OptionId).Prepend(repair).Take(3).ToList();
					AgentDoctrineDecisionController.Issue(state, "rejectionRepair", world.WorldTick, options);
				}
			}

			return BuildLegalNextSteps(slot, world);
		}

		static AgentGuidanceOptionObservation BuildRejectionRepairOption(AgentSlot slot, World world,
			AgentAction action, string reason)
		{
			if (action == null || string.IsNullOrEmpty(action.Type))
				return null;

			if (reason.Contains("does not exist or has no live actors", StringComparison.OrdinalIgnoreCase))
			{
				var actorIds = GuidanceCombatActorIds(slot, world, action);
				if (actorIds.Count == 0)
					return null;

				var exact = CloneExactAction(action);
				var actions = new List<AgentAction>();
				if (action.Type == "queueMission")
				{
					var groupNames = (action.MissionType is "strike" or "pincer"
						? action.Legs.Select(leg => leg.Squad)
						: [action.GroupName]).Where(name => !string.IsNullOrEmpty(name))
						.Distinct(StringComparer.Ordinal).ToArray();
					if (groupNames.Length == 0 || actorIds.Count < groupNames.Length)
						return null;

					var cursor = 0;
					for (var i = 0; i < groupNames.Length; i++)
					{
						var remainingGroups = groupNames.Length - i;
						var take = i == groupNames.Length - 1 ? actorIds.Count - cursor :
							Math.Max(1, (actorIds.Count - cursor) / remainingGroups);
						actions.Add(new AgentAction
						{
							Type = "assignGroup",
							Name = groupNames[i],
							ActorIds = actorIds.Skip(cursor).Take(take).ToList()
						});
						cursor += take;
					}

					actions.Add(exact);
				}
				else if (action.Type is "move" or "attackMove" or "stop" or "guard")
				{
					exact.GroupName = null;
					exact.ActorIds = actorIds;
					actions.Add(exact);
				}
				else
					return null;

				return new AgentGuidanceOptionObservation
				{
					OptionId = $"repair-{action.Type}-roster",
					Label = $"Use the exact legal combat roster for {action.Type}",
					Kind = "repair",
					Actions = actions
				};
			}

			if ((reason.Contains("owns production queues", StringComparison.OrdinalIgnoreCase) ||
				reason.Contains("reserved by build plan", StringComparison.OrdinalIgnoreCase) ||
				reason.Contains("cancel-first", StringComparison.OrdinalIgnoreCase) ||
				reason.Contains("cash floor", StringComparison.OrdinalIgnoreCase)) &&
				action.Type is "startProduction" or "cancelProduction" or "placeBuilding" or "placeBuildingAuto" &&
				slot.BuildPlan.Active)
			{
				var exact = CloneExactAction(action);
				if (action.Type == "startProduction" &&
					world.Map.Rules.Actors.TryGetValue(action.Item ?? "", out var actorInfo))
				{
					var alternative = world.ActorsWithTrait<ProductionQueue>()
						.Where(queue => queue.Actor.Owner == slot.Player && queue.Actor.IsInWorld &&
							!queue.Actor.IsDead && !queue.Actor.Disposed && queue.Actor.ActorID != slot.BuildPlan.ProducerId &&
							queue.Trait.CanBuild(actorInfo) && queue.Trait.BuildableItems().Contains(actorInfo))
						.OrderBy(queue => queue.Actor.ActorID).ThenBy(queue => queue.Trait.Info.Type).FirstOrDefault();
					if (alternative.Actor != null)
					{
						exact.ProducerId = alternative.Actor.ActorID;
						return new AgentGuidanceOptionObservation
						{
							OptionId = "repair-use-free-queue",
							Label = $"Use unreserved producer {alternative.Actor.ActorID}",
							Kind = "repair",
							Actions = [exact]
						};
					}
				}

				return new AgentGuidanceOptionObservation
				{
					OptionId = "repair-cancel-plan-first",
					Label = $"Cancel build plan {slot.BuildPlan.PlanId} v{slot.BuildPlan.Version}, then retry",
					Kind = "repair",
					Actions =
					[
						new AgentAction
						{
							Type = "controlBuildPlan",
							PlanId = slot.BuildPlan.PlanId,
							Version = slot.BuildPlan.Version,
							Command = "cancel"
						},
						exact
					]
				};
			}

			return null;
		}

		static List<uint> GuidanceCombatActorIds(AgentSlot slot, World world, AgentAction action)
		{
			string[] requiredOrders = action.Type switch
			{
				"move" => ["Move"],
				"attackMove" => ["AttackMove"],
				"stop" => ["Stop"],
				"guard" => ["Guard"],
				_ => ["Move", "AttackMove", "Stop"]
			};
			var actorIds = AgentCombatRoster.EligibleActorIds(world.Actors, slot.Player, requiredOrders).ToList();
			if (action.Type == "queueMission" && action.MissionType == "sweep")
				return actorIds.Take(4).ToList();
			return actorIds;
		}

		static AgentAction CloneExactAction(AgentAction action)
		{
			return JsonSerializer.Deserialize<AgentAction>(JsonSerializer.Serialize(action, JsonOptions), JsonOptions) ??
				throw new InvalidDataException("could not clone the rejected action for exact guidance");
		}

		static bool TryResolveGuidanceGroupCount(AgentSlot slot, World world, string groupName, out int count)
		{
			try
			{
				count = AgentSquadController.ResolveActorIds(slot.Squads, groupName, world, slot.Player).Count;
				return true;
			}
			catch (InvalidDataException)
			{
				count = 0;
				return false;
			}
		}

		static AgentDoctrineObservation BuildDoctrineObservation(AgentSlot slot, World world, Player player,
			Actor[] ownActors)
		{
			var explored = 0;
			if (player != null && world != null)
				explored = AgentAdvisor.SurveyShroud(world, player).ExploredPercent;

			var program = slot.Doctrine.Program;
			var mainTypes = new HashSet<string>(program?.MainUnitTypes ?? [], StringComparer.Ordinal);
			var commitType = program?.CommitUnitType;
			var commitUnitCount = ownActors.Count(actor =>
				(commitType == null ? mainTypes.Contains(actor.Info.Name) : actor.Info.Name == commitType) &&
				AgentCombatRoster.IsEligible(actor, player, "Move", "AttackMove", "Stop"));
			var (counterAttackWindow, pressAttack) = DoctrineMomentumWakes(slot, world);
			var facts = new AgentDoctrineProgressFacts
			{
				TankCount = commitUnitCount,
				CommitUnitCount = commitUnitCount,
				ExploredPercent = explored,
				ScoutCount = ownActors.Count(a => a.Info.Name is "e1" or "e3" or "dog"),
				KnownEnemyStructureCount = slot.KnownEnemyStructureCount,
				HasActiveOffensiveMission = AgentMissionController.GetObservation(slot.Missions)
					.Any(m => m.MissionType is "strike" or "pincer" or "airStrike" or "pursue"),
				CounterAttackWindow = counterAttackWindow,
				PressAttack = pressAttack
			};

			// Auto-advance only when executor is on (live doctrine). PR1 still
			// evaluates progress numbers for observation without phase advances
			// that would surprise models while executor is off.
			AgentDoctrineController.EvaluateProgress(slot.Doctrine, facts, world?.WorldTick ?? 0,
				autoAdvance: doctrineExecutorEnabled && !slot.Doctrine.Paused);

			return AgentDoctrineController.Observe(slot.Doctrine, strategyArsenalEnabled, doctrineExecutorEnabled,
				facts);
		}

		static List<AgentSupportPowerObservation> GetSupportPowerObservations(Player player)
		{
			var manager = player.PlayerActor?.TraitOrDefault<SupportPowerManager>();
			if (manager == null)
				return [];

			return manager.Powers.Values
				.Where(power => power.Info != null && !power.Disabled)
				.OrderBy(power => power.Info.OrderName, StringComparer.Ordinal)
				.ThenBy(power => power.Key, StringComparer.Ordinal)
				.Select(power => new AgentSupportPowerObservation
				{
					OrderName = power.Info.OrderName,
					Ready = power.Ready,
					RemainingSeconds = (power.RemainingTicks + 24) / 25
				}).ToList();
		}

		static AgentMissionObservation ToMissionObservation(AgentMissionController.Snapshot snapshot)
		{
			return new AgentMissionObservation
			{
				MissionId = snapshot.MissionId,
				MissionVersion = snapshot.MissionVersion,
				Type = snapshot.MissionType,
				State = snapshot.State,
				Paused = snapshot.Paused,
				PauseReason = snapshot.PauseReason,
				TargetCell = ToCellObservation(snapshot.TargetCell),
				LossesPercent = snapshot.LossesPercent,
				DetachedCount = snapshot.DetachedCount,
				SinceTick = snapshot.SinceTick,
				Legs = snapshot.Legs.Select(leg => new AgentMissionLegObservation
				{
					Squad = leg.Squad,
					Staged = leg.Staged,
					Alive = leg.Alive,
					Initial = leg.Initial
				}).ToList()
			};
		}

		static AgentMissionEventBatch ToMissionEventBatch(AgentMissionController.EventBatch batch)
		{
			return new AgentMissionEventBatch
			{
				LatestSequence = batch.LatestSequence,
				Events = batch.Events.Select(item => new AgentMissionEvent
				{
					Sequence = item.Sequence,
					WorldTick = item.WorldTick,
					MissionId = item.MissionId,
					MissionVersion = item.MissionVersion,
					MissionType = item.MissionType,
					Kind = item.Kind,
					State = item.State,
					Reason = item.Reason,
					ActorIds = item.ActorId == 0 ? [] : [item.ActorId],
					Cell = ToCellObservation(item.Cell)
				}).ToList()
			};
		}

		static AgentCellObservation ToCellObservation(CPos? cell)
		{
			return cell.HasValue ? new AgentCellObservation { X = cell.Value.X, Y = cell.Value.Y } : null;
		}

		static void CenterSpectatorCamera()
		{
			var world = Game.OrderManager?.World;
			var worldRenderer = Game.WorldRenderer;
			if (spectatorCameraCentered || world == null || worldRenderer == null || AgentSlots.Any(a => a.Player == null))
				return;

			var agentPlayers = AgentSlots.Select(a => a.Player).ToHashSet();
			var firstUnit = world.Actors
				.Where(a => a.IsInWorld && !a.IsDead && !a.Disposed && a.OccupiesSpace != null && agentPlayers.Contains(a.Owner))
				.OrderBy(a => a.ActorID)
				.FirstOrDefault();
			if (firstUnit == null)
				return;

			worldRenderer.Viewport.Center(firstUnit.CenterPosition);
			spectatorCameraCentered = true;
		}

		static AgentActionBatchResult SubmitBatch(AgentSlot slot, AgentActionBatch batch,
			List<Order> deferredOrders = null)
		{
			if (batch.SchemaVersion != AgentModeLimits.SchemaVersion)
				throw new InvalidDataException($"unsupported schemaVersion {batch.SchemaVersion}");
			if (batch.Actions == null)
				throw new InvalidDataException("actions is required");
			if (string.IsNullOrWhiteSpace(batch.Thoughts))
				throw new InvalidDataException("thoughts is required");
			if (batch.Thoughts.Length > AgentModeLimits.MaxThoughtChars)
				throw new InvalidDataException($"thoughts exceeds {AgentModeLimits.MaxThoughtChars} characters");
			if ((batch.Memo?.Length ?? 0) > AgentModeLimits.MaxMemoChars)
				throw new InvalidDataException($"memo exceeds {AgentModeLimits.MaxMemoChars} characters");
			if (batch.Actions.Count > AgentModeLimits.MaxActionsPerDecision)
				throw new InvalidDataException($"action count exceeds {AgentModeLimits.MaxActionsPerDecision}");
			if (batch.Actions.Any(a => a == null))
				throw new InvalidDataException("actions cannot contain null entries");
			if (batch.Actions.Any(a => a.Type == "queueMission" && a.Legs == null))
				throw new InvalidDataException("mission legs cannot be null");
			if (batch.Actions.Any(a => a.Legs?.Any(leg => leg == null) ?? false))
				throw new InvalidDataException("mission legs cannot contain null entries");
			if (batch.Actions.Any(action => action.Type == "acceptDoctrineDecision") && batch.Actions.Count != 1)
				throw new InvalidDataException("acceptDoctrineDecision must be the only action in its batch");
			var buildPlanActions = batch.Actions.Count(a => a.Type is "queueBuildPlan" or "controlBuildPlan");
			if (buildPlanActions > 1)
				throw new InvalidDataException("an action batch may contain at most one build-plan action");
			if (buildPlanActions != 0 && batch.Actions.Any(a => a.Type is
				"startProduction" or "cancelProduction" or "placeBuilding" or "placeBuildingAuto"))
			{
				var control = batch.Actions[0];
				if (!AgentBuildPlanController.IsExecutorCancelFirstBatch(doctrineExecutorEnabled, batch.Actions))
					throw new InvalidDataException("direct production requires an exact cancel-first controlBuildPlan action");
				AgentBuildPlanController.ValidateControl(slot.BuildPlan, control);
			}

			var missionActions = batch.Actions.Count(a => a.Type is "queueMission" or "controlMission");
			if (missionActions > 1)
				throw new InvalidDataException("an action batch may contain at most one mission action");
			if (batch.Actions.Count(a => a.Type == "adoptStrategy") > 1)
				throw new InvalidDataException("an action batch may contain at most one adoptStrategy action");

			var world = GetRegularWorld();
			slot.RequestInFlight = false;
			var pendingDecisionId = slot.DoctrineDecisions.Pending?.DecisionId ?? 0;
			var subjectCount = batch.Actions.Sum(a => a.ActorIds?.Count ?? 0) +
				batch.Actions.Count(a => a.ProducerId != 0) + batch.Actions.Count(a => a.TargetActorId != 0);
			foreach (var action in batch.Actions.Where(a => a.GroupName != null))
				if (TryResolveGuidanceGroupCount(slot, world, action.GroupName, out var groupCount))
					subjectCount += groupCount;
			foreach (var leg in batch.Actions.SelectMany(a => a.Legs ?? []))
				if (TryResolveGuidanceGroupCount(slot, world, leg.Squad, out var legCount))
					subjectCount += legCount;
			foreach (var destinationSquad in batch.Actions.Select(a => a.DestinationSquad).Where(name => name != null))
				if (TryResolveGuidanceGroupCount(slot, world, destinationSquad, out var destinationCount))
					subjectCount += destinationCount;
			if (subjectCount > AgentModeLimits.MaxSubjectIdsPerDecision)
				throw new InvalidDataException($"subject id count exceeds {AgentModeLimits.MaxSubjectIdsPerDecision}");
			if (batch.DecisionId <= slot.LastDecisionId)
				throw new InvalidDataException($"duplicate or out-of-order decisionId {batch.DecisionId}");
			if (batch.ObservedSequence <= 0 || batch.ObservedSequence > slot.ObservationSequence)
				throw new InvalidDataException($"unknown observation sequence {batch.ObservedSequence}");

			if (batch.ObservedWorldTick > world.WorldTick)
				throw new InvalidDataException("observedWorldTick is in the future");

			// R1 play-cadence stale-order guard: how many world ticks have elapsed since the observation
			// this batch was computed on. Future observations are already rejected above, so this is >= 0.
			var observationAgeTicks = world.WorldTick - batch.ObservedWorldTick;

			slot.LastDecisionId = batch.DecisionId;
			var result = new AgentActionBatchResult { DecisionId = batch.DecisionId };
			var orders = new List<Order>();
			var directOrders = new List<Order>();
			var commanderOverrideActorIds = new SortedSet<uint>();
			var acceptedActionIndexes = new HashSet<int>();
			var rejectedForGuidance = new List<(AgentAction Action, AgentActionResult Result, string Reason)>();
			var emergencyHarvesterAccepted = false;
			for (var i = 0; i < batch.Actions.Count; i++)
			{
				var action = batch.Actions[i];
				var actionResult = new AgentActionResult { Index = i, Type = action.Type ?? "" };
				try
				{
					if (AgentCadence.ShouldRejectStaleTacticalOrder(action.Type, observationAgeTicks, playCadenceEnabled))
						throw new InvalidDataException(
							$"tactical action '{action.Type}' rejected: observation is {observationAgeTicks} ticks stale " +
							$"(max {AgentCadence.TacticalStaleMaxAgeTicks}); recompute on a fresh observation");
					var emergencyHarvester = IsEmergencyHarvesterProduction(slot, action);
					if (emergencyHarvester && emergencyHarvesterAccepted)
						throw new InvalidDataException("only one emergency harvester may bypass the reserved vehicle queue");
					var actionOrders = new List<Order>();
					if (ShouldOverrideFallback(action))
						CancelFallbackMission(slot, actionOrders);
					var acceptedReason = BuildOrders(slot, action, actionOrders, modelAuthored: true);
					var isMissionAction = action.Type is "queueMission" or "controlMission" or "acceptDoctrineDecision";
					orders.AddRange(actionOrders);
					if (!isMissionAction)
					{
						directOrders.AddRange(actionOrders);
						foreach (var actorId in actionOrders.Select(o => o.Subject)
							.Where(a => a != null && a != slot.Player.PlayerActor && a.Owner == slot.Player)
							.Select(a => a.ActorID))
							commanderOverrideActorIds.Add(actorId);
					}

					actionResult.Accepted = true;
					actionResult.Reason = acceptedReason;
					result.Accepted++;
					acceptedActionIndexes.Add(i);
					emergencyHarvesterAccepted |= emergencyHarvester;
				}
				catch (InvalidDataException e)
				{
					actionResult.Reason = e.Message;
					if (action.Type == "acceptDoctrineDecision")
						actionResult.NextLegalActions = slot.DoctrineDecisions.Pending == null
							? BuildLegalNextSteps(slot, world) : [.. slot.DoctrineDecisions.Pending.Options];
					else if (actionGuidanceEnabled || doctrineExecutorEnabled)
						rejectedForGuidance.Add((action, actionResult, e.Message));
					result.Rejected++;
				}

				result.Results.Add(actionResult);
			}

			// Model-authored orders always beat standing mission commitments, regardless of
			// action order inside the batch. Invalid direct actions do not release actors.
			AgentMissionController.ReleaseActors(slot.Missions, commanderOverrideActorIds, world.WorldTick);
			var directOrderSet = directOrders.ToHashSet();
			orders.RemoveAll(order => !directOrderSet.Contains(order) && order.Subject != null &&
				commanderOverrideActorIds.Contains(order.Subject.ActorID));
			if (directOrders.Count != 0)
				AgentReflexController.LeaseOrders(slot.Reflexes, world, slot.Player, directOrders);

			if (pendingDecisionId != 0 && slot.DoctrineDecisions.Pending?.DecisionId == pendingDecisionId)
			{
				var pendingKind = slot.DoctrineDecisions.Pending.Kind;
				var mainActorIds = DoctrineMainActorIds(slot, world).ToHashSet();
				var decisionActorIds = PendingDecisionActorIds(slot.DoctrineDecisions.Pending).ToHashSet();
				var resolvedDirectly = (pendingKind == "rejectionRepair" && acceptedActionIndexes.Count != 0) ||
					acceptedActionIndexes.Any(index =>
				{
					var accepted = batch.Actions[index];
					return accepted.Type == "adoptStrategy" || accepted.Type == "controlDoctrine" ||
						(accepted.Type == "queueMission" && accepted.MissionType is "strike" or "pincer" or "airStrike" or "pursue");
				}) || commanderOverrideActorIds.Any(actorId =>
					mainActorIds.Contains(actorId) || decisionActorIds.Contains(actorId));
				if (resolvedDirectly)
				{
					AgentDoctrineController.RecordAction(slot.Doctrine, "decisionResolved", "direct model override",
						world.WorldTick, "modelDirect", pendingDecisionId, null,
						commanderOverrideActorIds.ToList(), "direct mission, doctrine control, strategy switch, or main-body order");
					AgentDoctrineDecisionController.Resolve(slot.DoctrineDecisions, world.WorldTick);
				}
				else
				{
					AgentDoctrineDecisionController.RecordMiss(slot.DoctrineDecisions, world.WorldTick);
					AgentDoctrineController.RecordAction(slot.Doctrine, "decisionMissed", "empty or irrelevant response",
						world.WorldTick, "model", pendingDecisionId, reason: "no accepted action resolved the pending decision");
				}
			}

			foreach (var rejected in rejectedForGuidance)
				rejected.Result.NextLegalActions = BuildRejectionLegalNextSteps(
					slot, world, rejected.Action, rejected.Reason);

			if (deferredOrders == null)
				IssueAgentOrders(slot, orders, false);
			else
				deferredOrders.AddRange(orders);
			return result;
		}

		static bool ShouldOverrideFallback(AgentAction action)
		{
			return action.Type is "adoptStrategy" or "controlDoctrine" ||
				(action.Type == "queueMission" && action.MissionType is "strike" or "pincer" or "airStrike" or "pursue") ||
				action.Type is "move" or "attackMove" or "attack" or "stop";
		}

		static void CancelFallbackMission(AgentSlot slot, List<Order> orders)
		{
			if (string.IsNullOrEmpty(slot.FallbackMissionId) || slot.FallbackMissionVersion <= 0)
				return;

			try
			{
				BuildOrders(slot, new AgentAction
				{
					Type = "controlMission",
					MissionId = slot.FallbackMissionId,
					MissionVersion = slot.FallbackMissionVersion,
					MissionCommand = "cancel"
				}, orders, true);
			}
			catch (InvalidDataException)
			{
				// A terminal fallback wave has already released itself.
			}

			slot.FallbackMissionId = null;
			slot.FallbackMissionVersion = 0;
		}

		static void IssueAgentOrders(AgentSlot slot, List<Order> orders, bool leaseActors)
		{
			if (orders.Count == 0)
				return;

			var world = GetRegularWorld();
			if (leaseActors)
				AgentReflexController.LeaseOrders(slot.Reflexes, world, slot.Player, orders);
			Game.OrderManager.IssueOrders(orders.ToArray());
		}

		static string BuildOrders(AgentSlot slot, AgentAction action, List<Order> orders, bool planOwned = false,
			bool modelAuthored = false)
		{
			if (string.IsNullOrEmpty(action.Type))
				throw new InvalidDataException("action type is required");
			if (action.Type != "setPolicy" && HasStandingPolicyFields(action))
				throw new InvalidDataException($"{action.Type} contains standing-policy fields");
			if (action.Type != "assignGroup" && action.Name != null)
				throw new InvalidDataException($"{action.Type} contains name for a different action type");
			if (action.GroupName != null && action.Type is not ("move" or "attackMove" or "stop" or "queueMission" or "guard" or "commitIntent"))
				throw new InvalidDataException($"{action.Type} does not support groupName");
			if (action.Type is not ("queueBuildPlan" or "controlBuildPlan") && HasBuildPlanFields(action))
				throw new InvalidDataException($"{action.Type} contains build-plan fields");
			if (action.Type is not ("queueMission" or "controlMission") && HasMissionFields(action))
				throw new InvalidDataException($"{action.Type} contains mission fields");
			if (action.Type != "adoptStrategy" && HasStrategyFields(action))
				throw new InvalidDataException($"{action.Type} contains strategy fields");
			if (action.Type != "controlDoctrine" && HasDoctrineFields(action))
				throw new InvalidDataException($"{action.Type} contains doctrine fields");
			if (action.Type != "acceptDoctrineDecision" && HasDoctrineDecisionFields(action))
				throw new InvalidDataException($"{action.Type} contains doctrine decision fields");
			if (action.Type is not ("commitIntent" or "reinforceIntent") && HasWarIntentFields(action))
				throw new InvalidDataException($"{action.Type} contains war-intent fields");

			var world = GetRegularWorld();
			var skippedActorIds = new List<uint>();
			switch (action.Type)
			{
				case "acceptDoctrineDecision":
				{
					ValidateDoctrineDecisionActionPurity(action);
					if (!actionGuidanceEnabled && !doctrineExecutorEnabled)
						throw new InvalidDataException("exact action guidance is disabled for this match");
					var pending = slot.DoctrineDecisions.Pending;
					if (pending == null || pending.DecisionId != action.DecisionId)
						throw new InvalidDataException($"doctrine decision {action.DecisionId} is stale; use the current pendingDecision");
					if (world.WorldTick > pending.ExpiresTick)
					{
						slot.DoctrineDecisions.Pending = null;
						throw new InvalidDataException($"doctrine decision {action.DecisionId} expired; request a refreshed pendingDecision");
					}

					var option = pending.Options.FirstOrDefault(item => item.OptionId == action.OptionId);
					if (option == null)
						throw new InvalidDataException($"unknown option '{action.OptionId}' for doctrine decision {action.DecisionId}");

					if (pending.Kind != "rejectionRepair")
					{
						var currentKind = DoctrineDecisionKind(slot, world);
						if (currentKind == null)
						{
							slot.DoctrineDecisions.Pending = null;
							throw new InvalidDataException($"doctrine decision {action.DecisionId} is stale; its preconditions no longer hold");
						}

						var refreshed = BuildDoctrineDecisionOptions(slot, world, currentKind,
							currentKind == pending.Kind ? pending.DecisionId : slot.DoctrineDecisions.NextDecisionId);
						var refreshedDecision = AgentDoctrineDecisionController.Issue(slot.DoctrineDecisions,
							currentKind, world.WorldTick, refreshed);
						var refreshedOption = refreshedDecision.Options.FirstOrDefault(item => item.OptionId == action.OptionId);
						if (refreshedDecision.DecisionId != action.DecisionId || refreshedOption == null ||
							!ExactOptionActionsMatch(option, refreshedOption))
							throw new InvalidDataException($"doctrine decision {action.DecisionId} changed; use the refreshed pendingDecision options");

						pending = refreshedDecision;
						option = refreshedOption;
					}

					if (!TryExecuteDoctrineOption(slot, world, pending, option, "modelSelectedGuidance",
						out var optionOrders, out var selectionReason))
					{
						if (pending.Kind == "rejectionRepair")
							AgentDoctrineDecisionController.DiscardStaleRejectionRepair(
								slot.DoctrineDecisions, pending.DecisionId);
						else
						{
							var refreshed = BuildDoctrineDecisionOptions(slot, world, pending.Kind, pending.DecisionId);
							if (refreshed.Count != 0)
								AgentDoctrineDecisionController.Issue(slot.DoctrineDecisions, pending.Kind,
									world.WorldTick, refreshed);
						}

						throw new InvalidDataException($"selected option is no longer legal: {selectionReason}");
					}

					orders.AddRange(optionOrders);
					AgentReflexController.LeaseOrders(slot.Reflexes, world, slot.Player, optionOrders);
					AgentDoctrineController.RecordAction(slot.Doctrine, "decisionAccepted", option.Label,
						world.WorldTick, "modelSelectedGuidance", pending.DecisionId,
						MissionIdFromOption(option), OrderActorIds(optionOrders), selectionReason);
					AgentDoctrineDecisionController.Resolve(slot.DoctrineDecisions, world.WorldTick);
					return $"accepted; model selected host-authored option '{option.OptionId}' " +
						$"for doctrine decision {action.DecisionId}";
				}

				case "queueMission":
				{
					ValidateMissionActionPurity(action, false);
					var request = CreateMissionRequest(slot, action, world,
						planOwned && action.MissionId == DoctrineScoutMissionId);
					var prepared = AgentMissionController.Prepare(slot.Missions, request, world, slot.Player,
						groupName => AgentSquadController.ResolveActorIds(
							slot.Squads, groupName, world, slot.Player).ToArray());
					if (prepared.StopActorIds.Count != 0)
						BuildOrders(slot, new AgentAction
						{
							Type = "stop",
							ActorIds = prepared.StopActorIds.ToList()
						}, orders, true);
					AgentMissionController.Commit(slot.Missions, prepared, world.WorldTick);
					return $"accepted; mission '{prepared.MissionId}' v{prepared.Version} queued";
				}

				case "controlMission":
				{
					ValidateMissionActionPurity(action, true);
					var prepared = AgentMissionController.PrepareControl(slot.Missions, action.MissionId,
						action.MissionVersion, action.MissionCommand, world, slot.Player);
					if (prepared.StopActorIds.Count != 0)
						BuildOrders(slot, new AgentAction
						{
							Type = "stop",
							ActorIds = prepared.StopActorIds.ToList()
						}, orders, true);
					AgentMissionController.CommitControl(slot.Missions, prepared, world.WorldTick);
					AgentMissionController.RecordControlStopsIssued(slot.Missions, prepared,
						orders.Where(order => order.Subject != null).Select(order => order.Subject.ActorID));
					var controlVerb = action.MissionCommand == "pause" ? "paused" :
						action.MissionCommand == "resume" ? "resumed" : "cancelled";
					return $"accepted; mission '{action.MissionId}' {controlVerb}";
				}

				case "queueBuildPlan":
				{
					ValidateBuildPlanActionPurity(action, false);
					AgentBuildPlanController.Validate(slot.BuildPlan, action, world);
					ValidateNoUnmanagedQueuedProduction(slot);
					CancelOutstandingBuildPlanProduction(slot, orders);
					AgentBuildPlanController.Replace(slot.BuildPlan, action, world);
					return $"accepted; build plan '{action.PlanId}' v{action.Version} queued";
				}

				case "controlBuildPlan":
				{
					ValidateBuildPlanActionPurity(action, true);
					AgentBuildPlanController.ValidateControl(slot.BuildPlan, action);
					if (action.Command == "cancel")
						CancelOutstandingBuildPlanProduction(slot, orders);
					AgentBuildPlanController.Control(slot.BuildPlan, action, world.WorldTick);
					var controlVerb = action.Command == "pause" ? "paused" :
						action.Command == "resume" ? "resumed" : "cancelled";
					return $"accepted; build plan '{action.PlanId}' {controlVerb}";
				}

				case "assignGroup":
				{
					if (action.GroupName != null || action.TargetActorId != 0 || action.ProducerId != 0 || action.Item != null ||
						action.Count != 0 || action.CellX != 0 || action.CellY != 0 || action.Queued)
						throw new InvalidDataException("assignGroup requires only name and actorIds");

					var name = AgentSquadController.ValidateName(action.Name);
					var actors = ValidateOwnedActors(slot, action, skippedActorIds).ToArray();
					AgentSquadController.Assign(slot.Squads, name, actors, slot.Player);
					return AcceptedReason(skippedActorIds, $"accepted; group '{name}' assigned {actors.Length} actors");
				}

				case "commitIntent":
				{
					// Model commits a standing war intent; the war compiler executes it (mass, launch,
					// reinforce) on the doctrine tick. Pure-safe: the host never commits on its own.
					var intent = AgentWarCompiler.NormalizeIntent(action.Intent);
					var priority = AgentWarCompiler.NormalizePriority(action.Priority);
					var minForce = AgentWarCompiler.ClampMinForce(action.MinForce);
					var squad = string.IsNullOrWhiteSpace(action.GroupName)
						? (slot.Doctrine.Program?.MainSquadName ?? AgentWarCompiler.CompilerMainSquad)
						: AgentSquadController.ValidateName(action.GroupName);
					slot.War.Intent = intent;
					slot.War.Priority = priority;
					slot.War.MinForce = minForce;
					slot.War.Squad = squad;
					slot.War.CommittedTick = world.WorldTick;
					slot.War.Status = intent == "hold" ? "hold" :
						intent == "defendBase" ? "defendBase" : "massing";
					if (modelAuthored)
					{
						slot.ModelCommitIntentCount++;
						if (slot.TimeToFirstCommitIntentTicks < 0)
							slot.TimeToFirstCommitIntentTicks = world.WorldTick;
					}

					return $"accepted; war commit intent={intent} minForce={minForce} squad={squad}";
				}

				case "reinforceIntent":
				{
					var to = string.IsNullOrWhiteSpace(action.To) ? "activeStrike" : action.To.Trim();
					if (to is not ("activeStrike" or "base"))
						throw new InvalidDataException("reinforceIntent.to must be activeStrike or base");
					var reinforceCap = Math.Clamp(action.MaxUnits ?? AgentWarCompiler.ReinforceBatchMax,
						1, AgentWarCompiler.ReinforceBatchMax);
					if (to == "base")
					{
						// Peel a bounded garrison of idle reserves home for defense — shares the structure-
						// defense selection (never economy/base/mission/reflex actors) and leaves any active
						// strike intent and mission intact. A defensive nudge, not a full defendBase recall.
						var garrisoned = CompileBaseGarrison(slot, world, reinforceCap, orders);
						return $"accepted; reinforceIntent base garrisoned {garrisoned} idle defender(s)";
					}

					if (string.IsNullOrEmpty(slot.War.Intent) || slot.War.Intent == "hold")
						throw new InvalidDataException("no active war commit to reinforce; commitIntent strike first");
					slot.War.ReinforceMaxUnits = reinforceCap;
					slot.War.NextReinforceEligibleTick = 0;
					return $"accepted; reinforceIntent activeStrike (compiler feeds up to {reinforceCap} idle combat)";
				}

				case "move":
				case "attackMove":
				{
					if (action.TargetActorId != 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0)
						throw new InvalidDataException($"{action.Type} contains fields for a different action type");

					var orderName = action.Type == "move" ? "Move" : "AttackMove";
					var cell = ValidateTargetCell(action);
					var moveSubjects = ValidateSubjects(slot, action, orderName, skippedActorIds).ToArray();
					RejectDribbleCombatMove(slot, action, modelAuthored, moveSubjects);
					foreach (var actor in moveSubjects)
					{
						if (orderName == "Move" && !actor.Info.HasTraitInfo<MobileInfo>() &&
							!actor.Info.HasTraitInfo<AircraftInfo>())
							throw new InvalidDataException($"actor {actor.ActorID} cannot move");
						if (orderName == "AttackMove" && !actor.Info.HasTraitInfo<AttackMoveInfo>())
							throw new InvalidDataException($"actor {actor.ActorID} cannot attack-move");

						orders.Add(new Order(orderName, actor, Target.FromCell(world, cell), action.Queued));
					}

					break;
				}

				case "attack":
				{
					if (action.TargetActorId == 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0 ||
						action.CellX != 0 || action.CellY != 0)
						throw new InvalidDataException("attack requires only actorIds, targetActorId, and optional queued");

					var targetActor = world.GetActorById(action.TargetActorId);
					if (targetActor == null || targetActor.Disposed || targetActor.IsDead || !targetActor.IsInWorld ||
						targetActor.Owner == null || slot.Player.RelationshipWith(targetActor.Owner) != PlayerRelationship.Enemy ||
						(!omniscientObservations && !targetActor.CanBeViewedByPlayer(slot.Player)))
						throw new InvalidDataException("target actor is stale, missing, or not visible to this agent");

					var target = Target.FromActor(targetActor);
					var attackSubjects = ValidateSubjects(slot, action, "Attack", skippedActorIds).ToArray();
					RejectDribbleCombatMove(slot, action, modelAuthored, attackSubjects);
					foreach (var actor in attackSubjects)
					{
						if (!actor.TraitsImplementing<AttackBase>().Any(a => a.HasAnyValidWeapons(target)))
							throw new InvalidDataException($"actor {actor.ActorID} cannot attack the target");

						orders.Add(new Order("Attack", actor, target, action.Queued));
					}

					break;
				}

				case "deploy":
					if (action.TargetActorId != 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0 ||
						action.CellX != 0 || action.CellY != 0 || action.Queued)
						throw new InvalidDataException("deploy contains fields for a different action type");
					if (IsCompletedStaleDeploy(slot, action, world, out var staleDeployReason))
						return staleDeployReason;

					foreach (var actor in ValidateSubjects(slot, action, "DeployTransform", skippedActorIds))
					{
						if (actor.Info.HasTraitInfo<BuildingInfo>())
							throw new InvalidDataException($"actor {actor.ActorID} is a deployed structure; deploying would undeploy it. " +
								"Buildings are produced via startProduction + placeBuildingAuto.");

						if (actor.TraitOrDefault<Transforms>() is not IIssueDeployOrder deploy ||
							!deploy.CanIssueDeployOrder(actor, false))
							throw new InvalidDataException($"actor {actor.ActorID} cannot deploy");

						var order = deploy.IssueDeployOrder(actor, false);
						if (order == null)
							throw new InvalidDataException($"actor {actor.ActorID} could not create a deploy order");
						orders.Add(order);
					}

					break;
				case "stop":
					if (action.TargetActorId != 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0 ||
						action.CellX != 0 || action.CellY != 0 || action.Queued)
						throw new InvalidDataException("stop contains fields for a different action type");
					foreach (var actor in ValidateSubjects(slot, action, "Stop", skippedActorIds))
						orders.Add(new Order("Stop", actor, false));
					break;
				case "startProduction":
				{
					RejectManualProductionDuringPlan(slot, action, planOwned);
					RejectExcessHarvesterProduction(slot, action, planOwned);
					if ((action.ActorIds?.Count ?? 0) != 0 || action.TargetActorId != 0 || action.CellX != 0 || action.CellY != 0)
						throw new InvalidDataException("startProduction contains fields for a different action type");

					var producer = ValidateOwnedActor(slot, action.ProducerId);
					if (string.IsNullOrEmpty(action.Item) || !world.Map.Rules.Actors.TryGetValue(action.Item, out var actorInfo))
						throw new InvalidDataException($"unknown production item '{action.Item}'");
					if (action.Count < 1 || action.Count > MaxProductionCount)
						throw new InvalidDataException($"production count must be between 1 and {MaxProductionCount}");
					producer = ResolveProductionQueueOwner(slot, producer,
						q => q.CanBuild(actorInfo) && q.BuildableItems().Contains(actorInfo));

					var queue = producer.TraitsImplementing<ProductionQueue>()
						.FirstOrDefault(q => q.CanBuild(actorInfo) && q.BuildableItems().Contains(actorInfo) &&
							q.CanQueue(actorInfo, out _, out _));
					if (queue == null || !producer.AcceptsOrder("StartProduction"))
					{
						var availableQueue = world.ActorsWithTrait<ProductionQueue>()
							.Where(q => q.Actor.Owner == slot.Player && q.Actor.IsInWorld && !q.Actor.IsDead && !q.Actor.Disposed)
							.OrderBy(q => q.Actor.ActorID)
							.ThenBy(q => q.Trait.Info.Type)
							.FirstOrDefault(q => q.Trait.CanBuild(actorInfo) && q.Trait.BuildableItems().Contains(actorInfo));
						var guidance = availableQueue.Actor != null
							? $"; use producerId {availableQueue.Actor.ActorID} from productionQueues " +
								$"(queue '{availableQueue.Trait.Info.Type}' can build it)"
							: $"; '{action.Item}' is not buildable from any of your current queues — check prerequisites";
						throw new InvalidDataException($"actor {producer.ActorID} cannot build '{action.Item}'{guidance}");
					}

					ValidateBuildPlanCashFloor(slot, action, queue, actorInfo, planOwned);

					orders.Add(Order.StartProduction(producer, actorInfo.Name, action.Count, action.Queued));
					break;
				}

				case "placeBuilding":
				{
					RejectManualProductionDuringPlan(slot, action, planOwned);
					if ((action.ActorIds?.Count ?? 0) != 0 || action.TargetActorId != 0 || action.Count != 0 || action.Queued)
						throw new InvalidDataException("placeBuilding contains fields for a different action type");

					var (producer, actorInfo, buildingInfo) = ValidateReadyBuilding(slot, action);

					var cell = ValidateTargetCell(action);
					if (!slot.Player.Shroud.IsVisible(cell))
						throw new InvalidDataException($"building cell {cell} is not currently visible");
					if (!world.CanPlaceBuilding(cell, actorInfo, buildingInfo, null) ||
						!buildingInfo.IsCloseEnoughToBase(world, slot.Player, actorInfo, cell))
						throw new InvalidDataException($"building '{action.Item}' cannot be placed at {cell}");
					if (!slot.Player.PlayerActor.AcceptsOrder("PlaceBuilding"))
						throw new InvalidDataException("player cannot place buildings");

					orders.Add(CreatePlacementOrder(world, slot.Player, producer, actorInfo, cell));
					MarkDirectPlanPlacement(slot, action, cell, world.WorldTick, planOwned);
					break;
				}

				case "placeBuildingAuto":
				{
					RejectManualProductionDuringPlan(slot, action, planOwned);
					if ((action.ActorIds?.Count ?? 0) != 0 || action.TargetActorId != 0 || action.Count != 0 ||
						action.CellX != 0 || action.CellY != 0 || action.Queued)
						throw new InvalidDataException("placeBuildingAuto contains fields for a different action type");

					var (producer, actorInfo, buildingInfo) = ValidateReadyBuilding(slot, action);
					var cell = AgentAdvisor.ChoosePlacementCell(world, slot.Player, actorInfo, buildingInfo);
					if (!cell.HasValue)
						throw new InvalidDataException($"building '{action.Item}' has no legal placement cell within MaxBaseRadius " +
							AgentAdvisor.GetMaxBaseRadius(world));
					if (!slot.Player.PlayerActor.AcceptsOrder("PlaceBuilding"))
						throw new InvalidDataException("player cannot place buildings");

					orders.Add(CreatePlacementOrder(world, slot.Player, producer, actorInfo, cell.Value));
					MarkDirectPlanPlacement(slot, action, cell.Value, world.WorldTick, planOwned);
					return $"accepted; placing {action.Item} at cell {cell.Value.X},{cell.Value.Y}";
				}

				case "capture":
				{
					if (action.TargetActorId == 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0 ||
						action.CellX != 0 || action.CellY != 0)
						throw new InvalidDataException("capture requires only actorIds, targetActorId, and optional queued");

					var targetActor = world.GetActorById(action.TargetActorId);
					var targetManager = targetActor?.TraitOrDefault<CaptureManager>();
					if (targetActor == null || targetActor.Disposed || targetActor.IsDead || !targetActor.IsInWorld ||
						targetActor.Owner == null || slot.Player.RelationshipWith(targetActor.Owner) != PlayerRelationship.Enemy ||
						!targetActor.CanBeViewedByPlayer(slot.Player) || targetManager == null)
						throw new InvalidDataException("target actor is stale, missing, or not visible to this agent");

					var target = Target.FromActor(targetActor);
					foreach (var actor in ValidateSubjects(slot, action, "CaptureActor", skippedActorIds))
					{
						var captures = actor.TraitsImplementing<Captures>()
							.FirstOrDefault(c => !c.IsTraitDisabled && c.CaptureManager.CanTarget(targetManager));
						var targeter = captures?.Orders.FirstOrDefault(o => o.OrderID == "CaptureActor");
						var order = targeter == null ? null : captures.IssueOrder(actor, targeter, target, action.Queued);
						if (order == null)
							throw new InvalidDataException($"actor {actor.ActorID} cannot capture the target");

						orders.Add(order);
					}

					break;
				}

				case "guard":
				{
					if (action.TargetActorId == 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0 ||
						action.CellX != 0 || action.CellY != 0 || action.Queued)
						throw new InvalidDataException("guard requires only actorIds or groupName and targetActorId");

					var targetActor = world.GetActorById(action.TargetActorId);
					if (targetActor == null || targetActor.Disposed || targetActor.IsDead || !targetActor.IsInWorld ||
						targetActor.Owner == null || (targetActor.Owner != slot.Player &&
							slot.Player.RelationshipWith(targetActor.Owner) != PlayerRelationship.Ally) ||
						!targetActor.CanBeViewedByPlayer(slot.Player) || !targetActor.Info.HasTraitInfo<GuardableInfo>())
						throw new InvalidDataException("guard target is stale, missing, or not owned/allied by this agent");

					foreach (var actor in ValidateSubjects(slot, action, "Guard", skippedActorIds))
					{
						if (!actor.Info.HasTraitInfo<GuardInfo>())
							throw new InvalidDataException($"actor {actor.ActorID} cannot guard another actor");
						if (actor == targetActor)
						{
							skippedActorIds.Add(actor.ActorID);
							continue;
						}

						orders.Add(new Order("Guard", actor, Target.FromActor(targetActor), false));
					}

					if (orders.Count == 0)
						throw new InvalidDataException("guard requires at least one subject other than the target");
					break;
				}

				case "spyPlane":
				{
					if ((action.ActorIds?.Count ?? 0) != 0 || action.GroupName != null || action.TargetActorId != 0 ||
						action.ProducerId != 0 || action.Item != null || action.Count != 0 || action.Queued)
						throw new InvalidDataException("spyPlane requires only cellX and cellY");

					var cell = ValidateTargetCell(action);
					var manager = slot.Player.PlayerActor?.TraitOrDefault<SupportPowerManager>();
					var power = manager?.Powers.Values
						.Where(candidate => candidate.Info?.OrderName == "SovietSpyPlane" && !candidate.Disabled)
						.OrderBy(candidate => candidate.Key, StringComparer.Ordinal)
						.FirstOrDefault();
					if (power == null)
						throw new InvalidDataException("support power 'SovietSpyPlane' is unavailable");
					if (!power.Ready)
						throw new InvalidDataException("support power 'SovietSpyPlane' is charging; " +
							$"~{(power.RemainingTicks + 24) / 25}s remain");

					orders.Add(new Order(power.Key, slot.Player.PlayerActor, Target.FromCell(world, cell), false)
					{
						SuppressVisualFeedback = true
					});
					break;
				}

				case "cancelProduction":
				{
					RejectManualProductionDuringPlan(slot, action, planOwned);
					if ((action.ActorIds?.Count ?? 0) != 0 || action.TargetActorId != 0 || action.CellX != 0 ||
						action.CellY != 0 || action.Queued)
						throw new InvalidDataException("cancelProduction contains fields for a different action type");

					var producer = ValidateOwnedActor(slot, action.ProducerId);
					if (string.IsNullOrEmpty(action.Item))
						throw new InvalidDataException("production item is required");
					if (action.Count < 1 || action.Count > MaxProductionCount)
						throw new InvalidDataException($"production count must be between 1 and {MaxProductionCount}");
					producer = ResolveProductionQueueOwner(slot, producer,
						q => q.AllQueued().Any(i => i.Item == action.Item));

					var queuedCount = producer.TraitsImplementing<ProductionQueue>()
						.SelectMany(q => q.AllQueued()).Count(i => i.Item == action.Item);
					if (queuedCount < action.Count || !producer.AcceptsOrder("CancelProduction"))
						throw new InvalidDataException($"actor {producer.ActorID} does not have {action.Count} queued '{action.Item}' items");

					orders.Add(Order.CancelProduction(producer, action.Item, action.Count));
					break;
				}

				case "setRallyPoint":
				{
					if ((action.ActorIds?.Count ?? 0) != 0 || action.TargetActorId != 0 || action.Item != null ||
						action.Count != 0 || action.Queued)
						throw new InvalidDataException("setRallyPoint contains fields for a different action type");

					var producer = ValidateOwnedActor(slot, action.ProducerId);
					var cell = ValidateTargetCell(action);
					if (producer.TraitOrDefault<RallyPoint>() == null || !producer.AcceptsOrder("SetRallyPoint"))
						throw new InvalidDataException($"actor {producer.ActorID} cannot set a rally point");

					orders.Add(new Order("SetRallyPoint", producer, Target.FromCell(world, cell), false)
					{
						SuppressVisualFeedback = true
					});
					return $"accepted; rally point set to cell {cell.X},{cell.Y}";
				}

				case "repair":
				{
					if (action.TargetActorId != 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0 ||
						action.CellX != 0 || action.CellY != 0 || action.Queued)
						throw new InvalidDataException("repair contains fields for a different action type");
					if (slot.Player.PlayerActor?.AcceptsOrder("RepairBuilding") != true)
						throw new InvalidDataException("player cannot repair buildings");

					foreach (var actor in ValidateOwnedActors(slot, action, skippedActorIds))
					{
						var health = actor.TraitOrDefault<Health>();
						var repairable = actor.TraitsImplementing<RepairableBuilding>().FirstOrDefault(r => !r.IsTraitDisabled);
						if (health == null || health.HP >= health.MaxHP || repairable == null)
							throw new InvalidDataException($"actor {actor.ActorID} is not a damaged repairable building");

						orders.Add(new Order("RepairBuilding", slot.Player.PlayerActor, Target.FromActor(actor), false));
					}

					break;
				}

				case "sell":
				{
					if (action.TargetActorId != 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0 ||
						action.CellX != 0 || action.CellY != 0 || action.Queued)
						throw new InvalidDataException("sell contains fields for a different action type");

					foreach (var actor in ValidateOwnedActors(slot, action, skippedActorIds))
					{
						if (actor.TraitsImplementing<Sellable>().All(s => s.IsTraitDisabled) || !actor.AcceptsOrder("Sell"))
							throw new InvalidDataException($"actor {actor.ActorID} cannot be sold");

						orders.Add(new Order("Sell", actor, Target.FromActor(actor), false));
					}

					break;
				}

				case "setPolicy":
					ValidatePolicyAction(action);
					AgentReflexController.SetPolicy(slot.Reflexes, action);
					return "accepted; standing orders updated";

				case "adoptStrategy":
					ValidateStrategyAction(slot, action);

					// Switching to a different card tears down the previous card's standing doctrine
					// (a leftover scout sweep would otherwise keep emitting under the new strategy).
					if (slot.Doctrine.Bound && slot.Doctrine.StrategyId != action.StrategyId)
						CleanupDoctrineStanding(slot, orders);
					AgentStrategyController.Adopt(slot.Strategy, action, world.WorldTick);
					AgentDoctrineController.Bind(slot.Doctrine, action.StrategyId, slot.Strategy.CardVersion,
						world.WorldTick, AgentStrategyController.NormalizeFactionSide(slot.Player.Faction.Side), world);
					return $"accepted; strategy '{action.StrategyId}' adopted";

				case "controlDoctrine":
					if (!strategyArsenalEnabled)
						throw new InvalidDataException("strategy arsenal is disabled for this match");
					if (!doctrineExecutorEnabled)
						throw new InvalidDataException("doctrine executor is off; controlDoctrine has no effect");
					ValidateDoctrineActionPurity(action);
					if (!slot.Doctrine.Bound)
						throw new InvalidDataException("no doctrine program is bound; adoptStrategy first");
					switch (action.DoctrineCommand)
					{
						case "pause":
							AgentDoctrineController.Pause(slot.Doctrine, "model");
							break;
						case "resume":
							AgentDoctrineController.Resume(slot.Doctrine);
							break;
						case "holdPhase":
							AgentDoctrineController.Hold(slot.Doctrine);
							break;
						default:
							AgentDoctrineController.AdvancePhase(slot.Doctrine, world.WorldTick);
							break;
					}

					return $"accepted; doctrine {action.DoctrineCommand}";

				case "surrender":
					if ((action.ActorIds?.Count ?? 0) != 0 || action.TargetActorId != 0 || action.ProducerId != 0 || action.Item != null ||
						action.Count != 0 || action.CellX != 0 || action.CellY != 0 || action.Queued)
						throw new InvalidDataException("surrender does not accept action fields");
					if (!slot.Player.PlayerActor.AcceptsOrder("Surrender"))
						throw new InvalidDataException("player cannot surrender");
					orders.Add(new Order("Surrender", slot.Player.PlayerActor, false));
					break;
				default:
					throw new InvalidDataException($"unsupported action type '{action.Type}'");
			}

			return AcceptedReason(skippedActorIds);
		}

		static bool IsCompletedStaleDeploy(AgentSlot slot, AgentAction action, World world, out string reason)
		{
			reason = null;
			if (action.GroupName != null || action.ActorIds == null || action.ActorIds.Count == 0)
				return false;

			var actorIds = action.ActorIds.Distinct().ToArray();
			foreach (var actorId in actorIds)
			{
				var actor = world.GetActorById(actorId);
				if (actor != null && actor.IsInWorld && !actor.IsDead && !actor.Disposed)
					return false;
				if (!slot.StaleDeployProofs.TryGetValue(actorId, out var proof) ||
					world.WorldTick - proof.Tick > 1500)
					return false;
				var successor = world.GetActorById(proof.SuccessorActorId);
				if (!IsUsableActor(successor, slot.Player) || successor.Info.Name != proof.SuccessorType ||
					successor.Location != proof.TransformCell)
					return false;
			}

			reason = $"accepted; deploy already completed for {actorIds.Length} stale actor(s) with exact transform successors";
			return true;
		}

		static string AcceptedReason(List<uint> skippedActorIds, string accepted = "accepted")
		{
			if (skippedActorIds.Count == 0)
				return accepted;

			var preview = string.Join(", ", skippedActorIds.Take(3));
			if (skippedActorIds.Count > 3)
				preview += ", ...";
			return $"{accepted}; skipped {skippedActorIds.Count} stale/invalid ids ({preview})";
		}

		static void ValidatePolicyAction(AgentAction action)
		{
			if ((action.ActorIds?.Count ?? 0) != 0 || action.TargetActorId != 0 || action.ProducerId != 0 ||
				action.Item != null || action.Count != 0 || action.CellX != 0 || action.CellY != 0 || action.Queued)
				throw new InvalidDataException("setPolicy contains fields for a different action type");
			if (!action.AutoReturnFire.HasValue || !action.HarvesterFlee.HasValue ||
				!action.RallyNewUnitsToDefense.HasValue || !action.DefendCriticalAssets.HasValue ||
				!action.AutoRepairBuildings.HasValue || !action.RetreatBelowHpPercent.HasValue)
				throw new InvalidDataException("setPolicy requires a complete standing-order policy");
			if (action.RetreatBelowHpPercent is < 0 or > 75)
				throw new InvalidDataException("retreatBelowHpPercent must be between 0 and 75");
		}

		static bool HasStandingPolicyFields(AgentAction action)
		{
			return action.AutoReturnFire.HasValue || action.HarvesterFlee.HasValue ||
				action.RallyNewUnitsToDefense.HasValue || action.DefendCriticalAssets.HasValue ||
				action.AutoRepairBuildings.HasValue ||
				action.RetreatBelowHpPercent.HasValue || action.ProactiveEngage.HasValue;
		}

		static bool HasBuildPlanFields(AgentAction action)
		{
			return action.PlanId != null || action.Version != 0 || action.ReserveCash.HasValue ||
				(action.Steps?.Count ?? 0) != 0 || action.Command != null;
		}

		static bool HasMissionFields(AgentAction action)
		{
			return action.MissionId != null || action.MissionType != null || action.MissionVersion != 0 ||
				action.MissionCommand != null || (action.Legs?.Count ?? 0) != 0 || action.DestinationSquad != null ||
				action.Posture != null || action.TargetPriority != null || action.ExploredPercentTarget.HasValue ||
				action.AbortLossPercent.HasValue || action.Sorties.HasValue || action.MaxChaseCells.HasValue;
		}

		static bool HasStrategyFields(AgentAction action)
		{
			return action.StrategyId != null || action.Reason != null;
		}

		static bool HasDoctrineFields(AgentAction action)
		{
			return action.DoctrineCommand != null;
		}

		static bool HasWarIntentFields(AgentAction action)
		{
			return action.Intent != null || action.Priority != null || action.MinForce.HasValue ||
				action.MaxUnits.HasValue || action.To != null;
		}

		// Freeform combat micro on the roster while a war commit is active is thrash: reject model-authored
		// attackMove/move/attack of combat units and point back at commitIntent/reinforceIntent. Host paths
		// (reflexes, compiled reinforce) are modelAuthored=false and untouched — safety reflexes always win.
		static void RejectDribbleCombatMove(AgentSlot slot, AgentAction action, bool modelAuthored,
			IEnumerable<Actor> subjects)
		{
			if (!modelAuthored)
				return;

			var warActive = slot.War != null && !string.IsNullOrEmpty(slot.War.Intent) &&
				slot.War.Intent is "strike" or "defendBase";
			if (!warActive)
				return;

			var subjectsAreCombat = subjects.Any(a =>
				AgentCombatRoster.IsEligible(a, slot.Player, "Move", "AttackMove", "Stop"));
			if (!AgentWarCompiler.ShouldRejectDribbleCombatMove(true, action.Type, subjectsAreCombat))
				return;

			slot.DribbleAttackMoveCount++;
			throw new InvalidDataException(
				"war commit is active — use commitIntent/reinforceIntent instead of freeform " +
				$"{action.Type} on combat units (control harness)");
		}

		static bool HasDoctrineDecisionFields(AgentAction action)
		{
			return action.DecisionId != 0 || action.OptionId != null;
		}

		static void ValidateDoctrineDecisionActionPurity(AgentAction action)
		{
			if (action.DecisionId <= 0 || string.IsNullOrWhiteSpace(action.OptionId) || action.OptionId.Length > 64)
				throw new InvalidDataException("acceptDoctrineDecision requires a positive decisionId and optionId");
			if ((action.ActorIds?.Count ?? 0) != 0 || action.Name != null || action.GroupName != null ||
				action.TargetActorId != 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0 ||
				action.CellX != 0 || action.CellY != 0 || action.Queued || HasStandingPolicyFields(action) ||
				HasBuildPlanFields(action) || HasMissionFields(action) || HasStrategyFields(action) ||
				HasDoctrineFields(action))
				throw new InvalidDataException("acceptDoctrineDecision requires only decisionId and optionId");
		}

		static void ValidateDoctrineActionPurity(AgentAction action)
		{
			if ((action.ActorIds?.Count ?? 0) != 0 || action.Name != null || action.GroupName != null ||
				action.TargetActorId != 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0 ||
				action.CellX != 0 || action.CellY != 0 || action.Queued || HasStandingPolicyFields(action) ||
				HasBuildPlanFields(action) || HasMissionFields(action) || HasStrategyFields(action))
				throw new InvalidDataException("controlDoctrine requires only doctrineCommand");
			if (action.DoctrineCommand is not ("pause" or "resume" or "holdPhase" or "advancePhase"))
				throw new InvalidDataException("doctrine command must be pause, resume, holdPhase, or advancePhase");
		}

		static void ValidateStrategyAction(AgentSlot slot, AgentAction action)
		{
			if (!strategyArsenalEnabled)
				throw new InvalidDataException("strategy arsenal is disabled for this match");

			ValidateStrategyActionPurity(action);
			AgentStrategyController.ValidateMetadata(slot.Strategy, action,
				AgentStrategyController.NormalizeFactionSide(slot.Player.Faction.Side));
		}

		static void ValidateStrategyActionPurity(AgentAction action)
		{
			if ((action.ActorIds?.Count ?? 0) != 0 || action.Name != null || action.GroupName != null ||
				action.TargetActorId != 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0 ||
				action.CellX != 0 || action.CellY != 0 || action.Queued || HasStandingPolicyFields(action) ||
				HasBuildPlanFields(action) || HasMissionFields(action))
				throw new InvalidDataException("adoptStrategy requires only strategyId and reason");
		}

		static void ValidateMissionActionPurity(AgentAction action, bool control)
		{
			if ((action.ActorIds?.Count ?? 0) != 0 || action.Name != null || action.TargetActorId != 0 ||
				action.ProducerId != 0 || action.Item != null || action.Count != 0 || action.Queued ||
				HasStandingPolicyFields(action) || HasBuildPlanFields(action))
				throw new InvalidDataException($"{action.Type} contains fields for a different action type");
			if (string.IsNullOrEmpty(action.MissionId))
				throw new InvalidDataException("missionId is required");
			if (action.MissionVersion < 1)
				throw new InvalidDataException("missionVersion must be at least 1");
			if (control)
			{
				if (action.MissionType != null || action.GroupName != null || action.CellX != 0 || action.CellY != 0 ||
					(action.Legs?.Count ?? 0) != 0 || action.DestinationSquad != null || action.Posture != null ||
					action.TargetPriority != null || action.ExploredPercentTarget.HasValue ||
					action.AbortLossPercent.HasValue || action.Sorties.HasValue || action.MaxChaseCells.HasValue)
					throw new InvalidDataException("controlMission requires only missionId, missionVersion, and missionCommand");
				if (action.MissionCommand is not ("pause" or "resume" or "cancel"))
					throw new InvalidDataException("mission command must be pause, resume, or cancel");
				return;
			}

			if (action.MissionCommand != null)
				throw new InvalidDataException("queueMission does not accept missionCommand");
			if (action.MissionType == "sweep")
			{
				if (string.IsNullOrEmpty(action.GroupName) || (action.Legs?.Count ?? 0) != 0 ||
					action.CellX != 0 || action.CellY != 0 || action.Posture != null || action.TargetPriority != null ||
					action.DestinationSquad != null || action.Sorties.HasValue || action.MaxChaseCells.HasValue)
					throw new InvalidDataException("sweep requires groupName and accepts only exploredPercentTarget and abortLossPercent options");
			}
			else if (action.MissionType is "strike" or "pincer")
			{
				if (action.MissionType == "strike" && (action.GroupName != null || action.Legs.Count != 1 ||
					action.ExploredPercentTarget.HasValue || action.DestinationSquad != null || action.Sorties.HasValue ||
					action.MaxChaseCells.HasValue))
					throw new InvalidDataException("strike requires exactly one leg and does not accept groupName or exploredPercentTarget");
				if (action.MissionType == "pincer" && (action.GroupName != null || action.Legs.Count < 2 || action.Legs.Count > 3 ||
					action.ExploredPercentTarget.HasValue || action.DestinationSquad != null || action.Sorties.HasValue ||
					action.MaxChaseCells.HasValue))
					throw new InvalidDataException("pincer requires between 2 and 3 legs");
				if (action.Legs.Select(leg => leg.Squad).Distinct(StringComparer.Ordinal).Count() != action.Legs.Count)
					throw new InvalidDataException("pincer legs must name distinct squads");
			}
			else if (action.MissionType == "airStrike")
			{
				if (string.IsNullOrEmpty(action.GroupName) || (action.Legs?.Count ?? 0) != 0 ||
					action.ExploredPercentTarget.HasValue || action.DestinationSquad != null || action.Posture != null ||
					action.MaxChaseCells.HasValue)
					throw new InvalidDataException("airStrike requires groupName, a target cell, and optional sorties, targetPriority, abortLossPercent");
			}
			else if (action.MissionType == "pursue")
			{
				if (string.IsNullOrEmpty(action.GroupName) || (action.Legs?.Count ?? 0) != 0 ||
					action.ExploredPercentTarget.HasValue || action.DestinationSquad != null || action.Posture != null ||
					action.TargetPriority != null || action.Sorties.HasValue)
					throw new InvalidDataException("pursue requires groupName, a target cell, and optional maxChaseCells and abortLossPercent");
			}
			else if (action.MissionType == "reinforce")
			{
				if (string.IsNullOrEmpty(action.GroupName) || (action.Legs?.Count ?? 0) != 0 ||
					action.ExploredPercentTarget.HasValue || action.Posture != null || action.TargetPriority != null ||
					action.AbortLossPercent.HasValue || action.Sorties.HasValue || action.MaxChaseCells.HasValue ||
					(action.DestinationSquad != null && (action.CellX != 0 || action.CellY != 0)))
					throw new InvalidDataException("reinforce requires groupName and exactly one destinationSquad or target cell");
			}
			else
				throw new InvalidDataException("unsupported missionType");
		}

		static AgentMissionController.Request CreateMissionRequest(AgentSlot slot, AgentAction action, World world,
			bool internalDoctrineScout = false)
		{
			var groupName = action.GroupName;
			CPos? targetCell = null;
			CPos? viaCell = null;
			var legs = new List<AgentMissionController.LegRequest>();
			if (action.MissionType is "strike" or "pincer")
			{
				targetCell = ValidateTargetCell(action);
				foreach (var leg in action.Legs)
				{
					var cell = new CPos(leg.ViaX, leg.ViaY);
					if (!world.Map.Contains(cell))
						throw new InvalidDataException($"{action.MissionType} via cell is outside the map");
					legs.Add(new AgentMissionController.LegRequest { SquadName = leg.Squad, ViaCell = cell });
				}

				groupName = action.Legs[0].Squad;
				viaCell = legs[0].ViaCell;
			}
			else if (action.MissionType is "airStrike" or "pursue")
				targetCell = ValidateTargetCell(action);
			else if (action.MissionType == "reinforce" && action.DestinationSquad == null)
				targetCell = ValidateTargetCell(action);

			var destinationActorIds = action.DestinationSquad == null ? [] :
				AgentSquadController.ResolveActorIds(slot.Squads, action.DestinationSquad, world, slot.Player).ToArray();

			return new AgentMissionController.Request
			{
				MissionId = action.MissionId,
				Version = action.MissionVersion,
				MissionType = action.MissionType,
				GroupName = groupName,
				TargetCell = targetCell,
				ViaCell = viaCell,
				Legs = legs,
				DestinationSquad = action.DestinationSquad,
				DestinationCell = action.MissionType == "reinforce" ? targetCell : null,
				DestinationActorIds = destinationActorIds,
				Posture = action.Posture ?? "assault",
				TargetPriority = action.TargetPriority ?? "any",
				ExploredPercentTarget = action.ExploredPercentTarget,
				AbortLossPercent = action.AbortLossPercent,
				Sorties = action.Sorties,
				MaxChaseCells = action.MaxChaseCells,
				RequireAircraft = action.MissionType == "airStrike",
				KnownEnemyStructureCount = slot.KnownEnemyStructureCount,
				RequireEnemyStructureContact = internalDoctrineScout &&
					AgentDoctrineController.PhaseRequiresEnemyStructureContact(slot.Doctrine)
			};
		}

		static void ValidateBuildPlanActionPurity(AgentAction action, bool control)
		{
			if ((action.ActorIds?.Count ?? 0) != 0 || action.Name != null || action.GroupName != null ||
				action.TargetActorId != 0 || action.ProducerId != 0 || action.Item != null || action.Count != 0 ||
				action.CellX != 0 || action.CellY != 0 || action.Queued || HasStandingPolicyFields(action))
				throw new InvalidDataException($"{action.Type} contains fields for a different action type");
			if (control && (action.ReserveCash.HasValue || (action.Steps?.Count ?? 0) != 0))
				throw new InvalidDataException("controlBuildPlan requires only planId, version, and command");
			if (!control && action.Command != null)
				throw new InvalidDataException("queueBuildPlan does not accept command");
		}

		static void RejectManualProductionDuringPlan(AgentSlot slot, AgentAction action, bool planOwned)
		{
			var state = slot.BuildPlan;
			if (!state.Active || planOwned)
				return;
			if (!doctrineExecutorEnabled)
				throw new InvalidDataException($"build plan '{state.PlanId}' owns production queues; " +
					"cancel or replace it before issuing direct production actions");

			var exactPlacement = action.Type is "placeBuilding" or "placeBuildingAuto" &&
				action.ProducerId == state.ProducerId && action.Item == state.CurrentStep?.Item &&
				state.StepState is "producing" or "waitingPlaceable" or "placing";
			if (exactPlacement || IsEmergencyHarvesterProduction(slot, action))
				return;

			var reservedProducer = state.ProducerId;
			if (reservedProducer == 0 && state.CurrentStep != null &&
				GetRegularWorld().Map.Rules.Actors.TryGetValue(state.CurrentStep.Item, out var actorInfo))
				reservedProducer = FindBuildPlanQueue(GetRegularWorld(), slot.Player, actorInfo).Actor?.ActorID ?? 0;
			if (AgentBuildPlanController.IsProducerReserved(state.Active, reservedProducer, action.ProducerId))
				throw new InvalidDataException($"producer {reservedProducer} is reserved by build plan '{state.PlanId}' " +
					$"for '{state.CurrentStep?.Item}'; use another queue or cancel-first");
		}

		static bool IsEmergencyHarvesterProduction(AgentSlot slot, AgentAction action)
		{
			var world = GetRegularWorld();
			if (action.Type != "startProduction" ||
				!world.Map.Rules.Actors.TryGetValue(action.Item ?? "", out var actorInfo) ||
				!actorInfo.HasTraitInfo<HarvesterInfo>())
				return false;

			var hasUsableHarvester = world.Actors.Any(actor =>
				IsUsableActor(actor, slot.Player) && actor.Info.HasTraitInfo<HarvesterInfo>());
			var hasQueuedHarvester = world.ActorsWithTrait<ProductionQueue>()
				.Where(queue => queue.Actor.Owner == slot.Player).SelectMany(queue => queue.Trait.AllQueued())
				.Any(item => item.Item == actorInfo.Name);
			return AgentBuildPlanController.EmergencyHarvesterAllowed(
				action.Count, hasUsableHarvester, hasQueuedHarvester);
		}

		static void RejectExcessHarvesterProduction(AgentSlot slot, AgentAction action, bool planOwned)
		{
			if (planOwned || action?.Item == null || slot.Player == null)
				return;

			var world = GetRegularWorld();
			if (world == null ||
				!world.Map.Rules.Actors.TryGetValue(action.Item, out var info) ||
				!info.HasTraitInfo<HarvesterInfo>())
				return;

			var own = world.Actors.Where(a => a.Owner == slot.Player && a.IsInWorld && !a.IsDead && !a.Disposed).ToArray();
			var liveHarv = own.Count(a => a.Info.HasTraitInfo<HarvesterInfo>());
			var refineries = own.Count(a => a.Info.HasTraitInfo<RefineryInfo>());
			var queuedHarv = own
				.SelectMany(a => a.TraitsImplementing<ProductionQueue>())
				.SelectMany(q => q.AllQueued())
				.Count(i => string.Equals(i.Item, action.Item, StringComparison.Ordinal) ||
					(world.Map.Rules.Actors.TryGetValue(i.Item, out var qi) && qi.HasTraitInfo<HarvesterInfo>()));
			var request = action.Count < 1 ? 1 : action.Count;
			if (AgentDoctrineExecutor.ShouldAllowMoreHarvesters(liveHarv, queuedHarv, refineries, request))
				return;

			var cap = AgentDoctrineExecutor.HarvesterSoftCap(refineries);
			throw new InvalidDataException(
				$"harvester soft cap reached: {liveHarv} live + {queuedHarv} queued for {refineries} refineries " +
				$"(max {cap}). Stop income spam — produce combat (3tnk/ftrk) or commitIntent strike/hold instead.");
		}

		static void ValidateBuildPlanCashFloor(AgentSlot slot, AgentAction action, ProductionQueue queue,
			ActorInfo actorInfo, bool planOwned)
		{
			var state = slot.BuildPlan;
			if (!doctrineExecutorEnabled || !state.Active || planOwned || IsEmergencyHarvesterProduction(slot, action) ||
				state.CurrentStep == null)
				return;

			var world = GetRegularWorld();
			if (!world.Map.Rules.Actors.TryGetValue(state.CurrentStep.Item, out var planActorInfo))
				return;
			var planQueue = FindBuildPlanQueue(world, slot.Player, planActorInfo, state.ProducerId);
			if (planQueue.Actor == null)
				return;
			var required = planQueue.Trait.GetProductionCost(planActorInfo) * state.CurrentStep.Count + state.ReserveCash;
			var spend = queue.GetProductionCost(actorInfo) * action.Count;
			var cash = slot.Player.PlayerActor?.TraitOrDefault<PlayerResources>()?.GetCashAndResources() ?? 0;
			if (!AgentBuildPlanController.DirectSpendLeavesPlanFloor(cash, spend,
				planQueue.Trait.GetProductionCost(planActorInfo) * state.CurrentStep.Count, state.ReserveCash))
				throw new InvalidDataException($"direct production would breach build plan '{state.PlanId}' cash floor {required}");
		}

		static void MarkDirectPlanPlacement(AgentSlot slot, AgentAction action, CPos cell, int worldTick, bool planOwned)
		{
			var state = slot.BuildPlan;
			if (planOwned || !doctrineExecutorEnabled || !state.Active || action.ProducerId != state.ProducerId ||
				action.Item != state.CurrentStep?.Item)
				return;

			state.PlacementCell = cell;
			state.LastOrderTick = worldTick;
			state.BlockedOn = "placement";
			AgentBuildPlanController.Transition(state, worldTick, "placing",
				$"commander placed current plan building {action.Item}");
		}

		static void ValidateNoUnmanagedQueuedProduction(AgentSlot slot)
		{
			var state = slot.BuildPlan;
			var step = state.CurrentStep;
			var world = GetRegularWorld();

			// Doctrine-streamed units are host-managed standing production; they must not block the
			// model from authoring or replacing its own build plan (a model-owned decision).
			var doctrine = slot.Doctrine;
			var streamUnits = doctrineExecutorEnabled && doctrine.Bound ? doctrine.Program?.StreamUnits : null;

			foreach (var queue in world.ActorsWithTrait<ProductionQueue>()
				.Where(q => q.Actor.Owner == slot.Player && q.Actor.IsInWorld && !q.Actor.IsDead && !q.Actor.Disposed)
				.OrderBy(q => q.Actor.ActorID)
				.ThenBy(q => q.Trait.Info.Type))
			{
				foreach (var item in queue.Trait.AllQueued())
				{
					var managedByCurrentPlan = state.Active && step != null && state.ProducerId == queue.Actor.ActorID &&
						state.StepState is "producing" or "waitingPlaceable" or "placing" && item.Item == step.Item;
					var managedByDoctrineStream = streamUnits != null &&
						streamUnits.Contains(item.Item, StringComparer.Ordinal);
					if (!managedByCurrentPlan && !managedByDoctrineStream)
						throw new InvalidDataException($"cannot start build plan while producer {queue.Actor.ActorID} " +
							$"has queued '{item.Item}'; finish or cancel it first");
				}
			}
		}

		static void CancelOutstandingBuildPlanProduction(AgentSlot slot, List<Order> orders)
		{
			var state = slot.BuildPlan;
			var step = state.CurrentStep;
			if (!state.Active || step == null || state.ProducerId == 0 ||
				state.StepState is not ("producing" or "waitingPlaceable" or "placing"))
				return;

			var producer = GetRegularWorld().GetActorById(state.ProducerId);
			var queuedCount = producer?.TraitsImplementing<ProductionQueue>()
				.SelectMany(q => q.AllQueued()).Count(i => i.Item == step.Item) ?? 0;
			if (queuedCount == 0)
				return;

			BuildOrders(slot, new AgentAction
			{
				Type = "cancelProduction",
				ProducerId = state.ProducerId,
				Item = step.Item,
				Count = Math.Min(queuedCount, MaxProductionCount)
			}, orders, true);
		}

		static (Actor Producer, ActorInfo ActorInfo, BuildingInfo BuildingInfo) ValidateReadyBuilding(
			AgentSlot slot, AgentAction action)
		{
			var world = GetRegularWorld();
			var producer = ValidateOwnedActor(slot, action.ProducerId);
			if (string.IsNullOrEmpty(action.Item) || !world.Map.Rules.Actors.TryGetValue(action.Item, out var actorInfo))
				throw new InvalidDataException($"unknown building '{action.Item}'");
			var buildingInfo = actorInfo.TraitInfoOrDefault<BuildingInfo>();
			if (buildingInfo == null)
				throw new InvalidDataException($"'{action.Item}' is not a building");
			if (actorInfo.HasTraitInfo<LineBuildInfo>() || actorInfo.HasTraitInfo<PlugInfo>())
				throw new InvalidDataException($"specialized placement for '{action.Item}' is not supported by schema v1");
			producer = ResolveProductionQueueOwner(slot, producer,
				q => q.AllQueued().Any(i => i.Item == actorInfo.Name));

			var queue = producer.TraitsImplementing<ProductionQueue>()
				.FirstOrDefault(q => q.CanBuild(actorInfo) && q.AllQueued().Any(i => i.Done && i.Item == actorInfo.Name));
			if (queue == null)
			{
				var pending = producer.TraitsImplementing<ProductionQueue>()
					.SelectMany(q => q.AllQueued())
					.FirstOrDefault(i => i.Item == actorInfo.Name);
				var eta = pending == null ? "" : $"; ~{(pending.RemainingTime + 24) / 25}s remain — wait for placeable:true";
				throw new InvalidDataException($"building '{action.Item}' is not ready on actor {producer.ActorID}{eta}");
			}

			return (producer, actorInfo, buildingInfo);
		}

		static Actor ResolveProductionQueueOwner(AgentSlot slot, Actor addressedActor, Func<ProductionQueue, bool> canServe)
		{
			if (addressedActor.TraitsImplementing<ProductionQueue>().Any(canServe) ||
				!addressedActor.Info.HasTraitInfo<BuildingInfo>())
				return addressedActor;

			var productionTypes = addressedActor.TraitsImplementing<Production>()
				.Where(p => !p.IsTraitDisabled)
				.SelectMany(p => p.Info.Produces)
				.ToHashSet(StringComparer.Ordinal);
			if (productionTypes.Count == 0)
				return addressedActor;

			var queue = GetRegularWorld().ActorsWithTrait<ProductionQueue>()
				.Where(q => q.Actor.Owner == slot.Player && q.Actor.IsInWorld && !q.Actor.IsDead && !q.Actor.Disposed &&
					productionTypes.Contains(q.Trait.Info.Type) && canServe(q.Trait))
				.OrderBy(q => q.Actor.ActorID)
				.ThenBy(q => q.Trait.Info.Type)
				.FirstOrDefault();
			return queue.Actor ?? addressedActor;
		}

		static Order CreatePlacementOrder(World world, Player player, Actor producer, ActorInfo actorInfo, CPos cell)
		{
			return new Order("PlaceBuilding", player.PlayerActor, Target.FromCell(world, cell), false)
			{
				TargetString = actorInfo.Name,
				ExtraData = producer.ActorID,
				ExtraLocation = CPos.Zero,
				SuppressVisualFeedback = true
			};
		}

		static IEnumerable<Actor> ValidateSubjects(AgentSlot slot, AgentAction action, string orderName,
			List<uint> skippedActorIds)
		{
			var actors = ValidateOwnedActors(slot, action, skippedActorIds).ToArray();
			var accepted = new List<Actor>();
			foreach (var actor in actors)
			{
				if (!actor.AcceptsOrder(orderName))
					skippedActorIds.Add(actor.ActorID);
				else
					accepted.Add(actor);
			}

			if (accepted.Count == 0)
				throw new InvalidDataException($"actor {actors[0].ActorID} rejects {orderName}");
			return accepted;
		}

		static IEnumerable<Actor> ValidateOwnedActors(AgentSlot slot, AgentAction action, List<uint> skippedActorIds)
		{
			var hasActorIds = action.ActorIds != null && action.ActorIds.Count != 0;
			var hasGroupName = action.GroupName != null;
			if (hasActorIds == hasGroupName)
				throw new InvalidDataException("exactly one of actorIds or groupName is required");

			var actorIds = hasGroupName
				? AgentSquadController.ResolveActorIds(slot.Squads, action.GroupName, GetRegularWorld(), slot.Player)
				: action.ActorIds;

			var actors = new List<Actor>();
			foreach (var actorId in actorIds.Distinct())
			{
				var actor = GetRegularWorld().GetActorById(actorId);
				if (actor == null || actor.Disposed || actor.IsDead || !actor.IsInWorld || actor.Owner != slot.Player)
					skippedActorIds.Add(actorId);
				else
					actors.Add(actor);
			}

			if (actors.Count == 0)
				throw new InvalidDataException("actor is stale, missing, or not owned by this agent");
			return actors;
		}

		static Actor ValidateOwnedActor(AgentSlot slot, uint actorId)
		{
			var actor = GetRegularWorld().GetActorById(actorId);
			if (actor == null || actor.Disposed || actor.IsDead || !actor.IsInWorld || actor.Owner != slot.Player)
				throw new InvalidDataException("actor is stale, missing, or not owned by this agent");
			return actor;
		}

		static CPos ValidateTargetCell(AgentAction action)
		{
			var cell = new CPos(action.CellX, action.CellY);
			var world = GetRegularWorld();
			if (!world.Map.Contains(cell))
				throw new InvalidDataException($"cell {cell} is outside the map");
			return cell;
		}

		static void EnsurePlayersMapped()
		{
			var orderManager = Game.OrderManager;
			var world = orderManager?.World;
			if (world == null || world.Type != WorldType.Regular ||
				(AgentSlots.All(a => a.Player != null) && (opponentBotType == null || opponentPlayer != null)))
				return;

			var botClients = orderManager.LobbyInfo.Clients
				.Where(c => c.Bot == AgentBotType)
				.OrderBy(c => c.Index)
				.ToArray();
			if (botClients.Length != AgentSlots.Count)
				return;

			for (var i = 0; i < AgentSlots.Count; i++)
				AgentSlots[i].Player = world.Players.FirstOrDefault(p => p.ClientIndex == botClients[i].Index);

			if (opponentBotType != null)
			{
				var opponentClient = orderManager.LobbyInfo.Clients
					.Where(c => c.Bot == opponentBotType)
					.OrderBy(c => c.Index)
					.FirstOrDefault();
				opponentPlayer = world.Players.FirstOrDefault(p => p.ClientIndex == opponentClient?.Index);
			}
		}

		static AgentPlayerState ToPlayerState(Player player, string agentId, string controllerType)
		{
			return player == null ? null : new AgentPlayerState
			{
				AgentId = agentId,
				ControllerType = controllerType,
				ClientIndex = player.ClientIndex,
				PlayerName = player.ResolvedPlayerName,
				Faction = player.Faction.InternalName,
				WinState = player.WinState.ToString(),
				PlayerColor = PlayerColorHex(player),
				SeatIdentity = agentId ?? $"opponent:{controllerType}"
			};
		}

		static string PlayerColorHex(Player player)
		{
			return player == null ? null : $"#{player.Color}";
		}

		static AgentSlot GetActiveSlot(string agentId)
		{
			if (matchId == null)
				throw new InvalidOperationException("no Agent mode match is active");

			EnsurePlayersMapped();
			var slot = AgentSlots.FirstOrDefault(a => a.Id == agentId);
			if (slot == null)
				throw new InvalidDataException("unknown agent id");
			if (slot.Player == null)
				throw new InvalidOperationException("agent world is not ready");
			return slot;
		}

		static AgentSlot GetPreparedSlot(string agentId)
		{
			if (matchId == null || matchLaunched)
				throw new InvalidOperationException("no prepared Agent mode match is active");
			return AgentSlots.FirstOrDefault(slot => slot.Id == agentId) ??
				throw new InvalidDataException("unknown agent id");
		}

		static void EnsurePlanningWarmupAllowsGameplay()
		{
			if (planningFailureReason != null)
				throw new InvalidOperationException(planningFailureReason);
			if (prematchPlanningEnabled && !planningWarmupResolved)
				throw new InvalidOperationException("prematch planning actions have not reached the warmup boundary");
		}

		static void EnsureLegacyDecisionApiAllowed()
		{
			if (benchmarkLockstepEnabled)
				throw new InvalidOperationException(
					"legacy observation/due/submit APIs are disabled by benchmark lockstep; use the barrier API");
		}

		static void CountDecisionOpportunity(AgentSlot slot, long decisionId)
		{
			if (decisionId <= slot.LastOpportunityDecisionId)
				return;

			slot.LastOpportunityDecisionId = decisionId;
			slot.DecisionOpportunities++;

			// FIX-1 outcome-delta is "since last decision"; clear the loss counters after the decision saw it.
			slot.OutcomeEnemyCombatLost = 0;
			slot.OutcomeOwnCombatLost = 0;
		}

		static void SetFallbackCounters(AgentSlot slot, AgentActionBatchResult result)
		{
			result.FallbackTurns = slot.FallbackTurns;
			result.DecisionOpportunities = slot.DecisionOpportunities;
		}

		static World GetRegularWorld()
		{
			var world = Game.OrderManager?.World;
			if (world == null || world.Type != WorldType.Regular)
				throw new InvalidOperationException("Agent mode world is not ready");
			return world;
		}

		static string SerializeBounded(AgentObservation observation)
		{
			var bytes = JsonSerializer.SerializeToUtf8Bytes(observation, JsonOptions);
			while (bytes.Length > AgentModeLimits.MaxJsonBytes && observation.Actors.Count != 0)
			{
				observation.Truncated = true;
				observation.Actors.RemoveRange(Math.Max(0, observation.Actors.Count - 32), Math.Min(32, observation.Actors.Count));
				bytes = JsonSerializer.SerializeToUtf8Bytes(observation, JsonOptions);
			}

			if (bytes.Length > AgentModeLimits.MaxJsonBytes)
				throw new InvalidDataException("observation metadata exceeds 256 KiB");
			return Encoding.UTF8.GetString(bytes);
		}

		static string SerializePlanningObservationBounded(AgentPlanningObservation observation)
		{
			var bytes = JsonSerializer.SerializeToUtf8Bytes(observation, JsonOptions);
			if (bytes.Length > AgentModeLimits.MaxJsonBytes)
				throw new InvalidDataException("planning observation exceeds 256 KiB");

			return Encoding.UTF8.GetString(bytes);
		}

		static string Serialize<T>(T value)
		{
			return JsonSerializer.Serialize(value, JsonOptions);
		}

		static string Error(string message)
		{
			return Serialize(new AgentError { Error = message });
		}

		static bool IsErrorResult(string result)
		{
			if (string.IsNullOrEmpty(result) || result[0] != '{')
				return false;
			try
			{
				using var document = JsonDocument.Parse(result);
				return document.RootElement.TryGetProperty("error", out _);
			}
			catch (JsonException)
			{
				return false;
			}
		}

		static bool ValidSpendCap(double value)
		{
			return !double.IsNaN(value) && !double.IsInfinity(value) && value >= 0.01 && value <= 1000;
		}

		static void StampReplayTelemetry(AgentReplayTelemetry telemetry)
		{
			telemetry.ResolvedProfile = resolvedProfile;
			telemetry.StrategyArsenalEnabled = strategyArsenalEnabled;
			telemetry.ActionGuidanceEnabled = actionGuidanceEnabled;
			telemetry.DoctrineExecutorEnabled = doctrineExecutorEnabled;
			telemetry.DoctrineFallbackStrikeEnabled = doctrineFallbackStrikeEnabled;
			telemetry.AdvisorFallbackEnabled = advisorFallbackEnabled;
			telemetry.StaffSeatEnabled = staffSeatEnabled;
			if (telemetry.AgentId == null)
				return;

			var slot = AgentSlots.FirstOrDefault(candidate => candidate.Id == telemetry.AgentId);
			if (slot == null)
				return;
			telemetry.SeatIdentity = $"agent{slot.Ordinal + 1}:{slot.Id}";
			if (slot.Player != null)
				telemetry.PlayerColor = PlayerColorHex(slot.Player);
		}

		static void ValidateReplayTelemetry(AgentReplayTelemetry telemetry)
		{
			if (telemetry.SchemaVersion != AgentModeLimits.SchemaVersion)
				throw new InvalidDataException($"unsupported schemaVersion {telemetry.SchemaVersion}");
			if (telemetry.MatchId != matchId)
				throw new InvalidDataException("telemetry matchId does not match the active match");
			if (telemetry.Kind is not ("match" or "decided" or "result" or "error" or "budget" or "alert" or "reflex" or
				"fallback" or "mission" or "planning" or "strategy" or "doctrine"))
				throw new InvalidDataException("unsupported telemetry kind");
			if (telemetry.Fallback != (telemetry.Kind == "fallback"))
				throw new InvalidDataException("fallback telemetry must use kind 'fallback' and only fallback telemetry may set fallback=true");
			if (telemetry.Fallback && (telemetry.AgentId == null || telemetry.DecisionId < 0 || telemetry.WorldTick < 0))
				throw new InvalidDataException("fallback telemetry requires agentId, decisionId, and worldTick");
			if (telemetry.AgentId != null && AgentSlots.All(a => a.Id != telemetry.AgentId))
				throw new InvalidDataException("unknown telemetry agent id");
			if ((telemetry.Model?.Length ?? 0) > 200)
				throw new InvalidDataException("telemetry model id exceeds 200 characters");
			if ((telemetry.Role?.Length ?? 0) > 40)
				throw new InvalidDataException("telemetry model role exceeds 40 characters");
			if ((telemetry.Prompt?.Length ?? 0) > AgentModeLimits.MaxPromptChars)
				throw new InvalidDataException($"telemetry prompt exceeds {AgentModeLimits.MaxPromptChars} characters");
			if ((telemetry.Thoughts?.Length ?? 0) > AgentModeLimits.MaxThoughtChars)
				throw new InvalidDataException($"telemetry thoughts exceeds {AgentModeLimits.MaxThoughtChars} characters");
			if ((telemetry.Summary?.Length ?? 0) > AgentModeLimits.MaxTelemetrySummaryChars)
				throw new InvalidDataException($"telemetry summary exceeds {AgentModeLimits.MaxTelemetrySummaryChars} characters");
			if (telemetry.PromptTokens < 0 || telemetry.CompletionTokens < 0 ||
				double.IsNaN(telemetry.CostUsd) || double.IsInfinity(telemetry.CostUsd) || telemetry.CostUsd < 0)
				throw new InvalidDataException("telemetry usage values are invalid");
		}

		static void FlushReplayTelemetry()
		{
			var orderManager = Game.OrderManager;

			// Sending an immediate order while the local client is still handshaking
			// can put it on the wire with the unassigned client id. Keep metadata in
			// the host queue until normal game orders and replay recording are live.
			if (!matchLaunched || orderManager?.GameStarted != true || orderManager.World?.Type != WorldType.Regular)
				return;

			while (PendingReplayTelemetry.TryDequeue(out var telemetry))
			{
				// A subject-less unknown order is inert during live play and replay playback,
				// but remains embedded in the recorded order stream for reproducibility tools.
				orderManager.IssueOrder(new Order(ReplayMetadataOrder, null, false)
				{
					IsImmediate = true,
					TargetString = telemetry
				});
			}
		}

		static void Reset()
		{
			matchId = null;
			matchLaunched = false;
			fakeAgents = false;
			omniscientObservations = false;
			advisorFallbackEnabled = false;
			prematchPlanningEnabled = false;
			strategyArsenalEnabled = false;
			doctrineExecutorEnabled = false;
			actionGuidanceEnabled = false;
			doctrineFallbackStrikeEnabled = false;
			staffSeatEnabled = false;
			playCadenceEnabled = false;
			benchmarkLockstepEnabled = false;
			benchmarkDecisionTimeoutMs = 0;
			lockstepState = null;
			adjudicationLedger = null;
			AdjudicationControlRegions.Clear();
			AdjudicationControlRegionByCell.Clear();
			AdjudicationStructureTypes.Clear();
			adjudicationControlRegionHash = null;
			adjudicationStructureCatalogInitialized = false;
			LockstepSnapshots.Clear();
			lockstepLastControllerWorldTick = -1;
			lockstepStopPauseIssued = false;
			resolvedProfile = null;
			buildPlanStallWatchdogTicks = 0;
			buildPlanInternalFailureWatchdogTicks = 0;
			planningWarmupResolved = false;
			planningFailureReason = null;
			planningTimeoutMs = 0;
			preparedMapUid = null;
			preparedMapTitle = null;
			preparedMapBounds = Rectangle.Empty;
			preparedSpawnPoints.Clear();
			preparedLaunchOrders.Clear();
			spectatorCameraCentered = false;
			opponentBotType = null;
			opponentPlayer = null;
			decisionIntervalTicks = 0;
			matchSpendCapUsd = 0;
			fakePhase = 0;
			nextFakeTick = 0;
			fakeAgentStatus = "disabled";
			PendingReplayTelemetry.Clear();
			AgentSlots.Clear();
		}

		static void TickFakeAgents()
		{
			var world = Game.OrderManager?.World;
			if (world == null || world.Type != WorldType.Regular || AgentSlots.Any(a => a.Player == null) || world.WorldTick < nextFakeTick)
				return;
			if (world.WorldTick < ObservationWarmupTicks)
			{
				nextFakeTick = ObservationWarmupTicks;
				return;
			}

			try
			{
				switch (fakePhase)
				{
					case 0:
						RunAdversarialChecks();
						IssueFakeMoveOrders(world);
						fakeAgentStatus = "checks passed; both agents issued move orders";
						break;
					case 1:
						IssueFakeStopOrders(world);
						fakeAgentStatus = "both agents issued stop orders";
						break;
					case 2:
						SubmitBatch(AgentSlots[1], new AgentActionBatch
						{
							SchemaVersion = AgentModeLimits.SchemaVersion,
							DecisionId = 12,
							ObservedSequence = AgentSlots[1].ObservationSequence,
							ObservedWorldTick = world.WorldTick,
							Thoughts = "A0 deterministic surrender phase.",
							Actions = [new AgentAction { Type = "surrender" }]
						});
						fakeAgentStatus = "agent 2 surrendered through the order pipeline";
						break;
					case 3:
						if (AgentSlots.Any(a => a.Player.WinState == WinState.Undefined))
						{
							fakeAgentStatus = "waiting for the surrender result";
							nextFakeTick = world.WorldTick + 25;
							return;
						}

						if (Game.OrderManager.IsOutOfSync)
							throw new InvalidDataException("sync error detected in fake-agent match");

						fakeAgents = false;
						fakeAgentStatus = "PASS: checks passed, both agents issued orders, match finished without a sync error";
						Console.WriteLine($"[AGENT-A0] tick={world.WorldTick}: {fakeAgentStatus}");
						return;
					default:
						return;
				}

				fakePhase++;
				nextFakeTick = world.WorldTick + decisionIntervalTicks;
				Console.WriteLine($"[AGENT-A0] phase={fakePhase} tick={world.WorldTick}: {fakeAgentStatus}");
			}
			catch (Exception e)
			{
				fakeAgents = false;
				fakeAgentStatus = $"FAILED phase={fakePhase} tick={world.WorldTick}: {e.Message}";
				Console.WriteLine($"[AGENT-A0] {fakeAgentStatus}\n{e}");
			}
		}

		static void RunAdversarialChecks()
		{
			var world = GetRegularWorld();
			AgentSituationEngine.ValidateDeterministicContract();
			var playerActors = world.Players.Select(p => p.PlayerActor).ToHashSet();
			foreach (var slot in AgentSlots)
			{
				var observation = BuildObservation(slot);
				var observedIds = observation.Actors.Select(a => a.ActorId).ToHashSet();
				var hiddenEnemies = world.Actors.Where(a => a.IsInWorld && !a.IsDead && !playerActors.Contains(a) && a.Owner != null &&
					slot.Player.RelationshipWith(a.Owner) == PlayerRelationship.Enemy && !a.CanBeViewedByPlayer(slot.Player)).ToArray();
				if (hiddenEnemies.Length == 0)
					throw new InvalidDataException($"fog test for {slot.Id} has no hidden enemy control sample");
				if (hiddenEnemies.Any(a => observedIds.Contains(a.ActorID)))
					throw new InvalidDataException($"fog leak detected for {slot.Id}");
				if (Encoding.UTF8.GetByteCount(SerializeBounded(observation)) > AgentModeLimits.MaxJsonBytes)
					throw new InvalidDataException("observation exceeds the hard size limit");

				var deployable = world.Actors.FirstOrDefault(a => a.Owner == slot.Player && a.IsInWorld && !a.IsDead &&
					!a.Info.HasTraitInfo<BuildingInfo>() &&
					a.TraitOrDefault<Transforms>() is IIssueDeployOrder deploy && deploy.CanIssueDeployOrder(a, false));
				if (deployable == null || observation.Actors.All(a => a.ActorId != deployable.ActorID || !a.Capabilities.Contains("deploy")))
					throw new InvalidDataException($"deploy capability check failed for {slot.Id}");
			}

			var firstSlot = AgentSlots[0];
			var deployActor = world.Actors.First(a => a.Owner == firstSlot.Player && a.IsInWorld && !a.IsDead &&
				!a.Info.HasTraitInfo<BuildingInfo>() &&
				a.TraitOrDefault<Transforms>() is IIssueDeployOrder deploy && deploy.CanIssueDeployOrder(a, false));
			var deployOrders = new List<Order>();
			BuildOrders(firstSlot, new AgentAction { Type = "deploy", ActorIds = [deployActor.ActorID] }, deployOrders);
			if (deployOrders.Count != 1 || deployOrders[0].OrderString != "DeployTransform")
				throw new InvalidDataException("deploy order adapter check failed");

			var movable = world.Actors.First(a => a.Owner == firstSlot.Player && a.IsInWorld && !a.IsDead &&
				a.Info.HasTraitInfo<MobileInfo>() && a.AcceptsOrder("Move"));
			var unexploredCell = world.Map.AllCells
				.Where(c => world.Map.Contains(c) && !firstSlot.Player.Shroud.IsExplored(c))
				.Select(c => (CPos?)c).FirstOrDefault();
			if (!unexploredCell.HasValue)
				throw new InvalidDataException("move-into-fog check has no unexplored target cell");

			var fogMoveOrders = new List<Order>();
			BuildOrders(firstSlot, new AgentAction
			{
				Type = "move",
				ActorIds = [movable.ActorID],
				CellX = unexploredCell.Value.X,
				CellY = unexploredCell.Value.Y
			}, fogMoveOrders);
			if (fogMoveOrders.Count != 1 || fogMoveOrders[0].OrderString != "Move")
				throw new InvalidDataException("move-into-fog adapter check failed");

			var ownedBySecond = world.Actors.Where(a => a.Owner == AgentSlots[1].Player && a.IsInWorld && !a.IsDead)
				.OrderBy(a => a.ActorID).First();
			var ownership = SubmitBatch(AgentSlots[0], new AgentActionBatch
			{
				SchemaVersion = AgentModeLimits.SchemaVersion,
				DecisionId = 1,
				ObservedSequence = AgentSlots[0].ObservationSequence,
				ObservedWorldTick = world.WorldTick,
				Thoughts = "A0 ownership rejection check.",
				Actions = [new AgentAction { Type = "stop", ActorIds = [ownedBySecond.ActorID] }]
			});
			if (ownership.Rejected != 1 || ownership.Accepted != 0)
				throw new InvalidDataException("ownership rejection check failed");

			try
			{
				SubmitBatch(AgentSlots[0], new AgentActionBatch
				{
					SchemaVersion = AgentModeLimits.SchemaVersion,
					DecisionId = 1,
					ObservedSequence = AgentSlots[0].ObservationSequence,
					ObservedWorldTick = world.WorldTick,
					Thoughts = "A0 duplicate decision check."
				});
				throw new InvalidDataException("duplicate decision check failed");
			}
			catch (InvalidDataException e) when (e.Message.StartsWith("duplicate", StringComparison.Ordinal))
			{
			}

			var stale = SubmitBatch(AgentSlots[0], new AgentActionBatch
			{
				SchemaVersion = AgentModeLimits.SchemaVersion,
				DecisionId = 2,
				ObservedSequence = AgentSlots[0].ObservationSequence,
				ObservedWorldTick = world.WorldTick,
				Thoughts = "A0 stale actor rejection check.",
				Actions = [new AgentAction { Type = "stop", ActorIds = [uint.MaxValue] }]
			});
			if (stale.Rejected != 1 || stale.Accepted != 0)
				throw new InvalidDataException("stale actor rejection check failed");

			var hiddenForFirst = world.Actors.Where(a => a.IsInWorld && !a.IsDead && !playerActors.Contains(a) && a.Owner != null &&
				AgentSlots[0].Player.RelationshipWith(a.Owner) == PlayerRelationship.Enemy && !a.CanBeViewedByPlayer(AgentSlots[0].Player))
				.OrderBy(a => a.ActorID).First();
			var hiddenOwnership = SubmitBatch(AgentSlots[0], new AgentActionBatch
			{
				SchemaVersion = AgentModeLimits.SchemaVersion,
				DecisionId = 3,
				ObservedSequence = AgentSlots[0].ObservationSequence,
				ObservedWorldTick = world.WorldTick,
				Thoughts = "A0 hidden actor oracle rejection check.",
				Actions = [new AgentAction { Type = "stop", ActorIds = [hiddenForFirst.ActorID] }]
			});
			if (hiddenOwnership.Rejected != 1 || hiddenOwnership.Results[0].Reason != stale.Results[0].Reason)
				throw new InvalidDataException("hidden actor rejection leaked actor existence");

			try
			{
				SubmitBatch(AgentSlots[0], new AgentActionBatch
				{
					SchemaVersion = AgentModeLimits.SchemaVersion,
					DecisionId = 4,
					ObservedSequence = AgentSlots[0].ObservationSequence,
					ObservedWorldTick = world.WorldTick,
					Thoughts = "A0 oversized action count check.",
					Actions = Enumerable.Range(0, AgentModeLimits.MaxActionsPerDecision + 1)
						.Select(_ => new AgentAction { Type = "stop", ActorIds = [uint.MaxValue] }).ToList()
				});
				throw new InvalidDataException("oversized action count check failed");
			}
			catch (InvalidDataException e) when (e.Message.StartsWith("action count", StringComparison.Ordinal))
			{
			}

			try
			{
				SubmitBatch(AgentSlots[0], new AgentActionBatch
				{
					SchemaVersion = AgentModeLimits.SchemaVersion,
					DecisionId = 4,
					ObservedSequence = AgentSlots[0].ObservationSequence,
					ObservedWorldTick = world.WorldTick,
					Thoughts = "A0 oversized subject count check.",
					Actions =
					[
						new AgentAction
						{
							Type = "stop",
							ActorIds = Enumerable.Repeat(uint.MaxValue, AgentModeLimits.MaxSubjectIdsPerDecision + 1).ToList()
						}
					]
				});
				throw new InvalidDataException("oversized subject count check failed");
			}
			catch (InvalidDataException e) when (e.Message.StartsWith("subject id count", StringComparison.Ordinal))
			{
			}

			var malformed = SubmitActions(AgentSlots[0].Id, "{");
			if (!malformed.Contains("malformed action JSON", StringComparison.Ordinal))
				throw new InvalidDataException("malformed JSON check failed");
		}

		static void IssueFakeMoveOrders(World world)
		{
			foreach (var slot in AgentSlots)
			{
				var actor = world.Actors.Where(a => a.Owner == slot.Player && a.IsInWorld && !a.IsDead &&
					a.Info.HasTraitInfo<MobileInfo>() && a.AcceptsOrder("Move"))
					.OrderBy(a => a.ActorID).FirstOrDefault();
				if (actor == null)
					throw new InvalidDataException($"{slot.Id} has no movable actor");

				slot.FakeActorId = actor.ActorID;
				slot.FakeStartCell = actor.Location;
				var mobile = actor.Trait<Mobile>();
				CVec[] directions = slot.Ordinal == 0
					? [new CVec(1, 0), new CVec(1, 1), new CVec(0, 1), new CVec(-1, 1), new CVec(-1, 0), new CVec(0, -1)]
					: [new CVec(-1, 0), new CVec(-1, -1), new CVec(0, -1), new CVec(1, -1), new CVec(1, 0), new CVec(0, 1)];
				var target = directions.Select(d => actor.Location + d)
					.Where(c => world.Map.Contains(c) && slot.Player.Shroud.IsExplored(c) && mobile.CanEnterCell(c, actor))
					.Cast<CPos?>().FirstOrDefault();
				if (!target.HasValue)
					throw new InvalidDataException($"{slot.Id} has no reachable adjacent cell");

				var result = SubmitBatch(slot, new AgentActionBatch
				{
					SchemaVersion = AgentModeLimits.SchemaVersion,
					DecisionId = 10,
					ObservedSequence = slot.ObservationSequence,
					ObservedWorldTick = world.WorldTick,
					Thoughts = "A0 deterministic move phase.",
					Actions =
					[
						new AgentAction
						{
							Type = "move",
							ActorIds = [actor.ActorID],
							CellX = target.Value.X,
							CellY = target.Value.Y
						}
					]
				});
				if (result.Accepted != 1)
					throw new InvalidDataException($"fake move rejected for {slot.Id}: {result.Results[0].Reason}");
			}
		}

		static void IssueFakeStopOrders(World world)
		{
			foreach (var slot in AgentSlots)
			{
				var actor = world.GetActorById(slot.FakeActorId);
				if (actor == null || actor.Disposed || actor.IsDead || !actor.IsInWorld)
					throw new InvalidDataException($"fake actor {slot.FakeActorId} became stale before movement verification");
				if (actor.Location == slot.FakeStartCell)
					throw new InvalidDataException($"bot-owned move order was not applied for {slot.Id}");

				var result = SubmitBatch(slot, new AgentActionBatch
				{
					SchemaVersion = AgentModeLimits.SchemaVersion,
					DecisionId = 11,
					ObservedSequence = slot.ObservationSequence,
					ObservedWorldTick = world.WorldTick,
					Thoughts = "A0 deterministic stop phase.",
					Actions = [new AgentAction { Type = "stop", ActorIds = [actor.ActorID] }]
				});
				if (result.Accepted != 1)
					throw new InvalidDataException($"fake stop rejected for {slot.Id}: {result.Results[0].Reason}");
			}
		}
	}
}
