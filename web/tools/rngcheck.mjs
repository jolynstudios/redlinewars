#!/usr/bin/env node
// STEELSEED — tools/rngcheck
// The `core.rng-bit-identical` gate, made executable.
//
// §0.2 requires "ctx.rng bit-identical across runs" and nothing checked it. `rulecheck` rule 5
// forbids the two obvious entropy sources — Math.random() and crypto.getRandomValues — which is  rulecheck-allow
// a different claim: it proves no OBVIOUS nondeterminism was TYPED, not that the RNG actually
// reproduces. A SplitMix64 seeding itself from a hash of something environment-dependent would
// pass rule 5 forever.
//
// The marker above is rule 5's own escape hatch, and this tool tripped rule 5 on its first run
// by NAMING the calls it exists to complement. rulecheck scans line by line with no idea what is
// code and what is prose, so the marker has to sit on the offending line itself — putting it on
// the following line, as I first did, changes nothing. That is a fair cost for a cheap gate, but
// it is worth knowing that rule 5's reach is textual, not semantic.
//
// TWO PROCESSES, not two calls. Drawing twice in one process proves only that the generator is
// a function of its own state. The claim under test is that a FRESH process with the same asset
// seed produces the same stream — which is what §5.2 promises and what every baseline, capture
// and sync hash in the project silently depends on.
//
// The stream names are NOT a hardcoded list. A hardcoded list is how an inventory goes stale:
// someone adds `forkNamed('weather')`, nothing scans for it, and the gate keeps reporting green
// on a stream it never drew. So this scans `src/` for every `forkNamed('literal')` call site and
// FAILS if the source names a stream the gate does not cover. Template-literal forks
// (`forkNamed(`layer-${l}`)`) cannot be resolved statically and are listed as such rather than
// silently ignored — see DYNAMIC_FORKS.
//
// Usage:
//   node tools/rngcheck.mjs [--draws=n] [--seed=s] [--probe-single-process]
//
//   --probe-single-process   §10.1 rule 1 falsification lever. Compares a process against
//                            ITSELF by reusing arm A's digest for arm B, so the comparison
//                            trivially passes and the gate must report that as a FAILURE of the
//                            method rather than a pass. Never a valid green.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = 'rngcheck'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SRC = resolve(WEB_ROOT, 'src')

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const hit = argv.find(a => a.startsWith(`--${name}=`))
	return hit == null ? fallback : hit.slice(name.length + 3)
}
const draws = Number(arg('draws', '4096'))
const seed = arg('seed', 'steelseed-rngcheck-v1')
const probeSingleProcess = argv.includes('--probe-single-process')

/**
 * Named streams the real nodes fork, as static literals. Kept in sync by the bijection check
 * below rather than by anyone remembering — the whole point.
 */
const STATIC_STREAMS = [
	'height',
	'surface',
	'surface-bands',
	'resource-bodies',
	'actors',
	'audio-bank',
	'sky-clouds',
	'terrain:variants',
	// The greeble generator forks six separate streams so that adding one detail kind cannot
	// shift another's values (§5). All six were missing from the first version of this list,
	// because I built it from a `grep | head -12` and never noticed the truncation. The
	// bijection check above found them on the first run — which is the entire reason it exists,
	// and it caught a human rather than a code change.
	'geo/greeble:panelLines',
	'geo/greeble:rivets',
	'geo/greeble:hatches',
	'geo/greeble:vents',
	'geo/greeble:weldSeams',
	'geo/greeble:wear',
]

/**
 * Forks whose name is computed, so no scan can resolve them. Listed explicitly with the shape
 * they take, and EXERCISED below with representative values — an unresolvable name is a reason
 * to write the case down, not a reason to skip it.
 */
const DYNAMIC_FORKS = [
	{ where: 'materials/index.ts', shape: 'materials/v${generatorVersion}', sample: 'materials/v1' },
	{ where: 'materials/forge.ts', shape: '${def.id}', sample: 'soil' },
	{ where: 'materials/forge.ts', shape: 'layer-${l}', sample: 'layer-0' },
	{ where: 'units/index.ts', shape: 'units/hull/${c}', sample: 'units/hull/0' },
	// §14.13 archetype hulls: one stream per ROSTER SLOT, so adding an actor cannot shift
	// the per-instance wear of any actor already in the roster. The sample is a real slot
	// name rather than a placeholder — a census entry that exercises a name no generator
	// would ever produce proves nothing about the stream the generator actually draws from.
	{ where: 'units/index.ts', shape: 'units/slot/${slot.name}', sample: 'units/slot/foundry_tread' },
	// The offline proof deliberately replays that same named stream in a separate build
	// entry. Keeping the call site in the census prevents the forge from becoming an
	// unmeasured second RNG contract.
	{ where: 'units/forge-entry.gate.ts', shape: 'units/slot/${slot.name}', sample: 'units/slot/foundry_crucible' },
]

function walk(dir) {
	const out = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) out.push(...walk(full))
		else if (entry.endsWith('.ts')) out.push(full)
	}
	return out
}

// 1. Bijection between the streams the source forks and the streams this gate draws.
const files = walk(SRC)
const foundStatic = new Map()
let dynamicSites = 0
for (const file of files) {
	const src = readFileSync(file, 'utf8')
	for (const m of src.matchAll(/\.forkNamed\(\s*(['"`])([^'"`$]*?)\1\s*\)/g))
		foundStatic.set(m[2], relative(WEB_ROOT, file))
	// A fork whose name is not a plain string literal is dynamic: a scanner cannot resolve it,
	// so it has to be written down in DYNAMIC_FORKS and exercised with a representative value.
	// This matched ONLY backtick templates containing ${, which missed `forkNamed(def.id)` in
	// materials/forge.ts — a bare identifier is every bit as unresolvable as an interpolation,
	// and simplifying `${def.id}` to def.id silently dropped a site out of the census while
	// leaving its DYNAMIC_FORKS entry correct. Match any argument that is not a plain literal.
	for (const m of src.matchAll(/\.forkNamed\(\s*([^)]*)\)/g)) {
		const argument = m[1].trim()
		const plainLiteral = /^(['"`])[^'"`$]*\1$/.test(argument)
		if (!plainLiteral) dynamicSites++
	}
}
// rng.ts declares the method and ctx.ts documents it in a comment; neither is a call site.
foundStatic.delete('name')
foundStatic.delete('my-generator')

const problems = []
const covered = new Set(STATIC_STREAMS)
for (const [name, where] of foundStatic)
	if (!covered.has(name))
		problems.push(`stream '${name}' is forked at ${where} but this gate never draws it — add it to STATIC_STREAMS`)
for (const name of STATIC_STREAMS)
	if (!foundStatic.has(name))
		problems.push(`STATIC_STREAMS lists '${name}' but no .forkNamed('${name}') exists in src/ — stale entry`)
if (dynamicSites !== DYNAMIC_FORKS.length)
	problems.push(
		`found ${dynamicSites} computed-name forkNamed call(s) but DYNAMIC_FORKS documents ${DYNAMIC_FORKS.length}. ` +
		'A computed stream name cannot be resolved by scanning, so each one must be written down and exercised ' +
		'with a representative value rather than left out of the census.',
	)

// 2. Draw the streams in a CHILD process, twice, and compare digests.
//    execFileSync rather than an import: a fresh interpreter is the thing being tested.
const CHILD = `
import { rootRng } from ${JSON.stringify(resolve(SRC, 'core/rng.ts'))}
// slice(1), not slice(2): under --eval there is NO argv[1] script path, so argv is
// [execPath, ...args]. slice(2) ate the seed and shifted everything — draws became a stream
// name, Number() gave NaN, and the child emitted ten EMPTY streams. The length check caught
// it, and the independence control below would have caught it too, since ten empty arrays
// hash identically. Two independent guards both firing on one mistake is the point of having
// both.
const [seed, draws, ...names] = process.argv.slice(1)
const out = []
for (const name of names) {
	const r = rootRng(seed).forkNamed(name)
	const vals = []
	for (let i = 0; i < Number(draws); i++) vals.push(r.next())
	// Raw bits, not decimal text: two different doubles can print identically at some
	// precisions, and this gate exists to catch last-bit differences.
	const buf = new Float64Array(vals)
	out.push(name + '=' + Buffer.from(buf.buffer).toString('base64'))
}
process.stdout.write(out.join('\\n'))
`

const streamNames = [...STATIC_STREAMS, ...DYNAMIC_FORKS.map(d => d.sample)]

function drawInChildProcess(label) {
	const stdout = execFileSync(
		process.execPath,
		['--experimental-strip-types', '--input-type=module', '--eval', CHILD, '--', seed, String(draws), ...streamNames],
		{ cwd: WEB_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
	)
	const perStream = new Map()
	for (const line of stdout.split('\n')) {
		const eq = line.indexOf('=')
		if (eq < 0) continue
		perStream.set(line.slice(0, eq), createHash('sha256').update(line.slice(eq + 1)).digest('hex').slice(0, 16))
	}
	if (perStream.size !== streamNames.length)
		throw new Error(`${label}: expected ${streamNames.length} stream digests, got ${perStream.size}`)
	return perStream
}

const armA = drawInChildProcess('arm A')
const armB = probeSingleProcess ? armA : drawInChildProcess('arm B')

if (probeSingleProcess)
	console.log(`${TOOL}: PROBE — arm B reuses arm A's digests, so the comparison cannot fail. Falsification only; never a valid pass.`)

let differing = 0
for (const name of streamNames) {
	const a = armA.get(name)
	const b = armB.get(name)
	if (a !== b) {
		differing++
		problems.push(`stream '${name}' differs between processes: ${a} vs ${b} — §5.2 is violated`)
	}
}

// 3. A control. If every stream produced the SAME digest as every other stream, the streams are
//    not actually independent and a cross-process match would be meaningless.
const distinct = new Set(armA.values())
if (distinct.size !== streamNames.length)
	problems.push(
		`only ${distinct.size} distinct digests across ${streamNames.length} streams — forkNamed is not separating ` +
		'them. Cross-process equality would then be trivially satisfiable and prove nothing.',
	)

console.log(`${TOOL}: ${streamNames.length} named streams x ${draws} draws, two processes`)
console.log(`  ${foundStatic.size} static forkNamed call sites scanned, ${dynamicSites} computed-name site(s) documented`)
console.log(`  ${distinct.size} distinct digests (independence control), ${differing} stream(s) differing across processes`)

if (probeSingleProcess) {
	// The inversion: under the probe the comparison is rigged, so agreement is the FAILURE.
	if (differing === 0) {
		console.error(
			`${TOOL}: FAIL — arm B was arm A and the comparison still reported agreement. That is what a ` +
			'single-process check looks like: it can never detect cross-process divergence, so it would report ' +
			'green even if a fresh interpreter produced a completely different stream.',
		)
		process.exit(1)
	}
	console.log(`${TOOL}: PASS — the rigged comparison was detected.`)
	process.exit(0)
}

if (problems.length > 0) {
	for (const p of problems) console.error(`  ${p}`)
	console.error(`${TOOL}: FAIL — ${problems.length} problem(s)`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — every named stream is bit-identical across two fresh processes.`)
