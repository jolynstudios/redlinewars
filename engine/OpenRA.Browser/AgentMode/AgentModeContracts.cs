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
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenRA.Browser
{
	public static class AgentModeLimits
	{
		public const string Era = "era3-skills";
		public const string BenchmarkSpecVersion = "benchmark-lockstep-v1";
		public const int SchemaVersion = 1;
		public const int MaxJsonBytes = 256 * 1024;
		public const int MaxActionsPerDecision = 12;
		public const int MaxActionsPerPlanning = 2;
		public const int MaxActionsPerArsenalPlanning = 3;
		public const int MaxSubjectIdsPerDecision = 256;
		public const int DefaultPlanningTimeoutMs = 30000;
		public const int MinPlanningTimeoutMs = 10000;
		public const int MaxPlanningTimeoutMs = 120000;
		public const int DefaultBenchmarkDecisionTimeoutMs = 120000;
		public const int MaxThoughtChars = 1000;
		public const int MaxMemoChars = 600;
		public const int MaxPromptChars = 8000;
		public const int MaxTelemetrySummaryChars = 4000;
		public const int MaxStrategyReasonChars = 240;
		public const string SidecarSchemaFingerprint = "2d95298daf25e89a12dbb802bb4cca7e063904f2b3473cd257cd6af04cabbd6b";
		public const string RulesKnowledgeHash = "6e59f10160f65db9cd45a185bdebcb061bda281549a84bc9714222a303b7abc8";
	}

	public sealed class AgentContractManifest
	{
		public int ContractVersion { get; set; } = 1;
		public string Era { get; set; } = AgentModeLimits.Era;
		public string BenchmarkSpecVersion { get; set; } = AgentModeLimits.BenchmarkSpecVersion;
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public int MaxActionsPerDecision { get; set; } = AgentModeLimits.MaxActionsPerDecision;
		public int MaxSubjectIdsPerDecision { get; set; } = AgentModeLimits.MaxSubjectIdsPerDecision;
		public string SidecarSchemaFingerprint { get; set; } = AgentModeLimits.SidecarSchemaFingerprint;
		public string RulesKnowledgeHash { get; set; } = AgentModeLimits.RulesKnowledgeHash;
		public List<AgentContractRule> FieldRules { get; set; } = [];
		public List<string> BatchInvariants { get; set; } = [];
		public List<string> ConfigSurface { get; set; } = [];
		public List<string> ObservationFields { get; set; } = [];
		public List<AgentContractRule> ObservationRules { get; set; } = [];
		public List<string> MissionEventFields { get; set; } = [];
		public List<string> StrategyEventFields { get; set; } = [];
		public List<string> MatchStateFields { get; set; } = [];
		public List<string> SituationKinds { get; set; } = [];
		public AgentPlanningContractManifest Planning { get; set; } = new();
		public AgentArsenalContractManifest Arsenal { get; set; } = new();
		public List<AgentContractVariant> Variants { get; set; } = [];
	}

	public sealed class AgentPlanningContractManifest
	{
		public int MaxActionsPerPlanning { get; set; } = AgentModeLimits.MaxActionsPerPlanning;
		public List<string> BatchInvariants { get; set; } = [];
		public List<AgentContractVariant> Variants { get; set; } = [];
	}

	public sealed class AgentArsenalContractManifest
	{
		public bool EnabledByConfig { get; set; } = true;
		public int MaxActionsPerDecision { get; set; } = AgentModeLimits.MaxActionsPerDecision;
		public int MaxActionsPerPlanning { get; set; } = AgentModeLimits.MaxActionsPerArsenalPlanning;
		public int CatalogVersion { get; set; }
		public string CatalogFileHash { get; set; }
		public string ManualFileHash { get; set; }
		public string RulesGraphHash { get; set; }
		public string RulesArtifactHash { get; set; }
		public string RulesHash { get; set; }
		public List<string> StrategyIds { get; set; } = [];
		public List<string> BatchInvariants { get; set; } = [];
		public List<string> PlanningBatchInvariants { get; set; } = [];
		public List<AgentContractVariant> Variants { get; set; } = [];
	}

	public sealed class AgentContractRule
	{
		public string Path { get; set; }
		public string Rule { get; set; }
	}

	public sealed class AgentContractVariant
	{
		public string VariantId { get; set; }
		public string Type { get; set; }
		public List<string> Fields { get; set; } = [];
		public List<AgentContractStringEnum> StringEnums { get; set; } = [];
	}

	public sealed class AgentContractStringEnum
	{
		public string Field { get; set; }
		public List<string> Values { get; set; } = [];
	}

	public sealed class AgentContractManifestEnvelope
	{
		public AgentContractManifest Manifest { get; set; }
		public string Fingerprint { get; set; }
	}

	public sealed class AgentMatchConfig
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public bool FakeAgents { get; set; }
		public int DecisionIntervalTicks { get; set; } = 500;
		public bool OmniscientObservations { get; set; }
		public bool AdvisorFallbackEnabled { get; set; }
		public bool PrematchPlanning { get; set; }
		public bool StrategyArsenalEnabled { get; set; }

		/// <summary>
		/// When true with arsenal, host may emit doctrine standing orders (PR2+).
		/// PR1 ships observation only; default remains false.
		/// </summary>
		public bool DoctrineExecutorEnabled { get; set; }
		public bool ActionGuidanceEnabled { get; set; }
		public bool DoctrineFallbackStrikeEnabled { get; set; }
		public bool StaffSeatEnabled { get; set; }

		/// <summary>
		/// Play/RTS-Agent cadence profile (Host.PlayCadence). When true the reactive preset lowers the
		/// effective decision interval toward the play cadence floor and relaxes the adaptive slow-model
		/// punish; the raw pure-benchmark track keeps tempo-as-score and is never affected. Default false.
		/// </summary>
		public bool PlayCadenceEnabled { get; set; }
		public bool BenchmarkLockstepEnabled { get; set; }
		public string BenchmarkSpecVersion { get; set; } = AgentModeLimits.BenchmarkSpecVersion;
		public int BenchmarkDecisionTimeoutMs { get; set; } = AgentModeLimits.DefaultBenchmarkDecisionTimeoutMs;
		public int BenchmarkTickHorizon { get; set; }
		public int BenchmarkDecisionHorizon { get; set; }
		public List<AgentBenchmarkControlRegionDefinition> BenchmarkControlRegions { get; set; } = [];
		public int BuildPlanStallWatchdogTicks { get; set; } = AgentBuildPlanController.DefaultStallWatchdogTicks;
		public int BuildPlanInternalFailureWatchdogTicks { get; set; } =
			AgentBuildPlanController.DefaultInternalFailureWatchdogTicks;

		/// <summary>
		/// Lobby gamespeed id (mod.yaml GameSpeeds.Speeds keys). Default fastest so agent
		/// smokes spend less wall-clock on long builds; both seats share the same option (MP-safe).
		/// </summary>
		public string GameSpeed { get; set; } = "fastest";

		public int PlanningTimeoutMs { get; set; } = AgentModeLimits.DefaultPlanningTimeoutMs;
		public double MatchSpendCapUsd { get; set; } = 2;
		public double Agent1SpendCapUsd { get; set; } = 1;
		public double Agent2SpendCapUsd { get; set; } = 1;
		public string OpponentBot { get; set; }
		public string Faction1 { get; set; } = "russia";
		public string Faction2 { get; set; } = "russia";
	}

	public sealed class AgentMatchStartResult
	{
		public string Era { get; set; } = AgentModeLimits.Era;
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public string MatchId { get; set; }
		public string MapUid { get; set; }
		public string GameSpeed { get; set; }
		public string MapTitle { get; set; }
		public List<string> AgentIds { get; set; } = [];
		public bool FakeAgents { get; set; }
		public bool OmniscientObservations { get; set; }
		public bool AdvisorFallbackEnabled { get; set; }
		public bool PrematchPlanning { get; set; }
		public bool StrategyArsenalEnabled { get; set; }
		public bool DoctrineExecutorEnabled { get; set; }
		public bool ActionGuidanceEnabled { get; set; }
		public bool DoctrineFallbackStrikeEnabled { get; set; }
		public bool StaffSeatEnabled { get; set; }
		public bool PlayCadenceEnabled { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentBenchmarkLockstepSpec BenchmarkLockstep { get; set; }
		public string ResolvedProfile { get; set; }
		public int BuildPlanStallWatchdogTicks { get; set; }
		public int BuildPlanInternalFailureWatchdogTicks { get; set; }
		public int PlanningTimeoutMs { get; set; } = AgentModeLimits.DefaultPlanningTimeoutMs;
		public string OpponentBot { get; set; }
	}

	public sealed class AgentMatchState
	{
		public string Era { get; set; } = AgentModeLimits.Era;
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public string MatchId { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string MapUid { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string MapTitle { get; set; }
		public string State { get; set; }
		public int WorldTick { get; set; } = -1;
		public int NetFrame { get; set; } = -1;
		public bool OutOfSync { get; set; }
		public double TotalSpentUsd { get; set; }
		public double MatchSpendCapUsd { get; set; }
		public List<AgentPlayerState> Agents { get; set; } = [];
		public AgentPlayerState Opponent { get; set; }
		public bool AdvisorFallbackEnabled { get; set; }
		public bool StrategyArsenalEnabled { get; set; }
		public bool DoctrineExecutorEnabled { get; set; }
		public bool ActionGuidanceEnabled { get; set; }
		public bool DoctrineFallbackStrikeEnabled { get; set; }
		public bool StaffSeatEnabled { get; set; }
		public bool PlayCadenceEnabled { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public int? DecisionIntervalTicks { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentBenchmarkLockstepSpec BenchmarkLockstep { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentLockstepBarrierSnapshot LockstepBarrier { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentAdjudicationTelemetry Adjudication { get; set; }
		public string ResolvedProfile { get; set; }
		public int BuildPlanStallWatchdogTicks { get; set; }
		public int BuildPlanInternalFailureWatchdogTicks { get; set; }
		public string OpponentBot { get; set; }
		public string FakeAgentStatus { get; set; }
		public string TerminalReason { get; set; }
	}

	public sealed class AgentBenchmarkLockstepSpec
	{
		public string SpecVersion { get; set; } = AgentModeLimits.BenchmarkSpecVersion;
		public int DecisionTimeoutMs { get; set; } = AgentModeLimits.DefaultBenchmarkDecisionTimeoutMs;
		public int TickHorizon { get; set; }
		public int DecisionHorizon { get; set; }
		public int ControlRegionCount { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string ControlRegionHash { get; set; }
	}

	public sealed class AgentBenchmarkControlRegionDefinition
	{
		public string Id { get; set; }
		public List<AgentCellObservation> Cells { get; set; } = [];
	}

	public sealed class AgentAdjudicationTelemetry
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public string SpecVersion { get; set; } = AgentModeLimits.BenchmarkSpecVersion;
		public int SampleCount { get; set; }
		public int FirstFrozenWorldTick { get; set; } = -1;
		public int LastFrozenWorldTick { get; set; } = -1;
		public int DurationTicks { get; set; }
		public int ControlRegionCount { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string ControlRegionHash { get; set; }
		public List<AgentAdjudicationSeatTelemetry> Seats { get; set; } = [];
		public List<AgentAdjudicationFrozenSampleTelemetry> FrozenSamples { get; set; } = [];
	}

	public sealed class AgentAdjudicationSeatTelemetry
	{
		public int Ordinal { get; set; }
		public string AgentId { get; set; }
		public AgentAdjudicationComponentValues Components { get; set; }
		public long OwnStructureLossValue { get; set; }
		public long OwnCombatUnitLossValue { get; set; }
		public long IncomePerMinute { get; set; }
		public long RefineryCapacity { get; set; }
		public long ProducerCapacity { get; set; }
		public long LiquidResources { get; set; }
		public double AverageIncomePerMinute { get; set; }
		public double AverageRefineryCapacity { get; set; }
		public double AverageProducerCapacity { get; set; }
		public double AverageLiquidResources { get; set; }
		public int OccupiedRegionCount { get; set; }
	}

	public sealed class AgentAdjudicationComponentValues
	{
		public double LiveHpAdjustedPower { get; set; }
		public double StructuresByValue { get; set; }
		public double Economy { get; set; }
		public double UnitReplacementValue { get; set; }
		public double Tech { get; set; }
		public double RegionControl { get; set; }
	}

	public sealed class AgentAdjudicationFrozenSampleTelemetry
	{
		public long BarrierId { get; set; }
		public int WorldTick { get; set; }
		public List<AgentAdjudicationSeatTelemetry> Seats { get; set; } = [];
	}

	public sealed class AgentLockstepBarrierSnapshot
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public string SpecVersion { get; set; } = AgentModeLimits.BenchmarkSpecVersion;
		public long BarrierId { get; set; }
		public bool Prematch { get; set; }
		public string Phase { get; set; }
		public int TriggerWorldTick { get; set; }
		public int TriggerNetFrame { get; set; }
		public int FrozenWorldTick { get; set; } = -1;
		public int FrozenNetFrame { get; set; } = -1;
		public int FrozenSyncHash { get; set; }
		public int AppliedWorldTick { get; set; } = -1;
		public int AppliedNetFrame { get; set; } = -1;
		public int ClosedWorldTick { get; set; } = -1;
		public int ClosedNetFrame { get; set; } = -1;
		public int DecisionTimeoutMs { get; set; }
		public int OpenedLiveBarriers { get; set; }
		public int CompletedLiveBarriers { get; set; }
		public int DecisionOpportunitiesPerSeat { get; set; }
		public int TickHorizon { get; set; }
		public int DecisionHorizon { get; set; }
		public string StopKind { get; set; }
		public bool PauseOwned { get; set; }
		public bool ResumeRequired { get; set; }
		public bool AuthoritativeWorldPaused { get; set; }
		public bool PredictedWorldPaused { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string StopReason { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string TimeoutReason { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string AbortReason { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string TerminalReason { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string CommitDigest { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentAdjudicationTelemetry Adjudication { get; set; }
		public List<AgentLockstepSeatSnapshot> Seats { get; set; } = [];
	}

	public sealed class AgentLockstepSeatSnapshot
	{
		public int Ordinal { get; set; }
		public string AgentId { get; set; }
		public long DecisionId { get; set; }
		public bool TriggerSource { get; set; }
		public string Trigger { get; set; }
		public long ObservationSequence { get; set; }
		public string SnapshotDigest { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public JsonElement? Observation { get; set; }
		public string Outcome { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string OutcomeReason { get; set; }
		public int DurationMs { get; set; }
	}

	public sealed class AgentLockstepCommitRequest
	{
		public int SchemaVersion { get; set; }
		public string SpecVersion { get; set; }
		public long BarrierId { get; set; }
		public List<AgentLockstepSeatCommit> Seats { get; set; } = [];
	}

	public sealed class AgentLockstepSeatCommit
	{
		public string AgentId { get; set; }
		public long DecisionId { get; set; }
		public string Status { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentActionBatch Batch { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string Reason { get; set; }
		public int DurationMs { get; set; }
	}

	public sealed class AgentLockstepCommitResult
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public string SpecVersion { get; set; } = AgentModeLimits.BenchmarkSpecVersion;
		public long BarrierId { get; set; }
		public string Phase { get; set; }
		public int AppliedWorldTick { get; set; } = -1;
		public int AppliedNetFrame { get; set; } = -1;
		public string CommitDigest { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentAdjudicationTelemetry Adjudication { get; set; }
		public List<AgentLockstepSeatResult> Seats { get; set; } = [];
	}

	public sealed class AgentLockstepSeatResult
	{
		public int Ordinal { get; set; }
		public string AgentId { get; set; }
		public long DecisionId { get; set; }
		public string Outcome { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string Reason { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentActionBatchResult ActionResult { get; set; }
	}

	public sealed class AgentLockstepAbortRequest
	{
		public int SchemaVersion { get; set; }
		public string SpecVersion { get; set; }
		public long BarrierId { get; set; }
		public string Reason { get; set; }
	}

	public sealed class AgentPlayerState
	{
		public string AgentId { get; set; }
		public string ControllerType { get; set; }
		public int ClientIndex { get; set; } = -1;
		public string PlayerName { get; set; }
		public string Faction { get; set; }
		public string WinState { get; set; }
		public double SpentUsd { get; set; }
		public double SpendCapUsd { get; set; }
		public int FallbackTurns { get; set; }
		public int DecisionOpportunities { get; set; }
		public string PlayerColor { get; set; }
		public string SeatIdentity { get; set; }

		// War compiler purity telemetry: host compiled counters (fire only after a model commit)
		// versus model commit agency. TimeToFirstCommitIntentTicks stays -1 until the model commits.
		public int HostCompiledStrikeCount { get; set; }
		public int HostCompiledReinforceCount { get; set; }

		// BQ F4 compiled fuzzy disengage: fires only under a live model war commit, so it is a compiled
		// counter (like strike/reinforce) that does not break pureGeneralValid.
		public int HostCompiledDisengageCount { get; set; }

		// BQ C1 reactive base defense (pure-safe body): new units force-rallied to auto-engage under
		// sustained structure fire, and structure-defense garrison pulls issued.
		public int HostEmergencyRallyOrders { get; set; }
		public int HostStructureDefenseOrders { get; set; }

		// R3 proactive in-weapon-range first-strikes issued by the reactive play preset (pure-safe body).
		// Counted so host combat stays auditable and is never hidden from the benchmark scorecard.
		public int HostProactiveEngageOrders { get; set; }
		public int ModelCommitIntentCount { get; set; }
		public int TimeToFirstCommitIntentTicks { get; set; } = -1;
		public int DribbleAttackMoveCount { get; set; }
	}

	public sealed class AgentObservation
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public string MatchId { get; set; }
		public string AgentId { get; set; }
		public long Sequence { get; set; }
		public int WorldTick { get; set; }
		public int NetFrame { get; set; }
		public int MapMinX { get; set; }
		public int MapMinY { get; set; }
		public int MapMaxX { get; set; }
		public int MapMaxY { get; set; }
		public string Visibility { get; set; }
		public string DecisionTrigger { get; set; }
		public bool Truncated { get; set; }
		public AgentPlayerObservation Player { get; set; }
		public List<AgentActorObservation> Actors { get; set; } = [];
		public List<AgentProductionQueueObservation> ProductionQueues { get; set; } = [];
		public AgentBaseObservation Base { get; set; } = new();
		public AgentScoutingObservation Scouting { get; set; } = new();
		public List<string> AdvisorHints { get; set; } = [];
		public List<AgentAlertObservation> Alerts { get; set; } = [];
		public List<AgentSituationObservation> Situations { get; set; } = [];
		public List<AgentKnownEnemyStructureObservation> KnownEnemyStructures { get; set; } = [];
		public AgentSpatialSummaryResult Spatial { get; set; } = new();
		public List<AgentGroupObservation> Groups { get; set; } = [];
		public AgentHostTruthObservation HostTruth { get; set; } = new();
	}

	public sealed class AgentPlanningObservation
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public string MatchId { get; set; }
		public string AgentId { get; set; }
		public long Sequence { get; set; } = 1;
		public int WorldTick { get; set; }
		public string Phase { get; set; } = "planning";
		public AgentPlanningMapObservation Map { get; set; } = new();
		public AgentPlanningSelfObservation Player { get; set; } = new();
		public AgentPlanningOpponentObservation Opponent { get; set; } = new();
	}

	public sealed class AgentPlanningMapObservation
	{
		public string Uid { get; set; }
		public string Title { get; set; }
		public int MinX { get; set; }
		public int MinY { get; set; }
		public int MaxX { get; set; }
		public int MaxY { get; set; }
		public List<AgentPlanningSpawnObservation> CandidateSpawnPoints { get; set; } = [];
	}

	public sealed class AgentPlanningSpawnObservation
	{
		public int SpawnPoint { get; set; }
		public AgentCellObservation Cell { get; set; }
	}

	public sealed class AgentPlanningSelfObservation
	{
		public string Faction { get; set; }
	}

	public sealed class AgentPlanningOpponentObservation
	{
		public string Faction { get; set; }
	}

	public sealed class AgentKnownEnemyStructureObservation
	{
		public string Type { get; set; }
		public AgentCellObservation Cell { get; set; }
		public int LastSeenTick { get; set; }
		public string Status { get; set; } = "last-known";
	}

	public sealed class AgentGroupObservation
	{
		public string Name { get; set; }
		public int LiveCount { get; set; }
		public List<uint> ActorIds { get; set; } = [];
	}

	public sealed class AgentDecisionDue
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public bool Due { get; set; }
		public string Trigger { get; set; }
		public int WorldTick { get; set; } = -1;
	}

	public sealed class AgentAlertObservation
	{
		public string Kind { get; set; }
		public string Severity { get; set; }
		public int FirstSeenTick { get; set; }
		public uint AffectedActorId { get; set; }
		public AgentCellObservation Cell { get; set; }
		public string VisibleAttackerSummary { get; set; }
		public string Detail { get; set; }
		public bool StillActive { get; set; }
		public bool BuildPlanAutoPaused { get; set; }
		public AgentThreatObservation Threat { get; set; }
	}

	public sealed class AgentThreatObservation
	{
		public int VisibleEnemyCount { get; set; }
		public int VisibleEnemyValue { get; set; }
		public int DefenderCount { get; set; }
		public int DefenderValue { get; set; }
		public int NearestEnemyDistanceCells { get; set; } = -1;
		public string Verdict { get; set; }
		public string Summary { get; set; }
	}

	public sealed class AgentEnemyAssessmentObservation
	{
		public int VisibleEnemyCount { get; set; }
		public int VisibleEnemyValue { get; set; }
		public int KnownEnemyStructureCount { get; set; }
		public string Verdict { get; set; }
	}

	public sealed class AgentSituationObservation
	{
		public string Id { get; set; }
		public string Key { get; set; }
		public string Severity { get; set; }
		public int SinceTick { get; set; }
		public int LastUpdatedTick { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentCellObservation Cell { get; set; }
		public AgentSituationEvidenceObservation Evidence { get; set; } = new();
		public List<string> FromAlerts { get; set; } = [];
	}

	public sealed class AgentSituationEvidenceObservation
	{
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string AttackerClass { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentSituationClassCountsObservation ClassCounts { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public bool DogRush { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public uint AssetId { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string AssetType { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public int HpPercent { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public bool CrushableAll { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public int CanDamageCount { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public bool UnderAttack { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public int VisibleEnemyCount { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public int VisibleEnemyValue { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public int DefenderCount { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public int DefenderValue { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string ThreatVerdict { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public List<uint> HarvesterIds { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string TargetType { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public bool VisibleOnly { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string SuperweaponType { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string Status { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string Funding { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public int Funds { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public int RepairCostEstimate { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public int SellRefundEstimate { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string PowerState { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public bool WaterAdjacent { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public int ExploredPercent { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public int ActiveSweepMissions { get; set; }
	}

	public sealed class AgentSituationClassCountsObservation
	{
		public int Infantry { get; set; }
		public int Dogs { get; set; }
		public int Armor { get; set; }
		public int Air { get; set; }
		public int Naval { get; set; }
		public int Buildings { get; set; }
	}

	public sealed class AgentHostTruthObservation
	{
		public Dictionary<string, int> BuildingCounts { get; set; } = [];
		public Dictionary<string, int> CompletedMilestones { get; set; } = [];
		public int RefineryCount { get; set; }
		public int KnownEnemyStructureCount { get; set; }
		public AgentEconomyObservation Economy { get; set; } = new();
		public AgentStandingPolicyObservation StandingPolicy { get; set; } = new();
		public AgentBuildPlanObservation BuildPlan { get; set; }
		public List<AgentMissionObservation> Missions { get; set; } = [];
		public List<AgentSupportPowerObservation> SupportPowers { get; set; } = [];
		public AgentFallbackObservation AdvisorFallback { get; set; } = new();
		public AgentStrategyObservation Strategy { get; set; }
		public AgentDoctrineObservation Doctrine { get; set; }
		public List<AgentCriticalEventObservation> RecentCriticalEvents { get; set; } = [];
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public List<AgentGuidanceOptionObservation> LegalNextSteps { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentEnemyAssessmentObservation EnemyAssessment { get; set; }

		// Control harness: phase-gated legal actions + war compiler status. Executor/guided-gated and
		// [JsonIgnore]-null so the raw benchmark track omits these fields entirely (raw stays null).
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string ControlPhase { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public List<string> LegalActionTypes { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentWarCommitObservation WarCommit { get; set; }

		// FIX-1 outcome-delta: fog-safe combat exchange + momentum flags since the last decision.
		// Executor/guided-gated and [JsonIgnore]-null so the raw benchmark track omits it entirely.
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentOutcomeDeltaObservation OutcomeDelta { get; set; }
	}

	public sealed class AgentWarCommitObservation
	{
		public string Intent { get; set; }
		public string Status { get; set; }
		public string Priority { get; set; }
		public string Squad { get; set; }
		public int MinForce { get; set; }
		public int MainLiveCount { get; set; }
		public bool Active { get; set; }

		/// <summary>Why compile last skipped (massing / waitingTarget / cooldown / queue fail).</summary>
		public string LastSkipReason { get; set; }
	}

	/// <summary>
	/// Fog-safe combat exchange since the previous model decision (FIX-1 outcome-delta).
	/// Host detects; model decides press / counter / hold.
	/// </summary>
	public sealed class AgentOutcomeDeltaObservation
	{
		public int EnemyCombatLost { get; set; }
		public int OwnCombatLost { get; set; }
		public bool LocalVictory { get; set; }
		public bool EnemyBaseExposed { get; set; }
		public bool CounterAttackWindow { get; set; }
		public bool PressAttack { get; set; }
		public string Summary { get; set; }
	}

	public sealed class AgentStrategyObservation
	{
		public bool Enabled { get; set; }
		public string StrategyId { get; set; }
		public int CardVersion { get; set; }
		public int CatalogVersion { get; set; }
		public int AdoptedTick { get; set; } = -1;
		public int LastSwitchTick { get; set; } = -1;
		public int SwitchCount { get; set; }
		public string ModelReason { get; set; }
	}

	public sealed class AgentDoctrineObservation
	{
		public bool Enabled { get; set; }
		public bool ExecutorEnabled { get; set; }
		public bool Bound { get; set; }
		public bool ExecutorSupported { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string ValidationError { get; set; }
		public string StrategyId { get; set; }
		public int CardVersion { get; set; }
		public int ProgramVersion { get; set; }
		public string Phase { get; set; }
		public int PhaseSinceTick { get; set; } = -1;
		public bool Paused { get; set; }
		public string PauseReason { get; set; }
		public bool PhaseHeld { get; set; }
		public bool ScoutFailed { get; set; }
		public AgentDoctrineProgressObservation Progress { get; set; }
		public List<string> NextAutoActions { get; set; } = [];
		public string NeedsDecision { get; set; }
		public List<string> SuggestedOptions { get; set; } = [];

		// Standing actions the executor issued on the model's behalf (source=doctrine). Lets the
		// model see what was automated and lets the scorecard separate host-driven from
		// model-driven play so the benchmark measures the model, not the harness.
		public List<AgentDoctrineActionRecord> RecentActions { get; set; } = [];
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public AgentDoctrinePendingDecisionObservation PendingDecision { get; set; }
	}

	public sealed class AgentDoctrineActionRecord
	{
		public string Kind { get; set; }
		public string Detail { get; set; }
		public int Tick { get; set; }
		public string Source { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public long DecisionId { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string MissionId { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public List<uint> ActorIds { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public string Reason { get; set; }
	}

	public sealed class AgentDoctrinePendingDecisionObservation
	{
		public long DecisionId { get; set; }
		public string Kind { get; set; }
		public int IssuedTick { get; set; }
		public int ExpiresTick { get; set; }
		public int MissCount { get; set; }
		public List<AgentGuidanceOptionObservation> Options { get; set; } = [];
	}

	public sealed class AgentGuidanceOptionObservation
	{
		public long DecisionId { get; set; }
		public string OptionId { get; set; }
		public string Label { get; set; }
		public string Kind { get; set; }
		public List<AgentAction> Actions { get; set; } = [];
	}

	public sealed class AgentDoctrineProgressObservation
	{
		public int TanksLive { get; set; }
		public int TanksNeed { get; set; }
		public int ExploredPercent { get; set; }
		public int ExploredNeed { get; set; }
		public int WavesFailed { get; set; }
	}

	public sealed class AgentSupportPowerObservation
	{
		public string OrderName { get; set; }
		public bool Ready { get; set; }
		public int RemainingSeconds { get; set; }
	}

	public sealed class AgentFallbackObservation
	{
		public bool Enabled { get; set; }
		public int FallbackTurns { get; set; }
		public int DecisionOpportunities { get; set; }
	}

	public sealed class AgentBuildPlanObservation
	{
		public bool Active { get; set; }
		public string PlanId { get; set; }
		public int Version { get; set; }
		public int StepIndex { get; set; }
		public int TotalSteps { get; set; }
		public AgentBuildPlanStep CurrentStep { get; set; }
		public string State { get; set; }
		public int ReserveCash { get; set; }
		public bool Paused { get; set; }
		public string PauseReason { get; set; }
		public int LastProgressTick { get; set; } = -1;
		public string BlockedOn { get; set; }
	}

	public sealed class AgentMissionObservation
	{
		public string MissionId { get; set; }
		public int MissionVersion { get; set; }
		public string Type { get; set; }
		public string State { get; set; }
		public bool Paused { get; set; }
		public string PauseReason { get; set; }
		public AgentCellObservation TargetCell { get; set; }
		public List<AgentMissionLegObservation> Legs { get; set; } = [];
		public int LossesPercent { get; set; }
		public int DetachedCount { get; set; }
		public int SinceTick { get; set; }
	}

	public sealed class AgentMissionLegObservation
	{
		public string Squad { get; set; }
		public bool Staged { get; set; }
		public int Alive { get; set; }
		public int Initial { get; set; }
	}

	public sealed class AgentStandingPolicyObservation
	{
		public bool AutoReturnFire { get; set; } = true;
		public bool HarvesterFlee { get; set; } = true;
		public bool RallyNewUnitsToDefense { get; set; }
		public bool DefendCriticalAssets { get; set; } = true;
		public bool AutoRepairBuildings { get; set; }
		public int RetreatBelowHpPercent { get; set; }

		// R3 proactive in-weapon-range engage: an idle own combat unit first-strikes a currently-visible
		// enemy already inside its weapon range (no move, no chase). Pure-safe reactive body, not a war
		// path. Off by default (benchmark track); the reactive play preset turns it on. Emitted only when
		// enabled so the raw benchmark observation bytes stay identical (default false → omitted).
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
		public bool ProactiveEngage { get; set; }
	}

	public sealed class AgentEconomyObservation
	{
		public int Cash { get; set; }
		public int Resources { get; set; }
		public int ResourceCapacity { get; set; }
		public int IncomePerMinute { get; set; }
		public int HarvesterCount { get; set; }
		public int PowerProvided { get; set; }
		public int PowerDrained { get; set; }
		public string PowerState { get; set; }
	}

	public sealed class AgentCriticalEventObservation
	{
		public string Kind { get; set; }
		public int Tick { get; set; }
		public uint ActorId { get; set; }
		public AgentCellObservation Cell { get; set; }
	}

	public sealed class AgentPlayerObservation
	{
		public int ClientIndex { get; set; }
		public string Name { get; set; }
		public string Faction { get; set; }
		public int SpawnPoint { get; set; }
		public int Team { get; set; }
		public List<int> AlliedClientIndexes { get; set; } = [];
		public string WinState { get; set; }
		public int Cash { get; set; }
		public int Resources { get; set; }
		public int ResourceCapacity { get; set; }
		public int PowerProvided { get; set; }
		public int PowerDrained { get; set; }
		public string PowerState { get; set; }
		public string Color { get; set; }
		public string SeatIdentity { get; set; }
	}

	public sealed class AgentActorObservation
	{
		public uint ActorId { get; set; }
		public string Type { get; set; }
		public string Relationship { get; set; }
		public int CellX { get; set; }
		public int CellY { get; set; }
		public int Health { get; set; }
		public int MaxHealth { get; set; }
		public bool Idle { get; set; }
		public List<string> Capabilities { get; set; } = [];
	}

	public sealed class AgentProductionQueueObservation
	{
		public uint ProducerId { get; set; }
		public string QueueType { get; set; }
		public List<string> BuildableItems { get; set; } = [];
		public List<AgentProductionItemObservation> Items { get; set; } = [];
	}

	public sealed class AgentProductionItemObservation
	{
		public string Item { get; set; }
		public int RemainingTime { get; set; }
		public int TotalTime { get; set; }
		public bool Paused { get; set; }
		public bool Done { get; set; }
		public int EtaSeconds { get; set; }
		public bool Placeable { get; set; }
	}

	public sealed class AgentBaseObservation
	{
		public List<AgentBaseYardObservation> Yards { get; set; } = [];
		public int BuildRadius { get; set; }
	}

	public sealed class AgentBaseYardObservation
	{
		public uint ActorId { get; set; }
		public int X { get; set; }
		public int Y { get; set; }
	}

	public sealed class AgentScoutingObservation
	{
		public int ExploredPercent { get; set; }
		public List<AgentCellObservation> Frontier { get; set; } = [];
	}

	public sealed class AgentCellObservation
	{
		public int X { get; set; }
		public int Y { get; set; }
	}

	public sealed class AgentActionBatch
	{
		public int SchemaVersion { get; set; }
		public long DecisionId { get; set; }
		public long ObservedSequence { get; set; }
		public int ObservedWorldTick { get; set; }
		public string Thoughts { get; set; }
		public string Memo { get; set; }
		public List<AgentAction> Actions { get; set; } = [];
	}

	public sealed class AgentAction
	{
		public string Type { get; set; }
		public string Name { get; set; }
		public string GroupName { get; set; }
		public List<uint> ActorIds { get; set; } = [];
		public uint TargetActorId { get; set; }
		public uint ProducerId { get; set; }
		public string Item { get; set; }
		public int Count { get; set; }
		public int CellX { get; set; }
		public int CellY { get; set; }
		public bool Queued { get; set; }
		public bool? AutoReturnFire { get; set; }
		public bool? HarvesterFlee { get; set; }
		public bool? RallyNewUnitsToDefense { get; set; }
		public bool? DefendCriticalAssets { get; set; }
		public bool? AutoRepairBuildings { get; set; }
		public int? RetreatBelowHpPercent { get; set; }

		// R3 optional standing-policy field. Not part of the raw base setPolicy schema (the reactive play
		// preset defaults it on; the model may still assert it explicitly). Absent leaves the current
		// value unchanged so a complete-policy replacement never silently disables the preset default.
		public bool? ProactiveEngage { get; set; }
		public string PlanId { get; set; }
		public int Version { get; set; }
		public int? ReserveCash { get; set; }
		public List<AgentBuildPlanStep> Steps { get; set; } = [];
		public string Command { get; set; }
		public string MissionId { get; set; }
		public string MissionType { get; set; }
		public int MissionVersion { get; set; }
		public string MissionCommand { get; set; }
		public List<AgentMissionLegInput> Legs { get; set; } = [];
		public string DestinationSquad { get; set; }
		public string Posture { get; set; }
		public string TargetPriority { get; set; }
		public int? ExploredPercentTarget { get; set; }
		public int? AbortLossPercent { get; set; }
		public int? Sorties { get; set; }
		public int? MaxChaseCells { get; set; }
		public string StrategyId { get; set; }
		public string Reason { get; set; }
		public string DoctrineCommand { get; set; }
		public long DecisionId { get; set; }
		public string OptionId { get; set; }

		// Control harness war intents (commitIntent / reinforceIntent). Guided/executor/arsenal
		// surface only — the raw base AgentActionSchema and StaticPrimer never emit these.
		public string Intent { get; set; }
		public string Priority { get; set; }
		public int? MinForce { get; set; }
		public int? MaxUnits { get; set; }
		public string To { get; set; }
	}

	public sealed class AgentMissionLegInput
	{
		public string Squad { get; set; }
		public int ViaX { get; set; }
		public int ViaY { get; set; }
	}

	public sealed class AgentBuildPlanStep
	{
		public string Item { get; set; }
		public int Count { get; set; }
	}

	public sealed class AgentBuildPlanEvent
	{
		public string Source { get; set; } = "buildPlan";
		public long Sequence { get; set; }
		public int WorldTick { get; set; }
		public string PlanId { get; set; }
		public int Version { get; set; }
		public int StepIndex { get; set; }
		public int TotalSteps { get; set; }
		public string Item { get; set; }
		public string State { get; set; }
		public string Reason { get; set; }
	}

	public sealed class AgentBuildPlanEventBatch
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public long LatestSequence { get; set; }
		public List<AgentBuildPlanEvent> Events { get; set; } = [];
	}

	public sealed class AgentMissionEvent
	{
		public string Source { get; set; } = "mission";
		public long Sequence { get; set; }
		public int WorldTick { get; set; }
		public string MissionId { get; set; }
		public int MissionVersion { get; set; }
		public string MissionType { get; set; }
		public string Kind { get; set; }
		public string State { get; set; }
		public string Reason { get; set; }
		public List<uint> ActorIds { get; set; } = [];
		public AgentCellObservation Cell { get; set; }
	}

	public sealed class AgentMissionEventBatch
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public long LatestSequence { get; set; }
		public List<AgentMissionEvent> Events { get; set; } = [];
	}

	public sealed class AgentReflexEvent
	{
		public string Source { get; set; } = "reflex";
		public long Sequence { get; set; }
		public int WorldTick { get; set; }
		public string Kind { get; set; }
		public List<uint> ActorIds { get; set; } = [];
		public uint TargetActorId { get; set; }
		public AgentCellObservation Cell { get; set; }
		public string Reason { get; set; }
	}

	public sealed class AgentReflexEventBatch
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public long LatestSequence { get; set; }
		public List<AgentReflexEvent> Events { get; set; } = [];
	}

	public sealed class AgentStrategyEvent
	{
		public long Sequence { get; set; }
		public int WorldTick { get; set; }
		public string Kind { get; set; }
		public string StrategyId { get; set; }
		public int CardVersion { get; set; }
		public string PreviousStrategyId { get; set; }
		public int CatalogVersion { get; set; }
		public string ModelReason { get; set; }
	}

	public sealed class AgentStrategyEventBatch
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public long LatestSequence { get; set; }
		public List<AgentStrategyEvent> Events { get; set; } = [];
	}

	public sealed class AgentActionBatchResult
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public long DecisionId { get; set; }
		public int Accepted { get; set; }
		public int Rejected { get; set; }
		public bool Fallback { get; set; }
		public string FallbackReason { get; set; }
		public int FallbackTurns { get; set; }
		public int DecisionOpportunities { get; set; }
		public List<AgentActionResult> Results { get; set; } = [];
	}

	public sealed class AgentFallbackRequest
	{
		public int SchemaVersion { get; set; }
		public long DecisionId { get; set; }
		public long ObservedSequence { get; set; }
		public int ObservedWorldTick { get; set; }
		public string Kind { get; set; }
		public string Reason { get; set; }
	}

	public sealed class AgentActionResult
	{
		public int Index { get; set; }
		public string Type { get; set; }
		public bool Accepted { get; set; }
		public string Reason { get; set; }
		[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
		public List<AgentGuidanceOptionObservation> NextLegalActions { get; set; }
	}

	public sealed class AgentDecisionFailureRequest
	{
		public int SchemaVersion { get; set; }
		public long RequestDecisionId { get; set; }
		public string Kind { get; set; }
		public string Reason { get; set; }
		public bool Terminal { get; set; } = true;
	}

	public sealed class AgentError
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public string Error { get; set; }
	}

	// This deliberately excludes credentials and raw request data. Entries are
	// embedded as inert orders in the replay stream for A1 reproducibility.
	public sealed class AgentReplayTelemetry
	{
		public int SchemaVersion { get; set; } = AgentModeLimits.SchemaVersion;
		public string MatchId { get; set; }
		public string Kind { get; set; }
		public string AgentId { get; set; }
		public long DecisionId { get; set; } = -1;
		public int WorldTick { get; set; } = -1;
		public string Model { get; set; }
		public string Role { get; set; }
		public string Prompt { get; set; }
		public string Thoughts { get; set; }
		public string Summary { get; set; }
		public int PromptTokens { get; set; }
		public int CompletionTokens { get; set; }
		public double CostUsd { get; set; }
		public bool OmniscientObservations { get; set; }
		public bool Fallback { get; set; }
		public string ResolvedProfile { get; set; }
		public bool StrategyArsenalEnabled { get; set; }
		public bool ActionGuidanceEnabled { get; set; }
		public bool DoctrineExecutorEnabled { get; set; }
		public bool DoctrineFallbackStrikeEnabled { get; set; }
		public bool AdvisorFallbackEnabled { get; set; }
		public bool StaffSeatEnabled { get; set; }
		public string SeatIdentity { get; set; }
		public string PlayerColor { get; set; }
	}
}
