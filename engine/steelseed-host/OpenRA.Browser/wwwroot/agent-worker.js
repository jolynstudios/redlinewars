// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

const encoder = new TextEncoder();
const agents = new Map();
let sidecarUrl = '';
let spendCapUsd = 0;
let spentUsd = 0;
let reservedUsd = 0;
let providerRequestsInFlight = 0;
let stopped = true;
let knowledgeChars = 16384;
let arsenalContextChars = 0;
let benchmarkLockstep = false;

function budgetFields(agent) {
	return {
		agentId: agent.agentId,
		spentUsd,
		spendCapUsd,
		providerRequestsInFlight,
		agentSpentUsd: agent.spentUsd,
		agentSpendCapUsd: agent.spendCapUsd
	};
}

function charge(agent, value) {
	const cost = Number(value);
	if (!Number.isFinite(cost) || cost <= 0) {
		return 0;
	}

	agent.spentUsd += cost;
	spentUsd += cost;
	return cost;
}

function exhaustedBudget(agent) {
	if (agent.spentUsd >= agent.spendCapUsd) {
		return `This agent's $${agent.spendCapUsd.toFixed(2)} seat cap was reached; match stopped.`;
	}

	if (spentUsd >= spendCapUsd) {
		return `The $${spendCapUsd.toFixed(2)} total match cap was reached; match stopped.`;
	}

	return '';
}

function bounded(value, max = 2000) {
	const text = String(value ?? '');
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function redactSecrets(value) {
	let text = String(value ?? '');
	for (const agent of agents.values()) {
		if (agent.apiKey) {
			text = text.split(agent.apiKey).join('[redacted]');
		}
	}

	return text;
}

function redact(value) {
	return bounded(redactSecrets(value));
}

function redactObject(value) {
	if (typeof value === 'string') {
		return redactSecrets(value);
	}

	if (Array.isArray(value)) {
		return value.map(redactObject);
	}

	if (value != null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactObject(entry)]));
	}

	return value;
}

function clearCredentials() {
	for (const agent of agents.values()) {
		agent.apiKey = '';
	}
}

function validateSidecarUrl(value) {
	const url = new URL(value, self.location.origin);
	const loopback = url.protocol === 'http:' &&
		(url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
	if (url.protocol !== 'https:' && url.origin !== self.location.origin && !loopback) {
		throw new Error('The agent sidecar must use HTTPS, the game origin, or loopback HTTP for local development.');
	}

	return url.href.replace(/\/$/, '');
}

function requestCostCeiling(agent, pricing, observation, previousResult) {
	// One token per UTF-8 byte is deliberately pessimistic. It gives the worker
	// a hard preflight bound before a charged request is sent.
	const inputBytes = encoder.encode(JSON.stringify(observation)).length +
		encoder.encode(agent.systemPrompt).length + encoder.encode(previousResult).length + knowledgeChars +
		(agent.arsenalMode === 'menu' ? arsenalContextChars : 0) + 2048;
	return pricing.request + inputBytes * pricing.prompt +
		agent.maxOutputTokens * pricing.completion;
}

function post(type, fields = {}) {
	self.postMessage({ type, ...fields });
}

async function decide(message) {
	const agent = agents.get(message.agentId);
	const lockstep = benchmarkLockstep && message.lockstep === true;
	if (stopped || agent == null) {
		return;
	}
	if (agent.inFlight) {
		// A page-owned lockstep deadline may resolve and resume before the
		// transport has delivered its abort rejection. Supersede only an older
		// barrier request; duplicate/current and all real-time requests remain
		// single-flight.
		const priorBarrierId = Number(agent.activeRequest?.barrierId);
		const nextBarrierId = Number(message.barrierId);
		if (!lockstep || !Number.isSafeInteger(priorBarrierId) || !Number.isSafeInteger(nextBarrierId) ||
			nextBarrierId <= priorBarrierId) {
			return;
		}

		agent.activeRequest.controller.abort();
	}

	const now = Date.now();
	if (agent.cooldownUntil > now) {
		post('decision-error', {
			...budgetFields(agent),
			agentId: message.agentId,
			decisionId: message.decisionId,
			barrierId: lockstep ? message.barrierId : null,
			message: `Rate-limit cooldown: ${Math.ceil((agent.cooldownUntil - now) / 1000)}s remaining; no-op turn.`
		});
		return;
	}

	const planning = message.phase === 'planning';
	const fastPath = !lockstep && !planning && message.fastPath === true;
	const reactionTurn = !lockstep && !planning && agent.reactionModel &&
		(fastPath || typeof message.decisionKind === 'string' && message.decisionKind.length > 0);
	const selectedModel = reactionTurn ? agent.reactionModel : agent.model;
	const selectedPricing = reactionTurn ? agent.reactionPricing : agent.pricing;
	const selectedReasoningEffort = reactionTurn ? agent.reactionReasoningEffort : agent.reasoningEffort;
	const selectedRole = reactionTurn ? 'reaction' : 'strategist';
	const ceiling = requestCostCeiling(agent, selectedPricing, message.observation, agent.previousResult);
	const seatCapExceeded = agent.spentUsd + agent.reservedUsd + ceiling > agent.spendCapUsd;
	const matchCapExceeded = spentUsd + reservedUsd + ceiling > spendCapUsd;
	if (!lockstep && (seatCapExceeded || matchCapExceeded)) {
		stopped = true;
		clearCredentials();
		post('budget-exhausted', {
			...budgetFields(agent),
			message: seatCapExceeded
				? `Next request could exceed this agent's $${agent.spendCapUsd.toFixed(2)} seat cap; match stopped before sending it.`
				: `Next request could exceed the $${spendCapUsd.toFixed(2)} total match cap; match stopped before sending it.`
		});
		return;
	}

	agent.inFlight = true;
	agent.reservedUsd += ceiling;
	reservedUsd += ceiling;
	const started = performance.now();
	post('thinking', { agentId: message.agentId, decisionId: message.decisionId,
		barrierId: lockstep ? message.barrierId : null,
		model: selectedModel, role: selectedRole });

	// Reaction turns run on a tight budget: short deadline, small output,
	// low reasoning (only for profiled models). Heartbeats keep full budgets.
	// Planning turns (pre-match, decisionId 0) never take the fast path and
	// use the match's planningTimeoutMs as the single timeout source so the
	// page deadline, this fetch abort, and the sidecar budget agree.
	const requestTimeoutMs = lockstep
		? Math.min(120000, Math.max(10000, Number(message.requestTimeoutMs) || 120000))
		: planning
		? Math.min(120000, Math.max(10000, Number(message.requestTimeoutMs) || 30000))
		: fastPath ? Math.min(20000, agent.requestTimeoutMs) : agent.requestTimeoutMs;
	const maxOutputTokens = fastPath ? Math.min(4096, agent.maxOutputTokens) : agent.maxOutputTokens;
	const reasoningEffort = fastPath && selectedReasoningEffort ? 'low' : selectedReasoningEffort;
	const controller = new AbortController();
	const requestToken = { controller, barrierId: lockstep ? Number(message.barrierId) : null,
		decisionId: message.decisionId };
	agent.activeRequest = requestToken;
	const timeout = setTimeout(() => controller.abort(), requestTimeoutMs + 2000);
	try {
		let response;
		let payload;
		providerRequestsInFlight++;
		try {
			response = await fetch(`${sidecarUrl}/api/decide`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					agentId: message.agentId,
					model: selectedModel,
					systemPrompt: agent.systemPrompt,
					apiKey: agent.apiKey,
					maxOutputTokens,
					decisionId: message.decisionId,
					observation: message.observation,
					previousResult: agent.previousResult,
					requestTimeoutMs,
					reasoningEffort: reasoningEffort || undefined,
					memo: agent.memo || undefined,
					phase: planning ? 'planning' : undefined,
					...(agent.arsenalMode === 'menu' ? { arsenalMode: 'menu' } : {}),
					...(agent.guidanceMode === 'exact' ? { guidanceMode: 'exact' } : {}),
					...(typeof message.decisionKind === 'string' && message.decisionKind.length > 0
						? { decisionMode: 'commit' } : {})
				}),
				signal: controller.signal,
				cache: 'no-store'
			});
			payload = await response.json().catch(() => ({ error: `Agent sidecar returned HTTP ${response.status}.` }));
		} finally {
			providerRequestsInFlight--;
		}

		if (!response.ok) {
			// A failed decision can still carry metered provider cost (a
			// schema-invalid response is a billed call, possibly two after the
			// retry). Charge it against the cap; never estimate on failures —
			// timeouts and 5xx may not have billed at all.
			const failedCallCost = Number(payload.costUsd ?? 0);
			charge(agent, failedCallCost);
			const authenticationFailed = response.status === 401 || response.status === 403;
			const insufficientCredit = response.status === 402;
			const fatalKind = insufficientCredit ? 'insufficient-credit'
				: authenticationFailed ? 'authentication' : null;

			const exhaustion = exhaustedBudget(agent);
			if (exhaustion && !stopped && fatalKind == null) {
				stopped = true;
				clearCredentials();
				post('budget-exhausted', {
					...budgetFields(agent),
					message: exhaustion
				});
			}

			const retryAfterMs = Number(payload.retryAfterMs ?? 0);
			if (retryAfterMs > 0) {
				agent.cooldownUntil = Date.now() + Math.min(300000, retryAfterMs);
			}

			const safeFailure = redact(payload.error ?? `Agent sidecar returned HTTP ${response.status}.`);
			const safeAttempts = redactObject(payload.attempts ?? []);
			if (fatalKind != null) {
				stopped = true;
				clearCredentials();
			}

			const failure = new Error(safeFailure);
			failure.fatalKind = fatalKind;
			failure.attempts = safeAttempts;
			throw failure;
		}

		const usage = payload.usage ?? {};
		const meteredCost = Number(usage.costUsd ?? 0);
		const estimatedActualCost = selectedPricing.request +
			Number(usage.promptTokens ?? 0) * selectedPricing.prompt +
			Number(usage.completionTokens ?? 0) * selectedPricing.completion;
		const costUsd = Number.isFinite(meteredCost) && meteredCost > 0 ? meteredCost : estimatedActualCost;
		charge(agent, costUsd);

		// Carry the commander journal forward; an empty memo keeps the previous
		// one (documented model behavior). Redacted like all provider output.
		const memoText = typeof payload.batch?.memo === 'string' ? redactSecrets(payload.batch.memo).trim() : '';
		if (!lockstep && memoText.length > 0) {
			agent.memo = memoText.slice(0, 600);
		}

		const durationMs = Number(payload.durationMs ?? Math.round(performance.now() - started));
		if (!lockstep) {
			agent.latencies.push(durationMs);
			if (agent.latencies.length > 5) {
				agent.latencies.shift();
			}
		}

		const sorted = [...agent.latencies].sort((a, b) => a - b);
		const latencyP50Ms = sorted[Math.floor((sorted.length - 1) / 2)] ?? durationMs;

		post('decision', {
			...budgetFields(agent),
			agentId: message.agentId,
			decisionId: message.decisionId,
			barrierId: lockstep ? message.barrierId : null,
			model: selectedModel,
			role: selectedRole,
			retryOf: message.retryOf ?? null,
			// Treat all provider output as untrusted, including strings outside the
			// thoughts field. This prevents an accidentally echoed credential from
			// reaching the UI, telemetry, or replay stream.
			batch: redactObject(payload.batch),
			usage: { ...usage, costUsd },
			attempts: redactObject(payload.attempts ?? []),
			latencyP50Ms,
			durationMs,
		});

		const exhaustion = exhaustedBudget(agent);
		if (!lockstep && exhaustion) {
			stopped = true;
			clearCredentials();
			post('budget-exhausted', {
				...budgetFields(agent),
				message: exhaustion
			});
		}
	} catch (error) {
		const messageText = error?.name === 'AbortError'
			? 'Agent request timed out; no-op turn.'
			: redact(error?.message ?? error);
		post('decision-error', {
			...budgetFields(agent),
			agentId: message.agentId,
			decisionId: message.decisionId,
			barrierId: lockstep ? message.barrierId : null,
			model: selectedModel,
			role: selectedRole,
			retryOf: message.retryOf ?? null,
			message: messageText,
			attempts: redactObject(error?.attempts ?? []),
			durationMs: Math.round(performance.now() - started),
			fatal: typeof error?.fatalKind === 'string',
			fatalKind: error?.fatalKind ?? null
		});
	} finally {
		clearTimeout(timeout);
		agent.reservedUsd = Math.max(0, agent.reservedUsd - ceiling);
		reservedUsd = Math.max(0, reservedUsd - ceiling);
		if (agent.activeRequest === requestToken) {
			agent.activeRequest = null;
			agent.inFlight = false;
		}
	}
}

self.onmessage = event => {
	const message = event.data ?? {};
	if (message.type === 'initialize') {
		agents.clear();
		sidecarUrl = validateSidecarUrl(message.sidecarUrl);
		spendCapUsd = Number(message.spendCapUsd);
		const estimatedKnowledgeChars = Number(message.knowledgeChars);
		knowledgeChars = Number.isFinite(estimatedKnowledgeChars) && estimatedKnowledgeChars >= 0
			? estimatedKnowledgeChars
			: 16384;
		const estimatedArsenalContextChars = Number(message.arsenalContextChars);
		arsenalContextChars = Number.isFinite(estimatedArsenalContextChars) && estimatedArsenalContextChars >= 0
			? estimatedArsenalContextChars
			: 0;
		spentUsd = 0;
		reservedUsd = 0;
		providerRequestsInFlight = 0;
		stopped = false;
		benchmarkLockstep = message.benchmarkLockstep === true;
		for (const config of message.agents ?? []) {
			const agentSpendCapUsd = Number(config.spendCapUsd);
			agents.set(config.agentId, {
				...config,
				reactionModel: typeof config.reactionModel === 'string' && config.reactionPricing != null
					? config.reactionModel : '',
				reactionPricing: config.reactionPricing ?? config.pricing,
				arsenalMode: config.arsenalMode === 'menu' ? 'menu' : 'off',
				guidanceMode: config.guidanceMode === 'exact' ? 'exact' : 'off',
				apiKey: String(config.apiKey ?? ''),
				previousResult: 'No previous decision result.',
				// Commander journal: the model's own rolling notes, echoed back
				// each decision. Empty until the model writes one.
				memo: '',
				// Rolling decision latencies (ms) for adaptive cadence.
				latencies: [],
				spentUsd: 0,
				reservedUsd: 0,
				spendCapUsd: agentSpendCapUsd,
				inFlight: false,
				activeRequest: null,
				lastCommittedBarrierId: -1,
				cooldownUntil: 0
			});
		}

		post('ready');
		return;
	}

	if (message.type === 'decide') {
		void decide(message);
		return;
	}

	if (message.type === 'decision-result') {
		const agent = agents.get(message.agentId);
		if (agent != null) {
			if (benchmarkLockstep && message.lockstep === true) {
				const barrierId = Number(message.barrierId);
				if (!Number.isSafeInteger(barrierId) || barrierId <= agent.lastCommittedBarrierId) {
					return;
				}

				agent.lastCommittedBarrierId = barrierId;
				const memo = typeof message.memo === 'string' ? redactSecrets(message.memo).trim() : '';
				if (memo.length > 0) {
					agent.memo = memo.slice(0, 600);
				}
			}
			agent.previousResult = bounded(message.summary, 4000);
		}
		return;
	}

	if (message.type === 'abort-barrier') {
		const barrierId = Number(message.barrierId);
		for (const agent of agents.values()) {
			if (agent.activeRequest?.barrierId === barrierId) {
				agent.activeRequest.controller.abort();
			}
		}
		return;
	}

	if (message.type === 'stop') {
		stopped = true;
		for (const agent of agents.values()) {
			agent.activeRequest?.controller.abort();
		}
		clearCredentials();
		agents.clear();
		close();
	}
};
