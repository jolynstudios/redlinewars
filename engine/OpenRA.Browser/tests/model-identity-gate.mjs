// Zero-spend behavioral gate for per-decision model and route provenance.
// The provider fixture is loopback-only; no request can reach a real model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBenchmarkAnchorProxy } from './benchmark-anchor-proxy.mjs';
import { BenchmarkAnchorModelId } from './benchmark-scripted-anchor.mjs';
import {
	scoreGame,
	validateDecisionModelIdentity
} from './benchmark-series-lib.mjs';
import {
	resolveSweep,
	scriptedOutcome
} from './benchmark-sweep-runner.mjs';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const browserRoot = resolve(testsDirectory, '..');
const repositoryRoot = resolve(browserRoot, '..');
const sidecarRoot = resolve(browserRoot, 'agent-sidecar');
const sidecarSource = resolve(sidecarRoot, 'src/server.ts');
const tsxCli = resolve(sidecarRoot, 'node_modules/tsx/dist/cli.mjs');
const fixturePath = resolve(testsDirectory, 'benchmark-sweep/benchmark-sweep-v1.fixture.json');
const matchRunnerPath = resolve(testsDirectory, 'match-runner.mjs');
const seriesLibPath = resolve(testsDirectory, 'benchmark-series-lib.mjs');

const RequestedModelId = 'grok:x-ai/grok-4.5';
const CanonicalModelId = 'x-ai/grok-4.5';
const Decision = {
	agentId: 'agent-identity-gate',
	model: RequestedModelId,
	systemPrompt: 'Return a legal OpenRA action batch.',
	apiKey: 'fixture-key',
	maxOutputTokens: 128,
	decisionId: 7,
	observation: { schemaVersion: 1, sequence: 8, worldTick: 900 },
	requestTimeoutMs: 5000
};

function completion(options = {}) {
	const batch = {
		schemaVersion: 1,
		decisionId: Decision.decisionId,
		observedSequence: Decision.observation.sequence,
		observedWorldTick: Decision.observation.worldTick,
		thoughts: 'Loopback identity fixture.',
		actions: []
	};
	return {
		id: 'chatcmpl-model-identity-gate',
		object: 'chat.completion',
		created: 0,
		model: options.model === undefined ? CanonicalModelId : options.model,
		choices: [{
			index: 0,
			message: { role: 'assistant', content: JSON.stringify(batch) },
			finish_reason: 'stop'
		}],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
		...(options.sublet === false ? {} : {
			sublet: {
				backend: options.backend ?? 'grok',
				provider_pinned: true,
				...(options.substitutedFor === undefined ? {} :
					{ substituted_for: options.substitutedFor })
			}
		})
	};
}

async function listen(server) {
	await new Promise((resolveListen, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	const address = server.address();
	assert.ok(address != null && typeof address === 'object');
	return address.port;
}

async function close(server) {
	server.closeAllConnections?.();
	await new Promise(resolveClose => server.close(resolveClose));
}

async function unusedPort() {
	const reservation = createServer();
	const port = await listen(reservation);
	await close(reservation);
	return port;
}

async function runNode(argv, options = {}) {
	const child = spawn(process.execPath, argv, {
		cwd: options.cwd ?? testsDirectory,
		env: { ...process.env, ...(options.env ?? {}) },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => { stdout += chunk; });
	child.stderr.on('data', chunk => { stderr += chunk; });
	const result = await new Promise((resolveExit, reject) => {
		child.once('error', reject);
		child.once('exit', (code, signal) => resolveExit({ code, signal }));
	});
	return { ...result, stdout, stderr };
}

async function eventually(check, description, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			return await check();
		} catch (error) {
			lastError = error;
			await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
		}
	}
	throw new Error(`${description}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function startSidecarFixture() {
	let nextResponse = completion();
	const requests = [];
	const provider = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify(nextResponse));
	});
	const providerPort = await listen(provider);
	const sidecarPort = await unusedPort();
	const child = spawn(process.execPath, [tsxCli, sidecarSource], {
		cwd: sidecarRoot,
		env: {
			...process.env,
			PORT: String(sidecarPort),
			OPENROUTER_BASE_URL: `http://127.0.0.1:${providerPort}/api/v1`,
			OPENROUTER_API_KEY: ''
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stderr = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', chunk => { stderr += chunk; });
	const url = `http://127.0.0.1:${sidecarPort}`;
	await eventually(async () => {
		if (child.exitCode != null)
			throw new Error(`sidecar exited ${child.exitCode}: ${stderr}`);
		const response = await fetch(`${url}/health`);
		assert.equal(response.status, 200);
	}, 'sidecar did not become healthy');

	return {
		url,
		requests,
		respondWith(value) {
			nextResponse = value;
		},
		async decide(overrides = {}) {
			return fetch(`${url}/api/decide`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...Decision, ...overrides })
			});
		},
		async stop() {
			if (child.exitCode == null && child.signalCode == null) {
				const exited = new Promise(resolveExit => child.once('exit', resolveExit));
				child.kill('SIGTERM');
				await Promise.race([exited, new Promise(resolveDelay => setTimeout(resolveDelay, 2000))]);
				if (child.exitCode == null && child.signalCode == null)
					child.kill('SIGKILL');
			}
			await close(provider);
		}
	};
}

function expectRejected(run, pattern, label) {
	let rejection = null;
	try {
		run();
	} catch (error) {
		rejection = error;
	}
	assert.ok(rejection instanceof Error, `${label} was accepted`);
	assert.match(rejection.message, pattern, `${label} failed for the wrong reason`);
}

const fixture = await startSidecarFixture();
try {
	const healthResponse = await fetch(`${fixture.url}/health`);
	const health = await healthResponse.json();
	assert.equal(healthResponse.status, 200);
	assert.match(health.providerEndpoint, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/);
	console.log('ok: health reports the exact resolved provider endpoint used by the sidecar');

	const positiveResponse = await fixture.decide();
	const positive = await positiveResponse.json();
	assert.equal(positiveResponse.status, 200, JSON.stringify(positive));
	assert.equal(fixture.requests[0].model, RequestedModelId,
		'route-pinned model id did not reach the provider');
	validateDecisionModelIdentity(positive.modelIdentity, {
		agentId: Decision.agentId,
		decisionId: Decision.decisionId,
		modelId: RequestedModelId
	});
	assert.equal(positive.modelIdentity.canonicalRequestedModelId, CanonicalModelId);
	assert.equal(positive.modelIdentity.attempts[0].servedModelId, CanonicalModelId);
	assert.equal(positive.modelIdentity.attempts[0].resolvedRoute, 'grok');
	assert.match(positive.modelIdentity.attempts[0].endpointHost, /^127\.0\.0\.1:\d+$/);
	console.log('ok: sidecar validates the canonical served model and route at decision time');

	fixture.respondWith(completion({ model: 'anthropic/claude-haiku-4.5' }));
	const mismatchResponse = await fixture.decide({ decisionId: 8,
		observation: { ...Decision.observation, sequence: 9 } });
	const mismatch = await mismatchResponse.json();
	assert.equal(mismatchResponse.status, 502);
	assert.match(mismatch.infrastructureCensorReason, /requested 'x-ai\/grok-4\.5'.*answered/);
	assert.equal(mismatch.modelIdentity.valid, false);
	assert.equal(mismatch.modelIdentity.attempts.length, 1,
		'a model mismatch must not launch a repair call');
	console.log('ok: mismatched served model is an infrastructure censor before schema repair');

	fixture.respondWith(completion({
		model: 'z-ai/glm-5.2',
		backend: 'zai',
		substitutedFor: RequestedModelId
	}));
	const substitutedResponse = await fixture.decide({ decisionId: 9,
		observation: { ...Decision.observation, sequence: 10 } });
	const substituted = await substitutedResponse.json();
	assert.equal(substitutedResponse.status, 502);
	assert.match(substituted.infrastructureCensorReason, /substituted for/);
	assert.equal(substituted.modelIdentity.attempts[0].substitutedFor, RequestedModelId);
	console.log('ok: explicit provider substitution is an infrastructure censor, never a model result');

	const unsafeSidecar = createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://sidecar.invalid');
		response.writeHead(url.pathname === '/health' ? 200 : 404, {
			'Content-Type': 'application/json'
		});
		response.end(JSON.stringify(url.pathname === '/health'
			? { ok: true, providerEndpoint: 'https://openrouter.ai/api/v1' }
			: { error: 'not found' }));
	});
	const unsafePort = await listen(unsafeSidecar);
	const unsafeLabel = 'int05-nonloopback-preflight-gate';
	const unsafeOutcomeDirectory = resolve(testsDirectory, 'match-results', unsafeLabel);
	rmSync(unsafeOutcomeDirectory, { recursive: true, force: true });
	try {
		const rejected = await runNode([
			matchRunnerPath,
			'--model1', RequestedModelId,
			'--model2', 'zai:z-ai/glm-5.2',
			'--benchmark-lockstep',
			'--map', 'Siberian-Pass.oramap',
			'--sidecar', `http://127.0.0.1:${unsafePort}`,
			'--label', unsafeLabel
		]);
		assert.equal(rejected.code, 4, `${rejected.stdout}${rejected.stderr}`);
		assert.match(`${rejected.stdout}${rejected.stderr}`,
			/Provider endpoint preflight failed before tick 0:.*openrouter\.ai/);
		assert.equal(existsSync(unsafeOutcomeDirectory), false,
			'non-loopback preflight created a match evidence directory');
	} finally {
		rmSync(unsafeOutcomeDirectory, { recursive: true, force: true });
		await close(unsafeSidecar);
	}
	console.log('ok: match runner names and refuses a non-loopback provider endpoint before tick zero');

	const resolved = resolveSweep(fixturePath, { allowTestVector: true });
	const game = resolved.schedule.games[0];
	const cleanOutcome = scriptedOutcome(game, resolved.calibration);
	assert.doesNotThrow(() => scoreGame(game, cleanOutcome, resolved.calibration));
	const missingProviderEndpoint = structuredClone(cleanOutcome);
	delete missingProviderEndpoint.providerEndpoint;
	expectRejected(() => scoreGame(game, missingProviderEndpoint, resolved.calibration),
		/provider endpoint must be an object/, 'outcome with no resolved provider endpoint');
	const remoteProviderEndpoint = structuredClone(cleanOutcome);
	remoteProviderEndpoint.providerEndpoint = {
		schemaVersion: 1,
		resolvedUrl: 'https://openrouter.ai/api/v1',
		endpointHost: 'openrouter.ai',
		loopback: false
	};
	expectRejected(() => scoreGame(game, remoteProviderEndpoint, resolved.calibration),
		/must be recorded as loopback/, 'outcome with a non-loopback provider endpoint');
	const missing = structuredClone(cleanOutcome);
	delete missing.modelIdentity;
	expectRejected(() => scoreGame(game, missing, resolved.calibration),
		/no complete model-identity provenance/, 'outcome with no provenance record');
	const missingDecision = structuredClone(cleanOutcome);
	missingDecision.modelIdentity.records.pop();
	expectRejected(() => scoreGame(game, missingDecision, resolved.calibration),
		/is missing model identity for/, 'outcome with one missing decision record');
	const missingEndpoint = structuredClone(cleanOutcome);
	missingEndpoint.modelIdentity.records[0].attempts[0].endpointHost = '';
	expectRejected(() => scoreGame(game, missingEndpoint, resolved.calibration),
		/endpoint host is missing or unsafe/, 'outcome with no endpoint provenance');
	const wrongEndpoint = structuredClone(cleanOutcome);
	const nonAnchorRecord = wrongEndpoint.modelIdentity.records.find(record =>
		record.canonicalRequestedModelId !== BenchmarkAnchorModelId);
	assert.ok(nonAnchorRecord, 'scripted score fixture did not contain a provider-backed seat');
	nonAnchorRecord.attempts[0].endpointHost = '127.0.0.1:19999';
	expectRejected(() => scoreGame(game, wrongEndpoint, resolved.calibration),
		/endpoint does not match the sidecar preflight/,
		'decision evidence from a different loopback endpoint');
	console.log('ok: outcome endpoint and identity evidence survive recording and are independently required by scoreGame');

	const anchorUpstream = createServer((_request, response) => {
		response.writeHead(500, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ error: 'anchor request must not be forwarded' }));
	});
	const anchorUpstreamPort = await listen(anchorUpstream);
	const anchorPort = await unusedPort();
	const anchor = createBenchmarkAnchorProxy({
		upstreamUrl: `http://127.0.0.1:${anchorUpstreamPort}`,
		port: anchorPort
	});
	await anchor.start();
	try {
		const anchorInput = {
			...Decision,
			agentId: 'agent-anchor-gate',
			model: BenchmarkAnchorModelId,
			decisionId: 0,
			phase: 'planning'
		};
		const anchorResponse = await fetch(`${anchor.url}/api/decide`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(anchorInput)
		});
		const anchorOutput = await anchorResponse.json();
		assert.equal(anchorResponse.status, 200);
		validateDecisionModelIdentity(anchorOutput.modelIdentity, {
			agentId: anchorInput.agentId,
			decisionId: anchorInput.decisionId,
			modelId: anchorInput.model
		});
		assert.equal(anchorOutput.modelIdentity.attempts[0].resolvedRoute, 'scripted-anchor');
	} finally {
		await anchor.stop();
		await close(anchorUpstream);
	}
	console.log('ok: normal-seat scripted anchor records its local endpoint and deterministic route');

	const matchRunnerSource = readFileSync(matchRunnerPath, 'utf8');
	const seriesSource = readFileSync(seriesLibPath, 'utf8');
	assert.match(matchRunnerSource, /page\.on\('response'/);
	assert.match(matchRunnerSource, /payload\?\.modelIdentity/);
	assert.match(matchRunnerSource, /validateOutcomeModelIdentity/);
	assert.match(matchRunnerSource, /readSidecarProviderEndpoint/);
	assert.match(seriesSource, /validateOutcomeModelIdentity\(game, outcome\)/);
	console.log('ok: match runner captures response-derived identity before outcome writing');

	console.log('OK every recorded decision proves which model and which route answered');
	console.log('model identity gate passed (8 checks)');
} finally {
	await fixture.stop();
}
