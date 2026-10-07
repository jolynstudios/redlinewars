// Copyright (c) The OpenRA Developers and Contributors
// PR3 gate: needsDecision wake framework. The executor surfaces the consequential offensive/phase
// decisions to the model (armyIdle / phaseReady) with non-ranked suggestedOptions, and deliberately
// does NOT launch the strike itself — targeting and commitment stay the model's, measured play.
// Usage: node doctrine-pr3-gate.mjs  (from OpenRA.Browser/tests)

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

// 1) Pure wake helpers exist in the dependency-free decision layer.
const executorCs = read('AgentMode/AgentDoctrineExecutor.cs');
for (const sym of ['NeedsDecisionWake', 'ArmyReadyForOrders', 'SuggestedOptionsFor']) {
	if (!executorCs.includes(sym))
		fail(`executor must expose ${sym}`);
}
const executorCode = executorCs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
if (executorCode.includes('new Order(') || /\bWorld\b/.test(executorCode))
	fail('wake helpers must stay pure (no World, no Order)');
ok('executor exposes pure needsDecision wake helpers');

// 2) Controller wires the wakes into Observe (no more null placeholder) with non-ranked options.
const controllerCs = read('AgentMode/AgentDoctrineController.cs');
if (!controllerCs.includes('AgentDoctrineExecutor.NeedsDecisionWake'))
	fail('Observe must populate needsDecision via the wake helper');
if (!controllerCs.includes('AgentDoctrineExecutor.SuggestedOptionsFor'))
	fail('Observe must surface non-ranked suggestedOptions for the wake');
if (!controllerCs.includes('KnownEnemyStructureCount') || !controllerCs.includes('HasActiveOffensiveMission'))
	fail('progress facts must carry contact + offensive-mission state for armyIdle');
ok('controller wakes the model for offensive/phase decisions');

// 3) Host feeds the contact + offensive-mission facts.
const hostCs = read('AgentMode/AgentModeHost.cs');
if (!/HasActiveOffensiveMission\s*=/.test(hostCs))
	fail('host must compute HasActiveOffensiveMission from live missions');
ok('host computes the facts the wakes need');

// 4) Benchmark honesty: the host does NOT auto-launch an offensive; the model must commit. Guard
//    against a future host "strikeMain" auto-emission sneaking in under this framework.
if (hostCs.includes('"doctrine-strike"'))
	fail('PR3 keeps offensive commitment with the model: host must not auto-launch a doctrine strike');
ok('offensive commitment stays a model decision (no host auto-strike)');

// 5) Deterministic coverage for the new wake logic.
const testCs = readFileSync(path.join(repo, 'OpenRA.Test/Browser/AgentDoctrineExecutorTest.cs'), 'utf8');
for (const sym of ['NeedsDecisionWake', 'ArmyReadyForOrders', 'SuggestedOptionsFor']) {
	if (!testCs.includes(sym))
		fail(`NUnit must cover ${sym}`);
}
ok('wake helpers have deterministic NUnit coverage');

if (!existsSync(path.join(root, 'AgentMode/AgentDoctrineExecutor.cs')))
	fail('missing executor');

console.log('\nPR3 doctrine needsDecision gate passed.');
