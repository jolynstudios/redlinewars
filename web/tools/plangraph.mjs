#!/usr/bin/env node
// STEELSEED — tools/plangraph
// The executable form of the plan's self-resolution loop and the failure modes that loop
// exists to catch. `plan/graph.json` is the source of truth for build
// order; this runner DERIVES every node status by EXECUTING gates and writes the result
// back only as a cache. It never trusts a status it reads.
//
// Four rules make this more than a task list:
//
//   1. THE FALSIFIABILITY LATCH — §10.1 rule 1, "a gate must be provably able to fail".
//      A gate counts only once someone broke the thing on purpose and WITNESSED the gate
//      go red. A passing gate with `falsifiable: false` may NOT promote its node; the node
//      is reported UNPROVEN_GATE and named. Only `falsify --gate=G --broke="..."` flips the
//      flag, and it must record what was broken to produce the red. §10.1 reports that on a
//      sibling project roughly half of 29 gate-failure tickets were agents grading their own
//      homework; this latch is what makes that mechanically impossible here.
//   2. §0.2 demands a gate for every node. A gate with kind "undefined" has no command, so
//      it can never pass and its node can never be VERIFIED — reported UNGATED, loudly.
//      That is a FINDING, not a pass.
//   3. A "subjective" gate is a critic's or a human's judgement. This runner may NEVER pass
//      one; it reports BLOCKED_ON_CRITIC and stops. A recorded critic verdict is honoured
//      only when it is attributed: `lastResult.ok === true` AND `lastResult.judgedBy` set by
//      the critic. The runner never writes that field.
//   4. §10.4 — at `policy.escalateAfterFailures` consecutive failures a node escalates to
//      the lead and the runner STOPS retrying it. It may never split a node, weaken a gate
//      or mark anything green by fiat. Nothing in this file can set a gate green except the
//      gate's own command exiting 0.
//
// Auto-repair (§10.1 / §10.5): a red gate writes or appends `issues/<node>-<n>.md` with the
// repro command and the measured tail, increments the node's failure count, and a regression
// on a cached-VERIFIED node cascades BLOCKED to its full TRANSITIVE dependent closure.
//
// Usage:
//   node tools/plangraph.mjs status
//   node tools/plangraph.mjs run    [--node=id] [--dry-run] [--no-sweep] [--verbose]
//                                   [--timeout-ms=n]
//   node tools/plangraph.mjs loop   [--max-passes=n] [--dry-run] [--no-sweep] [--verbose]
//                                   [--timeout-ms=n]
//   node tools/plangraph.mjs render [--out=path]
//   node tools/plangraph.mjs insert --id=x --deps=a,b --dir=d --discovered-by="who/when"
//                                   [--tier=n] [--owns="..."] [--gate-spec="..."]
//   node tools/plangraph.mjs falsify --gate=g --broke="what was broken to make it go red"
//                                   [--witness=who] [--red="the red output that was seen"]
//
// Exit codes. status/run/loop mirror the settle state, so a Makefile can branch on it:
//   0 ALL_GREEN   1 RED   2 usage or graph error   3 BLOCKED_ON_HUMAN
//   4 BLOCKED_ON_CRITIC   5 UNGATED
// render/insert/falsify exit 0 on success, 2 on a usage or graph error.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const TOOL = 'plangraph'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME_ROOT = resolve(WEB_ROOT, '..')
const GRAPH_PATH = join(GAME_ROOT, 'plan', 'graph.json')
const PLAN_PATH = join(GAME_ROOT, 'PLAN.md')
const ISSUES_DIR = join(GAME_ROOT, 'issues')

const DEFAULT_TIMEOUT_MS = 600000
const DEFAULT_MAX_PASSES = 8
const TICKET_TAIL_LINES = 40
const CACHE_TAIL_CHARS = 240
const CAPTURE_CAP = 64 * 1024

/** Node statuses. Derived, never read from the file. */
const S = Object.freeze({
	UNSTARTED: 'UNSTARTED',
	BLOCKED: 'BLOCKED',
	BLOCKED_ON_LEAD: 'BLOCKED_ON_LEAD',
	RED: 'RED',
	UNGATED: 'UNGATED',
	READY: 'READY',
	BLOCKED_ON_CRITIC: 'BLOCKED_ON_CRITIC',
	UNPROVEN_GATE: 'UNPROVEN_GATE',
	VERIFIED: 'VERIFIED',
})

/** The five terminal settle states of the loop, and the exit code each reports. */
const SETTLE_EXIT = Object.freeze({
	ALL_GREEN: 0,
	RED: 1,
	BLOCKED_ON_HUMAN: 3,
	BLOCKED_ON_CRITIC: 4,
	UNGATED: 5,
})

const COMMANDS = new Set(['status', 'run', 'loop', 'render', 'insert', 'falsify'])
const VALUE_FLAGS = new Set([
	'node', 'max-passes', 'timeout-ms', 'out',
	'id', 'deps', 'dir', 'discovered-by', 'tier', 'owns', 'gate-spec',
	'gate', 'broke', 'witness', 'red',
])
const BOOL_FLAGS = new Set(['dry-run', 'no-sweep', 'verbose', 'help'])

/** Canonical key order, so a written-back cache keeps graph.json diff-readable. */
const ROOT_KEY_ORDER = ['version', 'about', 'policy', 'nodes']
const NODE_KEY_ORDER = [
	'id', 'tier', 'dir', 'deps', 'status', 'failures', 'lastRun',
	'discoveredBy', 'owns', 'findings', 'gates', 'knownDefects',
	'humanDecision', 'blockedBy', 'openTickets', 'unblocks', 'notes',
]
const GATE_KEY_ORDER = [
	'id', 'kind', 'cwd', 'cmd', 'spec', 'falsifiable', 'falsifiedBy',
	'believedFailing', 'lastResult',
]

class UsageError extends Error {}

const argv = process.argv.slice(2)
try {
	process.exit(await main(argv))
} catch (error) {
	if (error instanceof UsageError) {
		console.error(`${TOOL}: ${error.message}`)
		process.exit(2)
	}
	throw error
}

async function main(args) {
	const { command, flags } = parseArgs(args)
	if (flags.has('help') || command == null) {
		printHelp()
		return command == null && !flags.has('help') ? 2 : 0
	}

	const options = {
		dryRun: flags.has('dry-run'),
		sweep: !flags.has('no-sweep'),
		verbose: flags.has('verbose'),
		timeoutMs: flags.has('timeout-ms')
			? positiveInteger(flags.get('timeout-ms'), 'timeout-ms')
			: DEFAULT_TIMEOUT_MS,
	}

	switch (command) {
		case 'status':
			return commandStatus()
		case 'run':
			return await commandRun(flags, options)
		case 'loop':
			return await commandLoop(flags, options)
		case 'render':
			return commandRender(flags)
		case 'insert':
			return commandInsert(flags, options)
		case 'falsify':
			return commandFalsify(flags, options)
		default:
			throw new UsageError(`unknown command '${command}'`)
	}
}

function parseArgs(args) {
	const flags = new Map()
	let command = null
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (!arg.startsWith('--')) {
			if (command != null)
				throw new UsageError(`unexpected second positional argument '${arg}'`)
			if (!COMMANDS.has(arg))
				throw new UsageError(
					`unknown command '${arg}'; expected one of ${[...COMMANDS].join(', ')}`,
				)
			command = arg
			continue
		}

		const body = arg.slice(2)
		const eq = body.indexOf('=')
		const name = eq < 0 ? body : body.slice(0, eq)
		if (VALUE_FLAGS.has(name)) {
			const value = eq < 0 ? args[++i] : body.slice(eq + 1)
			if (value == null || value === '')
				throw new UsageError(`--${name} requires a value`)
			flags.set(name, value)
		} else if (BOOL_FLAGS.has(name)) {
			flags.set(name, true)
		} else {
			throw new UsageError(`unknown flag --${name}`)
		}
	}
	return { command, flags }
}

function printHelp() {
	console.log(
		`${TOOL} — drive plan/graph.json\n` +
		'\n' +
		'  status                       derive and print the whole graph, run nothing\n' +
		'  run [--node=id]              one pass: execute eligible gates, update state\n' +
		'  loop [--max-passes=n]        passes until the graph settles or stops progressing\n' +
		'  render [--out=path]          write PLAN.md as a rendered VIEW of the graph\n' +
		'  insert --id=x --deps=a,b --dir=d --discovered-by="..." [--tier=n] [--owns=...]\n' +
		'                               [--gate-spec=...]   add a discovered node (§10)\n' +
		'  falsify --gate=g --broke="..." [--witness=w] [--red=...]\n' +
		'                               record a WITNESSED red (§10.1 rule 1)\n' +
		'\n' +
		'  --dry-run    execute gates but persist nothing (no graph write, no tickets)\n' +
		'  --no-sweep   skip the §10.5 regression sweep of cached-VERIFIED nodes\n' +
		'  --verbose    stream gate output as it happens\n' +
		'  --timeout-ms=n  per-gate wall clock, default ' + DEFAULT_TIMEOUT_MS + '\n' +
		'\n' +
		'exit: 0 ALL_GREEN  1 RED  2 usage/graph error  3 BLOCKED_ON_HUMAN\n' +
		'      4 BLOCKED_ON_CRITIC  5 UNGATED',
	)
}

// ---------------------------------------------------------------------------
// graph load / validate / serialize
// ---------------------------------------------------------------------------

function loadGraph() {
	let raw
	try {
		raw = readFileSync(GRAPH_PATH, 'utf8')
	} catch (error) {
		throw new UsageError(`cannot read ${rel(GRAPH_PATH)}: ${error.message}`)
	}

	let graph
	try {
		graph = JSON.parse(raw)
	} catch (error) {
		throw new UsageError(`${rel(GRAPH_PATH)} is not valid JSON: ${error.message}`)
	}

	if (graph == null || typeof graph !== 'object' || !Array.isArray(graph.nodes))
		throw new UsageError(`${rel(GRAPH_PATH)} has no 'nodes' array`)

	const seen = new Set()
	for (const node of graph.nodes) {
		if (node == null || typeof node !== 'object' || typeof node.id !== 'string')
			throw new UsageError(`${rel(GRAPH_PATH)} contains a node with no string id`)
		if (seen.has(node.id))
			throw new UsageError(`duplicate node id '${node.id}'`)
		seen.add(node.id)
		if (node.deps != null && !Array.isArray(node.deps))
			throw new UsageError(`node '${node.id}': deps must be an array`)
		if (node.gates != null && !Array.isArray(node.gates))
			throw new UsageError(`node '${node.id}': gates must be an array`)
	}
	for (const node of graph.nodes)
		for (const dep of node.deps ?? [])
			if (!seen.has(dep))
				throw new UsageError(`node '${node.id}' depends on unknown node '${dep}'`)

	graph.policy = graph.policy ?? {}
	return graph
}

function policyOf(graph) {
	const p = graph.policy ?? {}
	return {
		escalateAfterFailures: Number.isSafeInteger(p.escalateAfterFailures) && p.escalateAfterFailures > 0
			? p.escalateAfterFailures
			: 3,
		cascadeBlockOnRegression: p.cascadeBlockOnRegression !== false,
		requireFalsifiableToVerify: p.requireFalsifiableToVerify !== false,
	}
}

/** Deterministic topological order: tier first, then declaration order. Cycles are fatal. */
function topoOrder(graph) {
	const nodes = graph.nodes
	const byId = new Map(nodes.map(n => [n.id, n]))
	const rank = new Map(nodes.map((n, i) => [n.id, [Number(n.tier ?? 0), i]]))
	const indegree = new Map(nodes.map(n => [n.id, (n.deps ?? []).length]))
	const dependents = new Map(nodes.map(n => [n.id, []]))
	for (const node of nodes)
		for (const dep of node.deps ?? [])
			dependents.get(dep).push(node.id)

	const byRank = (a, b) => {
		const ra = rank.get(a)
		const rb = rank.get(b)
		return ra[0] - rb[0] || ra[1] - rb[1]
	}

	const ready = nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id).sort(byRank)
	const order = []
	while (ready.length > 0) {
		const id = ready.shift()
		order.push(byId.get(id))
		for (const next of dependents.get(id)) {
			indegree.set(next, indegree.get(next) - 1)
			if (indegree.get(next) === 0) {
				ready.push(next)
				ready.sort(byRank)
			}
		}
	}

	if (order.length !== nodes.length) {
		const stuck = nodes.filter(n => !order.includes(n)).map(n => n.id)
		throw new UsageError(`dependency cycle in ${rel(GRAPH_PATH)} among: ${stuck.join(', ')}`)
	}
	return order
}

/** Full transitive dependent closure of one node — the §10.5 cascade set. */
function transitiveDependents(graph, id) {
	const direct = new Map(graph.nodes.map(n => [n.id, []]))
	for (const node of graph.nodes)
		for (const dep of node.deps ?? [])
			direct.get(dep).push(node.id)

	const out = []
	const seen = new Set([id])
	const queue = [...(direct.get(id) ?? [])]
	while (queue.length > 0) {
		const next = queue.shift()
		if (seen.has(next))
			continue
		seen.add(next)
		out.push(next)
		queue.push(...(direct.get(next) ?? []))
	}
	return out
}

function orderObject(object, order) {
	const out = {}
	for (const key of order)
		if (Object.hasOwn(object, key))
			out[key] = object[key]
	for (const key of Object.keys(object))
		if (!Object.hasOwn(out, key))
			out[key] = object[key]
	return out
}

/**
 * Emit graph.json in the shape the file is already written in: 2-space indent, long string
 * arrays one element per line, every gate on exactly ONE line. A gate result therefore
 * shows up as a one-line diff instead of reflowing the file.
 */
function serializeGraph(graph) {
	const ordered = orderObject(graph, ROOT_KEY_ORDER)
	const lines = ['{']
	const keys = Object.keys(ordered)
	keys.forEach((key, index) => {
		const trailing = index === keys.length - 1 ? '' : ','
		if (key === 'nodes' && Array.isArray(ordered.nodes)) {
			lines.push(`${pad(1)}"nodes": [`)
			ordered.nodes.forEach((node, nodeIndex) => {
				const nodeTail = nodeIndex === ordered.nodes.length - 1 ? '' : ','
				lines.push(...emitNode(node, 2, nodeTail))
			})
			lines.push(`${pad(1)}]${trailing}`)
			return
		}
		lines.push(...emitEntry(key, ordered[key], 1, trailing, false))
	})
	lines.push('}')
	return `${lines.join('\n')}\n`
}

function emitNode(node, depth, trailing) {
	const ordered = orderObject(node, NODE_KEY_ORDER)
	const keys = Object.keys(ordered)
	const lines = [`${pad(depth)}{`]
	keys.forEach((key, index) => {
		const tail = index === keys.length - 1 ? '' : ','
		lines.push(...emitEntry(key, ordered[key], depth + 1, tail, key === 'gates'))
	})
	lines.push(`${pad(depth)}}${trailing}`)
	return lines
}

function emitEntry(key, value, depth, trailing, inlineChildren) {
	const prefix = `${pad(depth)}${JSON.stringify(key)}: `
	if (Array.isArray(value)) {
		if (canInlineArray(value))
			return [`${prefix}${inlineValue(value)}${trailing}`]
		const lines = [`${prefix}[`]
		value.forEach((item, index) => {
			const tail = index === value.length - 1 ? '' : ','
			if (inlineChildren || isScalar(item))
				lines.push(`${pad(depth + 1)}${inlineValue(item, key === 'gates' ? GATE_KEY_ORDER : null)}${tail}`)
			else
				lines.push(...emitNode(item, depth + 1, tail))
		})
		lines.push(`${pad(depth)}]${trailing}`)
		return lines
	}
	if (value !== null && typeof value === 'object') {
		const keys = Object.keys(value)
		const lines = [`${prefix}{`]
		keys.forEach((childKey, index) => {
			const tail = index === keys.length - 1 ? '' : ','
			lines.push(...emitEntry(childKey, value[childKey], depth + 1, tail, false))
		})
		lines.push(`${pad(depth)}}${trailing}`)
		return lines
	}
	return [`${prefix}${inlineValue(value)}${trailing}`]
}

function canInlineArray(value) {
	if (!value.every(isScalar))
		return false
	if (value.length <= 1)
		return true
	return inlineValue(value).length <= 100
}

function inlineValue(value, keyOrder = null) {
	if (Array.isArray(value))
		return value.length === 0 ? '[]' : `[${value.map(v => inlineValue(v)).join(', ')}]`
	if (value !== null && typeof value === 'object') {
		const ordered = keyOrder == null ? value : orderObject(value, keyOrder)
		const entries = Object.keys(ordered)
			.map(key => `${JSON.stringify(key)}: ${inlineValue(ordered[key])}`)
		return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`
	}
	return JSON.stringify(value ?? null)
}

function isScalar(value) {
	return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function pad(depth) {
	return '  '.repeat(depth)
}

/** Atomic: a temp file plus rename, so an interrupted run cannot corrupt the graph. */
function persistGraph(graph) {
	const text = serializeGraph(graph)
	const temp = `${GRAPH_PATH}.tmp-${process.pid}`
	try {
		writeFileSync(temp, text, 'utf8')
		renameSync(temp, GRAPH_PATH)
	} catch (error) {
		try {
			if (existsSync(temp))
				unlinkSync(temp)
		} catch {
			// The rename failed; a stale temp file is the lesser problem.
		}
		throw new UsageError(`could not write ${rel(GRAPH_PATH)}: ${error.message}`)
	}
}

// ---------------------------------------------------------------------------
// derivation
// ---------------------------------------------------------------------------

/**
 * One gate, classified without running anything.
 *
 * `passed` is the ONLY promotion signal in this file. For an auto gate it means the gate's
 * own command exited 0. For a subjective gate it means an attributed critic verdict exists.
 * For an undefined gate it is permanently false.
 */
function classifyGate(gate) {
	const id = typeof gate.id === 'string' && gate.id !== '' ? gate.id : '(unnamed gate)'
	const declared = typeof gate.kind === 'string' ? gate.kind : 'undefined'
	const cmd = typeof gate.cmd === 'string' && gate.cmd.trim() !== '' ? gate.cmd.trim() : null
	const last = gate.lastResult != null && typeof gate.lastResult === 'object' ? gate.lastResult : null
	const base = { id, gate, falsifiable: gate.falsifiable === true, last }

	if (declared === 'undefined' || (declared === 'auto' && cmd == null)) {
		return {
			...base,
			kind: 'undefined',
			runnable: false,
			passed: false,
			red: false,
			unrun: false,
			ungated: true,
			criticNeeded: false,
			why: declared === 'auto'
				? 'kind "auto" but no cmd — nothing to execute'
				: '§0.2 demands a gate; no command exists',
		}
	}

	if (declared === 'subjective') {
		const judgedBy = typeof last?.judgedBy === 'string' ? last.judgedBy.trim() : ''
		const judged = last?.ok === true && judgedBy !== ''
		return {
			...base,
			kind: 'subjective',
			runnable: false,
			passed: judged,
			red: last?.ok === false,
			unrun: last == null,
			ungated: false,
			criticNeeded: !judged,
			why: judged
				? `critic verdict recorded by ${judgedBy}`
				: 'a critic or human must judge it; the runner may never pass it',
		}
	}

	if (declared === 'auto') {
		return {
			...base,
			kind: 'auto',
			runnable: true,
			passed: last?.ok === true,
			red: last?.ok === false,
			unrun: last == null,
			ungated: false,
			criticNeeded: false,
			cmd,
			cwd: typeof gate.cwd === 'string' && gate.cwd !== '' ? gate.cwd : '.',
			why: last == null
				? 'never run'
				: `last run exit ${last.exitCode ?? '(none)'} at ${last.at ?? '(unknown)'}`,
		}
	}

	return {
		...base,
		kind: 'undefined',
		runnable: false,
		passed: false,
		red: false,
		unrun: false,
		ungated: true,
		criticNeeded: false,
		why: `unknown gate kind '${declared}' — treated as undefined`,
	}
}

function nodeDirParts(node) {
	const raw = typeof node.dir === 'string' ? node.dir.trim() : ''
	if (raw === '' || raw === '-')
		return { pseudo: true, parts: [], missing: [] }
	// `web/ + engine/OpenRA.Browser/` style composites: the node spans several dirs.
	const parts = raw.split('+').map(part => part.trim()).filter(Boolean)
	const missing = parts.filter(part => !existsSync(resolve(GAME_ROOT, part)))
	return { pseudo: false, parts, missing }
}

function derive(graph) {
	const policy = policyOf(graph)
	const order = topoOrder(graph)
	const states = new Map()

	for (const node of order) {
		const gates = (node.gates ?? []).map(classifyGate)
		const dirs = nodeDirParts(node)
		const failures = Number.isSafeInteger(node.failures) && node.failures > 0 ? node.failures : 0
		const unverifiedDeps = (node.deps ?? []).filter(dep => states.get(dep)?.status !== S.VERIFIED)
		const gateVerdict = deriveFromGates(gates, policy)

		let status
		let why
		if (!dirs.pseudo && dirs.missing.length === dirs.parts.length) {
			// Precedence 1. The filesystem decides this, never the cached status field.
			status = S.UNSTARTED
			why = `dir does not exist: ${dirs.parts.join(', ')}`
		} else if (unverifiedDeps.length > 0) {
			status = S.BLOCKED
			why = `deps not VERIFIED: ${unverifiedDeps
				.map(dep => `${dep} (${states.get(dep)?.status ?? 'UNKNOWN'})`)
				.join(', ')}`
		} else if (failures >= policy.escalateAfterFailures) {
			status = S.BLOCKED_ON_LEAD
			why = `${failures} consecutive failures >= policy.escalateAfterFailures=` +
				`${policy.escalateAfterFailures}; §10.4 stops the runner retrying this node`
		} else {
			status = gateVerdict.status
			why = gateVerdict.why
		}

		states.set(node.id, {
			node,
			id: node.id,
			tier: Number(node.tier ?? 0),
			status,
			why,
			gates,
			failures,
			dirs,
			unverifiedDeps,
			cachedStatus: typeof node.status === 'string' ? node.status : null,
			runnableGates: gates.filter(g => g.runnable),
		})
	}

	const list = order.map(node => states.get(node.id))
	const settle = settleState(list, policy)
	return { policy, order, states, list, settle }
}

function deriveFromGates(gates, policy) {
	if (gates.length === 0)
		return { status: S.UNGATED, why: '§0.2 demands a gate; this node declares none' }

	const red = gates.filter(g => g.red)
	if (red.length > 0)
		return { status: S.RED, why: `red: ${ids(red)}` }

	const ungated = gates.filter(g => g.ungated)
	if (ungated.length > 0)
		return { status: S.UNGATED, why: `no executable gate: ${ids(ungated)}` }

	const unrun = gates.filter(g => g.runnable && g.unrun)
	if (unrun.length > 0)
		return { status: S.READY, why: `never run: ${ids(unrun)}` }

	const critic = gates.filter(g => g.criticNeeded)
	if (critic.length > 0)
		return { status: S.BLOCKED_ON_CRITIC, why: `a critic must judge: ${ids(critic)}` }

	const unproven = gates.filter(g => !g.falsifiable)
	if (policy.requireFalsifiableToVerify && unproven.length > 0)
		return {
			status: S.UNPROVEN_GATE,
			why: `passing but never witnessed red (§10.1 rule 1): ${ids(unproven)}`,
		}

	// VERIFIED must be an ASSERTION that every gate passed, never the fall-through of "nothing
	// objectionable was found". A gate whose lastResult.ok is not strictly true — missing, null,
	// 1, "true", or a lastResult that carries only judgedBy — is none of red/ungated/unrun/critic
	// and would otherwise arrive here and be promoted. That is the one bug this whole file exists
	// to make impossible, so it is checked explicitly rather than implied by precedence.
	const notPassed = gates.filter(g => !g.passed)
	if (notPassed.length > 0)
		return {
			status: S.RED,
			why: `no recorded pass (lastResult.ok is not strictly true): ${ids(notPassed)}`,
		}

	return {
		status: S.VERIFIED,
		why: `${gates.length} gate(s) passed, each witnessed red`,
	}
}

/**
 * The settle state is read off the FRONTIER — the nodes that are actually obstructing, i.e.
 * not VERIFIED and not waiting on an upstream node. `unverifiedDeps` is checked rather than
 * the status, because precedence puts UNSTARTED ahead of BLOCKED: a node whose dir does not
 * exist yet AND which sits behind fifteen blocked deps is not what the graph is stuck on.
 * Nothing here can report ALL_GREEN while a gate is undefined, unproven or awaiting a critic;
 * the assertion below is belt and braces.
 */
function settleState(list, policy) {
	if (list.length > 0 && list.every(s => s.status === S.VERIFIED)) {
		const bad = list.flatMap(s => s.gates.filter(g => g.ungated || g.criticNeeded || !g.passed ||
			(policy.requireFalsifiableToVerify && !g.falsifiable)))
		if (bad.length > 0)
			throw new Error(
				`${TOOL} internal: refusing to report ALL_GREEN while ${bad.length} gate(s) ` +
				`cannot count (${ids(bad)})`,
			)
		return {
			state: 'ALL_GREEN',
			reason: `all ${list.length} node${list.length === 1 ? '' : 's'} VERIFIED, ` +
				'every gate witnessed red',
			frontier: [],
		}
	}

	const frontier = list.filter(s => s.status !== S.VERIFIED && s.status !== S.BLOCKED &&
		s.unverifiedDeps.length === 0)
	if (frontier.length === 0)
		return {
			state: 'RED',
			reason: 'no node is VERIFIED and no node is actionable — inspect the graph',
			frontier,
		}

	const pick = (predicate) => frontier.filter(predicate)

	// RED counts as retryable only when the runner can actually re-run the red gate. A red
	// recorded by a critic on a subjective gate is a critic's to move, not the runner's.
	const retryable = s => s.gates.some(g => g.red && g.runnable)
	const failing = pick(s => s.status === S.RED && retryable(s))
	if (failing.length > 0)
		return {
			state: 'RED',
			reason: `failing and retryable: ${failing.map(s => s.id).join(', ')}`,
			frontier,
		}

	const unstarted = pick(s => s.status === S.UNSTARTED)
	if (unstarted.length > 0)
		return {
			state: 'RED',
			reason: `not built yet, gates cannot pass: ${unstarted.map(s => s.id).join(', ')}`,
			frontier,
		}

	const human = pick(s => s.status === S.BLOCKED_ON_LEAD || s.node.humanDecision != null)
	if (human.length > 0)
		return {
			state: 'BLOCKED_ON_HUMAN',
			reason: `needs a lead/human decision: ${human.map(s => s.id).join(', ')}`,
			frontier,
		}

	const ungated = pick(s => s.status === S.UNGATED)
	if (ungated.length > 0)
		return {
			state: 'UNGATED',
			reason: `§0.2 demands a gate but none is executable: ${ungated.map(s => s.id).join(', ')}`,
			frontier,
		}

	const critic = pick(s => s.status === S.BLOCKED_ON_CRITIC || s.status === S.UNPROVEN_GATE ||
		(s.status === S.RED && !retryable(s)))
	if (critic.length > 0)
		return {
			state: 'BLOCKED_ON_CRITIC',
			reason: `only a critic can move these: ${critic.map(s => s.id).join(', ')}`,
			frontier,
		}

	return {
		state: 'RED',
		reason: `gates not run yet: ${frontier.map(s => s.id).join(', ')}`,
		frontier,
	}
}

/** State-only fingerprint. Timestamps are excluded so "nothing changed" means it. */
function fingerprint(graph) {
	return JSON.stringify(graph.nodes.map(node => [
		node.id,
		typeof node.status === 'string' ? node.status : null,
		Number.isSafeInteger(node.failures) ? node.failures : 0,
		(node.gates ?? []).map(gate => [
			gate.id,
			gate.falsifiable === true,
			gate.lastResult == null ? null : [gate.lastResult.ok === true, gate.lastResult.exitCode ?? null],
		]),
	]))
}

// ---------------------------------------------------------------------------
// gate execution
// ---------------------------------------------------------------------------

function tokenize(cmd) {
	const out = []
	let current = ''
	let quote = null
	let started = false
	for (const ch of cmd) {
		if (quote != null) {
			if (ch === quote)
				quote = null
			else
				current += ch
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			started = true
			continue
		}
		if (/\s/.test(ch)) {
			if (started || current !== '') {
				out.push(current)
				current = ''
				started = false
			}
			continue
		}
		// Gates are spawned WITHOUT a shell, so an unquoted shell operator is not executed — it is
		// handed to the program as a literal argv entry and its meaning is silently dropped. That
		// produces a FALSE GREEN: `node -e "..." | grep -q VIOLATION` exits with node's status and
		// the grep never runs. Refuse loudly instead; a gate that needs a pipeline is a graph defect
		// to fix in graph.json, not something to paper over by adding a shell.
		if ('|&;<>`'.includes(ch))
			throw new UsageError(
				`gate cmd contains the shell operator ${JSON.stringify(ch)} outside quotes, but ` +
				'gates are spawned without a shell, so its meaning would be silently dropped and ' +
				`the gate could report a false green: ${cmd}`,
			)
		current += ch
	}
	if (quote != null)
		throw new UsageError(`unbalanced quote in gate cmd: ${cmd}`)
	if (started || current !== '')
		out.push(current)
	return out
}

function execute(cmd, cwd, timeoutMs, verbose) {
	return new Promise((resolveRun) => {
		const tokens = tokenize(cmd)
		const started = Date.now()
		let captured = ''
		let settled = false
		let timer = null

		const finish = (payload) => {
			if (settled)
				return
			settled = true
			if (timer != null)
				clearTimeout(timer)
			const lines = captured
				.split(/\r?\n/)
				.map(line => line.replace(/\s+$/, ''))
				.filter(line => line.trim() !== '')
			resolveRun({
				at: new Date(started).toISOString(),
				durationMs: Date.now() - started,
				tail: lines.slice(-TICKET_TAIL_LINES),
				...payload,
			})
		}

		let child
		try {
			child = spawnProcessGroup(tokens[0], tokens.slice(1), {
				cwd,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: process.env,
			})
		} catch (error) {
			finish({ ok: false, exitCode: null, signal: null, spawnError: error.message })
			return
		}

		const push = (chunk) => {
			const text = String(chunk)
			if (verbose)
				process.stderr.write(text)
			captured += text
			if (captured.length > CAPTURE_CAP)
				captured = captured.slice(captured.length - CAPTURE_CAP)
		}
		child.stdout.on('data', push)
		child.stderr.on('data', push)

		let timedOut = false
		timer = setTimeout(() => {
			timedOut = true
			void (async () => {
				let stoppedBy = null
				let cleanupError = null
				try {
					stoppedBy = await stopProcessGroup(child)
				} catch (error) {
					cleanupError = error.message
				}
				captured += `\n${TOOL}: killed after ${timeoutMs}ms (--timeout-ms)\n`
				if (cleanupError != null)
					captured += `${TOOL}: process-group cleanup failed: ${cleanupError}\n`
				finish({
					ok: false,
					exitCode: null,
					signal: stoppedBy ?? child.signalCode ?? 'SIGTERM',
					timedOut: true,
					...(cleanupError == null ? {} : { cleanupError }),
				})
			})()
		}, timeoutMs)

		child.on('error', (error) => {
			if (timedOut) {
				captured += `\n${TOOL}: child error during timeout cleanup: ${error.message}\n`
				return
			}
			finish({ ok: false, exitCode: null, signal: null, spawnError: error.message })
		})
		child.on('close', (code, signal) => {
			// The timeout path owns completion. A wrapper can close before its descendants;
			// stopProcessGroup resolves only after the whole process group disappears.
			if (timedOut)
				return
			finish({ ok: code === 0, exitCode: code, signal: signal ?? null })
		})
	})
}

async function runGate(state, gate, options) {
	const cwd = resolve(GAME_ROOT, gate.cwd)
	const relative = rel(cwd)
	const repro = relative === '' ? gate.cmd : `cd ${relative} && ${gate.cmd}`
	if (!existsSync(cwd)) {
		const result = {
			at: new Date().toISOString(),
			durationMs: 0,
			ok: false,
			exitCode: null,
			signal: null,
			tail: [`cwd '${gate.cwd}' does not exist`],
		}
		console.log(`  ${gate.id}  RED    cwd '${gate.cwd}' does not exist`)
		return { result, repro }
	}

	console.log(`  ${gate.id}  RUN    ${repro}`)
	const result = await execute(gate.cmd, cwd, options.timeoutMs, options.verbose)
	const verdict = result.ok ? 'GREEN ' : 'RED   '
	const exit = result.spawnError != null
		? `spawn failed: ${result.spawnError}`
		: `exit ${result.exitCode ?? result.signal ?? '(none)'}`
	console.log(`  ${gate.id}  ${verdict} ${exit} in ${result.durationMs}ms`)
	if (!result.ok && result.tail.length > 0)
		for (const line of result.tail.slice(-4))
			console.log(`         | ${truncate(line, 160)}`)
	return { result, repro }
}

function cacheResult(gate, result, repro) {
	const cache = {
		at: result.at,
		ok: result.ok === true,
		exitCode: result.exitCode ?? null,
		durationMs: result.durationMs,
		tail: truncate(result.tail.slice(-2).join(' | '), CACHE_TAIL_CHARS),
	}
	if (result.signal != null)
		cache.signal = result.signal
	if (result.spawnError != null)
		cache.spawnError = result.spawnError
	if (result.cleanupError != null)
		cache.cleanupError = result.cleanupError
	if (result.timedOut === true)
		cache.timedOut = true
	cache.repro = repro
	gate.lastResult = cache
}

// ---------------------------------------------------------------------------
// auto-repair tickets (§10.1, §10.5)
// ---------------------------------------------------------------------------

function ticketMarkers(nodeId, gateId) {
	return { node: `**Node:** \`${nodeId}\``, gate: `**Gate:** \`${gateId}\`` }
}

function findExistingTicket(nodeId, gateId) {
	if (!existsSync(ISSUES_DIR))
		return null
	const markers = ticketMarkers(nodeId, gateId)
	for (const name of readdirSync(ISSUES_DIR).filter(f => f.endsWith('.md')).sort()) {
		const path = join(ISSUES_DIR, name)
		let text
		try {
			text = readFileSync(path, 'utf8')
		} catch {
			continue
		}
		if (text.includes(markers.gate) && text.includes(markers.node))
			return path
	}
	return null
}

function nextTicketPath(nodeId) {
	const slug = nodeId.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
	for (let n = 1; n < 1000; n++) {
		const path = join(ISSUES_DIR, `${slug}-${n}.md`)
		if (!existsSync(path))
			return path
	}
	throw new UsageError(`cannot find a free ticket filename for node '${nodeId}'`)
}

function runSection(result, repro) {
	const exit = result.spawnError != null
		? `spawn failed: ${result.spawnError}`
		: `exit ${result.exitCode ?? result.signal ?? '(none)'}`
	const tail = result.tail.length > 0 ? result.tail.join('\n') : '(no output captured)'
	return [
		`### Run ${result.at} — ${exit} after ${result.durationMs} ms`,
		'',
		'Recorded by `node web/tools/plangraph.mjs run`. Repro:',
		'',
		'```',
		repro,
		'```',
		'',
		'```',
		truncate(tail, 6000),
		'```',
		'',
	].join('\n')
}

/**
 * §10 step 1: a red gate writes a ticket. A body that already exists is never rewritten —
 * a human may own it — so a repeat failure only appends a dated run section.
 */
function writeTicket(state, gate, result, repro) {
	mkdirSync(ISSUES_DIR, { recursive: true })
	const existing = findExistingTicket(state.id, gate.id)
	if (existing != null) {
		const previous = readFileSync(existing, 'utf8')
		const separator = previous.endsWith('\n\n') ? '' : previous.endsWith('\n') ? '\n' : '\n\n'
		// A run section is an H3 under `## Evidence`. A human ticket that has no Evidence
		// section gets one opened at the end rather than an H3 dangling under whatever its
		// last heading happens to be. The existing body is never rewritten.
		const heading = /^## Evidence\b/m.test(previous) ? '' : '## Evidence\n\n'
		writeFileSync(existing, `${previous}${separator}${heading}${runSection(result, repro)}`, 'utf8')
		return { path: existing, appended: true }
	}

	const path = nextTicketPath(state.id)
	const markers = ticketMarkers(state.id, gate.id)
	const spec = typeof gate.gate.spec === 'string' ? gate.gate.spec : '(no spec recorded in the graph)'
	const body = [
		`# ${basename(path)} — gate \`${gate.id}\` is red`,
		'',
		markers.node,
		markers.gate,
		'**Status:** OPEN',
		'**Found by:** `node web/tools/plangraph.mjs run` — automated',
		'',
		'## Symptom',
		'',
		`The gate command exits non-zero. Gate spec: ${spec}`,
		'',
		'Repro:',
		'',
		'```',
		repro,
		'```',
		'',
		'§10 step 3 and §10.1 rule 7: the owner fixes and re-runs, then the CRITIC re-runs this',
		'same command independently. This ticket is the runner\'s measurement, never a verdict on',
		'the cause and never a close.',
		'',
		'## Evidence',
		'',
		runSection(result, repro),
	].join('\n')
	writeFileSync(path, body, 'utf8')
	return { path, appended: false }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function commandStatus() {
	const graph = loadGraph()
	const derived = derive(graph)
	printGraph(graph, derived)
	return SETTLE_EXIT[derived.settle.state]
}

async function commandRun(flags, options) {
	const graph = loadGraph()
	const target = flags.get('node') ?? null
	const pass = await executePass(graph, { ...options, target }, 1)
	printGraph(graph, pass.derived, pass)
	return SETTLE_EXIT[pass.derived.settle.state]
}

async function commandLoop(flags, options) {
	if (flags.has('node'))
		throw new UsageError('loop takes no --node; use `run --node=id` for a single node')

	const maxPasses = flags.has('max-passes')
		? positiveInteger(flags.get('max-passes'), 'max-passes')
		: DEFAULT_MAX_PASSES
	const graph = loadGraph()

	let pass = null
	let stopped = 'max-passes reached'
	for (let index = 1; index <= maxPasses; index++) {
		const before = fingerprint(graph)
		console.log(`\n${TOOL}: ---- pass ${index}/${maxPasses} ----`)
		pass = await executePass(graph, { ...options, target: null }, index)
		const after = fingerprint(graph)
		const settle = pass.derived.settle.state

		if (settle === 'ALL_GREEN') {
			stopped = 'settled green'
			break
		}
		if (settle !== 'RED') {
			// Nothing the runner is allowed to do can move a human, a critic or a missing
			// gate command. Retrying would be a spin.
			stopped = `settled on ${settle}; the runner cannot move it`
			break
		}
		if (after === before) {
			stopped = 'no state changed in this pass — stopping instead of spinning'
			break
		}
		if (pass.executed.length === 0) {
			stopped = 'no gate was eligible to run'
			break
		}
	}

	printGraph(graph, pass.derived, pass)
	console.log(`${TOOL}: loop stopped after ${pass.passIndex} pass(es) — ${stopped}`)
	return SETTLE_EXIT[pass.derived.settle.state]
}

/**
 * One pass: pick eligible nodes, run their auto gates, sweep cached-VERIFIED nodes for
 * regressions, then RE-DERIVE from the fresh results and persist the cache.
 */
async function executePass(graph, options, passIndex) {
	const before = derive(graph)
	const executed = []
	const regressions = []
	const notes = []

	let targets
	if (options.target != null) {
		const state = before.states.get(options.target)
		if (state == null)
			throw new UsageError(
				`unknown node '${options.target}'; known: ` +
				`${graph.nodes.map(n => n.id).join(', ')}`,
			)
		// An explicit --node is a measurement request. It runs even when the node is
		// BLOCKED, so a red gate can be seen before its upstream is green; a pass still
		// cannot promote it, because promotion is derived, never asserted.
		if (state.status !== S.READY && state.status !== S.RED)
			notes.push(
				`--node=${state.id} forced: derived status is ${state.status} (${state.why}); ` +
				'a green gate here cannot promote the node',
			)
		if (state.status === S.BLOCKED_ON_LEAD)
			notes.push(
				`§10.4: ${state.id} is escalated to the lead and the runner would not retry it ` +
				'on its own; --node overrode that at your instruction',
			)
		targets = [{ state, gates: state.runnableGates, sweep: false }]
	} else {
		targets = []
		for (const state of before.list) {
			// Derived status only. The cached `status` in graph.json is a report, never an input —
			// trusting it here would contradict this file's own contract and let a stale VERIFIED
			// route a node into the sweep-only branch.
			if (state.status === S.VERIFIED) {
				// §10.5 regression sweep: a VERIFIED node has to keep proving it.
				if (options.sweep && state.runnableGates.length > 0)
					targets.push({ state, gates: state.runnableGates, sweep: true })
				continue
			}
			// A skip list, not an allow list. UNGATED / UNPROVEN_GATE / BLOCKED_ON_CRITIC are
			// statuses a node earns from ONE bad gate while its other gates are perfectly
			// runnable; an allow list of READY|RED meant a single undefined gate suppressed every
			// runnable gate on that node, which made `loop` a no-op on the real graph.
			if (state.status === S.BLOCKED || state.status === S.BLOCKED_ON_LEAD ||
				state.status === S.UNSTARTED)
				continue
			const gates = state.runnableGates.filter(g => g.unrun || g.red)
			if (gates.length > 0)
				targets.push({ state, gates, sweep: false })
		}
	}

	for (const target of targets) {
		const { state, gates, sweep } = target
		console.log(
			`${TOOL}: ${state.id} [${state.status}]` +
			`${sweep ? ' — §10.5 regression sweep' : ''}`,
		)
		let anyRed = false
		for (const gate of gates) {
			const { result, repro } = await runGate(state, gate, options)
			executed.push({ node: state.id, gate: gate.id, ok: result.ok, durationMs: result.durationMs })
			if (!options.dryRun)
				cacheResult(gate.gate, result, repro)
			if (!result.ok) {
				anyRed = true
				if (!options.dryRun) {
					const ticket = writeTicket(state, gate, result, repro)
					console.log(
						`  ${gate.id}  TICKET ${rel(ticket.path)}` +
						`${ticket.appended ? ' (run section appended)' : ' (new)'}`,
					)
				}
			}
		}
		if (options.dryRun)
			continue

		if (anyRed) {
			state.node.failures = (Number.isSafeInteger(state.node.failures) ? state.node.failures : 0) + 1
			if (state.node.failures >= before.policy.escalateAfterFailures)
				notes.push(
					`§10.4 ESCALATED: ${state.id} has ${state.node.failures} consecutive failures ` +
					`(>= ${before.policy.escalateAfterFailures}). The runner stops retrying it. The lead may ` +
					'revise the spec or lower a budget, and may NOT delete a gate, weaken a rule ' +
					'or mark it green.',
				)
			if (sweep) {
				const cascade = transitiveDependents(graph, state.id)
				regressions.push({ id: state.id, cascade })
				notes.push(
					`§10.5 REGRESSION: ${state.id} was cached VERIFIED and is now RED. ` +
					(cascade.length > 0
						? `Cascading BLOCKED to ${cascade.length} transitive dependent(s): ${cascade.join(', ')}`
						: 'No dependents to cascade to.'),
				)
			}
		} else if (gates.length > 0 &&
			!(state.node.gates ?? []).some(g => g.lastResult?.ok === false)) {
			// §10.4 counts CONSECUTIVE failures, so a node with nothing red left clears its
			// count. Read from the live lastResult rather than from the gates this pass
			// happened to re-run: a node can have one cached-green gate and one that just
			// went green, and that is still a clean node.
			state.node.failures = 0
		}
		state.node.lastRun = new Date().toISOString()
	}

	const after = derive(graph)
	if (!options.dryRun) {
		for (const state of after.list)
			state.node.status = state.status
		persistGraph(graph)
	}

	return { passIndex, derived: after, executed, regressions, notes, dryRun: options.dryRun }
}

function commandRender(flags) {
	const graph = loadGraph()
	const derived = derive(graph)
	const out = flags.has('out') ? resolve(process.cwd(), flags.get('out')) : PLAN_PATH
	const text = renderPlan(graph, derived)
	mkdirSync(resolve(out, '..'), { recursive: true })
	writeFileSync(out, text, 'utf8')
	console.log(
		`${TOOL}: wrote ${rel(out)} — ${graph.nodes.length} nodes, ` +
		`settle ${derived.settle.state} (rendered from the cache; render executes nothing)`,
	)
	return 0
}

function commandInsert(flags, options) {
	const graph = loadGraph()
	const id = flags.get('id')
	if (id == null)
		throw new UsageError('insert requires --id')
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id))
		throw new UsageError(`insert: '${id}' is not a usable node id ([a-z0-9][a-z0-9._-]*)`)
	if (graph.nodes.some(node => node.id === id))
		throw new UsageError(`insert: node '${id}' already exists`)

	const dir = flags.get('dir')
	if (dir == null)
		throw new UsageError('insert requires --dir (use "-" for a cross-cutting pseudo-node)')
	const discoveredBy = flags.get('discovered-by')
	if (discoveredBy == null)
		throw new UsageError(
			'insert requires --discovered-by: a discovered node must say who found it and when',
		)

	const deps = (flags.get('deps') ?? '').split(',').map(d => d.trim()).filter(Boolean)
	for (const dep of deps) {
		if (dep === id)
			throw new UsageError(`insert: '${id}' cannot depend on itself`)
		if (!graph.nodes.some(node => node.id === dep))
			throw new UsageError(`insert: unknown dep '${dep}'`)
	}

	const depTiers = deps.map(dep => Number(graph.nodes.find(n => n.id === dep).tier ?? 0))
	const tier = flags.has('tier')
		? nonnegativeInteger(flags.get('tier'), 'tier')
		: depTiers.length > 0 ? Math.max(...depTiers) : 0

	const node = {
		id,
		tier,
		dir,
		deps,
		discoveredBy,
		owns: flags.get('owns') ?? 'UNSPECIFIED — the inserting agent must fill this in.',
		gates: [{
			id: `${id}.gate`,
			kind: 'undefined',
			cmd: null,
			spec: flags.get('gate-spec')
				?? 'UNSPECIFIED — §0.2 demands a gate. Write a command that can be witnessed red.',
			falsifiable: false,
		}],
	}

	// Keep the file grouped by tier the way it already is.
	let at = graph.nodes.length
	for (let i = graph.nodes.length - 1; i >= 0; i--) {
		if (Number(graph.nodes[i].tier ?? 0) <= tier) {
			at = i + 1
			break
		}
		at = i
	}
	graph.nodes.splice(at, 0, node)

	topoOrder(graph)
	const derived = derive(graph)
	if (!options.dryRun) {
		for (const state of derived.list)
			state.node.status = state.status
		persistGraph(graph)
	}

	console.log(
		`${TOOL}: inserted '${id}' at tier ${tier}` +
		`${deps.length > 0 ? ` after ${deps.join(', ')}` : ' with no deps'}` +
		`${options.dryRun ? ' (--dry-run: nothing written)' : ` -> ${rel(GRAPH_PATH)}`}`,
	)
	console.log(
		`${TOOL}: '${id}' is UNGATED — its gate has no command, so it can never be VERIFIED. ` +
		'§0.2 demands a gate: write one that can be witnessed red, then record the witness ' +
		`with \`falsify --gate=${id}.gate --broke="..."\``,
	)
	const dependents = transitiveDependents(graph, id)
	if (dependents.length > 0)
		console.log(`${TOOL}: ${dependents.length} node(s) now sit downstream: ${dependents.join(', ')}`)
	return 0
}

function commandFalsify(flags, options) {
	const graph = loadGraph()
	const gateId = flags.get('gate')
	if (gateId == null)
		throw new UsageError('falsify requires --gate')
	const broke = flags.get('broke')
	if (broke == null)
		throw new UsageError(
			'falsify requires --broke="what was broken on purpose to make this gate go red". ' +
			'§10.1 rule 1 is a WITNESSED red, not an assertion that one is possible.',
		)

	const matches = []
	for (const node of graph.nodes)
		for (const gate of node.gates ?? [])
			if (gate.id === gateId)
				matches.push({ node, gate })
	if (matches.length === 0)
		throw new UsageError(`falsify: no gate '${gateId}' in ${rel(GRAPH_PATH)}`)
	if (matches.length > 1)
		throw new UsageError(`falsify: gate id '${gateId}' is declared on ${matches.length} nodes`)

	const { node, gate } = matches[0]
	const classified = classifyGate(gate)
	if (classified.kind === 'undefined')
		throw new UsageError(
			`falsify: '${gateId}' has no command (${classified.why}). There is nothing to witness ` +
			'go red. Write the gate command first — that is the finding.',
		)

	// The latch has to MEASURE the red, not accept a claim that one happened. Without this, the
	// headline mechanism of this file is bypassable: a gate that provably cannot fail could be
	// asserted falsifiable and promote its node to VERIFIED, which is precisely the
	// "agents grading their own homework" failure §10.1 exists to prevent.
	const witness = flags.get('witness')
	if (witness == null || witness.trim() === '' || witness.trim() === 'unattributed')
		throw new UsageError(
			'falsify requires --witness=<who broke it and watched it go red>. An unattributed ' +
			'witness is an assertion, and §10.1 rule 1 wants an observation.',
		)
	if (gate.lastResult?.ok !== false)
		throw new UsageError(
			`falsify: this runner has no record of '${gateId}' ever going red. ` +
			`lastResult.ok is ${JSON.stringify(gate.lastResult?.ok)}, not false. Break the thing ` +
			'on purpose, run the gate through THIS tool so the red is recorded, then falsify. ' +
			'§10.1 rule 1 is a witnessed red; taking your word for it is the bug.',
		)

	if (gate.falsifiable === true)
		console.log(`${TOOL}: '${gateId}' was already falsifiable; recording this witness over the old one`)

	gate.falsifiable = true
	gate.falsifiedBy = {
		at: new Date().toISOString(),
		witness: witness.trim(),
		broke,
		observedRedAt: gate.lastResult?.at ?? null,
		observedRedExit: gate.lastResult?.exit ?? null,
	}
	if (flags.has('red'))
		gate.falsifiedBy.observedRed = flags.get('red')

	const derived = derive(graph)
	if (!options.dryRun) {
		for (const state of derived.list)
			state.node.status = state.status
		persistGraph(graph)
	}

	const state = derived.states.get(node.id)
	console.log(
		`${TOOL}: '${gateId}' on node '${node.id}' is now falsifiable — witnessed red by ` +
		`${gate.falsifiedBy.witness}: ${broke}`,
	)
	if (classified.kind === 'subjective')
		console.log(
			`${TOOL}: note — '${gateId}' is subjective, so the runner still cannot pass it; ` +
			'the node stays BLOCKED_ON_CRITIC until an attributed critic verdict exists',
		)
	console.log(`${TOOL}: node '${node.id}' derives ${state.status} — ${state.why}`)
	const remaining = state.gates.filter(g => !g.falsifiable)
	if (remaining.length > 0)
		console.log(`${TOOL}: still awaiting a witnessed red on: ${ids(remaining)}`)
	return 0
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function printGraph(graph, derived, pass = null) {
	const policy = derived.policy
	console.log(
		`\n${TOOL}: ${rel(GRAPH_PATH)} — ${graph.nodes.length} nodes; policy ` +
		`escalateAfterFailures=${policy.escalateAfterFailures}, ` +
		`requireFalsifiableToVerify=${policy.requireFalsifiableToVerify}, ` +
		`cascadeBlockOnRegression=${policy.cascadeBlockOnRegression}`,
	)

	const rows = [['TIER', 'NODE', 'STATUS', 'GATES', 'WHY']]
	for (const state of derived.list)
		rows.push([
			String(state.tier),
			state.id,
			state.status + (state.failures > 0 ? ` (${state.failures}x)` : ''),
			gateSummary(state),
			truncate(state.why, 96),
		])
	console.log('')
	for (const line of table(rows))
		console.log(`  ${line}`)

	const counts = new Map()
	for (const state of derived.list)
		counts.set(state.status, (counts.get(state.status) ?? 0) + 1)
	console.log(
		`\n  totals: ${[...counts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([status, n]) => `${status}=${n}`)
			.join('  ')}`,
	)

	const findings = collectFindings(derived)
	for (const section of findings) {
		console.log(`\n${TOOL}: ${section.title}`)
		for (const line of section.lines)
			console.log(`  ${line}`)
	}

	if (pass != null) {
		console.log(
			`\n${TOOL}: pass ${pass.passIndex} executed ${pass.executed.length} gate(s)` +
			`${pass.dryRun ? ' (--dry-run: nothing persisted)' : ''}`,
		)
		for (const run of pass.executed)
			console.log(`  ${run.ok ? 'GREEN ' : 'RED   '} ${run.node} / ${run.gate} (${run.durationMs}ms)`)
		for (const note of pass.notes)
			console.log(`  ! ${note}`)
	}

	const settle = derived.settle
	console.log(`\n${TOOL}: SETTLE ${settle.state} — ${settle.reason}`)
	console.log(`${TOOL}: exit ${SETTLE_EXIT[settle.state]}`)
}

function gateSummary(state) {
	const total = state.gates.length
	const passed = state.gates.filter(g => g.passed).length
	const extra = []
	const undefinedGates = state.gates.filter(g => g.ungated).length
	const subjective = state.gates.filter(g => g.kind === 'subjective').length
	const red = state.gates.filter(g => g.red).length
	if (red > 0) extra.push(`${red} red`)
	if (undefinedGates > 0) extra.push(`${undefinedGates} undefined`)
	if (subjective > 0) extra.push(`${subjective} subjective`)
	return `${passed}/${total}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`
}

function collectFindings(derived) {
	const sections = []
	const push = (title, lines) => {
		if (lines.length > 0)
			sections.push({ title, lines })
	}

	push(
		'FINDING — UNGATED: §0.2 demands a gate, and a gate with no command can never pass. ' +
		'These nodes can never be VERIFIED as written.',
		derived.list.flatMap(state => state.gates
			.filter(g => g.ungated)
			.map(g => `${state.id} / ${g.id}: ${g.why}; spec: ${truncate(specOf(g), 150)}`)),
	)

	push(
		'FINDING — UNPROVEN_GATE: §10.1 rule 1. These gates PASS but nobody has broken the ' +
		'thing on purpose and watched them go red, so they may not promote their node. ' +
		'Fix with: falsify --gate=<id> --broke="..."',
		derived.list
			.filter(state => state.status === S.UNPROVEN_GATE)
			.flatMap(state => state.gates
				.filter(g => !g.falsifiable)
				.map(g => `${state.id} / ${g.id} needs a witnessed red`)),
	)

	push(
		'BLOCKED_ON_CRITIC: subjective gates. The runner may never pass one. A verdict counts ' +
		'only when attributed (lastResult.judgedBy).',
		derived.list
			.filter(state => state.status === S.BLOCKED_ON_CRITIC)
			.flatMap(state => state.gates
				.filter(g => g.criticNeeded)
				.map(g => `${state.id} / ${g.id}: ${truncate(specOf(g), 150)}`)),
	)

	push(
		'UNSTARTED — the dir does not exist on disk, so no gate of this node can pass. ' +
		'Determined from the filesystem, never from the cached status field.',
		derived.list
			.filter(state => state.status === S.UNSTARTED)
			.map(state => `${state.id}: ${state.dirs.parts.join(', ')} missing` +
				`${state.unverifiedDeps.length > 0 ? ` (also behind ${state.unverifiedDeps.length} unverified dep(s), so not the frontier)` : ' — ON THE FRONTIER: needs an implementer'}`),
	)

	push(
		'§10.4 ESCALATED to the lead — the runner has STOPPED retrying these.',
		derived.list
			.filter(state => state.failures >= derived.policy.escalateAfterFailures)
			.map(state => `${state.id}: ${state.failures} consecutive failures`),
	)

	push(
		'RED gates.',
		derived.list.flatMap(state => state.gates
			.filter(g => g.red)
			.map(g => `${state.id} / ${g.id}: ${g.gate.lastResult?.repro ?? '(no repro recorded)'}`)),
	)

	push(
		'believedFailing in the graph but not yet MEASURED red by this runner.',
		derived.list.flatMap(state => state.gates
			.filter(g => g.gate.believedFailing === true && !g.red)
			.map(g => `${state.id} / ${g.id} (${g.kind})`)),
	)

	push(
		'GRAPH DEFECT — a declared dir part does not exist. The node still counts as started ' +
		'because another part of its dir does.',
		derived.list
			.filter(state => !state.dirs.pseudo && state.dirs.missing.length > 0 &&
				state.dirs.missing.length < state.dirs.parts.length)
			.map(state => `${state.id}: dir '${state.node.dir}' — missing ${state.dirs.missing.join(', ')}`),
	)

	push(
		'OPEN HUMAN DECISIONS (§10.2 — lead-owned, and no gate can be closed around them).',
		derived.list
			.filter(state => state.node.humanDecision != null)
			.map(state => `${state.id} [${state.status}]: ${truncate(String(state.node.humanDecision), 200)}`),
	)

	return sections
}

function specOf(gate) {
	return typeof gate.gate.spec === 'string' ? gate.gate.spec : '(no spec)'
}

function table(rows) {
	const widths = []
	for (const row of rows)
		row.forEach((cell, i) => {
			widths[i] = Math.max(widths[i] ?? 0, String(cell).length)
		})
	return rows.map(row => row
		.map((cell, i) => i === row.length - 1 ? String(cell) : String(cell).padEnd(widths[i]))
		.join('  ')
		.replace(/\s+$/, ''))
}

// ---------------------------------------------------------------------------
// PLAN.md — a rendered VIEW of the graph, never a source
// ---------------------------------------------------------------------------

function renderPlan(graph, derived) {
	const now = new Date().toISOString()
	const out = []
	const w = line => out.push(line)

	w('# STEELSEED — PLAN')
	w('')
	w('**GENERATED FILE — DO NOT HAND-EDIT.** Every byte below is rendered from')
	w('`plan/graph.json` by `node web/tools/plangraph.mjs render`. Edit the graph, or run the')
	w('gates; editing this file changes nothing and will be overwritten by the next render.')
	w('')
	w('`plan/graph.json` is the source of truth for build order. Node status is DERIVED by')
	w('EXECUTING gates (`node web/tools/plangraph.mjs run`) and cached back into the graph — it is')
	w('never asserted. `ARCHITECTURE.md` is the binding contract; this view does not')
	w('replace it.')
	w('')
	w(`Rendered at ${now}. \`render\` executes nothing: the statuses below are the cache left by`)
	w('the last `run`.')
	w('')
	w(`## Settle state: ${derived.settle.state}`)
	w('')
	w(`${derived.settle.reason}`)
	w('')
	w('The five terminal states are `ALL_GREEN`, `RED`, `BLOCKED_ON_HUMAN`, `BLOCKED_ON_CRITIC`')
	w('and `UNGATED`. `ALL_GREEN` is unreachable while any node is `UNGATED`, `UNPROVEN_GATE` or')
	w('`BLOCKED_ON_CRITIC`.')
	w('')
	w('| policy | value | meaning |')
	w('|---|---|---|')
	w(`| \`escalateAfterFailures\` | ${derived.policy.escalateAfterFailures} | §10.4: at this many consecutive failures the node escalates to the lead and the runner stops retrying it |`)
	w(`| \`cascadeBlockOnRegression\` | ${derived.policy.cascadeBlockOnRegression} | §10.5: a regressed VERIFIED node blocks its full transitive dependent closure |`)
	w(`| \`requireFalsifiableToVerify\` | ${derived.policy.requireFalsifiableToVerify} | §10.1 rule 1: a passing gate that has never been witnessed red cannot promote its node |`)
	w('')

	w('## State')
	w('')
	w('| node | tier | status | gates | why |')
	w('|---|---|---|---|---|')
	for (const state of derived.list)
		w(`| \`${state.id}\` | ${state.tier} | ${state.status}${state.failures > 0 ? ` (${state.failures} consecutive failures)` : ''} | ${gateSummary(state)} | ${mdCell(state.why)} |`)
	w('')

	const counts = new Map()
	for (const state of derived.list)
		counts.set(state.status, (counts.get(state.status) ?? 0) + 1)
	w(`Totals: ${[...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([status, n]) => `${status} ${n}`)
		.join(', ')}.`)
	w('')

	w('## Spine — topological order, grouped by tier')
	w('')
	w('A node is listed only after every node it depends on. Within a tier the order is the')
	w('graph\'s own declaration order.')
	w('')
	let tier = null
	for (const state of derived.list) {
		if (state.tier !== tier) {
			tier = state.tier
			w(`### tier ${tier}`)
			w('')
		}
		const node = state.node
		w(`#### \`${state.id}\` — ${state.status}`)
		w('')
		w(`- **dir:** \`${node.dir ?? '-'}\`${state.dirs.missing.length > 0 ? ` — MISSING ON DISK: ${state.dirs.missing.join(', ')}` : ''}`)
		w(`- **deps:** ${(node.deps ?? []).length === 0 ? '—' : node.deps.map(d => `\`${d}\``).join(', ')}`)
		w(`- **deliverable:** ${mdInline(node.owns ?? '(not recorded)')}`)
		if (node.discoveredBy != null)
			w(`- **discovered by:** ${mdInline(String(node.discoveredBy))}`)
		w(`- **why ${state.status}:** ${mdInline(state.why)}`)
		w('- **gates:**')
		if (state.gates.length === 0) {
			w('  - NONE DECLARED — §0.2 demands a gate. This node can never be VERIFIED.')
		} else {
			for (const gate of state.gates) {
				const verdict = gate.ungated
					? 'UNDEFINED (no command; can never pass)'
					: gate.red
						? `RED (exit ${gate.gate.lastResult?.exitCode ?? '(none)'} at ${gate.gate.lastResult?.at ?? '?'})`
						: gate.passed
							? `PASSED at ${gate.gate.lastResult?.at ?? '?'}`
							: gate.kind === 'subjective'
								? 'AWAITING A CRITIC (the runner may never pass it)'
								: 'NEVER RUN'
				const latch = gate.falsifiable
					? 'witnessed red'
					: 'NEVER WITNESSED RED (§10.1 rule 1: cannot promote)'
				const kind = gate.ungated ? '' : `${gate.kind}, `
				w(`  - \`${gate.id}\` — ${kind}${verdict}; falsifiable: ${latch}`)
				if (gate.cmd != null)
					w(`    - cmd: \`cd ${gate.cwd} && ${gate.cmd}\``)
				w(`    - spec: ${mdInline(specOf(gate))}`)
			}
		}
		if (Array.isArray(node.openTickets) && node.openTickets.length > 0)
			w(`- **open tickets:** ${node.openTickets.map(t => `\`issues/${t}.md\``).join(', ')}`)
		if (Array.isArray(node.blockedBy) && node.blockedBy.length > 0)
			for (const item of node.blockedBy)
				w(`- **blocked by:** ${mdInline(String(item))}`)
		if (node.humanDecision != null)
			w(`- **human decision:** ${mdInline(String(node.humanDecision))}`)
		if (Array.isArray(node.findings) && node.findings.length > 0) {
			w('- **findings:**')
			for (const finding of node.findings)
				w(`  - ${mdInline(String(finding))}`)
		}
		if (Array.isArray(node.knownDefects) && node.knownDefects.length > 0) {
			w('- **known defects:**')
			for (const defect of node.knownDefects)
				w(`  - ${mdInline(String(defect))}`)
		}
		if (node.notes != null)
			w(`- **notes:** ${mdInline(String(node.notes))}`)
		if (node.lastRun != null)
			w(`- **last run:** ${node.lastRun}`)
		w('')
	}

	w('## Open human decisions')
	w('')
	const decisions = derived.list.filter(state => state.node.humanDecision != null)
	if (decisions.length === 0) {
		w('None recorded in the graph.')
	} else {
		w('Collected from every node\'s `humanDecision`. §10.4: the lead may revise a spec or lower')
		w('a budget, and may never delete a gate, weaken a hard rule or mark a gate green by fiat.')
		w('')
		for (const state of decisions) {
			w(`- **\`${state.id}\`** [${state.status}] — ${mdInline(String(state.node.humanDecision))}`)
		}
	}
	w('')

	w('## Findings the runner reports loudly')
	w('')
	const findings = collectFindings(derived)
	if (findings.length === 0) {
		w('None.')
	} else {
		for (const section of findings) {
			w(`### ${section.title}`)
			w('')
			for (const line of section.lines)
				w(`- ${mdInline(line)}`)
			w('')
		}
	}

	w('---')
	w('')
	w(`Settle state: **${derived.settle.state}** — ${derived.settle.reason}`)
	w('')
	w('Regenerate with `cd web && node tools/plangraph.mjs render`.')
	w('')
	return out.join('\n')
}

function mdCell(text) {
	return String(text).replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

function mdInline(text) {
	return String(text).replace(/\n+/g, ' ')
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function ids(gates) {
	return gates.map(g => g.id).join(', ')
}

function rel(path) {
	const absolute = resolve(path)
	if (absolute === GAME_ROOT)
		return ''
	return absolute.startsWith(`${GAME_ROOT}/`) ? absolute.slice(GAME_ROOT.length + 1) : absolute
}

function basename(path) {
	const parts = String(path).split('/')
	return parts[parts.length - 1].replace(/\.md$/, '')
}

function truncate(text, limit) {
	const flat = String(text).replace(/\s+/g, ' ').trim()
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

function positiveInteger(value, name) {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new UsageError(`--${name} must be a positive integer (received '${value}')`)
	return parsed
}

function nonnegativeInteger(value, name) {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0)
		throw new UsageError(`--${name} must be a non-negative integer (received '${value}')`)
	return parsed
}
