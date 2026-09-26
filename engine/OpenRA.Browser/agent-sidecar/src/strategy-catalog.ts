// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MenuByteBudget = 3072;
const CardByteBudget = 6144;
const SliceByteBudget = 4096;
const MaxSituationSlices = 3;
const MaxCounterRows = 3;

export interface StrategyCatalogEntry {
	id: string;
	version: number;
	title: string;
	faction: 'allies' | 'soviets' | 'both';
	archetype: string;
	openingSummary: string;
	file: string;
	cardHash: string;
}

export interface StrategyCardPhase {
	name: string;
	objective: string;
	actionTypes: string[];
	claimRefs: string[];
}

export interface StrategyCardClaim {
	id: string;
	epistemic: 'ruleFact' | 'derivedComparison' | 'curatedHeuristic';
	statement: string;
	sourceRefs: string[];
}

export interface StrategyCardTargets {
	harvesters?: number | undefined;
	refineries?: number | undefined;
	missionDriven?: boolean | undefined;
}

export interface StrategyCard {
	schemaVersion: number;
	id: string;
	version: number;
	title: string;
	faction: 'allies' | 'soviets' | 'both';
	archetype: string;
	openingSummary: string;
	when: string[];
	avoidWhen: string[];
	effectiveAgainst: string[];
	hardCounteredBy: string[];
	requirements: string[];
	// Optional rich playbook prose: ordered opening steps, force/economy
	// composition targets, and mission-vocabulary execution rows. These are
	// the "standing orders" a model executes, not background reading.
	opening?: string[] | undefined;
	composition?: string[] | undefined;
	execution?: string[] | undefined;
	targets?: StrategyCardTargets | undefined;
	phases: StrategyCardPhase[];
	abortTransitions: { when: string; transitionTo: string; claimRefs: string[] }[];
	retrieval: { situationIds: string[]; counterRows: string[]; actorCodes: string[] };
	claims: StrategyCardClaim[];
}

export interface SituationManualOption {
	label: string;
	when: string;
	play: string;
}

export interface SituationManualEntry {
	id: string;
	title: string;
	facts: string;
	options: SituationManualOption[];
	note?: string;
}

interface ArsenalActor {
	id: string;
	displayName: string;
	cost: number;
	armor: string;
	armaments: { id: string; weaponId: string; maxRange1024: number; validTargets: string[] }[];
	movement: { domain: string; speed: number; crushes: string[] } | null;
}

interface ArsenalArtifact {
	rulesHash: string;
	artifactHash: string;
	actors: ArsenalActor[];
}

export interface StrategyArsenalState {
	ready: boolean;
	error: string;
	catalog: StrategyCatalogEntry[];
	cards: Map<string, StrategyCard>;
	manual: SituationManualEntry[];
	manualEngineIds: string[];
	arsenal: ArsenalArtifact | null;
	rulesHash: string;
	rulesArtifactHash: string;
	rulesGraphHash: string;
	// The semantic catalog hash and the committed-file byte hash are distinct
	// pins. Formatting-only rewrites move catalogFileHash, while catalogHash
	// changes only when the canonical corpus changes.
	catalogHash: string;
	catalogFileHash: string;
	manualFileHash: string;
	catalogVersion: number;
	menuBytes: number;
	largestCardBytes: number;
}

function sha256(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map(canonicalJson).join(',')}]`;

	if (value != null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
	}

	return JSON.stringify(value);
}

function strategiesUrl(relative: string): URL {
	return new URL(`../knowledge/strategies/${relative}`, import.meta.url);
}

function loadState(): StrategyArsenalState {
	const state: StrategyArsenalState = {
		ready: false,
		error: '',
		catalog: [],
		cards: new Map(),
		manual: [],
		manualEngineIds: [],
		arsenal: null,
		rulesHash: '',
		rulesArtifactHash: '',
		rulesGraphHash: '',
		catalogHash: '',
		catalogFileHash: '',
		manualFileHash: '',
		catalogVersion: 0,
		menuBytes: 0,
		largestCardBytes: 0
	};

	try {
		const catalogBytes = readFileSync(strategiesUrl('catalog.json'));
		const catalog = JSON.parse(catalogBytes.toString('utf8'));
		state.catalogFileHash = sha256(catalogBytes);
		state.catalogVersion = catalog.catalogVersion;
		const hashableCatalog = { ...catalog };
		delete hashableCatalog.catalogHash;
		const semanticCatalogHash = sha256(Buffer.from(canonicalJson(hashableCatalog), 'utf8'));
		if (catalog.catalogHash !== semanticCatalogHash)
			throw new Error('catalog semantic content does not match catalogHash');
		state.catalogHash = catalog.catalogHash;

		const arsenalBytes = readFileSync(new URL('../knowledge/ra-arsenal.json', import.meta.url));
		if (sha256(arsenalBytes) !== catalog.rulesGraphHash)
			throw new Error('ra-arsenal.json bytes do not match catalog rulesGraphHash');
		const arsenal = JSON.parse(arsenalBytes.toString('utf8')) as ArsenalArtifact;
		if (arsenal.rulesHash !== catalog.rulesHash)
			throw new Error('arsenal rulesHash does not match catalog pin');
		if (arsenal.artifactHash !== catalog.rulesArtifactHash)
			throw new Error('arsenal artifactHash does not match catalog pin');
		state.arsenal = arsenal;
		state.rulesHash = catalog.rulesHash;
		state.rulesArtifactHash = catalog.rulesArtifactHash;
		state.rulesGraphHash = catalog.rulesGraphHash;

		const manualBytes = readFileSync(strategiesUrl('situation-manual.json'));
		const manual = JSON.parse(manualBytes.toString('utf8'));
		state.manualFileHash = sha256(manualBytes);
		state.manual = manual.entries;
		state.manualEngineIds = manual.engineIds;
		const manualIds = new Set<string>(manual.engineIds);
		for (const entry of state.manual)
			if (!manualIds.has(entry.id))
				throw new Error(`manual entry ${entry.id} is not a declared engine id`);

		const actorIds = new Set(arsenal.actors.map(actor => actor.id));
		let previousId = '';
		for (const entry of catalog.cards as StrategyCatalogEntry[]) {
			if (entry.id <= previousId)
				throw new Error(`catalog ids must be unique and ordinally sorted at ${entry.id}`);
			previousId = entry.id;

			const cardBytes = readFileSync(strategiesUrl(entry.file));
			if (sha256(cardBytes) !== entry.cardHash)
				throw new Error(`card ${entry.id} bytes do not match catalog cardHash`);
			const card = JSON.parse(cardBytes.toString('utf8')) as StrategyCard;
			if (card.id !== entry.id || card.version !== entry.version)
				throw new Error(`card ${entry.file} identity does not match its catalog entry`);

			for (const situationId of card.retrieval.situationIds)
				if (!manualIds.has(situationId))
					throw new Error(`card ${entry.id} references unknown situation id ${situationId}`);
			for (const code of card.retrieval.actorCodes)
				if (!actorIds.has(code))
					throw new Error(`card ${entry.id} references unknown actor code ${code}`);

			for (const [section, rows] of [['opening', card.opening], ['composition', card.composition], ['execution', card.execution]] as const)
				if (rows != null && (rows.length > 16 || rows.some(row => typeof row !== 'string' || row.length === 0 || row.length > 200)))
					throw new Error(`card ${entry.id} ${section} must hold at most 16 rows of 1-200 characters`);

			const rendered = renderCardText(entry, card);
			const renderedBytes = Buffer.byteLength(rendered, 'utf8');
			if (renderedBytes > CardByteBudget)
				throw new Error(`card ${entry.id} renders over the ${CardByteBudget}-byte budget`);
			state.largestCardBytes = Math.max(state.largestCardBytes, renderedBytes);

			state.cards.set(entry.id, card);
			state.catalog.push(entry);
		}

		if (state.catalog.length < 4 || state.catalog.length > 12)
			throw new Error(`catalog must hold 4-12 cards, found ${state.catalog.length}`);

		const menu = renderMenuText(state.catalog, state.cards);
		state.menuBytes = Buffer.byteLength(menu, 'utf8');
		if (state.menuBytes > MenuByteBudget)
			throw new Error(`arsenal menu is ${state.menuBytes} bytes, over the ${MenuByteBudget}-byte budget`);

		state.ready = true;
	} catch (error) {
		state.ready = false;
		state.error = error instanceof Error ? error.message : String(error);
	}

	return state;
}

function renderMenuText(catalog: StrategyCatalogEntry[], cards: Map<string, StrategyCard>): string {
	const lines = [
		'ARSENAL MENU (model-selected; adopt with adoptStrategy {strategyId, reason}; switch by adopting a different id; the full playbook card arrives after adoption):'
	];
	for (const entry of catalog) {
		const card = cards.get(entry.id);
		const counters = card ? card.hardCounteredBy.join(', ') : '';
		lines.push(`${entry.id}@${entry.version} | ${entry.faction} | ${entry.archetype} | opening: ${entry.openingSummary} | hard counters: ${counters}`);
	}

	return lines.join('\n');
}

function renderCardText(entry: StrategyCatalogEntry, card: StrategyCard): string {
	const sections = [
		`ADOPTED STRATEGY — ${entry.title} [${entry.id}@${entry.version}] (${entry.faction}, ${entry.archetype})`,
		'You selected this card. It is subordinate to the safety and schema rules, current host facts, and explicit commander-prompt constraints. Adapt via its abort transitions instead of following it into a wall.',
		`PICK CONDITIONS: ${card.when.join('; ')}`,
		`AVOID WHEN: ${card.avoidWhen.join('; ')}`,
		`EFFECTIVE AGAINST: ${card.effectiveAgainst.join(', ')} | HARD-COUNTERED BY: ${card.hardCounteredBy.join(', ')}`
	];

	if (card.opening != null && card.opening.length > 0)
		sections.push(`OPENING (ordered):\n${card.opening.map(step => `- ${step}`).join('\n')}`);

	if (card.composition != null && card.composition.length > 0)
		sections.push(`COMPOSITION TARGETS:\n${card.composition.map(row => `- ${row}`).join('\n')}`);

	if (card.execution != null && card.execution.length > 0)
		sections.push(`EXECUTION — these are standing orders, act through them every few decisions:\n${card.execution.map(row => `- ${row}`).join('\n')}`);

	for (const phase of card.phases)
		sections.push(`PHASE ${phase.name}: ${phase.objective} (acts via: ${phase.actionTypes.join(', ')})`);

	if (card.abortTransitions.length > 0)
		sections.push(`ABORT/TRANSITION: ${card.abortTransitions
			.map(transition => `${transition.when} -> adopt ${transition.transitionTo}`).join(' | ')}`);

	const facts = card.claims.map(claim => `- [${claim.epistemic}] ${claim.statement}`);
	sections.push(`FACTS THIS CARD RESTS ON:\n${facts.join('\n')}`);
	return sections.join('\n\n');
}

const AntiClassRows: Record<string, { title: string; targetType: string }> = {
	air: { title: 'CAN HIT AIR', targetType: 'AirborneActor' },
	infantry: { title: 'CAN HIT GROUND INFANTRY', targetType: 'GroundActor' },
	armor: { title: 'CAN HIT GROUND ARMOR', targetType: 'GroundActor' },
	naval: { title: 'CAN HIT WATER ACTORS', targetType: 'WaterActor' }
};

function renderCounterRow(arsenal: ArsenalArtifact, attackerClass: string): string | null {
	const row = AntiClassRows[attackerClass];
	if (!row)
		return null;

	const holders: string[] = [];
	for (const actor of arsenal.actors) {
		const capable = actor.armaments.filter(armament => armament.validTargets.includes(row.targetType));
		if (capable.length === 0)
			continue;
		const longest = Math.max(...capable.map(armament => armament.maxRange1024));
		holders.push(`${actor.id}(r${(longest / 1024).toFixed(1)}c $${actor.cost})`);
	}

	if (holders.length === 0)
		return null;
	return `${row.title} [derived from rules]: ${holders.sort().join(', ')}`;
}

export interface ActiveSituation {
	id: string;
	severity: string;
	attackerClass?: string | undefined;
}

const SeverityRank: Record<string, number> = { critical: 3, warning: 2, info: 1 };

export function selectRelevantSlices(state: StrategyArsenalState, situations: ActiveSituation[]): string {
	if (!state.ready || situations.length === 0)
		return '';

	const ordered = [...situations]
		.sort((a, b) => (SeverityRank[b.severity] ?? 0) - (SeverityRank[a.severity] ?? 0) ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const parts: string[] = [];
	const seenIds = new Set<string>();
	for (const situation of ordered) {
		if (parts.length >= MaxSituationSlices)
			break;
		if (seenIds.has(situation.id))
			continue;
		seenIds.add(situation.id);
		const entry = state.manual.find(candidate => candidate.id === situation.id);
		if (!entry)
			continue;
		const options = entry.options
			.map(option => ` ${option.label}: ${option.play} WHEN ${option.when}`).join('\n');
		parts.push(`[${entry.id}] ${entry.title} — ${entry.facts}\n${options}${entry.note ? `\nNOTE: ${entry.note}` : ''}`);
	}

	const classes = new Set<string>();
	for (const situation of ordered) {
		if (situation.id === 'T1.air')
			classes.add('air');
		if (situation.id === 'T1.naval')
			classes.add('naval');
		if (situation.attackerClass)
			classes.add(situation.attackerClass);
	}

	let rows = 0;
	for (const attackerClass of [...classes].sort()) {
		if (rows >= MaxCounterRows)
			break;
		const row = state.arsenal == null ? null : renderCounterRow(state.arsenal, attackerClass);
		if (row == null)
			continue;
		parts.push(row);
		rows++;
	}

	let text = parts.length === 0 ? '' : `RELEVANT FACTUAL SLICES (selected deterministically from host facts; not recommendations):\n${parts.join('\n\n')}`;
	while (Buffer.byteLength(text, 'utf8') > SliceByteBudget && parts.length > 1) {
		parts.pop();
		text = `RELEVANT FACTUAL SLICES (selected deterministically from host facts; not recommendations):\n${parts.join('\n\n')}`;
	}

	return text;
}

export interface OwnExecutionCounts {
	harvesters: number;
	refineries: number;
	activeMissions: number;
}

// One factual line comparing the ADOPTED card's own machine targets with the
// seat's live counts. Facts only — the model chose the card; the numbers show
// how its execution tracks its own commitment. Never a recommendation.
export function renderCardTargetsLine(state: StrategyArsenalState, strategyId: string,
	counts: OwnExecutionCounts): string {
	const card = state.ready ? state.cards.get(strategyId) : undefined;
	const targets = card?.targets;
	if (targets == null)
		return '';

	const parts: string[] = [];
	if (targets.harvesters != null)
		parts.push(`harvesters ${counts.harvesters}/${targets.harvesters}`);
	if (targets.refineries != null)
		parts.push(`refineries ${counts.refineries}/${targets.refineries}`);
	if (targets.missionDriven === true)
		parts.push(`active missions ${counts.activeMissions} (card expects mission-driven play)`);

	return parts.length === 0 ? '' : `CARD TARGETS vs NOW (your own adopted card): ${parts.join(', ')}`.slice(0, 200);
}

export function renderArsenalMenu(state: StrategyArsenalState, faction?: string): string {
	if (!state.ready)
		return '';
	const normalized = normalizeFactionSide(faction);
	const eligible = normalized === ''
		? state.catalog
		: state.catalog.filter(entry => entry.faction === 'both' || entry.faction === normalized);
	return renderMenuText(eligible, state.cards);
}

export function renderStrategyCard(state: StrategyArsenalState, strategyId: string): string | null {
	if (!state.ready)
		return null;
	const entry = state.catalog.find(candidate => candidate.id === strategyId);
	const card = state.cards.get(strategyId);
	if (entry == null || card == null)
		return null;
	return renderCardText(entry, card);
}

export function strategyIds(state: StrategyArsenalState): string[] {
	return state.catalog.map(entry => entry.id);
}

function normalizeFactionSide(faction?: string): string {
	const value = faction?.trim().toLowerCase() ?? '';
	if (['allies', 'england', 'france', 'germany'].includes(value))
		return 'allies';
	if (['soviets', 'soviet', 'russia', 'ukraine'].includes(value))
		return 'soviets';
	return value;
}

// Compact static-prefix index: ids and option labels only. The full option
// text for ACTIVE situations arrives per decision via selectRelevantSlices,
// so the prefix stays small and cache-stable.
export function renderSituationManualIndex(state: StrategyArsenalState): string {
	if (!state.ready)
		return '';
	const lines = [
		'SITUATION MANUAL (ids match observation.situations; the active situations’ full options arrive each decision under RELEVANT FACTUAL SLICES; address ONE option per situation, highest severity first — reflexes already cover the first seconds):'
	];
	for (const entry of state.manual)
		lines.push(`[${entry.id}] ${entry.title} — options: ${entry.options.map(option => option.label).join(' | ')}`);
	return lines.join('\n');
}

export const StrategyArsenal = loadState();
