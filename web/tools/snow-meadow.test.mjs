// Snow buries the meadow (Sept 2026): knee-high grass cards stood in front of every
// soldier's legs, and under snow cover they turned white, so the legs read as holes onto
// the snowy ground. The placement scan now shortens the grass as snow settles and drops
// it once the cover is established. This pins that contract on the pure scan.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

const temp = mkdtempSync(join(tmpdir(), 'steelseed-snowmeadow-'))
const outfile = join(temp, 'scan.mjs')
await build({
	stdin: {
		contents: "export { scanScenery } from './src/units/scenery-scan.ts'; export { Surface } from './src/core/surface.ts'",
		resolveDir: new URL('..', import.meta.url).pathname,
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile,
})
const { scanScenery, Surface } = await import(pathToFileURL(outfile).href)
// The live match scans on a worker, which caches the terrain from the first message and merges
// each later message's per-scan fields into it by name. Build the real worker module too.
const workerFile = join(temp, 'worker.mjs')
await build({ entryPoints: [new URL('../src/units/scenery-scan.worker.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', outfile: workerFile })
const workerSource = workerFile
process.on('exit', () => rmSync(temp, { recursive: true, force: true }))

const N = 16
function scan(snowCover, burns = null) {
	const cells = N * N
	const req = {
		w: N, h: N, originX: 0, originZ: 0,
		surface: new Uint8Array(cells).fill(Surface.grass), resource: new Uint8Array(cells),
		liveType: null, liveDensity: null, liveMax: null,
		fieldW: N, fieldH: N, fieldOriginX: 0, fieldOriginY: 0, presentationRelief: false,
		height: new Uint8Array(cells), ramp: new Uint8Array(cells), metres: new Float32Array(cells),
		cornerY: new Float32Array((N + 1) * (N + 1)), waterLevel: new Float32Array(0), bridges: [],
		shroud: new Uint8Array(cells).fill(2), shroudW: N, shroudH: N, shroudOriginX: 0, shroudOriginY: 0, shroudSeen: true,
		occluders: new Float32Array(0), occluderCount: 0,
		cx: N / 2, cz: N / 2, radius: 12, wind: 0, windX: 0, windZ: 0, time: 0, snowCover,
		cardGrass: true, grassPerCell: 4, grassRadius: 20, grassSeen: 0, oreSeen: 0, gemsSeen: 0,
		burns: burns ? Float32Array.from(burns.flat()) : undefined, burnCount: burns ? burns.length : 0,
	}
	const into = { grass: new Float32Array(4096 * 16), ore: new Float32Array(64 * 16), gems: new Float32Array(64 * 16) }
	const counts = scanScenery(req, into)
	// Column 1's Y is scale * heightScale: how tall each placed card stands.
	let tall = 0
	for (let i = 0; i < counts.grassCount; i++) tall += into.grass[i * 16 + 5]
	const near = (x, z, r) => { let n = 0; for (let i = 0; i < counts.grassCount; i++) if (Math.hypot(into.grass[i * 16 + 12] - x, into.grass[i * 16 + 14] - z) < r) n++; return n }
	return { count: counts.grassCount, meanHeight: counts.grassCount ? tall / counts.grassCount : 0, near }
}

test('bare ground grows the full meadow', () => {
	const bare = scan(0)
	assert.ok(bare.count > 100, `fixture must place a meadow (${bare.count})`)
	assert.ok(bare.meanHeight > .5, `cards stand at full height (${bare.meanHeight.toFixed(3)})`)
})

test('shallow snow shortens the grass to tips', () => {
	const bare = scan(0), shallow = scan(.35)
	assert.equal(shallow.count, bare.count, 'shallow snow keeps every card')
	assert.ok(shallow.meanHeight < bare.meanHeight * .6, `tips only (${shallow.meanHeight.toFixed(3)} vs ${bare.meanHeight.toFixed(3)})`)
	assert.ok(shallow.meanHeight > 0, 'but still visible')
})

test('settled snow leaves no grass standing in front of legs', () => {
	assert.equal(scan(.6).count, 0)
	assert.equal(scan(1).count, 0)
})

// Scorched ground (vfx.md M4/M6): a scorch mark drawn under a knee-high meadow was invisible.
// Grass under a fresh mark burns away and grows back as the mark fades.
test('a fresh scorch burns the grass away, and it grows back as the mark fades', () => {
	const bare = scan(0), fresh = scan(0, [[8, 8, 3, 1]]), fading = scan(0, [[8, 8, 3, 0.3]])
	assert.ok(bare.near(8, 8, 1.5) > 10, 'the fixture has grass at the mark')
	assert.equal(fresh.near(8, 8, 1.5), 0, 'nothing stands inside a fresh mark')
	assert.ok(fresh.near(8, 8, 6) < bare.near(8, 8, 6), 'the mark takes out its area')
	assert.equal(fresh.near(2, 2, 1.5), bare.near(2, 2, 1.5), 'grass away from the mark is untouched')
	assert.ok(fading.near(8, 8, 1.5) > 0, 'a fading mark lets the grass back')
	assert.ok(fading.meanHeight < bare.meanHeight, 'as stubble at first')
})

test('the live worker scan follows snow and scorch after its first message', async () => {
	const replies = []
	globalThis.self = { postMessage: reply => replies.push(reply), onmessage: null }
	await import(pathToFileURL(workerSource).href + '?worker')
	const onmessage = globalThis.self.onmessage
	const N2 = N * N
	const base = {
		w: N, h: N, originX: 0, originZ: 0,
		surface: new Uint8Array(N2).fill(Surface.grass), resource: new Uint8Array(N2),
		liveType: null, liveDensity: null, liveMax: null,
		fieldW: N, fieldH: N, fieldOriginX: 0, fieldOriginY: 0, presentationRelief: false,
		height: new Uint8Array(N2), ramp: new Uint8Array(N2), metres: new Float32Array(N2),
		cornerY: new Float32Array((N + 1) * (N + 1)), waterLevel: new Float32Array(0), bridges: [],
		shroud: new Uint8Array(N2).fill(2), shroudW: N, shroudH: N, shroudOriginX: 0, shroudOriginY: 0, shroudSeen: true,
		occluders: new Float32Array(0), occluderCount: 0,
		cx: N / 2, cz: N / 2, radius: 12, wind: 0, windX: 0, windZ: 0, time: 0, snowCover: 0,
		cardGrass: true, grassPerCell: 4, grassRadius: 20, grassSeen: 0, oreSeen: 0, gemsSeen: 0,
		ticket: 1, grassCap: 4096, oreCap: 64, gemsCap: 64,
	}
	onmessage({ data: base })
	// Later messages drop the static grids, exactly as environment.postScan sends them.
	const later = extra => ({ ...base, ...extra, height: new Uint8Array(0), ramp: new Uint8Array(0), metres: new Float32Array(0),
		cornerY: new Float32Array(0), waterLevel: new Float32Array(0), surface: new Uint8Array(0), resource: new Uint8Array(0) })
	onmessage({ data: later({ ticket: 2, burns: Float32Array.of(8, 8, 3, 1), burnCount: 1 }) })
	onmessage({ data: later({ ticket: 3, snowCover: 1 }) })
	const [first, burnt, snowed] = replies
	assert.ok(first.grassCount > 100, 'the first scan places a meadow')
	assert.ok(burnt.grassCount < first.grassCount, `a later scorch reaches the worker (${burnt.grassCount} vs ${first.grassCount})`)
	assert.equal(snowed.grassCount, 0, 'later settled snow reaches the worker')
	delete globalThis.self
})
