#!/usr/bin/env node
// STEELSEED — tools/shroudgate
//
// §4.7 visibility decides what a player may SEE, so its failure modes are asymmetric and only
// one of them is loud. Hiding too much blanks the army and everybody notices within a frame.
// Hiding too LITTLE reveals the enemy base and looks exactly like a working game — which is
// what has actually been shipping, because the shroud section has crossed the bridge and been
// decoded since the bridge landed with nothing consuming it.
//
// So this gate checks BOTH directions against runs it constructs itself, and its controls
// invert the two failures rather than merely breaking the node.
//
// Usage:
//   node --experimental-strip-types tools/shroudgate.mjs [--falsify=missing-reveals|reveal]

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const TOOL = 'shroudgate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = n => {
	const hit = process.argv.find(a => a.startsWith(`--${n}=`))
	return hit ? hit.slice(n.length + 3) : null
}
const falsify = arg('falsify')
if (falsify !== null && falsify !== 'missing-reveals' && falsify !== 'reveal') {
	console.error(`${TOOL}: unknown --falsify=${falsify}`)
	process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'shroudgate-'))
const entry = join(tmp, 'e.ts')
writeFileSync(entry, `export { Shroud } from '${WEB}/src/shroud/index'\n`)
const bundle = join(tmp, 'b.mjs')
await esbuild({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent' })
const { Shroud } = await import(bundle)

const W = 32, H = 32
const UNEXPLORED = 0, EXPLORED = 1, VISIBLE = 2
const problems = []
const snap = (shroud, first) => ({
	shroud,
	terrainStatic: first ? { w: W, h: H } : null,
	actors: null,
})

// --- 1. an absent section must FAIL CLOSED ------------------------------------
{
	const s = new Shroud()
	s.onSnapshot(snap([], true), null, null)
	if (!s.unmodelled) problems.push('a snapshot with no shroud runs left the node claiming to model visibility')
	const missingReveals = falsify === 'missing-reveals'
	const visible = missingReveals ? true : s.isVisible(0, 0) || s.isVisible(W - 1, H - 1)
	if (visible)
		problems.push('with no shroud data the node revealed cells — missing visibility must fail CLOSED')
}

// --- 2. runs land where they are addressed ------------------------------------
{
	const s = new Shroud()
	// One visible band across row 4, and row 5 explored-but-not-visible.
	const runs = [
		{ cellIndex: 4 * W, runLength: W, state: VISIBLE },
		{ cellIndex: 5 * W, runLength: W, state: falsify === 'reveal' ? VISIBLE : EXPLORED },
	]
	s.onSnapshot(snap(runs, true), null, null)

	if (s.unmodelled) problems.push('the node still reports unmodelled after consuming runs')
	for (let x = 0; x < W; x++) {
		if (!s.isVisible(x, 4)) { problems.push(`cell (${x},4) was sent VISIBLE and reads ${s.stateAt(x, 4)}`); break }
	}
	for (let x = 0; x < W; x++) {
		// EXPLORED is remembered ground, not sight. An actor standing here must NOT be drawn:
		// that distinction is the whole reason scouting means anything.
		if (s.isVisible(x, 5)) { problems.push(`cell (${x},5) was sent EXPLORED and reads as visible — explored is memory, not sight`); break }
	}
	if (s.stateAt(0, 6) !== UNEXPLORED) problems.push('an unaddressed cell is not UNEXPLORED — the grid did not start dark')
	const wantVisible = W + (falsify === 'reveal' ? W : 0)
	if (s.visibleCells !== wantVisible)
		problems.push(`visibleCells ${s.visibleCells}, expected ${wantVisible}`)
}

// --- 3. each tick is a complete authoritative grid ----------------------------
{
	const s = new Shroud()
	s.onSnapshot(snap([{ cellIndex: 0, runLength: W, state: VISIBLE }], true), null, null)
	s.onSnapshot(snap([{ cellIndex: 10 * W, runLength: W, state: VISIBLE }], false), null, null)
	if (s.isVisible(0, 0))
		problems.push('row 0 retained stale visibility even though the complete later grid omitted it')
	if (!s.isVisible(0, 10)) problems.push('the second tick\'s run did not land')
}

// --- 4. explored terrain persists after current sight leaves -------------------
{
	const s = new Shroud()
	s.onSnapshot(snap([{ cellIndex: 3 * W, runLength: W, state: VISIBLE }], true), null, null)
	s.onSnapshot(snap([{ cellIndex: 3 * W, runLength: W, state: EXPLORED }], false), null, null)
	if (s.stateAt(0, 3) !== EXPLORED || s.isVisible(0, 3))
		problems.push('a previously visible row did not remain EXPLORED after line-of-sight moved away')
}

// --- 5. missing after valid data must also fail closed -------------------------
{
	const s = new Shroud()
	s.onSnapshot(snap([{ cellIndex: 0, runLength: W, state: VISIBLE }], true), null, null)
	s.onSnapshot(snap([], false), null, null)
	if (!s.unmodelled) problems.push('a zero-run frame after valid data did not invalidate the shroud model')
	if (s.isVisible(0, 0) || s.visibleCells !== 0)
		problems.push('a zero-run frame retained stale visibility — every missing shroud update must fail CLOSED')
}

// --- 6. non-zero origin and out-of-bounds reads ---------------------------------
{
	const s = new Shroud()
	const shifted = snap([{ cellIndex: 0, runLength: 4, state: VISIBLE }], true)
	shifted.world = { boundsLeft: 7, boundsTop: 11 }
	s.onSnapshot(shifted, null, null)
	if (!s.isVisible(7, 11) || s.isVisible(0, 0))
		problems.push('world-cell lookup did not apply the map bounds origin')
	if (s.isVisible(6, 10) || s.isVisible(7 + W, 11 + H))
		problems.push('an out-of-bounds cell read as visible — unknown must not reveal off-map actors')
}

// --- 7. GPU publication happens only when the complete grid or its origin changes ----------
{
	const uploads = []
	const render = {
		setShroud: (cells, w, h, originX, originY) => uploads.push({
			cells: Uint8Array.from(cells), w, h, originX, originY,
		}),
	}
	const s = new Shroud()
	await s.init({ get: id => {
		if (id !== 'render') throw new Error(`unexpected dependency '${id}'`)
		return render
	} })
	const first = snap([{ cellIndex: 0, runLength: W, state: VISIBLE }], true)
	first.world = { boundsLeft: 7, boundsTop: 11 }
	s.onSnapshot(first, null, null)
	if (uploads.length !== 1) problems.push(`first modelled grid published ${uploads.length} times, expected once`)

	const duplicate = snap([{ cellIndex: 0, runLength: W, state: VISIBLE }], false)
	duplicate.world = first.world
	s.onSnapshot(duplicate, first, null)
	if (uploads.length !== 1) problems.push('an identical run rewrote the GPU shroud')

	const changed = snap([{ cellIndex: W, runLength: W, state: EXPLORED }], false)
	changed.world = first.world
	s.onSnapshot(changed, duplicate, null)
	if (uploads.length !== 2) problems.push('a changed row did not publish the complete grid')

	const moved = snap([{ cellIndex: W, runLength: W, state: EXPLORED }], false)
	moved.world = { boundsLeft: 8, boundsTop: 11 }
	s.onSnapshot(moved, changed, null)
	if (uploads.length !== 3 || uploads[2]?.originX !== 8)
		problems.push('an origin-only map change did not republish the transform')
}

console.log(`${TOOL}: ${W}x${H} grid, 7 checks${falsify !== null ? ` (--falsify=${falsify})` : ''}`)
if (problems.length > 0) {
	for (const p of problems) console.error(`  ${p}`)
	console.error(`${TOOL}: FAIL — visibility does not follow §4.7.`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — absent data always fails closed, complete grids replace stale state, origins align, GPU writes only on change.`)
