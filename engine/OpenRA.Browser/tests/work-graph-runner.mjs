// Work-graph driver: resolves the benchmark completion graph, derives node state
// from the append-only gate ledger, and prints the ready frontier.
//
// This file CANNOT spend money, and that is a property of the schema rather than
// of care taken here. Gates are declared as argv arrays and spawned with
// shell:false, so the graph cannot express `sh -c`, a pipe, or a redirect; a
// forbidden-token scan rejects the whole graph at load time if any gate could
// reach a provider; and nodes whose WORK spends are never dispatched, only their
// (free) gates are run. See assertSpendSafe below.
//
// Status is never stored. A node is `landed` because the ledger says its gate
// passed at the current input digest, never because a human wrote it down. That
// is what keeps this file and OpenRA.Browser/WORK-GRAPH.md from drifting apart.
//
// --plan is the only mode implemented here (graph node INF-03). It validates,
// computes the frontier, prints one JSON document and exits: no ledger write, no
// spawn, no file written. --run/--report land in INF-04/INF-05.

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const browserRoot = path.join(testsDir, '..');
const repoRoot = path.join(browserRoot, '..');

const usage = 'Usage: node work-graph-runner.mjs --graph <path> (--plan | --run | --explain <nodeId>)\n' +
	'                                  [--tier <0|1|2|3>] [--owner <claude|codex|human>]\n' +
	'                                  [--resume] [--only <nodeId>]';

export function argumentError(message) {
	console.error(`${message}\n${usage}`);
	process.exit(2);
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

// Key-sorted and whitespace-free, matching era-lock.mjs, so the same tree always
// produces the same digest and a regenerated artifact is a byte-for-byte no-op.
export const canonicalJson = value => {
	if (value === null || typeof value !== 'object')
		return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value))
		return `[${value.map(canonicalJson).join(',')}]`;
	return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GraphKeys = new Set(['schemaVersion', 'graphId', 'ledger', 'doc', 'terminal', 'defaults', 'budget', 'nodes']);
const NodeKeys = new Set(['id', 'title', 'owner', 'spend', 'tier', 'deps', 'rationale', 'gate',
	'watch', 'resources', 'artifacts', 'retryBudget', 'planned']);
const GateKeys = new Set(['argv', 'cwd', 'expectExit', 'expectStdout', 'strength', 'timeoutMs']);
const Owners = new Set(['claude', 'codex', 'human']);
const SpendClasses = new Set(['none', 'build', 'provider']);
const Strengths = new Set(['grep', 'unit', 'artifact', 'behavioral']);
const NodeIdPattern = /^[A-Z]{3}-[0-9]{2}$/;

// argv[0] is restricted to interpreters that cannot themselves reach a network
// service without naming a script we also validate. `npm` is deliberately absent:
// `npm run x` hides the real command from the token scan below.
const AllowedCommands = new Set(['node', 'make', 'dotnet']);

// Any of these in a gate's argv means that gate could spend real money.
const ForbiddenTokens = ['--execute', '--confirm-provider-spend', '--cap', '--play', '--fallback-strike'];

// Scripts that CAN spend, and the token that neuters each. A gate may name one
// only in company with its guard.
const GuardedScripts = [
	{ script: 'match-runner.mjs', requiresAnyOf: ['--dry-run'] },
	{ script: 'benchmark-sweep-runner.mjs', requiresAnyOf: ['--dry-run', '--scripted-fixture'] },
	{ script: 'ladder-runner.mjs', requiresAnyOf: ['--dry-run'] }
];

function assertSpendSafe(node) {
	const argv = node.gate.argv;
	for (const token of ForbiddenTokens) {
		if (argv.includes(token))
			argumentError(`work-graph: ${node.id} gate argv contains the spending token '${token}'.`);
	}
	for (const { script, requiresAnyOf } of GuardedScripts) {
		if (!argv.some(entry => entry.endsWith(script)))
			continue;
		if (!requiresAnyOf.some(guard => argv.includes(guard)))
			argumentError(`work-graph: ${node.id} gate invokes ${script} without ${requiresAnyOf.join(' or ')}.`);
	}
	// A sidecar URL in a gate means a real key-bearing sidecar could answer.
	// Scripted fixtures own their own loopback ports; they never need this flag.
	if (argv.includes('--sidecar'))
		argumentError(`work-graph: ${node.id} gate passes --sidecar; gates must not reach a live sidecar.`);
}

function assertShape(condition, message) {
	if (!condition)
		argumentError(`work-graph: ${message}`);
}

export function loadGraph(graphPath) {
	let text;
	try {
		text = readFileSync(graphPath, 'utf8');
	} catch {
		argumentError(`--graph: ${graphPath} is not readable.`);
	}

	let graph;
	try {
		graph = JSON.parse(text);
	} catch (error) {
		argumentError(`--graph: ${graphPath} is not valid JSON (${error.message}).`);
	}

	assertShape(graph !== null && typeof graph === 'object' && !Array.isArray(graph), 'graph must be a JSON object.');
	for (const key of Object.keys(graph))
		assertShape(GraphKeys.has(key), `unknown top-level key '${key}'.`);
	assertShape(graph.schemaVersion === 1, 'schemaVersion must be 1.');
	assertShape(Array.isArray(graph.nodes) && graph.nodes.length > 0, 'nodes must be a non-empty array.');

	const byId = new Map();
	for (const node of graph.nodes) {
		for (const key of Object.keys(node))
			assertShape(NodeKeys.has(key), `node ${node.id ?? '<unnamed>'}: unknown key '${key}'.`);
		assertShape(typeof node.id === 'string' && NodeIdPattern.test(node.id),
			`node id '${node.id}' must match ${NodeIdPattern}.`);
		assertShape(!byId.has(node.id), `duplicate node id '${node.id}'.`);
		assertShape(typeof node.title === 'string' && node.title.length > 0, `node ${node.id}: title is required.`);
		assertShape(Owners.has(node.owner), `node ${node.id}: owner must be one of ${[...Owners].join('|')}.`);
		assertShape(SpendClasses.has(node.spend), `node ${node.id}: spend must be one of ${[...SpendClasses].join('|')}.`);
		assertShape(Number.isInteger(node.tier) && node.tier >= 0 && node.tier <= 3, `node ${node.id}: tier must be 0-3.`);
		assertShape(Array.isArray(node.deps), `node ${node.id}: deps must be an array.`);
		// Every node must say why it exists. A graph of bare ids is unreviewable.
		assertShape(Array.isArray(node.rationale) && node.rationale.length > 0,
			`node ${node.id}: at least one rationale line is required.`);

		const gate = node.gate;
		assertShape(gate !== null && typeof gate === 'object' && !Array.isArray(gate), `node ${node.id}: gate is required.`);
		for (const key of Object.keys(gate))
			assertShape(GateKeys.has(key), `node ${node.id}: unknown gate key '${key}'.`);
		assertShape(Array.isArray(gate.argv) && gate.argv.length >= 2 &&
			gate.argv.every(entry => typeof entry === 'string'), `node ${node.id}: gate.argv must be a string array.`);
		assertShape(AllowedCommands.has(gate.argv[0]),
			`node ${node.id}: gate.argv[0] '${gate.argv[0]}' must be one of ${[...AllowedCommands].join('|')}.`);
		assertShape(Strengths.has(gate.strength), `node ${node.id}: gate.strength must be one of ${[...Strengths].join('|')}.`);
		assertShape(gate.cwd === undefined || gate.cwd === 'tests' || gate.cwd === 'repo',
			`node ${node.id}: gate.cwd must be 'tests' or 'repo'.`);
		assertSpendSafe(node);

		byId.set(node.id, node);
	}

	for (const node of graph.nodes) {
		for (const dep of node.deps)
			assertShape(byId.has(dep), `node ${node.id}: dependency '${dep}' does not exist.`);
	}
	assertShape(graph.terminal === undefined || byId.has(graph.terminal),
		`terminal '${graph.terminal}' does not exist.`);

	assertAcyclic(graph, byId);
	return { graph, byId };
}

function assertAcyclic(graph, byId) {
	const indegree = new Map([...byId.keys()].map(id => [id, 0]));
	for (const node of graph.nodes)
		indegree.set(node.id, node.deps.length);

	const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
	const ordered = [];
	while (ready.length > 0) {
		const id = ready.shift();
		ordered.push(id);
		for (const node of graph.nodes) {
			if (!node.deps.includes(id))
				continue;
			indegree.set(node.id, indegree.get(node.id) - 1);
			if (indegree.get(node.id) === 0) {
				ready.push(node.id);
				ready.sort();
			}
		}
	}

	if (ordered.length !== byId.size) {
		const cyclic = [...byId.keys()].filter(id => !ordered.includes(id)).sort();
		argumentError(`work-graph: dependency cycle among ${cyclic.join(', ')}.`);
	}
	return ordered;
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

// Hash of everything a node's result depends on. A landed node whose inputs
// moved is `stale`, not `landed`: the ledger records a pass against a tree, not
// against a promise.
function inputsDigest(node) {
	const entries = {};
	for (const watched of node.watch ?? [node.gate.argv[1] ?? node.id])
		entries[watched] = digestPath(path.join(repoRoot, watched));
	return sha256(canonicalJson(entries));
}

// A watched directory hashes to the sorted (path, content-hash) list of the
// files under it, so adding, deleting or editing any one of them moves the
// digest. Hashing only regular files would let a new gate appear unnoticed,
// which is precisely what INF-01 exists to prevent.
function digestPath(absolute) {
	let stats;
	try {
		stats = statSync(absolute);
	} catch {
		return null;
	}
	if (stats.isFile())
		return sha256(readFileSync(absolute));
	if (!stats.isDirectory())
		return null;

	const files = {};
	const walk = directory => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules')
				continue;
			const child = path.join(directory, entry.name);
			if (entry.isDirectory())
				walk(child);
			else if (entry.isFile())
				files[path.relative(absolute, child)] = sha256(readFileSync(child));
		}
	};
	walk(absolute);
	return sha256(canonicalJson(files));
}

// True when the gate names a script under tests/ that has not been written yet.
// Only `node <script>` gates are checkable this way; make/dotnet targets are
// assumed present and will report for themselves.
function gateCannotVerify(node) {
	const [command, script] = node.gate.argv;
	if (command !== 'node' || typeof script !== 'string' || !script.endsWith('.mjs'))
		return false;
	const absolute = path.join(testsDir, script);
	if (!existsSync(absolute))
		return true;

	// A node that reuses an existing gate would otherwise land for free the moment
	// that gate passes for unrelated reasons -- three INT nodes did exactly that,
	// all sharing benchmark-sweep-gate.mjs. So a node's expectStdout must appear
	// verbatim in its gate's source. The gate is the specification: until it
	// contains an assertion specific to this node, there is nothing here that
	// could verify this node, and the node is awaiting work rather than passing.
	if (typeof node.gate.expectStdout === 'string' && node.gate.expectStdout.length > 0)
		return !readFileSync(absolute, 'utf8').includes(node.gate.expectStdout);
	return false;
}

export function readLedger(graph, graphPath) {
	const ledgerPath = path.join(path.dirname(graphPath), graph.ledger ?? 'work-graph/ledger.json');
	if (!existsSync(ledgerPath))
		return [];
	let entries;
	try {
		entries = JSON.parse(readFileSync(ledgerPath, 'utf8'));
	} catch (error) {
		// Never guess at history. An unreadable ledger would silently un-land
		// every node and invite a re-run of work that already passed.
		argumentError(`ledger ${ledgerPath} is unreadable (${error.message}); refusing to guess at graph history.`);
	}
	assertShape(Array.isArray(entries), `ledger ${ledgerPath} must contain an array.`);
	return entries;
}

export function deriveStates(graph, byId, ledger, options = {}) {
	const maxTier = options.tier ?? 1;
	const latest = new Map();
	const attempts = new Map();
	for (const entry of ledger) {
		if (entry.outcome === 'pass' || entry.outcome === 'fail')
			attempts.set(entry.nodeId, (attempts.get(entry.nodeId) ?? 0) + 1);
		latest.set(entry.nodeId, entry);
	}

	const states = new Map();
	// Topological order guarantees a node's dependencies are already resolved.
	const ordered = assertAcyclic(graph, byId);
	for (const id of ordered) {
		const node = byId.get(id);
		const entry = latest.get(id);
		const retryBudget = node.retryBudget ?? graph.defaults?.retryBudget ?? 2;

		let state;
		// Checked BEFORE any recorded result is honoured. A pass logged by a gate
		// that never contained this node's assertion is not evidence about this
		// node, and trusting it is how three INT nodes landed without a line of
		// their work existing. Undone work is also not a failure: running the gate
		// would only rediscover that nobody has written it, while burning fix
		// attempts and eventually escalating noise to a human.
		if (gateCannotVerify(node))
			state = 'awaiting-work';
		else if (entry?.outcome === 'pass')
			state = entry.inputsDigest === inputsDigest(node) ? 'landed' : 'stale';
		else if (entry?.outcome === 'fail')
			state = (attempts.get(id) ?? 0) >= retryBudget ? 'escalated' : 'failing';
		else
			state = 'pending';

		const blockedBy = node.deps.filter(dep => states.get(dep) !== 'landed');
		if (state !== 'landed' && state !== 'awaiting-work' && blockedBy.length > 0)
			state = 'blocked';
		else if (state !== 'landed' && state !== 'escalated' && state !== 'awaiting-work' && node.tier > maxTier)
			state = 'deferred';
		else if (state === 'pending' || state === 'stale')
			state = 'ready';

		states.set(id, state);
	}
	return states;
}

// ---------------------------------------------------------------------------
// Execution (INF-04)
// ---------------------------------------------------------------------------

// dotnet is not on PATH in this environment; the SDK lives in ~/.dotnet. A tier
// probe that only consulted PATH would report tier 2 unavailable and censor
// every dotnet gate, which reads exactly like "nothing to do here".
function resolveDotnet() {
	if (spawnSync('dotnet', ['--version'], { encoding: 'utf8' }).status === 0)
		return 'dotnet';
	const fallback = path.join(process.env.HOME ?? '', '.dotnet', 'dotnet');
	if (existsSync(fallback) && spawnSync(fallback, ['--version'], { encoding: 'utf8' }).status === 0)
		return fallback;
	return null;
}

export function probeTiers() {
	const dotnet = resolveDotnet();
	return {
		0: { available: true, reason: null },
		1: existsSync(path.join(browserRoot, 'agent-sidecar', 'dist'))
			? { available: true, reason: null }
			: { available: false, reason: 'agent-sidecar/dist is missing; run npm run build' },
		2: dotnet !== null
			? { available: true, reason: null, dotnet }
			: { available: false, reason: 'no usable dotnet on PATH or in ~/.dotnet' },
		3: existsSync(path.join(repoRoot, 'bin-browser', 'AppBundle', 'index.html')) &&
			existsSync(path.join(repoRoot, 'Support', 'Content', 'ra', 'v2'))
			? { available: true, reason: null }
			: { available: false, reason: 'bin-browser/AppBundle or Support/Content/ra/v2 is missing' }
	};
}

function ledgerPathFor(graph, graphPath) {
	return path.join(path.dirname(graphPath), graph.ledger ?? 'work-graph/ledger.json');
}

// Temp file plus rename is atomic on one filesystem: a crash mid-write can never
// leave a torn ledger, which would otherwise un-land every node behind it.
function appendLedger(ledgerFile, entries, entry) {
	const previous = entries.length > 0 ? entries[entries.length - 1].chainHash : '';
	const body = { ...entry };
	const entryHash = sha256(canonicalJson(body));
	const sealed = { ...body, entryHash, chainHash: sha256(previous + entryHash) };
	const next = [...entries, sealed];

	mkdirSync(path.dirname(ledgerFile), { recursive: true });
	const temporary = `${ledgerFile}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(next, null, 1)}\n`);
	renameSync(temporary, ledgerFile);
	return sealed;
}

function gitHead() {
	const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
	return result.status === 0 ? result.stdout.trim() : null;
}

function treeDirty() {
	const result = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
	return result.status === 0 ? result.stdout.trim().length > 0 : null;
}

export function runGate(graph, node, tiers) {
	const tier = tiers[node.tier];
	if (!tier.available) {
		// Censored, never failed: a missing prerequisite measured our environment,
		// not the node, and must not consume a fix attempt.
		return { outcome: 'infrastructure-censored', exitCode: null, stdout: '', durationMs: 0, note: tier.reason };
	}

	const argv = [...node.gate.argv];
	if (argv[0] === 'dotnet' && tier.dotnet)
		argv[0] = tier.dotnet;

	const cwd = (node.gate.cwd ?? graph.defaults?.cwd ?? 'tests') === 'tests' ? testsDir : repoRoot;
	const timeout = node.gate.timeoutMs ?? graph.defaults?.timeoutMs ?? 600000;

	// Provider keys are stripped from every child. This is defence in depth, not
	// the control: a gate reaching a separately-running key-bearing sidecar would
	// be unaffected, which is why --sidecar is refused at graph-load time.
	const env = { ...process.env };
	for (const key of ['OPENROUTER_API_KEY', 'openrouter', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
		delete env[key];

	const started = Date.now();
	const result = spawnSync(argv[0], argv.slice(1), {
		cwd, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', shell: false
	});
	const durationMs = Date.now() - started;
	const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;

	if (result.error?.code === 'ETIMEDOUT') {
		// A tier-0/1 gate that hangs is a real defect; a browser or dotnet gate
		// timing out is usually the machine, so it is censored rather than failed.
		return {
			outcome: node.tier <= 1 ? 'fail' : 'infrastructure-censored',
			exitCode: null, stdout, durationMs, note: `gate exceeded ${timeout}ms`
		};
	}

	const expectedExit = node.gate.expectExit ?? 0;
	const exitOk = result.status === expectedExit;
	const stdoutOk = node.gate.expectStdout === undefined || stdout.includes(node.gate.expectStdout);
	return {
		outcome: exitOk && stdoutOk ? 'pass' : 'fail',
		exitCode: result.status,
		stdout,
		durationMs,
		note: exitOk && !stdoutOk ? `stdout did not contain '${node.gate.expectStdout}'` : null
	};
}

function executeRun(graph, byId, graphPath, options) {
	const ledgerFile = ledgerPathFor(graph, graphPath);
	let entries = readLedger(graph, graphPath);

	// A fresh ledger silently un-lands every node. Here that destroys evidence
	// rather than money, but the reasoning is ladder-runner's and so is the guard.
	if (entries.length > 0 && !options.resume)
		argumentError(`a ledger already exists at ${ledgerFile}; pass --resume to continue it, or move it aside deliberately.`);

	const lockFile = `${ledgerFile}.lock`;
	if (existsSync(lockFile)) {
		const holder = readFileSync(lockFile, 'utf8').trim();
		argumentError(`ledger is locked by pid ${holder}; two drivers must not append to one hash chain.`);
	}
	mkdirSync(path.dirname(ledgerFile), { recursive: true });
	writeFileSync(lockFile, String(process.pid));

	const tiers = probeTiers();
	const head = gitHead();
	const dirty = treeDirty();
	console.log(`[work-graph] ${graph.graphId} @ ${head?.slice(0, 8) ?? 'unknown'}${dirty ? ' (dirty)' : ''}`);
	for (const tier of [0, 1, 2, 3])
		console.log(`[work-graph] tier ${tier}: ${tiers[tier].available ? 'ok' : `unavailable (${tiers[tier].reason})`}`);

	let censoredStreak = 0;
	let escalations = 0;
	let attempted = 0;
	const counts = { pass: 0, fail: 0, 'infrastructure-censored': 0 };

	try {
		// Recompute the frontier after every node: a pass can unblock dependants,
		// and running against a stale frontier would skip them until the next call.
		for (;;) {
			const states = deriveStates(graph, byId, entries, { tier: options.tier });
			const rank = { none: 0, build: 1, provider: 2 };
			const ready = [...states.entries()]
				// `failing` is dispatchable: a node with retry budget left IS the fix
			// node. Only `escalated` leaves the frontier for good.
			.filter(([, state]) => state === 'ready' || state === 'failing')
				.map(([id]) => byId.get(id))
				.filter(node => node.spend !== 'provider' && node.owner !== 'human')
				.filter(node => options.only === null || node.id === options.only)
				.sort((a, b) => a.tier - b.tier || rank[a.spend] - rank[b.spend] || a.id.localeCompare(b.id));

			const node = ready.find(candidate => !options.attempted.has(candidate.id));
			if (node === undefined)
				break;
			options.attempted.add(node.id);

			console.log(`[work-graph] ${node.id} (tier ${node.tier}, ${node.owner}, ${node.gate.strength}) -> ${node.gate.argv.join(' ')}`);
			const result = runGate(graph, node, tiers);
			attempted++;
			counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;

			if (result.stdout.trim().length > 0)
				console.log(result.stdout.trimEnd());

			const okLineCount = result.stdout.split('\n').filter(line => line.startsWith('ok:') || line.startsWith('OK ')).length;
			const sealed = appendLedger(ledgerFile, entries, {
				nodeId: node.id,
				outcome: result.outcome,
				engineCommit: head,
				treeDirty: dirty,
				inputsDigest: inputsDigest(node),
				gateScriptDigest: digestPath(path.join(testsDir, node.gate.argv[1] ?? '')),
				gateArgv: node.gate.argv,
				exitCode: result.exitCode,
				durationMs: result.durationMs,
				okLineCount,
				stdoutDigest: sha256(result.stdout),
				stdoutTail: result.stdout.split('\n').filter(Boolean).slice(-3).join('\n') || null,
				note: result.note ?? null
			});
			entries = [...entries, sealed];

			console.log(`[work-graph] ${node.id}: ${result.outcome} in ${(result.durationMs / 1000).toFixed(1)}s` +
				`${result.note ? ` — ${result.note}` : ''}`);

			if (result.outcome === 'infrastructure-censored') {
				censoredStreak++;
				if (censoredStreak >= 3) {
					console.error('[work-graph] stopping: 3 consecutive infrastructure-censored nodes; someone must intervene.');
					return 1;
				}
				continue;
			}
			censoredStreak = 0;

			if (result.outcome === 'fail') {
				const after = deriveStates(graph, byId, entries, { tier: options.tier });
				if (after.get(node.id) === 'escalated') {
					escalations++;
					console.error(`[work-graph] ${node.id} ESCALATED to human after exhausting its retry budget.`);
					if (escalations >= 3) {
						console.error('[work-graph] stopping: 3 escalations in one run suggests something systemic.');
						return 1;
					}
				}
			}
		}
	} finally {
		try {
			unlinkSync(lockFile);
		} catch { /* the lock is advisory; a failed cleanup must not mask the real result */ }
	}

	const final = deriveStates(graph, byId, entries, { tier: options.tier });
	const landed = [...final.values()].filter(state => state === 'landed').length;
	console.log(`[work-graph] ${attempted} attempted (${counts.pass} pass, ${counts.fail} fail, ` +
		`${counts['infrastructure-censored']} censored); graph ${landed}/${graph.nodes.length} landed.`);
	return 0;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function planDocument(graph, byId, states, options) {
	const rank = { none: 0, build: 1, provider: 2 };
	const frontier = [...states.entries()]
		// `failing` is dispatchable: a node with retry budget left IS the fix node.
		// Only `escalated` leaves the frontier for good.
		.filter(([, state]) => state === 'ready' || state === 'failing')
		.map(([id]) => byId.get(id))
		// Cheapest and freest first, deterministically: two runs of the same graph
		// must attempt the same nodes in the same order.
		.sort((a, b) => a.tier - b.tier || rank[a.spend] - rank[b.spend] || a.id.localeCompare(b.id))
		.map(node => ({
			id: node.id, title: node.title, owner: node.owner, spend: node.spend,
			tier: node.tier, strength: node.gate.strength,
			gate: node.gate.argv.join(' '),
			// A provider node is surfaced, never dispatched: only a human authorises
			// the work, and the driver merely watches for its gate to pass.
			dispatchable: node.spend !== 'provider' && node.owner !== 'human'
		}));

	const counts = {};
	for (const state of states.values())
		counts[state] = (counts[state] ?? 0) + 1;

	return {
		graphId: graph.graphId,
		terminal: graph.terminal ?? null,
		terminalState: graph.terminal ? states.get(graph.terminal) : null,
		tier: options.tier,
		nodeCount: graph.nodes.length,
		counts,
		frontier,
		blocked: [...states.entries()].filter(([, s]) => s === 'blocked')
			.map(([id]) => ({ id, waitingOn: byId.get(id).deps.filter(d => states.get(d) !== 'landed') })),
		escalated: [...states.entries()].filter(([, s]) => s === 'escalated').map(([id]) => id)
	};
}

function explain(graph, byId, states, nodeId) {
	const node = byId.get(nodeId);
	if (node === undefined)
		argumentError(`--explain: no node '${nodeId}'.`);
	const cwd = node.gate.cwd ?? graph.defaults?.cwd ?? 'tests';
	return {
		id: node.id, title: node.title, state: states.get(node.id),
		owner: node.owner, spend: node.spend, tier: node.tier,
		rationale: node.rationale,
		waitingOn: node.deps.filter(dep => states.get(dep) !== 'landed'),
		dependencies: node.deps.map(dep => ({ id: dep, state: states.get(dep) })),
		reproduce: `cd ${cwd === 'tests' ? 'OpenRA.Browser/tests' : '.'} && ${node.gate.argv.join(' ')}`,
		gateStrength: node.gate.strength,
		inputsDigest: inputsDigest(node)
	};
}

function main(argv) {
	let graphPath = null;
	let mode = null;
	let explainId = null;
	let tier = 1;
	let owner = null;
	let resume = false;
	let only = null;

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		// Unknown flags must never fall through to a default: a typo'd mode should
		// stop the run, not quietly pick one.
		if (token === '--graph' && index + 1 < argv.length) graphPath = argv[++index];
		else if (token === '--plan') { if (mode) argumentError('choose exactly one mode.'); mode = 'plan'; }
		else if (token === '--run') { if (mode) argumentError('choose exactly one mode.'); mode = 'run'; }
		else if (token === '--resume') resume = true;
		else if (token === '--only' && index + 1 < argv.length) only = argv[++index];
		else if (token === '--explain' && index + 1 < argv.length) {
			if (mode) argumentError('choose exactly one mode.');
			mode = 'explain';
			explainId = argv[++index];
		} else if (token === '--tier' && index + 1 < argv.length) tier = Number(argv[++index]);
		else if (token === '--owner' && index + 1 < argv.length) owner = argv[++index];
		else argumentError(`unknown or incomplete argument '${token}'.`);
	}

	if (graphPath === null)
		argumentError('--graph <path> is required.');
	if (mode === null)
		argumentError('choose exactly one of --plan, --run or --explain <nodeId>.');
	if (!Number.isInteger(tier) || tier < 0 || tier > 3)
		argumentError('--tier must be 0, 1, 2 or 3.');
	if (owner !== null && !Owners.has(owner))
		argumentError(`--owner must be one of ${[...Owners].join('|')}.`);

	const resolved = path.resolve(process.cwd(), graphPath);
	const { graph, byId } = loadGraph(resolved);

	if (mode === 'run') {
		if (only !== null && !byId.has(only))
			argumentError(`--only: no node '${only}'.`);
		process.exit(executeRun(graph, byId, resolved, { tier, resume, only, attempted: new Set() }));
	}

	const states = deriveStates(graph, byId, readLedger(graph, resolved), { tier });

	if (mode === 'explain') {
		console.log(JSON.stringify(explain(graph, byId, states, explainId), null, 1));
		return;
	}

	const document = planDocument(graph, byId, states, { tier });
	if (owner !== null)
		document.frontier = document.frontier.filter(node => node.owner === owner);
	console.log(JSON.stringify(document, null, 1));
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	main(process.argv.slice(2));
