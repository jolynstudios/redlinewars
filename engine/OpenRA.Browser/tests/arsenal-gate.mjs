#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '..', '..');
const artifactPath = path.join(repoRoot, 'OpenRA.Browser', 'agent-sidecar', 'knowledge', 'ra-arsenal.json');
const args = process.argv.slice(2);
const regenCheck = args.includes('--regen-check');
const unknown = args.filter(arg => arg !== '--regen-check');

if (unknown.length > 0) {
	console.error(`usage: node OpenRA.Browser/tests/arsenal-gate.mjs [--regen-check]`);
	process.exit(2);
}

function fail(message) {
	throw new Error(message);
}

function ok(condition, message) {
	if (!condition)
		fail(message);
	console.log(`OK ${message}`);
}

function check(condition, message) {
	if (!condition)
		fail(message);
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function sourcePath(mountedPath) {
	const separator = mountedPath.indexOf('|');
	if (separator <= 0)
		fail(`invalid mounted source path '${mountedPath}'`);
	return path.join(repoRoot, 'mods', mountedPath.slice(0, separator), mountedPath.slice(separator + 1));
}

function extract() {
	const dotnetDir = path.join(process.env.HOME ?? '', '.dotnet');
	const executable = path.join(dotnetDir, 'dotnet');
	const commandPath = fs.existsSync(executable) ? `${dotnetDir}:${process.env.PATH ?? ''}` : process.env.PATH;
	const result = spawnSync('./utility.sh', ['ra', '--extract-agent-knowledge', 'arsenal'], {
		cwd: repoRoot,
		encoding: null,
		maxBuffer: 2 * 1024 * 1024,
		env: { ...process.env, PATH: commandPath }
	});
	if (result.status !== 0)
		fail(`arsenal extraction failed (${result.status}): ${String(result.stderr).trim()}`);
	return result.stdout;
}

if (regenCheck) {
	const first = extract();
	const second = extract();
	ok(first.equals(second), 'two independent arsenal extractions are byte-identical');
	ok(first.equals(fs.readFileSync(artifactPath)), 'checked arsenal artifact matches a fresh extraction');
}

const bytes = fs.readFileSync(artifactPath);
ok(bytes.length >= 16 * 1024 && bytes.length <= 256 * 1024, 'artifact size is bounded to 16-256 KiB');
const data = JSON.parse(bytes);
ok(data.schemaVersion === 1 && data.modId === 'ra', 'artifact identity is ra schema v1');
ok(data.actorScope === 'buildable-default-rules', 'artifact declares its bounded actor scope');
ok(data.counterGraphEpistemic === 'derived-comparison', 'counter graph is labeled as derived comparison, not strategic truth');
ok(data.targetStateModel === 'boolean-condition-enumerated possible enabled-type unions',
	'target profiles model unions of simultaneously enabled targetable traits');
ok(data.counterEdgeRateFormula === 'peakDamagePerSalvo * 100 / armament.cycleTicks',
	'counter-edge rate derivation is explicit and non-duplicated');

const storedArtifactHash = data.artifactHash;
data.artifactHash = '';
ok(sha256(JSON.stringify(data)) === storedArtifactHash, 'artifactHash covers canonical artifact contents');
data.artifactHash = storedArtifactHash;

const rulesHash = createHash('sha256');
rulesHash.update('openra-agent-rules-v1\0');
for (const [index, source] of data.sourceFiles.entries()) {
	const sourceBytes = fs.readFileSync(sourcePath(source.path));
	ok(source.byteLength === sourceBytes.length, `source file ${index} byte length matches`);
	ok(source.sha256 === sha256(sourceBytes), `source file ${index} sha256 matches`);
	rulesHash.update(`${source.category}\0${source.path}\0${source.byteLength}\0`);
	rulesHash.update(sourceBytes);
}
ok(rulesHash.digest('hex') === data.rulesHash, 'rulesHash covers every ordered rule and weapon source byte');

ok(data.actors.length > 40 && data.actors.length <= 128, 'actor table is populated and bounded');
ok(data.actors.flatMap(actor => actor.armaments).length <= 256, 'armament table is bounded');
ok(data.counterEdges.length > 100 && data.counterEdges.length <= 4096, 'counter graph is populated and bounded');
ok(data.sourceRefs.length <= 2048, 'source-reference table is bounded');

const actorIds = new Set();
const armaments = new Map();
const sourceRefIds = new Set(data.sourceRefs.map(ref => ref.id));
const profiles = new Map(data.targetProfiles.map(profile => [profile.id, profile]));
let lastActorId = '';
for (const actor of data.actors) {
	check(actor.id > lastActorId, `actor '${actor.id}' violates deterministic id ordering`);
	lastActorId = actor.id;
	check(!actorIds.has(actor.id), `duplicate actor '${actor.id}'`);
	actorIds.add(actor.id);
	check(['standard', 'conditional', 'disabled'].includes(actor.availability), `actor '${actor.id}' has invalid availability`);
	check(actor.sourceRefIds.every(id => sourceRefIds.has(id)), `actor '${actor.id}' has an unresolved source reference`);
	check(actor.targetProfileIds.every(id => profiles.has(id)), `actor '${actor.id}' has an unresolved target profile`);
	for (const armament of actor.armaments) {
		check(!armaments.has(armament.id), `duplicate armament '${armament.id}'`);
		check(armament.actorId === actor.id, `armament '${armament.id}' owner does not resolve`);
		check(armament.sourceRefIds.every(id => sourceRefIds.has(id)), `armament '${armament.id}' has an unresolved source reference`);
		check(armament.weaponSourceRefIds.every(id => sourceRefIds.has(id)),
			`armament '${armament.id}' has an unresolved weapon source reference`);
		armaments.set(armament.id, armament);
	}
}
ok(true, 'actor, armament, profile, and source-reference identities resolve');

for (const [index, ref] of data.sourceRefs.entries()) {
	check(ref.id === `s${index + 1}`, `source reference '${ref.id}' has non-deterministic identity`);
	check(Number.isInteger(ref.sourceFileIndex) && ref.sourceFileIndex >= 0 && ref.sourceFileIndex < data.sourceFiles.length,
		`source reference '${ref.id}' file index does not resolve`);
	check(Number.isInteger(ref.line) && ref.line > 0, `source reference '${ref.id}' line is not positive`);
}

for (const profile of data.targetProfiles) {
	check(profile.memberActorIds.length > 0 && profile.memberActorIds.every(id => actorIds.has(id)),
		`target profile '${profile.id}' has unresolved members`);
}

let previousEdge = '';
for (const edge of data.counterEdges) {
	const key = `${edge.armamentId}\0${edge.targetProfileId}`;
	check(key > previousEdge, `counter edge '${edge.armamentId}' -> '${edge.targetProfileId}' violates deterministic ordering`);
	previousEdge = key;
	check(armaments.has(edge.armamentId), `counter edge armament '${edge.armamentId}' does not resolve`);
	check(profiles.has(edge.targetProfileId), `counter edge target '${edge.targetProfileId}' does not resolve`);
	check(edge.peakDamagePerSalvo > 0, `counter edge '${edge.armamentId}' lacks positive nominal damage`);
}
ok(true, 'counter edges are ordered, positive, and fully referential');

function actor(id) {
	const value = data.actors.find(candidate => candidate.id === id);
	if (!value)
		fail(`missing actor '${id}'`);
	return value;
}

function armament(id) {
	const value = armaments.get(id);
	if (!value)
		fail(`missing armament '${id}'`);
	return value;
}

function targetProfile(actorId, targetType) {
	const value = actor(actorId).targetProfileIds.map(id => profiles.get(id))
		.find(profile => !targetType || profile.targetTypes.includes(targetType));
	if (!value)
		fail(`missing target profile '${actorId}' / '${targetType ?? '*'}'`);
	return value;
}

function edge(armamentId, actorId, targetType) {
	const profile = targetProfile(actorId, targetType);
	return data.counterEdges.find(candidate => candidate.armamentId === armamentId && candidate.targetProfileId === profile.id);
}

function citedLines(sourceIds) {
	return sourceIds.map(id => {
		const ref = data.sourceRefs.find(candidate => candidate.id === id);
		const source = data.sourceFiles[ref.sourceFileIndex];
		const lines = fs.readFileSync(sourcePath(source.path), 'utf8').split(/\r?\n/);
		return `${source.path}:${ref.line}:${lines[ref.line - 1].trim()}`;
	});
}

for (const queue of data.globals.productionQueues) {
	const queueLines = citedLines(queue.sourceRefIds);
	ok(queueLines.some(line => line.endsWith(`ClassicProductionQueue@${queue.type}:`)),
		`queue '${queue.type}' cites its own trait definition`);
}

const yakStates = actor('yak').targetProfileIds.map(id => profiles.get(id).targetTypes.join(','));
ok(yakStates.includes('AirborneActor') && yakStates.includes('GroundActor,Vehicle') &&
	yakStates.includes('GroundActor,Repair,Vehicle'), 'aircraft profiles separate airborne, parked, and parked-damaged unions');
const mammothStates = actor('4tnk').targetProfileIds.map(id => profiles.get(id).targetTypes.join(','));
ok(mammothStates.includes('GroundActor,Repair,Vehicle') && !mammothStates.includes('Repair'),
	'damaged vehicles union Repair with their simultaneously enabled ground target types');

ok(actor('harv').movement.crushes.includes('infantry'), 'harvester mechanically crushes infantry');
ok(actor('e3').displayName === 'Rocket Soldier', 'E3 identity is Rocket Soldier');
ok(actor('powr').placement.adjacentCells === 2, 'standard building adjacency is 2 cells');
ok(actor('brik').placement.adjacentCells === 7, 'wall adjacency is 7 cells');
ok(actor('spen').placement.adjacentCells === 8, 'naval building adjacency is 8 cells');
ok(actor('fact').placement.baseProviderRange1024 === 16 * 1024, 'Construction Yard base-provider range is 16 cells');
ok(data.globals.productionQueues.every(queue => queue.lowPowerModifierPct === 300), 'all RA queues expose the 3x low-power slowdown');

ok(!edge('dog:primary', '1tnk'), 'dog bite cannot damage a light tank');
ok(!edge('4tnk:primary', 'e3'), 'Mammoth 120mm armament cannot target infantry');
ok(Boolean(edge('4tnk:secondary', 'e3')), 'Mammoth tusks can target infantry');
ok(Boolean(edge('ftrk:aa', 'yak', 'AirborneActor')), 'flak truck AA armament damages airborne aircraft');
ok(Boolean(edge('msub:secondary', 'yak', 'AirborneActor')), 'missile submarine AA armament damages airborne aircraft');
ok(Boolean(edge('ca:primary', 'fact')), 'cruiser primary armament damages structures');
ok(edge('ss:primary', 'dd', 'WaterActor').peakDamagePerSalvo < actor('dd').hp,
	'submarine does not one-volley a full-health destroyer');

const cruiserGuns = actor('ca').armaments.filter(value => value.weaponId === '8Inch');
ok(cruiserGuns.length === 2 && cruiserGuns.every(value => value.maxRange1024 === 20 * 1024),
	'cruiser exposes both independent 20-cell 8Inch armaments');
ok(cruiserGuns.every(value => value.damageWarheads.some(warhead => warhead.falloffPct?.[0] === 1000)),
	'cruiser armaments preserve the 1000% center falloff fact');
for (const gun of cruiserGuns) {
	const weaponLines = citedLines(gun.weaponSourceRefIds);
	ok(weaponLines.some(line => line.endsWith('8Inch:')) && weaponLines.some(line => line.endsWith('Range: 20c0')) &&
		weaponLines.some(line => line.endsWith('Damage: 2500')) &&
		weaponLines.some(line => line.startsWith('ra|weapons/ballistics.yaml:143:Falloff: 1000,')),
		`cruiser armament '${gun.id}' cites its exact weapon range, damage, and falloff definition`);
}
ok(actor('ftrk').armaments.some(value => value.weaponId === 'FLAK-23-AA') &&
	actor('ftrk').armaments.some(value => value.weaponId === 'FLAK-23-AG'), 'flak truck exposes both AA and ground armaments');
ok(actor('dd').armaments.map(value => value.weaponId).sort().join(',') === 'DepthCharge,Stinger,StingerAA',
	'destroyer exposes surface, anti-air, and depth-charge armaments');
ok(armament('msub:primary').maxRange1024 === 20 * 1024, 'missile submarine surface missile range is 20 cells');

console.log(`ARSENAL GATE PASS rulesHash=${data.rulesHash} artifactHash=${data.artifactHash} bytes=${bytes.length}`);
