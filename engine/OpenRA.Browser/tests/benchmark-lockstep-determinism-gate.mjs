// Phase-2 semantic determinism gate: invert only scripted response latency and
// require the canonical barrier trace to remain byte-identical with no OOS.
import {
	assert,
	canonicalBarrierTrace,
	createBenchmarkHarness
} from './benchmark-lockstep-fixture.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const unknown = args.filter(arg => arg !== '--headed');
if (unknown.length !== 0) {
	console.error(`Unknown argument(s): ${unknown.join(', ')}`);
	console.error('Usage: node benchmark-lockstep-determinism-gate.mjs [--headed]');
	process.exit(2);
}

let harness;
try {
	harness = await createBenchmarkHarness({ bundlePort: 8366, sidecarPort: 4166, headed });
	const first = await harness.runScenario('determinism-fast-seat-1', ({ input, seat }) => ({
		delayMs: input.decisionId === 1 ? [15, 275][seat] : 5
	}));
	const second = await harness.runScenario('determinism-fast-seat-2', ({ input, seat }) => ({
		delayMs: input.decisionId === 1 ? [275, 15][seat] : 5
	}));
	assert(first.state.outOfSync === false && second.state.outOfSync === false,
		`determinism run reported OOS: ${JSON.stringify([first.state, second.state])}`);
	const firstTrace = canonicalBarrierTrace(first.trace);
	const secondTrace = canonicalBarrierTrace(second.trace);
	assert(JSON.stringify(firstTrace) === JSON.stringify(secondTrace),
		`latency inversion changed canonical barrier trace:\nfirst=${JSON.stringify(firstTrace)}\n` +
		`second=${JSON.stringify(secondTrace)}`);
	assert(firstTrace.length === 2 && firstTrace[0].barrierId === 0 && firstTrace[1].barrierId === 1,
		`golden trace must contain prematch barrier zero and one live barrier: ${JSON.stringify(firstTrace)}`);
	const canonicalAdjudication = telemetry => ({
		sampleCount: telemetry?.sampleCount,
		firstFrozenWorldTick: telemetry?.firstFrozenWorldTick,
		lastFrozenWorldTick: telemetry?.lastFrozenWorldTick,
		durationTicks: telemetry?.durationTicks,
		controlRegionCount: telemetry?.controlRegionCount,
		controlRegionHash: telemetry?.controlRegionHash ?? null,
		seats: telemetry?.seats?.map(seat => ({
			ordinal: seat.ordinal,
			components: seat.components,
			ownStructureLossValue: seat.ownStructureLossValue,
			ownCombatUnitLossValue: seat.ownCombatUnitLossValue,
			averageIncomePerMinute: seat.averageIncomePerMinute,
			averageRefineryCapacity: seat.averageRefineryCapacity,
			averageProducerCapacity: seat.averageProducerCapacity,
			averageLiquidResources: seat.averageLiquidResources,
			occupiedRegionCount: seat.occupiedRegionCount
		}))
	});
	const firstAdjudication = canonicalAdjudication(first.state.adjudication);
	const secondAdjudication = canonicalAdjudication(second.state.adjudication);
	assert(JSON.stringify(firstAdjudication) === JSON.stringify(secondAdjudication),
		`latency inversion changed adjudication telemetry:\nfirst=${JSON.stringify(firstAdjudication)}\n` +
		`second=${JSON.stringify(secondAdjudication)}`);
	console.log(`OK inverted latency produced identical ${firstTrace.length}-barrier golden trace`);
	console.log('OK inverted latency produced identical six-component adjudication telemetry');
	console.log('BENCHMARK LOCKSTEP DETERMINISM GATE RESULT: PASS oos=false');
} catch (error) {
	console.error('BENCHMARK LOCKSTEP DETERMINISM GATE FAILED:', error.message);
	process.exitCode = 1;
} finally {
	await harness?.close();
}
