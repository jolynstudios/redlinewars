// Regression tests for work-graph-runner.mjs.
//
// This file never boots a browser, never starts a sidecar and cannot contact a
// model provider. It writes only into a temp directory it removes afterwards.
//
// The spend-safety cases are the point of this file. A graph is the one place an
// agent could smuggle `match-runner --execute` past review, so every rejection
// below is load-bearing rather than defensive tidiness.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGate, probeTiers } from './work-graph-runner.mjs';

// The schema/CLI suite always runs; --run adds the ledger suite on top. Each
// graph node names the mode it gates on, so a node cannot pass on someone
// else's checks.
const mode = process.argv[2] ?? '--plan';
if (!['--plan', '--run'].includes(mode)) {
	console.error(`unknown mode '${mode}'; expected --plan or --run`);
	process.exit(2);
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(testsDir, 'work-graph-runner.mjs');
const realGraph = path.join(testsDir, 'work-graph.json');

let checks = 0;
const failures = [];

function ok(message) {
	checks++;
	console.log(`ok: ${message}`);
}

function fail(message) {
	failures.push(message);
	console.log(`FAIL: ${message}`);
}

function expect(condition, message) {
	if (condition) ok(message);
	else fail(message);
}

function run(args) {
	const result = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8' });
	return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const scratch = mkdtempSync(path.join(tmpdir(), 'work-graph-test-'));

function graphWith(mutate) {
	const graph = {
		schemaVersion: 1,
		graphId: 'fixture',
		ledger: 'work-graph/ledger.json',
		terminal: 'AAA-02',
		defaults: { retryBudget: 2 },
		nodes: [
			{
				id: 'AAA-01', title: 'first', owner: 'codex', spend: 'none', tier: 0, deps: [],
				rationale: ['because'],
				gate: { argv: ['node', 'alpha-gate.mjs'], strength: 'unit' }
			},
			{
				id: 'AAA-02', title: 'second', owner: 'claude', spend: 'none', tier: 0, deps: ['AAA-01'],
				rationale: ['because'],
				gate: { argv: ['node', 'beta-gate.mjs'], strength: 'artifact' }
			}
		]
	};
	mutate(graph);
	const file = path.join(scratch, `graph-${checks}-${failures.length}-${Math.abs(JSON.stringify(graph).length)}.json`);
	writeFileSync(file, JSON.stringify(graph, null, 1));
	return file;
}

function rejects(description, mutate) {
	const file = graphWith(mutate);
	const result = run(['--graph', file, '--plan']);
	expect(result.code === 2, `rejects ${description} (exit 2)`);
}

try {
	// --- the real graph must be well formed -------------------------------
	const real = run(['--graph', realGraph, '--plan']);
	expect(real.code === 0, 'the checked-in work-graph.json validates');
	let document = null;
	try {
		document = JSON.parse(real.stdout);
	} catch {
		fail('--plan emits a single parseable JSON document');
	}
	if (document !== null) {
		ok('--plan emits a single parseable JSON document');
		expect(document.frontier.every(node => node.spend !== 'provider'),
			'no provider node ever appears as dispatchable on the frontier');
		expect(document.frontier.every(node => typeof node.gate === 'string' && node.gate.length > 0),
			'every frontier entry carries a runnable gate command');
	}

	// --- schema ------------------------------------------------------------
	rejects('an unknown top-level key', graph => { graph.mystery = true; });
	rejects('an unknown node key', graph => { graph.nodes[0].status = 'landed'; });
	rejects('a malformed node id', graph => { graph.nodes[0].id = 'nope'; });
	rejects('an unknown owner', graph => { graph.nodes[0].owner = 'somebody'; });
	rejects('an unknown spend class', graph => { graph.nodes[0].spend = 'cheap'; });
	rejects('a node with no rationale', graph => { graph.nodes[0].rationale = []; });
	rejects('a dangling dependency', graph => { graph.nodes[0].deps = ['ZZZ-99']; });
	rejects('a dependency cycle', graph => { graph.nodes[0].deps = ['AAA-02']; });
	rejects('a terminal that does not exist', graph => { graph.terminal = 'ZZZ-99'; });

	// --- spend safety ------------------------------------------------------
	rejects('a gate that passes --execute',
		graph => { graph.nodes[0].gate.argv = ['node', 'benchmark-sweep-runner.mjs', '--execute']; });
	rejects('a gate that passes --confirm-provider-spend',
		graph => { graph.nodes[0].gate.argv = ['node', 'x-gate.mjs', '--confirm-provider-spend']; });
	rejects('a gate that passes a dollar --cap',
		graph => { graph.nodes[0].gate.argv = ['node', 'x-gate.mjs', '--cap', '5']; });
	rejects('match-runner without --dry-run',
		graph => { graph.nodes[0].gate.argv = ['node', 'match-runner.mjs', '--model1', 'a/b']; });
	rejects('benchmark-sweep-runner without a no-spend mode',
		graph => { graph.nodes[0].gate.argv = ['node', 'benchmark-sweep-runner.mjs', '--manifest', 'm.json']; });
	rejects('a gate pointed at a live sidecar',
		graph => { graph.nodes[0].gate.argv = ['node', 'x-gate.mjs', '--sidecar', 'http://127.0.0.1:4112']; });
	rejects('a shell interpreter as argv[0]',
		graph => { graph.nodes[0].gate.argv = ['sh', '-c', 'node x-gate.mjs']; });
	rejects('npm as argv[0], which would hide the real command',
		graph => { graph.nodes[0].gate.argv = ['npm', 'run', 'gates']; });

	// match-runner WITH the guard is legitimate: several gates shell out to a
	// dry run to assert CLI rejection behaviour.
	const guarded = graphWith(graph => {
		graph.nodes[0].gate.argv = ['node', 'match-runner.mjs', '--benchmark-lockstep', '--dry-run'];
	});
	expect(run(['--graph', guarded, '--plan']).code === 0, 'accepts match-runner when guarded by --dry-run');

	// --- CLI ---------------------------------------------------------------
	expect(run(['--graph', realGraph, '--plan', '--bogus']).code === 2, 'rejects an unknown flag');
	expect(run(['--graph', realGraph]).code === 2, 'rejects a missing mode');
	expect(run(['--plan']).code === 2, 'rejects a missing --graph');
	expect(run(['--graph', realGraph, '--plan', '--explain', 'INF-01']).code === 2, 'rejects two modes at once');
	expect(run(['--graph', realGraph, '--plan', '--tier', '9']).code === 2, 'rejects an out-of-range tier');
	expect(run(['--graph', path.join(scratch, 'absent.json'), '--plan']).code === 2, 'rejects an unreadable graph');

	// --- ledger ------------------------------------------------------------
	const ledgerDir = path.join(scratch, 'work-graph');
	mkdirSync(ledgerDir, { recursive: true });
	writeFileSync(path.join(ledgerDir, 'ledger.json'), '{ not json');
	const torn = graphWith(() => {});
	expect(run(['--graph', torn, '--plan']).code === 2,
		'refuses to guess at graph history when the ledger is unreadable');

	// --- explain -----------------------------------------------------------
	const explained = run(['--graph', realGraph, '--explain', 'CAL-05']);
	expect(explained.code === 0, '--explain resolves a real node');
	if (explained.code === 0) {
		const detail = JSON.parse(explained.stdout);
		expect(Array.isArray(detail.waitingOn), '--explain reports what a node is waiting on');
		expect(typeof detail.reproduce === 'string' && detail.reproduce.includes('&&'),
			'--explain prints a copy-pasteable reproduce command');
	}
	expect(run(['--graph', realGraph, '--explain', 'ZZZ-99']).code === 2, '--explain rejects an unknown node');

	// --- --run and the ledger (INF-04) --------------------------------------
	if (mode === '--run') {
		// A fixture graph whose only gate is a node one-liner, so the suite stays
		// tier-0, hermetic and free.
		const runScratch = mkdtempSync(path.join(tmpdir(), 'work-graph-run-'));
		writeFileSync(path.join(testsDir, 'work-graph-fixture-gate.mjs'),
			"console.log('ok: fixture');\nconsole.log('work graph fixture gate passed (1 checks)');\n");
		const fixture = {
			schemaVersion: 1, graphId: 'run-fixture', ledger: 'ledger.json',
			nodes: [
				{
					id: 'BBB-01', title: 'passes', owner: 'codex', spend: 'none', tier: 0, deps: [],
					rationale: ['fixture'],
					gate: {
						argv: ['node', 'work-graph-fixture-gate.mjs'], strength: 'unit',
						expectStdout: 'work graph fixture gate passed'
					}
				},
				{
					id: 'BBB-02', title: 'needs tier 3', owner: 'codex', spend: 'none', tier: 3, deps: [],
					rationale: ['fixture'],
					gate: { argv: ['node', 'work-graph-fixture-gate.mjs'], strength: 'unit' }
				},
				{
					id: 'BBB-03', title: 'never dispatched', owner: 'claude', spend: 'provider', tier: 0, deps: [],
					rationale: ['fixture'],
					gate: { argv: ['node', 'work-graph-fixture-gate.mjs'], strength: 'behavioral' }
				}
			]
		};
		const fixturePath = path.join(runScratch, 'graph.json');
		writeFileSync(fixturePath, JSON.stringify(fixture, null, 1));

		try {
			const first = run(['--graph', fixturePath, '--run', '--tier', '0']);
			expect(first.code === 0, '--run completes a clean tier-0 pass');

			const ledgerFile = path.join(runScratch, 'ledger.json');
			const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
			expect(ledger.some(entry => entry.nodeId === 'BBB-01' && entry.outcome === 'pass'),
				'a passing gate is recorded as pass');
			expect(!ledger.some(entry => entry.nodeId === 'BBB-03'),
				'a provider-spend node is never dispatched by the driver');
			expect(ledger.every(entry => entry.entryHash && entry.chainHash),
				'every ledger entry is sealed with an entry and chain hash');

			// The chain must actually chain: recomputing it from the recorded entry
			// hashes has to reproduce what is on disk, or a retroactive edit would
			// pass unnoticed.
			let previous = '';
			const chained = ledger.every(entry => {
				const expected = createHash('sha256').update(previous + entry.entryHash).digest('hex');
				previous = entry.chainHash;
				return expected === entry.chainHash;
			});
			expect(chained, 'the ledger hash chain verifies end to end');

			// Deferred and censored are different states and must not be conflated:
			// deferred is the operator declining to spend wall clock, censored is a
			// missing prerequisite. Only the latter is a fact about the environment.
			expect(!ledger.some(entry => entry.nodeId === 'BBB-02'),
				'a node above the --tier cap is deferred, not attempted');

			// Drive the censor branch directly, since whether a tier is genuinely
			// unavailable depends on the machine this runs on.
			const censored = runGate(fixture, fixture.nodes[0], { 0: { available: false, reason: 'fixture' } });
			expect(censored.outcome === 'infrastructure-censored',
				'an unavailable tier censors rather than fails, so it burns no retry');
			expect(censored.exitCode === null && censored.note === 'fixture',
				'a censored node records why the environment was unusable');

			const tiers = probeTiers();
			expect([0, 1, 2, 3].every(tier => typeof tiers[tier].available === 'boolean' &&
				(tiers[tier].available || typeof tiers[tier].reason === 'string')),
				'every tier probe reports availability and a reason when unavailable');
			expect(tiers[2].available === false || typeof tiers[2].dotnet === 'string',
				'the tier-2 probe resolves dotnet from PATH or ~/.dotnet');

			const second = run(['--graph', fixturePath, '--run', '--tier', '0']);
			expect(second.code === 2, '--run refuses to start fresh over an existing ledger');
			expect(run(['--graph', fixturePath, '--run', '--tier', '0', '--resume']).code === 0,
				'--resume continues an existing ledger');

			writeFileSync(`${ledgerFile}.lock`, '999999');
			expect(run(['--graph', fixturePath, '--run', '--tier', '0', '--resume']).code === 2,
				'a held lock stops a second driver appending to one chain');
			rmSync(`${ledgerFile}.lock`, { force: true });

			expect(run(['--graph', fixturePath, '--run', '--only', 'ZZZ-99', '--resume']).code === 2,
				'--only rejects an unknown node');

			// Retry then escalate. A failing node with budget left must come back on
			// the frontier -- that IS the fix node -- and must leave it for good once
			// the budget is gone, rather than being retried forever.
			// The marker comment puts the expected string in the gate's SOURCE without
			// printing it, so this node is verifiable-but-failing rather than
			// awaiting-work. That distinction is what this fixture is testing.
			writeFileSync(path.join(testsDir, 'work-graph-fixture-gate.mjs'),
				"// marker: a string this gate never prints\nconsole.log('ok: fixture');\n" +
				"console.log('work graph fixture gate passed (1 checks)');\n");
			const failScratch = mkdtempSync(path.join(tmpdir(), 'work-graph-fail-'));
			const failing = {
				schemaVersion: 1, graphId: 'fail-fixture', ledger: 'ledger.json',
				defaults: { retryBudget: 2 },
				nodes: [{
					id: 'CCC-01', title: 'always fails', owner: 'codex', spend: 'none', tier: 0, deps: [],
					rationale: ['fixture'],
					gate: {
						argv: ['node', 'work-graph-fixture-gate.mjs'], strength: 'unit',
						expectStdout: 'a string this gate never prints'
					}
				}]
			};
			const failPath = path.join(failScratch, 'graph.json');
			writeFileSync(failPath, JSON.stringify(failing, null, 1));
			try {
				run(['--graph', failPath, '--run', '--tier', '0']);
				const afterFirst = JSON.parse(run(['--graph', failPath, '--plan', '--tier', '0']).stdout);
				expect(afterFirst.frontier.some(node => node.id === 'CCC-01'),
					'a failed node with retry budget left returns to the frontier as a fix attempt');

				run(['--graph', failPath, '--run', '--tier', '0', '--resume']);
				const afterSecond = JSON.parse(run(['--graph', failPath, '--plan', '--tier', '0']).stdout);
				expect(afterSecond.escalated.includes('CCC-01'),
					'a node that exhausts its retry budget escalates to a human');
				expect(!afterSecond.frontier.some(node => node.id === 'CCC-01'),
					'an escalated node leaves the frontier instead of retrying forever');
			} finally {
				rmSync(failScratch, { recursive: true, force: true });
			}

			// Undone work must not masquerade as a broken gate, or the escalation
			// list fills with nodes nobody has started.
			const pendingScratch = mkdtempSync(path.join(tmpdir(), 'work-graph-pending-'));
			const pendingPath = path.join(pendingScratch, 'graph.json');
			writeFileSync(pendingPath, JSON.stringify({
				schemaVersion: 1, graphId: 'pending-fixture', ledger: 'ledger.json',
				nodes: [{
					id: 'DDD-01', title: 'not written yet', owner: 'codex', spend: 'none', tier: 0, deps: [],
					rationale: ['fixture'], planned: true,
					gate: { argv: ['node', 'a-gate-nobody-has-written.mjs'], strength: 'unit' }
				}]
			}, null, 1));
			try {
				const pendingPlan = JSON.parse(run(['--graph', pendingPath, '--plan', '--tier', '0']).stdout);
				expect(pendingPlan.counts['awaiting-work'] === 1,
					'a node whose gate script does not exist yet is awaiting work, not failing');
				expect(!pendingPlan.frontier.some(node => node.id === 'DDD-01'),
					'an awaiting-work node is not dispatched, so it burns no fix attempts');
				run(['--graph', pendingPath, '--run', '--tier', '0']);
				expect(!existsSync(path.join(pendingScratch, 'ledger.json')),
					'awaiting-work records nothing: there is no result to record');
			} finally {
				rmSync(pendingScratch, { recursive: true, force: true });
			}

			// The most dangerous bug this driver can have: a node landing on a gate
			// that passes for someone else's reasons. Three real nodes did exactly
			// this by sharing benchmark-sweep-gate.mjs, and a recorded pass then kept
			// them landed even after the check was added. A node's expectStdout must
			// appear in its gate's source, and that must be decided BEFORE any
			// recorded result is honoured.
			const borrowScratch = mkdtempSync(path.join(tmpdir(), 'work-graph-borrow-'));
			const borrowPath = path.join(borrowScratch, 'graph.json');
			writeFileSync(path.join(testsDir, 'work-graph-fixture-gate.mjs'),
				"console.log('ok: fixture');\nconsole.log('work graph fixture gate passed (1 checks)');\n");
			writeFileSync(borrowPath, JSON.stringify({
				schemaVersion: 1, graphId: 'borrow-fixture', ledger: 'ledger.json',
				nodes: [{
					id: 'EEE-01', title: 'borrows a passing gate', owner: 'codex', spend: 'none', tier: 0, deps: [],
					rationale: ['fixture'],
					gate: {
						argv: ['node', 'work-graph-fixture-gate.mjs'], strength: 'behavioral',
						expectStdout: 'OK a claim this gate never makes'
					}
				}]
			}, null, 1));
			try {
				const borrowed = JSON.parse(run(['--graph', borrowPath, '--plan', '--tier', '0']).stdout);
				expect(borrowed.counts['awaiting-work'] === 1,
					'a node cannot land on a gate that lacks an assertion specific to it');

				// Forge a pass for it, exactly as the real ledger had, and confirm the
				// forged history is still not enough to call it landed.
				writeFileSync(path.join(borrowScratch, 'ledger.json'), JSON.stringify([{
					nodeId: 'EEE-01', outcome: 'pass', inputsDigest: 'whatever',
					entryHash: 'x', chainHash: 'y'
				}], null, 1));
				const withHistory = JSON.parse(run(['--graph', borrowPath, '--plan', '--tier', '0']).stdout);
				expect(withHistory.counts['awaiting-work'] === 1,
					'a recorded pass from a gate that cannot verify the node does not land it');
			} finally {
				rmSync(borrowScratch, { recursive: true, force: true });
				rmSync(path.join(testsDir, 'work-graph-fixture-gate.mjs'), { force: true });
			}
		} finally {
			rmSync(runScratch, { recursive: true, force: true });
			rmSync(path.join(testsDir, 'work-graph-fixture-gate.mjs'), { force: true });
		}
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\nwork graph runner tests FAILED (${failures.length} of ${checks + failures.length})`);
	process.exit(1);
}
// Both success lines are spelled out rather than interpolated: the driver
// requires a node's expectStdout to appear verbatim in its gate's source, so a
// dynamically assembled banner would make this file unable to verify anything.
console.log(mode === '--run'
	? `work graph runner run tests passed (${checks} checks)`
	: `work graph runner plan tests passed (${checks} checks)`);
