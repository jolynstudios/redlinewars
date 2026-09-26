// Copyright (c) The OpenRA Developers and Contributors
// Pure generalship gate (WC-5, skill track): the model owns the war. The host has
// NO combat last-resort path — it only compiles a strike/reinforce after a model
// commitIntent — so purity telemetry (compiled counters, pureGeneralValid) is
// present while the autonomous last-resort machinery is provably absent.
// enemyAssessment observation + runner/metrics wiring are verified too.
// Usage: node generalship-pure-gate.mjs  (from OpenRA.Browser/tests)

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..');
const fail = msg => {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
};
const ok = msg => console.log(`ok: ${msg}`);
const read = rel => readFileSync(path.join(root, rel), 'utf8');

// Contracts — pure war-commit telemetry + enemyAssessment present; the assisted
// last-resort telemetry must be absent.
const contracts = read('AgentMode/AgentModeContracts.cs');
for (const sym of [
	'AgentEnemyAssessmentObservation', 'AgentWarCommitObservation',
	'HostCompiledStrikeCount', 'HostCompiledReinforceCount', 'ModelCommitIntentCount', 'DribbleAttackMoveCount'
]) {
	if (!contracts.includes(sym))
		fail(`contracts must include ${sym}`);
}
for (const banned of ['HostCombatLastResortEnabled', 'HostStrikeMainCount', 'HostSoftDisengageCount']) {
	if (contracts.includes(banned))
		fail(`contracts must NOT include last-resort telemetry ${banned} on the pure track`);
}
ok('contracts: enemyAssessment + pure war-commit telemetry (no last-resort fields)');

// Executor — commitIntent language present; no host-combat last-resort helpers.
const executor = read('AgentMode/AgentDoctrineExecutor.cs');
if (!executor.includes('commitIntent'))
	fail('executor must use commitIntent language');
for (const banned of ['MayHostCombatLastResort', 'ShouldHostStrikeMain', 'hostCombatLastResortEnabled']) {
	if (executor.includes(banned))
		fail(`executor must NOT expose last-resort helper ${banned} on the pure track`);
}
ok('executor: commitIntent language, no last-resort helpers');

// Host — publishes enemyAssessment, counts model-authored commits, compiles the war
// only after a commit; the last-resort gate/block is absent.
const host = read('AgentMode/AgentModeHost.cs');
if (!host.includes('BuildEnemyAssessment') || !host.includes('EnemyAssessment'))
	fail('host must publish enemyAssessment');
if (!host.includes('modelAuthored'))
	fail('host must distinguish model-authored commits');
if (!host.includes('HostCompiledStrikeCount') || !host.includes('HostCompiledReinforceCount'))
	fail('host must increment compiled counters after a model commit');
if (host.includes('hostCombatLastResortEnabled') || host.includes('if (hostCombatLastResortEnabled)'))
	fail('host must NOT contain a combat last-resort gate on the pure track');
ok('host: assessment + model-authored commits + compiled-only war (no last-resort gate)');

// match-runner — outcome.generalship stamps purity fields; no assisted last-resort flag.
const runner = read('tests/match-runner.mjs');
if (!runner.includes('generalship') || !runner.includes('pureGeneralValid'))
	fail('match-runner outcome must stamp generalship purity fields');
if (runner.includes('Host.HostCombatLastResort') || runner.includes('host-combat-last-resort'))
	fail('match-runner must NOT expose an assisted host-combat-last-resort flag on the pure track');
ok('match-runner: outcome.generalship purity, pure track only');

// a2a-metrics — surfaces generalship purity on scorecard/metrics.
const metrics = read('tests/a2a-metrics.mjs');
if (!metrics.includes('generalship') || !metrics.includes('pureGeneralValid'))
	fail('a2a-metrics must surface generalship purity on scorecard/metrics');
ok('a2a-metrics generalship section present');

// Sidecar primer — teaches the war compiler (model owns the war); no assisted mode.
const primer = read('agent-sidecar/src/instructions.ts');
if (!primer.includes('commitIntent') || !primer.includes('war compiler'))
	fail('primer must teach the war compiler (model opens the war via commitIntent)');
if (primer.includes('hostCombatLastResort'))
	fail('primer must NOT reference hostCombatLastResort on the pure track');
ok('sidecar primer: model owns the war (pure)');

// NUnit — the pure war compiler helpers are unit-covered.
const warTest = path.join(repo, 'OpenRA.Test/Browser/AgentWarCompilerTest.cs');
if (!existsSync(warTest))
	fail('missing OpenRA.Test/Browser/AgentWarCompilerTest.cs');
const nunit = readFileSync(warTest, 'utf8');
if (!nunit.includes('ShouldLaunchCompiledStrike') || !nunit.includes('ResolveControlPhase'))
	fail('NUnit must cover the pure war-compiler launch + phase helpers');
if (!existsSync(path.join(repo, 'OpenRA.Test/Browser/AgentDoctrineExecutorTest.cs')))
	fail('missing OpenRA.Test/Browser/AgentDoctrineExecutorTest.cs');
ok('NUnit pure war-compiler coverage present');

console.log('\nPure generalship gate passed (model owns the war; no host last-resort).');
