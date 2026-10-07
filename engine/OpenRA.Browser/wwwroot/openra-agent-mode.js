// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

const MaxFeedEntries = 80;
const MaxBubbleChars = 2400;
const SpectatorToastLimit = 3;
const SpectatorToastMs = 5000;
// R1 cadence profile. The play/RTS-Agent preset lowers the effective decision interval toward
// PlayCadenceIntervalTicks (~4s at 25 ticks/s) and relaxes the adaptive slow-model punish from the
// benchmark ceiling to PlayCadenceAdaptiveCeilingTicks. The raw pure-benchmark track keeps
// tempo-as-score: BenchmarkAdaptiveCeilingTicks and the operator interval, never contaminated.
const PlayCadenceIntervalTicks = 100;
const PlayCadenceAdaptiveCeilingTicks = 200;
const BenchmarkAdaptiveCeilingTicks = 500;
const BenchmarkLockstepSpecVersion = 'benchmark-lockstep-v1';
const BaseBuildingPrompt = 'Deploy your MCV to found your base, then build power, a refinery, and production structures, and produce units to scout and fight.';
const DefaultPrompts = [
	`You are the Red commander. Build a stable economy, scout cautiously, produce a balanced army, and defeat the opposing agent. ${BaseBuildingPrompt}`,
	`You are the Blue commander. Expand your economy, defend important assets, exploit visible weaknesses, and defeat the opposing agent. ${BaseBuildingPrompt}`
];

let program;
let root;
let worker;
let active;
let workerReady = false;
let pollInProgress = false;
let lastPollAt = 0;
let thinkingTimer;
let spectator = false;
const spectatorStats = [];

function element(id) {
	return document.getElementById(id);
}

function numberValue(id) {
	// Comma-decimal locales make Number(input.value) NaN ("2,00"); prefer the
	// browser-parsed valueAsNumber and fall back to a comma-tolerant parse.
	const input = element(id);
	if (Number.isFinite(input.valueAsNumber)) {
		return input.valueAsNumber;
	}

	return Number(String(input.value).replace(',', '.'));
}

function bounded(value, max = MaxBubbleChars) {
	const text = String(value ?? '');
	if (text.length <= max) {
		return text;
	}

	const suffix = '… [truncated]';
	return max <= suffix.length ? text.slice(0, max) : `${text.slice(0, max - suffix.length)}${suffix}`;
}

function normalizeSidecarUrl(value) {
	const url = new URL(value, location.origin);
	const loopback = url.protocol === 'http:' &&
		(url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
	if (url.protocol !== 'https:' && url.origin !== location.origin && !loopback) {
		throw new Error('The agent sidecar must use HTTPS, the game origin, or loopback HTTP for local development.');
	}

	return url.href.replace(/\/$/, '');
}

function parseHostJson(value, operation) {
	let parsed;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${operation} returned malformed JSON.`);
	}

	if (parsed?.error) {
		throw new Error(bounded(parsed.error, 500));
	}

	return parsed;
}

function appendBubble(index, kind, title, text) {
	const feed = element(`agent-feed-${index + 1}`);
	const bubble = document.createElement('article');
	bubble.className = `agent-bubble agent-bubble-${kind}`;

	const heading = document.createElement('strong');
	heading.textContent = bounded(title, 160);
	bubble.appendChild(heading);

	const body = document.createElement('div');
	body.className = 'agent-bubble-body';
	body.textContent = bounded(text);
	bubble.appendChild(body);
	feed.appendChild(bubble);
	while (feed.childElementCount > MaxFeedEntries) {
		feed.firstElementChild.remove();
	}

	feed.scrollTop = feed.scrollHeight;
	if (spectator && (kind === 'alert' || kind === 'reflex' || kind === 'mission' || kind === 'strategy')) {
		spawnSpectatorToast(index, kind, title, text);
	}

	return body;
}

function setStatus(message, isError = false) {
	const status = element('agent-match-status');
	status.textContent = bounded(message, 500);
	status.classList.toggle('agent-error', isError);
}

function setSpend(value) {
	element('agent-live-spend').textContent = `$${Number(value ?? 0).toFixed(4)}`;
}

function syncSpendCapDefaults() {
	const matchCap = numberValue('agent-spend-cap');
	if (!Number.isFinite(matchCap) || matchCap <= 0) {
		return;
	}

	const defaultSeatCap = matchCap / 2;
	for (let index = 1; index <= 2; index++) {
		const input = element(`agent-spend-cap-${index}`);
		if (input.dataset.customized !== 'true') {
			input.value = defaultSeatCap.toFixed(2);
		}
	}
}

function recordSeatSpend(message) {
	const index = agentIndex(message.agentId);
	const spent = Number(message.agentSpentUsd);
	const cap = Number(message.agentSpendCapUsd);
	if (index < 0 || !Number.isFinite(spent) || spent < 0 || !Number.isFinite(cap) || cap <= 0) {
		return;
	}

	const agent = active.agents[index];
	agent.spentUsd = spent;
	agent.spendCapUsd = cap;
	setSpend(message.spentUsd);
	const result = program.RecordAgentSpend(agent.id, spent, cap);
	if (result !== 'recorded') {
		console.warn('[agent-mode] host rejected per-seat spend update');
	}
}

// Agent-vs-agent spectator layout: when body.spectator is set (Host.AgentMode=1,
// applied by index.html before the game boots), the operator console becomes a
// centered pre-match panel, the thought feeds move into side bars beside the
// game, and ALERT/REFLEX bubbles mirror into transient toasts over the play
// area. Every function below no-ops in the classic overlay layout.

function buildSpectatorSideBar(index) {
	const bar = document.createElement('aside');
	bar.id = `spectator-bar-${index + 1}`;
	bar.className = 'spectator-bar';

	const card = document.createElement('div');
	card.id = `agent-card-${index + 1}`;
	card.className = 'agent-card';
	const title = document.createElement('strong');
	title.textContent = `Agent ${index + 1}`;
	card.appendChild(title);
	for (const field of ['model', 'doctrine', 'faction']) {
		const line = document.createElement('div');
		line.className = `agent-card-${field}`;
		line.textContent = `${field} —`;
		card.appendChild(line);
	}

	bar.appendChild(card);
	bar.appendChild(element(`agent-feed-${index + 1}`));

	const metrics = document.createElement('div');
	metrics.id = `agent-metrics-${index + 1}`;
	metrics.className = 'agent-metrics';
	bar.appendChild(metrics);
	document.body.appendChild(bar);

	const toasts = document.createElement('div');
	toasts.id = `spectator-toasts-${index + 1}`;
	toasts.className = 'spectator-toasts';
	document.body.appendChild(toasts);
	renderSpectatorMetrics(index);
}

function buildSpectatorTopbar() {
	const topbar = document.createElement('div');
	topbar.id = 'spectator-topbar';
	const status = document.createElement('span');
	status.id = 'spectator-topbar-status';
	const spend = document.createElement('span');
	spend.id = 'spectator-topbar-spend';
	topbar.appendChild(status);
	topbar.appendChild(spend);
	document.body.appendChild(topbar);

	// Mirror the console's status/spend text into the strip so both stay
	// visible while the setup panel is hidden mid-match.
	const mirror = () => {
		status.textContent = element('agent-match-status').textContent;
		spend.textContent = `spend ${element('agent-live-spend').textContent}`;
	};
	const observer = new MutationObserver(mirror);
	observer.observe(element('agent-match-status'), { childList: true, characterData: true, subtree: true });
	observer.observe(element('agent-live-spend'), { childList: true, characterData: true, subtree: true });
	mirror();
}

function buildSpectatorLayout() {
	buildSpectatorSideBar(0);
	buildSpectatorSideBar(1);
	buildSpectatorTopbar();
}

function updateSpectatorCard(index, model, doctrine, faction, playerColor, seatIdentity) {
	const card = element(`agent-card-${index + 1}`);
	if (!card) {
		return;
	}

	card.querySelector('.agent-card-model').textContent = `model ${bounded(model, 120)}`;
	card.querySelector('strong').textContent = bounded(seatIdentity ?? `Agent ${index + 1}`, 160);
	card.querySelector('.agent-card-doctrine').textContent =
		`doctrine ${bounded(String(doctrine ?? '').trim().split('\n')[0], 160)}`;
	card.querySelector('.agent-card-faction').textContent = `faction ${bounded(faction, 60) || 'default'}`;
	if (/^#[0-9a-f]{6}$/i.test(playerColor ?? '')) {
		card.parentElement?.style.setProperty('--agent-seat-color', playerColor);
	}
}

function renderSpectatorMetrics(index) {
	const strip = element(`agent-metrics-${index + 1}`);
	if (!strip) {
		return;
	}

	const stats = spectatorStats[index];
	if (!stats) {
		strip.textContent = 'decisions 0 · accepted —% · no-ops 0 · fallback 0/0 · avg — · spend $0.0000';
		return;
	}

	const accepted = stats.totalActions > 0
		? `${Math.round(100 * stats.acceptedActions / stats.totalActions)}%`
		: '—%';
	const latency = stats.latencySamples > 0
		? `${(stats.latencyTotalMs / stats.latencySamples / 1000).toFixed(1)}s`
		: '—';
	strip.textContent = `decisions ${stats.decisions} · accepted ${accepted} · no-ops ${stats.noops} · ` +
		`fallback ${stats.fallbackTurns}/${stats.decisionOpportunities} · avg ${latency} · spend $${stats.spendUsd.toFixed(4)}`;
}

function noteSpectatorDecision(index, sample) {
	const stats = spectatorStats[index];
	if (!spectator || !stats) {
		return;
	}

	stats.decisions++;
	stats.acceptedActions += sample.acceptedActions ?? 0;
	stats.totalActions += sample.totalActions ?? 0;
	if (sample.noop) {
		stats.noops++;
	}

	if (Number.isFinite(sample.latencyMs) && sample.latencyMs > 0) {
		stats.latencyTotalMs += sample.latencyMs;
		stats.latencySamples++;
	}

	stats.spendUsd += Number(sample.costUsd ?? 0);
	if (Number.isInteger(sample.fallbackTurns)) {
		stats.fallbackTurns = sample.fallbackTurns;
	}
	if (Number.isInteger(sample.decisionOpportunities)) {
		stats.decisionOpportunities = sample.decisionOpportunities;
	}
	renderSpectatorMetrics(index);
}

function spawnSpectatorToast(index, kind, title, text) {
	const stack = element(`spectator-toasts-${index + 1}`);
	if (!stack) {
		return;
	}

	const toast = document.createElement('div');
	toast.className = `spectator-toast spectator-toast-${kind}`;
	const heading = document.createElement('strong');
	heading.textContent = bounded(title, 120);
	toast.appendChild(heading);
	const body = document.createElement('div');
	body.textContent = bounded(text, 240);
	toast.appendChild(body);
	stack.appendChild(toast);
	while (stack.childElementCount > SpectatorToastLimit) {
		stack.firstElementChild.remove();
	}

	// remove() on a toast already evicted by the cap is a harmless no-op.
	setTimeout(() => toast.remove(), SpectatorToastMs);
}

function setSpectatorMatchRunning(running) {
	if (!spectator) {
		return;
	}

	// The centered setup panel yields to the match; the Agents overlay button
	// can still reopen it (e.g. to reach Stop) while the match runs.
	element('agent-mode').hidden = running;
	if (!running || !active) {
		return;
	}

	for (let index = 0; index < 2; index++) {
		element(`agent-feed-${index + 1}`).replaceChildren();
		spectatorStats[index] = undefined;
		renderSpectatorMetrics(index);
	}

	for (let index = 0; index < active.agents.length; index++) {
			spectatorStats[index] = {
				decisions: 0, acceptedActions: 0, totalActions: 0, noops: 0,
				fallbackTurns: 0, decisionOpportunities: 0,
				latencyTotalMs: 0, latencySamples: 0, spendUsd: 0
		};
		renderSpectatorMetrics(index);
		updateSpectatorCard(index, active.agents[index].model, active.agents[index].replayPrompt,
			element(`agent-faction-${index + 1}`).value.trim());
	}

	if (active.opponentBot) {
		updateSpectatorCard(1, `OpenRA ${active.opponentBot} AI`, 'Synchronized engine bot',
			element('agent-faction-2').value.trim());
		element('agent-metrics-2').textContent = 'engine bot · LLM decisions N/A · spend $0.0000';
		appendBubble(1, 'result', 'OpenRA Normal AI',
			'This seat is controlled by the shipped synchronized engine bot, not the Agent host.');
	}
}

function selectedOpponentBot() {
	return element('agent-opponent').value.trim();
}

function syncOpponentControls() {
	const disabled = selectedOpponentBot() !== '';
	for (const id of ['agent-key-2', 'agent-model-2', 'agent-effort-2', 'agent-prompt-2', 'agent-spend-cap-2']) {
		element(id).disabled = disabled;
	}
	syncSpendCapDefaults();
}

function agentIndex(agentId) {
	return active?.agents.findIndex(agent => agent.id === agentId) ?? -1;
}

function summarizeAlert(alert) {
	const cell = alert?.cell != null ? ` at ${alert.cell.x},${alert.cell.y}` : '';
	const threat = alert?.threat?.verdict ? ` · ${alert.threat.verdict} fight` : '';
	const attacker = alert?.visibleAttackerSummary ? ` · ${alert.visibleAttackerSummary}` : '';
	return `${alert?.severity ?? ''} ${alert?.kind ?? 'alert'}${cell}${attacker}${threat}`.trim();
}

// Reaction turns get a trimmed observation: the alerts, the authoritative
// ledger, production queues, and only the actors near the trouble (plus
// harvesters). The model is told this is a tactical turn; the next
// heartbeat carries the full picture again.
function buildFastObservation(observation) {
	const cells = (observation.alerts ?? []).map(alert => alert.cell).filter(cell => cell != null);
	const near = actor => cells.length === 0 ||
		cells.some(cell => Math.max(Math.abs(actor.cellX - cell.x), Math.abs(actor.cellY - cell.y)) <= 14);
	const actors = (observation.actors ?? []).filter(actor =>
		actor.relationship !== 'self' ? near(actor) : near(actor) || actor.type === 'harv');
	return {
		...observation,
		actors: actors.slice(0, 80),
		fastPath: true,
		fastPathNote: 'Tactical reaction turn: you were woken by the alerts above. Respond with tactical and ' +
			'policy actions for the affected area; the actor list is trimmed to the vicinity. A full ' +
			'strategic observation follows on your next heartbeat.'
	};
}

function buildCommitObservation(observation) {
	const pending = observation.hostTruth?.doctrine?.pendingDecision;
	const actorIds = new Set();
	const groupNames = new Set();
	for (const option of pending?.options ?? []) {
		for (const action of option.actions ?? []) {
			for (const actorId of action.actorIds ?? []) actorIds.add(actorId);
			if (action.groupName) groupNames.add(action.groupName);
			for (const leg of action.legs ?? []) if (leg.squad) groupNames.add(leg.squad);
		}
	}
	for (const group of observation.groups ?? []) {
		if (groupNames.has(group.name))
			for (const actorId of group.actorIds ?? []) actorIds.add(actorId);
	}
	const actors = (observation.actors ?? []).filter(actor =>
		actorIds.has(actor.actorId) || actor.relationship === 'enemy').slice(0, 64);
	return {
		...observation,
		actors,
		commitmentPath: true,
		commitmentNote: 'Narrow exact-choice turn. Select one pending option token or explicitly return no actions.'
	};
}

function executorMaterialSignature(observation) {
	const hostTruth = observation.hostTruth ?? {};
	const economy = hostTruth.economy ?? {};
	const warCommit = hostTruth.warCommit ?? null;
	const outcomeDelta = hostTruth.outcomeDelta ?? null;
	// Own live army: unit count (builds/losses) and summed health (damage/repair) so a
	// silently completed unit or a lost/hurt force is never read as "unchanged".
	const ownActors = (observation.actors ?? []).filter(actor => actor.relationship === 'self');
	return JSON.stringify({
		alerts: (observation.alerts ?? []).filter(alert => alert.stillActive !== false)
			.map(alert => [alert.kind, alert.affectedActorId, alert.cell?.x, alert.cell?.y]),
		visibleEnemies: (observation.actors ?? []).filter(actor => actor.relationship === 'enemy')
			.map(actor => [actor.actorId, actor.type, actor.cellX, actor.cellY]),
		knownEnemyStructureCount: hostTruth.knownEnemyStructureCount ?? 0,
		// Economy: a cash swing crosses affordability thresholds; harvester/power shifts
		// change what the build plan can do — all material to a strategic wake.
		cash: economy.cash ?? 0,
		harvesters: economy.harvesterCount ?? 0,
		powerState: economy.powerState ?? null,
		ownUnitCount: ownActors.length,
		ownHealth: ownActors.reduce((sum, actor) => sum + (actor.health ?? 0), 0),
		// Named group rosters: membership changes (assignGroup, culls, losses) matter.
		groups: (observation.groups ?? []).map(group => [group.name, group.liveCount]),
		buildPlan: hostTruth.buildPlan == null ? null : [hostTruth.buildPlan.planId, hostTruth.buildPlan.version,
			hostTruth.buildPlan.stepIndex, hostTruth.buildPlan.state, hostTruth.buildPlan.paused],
		doctrine: hostTruth.doctrine == null ? null : [hostTruth.doctrine.strategyId, hostTruth.doctrine.phase,
			hostTruth.doctrine.paused, hostTruth.doctrine.pendingDecision?.decisionId ?? 0],
		// War progress: commit lifecycle + fog-safe combat exchange since the last decision.
		war: warCommit == null ? null : [warCommit.intent, warCommit.status, warCommit.active, warCommit.mainLiveCount],
		outcomeDelta: outcomeDelta == null ? null : [outcomeDelta.enemyCombatLost, outcomeDelta.ownCombatLost,
			outcomeDelta.counterAttackWindow, outcomeDelta.pressAttack],
		missions: (hostTruth.missions ?? []).map(mission =>
			[mission.missionId, mission.missionVersion, mission.state, mission.paused]),
		// Production: real queue fields (producerId/queueType) plus per-item lifecycle
		// (what is building, whether it finished, whether it is placeable) — never the
		// per-tick countdown, which would churn the signature every heartbeat.
		queues: (observation.productionQueues ?? []).map(queue =>
			[queue.producerId, queue.queueType, (queue.items ?? []).map(item =>
				[item.item, item.done, item.placeable])]),
		situations: (observation.situations ?? []).map(situation => [situation.id, situation.severity])
	});
}

function summarizeActions(actions) {
	if (!Array.isArray(actions) || actions.length === 0) {
		return 'No actions (no-op turn).';
	}

	return actions.map((action, index) => {
		const subjects = Array.isArray(action.actorIds) ? ` actors=${action.actorIds.join(',')}` : '';
		const target = action.targetActorId ? ` target=${action.targetActorId}` : '';
		const producer = action.producerId ? ` producer=${action.producerId}` : '';
		const item = action.item ? ` item=${action.item}` : '';
		const group = action.groupName ? ` group=${bounded(action.groupName, 24)}` :
			action.name ? ` group=${bounded(action.name, 24)}` : '';
		const mission = action.missionId
			? ` mission=${bounded(action.missionId, 32)}/${bounded(action.missionType ?? action.missionCommand ?? 'control', 32)}` +
				`@${Number.isInteger(action.missionVersion) ? action.missionVersion : '?'}`
			: '';
		const destination = action.destinationSquad ? ` destination=${bounded(action.destinationSquad, 24)}` : '';
		const legs = Array.isArray(action.legs) && action.legs.length > 0
			? ` legs=${action.legs.map(leg =>
				`${bounded(leg.squad, 24)}@${Number.isInteger(leg.viaX) ? leg.viaX : '?'},` +
				`${Number.isInteger(leg.viaY) ? leg.viaY : '?'}`).join(';')}`
			: '';
		const cell = Number.isInteger(action.cellX) && Number.isInteger(action.cellY)
			? ` cell=${action.cellX},${action.cellY}`
			: '';
		const strategy = action.type === 'adoptStrategy' && action.strategyId
			? ` strategy=${bounded(action.strategyId, 64)}`
			: '';
		const reason = action.type === 'adoptStrategy' && action.reason
			? ` reason=${bounded(action.reason, 240)}`
			: '';
		return `${index + 1}. ${action.type}${subjects}${target}${producer}${item}${group}${mission}` +
			`${destination}${legs}${cell}${strategy}${reason}`;
	}).join('\n');
}

function strategyTitle(strategyId) {
	return String(strategyId ?? 'unknown strategy').split('-').filter(Boolean).map(word =>
		/^[a-z]\d+$/i.test(word) ? word.toUpperCase() : `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

function humanizeStrategyId(id) {
	return String(id ?? '').split('-')
		.map(word => word.length === 0 ? word : word[0].toUpperCase() + word.slice(1))
		.join(' ');
}

// Persistent per-seat strategy chip: which card the model committed to, when,
// how often it switched, and its latest stated reason — always visible above
// the feed instead of scrolling away as one bubble.
function updateStrategyPanel(index, event) {
	const feed = element(`agent-feed-${index + 1}`);
	if (feed == null || feed.parentElement == null) {
		return;
	}

	let panel = document.getElementById(`agent-strategy-panel-${index + 1}`);
	if (panel == null) {
		panel = document.createElement('div');
		panel.id = `agent-strategy-panel-${index + 1}`;
		panel.style.cssText = 'padding:.4rem .5rem;margin-bottom:.3rem;border:1px solid #3b4a5a;' +
			'background:#101821;font-size:.85em;line-height:1.35;';
		feed.parentElement.insertBefore(panel, feed);
	}

	const title = humanizeStrategyId(event.strategyId);
	const minute = event.worldTick >= 0 ? (event.worldTick / 25 / 60).toFixed(1) : '?';
	const switches = Math.max(0, (event.sequence ?? 1) - 1);
	const previous = event.previousStrategyId != null
		? ` (from ${humanizeStrategyId(event.previousStrategyId)})`
		: '';
	panel.replaceChildren();
	const head = document.createElement('div');
	head.style.cssText = 'font-weight:600;color:#e3b341;';
	head.textContent = `STRATEGY: ${title}${previous} · adopted ${minute}m · switches ${switches}`;
	const reason = document.createElement('div');
	reason.style.cssText = 'color:#8b949e;';
	reason.textContent = event.modelReason ? `“${event.modelReason}”` : '';
	panel.append(head, reason);
}

function summarizeStrategyEvent(event) {
	const title = strategyTitle(event?.strategyId);
	const previous = event?.previousStrategyId
		? ` (switched from ${strategyTitle(event.previousStrategyId)})`
		: '';
	const modelReason = bounded(event?.modelReason ?? 'No model reason supplied.', 240);
	return {
		title: `NEW STRATEGY — ${title}${previous}`,
		text: `model reason: ${modelReason}`,
		telemetry: JSON.stringify({
			sequence: event?.sequence ?? null,
			worldTick: event?.worldTick ?? null,
			kind: event?.kind ?? null,
			strategyId: event?.strategyId ?? null,
			cardVersion: event?.cardVersion ?? null,
			previousStrategyId: event?.previousStrategyId ?? null,
			catalogVersion: event?.catalogVersion ?? null,
			modelReason: event?.modelReason ?? null
		})
	};
}

function summarizeMissionEvent(event) {
	const missionId = bounded(event?.missionId ?? 'unknown', 32);
	const missionType = bounded(event?.missionType ?? 'unknown', 32);
	const state = bounded(event?.state ?? event?.kind ?? 'updated', 32);
	const kind = event?.kind && event.kind !== event.state ? ` · ${bounded(event.kind, 32)}` : '';
	const cell = event?.cell != null ? ` · cell ${event.cell.x},${event.cell.y}` : '';
	const reason = bounded(event?.reason ?? 'No reason supplied.', 400);
	return {
		title: `MISSION — ${missionId}`,
		text: `${missionType} · ${state}${kind}${cell}\n${reason}`,
		telemetry: `${missionId}/${missionType}: ${state}${kind}${cell}; ${reason}`
	};
}

function summarizeResults(result) {
	if (!Array.isArray(result.results) || result.results.length === 0) {
		return 'No actions submitted; simulation continued.';
	}

	return result.results.map(item => {
		const outcome = item.accepted
			? item.reason && item.reason !== 'accepted' ? item.reason : 'accepted'
			: `rejected — ${item.reason}`;
		const legal = !item.accepted && Array.isArray(item.nextLegalActions) && item.nextLegalActions.length > 0
			? ` Next legal options: ${item.nextLegalActions.map(option =>
				`decisionId=${option.decisionId} optionId=${option.optionId} ${option.label}; exactActions=` +
				JSON.stringify(option.actions ?? [])).join(' | ')}` : '';
		return `${item.index + 1}. ${item.type}: ${outcome}${legal}`;
	}).join('\n');
}

function fallbackKind(message) {
	const text = String(message ?? '').toLowerCase();
	if (text.includes('timed out') || text.includes('timeout')) {
		return 'timeout';
	}
	if (text.includes('schema') || text.includes('actionbatch') || text.includes('did not match')) {
		return 'schema';
	}
	if (text.includes('circuit')) {
		return 'circuit';
	}
	return 'upstream';
}

function submitAdvisorFallback(index, agent, decisionId, reason) {
	if (!active?.advisorFallbackEnabled || agent.pendingObservation == null) {
		return null;
	}

	const result = parseHostJson(program.SubmitAgentFallback(agent.id, JSON.stringify({
		schemaVersion: 1,
		decisionId,
		observedSequence: agent.pendingObservation.sequence,
		observedWorldTick: agent.pendingObservation.worldTick,
		kind: fallbackKind(reason),
		reason: String(reason ?? '').slice(0, 500)
	})), 'SubmitAgentFallback');
	const summary = summarizeResults(result);
	appendBubble(index, 'fallback', `FALLBACK — decision ${decisionId}`,
		`fallback:true · deterministic advisor v1\nCause: ${bounded(reason, 500)}\n${summary}`);
	worker?.postMessage({ type: 'decision-result', agentId: agent.id, summary: `Fallback: ${summary}` });
	const results = Array.isArray(result.results) ? result.results : [];
	noteSpectatorDecision(index, {
		acceptedActions: results.filter(item => item.accepted).length,
		totalActions: results.length,
		noop: !results.some(item => item.accepted),
		fallbackTurns: Number(result.fallbackTurns ?? 0),
		decisionOpportunities: Number(result.decisionOpportunities ?? 0)
	});
	return result;
}

function recordTelemetry(fields) {
	if (!active) {
		return;
	}

	const result = program.RecordAgentTelemetry(JSON.stringify({
		schemaVersion: 1,
		matchId: active.matchId,
		kind: fields.kind,
		agentId: fields.agentId ?? null,
		decisionId: fields.decisionId ?? -1,
		worldTick: fields.worldTick ?? active.worldTick ?? -1,
		model: fields.model ?? null,
		role: fields.role ?? null,
		prompt: fields.prompt ?? null,
		thoughts: fields.thoughts ?? null,
		summary: bounded(fields.summary ?? '', 4000),
		promptTokens: fields.promptTokens ?? 0,
		completionTokens: fields.completionTokens ?? 0,
		costUsd: fields.costUsd ?? 0,
		omniscientObservations: active.omniscient,
		resolvedProfile: active.resolvedProfile,
		strategyArsenalEnabled: active.strategyArsenalEnabled,
		actionGuidanceEnabled: active.actionGuidanceEnabled,
		doctrineExecutorEnabled: active.doctrineExecutorEnabled,
		doctrineFallbackStrikeEnabled: active.doctrineFallbackStrikeEnabled,
		advisorFallbackEnabled: active.advisorFallbackEnabled,
		staffSeatEnabled: active.staffSeatEnabled,
		seatIdentity: fields.agentId == null ? null :
			`agent${active.agents.findIndex(agent => agent.id === fields.agentId) + 1}:${fields.agentId}`,
		playerColor: active.agents.find(agent => agent.id === fields.agentId)?.playerColor ?? null
	}));
	if (result !== 'recorded') {
		console.warn('[agent-mode] replay telemetry entry was rejected');
	}
}

function setHostRequestState(agent, decisionId, inFlight) {
	if (typeof program.SetAgentDecisionRequestState !== 'function') {
		return;
	}
	const result = program.SetAgentDecisionRequestState(agent.id, decisionId, inFlight);
	if (result !== 'recorded') {
		throw new Error('Agent host rejected the seat request-state transition.');
	}
}

function recordTerminalDecisionFailure(agent, decisionId, reason) {
	if (typeof program.RecordAgentDecisionFailure !== 'function') {
		return;
	}
	const result = program.RecordAgentDecisionFailure(agent.id, JSON.stringify({
		schemaVersion: 1,
		requestDecisionId: decisionId,
		kind: fallbackKind(reason),
		reason: String(reason ?? '').slice(0, 500),
		terminal: true
	}));
	if (result !== 'recorded') {
		throw new Error('Agent host rejected terminal decision-failure telemetry.');
	}
}

// Pre-match planning (Host.PrematchPlanning / the agent-prematch-planning
// checkbox): both seats concurrently commit an opening memo, at most one
// build plan, and at most one complete policy against a symmetric pre-world
// observation (decision 0, sequence 1, tick 0). The world does not exist and
// never ticks during this phase. Each seat fails open — a timeout, rejection,
// or provider failure launches that seat without a staged plan — while
// credential rejection and exhausted provider credit remain terminal for the
// whole match. Responses arriving after the window closes are discarded,
// never staged.
function planningConfig() {
	const hostArgs = new URLSearchParams(location.search);
	const override = hostArgs.get('Host.PrematchPlanning');
	const enabled = override === '1' ? true
		: override === '0' ? false
			: element('agent-prematch-planning')?.checked ?? false;
	const requested = Number(hostArgs.get('Host.PlanningTimeoutMs'));
	const timeoutMs = Math.min(120000, Math.max(10000,
		Number.isFinite(requested) && requested > 0 ? requested : 30000));
	return { enabled, timeoutMs };
}

function benchmarkLockstepConfig() {
	const hostArgs = new URLSearchParams(location.search);
	const enabled = hostArgs.get('Host.BenchmarkLockstep') === '1';
	const requestedTimeout = Number(hostArgs.get('Host.BenchmarkDecisionTimeoutMs'));
	const timeoutMs = Math.min(120000, Math.max(10000,
		Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 120000));
	const requestedTickHorizon = Number(hostArgs.get('Host.BenchmarkTickHorizon'));
	const requestedDecisionHorizon = Number(hostArgs.get('Host.BenchmarkDecisionHorizon'));
	const tickHorizon = Number.isSafeInteger(requestedTickHorizon) && requestedTickHorizon >= 0
		? requestedTickHorizon : 0;
	const decisionHorizon = Number.isSafeInteger(requestedDecisionHorizon) && requestedDecisionHorizon >= 0
		? requestedDecisionHorizon : 0;
	let controlRegions = [];
	const encodedControlRegions = hostArgs.get('Host.BenchmarkControlRegions');
	if (encodedControlRegions != null && encodedControlRegions.trim() !== '') {
		controlRegions = JSON.parse(encodedControlRegions);
		if (!Array.isArray(controlRegions)) {
			throw new Error('Host.BenchmarkControlRegions must be a JSON array.');
		}
	}

	return {
		enabled,
		specVersion: BenchmarkLockstepSpecVersion,
		timeoutMs,
		tickHorizon,
		decisionHorizon,
		controlRegions
	};
}

// UI setup preset (the agent-preset select). The default RTS-Agent preset turns
// the full play stack on — strategy arsenal + doctrine executor + exact action
// guidance — so casual play runs the war compiler instead of raw model-only
// turns. Raw is the explicit benchmark option: every compiled assist stays off,
// byte-identical to the pre-arsenal harness. A URL override always wins over the
// panel (below), so the benchmark runner drives its own flags regardless of the
// preset; it also pins the select to raw so the default stack never contaminates
// a raw benchmark match.
function presetConfig() {
	return element('agent-preset')?.value === 'raw' ? 'raw' : 'rts-agent';
}

function strategyArsenalConfig() {
	const hostArgs = new URLSearchParams(location.search);
	const benchmarkTrack = (hostArgs.get('Host.BenchmarkTrack') ?? hostArgs.get('Host.Track') ?? '').toLowerCase();
	// Raw benchmark turns are intentionally byte-identical to the pre-arsenal
	// harness. A URL override or the human panel must never contaminate that track.
	if (benchmarkTrack === 'raw') {
		return { enabled: false, benchmarkTrack };
	}

	const override = hostArgs.get('Host.StrategyArsenal');
	const enabled = override === '1' ? true
		: override === '0' ? false
			: presetConfig() === 'rts-agent';
	return { enabled, benchmarkTrack };
}

function doctrineExecutorConfig() {
	const hostArgs = new URLSearchParams(location.search);
	const benchmarkTrack = (hostArgs.get('Host.BenchmarkTrack') ?? hostArgs.get('Host.Track') ?? '').toLowerCase();
	// The raw benchmark track stays byte-identical to the pre-arsenal harness, so
	// the deterministic doctrine autopilot must never engage there.
	if (benchmarkTrack === 'raw') {
		return { enabled: false };
	}

	const override = hostArgs.get('Host.DoctrineExecutor');
	const enabled = override === '1' ? true
		: override === '0' ? false
			: presetConfig() === 'rts-agent';
	return { enabled };
}

function actionGuidanceConfig() {
	const hostArgs = new URLSearchParams(location.search);
	const benchmarkTrack = (hostArgs.get('Host.BenchmarkTrack') ?? hostArgs.get('Host.Track') ?? '').toLowerCase();
	if (benchmarkTrack === 'raw') {
		return { enabled: false };
	}

	const override = hostArgs.get('Host.ActionGuidance');
	const enabled = override === '1' ? true
		: override === '0' ? false
			: presetConfig() === 'rts-agent';
	return { enabled };
}

function doctrineFallbackStrikeConfig() {
	const hostArgs = new URLSearchParams(location.search);
	return { enabled: hostArgs.get('Host.DoctrineFallbackStrike') === '1' };
}

function staffSeatConfig() {
	const hostArgs = new URLSearchParams(location.search);
	const enabled = hostArgs.get('Host.StaffSeat') === '1';
	return {
		enabled,
		reactionModels: [hostArgs.get('Host.ReactionModel1') ?? '', hostArgs.get('Host.ReactionModel2') ?? ''],
		reactionEfforts: [hostArgs.get('Host.ReactionEffort1') ?? '', hostArgs.get('Host.ReactionEffort2') ?? '']
	};
}

// Play/RTS-Agent cadence profile (Host.PlayCadence). The reactive preset lowers the effective
// decision interval toward the play cadence floor and relaxes the adaptive slow-model punish so a
// laggy seat still wakes often (reflexes cover the gaps). The raw pure-benchmark track keeps
// tempo-as-score and is never contaminated by a URL override, exactly like the other extras.
function cadenceProfileConfig() {
	const hostArgs = new URLSearchParams(location.search);
	const benchmarkTrack = (hostArgs.get('Host.BenchmarkTrack') ?? hostArgs.get('Host.Track') ?? '').toLowerCase();
	if (benchmarkTrack === 'raw')
		return { playCadence: false, adaptiveCeilingTicks: BenchmarkAdaptiveCeilingTicks };

	const playCadence = hostArgs.get('Host.PlayCadence') === '1';
	return {
		playCadence,
		adaptiveCeilingTicks: playCadence ? PlayCadenceAdaptiveCeilingTicks : BenchmarkAdaptiveCeilingTicks
	};
}

/** Lobby gamespeed id (slowest…fastest). Default fastest for agent wall-clock smokes. */
function gameSpeedConfig() {
	const hostArgs = new URLSearchParams(location.search);
	const fromUrl = (hostArgs.get('Host.GameSpeed') ?? '').trim().toLowerCase();
	const allowed = new Set(['slowest', 'slower', 'default', 'fast', 'faster', 'fastest']);
	if (fromUrl && allowed.has(fromUrl))
		return fromUrl;
	const fromUi = element('agent-game-speed')?.value?.trim()?.toLowerCase();
	if (fromUi && allowed.has(fromUi))
		return fromUi;
	return 'fastest';
}

async function verifyStrategyArsenalPreflight(sidecarUrl, contract, enabled) {
	if (!enabled) {
		return;
	}

	let response;
	let health;
	try {
		response = await fetch(`${sidecarUrl}/health`, { cache: 'no-store' });
		health = await response.json();
	} catch {
		throw new Error('Agent strategy arsenal preflight failed.');
	}

	const host = contract?.manifest?.arsenal;
	const pins = ['rulesHash', 'rulesArtifactHash', 'rulesGraphHash', 'catalogFileHash', 'manualFileHash'];
	const matches = response.ok && health?.arsenalReady === true && host != null &&
		pins.every(field => /^[0-9a-f]{64}$/.test(host[field] ?? '') &&
			/^[0-9a-f]{64}$/.test(health?.[field] ?? '') && host[field] === health[field]);
	if (!matches) {
		// Do not surface sidecar error prose or mismatched pin values: both can
		// contain environment details and neither helps the operator repair the
		// version skew. The integrated gate records the exact mismatch offline.
		throw new Error('Agent strategy arsenal preflight mismatch.');
	}
}

function clearPlanningTurnState(agent) {
	agent.inFlight = false;
	agent.thinkingBody = null;
	agent.pendingObservation = null;
}

function startPlanningPhase() {
	if (!active || active.phase !== 'planning' || active.planningStarted) {
		return;
	}

	active.planningStarted = true;
	setStatus(`Pre-match planning · both commanders committing openings · ${Math.round(active.planningTimeoutMs / 1000)}s window`);
	// Page deadline sits 3s behind the worker/sidecar budget so the fetch
	// abort fires first and the page only sweeps up true stragglers.
	active.planningTimer = setTimeout(() => maybeLaunchPlanned(true), active.planningTimeoutMs + 3000);
	for (let index = 0; index < active.agents.length; index++) {
		const agent = active.agents[index];
		let observation;
		try {
			observation = parseHostJson(program.GetAgentObservation(agent.id, 0), 'GetAgentObservation');
		} catch (error) {
			const safe = bounded(error.message, 1000);
			appendBubble(index, 'error', 'PLANNING observation failed — no staged plan', safe);
			recordTelemetry({ kind: 'planning', agentId: agent.id, decisionId: 0, worldTick: 0,
				summary: `Fail-open: observation failed: ${safe}` });
			settlePlanningSeat(agent.id);
			continue;
		}

		agent.inFlight = true;
		appendBubble(index, 'observing', 'PLANNING — decision 0',
			`pre-world observation · tick 0 · window ${Math.round(active.planningTimeoutMs / 1000)}s`);
		worker.postMessage({
			type: 'decide',
			agentId: agent.id,
			decisionId: 0,
			phase: 'planning',
			requestTimeoutMs: active.planningTimeoutMs,
			observation
		});
	}
}

function handlePlanningDecision(index, agent, message) {
	clearPlanningTurnState(agent);
	if (active.phase !== 'planning') {
		appendBubble(index, 'error', 'PLANNING — late response discarded',
			'The planning window closed before this response arrived; the match launched without it.');
		recordTelemetry({ kind: 'planning', agentId: agent.id, decisionId: 0, worldTick: 0,
			summary: 'Late planning response discarded.' });
		return;
	}

	const batch = message.batch ?? {};
	setSpend(message.spentUsd);
	appendBubble(index, 'decided', 'PLANNING — decision 0',
		`${bounded(batch.thoughts, 1000)}\n\n${summarizeActions(batch.actions)}`);
	recordTelemetry({
		kind: 'planning',
		agentId: agent.id,
		decisionId: 0,
		worldTick: 0,
		model: agent.model,
		thoughts: bounded(batch.thoughts, 1000),
		summary: summarizeActions(batch.actions),
		promptTokens: Number(message.usage?.promptTokens ?? 0),
		completionTokens: Number(message.usage?.completionTokens ?? 0),
		costUsd: Number(message.usage?.costUsd ?? 0)
	});
	try {
		const result = parseHostJson(program.StageAgentPlanningActions(agent.id, JSON.stringify(batch)),
			'StageAgentPlanningActions');
		const summary = summarizeResults(result);
		appendBubble(index, 'result', 'PLANNING staged — final validation at match start', summary);
		recordTelemetry({ kind: 'planning', agentId: agent.id, decisionId: 0, worldTick: 0, summary: `Staged: ${summary}` });
		worker?.postMessage({ type: 'decision-result', agentId: agent.id, summary: `Planning staged: ${summary}` });
	} catch (error) {
		// Fail-open: a rejected planning batch costs the opening commitment,
		// never the match.
		const safe = bounded(error.message, 1000);
		appendBubble(index, 'error', 'PLANNING rejected — launching without a staged plan', safe);
		recordTelemetry({ kind: 'planning', agentId: agent.id, decisionId: 0, worldTick: 0, summary: `Rejected: ${safe}` });
		worker?.postMessage({ type: 'decision-result', agentId: agent.id, summary: `Planning batch rejected: ${safe}` });
	}

	settlePlanningSeat(agent.id);
}

function handlePlanningError(index, agent, message) {
	clearPlanningTurnState(agent);
	const safe = bounded(message.message, 1000);
	setSpend(message.spentUsd);
	// Provider-terminal failure is match-fatal even when it arrives just after
	// the planning deadline. The worker has already cleared credentials and
	// stopped, so treating it as an ignorable late failure would leave a live
	// match with a permanently silent commander.
	if (active.phase !== 'planning' && !message.fatal) {
		appendBubble(index, 'error', 'PLANNING — late failure ignored', safe);
		return;
	}

	appendBubble(index, 'error', 'PLANNING failed — launching without a staged plan', safe);
	recordTelemetry({ kind: 'planning', agentId: agent.id, decisionId: 0, worldTick: 0, summary: `Fail-open: ${safe}` });
	if (message.fatal) {
		stopForFatalWorkerFailure(message);
		return;
	}

	settlePlanningSeat(agent.id);
}

function settlePlanningSeat(agentId) {
	if (!active || active.phase !== 'planning') {
		return;
	}

	active.planningPending.delete(agentId);
	maybeLaunchPlanned(false);
}

function maybeLaunchPlanned(deadlineExpired) {
	if (!active || active.phase !== 'planning') {
		return;
	}

	if (!deadlineExpired && active.planningPending.size > 0) {
		return;
	}

	if (active.planningTimer != null) {
		clearTimeout(active.planningTimer);
		active.planningTimer = null;
	}

	for (const agent of active.agents) {
		if (active.planningPending.has(agent.id)) {
			const index = agentIndex(agent.id);
			appendBubble(index, 'error', 'PLANNING timeout — launching without a staged plan',
				`No planning response within ${active.planningTimeoutMs + 3000}ms; this seat starts with defaults.`);
			recordTelemetry({ kind: 'planning', agentId: agent.id, decisionId: 0, worldTick: 0,
				summary: `Fail-open: planning timed out after ${active.planningTimeoutMs + 3000}ms.` });
			// Keep the page-side in-flight guard until the bounded worker request
			// settles.  The match still launches now, but posting decision 1 while
			// the worker still owns decision 0 would make the worker drop it as
			// busy.  The late planning response/error clears this guard without
			// ever staging its batch.
		}
	}

	active.planningPending.clear();
	try {
		parseHostJson(program.LaunchPreparedAgentMatch(active.matchId), 'LaunchPreparedAgentMatch');
	} catch (error) {
		stopMatch(bounded(`Launch failed: ${error.message}`, 500));
		return;
	}

	active.phase = 'live';
	setStatus('Planning complete; match launching.');
	recordTelemetry({ kind: 'planning', decisionId: 0, worldTick: 0,
		summary: `Planning phase closed (${deadlineExpired ? 'deadline' : 'all seats settled'}); match launched.` });
}

function clearLockstepSeatState(agent) {
	agent.inFlight = false;
	agent.thinkingBody = null;
	agent.currentThinkingModel = null;
	agent.currentThinkingRole = null;
	agent.pendingObservation = null;
}

function validateLockstepBatch(batch, seat) {
	if (batch == null || typeof batch !== 'object' || Array.isArray(batch)) {
		return 'Sidecar returned no action batch.';
	}

	if (batch.schemaVersion !== 1 || batch.decisionId !== seat.decisionId ||
		batch.observedSequence !== seat.observationSequence ||
		batch.observedWorldTick !== seat.observation?.worldTick) {
		return 'Action batch identity does not match the cached lockstep snapshot.';
	}

	if (typeof batch.thoughts !== 'string' || batch.thoughts.trim().length === 0 ||
		!Array.isArray(batch.actions)) {
		return 'Action batch is missing required thoughts or actions.';
	}

	return '';
}

function lockstepSeatDuration(message, startedAt) {
	const reported = Number(message?.durationMs);
	const measured = Math.round(performance.now() - startedAt);
	return Math.max(0, Math.round(Number.isFinite(reported) ? reported : measured));
}

function appendLockstepTrace(snapshot, result, commits) {
	if (!active?.benchmarkLockstep) {
		return;
	}

	const byAgent = new Map((result?.seats ?? []).map(seat => [seat.agentId, seat]));
	const trace = {
		specVersion: snapshot.specVersion,
		barrierId: snapshot.barrierId,
		prematch: snapshot.prematch,
		triggerWorldTick: snapshot.triggerWorldTick,
		triggerNetFrame: snapshot.triggerNetFrame,
		frozenWorldTick: snapshot.frozenWorldTick,
		frozenNetFrame: snapshot.frozenNetFrame,
		frozenSyncHash: snapshot.frozenSyncHash,
		appliedWorldTick: result?.appliedWorldTick ?? -1,
		appliedNetFrame: result?.appliedNetFrame ?? -1,
		closedWorldTick: -1,
		closedNetFrame: -1,
		resumed: snapshot.prematch,
		commitDigest: result?.commitDigest ?? null,
		seats: snapshot.seats.map(seat => ({
			ordinal: seat.ordinal,
			agentId: seat.agentId,
			decisionId: seat.decisionId,
			triggerSource: seat.triggerSource,
			trigger: seat.trigger,
			observationSequence: seat.observationSequence,
			snapshotDigest: seat.snapshotDigest,
			status: commits.get(seat.agentId)?.status ?? 'timeout',
			outcome: byAgent.get(seat.agentId)?.outcome ?? null,
			durationMs: commits.get(seat.agentId)?.durationMs ?? 0
		}))
	};
	active.lockstepTrace.push(trace);
	globalThis.oraLastLockstepTrace = JSON.parse(JSON.stringify(active.lockstepTrace));
}

function reconcileClosedLockstepTrace(snapshot) {
	if (!active?.benchmarkLockstep || snapshot.phase !== 'Idle') {
		return;
	}

	const trace = active.lockstepTrace.find(entry => entry.barrierId === snapshot.barrierId);
	if (trace == null || trace.closedWorldTick >= 0) {
		return;
	}

	trace.closedWorldTick = snapshot.closedWorldTick;
	trace.closedNetFrame = snapshot.closedNetFrame;
	trace.resumed = !snapshot.authoritativeWorldPaused;
	globalThis.oraLastLockstepTrace = JSON.parse(JSON.stringify(active.lockstepTrace));
}

function abortActiveLockstepBarrier(reason) {
	if (!active?.benchmarkLockstep) {
		return;
	}

	const current = active.lockstepBarrier;
	if (current?.timer != null) {
		clearTimeout(current.timer);
		current.timer = null;
	}

	if (current != null) {
		worker?.postMessage({ type: 'abort-barrier', barrierId: current.snapshot.barrierId });
	}

	let snapshot = current?.snapshot;
	if (snapshot == null) {
		try {
			snapshot = parseHostJson(program.GetAgentLockstepBarrier(), 'GetAgentLockstepBarrier');
		} catch {
			return;
		}
	}

	if (snapshot.barrierId < 0 || snapshot.phase === 'Idle' ||
		active.lockstepAbortedBarriers.has(snapshot.barrierId)) {
		return;
	}

	active.lockstepAbortedBarriers.add(snapshot.barrierId);
	try {
		parseHostJson(program.AbortAgentLockstepBarrier(JSON.stringify({
			schemaVersion: 1,
			specVersion: BenchmarkLockstepSpecVersion,
			barrierId: snapshot.barrierId,
			reason: bounded(reason, 500)
		})), 'AbortAgentLockstepBarrier');
	} catch (error) {
		console.warn(`[agent-mode] lockstep abort failed: ${bounded(error.message, 500)}`);
	}
}

function beginLockstepBarrier(snapshot) {
	if (!active?.benchmarkLockstep || active.lockstepBarrier != null || snapshot.phase !== 'Collecting') {
		return;
	}

	if (snapshot.specVersion !== BenchmarkLockstepSpecVersion || !Number.isSafeInteger(snapshot.barrierId) ||
		!Array.isArray(snapshot.seats) || snapshot.seats.length !== 2) {
		throw new Error('Host returned an invalid benchmark lockstep barrier.');
	}

	const orderedSeats = [...snapshot.seats].sort((a, b) => a.ordinal - b.ordinal);
	for (const seat of orderedSeats) {
		if (agentIndex(seat.agentId) < 0 || !Number.isSafeInteger(seat.decisionId) ||
			seat.observation == null || typeof seat.observation !== 'object') {
			throw new Error('Host returned an invalid cached lockstep seat snapshot.');
		}
	}

	const startedAt = performance.now();
	const barrier = {
		snapshot: { ...snapshot, seats: orderedSeats },
		startedAt,
		commits: new Map(),
		commitIssued: false,
		timer: null
	};
	active.lockstepBarrier = barrier;
	setStatus(`${snapshot.prematch ? 'Prematch' : 'Benchmark'} barrier ${snapshot.barrierId} · ` +
		`frozen tick ${snapshot.frozenWorldTick} · awaiting both seats`);
	barrier.timer = setTimeout(() => commitLockstepBarrier(true), snapshot.decisionTimeoutMs);

	// Both messages are posted from the same task after the page-owned deadline
	// is armed. The worker has independent per-seat fetches, so neither seat can
	// observe or wait for the other's result.
	for (const seat of orderedSeats) {
		const index = agentIndex(seat.agentId);
		const agent = active.agents[index];
		agent.inFlight = true;
		agent.pendingObservation = {
			sequence: seat.observationSequence,
			worldTick: seat.observation.worldTick
		};
		const own = Array.isArray(seat.observation.actors)
			? seat.observation.actors.filter(actor => actor.relationship === 'self').length : 0;
		const enemies = Array.isArray(seat.observation.actors)
			? seat.observation.actors.filter(actor => actor.relationship === 'enemy').length : 0;
		appendBubble(index, 'observing',
			`${snapshot.prematch ? 'PLANNING' : 'LOCKSTEP'} — decision ${seat.decisionId}`,
			`barrier ${snapshot.barrierId} · frozen tick ${snapshot.frozenWorldTick} · ` +
			`own actors ${own} · visible enemies ${enemies}`);
		worker.postMessage({
			type: 'decide',
			lockstep: true,
			barrierId: snapshot.barrierId,
			agentId: seat.agentId,
			decisionId: seat.decisionId,
			phase: snapshot.prematch ? 'planning' : 'live',
			requestTimeoutMs: snapshot.decisionTimeoutMs,
			observation: seat.observation
		});
	}
}

function settleLockstepSeat(message, failed) {
	const barrier = active?.lockstepBarrier;
	if (barrier == null || barrier.commitIssued || message.barrierId !== barrier.snapshot.barrierId) {
		return;
	}

	const seat = barrier.snapshot.seats.find(candidate => candidate.agentId === message.agentId);
	if (seat == null || message.decisionId !== seat.decisionId || barrier.commits.has(seat.agentId)) {
		return;
	}

	const index = agentIndex(seat.agentId);
	const agent = active.agents[index];
	const durationMs = lockstepSeatDuration(message, barrier.startedAt);
	if (failed) {
		const reason = bounded(message.message || 'Agent request failed.', 500);
		barrier.commits.set(seat.agentId, { status: 'invalid', reason, durationMs });
		appendBubble(index, 'error', `LOCKSTEP failed — decision ${seat.decisionId}`, `${reason}\nDeterministic no-op.`);
	} else {
		const invalidReason = validateLockstepBatch(message.batch, seat);
		if (invalidReason) {
			barrier.commits.set(seat.agentId, { status: 'invalid', reason: invalidReason, durationMs });
			appendBubble(index, 'error', `LOCKSTEP invalid — decision ${seat.decisionId}`,
				`${invalidReason}\nDeterministic no-op.`);
		} else {
			barrier.commits.set(seat.agentId, { status: 'valid', batch: message.batch, durationMs, message });
			appendBubble(index, 'decided', `LOCKSTEP decided — decision ${seat.decisionId}`,
				`${bounded(message.batch.thoughts, 1000)}\n\n${summarizeActions(message.batch.actions)}`);
		}
	}

	clearLockstepSeatState(agent);
	if (barrier.commits.size === barrier.snapshot.seats.length) {
		commitLockstepBarrier(false);
	}
}

function commitLockstepBarrier(deadlineExpired) {
	const barrier = active?.lockstepBarrier;
	if (barrier == null || barrier.commitIssued) {
		return;
	}

	barrier.commitIssued = true;
	if (barrier.timer != null) {
		clearTimeout(barrier.timer);
		barrier.timer = null;
	}

	if (deadlineExpired) {
		worker?.postMessage({ type: 'abort-barrier', barrierId: barrier.snapshot.barrierId });
	}

	for (const seat of barrier.snapshot.seats) {
		if (!barrier.commits.has(seat.agentId)) {
			const reason = `No response before the shared ${barrier.snapshot.decisionTimeoutMs}ms deadline.`;
			barrier.commits.set(seat.agentId, {
				status: 'timeout', reason, durationMs: barrier.snapshot.decisionTimeoutMs
			});
			const index = agentIndex(seat.agentId);
			appendBubble(index, 'error', `LOCKSTEP timeout — decision ${seat.decisionId}`,
				`${reason}\nDeterministic no-op.`);
			clearLockstepSeatState(active.agents[index]);
		}
	}

	const request = {
		schemaVersion: 1,
		specVersion: BenchmarkLockstepSpecVersion,
		barrierId: barrier.snapshot.barrierId,
		seats: barrier.snapshot.seats.map(seat => {
			const commit = barrier.commits.get(seat.agentId);
			return {
				agentId: seat.agentId,
				decisionId: seat.decisionId,
				status: commit.status,
				...(commit.status === 'valid' ? { batch: commit.batch } : { reason: commit.reason }),
				durationMs: commit.durationMs
			};
		})
	};

	let result;
	try {
		result = parseHostJson(program.CommitAgentLockstepBarrier(JSON.stringify(request)),
			'CommitAgentLockstepBarrier');
	} catch (error) {
		abortActiveLockstepBarrier(`combined commit failed: ${error.message}`);
		stopMatch(bounded(`Benchmark lockstep commit failed: ${error.message}`, 500));
		return;
	}

	appendLockstepTrace(barrier.snapshot, result, barrier.commits);
	for (const seat of barrier.snapshot.seats) {
		const index = agentIndex(seat.agentId);
		const agent = active.agents[index];
		const commit = barrier.commits.get(seat.agentId);
		const seatResult = result.seats?.find(candidate => candidate.agentId === seat.agentId);
		const summary = seatResult?.actionResult != null
			? summarizeResults(seatResult.actionResult)
			: `${seatResult?.outcome ?? commit.status}; deterministic no-op.`;
		appendBubble(index, 'result', `LOCKSTEP applied — decision ${seat.decisionId}`,
			`${summary}\nbarrier ${barrier.snapshot.barrierId} · applied frame ${result.appliedNetFrame} · ` +
			`digest ${bounded(result.commitDigest, 80)}`);
		recordTelemetry({
			kind: barrier.snapshot.prematch ? 'planning' : 'result',
			agentId: seat.agentId,
			decisionId: seat.decisionId,
			worldTick: barrier.snapshot.frozenWorldTick,
			model: agent.model,
			role: 'strategist',
			thoughts: commit.status === 'valid' ? bounded(commit.batch.thoughts, 1000) : null,
			summary: `barrier=${barrier.snapshot.barrierId}; outcome=${seatResult?.outcome ?? commit.status}; ` +
				`appliedNetFrame=${result.appliedNetFrame}; commitDigest=${result.commitDigest ?? 'none'}; ${summary}`,
			promptTokens: Number(commit.message?.usage?.promptTokens ?? 0),
			completionTokens: Number(commit.message?.usage?.completionTokens ?? 0),
			costUsd: Number(commit.message?.usage?.costUsd ?? 0)
		});
		worker?.postMessage({
			type: 'decision-result',
			lockstep: true,
			barrierId: barrier.snapshot.barrierId,
			agentId: seat.agentId,
			memo: commit.status === 'valid' ? commit.batch.memo : null,
			summary
		});
		const actionResults = seatResult?.actionResult?.results ?? [];
		noteSpectatorDecision(index, {
			acceptedActions: actionResults.filter(item => item.accepted).length,
			totalActions: actionResults.length,
			noop: commit.status !== 'valid' || actionResults.length === 0,
			latencyMs: commit.durationMs,
			costUsd: Number(commit.message?.usage?.costUsd ?? 0),
			fallbackTurns: Number(seatResult?.actionResult?.fallbackTurns ?? 0),
			decisionOpportunities: Number(seatResult?.actionResult?.decisionOpportunities ?? 0)
		});
	}

	const prematch = barrier.snapshot.prematch;
	active.lockstepBarrier = null;
	if (prematch) {
		try {
			parseHostJson(program.LaunchPreparedAgentMatch(active.matchId), 'LaunchPreparedAgentMatch');
		} catch (error) {
			stopMatch(bounded(`Launch failed: ${error.message}`, 500));
			return;
		}

		active.phase = 'live';
		setStatus('Benchmark barrier zero complete; match launching.');
	}
}

function pollLockstep(state) {
	const snapshot = parseHostJson(program.GetAgentLockstepBarrier(), 'GetAgentLockstepBarrier');
	if (snapshot.specVersion !== BenchmarkLockstepSpecVersion) {
		throw new Error(`Unsupported benchmark specVersion '${snapshot.specVersion}'.`);
	}

	reconcileClosedLockstepTrace(snapshot);
	if (snapshot.phase === 'Collecting') {
		beginLockstepBarrier(snapshot);
	} else if (snapshot.phase === 'PausePending') {
		setStatus(`Benchmark barrier ${snapshot.barrierId} · waiting for authoritative pause`);
	} else if (snapshot.phase === 'ResumePending') {
		setStatus(`Benchmark barrier ${snapshot.barrierId} · applied frame ${snapshot.appliedNetFrame} · resuming`);
	} else if (snapshot.stopKind !== 'None' && state.state === 'running') {
		setStatus(`Benchmark stopped: ${snapshot.stopReason ?? snapshot.stopKind}.`);
	}
}

function finishTurn(agent, worldTick) {
	agent.inFlight = false;
	agent.thinkingBody = null;
	agent.currentThinkingModel = null;
	agent.currentThinkingRole = null;
	agent.pendingObservation = null;
	// Adaptive cadence (deliberation consensus): heartbeat follows measured
	// model latency — clamp(100, 1.5 × p50 in world ticks, ceiling). Fast models
	// think often; slow models think less often (reflexes cover the gaps).
	// The play/RTS-Agent preset relaxes the slow-model punish by lowering the
	// ceiling; the raw pure-benchmark track keeps the 500-tick tempo-as-score
	// ceiling. Until a latency sample exists, the configured interval applies.
	const ticksPerMs = 25 / 1000;
	const adaptiveCeiling = active.adaptiveCeilingTicks ?? BenchmarkAdaptiveCeilingTicks;
	const adaptive = active.staffSeatEnabled ? active.interval
		: Number.isFinite(agent.latencyP50Ms) && agent.latencyP50Ms > 0
		? Math.min(adaptiveCeiling, Math.max(100, Math.round(1.5 * agent.latencyP50Ms * ticksPerMs)))
		: active.interval;
	agent.nextDecisionTick = Math.max(worldTick, active?.worldTick ?? worldTick) + adaptive;
}

function stopWorker() {
	if (thinkingTimer != null) {
		clearInterval(thinkingTimer);
		thinkingTimer = undefined;
	}

	if (worker != null) {
		worker.postMessage({ type: 'stop' });
		worker.terminate();
		worker = undefined;
	}
	workerReady = false;
}

function startThinkingTimer() {
	if (thinkingTimer != null) {
		return;
	}

	thinkingTimer = setInterval(() => {
		if (!active) {
			return;
		}

		for (const agent of active.agents) {
			if (agent.thinkingBody != null) {
				const seconds = (performance.now() - agent.thinkingStarted) / 1000;
				agent.thinkingBody.textContent = `${agent.currentThinkingModel ?? agent.model} ` +
					`(${agent.currentThinkingRole ?? 'commander'}) · request in flight · ${seconds.toFixed(1)}s`;
			}
		}
	}, 250);
}

function spendSettlement(override) {
	if (override != null) {
		const count = Math.max(0, Number(override.inFlightSpendRequests) || 0);
		return { spendFinal: count === 0, inFlightSpendRequests: count };
	}

	const count = active?.agents?.filter(agent => agent.inFlight).length ?? 0;
	return { spendFinal: count === 0, inFlightSpendRequests: count };
}

function stashResolvedMatchState(state, spendState, missionEventBatches = [], terminalReason) {
	const participants = [
		...(Array.isArray(state?.agents) ? state.agents : []),
		...(state?.opponent != null ? [state.opponent] : [])
	];
	const hasResolvedPlayer = participants.some(player =>
		player?.winState != null && player.winState !== 'Undefined' && player.winState !== 'Pending');
	if (state?.state !== 'finished' && state?.state !== 'failed' && state?.outOfSync !== true && !hasResolvedPlayer) {
		return false;
	}

	// Keep only the host's plain JSON terminal record. Never retain the active
	// page state, prompts, or any worker-owned credential material.
	globalThis.oraLastResolvedMatchState = JSON.parse(JSON.stringify({
		...state,
		...(terminalReason == null ? {} : { terminalReason: bounded(terminalReason, 500) }),
		terminalKind: spendState?.terminalKind ?? null,
		...spendSettlement(spendState),
		missionEventBatches
	}));
	return true;
}

function stashStoppedMatchState(reason, spendState, missionEventBatches = []) {
	try {
		const state = parseHostJson(program.GetAgentMatchState(), 'GetAgentMatchState');
		if (stashResolvedMatchState(state, spendState, missionEventBatches, reason)) {
			return;
		}

		globalThis.oraLastResolvedMatchState = JSON.parse(JSON.stringify({
			...state,
			state: 'stopped',
			terminalReason: bounded(reason, 500),
			terminalKind: spendState?.terminalKind ?? null,
			...spendSettlement(spendState),
			missionEventBatches
		}));
	} catch {
		// Teardown must remain available even if the host state is unavailable.
		// The mission drain happened before this call, so preserve those bounded
		// facts even when GetAgentMatchState loses the teardown race.
		globalThis.oraLastResolvedMatchState = JSON.parse(JSON.stringify({
			state: 'stopped',
			terminalReason: bounded(reason, 500),
			terminalKind: spendState?.terminalKind ?? null,
			...spendSettlement(spendState),
			missionEventBatches
		}));
	}
}

function drainMissionEventsForAgent(index, agent) {
	const missions = parseHostJson(program.GetAgentMissionEvents(agent.id, agent.missionSequence ?? 0),
		'GetAgentMissionEvents');
	for (const event of missions.events ?? []) {
		const summary = summarizeMissionEvent(event);
		appendBubble(index, 'mission', summary.title, summary.text);
		recordTelemetry({
			kind: 'mission',
			agentId: agent.id,
			worldTick: event.worldTick,
			summary: summary.telemetry
		});
	}

	if (missions.latestSequence != null) {
		agent.missionSequence = missions.latestSequence;
	}

	return {
		agentId: agent.id,
		schemaVersion: missions.schemaVersion ?? null,
		latestSequence: missions.latestSequence ?? agent.missionSequence ?? 0,
		events: Array.isArray(missions.events) ? missions.events : []
	};
}

function drainMissionEvents() {
	if (!active) {
		return [];
	}

	const batches = [];
	for (let index = 0; index < active.agents.length; index++) {
		try {
			batches.push(drainMissionEventsForAgent(index, active.agents[index]));
		} catch {
			// Mission telemetry is presentation-only; teardown must never depend on it.
		}
	}

	return batches;
}

function stopMatch(reason, stopGame = true, spendState) {
	if (!active) {
		return;
	}

	// Abort through the barrier API before terminating the worker or
	// disconnecting the game. This is the only teardown ordering that lets the
	// host issue its owned unpause while the regular world still exists.
	abortActiveLockstepBarrier(reason);

	if (active.planningTimer != null) {
		clearTimeout(active.planningTimer);
		active.planningTimer = null;
	}

	// Mission state can transition on the same world tick as victory, a spend
	// stop, or an operator stop. Drain it synchronously while the host still
	// owns the world, then carry the bounded batches in the terminal stash for
	// the benchmark runner's independent cursor.
	const missionEventBatches = drainMissionEvents();
	stashStoppedMatchState(reason, spendState, missionEventBatches);
	setStatus(reason);
	stopWorker();
	if (stopGame) {
		program.StopAgentMatch();
	}
	active = undefined;
	element('agent-start').disabled = false;
	element('agent-stop').disabled = true;
	setSpectatorMatchRunning(false);
}

function stopForFatalWorkerFailure(message) {
	const insufficientCredit = message.fatalKind === 'insufficient-credit';
	const terminalKind = insufficientCredit ? 'insufficient-credit' : 'authentication';
	const reason = insufficientCredit
		? 'OpenRouter reported insufficient credit; the match was stopped before another provider request.'
		: 'OpenRouter authentication failed; credentials were cleared and the match was stopped.';
	stopMatch(reason, true, {
		inFlightSpendRequests: message.providerRequestsInFlight,
		terminalKind
	});
	setStatus(reason, true);
}

function onWorkerMessage(event) {
	const message = event.data ?? {};
	if (!active && message.type !== 'ready') {
		return;
	}
	if (active && message.agentId) {
		recordSeatSpend(message);
	}

	if (message.type === 'ready') {
		workerReady = true;
		setStatus('Agent worker ready; waiting for the match world.');
		if (active?.benchmarkLockstep) {
			void poll();
		} else if (active?.phase === 'planning') {
			startPlanningPhase();
		}
		return;
	}

	if (message.type === 'thinking') {
		if (active.benchmarkLockstep && message.barrierId !== active.lockstepBarrier?.snapshot.barrierId) {
			return;
		}

		const index = agentIndex(message.agentId);
		if (index < 0) {
			return;
		}

		const agent = active.agents[index];
		agent.thinkingStarted = performance.now();
		agent.currentThinkingModel = message.model;
		agent.currentThinkingRole = message.role;
		agent.thinkingBody = appendBubble(index, 'thinking', `Thinking — decision ${message.decisionId}`,
			`${bounded(message.model, 200)} (${bounded(message.role ?? 'commander', 40)}) · request in flight · 0.0s`);
		return;
	}

	if (message.type === 'decision') {
		if (active.benchmarkLockstep) {
			settleLockstepSeat(message, false);
			return;
		}

		const index = agentIndex(message.agentId);
		if (index < 0) {
			return;
		}

		const agent = active.agents[index];
		// Planning decisions (decisionId 0) stage through the prepared-match
		// path and never touch SubmitAgentActions; late ones are discarded.
		if (active.phase === 'planning' || message.decisionId === 0) {
			handlePlanningDecision(index, agent, message);
			return;
		}
		try {
			setHostRequestState(agent, message.decisionId, false);
		} catch (error) {
			stopMatch(bounded(error.message, 500));
			return;
		}

		if (Number.isFinite(message.latencyP50Ms) && message.latencyP50Ms > 0) {
			agent.latencyP50Ms = message.latencyP50Ms;
		}

		const batch = message.batch ?? {};
		const actionSummary = summarizeActions(batch.actions);
		appendBubble(index, 'decided', `Decided — decision ${message.decisionId}`,
			`${bounded(batch.thoughts, 1000)}\n\n${actionSummary}`);
		setSpend(message.spentUsd);
		recordTelemetry({
			kind: 'decided',
			agentId: message.agentId,
			decisionId: message.decisionId,
			worldTick: batch.observedWorldTick,
			model: message.model ?? agent.model,
			role: message.role ?? 'strategist',
			thoughts: bounded(batch.thoughts, 1000),
			summary: actionSummary,
			promptTokens: Number(message.usage?.promptTokens ?? 0),
			completionTokens: Number(message.usage?.completionTokens ?? 0),
			costUsd: Number(message.usage?.costUsd ?? 0)
		});

		let result;
		let nearMissRetry = false;
		try {
			result = parseHostJson(program.SubmitAgentActions(message.agentId, JSON.stringify(batch)), 'SubmitAgentActions');
			const summary = summarizeResults(result);
			appendBubble(index, 'result', `Result — decision ${message.decisionId}`,
				`${summary}\nUsage: ${message.usage?.promptTokens ?? 0} in / ${message.usage?.completionTokens ?? 0} out · ` +
				`$${Number(message.usage?.costUsd ?? 0).toFixed(5)} · ${message.durationMs ?? 0}ms`);
			recordTelemetry({
				kind: 'result',
				agentId: message.agentId,
				decisionId: message.decisionId,
				worldTick: batch.observedWorldTick,
				model: message.model ?? agent.model,
				role: message.role ?? 'strategist',
				summary
			});
			worker.postMessage({ type: 'decision-result', agentId: message.agentId, summary });
			const results = Array.isArray(result.results) ? result.results : [];
			nearMissRetry = message.retryOf == null && results.length > 0 &&
				results.every(item => !item.accepted) && results.some(item =>
					Array.isArray(item.nextLegalActions) && item.nextLegalActions.length > 0);
			noteSpectatorDecision(index, {
				acceptedActions: results.filter(item => item.accepted).length,
				totalActions: results.length,
				noop: results.length === 0,
				latencyMs: Number(message.durationMs ?? 0),
				costUsd: Number(message.usage?.costUsd ?? 0),
				fallbackTurns: Number(result.fallbackTurns ?? 0),
				decisionOpportunities: Number(result.decisionOpportunities ?? 0)
			});
		} catch (error) {
			const safe = bounded(error.message, 1000);
			appendBubble(index, 'error', `Rejected batch — decision ${message.decisionId}`, safe);
			recordTelemetry({ kind: 'error', agentId: message.agentId, decisionId: message.decisionId,
				model: message.model ?? agent.model, role: message.role ?? 'strategist', summary: safe });
			worker.postMessage({ type: 'decision-result', agentId: message.agentId, summary: `Batch rejected: ${safe}` });
			noteSpectatorDecision(index,
				{ noop: true, latencyMs: Number(message.durationMs ?? 0), costUsd: Number(message.usage?.costUsd ?? 0) });
			try {
				recordTerminalDecisionFailure(agent, message.decisionId, `irrelevant host rejection: ${safe}`);
			} catch {
				// The host rejection remains the authoritative visible result.
			}
		}

		finishTurn(agent, batch.observedWorldTick ?? active.worldTick);
		if (nearMissRetry) {
			agent.retryOf = message.decisionId;
			agent.nextDecisionTick = active.worldTick + 25;
		}
		return;
	}

	if (message.type === 'decision-error') {
		if (active.benchmarkLockstep) {
			if (message.barrierId !== active.lockstepBarrier?.snapshot.barrierId) {
				return;
			}

			if (message.fatal) {
				abortActiveLockstepBarrier(`fatal worker failure: ${message.message}`);
				stopForFatalWorkerFailure(message);
				return;
			}

			settleLockstepSeat(message, true);
			return;
		}

		const index = agentIndex(message.agentId);
		if (index < 0) {
			return;
		}

		const agent = active.agents[index];
		if (active.phase === 'planning' || message.decisionId === 0) {
			handlePlanningError(index, agent, message);
			return;
		}
		try {
			setHostRequestState(agent, message.decisionId, false);
			recordTerminalDecisionFailure(agent, message.decisionId, message.message);
		} catch (error) {
			stopMatch(bounded(error.message, 500));
			return;
		}

		const safe = bounded(message.message, 1000);
		appendBubble(index, 'error', `Model failed — decision ${message.decisionId}`, safe);
		setSpend(message.spentUsd);
		recordTelemetry({ kind: 'error', agentId: message.agentId, decisionId: message.decisionId,
			model: message.model ?? agent.model, role: message.role ?? 'strategist', summary: safe });
		let fallbackResult;
		if (!message.fatal) {
			try {
				fallbackResult = submitAdvisorFallback(index, agent, message.decisionId, safe);
			} catch (error) {
				appendBubble(index, 'error', `Fallback failed — decision ${message.decisionId}`, bounded(error.message, 1000));
			}
		}
		if (fallbackResult == null) {
			noteSpectatorDecision(index, { noop: true });
		}
		finishTurn(agent, active.worldTick);
		if (fallbackKind(safe) === 'schema' && message.retryOf == null) {
			agent.retryOf = message.decisionId;
			agent.nextDecisionTick = active.worldTick + 25;
		} else {
			agent.retryOf = null;
		}
		if (message.fatal) {
			stopForFatalWorkerFailure(message);
		}
		return;
	}

	if (message.type === 'budget-exhausted') {
		if (active.benchmarkLockstep) {
			abortActiveLockstepBarrier('Worker attempted a forbidden spend-cap stop in benchmark lockstep mode.');
			stopMatch('Benchmark lockstep worker violated the no-dollar-stop invariant.');
			return;
		}

		const safe = bounded(message.message, 1000);
		setSpend(message.spentUsd);
		for (let index = 0; index < active.agents.length; index++) {
			appendBubble(index, 'error', 'Spend cap reached', safe);
		}

		recordTelemetry({ kind: 'budget', summary: safe, costUsd: Number(message.spentUsd ?? 0) });
		stopMatch(safe, true, { inFlightSpendRequests: message.providerRequestsInFlight });
	}
}

async function estimate(strategyArsenalEnabled = strategyArsenalConfig().enabled,
	doctrineExecutorEnabled = doctrineExecutorConfig().enabled,
	staffSeat = staffSeatConfig()) {
	const sidecar = normalizeSidecarUrl(element('agent-sidecar').value.trim());
	const opponentBot = selectedOpponentBot();
	const models = opponentBot
		? [element('agent-model-1').value.trim()]
		: [element('agent-model-1').value.trim(), element('agent-model-2').value.trim()];
	if (!sidecar || models.some(model => !model)) {
		throw new Error(`Sidecar URL and ${opponentBot ? 'the Agent 1 model id are' : 'both model ids are'} required.`);
	}
	const reactionModels = opponentBot ? staffSeat.reactionModels.slice(0, 1) : staffSeat.reactionModels;
	if (staffSeat.enabled && reactionModels.some(model => !model)) {
		throw new Error('Staff-seat mode requires a separately declared reaction model for every LLM seat.');
	}

	const priceModels = async requestedModels => {
		const transportModels = opponentBot ? [requestedModels[0], requestedModels[0]] : requestedModels;
		const response = await fetch(`${sidecar}/api/estimate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				models: transportModels,
				maxOutputTokens: doctrineExecutorEnabled ? 8192 : Math.min(4096, numberValue('agent-max-tokens')),
				estimatedInputTokens: 8000,
				estimatedDecisionsPerAgent: 20,
				...(strategyArsenalEnabled ? { strategyArsenalEnabled: true } : {})
			}),
			cache: 'no-store'
		});
		const payload = await response.json().catch(() => ({ error: `Sidecar returned HTTP ${response.status}.` }));
		if (!response.ok)
			throw new Error(bounded(payload.error, 500));
		return opponentBot ? { ...payload, agents: payload.agents.slice(0, 1),
			estimatedMatchUsd: payload.agents[0].perDecisionUsd * payload.assumptions.estimatedDecisionsPerAgent } : payload;
	};

	const priced = await priceModels(models);
	if (staffSeat.enabled) {
		const reactionPricing = await priceModels(reactionModels);
		priced.reactionAgents = reactionPricing.agents;
		priced.reactionModels = reactionModels;
		priced.estimatedMatchUsd += reactionPricing.estimatedMatchUsd;
	}
	element('agent-estimate').textContent =
		`Estimated ${staffSeat.enabled ? 'strategist + reaction staff budgets' : '20 decisions'} ` +
		`per ${opponentBot ? 'LLM seat' : 'agent'} at 8k input tokens: ` +
		`$${Number(priced.estimatedMatchUsd).toFixed(3)}. ` +
		'Live preflight uses a stricter byte-based ceiling.';
	return priced;
}

async function startMatch() {
	if (active) {
		return;
	}

	delete globalThis.oraLastResolvedMatchState;
	delete globalThis.oraLastLockstepTrace;

	element('agent-start').disabled = true;
	setStatus('Checking model pricing…');
	let hostStarted = false;
	try {
		const contract = parseHostJson(program.GetAgentContractManifest(), 'GetAgentContractManifest');
		const benchmarkLockstep = benchmarkLockstepConfig();
		if (benchmarkLockstep.enabled && benchmarkLockstep.tickHorizon === 0 &&
			benchmarkLockstep.decisionHorizon === 0) {
			throw new Error('Benchmark lockstep requires a positive tick or decision horizon.');
		}
		const strategyArsenal = strategyArsenalConfig();
		const doctrineExecutor = doctrineExecutorConfig();
		const actionGuidance = actionGuidanceConfig();
		const doctrineFallbackStrike = doctrineFallbackStrikeConfig();
		const staffSeat = staffSeatConfig();
		const sidecarUrl = normalizeSidecarUrl(element('agent-sidecar').value.trim());
		await verifyStrategyArsenalPreflight(sidecarUrl, contract, strategyArsenal.enabled);
		const pricing = await estimate(strategyArsenal.enabled, doctrineExecutor.enabled, staffSeat);
		const hostKnowledgeHash = contract?.manifest?.rulesKnowledgeHash;
		const sidecarKnowledgeHash = pricing?.rulesKnowledgeHash;
		if (!/^[0-9a-f]{64}$/.test(hostKnowledgeHash ?? '') ||
			!/^[0-9a-f]{64}$/.test(sidecarKnowledgeHash ?? '') ||
			hostKnowledgeHash !== sidecarKnowledgeHash) {
			throw new Error('Agent rules knowledge does not match the running game bundle; rebuild and restart the sidecar.');
		}

		const opponentBot = selectedOpponentBot();
		const agentCount = opponentBot ? 1 : 2;
		let key1 = element('agent-key-1').value.trim();
		let key2 = element('agent-key-2').value.trim();
		if (!key1) {
			throw new Error('An OpenRouter key is required.');
		}

		if (!opponentBot && !key2) {
			key2 = key1;
		}

		const requestedCadence = cadenceProfileConfig();
		const cadence = benchmarkLockstep.enabled
			? { playCadence: false, adaptiveCeilingTicks: BenchmarkAdaptiveCeilingTicks }
			: requestedCadence;
		// The play/RTS-Agent preset floors the effective decision interval toward the reactive cadence;
		// the pure benchmark (and every other track) keeps the operator interval unchanged (tempo-as-score).
		const uiInterval = numberValue('agent-interval');
		const interval = cadence.playCadence ? Math.min(uiInterval, PlayCadenceIntervalTicks) : uiInterval;
		// Raw and ordinary arsenal retain their effective 4096 ceiling. Executor
		// strategic turns use the additive 8192 ceiling; reaction turns are capped
		// at 4096 in the worker.
		const maxOutputTokens = doctrineExecutor.enabled ? 8192 : Math.min(4096, numberValue('agent-max-tokens'));
		const spendCapUsd = numberValue('agent-spend-cap');
		if (!Number.isFinite(spendCapUsd) || spendCapUsd < 0.01 || spendCapUsd > 1000) {
			throw new Error('Spend cap must be between $0.01 and $1000.');
		}
		syncSpendCapDefaults();
		const seatSpendCaps = [numberValue('agent-spend-cap-1'), numberValue('agent-spend-cap-2')].slice(0, agentCount);
		if (seatSpendCaps.some(cap => !Number.isFinite(cap) || cap < 0.01 || cap > spendCapUsd)) {
			throw new Error('Each active seat cap must be between $0.01 and the total match cap.');
		}

		const prompts = [element('agent-prompt-1').value, element('agent-prompt-2').value].slice(0, agentCount);
		if (prompts.some(prompt => !prompt.trim() || prompt.length > 8000)) {
			throw new Error('Each system prompt must contain 1–8000 characters.');
		}

		const replayPrompts = prompts.map(prompt => [key1, key2]
			.filter(key => key.length !== 0)
			.reduce((safe, key) => safe.split(key).join('[redacted]'), prompt));
		const omniscient = element('agent-omniscient').checked;
		const advisorFallbackEnabled = benchmarkLockstep.enabled ? false : element('agent-advisor-fallback').checked;
		const factions = [element('agent-faction-1').value.trim(), element('agent-faction-2').value.trim()];
		const requestedPlanning = planningConfig();
		const planning = benchmarkLockstep.enabled
			? { enabled: true, timeoutMs: benchmarkLockstep.timeoutMs }
			: requestedPlanning;
		const gameSpeed = gameSpeedConfig();
		const matchConfig = {
			schemaVersion: 1,
			fakeAgents: false,
			decisionIntervalTicks: interval,
			omniscientObservations: omniscient,
			advisorFallbackEnabled,
			strategyArsenalEnabled: strategyArsenal.enabled,
			doctrineExecutorEnabled: doctrineExecutor.enabled,
			actionGuidanceEnabled: actionGuidance.enabled,
			doctrineFallbackStrikeEnabled: doctrineFallbackStrike.enabled,
			staffSeatEnabled: staffSeat.enabled,
			playCadenceEnabled: cadence.playCadence,
			benchmarkLockstepEnabled: benchmarkLockstep.enabled,
			benchmarkSpecVersion: benchmarkLockstep.specVersion,
			benchmarkDecisionTimeoutMs: benchmarkLockstep.timeoutMs,
			benchmarkTickHorizon: benchmarkLockstep.tickHorizon,
			benchmarkDecisionHorizon: benchmarkLockstep.decisionHorizon,
			benchmarkControlRegions: benchmarkLockstep.controlRegions,
			gameSpeed,
			matchSpendCapUsd: spendCapUsd,
			agent1SpendCapUsd: seatSpendCaps[0],
			agent2SpendCapUsd: seatSpendCaps[1] ?? spendCapUsd,
			opponentBot: opponentBot || null,
			faction1: factions[0],
			faction2: factions[1]
		};
		const requestedMapUid = element('agent-map').value.trim();
		// Planning prepares the match without creating the world; the launch
		// happens after both seats settle or the planning deadline expires.
		// The legacy one-shot start stays byte-identical when planning is off.
		const start = planning.enabled
			? parseHostJson(program.PrepareAgentMatch(requestedMapUid, JSON.stringify({
				...matchConfig,
				prematchPlanning: true,
				planningTimeoutMs: planning.timeoutMs
			})), 'PrepareAgentMatch')
			: parseHostJson(program.StartAgentMatch(requestedMapUid,
				JSON.stringify(matchConfig)), 'StartAgentMatch');
		hostStarted = true;
		if (!Array.isArray(start.agentIds) || start.agentIds.length !== agentCount) {
			throw new Error(`Agent match did not return ${agentCount} LLM agent slot(s).`);
		}
		if (strategyArsenal.enabled && start.strategyArsenalEnabled !== true) {
			throw new Error('Agent host did not apply the requested strategy arsenal mode.');
		}
		if (doctrineExecutor.enabled && start.doctrineExecutorEnabled !== true) {
			throw new Error('Agent host did not apply the requested doctrine executor mode.');
		}
		if (actionGuidance.enabled && start.actionGuidanceEnabled !== true) {
			throw new Error('Agent host did not apply the requested exact action guidance mode.');
		}
		if (doctrineFallbackStrike.enabled && start.doctrineFallbackStrikeEnabled !== true) {
			throw new Error('Agent host did not apply the requested doctrine fallback strike mode.');
		}
		if (staffSeat.enabled && start.staffSeatEnabled !== true) {
			throw new Error('Agent host did not apply the requested staff-seat profile.');
		}
		if (cadence.playCadence && start.playCadenceEnabled !== true) {
			throw new Error('Agent host did not apply the requested play cadence profile.');
		}
		if (benchmarkLockstep.enabled && (start.resolvedProfile !== 'benchmark-lockstep' ||
			start.benchmarkLockstep?.specVersion !== benchmarkLockstep.specVersion ||
			start.benchmarkLockstep?.decisionTimeoutMs !== benchmarkLockstep.timeoutMs ||
			start.benchmarkLockstep?.tickHorizon !== benchmarkLockstep.tickHorizon ||
			start.benchmarkLockstep?.decisionHorizon !== benchmarkLockstep.decisionHorizon)) {
			throw new Error('Agent host did not apply the requested benchmark lockstep spec.');
		}

		const models = [element('agent-model-1').value.trim(), element('agent-model-2').value.trim()].slice(0, agentCount);
		const reactionModels = staffSeat.reactionModels.slice(0, agentCount);
		if (staffSeat.enabled && (reactionModels.some(model => !model) ||
			!Array.isArray(pricing.reactionAgents) || pricing.reactionAgents.length !== agentCount)) {
			throw new Error('Staff-seat reaction models did not pass pricing preflight.');
		}
		active = {
			matchId: start.matchId,
			benchmarkLockstep: benchmarkLockstep.enabled,
			benchmarkSpecVersion: benchmarkLockstep.specVersion,
			benchmarkDecisionTimeoutMs: benchmarkLockstep.timeoutMs,
			benchmarkTickHorizon: benchmarkLockstep.tickHorizon,
			benchmarkDecisionHorizon: benchmarkLockstep.decisionHorizon,
			lockstepBarrier: null,
			lockstepTrace: [],
			lockstepAbortedBarriers: new Set(),
			interval,
			playCadence: cadence.playCadence,
			adaptiveCeilingTicks: cadence.adaptiveCeilingTicks,
			omniscient,
			advisorFallbackEnabled,
			strategyArsenalEnabled: strategyArsenal.enabled,
			doctrineExecutorEnabled: doctrineExecutor.enabled,
			actionGuidanceEnabled: actionGuidance.enabled,
			doctrineFallbackStrikeEnabled: doctrineFallbackStrike.enabled,
			staffSeatEnabled: staffSeat.enabled,
			resolvedProfile: start.resolvedProfile,
			opponentBot,
			phase: planning.enabled ? 'planning' : 'live',
			planningTimeoutMs: planning.timeoutMs,
			planningPending: new Set(planning.enabled && !benchmarkLockstep.enabled ? start.agentIds : []),
			planningTimer: null,
			planningStarted: false,
			worldTick: -1,
			agents: start.agentIds.map((id, index) => ({
				id,
				model: models[index],
				reactionModel: staffSeat.enabled ? reactionModels[index] : null,
				prompt: prompts[index],
				replayPrompt: replayPrompts[index],
				lastSequence: 0,
				decisionId: 1,
				nextDecisionTick: 25,
				inFlight: false,
				thinkingBody: null,
				pendingObservation: null,
				strategySequence: 0,
				spentUsd: 0,
				spendCapUsd: seatSpendCaps[index]
			}))
		};
		for (const agent of active.agents) {
			const result = program.RecordAgentSpend(agent.id, 0, agent.spendCapUsd);
			if (result !== 'recorded') {
				throw new Error('Agent host rejected the per-seat spend budget.');
			}
		}
		startThinkingTimer();

		worker = new Worker(new URL('./agent-worker.js', import.meta.url), { type: 'module' });
		worker.addEventListener('message', onWorkerMessage);
		worker.addEventListener('error', () => {
			if (active) {
				setStatus('Agent worker crashed; match stopped.', true);
				stopMatch('Agent worker crashed; match stopped.');
			}
		});
		// Per-agent model profile: reasoning effort is only forwarded when the
		// operator picked one, so models without reasoning support are unaffected.
		const efforts = [element('agent-effort-1')?.value ?? '', element('agent-effort-2')?.value ?? ''];
		worker.postMessage({
			type: 'initialize',
			sidecarUrl,
			spendCapUsd,
			benchmarkLockstep: benchmarkLockstep.enabled,
			knowledgeChars: Number(pricing.knowledgeChars ?? 16384),
			arsenalContextChars: Number(pricing.arsenalContextChars ?? 0),
			agents: active.agents.map((agent, index) => ({
				agentId: agent.id,
				model: agent.model,
				systemPrompt: agent.prompt,
				apiKey: index === 0 ? key1 : key2,
				spendCapUsd: agent.spendCapUsd,
				maxOutputTokens,
				requestTimeoutMs: benchmarkLockstep.enabled ? benchmarkLockstep.timeoutMs : 60000,
				reasoningEffort: ['low', 'medium', 'high'].includes(efforts[index]) ? efforts[index] : '',
				reactionModel: agent.reactionModel,
				reactionReasoningEffort: ['low', 'medium', 'high'].includes(staffSeat.reactionEfforts[index])
					? staffSeat.reactionEfforts[index] : '',
				reactionPricing: staffSeat.enabled ? pricing.reactionAgents[index] : null,
				arsenalMode: strategyArsenal.enabled ? 'menu' : 'off',
				guidanceMode: actionGuidance.enabled || doctrineExecutor.enabled ? 'exact' : 'off',
				pricing: pricing.agents[index]
			}))
		});

		// Drop every main-thread reference immediately after the structured clone.
		active.agents.forEach(agent => { agent.prompt = ''; });
		key1 = '';
		key2 = '';
		element('agent-key-1').value = '';
		element('agent-key-2').value = '';
		element('agent-start').disabled = true;
		element('agent-stop').disabled = false;
		element('agent-feeds').hidden = false;
		setSpectatorMatchRunning(true);
		setSpend(0);
		setStatus(`Starting ${start.mapTitle} · ${omniscient ? 'OMNISCIENT RESEARCH MODE' : 'player fog'} · ` +
			(opponentBot ? `OpenRA ${opponentBot} AI opponent` : 'two LLM commanders') +
			(planning.enabled ? ` · pre-match planning ${Math.round(planning.timeoutMs / 1000)}s` : '') +
			(benchmarkLockstep.enabled ? ` · ${benchmarkLockstep.specVersion}` : '') +
			(strategyArsenal.enabled ? ' · strategy arsenal' : ''));
		active.agents.forEach(agent => recordTelemetry({
			kind: 'match',
			agentId: agent.id,
			model: agent.model,
			prompt: agent.replayPrompt,
			summary: `Agent match started on ${start.mapTitle}; visibility=${omniscient ? 'omniscient' : 'player-fog'}; ` +
				`advisorFallback=${advisorFallbackEnabled}; opponentBot=${opponentBot || 'none'}; ` +
				`strategyArsenalEnabled=${strategyArsenal.enabled}; ` +
				`doctrineExecutorEnabled=${doctrineExecutor.enabled}; actionGuidanceEnabled=${actionGuidance.enabled}; ` +
				`doctrineFallbackStrikeEnabled=${doctrineFallbackStrike.enabled}; staffSeatEnabled=${staffSeat.enabled}; ` +
				`strategistModel=${agent.model}; reactionModel=${agent.reactionModel ?? 'none'}; ` +
				`resolvedProfile=${start.resolvedProfile}; ` +
				`matchSpendCapUsd=${spendCapUsd}; seatSpendCapUsd=${agent.spendCapUsd}; ` +
				`prematchPlanning=${planning.enabled}${planning.enabled ? `; planningTimeoutMs=${planning.timeoutMs}` : ''}; ` +
				`benchmarkLockstep=${benchmarkLockstep.enabled}` +
				(benchmarkLockstep.enabled ? `; benchmarkSpecVersion=${benchmarkLockstep.specVersion}; ` +
					`benchmarkDecisionTimeoutMs=${benchmarkLockstep.timeoutMs}; ` +
					`benchmarkTickHorizon=${benchmarkLockstep.tickHorizon}; ` +
					`benchmarkDecisionHorizon=${benchmarkLockstep.decisionHorizon}; ` +
					`reasoningEffort=${efforts[active.agents.indexOf(agent)] || 'provider-default'}` : '') + '.'
		}));
	} catch (error) {
		const safe = bounded(error.message, 500);
		if (active) {
			stopMatch(safe);
			setStatus(safe, true);
		} else {
			if (hostStarted) {
				program.StopAgentMatch();
			}
			setStatus(safe, true);
			element('agent-start').disabled = false;
		}
		element('agent-key-1').value = '';
		element('agent-key-2').value = '';
	}
}

async function poll() {
	if (!active || !workerReady || pollInProgress) {
		return;
	}

	pollInProgress = true;
	try {
		const state = parseHostJson(program.GetAgentMatchState(), 'GetAgentMatchState');
		stashResolvedMatchState(state);
		active.worldTick = state.worldTick;
		for (let index = 0; index < active.agents.length; index++) {
			const participant = state.agents?.[index];
			if (participant?.playerColor) active.agents[index].playerColor = participant.playerColor;
			if (participant?.seatIdentity) active.agents[index].seatIdentity = participant.seatIdentity;
			updateSpectatorCard(index, active.agents[index].model,
				active.agents[index].replayPrompt, participant?.faction,
				participant?.playerColor, participant?.seatIdentity);
		}
		setStatus(`${state.state} · tick ${state.worldTick} · net ${state.netFrame} · ` +
			`${active.omniscient ? 'OMNISCIENT RESEARCH MODE' : 'player fog'}`);
		if (state.outOfSync) {
			stopMatch('Sync error detected; match stopped.');
			return;
		}

		if (active.benchmarkLockstep) {
			pollLockstep(state);
			if (state.state === 'finished' || state.state === 'failed') {
				stopMatch(`Agent match ${state.state}: ${state.terminalReason ?? 'benchmark horizon or win state resolved'}.`);
			}
			return;
		}

		if (state.state === 'finished' || state.state === 'failed') {
			stopMatch(`Agent match ${state.state}: ${state.terminalReason ?? 'win states resolved'}.`);
			return;
		}

		if (state.state !== 'running' || state.worldTick < 25) {
			return;
		}

		for (let index = 0; index < active.agents.length; index++) {
			const agent = active.agents[index];

			// The deterministic reflex layer acts between decisions; surface its
			// orders as REFLEX bubbles so the commander visibly reacts while the
			// model is still thinking.
			try {
				const reflexes = parseHostJson(program.GetAgentReflexEvents(agent.id, agent.reflexSequence ?? 0),
					'GetAgentReflexEvents');
				for (const event of reflexes.events ?? []) {
					const cell = event.cell != null ? ` → ${event.cell.x},${event.cell.y}` : '';
					const target = event.targetActorId ? ` target ${event.targetActorId}` : '';
					appendBubble(index, 'reflex', `REFLEX — tick ${event.worldTick}`,
						`${event.kind}: ${event.actorIds?.length ?? 0} unit(s)${target}${cell}\n${bounded(event.reason ?? '', 200)}`);
					recordTelemetry({
						kind: 'reflex',
						agentId: agent.id,
						worldTick: event.worldTick,
						summary: `${event.kind} ${event.reason ?? ''}`.trim()
					});
				}

				if (reflexes.latestSequence != null) {
					agent.reflexSequence = reflexes.latestSequence;
				}
			} catch {
				// Reflex telemetry is presentation-only; never block decisions on it.
			}

			// Mission commitments keep progressing while a model request is in
			// flight. Poll their independent sequence before the in-flight guard so
			// the spectator sees every bounded state transition in real time.
			try {
				drainMissionEventsForAgent(index, agent);
			} catch {
				// Mission telemetry is presentation-only; never block decisions on it.
			}

			// Strategy adoption is a separate bounded cursor stream. Poll it even
			// while the model is thinking so spectators see a switch as soon as the
			// host accepts it, without coupling decisions to presentation work.
			if (active.strategyArsenalEnabled) {
				try {
					const strategies = parseHostJson(
						program.GetAgentStrategyEvents(agent.id, agent.strategySequence ?? 0),
						'GetAgentStrategyEvents');
					for (const event of strategies.events ?? []) {
						const summary = summarizeStrategyEvent(event);
						appendBubble(index, 'strategy', summary.title, summary.text);
						updateStrategyPanel(index, event);
						recordTelemetry({
							kind: 'strategy',
							agentId: agent.id,
							worldTick: event.worldTick,
							sequence: event.sequence,
							strategyId: event.strategyId,
							cardVersion: event.cardVersion,
							previousStrategyId: event.previousStrategyId,
							catalogVersion: event.catalogVersion,
							modelReason: event.modelReason,
							summary: summary.telemetry
						});
					}

					if (strategies.latestSequence != null) {
						agent.strategySequence = strategies.latestSequence;
					}
				} catch {
					// Strategy telemetry is presentation-only; never block decisions on it.
				}
			}

			if (agent.inFlight) {
				continue;
			}

			// Alerts cut through immediately via the host's single-claim due
			// poll; routine thinking follows the adaptive schedule. The claim
			// only happens here, when the agent is free to act on it.
			let trigger = state.worldTick >= agent.nextDecisionTick ? 'adaptive' : '';
			try {
				const due = parseHostJson(program.GetAgentDecisionDue(agent.id), 'GetAgentDecisionDue');
				if (due.due) {
					trigger = due.trigger || 'heartbeat';
				}
			} catch {
				// Due polling is advisory; the adaptive schedule still runs.
			}

			if (!trigger) {
				continue;
			}

			let observation;
			try {
				observation = parseHostJson(program.GetAgentObservation(agent.id, agent.lastSequence), 'GetAgentObservation');
			} catch (error) {
				const safe = bounded(error.message, 1000);
				appendBubble(index, 'error', `Observation failed — decision ${agent.decisionId}`, `${safe}\nNo-op turn.`);
				recordTelemetry({ kind: 'error', agentId: agent.id, decisionId: agent.decisionId, summary: safe });
				noteSpectatorDecision(index, { noop: true });
				agent.decisionId++;
				agent.nextDecisionTick = state.worldTick + active.interval;
				continue;
			}

			agent.lastSequence = observation.sequence;
			agent.inFlight = true;
			agent.pendingObservation = { sequence: observation.sequence, worldTick: observation.worldTick };

			const alerts = Array.isArray(observation.alerts) ? observation.alerts : [];
			if (alerts.length > 0) {
				appendBubble(index, 'alert', `ALERT — decision ${agent.decisionId}`,
					alerts.slice(0, 3).map(summarizeAlert).join('\n'));
				recordTelemetry({
					kind: 'alert',
					agentId: agent.id,
					decisionId: agent.decisionId,
					summary: alerts.slice(0, 3).map(summarizeAlert).join('; ')
				});
			}

			const doctrineActions = observation.hostTruth?.doctrine?.recentActions ?? [];
			agent.seenDoctrineActions ??= new Set();
			for (const action of doctrineActions) {
				const key = `${action.tick}:${action.kind}:${action.source}:${action.decisionId}:${action.missionId ?? ''}`;
				if (agent.seenDoctrineActions.has(key)) continue;
				agent.seenDoctrineActions.add(key);
				const summary = `source=${action.source ?? 'doctrine'} kind=${action.kind ?? 'action'} ` +
					`decision=${action.decisionId ?? 0} mission=${action.missionId ?? 'none'} ` +
					`actors=${(action.actorIds ?? []).join(',') || 'none'} reason=${action.reason ?? action.detail ?? ''}`;
				appendBubble(index, 'doctrine', `DOCTRINE — tick ${action.tick}`, summary);
				recordTelemetry({ kind: 'doctrine', agentId: agent.id, decisionId: action.decisionId ?? -1,
					worldTick: action.tick, summary });
			}
			while (agent.seenDoctrineActions.size > 32) {
				agent.seenDoctrineActions.delete(agent.seenDoctrineActions.values().next().value);
			}

			const materialSignature = active.doctrineExecutorEnabled ? executorMaterialSignature(observation) : null;
			const quietExecutorHeartbeat = active.doctrineExecutorEnabled && agent.retryOf == null &&
				(trigger === 'heartbeat' || trigger === 'adaptive') && alerts.length === 0 &&
				observation.hostTruth?.doctrine?.pendingDecision == null;
			if (quietExecutorHeartbeat && agent.lastMaterialSignature === materialSignature) {
				recordTelemetry({ kind: 'doctrine', agentId: agent.id, worldTick: observation.worldTick,
					summary: 'Quiet executor-covered heartbeat skipped; material state unchanged.' });
				finishTurn(agent, state.worldTick);
				continue;
			}
			agent.lastMaterialSignature = materialSignature;

			// A reaction turn (woken by an alert) runs on a trimmed observation
			// with a tight token/time budget; heartbeats carry the full picture.
			const fastPath = alerts.length > 0 && trigger !== 'heartbeat' && trigger !== 'adaptive';
			const own = observation.actors.filter(actor => actor.relationship === 'self').length;
			const enemies = observation.actors.filter(actor => actor.relationship === 'enemy').length;
			appendBubble(index, 'observing', `Observing — decision ${agent.decisionId}`,
				`tick ${observation.worldTick} · own actors ${own} · visible enemies ${enemies} · ` +
				`production queues ${observation.productionQueues.length} · ${observation.visibility} · ` +
				`trigger ${trigger}${fastPath ? ' (fast reaction)' : ''}`);
			try {
				setHostRequestState(agent, agent.decisionId, true);
			} catch (error) {
				agent.inFlight = false;
				stopMatch(bounded(error.message, 500));
				return;
			}
			const decisionKind = fastPath ? null : observation.hostTruth?.doctrine?.pendingDecision?.kind ?? null;
			worker.postMessage({
				type: 'decide',
				agentId: agent.id,
				decisionId: agent.decisionId,
				retryOf: agent.retryOf ?? null,
				fastPath,
				decisionKind,
				observation: fastPath ? buildFastObservation(observation)
					: decisionKind != null ? buildCommitObservation(observation) : observation
			});
			agent.retryOf = null;
			agent.decisionId++;
		}
	} catch (error) {
		setStatus(bounded(error.message, 500), true);
	} finally {
		pollInProgress = false;
	}
}

export function initialize(agentProgram) {
	program = agentProgram;
	root = element('agent-mode');
	if (!root || new URLSearchParams(location.search).get('Host.AgentMode') !== '1') {
		return;
	}

	root.hidden = false;
	spectator = document.body.classList.contains('spectator');
	if (spectator) {
		buildSpectatorLayout();
	}

	element('agent-prompt-1').value = DefaultPrompts[0];
	element('agent-prompt-2').value = DefaultPrompts[1];
	const hostArgs = new URLSearchParams(location.search);
	element('agent-advisor-fallback').checked = hostArgs.get('Host.AdvisorFallback') === '1';
	const requestedOpponent = hostArgs.get('Host.OpponentBot') ?? '';
	if ([...element('agent-opponent').options].some(option => option.value === requestedOpponent)) {
		element('agent-opponent').value = requestedOpponent;
	}
	element('agent-opponent').addEventListener('change', syncOpponentControls);
	element('agent-spend-cap').addEventListener('input', syncSpendCapDefaults);
	for (const id of ['agent-spend-cap-1', 'agent-spend-cap-2']) {
		element(id).addEventListener('input', event => { event.currentTarget.dataset.customized = 'true'; });
	}
	syncOpponentControls();
	element('agent-start').addEventListener('click', () => void startMatch());
	element('agent-estimate-button').addEventListener('click', () => {
		setStatus('Checking model pricing…');
		void estimate().then(() => setStatus('Estimate updated.')).catch(error => setStatus(bounded(error.message, 500), true));
	});
	element('agent-stop').addEventListener('click', () => stopMatch('Stopped by operator.'));
	startThinkingTimer();
	window.addEventListener('pagehide', shutdown, { once: true });
	setStatus('Enter an ephemeral OpenRouter key, review the estimate, then start. Keys are never stored.');
}

export function tick() {
	if (!active) {
		return;
	}

	const now = performance.now();
	if (now - lastPollAt < 100) {
		return;
	}

	lastPollAt = now;
	void poll();
}

export function shutdown() {
	if (active?.benchmarkLockstep) {
		abortActiveLockstepBarrier('Agent page teardown.');
	}
	stopWorker();
	active = undefined;
}
