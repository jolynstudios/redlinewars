// Copyright (c) The OpenRA Developers and Contributors
// PR2 gate: standing doctrine execution (scout + bounded stream + squad maintain) behind the
// executor flag, with source=doctrine attribution and cleanup on strategy switch. Deterministic
// source-structure checks only; behaviour is covered by OpenRA.Test/Browser/AgentDoctrineExecutorTest.
// Usage: node doctrine-pr2-gate.mjs  (from OpenRA.Browser/tests)

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

// 1) Pure decision layer exists and stays free of engine/browser dependencies so it is unit
//    testable and can never smuggle order emission past the controller gate.
const executorRel = 'AgentMode/AgentDoctrineExecutor.cs';
if (!existsSync(path.join(root, executorRel)))
	fail(`missing ${executorRel}`);
const executorCs = read(executorRel);
// usings are never in comments, so check them against the raw source.
for (const banned of ['using OpenRA.Mods', 'using OpenRA.Platforms', 'using OpenRA.Traits']) {
	if (executorCs.includes(banned))
		fail(`executor must stay pure: found "${banned}"`);
}
// Code-pattern checks ignore comments so prose (e.g. "never touches the World") can't false-trip them.
const executorCode = executorCs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
if (executorCode.includes('new Order('))
	fail('executor must stay pure: constructs OpenRA Order objects');
if (/\bWorld\b/.test(executorCode))
	fail('executor must not reference World (keep it pure/unit-testable)');
for (const sym of ['StreamQuantity', 'ShouldLaunchScout', 'PhaseHasStanding']) {
	if (!executorCs.includes(sym))
		fail(`executor must expose ${sym}`);
}
ok('AgentDoctrineExecutor is a pure, dependency-free decision layer');

// 2) IR carries the stream bounds the executor needs.
const programCs = read('AgentMode/AgentDoctrineProgram.cs');
if (!programCs.includes('StreamMaxConcurrent') || !programCs.includes('StreamBatchCount'))
	fail('IR must define StreamMaxConcurrent and StreamBatchCount stream bounds');
ok('IR defines stream concurrency/batch bounds');

// 3) Host runs a doctrine tick, gated by the executor flag, that emits standing behaviours.
const hostCs = read('AgentMode/AgentModeHost.cs');
if (!hostCs.includes('static void TickDoctrine('))
	fail('host must define TickDoctrine');
if (!hostCs.includes('TickDoctrine(slot, world)'))
	fail('TickDoctrine must be wired into the per-slot Tick loop');
if (!/TickDoctrine[\s\S]{0,400}doctrineExecutorEnabled/.test(hostCs))
	fail('TickDoctrine must gate on doctrineExecutorEnabled');
if (!hostCs.includes('"doctrine-scout"'))
	fail('host must launch a standing doctrine scout sweep (doctrine-scout mission id)');
if (!hostCs.includes('MaintainDoctrineSquads') || !hostCs.includes('StreamDoctrineUnits') ||
	!hostCs.includes('LaunchDoctrineScout'))
	fail('host must implement maintainSquads + scoutSweep + streamUnits standing behaviours');
// The stream must throttle re-issue across the order-latency window, or it overshoots the
// concurrency cap / cash reserve and over-plays for the model. Lock the cooldown guard.
if (!hostCs.includes('StreamNextTick') || !hostCs.includes('DoctrineStreamCooldownTicks'))
	fail('stream must track a per-unit cooldown so order latency cannot cause over-issue');
// Doctrine stream production must not block the model authoring its own build plan.
if (!/managedByDoctrineStream/.test(hostCs))
	fail('unmanaged-production check must tolerate doctrine-streamed units (model keeps build-plan authoring)');
ok('host TickDoctrine emits scout + stream + squad-maintain behind the executor flag');
ok('stream is latency-throttled and does not block model build-plan authoring');

// 4) Cleanup on strategy switch so a stale sweep does not run under a new card.
if (!hostCs.includes('CleanupDoctrineStanding'))
	fail('host must define CleanupDoctrineStanding');
if (!/StrategyId != action\.StrategyId[\s\S]{0,120}CleanupDoctrineStanding/.test(hostCs))
	fail('adoptStrategy must tear down standing doctrine when the card actually changes');
ok('strategy switch tears down standing doctrine');

// 5) Attribution: every doctrine emission is recorded (source=doctrine) and a doctrine telemetry
//    kind exists, so the scorecard can separate host-driven from model-driven play.
if (!hostCs.includes('AgentDoctrineController.RecordAction'))
	fail('host must attribute doctrine emissions via RecordAction (source=doctrine)');
if (!/or "doctrine"/.test(hostCs))
	fail('telemetry whitelist must accept the doctrine kind for attribution');
const contractsCs = read('AgentMode/AgentModeContracts.cs');
if (!contractsCs.includes('AgentDoctrineActionRecord'))
	fail('contracts must define AgentDoctrineActionRecord');
if (!/class AgentDoctrineObservation[\s\S]{0,1500}RecentActions/.test(contractsCs))
	fail('AgentDoctrineObservation must surface RecentActions for attribution + transparency');
ok('doctrine emissions are attributed (RecentActions + doctrine telemetry kind)');

// 6) Controller tracks standing state but still never constructs orders (PR1 invariant holds).
const controllerCs = read('AgentMode/AgentDoctrineController.cs');
if (!controllerCs.includes('RecordAction') || !controllerCs.includes('ScoutMissionVersion'))
	fail('controller must track standing action log + scout mission version');
if (/new Order\(/.test(controllerCs))
	fail('PR1 invariant: doctrine controller must never construct OpenRA Order objects');
ok('controller holds standing state without emitting orders');

// 7) Deterministic unit coverage is wired: the pure layer is source-linked into OpenRA.Test.
const testRel = 'OpenRA.Test/Browser/AgentDoctrineExecutorTest.cs';
if (!existsSync(path.join(repo, testRel)))
	fail(`missing ${testRel}`);
const testCsproj = readFileSync(path.join(repo, 'OpenRA.Test/OpenRA.Test.csproj'), 'utf8');
if (!testCsproj.includes('AgentDoctrineExecutor.cs'))
	fail('OpenRA.Test must source-link AgentDoctrineExecutor.cs for deterministic unit tests');
ok('pure decision layer has deterministic NUnit coverage');

console.log('\nPR2 doctrine executor gate passed.');
