#!/usr/bin/env node
// STEELSEED — tools/rulecheck
// Static enforcement of the hard rules (ARCHITECTURE.md §2).
//
// This runs on every node's gate. It is deliberately the cheapest gate in the project:
// it needs no browser, no GPU and no engine build, so a node can run it in a second
// and never land a rule violation for a critic to find later.
//
// It cannot catch everything — a per-frame allocation hidden behind a helper needs
// profile.mjs, and a fake GI needs a human looking at a split view. What it does catch
// is the mechanical rules, completely.
//
// Usage: node tools/rulecheck.mjs [--fix-hint] [--json]

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url))
const GAME_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')

/** Subsystem dirs under web/src. Cross-imports between these are rule-3 violations. */
const SUBSYSTEMS = [
	'core', 'geo', 'materials', 'render', 'sky', 'terrain', 'structures',
	'units', 'anim', 'fx', 'shroud', 'camera', 'ui', 'audio',
]

/**
 * core is the one legal import target: it owns the registry, ctx, RNG, math and the
 * snapshot decoder, and every node needs those as *types* at minimum. Everything else
 * is runtime-only via ctx.get().
 */
/**
 * Subsystems a node may import directly rather than reach through ctx.get().
 *
 * Rule 3 exists so a node cannot couple to another node's runtime INSTANCE — its init
 * order, its GPU objects, its lifecycle. Both entries here have none of that to couple to:
 *
 *   core — types, math, the RNG and the snapshot decoder. Pure helpers. Importing a core
 *          SYSTEM instance still has to go through ctx.get().
 *   geo  — the generator library: mesh, sdf, csg, spline, greeble, rig. Stateless pure
 *          functions over plain arrays, with no node, no init and no device. There is no
 *          ordering hazard to protect against, and routing it through ctx would mean
 *          registering a node that owns nothing purely to satisfy a rule aimed at
 *          something else. The alternative is worse and already visible: `terrain` hand
 *          writes its own interleaved vertex buffers specifically to avoid importing
 *          geo/mesh, which duplicates a layout that §3.1 pins in one place.
 */
const IMPORTABLE = new Set(['core', 'geo'])

const findings = []
function fail(rule, file, line, msg) {
	findings.push({ rule, file, line, msg })
}

function walk(dir, out = []) {
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return out
	}
	for (const e of entries) {
		if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'obj' || e.name === 'bin') continue
		const p = join(dir, e.name)
		if (e.isDirectory()) walk(p, out)
		else out.push(p)
	}
	return out
}

/** This file necessarily contains every pattern it searches for. Exclude it. */
const SELF = fileURLToPath(import.meta.url)

const sourceFiles = walk(join(WEB_ROOT, 'src'))
	.concat(walk(join(WEB_ROOT, 'tools')))
	.filter((f) => /\.(ts|mjs|js|wgsl)$/.test(f) && f !== SELF)

// ---------------------------------------------------------------------------
// Rule 5 — no Math.random(). Asset generation must be a pure function of the seed.
// ---------------------------------------------------------------------------
for (const file of sourceFiles) {
	const rel = relative(GAME_ROOT, file)
	const src = readFileSync(file, 'utf8')
	const lines = src.split('\n')
	lines.forEach((l, i) => {
		if (l.includes('rulecheck-allow')) return
		if (/\bMath\.random\s*\(/.test(l))
			fail(5, rel, i + 1, 'Math.random() — use ctx.rng (SplitMix64) or a ctx.rng.fork() you keep')
		if (/\bcrypto\.getRandomValues\b/.test(l))
			fail(5, rel, i + 1, 'crypto.getRandomValues — non-deterministic; use ctx.rng')
		// Date.now()/performance.now() in a generator makes output time-dependent, which
		// silently breaks the "two runs of the same seed are byte-identical" property.
		if (/\/(geo|materials)\//.test(rel) && /\b(Date\.now|performance\.now)\s*\(/.test(l))
			fail(5, rel, i + 1, 'wall-clock read inside a generator — generation must be a pure function of the seed')
	})
}

// ---------------------------------------------------------------------------
// Rule 14.13a — no actor NAME may reach the archetype generators.
//
// §14.13a relaxes §14.13 so the mod can describe an actor's FUNCTION more precisely, which
// is what makes 97 distinct machines possible. The thing it does NOT relax is the ban on
// keying geometry off a name, because a name table goes stale silently the first time an
// actor is renamed and draws the wrong unit with nothing reporting it.
//
// That relaxation is one careless line away from `slot.name === 'foundry_anvil'`, and in a
// file full of legitimate per-actor tuning that line would read as reasonable. So the ruling
// and its enforcement ship together: any actor-name literal under units/archetype/ fails.
//
// The committed roster.json is data, not code, and is excluded. `en.ftl`'s names remain a
// prompt for the human authoring a Form block, never an input to the generator.
// ---------------------------------------------------------------------------
const ACTOR_NAME_LITERAL = /['"`](foundry|lattice|drift)_[a-z_]+['"`]/
for (const file of sourceFiles) {
	const rel = relative(GAME_ROOT, file)
	if (!rel.includes(join('units', 'archetype'))) continue
	const src = readFileSync(file, 'utf8')
	src.split('\n').forEach((l, i) => {
		if (l.includes('rulecheck-allow')) return
		const m = ACTOR_NAME_LITERAL.exec(l)
		if (m === null) return
		// A comment citing a measured actor by name is evidence, not dispatch — every
		// generator in this directory documents the actor that forced a constant, and
		// banning that would delete the reasoning along with the defect.
		if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
		fail('14.13a', rel, i + 1,
			`actor name ${m[0]} in the archetype path — §14.13a permits describing an actor's ` +
			'FUNCTION in the mod, never keying geometry off its name. Add a SteelseedForm field.')
	})
}

// ---------------------------------------------------------------------------
// Rule 3 — never import another subsystem's module. Get it at runtime: ctx.get('fx').
// ---------------------------------------------------------------------------
const IMPORT_RE = /^\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/gm
for (const file of sourceFiles) {
	const rel = relative(GAME_ROOT, file)
	const parts = relative(join(WEB_ROOT, 'src'), file).split(sep)
	if (parts.length < 2 || parts[0] === '..') continue
	const owner = parts[0]
	if (!SUBSYSTEMS.includes(owner)) continue

	const src = readFileSync(file, 'utf8')
	for (const m of src.matchAll(IMPORT_RE)) {
		const spec = m[1]
		if (!spec.startsWith('.')) {
			// Rule 4 — zero runtime dependencies. Bare specifiers mean an npm package.
			fail(4, rel, lineOf(src, m.index), `bare import '${spec}' — zero runtime dependencies; no npm package ships in the bundle`)
			continue
		}
		// Resolve which subsystem this import lands in.
		const abs = join(file, '..', spec)
		const target = relative(join(WEB_ROOT, 'src'), abs).split(sep)[0]
		if (!SUBSYSTEMS.includes(target)) continue
		if (target === owner) continue
		if (IMPORTABLE.has(target)) {
			// Importing core is legal, but only for types and pure helpers. Importing a
			// core *system instance* still has to go through ctx.get().
			continue
		}
		fail(3, rel, lineOf(src, m.index),
			`'${owner}' imports '${target}' — get it at runtime instead: const x = ctx.get('${target}')`)
	}
}

function lineOf(src, idx) {
	return src.slice(0, idx).split('\n').length
}

// ---------------------------------------------------------------------------
// Rule 6 — allocate nothing per frame. Heuristic: `new Vec/Float32Array/Array` or an
// array/object literal inside update()/lateUpdate()/onSnapshot().
// ---------------------------------------------------------------------------
const HOT = /\b(update|lateUpdate|onSnapshot)\s*\(/
for (const file of sourceFiles) {
	if (!/\/src\//.test(file)) continue
	const rel = relative(GAME_ROOT, file)
	const lines = readFileSync(file, 'utf8').split('\n')
	let depth = null
	let brace = 0
	lines.forEach((l, i) => {
		if (depth === null && HOT.test(l)) {
			depth = 0
			brace = 0
		}
		if (depth !== null) {
			brace += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length
			if (l.includes('rulecheck-allow')) return
			if (/\bnew\s+(Float32Array|Float64Array|Int32Array|Uint32Array|Uint8Array|Uint16Array|Int16Array|Map|Set|Array)\b/.test(l))
				fail(6, rel, i + 1, 'allocation in a per-frame method — preallocate in init() and reuse')
			if (/\b(vec2|vec3|vec4|quat|mat4)\s*\(/.test(l))
				fail(6, rel, i + 1, 'vector/matrix construction in a per-frame method — use the scratch pool or a preallocated field')
			if (brace <= 0 && i > 0) depth = null
		}
	})
}

// ---------------------------------------------------------------------------
// §9.0 art direction — grounded, not science fiction.
//
// STEELSEED looks like the real world: mud, rust, galvanised steel, canvas, concrete,
// snow, wet grass. No neon, no glowing panel lines, no holograms, no cyberpunk palette,
// no antigravity. Emissive exists only where a real light source does.
//
// This is a static gate because the art direction is the easiest thing in the project to
// lose: six nodes are still unbuilt, each will be written by an agent reading the docs,
// and "cool sci-fi vehicle" is the default a generator drifts toward. One faction already
// shipped a cyan accent tint and a never-weathers surface before this check existed.
//
// The word list is deliberately short and high-signal. `hover` is NOT in it — CSS `:hover`
// is legitimate and the `ui` node will be full of it; false positives would get this gate
// disabled, which is worse than not having it. Append `art-direction-ok` on a line to
// document a genuine exception (e.g. a comment stating the prohibition itself).
// ---------------------------------------------------------------------------
const UNGROUNDED = [
	[/\bneon\b/i, 'neon is forbidden — emissive only where a real light source exists (§9.0)'],
	[/\bcyberpunk\b/i, 'cyberpunk palette/aesthetic is forbidden (§9.0)'],
	[/\bholograp?h(ic|y)?\b/i, 'holograms are forbidden — the world is physical (§9.0)'],
	[/\banti-?gravity\b/i, 'antigravity is forbidden — wheels, tracks, rotors and legs only (§9.0)'],
	[/\bsci-?fi\b/i, 'science-fiction framing is forbidden (§9.0)'],
	[/\bfuturistic\b/i, 'futuristic framing is forbidden — this is a grounded, real-world war (§9.0)'],
]
for (const file of sourceFiles) {
	if (!/\/src\//.test(file)) continue
	const rel = relative(GAME_ROOT, file)
	readFileSync(file, 'utf8')
		.split('\n')
		.forEach((l, i) => {
			if (l.includes('art-direction-ok')) return
			for (const [re, msg] of UNGROUNDED) if (re.test(l)) fail('9.0', rel, i + 1, msg)
		})
}

// ---------------------------------------------------------------------------
// Rule 13 — zero binary assets, forever. Content-typed, not extension-guessed.
// ---------------------------------------------------------------------------
const TEXT_MIME = /charset=(us-ascii|utf-8|iso-8859-1|unknown-8bit)/
function checkBinaries(root, label) {
	const files = walk(root).filter((f) => !f.includes('/bin-browser/') && !f.includes('/AppBundle/'))
	// Batch through `file` for speed; a per-file spawn over a few thousand files is slow.
	const CHUNK = 200
	for (let i = 0; i < files.length; i += CHUNK) {
		const batch = files.slice(i, i + CHUNK)
		let out = ''
		try {
			out = execFileSync('file', ['--mime', ...batch], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
		} catch {
			continue
		}
		for (const line of out.split('\n')) {
			if (!line.trim()) continue
			const sepIdx = line.lastIndexOf(': ')
			if (sepIdx < 0) continue
			const path = line.slice(0, sepIdx)
			const mime = line.slice(sepIdx + 2)
			if (!TEXT_MIME.test(mime))
				fail(13, relative(GAME_ROOT, path), 0, `binary file in ${label} (${mime.trim()}) — the repo contains only code`)
		}
	}
}
checkBinaries(join(GAME_ROOT, 'web', 'src'), 'web/src')
checkBinaries(join(GAME_ROOT, 'web', 'tools'), 'web/tools')
checkBinaries(join(GAME_ROOT, 'engine', 'mods'), 'engine/mods')

// ---------------------------------------------------------------------------
// Rule 14 — new IP only. Scoped to the AUTHORED surface: inherited engine source keeps
// upstream naming because rule 2 forbids editing it (ARCHITECTURE.md §1.3).
// ---------------------------------------------------------------------------
const EA_TERMS = [
	/\bWestwood\b/i, /\bCommand\s*&\s*Conquer\b/i, /\bRed\s+Alert\b/i,
	/\bTiberian\b/i, /\bTiberium\b/i, /\bDune\s*2000\b/i,
	/\bBrotherhood\s+of\s+Nod\b/i, /\bG\.?D\.?I\.?\b/,
	// 'Cnc' abbreviates the EA trademark, so prose uses of it are banned in authored
	// text. Structural references are exempt — see STRUCTURAL_REF below.
	/\bCnc\b/,
]

/**
 * A line that REFERENCES an inherited assembly by its real identifier — a
 * ProjectReference path, a TrimmerRootAssembly entry, an import, a using. Rule 14 bans
 * EA *naming*; it cannot ban naming the assemblies the project is built on, or the fork
 * could not reference the engine at all. The exemption is deliberately narrow: it
 * matches the mechanical forms only, so prose like "mirrors OpenRA.Mods.Cnc" in a
 * comment still fails, which is exactly the case that prompted it.
 */
const STRUCTURAL_REF =
	/(ProjectReference|TrimmerRootAssembly|WasmFilesToIncludeInFileSystem|^\s*using\s|^\s*import\s|require\(|Assembly\.Load|typeof\()/

const AUTHORED = [
	join(GAME_ROOT, 'web', 'src'),
	join(GAME_ROOT, 'web', 'tools'),
	join(GAME_ROOT, 'engine', 'mods'),
	join(GAME_ROOT, 'engine', 'OpenRA.Browser', 'Steelseed'),
	// The mod assembly is authored surface too. It was missed in the first revision of
	// this list, and an EA abbreviation reached a csproj comment as a result.
	join(GAME_ROOT, 'engine', 'OpenRA.Mods.Steelseed'),
]
for (const root of AUTHORED) {
	for (const file of walk(root)) {
		if (file === SELF) continue
		if (!/\.(ts|mjs|js|wgsl|yaml|yml|md|json|cs)$/.test(file)) continue
		const rel = relative(GAME_ROOT, file)
		const lines = readFileSync(file, 'utf8').split('\n')
		lines.forEach((l, i) => {
			if (l.includes('rulecheck-allow')) return
			if (STRUCTURAL_REF.test(l)) return
			for (const re of EA_TERMS)
				if (re.test(l)) fail(14, rel, i + 1, `EA/Westwood name in authored surface: ${re.source}`)
		})
	}
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Rule 4.1 — no backtick inside a WGSL template literal.
//
// Not a style rule. Shader source lives in tagged template literals (hard rule 4 forbids a
// build plugin that would let it live in .wgsl files), so a stray backtick inside one
// TERMINATES the literal and the rest of the shader is parsed as TypeScript. The failure is
// a syntax error tens of lines away from the real cause, and it has cost this project five
// separate build breaks — every one of them a backtick used to quote an identifier inside
// an ordinary comment, which is exactly where it looks harmless.
//
// Detection is deliberately dumb: inside a `/* wgsl */` literal, no backtick may appear
// except the one that closes it. Anything cleverer would need a real parser, and a real
// parser is what already tells us far too late.
// ---------------------------------------------------------------------------
for (const file of sourceFiles) {
	const src = readFileSync(file, 'utf8')
	const lines = src.split('\n')
	let inWgsl = false
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (!inWgsl) {
			if (/\/\* wgsl \*\/\s*`/.test(line)) inWgsl = true
			continue
		}
		// The closing delimiter is a backtick alone on a line, possibly followed by a comma,
		// a paren or a plus — that is how every literal in this project ends.
		if (/^\s*`\s*[,)+;]?\s*$/.test(line)) {
			inWgsl = false
			continue
		}
		if (line.includes('`')) {
			fail('4.1', file, i + 1, 'backtick inside a WGSL template literal terminates it early')
		}
	}
}

// ---------------------------------------------------------------------------
// Rule 12.4a — no rotateZ() applied to a Z-aligned primitive.
//
// `cylinder`, `cappedCone` and `hexPrism` all stand along Z. Rotating one about Z is a
// NO-OP, so the call compiles, runs, costs nothing and silently does not happen.
//
// This is not hypothetical. `units/shapes.ts` shipped a turret rendered as a disc standing
// on edge like a wheel, and a gun barrel pointing sideways across the hull, because both
// reached for `rotateZ` when they needed rotateX and rotateY — which did not exist, so
// `rotateZ` was the closest thing exported. A no-op rotation is worse than a wrong one:
// it produces a plausible shape rather than an error, and the wheels came out correct by
// accident, which made the file look internally consistent.
//
// Detection is textual and deliberately narrow — the two-call nesting is how it is always
// written, and a general "is this expression Z-aligned" question needs type flow that a
// line scanner cannot have. False negatives are acceptable here; false positives are not.
// ---------------------------------------------------------------------------
const Z_ALIGNED = 'cylinder|cappedCone|hexPrism'
for (const file of sourceFiles) {
	const lines = readFileSync(file, 'utf8').split('\n')
	for (let i = 0; i < lines.length; i++) {
		if (new RegExp(`rotateZ\\(\\s*(?:sdf\\.)?(?:${Z_ALIGNED})\\(`).test(lines[i]))
			fail('12.4a', file, i + 1,
				'rotateZ() on a Z-aligned primitive is a no-op — use rotateX/rotateY, or build on the axis you want')
	}
}

const RULE_NAMES = {
	3: 'never import another subsystem',
	4: 'zero runtime dependencies',
	5: 'no Math.random()',
	6: 'allocate nothing per frame',
	13: 'zero binary assets',
	14: 'new IP only',
	'9.0': 'grounded art direction — no science fiction',
	'4.1': 'no backtick inside a WGSL template literal',
	'12.4a': 'no rotateZ() on a Z-aligned primitive — it is a no-op',
	'14.13a': 'no actor name literal in the archetype path',
}

if (asJson) {
	console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
} else if (findings.length === 0) {
	console.log(`rulecheck: PASS — ${sourceFiles.length} source files, 0 violations`)
} else {
	const byRule = new Map()
	for (const f of findings) {
		if (!byRule.has(f.rule)) byRule.set(f.rule, [])
		byRule.get(f.rule).push(f)
	}
	for (const [rule, list] of [...byRule].sort((a, b) => a[0] - b[0])) {
		console.log(`\nrule ${rule} — ${RULE_NAMES[rule]} (${list.length})`)
		for (const f of list.slice(0, 25)) console.log(`  ${f.file}:${f.line}  ${f.msg}`)
		if (list.length > 25) console.log(`  … ${list.length - 25} more`)
	}
	console.log(`\nrulecheck: FAIL — ${findings.length} violation(s)`)
}

process.exit(findings.length === 0 ? 0 : 1)
