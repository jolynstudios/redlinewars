// Copyright (c) The OpenRA Developers and Contributors
// controlDoctrine gate (plan §8): the model's command surface over the bound doctrine —
// pause/resume/holdPhase/advancePhase. holdPhase is a sticky veto on auto-advance (D2);
// advancePhase takes the boundary. Arsenal-only, so the raw track's schemas stay byte-identical.
// Usage: node doctrine-control-gate.mjs  (from OpenRA.Browser/tests)

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fail = msg => {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
};
const ok = msg => console.log(`ok: ${msg}`);
const read = rel => readFileSync(path.join(root, rel), 'utf8');

// 1) Host handles the action with its own field-gate + purity validation.
const hostCs = read('AgentMode/AgentModeHost.cs');
if (!hostCs.includes('case "controlDoctrine"'))
	fail('host must handle the controlDoctrine action');
if (!hostCs.includes('HasDoctrineFields') || !hostCs.includes('ValidateDoctrineActionPurity'))
	fail('host must field-gate + purity-validate controlDoctrine');
// Executor must be on: otherwise the command would relabel observation phase without any host
// execution to control (F1). Keeps the observation-only track free of phase-walking side effects.
if (!/case "controlDoctrine"[\s\S]{0,400}doctrineExecutorEnabled/.test(hostCs))
	fail('controlDoctrine must require the executor to be on');
for (const cmd of ['pause', 'resume', 'holdPhase', 'advancePhase']) {
	if (!hostCs.includes(`"${cmd}"`))
		fail(`controlDoctrine must dispatch ${cmd}`);
}
ok('host dispatches + validates controlDoctrine commands');

// 2) Controller has the phase-hold state machine (sticky veto + manual advance).
const controllerCs = read('AgentMode/AgentDoctrineController.cs');
if (!/Held\s*{\s*get;\s*set;\s*}/.test(controllerCs))
	fail('controller must track the Held (phase veto) state');
if (!controllerCs.includes('AdvancePhase') || !controllerCs.includes('static void Hold('))
	fail('controller must expose Hold + AdvancePhase');
if (!/state\.Held\b/.test(controllerCs) || !/!autoAdvance \|\| state\.Held/.test(controllerCs))
	fail('EvaluateProgress must suppress auto-advance while Held (D2 veto)');
ok('controller phase-hold veto + manual advance wired into auto-advance');

// 3) Contracts carry the command + the observed hold flag.
const contractsCs = read('AgentMode/AgentModeContracts.cs');
if (!contractsCs.includes('DoctrineCommand') || !contractsCs.includes('PhaseHeld'))
	fail('contracts must expose DoctrineCommand (action) + PhaseHeld (observation)');
ok('contracts expose the command + PhaseHeld');

// 4) Benchmark honesty: the action is arsenal-only. It must be in ArsenalActionSchema but NOT in
//    the base AgentActionSchema union, so the raw track's provider-visible schemas stay identical.
const contractsTs = read('agent-sidecar/src/contracts.ts');
if (!contractsTs.includes('ControlDoctrineAction'))
	fail('sidecar must define ControlDoctrineAction');
if (!/ArsenalActionSchema = z\.union\(\[[\s\S]*ControlDoctrineAction/.test(contractsTs))
	fail('controlDoctrine must be added to ArsenalActionSchema');
const baseUnion = contractsTs.match(/AgentActionSchema = z\.(?:discriminatedUnion|union)\([\s\S]*?\n\]\)/);
if (!baseUnion)
	fail('could not locate the base AgentActionSchema union to verify controlDoctrine is excluded');
if (baseUnion[0].includes('controlDoctrine'))
	fail('controlDoctrine must NOT be in the base AgentActionSchema (raw track must stay byte-identical)');
ok('controlDoctrine is arsenal-only; raw track stays byte-identical');

// 5) phaseReady returns, now backed by a real order, and the primer teaches the action.
const executorCs = read('AgentMode/AgentDoctrineExecutor.cs');
if (!/phaseHeldAtBoundary/.test(executorCs) || !executorCs.includes('"phaseReady"'))
	fail('phaseReady wake must return, gated on a held boundary');
const instructions = read('agent-sidecar/src/instructions.ts');
if (!instructions.includes('controlDoctrine'))
	fail('primer must teach the controlDoctrine action');
ok('phaseReady is backed by controlDoctrine and taught in the primer');

if (!existsSync(path.join(root, 'AgentMode/AgentModeHost.cs')))
	fail('missing host');

console.log('\ncontrolDoctrine gate passed.');
