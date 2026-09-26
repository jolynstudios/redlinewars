// The named era surfaces (browserRoot-relative): everything a model's
// apparent skill can hinge on that is not already frozen inside the
// committed engine build. Changing this list is itself era-defining:
// extend it, regenerate, and that is a new era.
//
// The list is DERIVED, not chosen. It was hand-picked once and that was wrong
// twice over -- OpenRA.Browser.csproj sets no explicit Compile items and does
// not disable the default ones, so every AgentMode/*.cs is compiled into the
// served assembly rather than the eight someone judged important; and
// strategy-catalog.ts reads ra-arsenal.json, strategies/catalog.json,
// situation-manual.json and the strategy cards at runtime, so the unit stats
// table the models reason from was invisible to era identity. era1 died of an
// incomplete pin list. Judgment about which files "matter" is exactly the thing
// that failed, so the rule below replaces it.
//
// Kept as an explicit literal even though deriveEraFiles() can compute it,
// because the two together are stronger than either alone: the literal makes a
// new era surface a reviewable diff instead of a silent change, and
// EraSurfaceRules makes it impossible for the literal to quietly fall behind
// the tree. era-lock-stamp-gate.mjs asserts they agree, so adding a file under
// AgentMode/ fails loudly until someone decides, on the record, that it is part
// of the era.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const browserRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const EraFiles = Object.freeze([
	'AgentMode/AgentAdjudication.cs',
	'AgentMode/AgentAdjudicationLedger.cs',
	'AgentMode/AgentAdvisor.cs',
	'AgentMode/AgentBuildPlanController.cs',
	'AgentMode/AgentCadence.cs',
	'AgentMode/AgentCombatRoster.cs',
	'AgentMode/AgentDamageObserver.cs',
	'AgentMode/AgentDoctrineController.cs',
	'AgentMode/AgentDoctrineDecisionController.cs',
	'AgentMode/AgentDoctrineExecutor.cs',
	'AgentMode/AgentDoctrineProgram.cs',
	'AgentMode/AgentFallbackController.cs',
	'AgentMode/AgentFogMemory.cs',
	'AgentMode/AgentFuzzyEngagement.cs',
	'AgentMode/AgentLockstepBarrier.cs',
	'AgentMode/AgentMissionController.cs',
	'AgentMode/AgentModeContracts.cs',
	'AgentMode/AgentModeHost.cs',
	'AgentMode/AgentReflexController.cs',
	'AgentMode/AgentSituationDetector.cs',
	'AgentMode/AgentSituationEngine.cs',
	'AgentMode/AgentSpatialSummary.cs',
	'AgentMode/AgentSquadController.cs',
	'AgentMode/AgentStrategyCatalog.Generated.cs',
	'AgentMode/AgentStrategyController.cs',
	'AgentMode/AgentWarCompiler.cs',
	'AgentMode/Program.AgentMode.cs',
	'AgentMode/agent-rules.yaml',
	'agent-sidecar/knowledge/ra-arsenal.json',
	'agent-sidecar/knowledge/ra-knowledge.md',
	'agent-sidecar/knowledge/strategies/cards/allied-e3-mass.strategy.json',
	'agent-sidecar/knowledge/strategies/cards/allied-fast-boom.strategy.json',
	'agent-sidecar/knowledge/strategies/cards/soviet-grenadier-rush.strategy.json',
	'agent-sidecar/knowledge/strategies/cards/soviet-tank-pressure.strategy.json',
	'agent-sidecar/knowledge/strategies/catalog.json',
	'agent-sidecar/knowledge/strategies/situation-manual.json',
	'agent-sidecar/src/contract-manifest.ts',
	'agent-sidecar/src/contracts.ts',
	'agent-sidecar/src/instructions.ts',
	'agent-sidecar/src/provider-schema.ts',
	'agent-sidecar/src/server.ts',
	'agent-sidecar/src/strategy-catalog.ts',
	'tests/benchmark-scripted-anchor.mjs',
	'tests/benchmark-series-lib.mjs',
	'wwwroot/agent-worker.js',
	'wwwroot/index.html',
	'wwwroot/main.js',
	'wwwroot/openra-agent-mode.js',
	'wwwroot/openra-audio.js',
	// STEELSEED Tier 0 removed the legacy freeware-content module and its era-lock surface.
	'wwwroot/openra-fs.js',
	'wwwroot/openra-gl.js',
	'wwwroot/openra-input.js'
]);

// The era1 surfaces, kept only so the gate can prove the benchmark era is a
// strict superset. A surface that stops being pinned is a silent narrowing of
// what the era means, which is the failure this list exists to make impossible.
export const Era1Files = Object.freeze([
	'AgentMode/AgentModeContracts.cs',
	'AgentMode/agent-rules.yaml',
	'agent-sidecar/knowledge/ra-knowledge.md',
	'agent-sidecar/src/contracts.ts',
	'agent-sidecar/src/instructions.ts',
	'agent-sidecar/src/provider-schema.ts',
	'agent-sidecar/src/server.ts',
	'wwwroot/agent-worker.js',
	'wwwroot/openra-agent-mode.js'
]);

// Each rule states the evidence for why its files decide apparent skill, so a
// reviewer can check the reason rather than take the list on trust.
export const EraSurfaceRules = Object.freeze([
	{
		why: 'compiled into the served assembly: the csproj declares no Compile items and does not disable the defaults',
		root: 'AgentMode'
	},
	{
		why: 'executed by the sidecar that mediates every model decision',
		root: 'agent-sidecar/src'
	},
	{
		// playbooks/ is excluded because doctrineHashes already pins it INCLUDING
		// set membership, which is stronger than a files{} entry: an added or
		// removed playbook is drift there, whereas an unlisted file is invisible here.
		why: 'model-facing knowledge read at runtime by strategy-catalog.ts and instructions.ts',
		root: 'agent-sidecar/knowledge',
		skip: relative => relative.startsWith('agent-sidecar/knowledge/playbooks/')
	},
	{
		// s3.* and s4audio.* are standalone demo pages; index.html loads only main.js,
		// and nothing reaches them during a match.
		why: 'the page that hosts the agent, and everything index.html transitively loads',
		root: 'wwwroot',
		skip: (relative, name) => relative.slice('wwwroot/'.length).includes('/') ||
			!(name === 'index.html' || name.endsWith('.js')) ||
			name.startsWith('s3.') || name.startsWith('s4audio.')
	},
	{
		why: "the benchmark's own player, and the scheduler that pairs and scores it",
		files: ['tests/benchmark-scripted-anchor.mjs', 'tests/benchmark-series-lib.mjs']
	}
]);

// Deliberately NOT pinned, stated rather than left to inference:
//   tests/match-runner.mjs -- it is the code that VALIDATES the lock. Pinning
//     the validator makes every future era definition self-invalidating.
//   agent-sidecar/knowledge/playbooks/** -- covered by doctrineHashes, above.
//   wwwroot/s3.*, wwwroot/s4audio.* -- standalone demo pages, never loaded.
//   Everything under tests/ other than the two named above -- gates observe a
//     match, they do not shape it.

function walk(relative, skip) {
	const found = [];
	for (const name of readdirSync(path.join(browserRoot, relative)).sort()) {
		const childRelative = path.posix.join(relative, name);
		if (statSync(path.join(browserRoot, childRelative)).isDirectory())
			found.push(...walk(childRelative, skip));
		else if (!skip?.(childRelative, name))
			found.push(childRelative);
	}
	return found;
}

// Recomputes the surface set from the tree. Not called at import time: the
// consumers of EraFiles run per match, and an era definition should not depend
// on a directory scan succeeding.
export function deriveEraFiles() {
	const derived = [];
	for (const rule of EraSurfaceRules)
		derived.push(...(rule.files ?? walk(rule.root, rule.skip)));
	return [...new Set(derived)].sort();
}
