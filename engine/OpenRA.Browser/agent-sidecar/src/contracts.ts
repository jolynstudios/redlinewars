// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { z } from 'zod';
import { StrategyArsenal, strategyIds } from './strategy-catalog.js';

const UIntId = z.number().int().positive().max(0xFFFFFFFF);
const Int32 = z.number().int().min(-0x80000000).max(0x7FFFFFFF);
const NonNegativeInt32 = Int32.nonnegative();
const PositiveInt32 = Int32.positive();
const ActorIds = z.array(UIntId).min(1).max(256);
const Cell = Int32;

const GroupName = z.string().trim().min(1).max(24).regex(/^[^\u0000-\u001F\u007F]+$/);
const MissionId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const MissionVersion = PositiveInt32;
const MissionLeg = z.object({ squad: GroupName, viaX: Cell, viaY: Cell }).strict();
const TargetPriority = z.enum(['any', 'economy', 'production', 'defenses']);
const AbortLossPercent = z.number().int().min(10).max(100);

// Shared variant objects: referenced by BOTH the live action union and the
// pre-match planning union so the two surfaces can never drift apart.
const QueueBuildPlanAction = z.object({
	type: z.literal('queueBuildPlan'),
	planId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
	version: PositiveInt32,
	// The host caps reserveCash at 1,000,000 (AgentBuildPlanController);
	// mirroring it here turns a doomed plan into schema feedback.
	reserveCash: z.number().int().min(0).max(1000000).default(0),
	steps: z.array(z.object({
		item: z.string().min(1).max(128),
		count: z.number().int().min(1).max(5)
	}).strict()).min(1).max(8)
}).strict();

const SetPolicyAction = z.object({
	type: z.literal('setPolicy'),
	autoReturnFire: z.boolean(),
	harvesterFlee: z.boolean(),
	rallyNewUnitsToDefense: z.boolean(),
	defendCriticalAssets: z.boolean(),
	autoRepairBuildings: z.boolean(),
	retreatBelowHpPercent: z.number().int().min(0).max(75)
}).strict();

// Plain union (not discriminatedUnion): move/attackMove/stop each have an
// actorIds variant AND a groupName variant. Strict objects make the shapes
// mutually exclusive — supplying both fields matches neither variant — which
// enforces the host's "exactly one addressing form" rule at the schema level.
export const AgentActionSchema = z.union([
	z.object({ type: z.literal('move'), actorIds: ActorIds, cellX: Cell, cellY: Cell, queued: z.boolean().default(false) }).strict(),
	z.object({ type: z.literal('move'), groupName: GroupName, cellX: Cell, cellY: Cell, queued: z.boolean().default(false) }).strict(),
	z.object({ type: z.literal('attackMove'), actorIds: ActorIds, cellX: Cell, cellY: Cell, queued: z.boolean().default(false) }).strict(),
	z.object({ type: z.literal('attackMove'), groupName: GroupName, cellX: Cell, cellY: Cell, queued: z.boolean().default(false) }).strict(),
	z.object({ type: z.literal('attack'), actorIds: ActorIds, targetActorId: UIntId, queued: z.boolean().default(false) }).strict(),
	z.object({ type: z.literal('deploy'), actorIds: ActorIds }).strict(),
	z.object({ type: z.literal('stop'), actorIds: ActorIds }).strict(),
	z.object({ type: z.literal('stop'), groupName: GroupName }).strict(),
	// Named squads: assignment REPLACES membership; the host culls dead or
	// unowned members and drops empty groups; at most 16 groups per agent.
	z.object({ type: z.literal('assignGroup'), name: GroupName, actorIds: ActorIds }).strict(),
	// Military commitments. The host resolves each squad to an immutable
	// roster snapshot, then emits only ordinary validated orders while the
	// world keeps advancing. Defaults mirror the host exactly.
	z.object({
		type: z.literal('queueMission'),
		missionId: MissionId,
		missionType: z.literal('sweep'),
		missionVersion: MissionVersion,
		groupName: GroupName,
		exploredPercentTarget: z.number().int().min(50).max(100).default(85),
		abortLossPercent: AbortLossPercent.default(50)
	}).strict(),
	z.object({
		type: z.literal('queueMission'),
		missionId: MissionId,
		missionType: z.literal('strike'),
		missionVersion: MissionVersion,
		cellX: Cell,
		cellY: Cell,
		legs: z.array(MissionLeg).length(1),
		posture: z.enum(['assault', 'raid']).default('assault'),
		targetPriority: TargetPriority.default('any'),
		abortLossPercent: AbortLossPercent.default(40)
	}).strict(),
	z.object({
		type: z.literal('queueMission'),
		missionId: MissionId,
		missionType: z.literal('pincer'),
		missionVersion: MissionVersion,
		cellX: Cell,
		cellY: Cell,
		legs: z.array(MissionLeg).min(2).max(3),
		posture: z.enum(['assault', 'raid']).default('assault'),
		targetPriority: TargetPriority.default('any'),
		abortLossPercent: AbortLossPercent.default(40)
	}).strict(),
	z.object({
		type: z.literal('queueMission'),
		missionId: MissionId,
		missionType: z.literal('airStrike'),
		missionVersion: MissionVersion,
		groupName: GroupName,
		cellX: Cell,
		cellY: Cell,
		sorties: z.number().int().min(1).max(5).default(3),
		targetPriority: TargetPriority.default('any'),
		abortLossPercent: AbortLossPercent.default(50)
	}).strict(),
	z.object({
		type: z.literal('queueMission'),
		missionId: MissionId,
		missionType: z.literal('pursue'),
		missionVersion: MissionVersion,
		groupName: GroupName,
		cellX: Cell,
		cellY: Cell,
		maxChaseCells: z.number().int().min(5).max(60).default(25),
		abortLossPercent: AbortLossPercent.default(30)
	}).strict(),
	z.object({
		type: z.literal('queueMission'),
		missionId: MissionId,
		missionType: z.literal('reinforce'),
		missionVersion: MissionVersion,
		groupName: GroupName,
		destinationSquad: GroupName
	}).strict(),
	z.object({
		type: z.literal('queueMission'),
		missionId: MissionId,
		missionType: z.literal('reinforce'),
		missionVersion: MissionVersion,
		groupName: GroupName,
		cellX: Cell,
		cellY: Cell
	}).strict(),
	z.object({
		type: z.literal('controlMission'),
		missionId: MissionId,
		missionVersion: MissionVersion,
		missionCommand: z.enum(['pause', 'resume', 'cancel'])
	}).strict(),
	// Build-plan commitment: the host executes the whole ordered plan as a
	// state machine (one outstanding step, auto placement, result-driven
	// advancement; critical alerts auto-pause). A new planId or a higher
	// version atomically replaces the active plan; same or lower rejects.
	// Buildings require count 1; units may use 1-5.
	QueueBuildPlanAction,
	z.object({
		type: z.literal('controlBuildPlan'),
		planId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
		version: PositiveInt32,
		command: z.enum(['pause', 'resume', 'cancel'])
	}).strict(),
	z.object({
		type: z.literal('startProduction'),
		producerId: UIntId,
		item: z.string().min(1).max(128),
		count: z.number().int().min(1).max(5),
		queued: z.boolean().default(false)
	}).strict(),
	z.object({
		type: z.literal('placeBuilding'),
		producerId: UIntId,
		item: z.string().min(1).max(128),
		cellX: Cell,
		cellY: Cell
	}).strict(),
	z.object({
		type: z.literal('placeBuildingAuto'),
		producerId: UIntId,
		item: z.string().min(1).max(128)
	}).strict(),
	z.object({
		type: z.literal('capture'),
		actorIds: ActorIds,
		targetActorId: UIntId,
		queued: z.boolean().default(false)
	}).strict(),
	z.object({
		type: z.literal('cancelProduction'),
		producerId: UIntId,
		item: z.string().min(1).max(128),
		count: z.number().int().min(1).max(5)
	}).strict(),
	z.object({ type: z.literal('setRallyPoint'), producerId: UIntId, cellX: Cell, cellY: Cell }).strict(),
	z.object({ type: z.literal('guard'), actorIds: ActorIds, targetActorId: UIntId }).strict(),
	z.object({ type: z.literal('guard'), groupName: GroupName, targetActorId: UIntId }).strict(),
	z.object({ type: z.literal('spyPlane'), cellX: Cell, cellY: Cell }).strict(),
	// Standing orders for the deterministic reflex layer. Full-policy
	// statement: every field is explicit so there is no partial-merge
	// ambiguity (defaults: return fire on, harvester flee on, rally off,
	// defend critical on, auto repair off, retreat 0 = never).
	SetPolicyAction,
	z.object({ type: z.literal('repair'), actorIds: ActorIds }).strict(),
	z.object({ type: z.literal('sell'), actorIds: ActorIds }).strict(),
	z.object({ type: z.literal('surrender') }).strict()
]);

export const AgentActionBatchSchema = z.object({
	schemaVersion: z.literal(1),
	decisionId: z.number().int().nonnegative(),
	observedSequence: z.number().int().positive(),
	observedWorldTick: NonNegativeInt32,
	thoughts: z.string().trim().min(1).max(1000),
	// The commander journal: rolling intent/beliefs the model carries between
	// decisions. Defaulted so models that omit it never fail validation; the
	// provider schema still lists it as required (strict-mode completion rule
	// in providerSafeSchema).
	memo: z.string().trim().max(600).default(''),
	// Ceiling forces conciseness structurally: giant-batch panic replies
	// (thirty cancels at once) exceed output budgets and die; twelve decisive
	// actions is more than any sound turn needs (counts batch production).
	actions: z.array(AgentActionSchema).max(12)
}).strict().superRefine((batch, context) => {
	const subjects = batch.actions.reduce((total, action) => {
		if ('actorIds' in action) {
			total += action.actorIds.length;
		}

		if ('producerId' in action) {
			total++;
		}

		if ('targetActorId' in action) {
			total++;
		}

		return total;
	}, 0);
	if (subjects > 256) {
		context.addIssue({ code: 'custom', message: 'subject id count exceeds 256' });
	}

	// Mirror the host's batch-level build-plan invariants (AgentModeHost
	// rejects the whole batch otherwise): at most one build-plan action, and
	// never mixed with direct production in the same batch.
	const planActions = batch.actions.filter(action =>
		action.type === 'queueBuildPlan' || action.type === 'controlBuildPlan').length;
	if (planActions > 1) {
		context.addIssue({ code: 'custom', message: 'an action batch may contain at most one build-plan action' });
	}

	if (planActions > 0 && batch.actions.some(action =>
		action.type === 'startProduction' || action.type === 'cancelProduction' ||
		action.type === 'placeBuilding' || action.type === 'placeBuildingAuto')) {
		context.addIssue({ code: 'custom', message: 'build-plan controls cannot share a batch with direct production actions' });
	}

	const missionActions = batch.actions.filter(action =>
		action.type === 'queueMission' || action.type === 'controlMission').length;
	if (missionActions > 1) {
		context.addIssue({ code: 'custom', message: 'an action batch may contain at most one mission action' });
	}

	batch.actions.forEach((action, index) => {
		if (action.type !== 'queueMission' || action.missionType !== 'pincer') {
			return;
		}

		const squads = action.legs.map(leg => leg.squad);
		if (new Set(squads).size !== squads.length) {
			context.addIssue({
				code: 'custom',
				path: ['actions', index, 'legs'],
				message: 'pincer legs must name distinct squads'
			});
		}
	});
});

export type AgentActionBatch = z.infer<typeof AgentActionBatchSchema>;

// Exact host-authored choice selection. Kept out of AgentActionSchema so raw
// and ordinary arsenal provider schemas remain byte-for-byte unchanged.
const AcceptDoctrineDecisionAction = z.object({
	type: z.literal('acceptDoctrineDecision'),
	decisionId: z.number().int().positive(),
	optionId: z.string().trim().min(1).max(64)
}).strict();

// Control harness war intents (WC-2): the model commits a standing intent and the
// host war compiler executes it (mass, launch a labelled strike, auto-reinforce).
// Kept OUT of AgentActionSchema and the ordinary ArsenalActionSchema — like
// acceptDoctrineDecision — so the raw benchmark track and the non-executor arsenal
// provider schemas stay byte-for-byte unchanged. These live only on the executor
// surfaces (GuidedActionSchema, GuidedArsenalActionSchema).
const CommitIntentAction = z.object({
	type: z.literal('commitIntent'),
	intent: z.enum(['strike', 'hold', 'defendBase']),
	priority: z.enum(['any', 'economy', 'production', 'power', 'defenses']).default('production'),
	minForce: z.number().int().min(1).max(24).default(6),
	// Optional named squad (defaults to the doctrine main squad on the host).
	groupName: GroupName.optional()
}).strict();

const ReinforceIntentAction = z.object({
	type: z.literal('reinforceIntent'),
	to: z.enum(['activeStrike', 'base']).default('activeStrike'),
	maxUnits: z.number().int().min(1).max(24).default(8)
}).strict();

const guidedBatch = <T extends z.ZodTypeAny>(actionSchema: T) => z.object({
	schemaVersion: z.literal(1),
	decisionId: z.number().int().nonnegative(),
	observedSequence: z.number().int().positive(),
	observedWorldTick: NonNegativeInt32,
	thoughts: z.string().trim().min(1).max(1000),
	memo: z.string().trim().max(600).default(''),
	actions: z.array(actionSchema).max(12)
}).strict().superRefine((batch, context) => {
	const selections = batch.actions.filter(action =>
		(action as { type?: string }).type === 'acceptDoctrineDecision').length;
	if (selections > 1 || (selections === 1 && batch.actions.length !== 1)) {
		context.addIssue({
			code: 'custom',
			message: 'acceptDoctrineDecision must be the only action in its batch'
		});
	}
});

export const GuidedActionSchema = z.union([
	...AgentActionSchema.options, AcceptDoctrineDecisionAction, CommitIntentAction, ReinforceIntentAction
]);
export const GuidedActionBatchSchema = guidedBatch(GuidedActionSchema);
export const CommitActionBatchSchema = guidedBatch(AcceptDoctrineDecisionAction);

// Pre-match planning: the world has not been created, so the only legal
// commitments are the opening build plan and the standing policy — no actor,
// group, or mission can exist to be addressed. Reusing the exact live variant
// objects keeps the two surfaces structurally identical forever.
export const PlanningActionSchema = z.union([QueueBuildPlanAction, SetPolicyAction]);

// Identity fields are LITERALS: decision 0 observing sequence 1 at tick 0 is
// the only planning identity that exists, so drift is unrepresentable rather
// than merely validated.
export const PlanningBatchSchema = z.object({
	schemaVersion: z.literal(1),
	decisionId: z.literal(0),
	observedSequence: z.literal(1),
	observedWorldTick: z.literal(0),
	thoughts: z.string().trim().min(1).max(1000),
	memo: z.string().trim().max(600).default(''),
	actions: z.array(PlanningActionSchema).max(2)
}).strict().superRefine((batch, context) => {
	if (batch.actions.filter(action => action.type === 'queueBuildPlan').length > 1) {
		context.addIssue({ code: 'custom', message: 'a planning batch may contain at most one queueBuildPlan action' });
	}

	if (batch.actions.filter(action => action.type === 'setPolicy').length > 1) {
		context.addIssue({ code: 'custom', message: 'a planning batch may contain at most one setPolicy action' });
	}
});

export type PlanningBatch = z.infer<typeof PlanningBatchSchema>;

// Strategy arsenal (assisted-mode only): adoptStrategy lives in SEPARATE
// schema objects so the raw track's provider-visible schemas stay
// byte-identical — adding the variant to the shared unions would leak the
// strategy surface into raw matches through the provider dialect.
const ArsenalStrategyIds = strategyIds(StrategyArsenal);
const StrategyIdSchema = ArsenalStrategyIds.length > 0
	? z.enum(ArsenalStrategyIds as [string, ...string[]])
	: z.string().min(1).max(64);

const AdoptStrategyAction = z.object({
	type: z.literal('adoptStrategy'),
	strategyId: StrategyIdSchema,
	// Always surfaced as modelReason in host truth and events — the model's
	// stated selection rationale, never a host fact.
	reason: z.string().trim().min(1).max(240)
}).strict();

// Model control over the bound doctrine (arsenal-only, like adoptStrategy, so the raw
// track's schemas stay byte-identical). pause/resume gate standing emission; holdPhase is a
// sticky veto on auto phase-advance (D2) and advancePhase takes the boundary itself.
const ControlDoctrineAction = z.object({
	type: z.literal('controlDoctrine'),
	doctrineCommand: z.enum(['pause', 'resume', 'holdPhase', 'advancePhase'])
}).strict();

export const ArsenalActionSchema = z.union([
	...AgentActionSchema.options, AdoptStrategyAction, ControlDoctrineAction]);

export const GuidedArsenalActionSchema = z.union([
	...AgentActionSchema.options, AdoptStrategyAction, ControlDoctrineAction, AcceptDoctrineDecisionAction,
	CommitIntentAction, ReinforceIntentAction
]);

export const GuidedArsenalActionBatchSchema = guidedBatch(GuidedArsenalActionSchema);

export const ArsenalActionBatchSchema = z.object({
	schemaVersion: z.literal(1),
	decisionId: z.number().int().nonnegative(),
	observedSequence: z.number().int().positive(),
	observedWorldTick: NonNegativeInt32,
	thoughts: z.string().trim().min(1).max(1000),
	memo: z.string().trim().max(600).default(''),
	actions: z.array(ArsenalActionSchema).max(12)
}).strict().superRefine((batch, context) => {
	const subjects = batch.actions.reduce((total, action) => {
		if ('actorIds' in action) {
			total += action.actorIds.length;
		}

		if ('producerId' in action) {
			total++;
		}

		if ('targetActorId' in action) {
			total++;
		}

		return total;
	}, 0);
	if (subjects > 256) {
		context.addIssue({ code: 'custom', message: 'subject id count exceeds 256' });
	}

	const planActions = batch.actions.filter(action =>
		action.type === 'queueBuildPlan' || action.type === 'controlBuildPlan').length;
	if (planActions > 1) {
		context.addIssue({ code: 'custom', message: 'an action batch may contain at most one build-plan action' });
	}

	if (planActions > 0 && batch.actions.some(action =>
		action.type === 'startProduction' || action.type === 'cancelProduction' ||
		action.type === 'placeBuilding' || action.type === 'placeBuildingAuto')) {
		context.addIssue({ code: 'custom', message: 'build-plan controls cannot share a batch with direct production actions' });
	}

	const missionActions = batch.actions.filter(action =>
		action.type === 'queueMission' || action.type === 'controlMission').length;
	if (missionActions > 1) {
		context.addIssue({ code: 'custom', message: 'an action batch may contain at most one mission action' });
	}

	if (batch.actions.filter(action => action.type === 'adoptStrategy').length > 1) {
		context.addIssue({ code: 'custom', message: 'an action batch may contain at most one adoptStrategy action' });
	}

	batch.actions.forEach((action, index) => {
		if (action.type !== 'queueMission' || action.missionType !== 'pincer') {
			return;
		}

		const squads = action.legs.map(leg => leg.squad);
		if (new Set(squads).size !== squads.length) {
			context.addIssue({
				code: 'custom',
				path: ['actions', index, 'legs'],
				message: 'pincer legs must name distinct squads'
			});
		}
	});
});

export type ArsenalActionBatch = z.infer<typeof ArsenalActionBatchSchema>;

// Arsenal planning adds the opening strategy pick to the two existing
// planning commitments; identity literals are unchanged.
export const ArsenalPlanningActionSchema = z.union([QueueBuildPlanAction, SetPolicyAction, AdoptStrategyAction]);

export const ArsenalPlanningBatchSchema = z.object({
	schemaVersion: z.literal(1),
	decisionId: z.literal(0),
	observedSequence: z.literal(1),
	observedWorldTick: z.literal(0),
	thoughts: z.string().trim().min(1).max(1000),
	memo: z.string().trim().max(600).default(''),
	actions: z.array(ArsenalPlanningActionSchema).max(3)
}).strict().superRefine((batch, context) => {
	if (batch.actions.filter(action => action.type === 'queueBuildPlan').length > 1) {
		context.addIssue({ code: 'custom', message: 'a planning batch may contain at most one queueBuildPlan action' });
	}

	if (batch.actions.filter(action => action.type === 'setPolicy').length > 1) {
		context.addIssue({ code: 'custom', message: 'a planning batch may contain at most one setPolicy action' });
	}

	if (batch.actions.filter(action => action.type === 'adoptStrategy').length > 1) {
		context.addIssue({ code: 'custom', message: 'a planning batch may contain at most one adoptStrategy action' });
	}
});

export type ArsenalPlanningBatch = z.infer<typeof ArsenalPlanningBatchSchema>;

export const DecideRequestSchema = z.object({
	agentId: z.string().min(1).max(128),
	model: z.string().min(1).max(200),
	systemPrompt: z.string().min(1).max(8000),
	apiKey: z.string().min(8).max(512),
	maxOutputTokens: z.number().int().min(128).max(8192),
	decisionId: z.number().int().nonnegative(),
	observation: z.object({
		schemaVersion: z.literal(1),
		sequence: z.number().int().positive(),
		worldTick: NonNegativeInt32
	}).passthrough(),
	previousResult: z.string().max(4000).default('No previous decision result.'),
	requestTimeoutMs: z.number().int().min(5000).max(120000).default(60000),
	// Per-agent model profile: forwarded to OpenRouter's unified `reasoning`
	// parameter. Omitted = provider default (safe for models without
	// reasoning support).
	reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
	// The agent's own journal from its previous accepted decision, echoed
	// back as clearly-labeled, possibly-stale memory.
	memo: z.string().max(600).optional(),
	// Pre-match planning turns validate against PlanningBatchSchema and get a
	// PLANNING instruction section; live turns are unchanged by the default.
	phase: z.enum(['live', 'planning']).default('live'),
	// The assisted strategy arsenal is a separate provider-visible schema.
	// The 'off' default keeps legacy and benchmark-raw requests on the exact
	// provider surface they had before the arsenal existed.
	arsenalMode: z.enum(['off', 'menu']).default('off'),
	// Additive exact-choice schema. The off default preserves the provider
	// surface for raw and ordinary arsenal matches.
	guidanceMode: z.enum(['off', 'exact']).default('off'),
	// Exact doctrine commitments use the narrow selection-only schema. The
	// strategic default preserves all pre-guidance request bytes.
	decisionMode: z.enum(['strategic', 'commit']).default('strategic')
}).strict();

export type DecideRequest = z.infer<typeof DecideRequestSchema>;

// The self-improvement loop: after a match, the model reads its own match
// report plus its prior lessons and rewrites the lessons file — bounded,
// self-compacting cross-match memory injected into future system prompts.
export const ReflectRequestSchema = z.object({
	model: z.string().min(1).max(200),
	apiKey: z.string().min(8).max(512),
	matchReport: z.string().min(1).max(6000),
	priorLessons: z.string().max(2500).default(''),
	requestTimeoutMs: z.number().int().min(5000).max(120000).default(45000)
}).strict();

export const EstimateRequestSchema = z.object({
	models: z.array(z.string().min(1).max(200)).length(2),
	maxOutputTokens: z.number().int().min(128).max(8192),
	estimatedInputTokens: z.number().int().min(1000).max(65536).default(8000),
	estimatedDecisionsPerAgent: z.number().int().min(1).max(1000).default(20),
	strategyArsenalEnabled: z.boolean().default(false)
}).strict();
