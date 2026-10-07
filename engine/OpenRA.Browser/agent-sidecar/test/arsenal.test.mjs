// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	AgentActionBatchSchema,
	ArsenalActionBatchSchema,
	ArsenalPlanningBatchSchema,
	DecideRequestSchema,
	PlanningBatchSchema
} from '../dist/contracts.js';
import {
	ArsenalPlanningPrimer,
	buildInstructions,
	PlanningPrimer,
	StaticPrimer
} from '../dist/instructions.js';
import {
	StrategyArsenal,
	renderArsenalMenu,
	renderSituationManualIndex,
	renderStrategyCard,
	selectRelevantSlices,
	strategyIds
} from '../dist/strategy-catalog.js';

const identity = { schemaVersion: 1, decisionId: 3, observedSequence: 4, observedWorldTick: 500 };
const planningIdentity = { schemaVersion: 1, decisionId: 0, observedSequence: 1, observedWorldTick: 0 };
const policy = {
	type: 'setPolicy',
	autoReturnFire: true,
	harvesterFlee: true,
	rallyNewUnitsToDefense: false,
	defendCriticalAssets: true,
	autoRepairBuildings: true,
	retreatBelowHpPercent: 0
};
const plan = {
	type: 'queueBuildPlan',
	planId: 'open1',
	version: 1,
	steps: [{ item: 'powr', count: 1 }, { item: 'barr', count: 1 }]
};

test('strategy arsenal loads ready with all budgets honored', () => {
	assert.equal(StrategyArsenal.ready, true, StrategyArsenal.error);
	assert.equal(strategyIds(StrategyArsenal).length, 4);
	assert.ok(StrategyArsenal.menuBytes > 0 && StrategyArsenal.menuBytes <= 3072);
	assert.ok(StrategyArsenal.largestCardBytes > 0 && StrategyArsenal.largestCardBytes <= 6144);
	assert.match(StrategyArsenal.rulesHash, /^[0-9a-f]{64}$/);
	assert.match(StrategyArsenal.rulesArtifactHash, /^[0-9a-f]{64}$/);
	assert.match(StrategyArsenal.rulesGraphHash, /^[0-9a-f]{64}$/);
	assert.match(StrategyArsenal.catalogFileHash, /^[0-9a-f]{64}$/);
	assert.match(StrategyArsenal.manualFileHash, /^[0-9a-f]{64}$/);
});

test('every card retrieval id resolves against the manual engine ids', () => {
	const engineIds = new Set(StrategyArsenal.manualEngineIds);
	for (const id of strategyIds(StrategyArsenal)) {
		const card = StrategyArsenal.cards.get(id);
		for (const situationId of card.retrieval.situationIds) {
			assert.ok(engineIds.has(situationId), `${id} references unknown situation ${situationId}`);
		}
	}
});

test('arsenal live batch accepts one adoption and rejects the abuse cases', () => {
	const adopt = { type: 'adoptStrategy', strategyId: 'soviet-tank-pressure', reason: 'Land route with no scouted rocket mass.' };
	const accepted = ArsenalActionBatchSchema.parse({ ...identity, thoughts: 'adopting', actions: [adopt] });
	assert.equal(accepted.actions[0].strategyId, 'soviet-tank-pressure');

	// The raw live schema must not even represent the action.
	assert.throws(() => AgentActionBatchSchema.parse({ ...identity, thoughts: 'x', actions: [adopt] }));
	// Unknown ids fail at the schema (closed enum from the catalog).
	assert.throws(() => ArsenalActionBatchSchema.parse({ ...identity, thoughts: 'x', actions: [{ ...adopt, strategyId: 'nonexistent-card' }] }));
	// Reason bounds.
	assert.throws(() => ArsenalActionBatchSchema.parse({ ...identity, thoughts: 'x', actions: [{ ...adopt, reason: '' }] }));
	assert.throws(() => ArsenalActionBatchSchema.parse({ ...identity, thoughts: 'x', actions: [{ ...adopt, reason: 'r'.repeat(241) }] }));
	// One adoption per batch.
	assert.throws(() => ArsenalActionBatchSchema.parse({ ...identity, thoughts: 'x', actions: [adopt, { ...adopt, strategyId: 'soviet-grenadier-rush' }] }));
	// Unknown fields stay rejected.
	assert.throws(() => ArsenalActionBatchSchema.parse({ ...identity, thoughts: 'x', actions: [{ ...adopt, confidence: 1 }] }));
});

test('arsenal planning accepts adopt+plan+policy and raw planning rejects adoption', () => {
	const adopt = { type: 'adoptStrategy', strategyId: 'allied-fast-boom', reason: 'Long rush distance and two mines.' };
	const accepted = ArsenalPlanningBatchSchema.parse({
		...planningIdentity, thoughts: 'opening', actions: [adopt, plan, policy]
	});
	assert.equal(accepted.actions.length, 3);

	// Raw planning stays max-2 and cannot represent adoptStrategy.
	assert.throws(() => PlanningBatchSchema.parse({ ...planningIdentity, thoughts: 'x', actions: [adopt] }));
	assert.throws(() => PlanningBatchSchema.parse({ ...planningIdentity, thoughts: 'x', actions: [plan, policy, plan] }));
	// Arsenal planning rejects duplicates of any commitment.
	assert.throws(() => ArsenalPlanningBatchSchema.parse({
		...planningIdentity, thoughts: 'x',
		actions: [adopt, { ...adopt, strategyId: 'soviet-tank-pressure' }]
	}));
});

test('decide request arsenalMode defaults off and only accepts off/menu', () => {
	const base = {
		agentId: 'a', model: 'm/x', systemPrompt: 'p', apiKey: 'use-env-key-xx',
		maxOutputTokens: 1024, decisionId: 1,
		observation: { schemaVersion: 1, sequence: 2, worldTick: 100 }
	};
	assert.equal(DecideRequestSchema.parse(base).arsenalMode, 'off');
	assert.equal(DecideRequestSchema.parse({ ...base, arsenalMode: 'menu' }).arsenalMode, 'menu');
	assert.throws(() => DecideRequestSchema.parse({ ...base, arsenalMode: 'full' }));
});

test('instructions stay clean without arsenal and gain ordered sections with it', () => {
	const bare = buildInstructions('Fight well.', 'KNOWLEDGE', 'live');
	assert.ok(!bare.includes('ARSENAL MENU'));
	assert.ok(!bare.includes('SITUATION MANUAL'));
	assert.ok(bare.startsWith(StaticPrimer));

	const manual = renderSituationManualIndex(StrategyArsenal);
	const menu = renderArsenalMenu(StrategyArsenal, 'russia');
	const card = renderStrategyCard(StrategyArsenal, 'soviet-tank-pressure');
	const armed = buildInstructions('Fight well.', 'KNOWLEDGE', 'live', { manual, menu, card });

	const manualAt = armed.indexOf('SITUATION MANUAL');
	const menuAt = armed.indexOf('ARSENAL MENU');
	const commanderAt = armed.indexOf('COMMANDER PROMPT');
	const cardAt = armed.indexOf('ADOPTED STRATEGY');
	assert.ok(manualAt > 0 && menuAt > manualAt && commanderAt > menuAt && cardAt > commanderAt,
		'sections must order manual < menu < commander < card');

	// The arsenal planning primer replaces (never joins) the raw one.
	const rawPlanning = buildInstructions('Fight well.', 'K', 'planning');
	assert.ok(rawPlanning.includes(PlanningPrimer));
	assert.ok(!rawPlanning.includes('at most THREE actions'));
	const arsenalPlanning = buildInstructions('Fight well.', 'K', 'planning', { menu, manual });
	assert.ok(arsenalPlanning.includes(ArsenalPlanningPrimer));
	assert.ok(!arsenalPlanning.includes(PlanningPrimer));
});

test('faction filter keeps only the requesting faction cards', () => {
	const sovietMenu = renderArsenalMenu(StrategyArsenal, 'russia');
	assert.ok(sovietMenu.includes('soviet-tank-pressure@'));
	assert.ok(sovietMenu.includes('soviet-grenadier-rush@'));
	assert.ok(!sovietMenu.includes('allied-e3-mass@'));
	const alliedMenu = renderArsenalMenu(StrategyArsenal, 'england');
	assert.ok(alliedMenu.includes('allied-e3-mass@'));
	assert.ok(!alliedMenu.includes('soviet-grenadier-rush@'));
});

test('relevant slices carry active situations, counter rows, and the byte bound', () => {
	const slices = selectRelevantSlices(StrategyArsenal, [
		{ id: 'T3.harv', severity: 'critical', attackerClass: 'infantry' },
		{ id: 'T1.air', severity: 'critical' },
		{ id: 'E1.power', severity: 'warning' },
		{ id: 'E1.funding', severity: 'info' }
	]);
	assert.ok(slices.startsWith('RELEVANT FACTUAL SLICES'));
	assert.ok(slices.includes('[T3.harv]'));
	assert.ok(slices.includes('CAN HIT AIR'));
	assert.ok(Buffer.byteLength(slices, 'utf8') <= 4096);
	// Never a recommendation: options carry WHEN conditions, not rankings.
	assert.ok(!slices.toLowerCase().includes('recommended'));

	assert.equal(selectRelevantSlices(StrategyArsenal, []), '');
});
