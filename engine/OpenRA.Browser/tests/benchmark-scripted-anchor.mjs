// Versioned deterministic benchmark anchor. It deliberately uses the ordinary LLM-seat
// ActionBatch contract so it receives the same frozen observation and decision opportunity
// as its opponent. It is not an engine opponentBot and never contacts a provider.
import { canonicalJson, sha256 } from './benchmark-calibration-lib.mjs';

export const BenchmarkAnchorModelId = 'benchmark-anchor/normal';
export const BenchmarkAnchorDifficulty = 'normal';
export const BenchmarkAnchorPolicyVersion = 1;

function deepFreeze(value) {
	if (value == null || typeof value !== 'object' || Object.isFrozen(value))
		return value;

	for (const child of Object.values(value))
		deepFreeze(child);
	return Object.freeze(value);
}

export const BenchmarkAnchorPolicyDescriptor = deepFreeze({
	modelId: BenchmarkAnchorModelId,
	difficulty: BenchmarkAnchorDifficulty,
	policyVersion: BenchmarkAnchorPolicyVersion,
	planning: {
		actions: 'no-op',
		rationale: 'faction-neutral live production avoids invalid cross-faction build plans'
	},
	production: {
		structurePreference: ['powr', 'apwr', 'proc', 'barr', 'tent', 'weap', 'dome', 'fix', 'afld'],
		infantryPreference: ['e1', 'e3', 'dog', 'e2', 'spy', 'thf'],
		vehiclePreference: ['3tnk', '2tnk', '1tnk', 'v2rl', 'arty', 'jeep', 'apc'],
		desiredStructureCount: {
			powr: 2,
			apwr: 1,
			proc: 2,
			barr: 1,
			tent: 1,
			weap: 1,
			dome: 1,
			fix: 1,
			afld: 1
		},
		structureBatchSize: 1,
		unitBatchSize: 3,
		actionCap: 11,
		queueMode: false,
		tieBreak: 'producer id, then configured preference order, then lexical buildable id'
	},
	combat: {
		deployFirst: true,
		idleUnitsOnly: true,
		actorCap: 64,
		visibleEnemyTieBreak: 'actor id',
		patrol: {
			centerRounding: 'floor',
			centerDivisor: 2,
			phaseSource: 'decisionId',
			phaseOffsets: [[0, -1], [1, 0], [0, 1], [-1, 0]],
			offsetSpan: 'minimum map dimension',
			minimumOffset: 2,
			mapSpanDivisor: 8
		}
	},
	maximumActions: 12
});

export function benchmarkAnchorPolicyDigest(descriptor = BenchmarkAnchorPolicyDescriptor) {
	return sha256(canonicalJson(descriptor));
}

export const BenchmarkAnchorPolicyDigest = benchmarkAnchorPolicyDigest();
export const BenchmarkAnchorSpec = Object.freeze({
	modelId: BenchmarkAnchorModelId,
	difficulty: BenchmarkAnchorDifficulty,
	policyVersion: BenchmarkAnchorPolicyVersion,
	policyDigest: BenchmarkAnchorPolicyDigest
});

export function isBenchmarkAnchorModel(model) {
	return model === BenchmarkAnchorModelId;
}

function batch(input, actions, thoughts) {
	return {
		schemaVersion: 1,
		decisionId: input.decisionId,
		observedSequence: input.observation.sequence,
		observedWorldTick: input.observation.worldTick,
		thoughts,
		memo: `anchor=${BenchmarkAnchorPolicyVersion};digest=${BenchmarkAnchorPolicyDigest.slice(0, 12)}`,
		actions
	};
}

function capability(actor, name) {
	return Array.isArray(actor.capabilities) && actor.capabilities.includes(name);
}

function selfActors(observation) {
	return (observation.actors ?? []).filter(actor => actor.relationship === 'self')
		.sort((a, b) => a.actorId - b.actorId);
}

function productionActions(observation) {
	const actions = [];
	const actors = selfActors(observation);
	const policy = BenchmarkAnchorPolicyDescriptor.production;
	const typeCounts = new Map();
	for (const actor of actors)
		typeCounts.set(actor.type, (typeCounts.get(actor.type) ?? 0) + 1);

	for (const queue of [...(observation.productionQueues ?? [])].sort((a, b) => a.producerId - b.producerId)) {
		const completed = (queue.items ?? []).find(item => item.done === true && item.placeable === true);
		if (completed != null) {
			actions.push({ type: 'placeBuildingAuto', producerId: queue.producerId, item: completed.item });
			continue;
		}
		if ((queue.items ?? []).length > 0)
			continue;
		const buildable = new Set(queue.buildableItems ?? []);
		const neededStructure = policy.structurePreference.find(item => buildable.has(item) &&
			(typeCounts.get(item) ?? 0) < (policy.desiredStructureCount[item] ?? 0));
		const preferred = neededStructure ?? policy.infantryPreference.find(item => buildable.has(item)) ??
			policy.vehiclePreference.find(item => buildable.has(item)) ?? [...buildable].sort()[0];
		if (preferred != null) {
			actions.push({
				type: 'startProduction',
				producerId: queue.producerId,
				item: preferred,
				count: policy.structurePreference.includes(preferred) ?
					policy.structureBatchSize : policy.unitBatchSize,
				queued: policy.queueMode
			});
		}
	}
	return actions;
}

function combatAction(input) {
	const observation = input.observation;
	const actors = selfActors(observation);
	const policy = BenchmarkAnchorPolicyDescriptor.combat;
	const deployable = actors.find(actor => capability(actor, 'deploy'));
	if (policy.deployFirst && deployable != null)
		return { type: 'deploy', actorIds: [deployable.actorId] };

	const combat = actors.filter(actor => (!policy.idleUnitsOnly || actor.idle === true) &&
		capability(actor, 'attackMove')).slice(0, policy.actorCap);
	if (combat.length === 0)
		return null;
	const visibleEnemy = (observation.actors ?? []).filter(actor => actor.relationship === 'enemy')
		.sort((a, b) => a.actorId - b.actorId)[0];
	const attackers = combat.filter(actor => capability(actor, 'attack'));
	if (visibleEnemy != null && attackers.length > 0) {
		return {
			type: 'attack',
			actorIds: attackers.map(actor => actor.actorId),
			targetActorId: visibleEnemy.actorId,
			queued: false
		};
	}

	const roundCenter = Math[policy.patrol.centerRounding];
	if (typeof roundCenter !== 'function' || policy.patrol.phaseSource !== 'decisionId' ||
		policy.patrol.offsetSpan !== 'minimum map dimension')
		throw new Error('unsupported scripted anchor patrol policy');
	const centerX = roundCenter((observation.mapMinX + observation.mapMaxX) /
		policy.patrol.centerDivisor);
	const centerY = roundCenter((observation.mapMinY + observation.mapMaxY) /
		policy.patrol.centerDivisor);
	const phase = Number(input[policy.patrol.phaseSource]) % policy.patrol.phaseOffsets.length;
	const mapSpan = Math.min(
		observation.mapMaxX - observation.mapMinX,
		observation.mapMaxY - observation.mapMinY);
	const offset = Math.max(policy.patrol.minimumOffset,
		Math.floor(mapSpan / policy.patrol.mapSpanDivisor));
	const patrolPhase = policy.patrol.phaseOffsets[phase];
	return {
		type: 'attackMove',
		actorIds: combat.map(actor => actor.actorId),
		cellX: centerX + patrolPhase[0] * offset,
		cellY: centerY + patrolPhase[1] * offset,
		queued: false
	};
}

export function scriptedAnchorDecision(input) {
	if (!isBenchmarkAnchorModel(input?.model))
		throw new Error(`unsupported scripted anchor model '${input?.model}'`);
	if (input.phase === 'planning') {
		return {
			batch: batch(input, [], 'Pinned anchor keeps planning faction-neutral and acts from the live frozen state.'),
			usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 },
			attempts: [{ label: 'strict', durationMs: 0, outcome: 'ok', finishReason: 'scripted-anchor',
				reasoningTokens: 0, outputBytes: 0 }],
			durationMs: 0,
			anchor: BenchmarkAnchorSpec
		};
	}

	const actions = productionActions(input.observation)
		.slice(0, BenchmarkAnchorPolicyDescriptor.production.actionCap);
	const combat = combatAction(input);
	if (combat != null) actions.push(combat);
	return {
		batch: batch(input, actions.slice(0, BenchmarkAnchorPolicyDescriptor.maximumActions),
			'Pinned normal anchor executes deterministic economy and combat priorities.'),
		usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 },
		attempts: [{ label: 'strict', durationMs: 0, outcome: 'ok', finishReason: 'scripted-anchor',
			reasoningTokens: 0, outputBytes: 0 }],
		durationMs: 0,
		anchor: BenchmarkAnchorSpec
	};
}
