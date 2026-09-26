#!/usr/bin/env node
// STEELSEED — tools/tonegate
// The display transform must preserve neutral. Grey in, grey out.
//
// This gate exists because both AgX matrices in `render/shaders.ts` were TRANSPOSED, and
// the result tinted every pixel in the game blue for the entire life of the project. It was
// invisible to every other gate: `capture` saw a non-black frame, `artcheck` saw reviewed
// generators, `profile` saw a healthy frame time, and `todgate` measured a day/night ratio
// that was wrong in the same direction at every hour, so nothing looked inconsistent.
//
// It also cost three wrong diagnoses. §14.5 first blamed the sun/ambient balance and
// retracted it after measuring 7.56:1 the other way; `t1-render-7` blamed albedo variation
// swamping the shading gradient; and the first attempt at THIS fix blamed a missing matrix
// inversion. All three read the frame as evidence about lighting, when nothing in the
// lighting chain was involved — the mechanism sat three passes downstream of every quantity
// anyone had measured.
//
// The check is pure arithmetic, needs no browser, and runs in milliseconds:
//
//   1. STRUCTURAL — each matrix's row sums must be 1, so each maps (1,1,1) to (1,1,1).
//      This is what a transpose breaks and it is checkable by inspection.
//   2. END TO END — push neutral greys through the ACTUAL pipeline, including the
//      nonlinear log2/contrast stage between the two matrices, and assert the output
//      channels agree. The structural check alone is not sufficient: two matrices can each
//      be individually fine and still fail across a nonlinearity if they are not a
//      matched pair.
//
// The matrices are PARSED OUT OF THE SHADER SOURCE rather than duplicated here. A gate that
// carries its own copy of the value it is checking is testing itself (§10.1 rule 2) — that
// is how `materials.budget-not-tautology` was written wrong, and the whole point here is
// that a second copy is exactly how the first transpose survived.
//
// Usage:
//   node tools/tonegate.mjs [--falsify=transpose|pair]

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = 'tonegate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHADER_SRC = resolve(WEB_ROOT, 'src/render/shaders.ts')
const falsify = (process.argv.find(a => a.startsWith('--falsify=')) ?? '').slice('--falsify='.length)

/** Pull `let <name> = mat3x3<f32>( vec3<f32>(..), vec3<f32>(..), vec3<f32>(..) )` as COLUMNS. */
function parseMat(src, name) {
	const at = src.indexOf(`let ${name} = mat3x3<f32>(`)
	if (at < 0) throw new Error(`${TOOL}: no mat3x3 named '${name}' in render/shaders.ts`)
	const body = src.slice(at, src.indexOf(');', at))
	const cols = [...body.matchAll(/vec3<f32>\(([^)]*)\)/g)]
		.map(m => m[1].split(',').map(s => Number(s.trim())))
	if (cols.length !== 3 || cols.some(c => c.length !== 3 || c.some(Number.isNaN)))
		throw new Error(`${TOOL}: '${name}' did not parse as three vec3<f32> columns`)
	return cols
}

const src = readFileSync(SHADER_SRC, 'utf8')
let inset = parseMat(src, 'inset')
let outset = parseMat(src, 'outset')

// Falsification levers. §10.1 rule 1: a gate that has never been seen red proves nothing.
const transpose = c => [0, 1, 2].map(r => [c[0][r], c[1][r], c[2][r]])
if (falsify === 'transpose') inset = transpose(inset)          // the exact historical defect
else if (falsify === 'pair') outset = transpose(outset)        // one matrix right, one wrong
else if (falsify) throw new Error(`${TOOL}: unknown --falsify=${falsify}`)

// Row r of the mathematical matrix, given column vectors.
const rowSums = c => [0, 1, 2].map(r => c[0][r] + c[1][r] + c[2][r])
const mul = (c, v) => [0, 1, 2].map(r => c[0][r] * v[0] + c[1][r] * v[1] + c[2][r] * v[2])

const problems = []

// --- 1. structural -----------------------------------------------------------
for (const [name, m] of [['inset', inset], ['outset', outset]]) {
	const sums = rowSums(m)
	const worst = Math.max(...sums.map(s => Math.abs(s - 1)))
	if (worst > 1e-6)
		problems.push(
			`${name}: row sums are (${sums.map(s => s.toFixed(6)).join(', ')}), must be (1, 1, 1). ` +
			'This matrix does not map neutral to neutral. The usual cause is a TRANSPOSE — ' +
			'mat3x3(a, b, c) takes COLUMN vectors, and every published AgX listing writes ROWS.',
		)
}

// --- 2. end to end, through the real nonlinearity ----------------------------
// Mirrors agx() in shaders.ts. Kept in step by the parse above: the matrices are the
// shader's own, so only the curve constants are restated, and those are inert literals.
const AGX_MIN_EV = -12.47393
const AGX_MAX_EV = 4.026069
const contrast = x => {
	const x2 = x * x, x4 = x2 * x2
	return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
}
function agx(c) {
	let v = mul(inset, c).map(x => Math.max(x, 0))
	v = v.map(x => Math.min(AGX_MAX_EV, Math.max(AGX_MIN_EV, Math.log2(Math.max(x, 1e-10)))))
	v = v.map(x => (x - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV))
	v = v.map(contrast)
	return mul(outset, v)
}

// 0.18 is mid grey; the rest span deep shadow to blown highlight, because a transform can
// be neutral at one stop and drift at another once the curve's shoulder engages.
const GREYS = [0.005, 0.02, 0.05, 0.18, 0.5, 1.0, 4.0, 16.0]
let worstSpread = 0
let worstAt = 0
for (const g of GREYS) {
	const o = agx([g, g, g])
	const spread = Math.max(...o) - Math.min(...o)
	if (spread > worstSpread) { worstSpread = spread; worstAt = g }
}
// 1/255 is one 8-bit code value. Anything at or above that is visible banding of hue on a
// surface that should be achromatic, which is precisely the reported symptom.
const TOLERANCE = 1 / 512
if (worstSpread > TOLERANCE)
	problems.push(
		`neutral is not preserved: worst channel spread ${worstSpread.toExponential(3)} at grey ${worstAt}, ` +
		`tolerance ${TOLERANCE.toExponential(3)} (half an 8-bit code value). ` +
		'Grey in, grey out is a colorimetric invariant of any display transform.',
	)

console.log(
	`${TOOL}: inset/outset row sums ok=${problems.length === 0}, ` +
	`worst neutral spread ${worstSpread.toExponential(3)} at grey ${worstAt} over ${GREYS.length} stops`,
)

if (problems.length > 0) {
	for (const p of problems) console.error(`  ${p}`)
	console.error(`${TOOL}: FAIL — the display transform does not preserve neutral.`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — grey in, grey out across ${GREYS.length} stops from 0.005 to 16.0.`)
