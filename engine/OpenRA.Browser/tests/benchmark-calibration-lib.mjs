// Deterministic, dependency-free calibration helpers. This mirrors the pure C# ledger only so candidate
// generation can replay test fixtures; AgentAdjudicationGoldenTest remains the authoritative cross-check.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const ComponentFields = [
	'liveHpAdjustedPower',
	'structuresByValue',
	'economy',
	'unitReplacementValue',
	'tech',
	'regionControl'
];

export function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

export function readZipEntry(archive, entryName) {
	const bytes = readFileSync(archive);
	let eocd = -1;
	for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
		if (bytes.readUInt32LE(offset) === 0x06054b50) {
			eocd = offset;
			break;
		}
	}
	assert(eocd >= 0, `${archive} has no ZIP end-of-central-directory record`);
	const entryCount = bytes.readUInt16LE(eocd + 10);
	let offset = bytes.readUInt32LE(eocd + 16);
	for (let index = 0; index < entryCount; index++) {
		assert(bytes.readUInt32LE(offset) === 0x02014b50, `${archive} central directory is malformed`);
		const method = bytes.readUInt16LE(offset + 10);
		const compressedSize = bytes.readUInt32LE(offset + 20);
		const nameLength = bytes.readUInt16LE(offset + 28);
		const extraLength = bytes.readUInt16LE(offset + 30);
		const commentLength = bytes.readUInt16LE(offset + 32);
		const localOffset = bytes.readUInt32LE(offset + 42);
		const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
		if (name === entryName) {
			assert(bytes.readUInt32LE(localOffset) === 0x04034b50, `${archive}:${entryName} local header is malformed`);
			const localNameLength = bytes.readUInt16LE(localOffset + 26);
			const localExtraLength = bytes.readUInt16LE(localOffset + 28);
			const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
			const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
			if (method === 0) return Buffer.from(compressed);
			if (method === 8) return inflateRawSync(compressed);
			throw new Error(`${archive}:${entryName} uses unsupported ZIP compression method ${method}`);
		}
		offset += 46 + nameLength + extraLength + commentLength;
	}
	throw new Error(`${archive} does not contain ${entryName}`);
}

function requireNonNegativeSafe(value, label) {
	assert(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative safe integer`);
}

export function productiveEconomy(sample) {
	const productiveBase = sample.incomePerMinute + sample.refineryCapacity + sample.producerCapacity;
	if (productiveBase === 0 || sample.liquidResources === 0) return productiveBase;
	return productiveBase + Math.floor(
		productiveBase * sample.liquidResources / (productiveBase + sample.liquidResources));
}

function average(twiceArea, current, durationTicks) {
	return durationTicks === 0 ? current : twiceArea / (2 * durationTicks);
}

function validateSample(sample, regionCount) {
	requireNonNegativeSafe(sample.ordinal, 'sample ordinal');
	assert(sample.ordinal <= 1, 'sample ordinal must be 0 or 1');
	for (const field of ['liveHpAdjustedPower', 'incomePerMinute', 'refineryCapacity', 'producerCapacity',
		'liquidResources', 'techCapability', 'occupiedRegionCount'])
		requireNonNegativeSafe(sample[field], `sample ${field}`);
	assert(sample.occupiedRegionCount <= regionCount, 'occupiedRegionCount exceeds the frozen region count');
}

function seatSnapshot(state, seat) {
	const opponent = state.seats[1 - seat.ordinal];
	const duration = state.lastTick - state.firstTick;
	return {
		ordinal: seat.ordinal,
		components: {
			liveHpAdjustedPower: seat.current.liveHpAdjustedPower,
			structuresByValue: opponent.structureLossValue,
			economy: average(seat.economyTwiceArea, productiveEconomy(seat.current), duration),
			unitReplacementValue: opponent.combatUnitLossValue,
			tech: seat.current.techCapability,
			regionControl: average(seat.regionTwiceArea, seat.current.occupiedRegionCount, duration)
		},
		ownStructureLossValue: seat.structureLossValue,
		ownCombatUnitLossValue: seat.combatUnitLossValue
	};
}

export function replayScenario(scenario) {
	assert(scenario.oos === false, `${scenario.id} must pin oos=false`);
	requireNonNegativeSafe(scenario.seed, `${scenario.id} seed`);
	requireNonNegativeSafe(scenario.controlRegionCount, `${scenario.id} controlRegionCount`);
	const state = {
		firstTick: -1,
		lastTick: -1,
		lastBarrierId: -1,
		destroyed: new Set(),
		seats: [0, 1].map(ordinal => ({
			ordinal,
			structureLossValue: 0,
			combatUnitLossValue: 0,
			current: null,
			economyTwiceArea: 0,
			regionTwiceArea: 0
		})),
		frozenSamples: []
	};

	for (const event of scenario.events) {
		if (event.kind === 'destroyed') {
			requireNonNegativeSafe(event.actorId, `${scenario.id} destroyed actorId`);
			assert(event.actorId > 0, `${scenario.id} destroyed actorId must be positive`);
			assert(event.victimOrdinal === 0 || event.victimOrdinal === 1,
				`${scenario.id} destroyed victimOrdinal must be 0 or 1`);
			requireNonNegativeSafe(event.replacementValue, `${scenario.id} replacementValue`);
			assert(!state.destroyed.has(event.actorId), `${scenario.id} repeats destroyed actor ${event.actorId}`);
			state.destroyed.add(event.actorId);
			const victim = state.seats[event.victimOrdinal];
			if (event.destroyedKind === 'Structure') victim.structureLossValue += event.replacementValue;
			else if (event.destroyedKind === 'CombatUnit') victim.combatUnitLossValue += event.replacementValue;
			else throw new Error(`${scenario.id} has unknown destroyedKind ${event.destroyedKind}`);
			continue;
		}

		assert(event.kind === 'frozen', `${scenario.id} has unknown event kind ${event.kind}`);
		requireNonNegativeSafe(event.barrierId, `${scenario.id} barrierId`);
		requireNonNegativeSafe(event.worldTick, `${scenario.id} worldTick`);
		assert(event.barrierId > state.lastBarrierId, `${scenario.id} barrier ids are not monotonic`);
		assert(event.worldTick > state.lastTick, `${scenario.id} frozen ticks are not monotonic`);
		const samples = [...event.seats].sort((a, b) => a.ordinal - b.ordinal);
		assert(samples.length === 2 && samples[0].ordinal === 0 && samples[1].ordinal === 1,
			`${scenario.id} frozen event must contain each seat exactly once`);
		for (const sample of samples) validateSample(sample, scenario.controlRegionCount);

		if (state.firstTick < 0) state.firstTick = event.worldTick;
		else {
			const delta = event.worldTick - state.lastTick;
			for (const sample of samples) {
				const seat = state.seats[sample.ordinal];
				seat.economyTwiceArea += (productiveEconomy(seat.current) + productiveEconomy(sample)) * delta;
				seat.regionTwiceArea +=
					(seat.current.occupiedRegionCount + sample.occupiedRegionCount) * delta;
			}
		}
		for (const sample of samples) state.seats[sample.ordinal].current = structuredClone(sample);
		state.lastBarrierId = event.barrierId;
		state.lastTick = event.worldTick;
		state.frozenSamples.push({
			barrierId: event.barrierId,
			worldTick: event.worldTick,
			seats: state.seats.map(seat => seatSnapshot(state, seat))
		});
	}

	assert(state.frozenSamples.length > 0, `${scenario.id} has no frozen samples`);
	return {
		id: scenario.id,
		seed: scenario.seed,
		oos: scenario.oos,
		calibrationEligible: scenario.calibrationEligible,
		terminalOutcome: scenario.terminalOutcome,
		firstFrozenWorldTick: state.firstTick,
		lastFrozenWorldTick: state.lastTick,
		durationTicks: state.lastTick - state.firstTick,
		frozenSamples: state.frozenSamples,
		seats: state.seats.map(seat => seatSnapshot(state, seat))
	};
}

function nearestRank(values, percentile) {
	assert(values.length > 0, 'nearest-rank requires at least one value');
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

export function deriveCandidateFloors(replays) {
	const totals = Object.fromEntries(ComponentFields.map(field => [field, []]));
	for (const replay of replays.filter(candidate => candidate.calibrationEligible)) {
		for (const sample of replay.frozenSamples) {
			for (const field of ComponentFields) {
				const total = sample.seats[0].components[field] + sample.seats[1].components[field];
				if (total > 0) totals[field].push(total);
			}
		}
	}
	const values = {};
	const provenance = {};
	for (const field of ComponentFields) {
		assert(totals[field].length > 0, `no positive paired totals for ${field}`);
		values[field] = nearestRank(totals[field], 0.25);
		provenance[field] = {
			positiveSampleCount: totals[field].length,
			minimum: Math.min(...totals[field]),
			maximum: Math.max(...totals[field]),
			orderedTotals: [...totals[field]].sort((a, b) => a - b)
		};
	}
	return { values, provenance };
}

export function parseMapYaml(yaml) {
	const title = yaml.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
	const bounds = yaml.match(/^Bounds:\s*(-?\d+),(-?\d+),(\d+),(\d+)$/m);
	assert(title && bounds, 'map.yaml is missing Title or Bounds');
	const actors = [];
	const lines = yaml.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const actor = lines[index].match(/^\s+Actor[^:]*:\s+([^\s]+)\s*$/);
		if (!actor) continue;
		for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 8); lookahead++) {
			if (/^\s+Actor[^:]*:/.test(lines[lookahead])) break;
			const location = lines[lookahead].match(/^\s+Location:\s*(-?\d+),(-?\d+)\s*$/);
			if (location) {
				actors.push({ type: actor[1], x: Number(location[1]), y: Number(location[2]) });
				break;
			}
		}
	}
	return {
		title,
		bounds: { x: Number(bounds[1]), y: Number(bounds[2]), width: Number(bounds[3]), height: Number(bounds[4]) },
		actors
	};
}

function manhattan(a, b) {
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function connectedClusters(points, maximumDistance) {
	const unseen = new Set(points.map((_, index) => index));
	const clusters = [];
	while (unseen.size > 0) {
		const start = Math.min(...unseen);
		unseen.delete(start);
		const queue = [start];
		const cluster = [];
		while (queue.length > 0) {
			const current = queue.pop();
			cluster.push(points[current]);
			for (const candidate of [...unseen].sort((a, b) => a - b)) {
				if (manhattan(points[current], points[candidate]) <= maximumDistance) {
					unseen.delete(candidate);
					queue.push(candidate);
				}
			}
		}
		clusters.push(cluster.sort((a, b) => a.x - b.x || a.y - b.y || a.type.localeCompare(b.type)));
	}
	return clusters;
}

function diamondCells(anchors, radius, bounds) {
	const cells = new Map();
	for (const anchor of anchors) {
		for (let dx = -radius; dx <= radius; dx++) {
			for (let dy = -radius; dy <= radius; dy++) {
				if (Math.abs(dx) + Math.abs(dy) > radius) continue;
				const x = anchor.x + dx;
				const y = anchor.y + dy;
				if (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height)
					continue;
				cells.set(`${x},${y}`, { x, y });
			}
		}
	}
	return [...cells.values()].sort((a, b) => a.x - b.x || a.y - b.y);
}

export function deriveMapRegions(repositoryRoot, input) {
	const sourcePath = `${repositoryRoot}/${input.source}`;
	const sourceIsDirectory = statSync(sourcePath).isDirectory();
	const yamlBytes = sourceIsDirectory
		? readFileSync(join(sourcePath, 'map.yaml'))
		: readZipEntry(sourcePath, 'map.yaml');
	const packageSha256 = sourceIsDirectory
		? sha256(readdirSync(sourcePath).sort().filter(name => statSync(join(sourcePath, name)).isFile()).map(name =>
			`${name}:${sha256(readFileSync(join(sourcePath, name)))}`).join('|'))
		: sha256(readFileSync(sourcePath));
	const map = parseMapYaml(yamlBytes.toString('utf8'));
	assert(map.title === input.title, `${input.mapId} title drifted: ${map.title}`);
	const spawns = map.actors.filter(actor => actor.type === 'mpspawn').sort((a, b) => a.x - b.x || a.y - b.y);
	assert(spawns.length === 2, `${input.mapId} calibration requires exactly two spawn points`);
	const resourceTypes = new Set(input.resourceActorTypes);
	const resources = map.actors.filter(actor => resourceTypes.has(actor.type));
	assert(resources.length > 0, `${input.mapId} has no configured resource anchors`);
	const clusters = connectedClusters(resources, input.resourceClusterManhattanDistance);
	const claimed = new Set();
	const regions = [];

	for (const cluster of clusters) {
		const center = {
			x: Math.round(cluster.reduce((sum, point) => sum + point.x, 0) / cluster.length),
			y: Math.round(cluster.reduce((sum, point) => sum + point.y, 0) / cluster.length)
		};
		if (Math.min(...spawns.map(spawn => manhattan(center, spawn))) <= input.homeExclusionManhattanDistance)
			continue;
		const cells = diamondCells(cluster, input.resourceRegionRadius, map.bounds);
		for (const cell of cells) {
			assert(!claimed.has(`${cell.x},${cell.y}`), `${input.mapId} resource candidate regions overlap`);
			claimed.add(`${cell.x},${cell.y}`);
		}
		regions.push({
			id: `resource-${String(center.x).padStart(2, '0')}-${String(center.y).padStart(2, '0')}`,
			kind: 'resource',
			anchors: cluster,
			cells
		});
	}

	for (const seed of [...input.chokepointSeeds].sort((a, b) => a.id.localeCompare(b.id))) {
		const derived = diamondCells([seed], input.chokepointRegionRadius, map.bounds);
		const cells = derived.filter(cell => !claimed.has(`${cell.x},${cell.y}`));
		assert(cells.length > 0, `${input.mapId} chokepoint ${seed.id} is fully overlapped or out of bounds`);
		for (const cell of cells) claimed.add(`${cell.x},${cell.y}`);
		regions.push({
			id: seed.id,
			kind: 'chokepoint',
			anchors: [{ x: seed.x, y: seed.y }],
			provenance: seed.provenance,
			trimmedOverlapCellCount: derived.length - cells.length,
			cells
		});
	}

	regions.sort((a, b) => a.id.localeCompare(b.id));
	const canonical = regions.map(region =>
		`${region.id}:${region.cells.map(cell => `${cell.x},${cell.y}`).join(';')}`).join('|');
	return {
		mapId: input.mapId,
		title: input.title,
		benchmarkRole: input.benchmarkRole,
		source: input.source,
		sourceKind: sourceIsDirectory ? 'directory-map' : 'oramap-archive',
		packageSha256,
		mapYamlSha256: sha256(yamlBytes),
		bounds: map.bounds,
		spawnPoints: spawns.map(({ x, y }) => ({ x, y })),
		resourceAnchorCount: resources.length,
		parameters: {
			resourceActorTypes: [...input.resourceActorTypes].sort(),
			resourceClusterManhattanDistance: input.resourceClusterManhattanDistance,
			homeExclusionManhattanDistance: input.homeExclusionManhattanDistance,
			resourceRegionRadius: input.resourceRegionRadius,
			chokepointRegionRadius: input.chokepointRegionRadius
		},
		controlRegionCount: regions.length,
		controlRegionHash: sha256(canonical),
		regions
	};
}

export function evaluate(sideA, sideB, floors, terminalOutcome, weights, drawBand) {
	if (terminalOutcome === 'SideAWin') return { score: 1, verdict: 'SideA', terminalOverride: true };
	if (terminalOutcome === 'SideBWin') return { score: -1, verdict: 'SideB', terminalOverride: true };
	assert(terminalOutcome === 'Unresolved', `unknown terminal outcome ${terminalOutcome}`);
	let score = 0;
	for (const field of ComponentFields) {
		const denominator = Math.max(sideA[field] + sideB[field], floors[field]);
		const margin = Math.max(-1, Math.min(1, (sideA[field] - sideB[field]) / denominator));
		score += weights[field] * margin;
	}
	score = Math.max(-1, Math.min(1, score));
	return {
		score,
		verdict: Math.abs(score) < drawBand ? 'Draw' : score > 0 ? 'SideA' : 'SideB',
		terminalOverride: false
	};
}
