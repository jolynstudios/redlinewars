// Phase-2 integrated lockstep gate. Every model response comes from the local
// scripted sidecar in benchmark-lockstep-fixture.mjs; this file cannot contact
// OpenRouter or spend money.
import { spawnSync } from 'node:child_process';
import {
	assert,
	BenchmarkSpecVersion,
	createBenchmarkHarness
} from './benchmark-lockstep-fixture.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const unknown = args.filter(arg => arg !== '--headed');
if (unknown.length !== 0) {
	console.error(`Unknown argument(s): ${unknown.join(', ')}`);
	console.error('Usage: node benchmark-lockstep-gate.mjs [--headed]');
	process.exit(2);
}

function assertMainScenario(result) {
	assert(result.pageErrors.length === 0,
		`${result.name} page errors: ${JSON.stringify(result.pageErrors)}`);
	assert(result.state.outOfSync === false, `${result.name} reported OOS`);
	assert(result.liveTrace.specVersion === BenchmarkSpecVersion,
		`${result.name} spec drifted: ${JSON.stringify(result.liveTrace)}`);
	assert(result.liveTrace.barrierId === 1 && result.liveTrace.prematch === false,
		`${result.name} did not resolve exactly the first live barrier`);
	assert(result.liveTrace.frozenWorldTick === result.liveTrace.appliedWorldTick,
		`${result.name} applied outside the frozen tick: ${JSON.stringify(result.liveTrace)}`);
	assert(result.liveTrace.closedWorldTick >= result.liveTrace.frozenWorldTick && result.liveTrace.resumed === true,
		`${result.name} did not close/resume once from the frozen tick: ${JSON.stringify(result.liveTrace)}`);
	assert(result.liveTrace.seats.length === 2 && result.liveTrace.seats.every(seat =>
		seat.decisionId === 1 && seat.status === 'valid' && seat.outcome === 'Valid'),
		`${result.name} did not apply one paired valid opportunity: ${JSON.stringify(result.liveTrace.seats)}`);
	assert(result.samples.length > 0, `${result.name} never observed the collecting barrier`);
	const frozenTicks = new Set(result.samples.map(sample => sample.frozenWorldTick));
	const frozenHashes = new Set(result.samples.map(sample => sample.frozenSyncHash));
	assert(frozenTicks.size === 1 && frozenTicks.has(result.liveTrace.frozenWorldTick),
		`${result.name} world tick drifted while waiting`);
	assert(frozenHashes.size === 1 && !frozenHashes.has(0),
		`${result.name} sync hash drifted while waiting`);
	assert(result.samples.every(sample => sample.authoritativeWorldPaused === true && sample.appliedWorldTick === -1),
		`${result.name} applied early or unpaused during collection`);
	const adjudication = result.state.adjudication;
	assert(adjudication?.sampleCount === 1 && adjudication.firstFrozenWorldTick === result.liveTrace.frozenWorldTick &&
		adjudication.lastFrozenWorldTick === result.liveTrace.frozenWorldTick && adjudication.seats?.length === 2,
		`${result.name} did not emit one paired frozen adjudication sample: ${JSON.stringify(adjudication)}`);
	const componentFields = ['liveHpAdjustedPower', 'structuresByValue', 'economy',
		'unitReplacementValue', 'tech', 'regionControl'];
	assert(adjudication.seats.every(seat => componentFields.every(field =>
		typeof seat.components?.[field] === 'number' && Number.isFinite(seat.components[field]) &&
		seat.components[field] >= 0)),
		`${result.name} adjudication did not emit six finite non-negative components: ${JSON.stringify(adjudication)}`);
	assert(result.samples.every(sample => sample.adjudication?.lastFrozenWorldTick === sample.frozenWorldTick),
		`${result.name} barrier telemetry did not carry the frozen adjudication ledger`);
	const liveRequests = result.requests.filter(request => request.decisionId === 1);
	assert(liveRequests.length === 2 && liveRequests.every(request => request.respondedAt != null),
		`${result.name} scripted sidecar did not return exactly two live responses: ${JSON.stringify(liveRequests)}`);
	assert(result.firstAppliedObservedAt >= Math.max(...liveRequests.map(request => request.respondedAt)),
		`${result.name} applied before the delayed response arrived`);
	assert(result.metrics.commits.length === 2,
		`${result.name} expected prematch+live combined commits, got ${result.metrics.commits.length}`);
	assert(result.metrics.aborts.length === 0,
		`${result.name} unexpectedly aborted a healthy barrier`);
}

function dryRunAssertions() {
	const runner = new URL('./match-runner.mjs', import.meta.url).pathname;
	const good = spawnSync(process.execPath, [runner, '--benchmark-lockstep', '--map', 'Siberian-Pass.oramap',
		'--tick-horizon', '30000',
		'--decision-horizon', '60', '--decision-timeout-ms', '90000', '--effort1', 'high',
		'--effort2', 'medium', '--dry-run'], { encoding: 'utf8' });
	assert(good.status === 0, `benchmark dry-run failed: ${good.stderr}`);
	const resolved = JSON.parse(good.stdout);
	assert(resolved.resolvedProfile === 'benchmark-lockstep' &&
		resolved.benchmarkSpecVersion === BenchmarkSpecVersion &&
		resolved.benchmarkConfig.stopPolicy.dollarStop === false &&
		resolved.benchmarkConfig.tickHorizon === 30000 &&
		resolved.benchmarkConfig.decisionHorizon === 60 &&
		resolved.pinnedModelConfig.seats[0].reasoningEffort === 'high' &&
		resolved.pinnedModelConfig.seats[1].reasoningEffort === 'medium',
		`benchmark dry-run resolution drifted: ${good.stdout}`);

	for (const [flags, text] of [
		[['--cap', '3'], '--cap is a dollar stop'],
		[['--play'], '--play enables advisor fallback'],
		[['--fallback-strike', '--executor', '--arsenal'], '--fallback-strike is incompatible'],
		[['--tick-horizon', '0', '--decision-horizon', '0'], 'requires a positive']
	]) {
		const rejected = spawnSync(process.execPath, [runner, '--benchmark-lockstep', '--map',
			'Siberian-Pass.oramap', ...flags, '--dry-run'],
			{ encoding: 'utf8' });
		assert(rejected.status === 2 && `${rejected.stdout}${rejected.stderr}`.includes(text),
			`dry-run did not reject ${flags.join(' ')}: ${rejected.stdout}${rejected.stderr}`);
	}
	console.log('OK benchmark-lockstep dry-run pins and incompatible flags');
}

async function assertShellMapAdvances(harness, page, label) {
	const before = await page.evaluate(() => globalThis.ora.GetNetFrame());
	await new Promise(resolve => setTimeout(resolve, 250));
	const after = await page.evaluate(() => globalThis.ora.GetNetFrame());
	assert(after > before, `${label} left the replacement world paused (${before} -> ${after})`);
}

async function waitForLiveCollecting(harness, page, label) {
	return harness.waitFor(label, async () => {
		const snapshot = await harness.pageSnapshot(page);
		return snapshot.barrier.barrierId === 1 && snapshot.barrier.phase === 'Collecting' ? snapshot : false;
	}, 180_000, 20);
}

let harness;
try {
	dryRunAssertions();
	harness = await createBenchmarkHarness({ bundlePort: 8365, sidecarPort: 4165, headed });
	const fastFirst = await harness.runScenario('fast-first', ({ input, seat }) => ({
		delayMs: input.decisionId === 1 ? [20, 350][seat] : 10
	}));
	assertMainScenario(fastFirst);
	console.log('OK fast-vs-delayed waits at one frozen tick and commits once');

	const delayedFirst = await harness.runScenario('delayed-first', ({ input, seat }) => ({
		delayMs: input.decisionId === 1 ? [350, 20][seat] : 10
	}));
	assertMainScenario(delayedFirst);
	assert(fastFirst.liveTrace.frozenWorldTick === delayedFirst.liveTrace.frozenWorldTick,
		`inverted latency changed frozen tick: ${fastFirst.liveTrace.frozenWorldTick} vs ` +
		`${delayedFirst.liveTrace.frozenWorldTick}`);
	assert(fastFirst.liveTrace.commitDigest === delayedFirst.liveTrace.commitDigest,
		`inverted latency changed commit/order digest: ${fastFirst.liveTrace.commitDigest} vs ` +
		`${delayedFirst.liveTrace.commitDigest}`);
	console.log('OK inverted response arrival preserves frozen tick and commit/order digest');

	const timedOut = await harness.runScenario('shared-deadline-timeout', ({ input, seat }) => ({
		delayMs: input.decisionId === 1 && seat === 1 ? 11_000 : 10
	}), { timeoutMs: 10_000, scenarioTimeoutMs: 200_000 });
	const timeoutSeats = [...timedOut.liveTrace.seats].sort((a, b) => a.ordinal - b.ordinal);
	assert(timeoutSeats[0].status === 'valid' && timeoutSeats[0].outcome === 'Valid' &&
		timeoutSeats[1].status === 'timeout' && timeoutSeats[1].outcome === 'NoOpTimeout',
		`shared deadline did not produce one deterministic timeout no-op: ${JSON.stringify(timeoutSeats)}`);
	assert(timedOut.metrics.commits.length === 2 && timedOut.metrics.aborts.length === 0 &&
		timedOut.liveTrace.resumed === true && timedOut.state.outOfSync === false,
		`timeout barrier did not resolve/resume exactly once: ${JSON.stringify(timedOut)}`);
	console.log('OK shared timeout resolves once as a deterministic no-op and resumes');

	const stopPage = await harness.newPageScenario(({ input }) => ({
		delayMs: input.decisionId === 1 ? 3000 : 5
	}));
	await waitForLiveCollecting(harness, stopPage, 'page-stop live collecting');
	await stopPage.evaluate(() => document.getElementById('agent-stop').click());
	const stopped = await harness.waitFor('page-stop inactive', async () => {
		const snapshot = await harness.pageSnapshot(stopPage);
		return snapshot.state.state === 'inactive' ? snapshot : false;
	}, 60_000, 20);
	assert(stopped.metrics.aborts.length === 1 && stopped.metrics.commits.length === 1,
		`page-stop did not abort exactly the live barrier: ${JSON.stringify(stopped.metrics)}`);
	await assertShellMapAdvances(harness, stopPage, 'page-stop');
	await stopPage.close();
	console.log('OK page-stop aborts once and leaves an advancing unpaused world');

	const fatalPage = await harness.newPageScenario(({ input, seat }) => ({
		delayMs: input.decisionId === 1 && seat === 1 ? 1000 : 5,
		...(input.decisionId === 1 && seat === 0 ? { status: 401, error: 'Scripted fatal credential failure.' } : {})
	}));
	const fatal = await harness.waitFor('worker-fatal teardown', async () => {
		const snapshot = await harness.pageSnapshot(fatalPage);
		return snapshot.state.state === 'inactive' && snapshot.lastResolved?.terminalKind === 'authentication'
			? snapshot : false;
	}, 180_000, 20);
	assert(fatal.metrics.aborts.length === 1 && fatal.metrics.commits.length === 1,
		`worker-fatal did not abort exactly the live barrier: ${JSON.stringify(fatal.metrics)}`);
	await assertShellMapAdvances(harness, fatalPage, 'worker-fatal');
	await fatalPage.close();
	console.log('OK worker-fatal aborts once and leaves an advancing unpaused world');

	const terminal = await harness.runScenario('terminal-from-frozen-commit', ({ input, seat }) => ({
		delayMs: 5,
		actions: input.decisionId === 1 && seat === 0 ? [{ type: 'surrender' }] : []
	}), { keepPage: true });
	const terminalSnapshot = await harness.waitFor('terminal frozen commit teardown', async () => {
		const snapshot = await harness.pageSnapshot(terminal.page);
		return snapshot.state.state === 'inactive' && snapshot.lastResolved?.state === 'finished' ? snapshot : false;
	}, 60_000, 20);
	assert(terminalSnapshot.metrics.commits.length === 2 && terminalSnapshot.metrics.aborts.length === 0,
		`terminal frozen commit resolved more than once: ${JSON.stringify(terminalSnapshot.metrics)}`);
	assert(terminal.liveTrace.seats[0].status === 'valid' && terminal.liveTrace.resumed === true,
		`terminal batch was not atomically committed from the frozen barrier: ${JSON.stringify(terminal.liveTrace)}`);
	await assertShellMapAdvances(harness, terminal.page, 'terminal teardown');
	await terminal.page.close();
	console.log('OK terminal-from-frozen commit resolves once and leaves an advancing unpaused world');
	console.log('BENCHMARK LOCKSTEP GATE RESULT: PASS');
} catch (error) {
	console.error('BENCHMARK LOCKSTEP GATE FAILED:', error.message);
	process.exitCode = 1;
} finally {
	await harness?.close();
}
