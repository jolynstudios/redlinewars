// Copyright (c) The OpenRA Developers and Contributors
// PR1 gate: doctrine IR + observation contract without executor emission.
// Usage: node doctrine-pr1-gate.mjs  (from OpenRA.Browser/tests)

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

// 1) Doctrine controller + program sources exist
for (const rel of [
	'AgentMode/AgentDoctrineController.cs',
	'AgentMode/AgentDoctrineProgram.cs',
	'AgentMode/AgentModeContracts.cs',
	'AgentMode/AgentModeHost.cs'
]) {
	const p = path.join(root, rel);
	if (!existsSync(p))
		fail(`missing ${rel}`);
	ok(`present ${rel}`);
}

const programCs = readFileSync(path.join(root, 'AgentMode/AgentDoctrineProgram.cs'), 'utf8');
if (!programCs.includes('soviet-tank-pressure'))
	fail('IR must include soviet-tank-pressure vertical slice');
if (!programCs.includes('CashReserveForPlan'))
	fail('IR must include cash reserve for plan (D5)');
if (!programCs.includes('mobilize') || !programCs.includes('pressure'))
	fail('IR must define mobilize and pressure phases');
ok('soviet-tank-pressure IR phases present');

const controllerCs = readFileSync(path.join(root, 'AgentMode/AgentDoctrineController.cs'), 'utf8');
if (!controllerCs.includes('observation-only') && !controllerCs.includes('ExecutorEnabled'))
	fail('controller must document observation-only / executor flag');
if (!controllerCs.includes('Bind(') || !controllerCs.includes('Observe('))
	fail('controller must expose Bind and Observe');
// PR1 must not issue OpenRA orders from doctrine controller
if (/\bOrder\b/.test(controllerCs) && /new Order\(/.test(controllerCs))
	fail('PR1 doctrine controller must not construct OpenRA Order objects');
ok('doctrine controller is observation-oriented');

const hostCs = readFileSync(path.join(root, 'AgentMode/AgentModeHost.cs'), 'utf8');
if (!hostCs.includes('BuildDoctrineObservation') || !hostCs.includes('Doctrine = BuildDoctrineObservation'))
	fail('hostTruth.doctrine must be wired in BuildHostTruth');
if (!hostCs.includes('AgentDoctrineController.Bind'))
	fail('adoptStrategy must bind doctrine program');
if (!hostCs.includes('doctrineExecutorEnabled'))
	fail('host must gate executor with doctrineExecutorEnabled');
if (!hostCs.includes('hostTruth.doctrine'))
	fail('contract rules must document hostTruth.doctrine');
ok('host wires doctrine observation + adopt bind');

const contractsCs = readFileSync(path.join(root, 'AgentMode/AgentModeContracts.cs'), 'utf8');
if (!contractsCs.includes('class AgentDoctrineObservation'))
	fail('AgentDoctrineObservation contract type missing');
if (!contractsCs.includes('DoctrineExecutorEnabled'))
	fail('match config must expose DoctrineExecutorEnabled');
ok('contracts include doctrine observation + flag');

const instructions = readFileSync(path.join(root, 'agent-sidecar/src/instructions.ts'), 'utf8');
if (!instructions.includes('hostTruth.doctrine'))
	fail('arsenal primer must mention hostTruth.doctrine');
if (!instructions.includes('executorEnabled=false'))
	fail('primer must state observation-only when executor off');
// Raw track: doctrine primer only under arsenal menu branch
if (!instructions.includes("if (arsenal?.menu)"))
	fail('doctrine primer must stay under arsenal?.menu so raw bytes stay pure');
ok('instructions keep doctrine text arsenal-only');

// 2) Continuity + metrics from PR0 still present
if (!hostCs.includes('IsCriticalAssetContinuity'))
	fail('PR0 MCV continuity helper missing');
const metrics = readFileSync(path.join(root, 'tests/a2a-metrics.mjs'), 'utf8');
if (!metrics.includes('groupMissing'))
	fail('PR0 groupMissing taxonomy missing from metrics');
ok('PR0 hygiene + metrics still present');

console.log('\nPR1 doctrine gate passed.');
