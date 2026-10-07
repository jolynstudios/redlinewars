// Auditor for the work graph and its ledger (graph node INF-06).
//
// Written deliberately by the coordinator rather than by the agent that builds
// the driver: the auditor and the audited must not share an author. Everything
// here is checkable by a human with git and sha256, which is the point -- the
// graph's claims about itself should not have to be taken on trust.
//
// Zero-spend, tier 0: reads files and runs git. No browser, no sidecar, no
// dotnet, no network.
//
// What this cannot check yet: that OpenRA.Browser/WORK-GRAPH.md equals a
// regeneration. That doc is produced by INF-05, which is deferred, so the check
// is absent rather than silently passing -- see the DEFERRED note at the end.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, loadGraph } from './work-graph-runner.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(testsDir, '..', '..');
const graphPath = path.join(testsDir, 'work-graph.json');
const ledgerRelative = 'OpenRA.Browser/tests/work-graph/ledger.json';
const ledgerPath = path.join(repoRoot, ledgerRelative);

const sha256 = value => createHash('sha256').update(value).digest('hex');

let checks = 0;
const failures = [];

function ok(message) {
	checks++;
	console.log(`ok: ${message}`);
}

function fail(message) {
	failures.push(message);
	console.log(`FAIL: ${message}`);
}

function expect(condition, message) {
	if (condition) ok(message);
	else fail(message);
}

// --- the ledger is a hash chain -------------------------------------------

// Recomputed from the entries themselves, so a retroactive edit anywhere
// invalidates every entry after it. Forging history then requires rewriting the
// whole tail, which is a deliberate multi-line diff rather than a slip.
function verifyChain(entries) {
	let previous = '';
	for (const [index, entry] of entries.entries()) {
		const { entryHash, chainHash, ...body } = entry;
		if (sha256(canonicalJson(body)) !== entryHash)
			return `entry ${index} (${entry.nodeId}) has a body that does not match its entryHash`;
		if (sha256(previous + entryHash) !== chainHash)
			return `entry ${index} (${entry.nodeId}) breaks the chain from its predecessor`;
		previous = chainHash;
	}
	return null;
}

// --- gates may never be weakened -------------------------------------------

// The cheapest way to turn a red node green is to loosen its gate. A pass that
// asserts fewer things than a previous pass of the same node is therefore
// treated as evidence of weakening, not of success.
function verifyNoWeakening(entries) {
	const best = new Map();
	for (const entry of entries) {
		if (entry.outcome !== 'pass')
			continue;
		const previous = best.get(entry.nodeId);
		if (previous !== undefined && entry.okLineCount < previous)
			return `${entry.nodeId} passed with ${entry.okLineCount} assertions after previously passing with ${previous}`;
		best.set(entry.nodeId, Math.max(previous ?? 0, entry.okLineCount));
	}
	return null;
}

// --- declared tiers must match what the gate actually needs ----------------

// Deliberately narrow. A first attempt grepped for the mere words "dotnet",
// "make " and "server.mjs" and immediately misdeclared six honest tier-0 nodes,
// including this file, because they MENTION those tools rather than needing
// them. A check that cries wolf gets ignored, so this only looks for evidence a
// gate actually depends on a tier: an import it cannot run without, or an
// interpreter named directly in its argv. Declaring a HIGHER tier than inferred
// is always allowed -- that is an operator choosing to spend more wall clock.
const TierImports = [
	{ tier: 3, pattern: /from\s+'@playwright\/test'/ },
	{ tier: 1, pattern: /from\s+'[^']*agent-sidecar\/dist/ }
];

function inferredTier(node, source) {
	let tier = 0;
	if (node.gate.argv[0] === 'dotnet' || node.gate.argv[0] === 'make')
		tier = Math.max(tier, 2);
	for (const { tier: marker, pattern } of TierImports) {
		if (pattern.test(source))
			tier = Math.max(tier, marker);
	}
	return tier;
}

try {
	const { graph, byId } = loadGraph(graphPath);
	ok(`work-graph.json validates (${graph.nodes.length} nodes)`);

	// --- assertion ownership ------------------------------------------------
	// The false-landing bug: three nodes shared one gate that already passed, so
	// all three landed without a line of their work existing. Two nodes claiming
	// the same success string means at most one of them is really being verified.
	const byAssertion = new Map();
	for (const node of graph.nodes) {
		const assertion = node.gate.expectStdout;
		if (typeof assertion !== 'string' || assertion.length === 0)
			continue;
		if (!byAssertion.has(assertion))
			byAssertion.set(assertion, []);
		byAssertion.get(assertion).push(node.id);
	}
	const shared = [...byAssertion.entries()].filter(([, ids]) => ids.length > 1);
	expect(shared.length === 0,
		shared.length === 0
			? 'no two nodes claim the same gate assertion'
			: `nodes share an assertion: ${shared.map(([text, ids]) => `${ids.join('+')} -> "${text}"`).join('; ')}`);

	// A node that names a gate but no assertion can land on that gate passing for
	// any reason at all. Only nodes whose gate script is dedicated to them are
	// allowed to omit one.
	const dedicated = new Set();
	for (const node of graph.nodes) {
		const script = node.gate.argv[1];
		if (node.gate.argv[0] === 'node' && graph.nodes.filter(other => other.gate.argv[1] === script).length === 1)
			dedicated.add(node.id);
	}
	const unguarded = graph.nodes.filter(node =>
		(typeof node.gate.expectStdout !== 'string' || node.gate.expectStdout.length === 0) && !dedicated.has(node.id));
	expect(unguarded.length === 0,
		unguarded.length === 0
			? 'every node sharing a gate carries its own assertion'
			: `nodes share a gate with no assertion of their own: ${unguarded.map(n => n.id).join(', ')}`);

	// --- declared tiers -----------------------------------------------------
	const misdeclared = [];
	for (const node of graph.nodes) {
		const script = node.gate.argv[1];
		if (node.gate.argv[0] !== 'node' || typeof script !== 'string' || !script.endsWith('.mjs'))
			continue;
		const absolute = path.join(testsDir, script);
		if (!existsSync(absolute))
			continue;
		const inferred = inferredTier(node, readFileSync(absolute, "utf8"));
		if (node.tier < inferred)
			misdeclared.push(`${node.id} declares tier ${node.tier} but ${script} needs tier ${inferred}`);
	}
	expect(misdeclared.length === 0,
		misdeclared.length === 0
			? 'every declared tier covers what its gate actually needs'
			: misdeclared.join('; '));

	// --- spend containment --------------------------------------------------
	// loadGraph already rejects a spending gate, so reaching here proves it. The
	// separate structural claim is that no paid node can be reached without the
	// budget ceiling, the era lock and the integrity track landing first.
	const reaches = (id, target, seen = new Set()) => {
		if (id === target) return true;
		if (seen.has(id)) return false;
		seen.add(id);
		return byId.get(id).deps.some(dep => reaches(dep, target, seen));
	};
	// INT-05 joined the guard set when runs moved to a subscription proxy: the
	// proxy resolves an unknown model down a ladder to a default, so without it a
	// rating can be published for a model that never played.
	const guards = ['SWP-03', 'ERA-02', 'INT-01', 'INT-02', 'INT-03', 'INT-04', 'INT-05', 'INF-04'];
	const ungated = [];
	for (const node of graph.nodes.filter(candidate => candidate.spend === 'provider')) {
		for (const guard of guards) {
			if (!reaches(node.id, guard))
				ungated.push(`${node.id} is not gated by ${guard}`);
		}
	}
	expect(ungated.length === 0,
		ungated.length === 0
			? 'no provider-spend node is reachable without budget, era lock, integrity and the ledger'
			: ungated.join('; '));

	// --- the ledger ---------------------------------------------------------
	if (!existsSync(ledgerPath)) {
		ok('no ledger yet: nothing to audit');
	} else {
		const entries = JSON.parse(readFileSync(ledgerPath, 'utf8'));
		expect(Array.isArray(entries), 'the ledger is an array');

		const chainError = verifyChain(entries);
		expect(chainError === null, chainError ?? `the ledger hash chain verifies across ${entries.length} entries`);

		const weakened = verifyNoWeakening(entries);
		expect(weakened === null, weakened ?? 'no gate passed with fewer assertions than it previously did');

		// Tamper fixture: the chain check must actually reject a forged history,
		// not merely pass over an honest one.
		if (entries.length > 1) {
			const forged = JSON.parse(JSON.stringify(entries));
			forged[0].outcome = forged[0].outcome === 'pass' ? 'fail' : 'pass';
			expect(verifyChain(forged) !== null, 'a tampered ledger entry is rejected by the chain check');
		}

		expect(entries.every(entry => byId.has(entry.nodeId)),
			'every ledger entry names a node that exists in the graph');

		// Append-only against the previous commit. A rewritten history shows up as
		// a gate failure rather than as a diff nobody reads.
		const previous = spawnSync('git', ['show', `HEAD~1:${ledgerRelative}`], { cwd: repoRoot, encoding: 'utf8' });
		if (previous.status !== 0) {
			ok('ledger has no committed predecessor to compare against');
		} else {
			let priorEntries = [];
			try {
				priorEntries = JSON.parse(previous.stdout);
			} catch {
				priorEntries = [];
			}
			const isPrefix = priorEntries.every((entry, index) => entries[index]?.chainHash === entry.chainHash);
			expect(isPrefix, isPrefix
				? `the ledger extends its committed predecessor (${priorEntries.length} -> ${entries.length} entries)`
				: 'the ledger is NOT an extension of its committed predecessor: history was rewritten');
		}
	}
} catch (error) {
	fail(`auditor threw: ${error.message}`);
}

// DEFERRED, stated rather than silently skipped: doc-equals-regeneration needs
// INF-05's generated WORK-GRAPH.md, which is deferred past RUN-03.
console.log('note: doc-equals-regeneration is not checked here; it arrives with INF-05.');

if (failures.length > 0) {
	console.error(`\nwork graph gate FAILED (${failures.length} of ${checks + failures.length})`);
	process.exit(1);
}
console.log(`work graph gate passed (${checks} checks)`);
