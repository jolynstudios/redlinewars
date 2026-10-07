// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

// Benchmark metrics engine: consumes a match's log.jsonl and produces
// metrics.json + scorecard.md — the per-agent numbers the Red Alert
// benchmark scores on. Pure log analysis; no game or network access.
// Usage:
//   node a2a-metrics.mjs match-results/<label>            # writes into the dir
//   node a2a-metrics.mjs match-results/<label> --print    # also prints scorecard
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const targetDir = process.argv[2];
if (!targetDir || !existsSync(path.join(targetDir, 'log.jsonl'))) {
	console.error('usage: node a2a-metrics.mjs <match-results-dir> [--print]');
	process.exit(2);
}

const lines = readFileSync(path.join(targetDir, 'log.jsonl'), 'utf8')
	.split('\n').filter(Boolean).map(line => {
		try {
			return JSON.parse(line);
		} catch {
			return null;
		}
	}).filter(Boolean);

const TicksPerSecond = 25;
// Doctrine milestones: first ACCEPTED use of each production item.
const MilestoneItems = ['powr', 'barr', 'kenn', 'proc', 'weap', 'fix', 'dome', '3tnk', 'e2'];
const agents = new Map();
const agentOf = id => {
	if (!agents.has(id)) {
		agents.set(id, {
			agent: id,
			model: null,
			decisions: 0,
			resultBatches: 0,
			// Decision outcomes that never reached a per-action host verdict. A
			// rejected batch (worker/host threw the whole submission out) and a
			// model failure (the model call itself errored) are each a no-effect
			// turn; counting them stops a large no-op floor from hiding as an
			// uncounted decision and feeds validDecisionRate.
			rejectedBatches: 0,
			modelFailures: 0,
			actionsAccepted: 0,
			actionsRejected: 0,
			noOps: 0,
			emptyActionTurns: 0,
			alerts: 0,
			reflexOrders: 0,
			rejectionCauses: {},
			firstAcceptedTickByType: {},
			// Actions from the last Decided bubble, held until the matching
			// Result bubble proves per-action acceptance.
			pendingSubmittedActions: null,
			decisionLatenciesMs: [],
			// alert bubble time -> next accepted Result bubble time (reaction).
			pendingAlertAt: null,
			reactionLatenciesMs: [],
			spendUsd: 0,
			promptTokens: 0,
			completionTokens: 0,
			// Era-2 forward scaffolding: attempt diagnostics + fallback markers.
			attemptDecisions: 0,
			attemptsTotal: 0,
			attemptsFailed: 0,
			attemptsByOutcome: {},
			attemptsByFinishReason: {},
			repairedDecisions: 0,
			fallbackTurns: 0,
			missionInstrumentation: false,
			missionTelemetryComplete: null,
			missionsQueued: 0,
			missionsCompleted: 0,
			missionsAborted: 0,
			missionsReplaced: 0,
			firstMissionContactTick: null,
			// Era-3 strategy adoption: null-when-absent mirrors the mission
			// pattern — raw matches report "not instrumented", never zero.
			strategyInstrumentation: false,
			strategyTelemetryComplete: null,
			strategyAdopted: false,
			initialStrategyId: null,
			initialAdoptTick: null,
			currentStrategyId: null,
			strategySwitches: 0,
			// Audit-agreed thrash diagnostic: longest run of consecutive Result
			// bubbles whose first rejection cause is identical.
			maxSameRejectionStreak: 0,
			pendingRejectionKey: null,
			currentRejectionStreak: 0,
			// PR0 metrics freeze (DOCTRINE-ORCHESTRATION.md): noop / thrash by cause.
			// groupMissing = assign/move/attack on a squad name with no live roster
			// (group-reference sequencing: use before assignGroup or after cull).
			noopByCause: {
				emptyBatch: 0,
				allRejected: 0,
				groupMissing: 0,
				planOwnsQueues: 0,
				queueLocalReservation: 0,
				placeNotReady: 0,
				timeout: 0,
				schemaFailure: 0,
				budget: 0,
				other: 0
			},
			// Prose "mission" in thoughts vs typed queueMission accepts (knowing-doing).
			missionMentions: 0,
			missionActionsAccepted: 0,
			rejectionRecoveryOpportunities: 0,
			rejectionRecoveries: 0,
			pendingRejectionRecovery: false,
			doctrineInstrumentation: false,
			doctrineActions: 0,
			doctrineDecisionIds: new Set(),
			guidanceSelections: 0,
			modelSelectedCommitCount: 0,
			modelDirectStrikeCount: 0,
			doctrineFallbackStrikeCount: 0,
			criticalAssetLostCount: 0,
			productionIdleAffordableWakeCount: 0
		});
	}

	return agents.get(id);
};

// Normalize a rejection reason into a stable thrash bucket for per-cause rates.
const classifyRejectionCause = reason => {
	const r = String(reason ?? '');
	// Host: "group 'Name' does not exist or has no live actors"
	if (/group\s+['"][^'"]+['"]\s+does not exist or has no live actors/i.test(r) ||
		/does not exist or has no live actors/i.test(r) && /group/i.test(r))
		return 'groupMissing';
	if (/producer \d+ is reserved by build plan|use another queue or cancel-first/i.test(r))
		return 'queueLocalReservation';
	if (/owns production queues|build plan .* owns/i.test(r))
		return 'planOwnsQueues';
	if (/not ready|placeable:true|is not placeable/i.test(r))
		return 'placeNotReady';
	if (/timeout|timed out/i.test(r))
		return 'timeout';
	if (/schema|malformed|invalid json/i.test(r))
		return 'schemaFailure';
	if (/budget|spend cap|credit/i.test(r))
		return 'budget';
	return 'other';
};

let booted = null;
let terminal = null;
let lastState = null;
let desync = false;
let lastTickByTime = [];
let fallbackDetected = false;
let globalMissionTelemetryError = false;
const seenMissionEvents = new Set();

// A contact tick is deliberately derived from host mission facts, never from
// rendered feed prose. These are the bounded states/reasons emitted when a
// committed strike/pincer enters engaging or a sweep discovers a previously
// unknown enemy structure. Pursue/air order kinds are currently controller
// intents, not lifecycle events, so claiming them here would fabricate cover.
const isMissionContact = entry => entry.state === 'engaging' ||
	/new enemy structure discovered/i.test(String(entry.reason ?? ''));

for (const entry of lines) {
	if (entry.kind === 'booted') {
		booted = entry;
	}

	if (entry.kind === 'state') {
		// Terminal states report tick=-1; keep the last real tick for game time.
		if (entry.tick != null && entry.tick >= 0) {
			lastState = entry;
		}

		lastTickByTime.push({ t: Date.parse(entry.t), tick: entry.tick });
		if (entry.oos) {
			desync = true;
		}
	}

	if (entry.kind === 'terminal') {
		terminal = entry;
	}

	if (entry.kind === 'mission-instrumentation' && entry.agent && entry.available === true) {
		const stats = agentOf(entry.agent);
		stats.missionInstrumentation = true;
		if (stats.missionTelemetryComplete == null)
			stats.missionTelemetryComplete = true;
	}

	if (entry.kind === 'mission-telemetry-error') {
		if (entry.agent) {
			const stats = agentOf(entry.agent);
			stats.missionInstrumentation = true;
			stats.missionTelemetryComplete = false;
		} else {
			globalMissionTelemetryError = true;
		}
	}

	if (entry.kind === 'mission' && entry.agent) {
		const stats = agentOf(entry.agent);
		stats.missionInstrumentation = true;
		if (stats.missionTelemetryComplete == null)
			stats.missionTelemetryComplete = true;
		const eventKey = `${entry.agent}:${entry.sequence}`;
		if (!seenMissionEvents.has(eventKey)) {
			seenMissionEvents.add(eventKey);
			if (entry.state === 'planned' && entry.eventKind === 'planned')
				stats.missionsQueued++;
			if (entry.state === 'completed')
				stats.missionsCompleted++;
			if (entry.state === 'aborted')
				stats.missionsAborted++;
			if (entry.eventKind === 'replaced')
				stats.missionsReplaced++;
			if (stats.firstMissionContactTick == null && Number.isFinite(entry.worldTick) &&
				isMissionContact(entry))
				stats.firstMissionContactTick = entry.worldTick;
		}
	}

	if (entry.kind === 'strategy-instrumentation' && entry.agent && entry.available === true) {
		const stats = agentOf(entry.agent);
		stats.strategyInstrumentation = true;
		if (stats.strategyTelemetryComplete == null)
			stats.strategyTelemetryComplete = true;
	}

	if (entry.kind === 'strategy-telemetry-error' && entry.agent) {
		const stats = agentOf(entry.agent);
		stats.strategyInstrumentation = true;
		stats.strategyTelemetryComplete = false;
	}

	if (entry.kind === 'strategy' && entry.agent) {
		const stats = agentOf(entry.agent);
		stats.strategyInstrumentation = true;
		if (stats.strategyTelemetryComplete == null)
			stats.strategyTelemetryComplete = true;
		const eventKey = `strategy:${entry.agent}:${entry.sequence}`;
		if (!seenMissionEvents.has(eventKey)) {
			seenMissionEvents.add(eventKey);
			if (entry.eventKind === 'adopted') {
				stats.strategyAdopted = true;
				stats.initialStrategyId ??= entry.strategyId ?? null;
				if (stats.initialAdoptTick == null && Number.isFinite(entry.worldTick))
					stats.initialAdoptTick = entry.worldTick;
			}

			if (entry.eventKind === 'switched')
				stats.strategySwitches++;
			if (entry.strategyId != null)
				stats.currentStrategyId = entry.strategyId;
		}
	}

	// Attempt diagnostics: entries of any kind may carry an attempts array of
	// {label, outcome, finishReason, reasoningTokens, outputBytes, durationMs}
	// describing every model call behind one decision. Aggregate per agent;
	// logs that predate the feature report resilience: null (never fabricated
	// zeros).
	if (entry.agent && Array.isArray(entry.attempts) && entry.attempts.length > 0) {
		const stats = agentOf(entry.agent);
		stats.attemptDecisions++;
		let repaired = false;
		for (const attempt of entry.attempts) {
			stats.attemptsTotal++;
			const attemptOutcome = attempt?.outcome != null ? String(attempt.outcome) : 'unknown';
			stats.attemptsByOutcome[attemptOutcome] = (stats.attemptsByOutcome[attemptOutcome] ?? 0) + 1;
			if (attemptOutcome !== 'ok') {
				stats.attemptsFailed++;
			}

			const finishReason = attempt?.finishReason != null ? String(attempt.finishReason) : 'unknown';
			stats.attemptsByFinishReason[finishReason] = (stats.attemptsByFinishReason[finishReason] ?? 0) + 1;
			if (attempt?.label != null && String(attempt.label).includes('repair')) {
				repaired = true;
			}
		}

		if (repaired) {
			stats.repairedDecisions++;
		}
	}

	// Fallback markers (tolerantly detected future Era-2 shape): kind
	// 'fallback' or a fallback: true field marks a turn where a scripted
	// fallback stood in for the model. Matches without any marker report
	// fallbackRate: null ('not enabled this era').
	if (entry.kind === 'fallback' || entry.fallback === true) {
		fallbackDetected = true;
		if (entry.agent) {
			agentOf(entry.agent).fallbackTurns++;
		}
	}

	// Alert bubbles: count hygiene-relevant kinds when the feed prints them.
	if (entry.kind === 'bubble' && entry.agent && typeof entry.text === 'string') {
		const stats = agentOf(entry.agent);
		if (/criticalAssetLost/i.test(entry.text))
			stats.criticalAssetLostCount++;
		if (/productionIdleAffordable/i.test(entry.text))
			stats.productionIdleAffordableWakeCount++;
	}

	if (entry.kind !== 'bubble' || !entry.agent) {
		continue;
	}

	const agent = agentOf(entry.agent);
	const text = String(entry.text ?? '');

	if (text.startsWith('ALERT')) {
		agent.alerts++;
		agent.pendingAlertAt = Date.parse(entry.t);
	}

	if (text.startsWith('REFLEX')) {
		agent.reflexOrders++;
	}

	if (text.startsWith('DOCTRINE')) {
		agent.doctrineInstrumentation = true;
		agent.doctrineActions++;
		const source = text.match(/\bsource=([^\s]+)/)?.[1] ?? '';
		const eventKind = text.match(/\bkind=([^\s]+)/)?.[1] ?? '';
		const decisionId = Number(text.match(/\bdecision=(\d+)/)?.[1] ?? 0);
		if (decisionId > 0)
			agent.doctrineDecisionIds.add(decisionId);
		if (source === 'modelSelectedGuidance') {
			agent.guidanceSelections++;
			if (eventKind === 'decisionAccepted')
				agent.modelSelectedCommitCount++;
		}
		if (source === 'modelDirect' && eventKind === 'decisionResolved')
			agent.modelDirectStrikeCount++;
		if (source === 'doctrineFallback' && eventKind === 'fallbackStrike')
			agent.doctrineFallbackStrikeCount++;
	}

	if (text.startsWith('Thinking')) {
		const model = text.match(/decision \d+([a-z0-9./-]+·?[^·]*)?/i);
		const idMatch = text.match(/decision \d+(\S+\/\S+)/);
		if (idMatch && !agent.model) {
			agent.model = idMatch[1].split(' ')[0];
		}
		void model;
	}

	if (text.startsWith('No-op')) {
		agent.noOps++;
		agent.decisions++;
		agent.pendingRejectionRecovery = false;
		// A held submitted list must never leak past a decision boundary.
		agent.pendingSubmittedActions = null;
		if (/timeout|timed out/i.test(text))
			agent.noopByCause.timeout++;
		else if (/schema|malformed|invalid json/i.test(text))
			agent.noopByCause.schemaFailure++;
		else if (/budget|spend cap|credit/i.test(text))
			agent.noopByCause.budget++;
		else
			agent.noopByCause.other++;
	}

	// Rejected-batch: the whole submitted batch was thrown out before any
	// per-action host verdict (worker/host exception, "irrelevant host
	// rejection"). A distinct decision outcome from a per-action Result — counted
	// on its own so it feeds validDecisionRate instead of vanishing off-scorecard.
	// Kept out of decisions/noOps so existing rates stay byte-identical; clearing
	// the held Decided list is decision-boundary hygiene (no Result will consume it).
	if (text.startsWith('Rejected batch')) {
		agent.rejectedBatches++;
		agent.pendingRejectionRecovery = false;
		agent.pendingSubmittedActions = null;
	}

	// Model-failed: the model call itself errored (timeout, provider/credit,
	// fatal). Counted on its own for validDecisionRate; on assisted tracks a
	// separate FALLBACK bubble is what a fallback turn is counted from, so folding
	// this into decisions would double-count that turn — hence a dedicated counter.
	if (text.startsWith('Model failed')) {
		agent.modelFailures++;
		agent.pendingRejectionRecovery = false;
		agent.pendingSubmittedActions = null;
	}

	if (text.startsWith('Result')) {
		agent.decisions++;
		agent.resultBatches++;
		const accepted = (text.match(/: accepted/g) ?? []).length;
		const rejected = (text.match(/: rejected/g) ?? []).length;
		if (agent.pendingRejectionRecovery) {
			if (accepted > 0)
				agent.rejectionRecoveries++;
			agent.pendingRejectionRecovery = false;
		}
		agent.actionsAccepted += accepted;
		agent.actionsRejected += rejected;
		if (accepted === 0 && rejected === 0) {
			agent.emptyActionTurns++;
			agent.noOps++;
			if (/No actions submitted/i.test(text))
				agent.noopByCause.emptyBatch++;
			else
				agent.noopByCause.other++;
		} else if (accepted === 0 && rejected > 0) {
			agent.noOps++;
			agent.noopByCause.allRejected++;
			agent.rejectionRecoveryOpportunities++;
			agent.pendingRejectionRecovery = true;
		}

		let firstRejectionKey = null;
		for (const cause of text.matchAll(/rejected — (.+?)(?= \d+\. | Usage:|$)/g)) {
			const raw = cause[1].trim();
			const key = raw.replace(/\d+/g, 'N').slice(0, 70);
			const bucket = classifyRejectionCause(raw);
			if (bucket !== 'queueLocalReservation')
				firstRejectionKey ??= key;
			agent.rejectionCauses[key] = (agent.rejectionCauses[key] ?? 0) + 1;
			// Fine-grained thrash buckets (group sequencing, place-not-ready, …).
			// Coarse allRejected still counts whole dead batches above.
			agent.noopByCause[bucket] = (agent.noopByCause[bucket] ?? 0) + 1;
		}

		if (/queueMission:\s*accepted/i.test(text))
			agent.missionActionsAccepted += (text.match(/queueMission:\s*accepted/gi) ?? []).length;

		// Same-rejection streak: consecutive Result turns opening with the
		// identical normalized cause — the "spammed the same illegal action"
		// signature the external audits asked to make visible.
		if (firstRejectionKey != null && firstRejectionKey === agent.pendingRejectionKey) {
			agent.currentRejectionStreak++;
		} else {
			agent.pendingRejectionKey = firstRejectionKey;
			agent.currentRejectionStreak = firstRejectionKey != null ? 1 : 0;
		}

		agent.maxSameRejectionStreak = Math.max(agent.maxSameRejectionStreak, agent.currentRejectionStreak);

		const latency = text.match(/· (\d+)ms/);
		if (latency) {
			agent.decisionLatenciesMs.push(Number(latency[1]));
		}

		const cost = text.match(/\$([0-9.]+) ·/);
		if (cost) {
			agent.spendUsd += Number(cost[1]);
		}

		const usage = text.match(/Usage: (\d+) in \/ (\d+) out/);
		if (usage) {
			agent.promptTokens += Number(usage[1]);
			agent.completionTokens += Number(usage[2]);
		}

		if (accepted > 0 && agent.pendingAlertAt != null) {
			agent.reactionLatenciesMs.push(Date.parse(entry.t) - agent.pendingAlertAt);
			agent.pendingAlertAt = null;
		}

		// Milestone commit — acceptance is proven here, never at Decided.
		// A Result bubble rules on every submitted action in submission
		// order as '<n>. <type>: accepted[; detail]' or
		// '<n>. <type>: rejected — <cause>'. Pair each verdict with the held
		// Decided action by position AND action type: any misalignment (a
		// missing Decided, an unparsed list, a cause that fakes a verdict)
		// breaks the type match and forfeits the stamp rather than risking a
		// false one. Only an accepted action carrying item=<milestone>
		// counts; submitted-only or thought-text mentions never do. The
		// stamped tick is the one current when the action was submitted,
		// preserving the historical milestone-tick convention.
		const submitted = agent.pendingSubmittedActions;
		agent.pendingSubmittedActions = null;
		if (submitted != null) {
			[...text.matchAll(/\d+\.\s+(\w+): (accepted|rejected)/g)].forEach((verdict, position) => {
				const action = submitted.actions[position];
				if (verdict[2] === 'accepted' && action != null && action.type === verdict[1] &&
					action.item != null && MilestoneItems.includes(action.item) &&
					agent.firstAcceptedTickByType[action.item] == null) {
					agent.firstAcceptedTickByType[action.item] = submitted.tick;
				}
			});
		}
	}

	if (text.startsWith('Decided')) {
		// A Decided bubble only proves submission, so it must not stamp
		// milestones itself. Its numbered action list
		// ('1. <type> key=value ...') is appended after free-form thought
		// text; anchor on the LAST ' 1. <type>' occurrence so numbered prose
		// inside the thought can never be read as actions, then hold the
		// parsed list (with the submit-time tick) for the Result verdicts.
		agent.pendingSubmittedActions = null;
		const listStarts = [...text.matchAll(/(?:^|\s)1\.\s+[A-Za-z]\w*/g)];
		if (listStarts.length > 0) {
			const actions = [];
			const tail = text.slice(listStarts[listStarts.length - 1].index);
			for (const action of tail.matchAll(/(?:^|\s)\d+\.\s+([A-Za-z]\w*)((?:\s+[\w.-]+=\S+)*)/g)) {
				actions.push({ type: action[1], item: action[2].match(/\bitem=([\w.-]+)/)?.[1] ?? null });
			}

			agent.pendingSubmittedActions = { actions, tick: lastState?.tick ?? -1 };
		}

		// Knowing-doing: free-text "mission" / queueMission mentions in thought.
		// Knowing-doing: free-text mission talk vs typed queueMission commits.
		if (/\bqueueMission\b|\bmission\b/i.test(text))
			agent.missionMentions++;
	}
}

// Winner detection: the runner writes outcome.json beside log.jsonl with the
// first resolved winState a poll caught ({winner, how, tick, ...}; winner is
// null when the teardown beat the poll). Prefer it, then the enriched terminal
// entry; matches that predate the feature have neither and report null.
let outcome = null;
const outcomePath = path.join(targetDir, 'outcome.json');
if (existsSync(outcomePath)) {
	try {
		outcome = JSON.parse(readFileSync(outcomePath, 'utf8'));
	} catch {
		outcome = null;
	}
}

const winner = outcome?.winner ?? terminal?.winner?.agent ?? null;
const winnerHow = outcome?.how ?? terminal?.winner?.how ?? null;
const executorInstrumented = outcome?.assistance?.executor === true || booted?.executor === true;

// Generalship purity from outcome.json. The host runs the war compiler only after a
// model commitIntent (compiled strike/reinforce/disengage are pure-safe), so purity
// turns on whether the host issued any AUTONOMOUS combat (reactive rally / structure-
// defense backstop / proactive strike): each such counter must be 0 for a pure seat.
// Seat ids in host state are long agent-* guids and outcome.generalship[].agentId
// matches those, but log agent keys are usually agent1/agent2 — map by id, fall back to index.
const generalshipRows = Array.isArray(outcome?.generalship) ? outcome.generalship : [];
const generalshipByAgentId = new Map(generalshipRows
	.filter(row => row?.agentId)
	.map(row => [row.agentId, row]));
const matchHostCombatLastResort = outcome?.hostCombatLastResort === true;
const pureGeneralTrack = outcome != null && !matchHostCombatLastResort &&
	(booted?.executor === true || generalshipRows.length > 0);

const instrumentedMissionAgents = [...agents.values()].filter(agent => agent.missionInstrumentation);
const matchMissionTelemetryComplete = globalMissionTelemetryError ? false : instrumentedMissionAgents.length > 0
	? instrumentedMissionAgents.every(agent => agent.missionTelemetryComplete === true) : null;
const instrumentedContactTicks = instrumentedMissionAgents
	.filter(agent => agent.firstMissionContactTick != null)
	.map(agent => agent.firstMissionContactTick);

// Resolution note echoed so the leaderboard needn't re-derive it. New outcomes
// carry a machine censor bit; the status regex remains the compatibility path
// for older results and must stay aligned with leaderboard.mjs. Censored means
// infrastructure ate the outcome (excluded from skill stats per BENCHMARK.md);
// resolved means win states resolved and not censored; unfinished is everything
// else.
const terminalStatus = terminal?.status ?? '';
const outcomeInfrastructureCensored = outcome?.infrastructureCensored === true;
const resolveRate = outcomeInfrastructureCensored || /authentication|credential|sidecar returned/i.test(terminalStatus)
	? 'censored'
	: /win states resolved/i.test(terminalStatus) ? 'resolved' : 'unfinished';

const percentile = (values, p) => {
	if (values.length === 0) {
		return null;
	}

	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

const report = {
	schemaVersion: 1,
	// PR0 freeze: explicit metrics contract version (see DOCTRINE-ORCHESTRATION.md).
	metricsVersion: 1,
	label: path.basename(targetDir),
	generatedFrom: 'log.jsonl',
	resolveRate,
	// outcome.json passthrough: stamped only when the sidecar exists, so
	// matches that predate it keep their metrics byte-identical.
	...(outcome != null ? {
		winner,
		how: winnerHow,
		mirror: outcome.mirror ?? false,
		lessonsMode: outcome.lessonsMode ?? 'off',
		lessonsInjected: outcome.lessonsInjected ?? null,
		// Reproducibility stamps; null-tolerant so outcome.json files written
		// before the runner recorded them still produce metrics.
		eraLock: outcome.eraLock ?? null,
		providerEndpoint: outcome.providerEndpoint ?? null,
		modelIdentity: outcome.modelIdentity ?? null,
		seed: outcome.seed ?? null,
		hostCombatLastResort: matchHostCombatLastResort,
		pureGeneralTrack,
		generalship: generalshipRows
	} : {}),
	match: {
		model1: booted?.model1 ?? null,
		model2: booted?.model2 ?? null,
		...(outcome?.map != null || outcome?.benchmark?.requestedMapUid != null ||
			booted?.effectiveMapUid != null ? {
				requestedMapUid: outcome?.map?.requestedMapUid ??
					outcome?.benchmark?.requestedMapUid ?? booted?.requestedMapUid ?? null,
				effectiveMapUid: outcome?.map?.effectiveMapUid ?? booted?.effectiveMapUid ?? null,
				resolvedMapUid: outcome?.map?.resolvedMapUid ??
					outcome?.benchmark?.resolvedMapUid ?? null,
				resolvedMapTitle: outcome?.map?.resolvedMapTitle ??
					outcome?.benchmark?.resolvedMapTitle ?? null
			} : {}),
		playbook1: booted?.playbook1 ?? null,
		playbook2: booted?.playbook2 ?? null,
		capUsd: booted?.cap != null ? Number(booted.cap) : null,
		terminalState: terminal?.state ?? lastState?.state ?? null,
		terminalStatus: terminal?.status ?? null,
		winner,
		winnerHow,
		finalTick: lastState?.tick ?? null,
		gameMinutes: lastState?.tick != null ? +(lastState.tick / TicksPerSecond / 60).toFixed(1) : null,
		desync,
		totalSpendUsd: outcome?.spendFinal === false ? null
			: typeof outcome?.totalSpendUsd === 'number' && Number.isFinite(outcome.totalSpendUsd)
			? outcome.totalSpendUsd
			: terminal?.spend != null ? Number(String(terminal.spend).replace('$', '')) : null,
		...(typeof outcome?.infrastructureCensored === 'boolean' ? {
			infrastructureCensored: outcome.infrastructureCensored,
			terminalKind: outcome.terminalKind ?? null,
			censorReason: outcome.censorReason ?? null,
			spendFinal: outcome.spendFinal ?? null,
			totalDecisionOpportunities: outcome.totalDecisionOpportunities ?? null,
			zeroSpendZeroOpportunity: outcome.zeroSpendZeroOpportunity === true
		} : {}),
		missionTelemetryComplete: matchMissionTelemetryComplete,
		resolvedProfile: outcome?.resolvedProfile ?? booted?.resolvedProfile ?? null,
		assistance: outcome?.assistance ?? (booted == null ? null : {
			arsenal: booted.arsenal === true,
			executor: booted.executor === true,
			guided: booted.guided === true,
			fallbackStrike: booted.fallbackStrike === true,
			play: booted.play === true,
			staffSeat: booted.staffSeat === true
		}),
		// Earliest mission-confirmed contact across instrumented seats. Older
		// eras and logs with a detected cursor gap remain null.
		timeToFirstContactTicks: matchMissionTelemetryComplete === true && instrumentedContactTicks.length > 0
			? Math.min(...instrumentedContactTicks) : null
	},
	agents: [...agents.values()].map((agent, index) => {
		const generalship = generalshipByAgentId.get(agent.agent) ?? generalshipRows[index] ?? null;
		// Autonomous host-combat orders (reactive base defense + proactive strikes) the host
		// issued on its own initiative. Any non-zero total means the host fought for the model,
		// so the scorecard can never read pure-green while it did — independent of the stamp.
		const autonomousHostCombat = generalship == null ? 0 :
			(generalship.hostEmergencyRallyOrders ?? 0) + (generalship.hostStructureDefenseOrders ?? 0) +
			(generalship.hostProactiveEngageOrders ?? 0);
		return ({
		agent: agent.agent,
		decisions: agent.decisions,
		// Every observed decision resolves as exactly one of: a per-action Result
		// batch, a rejected batch, a model failure, or an in-flight/no-op turn.
		// validDecisionRate is the share that reached a host verdict batch — the
		// honest denominator that stops rejected/failed turns hiding off-scorecard.
		resultBatches: agent.resultBatches,
		rejectedBatches: agent.rejectedBatches,
		modelFailures: agent.modelFailures,
		validDecisionRate: agent.resultBatches + agent.rejectedBatches + agent.modelFailures > 0
			? +(agent.resultBatches /
				(agent.resultBatches + agent.rejectedBatches + agent.modelFailures) * 100).toFixed(2)
			: null,
		actions: agent.actionsAccepted + agent.actionsRejected,
		acceptanceRate: agent.actionsAccepted + agent.actionsRejected > 0
			? +(agent.actionsAccepted / (agent.actionsAccepted + agent.actionsRejected) * 100).toFixed(2)
			: null,
		noOps: agent.noOps,
		noOpRate: agent.decisions > 0 ? +(agent.noOps / agent.decisions * 100).toFixed(2) : null,
		noopByCause: agent.noopByCause,
		// groupMissing isolations (subset of rejections): use-before-assignGroup.
		groupMissingRejections: agent.noopByCause.groupMissing ?? 0,
		missionMentions: agent.missionMentions,
		missionActionsAccepted: agent.missionActionsAccepted,
		rejectionRecoveryOpportunities: agent.rejectionRecoveryOpportunities,
		rejectionRecoveries: agent.rejectionRecoveries,
		rejectionRecoveryRate: agent.rejectionRecoveryOpportunities > 0
			? +(agent.rejectionRecoveries / agent.rejectionRecoveryOpportunities * 100).toFixed(2) : null,
		emptyActionTurns: agent.emptyActionTurns,
		criticalAssetLostCount: agent.criticalAssetLostCount,
		productionIdleAffordableWakeCount: agent.productionIdleAffordableWakeCount,
		doctrineActionRate: agent.doctrineInstrumentation || executorInstrumented
			? +(agent.doctrineActions / Math.max(1, agent.decisions) * 100).toFixed(2) : null,
		hostStrikeRate: executorInstrumented
			? +(agent.doctrineFallbackStrikeCount /
				Math.max(1, agent.modelDirectStrikeCount + agent.modelSelectedCommitCount +
					agent.doctrineFallbackStrikeCount) * 100).toFixed(2) : null,
		guidanceSelectionRate: agent.doctrineDecisionIds.size > 0
			? +(agent.guidanceSelections / agent.doctrineDecisionIds.size * 100).toFixed(2) : null,
		modelDirectStrikeCount: agent.modelDirectStrikeCount,
		modelSelectedCommitCount: agent.modelSelectedCommitCount,
		doctrineFallbackStrikeCount: agent.doctrineFallbackStrikeCount,
		overrideRate: null,
		needsDecisionResponseRate: null,
		needsDecisionLatencyMsP50: null,
		alerts: agent.alerts,
		reflexOrders: agent.reflexOrders,
		reactionLatencyMsP50: percentile(agent.reactionLatenciesMs, 0.5),
		decisionLatencyMsP50: percentile(agent.decisionLatenciesMs, 0.5),
		decisionLatencyMsP95: percentile(agent.decisionLatenciesMs, 0.95),
		spendUsd: +agent.spendUsd.toFixed(4),
		// Runner-audited seat spend (outcome.perSeatSpendUsd, keyed by the
		// stable seat ids agent1/agent2) — authoritative over bubble-parsed
		// spendUsd when present; older outcomes simply lack the key, and a
		// missing or non-numeric seat entry reports null, never 0.
		...(outcome?.perSeatSpendUsd != null ? {
			perSeatSpendUsd: typeof outcome.perSeatSpendUsd[agent.agent] === 'number' &&
				Number.isFinite(outcome.perSeatSpendUsd[agent.agent])
				? outcome.perSeatSpendUsd[agent.agent]
				: null
		} : {}),
		promptTokens: agent.promptTokens,
		completionTokens: agent.completionTokens,
		costPerDecisionUsd: agent.decisions > 0 ? +(agent.spendUsd / agent.decisions).toFixed(5) : null,
		firstAcceptedTickByType: agent.firstAcceptedTickByType,
		rejectionCauses: agent.rejectionCauses,
		// null when this agent's log carries no attempts arrays — absence of
		// instrumentation, not a measured zero.
		resilience: agent.attemptDecisions > 0 ? {
			decisionsWithAttempts: agent.attemptDecisions,
			totalAttempts: agent.attemptsTotal,
			failedAttempts: agent.attemptsFailed,
			attemptsByOutcome: agent.attemptsByOutcome,
			attemptsByFinishReason: agent.attemptsByFinishReason,
			repairedDecisions: agent.repairedDecisions,
			repairRatePct: +(agent.repairedDecisions / agent.attemptDecisions * 100).toFixed(2)
		} : null,
		// null when no entry in the whole log carries a fallback marker
		// (feature not enabled this era); real zeroes only once markers exist.
		fallbackRate: fallbackDetected ? {
			fallbackTurns: agent.fallbackTurns,
			decisionOpportunities: agent.decisions + agent.fallbackTurns,
			ratePct: agent.decisions + agent.fallbackTurns > 0
				? +(agent.fallbackTurns / (agent.decisions + agent.fallbackTurns) * 100).toFixed(2)
				: null
		} : null,
		// Churn is the fraction of authored commitments that were replaced or
		// aborted instead of running to completion. A real instrumented zero is
		// distinct from null, which means this era had no mission telemetry.
		missionTelemetryComplete: agent.missionInstrumentation ? agent.missionTelemetryComplete === true : null,
		missions: agent.missionInstrumentation && agent.missionTelemetryComplete === true ? {
			queued: agent.missionsQueued,
			completed: agent.missionsCompleted,
			aborted: agent.missionsAborted,
			replaced: agent.missionsReplaced,
			missionChurn: agent.missionsQueued > 0
				? +((agent.missionsAborted + agent.missionsReplaced) / agent.missionsQueued).toFixed(4)
				: 0,
			timeToFirstContactTicks: agent.firstMissionContactTick
		} : null,
		maxSameRejectionStreak: agent.maxSameRejectionStreak,
		// null = arsenal/telemetry not instrumented this match (raw track or
		// pre-era3 log); a real zero-switch run reports strategySwitches: 0.
		strategyTelemetryComplete: agent.strategyInstrumentation ? agent.strategyTelemetryComplete === true : null,
		strategy: agent.strategyInstrumentation && agent.strategyTelemetryComplete === true ? {
			strategyAdopted: agent.strategyAdopted,
			initialStrategyId: agent.initialStrategyId,
			initialAdoptTick: agent.initialAdoptTick,
			currentStrategyId: agent.currentStrategyId,
			strategySwitches: agent.strategySwitches
		} : null,
		// Pure generalship: purity holds only when the host issued NO autonomous combat for
		// this seat (reactive rally / structure-defense backstop / proactive strike). The
		// compiled strike/reinforce/disengage counters fire only AFTER a model commitIntent —
		// pure-safe staff work — so they never gate purity. The scorecard AND-guards the
		// producer's stamp with the counters, so a mis-stamped outcome can never read as pure
		// while an autonomous host-combat counter fired.
		generalship: generalship == null ? null : {
			hostEmergencyRallyOrders: generalship.hostEmergencyRallyOrders ?? 0,
			hostStructureDefenseOrders: generalship.hostStructureDefenseOrders ?? 0,
			hostProactiveEngageOrders: generalship.hostProactiveEngageOrders ?? 0,
			autonomousHostCombat,
			hostCompiledStrikeCount: generalship.hostCompiledStrikeCount ?? 0,
			hostCompiledReinforceCount: generalship.hostCompiledReinforceCount ?? 0,
			hostCompiledDisengageCount: generalship.hostCompiledDisengageCount ?? 0,
			modelCommitIntentCount: generalship.modelCommitIntentCount ?? 0,
			timeToFirstCommitIntentTicks: generalship.timeToFirstCommitIntentTicks ?? -1,
			dribbleAttackMoveCount: generalship.dribbleAttackMoveCount ?? 0,
			pureGeneralValid: generalship.pureGeneralValid === true && autonomousHostCombat === 0
		}
		});
	})
};

const minutesOf = tick => tick != null && tick >= 0 ? `${(tick / TicksPerSecond / 60).toFixed(1)}m` : '—';
const scorecard = [
	`# Scorecard — ${report.label}`,
	'',
	`${report.match.model1 ?? 'agent1'} (${report.match.playbook1 || 'no playbook'}) vs ` +
	`${report.match.model2 ?? 'agent2'} (${report.match.playbook2 || 'no playbook'})`,
	`Outcome: ${report.match.terminalState ?? 'unknown'} — ${report.match.terminalStatus ?? ''}` +
		(report.match.winner != null ? ` · winner: ${report.match.winner} (${report.match.winnerHow ?? 'unrecorded'})` : ''),
	`Game time: ${report.match.gameMinutes ?? '?'} min · total spend $${report.match.totalSpendUsd ?? '?'} · desync: ${report.match.desync}`,
	...(outcome != null ? [
		`Winner: ${report.winner ?? 'undetected'}${report.how != null ? ` (${report.how})` : ''}`,
		`Mirror: ${report.mirror} · lessons: ${report.lessonsMode}` +
			(report.lessonsInjected != null ? ` (${report.lessonsInjected} injected)` : ''),
		`Generalship track: ${report.hostCombatLastResort ? 'assisted (host combat last-resort ON)' :
			report.pureGeneralTrack ? 'pure (host war compiler only after model commitIntent)' : 'not stamped'}`
	] : []),
	'',
	'| metric | ' + report.agents.map(agent => agent.agent).join(' | ') + ' |',
	'|---|' + report.agents.map(() => '---').join('|') + '|',
	...[
		['decisions', agent => agent.decisions],
		['actions (acc %)', agent => `${agent.actions} (${agent.acceptanceRate ?? '—'}%)`],
		['no-op rate', agent => `${agent.noOpRate ?? '—'}%`],
		['result/rejected/failed', agent => `${agent.resultBatches}/${agent.rejectedBatches}/${agent.modelFailures}`],
		['valid decision rate', agent => `${agent.validDecisionRate ?? '—'}%`],
		['alerts seen', agent => agent.alerts],
		['reflex orders', agent => agent.reflexOrders],
		['mission telemetry', agent => agent.missionTelemetryComplete == null ? 'not instrumented' :
			agent.missionTelemetryComplete ? 'complete' : 'incomplete'],
		['missions q/c/a/r', agent => agent.missions == null ? '—' :
			`${agent.missions.queued}/${agent.missions.completed}/${agent.missions.aborted}/${agent.missions.replaced}`],
		['mission churn', agent => agent.missions == null ? '—' : agent.missions.missionChurn],
		['first mission contact', agent => agent.missions == null ? '—' : minutesOf(agent.missions.timeToFirstContactTicks)],
		['strategy', agent => agent.strategyTelemetryComplete == null ? 'not instrumented' :
			agent.strategy == null ? 'telemetry incomplete' :
			agent.strategy.strategyAdopted
				? `${agent.strategy.currentStrategyId} (switches: ${agent.strategy.strategySwitches})`
				: 'none adopted'],
		['pure general valid', agent => agent.generalship == null ? '—' : agent.generalship.pureGeneralValid],
		['model commitIntent', agent => agent.generalship == null ? '—' : agent.generalship.modelCommitIntentCount],
		['time to first commitIntent', agent => agent.generalship == null ? '—' :
			minutesOf(agent.generalship.timeToFirstCommitIntentTicks >= 0
				? agent.generalship.timeToFirstCommitIntentTicks : null)],
		['host compiled strike/reinforce', agent => agent.generalship == null ? '—' :
			`${agent.generalship.hostCompiledStrikeCount ?? 0}/${agent.generalship.hostCompiledReinforceCount ?? 0}`],
		['dribble attackMove rejects', agent => agent.generalship == null ? '—' :
			agent.generalship.dribbleAttackMoveCount ?? 0],
		['host autonomous combat (rally/structDef/proactive)', agent => agent.generalship == null ? '—' :
			`${agent.generalship.hostEmergencyRallyOrders}/${agent.generalship.hostStructureDefenseOrders}/` +
			`${agent.generalship.hostProactiveEngageOrders}`],
		['max same-rejection streak', agent => agent.maxSameRejectionStreak],
		['reaction p50', agent => agent.reactionLatencyMsP50 != null ? `${agent.reactionLatencyMsP50}ms` : '—'],
		['decision p50/p95', agent => `${agent.decisionLatencyMsP50 ?? '—'}/${agent.decisionLatencyMsP95 ?? '—'}ms`],
		['spend ($/decision)', agent => `$${agent.spendUsd} ($${agent.costPerDecisionUsd ?? '—'})`],
		['first weap/3tnk', agent =>
			`${minutesOf(agent.firstAcceptedTickByType.weap)}/${minutesOf(agent.firstAcceptedTickByType['3tnk'])}`]
	].map(([name, cell]) => `| ${name} | ${report.agents.map(cell).join(' | ')} |`),
	'',
	'Top rejection causes:',
	...report.agents.map(agent => `- ${agent.agent}: ` +
		(Object.entries(agent.rejectionCauses).sort((a, b) => b[1] - a[1]).slice(0, 3)
			.map(([cause, count]) => `${cause} (${count})`).join('; ') || 'none')),
	...(report.agents.some(agent => agent.resilience != null) ? [
		'',
		'Resilience (attempt diagnostics):',
		...report.agents.map(agent => `- ${agent.agent}: ` + (agent.resilience != null
			? `${agent.resilience.totalAttempts} attempts / ${agent.resilience.decisionsWithAttempts} decisions · ` +
				`${agent.resilience.failedAttempts} failed · repair rate ${agent.resilience.repairRatePct}% · ` +
				Object.entries(agent.resilience.attemptsByOutcome).map(([key, count]) => `${key}=${count}`).join(' ')
			: 'no attempt data'))
	] : []),
	'',
	...(fallbackDetected
		? ['Fallback:', ...report.agents.map(agent =>
			`- ${agent.agent}: ${agent.fallbackRate.fallbackTurns}/${agent.fallbackRate.decisionOpportunities} turns` +
				` (${agent.fallbackRate.ratePct ?? '—'}%)`)]
		: ['fallback: not enabled this era'])
].join('\n');

writeFileSync(path.join(targetDir, 'metrics.json'), JSON.stringify(report, null, 1));
writeFileSync(path.join(targetDir, 'scorecard.md'), scorecard);
console.log(`metrics written: ${path.join(targetDir, 'metrics.json')}`);
if (process.argv.includes('--print')) {
	console.log('\n' + scorecard);
}
