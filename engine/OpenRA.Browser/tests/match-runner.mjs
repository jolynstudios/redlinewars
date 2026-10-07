// Live agent-vs-agent match runner: boots the real UI, fills the setup panel,
// starts a match, and follows it to the end — logging match state and both
// thought feeds to JSONL, taking periodic screenshots, and enforcing the spend
// cap plus a wall-clock safety limit. Winner detection: each poll scans the
// match-state participants (LLM agents plus an optional engine-bot opponent)
// for a resolved winState. The durable page stash wins the final race, and the
// result (plus the last non-empty participant snapshot) lands in outcome.json,
// because the world tears down on victory before the final poll would see it.
// The OpenRouter key never appears here:
// the panel receives the 'use-env-key' sentinel and the sidecar substitutes
// the key from its own environment.
// --lessons wires the learned-series track (BENCHMARK.md): 'on' injects each
// model's own lessons file into its seat prompt and rewrites it through the
// sidecar's /api/reflect after the terminal state; 'control' is the
// fresh-context baseline the track must be reported against.
// --seed pins the engine's server RNG through the boot URL so a result can be
// reproduced; --era-lock refuses to start (exit 3) when any prompt-shaping
// source drifted from the committed era lock, because leaderboard eras are
// only comparable across byte-identical sources.
// Usage:
//   node match-runner.mjs --model1 openai/gpt-5-mini --model2 google/gemini-2.5-flash \
//     [--playbook1 soviet-armor] [--playbook2 soviet-grenadier-rush] [--cap 2.00] \
//     [--label match1] [--minutes 45]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, appendFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	loadCalibrationBundle,
	validateDecisionModelIdentity,
	validateOutcomeModelIdentity,
	validateProviderEndpointProvenance
} from './benchmark-series-lib.mjs';
import { EraFiles } from './era-surfaces.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const InfrastructureExitCode = 4;
const BenchmarkLockstepSpecVersion = 'benchmark-lockstep-v1';
const DefaultAgentMapUid = 'a-nuclear-winter';
const args = process.argv.slice(2);
// This runner spends real money the moment it starts: unknown flags (including
// --help) must never fall through to defaults and silently launch a match.
const usage = 'Usage: node match-runner.mjs --model1 <id> --model2 <id> ' +
	'[--playbook1 <name>] [--playbook2 <name>] [--faction1 <f>] [--faction2 <f>] ' +
	'[--effort1 low|medium|high] [--effort2 ...] [--reaction-model1 <id>] [--reaction-model2 <id>] ' +
	'[--reaction-effort1 low|medium|high] [--reaction-effort2 ...] [--cap <usd>] [--label <name>] ' +
	'[--minutes <n>] [--port <n>] [--sidecar <local-url>] [--lessons off|on|control] [--seed <n>] ' +
	'[--game-speed slowest|slower|default|fast|faster|fastest] ' +
	'[--benchmark-lockstep] [--tick-horizon <n>] [--decision-horizon <n>] [--decision-timeout-ms <n>] ' +
	'[--map <uid>] [--benchmark-calibration <frozen.json>] ' +
	'[--era-lock <path>] [--headed] [--arsenal] [--executor] [--guided] [--fallback-strike] ' +
	'[--play] [--staff-seat] [--mirror] [--dry-run]';
const valueFlags = new Set(['model1', 'model2', 'playbook1', 'playbook2', 'faction1', 'faction2',
	'effort1', 'effort2', 'reaction-model1', 'reaction-model2', 'reaction-effort1', 'reaction-effort2',
	'cap', 'label', 'minutes', 'port', 'sidecar', 'lessons', 'seed', 'era-lock', 'game-speed',
	'tick-horizon', 'decision-horizon', 'decision-timeout-ms', 'map', 'benchmark-calibration']);
const booleanFlags = new Set(['headed', 'mirror', 'dry-run', 'arsenal', 'executor', 'guided',
	'fallback-strike', 'play', 'staff-seat', 'benchmark-lockstep']);
const parsed = new Map();

const argumentError = message => {
	console.error(`${message}\n${usage}`);
	process.exit(2);
};

for (let i = 0; i < args.length; i++) {
	const token = args[i];
	if (!token.startsWith('--') || token.length === 2) {
		argumentError(`Unexpected argument '${token}'.`);
	}

	const name = token.slice(2);
	if (!valueFlags.has(name) && !booleanFlags.has(name)) {
		argumentError(`Unknown flag ${token}.`);
	}

	if (parsed.has(name)) {
		argumentError(`Flag ${token} was supplied more than once.`);
	}

	if (booleanFlags.has(name)) {
		parsed.set(name, true);
		continue;
	}

	const value = args[++i];
	if (value == null || value.startsWith('-')) {
		argumentError(`Flag ${token} requires a non-flag value.`);
	}

	parsed.set(name, value);
}

const arg = (name, fallback) => parsed.get(name) ?? fallback;
const model1 = arg('model1', 'openai/gpt-5-mini');
const model2 = arg('model2', 'google/gemini-2.5-flash');
// Cross-model battles are the default product experience; same-model mirrors
// are a benchmark calibration tool and must be requested explicitly.
if (model1 === model2 && !args.includes('--mirror')) {
	console.error(`Both seats use ${model1}. Mirror matches calibrate self-play variance ` +
		'but are not battles; pass --mirror to run one deliberately.');
	process.exit(2);
}
const playbook1 = arg('playbook1', '');
const playbook2 = arg('playbook2', '');
const faction1 = arg('faction1', 'russia');
const faction2 = arg('faction2', 'russia');
const effort1 = arg('effort1', '');
const effort2 = arg('effort2', '');
const reactionModel1 = arg('reaction-model1', '');
const reactionModel2 = arg('reaction-model2', '');
const reactionEffort1 = arg('reaction-effort1', '');
const reactionEffort2 = arg('reaction-effort2', '');
const cap = arg('cap', '2.00');
const label = arg('label', 'match');
const maxMinutes = Number(arg('minutes', '45'));
const httpPort = Number(arg('port', '8379'));
const sidecarUrl = arg('sidecar', 'http://127.0.0.1:4112').replace(/\/+$/, '');
// --headed opens a visible browser window so a human can spectate the match.
const headed = parsed.has('headed');
// --arsenal enables the era3 strategy arsenal (Host.StrategyArsenal=1):
// menu-mode prompts, adoptStrategy, and the five-pin hash preflight.
const play = parsed.has('play');
const staffSeat = parsed.has('staff-seat');
const arsenal = parsed.has('arsenal') || play || staffSeat;
// --executor runs the deterministic doctrine autopilot (Host.DoctrineExecutor=1):
// standing scout/stream/squad behaviours that carry out the card the model
// adopts. The autopilot only acts once a strategy is bound, and adoptStrategy
// lives solely on the arsenal action schema, so --executor is a no-op without
// --arsenal; refuse the pairing rather than bill a dead run.
const executor = parsed.has('executor') || play || staffSeat;

// Guidance never submits by itself: it only exposes exact legal batches and
// the model-selected acceptance action. Executor and play also need the exact
// doctrine commit surface.
const guided = parsed.has('guided') || play || staffSeat;
const fallbackStrike = parsed.has('fallback-strike') || play;
if (executor && !arsenal && !parsed.has('benchmark-lockstep'))
	argumentError('--executor requires --arsenal: the doctrine autopilot only acts on an adopted strategy card.');
if (fallbackStrike && !executor)
	argumentError('--fallback-strike requires --executor (or --play).');
const mirror = parsed.has('mirror');
const dryRun = parsed.has('dry-run');
const benchmarkLockstep = parsed.has('benchmark-lockstep');
const benchmarkTickHorizon = Number(arg('tick-horizon', benchmarkLockstep ? '22500' : '0'));
const benchmarkDecisionHorizon = Number(arg('decision-horizon', benchmarkLockstep ? '40' : '0'));
const benchmarkDecisionTimeoutMs = Number(arg('decision-timeout-ms', benchmarkLockstep ? '120000' : '0'));
const requestedMapUid = arg('map', '');
const effectiveMapUid = requestedMapUid || DefaultAgentMapUid;
const benchmarkCalibrationPath = arg('benchmark-calibration', '');
const lessonsMode = arg('lessons', 'off');
// Lobby gamespeed (shared by both seats). Default fastest ≈ 2× wall-clock vs default.
const gameSpeed = String(arg('game-speed', 'fastest')).toLowerCase();
const allowedGameSpeeds = new Set(['slowest', 'slower', 'default', 'fast', 'faster', 'fastest']);
if (!allowedGameSpeeds.has(gameSpeed))
	argumentError(`--game-speed must be one of: ${[...allowedGameSpeeds].join('|')}`);
const seedRaw = arg('seed', '');
const eraLockPath = arg('era-lock', '');
const resolvedProfile = benchmarkLockstep ? 'benchmark-lockstep'
	: staffSeat && arsenal && executor && guided && !fallbackStrike && !play ? 'staff-seat'
	: play && arsenal && executor && guided && fallbackStrike && !staffSeat ? 'play'
		: arsenal && executor && !guided && !fallbackStrike && !staffSeat && !play ? 'executor'
			: !arsenal && !executor && guided && !fallbackStrike && !staffSeat && !play ? 'guided'
				: arsenal && !executor && !guided && !fallbackStrike && !staffSeat && !play ? 'arsenal'
					: !arsenal && !executor && !guided && !fallbackStrike && !staffSeat && !play ? 'raw' : 'custom';

if (!Number.isFinite(Number(cap)) || Number(cap) <= 0)
	argumentError('--cap must be a positive number.');
if (!Number.isFinite(maxMinutes) || maxMinutes <= 0)
	argumentError('--minutes must be a positive number.');
if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535)
	argumentError('--port must be an integer between 1 and 65535.');
try {
	const parsedSidecar = new URL(sidecarUrl);
	if (parsedSidecar.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedSidecar.hostname) ||
		parsedSidecar.username !== '' || parsedSidecar.password !== '')
		argumentError('--sidecar must be an unauthenticated local HTTP URL.');
} catch {
	argumentError('--sidecar must be an unauthenticated local HTTP URL.');
}
if (![effort1, effort2].every(effort => effort === '' || ['low', 'medium', 'high'].includes(effort)))
	argumentError('--effort1 and --effort2 must be low, medium, or high.');
if (![reactionEffort1, reactionEffort2].every(effort => effort === '' || ['low', 'medium', 'high'].includes(effort)))
	argumentError('--reaction-effort1 and --reaction-effort2 must be low, medium, or high.');
if (staffSeat && (!reactionModel1 || !reactionModel2))
	argumentError('--staff-seat requires --reaction-model1 and --reaction-model2.');
if (!staffSeat && [reactionModel1, reactionModel2, reactionEffort1, reactionEffort2].some(Boolean))
	argumentError('--reaction-model/effort flags require --staff-seat.');
if (!/^[A-Za-z0-9._-]+$/.test(label))
	argumentError('--label must contain only letters, numbers, dot, underscore, or hyphen.');
if (![playbook1, playbook2].every(name => name === '' || /^[A-Za-z0-9_-]+$/.test(name)))
	argumentError('--playbook1 and --playbook2 must contain only letters, numbers, underscore, or hyphen.');
if (!['off', 'on', 'control'].includes(lessonsMode))
	argumentError('--lessons must be off, on, or control.');
if (benchmarkLockstep) {
	if (requestedMapUid === '')
		argumentError('--map is required for --benchmark-lockstep; implicit map selection is forbidden.');
	if (parsed.has('cap'))
		argumentError('--cap is a dollar stop and is incompatible with --benchmark-lockstep; spend is report-only.');
	if (play)
		argumentError('--play enables advisor fallback and play cadence, both incompatible with --benchmark-lockstep.');
	if (fallbackStrike)
		argumentError('--fallback-strike is incompatible with --benchmark-lockstep.');
	if (staffSeat)
		argumentError('--staff-seat is incompatible with --benchmark-lockstep; each seat must use one pinned strategist model.');
	if (executor)
		argumentError('--executor is incompatible with --benchmark-lockstep; the skill track is raw.');
	if (arsenal)
		argumentError('--arsenal is incompatible with --benchmark-lockstep; the skill track is raw.');
	if (guided)
		argumentError('--guided is incompatible with --benchmark-lockstep; the skill track is raw.');
	if (parsed.has('lessons'))
		argumentError('--lessons is incompatible with --benchmark-lockstep; cross-match learning makes the skill track order-dependent.');
	if (!Number.isSafeInteger(benchmarkTickHorizon) || benchmarkTickHorizon < 0 ||
		!Number.isSafeInteger(benchmarkDecisionHorizon) || benchmarkDecisionHorizon < 0 ||
		(benchmarkTickHorizon === 0 && benchmarkDecisionHorizon === 0))
		argumentError('--benchmark-lockstep requires a positive --tick-horizon or --decision-horizon.');
	if (!Number.isSafeInteger(benchmarkDecisionTimeoutMs) || benchmarkDecisionTimeoutMs < 10000 ||
		benchmarkDecisionTimeoutMs > 120000)
		argumentError('--decision-timeout-ms must be an integer between 10000 and 120000.');
} else if (parsed.has('tick-horizon') || parsed.has('decision-horizon') || parsed.has('decision-timeout-ms')) {
	argumentError('--tick-horizon, --decision-horizon, and --decision-timeout-ms require --benchmark-lockstep.');
}
if (parsed.has('benchmark-calibration') && !benchmarkLockstep)
	argumentError('--benchmark-calibration requires --benchmark-lockstep.');
if (requestedMapUid !== '' && !/^[A-Za-z0-9._-]{1,128}$/.test(requestedMapUid))
	argumentError('--map must be a map uid containing only letters, numbers, dot, underscore, or hyphen.');

let benchmarkCalibration = null;
if (benchmarkCalibrationPath !== '') {
	try {
		const loaded = loadCalibrationBundle(benchmarkCalibrationPath, { mapId: requestedMapUid });
		benchmarkCalibration = {
			path: loaded.path,
			calibrationId: loaded.normalized.calibrationId,
			digest: loaded.normalized.digest,
			mapId: loaded.normalized.mapId,
			controlRegionHash: loaded.normalized.controlRegionHash,
			regions: loaded.normalized.regions
		};
	} catch (error) {
		argumentError(`--benchmark-calibration: ${error.message}`);
	}
}

// The seed reaches the engine verbatim through the boot URL, so anything the
// server's 32-bit seed cannot represent must be rejected here, not mid-boot.
let seed = null;
if (seedRaw !== '') {
	if (!/^\d+$/.test(seedRaw) || !Number.isSafeInteger(Number(seedRaw)))
		argumentError('--seed must be an integer between 1 and 2147483647.');
	seed = Number(seedRaw);
	if (seed < 1 || seed > 2 ** 31 - 1)
		argumentError('--seed must be an integer between 1 and 2147483647.');
}

// Era lock (BENCHMARK.md): results are only comparable within an era while
// every prompt-shaping source stays byte-identical to what the lock recorded.
// Sources are re-hashed from the working tree and any drift refuses the match
// (exit 3) before a server, browser, or dollar is committed. engineCommit is
// stamped provenance only: checking it would require invoking git at match
// time, and the hashed sources are what actually shape agent behavior.
const sha256Hex = data => createHash('sha256').update(data).digest('hex');
// lockHash contract: sha256 over the lock body with the lockHash field
// removed, keys sorted at every level, no whitespace.
const canonicalJson = value => {
	if (Array.isArray(value))
		return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `{${Object.keys(value).sort().map(key =>
			`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
	}

	return JSON.stringify(value);
};
let eraLock = null;
if (eraLockPath !== '') {
	let lockText;
	try {
		lockText = readFileSync(eraLockPath, 'utf8');
	} catch (error) {
		argumentError(`--era-lock: cannot read ${eraLockPath} (${error.message}).`);
	}

	try {
		eraLock = JSON.parse(lockText);
	} catch (error) {
		argumentError(`--era-lock: ${eraLockPath} is not valid JSON (${error.message}).`);
	}

	if (eraLock === null || typeof eraLock !== 'object' || Array.isArray(eraLock))
		argumentError(`--era-lock: ${eraLockPath} must contain a JSON object.`);
	if (eraLock.files === null || typeof eraLock.files !== 'object' || Array.isArray(eraLock.files))
		argumentError(`--era-lock: ${eraLockPath} must contain a files object.`);
	if (eraLock.doctrineHashes === null || typeof eraLock.doctrineHashes !== 'object' ||
		Array.isArray(eraLock.doctrineHashes))
		argumentError(`--era-lock: ${eraLockPath} must contain a doctrineHashes object.`);
	for (const legacyField of ['actionSchemaHash', 'primerHash', 'knowledgeHash']) {
		if (Object.prototype.hasOwnProperty.call(eraLock, legacyField))
			argumentError(`--era-lock: ${eraLockPath} contains malformed legacy field '${legacyField}'; regenerate it.`);
	}
	for (const relPath of Object.keys(eraLock.files)) {
		if (relPath.startsWith('/') || relPath.split('/').includes('..'))
			argumentError(`--era-lock: files["${relPath}"] must be a Browser-root-relative path.`);
	}

	// Doctrine ids become file paths: the --playbook1/2 charset rule keeps a
	// hand-edited lock from reaching outside the playbooks directory.
	for (const playbookId of Object.keys(eraLock.doctrineHashes)) {
		if (!/^[A-Za-z0-9_-]+$/.test(playbookId))
			argumentError(`--era-lock: doctrine id '${playbookId}' is not a valid playbook name.`);
	}

	// An unreadable source hashes to null: deletion is drift, not a crash.
	const hashSourceFile = relPath => {
		try {
			return sha256Hex(readFileSync(path.join(testsDir, '..', relPath)));
		} catch {
			return null;
		}
	};
	const liveFiles = Object.fromEntries(EraFiles.map(relPath => [relPath, hashSourceFile(relPath)]));
	const drifted = [];
	for (const relPath of [...new Set([...Object.keys(eraLock.files), ...Object.keys(liveFiles)])].sort()) {
		const locked = Object.prototype.hasOwnProperty.call(eraLock.files, relPath)
			? eraLock.files[relPath] : null;
		const actual = Object.prototype.hasOwnProperty.call(liveFiles, relPath)
			? liveFiles[relPath] : null;
		if (actual !== locked)
			drifted.push(`${relPath} (files: lock has ${locked ?? 'no entry'}, ` +
				`live surface map has ${actual ?? 'no entry'})`);
	}
	for (const [playbookId, locked] of Object.entries(eraLock.doctrineHashes)) {
		const relPath = `agent-sidecar/knowledge/playbooks/${playbookId}.md`;
		const actual = hashSourceFile(relPath);
		if (actual !== locked)
			drifted.push(`${relPath} (doctrineHashes.${playbookId}: lock has ${locked}, ` +
				`working tree has ${actual ?? 'no readable file'})`);
	}

	// The lock must also agree with itself: the leaderboard partitions eras by
	// lockHash, so a body edit without a lockHash refresh is drift of the lock
	// file itself.
	const { lockHash, ...lockBody } = eraLock;
	if (sha256Hex(canonicalJson(lockBody)) !== lockHash)
		drifted.push(`${eraLockPath} (lockHash does not match the canonicalized lock body)`);

	if (drifted.length > 0) {
		console.error(['Era lock drift; refusing to start:', ...drifted.map(line => `  ${line}`)].join('\n'));
		process.exit(3);
	}
}

const pinnedModelConfig = {
	specVersion: benchmarkLockstep ? BenchmarkLockstepSpecVersion : null,
	maxOutputTokens: executor ? 8192 : 4096,
	seats: [
		{ seat: 'agent1', model: model1, reasoningEffort: effort1 || 'provider-default' },
		{ seat: 'agent2', model: model2, reasoningEffort: effort2 || 'provider-default' }
	]
};
const benchmarkConfig = {
	enabled: benchmarkLockstep,
	specVersion: benchmarkLockstep ? BenchmarkLockstepSpecVersion : null,
	decisionTimeoutMs: benchmarkLockstep ? benchmarkDecisionTimeoutMs : null,
	tickHorizon: benchmarkLockstep ? benchmarkTickHorizon : null,
	decisionHorizon: benchmarkLockstep ? benchmarkDecisionHorizon : null,
	calibration: benchmarkLockstep && benchmarkCalibration != null ? {
		calibrationId: benchmarkCalibration.calibrationId,
		digest: benchmarkCalibration.digest,
		mapId: benchmarkCalibration.mapId,
		controlRegionHash: benchmarkCalibration.controlRegionHash
	} : null,
	stopPolicy: benchmarkLockstep ? {
		game: 'first-of-terminal-tick-horizon-decision-horizon',
		dollarStop: false,
		wallClockSafetyMinutes: maxMinutes,
		spendCapUsd: Number(cap),
		spendCapMode: 'report-only'
	} : null
};
const resolvedConfig = {
	model1, model2, playbook1, playbook2, faction1, faction2, effort1, effort2,
	reactionModel1, reactionModel2, reactionEffort1, reactionEffort2,
	cap, label, maxMinutes, httpPort, sidecarUrl, headed, arsenal, executor, guided, fallbackStrike,
	play, staffSeat, mirror, lessonsMode, seed, eraLock, benchmarkLockstep,
	benchmarkTickHorizon, benchmarkDecisionHorizon, benchmarkDecisionTimeoutMs,
	requestedMapUid, effectiveMapUid, benchmarkCalibrationPath: benchmarkCalibration?.path ?? null,
	benchmarkSpecVersion: benchmarkLockstep ? BenchmarkLockstepSpecVersion : null,
	pinnedModelConfig, benchmarkConfig, resolvedProfile
};
if (dryRun) {
	console.log(JSON.stringify(resolvedConfig));
	process.exit(0);
}

let providerEndpoint;
try {
	providerEndpoint = await readSidecarProviderEndpoint();
} catch (error) {
	console.error(`Provider endpoint preflight failed before tick 0: ${error.message}`);
	process.exit(InfrastructureExitCode);
}

const outDir = path.join(testsDir, 'match-results', label);
mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, 'log.jsonl');
const log = entry => appendFileSync(logPath, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);

const playbookText = name => {
	if (!name) return '';
	const file = path.join(testsDir, '../agent-sidecar/knowledge/playbooks', `${name}.md`);
	return readFileSync(file, 'utf8').slice(0, 7800);
};

// Learned-series track: each model owns one lessons file under tests/lessons/,
// named by slug so OpenRouter ids ('/' and '.') stay filesystem-safe. Lessons
// are keyed by model, not seat — a mirror match rewrites the same file twice.
const lessonsDir = path.join(testsDir, 'lessons');
const modelSlug = model => model.replace(/[/.]/g, '-');
const lessonsHeader = '\n\nLESSONS FROM YOUR PAST MATCHES (self-written, may be stale):\n';
// A raw match (no playbooks) must differ between seats only by model. Leaving
// the prompt fields untouched would keep the panel's asymmetric per-seat
// defaults (Red plays aggressive-balanced, Blue plays defensive), so both
// seats are pinned to one neutral prompt instead.
const neutralPrompt = 'Win the skirmish. Scout, build an economy, produce an army, and destroy the enemy.';
const rawPromptMatch = playbook1 === '' && playbook2 === '';
const assembleSeatPrompt = (playbookName, model) => {
	const playbook = rawPromptMatch ? neutralPrompt : playbookText(playbookName);
	if (lessonsMode !== 'on') return { prompt: playbook, injected: null };
	const file = path.join(lessonsDir, `${modelSlug(model)}.md`);
	if (!existsSync(file)) return { prompt: playbook, injected: null };
	// 2500 mirrors the reflect contract's priorLessons cap: never inject more
	// than the reflection step can be shown again afterwards.
	const lessons = readFileSync(file, 'utf8').slice(0, 2500);
	// The combined prompt honors the same 7800-char panel bound the playbook
	// slice does. `injected` is the lessons text that actually survived the
	// cap; if nothing did, keep the plain playbook rather than leave the model
	// a dangling truncated header.
	const combined = `${playbook}${lessonsHeader}${lessons}`.slice(0, 7800);
	const injected = combined.slice(playbook.length + lessonsHeader.length);
	if (injected.length === 0) return { prompt: playbook, injected: null };
	return { prompt: combined, injected };
};

// outcome.json pins the injected lessons by digest so a learned-series result
// can be audited against the lessons file history without storing the text.
const injectedDigest = text => text == null ? null : createHash('sha256').update(text).digest('hex');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const serverUrl = `http://127.0.0.1:${httpPort}/index.html`;
const bootParams = new URLSearchParams({
	mode: 'game',
	platform: 'webgl2',
	'Host.AgentMode': '1',
	'Host.DevContent': '1',
	'Launch.Map': effectiveMapUid,
	'Host.GameSpeed': gameSpeed
});
if (arsenal) bootParams.set('Host.StrategyArsenal', '1');
if (executor) bootParams.set('Host.DoctrineExecutor', '1');
if (guided) bootParams.set('Host.ActionGuidance', '1');
if (fallbackStrike) bootParams.set('Host.DoctrineFallbackStrike', '1');
if (play) {
	bootParams.set('Host.AdvisorFallback', '1');
	bootParams.set('Host.PlayCadence', '1');
}
if (staffSeat) {
	bootParams.set('Host.StaffSeat', '1');
	bootParams.set('Host.ReactionModel1', reactionModel1);
	bootParams.set('Host.ReactionModel2', reactionModel2);
	if (reactionEffort1) bootParams.set('Host.ReactionEffort1', reactionEffort1);
	if (reactionEffort2) bootParams.set('Host.ReactionEffort2', reactionEffort2);
}
if (benchmarkLockstep) {
	bootParams.set('Host.BenchmarkLockstep', '1');
	bootParams.set('Host.PrematchPlanning', '1');
	bootParams.set('Host.BenchmarkDecisionTimeoutMs', String(benchmarkDecisionTimeoutMs));
	bootParams.set('Host.BenchmarkTickHorizon', String(benchmarkTickHorizon));
	bootParams.set('Host.BenchmarkDecisionHorizon', String(benchmarkDecisionHorizon));
	if (benchmarkCalibration != null)
		bootParams.set('Host.BenchmarkControlRegions', JSON.stringify(benchmarkCalibration.regions));
}
if (seed != null) bootParams.set('Debug.ServerRandomSeed', String(seed));
let server;
let browser;
let cleanupPromise;

async function probe(url, timeoutMs = 500) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
		await response.body?.cancel();
		return response.status;
	} catch {
		return null;
	}
}

async function readSidecarProviderEndpoint() {
	let response;
	try {
		response = await fetch(`${sidecarUrl}/health`, {
			signal: AbortSignal.timeout(5000),
			cache: 'no-store'
		});
	} catch (error) {
		throw new Error(`sidecar ${sidecarUrl} health request failed: ${error.message}`);
	}
	if (!response.ok)
		throw new Error(`sidecar ${sidecarUrl} health returned HTTP ${response.status}`);
	const health = await response.json().catch(() => null);
	const resolvedUrl = health?.providerEndpoint;
	if (typeof resolvedUrl !== 'string' || resolvedUrl.length === 0)
		throw new Error(`sidecar ${sidecarUrl} did not report its resolved provider endpoint`);
	let endpoint;
	try {
		endpoint = new URL(resolvedUrl);
	} catch {
		throw new Error(`sidecar reported invalid provider endpoint '${resolvedUrl}'`);
	}
	const record = {
		schemaVersion: 1,
		resolvedUrl,
		endpointHost: endpoint.host.toLowerCase(),
		loopback: ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname.toLowerCase())
	};
	try {
		return validateProviderEndpointProvenance({ providerEndpoint: record }, 'sidecar provider endpoint');
	} catch (error) {
		throw new Error(`${error.message}; found '${resolvedUrl}'`);
	}
}

async function stopChild(child) {
	if (child == null || child.exitCode != null || child.signalCode != null)
		return;

	const exited = new Promise(resolve => child.once('exit', resolve));
	child.kill('SIGTERM');
	await Promise.race([exited, delay(2000)]);
	if (child.exitCode == null && child.signalCode == null) {
		child.kill('SIGKILL');
		await Promise.race([exited, delay(2000)]);
	}
}

function cleanup() {
	if (cleanupPromise == null) {
		cleanupPromise = Promise.allSettled([
			browser == null ? Promise.resolve() : Promise.resolve().then(() => browser.close()),
			stopChild(server)
		]);
	}

	return cleanupPromise;
}

const onSignal = signal => {
	const exitCode = signal === 'SIGINT' ? 130 : 143;
	void cleanup().finally(() => process.exit(exitCode));
};
const onSigint = () => onSignal('SIGINT');
const onSigterm = () => onSignal('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

async function waitForOwnedServer(child, startupOutput) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (startupOutput.error != null)
			throw new Error(`Could not start the bundle server: ${startupOutput.error.message}`);
		if (child.exitCode != null || child.signalCode != null) {
			const detail = startupOutput.stderr.trim().slice(-500);
			throw new Error(`Bundle server exited before becoming ready${detail ? `: ${detail}` : '.'}`);
		}

		// Require both the readiness line from OUR child and an HTTP 200. This
		// prevents silently adopting a stale server that happens to own the port.
		if (startupOutput.listening && await probe(serverUrl) === 200)
			return;
		await delay(100);
	}

	throw new Error(`Bundle server did not become ready at ${serverUrl} within 10 seconds.`);
}

try {
	if (await probe(serverUrl) != null)
		throw new Error(`Port ${httpPort} is already serving HTTP; refusing to adopt an unowned bundle server.`);

	const startupOutput = { listening: false, stdout: '', stderr: '', error: null };
	server = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(httpPort)], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.once('error', error => { startupOutput.error = error; });
	server.stdout.on('data', chunk => {
		startupOutput.stdout = `${startupOutput.stdout}${String(chunk)}`.slice(-2000);
		if (startupOutput.stdout.includes('[server] serving '))
			startupOutput.listening = true;
	});
	server.stderr.on('data', chunk => {
		startupOutput.stderr = `${startupOutput.stderr}${String(chunk)}`.slice(-2000);
	});
	await waitForOwnedServer(server, startupOutput);

	browser = await chromium.launch({ headless: !headed });
	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	let pageInfrastructureFault = null;
	let modelIdentityCensorReason = null;
	const modelIdentityRecords = [];
	const pendingModelIdentityCaptures = new Set();
	const decideEndpoint = new URL(`${sidecarUrl}/api/decide`);
	const markModelIdentityFault = reason => {
		modelIdentityCensorReason ??= `model-identity: ${String(reason).slice(0, 300)}`;
	};
	const captureModelIdentity = async response => {
		const responseUrl = new URL(response.url());
		if (responseUrl.origin !== decideEndpoint.origin || responseUrl.pathname !== decideEndpoint.pathname)
			return;

		let requestBody;
		try {
			requestBody = response.request().postDataJSON();
		} catch {
			markModelIdentityFault('could not read the recorded decision request');
			return;
		}

		const payload = await response.json().catch(() => null);
		const identity = payload?.modelIdentity ?? null;
		if (identity != null) {
			try {
				validateDecisionModelIdentity(identity, {
					agentId: requestBody.agentId,
					decisionId: requestBody.decisionId,
					modelId: requestBody.model
				}, `${requestBody.agentId ?? 'unknown'} decision ${requestBody.decisionId ?? 'unknown'}`);
				// Only an accepted decision belongs in the score-time one-to-one
				// record set. Rejected/schema/timeout responses remain in JSONL
				// for diagnosis, but their deterministic no-op barrier seats are
				// intentionally absent from the accepted barrier trace.
				if (response.status() === 200)
					modelIdentityRecords.push(identity);
				log({
					kind: response.status() === 200 ? 'model-identity' : 'model-identity-rejected',
					agentId: identity.agentId,
					decisionId: identity.decisionId,
					requestedModelId: identity.requestedModelId,
					canonicalRequestedModelId: identity.canonicalRequestedModelId,
					httpStatus: response.status(),
					attempts: identity.attempts
				});
			} catch (error) {
				markModelIdentityFault(error.message);
				log({ kind: 'model-identity-error', text: String(error.message).slice(0, 300), identity });
			}
		} else if (response.status() === 200) {
			markModelIdentityFault(
				`${requestBody.agentId ?? 'unknown'} decision ${requestBody.decisionId ?? 'unknown'} ` +
				'returned HTTP 200 without provenance');
		}

		if (typeof payload?.infrastructureCensorReason === 'string' &&
			payload.infrastructureCensorReason.length > 0) {
			markModelIdentityFault(payload.infrastructureCensorReason);
		}
	};
	page.on('response', response => {
		const capture = captureModelIdentity(response)
			.catch(error => markModelIdentityFault(`capture failed: ${error.message}`))
			.finally(() => pendingModelIdentityCaptures.delete(capture));
		pendingModelIdentityCaptures.add(capture);
	});
	page.on('pageerror', error => {
		const text = String(error).slice(0, 300);
		pageInfrastructureFault ??= `pageerror: ${text}`;
		log({ kind: 'pageerror', text });
	});
	page.on('crash', () => {
		pageInfrastructureFault ??= 'browser page crashed';
		log({ kind: 'page-crash' });
	});

	await page.goto(`${serverUrl}?${bootParams}`);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
	log({ kind: 'booted', model1, model2, playbook1, playbook2, cap, sidecarUrl, mirror, lessonsMode,
		seed, requestedMapUid, effectiveMapUid, arsenal, executor, guided, fallbackStrike, play, staffSeat,
		reactionModel1: staffSeat ? reactionModel1 : null, reactionModel2: staffSeat ? reactionModel2 : null,
		reactionEffort1: staffSeat ? reactionEffort1 : null, reactionEffort2: staffSeat ? reactionEffort2 : null,
		resolvedProfile, gameSpeed, benchmarkLockstep, benchmarkConfig, pinnedModelConfig, providerEndpoint });

	// Assembled up front so the exact injected lessons text is known for
	// outcome.json auditing and as priorLessons in the post-match reflect call.
	const seat1 = assembleSeatPrompt(playbook1, model1);
	const seat2 = assembleSeatPrompt(playbook2, model2);

	await page.evaluate(config => {
		// The benchmark runner drives every compiled assist explicitly through URL
		// flags (Host.StrategyArsenal/DoctrineExecutor/ActionGuidance), which win
		// over the UI preset. Pin the preset to raw so the default RTS-Agent play
		// stack never adds an extra the profile did not request; a raw profile
		// stays byte-identical to the pre-preset harness.
		const preset = document.getElementById('agent-preset');
		if (preset) preset.value = 'raw';
		document.getElementById('agent-key-1').value = 'use-env-key';
		document.getElementById('agent-sidecar').value = config.sidecarUrl;
		document.getElementById('agent-model-1').value = config.model1;
		document.getElementById('agent-model-2').value = config.model2;
		document.getElementById('agent-map').value = config.effectiveMapUid;
		document.getElementById('agent-spend-cap').value = config.cap;
		// Reasoning models (gpt-5-mini) can burst past 2048 thinking tokens on hard
		// decisions, leaving no room for the JSON; evals buy the full headroom.
		document.getElementById('agent-max-tokens').value = config.executor ? '8192' : '4096';
		if (config.staffSeat) document.getElementById('agent-interval').value = '1500';
		// Doctrine playbooks assume a faction; Random would invalidate the eval.
		document.getElementById('agent-faction-1').value = config.faction1;
		document.getElementById('agent-faction-2').value = config.faction2;
		// Per-model reasoning profiles (empty = provider default).
		if (config.effort1) document.getElementById('agent-effort-1').value = config.effort1;
		if (config.effort2) document.getElementById('agent-effort-2').value = config.effort2;
		if (config.prompt1) document.getElementById('agent-prompt-1').value = config.prompt1;
		if (config.prompt2) document.getElementById('agent-prompt-2').value = config.prompt2;
	}, { model1, model2, cap, sidecarUrl, effectiveMapUid, faction1, faction2, effort1, effort2, executor, staffSeat,
		prompt1: seat1.prompt, prompt2: seat2.prompt });

	await page.click('#agent-estimate-button');
	await new Promise(r => setTimeout(r, 3000));
	log({ kind: 'estimate', text: await page.evaluate(() => document.getElementById('agent-estimate').textContent) });

	await page.click('#agent-start');
	// The click handler is async and performs a second pricing preflight before
	// StartAgentMatch. Do not let the 500 ms light poll mistake that legitimate
	// pre-start `inactive` state for a terminal match.
	await page.waitForFunction(() => {
		let matchState = {};
		try { matchState = JSON.parse(globalThis.ora.GetAgentMatchState()); } catch { }
		return ['planning', 'starting', 'running'].includes(matchState.state) ||
			globalThis.oraLastResolvedMatchState?.terminalKind != null ||
			document.getElementById('agent-match-status')?.classList.contains('agent-error');
	}, undefined, { timeout: 240_000 });
	const startedState = await page.evaluate(() => {
		let matchState = {};
		try { matchState = JSON.parse(globalThis.ora.GetAgentMatchState()); } catch { }
		return {
			state: matchState.state,
			resolvedProfile: matchState.resolvedProfile,
			decisionIntervalTicks: matchState.decisionIntervalTicks ?? null,
			benchmarkLockstep: matchState.benchmarkLockstep ?? null,
			status: document.getElementById('agent-match-status')?.textContent?.slice(0, 300),
			error: document.getElementById('agent-match-status')?.classList.contains('agent-error') === true,
			terminalKind: globalThis.oraLastResolvedMatchState?.terminalKind ?? null
		};
	});
	const validStartedState = ['planning', 'starting', 'running'].includes(startedState.state);
	if ((startedState.error || !validStartedState) && startedState.terminalKind == null)
		throw new Error(`Agent match did not start: ${startedState.status ?? startedState.state ?? 'unknown error'}`);
	if (benchmarkLockstep && (!Number.isSafeInteger(startedState.decisionIntervalTicks) ||
		startedState.decisionIntervalTicks < 25 || startedState.decisionIntervalTicks > 2500)) {
		throw new Error('Agent match did not report a valid host-used decision interval.');
	}
	if (benchmarkLockstep && (startedState.resolvedProfile !== 'benchmark-lockstep' ||
		startedState.benchmarkLockstep?.specVersion !== BenchmarkLockstepSpecVersion ||
		startedState.benchmarkLockstep?.decisionTimeoutMs !== benchmarkDecisionTimeoutMs ||
		startedState.benchmarkLockstep?.tickHorizon !== benchmarkTickHorizon ||
		startedState.benchmarkLockstep?.decisionHorizon !== benchmarkDecisionHorizon)) {
		throw new Error('Agent match did not report the pinned benchmark lockstep spec.');
	}
	const effectiveDecisionIntervalTicks = benchmarkLockstep ? startedState.decisionIntervalTicks : null;
	log({ kind: 'started', state: startedState.state, terminalKind: startedState.terminalKind,
		resolvedProfile: startedState.resolvedProfile, decisionIntervalTicks: effectiveDecisionIntervalTicks,
		benchmarkLockstep: startedState.benchmarkLockstep });

	const seen = new Set();
	// Mission telemetry is polled directly from the host sequence API. It is
	// deliberately independent from the DOM feed: presentation truncation,
	// hidden panels, or a slow heavy-poll must never erase benchmark facts.
	const missionCursors = new Map();
	const missionInstrumentation = new Set();
	const missionSeatById = new Map();
	const missionIssueKinds = new Set();
	// StopAgentMatch can win the narrow race between the light state snapshot
	// and GetAgentMissionEvents. Hold that API error provisionally: a terminal
	// stash at the same cursor proves the stream complete and clears it.
	const provisionalMissionErrors = new Map();
	const noteMissionSeats = snapshot => {
		(snapshot?.agents ?? []).forEach((agent, index) => {
			if (typeof agent?.agentId === 'string' && agent.agentId.length > 0)
				missionSeatById.set(agent.agentId, `agent${index + 1}`);
		});
	};
	const markMissionTelemetryIssue = (agent, agentId, issue, text) => {
		// A missing/old host would otherwise append the same error every 500 ms
		// for an hour. One bounded record per seat+class proves incompleteness.
		const key = `${agent ?? 'global'}:${issue}`;
		if (missionIssueKinds.has(key))
			return;
		missionIssueKinds.add(key);
		log({
			kind: 'mission-telemetry-error', agent, agentId, issue,
			text: String(text ?? issue).slice(0, 300)
		});
	};
	const recordMissionBatch = (response, source = 'host-poll') => {
		const { agent, agentId, batch } = response;
		if (batch == null || !Array.isArray(batch.events) || !Number.isSafeInteger(batch.latestSequence) ||
			batch.latestSequence < 0) {
			markMissionTelemetryIssue(agent, agentId, 'invalid-batch', response.error ?? 'invalid mission-event batch');
			return false;
		}

		if (!missionInstrumentation.has(agent)) {
			missionInstrumentation.add(agent);
			log({
				kind: 'mission-instrumentation', agent, agentId,
				schemaVersion: batch.schemaVersion ?? null, available: true
			});
		}

		const cursor = missionCursors.get(agent) ?? 0;
		if (batch.latestSequence < cursor) {
			markMissionTelemetryIssue(agent, agentId, 'cursor-regressed',
				`${source}: latestSequence ${batch.latestSequence} is behind cursor ${cursor}`);
			return false;
		}

		let complete = true;
		const seenInBatch = new Set();
		const events = [];
		for (const event of batch.events) {
			if (!Number.isSafeInteger(event?.sequence) || event.sequence < 1) {
				complete = false;
				markMissionTelemetryIssue(agent, agentId, 'invalid-sequence',
					`${source}: event has invalid sequence`);
				continue;
			}
			if (seenInBatch.has(event.sequence)) {
				complete = false;
				markMissionTelemetryIssue(agent, agentId, 'duplicate-sequence',
					`${source}: duplicate sequence ${event.sequence}`);
				continue;
			}
			seenInBatch.add(event.sequence);
			if (event.sequence > cursor)
				events.push(event);
		}
		events.sort((a, b) => a.sequence - b.sequence);

		let expected = cursor + 1;
		for (const event of events) {
			if (event.sequence !== expected) {
				complete = false;
				markMissionTelemetryIssue(agent, agentId, 'sequence-gap',
					`${source}: expected sequence ${expected}, received ${event.sequence}`);
			}
			expected = event.sequence + 1;
			log({
				kind: 'mission', agent, agentId, sequence: event.sequence,
				worldTick: event.worldTick ?? null,
				missionId: event.missionId ?? null,
				missionVersion: event.missionVersion ?? null,
				missionType: event.missionType ?? null,
				eventKind: event.kind ?? null,
				state: event.state ?? null,
				reason: event.reason ?? null,
				actorIds: Array.isArray(event.actorIds) ? event.actorIds : [],
				cell: event.cell ?? null,
				source
			});
		}
		if (expected !== batch.latestSequence + 1) {
			complete = false;
			markMissionTelemetryIssue(agent, agentId, 'sequence-gap',
				`${source}: events ended at ${expected - 1}, latestSequence is ${batch.latestSequence}`);
		}

		missionCursors.set(agent, batch.latestSequence);
		return complete;
	};
	const pollMissionEvents = async snapshot => {
		noteMissionSeats(snapshot);
		const requests = (snapshot.agents ?? []).map((agent, index) => ({
			agent: `agent${index + 1}`,
			agentId: agent?.agentId,
			sinceSequence: missionCursors.get(`agent${index + 1}`) ?? 0
		})).filter(request => typeof request.agentId === 'string' && request.agentId.length > 0);
		if (requests.length === 0)
			return;

		const responses = await page.evaluate(items => items.map(item => {
			try {
				const batch = JSON.parse(globalThis.ora.GetAgentMissionEvents(item.agentId, item.sinceSequence));
				if (batch?.error != null || !Array.isArray(batch?.events) ||
					typeof batch?.latestSequence !== 'number')
					return { ...item, error: batch?.error ?? 'invalid mission-event batch' };
				return { ...item, batch };
			} catch (error) {
				return { ...item, error: String(error).slice(0, 200) };
			}
		}), requests);

		for (const response of responses) {
			if (response.batch == null) {
				provisionalMissionErrors.set(response.agent, {
					agent: response.agent,
					agentId: response.agentId,
					issue: 'host-poll-error',
					text: response.error ?? 'mission-event host poll failed'
				});
				continue;
			}

			if (recordMissionBatch(response))
				provisionalMissionErrors.delete(response.agent);
		}
	};
	// Strategy adoption events: a lighter sibling of the mission poll. Any
	// poll error, invalid batch, or sequence gap emits strategy-telemetry-error
	// so the metrics report the seat's strategy block as incomplete (null)
	// rather than silently undercounting switches.
	const strategyCursors = new Map();
	const pollStrategyEvents = async snapshot => {
		const requests = (snapshot.agents ?? []).map((agent, index) => ({
			agent: `agent${index + 1}`,
			agentId: agent?.agentId,
			sinceSequence: strategyCursors.get(`agent${index + 1}`) ?? 0
		})).filter(request => typeof request.agentId === 'string' && request.agentId.length > 0);
		if (requests.length === 0)
			return;

		const responses = await page.evaluate(items => items.map(item => {
			try {
				if (typeof globalThis.ora?.GetAgentStrategyEvents !== 'function')
					return { ...item, unsupported: true };
				const batch = JSON.parse(globalThis.ora.GetAgentStrategyEvents(item.agentId, item.sinceSequence));
				if (batch?.error != null || !Array.isArray(batch?.events) ||
					typeof batch?.latestSequence !== 'number')
					return { ...item, error: batch?.error ?? 'invalid strategy-event batch' };
				return { ...item, batch };
			} catch (error) {
				return { ...item, error: String(error).slice(0, 200) };
			}
		}), requests);

		for (const response of responses) {
			if (response.unsupported)
				continue;
			if (response.batch == null) {
				// During pre-match planning the strategy slot is not queryable
				// yet — that is a phase, not a telemetry failure.
				const text = response.error ?? 'strategy-event host poll failed';
				if (/no Agent mode match is active|agent world is not ready|unknown agent id/i.test(text))
					continue;
				log({
					kind: 'strategy-telemetry-error', agent: response.agent, agentId: response.agentId,
					issue: 'host-poll-error', text
				});
				continue;
			}

			log({ kind: 'strategy-instrumentation', agent: response.agent, agentId: response.agentId, available: true });
			const cursor = strategyCursors.get(response.agent) ?? 0;
			const events = response.batch.events
				.filter(event => Number.isSafeInteger(event?.sequence) && event.sequence > cursor)
				.sort((a, b) => a.sequence - b.sequence);
			let expected = cursor + 1;
			for (const event of events) {
				if (event.sequence !== expected)
					log({
						kind: 'strategy-telemetry-error', agent: response.agent, agentId: response.agentId,
						issue: 'sequence-gap', text: `expected sequence ${expected}, received ${event.sequence}`
					});
				expected = event.sequence + 1;
				log({
					kind: 'strategy', agent: response.agent, agentId: response.agentId,
					sequence: event.sequence,
					worldTick: event.worldTick ?? null,
					eventKind: event.kind ?? null,
					strategyId: event.strategyId ?? null,
					previousStrategyId: event.previousStrategyId ?? null,
					cardVersion: event.cardVersion ?? null,
					catalogVersion: event.catalogVersion ?? null,
					modelReason: event.modelReason ?? null
				});
			}

			strategyCursors.set(response.agent, response.batch.latestSequence);
		}
	};
	const consumeStashedMissionEvents = snapshot => {
		noteMissionSeats(snapshot);
		for (const batch of snapshot?.missionEventBatches ?? []) {
			const agentId = batch?.agentId;
			const agent = missionSeatById.get(agentId);
			if (agent == null) {
				markMissionTelemetryIssue(null, agentId ?? null, 'unknown-agent',
					'terminal-state-stash mission batch has no matching seat');
				continue;
			}
			if (recordMissionBatch({ agent, agentId, batch }, 'terminal-state-stash'))
				provisionalMissionErrors.delete(agent);
		}
	};
	const flushProvisionalMissionErrors = () => {
		for (const pending of provisionalMissionErrors.values())
			markMissionTelemetryIssue(pending.agent, pending.agentId, pending.issue, pending.text);
		provisionalMissionErrors.clear();
	};
	// The reflect report wants each seat's closing thoughts: a 25-entry tail
	// per seat bounds memory however long the match runs or however chatty the
	// models get (`seen` only keeps 80-char dedupe prefixes, not full text).
	const recentBubbles = { agent1: [], agent2: [] };
	const recordBubble = (agent, bubble, includeInReflection = false) => {
		const text = bubble.slice(0, 600);
		log({ kind: 'bubble', agent, text });
		if (bubble.startsWith('FALLBACK'))
			log({ kind: 'fallback', agent, fallback: true, text });
		if (!includeInReflection)
			return;
		recentBubbles[agent].push(text);
		if (recentBubbles[agent].length > 25) recentBubbles[agent].shift();
	};
	const lockstepTraceDigests = new Map();
	const recordLockstepTrace = trace => {
		if (!benchmarkLockstep || !Array.isArray(trace))
			return;
		for (const barrier of trace) {
			if (!Number.isSafeInteger(barrier?.barrierId))
				continue;
			const digest = sha256Hex(canonicalJson(barrier));
			if (lockstepTraceDigests.get(barrier.barrierId) === digest)
				continue;
			lockstepTraceDigests.set(barrier.barrierId, digest);
			log({ kind: 'lockstep-barrier', traceVersion: 1, barrier });
		}
	};
	const deadline = Date.now() + maxMinutes * 60_000;
	let shots = 0;
	let lastShot = 0;
	let state = {};
	let lastAgentsSnapshot = null;
	let winner = null;
	let terminal = false;
	let terminalStateSource = 'poll';
	let lastAudioState = null;
	const participantsOf = snapshot => {
		const agents = Array.isArray(snapshot.agents) ? snapshot.agents.map((participant, index) => ({
			...participant,
			seat: `agent${index + 1}`,
			controllerType: participant.controllerType ?? 'llm'
		})) : [];
		const opponent = snapshot.opponent == null ? [] : [{
			...snapshot.opponent,
			seat: 'opponent',
			controllerType: snapshot.opponent.controllerType ?? snapshot.opponentBot ?? 'engine-bot'
		}];
		return [...agents, ...opponent];
	};
	const observeMatchState = (snapshot, prefer = false) => {
		state = { ...state, ...snapshot };
		const participants = participantsOf(snapshot);
		if (participants.length > 0) {
			lastAgentsSnapshot = {
				tick: snapshot.tick,
				agents: snapshot.agents ?? [],
				opponent: snapshot.opponent ?? null,
				opponentBot: snapshot.opponentBot ?? null
			};
			const won = participants.find(participant => participant.winState === 'Won');
			const survivors = participants.filter(participant => participant.winState !== 'Lost');
			const resolved = won ?? (survivors.length === 1 && participants.length > 1 ? survivors[0] : null);
			if (resolved != null && (winner == null || prefer)) {
				winner = {
					// outcome.json's public winner contract is the stable seat id;
					// retain the generated host id separately for replay correlation.
					agent: resolved.seat,
					participantId: resolved.agentId ?? `bot:${resolved.controllerType}`,
					seat: resolved.seat,
					controllerType: resolved.controllerType,
					how: won != null ? 'winState Won' : 'opponent winState Lost',
					tick: snapshot.tick
				};
				log({ kind: 'winner', source: prefer ? 'terminal-state-stash' : 'poll', ...winner });
			}
		}

		terminal = snapshot.terminalStash === true || snapshot.oos === true ||
			['finished', 'failed', 'inactive'].includes(snapshot.state);
	};
	while (Date.now() < deadline) {
		// Win states may exist only briefly before the page controller tears down
		// the match. Poll the cheap host JSON independently from the expensive DOM
		// feed scrape and screenshots to narrow that race without pausing the game.
		const heavyPollAt = Math.min(deadline, Date.now() + 15_000);
		while (!terminal && Date.now() < heavyPollAt) {
			await delay(Math.min(500, heavyPollAt - Date.now()));
			const light = await page.evaluate(() => {
				const stashed = globalThis.oraLastResolvedMatchState ?? null;
				if (stashed != null) {
					return {
						state: stashed.state, tick: stashed.worldTick, net: stashed.netFrame,
						oos: stashed.outOfSync, agents: stashed.agents,
						opponent: stashed.opponent, opponentBot: stashed.opponentBot,
						mapUid: stashed.mapUid, mapTitle: stashed.mapTitle,
						terminalKind: stashed.terminalKind ?? null,
						spendFinal: stashed.spendFinal,
						inFlightSpendRequests: stashed.inFlightSpendRequests,
						spend: document.getElementById('agent-live-spend')?.textContent,
						status: document.getElementById('agent-match-status')?.textContent?.slice(0, 200),
						resolvedProfile: stashed.resolvedProfile,
						adjudication: stashed.adjudication ?? null,
						buildPlanStallWatchdogTicks: stashed.buildPlanStallWatchdogTicks,
						buildPlanInternalFailureWatchdogTicks: stashed.buildPlanInternalFailureWatchdogTicks,
						lockstepTrace: globalThis.oraLastLockstepTrace ?? null,
						terminalStash: true
					};
				}

				try {
					const matchState = JSON.parse(globalThis.ora.GetAgentMatchState());
					return {
						state: matchState.state, tick: matchState.worldTick, net: matchState.netFrame,
						oos: matchState.outOfSync, agents: matchState.agents,
						opponent: matchState.opponent, opponentBot: matchState.opponentBot,
						mapUid: matchState.mapUid, mapTitle: matchState.mapTitle,
						resolvedProfile: matchState.resolvedProfile,
						benchmarkLockstep: matchState.benchmarkLockstep ?? null,
						adjudication: matchState.adjudication ?? null,
						buildPlanStallWatchdogTicks: matchState.buildPlanStallWatchdogTicks,
						buildPlanInternalFailureWatchdogTicks: matchState.buildPlanInternalFailureWatchdogTicks,
						lockstepTrace: globalThis.oraLastLockstepTrace ?? null
					};
				} catch {
					return {};
				}
			});
			recordLockstepTrace(light.lockstepTrace);
			if (!light.terminalStash)
				await pollMissionEvents(light);
				await pollStrategyEvents(light);
			observeMatchState(light);
		}

		if (terminal)
			break;

		const snapshot = await page.evaluate(() => {
			let matchState = {};
			try { matchState = JSON.parse(globalThis.ora.GetAgentMatchState()); } catch { }
			const feed = id => [...document.querySelectorAll(`#${id} .agent-bubble`)].map(b => ({
				text: b.textContent.replace(/\s+/g, ' ').trim(),
				decided: b.classList.contains('agent-bubble-decided')
			}));
			return {
				state: matchState.state, tick: matchState.worldTick, net: matchState.netFrame,
				oos: matchState.outOfSync, agents: matchState.agents,
				opponent: matchState.opponent, opponentBot: matchState.opponentBot,
				mapUid: matchState.mapUid, mapTitle: matchState.mapTitle,
				resolvedProfile: matchState.resolvedProfile,
				benchmarkLockstep: matchState.benchmarkLockstep ?? null,
				adjudication: matchState.adjudication ?? null,
				buildPlanStallWatchdogTicks: matchState.buildPlanStallWatchdogTicks,
				buildPlanInternalFailureWatchdogTicks: matchState.buildPlanInternalFailureWatchdogTicks,
				lockstepTrace: globalThis.oraLastLockstepTrace ?? null,
				spend: document.getElementById('agent-live-spend')?.textContent,
				status: document.getElementById('agent-match-status')?.textContent?.slice(0, 200),
				audio: globalThis.openraAudioDebug == null ? null : {
					state: globalThis.openraAudioDebug.state(),
					voicesStarted: globalThis.openraAudioDebug.voicesStarted,
					activeVoices: globalThis.openraAudioDebug.activeVoices()
				},
				feed1: feed('agent-feed-1'), feed2: feed('agent-feed-2')
			};
		});
		if (snapshot.audio != null)
			lastAudioState = snapshot.audio;
		recordLockstepTrace(snapshot.lockstepTrace);

		for (const [agent, bubbles] of [['agent1', snapshot.feed1], ['agent2', snapshot.feed2]]) {
			for (const bubble of bubbles) {
				const text = bubble.text ?? '';
				const key = `${agent}:${text.slice(0, 80)}`;
				if (!seen.has(key)) {
					seen.add(key);
					recordBubble(agent, text, bubble.decided === true);
				}
			}
		}

		observeMatchState(snapshot);

		log({ kind: 'state', state: snapshot.state, tick: snapshot.tick, net: snapshot.net, oos: snapshot.oos,
			spend: snapshot.spend, status: snapshot.status, audio: snapshot.audio });
		if (Date.now() - lastShot > 120_000) {
			lastShot = Date.now();
			await page.screenshot({ path: path.join(outDir, `shot-${String(shots++).padStart(2, '0')}.png`) });
		}

		if (snapshot.oos) { log({ kind: 'DESYNC' }); break; }
		if (terminal) break;
	}

	let deadlineReached = !terminal && Date.now() >= deadline;
	// The page captures the complete host state before StopAgentMatch resets the
	// world. Prefer it over every poll: it is the authoritative terminal record
	// when the resolved winState existed for less than one 500 ms light-poll.
	const stashedTerminal = await page.evaluate(() => globalThis.oraLastResolvedMatchState ?? null);
	if (stashedTerminal != null) {
		consumeStashedMissionEvents(stashedTerminal);
		deadlineReached = false;
		terminalStateSource = 'terminal-state-stash';
		observeMatchState({
			state: stashedTerminal.state,
			tick: stashedTerminal.worldTick,
			net: stashedTerminal.netFrame,
			oos: stashedTerminal.outOfSync,
			agents: stashedTerminal.agents,
			opponent: stashedTerminal.opponent,
			opponentBot: stashedTerminal.opponentBot,
			mapUid: stashedTerminal.mapUid,
			mapTitle: stashedTerminal.mapTitle,
			terminalReason: stashedTerminal.terminalReason,
			terminalKind: stashedTerminal.terminalKind ?? null,
			spendFinal: stashedTerminal.spendFinal,
			inFlightSpendRequests: stashedTerminal.inFlightSpendRequests,
			terminalStash: true
		}, true);
	}

	// One last feed scrape: the terminal usually lands mid-window via the light
	// poll, and the closing bubbles (the winning attack) would otherwise never
	// reach the log. The DOM outlives the torn-down match.
	try {
		const closing = await page.evaluate(() => {
			const feed = id => [...document.querySelectorAll(`#${id} .agent-bubble`)].map(b => ({
				text: b.textContent.replace(/\s+/g, ' ').trim(),
				decided: b.classList.contains('agent-bubble-decided')
			}));
			return {
				feed1: feed('agent-feed-1'), feed2: feed('agent-feed-2'),
				spend: document.getElementById('agent-live-spend')?.textContent,
				status: document.getElementById('agent-match-status')?.textContent?.slice(0, 200),
				audio: globalThis.openraAudioDebug == null ? null : {
					state: globalThis.openraAudioDebug.state(),
					voicesStarted: globalThis.openraAudioDebug.voicesStarted,
					activeVoices: globalThis.openraAudioDebug.activeVoices()
				}
			};
		});
		if (closing.audio != null)
			lastAudioState = closing.audio;
		for (const [agent, bubbles] of [['agent1', closing.feed1], ['agent2', closing.feed2]]) {
			for (const bubble of bubbles) {
				const text = bubble.text ?? '';
				const key = `${agent}:${text.slice(0, 80)}`;
				if (!seen.has(key)) {
					seen.add(key);
					recordBubble(agent, text, bubble.decided === true);
				}
			}
		}

		state = { ...state, spend: closing.spend ?? state.spend, status: closing.status ?? state.status };
	} catch { }

	await page.screenshot({ path: path.join(outDir, 'final.png') });
	if (deadlineReached) {
		// Stop the paid worker before outcome serialization and optional reflection.
		// Otherwise the world keeps requesting decisions for up to two 55-second
		// reflect calls after the wall-clock safety limit has expired.
		terminalStateSource = 'deadline';
		state = { ...state, status: `Wall-clock limit reached after ${maxMinutes} minutes.` };
		await page.click('#agent-stop').catch(() => { });
		// The Stop handler drains mission events before destroying the host. Read
		// that bounded stash after the click so deadline stops retain the same
		// lifecycle facts as natural terminal states.
		const deadlineStash = await page.evaluate(() => globalThis.oraLastResolvedMatchState ?? null).catch(() => null);
		if (deadlineStash != null) {
			consumeStashedMissionEvents(deadlineStash);
			noteMissionSeats(deadlineStash);
			state = {
				...state,
				mapUid: deadlineStash.mapUid ?? state.mapUid,
				mapTitle: deadlineStash.mapTitle ?? state.mapTitle,
				adjudication: deadlineStash.adjudication ?? state.adjudication ?? null
			};
			lastAgentsSnapshot = {
				tick: deadlineStash.worldTick,
				agents: deadlineStash.agents ?? [],
				opponent: deadlineStash.opponent ?? null,
				opponentBot: deadlineStash.opponentBot ?? null
			};
		}
	}
	const finalLockstepTrace = benchmarkLockstep
		? await page.evaluate(() => globalThis.oraLastLockstepTrace ?? []).catch(() => [])
		: null;
	recordLockstepTrace(finalLockstepTrace);
	// A clean final stash has now had the opportunity to cover a teardown-race
	// poll error. Only unresolved provisional errors make telemetry incomplete.
	flushProvisionalMissionErrors();
	log({ kind: 'terminal', state: state.state, tick: state.tick, spend: state.spend,
		agents: state.agents, opponent: state.opponent, opponentBot: state.opponentBot,
		status: state.status, terminalKind: state.terminalKind ?? null,
		spendFinal: state.spendFinal ?? null,
		inFlightSpendRequests: state.inFlightSpendRequests ?? null,
		terminalStateSource, lastAgentsSnapshot, winner });
	// Per-seat spend exists only if the page's match state exposes it
	// (agents[].spentUsd, with tolerance for near spellings while the
	// page-side change lands); absent that, record null — never apportion the
	// aggregate spend readout across seats.
	const seatSpendUsd = participant => {
		if (participant == null || typeof participant !== 'object')
			return null;
		for (const key of ['spentUsd', 'spendUsd', 'usdSpent', 'costUsd', 'spent']) {
			const value = participant[key];
			if (typeof value === 'number' && Number.isFinite(value))
				return value;
			if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
				return Number(value);
		}

		return null;
	};
	const seatAgents = lastAgentsSnapshot?.agents ?? [];
	const seatSpend1 = seatSpendUsd(seatAgents[0]);
	const seatSpend2 = seatSpendUsd(seatAgents[1]);
	const perSeatSpendUsd = seatSpend1 == null && seatSpend2 == null
		? null
		: { agent1: seatSpend1, agent2: seatSpend2 };
	const parsedSpendUsd = typeof state.spend === 'number' ? state.spend
		: Number(String(state.spend ?? '').replace(/^\$/, ''));
	const totalSpendUsd = Number.isFinite(parsedSpendUsd) ? parsedSpendUsd : null;
	const opportunityValues = seatAgents.map(agent => Number(agent?.decisionOpportunities));
	const totalDecisionOpportunities = seatAgents.length > 0 && opportunityValues.every(Number.isFinite)
		? opportunityValues.reduce((sum, value) => sum + value, 0) : null;
	while (pendingModelIdentityCaptures.size > 0)
		await Promise.allSettled([...pendingModelIdentityCaptures]);
	modelIdentityRecords.sort((left, right) =>
		String(left?.agentId).localeCompare(String(right?.agentId)) ||
		Number(left?.decisionId) - Number(right?.decisionId));
	const modelIdentity = { schemaVersion: 1, records: modelIdentityRecords };
	if (benchmarkLockstep && modelIdentityCensorReason == null) {
		try {
			validateOutcomeModelIdentity({
				gameId: label,
				seats: [{ modelId: model1 }, { modelId: model2 }]
			}, {
				modelIdentity,
				lastAgentsSnapshot: { agents: seatAgents },
				benchmark: { barrierTrace: finalLockstepTrace }
			});
		} catch (error) {
			markModelIdentityFault(error.message);
		}
	}
	const providerTerminal = state.terminalKind === 'authentication' || state.terminalKind === 'insufficient-credit';
	const harnessCensorReason = state.oos === true ? 'determinism-desync'
		: state.state === 'failed' ? 'host-state-failed'
			: modelIdentityCensorReason ?? pageInfrastructureFault;
	const infrastructureCensored = providerTerminal || harnessCensorReason != null;
	const zeroSpendZeroOpportunity = providerTerminal && state.spendFinal === true && totalSpendUsd === 0 &&
		totalDecisionOpportunities === 0;
	const censorReason = providerTerminal ? `provider-${state.terminalKind}` : harnessCensorReason;
	// Sidecar outcome file so downstream tooling (a2a-metrics, leaderboard) can
	// pick up the winner without replaying the whole log.
	writeFileSync(path.join(outDir, 'outcome.json'), `${JSON.stringify({
		winner: winner?.agent ?? null,
		winnerParticipantId: winner?.participantId ?? null,
		winnerSeat: winner?.seat ?? null,
		winnerControllerType: winner?.controllerType ?? null,
		how: winner?.how ?? null,
		tick: winner?.tick ?? null,
		lastAgentsSnapshot,
		opponentBot: state.opponentBot ?? null,
		opponentControllerType: state.opponent?.controllerType ?? null,
		opponent: state.opponent ?? null,
		terminalStateSource,
		terminalStatus: state.status ?? null,
		terminalKind: state.terminalKind ?? null,
		spendFinal: state.spendFinal ?? null,
		inFlightSpendRequests: state.inFlightSpendRequests ?? null,
		totalSpendUsd,
		totalDecisionOpportunities,
		infrastructureCensored,
		censorReason,
		zeroSpendZeroOpportunity,
		providerEndpoint,
		modelIdentity,
		map: {
			requestedMapUid: requestedMapUid || null,
			effectiveMapUid,
			resolvedMapUid: state.mapUid ?? null,
			resolvedMapTitle: state.mapTitle ?? null
		},
		audio: lastAudioState,
		assistance: {
			arsenal,
			executor,
			guided,
			fallbackStrike,
			play,
			staffSeat,
			lessons: lessonsMode !== 'off'
		},
		benchmark: benchmarkLockstep ? {
			...benchmarkConfig,
			decisionIntervalTicks: effectiveDecisionIntervalTicks,
			requestedMapUid,
			resolvedMapUid: state.mapUid ?? null,
			resolvedMapTitle: state.mapTitle ?? null,
			modelConfig: pinnedModelConfig,
			barrierTraceVersion: 1,
			barrierTrace: finalLockstepTrace,
			adjudication: state.adjudication ?? null,
			oos: state.oos ?? null
		} : null,
		staffModels: staffSeat ? {
			strategist: { agent1: model1, agent2: model2 },
			reaction: { agent1: reactionModel1, agent2: reactionModel2 }
		} : null,
		buildPlanWatchdogs: {
			stallTicks: state.buildPlanStallWatchdogTicks ?? null,
			internalFailureTicks: state.buildPlanInternalFailureWatchdogTicks ?? null
		},
		resolvedProfile: state.resolvedProfile ?? resolvedConfig.resolvedProfile,
		mirror,
		lessonsMode,
		lessonsInjected: { agent1: injectedDigest(seat1.injected), agent2: injectedDigest(seat2.injected) },
		seed,
		eraLock,
		perSeatSpendUsd,
		// Pure generalship telemetry. The host runs the war compiler only after a model
		// commitIntent (compiled strike/reinforce/disengage are pure-safe staff work). The
		// old HostStrikeMain/HostSoft* last-resort counters were removed from the C# track
		// (they never arrive), so purity now turns on the AUTONOMOUS host-combat counters:
		// reactive rally, the structure-defense backstop (garrison pulls, up to a dozen
		// units), and proactive first-strikes. Any non-zero means the host fought for the
		// model, so it breaks purity and is surfaced so host combat is never hidden.
		// Counters are read straight off the host AgentPlayerState snapshot (camelCase JSON).
		hostCombatLastResort: false,
		generalship: seatAgents.map(agent => {
			const hostEmergencyRallyOrders = agent?.hostEmergencyRallyOrders ?? 0;
			const hostStructureDefenseOrders = agent?.hostStructureDefenseOrders ?? 0;
			const hostProactiveEngageOrders = agent?.hostProactiveEngageOrders ?? 0;
			return {
				agentId: agent?.agentId ?? null,
				hostEmergencyRallyOrders,
				hostStructureDefenseOrders,
				hostProactiveEngageOrders,
				hostCompiledStrikeCount: agent?.hostCompiledStrikeCount ?? 0,
				hostCompiledReinforceCount: agent?.hostCompiledReinforceCount ?? 0,
				hostCompiledDisengageCount: agent?.hostCompiledDisengageCount ?? 0,
				modelCommitIntentCount: agent?.modelCommitIntentCount ?? 0,
				timeToFirstCommitIntentTicks: agent?.timeToFirstCommitIntentTicks ?? -1,
				dribbleAttackMoveCount: agent?.dribbleAttackMoveCount ?? 0,
				// Purity holds only when the host issued NO autonomous combat for this seat.
				// Compiled (post-commitIntent) counters are pure-safe and never gate this.
				pureGeneralValid: hostEmergencyRallyOrders === 0 && hostStructureDefenseOrders === 0 &&
					hostProactiveEngageOrders === 0
			};
		})
	}, null, 1)}\n`);
	console.log(`MATCH ${label} TERMINAL: state=${state.state} tick=${state.tick} spend=${state.spend} ` +
		`winner=${winner ? `${winner.agent} (${winner.how})` : 'undetected'}`);
	console.log(JSON.stringify(state.agents ?? []));

	// Learned-series reflection, strictly after the outcome is on disk and
	// strictly best-effort: the match is already paid for and recorded, so no
	// reflect failure may change this run's exit.
	if (lessonsMode === 'on' && !providerTerminal) {
		let classification = 'unfinished (no winner before stop)';
		if (winner != null) classification = 'resolved';
		else if (state.oos === true) classification = 'infrastructure-censored (desync)';
		else if (state.state === 'failed') classification = 'infrastructure-censored (harness failure)';
		const seats = [
			{ id: 'agent1', model: model1, faction: faction1, playbook: playbook1, opponent: model2, opponentPlaybook: playbook2, injected: seat1.injected },
			{ id: 'agent2', model: model2, faction: faction2, playbook: playbook2, opponent: model1, opponentPlaybook: playbook1, injected: seat2.injected }
		];
		for (const seat of seats) {
			try {
				const header = [
					`Match ${label}: you were ${seat.id} playing ${seat.model} (faction ${seat.faction}) vs ${seat.opponent}.`,
					`Playbooks: yours=${seat.playbook || 'none'} opponent=${seat.opponentPlaybook || 'none'}.`,
					`Result for you: ${winner == null ? classification : winner.seat === seat.id ? 'win' : 'loss'}.`,
					`Winner: ${winner ? `${winner.agent} via ${winner.how} at tick ${winner.tick}` : 'undetected'}.`,
					`Terminal: state=${state.state} tick=${state.tick} spend=${state.spend ?? 'unknown'} status=${state.status ?? 'none'}.`,
					`Outcome classification: ${classification}.`,
					'Your final thoughts, oldest first:'
				].join('\n');
				// 5800 leaves headroom under the reflect contract's 6000-char
				// matchReport cap; budget from the newest thought backwards so
				// the endgame — the part worth learning from — always survives.
				const thoughts = [];
				let budget = 5800 - header.length;
				for (const bubble of [...recentBubbles[seat.id]].reverse()) {
					const line = `\n- ${bubble}`;
					if (line.length > budget) break;
					budget -= line.length;
					thoughts.unshift(line);
				}
				const matchReport = `${header}${thoughts.length > 0 ? thoughts.join('') : '\n- (no thoughts captured)'}`.slice(0, 5800);
				// Client timeout exceeds the sidecar's 45s upstream budget so a
				// slow-but-successful reflection is never abandoned mid-flight.
				const response = await fetch(`${sidecarUrl}/api/reflect`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						model: seat.model,
						apiKey: 'use-env-key',
						matchReport,
						priorLessons: seat.injected ?? '',
						requestTimeoutMs: 45_000
					}),
					signal: AbortSignal.timeout(55_000)
				});
				if (response.status !== 200)
					throw new Error(`reflect HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
				const lessons = (await response.json())?.lessons;
				if (typeof lessons !== 'string' || lessons.length === 0)
					throw new Error('reflect returned no lessons text');
				// Temp + rename in the same directory: a concurrent runner reading
				// this model's lessons must never observe a half-written file.
				mkdirSync(lessonsDir, { recursive: true });
				const target = path.join(lessonsDir, `${modelSlug(seat.model)}.md`);
				const temp = `${target}.${process.pid}.tmp`;
				writeFileSync(temp, lessons);
				renameSync(temp, target);
				log({ kind: 'lessons-updated', agent: seat.id, model: seat.model, chars: lessons.length });
			} catch (error) {
				log({ kind: 'reflect-error', agent: seat.id, text: String(error).slice(0, 300) });
			}
		}
	}
	if (infrastructureCensored)
		process.exitCode = InfrastructureExitCode;
} finally {
	process.removeListener('SIGINT', onSigint);
	process.removeListener('SIGTERM', onSigterm);
	await cleanup();
}
