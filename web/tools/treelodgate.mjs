#!/usr/bin/env node
// Is a declared tree LOD chain actually CHEAPER than the one the renderer builds for free?
//
// The report that started this was "the scenery flickers, some are shown some are not even when
// they are there... it happens on large maps like jungle law", and the diagnosis handed over
// with it was that only `tc04` had a LOD chain and the other 21 trees "render their FULL mesh at
// every distance". That second half is not true, and this gate exists because believing it costs
// triangles rather than saving them.
//
// MEASURED. `MeshStore.upload` (`src/render/gpumesh.ts:97`) calls
// `Mesh.generateLodChain(LOD_LEVELS, LOD_FALLOFF)` on every mesh that does not arrive with
// authored levels, so a tree with no pack entry already has three levels at 100/50/25 percent.
// Running that exact call over the shipping roster: `tc03` 59,852 -> 29,926 -> 14,962,
// `tc05` 38,028 -> 19,014 -> 9,506, and so on for all 22 living trees, every one of them landing
// within 0.1% of the nominal ratio. Nothing renders its full mesh at every distance.
//
// What that automatic chain costs is not triangles, it is LEAVES. QEM reaches its budget on a
// tree by DELETING foliage: `tc05` carries 34,956 leaf triangles at L0 and 7,504 at L2, so 79%
// of the canopy is gone by the time the camera has pulled back, and the crown thins from a solid
// mass to a scatter with brown branch showing through. That is a colour-mass pop, and it is the
// same complaint the flicker was.
//
// So a declared chain earns its place by holding EVERY foliage cluster while costing LESS than
// the automatic chain it displaces. The first authored chain did neither: `tc04` was declared at
// 4,692 -> 4,044 -> 3,720 against a free 4,692 -> 2,346 -> 1,172, because it reduced only the
// canopy and never touched the 3,072 triangles of trunk, collars, roots and 81 fine twigs that
// the canopy hides. Declaring it made the tree 72% more expensive at L1 and 217% at L2, in the
// main pass and again in every shadow cascade.
//
// ASSERTIONS
//   1. Every renderable tree resolves to exactly three levels with strictly decreasing counts.
//   2. A DECLARED level never costs more than the automatic level it replaces, and never more
//      than `LOD_FALLOFF ** level` of its own L0. Assertion 2 is the one the first authored
//      chain failed; the negative fixtures below re-run it against those exact numbers.
//   3. A DECLARED level keeps every foliage cluster owner it had at L0. A level may drop planes
//      from a cluster; dropping the cluster loses a wind owner and thins the crown.
//
// It also prints the tree population of a real large map through `Renderer.applyBudget`'s own
// arithmetic — main = triangles x instances x 2 (prepass + forward), shadow = triangles x
// instances x cascades — because the budget is what evicts a draw item, and the eviction is
// what the human saw.
//
// Usage: node tools/treelodgate.mjs [--pack=<dir>] [--map=<map.yaml>] [--quality=high]
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'

const TOOL = 'treelodgate'
const web = resolve(import.meta.dirname, '..')
const repo = resolve(web, '..')
const arg = (name, fallback) => {
	const found = process.argv.find(a => a.startsWith(`--${name}=`))
	return found ? found.slice(name.length + 3) : fallback
}
const PACK = resolve(web, arg('pack', '.forge/tree-lods'))
const MAP = resolve(repo, arg('map', 'engine/openra/mods/ra/maps/jungle-law/map.yaml'))
const QUALITY = arg('quality', 'high')
const json = path => JSON.parse(readFileSync(path))

// The renderer's own constants, read rather than restated. A change to either must reach here.
const gpumesh = readFileSync(resolve(web, 'src/render/gpumesh.ts'), 'utf8')
const LOD_LEVELS = Number(/^const LOD_LEVELS = (\d+)$/m.exec(gpumesh)?.[1])
const LOD_FALLOFF = Number(/^const LOD_FALLOFF = ([\d.]+)$/m.exec(gpumesh)?.[1])
assert.ok(LOD_LEVELS === 3 && LOD_FALLOFF > 0 && LOD_FALLOFF < 1,
	`${TOOL}: could not read LOD_LEVELS/LOD_FALLOFF out of src/render/gpumesh.ts`)
assert.match(gpumesh, /generateLodChain\(LOD_LEVELS, LOD_FALLOFF\)/,
	`${TOOL}: MeshStore.upload no longer builds the automatic chain this gate compares against`)
const config = readFileSync(resolve(web, 'src/core/config.ts'), 'utf8')
const tier = new RegExp(`\\b${QUALITY}: \\{[^}]*?triangles: ([\\d_]+),[^}]*?shadowCascades: (\\d+),`, 's').exec(config)
assert.ok(tier, `${TOOL}: no '${QUALITY}' budget in src/core/config.ts`)
const TRIANGLE_BUDGET = Number(tier[1].replaceAll('_', ''))
const CASCADES = Number(tier[2])

const bundle = await build({ stdin: { contents: `
	export { decodeBlenderAsset } from './src/units/blender-mesh.ts'
	export { Mesh } from './src/geo/mesh.ts'
`, resolveDir: web }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

const roster = json(resolve(web, '.forge/blender/manifest.json'))
const rosterBytes = new Uint8Array(readFileSync(resolve(web, '.forge/blender/roster.ssasset')))
const declared = existsSync(resolve(PACK, 'manifest.json')) ? json(resolve(PACK, 'manifest.json')) : { assets: {} }
const packBytes = existsSync(resolve(PACK, 'trees.ssmesh.gz'))
	? new Uint8Array(gunzipSync(readFileSync(resolve(PACK, 'trees.ssmesh.gz')))) : new Uint8Array(0)

// Zone 6 broadleaf, 25 pine needles, 26 leaf undersides: everything a canopy is made of.
const FOLIAGE = new Set([6, 25, 26])
const census = mesh => {
	let foliage = 0
	const owners = new Set()
	for (let i = 0; i < mesh.triangleCount * 3; i += 3) {
		const v = mesh.indices[i]
		if (!FOLIAGE.has(mesh.materialZone[v])) continue
		foliage++
		if (mesh.skinIndices) for (let j = 0; j < 4; j++) if (mesh.skinWeights[v * 4 + j] !== 0) owners.add(mesh.skinIndices[v * 4 + j])
	}
	return { triangles: mesh.triangleCount, foliage, owners }
}

const trees = Object.entries(roster.assets)
	.filter(([, a]) => a.template === 'tree' && !a.hidden)
	.sort((a, b) => b[1].triangles - a[1].triangles)
assert.ok(trees.length >= 20, `${TOOL}: the roster holds only ${trees.length} trees`)

const rows = []
for (const [id, entry] of trees) {
	const { mesh } = api.decodeBlenderAsset(rosterBytes, entry)
	const base = census(mesh)
	// The automatic chain, built by the same call the renderer makes. Level 0 is a clone.
	const automatic = api.Mesh.prototype.generateLodChain.call(mesh, LOD_LEVELS, LOD_FALLOFF).map(census)
	const pack = declared.assets[id]
	const authored = pack ? pack.levels.map(l => census(api.decodeBlenderAsset(packBytes, l).mesh)) : null
	rows.push({ id, base, automatic, authored, live: !id.includes('.') })
}

function check(row) {
	const { id, automatic, authored } = row
	const chain = authored ?? automatic
	// 1. Three levels, strictly cheaper each time.
	assert.equal(chain.length, LOD_LEVELS, `${TOOL}: ${id} resolves to ${chain.length} levels`)
	for (let level = 1; level < chain.length; level++)
		assert.ok(chain[level].triangles < chain[level - 1].triangles,
			`${TOOL}: ${id} level ${level} is ${chain[level].triangles} triangles against ` +
			`${chain[level - 1].triangles} above it — a level that is not cheaper is not a level`)
	if (!authored) return
	for (let level = 1; level < chain.length; level++) {
		// 2. Declaring a chain must not cost more than not declaring one.
		const ceiling = Math.min(automatic[level].triangles, Math.floor(authored[0].triangles * LOD_FALLOFF ** level))
		assert.ok(authored[level].triangles <= ceiling,
			`${TOOL}: ${id} declares level ${level} at ${authored[level].triangles} triangles, but the renderer ` +
			`would build ${automatic[level].triangles} for free and the ${LOD_FALLOFF ** level} budget is ` +
			`${Math.floor(authored[0].triangles * LOD_FALLOFF ** level)}. A declared level that costs more than ` +
			'the automatic one it displaces is a regression in the main pass and in every shadow cascade.')
		// 3. Cheaper by dropping planes, never by dropping clusters.
		assert.ok(authored[level].owners.size === authored[0].owners.size &&
			[...authored[0].owners].every(o => authored[level].owners.has(o)),
			`${TOOL}: ${id} level ${level} keeps ${authored[level].owners.size} of ${authored[0].owners.size} ` +
			'foliage clusters. Losing a cluster loses a wind owner and thins the crown.')
	}
}
for (const row of rows) check(row)

// --- negative fixtures: the assertions above must reject what actually shipped ---------------
const fixtures = [
	['the first authored tc04 chain, which cost more than no chain at all',
		{ id: 'tc04', automatic: [4692, 2346, 1172], authored: [4692, 4044, 3720], owners: [27, 27, 27] }, /costs more than|would build/],
	['a level that is not cheaper than the level above it',
		{ id: 'x', automatic: [1000, 500, 250], authored: [1000, 400, 400], owners: [9, 9, 9] }, /not cheaper is not a level/],
	['a level that saves triangles by deleting whole clusters',
		{ id: 'y', automatic: [1000, 500, 250], authored: [1000, 400, 200], owners: [9, 9, 5] }, /thins the crown/],
]
for (const [name, spec, pattern] of fixtures) {
	const row = {
		id: spec.id,
		automatic: spec.automatic.map(t => ({ triangles: t, foliage: t, owners: new Set() })),
		authored: spec.authored.map((t, i) => ({ triangles: t, foliage: t, owners: new Set(Array.from({ length: spec.owners[i] }, (_, k) => k)) })),
	}
	assert.throws(() => check(row), pattern, `${TOOL}: fixture '${name}' was accepted`)
}

// --- what the tree population of a real map demands ------------------------------------------
assert.ok(existsSync(MAP), `${TOOL}: ${MAP} is missing`)
const population = new Map()
for (const [, id] of readFileSync(MAP, 'utf8').matchAll(/^\s+Actor\d+:\s*([a-z0-9]+)\s*$/gm))
	if (declared.assets[id] || roster.assets[id]?.template === 'tree') population.set(id, (population.get(id) ?? 0) + 1)
const placed = [...population].filter(([id]) => rows.some(r => r.id === id))
assert.ok(placed.length >= 5, `${TOOL}: ${MAP} placed only ${placed.length} kinds of tree`)

const byLevel = [0, 1, 2].map(level => placed.reduce((total, [id, count]) => {
	const row = rows.find(r => r.id === id)
	return total + (row.authored ?? row.automatic)[level].triangles * count
}, 0))
const instances = placed.reduce((t, [, c]) => t + c, 0)

for (const row of rows.filter(r => r.live)) {
	const count = population.get(row.id) ?? 0
	const chain = row.authored ?? row.automatic
	console.log(`${TOOL}: ${row.id.padEnd(5)} ${row.authored ? 'declared ' : 'automatic'} ` +
		`${chain.map(l => String(l.triangles).padStart(6)).join(' ')}  foliage ` +
		`${chain.map(l => String(l.foliage).padStart(6)).join(' ')}  clusters ` +
		`${chain.map(l => String(l.owners.size).padStart(3)).join(' ')}  x${String(count).padStart(4)} on the map`)
}
console.log(`${TOOL}: ${instances} tree instances of ${placed.length} kinds on ${MAP.split('/').at(-2)} demand ` +
	byLevel.map((t, l) => `L${l} ${t.toLocaleString()}`).join(', ') + ' triangles of geometry; through ' +
	`applyBudget that is ${byLevel.map((t, l) => `L${l} ${(t * 2).toLocaleString()} main + ${(t * CASCADES).toLocaleString()} shadow = ` +
		`${((t * (2 + CASCADES)) / TRIANGLE_BUDGET * 100).toFixed(0)}% of the ${QUALITY} budget`).join('; ')}`)
console.log(`${TOOL}: PASS — ${rows.length} trees, ${rows.filter(r => r.authored).length} with a declared chain, ` +
	`${fixtures.length} negative fixtures rejected, ${TRIANGLE_BUDGET.toLocaleString()}-triangle ${QUALITY} budget, ` +
	`${CASCADES} shadow cascades`)
