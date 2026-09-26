// Synthetic regression for structured mission telemetry. This never boots a
// browser or contacts a model provider; it exercises the same JSONL contract
// the live match runner writes.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const metricsScript = path.join(testsDir, 'a2a-metrics.mjs');
const root = mkdtempSync(path.join(tmpdir(), 'openra-a2a-missions-'));

const run = (name, entries, outcome) => {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, 'log.jsonl'), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
	if (outcome != null)
		writeFileSync(path.join(dir, 'outcome.json'), JSON.stringify(outcome));
	const result = spawnSync(process.execPath, [metricsScript, dir], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return JSON.parse(readFileSync(path.join(dir, 'metrics.json'), 'utf8'));
};

try {
	const report = run('instrumented', [
		{ t: '2026-07-17T00:00:00.000Z', kind: 'booted', model1: 'model/a', model2: 'model/b' },
		{ t: '2026-07-17T00:00:00.100Z', kind: 'bubble', agent: 'agent1',
			text: "Result — decision 1\n1. attackMove: rejected — group 'main' does not exist or has no live actors" },
		{ t: '2026-07-17T00:00:00.200Z', kind: 'bubble', agent: 'agent1',
			text: 'Result — decision 2\n1. assignGroup: accepted; exact guided repair' },
		{ t: '2026-07-17T00:00:01.000Z', kind: 'mission-instrumentation', agent: 'agent1', available: true },
		{ t: '2026-07-17T00:00:01.000Z', kind: 'mission-instrumentation', agent: 'agent2', available: true },
		{ kind: 'mission', agent: 'agent1', sequence: 1, worldTick: 100, missionId: 'push', missionVersion: 1,
			missionType: 'strike', eventKind: 'planned', state: 'planned', reason: 'accepted' },
		{ kind: 'mission', agent: 'agent1', sequence: 2, worldTick: 150, missionId: 'push', missionVersion: 1,
			missionType: 'strike', eventKind: 'staging', state: 'staging', reason: 'moving' },
		{ kind: 'mission', agent: 'agent1', sequence: 3, worldTick: 200, missionId: 'push', missionVersion: 1,
			missionType: 'strike', eventKind: 'replaced', state: 'staging', reason: 'replaced by push v2' },
		{ kind: 'mission', agent: 'agent1', sequence: 4, worldTick: 201, missionId: 'push', missionVersion: 2,
			missionType: 'strike', eventKind: 'planned', state: 'planned', reason: 'accepted' },
		{ kind: 'mission', agent: 'agent1', sequence: 5, worldTick: 300, missionId: 'push', missionVersion: 2,
			missionType: 'strike', eventKind: 'engaging', state: 'engaging', reason: 'visible enemy contact near strike force' },
		{ kind: 'mission', agent: 'agent1', sequence: 6, worldTick: 500, missionId: 'push', missionVersion: 2,
			missionType: 'strike', eventKind: 'completed', state: 'completed', reason: 'target area consolidated',
			source: 'terminal-state-stash' },
		{ kind: 'mission', agent: 'agent2', sequence: 1, worldTick: 120, missionId: 'sweep', missionVersion: 1,
			missionType: 'sweep', eventKind: 'planned', state: 'planned', reason: 'accepted' },
		// Duplicate sequence is ignored even if a concatenated log repeats a poll.
		{ kind: 'mission', agent: 'agent2', sequence: 1, worldTick: 120, missionId: 'sweep', missionVersion: 1,
			missionType: 'sweep', eventKind: 'planned', state: 'planned', reason: 'accepted' },
		{ kind: 'mission', agent: 'agent2', sequence: 2, worldTick: 250, missionId: 'sweep', missionVersion: 1,
			missionType: 'sweep', eventKind: 'aborted', state: 'aborted', reason: 'no remaining units' }
	]);

	const agent1 = report.agents.find(agent => agent.agent === 'agent1');
	const agent2 = report.agents.find(agent => agent.agent === 'agent2');
	assert.deepEqual(agent1.missions, {
		queued: 2, completed: 1, aborted: 0, replaced: 1,
		missionChurn: 0.5, timeToFirstContactTicks: 300
	});
	assert.equal(agent1.missionTelemetryComplete, true);
	assert.deepEqual(agent2.missions, {
		queued: 1, completed: 0, aborted: 1, replaced: 0,
		missionChurn: 1, timeToFirstContactTicks: null
	});
	assert.equal(agent2.missionTelemetryComplete, true);
	assert.equal(report.match.missionTelemetryComplete, true);
	assert.equal(report.match.timeToFirstContactTicks, 300);
	assert.equal(agent1.rejectionRecoveryOpportunities, 1);
	assert.equal(agent1.rejectionRecoveries, 1);
	assert.equal(agent1.rejectionRecoveryRate, 100);

	const incomplete = run('incomplete', [
		{ t: '2026-07-17T00:00:00.000Z', kind: 'booted', model1: 'model/a', model2: 'model/b' },
		{ kind: 'mission-instrumentation', agent: 'agent1', available: true },
		{ kind: 'mission', agent: 'agent1', sequence: 1, worldTick: 100, missionId: 'push', missionVersion: 1,
			missionType: 'strike', eventKind: 'planned', state: 'planned', reason: 'accepted' },
		{ kind: 'mission-telemetry-error', agent: 'agent1', issue: 'sequence-gap',
			text: 'expected sequence 2, received 3' },
		{ kind: 'mission', agent: 'agent1', sequence: 3, worldTick: 200, missionId: 'push', missionVersion: 1,
			missionType: 'strike', eventKind: 'engaging', state: 'engaging', reason: 'visible enemy contact' },
		{ kind: 'mission-telemetry-error', agent: 'agent2', issue: 'invalid-batch', text: 'host error' }
	]);
	const incomplete1 = incomplete.agents.find(agent => agent.agent === 'agent1');
	const incomplete2 = incomplete.agents.find(agent => agent.agent === 'agent2');
	assert.equal(incomplete1.missionTelemetryComplete, false);
	assert.equal(incomplete1.missions, null);
	assert.equal(incomplete2.missionTelemetryComplete, false);
	assert.equal(incomplete2.missions, null);
	assert.equal(incomplete.match.missionTelemetryComplete, false);
	assert.equal(incomplete.match.timeToFirstContactTicks, null);

	const legacy = run('legacy', [
		{ t: '2026-07-17T00:00:00.000Z', kind: 'booted', model1: 'model/a', model2: 'model/b' },
		{ t: '2026-07-17T00:00:01.000Z', kind: 'bubble', agent: 'agent1', text: 'No-op — legacy turn' }
	]);
	assert.equal(legacy.agents[0].missions, null);
	assert.equal(legacy.agents[0].missionTelemetryComplete, null);
	assert.equal(legacy.match.missionTelemetryComplete, null);
	assert.equal(legacy.match.timeToFirstContactTicks, null);

	// Decision-accounting honesty (defect 1): rejected-batch and model-failed turns are
	// counted as decision outcomes — the no-op floor that used to vanish off-scorecard —
	// and validDecisionRate is the share that reached a per-action host verdict batch.
	const decisions = run('decisions', [
		{ t: '2026-07-17T00:00:00.000Z', kind: 'booted', model1: 'model/a', model2: 'model/b' },
		{ t: '2026-07-17T00:00:00.100Z', kind: 'bubble', agent: 'agent1', text: 'Result \u2014 decision 1\n1. startProduction: accepted' },
		{ t: '2026-07-17T00:00:00.200Z', kind: 'bubble', agent: 'agent1', text: 'Result \u2014 decision 2\n1. attackMove: accepted' },
		{ t: '2026-07-17T00:00:00.300Z', kind: 'bubble', agent: 'agent1', text: 'Rejected batch \u2014 decision 3Batch rejected: irrelevant host rejection' },
		{ t: '2026-07-17T00:00:00.400Z', kind: 'bubble', agent: 'agent1', text: 'Model failed \u2014 decision 4OpenRouter reported insufficient credit; this turn is a no-op.' },
		{ t: '2026-07-17T00:00:00.500Z', kind: 'bubble', agent: 'agent1', text: 'Model failed \u2014 decision 5upstream timed out' }
	]);
	const d1 = decisions.agents.find(agent => agent.agent === 'agent1');
	assert.equal(d1.resultBatches, 2);
	assert.equal(d1.rejectedBatches, 1);
	assert.equal(d1.modelFailures, 2);
	// Rejected/failed are surfaced via their own counters + validDecisionRate; they
	// are deliberately kept OUT of decisions/noOps so existing rates stay unperturbed.
	assert.equal(d1.decisions, 2);
	assert.equal(d1.noOps, 0);
	// validDecisionRate = 2 result batches / (2 + 1 rejected + 2 failed) = 40%.
	assert.equal(d1.validDecisionRate, 40);

	// Purity honesty (defect 2): an outcome that stamps pureGeneralValid true while an
	// autonomous host-combat counter fired (structure-defense backstop) must still read
	// impure on the scorecard, and the counter must be surfaced.
	const general = run('generalship', [
		{ t: '2026-07-17T00:00:00.000Z', kind: 'booted', model1: 'model/a', model2: 'model/b', executor: true },
		{ t: '2026-07-17T00:00:00.100Z', kind: 'bubble', agent: 'agent1', text: 'Result \u2014 decision 1\n1. commitIntent: accepted' },
		{ t: '2026-07-17T00:00:00.100Z', kind: 'bubble', agent: 'agent2', text: 'Result \u2014 decision 1\n1. commitIntent: accepted' }
	], {
		winner: null,
		generalship: [
			{ agentId: 'agent1', hostEmergencyRallyOrders: 0, hostStructureDefenseOrders: 4,
				hostProactiveEngageOrders: 0, hostCompiledStrikeCount: 2, hostCompiledDisengageCount: 1,
				modelCommitIntentCount: 3, pureGeneralValid: true },
			{ agentId: 'agent2', hostEmergencyRallyOrders: 0, hostStructureDefenseOrders: 0,
				hostProactiveEngageOrders: 0, hostCompiledStrikeCount: 1, hostCompiledDisengageCount: 0,
				modelCommitIntentCount: 5, pureGeneralValid: true }
		]
	});
	const g1 = general.agents.find(agent => agent.agent === 'agent1');
	const g2 = general.agents.find(agent => agent.agent === 'agent2');
	assert.equal(g1.generalship.hostStructureDefenseOrders, 4);
	assert.equal(g1.generalship.autonomousHostCombat, 4);
	assert.equal(g1.generalship.hostCompiledDisengageCount, 1);
	assert.equal(g1.generalship.pureGeneralValid, false);
	assert.equal(g2.generalship.autonomousHostCombat, 0);
	assert.equal(g2.generalship.pureGeneralValid, true);

	console.log('A2A mission metrics fixture: PASS');
} finally {
	rmSync(root, { recursive: true, force: true });
}
