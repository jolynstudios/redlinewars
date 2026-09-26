#!/usr/bin/env node
// STEELSEED — tools/artcheck
// The replacement for `rulecheck` rule 9.0, which is a gate that cannot fail.
//
// Rule 9.0 greps `web/src` for the words neon, cyberpunk, hologram, antigravity, sci-fi and
// futuristic. On 2026-07-30 a human looked at the screen and found that
// `materials/wgsl-field.ts:305` still implements the SUPERSEDED science-fiction Lattice
// spec in full — a hex rib frame, panel traces, and an explicit "No corrosion model: the
// composite does not oxidise" against §9.0's "nothing is pristine, every faction weathers".
// Rule 9.0 returned PASS on that code for two days, because the code says "ceramic
// composite" and "printed in place" — the removed spec's own vocabulary, none of it on the
// word list. See `issues/art-1.md`.
//
// A word-grep cannot decide a question about geometry. So this tool does not try. It checks
// the one thing a static gate honestly can:
//
//   Has every surface been REVIEWED against §9.1 in BOTH passes, and is it UNCHANGED since?
//
// Both halves, because the violation is asserted twice. fieldLattice builds the hex frame;
// shadeLattice independently declares ceramic, zero metalness and no edge wear. That second
// assertion is why removing wearBias from the Lattice set changed nothing — the parameter
// could not reach a shading pass that hardcodes the answer. A gate covering one pass would
// have gone green on half a violation.
//
// The body hash is the load-bearing part. Without it an inventory goes stale silently,
// which is precisely the failure mode: an art-direction change can land in the contract
// and in sets.ts while a generator such as `wgsl-field.ts` is never touched. With the
// hash, editing a generator breaks this gate until someone re-reads it and re-affirms the
// entry — which is the review that did not happen.
//
// This gate starts RED on purpose. Sixteen generators exist and none had ever been reviewed
// against §9.1, so reporting green would have been the same lie rule 9.0 was telling. A gate
// that starts red and names the work is worth more than one that starts green.
//
// Usage:
//   node tools/artcheck.mjs [--update-hashes]   # --update-hashes re-stamps bodies you have re-read

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = 'artcheck'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIELD_SRC = resolve(WEB_ROOT, 'src/materials/wgsl-field.ts')
// The violation this tool exists for is asserted in BOTH passes, not one. fieldLattice
// builds a hex rib frame; shadeLattice independently declares ceramic, zero metalness and
// no edge wear. A gate that hashes only the field half leaves the second assertion
// unguarded — and it is the half that made removing `wearBias: 0` from the set change
// nothing at all, because the shading pass hardcodes what the parameter was meant to reach.
const SHADE_SRC = resolve(WEB_ROOT, 'src/materials/wgsl-pack.ts')
// A THIRD place the removed art direction survived, found while verifying its own fix:
// geo/greeble.ts exports faction-named GreeblePlan presets, and LATTICE_GREEBLE still carried
// `pattern: 'hex'` with a negative plateHeight and `fasteners: 0`. Nothing scanned it — this
// tool covered only materials, giving it a NARROWER file scope than the word-grep it replaced.
const GREEBLE_SRC = resolve(WEB_ROOT, 'src/geo/greeble.ts')
const INVENTORY = resolve(WEB_ROOT, 'src/materials/art-inventory.json')
// The art direction ITSELF is a hashed input, and this is the hole the 2026-08-05 amendment
// exposed. Every entry in the inventory recorded that someone had read a generator against
// "§9.1" — with no record of WHICH §9.1. So amending the art direction silently converted 16
// valid reviews into 16 stale ones, and this tool would have reported PASS on all of them.
//
// That is precisely the failure this tool was built to catch, turned on the tool: a record
// that cannot go stale visibly is indistinguishable from a record that is current. The body
// hash guards "the code changed since review"; this guards "the STANDARD changed since
// review", and both are needed because either one alone reads as green while half the
// question is unasked.
const SPEC_SRC = resolve(WEB_ROOT, '..', 'ARCHITECTURE.md')

const update = process.argv.includes('--update-hashes')
const affirm = (process.argv.find(a => a.startsWith('--affirm=')) ?? '').slice('--affirm='.length)

/**
 * SHA of §9 in full — 9.0, 9.1 and 9.2 — which is the whole art-direction contract.
 *
 * Deliberately the entire section rather than a version string someone has to remember to
 * bump. A version number is a promise; a content hash is a measurement, and the 2026-07-28
 * amendment proves which one this project actually keeps: the art direction changed in three
 * files and `wgsl-field.ts` was simply never touched.
 */
function specSha() {
	const src = readFileSync(SPEC_SRC, 'utf8')
	const from = src.indexOf('### 9.0 ')
	const to = src.indexOf('\n## 10.', from)
	if (from < 0 || to < 0)
		throw new Error(`${TOOL}: cannot locate §9 in ARCHITECTURE.md — the section headings moved`)
	return createHash('sha256').update(src.slice(from, to)).digest('hex').slice(0, 12)
}
const SPEC = specSha()

/**
 * End of a top-level block: the first line that is exactly a closing brace at column 0.
 *
 * Slicing from one symbol to the START of the next is wrong, and the gate caught it on
 * itself — rewriting LATTICE_GREEBLE's doc comment changed FOUNDRY_GREEBLE's hash, because
 * the slice swept up the following comment. A comment edit demanding re-review of the
 * PREVIOUS entity is a false positive, and a gate that cries wolf gets switched off.
 */
function blockEnd(src, from) {
	const close = src.indexOf('\n}', from)
	return close < 0 ? src.length : close + 2
}

/** Every `fn <prefix>X(...) { ... }` in a WGSL source, keyed by the bare surface name. */
function readPass(file, prefix) {
	const src = readFileSync(file, 'utf8')
	const out = new Map()
	const re = new RegExp(`^fn (${prefix}[A-Za-z0-9_]*)\\s*\\(`, 'gm')
	const starts = []
	let m
	while ((m = re.exec(src)) !== null) starts.push({ name: m[1], at: m.index })
	for (let i = 0; i < starts.length; i++) {
		const body = src.slice(starts[i].at, blockEnd(src, starts[i].at))
		out.set(starts[i].name.slice(prefix.length), {
			fn: starts[i].name,
			sha: createHash('sha256').update(body).digest('hex').slice(0, 16),
		})
	}
	return out
}

/** Exported `export const X_GREEBLE: GreeblePlan` presets, with the body each currently has. */
function readGreeblePlans() {
	const src = readFileSync(GREEBLE_SRC, 'utf8')
	const out = new Map()
	const re = /^export const ([A-Z0-9_]+_GREEBLE)\s*:/gm
	const starts = []
	let g
	while ((g = re.exec(src)) !== null) starts.push({ name: g[1], at: g.index })
	for (let i = 0; i < starts.length; i++) {
		const body = src.slice(starts[i].at, blockEnd(src, starts[i].at))
		out.set(starts[i].name, createHash('sha256').update(body).digest('hex').slice(0, 16))
	}
	return out
}

const fields = readPass(FIELD_SRC, 'field')
const shades = readPass(SHADE_SRC, 'shade')

// Inventory entries are keyed by the field function name, so the shade half is looked up by
// the surface suffix. A field with no shade counterpart is itself a finding.
const generators = new Map()
for (const [surface, f] of fields) {
	const s = shades.get(surface)
	generators.set(f.fn, { sha: f.sha, shadeFn: s?.fn ?? null, shadeSha: s?.sha ?? null })
}
for (const [surface, s] of shades)
	if (!fields.has(surface))
		console.error(`${TOOL}: WARNING — ${s.fn} has no field counterpart`)
let inventory
try {
	inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'))
} catch {
	console.error(`${TOOL}: FAIL — no inventory at ${relative(WEB_ROOT, INVENTORY)}.`)
	console.error(`${TOOL}: every field generator must carry a recorded §9.1 review.`)
	process.exit(1)
}

const entries = new Map(inventory.generators.map(e => [e.generator, e]))
const problems = []

// 1. Bijection. A generator with no entry has never been reviewed; an entry with no
//    generator means the record is describing something that no longer exists.
for (const name of generators.keys())
	if (!entries.has(name))
		problems.push(`${name}: exists in wgsl-field.ts with NO inventory entry — never reviewed against §9.1`)
for (const name of entries.keys())
	if (!generators.has(name))
		problems.push(`${name}: inventory entry for a generator that no longer exists — stale record`)

// 2. Review state and drift.
for (const [name, gen] of generators) {
	const e = entries.get(name)
	if (!e) continue
	if (!e.implements || e.implements === 'UNREVIEWED')
		problems.push(`${name}: UNREVIEWED — no recorded §9.1 justification for what it generates`)
	if (e.verdict === 'VIOLATION')
		problems.push(`${name}: recorded VIOLATION of §9.1 — ${e.note ?? 'see issues/'}`)
	// The STANDARD, not the code. An entry reviewed against a superseded art direction is
	// not a review of the current one, and nothing about the generator's own bytes says so.
	if (e.reviewedAgainst !== SPEC)
		problems.push(
			`${name}: reviewed against art direction ${e.reviewedAgainst ?? '(unrecorded)'}, current ${SPEC}. ` +
			'The art direction was AMENDED after this review. Re-read the generator against the ' +
			`current section 9, then affirm with --affirm=${name} — one generator per invocation.`,
		)
	if (e.bodySha && e.bodySha !== gen.sha)
		problems.push(
			`${name}: CHANGED since review (${e.bodySha} -> ${gen.sha}). Re-read it against §9.1, ` +
			'update the entry, then --update-hashes. A generator edited without re-review is how ' +
			'the 2026-07-28 art-direction change failed to reach the shader.',
		)

	// The shading half. Both passes assert the material independently, so reviewing one is
	// reviewing half — see issues/art-1.md, where exactly that scoping error was made.
	if (!gen.shadeFn)
		problems.push(`${name}: no shade${name.slice('field'.length)} counterpart in wgsl-pack.ts`)
	else if (!e.shadeImplements || e.shadeImplements === 'UNREVIEWED')
		problems.push(
			`${name}: SHADE HALF UNREVIEWED — ${gen.shadeFn} decides what this field looks like and ` +
			'has never been read. shadeLattice independently declares ceramic, zero metalness and no ' +
			'edge wear, which is why removing wearBias from the set changed nothing.',
		)
	else if (!e.shadeSha || e.shadeSha !== gen.shadeSha)
		problems.push(`${name}: ${gen.shadeFn} CHANGED since review (${e.shadeSha} -> ${gen.shadeSha})`)
}

// 3. Greeble plans. Same regime, different symbol shape: an exported preset carrying a
//    faction's name is an art-direction assertion whether or not anything calls it yet.
//    LATTICE_GREEBLE was dormant AND wrong for two days because nothing looked.
const greebles = readGreeblePlans()
const greebleEntries = new Map((inventory.greebles ?? []).map(e => [e.plan, e]))
for (const [name, sha] of greebles) {
	const e = greebleEntries.get(name)
	if (!e) {
		problems.push(`${name}: exported GreeblePlan with NO inventory entry — never reviewed against §9.1`)
		continue
	}
	if (!e.implements || e.implements === 'UNREVIEWED')
		problems.push(`${name}: UNREVIEWED — no recorded §9.1 justification`)
	if (e.verdict === 'VIOLATION')
		problems.push(`${name}: recorded VIOLATION of §9.1 — ${e.note ?? 'see issues/'}`)
	if (e.bodySha && e.bodySha !== sha)
		problems.push(`${name}: CHANGED since review (${e.bodySha} -> ${sha})`)
	if (e.reviewedAgainst !== SPEC)
		problems.push(
			`${name}: reviewed against art direction ${e.reviewedAgainst ?? '(unrecorded)'}, current ${SPEC}. ` +
			`Re-read against the current section 9, then --affirm=${name}.`,
		)
}
for (const name of greebleEntries.keys())
	if (!greebles.has(name))
		problems.push(`${name}: inventory entry for a GreeblePlan that no longer exists — stale record`)

// --affirm is deliberately ONE generator per invocation and deliberately separate from
// --update-hashes. Re-stamping a body hash means "I saw the diff"; affirming means "I re-read
// this against a CHANGED standard and it still holds". A single flag that did both would let
// an art-direction amendment be cleared for 16 generators by one keystroke, which is the
// bulk-approval failure `issues/art-1.md` records — 16 unreviewed generators reported green.
if (affirm) {
	const e = entries.get(affirm) ?? greebleEntries.get(affirm)
	if (!e) {
		console.error(`${TOOL}: FAIL — --affirm=${affirm} names no generator or greeble plan in the inventory.`)
		process.exit(1)
	}
	e.reviewedAgainst = SPEC
	writeFileSync(INVENTORY, `${JSON.stringify(inventory, null, '\t')}\n`)
	console.log(`${TOOL}: affirmed ${affirm} against art direction ${SPEC}. Body hashes untouched.`)
}

if (update) {
	for (const [name, gen] of generators) {
		const e = entries.get(name)
		if (e) { e.bodySha = gen.sha; if (gen.shadeSha) e.shadeSha = gen.shadeSha }
	}
	// The greeble plans need stamping too. An earlier version of this block silently missed
	// them — the field and shade hashes updated while the greeble ones did not, and the gate
	// kept reporting CHANGED after a re-stamp. A partial --update-hashes is worse than none,
	// because it looks like the flag ran.
	for (const [name, sha] of greebles) {
		const e = greebleEntries.get(name)
		if (e) e.bodySha = sha
	}
	writeFileSync(INVENTORY, `${JSON.stringify(inventory, null, '\t')}\n`)
	console.log(
		`${TOOL}: re-stamped ${generators.size} surfaces and ${greebles.size} greeble plans. ` +
		'Review markers are untouched — anything unread is still UNREVIEWED.',
	)
}

const reviewed = [...entries.values()].filter(e => e.implements && e.implements !== 'UNREVIEWED').length
const shadeReviewed = [...entries.values()].filter(e => e.shadeImplements && e.shadeImplements !== 'UNREVIEWED').length
console.log(`${TOOL}: ${generators.size} surfaces + ${greebles.size} greeble plans — ${reviewed} field halves and ${shadeReviewed} shade halves reviewed against §9.1, ${problems.length} problem(s)`)

if (problems.length > 0) {
	for (const p of problems) console.error(`  ${p}`)
	console.error(`${TOOL}: FAIL — this gate cannot decide whether geometry matches an art direction.`)
	// The closing line adapts, because a fixed one goes stale the moment the state changes —
	// which is the same drift this whole tool exists to catch.
	const unlooked = (generators.size - reviewed) + (generators.size - shadeReviewed)
	if (unlooked > 0)
		console.error(`${TOOL}: It decides whether anyone has LOOKED. ${generators.size - reviewed} field and ${generators.size - shadeReviewed} shade halves not yet read.`)
	else
		console.error(`${TOOL}: Both passes read for all ${generators.size}. What remains is a real defect, not review debt.`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — every generator reviewed against §9.1 and unchanged since.`)
