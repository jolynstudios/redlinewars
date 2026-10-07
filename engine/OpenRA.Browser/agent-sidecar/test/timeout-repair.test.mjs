// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SidecarRoot = fileURLToPath(new URL('..', import.meta.url));
const SidecarEntry = fileURLToPath(new URL('../dist/server.js', import.meta.url));

const Decision = {
	agentId: 'timeout-repair-test',
	model: 'test/provider-model',
	systemPrompt: 'Return a legal OpenRA action batch.',
	apiKey: 'test-api-key',
	maxOutputTokens: 128,
	decisionId: 1,
	observation: { schemaVersion: 1, sequence: 2, worldTick: 100 },
	requestTimeoutMs: 5000
};

function completion(content, finishReason = 'stop') {
	return {
		id: 'chatcmpl-timeout-repair-test',
		object: 'chat.completion',
		created: 0,
		model: Decision.model,
		choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
		usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
	};
}

async function listen(server, port = 0) {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	const address = server.address();
	assert.ok(address != null && typeof address === 'object');
	return address.port;
}

async function close(server) {
	server.closeAllConnections?.();
	await new Promise(resolve => server.close(resolve));
}

async function unusedPort() {
	const reservation = createServer();
	const port = await listen(reservation);
	await close(reservation);
	return port;
}

async function eventually(check, description, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			return await check();
		} catch (error) {
			lastError = error;
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	}

	throw new Error(`${description}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function startFixture(t, respond) {
	const requests = [];
	const provider = createServer(async (request, response) => {
		try {
			assert.equal(request.method, 'POST');
			assert.equal(request.url, '/api/v1/chat/completions');
			const chunks = [];
			for await (const chunk of request) {
				chunks.push(chunk);
			}

			const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			requests.push(body);
			const payload = await respond(requests.length, body);
			if (response.destroyed || response.writableEnded) {
				return;
			}

			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify(payload));
		} catch (error) {
			if (!response.destroyed && !response.writableEnded) {
				response.writeHead(500, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ error: { message: String(error) } }));
			}
		}
	});
	const providerPort = await listen(provider);
	const sidecarPort = await unusedPort();
	const child = spawn(process.execPath, [SidecarEntry], {
		cwd: SidecarRoot,
		env: {
			...process.env,
			PORT: String(sidecarPort),
			OPENROUTER_BASE_URL: `http://127.0.0.1:${providerPort}/api/v1`,
			OPENROUTER_API_KEY: ''
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => { stdout += chunk; });
	child.stderr.on('data', chunk => { stderr += chunk; });

	t.after(async () => {
		if (child.exitCode == null && child.signalCode == null) {
			child.kill('SIGTERM');
			await new Promise(resolve => child.once('exit', resolve));
		}
		await close(provider);
	});

	const baseUrl = `http://127.0.0.1:${sidecarPort}`;
	await eventually(async () => {
		if (child.exitCode != null) {
			throw new Error(`sidecar exited ${child.exitCode}; stdout=${stdout}; stderr=${stderr}`);
		}
		const response = await fetch(`${baseUrl}/health`);
		assert.equal(response.status, 200);
	}, 'sidecar did not become healthy');

	return {
		requests,
		stderr: () => stderr,
		decide: (overrides = {}) => fetch(`${baseUrl}/api/decide`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...Decision, ...overrides })
		})
	};
}

test('deadline tripwire is one aborted attempt with no repair and HTTP 408', async t => {
	const fixture = await startFixture(t, async () => {
		// The strict attempt has a 4s budget for this 5s request. Respond only
		// after its AbortController has fired. Mastra normalizes that abort into
		// an empty result whose finishReason is "tripwire".
		await new Promise(resolve => setTimeout(resolve, 4500));
		return completion('{}', 'tripwire');
	});

	const response = await fixture.decide();
	const body = await response.json();

	assert.equal(response.status, 408);
	assert.equal(body.error, 'OpenRouter request timed out; this turn is a no-op.');
	assert.equal(body.retryAfterMs, 0);
	assert.equal(body.costUsd, 0);
	assert.equal(fixture.requests.length, 1, 'an aborted strict attempt must not launch repair');
	assert.deepEqual(body.attempts.map(attempt => ({
		label: attempt.label,
		outcome: attempt.outcome,
		finishReason: attempt.finishReason,
		reasoningTokens: attempt.reasoningTokens,
		outputBytes: attempt.outputBytes
	})), [{
		label: 'strict',
		outcome: 'aborted',
		finishReason: 'tripwire',
		reasoningTokens: 0,
		outputBytes: 0
	}]);
	assert.ok(body.attempts[0].durationMs >= 3900 && body.attempts[0].durationMs < 5000,
		`strict attempt should end at its 4s budget, got ${body.attempts[0].durationMs}ms`);
	assert.match(fixture.stderr(), /status=408 attempts=strict:aborted\/tripwire\(r0,b0,\d+ms\)/);
	assert.doesNotMatch(fixture.stderr(), /repair:/);
});

test('fast empty response remains schema-repairable', async t => {
	const repairedBatch = {
		schemaVersion: 1,
		decisionId: Decision.decisionId,
		observedSequence: Decision.observation.sequence,
		observedWorldTick: Decision.observation.worldTick,
		thoughts: 'The repair returned a valid no-op decision.',
		actions: []
	};
	const fixture = await startFixture(t, async requestNumber =>
		requestNumber === 1 ? completion('') : completion(JSON.stringify(repairedBatch)));

	const response = await fixture.decide({ requestTimeoutMs: 16000 });
	const body = await response.json();

	assert.equal(response.status, 200, `body=${JSON.stringify(body)} stderr=${fixture.stderr()}`);
	assert.equal(fixture.requests.length, 2, 'a genuine fast empty response should receive one repair attempt');
	assert.equal(fixture.requests[0].response_format.type, 'json_schema');
	assert.equal(fixture.requests[1].response_format.type, 'json_object');
	assert.deepEqual(body.attempts.map(attempt => ({
		label: attempt.label,
		outcome: attempt.outcome,
		finishReason: attempt.finishReason
	})), [
		{ label: 'strict', outcome: 'schema', finishReason: 'stop' },
		{ label: 'repair', outcome: 'ok', finishReason: 'stop' }
	]);
	assert.equal(body.batch.thoughts, repairedBatch.thoughts);
	assert.deepEqual(body.batch.actions, []);
});
