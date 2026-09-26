// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';
import {
	AgentActionBatchSchema,
	AgentActionSchema,
	CommitActionBatchSchema,
	GuidedActionBatchSchema,
	GuidedArsenalActionBatchSchema,
	PlanningActionSchema,
	PlanningBatchSchema
} from '../dist/contracts.js';
import {
	buildContractManifest,
	buildProviderSurfaceManifest,
	fingerprintContractManifest
} from '../dist/contract-manifest.js';
import { buildInstructions, RulesKnowledgeHash, StaticPrimer, ThinDecisionPrimer } from '../dist/instructions.js';
import { narrowActionSchema, providerSafeSchema } from '../dist/provider-schema.js';

const ForbiddenKeywords = [
	'exclusiveMaximum',
	'exclusiveMinimum',
	'format',
	'maxItems',
	'maxLength',
	'maxProperties',
	'maximum',
	'minItems',
	'minLength',
	'minProperties',
	'minimum',
	'multipleOf',
	'oneOf',
	'pattern',
	'uniqueItems'
];

test('ActionBatch accepts the placeBuildingAuto action', () => {
	const batch = AgentActionBatchSchema.parse({
		schemaVersion: 1,
		decisionId: 3,
		observedSequence: 8,
		observedWorldTick: 125,
		thoughts: 'Place the completed power plant without guessing a cell.',
		actions: [{ type: 'placeBuildingAuto', producerId: 42, item: 'powr' }]
	});

	assert.equal(batch.actions[0].type, 'placeBuildingAuto');
});

test('guided batches add exact decision selection without changing raw or ordinary arsenal', () => {
	const selection = {
		schemaVersion: 1,
		decisionId: 5,
		observedSequence: 9,
		observedWorldTick: 150,
		thoughts: 'Select the still-current exact host option.',
		actions: [{ type: 'acceptDoctrineDecision', decisionId: 3, optionId: 'strike-production' }]
	};
	assert.equal(GuidedActionBatchSchema.parse(selection).actions[0].optionId, 'strike-production');
	assert.equal(GuidedArsenalActionBatchSchema.parse(selection).actions[0].decisionId, 3);
	assert.throws(() => AgentActionBatchSchema.parse(selection),
		'raw action bytes must not gain the guided selection variant');
	assert.throws(() => GuidedActionBatchSchema.parse({
		...selection,
		actions: [selection.actions[0], { type: 'stop', actorIds: [1] }]
	}), 'a guidance selection must be the only submitted action');
	assert.equal(CommitActionBatchSchema.parse(selection).actions[0].type, 'acceptDoctrineDecision');
	assert.throws(() => CommitActionBatchSchema.parse({
		...selection,
		actions: [{ type: 'attackMove', actorIds: [1], cellX: 2, cellY: 3, queued: false }]
	}), 'commit mode exposes only the exact option selection action');
	assert.equal(buildInstructions('ignored', 'ignored', 'live', undefined, 'commit'), ThinDecisionPrimer);
	const guided = buildInstructions('orders', 'knowledge', 'live', undefined, 'guided');
	assert.match(guided, /reinforce-wave/);
	assert.match(guided, /regroup-home/);
	assert.match(guided, /never move automatically/);
	assert.doesNotMatch(buildInstructions('orders', 'knowledge'), /reinforce-wave|regroup-home/,
		'raw prompt bytes must not gain assisted exact choices');
	assert.doesNotMatch(buildInstructions('orders', 'knowledge', 'live', { menu: 'menu' }),
		/reinforce-wave|regroup-home/, 'ordinary arsenal prompt bytes must not gain assisted exact choices');
});

test('ActionBatch accepts the completed strategic action vocabulary', () => {
	const batch = AgentActionBatchSchema.parse({
		schemaVersion: 1,
		decisionId: 4,
		observedSequence: 9,
		observedWorldTick: 150,
		thoughts: 'Exercise each typed strategic action without extra fields.',
		actions: [
			{ type: 'capture', actorIds: [11], targetActorId: 22, queued: false },
			{ type: 'cancelProduction', producerId: 33, item: 'powr', count: 1 },
			{ type: 'setRallyPoint', producerId: 44, cellX: 10, cellY: 12 },
			{ type: 'repair', actorIds: [55] },
			{ type: 'sell', actorIds: [66] },
			{
				type: 'setPolicy',
				autoReturnFire: true,
				harvesterFlee: true,
				rallyNewUnitsToDefense: false,
				defendCriticalAssets: true,
				autoRepairBuildings: false,
				retreatBelowHpPercent: 40
			}
		]
	});

	assert.deepEqual(batch.actions.map(action => action.type),
		['capture', 'cancelProduction', 'setRallyPoint', 'repair', 'sell', 'setPolicy']);
	assert.throws(() => AgentActionBatchSchema.parse({
		...batch,
		actions: [{ type: 'sell', actorIds: [66], queued: false }]
	}));
});

test('control harness: commitIntent and reinforceIntent parse on the executor surface with defaults', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 20,
		observedSequence: 30,
		observedWorldTick: 500,
		thoughts: 'Commit a compiled strike.'
	};
	const batch = GuidedActionBatchSchema.parse({
		...base,
		actions: [
			{ type: 'commitIntent', intent: 'strike' },
			{ type: 'reinforceIntent' }
		]
	});
	assert.equal(batch.actions[0].type, 'commitIntent');
	assert.equal(batch.actions[0].intent, 'strike');
	assert.equal(batch.actions[0].minForce, 6);
	assert.equal(batch.actions[0].priority, 'production');
	assert.equal(batch.actions[1].type, 'reinforceIntent');
	assert.equal(batch.actions[1].to, 'activeStrike');
	assert.equal(batch.actions[1].maxUnits, 8);

	const defend = GuidedArsenalActionBatchSchema.parse({
		...base,
		actions: [{ type: 'commitIntent', intent: 'defendBase', minForce: 8, priority: 'any', groupName: 'main' }]
	});
	assert.equal(defend.actions[0].intent, 'defendBase');
	assert.equal(defend.actions[0].minForce, 8);
	assert.equal(defend.actions[0].groupName, 'main');

	assert.throws(() => GuidedActionBatchSchema.parse({
		...base,
		actions: [{ type: 'commitIntent', intent: 'raid' }]
	}), 'unknown intent must fail');

	// Benchmark integrity: the raw base track never exposes war intents.
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'commitIntent', intent: 'strike' }]
	}), 'raw track must reject commitIntent');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'reinforceIntent' }]
	}), 'raw track must reject reinforceIntent');
});

test('squads: assignGroup and group addressing parse; mixed addressing rejects', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 6,
		observedSequence: 11,
		observedWorldTick: 200,
		thoughts: 'Squad vocabulary check.'
	};
	const batch = AgentActionBatchSchema.parse({
		...base,
		actions: [
			{ type: 'assignGroup', name: 'mainArmy', actorIds: [10, 11, 12] },
			{ type: 'attackMove', groupName: 'mainArmy', cellX: 50, cellY: 40, queued: false },
			{ type: 'stop', groupName: 'mainArmy' }
		]
	});
	assert.equal(batch.actions[1].groupName, 'mainArmy');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'move', actorIds: [10], groupName: 'both', cellX: 1, cellY: 1, queued: false }]
	}), 'supplying both addressing forms must fail');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'attack', groupName: 'mainArmy', targetActorId: 5, queued: false }]
	}), 'attack has no group variant');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'assignGroup', name: 'bad\nname', actorIds: [10] }]
	}), 'group names reject embedded control characters');
});

test('host-width numeric boundaries reject before transport', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 7,
		observedSequence: 12,
		observedWorldTick: 200,
		thoughts: 'Exercise C# numeric widths.'
	};
	assert.doesNotThrow(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'move', actorIds: [0xFFFFFFFF], cellX: 0x7FFFFFFF,
			cellY: -0x80000000, queued: false }]
	}));
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'move', actorIds: [0x100000000], cellX: 1, cellY: 1, queued: false }]
	}), 'actor ids above uint reject before host deserialization');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'move', actorIds: [1], cellX: 0x80000000, cellY: 1, queued: false }]
	}), 'cells above int32 reject before host deserialization');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		observedWorldTick: 0x80000000,
		actions: []
	}), 'world ticks above int32 reject before host deserialization');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'controlMission', missionId: 'm', missionVersion: 0x80000000,
			missionCommand: 'pause' }]
	}), 'mission versions above int32 reject before host deserialization');
});

test('missions: sweep, strike, and control shapes parse; host invariants reject', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 20,
		observedSequence: 30,
		observedWorldTick: 400,
		thoughts: 'Commit one bounded mission.'
	};
	const sweep = {
		type: 'queueMission', missionId: 'recon_1', missionType: 'sweep', missionVersion: 1,
		groupName: 'scouts', exploredPercentTarget: 85, abortLossPercent: 50
	};
	const strike = {
		type: 'queueMission', missionId: 'strike-1', missionType: 'strike', missionVersion: 1,
		cellX: 70, cellY: 40, legs: [{ squad: 'main', viaX: 50, viaY: 40 }],
		posture: 'assault', targetPriority: 'production', abortLossPercent: 40
	};
	assert.equal(AgentActionBatchSchema.parse({ ...base, actions: [sweep] }).actions[0].missionType, 'sweep');
	assert.equal(AgentActionBatchSchema.parse({ ...base, actions: [strike] }).actions[0].missionType, 'strike');
	assert.equal(AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'controlMission', missionId: 'strike-1', missionVersion: 1, missionCommand: 'pause' }]
	}).actions[0].missionCommand, 'pause');
	assert.throws(() => AgentActionBatchSchema.parse({ ...base, actions: [sweep, strike] }),
		'only one mission action is allowed in a decision');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ ...sweep, missionId: 'bad id!' }]
	}), 'missionId charset is enforced by Zod');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ ...strike, legs: [{ squad: 'a', viaX: 1, viaY: 1 }, { squad: 'b', viaX: 2, viaY: 2 }] }]
	}), 'CP1 strike accepts exactly one leg');
});

test('CP2 missions: pincer, air strike, pursue, and reinforce enforce bounded strict shapes', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 21,
		observedSequence: 31,
		observedWorldTick: 425,
		thoughts: 'Exercise the expanded bounded mission vocabulary.'
	};
	const parseOne = action => AgentActionBatchSchema.parse({ ...base, actions: [action] }).actions[0];
	const pincer = {
		type: 'queueMission', missionId: 'pincer-1', missionType: 'pincer', missionVersion: 1,
		cellX: 70, cellY: 40,
		legs: [{ squad: 'left', viaX: 45, viaY: 30 }, { squad: 'right', viaX: 45, viaY: 50 }]
	};
	const parsedPincer = parseOne(pincer);
	assert.equal(parsedPincer.posture, 'assault');
	assert.equal(parsedPincer.targetPriority, 'any');
	assert.equal(parsedPincer.abortLossPercent, 40);
	assert.throws(() => parseOne({ ...pincer, legs: [pincer.legs[0]] }),
		'pincer requires at least two legs');
	assert.throws(() => parseOne({
		...pincer,
		legs: [...pincer.legs, { squad: 'reserve', viaX: 40, viaY: 40 }, { squad: 'fourth', viaX: 35, viaY: 40 }]
	}), 'pincer allows at most three legs');
	assert.throws(() => parseOne({ ...pincer, legs: [pincer.legs[0], { ...pincer.legs[1], squad: 'left' }] }),
		'pincer leg squads must be distinct');

	const airStrike = parseOne({
		type: 'queueMission', missionId: 'air-1', missionType: 'airStrike', missionVersion: 1,
		groupName: 'airWing', cellX: 80, cellY: 30
	});
	assert.equal(airStrike.sorties, 3);
	assert.equal(airStrike.targetPriority, 'any');
	assert.equal(airStrike.abortLossPercent, 50);
	for (const sorties of [0, 6]) {
		assert.throws(() => parseOne({
			type: 'queueMission', missionId: 'air-bad', missionType: 'airStrike', missionVersion: 1,
			groupName: 'airWing', cellX: 80, cellY: 30, sorties
		}), `airStrike sorties=${sorties} must reject`);
	}

	const pursue = parseOne({
		type: 'queueMission', missionId: 'pursue-1', missionType: 'pursue', missionVersion: 1,
		groupName: 'hunters', cellX: 60, cellY: 60
	});
	assert.equal(pursue.maxChaseCells, 25);
	assert.equal(pursue.abortLossPercent, 30);
	for (const maxChaseCells of [4, 61]) {
		assert.throws(() => parseOne({
			type: 'queueMission', missionId: 'pursue-bad', missionType: 'pursue', missionVersion: 1,
			groupName: 'hunters', cellX: 60, cellY: 60, maxChaseCells
		}), `pursue maxChaseCells=${maxChaseCells} must reject`);
	}

	const destination = parseOne({
		type: 'queueMission', missionId: 'reinforce-squad', missionType: 'reinforce', missionVersion: 1,
		groupName: 'reserve', destinationSquad: 'frontline'
	});
	assert.equal(destination.destinationSquad, 'frontline');
	const fixed = parseOne({
		type: 'queueMission', missionId: 'reinforce-cell', missionType: 'reinforce', missionVersion: 1,
		groupName: 'reserve', cellX: 25, cellY: 35
	});
	assert.equal(fixed.cellX, 25);
	assert.throws(() => parseOne({
		type: 'queueMission', missionId: 'reinforce-mixed', missionType: 'reinforce', missionVersion: 1,
		groupName: 'reserve', destinationSquad: 'frontline', cellX: 25, cellY: 35
	}), 'reinforce must use exactly one destination form');
	assert.throws(() => parseOne({
		type: 'queueMission', missionId: 'reinforce-empty', missionType: 'reinforce', missionVersion: 1,
		groupName: 'reserve'
	}), 'reinforce requires a destination');

	for (const abortLossPercent of [9, 101]) {
		assert.throws(() => parseOne({ ...pincer, abortLossPercent }),
			`mission abortLossPercent=${abortLossPercent} must reject`);
	}
});

test('CP2 direct guard and spyPlane actions enforce exclusive addressing', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 22,
		observedSequence: 32,
		observedWorldTick: 450,
		thoughts: 'Exercise persistent guard and reconnaissance support power.'
	};
	const batch = AgentActionBatchSchema.parse({
		...base,
		actions: [
			{ type: 'guard', actorIds: [10, 11], targetActorId: 12 },
			{ type: 'guard', groupName: 'escort', targetActorId: 12 },
			{ type: 'spyPlane', cellX: 70, cellY: 40 }
		]
	});
	assert.deepEqual(batch.actions.map(action => action.type), ['guard', 'guard', 'spyPlane']);
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'guard', actorIds: [10], groupName: 'escort', targetActorId: 12 }]
	}), 'guard must use exactly one addressing form');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'spyPlane', cellX: 70, cellY: 40, queued: false }]
	}), 'spyPlane rejects unrelated fields');
});

test('setPolicy requires the CP2 autoRepairBuildings standing order', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 23,
		observedSequence: 33,
		observedWorldTick: 475,
		thoughts: 'State the complete standing policy.'
	};
	const policy = {
		type: 'setPolicy', autoReturnFire: true, harvesterFlee: true,
		rallyNewUnitsToDefense: false, defendCriticalAssets: true,
		autoRepairBuildings: true, retreatBelowHpPercent: 25
	};
	assert.equal(AgentActionBatchSchema.parse({ ...base, actions: [policy] }).actions[0].autoRepairBuildings, true);
	const { autoRepairBuildings, ...incomplete } = policy;
	assert.equal(autoRepairBuildings, true);
	assert.throws(() => AgentActionBatchSchema.parse({ ...base, actions: [incomplete] }),
		'partial standing policies must reject');
});

test('build plans: queueBuildPlan and controlBuildPlan parse; bad shapes reject', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 7,
		observedSequence: 12,
		observedWorldTick: 220,
		thoughts: 'Commit the opening as a plan.'
	};
	const plan = {
		type: 'queueBuildPlan',
		planId: 'opening-v1',
		version: 1,
		reserveCash: 300,
		steps: [
			{ item: 'powr', count: 1 },
			{ item: 'barr', count: 1 },
			{ item: 'e1', count: 5 }
		]
	};
	const batch = AgentActionBatchSchema.parse({ ...base, actions: [plan] });
	assert.equal(batch.actions[0].steps.length, 3);
	const control = AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'controlBuildPlan', planId: 'opening-v1', version: 1, command: 'pause' }]
	});
	assert.equal(control.actions[0].command, 'pause');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ type: 'queueBuildPlan', planId: 'bad id!', version: 1, steps: [{ item: 'powr', count: 1 }] }]
	}), 'planId charset must reject spaces and punctuation');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{
			type: 'queueBuildPlan', planId: 'x', version: 1,
			steps: Array.from({ length: 9 }, () => ({ item: 'e1', count: 1 }))
		}]
	}), 'more than eight steps must reject');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [{ ...plan, reserveCash: 1000001 }]
	}), 'reserveCash above the host cap must reject');
});

test('build plans mirror the host batch invariants: one plan action, no direct-production mix', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 8,
		observedSequence: 13,
		observedWorldTick: 240,
		thoughts: 'Host-mirror invariants.'
	};
	const plan = {
		type: 'queueBuildPlan', planId: 'opening-v2', version: 1,
		steps: [{ item: 'powr', count: 1 }]
	};
	// The host rejects these whole batches (AgentModeHost): the schema must too.
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [plan, { type: 'controlBuildPlan', planId: 'opening-v1', version: 1, command: 'cancel' }]
	}), 'two build-plan actions in one batch must reject');
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: [plan, { type: 'startProduction', producerId: 9, item: 'e1', count: 5, queued: false }]
	}), 'a build-plan action mixed with direct production must reject');
	// Plan actions still combine with non-production actions freely.
	const combined = AgentActionBatchSchema.parse({
		...base,
		actions: [plan, { type: 'attackMove', groupName: 'mainArmy', cellX: 10, cellY: 12, queued: false }]
	});
	assert.equal(combined.actions.length, 2);
});

test('action ceiling: twelve actions parse, thirteen reject', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 9,
		observedSequence: 14,
		observedWorldTick: 260,
		thoughts: 'Ceiling boundary check.'
	};
	const stop = index => ({ type: 'stop', actorIds: [index + 1] });
	const twelve = AgentActionBatchSchema.parse({
		...base,
		actions: Array.from({ length: 12 }, (_, index) => stop(index))
	});
	assert.equal(twelve.actions.length, 12);
	assert.throws(() => AgentActionBatchSchema.parse({
		...base,
		actions: Array.from({ length: 13 }, (_, index) => stop(index))
	}), 'thirteen actions must reject');
});

test('commander memo defaults when omitted and roundtrips when present', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 5,
		observedSequence: 10,
		observedWorldTick: 175,
		thoughts: 'Journal continuity check.',
		actions: []
	};
	assert.equal(AgentActionBatchSchema.parse(base).memo, '');
	assert.equal(AgentActionBatchSchema.parse({ ...base, memo: 'Phase: opening. Next: weap.' }).memo,
		'Phase: opening. Next: weap.');
	assert.throws(() => AgentActionBatchSchema.parse({ ...base, memo: 'x'.repeat(601) }));
});

test('provider schema marks every object property required (strict completion)', () => {
	const schema = providerSafeSchema(z.toJSONSchema(AgentActionBatchSchema));
	const visit = value => {
		if (Array.isArray(value)) {
			value.forEach(visit);
			return;
		}

		if (value == null || typeof value !== 'object') {
			return;
		}

		if (value.type === 'object' && value.properties != null) {
			assert.deepEqual([...(value.required ?? [])].sort(), Object.keys(value.properties).sort(),
				'strict providers demand all properties in required');
		}

		Object.values(value).forEach(visit);
	};
	visit(schema);
	assert.match(JSON.stringify(schema), /"memo"/);
});

test('provider schema uses only supported keywords and string enums', () => {
	const schema = providerSafeSchema(z.toJSONSchema(AgentActionBatchSchema));
	const json = JSON.stringify(schema);
	for (const keyword of ForbiddenKeywords) {
		assert.doesNotMatch(json, new RegExp(`"${keyword}":`), `schema retained ${keyword}`);
	}

	assert.match(json, /placeBuildingAuto/);
	for (const action of ['capture', 'cancelProduction', 'setRallyPoint', 'repair', 'sell']) {
		assert.match(json, new RegExp(action));
	}
	assert.match(json, /"anyOf":/);
	assert.doesNotMatch(json, /"const":/);

	const visit = value => {
		if (Array.isArray(value)) {
			value.forEach(visit);
			return;
		}

		if (value == null || typeof value !== 'object') {
			return;
		}

		for (const [key, entry] of Object.entries(value)) {
			if (key === 'enum') {
				assert.ok(Array.isArray(entry) && entry.every(option => typeof option === 'string'),
					`non-string enum: ${JSON.stringify(entry)}`);
			}

			visit(entry);
		}
	};
	visit(schema);
});

test('raw Zod batch identity and provider-safe action surface are canonical', () => {
	const rawAction = z.toJSONSchema(AgentActionSchema);
	const rawBatch = z.toJSONSchema(AgentActionBatchSchema);
	const provider = providerSafeSchema(rawAction);
	const rawManifest = buildContractManifest(rawAction, rawBatch, 'era3-skills',
		z.toJSONSchema(PlanningActionSchema), RulesKnowledgeHash);
	assert.deepEqual(buildProviderSurfaceManifest(provider, 'era3-skills'),
		buildProviderSurfaceManifest(rawAction, 'era3-skills'));
	assert.equal(rawManifest.maxActionsPerDecision, 12);
	assert.ok(rawManifest.fieldRules.some(rule =>
		rule.path === 'queueMission.strike.legs' && rule.rule.includes('length=1')));
	assert.ok(rawManifest.batchInvariants.includes('at most one mission action per batch'));
	assert.ok(rawManifest.configSurface.includes('omniscientObservations:boolean default=false'));
	assert.match(rawManifest.rulesKnowledgeHash, /^[0-9a-f]{64}$/);
	assert.deepEqual(rawManifest.observationFields, [...rawManifest.observationFields].sort());
	assert.ok(rawManifest.observationRules.some(rule => rule.path === 'observation.hostTruth.missions'));
	assert.ok(rawManifest.observationRules.some(rule =>
		rule.path === 'observation.hostTruth.doctrine.pendingDecision.kind' &&
		rule.rule.includes('reinforceAttack') && rule.rule.includes('regroupNeeded')));
	assert.ok(rawManifest.missionEventFields.includes('kind'));
	assert.ok(rawManifest.matchStateFields.includes('outOfSync'));
	assert.deepEqual(rawManifest.situationKinds, [
		'E1.funding', 'E1.power', 'O1.retreat', 'O2', 'S1.water', 'S2.recon', 'T1.air', 'T1.base',
		'T1.naval', 'T1.sw', 'T2.reinforcement', 'T3.harv', 'T4'
	]);
	assert.ok(rawManifest.observationFields.includes('situations'));
	assert.ok(rawManifest.observationRules.some(rule => rule.path === 'observation.situations'));
	assert.ok(rawManifest.variants.some(variant => variant.variantId === 'queueMission.sweep'));
	assert.ok(rawManifest.variants.some(variant => variant.variantId === 'queueMission.strike'));
});

const actionUnionOf = schema => schema?.properties?.actions?.items?.anyOf ?? schema?.properties?.actions?.items?.oneOf;
const actionTypesOf = schema => [...new Set((actionUnionOf(schema) ?? [])
	.map(variant => variant?.properties?.type?.const ?? variant?.properties?.type?.enum?.[0])
	.filter(type => typeof type === 'string'))].sort();

test('narrowActionSchema intersects the guided action union with the phase legal types', () => {
	const full = z.toJSONSchema(GuidedActionBatchSchema);
	const legal = ['commitIntent', 'reinforceIntent', 'setPolicy', 'startProduction'];
	const narrowed = narrowActionSchema(full, legal);
	// acceptDoctrineDecision is the phase-agnostic exact-choice escape hatch and
	// is always retained even though it is not in any control-phase legal set.
	assert.deepEqual(actionTypesOf(narrowed), [...legal, 'acceptDoctrineDecision'].sort());
	for (const stripped of ['move', 'attack', 'attackMove', 'queueMission', 'surrender', 'sell', 'deploy']) {
		assert.ok(!actionTypesOf(narrowed).includes(stripped), `narrowing left ${stripped} in the union`);
	}

	// The full authority union is untouched (narrowing returns a fresh object).
	assert.ok(actionTypesOf(full).includes('move'), 'input schema must not be mutated');
	assert.equal(actionUnionOf(narrowed).length, legal.length + 1);
});

test('narrowActionSchema preserves acceptDoctrineDecision even when the phase omits it', () => {
	const narrowed = narrowActionSchema(z.toJSONSchema(GuidedActionBatchSchema), ['commitIntent']);
	assert.deepEqual(actionTypesOf(narrowed), ['acceptDoctrineDecision', 'commitIntent']);
});

test('narrowActionSchema is a no-op for the raw track and full legal sets', () => {
	const raw = z.toJSONSchema(AgentActionBatchSchema);
	// No legal types (raw/planning/commit paths) — byte-identical structure.
	assert.deepEqual(narrowActionSchema(raw, undefined), raw);
	assert.deepEqual(narrowActionSchema(raw, []), raw);

	// A legal set covering every present type removes nothing.
	const guided = z.toJSONSchema(GuidedActionBatchSchema);
	assert.deepEqual(narrowActionSchema(guided, actionTypesOf(guided)), guided);
});

test('narrowActionSchema never emits an empty union (fail-safe to full)', () => {
	// AgentActionBatchSchema has no phase-agnostic variant, so an all-illegal
	// legal set would empty the union — the guard must return the full schema.
	const raw = z.toJSONSchema(AgentActionBatchSchema);
	assert.deepEqual(narrowActionSchema(raw, ['noSuchActionType']), raw);
});

test('generated RA knowledge is bounded and contains anchor actors', async () => {
	const path = new URL('../knowledge/ra-knowledge.md', import.meta.url);
	const bytes = await readFile(path);
	assert.equal(RulesKnowledgeHash, createHash('sha256').update(bytes).digest('hex'),
		'rules knowledge hash must describe the exact packaged bytes');
	assert.ok(bytes.byteLength >= 2 * 1024, `knowledge file is too small: ${bytes.byteLength}`);
	assert.ok(bytes.byteLength <= 24 * 1024, `knowledge file is too large: ${bytes.byteLength}`);

	const text = bytes.toString('utf8');
	for (const actor of ['powr', 'proc', '2tnk']) {
		assert.match(text, new RegExp(`^- ${actor}\\|`, 'm'), `missing ${actor} knowledge row`);
	}
});

test('instructions keep static and rules knowledge ahead of the user prompt', () => {
	const instructions = buildInstructions('USER_PLAYBOOK_SENTINEL', 'RULES_KNOWLEDGE_SENTINEL');
	const primer = instructions.indexOf(StaticPrimer);
	const knowledge = instructions.indexOf('RULES_KNOWLEDGE_SENTINEL');
	const user = instructions.indexOf('USER_PLAYBOOK_SENTINEL');
	assert.equal(primer, 0);
	assert.ok(knowledge > primer, 'rules knowledge must follow the static primer');
	assert.ok(user > knowledge, 'the user prompt must follow static cacheable context');
	assert.match(instructions, /PLAYBOOK\/DOCTRINE/);
});

test('planning batch accepts memo plus one build plan and one complete policy', () => {
	const batch = PlanningBatchSchema.parse({
		schemaVersion: 1,
		decisionId: 0,
		observedSequence: 1,
		observedWorldTick: 0,
		thoughts: 'Open with power, refinery, barracks; scout early; policy defensive.',
		memo: 'Phase: opening. Build powr>proc>tent, scout at first infantry, expand by minute four.',
		actions: [
			{
				type: 'queueBuildPlan',
				planId: 'opening',
				version: 1,
				steps: [{ item: 'powr', count: 1 }, { item: 'proc', count: 1 }, { item: 'tent', count: 1 }]
			},
			{
				type: 'setPolicy',
				autoReturnFire: true,
				harvesterFlee: true,
				rallyNewUnitsToDefense: true,
				defendCriticalAssets: true,
				autoRepairBuildings: true,
				retreatBelowHpPercent: 30
			}
		]
	});
	assert.equal(batch.actions.length, 2);
	assert.equal(batch.memo.startsWith('Phase: opening.'), true);

	const memoOnly = PlanningBatchSchema.parse({
		schemaVersion: 1,
		decisionId: 0,
		observedSequence: 1,
		observedWorldTick: 0,
		thoughts: 'Commit intent only; defaults are acceptable.',
		actions: []
	});
	assert.equal(memoOnly.actions.length, 0);
	assert.equal(memoOnly.memo, '');
});

test('planning batch rejects live actions, duplicates, and non-literal identity', () => {
	const base = {
		schemaVersion: 1,
		decisionId: 0,
		observedSequence: 1,
		observedWorldTick: 0,
		thoughts: 'Planning rejection matrix.'
	};
	const plan = version => ({
		type: 'queueBuildPlan', planId: 'opening', version, steps: [{ item: 'powr', count: 1 }]
	});
	const policy = {
		type: 'setPolicy', autoReturnFire: true, harvesterFlee: true, rallyNewUnitsToDefense: false,
		defendCriticalAssets: true, autoRepairBuildings: false, retreatBelowHpPercent: 0
	};

	// The live vocabulary is unrepresentable: no actor, group, or mission
	// action exists in the planning union at all.
	for (const action of [
		{ type: 'move', actorIds: [1], cellX: 5, cellY: 5, queued: false },
		{ type: 'attackMove', groupName: 'main', cellX: 5, cellY: 5, queued: false },
		{ type: 'assignGroup', name: 'main', actorIds: [1] },
		{
			type: 'queueMission', missionId: 'push', missionType: 'sweep', missionVersion: 1,
			groupName: 'main', exploredPercentTarget: 85, abortLossPercent: 50
		},
		{ type: 'startProduction', producerId: 7, item: 'powr', count: 1, queued: false },
		{ type: 'spyPlane', cellX: 5, cellY: 5 },
		{ type: 'surrender' }
	]) {
		assert.throws(() => PlanningBatchSchema.parse({ ...base, actions: [action] }),
			`planning must reject ${action.type}`);
	}

	assert.throws(() => PlanningBatchSchema.parse({ ...base, actions: [plan(1), plan(2)] }),
		'two build plans must fail');
	assert.throws(() => PlanningBatchSchema.parse({ ...base, actions: [policy, policy] }),
		'two policies must fail');
	assert.throws(() => PlanningBatchSchema.parse({ ...base, actions: [plan(1), policy, policy] }),
		'three actions exceed the planning ceiling');
	assert.throws(() => PlanningBatchSchema.parse({ ...base, decisionId: 1, actions: [] }),
		'planning identity requires decisionId 0');
	assert.throws(() => PlanningBatchSchema.parse({ ...base, observedSequence: 2, actions: [] }),
		'planning identity requires sequence 1');
	assert.throws(() => PlanningBatchSchema.parse({ ...base, observedWorldTick: 5, actions: [] }),
		'planning identity requires tick 0');
});

test('planning manifest section and provider surface stay canonical', () => {
	const rawManifest = buildContractManifest(
		z.toJSONSchema(AgentActionSchema), z.toJSONSchema(AgentActionBatchSchema), 'era3-skills',
		z.toJSONSchema(PlanningActionSchema), RulesKnowledgeHash);
	assert.equal(rawManifest.planning.maxActionsPerPlanning, 2);
	assert.deepEqual(rawManifest.planning.batchInvariants, [
		'at most one queueBuildPlan',
		'at most one setPolicy',
		'identity literals decisionId=0 observedSequence=1 observedWorldTick=0'
	]);
	assert.deepEqual(rawManifest.planning.variants.map(variant => variant.type).sort(),
		['queueBuildPlan', 'setPolicy']);
	assert.ok(rawManifest.configSurface.includes('planningTimeoutMs:integer clamp=10000..120000 default=30000'));
	assert.ok(rawManifest.configSurface.includes('prematchPlanning:boolean default=false'));

	// The fingerprint must move when the planning surface changes.
	const fingerprint = fingerprintContractManifest(rawManifest);
	const mutated = fingerprintContractManifest({
		...rawManifest,
		planning: { ...rawManifest.planning, maxActionsPerPlanning: 3 }
	});
	assert.notEqual(fingerprint, mutated);

	// The provider-safe planning schema keeps the strict-subset dialect.
	const providerPlanning = providerSafeSchema(z.toJSONSchema(PlanningBatchSchema));
	const json = JSON.stringify(providerPlanning);
	for (const keyword of ForbiddenKeywords) {
		assert.doesNotMatch(json, new RegExp(`"${keyword}":`), `planning schema retained ${keyword}`);
	}
});

test('planning instructions add the planning section between primer and knowledge', () => {
	const planning = buildInstructions('USER_PLAYBOOK_SENTINEL', 'RULES_KNOWLEDGE_SENTINEL', 'planning');
	assert.equal(planning.indexOf(StaticPrimer), 0);
	const section = planning.indexOf('PRE-MATCH PLANNING TURN');
	const knowledge = planning.indexOf('RULES_KNOWLEDGE_SENTINEL');
	const user = planning.indexOf('USER_PLAYBOOK_SENTINEL');
	assert.ok(section > 0, 'planning section must be present');
	assert.ok(knowledge > section, 'rules knowledge must follow the planning section');
	assert.ok(user > knowledge, 'the user prompt stays last');
	assert.match(planning, /PlanningBatch/);
	assert.match(planning, /robust to any of them/);

	const live = buildInstructions('USER_PLAYBOOK_SENTINEL', 'RULES_KNOWLEDGE_SENTINEL');
	assert.equal(live.includes('PRE-MATCH PLANNING TURN'), false, 'live prompts must not carry the planning section');
});
