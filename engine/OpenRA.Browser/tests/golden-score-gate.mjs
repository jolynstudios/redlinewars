// Phase-3 calibration/golden-score gate. This uses only deterministic fixtures, the local map archive,
// and the pure C# test slice. It cannot contact a model provider or spend money.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assert, canonicalJson, readJson } from './benchmark-calibration-lib.mjs';
import { buildCandidateBundle } from './benchmark-calibration-runner.mjs';
import { LockedWeights } from './benchmark-series-lib.mjs';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testsDirectory, '../..');
const candidatePath = resolve(testsDirectory,
	'benchmark-calibration/candidates/benchmark-calibration-v1.candidate.json');
const frozenTestPath = resolve(testsDirectory, 'benchmark-calibration/golden-score-v1.frozen-test.json');
const CandidateMapId = 'Siberian-Pass.oramap';

function dotnetExecutable() {
	for (const candidate of [
		process.env.DOTNET_HOST_PATH,
		process.env.DOTNET_ROOT ? resolve(process.env.DOTNET_ROOT, 'dotnet') : null,
		resolve(homedir(), '.dotnet/dotnet')
	].filter(Boolean))
		if (existsSync(candidate)) return candidate;
	const pathProbe = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
	if (pathProbe.status === 0) return 'dotnet';
	throw new Error('dotnet executable was not found');
}

try {
	const generated = buildCandidateBundle(CandidateMapId);
	const reviewedCandidate = readJson(candidatePath);
	assert(canonicalJson(generated) === canonicalJson(reviewedCandidate),
		'candidate bundle is not a reproducible calibration-runner result');
	assert(reviewedCandidate.status === 'candidate-human-review-required' &&
		reviewedCandidate.productionDefault === false,
		'candidate bundle lost its explicit human-review/non-production guard');
	assert(reviewedCandidate.candidateMaps.length === 1 &&
		reviewedCandidate.candidateMaps[0].mapId === CandidateMapId,
		'candidate bundle is not pinned to the current benchmark map');
	assert(Object.values(reviewedCandidate.candidateFloors.values).every(value =>
		Number.isFinite(value) && value > 0), 'candidate floors must be finite and positive');
	for (const map of reviewedCandidate.candidateMaps) {
		assert(map.controlRegionCount === map.regions.length && map.controlRegionCount > 0 &&
			map.controlRegionCount <= 64, `${map.mapId} candidate region count is invalid`);
		const cells = new Set();
		for (const region of map.regions) {
			assert(region.cells.length > 0, `${map.mapId}:${region.id} has no exact cells`);
			for (const cell of region.cells)
				assert(!cells.has(`${cell.x},${cell.y}`) && cells.add(`${cell.x},${cell.y}`),
					`${map.mapId} candidate cells overlap at ${cell.x},${cell.y}`);
		}
		assert(cells.size <= 4096, `${map.mapId} candidate exceeds the host cell limit`);
	}

	const frozenTest = readJson(frozenTestPath);
	assert(frozenTest.status === 'frozen-test-vector' && frozenTest.scope === 'golden-score-gate-only' &&
		frozenTest.productionDefault === false,
		'test-only frozen score vector lost its scope/non-production guard');
	const productionSources = [
		'OpenRA.Browser/AgentMode/AgentModeHost.cs',
		'OpenRA.Browser/AgentMode/AgentModeContracts.cs',
		'OpenRA.Browser/wwwroot/openra-agent-mode.js',
		'OpenRA.Browser/tests/match-runner.mjs'
	].map(path => readFileSync(resolve(repositoryRoot, path), 'utf8')).join('\n');
	for (const forbidden of [reviewedCandidate.calibrationId, reviewedCandidate.derivationSha256,
		frozenTest.calibrationId, frozenTest.controlRegionHash])
		assert(!productionSources.includes(forbidden),
			`calibration fixture '${forbidden}' leaked into production/runtime defaults`);

	const adjudicationSource = readFileSync(resolve(repositoryRoot,
		'OpenRA.Browser/AgentMode/AgentAdjudication.cs'), 'utf8');
	const csharpWeightNames = {
		liveHpAdjustedPower: 'LivePowerWeight',
		structuresByValue: 'StructuresWeight',
		economy: 'EconomyWeight',
		unitReplacementValue: 'UnitValueWeight',
		tech: 'TechWeight',
		regionControl: 'RegionControlWeight'
	};
	const declaredWeights = [...adjudicationSource.matchAll(/\bconst double (\w+Weight) = ([0-9.]+);/g)];
	assert(declaredWeights.length === Object.keys(csharpWeightNames).length,
		'AgentAdjudication.cs must declare exactly the six locked component weights');
	for (const [field, csharpName] of Object.entries(csharpWeightNames)) {
		const declaration = declaredWeights.find(match => match[1] === csharpName);
		assert(declaration != null && Number(declaration[2]) === LockedWeights[field],
			`AgentAdjudication.cs ${csharpName} drifted from LockedWeights.${field}`);
	}

	const dotnet = spawnSync(dotnetExecutable(), [
		'test', 'OpenRA.Test/OpenRA.Test.csproj', '-c', 'Debug', '--no-restore',
		'--filter', 'FullyQualifiedName~AgentAdjudicationGoldenTest',
		'--logger', 'console;verbosity=minimal'
	], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
	assert(dotnet.status === 0,
		`C# golden replay/score slice failed:\n${dotnet.stdout}\n${dotnet.stderr}`);
	assert(/Passed:\s+1/.test(dotnet.stdout),
		`C# golden replay/score slice did not execute exactly one test:\n${dotnet.stdout}`);

	console.log(`OK candidate bundle reproducible: ${reviewedCandidate.derivationSha256}`);
	console.log(`OK CANDIDATE floors (not frozen): ${JSON.stringify(reviewedCandidate.candidateFloors.values)}`);
	for (const map of reviewedCandidate.candidateMaps)
		console.log(`OK CANDIDATE regions (not frozen) ${map.mapId}: ` +
			`${map.controlRegionCount} hash=${map.controlRegionHash}`);
	console.log('OK AgentAdjudication.cs weights match the locked JS scoring weights');
	console.log('OK frozen test vector replays production ledger + AgentAdjudication.Evaluate end-to-end');
	console.log('GOLDEN SCORE GATE RESULT: PASS');
} catch (error) {
	console.error(`GOLDEN SCORE GATE FAILED: ${error.message}`);
	process.exitCode = 1;
}
