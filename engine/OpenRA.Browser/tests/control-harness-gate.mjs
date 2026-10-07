// Copyright (c) The OpenRA Developers and Contributors
// Control harness gate (WC-5, pure skill track): static checks that the war
// compiler is fully wired (commitIntent/reinforceIntent, controlPhase,
// legalActionTypes, compiled strike/reinforce, dribble reject, scout cap,
// metrics) AND that the autonomous host combat last-resort path is provably
// absent — the PureGeneralValid CI guard. The war compiler runs only after a
// model commitIntent; compiled counters are pure-safe, so purity never depends
// on the host opening the war on its own.
// Usage: node control-harness-gate.mjs  (from OpenRA.Browser/tests)

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

// Phase 0 — design doc + contract metric names
if (!existsSync(path.join(root, 'CONTROL-HARNESS-ADOPTION-PLAN.md')))
	fail('missing CONTROL-HARNESS-ADOPTION-PLAN.md');
ok('CONTROL-HARNESS-ADOPTION-PLAN.md present');

const contracts = read('AgentMode/AgentModeContracts.cs');
for (const sym of [
	'ControlPhase', 'LegalActionTypes', 'AgentWarCommitObservation',
	'HostCompiledStrikeCount', 'HostCompiledReinforceCount',
	'ModelCommitIntentCount', 'TimeToFirstCommitIntentTicks', 'DribbleAttackMoveCount'
]) {
	if (!contracts.includes(sym))
		fail(`contracts must include ${sym}`);
}
ok('contracts: control phase + war commit + harness metrics');

// Phase 1+2 — host war compiler + legal phase gate
const host = read('AgentMode/AgentModeHost.cs');
if (!host.includes('TickWarCompiler') || !host.includes('MaybeCompiledReinforce'))
	fail('host must TickWarCompiler + MaybeCompiledReinforce');
if (!host.includes('case "commitIntent"') || !host.includes('case "reinforceIntent"'))
	fail('host must handle commitIntent and reinforceIntent');
if (!host.includes('ControlPhase = controlPhase') || !host.includes('LegalActionsForPhase'))
	fail('host must publish controlPhase + legalActionTypes on hostTruth');
if (!host.includes('ShouldRejectDribbleCombatMove'))
	fail('host must phase-gate model actions (reject dribble combat via the compiler)');
if (!host.includes('war commit is active'))
	fail('host must reject dribble combat while war commit active');
ok('host: war compiler + phase gate + dribble reject');

const compiler = read('AgentMode/AgentWarCompiler.cs');
if (!compiler.includes('ResolveControlPhase') || !compiler.includes('ShouldLaunchCompiledStrike'))
	fail('AgentWarCompiler missing core helpers');
if (!compiler.includes('IsActionLegalInPhase') || !compiler.includes('LegalActionsForPhase'))
	fail('AgentWarCompiler must define phase-legality helpers');
if (!compiler.includes('DefaultScoutCap') || !compiler.includes('CapScoutRoster'))
	fail('AgentWarCompiler must cap scouts');
ok('AgentWarCompiler pure helpers present');

// PureGeneralValid CI guard — the four host combat last-resort counters and the
// autonomous last-resort machinery must be provably absent from the C# sources on
// this skill track. Only a model commitIntent may open the war (compiled strike /
// reinforce are pure-safe), so these counters are structurally 0 and can never
// contaminate a pure scorecard. (The lone word "strikeMain" survives only in a
// host comment documenting that this path is NOT ported; the code identifiers
// below never appear.)
const purityGuarded = `${contracts}\n${host}\n${read('AgentMode/AgentDoctrineExecutor.cs')}`;
for (const banned of [
	// the four last-resort counters
	'HostStrikeMainCount', 'HostSoftReinforceCount', 'HostSoftRegroupCount', 'HostSoftDisengageCount',
	// the enabling flag + autonomous last-resort entry points
	'hostCombatLastResortEnabled', 'HostCombatLastResortEnabled',
	'MaybeSoftReinforceAttack', 'MaybeSoftRegroup', 'MaybeSoftDisengage',
	'ShouldHostStrikeMain', 'LaunchDoctrineStrike'
]) {
	if (purityGuarded.includes(banned))
		fail(`pure guard: last-resort symbol "${banned}" must not exist on the skill track`);
}
if (!host.includes('HostCompiledStrikeCount') || !host.includes('HostCompiledReinforceCount'))
	fail('host must increment the pure-safe compiled counters (post-commit only)');
ok('pure guard: last-resort machinery absent; only compiled counters fire');

// Phase 3 — reinforceIntent + defendBase
if (!host.includes('TickWarCompilerDefendBase') || !host.includes('reinforceIntent'))
	fail('host must defendBase + reinforceIntent paths');
ok('host: reinforce + defendBase');

// Phase 4 — primer + wakes teach the war compiler
const primer = read('agent-sidecar/src/instructions.ts');
if (!primer.includes('commitIntent') || !primer.includes('war compiler'))
	fail('primer must teach commitIntent + war compiler');
if (!primer.includes('legalActionTypes'))
	fail('primer must mention legalActionTypes');
const executor = read('AgentMode/AgentDoctrineExecutor.cs');
if (!executor.includes('commitIntent'))
	fail('SuggestedOptionsFor must use commitIntent language');
ok('primer + wakes: commit language');

// Phase 5 — scout cap. The cap lives in the pure AgentWarCompiler helper
// (CapScoutRoster/DefaultScoutCap, above) and the host maintains the scout squad.
if (!host.includes('MaintainDoctrineSquads'))
	fail('host must maintain doctrine squads (scout roster)');
ok('scout roster cap available + squads maintained');

// Sidecar schemas — commitIntent/reinforceIntent live in the guided/executor union
const sideContracts = read('agent-sidecar/src/contracts.ts');
if (!sideContracts.includes("literal('commitIntent')") || !sideContracts.includes("literal('reinforceIntent')"))
	fail('sidecar Zod must include commitIntent and reinforceIntent');
ok('sidecar: commitIntent + reinforceIntent schemas');

// Metrics + runner surface the harness telemetry
const metrics = read('tests/a2a-metrics.mjs');
if (!metrics.includes('hostCompiledStrikeCount') || !metrics.includes('modelCommitIntentCount'))
	fail('a2a-metrics must surface compiled + commitIntent counts');
if (!metrics.includes('dribbleAttackMoveCount'))
	fail('a2a-metrics must surface dribble metric');
if (!metrics.includes('pureGeneralValid'))
	fail('a2a-metrics must surface pureGeneralValid purity');
const runner = read('tests/match-runner.mjs');
if (!runner.includes('hostCompiledStrikeCount') || !runner.includes('modelCommitIntentCount'))
	fail('match-runner outcome.generalship must stamp harness fields');
if (!runner.includes('pureGeneralValid'))
	fail('match-runner outcome.generalship must stamp pureGeneralValid');
ok('metrics + match-runner harness telemetry');

// NUnit — pure helper coverage + source link
const nunitPath = path.join(repo, 'OpenRA.Test/Browser/AgentWarCompilerTest.cs');
if (!existsSync(nunitPath))
	fail('missing OpenRA.Test/Browser/AgentWarCompilerTest.cs');
const nunit = readFileSync(nunitPath, 'utf8');
if (!nunit.includes('ShouldLaunchCompiledStrike') || !nunit.includes('ResolveControlPhase'))
	fail('NUnit must cover launch + phase helpers');
const csproj = readFileSync(path.join(repo, 'OpenRA.Test/OpenRA.Test.csproj'), 'utf8');
if (!csproj.includes('AgentWarCompiler.cs'))
	fail('OpenRA.Test.csproj must source-link AgentWarCompiler.cs');
ok('NUnit AgentWarCompilerTest + csproj link');

console.log('\nControl harness gate passed (war compiler wired + PureGeneralValid guard).');
