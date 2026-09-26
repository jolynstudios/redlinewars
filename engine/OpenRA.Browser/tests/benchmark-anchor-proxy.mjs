// Loopback-only sidecar proxy that serves the fixed scripted anchor in one normal lockstep
// seat and forwards the other seat to an operator-owned local sidecar. This keeps both seats
// on the same worker/barrier path without teaching the production sidecar a benchmark model.
import { createServer } from 'node:http';
import { RulesKnowledgeHash } from '../agent-sidecar/dist/instructions.js';
import {
	BenchmarkAnchorModelId,
	BenchmarkAnchorSpec,
	isBenchmarkAnchorModel,
	scriptedAnchorDecision
} from './benchmark-scripted-anchor.mjs';

const MaxBodyBytes = 8 * 1024 * 1024;

function assertLoopbackUrl(raw, label) {
	const url = new URL(raw);
	if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
		url.username !== '' || url.password !== '')
		throw new Error(`${label} must be an unauthenticated loopback HTTP URL`);
	return url.toString().replace(/\/+$/, '');
}

function cors(response, origin) {
	if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
	response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(response, status, value, origin) {
	cors(response, origin);
	response.writeHead(status, {
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json; charset=utf-8'
	});
	response.end(JSON.stringify(value));
}

function scriptedAnchorModelIdentity(input, endpointHost) {
	return {
		schemaVersion: 1,
		agentId: input.agentId,
		decisionId: input.decisionId,
		requestedModelId: input.model,
		canonicalRequestedModelId: BenchmarkAnchorModelId,
		requestedRoute: null,
		attempts: [{
			label: 'scripted-anchor',
			servedModelId: BenchmarkAnchorModelId,
			endpointHost,
			resolvedRoute: 'scripted-anchor',
			substitutedFor: null
		}],
		valid: true,
		failureReason: null
	};
}

async function readBytes(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MaxBodyBytes) throw new Error('proxy request body exceeds 8 MiB');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function forward(upstream, request, response, bytes, origin) {
	const target = `${upstream}${request.url ?? '/'}`;
	const upstreamResponse = await fetch(target, {
		method: request.method,
		headers: { 'Content-Type': request.headers['content-type'] ?? 'application/json' },
		body: request.method === 'GET' || request.method === 'HEAD' ? undefined : bytes,
		signal: AbortSignal.timeout(130_000)
	});
	const body = Buffer.from(await upstreamResponse.arrayBuffer());
	cors(response, origin);
	response.writeHead(upstreamResponse.status, {
		'Cache-Control': 'no-store',
		'Content-Type': upstreamResponse.headers.get('content-type') ?? 'application/json; charset=utf-8'
	});
	response.end(body);
}

async function estimateMixed(upstream, input) {
	const realModels = input.models.filter(model => !isBenchmarkAnchorModel(model));
	if (realModels.length === 0) {
		return {
			agents: input.models.map(model => ({ model, prompt: 0, completion: 0, request: 0,
				perDecisionUsd: 0, estimatedInputTokens: input.estimatedInputTokens })),
			estimatedMatchUsd: 0,
			assumptions: input,
			knowledgeChars: 0,
			rulesKnowledgeHash: RulesKnowledgeHash,
			arsenalContextChars: 0,
			anchor: BenchmarkAnchorSpec
		};
	}

	// The production estimate schema requires exactly two models. Duplicate the single real
	// model for pricing, then discard the duplicate and insert the zero-cost anchor quote.
	const pricingModels = realModels.length === 1 ? [realModels[0], realModels[0]] : realModels;
	const upstreamResponse = await fetch(`${upstream}/api/estimate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...input, models: pricingModels }),
		signal: AbortSignal.timeout(30_000)
	});
	const output = await upstreamResponse.json();
	if (!upstreamResponse.ok)
		throw new Error(`upstream estimate failed HTTP ${upstreamResponse.status}: ${output.error ?? 'unknown error'}`);
	const realQuote = output.agents.find(agent => agent.model === realModels[0]);
	if (realQuote == null) throw new Error('upstream estimate omitted the real model quote');
	const agents = input.models.map(model => isBenchmarkAnchorModel(model)
		? { model, prompt: 0, completion: 0, request: 0, perDecisionUsd: 0,
			estimatedInputTokens: input.estimatedInputTokens }
		: { ...realQuote, model });
	return {
		...output,
		agents,
		estimatedMatchUsd: agents.reduce((total, agent) =>
			total + agent.perDecisionUsd * input.estimatedDecisionsPerAgent, 0),
		assumptions: input,
		anchor: BenchmarkAnchorSpec
	};
}

export function createBenchmarkAnchorProxy(options) {
	const upstream = assertLoopbackUrl(options.upstreamUrl, 'anchor proxy upstreamUrl');
	const host = options.host ?? '127.0.0.1';
	if (host !== '127.0.0.1') throw new Error('anchor proxy may only bind 127.0.0.1');
	const port = Number(options.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error('anchor proxy port must be 1-65535');
	const server = createServer(async (request, response) => {
		const origin = request.headers.origin;
		try {
			if (request.method === 'OPTIONS') {
				cors(response, origin);
				response.writeHead(204);
				response.end();
				return;
			}
			const url = new URL(request.url ?? '/', 'http://anchor-proxy.invalid');
			if (request.method === 'GET' && url.pathname === '/health') {
				sendJson(response, 200, { ok: true, kind: 'benchmark-anchor-proxy', anchor: BenchmarkAnchorSpec }, origin);
				return;
			}
			const bytes = await readBytes(request);
			if (request.method === 'POST' && url.pathname === '/api/decide') {
				const input = JSON.parse(bytes.toString('utf8'));
				if (isBenchmarkAnchorModel(input.model)) {
					sendJson(response, 200, {
						...scriptedAnchorDecision(input),
						modelIdentity: scriptedAnchorModelIdentity(input, request.headers.host ?? `${host}:${port}`)
					}, origin);
					return;
				}
				await forward(upstream, request, response, bytes, origin);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/estimate') {
				const input = JSON.parse(bytes.toString('utf8'));
				if (Array.isArray(input.models) && input.models.some(isBenchmarkAnchorModel)) {
					sendJson(response, 200, await estimateMixed(upstream, input), origin);
					return;
				}
			}
			await forward(upstream, request, response, bytes, origin);
		} catch (error) {
			sendJson(response, 502, { error: `benchmark anchor proxy: ${error.message}`, costUsd: 0 }, origin);
		}
	});
	return {
		server,
		url: `http://${host}:${port}`,
		anchor: BenchmarkAnchorSpec,
		async start() {
			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, host, resolve);
			});
			return this;
		},
		async stop() {
			if (!server.listening) return;
			await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	};
}

export { BenchmarkAnchorModelId };
