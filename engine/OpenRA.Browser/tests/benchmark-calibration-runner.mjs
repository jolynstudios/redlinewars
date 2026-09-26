// Produces a deterministic candidate calibration bundle. It never edits production configuration and
// deliberately labels all derived floor/region values as candidates pending human blind review/freeze.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assert,
	canonicalJson,
	deriveCandidateFloors,
	deriveMapRegions,
	evaluate,
	readJson,
	replayScenario,
	sha256
} from './benchmark-calibration-lib.mjs';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testsDirectory, '../..');
const scenarioPath = resolve(testsDirectory, 'benchmark-calibration/golden-adjudication-scenarios.json');
const mapInputPath = resolve(testsDirectory, 'benchmark-calibration/calibration-map-inputs.json');
const scorerPath = resolve(repositoryRoot, 'OpenRA.Browser/AgentMode/AgentAdjudication.cs');

function lockedScoringSpec() {
	const source = readFileSync(scorerPath, 'utf8');
	const value = name => {
		const match = source.match(new RegExp(`(?:internal )?const double ${name} = ([0-9.]+);`));
		assert(match, `could not read ${name} from AgentAdjudication.cs`);
		return Number(match[1]);
	};
	const weights = {
		liveHpAdjustedPower: value('LivePowerWeight'),
		structuresByValue: value('StructuresWeight'),
		economy: value('EconomyWeight'),
		unitReplacementValue: value('UnitValueWeight'),
		tech: value('TechWeight'),
		regionControl: value('RegionControlWeight')
	};
	assert(Math.abs(Object.values(weights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12,
		'locked adjudication weights do not sum to one');
	return { weights, drawBand: value('DrawBand') };
}

export function buildCandidateBundle(candidateMapId) {
	assert(typeof candidateMapId === 'string' && candidateMapId.length > 0,
		'candidate generation requires an explicit map id');
	const scenarios = readJson(scenarioPath);
	const mapInputs = readJson(mapInputPath);
	assert(scenarios.schemaVersion === 1 && scenarios.specVersion === 'benchmark-lockstep-v1',
		'golden scenario schema/spec drifted');
	assert(mapInputs.schemaVersion === 1 && mapInputs.status === 'candidate-input',
		'map calibration input must remain candidate-input');
	const replays = scenarios.scenarios.map(replayScenario);
	assert(new Set(replays.map(replay => replay.seed)).size === replays.length,
		'golden scenario seeds must be unique');
	assert(replays.every(replay => replay.oos === false), 'all golden scenarios must pin oos=false');
	const floors = deriveCandidateFloors(replays);
	const scoring = lockedScoringSpec();
	const selectedMapInputs = mapInputs.maps.filter(input => input.mapId === candidateMapId);
	assert(selectedMapInputs.length === 1,
		`calibration map '${candidateMapId}' must identify exactly one map input`);
	const maps = selectedMapInputs.map(input => deriveMapRegions(repositoryRoot, input));
	const source = {
		candidateMapId,
		scenarioFixture: 'OpenRA.Browser/tests/benchmark-calibration/golden-adjudication-scenarios.json',
		scenarioFixtureSha256: sha256(readFileSync(scenarioPath)),
		mapInputFixture: 'OpenRA.Browser/tests/benchmark-calibration/calibration-map-inputs.json',
		mapInputFixtureSha256: sha256(readFileSync(mapInputPath)),
		scorerSource: 'OpenRA.Browser/AgentMode/AgentAdjudication.cs',
		scorerSourceSha256: sha256(readFileSync(scorerPath)),
		scenarioSeeds: replays.map(replay => replay.seed),
		oosRequired: false
	};
	const bundle = {
		schemaVersion: 1,
		calibrationId: 'benchmark-calibration-v1-candidate',
		status: 'candidate-human-review-required',
		productionDefault: false,
		specVersion: scenarios.specVersion,
		description: 'Model-blind candidate only. Values must not enter leaderboard configuration until human blind review and freeze.',
		source,
		lockedScoring: {
			weights: scoring.weights,
			drawBand: scoring.drawBand
		},
		candidateFloors: {
			method: 'nearest-rank p25 of positive paired A+B totals across every calibration-eligible frozen sample',
			values: floors.values,
			provenance: floors.provenance
		},
		candidateMaps: maps,
		goldenLedgerOutputs: replays.map(replay => ({
			id: replay.id,
			seed: replay.seed,
			oos: replay.oos,
			calibrationEligible: replay.calibrationEligible,
			terminalOutcome: replay.terminalOutcome,
			firstFrozenWorldTick: replay.firstFrozenWorldTick,
			lastFrozenWorldTick: replay.lastFrozenWorldTick,
			durationTicks: replay.durationTicks,
			seats: replay.seats,
			candidateScore: evaluate(replay.seats[0].components, replay.seats[1].components,
				floors.values, replay.terminalOutcome, scoring.weights, scoring.drawBand)
		}))
	};
	bundle.derivationSha256 = sha256(canonicalJson(bundle));
	return bundle;
}

function usage() {
	console.error('Usage: node benchmark-calibration-runner.mjs --map <map-id> ' +
		'[--check <candidate.json>] [--compact]');
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const args = process.argv.slice(2);
	let checkPath = null;
	let candidateMapId = null;
	let compact = false;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === '--check' && index + 1 < args.length && !args[index + 1].startsWith('--')) {
			if (checkPath != null) {
				usage();
				process.exit(2);
			}
			checkPath = resolve(process.cwd(), args[++index]);
		}
		else if (args[index] === '--map' && index + 1 < args.length && !args[index + 1].startsWith('--')) {
			if (candidateMapId != null) {
				usage();
				process.exit(2);
			}
			candidateMapId = args[++index];
		}
		else if (args[index] === '--compact') compact = true;
		else {
			usage();
			process.exit(2);
		}
	}
	if (candidateMapId == null) {
		usage();
		process.exit(2);
	}

	try {
		const bundle = buildCandidateBundle(candidateMapId);
		if (checkPath != null) {
			const reviewed = readJson(checkPath);
			assert(reviewed.status === 'candidate-human-review-required' && reviewed.productionDefault === false,
				'checked calibration bundle lost its candidate/non-production guard');
			assert(reviewed.candidateMaps?.length === 1 &&
				reviewed.candidateMaps[0].mapId === candidateMapId,
				'checked calibration bundle is not pinned to the requested single map');
			assert(canonicalJson(reviewed) === canonicalJson(bundle),
				`candidate bundle drifted; rerun without --check to inspect the proposed replacement`);
			console.log(`OK calibration candidate is reproducible: ${bundle.derivationSha256}`);
			console.log(`CANDIDATE floors: ${JSON.stringify(bundle.candidateFloors.values)}`);
			for (const map of bundle.candidateMaps)
				console.log(`CANDIDATE regions ${map.mapId}: ${map.controlRegionCount} hash=${map.controlRegionHash}`);
		} else console.log(JSON.stringify(bundle, null, compact ? 0 : '\t'));
	} catch (error) {
		console.error(`BENCHMARK CALIBRATION FAILED: ${error.message}`);
		process.exitCode = 1;
	}
}
