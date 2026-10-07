// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { createHash } from 'node:crypto';
import { StrategyArsenal, strategyIds } from './strategy-catalog.js';

const ordinalCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export interface ContractStringEnum {
	field: string;
	values: string[];
}

export interface ContractVariant {
	variantId: string;
	type: string;
	fields: string[];
	stringEnums: ContractStringEnum[];
}

export interface ContractRule {
	path: string;
	rule: string;
}

export interface ContractPlanningSurface {
	maxActionsPerPlanning: number;
	batchInvariants: string[];
	variants: ContractVariant[];
}

export interface ContractArsenalSurface {
	enabledByConfig: boolean;
	maxActionsPerDecision: number;
	maxActionsPerPlanning: number;
	catalogVersion: number;
	catalogFileHash: string;
	manualFileHash: string;
	rulesGraphHash: string;
	rulesArtifactHash: string;
	rulesHash: string;
	strategyIds: string[];
	batchInvariants: string[];
	planningBatchInvariants: string[];
	variants: ContractVariant[];
}

export interface ContractArsenalPins {
	catalogVersion: number;
	catalogFileHash: string;
	manualFileHash: string;
	rulesGraphHash: string;
	rulesArtifactHash: string;
	rulesHash: string;
	strategyIds: string[];
}

export interface ContractManifest {
	contractVersion: number;
	era: string;
	benchmarkSpecVersion: string;
	schemaVersion: number;
	maxActionsPerDecision: number;
	maxSubjectIdsPerDecision: number;
	sidecarSchemaFingerprint: string;
	rulesKnowledgeHash: string;
	fieldRules: ContractRule[];
	batchInvariants: string[];
	configSurface: string[];
	observationFields: string[];
	observationRules: ContractRule[];
	missionEventFields: string[];
	strategyEventFields: string[];
	matchStateFields: string[];
	situationKinds: string[];
	planning: ContractPlanningSurface;
	arsenal: ContractArsenalSurface;
	variants: ContractVariant[];
}

export interface ProviderSurfaceManifest {
	era: string;
	variants: ContractVariant[];
}

const FieldRules: ContractRule[] = [
	{ path: 'action.actorIds', rule: 'array<uint>; minItems=1; maxItems=256; every id > 0' },
	{ path: 'action.commitIntent', rule: 'guided/executor surface only; intent=strike|hold|defendBase; priority=any|economy|production|power|defenses default=production; minForce 1-24 default 6; optional groupName' },
	{ path: 'action.reinforceIntent', rule: 'guided/executor surface only; to=activeStrike|base default=activeStrike; maxUnits 1-24 default 8' },
	{ path: 'action.cellX', rule: 'int32; must be inside the running map when used as a target' },
	{ path: 'action.cellY', rule: 'int32; must be inside the running map when used as a target' },
	{ path: 'action.count', rule: 'integer; min=1; max=5' },
	{ path: 'action.groupName', rule: 'trimmed string; minLength=1; maxLength=24; no control characters' },
	{ path: 'action.item', rule: 'string; minLength=1; maxLength=128' },
	{ path: 'action.decisionId', rule: 'acceptDoctrineDecision only; positive current host decision id' },
	{ path: 'action.optionId', rule: 'acceptDoctrineDecision only; exact host-authored option token; maxLength=64' },
	{ path: 'action.missionId', rule: 'string; pattern=^[A-Za-z0-9_-]{1,32}$' },
	{ path: 'action.missionVersion', rule: 'int32; min=1' },
	{ path: 'action.name', rule: 'trimmed string; minLength=1; maxLength=24; no control characters' },
	{ path: 'action.planId', rule: 'string; pattern=^[A-Za-z0-9_-]{1,32}$' },
	{ path: 'action.producerId', rule: 'uint; value > 0' },
	{ path: 'action.reason', rule: 'adoptStrategy only; trimmed string; minLength=1; maxLength=240' },
	{ path: 'action.strategyId', rule: 'adoptStrategy only; generated catalog enum' },
	{ path: 'action.targetActorId', rule: 'uint; value > 0' },
	{ path: 'action.version', rule: 'int32; min=1' },
	{ path: 'batch.actions', rule: 'array<strict AgentAction variant>; maxItems=12' },
	{ path: 'batch.decisionId', rule: 'integer; min=0' },
	{ path: 'batch.memo', rule: 'trimmed string; maxLength=600; default empty' },
	{ path: 'batch.observedSequence', rule: 'integer; min=1; cannot be ahead of current observation sequence' },
	{ path: 'batch.observedWorldTick', rule: 'int32; min=0; cannot be ahead of current world tick' },
	{ path: 'batch.schemaVersion', rule: 'literal integer 1' },
	{ path: 'batch.thoughts', rule: 'trimmed string; minLength=1; maxLength=1000' },
	{ path: 'queueBuildPlan.reserveCash', rule: 'integer; min=0; max=1000000; default=0' },
	{ path: 'queueBuildPlan.steps', rule: 'array<{item,count}>; minItems=1; maxItems=8' },
	{ path: 'queueBuildPlan.steps[].count', rule: 'integer; min=1; max=5' },
	{ path: 'queueBuildPlan.steps[].item', rule: 'string; minLength=1; maxLength=128' },
	{ path: 'queueMission.abortLossPercent', rule: 'integer; min=10; max=100; sweep=50; strike=40; pincer=40; airStrike=50; pursue=30' },
	{ path: 'queueMission.airStrike.sorties', rule: 'integer; min=1; max=5; default=3' },
	{ path: 'queueMission.pincer.legs', rule: 'array<{squad,viaX,viaY}>; minItems=2; maxItems=3; squads distinct' },
	{ path: 'queueMission.pursue.maxChaseCells', rule: 'integer; min=5; max=60; default=25' },
	{ path: 'queueMission.reinforce.destination', rule: 'exactly one of destinationSquad or cellX+cellY' },
	{ path: 'queueMission.strike.legs', rule: 'array<{squad,viaX,viaY}>; length=1' },
	{ path: 'queueMission.strike.legs[].squad', rule: 'trimmed string; minLength=1; maxLength=24; no control characters' },
	{ path: 'queueMission.strike.legs[].viaX', rule: 'integer; must be inside the running map' },
	{ path: 'queueMission.strike.legs[].viaY', rule: 'integer; must be inside the running map' },
	{ path: 'queueMission.sweep.exploredPercentTarget', rule: 'integer; min=50; max=100; default=85' },
	{ path: 'setPolicy.autoRepairBuildings', rule: 'boolean; complete-policy field; default=false' },
	{ path: 'setPolicy.retreatBelowHpPercent', rule: 'integer; min=0; max=75' }
].sort((a, b) => ordinalCompare(a.path, b.path));

const BatchInvariants = [
	'action objects reject unknown fields and must match exactly one variant',
	'at most one build-plan action per batch',
	'at most one mission action per batch',
	'build-plan actions cannot share a batch with direct production actions',
	'sum(explicit actor ids + resolved group and mission-leg rosters + producer and target references) <= 256'
].sort();

const ConfigSurface = [
	'advisorFallbackEnabled:boolean default=false',
	'actionGuidanceEnabled:boolean default=false',
	'agent1SpendCapUsd:number range=0.01..matchSpendCapUsd default=1',
	'agent2SpendCapUsd:number range=0.01..matchSpendCapUsd default=1',
	'benchmarkControlRegions:array<{id,cells[{x,y}]}> maxRegions=64 maxCells=4096 default=[]',
	'benchmarkDecisionHorizon:integer min=0 default=0',
	'benchmarkDecisionTimeoutMs:integer range=10000..120000 default=120000',
	'benchmarkLockstepEnabled:boolean default=false',
	'benchmarkSpecVersion:literal benchmark-lockstep-v1',
	'benchmarkTickHorizon:integer min=0 default=0',
	'buildPlanInternalFailureWatchdogTicks:integer clamp=25..2500 default=250',
	'buildPlanStallWatchdogTicks:integer clamp=100..10000 default=750',
	'decisionIntervalTicks:integer clamp=25..2500 default=500',
	'faction1:string playable-faction default=russia',
	'faction2:string playable-faction default=russia',
	'fakeAgents:boolean default=false',
	'matchSpendCapUsd:number range=0.01..1000 default=2',
	'doctrineExecutorEnabled:boolean default=false',
	'doctrineFallbackStrikeEnabled:boolean default=false',
	'omniscientObservations:boolean default=false',
	'opponentBot:null-or-safe-id maxLength=64',
	'planningTimeoutMs:integer clamp=10000..120000 default=30000',
	'playCadenceEnabled:boolean default=false',
	'prematchPlanning:boolean default=false',
	'strategyArsenalEnabled:boolean default=false',
	'staffSeatEnabled:boolean default=false',
	'schemaVersion:literal integer 1'
].sort();

// Planning-surface invariants: byte-identical strings must be emitted by the
// host's GetContractManifest — this section is fingerprinted with the rest.
const PlanningBatchInvariants = [
	'at most one queueBuildPlan',
	'at most one setPolicy',
	'identity literals decisionId=0 observedSequence=1 observedWorldTick=0'
].sort();

const ObservationFields = [
	'actors', 'advisorHints', 'agentId', 'alerts', 'base', 'decisionTrigger',
	'groups', 'hostTruth', 'knownEnemyStructures', 'mapMaxX', 'mapMaxY', 'mapMinX',
	'mapMinY', 'matchId', 'netFrame', 'player', 'productionQueues', 'schemaVersion',
	'scouting', 'sequence', 'situations', 'spatial', 'truncated', 'visibility', 'worldTick'
].sort();

const ObservationRules: ContractRule[] = [
	{ path: 'observation', rule: 'UTF-8 JSON; maxBytes=262144; camelCase' },
	{ path: 'observation.actors', rule: 'relationship caps self=64 enemy=48 ally=16; fields=actorId,type,relationship,cellX,cellY,health,maxHealth,idle,capabilities' },
	{ path: 'observation.alerts', rule: 'maxItems=6; fields=kind,severity,firstSeenTick,affectedActorId,cell,visibleAttackerSummary,detail,stillActive,buildPlanAutoPaused,threat; enemy facts visible-only' },
	{ path: 'observation.groups', rule: 'maxItems=16; fields=name,liveCount,actorIds; dead or unowned actors culled' },
	{ path: 'observation.hostTruth', rule: 'fields=buildingCounts,completedMilestones,refineryCount,knownEnemyStructureCount,economy,standingPolicy,buildPlan,missions,advisorFallback,supportPowers,strategy,doctrine,recentCriticalEvents,legalNextSteps,enemyAssessment,controlPhase,legalActionTypes,warCommit' },
	{ path: 'observation.hostTruth.controlPhase', rule: 'opening|economy|army|war|emergency; guided/executor surface only (omitted on the raw track)' },
	{ path: 'observation.hostTruth.legalActionTypes', rule: 'array of action type strings legal in the current controlPhase; guided/executor surface only (omitted on the raw track)' },
	{ path: 'observation.hostTruth.warCommit', rule: 'fields=intent,status,priority,squad,minForce,mainLiveCount,active; present once a war commit is active' },
	{ path: 'observation.hostTruth.doctrine', rule: 'fields=enabled,executorEnabled,bound,strategyId,cardVersion,programVersion,phase,phaseSinceTick,paused,pauseReason,progress,nextAutoActions,needsDecision,suggestedOptions,pendingDecision; progress fields=tanksLive,tanksNeed,exploredPercent,exploredNeed,wavesFailed; executorEnabled=false means observation-only (PR1)' },
	{ path: 'observation.hostTruth.doctrine.pendingDecision.kind', rule: 'rejectionRepair|reinforceAttack|regroupNeeded|enemyContact|scoutFailed|armyIdle|phaseReady|baseDefenseNeeded' },
	{ path: 'observation.hostTruth.missions', rule: 'maxItems=3; fields=missionId,missionVersion,type,state,paused,pauseReason,targetCell,legs,lossesPercent,detachedCount,sinceTick' },
	{ path: 'observation.hostTruth.missions[].legs', rule: 'maxItems=3; fields=squad,staged,alive,initial' },
	{ path: 'observation.hostTruth.strategy', rule: 'fields=enabled,strategyId,cardVersion,catalogVersion,adoptedTick,lastSwitchTick,switchCount,modelReason; requirements are advisory' },
	{ path: 'observation.hostTruth.supportPowers', rule: 'fields=orderName,ready,remainingSeconds; owned player support powers only' },
	{ path: 'observation.knownEnemyStructures', rule: 'remembered structures only; fields=type,cell,lastSeenTick,status; status=last-known' },
	{ path: 'observation.player', rule: 'fields=clientIndex,name,faction,spawnPoint,team,alliedClientIndexes,winState,cash,resources,resourceCapacity,powerProvided,powerDrained,powerState,color,seatIdentity' },
	{ path: 'observation.productionQueues', rule: 'fields=producerId,queueType,buildableItems,items; items fields=item,remainingTime,totalTime,paused,done,etaSeconds,placeable' },
	{ path: 'observation.situations', rule: 'maxItems=5; factual persistent states; fields=id,key,severity,sinceTick,lastUpdatedTick,cell,evidence,fromAlerts; enemy facts visible or last-known only' },
	{ path: 'observation.spatial', rule: 'gridWidth=16; gridHeight=16; grid rows=16x16; fog-safe legend and contact lines' },
	{ path: 'observation.visibility', rule: 'player-fog default; omniscient only by explicit config' }
].sort((a, b) => ordinalCompare(a.path, b.path));

const MissionEventFields = [
	'actorIds', 'cell', 'kind', 'missionId', 'missionType', 'missionVersion', 'reason',
	'sequence', 'source', 'state', 'worldTick'
].sort();

const StrategyEventFields = [
	'cardVersion', 'catalogVersion', 'kind', 'modelReason', 'previousStrategyId', 'sequence',
	'strategyId', 'worldTick'
].sort();

const MatchStateFields = [
	'advisorFallbackEnabled', 'agents', 'era', 'fakeAgentStatus', 'matchId', 'matchSpendCapUsd',
	'netFrame', 'opponent', 'opponentBot', 'outOfSync', 'schemaVersion', 'state', 'terminalReason',
	'actionGuidanceEnabled', 'doctrineExecutorEnabled', 'doctrineFallbackStrikeEnabled',
	'adjudication', 'benchmarkLockstep', 'lockstepBarrier', 'buildPlanInternalFailureWatchdogTicks', 'buildPlanStallWatchdogTicks',
	'resolvedProfile', 'staffSeatEnabled',
	'strategyArsenalEnabled', 'totalSpentUsd', 'worldTick'
].sort();

function stringEnum(schema: unknown): string[] {
	if (schema == null || typeof schema !== 'object') {
		return [];
	}

	const record = schema as Record<string, unknown>;
	if (typeof record.const === 'string') {
		return [record.const];
	}

	return Array.isArray(record.enum) && record.enum.every(value => typeof value === 'string')
		? [...record.enum].sort() as string[]
		: [];
}

function variantId(type: string, properties: Record<string, unknown>): string {
	if (type === 'queueMission') {
		const missionType = stringEnum(properties.missionType)[0];
		if (missionType != null) {
			if (missionType === 'reinforce') {
				return `${type}.${missionType}.${properties.destinationSquad == null ? 'cell' : 'destinationSquad'}`;
			}

			return `${type}.${missionType}`;
		}
	}

	if ((type === 'move' || type === 'attackMove' || type === 'stop' || type === 'guard') && properties.groupName != null) {
		return `${type}.groupName`;
	}

	if ((type === 'move' || type === 'attackMove' || type === 'stop' || type === 'guard') && properties.actorIds != null) {
		return `${type}.actorIds`;
	}

	return type;
}

function normalizeVariants(actionSchema: unknown): ContractVariant[] {
	if (actionSchema == null || typeof actionSchema !== 'object') {
		throw new Error('action schema is not an object');
	}

	const record = actionSchema as Record<string, unknown>;
	const variants = (Array.isArray(record.anyOf) ? record.anyOf : record.oneOf) as unknown[] | undefined;
	if (!Array.isArray(variants)) {
		throw new Error('action schema does not contain a union');
	}

	return variants.map(item => {
		if (item == null || typeof item !== 'object') {
			throw new Error('action variant is not an object');
		}

		const properties = (item as Record<string, unknown>).properties;
		if (properties == null || typeof properties !== 'object' || Array.isArray(properties)) {
			throw new Error('action variant does not contain properties');
		}

		const propertyMap = properties as Record<string, unknown>;
		const type = stringEnum(propertyMap.type)[0];
		if (type == null) {
			throw new Error('action variant does not pin a string type');
		}

		const stringEnums = Object.entries(propertyMap)
			.map(([field, schema]) => ({ field, values: stringEnum(schema) }))
			.filter(entry => entry.values.length !== 0)
			.sort((a, b) => ordinalCompare(a.field, b.field));
		return {
			variantId: variantId(type, propertyMap),
			type,
			fields: Object.keys(propertyMap).sort(),
			stringEnums
		};
	}).sort((a, b) => ordinalCompare(a.variantId, b.variantId));
}

function canonicalizeSchema(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalizeSchema);
	}

	if (value == null || typeof value !== 'object') {
		return value;
	}

	const record = value as Record<string, unknown>;
	return Object.fromEntries(Object.keys(record).sort(ordinalCompare)
		.filter(key => record[key] !== undefined)
		.map(key => [key, canonicalizeSchema(record[key])]));
}

export function fingerprintSemanticSchema(schema: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonicalizeSchema(schema)), 'utf8').digest('hex');
}

export function buildProviderSurfaceManifest(actionSchema: unknown, era: string): ProviderSurfaceManifest {
	return { era, variants: normalizeVariants(actionSchema) };
}

export function buildContractManifest(
	actionSchema: unknown, batchSchema: unknown, era: string, planningActionSchema: unknown,
	rulesKnowledgeHash: string, arsenalActionSchema?: unknown, arsenalPlanningActionSchema?: unknown,
	arsenalPins?: ContractArsenalPins): ContractManifest {
	const normalized = normalizeVariants(actionSchema);
	const rawIds = new Set(normalized.map(variant => variant.variantId));
	const arsenalVariants = arsenalActionSchema == null ? [] : normalizeVariants(arsenalActionSchema)
		.filter(variant => !rawIds.has(variant.variantId));
	const rawPlanningIds = new Set(normalizeVariants(planningActionSchema).map(variant => variant.variantId));
	const arsenalPlanningVariants = arsenalPlanningActionSchema == null ? [] : normalizeVariants(arsenalPlanningActionSchema)
		.filter(variant => !rawPlanningIds.has(variant.variantId));
	const adoptedVariants = [...arsenalVariants, ...arsenalPlanningVariants]
		.filter((variant, index, variants) => variants.findIndex(candidate => candidate.variantId === variant.variantId) === index)
		.sort((a, b) => ordinalCompare(a.variantId, b.variantId));
	// The default pins come from the loaded strategy corpus so the sidecar
	// manifest reproduces the host's generated-catalog constants without
	// callers threading them through. Not-ready corpus yields empty pins,
	// which the fingerprint gate then fails loudly — never silently.
	const pins = arsenalPins ?? {
		catalogVersion: StrategyArsenal.catalogVersion,
		catalogFileHash: StrategyArsenal.catalogFileHash,
		manualFileHash: StrategyArsenal.manualFileHash,
		rulesGraphHash: StrategyArsenal.rulesGraphHash,
		rulesArtifactHash: StrategyArsenal.rulesArtifactHash,
		rulesHash: StrategyArsenal.rulesHash,
		strategyIds: strategyIds(StrategyArsenal)
	};

	// The adopt variant is synthesized from the pinned ids when the arsenal
	// schemas are not passed explicitly — matching normalizeVariants' shape
	// for the Zod AdoptStrategyAction exactly.
	const defaultAdoptVariants: ContractVariant[] = pins.strategyIds.length === 0 ? [] : [{
		variantId: 'adoptStrategy',
		type: 'adoptStrategy',
		fields: ['reason', 'strategyId', 'type'],
		stringEnums: [
			{ field: 'strategyId', values: [...pins.strategyIds].sort(ordinalCompare) },
			{ field: 'type', values: ['adoptStrategy'] }
		]
	}];

	return {
		contractVersion: 1,
		era,
		benchmarkSpecVersion: 'benchmark-lockstep-v1',
		schemaVersion: 1,
		maxActionsPerDecision: 12,
		maxSubjectIdsPerDecision: 256,
		sidecarSchemaFingerprint: fingerprintSemanticSchema(batchSchema),
		rulesKnowledgeHash,
		fieldRules: FieldRules,
		batchInvariants: BatchInvariants,
		configSurface: ConfigSurface,
		observationFields: ObservationFields,
		observationRules: ObservationRules,
		missionEventFields: MissionEventFields,
		strategyEventFields: StrategyEventFields,
		matchStateFields: MatchStateFields,
		situationKinds: [
			'E1.funding', 'E1.power', 'O1.retreat', 'O2', 'S1.water', 'S2.recon', 'T1.air', 'T1.base',
			'T1.naval', 'T1.sw', 'T2.reinforcement', 'T3.harv', 'T4'
		],
		planning: {
			maxActionsPerPlanning: 2,
			batchInvariants: PlanningBatchInvariants,
			variants: normalizeVariants(planningActionSchema)
		},
		arsenal: {
			enabledByConfig: true,
			maxActionsPerDecision: 12,
			maxActionsPerPlanning: 3,
			catalogVersion: pins.catalogVersion,
			catalogFileHash: pins.catalogFileHash,
			manualFileHash: pins.manualFileHash,
			rulesGraphHash: pins.rulesGraphHash,
			rulesArtifactHash: pins.rulesArtifactHash,
			rulesHash: pins.rulesHash,
			strategyIds: [...pins.strategyIds].sort(ordinalCompare),
			batchInvariants: ['at most one adoptStrategy action per batch'],
			planningBatchInvariants: [
				'at most one adoptStrategy',
				'at most one queueBuildPlan',
				'at most one setPolicy',
				'identity literals decisionId=0 observedSequence=1 observedWorldTick=0'
			].sort(),
			variants: adoptedVariants.length > 0 ? adoptedVariants : defaultAdoptVariants
		},
		variants: normalized
	};
}

export function fingerprintContractManifest(manifest: ContractManifest): string {
	return createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex');
}
