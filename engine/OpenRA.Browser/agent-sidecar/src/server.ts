// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ZodError } from 'zod';
import {
	AgentActionBatchSchema,
	ArsenalActionBatchSchema,
	ArsenalPlanningBatchSchema,
	DecideRequestSchema,
	EstimateRequestSchema,
	GuidedActionBatchSchema,
	GuidedArsenalActionBatchSchema,
	CommitActionBatchSchema,
	PlanningBatchSchema,
	ReflectRequestSchema,
	type DecideRequest
} from './contracts.js';
import { z } from 'zod';
import { buildInstructions, RulesKnowledge, RulesKnowledgeHash } from './instructions.js';
import {
	StrategyArsenal,
	renderArsenalMenu,
	renderSituationManualIndex,
	renderStrategyCard,
	renderCardTargetsLine,
	selectRelevantSlices
} from './strategy-catalog.js';
import { makeJsonObjectRequest, makeProviderRequestCompatible } from './provider-schema.js';

const Port = parsePort(process.env.PORT ?? '4112');
const MaxRequestBytes = 512 * 1024;
// Unattended runs type this sentinel into the key field instead of a real
// credential; the sidecar substitutes the key from its own environment so the
// secret never passes through the browser, a transcript, or a log.
const EnvironmentKeySentinel = 'use-env-key';
const EnvironmentApiKey = (process.env.OPENROUTER_API_KEY ?? process.env.openrouter ?? '').trim();
// Overridable so tests can capture the exact provider request against a local
// fake transport without a credential or network access.
const ProviderEndpoint = new URL(
	process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
).toString().replace(/\/+$/, '');
const ProviderEndpointHost = new URL(ProviderEndpoint).host.toLowerCase();
const AllowedOrigins = new Set((process.env.OPENRA_ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean));

type OpenRouterPricing = {
	prompt: number;
	completion: number;
	request: number;
};

type UsageWithCost = {
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	costUsd: number;
};

interface ModelIdentityAttempt {
	label: string;
	servedModelId: string | null;
	endpointHost: string;
	resolvedRoute: string;
	substitutedFor: string | null;
}

interface ModelIdentityEvidence {
	schemaVersion: 1;
	agentId: string;
	decisionId: number;
	requestedModelId: string;
	canonicalRequestedModelId: string;
	requestedRoute: string | null;
	attempts: ModelIdentityAttempt[];
	valid: boolean;
	failureReason: string | null;
}

class PublicError extends Error {
	readonly status: number;
	readonly retryAfterMs: number;

	// Metered provider cost incurred before the failure (a schema-invalid
	// response is still a billed call). Surfaced so the worker charges it
	// against the match spend cap even though the decision is a no-op.
	costUsd = 0;

	// Per-attempt diagnostics (durations, outcomes, token counts — never
	// payloads) so failed decisions are attributable from the match log.
	attempts: AttemptDiagnostic[] = [];

	// Model swaps and missing response provenance are harness failures, not
	// evidence against the requested model. The browser runner persists these
	// safe identifiers and censors the match from skill scoring.
	infrastructureCensorReason: string | null = null;
	modelIdentity: ModelIdentityEvidence | null = null;

	constructor(message: string, status = 400, retryAfterMs = 0) {
		super(message);
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

interface AttemptDiagnostic {
	label: 'strict' | 'repair';
	durationMs: number;
	outcome: 'ok' | 'schema' | 'aborted' | 'upstream';
	finishReason: string | null;
	reasoningTokens: number;
	outputBytes: number;
}

function requestedModelIdentity(modelId: string): { canonicalModelId: string; route: string | null } {
	const match = /^([A-Za-z0-9._-]+):(.+)$/.exec(modelId);
	return match == null
		? { canonicalModelId: modelId, route: null }
		: { canonicalModelId: match[2]!, route: match[1]! };
}

function stringField(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function modelIdentityAttempt(label: string, requestedModelId: string, result: unknown): {
	attempt: ModelIdentityAttempt;
	failureReason: string | null;
} {
	const generated = result != null && typeof result === 'object' ? result as Record<string, unknown> : {};
	const response = generated.response != null && typeof generated.response === 'object'
		? generated.response as Record<string, unknown> : {};
	const body = response.body != null && typeof response.body === 'object'
		? response.body as Record<string, unknown> : {};
	const sublet = body.sublet != null && typeof body.sublet === 'object'
		? body.sublet as Record<string, unknown> : {};
	const requested = requestedModelIdentity(requestedModelId);
	const servedModelId = stringField(response.modelId) ?? stringField(body.model);
	const substitutedForPresent = Object.prototype.hasOwnProperty.call(sublet, 'substituted_for');
	const substitutedFor = substitutedForPresent
		? stringField(sublet.substituted_for) ?? String(sublet.substituted_for ?? '')
		: null;
	const resolvedRoute = stringField(sublet.backend) ?? stringField(body.provider) ??
		`direct:${ProviderEndpointHost}`;
	const attempt: ModelIdentityAttempt = {
		label,
		servedModelId,
		endpointHost: ProviderEndpointHost,
		resolvedRoute,
		substitutedFor
	};

	if (substitutedForPresent) {
		return { attempt, failureReason: `provider substituted for '${substitutedFor}'` };
	}

	if (servedModelId == null) {
		return { attempt, failureReason: 'provider response omitted its served model id' };
	}

	const served = requestedModelIdentity(servedModelId);
	if (served.canonicalModelId !== requested.canonicalModelId) {
		return {
			attempt,
			failureReason: `requested '${requested.canonicalModelId}' but '${served.canonicalModelId}' answered`
		};
	}

	if (requested.route != null && stringField(sublet.backend) != null &&
		requested.route !== stringField(sublet.backend)) {
		return {
			attempt,
			failureReason: `requested route '${requested.route}' but route '${stringField(sublet.backend)}' answered`
		};
	}

	return { attempt, failureReason: null };
}

function modelIdentityEvidence(
	agentId: string,
	decisionId: number,
	requestedModelId: string,
	attempts: ModelIdentityAttempt[],
	failureReason: string | null = null
): ModelIdentityEvidence {
	const requested = requestedModelIdentity(requestedModelId);
	return {
		schemaVersion: 1,
		agentId,
		decisionId,
		requestedModelId,
		canonicalRequestedModelId: requested.canonicalModelId,
		requestedRoute: requested.route,
		attempts: [...attempts],
		valid: failureReason == null,
		failureReason
	};
}

function parsePort(value: string): number {
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('PORT must be an integer between 1 and 65535.');
	}

	return port;
}

function isLoopbackOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
	} catch {
		return false;
	}
}

function allowOrigin(request: IncomingMessage, response: ServerResponse): boolean {
	const origin = request.headers.origin;
	if (origin == null) {
		return true;
	}

	if (!AllowedOrigins.has(origin) && !isLoopbackOrigin(origin)) {
		return false;
	}

	response.setHeader('Access-Control-Allow-Origin', origin);
	response.setHeader('Vary', 'Origin');
	return true;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json; charset=utf-8',
		'X-Content-Type-Options': 'nosniff'
	});
	response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
		size += bytes.length;
		if (size > MaxRequestBytes) {
			throw new PublicError('Request body exceeds 512 KiB.', 413);
		}

		chunks.push(bytes);
	}

	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
	} catch {
		throw new PublicError('Request body is not valid JSON.');
	}
}

function usageTokens(usage: unknown, group: 'inputTokens' | 'outputTokens'): number {
	if (usage == null || typeof usage !== 'object') {
		return 0;
	}

	// The AI SDK surfaces usage either as our convertUsage groups ({ total, ... })
	// or normalised to plain numbers depending on version and code path.
	const tokenGroup = (usage as Record<string, unknown>)[group];
	if (typeof tokenGroup === 'number' && Number.isFinite(tokenGroup)) {
		return Math.max(0, Math.trunc(tokenGroup));
	}

	if (tokenGroup == null || typeof tokenGroup !== 'object') {
		return 0;
	}

	const total = (tokenGroup as Record<string, unknown>).total;
	return typeof total === 'number' && Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
}

function usageReasoningTokens(usage: unknown): number {
	if (usage == null || typeof usage !== 'object') {
		return 0;
	}

	const direct = (usage as Record<string, unknown>).reasoningTokens;
	if (typeof direct === 'number' && Number.isFinite(direct)) {
		return Math.max(0, Math.trunc(direct));
	}

	const output = (usage as Record<string, unknown>).outputTokens;
	if (output == null || typeof output !== 'object') {
		return 0;
	}

	const reasoning = (output as Record<string, unknown>).reasoning;
	return typeof reasoning === 'number' && Number.isFinite(reasoning) ? Math.max(0, Math.trunc(reasoning)) : 0;
}

function safeUpstreamMessage(candidate: Record<string, unknown>, credential?: string): string | undefined {
	let detail: Record<string, unknown> | undefined;
	const data = candidate.data;
	if (data != null && typeof data === 'object') {
		const inner = (data as Record<string, unknown>).error;
		if (inner != null && typeof inner === 'object') {
			detail = inner as Record<string, unknown>;
		}
	}

	if (detail == null && typeof candidate.responseBody === 'string') {
		try {
			const body = JSON.parse(candidate.responseBody) as { error?: unknown };
			if (body.error != null && typeof body.error === 'object') {
				detail = body.error as Record<string, unknown>;
			}
		} catch {
			// Never expose an unstructured upstream body: it may contain request data.
		}
	}

	if (detail == null) {
		return undefined;
	}

	// OpenRouter wraps provider rejections as { message, metadata: { provider_name, raw } }.
	// The provider's verbatim reason is the actionable part of a 4xx, so surface it too —
	// it is provider response text, never our request or credential.
	const parts: string[] = [];
	if (typeof detail.message === 'string' && detail.message.trim().length > 0) {
		parts.push(detail.message.trim());
	}

	const metadata = detail.metadata;
	if (metadata != null && typeof metadata === 'object') {
		const meta = metadata as Record<string, unknown>;
		if (typeof meta.provider_name === 'string' && meta.provider_name.trim().length > 0) {
			parts.push(`provider=${meta.provider_name.trim()}`);
		}

		if (typeof meta.raw === 'string' && meta.raw.trim().length > 0) {
			parts.push(`reason: ${meta.raw.trim()}`);
		}
	}

	if (parts.length === 0) {
		return undefined;
	}

	let safe = parts.join(' — ').replace(/[\r\n\t]+/g, ' ').trim();
	if (credential) {
		safe = safe.split(credential).join('[redacted]');
	}

	return safe.length <= 700 ? safe : `${safe.slice(0, 699)}…`;
}

function upstreamFailure(error: unknown, credential?: string): PublicError {
	if (error instanceof PublicError) {
		return error;
	}

	if (error instanceof ZodError) {
		// Issue paths and messages describe our own schema, never the request
		// payload; they turn an opaque no-op into an actionable rejection.
		const issues = error.issues.slice(0, 3)
			.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
			.join('; ')
			.replace(/[\r\n\t]+/g, ' ')
			.slice(0, 260);
		const detail = issues.length > 0 ? ` (${issues})` : '';
		return new PublicError(`Model response did not match the required ActionBatch schema${detail}.`, 422);
	}

	const candidate = error != null && typeof error === 'object' ? error as Record<string, unknown> : {};
	const statusValue = candidate.statusCode ?? candidate.status;
	const status = typeof statusValue === 'number' ? statusValue : 502;
	const safeMessage = safeUpstreamMessage(candidate, credential);
	const headers = candidate.responseHeaders;
	let retryAfterMs = 0;
	if (headers != null && typeof headers === 'object') {
		const retry = (headers as Record<string, unknown>)['retry-after'];
		if (typeof retry === 'string') {
			const seconds = Number.parseFloat(retry);
			if (Number.isFinite(seconds)) {
				retryAfterMs = Math.min(300000, Math.max(0, Math.ceil(seconds * 1000)));
			}
		}
	}

	if (candidate.name === 'AbortError' || status === 408) {
		return new PublicError('OpenRouter request timed out; this turn is a no-op.', 408);
	}

	if (status === 401 || status === 403) {
		return new PublicError('OpenRouter rejected the credential; the key was cleared.', status);
	}

	if (status === 402) {
		return new PublicError('OpenRouter reported insufficient credit; this turn is a no-op.', status);
	}

	if (status === 429 || status === 503) {
		return new PublicError(`OpenRouter is temporarily unavailable (HTTP ${status}); this turn is a no-op.`, status, retryAfterMs);
	}

	const detail = safeMessage == null ? '' : `: ${safeMessage}`;
	return new PublicError(`OpenRouter request failed (HTTP ${status})${detail}; this turn is a no-op.`, status);
}

// The strict attempt keeps this much of the deadline in reserve so a schema
// repair normally has a usable budget; a timed-out first attempt fails fast
// instead (there is nothing to repair). With the 4s strict floor, request
// deadlines below ~9s cannot fund a repair and fail after the strict attempt
// — accepted behavior for short fast-path turns.
const RepairReserveMs = 10_000;
const MinRepairBudgetMs = 5_000;

// Circuit breaker for schema-failure spirals: after this many consecutive
// invalid decisions from one agent, its accumulated conversational state
// (memo, failure-echoing previous result) is quarantined so the next prompt
// is a fresh start. Poisoned self-written memory otherwise persists forever.
const FreshStartAfterFailures = 2;
const consecutiveSchemaFailures = new Map<string, number>();

// The control harness publishes hostTruth.legalActionTypes (the action types
// legal in the current controlPhase) on the guided/executor surface only. Read
// it defensively — a missing, non-array, or empty value simply disables phase
// narrowing and leaves the full provider union in place.
function readLegalActionTypes(observation: Record<string, any>): string[] | undefined {
	const raw = observation?.hostTruth?.legalActionTypes;
	if (!Array.isArray(raw)) {
		return undefined;
	}

	const types = raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
	return types.length > 0 ? types : undefined;
}

async function decide(input: DecideRequest): Promise<{
	batch: ReturnType<typeof AgentActionBatchSchema.parse> | ReturnType<typeof PlanningBatchSchema.parse> |
		ReturnType<typeof ArsenalActionBatchSchema.parse> | ReturnType<typeof ArsenalPlanningBatchSchema.parse> |
		ReturnType<typeof GuidedActionBatchSchema.parse> | ReturnType<typeof GuidedArsenalActionBatchSchema.parse> |
		ReturnType<typeof CommitActionBatchSchema.parse>;
	usage: UsageWithCost;
	model: string;
	modelIdentity: ModelIdentityEvidence;
	durationMs: number;
	attempts: AttemptDiagnostic[];
}> {
	const apiKey = input.apiKey === EnvironmentKeySentinel ? EnvironmentApiKey : input.apiKey;
	if (apiKey.length < 8) {
		throw new PublicError('The use-env-key sentinel requires an OpenRouter key in the sidecar environment.', 401);
	}

	// Planning turns swap the whole action vocabulary: the provider schema, the
	// final Zod authority, and the batch noun in every instruction all follow
	// the phase so a planning reply can never carry live actions (or vice
	// versa) past validation. Arsenal mode swaps to the strategy-extended
	// schemas the same way; with the default 'off' every raw-track byte —
	// schema, instructions, user message — is untouched.
	const planning = input.phase === 'planning';
	if (input.arsenalMode === 'menu' && !StrategyArsenal.ready) {
		throw new PublicError(`Arsenal mode requested but the strategy catalog is not loadable: ${StrategyArsenal.error}`, 503);
	}

	const arsenal = input.arsenalMode === 'menu';
	const guided = input.guidanceMode === 'exact';
	const batchSchema = planning
		? (arsenal ? ArsenalPlanningBatchSchema : PlanningBatchSchema)
		: input.decisionMode === 'commit'
			? CommitActionBatchSchema
		: guided
			? (arsenal ? GuidedArsenalActionBatchSchema : GuidedActionBatchSchema)
			: (arsenal ? ArsenalActionBatchSchema : AgentActionBatchSchema);
	const batchNoun = planning ? 'PlanningBatch' : 'ActionBatch';

	// The adopted strategy is read from HOST TRUTH in the observation — the
	// sidecar keeps no competing strategy state; a stale or absent id simply
	// renders no card and the menu remains the model's decision surface.
	const observationRecord = input.observation as Record<string, any>;
	const adoptedStrategyId = arsenal
		? observationRecord.hostTruth?.strategy?.strategyId as string | undefined
		: undefined;
	const arsenalSections = arsenal
		? {
			manual: renderSituationManualIndex(StrategyArsenal),
			menu: renderArsenalMenu(StrategyArsenal),
			card: adoptedStrategyId == null
				? undefined
				: renderStrategyCard(StrategyArsenal, adoptedStrategyId) ?? undefined
		}
		: undefined;
	const observedSituations = arsenal && Array.isArray(observationRecord.situations)
		? observationRecord.situations
			.filter((situation: any) => typeof situation?.id === 'string')
			.map((situation: any) => ({
				id: situation.id as string,
				severity: typeof situation.severity === 'string' ? situation.severity : 'info',
				attackerClass: situation.evidence?.attackerClass as string | undefined
			}))
		: [];
	// Control-harness phase narrowing (guided/executor surface only): when the
	// host publishes the legal action types for the current control phase, hand
	// the provider an action union restricted to them so strict structured output
	// has fewer variants to satisfy (fewer schema-miss retries). The Zod
	// batchSchema below stays the full authority — an over-broad model reply is
	// still accepted — so this only trims the provider hint, never validation.
	// Raw (guidanceMode 'off') and planning/commit paths pass undefined, keeping
	// every raw-track provider byte unchanged.
	const phaseLegalActionTypes = guided && !planning && input.decisionMode !== 'commit'
		? readLegalActionTypes(observationRecord)
		: undefined;

	let relevantSlices = arsenal ? selectRelevantSlices(StrategyArsenal, observedSituations) : '';
	if (arsenal && adoptedStrategyId != null) {
		const ownActors = Array.isArray(observationRecord.actors) ? observationRecord.actors : [];
		const targetsLine = renderCardTargetsLine(StrategyArsenal, adoptedStrategyId, {
			harvesters: ownActors.filter((actor: any) => actor?.relationship === 'self' && actor?.type === 'harv').length,
			refineries: typeof observationRecord.hostTruth?.refineryCount === 'number'
				? observationRecord.hostTruth.refineryCount
				: 0,
			activeMissions: Array.isArray(observationRecord.hostTruth?.missions)
				? observationRecord.hostTruth.missions.length
				: 0
		});
		if (targetsLine.length > 0)
			relevantSlices = relevantSlices.length === 0 ? targetsLine : `${relevantSlices}\n${targetsLine}`;
	}

	let observedCost = 0;
	const attempts: AttemptDiagnostic[] = [];
	const modelIdentityAttempts: ModelIdentityAttempt[] = [];
	let lastInvalidText = '';
	// Billed usage accumulates across ALL attempts (strict + repair): after a
	// repaired decision the strict attempt's tokens are real spend, and when
	// the provider omits usage.cost the worker estimates cost from these
	// totals — dropping the first attempt would leak past the hard cap.
	let usedPromptTokens = 0;
	let usedCompletionTokens = 0;
	let usedReasoningTokens = 0;

	const expected = {
		schemaVersion: 1,
		decisionId: input.decisionId,
		observedSequence: input.observation.sequence,
		observedWorldTick: input.observation.worldTick
	};

	// Per-agent model profile: OpenRouter's unified `reasoning` parameter is
	// only injected when a profile explicitly asks for it, so unprofiled
	// models never see an unsupported field.
	const withEffort = (
		base: (args: Record<string, any>) => Record<string, any>,
		effort: 'low' | 'medium' | 'high' | undefined
	) => (args: Record<string, any>) => {
		const built = base(args);
		return effort == null ? built : { ...built, reasoning: { effort } };
	};

	const quarantined = (consecutiveSchemaFailures.get(input.agentId) ?? 0) >= FreshStartAfterFailures;
	const previousResult = quarantined
		? 'Fresh start: your recent replies were invalid and have been discarded. Assess the observation and act.'
		: input.previousResult;

	const buildUserMessage = (repairNote?: string) => {
		const memoBlock = quarantined || input.memo == null || input.memo.trim().length === 0
			? ''
			: 'Commander journal (self-authored on your previous decision; possibly stale — ' +
				`current observation, alerts, and host facts override it):\n${input.memo}\n`;
		const repairBlock = repairNote == null ? '' : `\n${repairNote}`;
		// The trailing order breaks apology loops: after a failed turn some
		// models answer the failure text conversationally instead of emitting
		// JSON; instruction adjacency at the very end keeps them on format.
		// Arsenal slices sit between the observation and the trailing order;
		// they are empty in raw mode so those bytes never change.
		const slicesBlock = relevantSlices.length === 0 ? '' : `\n${relevantSlices}`;
		const guidanceBlock = guided
			? '\nExact guidance is opt-in: choose a host-authored pending option only with a single ' +
				'acceptDoctrineDecision action containing its exact decisionId and optionId. You may still issue ordinary actions.'
			: '';
		return `Decision identity (copy these exact integer values): ${JSON.stringify(expected)}\n` +
			`Previous result: ${previousResult}\n` +
			memoBlock +
			`Current fog-safe observation JSON:\n${JSON.stringify(input.observation)}` +
			slicesBlock +
			guidanceBlock +
			repairBlock +
			`\nReply with ONLY the ${batchNoun} JSON object — no prose, no apologies, no explanations outside the thoughts field.`;
	};

	const generateWith = (
		transformRequestBody: (args: Record<string, any>) => Record<string, any>,
		signal: AbortSignal,
		options?: { repairNote?: string; maxOutputTokens?: number }
	) => {
		const provider = createOpenAICompatible({
			name: 'openrouter',
			baseURL: ProviderEndpoint,
			apiKey: apiKey,
			supportsStructuredOutputs: true,
			headers: { 'X-OpenRouter-Title': 'OpenRA Agent Match' },
			// OpenRouter routes to providers that implement OpenAI's restricted strict
			// schema subset. Zod remains authoritative after generation; this schema is
			// provider guidance and deliberately omits unsupported validation keywords.
			transformRequestBody,
			convertUsage: usage => {
				const promptTokens = usage?.prompt_tokens ?? 0;
				const completionTokens = usage?.completion_tokens ?? 0;
				const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
				const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
				const cost = (usage as Record<string, unknown> | null | undefined)?.cost;
				// Accumulate: a repair adds a second billed call to this decision.
				observedCost += typeof cost === 'number' && Number.isFinite(cost) ? Math.max(0, cost) : 0;
				return {
					inputTokens: {
						total: promptTokens,
						noCache: Math.max(0, promptTokens - cachedTokens),
						cacheRead: cachedTokens,
						cacheWrite: undefined
					},
					outputTokens: {
						total: completionTokens,
						text: Math.max(0, completionTokens - reasoningTokens),
						reasoning: reasoningTokens
					},
					raw: {}
				};
			}
		});

		const openRaAgent = new Agent({
			id: `openra-${input.agentId}`,
			name: `OpenRA ${input.agentId}`,
			instructions: buildInstructions(input.systemPrompt, RulesKnowledge, input.phase, arsenalSections,
				input.decisionMode === 'commit' ? 'commit' : guided ? 'guided' : 'full'),
			model: provider.chatModel(input.model),
			maxRetries: 0
		});
		// Mastra's default error logger includes the complete provider request. Register
		// the per-request agent with logging disabled so prompts, observations, and
		// provider error objects never leave process memory.
		const mastra = new Mastra({ agents: { openra: openRaAgent }, logger: false });
		return mastra.getAgent('openra').generate(
			buildUserMessage(options?.repairNote),
			{
				abortSignal: signal,
				maxSteps: 1,
				modelSettings: {
					maxOutputTokens: options?.maxOutputTokens ?? input.maxOutputTokens,
					temperature: 0.2
				},
				// 'warn': Mastra's own validation pass demands the model echo the
				// identity fields we overwrite below, so let it hand back the raw
				// object; our phase-selected batchSchema.parse stays the strict authority.
				structuredOutput: { schema: batchSchema, errorStrategy: 'warn' }
			});
	};

	const started = performance.now();

	const runAttempt = async (
		label: AttemptDiagnostic['label'],
		transform: (args: Record<string, any>) => Record<string, any>,
		budgetMs: number,
		options?: { repairNote?: string; maxOutputTokens?: number }
	) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.max(1000, budgetMs));
		const attemptStarted = performance.now();
		const diagnostic: AttemptDiagnostic = {
			label,
			durationMs: 0,
			outcome: 'upstream',
			finishReason: null,
			reasoningTokens: 0,
			outputBytes: 0
		};
		attempts.push(diagnostic);
		try {
			const result = await generateWith(transform, controller.signal, options);
			const identity = modelIdentityAttempt(label, input.model, result);
			modelIdentityAttempts.push(identity.attempt);
			if (identity.failureReason != null) {
				const failure = new PublicError(
					`Provider model identity could not be verified: ${identity.failureReason}.`, 502);
				failure.infrastructureCensorReason = `model-identity: ${identity.failureReason}`;
				failure.modelIdentity = modelIdentityEvidence(input.agentId, input.decisionId,
					input.model, modelIdentityAttempts, identity.failureReason);
				throw failure;
			}

			const raw = (result as Record<string, unknown>).text;
			lastInvalidText = typeof raw === 'string' ? raw : '';
			diagnostic.finishReason = typeof (result as Record<string, unknown>).finishReason === 'string'
				? (result as Record<string, unknown>).finishReason as string
				: null;
			diagnostic.reasoningTokens = usageReasoningTokens(result.totalUsage);
			diagnostic.outputBytes = Buffer.byteLength(lastInvalidText, 'utf8');
			usedPromptTokens += usageTokens(result.totalUsage, 'inputTokens');
			usedCompletionTokens += usageTokens(result.totalUsage, 'outputTokens');
			usedReasoningTokens += usageReasoningTokens(result.totalUsage);

			// A deadline abort surfaces through Mastra as a normal empty result
			// (finishReason=tripwire, r0/b0), NOT a thrown AbortError. Detect the
			// fired signal here and raise an abort-class error BEFORE the salvage
			// parse, so the catch records outcome=aborted (not ZodError->schema),
			// the doomed repair is suppressed by the timedOut guard below, and the
			// caller returns 408. Only a truly aborted attempt skips repair; a fast
			// genuine empty response still deserves one.
			if (controller.signal.aborted) {
				const abortError = new Error('attempt aborted before completion: request deadline exceeded');
				abortError.name = 'AbortError';
				throw abortError;
			}

			// Salvage: the extraction layer sometimes returns no object even
			// though the reply text IS well-formed batch JSON (observed live:
			// perfectly valid replies rejected as empty). The raw text is
			// authoritative input to Zod either way — validation still rules.
			let candidate: unknown = result.object;
			if (candidate == null) {
				const text = lastInvalidText.trim();
				const start = text.indexOf('{');
				const end = text.lastIndexOf('}');
				if (start >= 0 && end > start) {
					try {
						candidate = JSON.parse(text.slice(start, end + 1));
					} catch {
						candidate = undefined;
					}
				}
			}

			const batch = batchSchema.parse({
				...(candidate ?? {}),
				...expected
			});
			diagnostic.outcome = 'ok';
			return { batch, usage: result.totalUsage };
		} catch (error) {
			diagnostic.outcome = error instanceof ZodError
				? 'schema'
				: controller.signal.aborted ? 'aborted' : 'upstream';
			throw error;
		} finally {
			diagnostic.durationMs = Math.round(performance.now() - attemptStarted);
			clearTimeout(timer);
		}
	};

	try {
		const strictBudget = Math.max(4000, input.requestTimeoutMs - RepairReserveMs);
		let outcome: Awaited<ReturnType<typeof runAttempt>>;
		try {
			outcome = await runAttempt('strict',
				withEffort(args => makeProviderRequestCompatible(args, phaseLegalActionTypes), input.reasoningEffort),
				strictBudget);
		} catch (error) {
			// Two repairable failures: providers that reject the json_schema dialect
			// with an HTTP 400 before inference, and models whose json_schema output
			// fails Zod (reasoning models drift or truncate under load). A timed-out
			// first attempt fails fast — there is no output to repair. The repair is
			// one short, low-reasoning json_object call that sees the invalid output.
			const timedOut = attempts[attempts.length - 1]?.outcome === 'aborted';
			const repairable = !timedOut &&
				(error instanceof ZodError || upstreamFailure(error, apiKey).status === 400);
			const remaining = input.requestTimeoutMs - (performance.now() - started);
			if (!repairable || remaining < MinRepairBudgetMs) {
				throw error;
			}

			const excerpt = lastInvalidText.trim().slice(0, 500);
			// A 'length' failure means the reply outgrew the budget — the repair
			// must get the FULL budget (a smaller repair is guaranteed to truncate
			// again) plus an explicit brevity order to break verbosity spirals.
			const truncated = attempts[attempts.length - 1]?.finishReason === 'length';
			const brevityNote = truncated
				? ' Your reply was cut off for length: keep thoughts to two short sentences, the memo to one line, and at most four actions.'
				: '';
			const repairNote = (excerpt.length > 0
				? `Your previous reply was not a valid ${batchNoun} JSON object. Invalid reply excerpt: ` +
					`${excerpt}\nReturn ONLY the corrected JSON object, nothing else.`
				: `Your previous reply was not a valid ${batchNoun} JSON object. Return ONLY a valid JSON object, nothing else.`) +
				brevityNote;
			outcome = await runAttempt(
				'repair',
				withEffort(args => makeJsonObjectRequest(args, phaseLegalActionTypes),
					input.reasoningEffort == null ? undefined : 'low'),
				Math.min(remaining, RepairReserveMs + MinRepairBudgetMs),
				{ repairNote, maxOutputTokens: truncated ? input.maxOutputTokens : Math.min(1536, input.maxOutputTokens) });
		}

		consecutiveSchemaFailures.delete(input.agentId);
		const { batch } = outcome;
		return {
			batch,
			usage: {
				promptTokens: usedPromptTokens,
				completionTokens: usedCompletionTokens,
				reasoningTokens: usedReasoningTokens,
				costUsd: observedCost
			},
			model: input.model,
			modelIdentity: modelIdentityEvidence(input.agentId, input.decisionId, input.model, modelIdentityAttempts),
			durationMs: Math.round(performance.now() - started),
			attempts
		};
	} catch (error) {
		const failure = upstreamFailure(error, apiKey);
		failure.costUsd = observedCost;
		failure.attempts = attempts;
		if (failure.modelIdentity == null && modelIdentityAttempts.length > 0) {
			failure.modelIdentity = modelIdentityEvidence(input.agentId, input.decisionId,
				input.model, modelIdentityAttempts, failure.infrastructureCensorReason);
		}
		// The breaker counts every decision that produced schema-invalid output,
		// even when the final thrown error is the repair's upstream failure —
		// the model's context is just as poisoned either way.
		const schemaInvalid = error instanceof ZodError || attempts.some(attempt => attempt.outcome === 'schema');
		if (schemaInvalid) {
			consecutiveSchemaFailures.set(input.agentId,
				(consecutiveSchemaFailures.get(input.agentId) ?? 0) + 1);
			// Temporary forensic: what shape is the model actually returning?
			// Provider output only (already user-visible in feeds), key-redacted.
			const clean = lastInvalidText.replace(/[\r\n\t]+/g, ' ').split(apiKey).join('[redacted]');
			const issues = error instanceof ZodError
				? error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
				: `final error not Zod: ${String((error as Error).message ?? error).slice(0, 80)}`;
			let parseVerdict = 'no-json';
			const start = clean.indexOf('{');
			const end = clean.lastIndexOf('}');
			if (start >= 0 && end > start) {
				try {
					JSON.parse(lastInvalidText.trim().slice(lastInvalidText.trim().indexOf('{'), lastInvalidText.trim().lastIndexOf('}') + 1));
					parseVerdict = 'parses';
				} catch (parseError) {
					parseVerdict = `parse-error: ${String((parseError as Error).message).slice(0, 60)}`;
				}
			}

			console.warn(`[agent-sidecar] invalid-shape agent=${input.agentId} quarantine=${quarantined} ` +
				`json=${parseVerdict} zod="${issues.slice(0, 160)}" head="${clean.slice(0, 120)}" tail="${clean.slice(-120)}"`);
		}

		throw failure;
	}
}

// One constant governs both the instruction's promised bound and the
// enforcement slice — they must never drift apart.
const MaxLessonsChars = 2200;

// The self-improvement loop: the model rereads its own match report and prior
// lessons and rewrites the bounded lessons file that future system prompts
// carry. Plain text generation — no action schema — but the same key
// sentinel, redaction, and logging rules as decide().
async function reflect(input: z.infer<typeof ReflectRequestSchema>): Promise<{
	lessons: string;
	usage: UsageWithCost;
	model: string;
	modelIdentity: ModelIdentityEvidence;
	durationMs: number;
}> {
	const apiKey = input.apiKey === EnvironmentKeySentinel ? EnvironmentApiKey : input.apiKey;
	if (apiKey.length < 8) {
		throw new PublicError('The use-env-key sentinel requires an OpenRouter key in the sidecar environment.', 401);
	}

	let observedCost = 0;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), input.requestTimeoutMs);
	const started = performance.now();
	try {
		const provider = createOpenAICompatible({
			name: 'openrouter',
			baseURL: ProviderEndpoint,
			apiKey: apiKey,
			headers: { 'X-OpenRouter-Title': 'OpenRA Agent Match' },
			convertUsage: usage => {
				const promptTokens = usage?.prompt_tokens ?? 0;
				const completionTokens = usage?.completion_tokens ?? 0;
				const cost = (usage as Record<string, unknown> | null | undefined)?.cost;
				observedCost += typeof cost === 'number' && Number.isFinite(cost) ? Math.max(0, cost) : 0;
				return {
					inputTokens: { total: promptTokens, noCache: promptTokens, cacheRead: 0, cacheWrite: undefined },
					outputTokens: { total: completionTokens, text: completionTokens, reasoning: 0 },
					raw: {}
				};
			}
		});

		const reflectionAgent = new Agent({
			id: 'openra-reflect',
			name: 'OpenRA Reflection',
			instructions: 'You are the same Red Alert commander who just played the match described by the report. ' +
				`Rewrite your persistent lessons file for future matches. Rules: at most ${MaxLessonsChars} characters; imperative, ` +
				'specific, and grounded in this game (timings, producer addressing, phase transitions, what the enemy ' +
				'punished); merge your prior lessons — keep what proved true, revise or delete what failed; never ' +
				'restate the playbook, only what experience added. Output ONLY the lessons text.',
			model: provider.chatModel(input.model),
			maxRetries: 0
		});
		const mastra = new Mastra({ agents: { reflect: reflectionAgent }, logger: false });
		const result = await mastra.getAgent('reflect').generate(
			`Prior lessons file (may be empty):\n${input.priorLessons}\n\nMatch report:\n${input.matchReport}\n\n` +
			'Rewrite the complete lessons file now.',
			{
				abortSignal: controller.signal,
				maxSteps: 1,
				modelSettings: { maxOutputTokens: 1024, temperature: 0.4 }
			});
		const identity = modelIdentityAttempt('reflect', input.model, result);
		if (identity.failureReason != null) {
			const failure = new PublicError(
				`Provider model identity could not be verified: ${identity.failureReason}.`, 502);
			failure.infrastructureCensorReason = `model-identity: ${identity.failureReason}`;
			failure.modelIdentity = modelIdentityEvidence('reflection', 0,
				input.model, [identity.attempt], identity.failureReason);
			throw failure;
		}

		const lessons = (result.text ?? '').trim().slice(0, MaxLessonsChars);
		if (lessons.length === 0) {
			throw new PublicError('Reflection returned no text; lessons file unchanged.', 422);
		}

		return {
			lessons,
			usage: {
				promptTokens: usageTokens(result.totalUsage, 'inputTokens'),
				completionTokens: usageTokens(result.totalUsage, 'outputTokens'),
				reasoningTokens: 0,
				costUsd: observedCost
			},
			model: input.model,
			modelIdentity: modelIdentityEvidence('reflection', 0, input.model, [identity.attempt]),
			durationMs: Math.round(performance.now() - started)
		};
	} catch (error) {
		const failure = upstreamFailure(error, apiKey);
		failure.costUsd = observedCost;
		throw failure;
	} finally {
		clearTimeout(timer);
	}
}

async function modelPricing(modelIds: string[]): Promise<Map<string, OpenRouterPricing>> {
	const response = await fetch(`${ProviderEndpoint}/models`, { headers: { Accept: 'application/json' } });
	if (!response.ok) {
		throw new PublicError('Could not load OpenRouter model pricing.', 502);
	}

	const body = await response.json() as { data?: Array<{ id?: string; pricing?: Record<string, string> }> };
	const wanted = new Set(modelIds);
	const result = new Map<string, OpenRouterPricing>();
	for (const model of body.data ?? []) {
		if (model.id == null || !wanted.has(model.id)) {
			continue;
		}

		const prompt = Number.parseFloat(model.pricing?.prompt ?? 'NaN');
		const completion = Number.parseFloat(model.pricing?.completion ?? 'NaN');
		const request = Number.parseFloat(model.pricing?.request ?? '0');
		if (Number.isFinite(prompt) && prompt >= 0 && Number.isFinite(completion) && completion >= 0 &&
			Number.isFinite(request) && request >= 0) {
			result.set(model.id, { prompt, completion, request });
		}
	}

	return result;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (!allowOrigin(request, response)) {
		throw new PublicError('Origin is not allowed.', 403);
	}

	if (request.method === 'OPTIONS') {
		response.writeHead(204, {
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Max-Age': '600'
		});
		response.end();
		return;
	}

	const url = new URL(request.url ?? '/', 'http://sidecar.invalid');
	if (request.method === 'GET' && url.pathname === '/health') {
		sendJson(response, 200, {
			ok: true,
			service: 'openra-agent-sidecar',
			mastra: true,
			// This exact normalized value is also passed to the provider client.
			// Match orchestration reads it back before tick zero rather than
			// trusting the environment that launched this process.
			providerEndpoint: ProviderEndpoint,
			knowledgeChars: RulesKnowledge.length,
			rulesKnowledgeHash: RulesKnowledgeHash,
			// Strategy-arsenal preflight surface: the browser compares these
			// pins against the host manifest BEFORE any paid request; a
			// not-ready arsenal never blocks raw-mode matches.
			arsenalReady: StrategyArsenal.ready,
			arsenalError: StrategyArsenal.ready ? '' : StrategyArsenal.error,
			strategyCatalogVersion: StrategyArsenal.catalogVersion,
			strategyCount: StrategyArsenal.catalog.length,
			rulesHash: StrategyArsenal.rulesHash,
			rulesArtifactHash: StrategyArsenal.rulesArtifactHash,
			rulesGraphHash: StrategyArsenal.rulesGraphHash,
			catalogFileHash: StrategyArsenal.catalogFileHash,
			manualFileHash: StrategyArsenal.manualFileHash,
			arsenalMenuChars: StrategyArsenal.menuBytes,
			maxStrategyContextChars: StrategyArsenal.menuBytes + StrategyArsenal.largestCardBytes + 4096
		});
		return;
	}

	if (request.method === 'POST' && url.pathname === '/api/estimate') {
		const input = EstimateRequestSchema.parse(await readJson(request));
		const prices = await modelPricing(input.models);
		const agents = input.models.map(model => {
			const pricing = prices.get(model);
			if (pricing == null) {
				throw new PublicError(`OpenRouter pricing is unavailable for model '${model}'.`, 422);
			}

			const estimatedInputTokens = input.estimatedInputTokens + Math.ceil(RulesKnowledge.length / 4);
			const perDecisionUsd = pricing.request + estimatedInputTokens * pricing.prompt +
				input.maxOutputTokens * pricing.completion;
			return { model, ...pricing, perDecisionUsd, estimatedInputTokens };
		});
		const estimatedMatchUsd = agents.reduce((total, agent) =>
			total + agent.perDecisionUsd * input.estimatedDecisionsPerAgent, 0);
		sendJson(response, 200, {
			agents,
			estimatedMatchUsd,
			assumptions: input,
			knowledgeChars: RulesKnowledge.length,
			rulesKnowledgeHash: RulesKnowledgeHash,
			// Worst-case arsenal-mode reference size (menu + largest card +
			// slice budget) so worker spend preflight stays conservative when
			// the arsenal is enabled; zero when the catalog is not loadable.
			arsenalContextChars: StrategyArsenal.ready
				? StrategyArsenal.menuBytes + StrategyArsenal.largestCardBytes + 4096
				: 0
		});
		return;
	}

	if (request.method === 'POST' && url.pathname === '/api/decide') {
		const input = DecideRequestSchema.parse(await readJson(request));
		const output = await decide(input);
		sendJson(response, 200, output);
		return;
	}

	if (request.method === 'POST' && url.pathname === '/api/reflect') {
		const input = ReflectRequestSchema.parse(await readJson(request));
		const output = await reflect(input);
		sendJson(response, 200, output);
		return;
	}

	throw new PublicError('Not found.', 404);
}

const server = createServer((request, response) => {
	void handle(request, response).catch(error => {
		const failure = error instanceof ZodError
			? new PublicError('Request failed schema validation.', 422)
			: upstreamFailure(error);
		// Attempt diagnostics are schema-safe (labels, outcomes, provider finish
		// reasons, token counts — never payloads) and name the failure cause
		// (e.g. Gemini RECITATION/SAFETY empty candidates vs length truncation).
		const attemptSummary = failure.attempts.length === 0
			? ''
			: ` attempts=${failure.attempts.map(attempt =>
				`${attempt.label}:${attempt.outcome}` +
				`${attempt.finishReason == null ? '' : `/${attempt.finishReason}`}` +
				`(r${attempt.reasoningTokens},b${attempt.outputBytes},${attempt.durationMs}ms)`).join(',')}`;
		console.warn(`[agent-sidecar] request failed path=${request.url ?? '/'} status=${failure.status}${attemptSummary}`);
		sendJson(response, failure.status, {
			error: failure.message,
			retryAfterMs: failure.retryAfterMs,
			costUsd: failure.costUsd,
			infrastructureCensorReason: failure.infrastructureCensorReason,
			modelIdentity: failure.modelIdentity,
			// The worker threads these into the match log so a failed decision
			// keeps its finish-reason/schema/abort attribution.
			attempts: failure.attempts
		});
	});
});

server.listen(Port, '127.0.0.1', () => {
	console.log(`[agent-sidecar] listening on http://127.0.0.1:${Port}`);
});
