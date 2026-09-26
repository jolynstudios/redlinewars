#!/usr/bin/env node
// Actual OpenRA WASM clock + shipped Blender leaf skinning, including dense-map palette use.
// Unlike environmentgate, this leaves requestAnimationFrame, snapshots and weather untouched.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const TOOL = 'livefoliagegate'
const root = resolve(import.meta.dirname, '../..')
const web = join(root, 'web')
const flags = new Map(process.argv.slice(2).map(arg => {
	const [key, ...rest] = arg.replace(/^--/, '').split('=')
	return [key, rest.length ? rest.join('=') : '1']
}))
const port = Number(flags.get('port') ?? 8420)
const name = flags.get('map') ?? 'Doubles'
const fog = flags.get('fog') === '1'
const out = resolve(root, flags.get('out') ?? '.artifacts/livefoliage')
mkdirSync(out, { recursive: true })
const temp = mkdtempSync(join(tmpdir(), 'steelseed-livefoliage-'))
const base = flags.get('url') ?? `http://127.0.0.1:${port}/steelseed/index.html`
const server = flags.has('url') ? null : spawnProcessGroup(process.execPath, [
	join(root, 'engine/OpenRA.Browser/tests/server.mjs'), '--root', join(root, 'engine/bin-browser/AppBundle'), '--port', String(port),
], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
let browser = null
try {
	for (let attempt = 0; attempt < 100; attempt++) {
		try { if ((await fetch(base)).ok) break } catch { /* server startup */ }
		if (attempt === 99) throw new Error('composed server unavailable')
		await new Promise(done => setTimeout(done, 100))
	}
	const launched = await launchGpuBrowser(await loadChromium(TOOL), TOOL)
	browser = launched.browser
	const page = await browser.newPage({ viewport: { width: 1512, height: 982 } })
	const errors = []
	page.on('pageerror', error => errors.push(error.message))
	const url = new URL(base)
	url.searchParams.set('mode', 'game'); url.searchParams.set('platform', 'null')
	await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed, undefined, { timeout: 120000, polling: 100 })
	const catalog = await page.evaluate(() => globalThis.steelseedBridge.getSkirmishCatalog())
	const map = catalog.maps.find(entry => entry.title === name)
	assert.ok(map, `map ${name} missing`)
	const config = configFor(catalog, map, { withBot: false })
	for (const [key, value] of [['fog', String(fog)], ['explored', String(!fog)], ['crates', 'false']]) {
		const option = map.options.find(entry => entry.id.toLowerCase() === key)
		config.options[option.id] = option.values.find(entry => entry.id.toLowerCase() === value).id
	}
	assert.equal((await page.evaluate(value => globalThis.steelseedBridge.startSkirmish(value), config)).status, 'loading')
	await page.waitForFunction(() => globalThis.steelseed.ctx.snapshot?.tick >= 8, undefined, { timeout: 120000, polling: 100 })
	const initial = await page.evaluate(capture)
	assert.ok(initial.trees.length, 'the real match must contain visible trees')
	const middleX = (initial.bounds[0] + initial.bounds[2]) * .5
	const middleZ = (initial.bounds[1] + initial.bounds[3]) * .5
	const byMapCentre = (a, b) => Math.hypot(a.position[0] - middleX, a.position[2] - middleZ) -
		Math.hypot(b.position[0] - middleX, b.position[2] - middleZ)
	const target = [...initial.trees].filter(tree => tree.palette > 0).sort(byMapCentre)[0]
	assert.ok(target, 'no actual tree received a bone palette')
	await page.evaluate(({ position, height }) => {
		const camera = globalThis.steelseed.ctx.get('camera')
		if (height) camera.height = camera.heightGoal = height
		camera.focusWorld(position[0], position[2])
	}, { position: target.position, height: Number(flags.get('height') ?? 0) })
	await page.waitForTimeout(1800)
	const samples = []
	for (let i = 0; i < 17; i++) {
		samples.push(await page.evaluate(capture, target.id))
		if (i === 0 || i === 16) await page.screenshot({ path: join(out, `wind-${i}.png`) })
		await page.waitForTimeout(250)
	}
	await page.evaluate(() => globalThis.steelseed.ctx.session.setPaused(true))
	await page.waitForFunction(() => (globalThis.steelseed.ctx.snapshot.flags & 2) !== 0, undefined, { timeout: 30000, polling: 50 })
	await page.waitForTimeout(250)
	const pausedA = await page.evaluate(capture, target.id)
	await page.waitForTimeout(1000)
	const pausedB = await page.evaluate(capture, target.id)
	await page.evaluate(() => globalThis.steelseed.ctx.session.setPaused(false))
	await page.waitForTimeout(1000)
	const resumed = await page.evaluate(capture, target.id)
	let rigidWitness = null
	const rigidTarget = [...initial.trees].filter(tree => tree.palette === 0).sort(byMapCentre)[0]
	if (rigidTarget) {
		await page.evaluate(position => globalThis.steelseed.ctx.get('camera').focusWorld(position[0], position[2]), rigidTarget.position)
		await page.waitForTimeout(1500)
		const before = await page.evaluate(capture, rigidTarget.id)
		await page.waitForTimeout(1500)
		const after = await page.evaluate(capture, rigidTarget.id)
		await page.screenshot({ path: join(out, 'rigid-tree.png') })
		rigidWitness = { before, after }
	}
	const outfile = join(temp, 'decoder.mjs')
	await build({ stdin: { contents: "export { decodeBlenderAsset } from './src/units/blender-mesh.ts'", resolveDir: web, loader: 'ts' },
		bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile, logLevel: 'silent' })
	const { decodeBlenderAsset } = await import(pathToFileURL(outfile).href)
	const manifest = JSON.parse(readFileSync(join(web, '.forge/blender/manifest.json')))
	const { mesh, rig } = decodeBlenderAsset(new Uint8Array(readFileSync(join(web, '.forge/blender/roster.ssasset'))), manifest.assets[target.type])
	const movingBones = new Set(rig.windBones)
	let leafVertices = 0, maxDisplacementPixels = 0, maxDisplacementWorld = 0
	const baseline = samples[0]
	for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
		if (![0, 1, 2, 3].some(j => movingBones.has(mesh.skinIndices[vertex * 4 + j]) && mesh.skinWeights[vertex * 4 + j] > 0)) continue
		leafVertices++
		const start = skinVertex(mesh, vertex, baseline.selected.bones)
		const startWorld = transformPoint(baseline.selected.matrix, start)
		const startPixel = project(baseline.viewProj, startWorld, baseline.viewport)
		for (const sample of samples.slice(1)) {
			const position = transformPoint(baseline.selected.matrix, skinVertex(mesh, vertex, sample.selected.bones))
			const pixel = project(baseline.viewProj, position, baseline.viewport)
			maxDisplacementPixels = Math.max(maxDisplacementPixels, Math.hypot(pixel[0] - startPixel[0], pixel[1] - startPixel[1]))
			maxDisplacementWorld = Math.max(maxDisplacementWorld, Math.hypot(...position.map((value, i) => value - startWorld[i])))
		}
	}
	const report = { map: name, fog, target, leafVertices, maxDisplacementPixels, maxDisplacementWorld,
		initial, samples, pausedA, pausedB, resumed, rigidWitness, errors }
	writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
	assert.equal(errors.length, 0, errors.join('\n'))
	assert.ok(samples.at(-1).tick > baseline.tick && samples.at(-1).motionTime > baseline.motionTime, 'actual simulation must advance weather')
	assert.ok(maxDisplacementWorld > .001, 'actual animated leaf vertices must move')
	assert.equal(pausedA.tick, pausedB.tick, 'pause must freeze simulation')
	assert.equal(pausedA.motionTime, pausedB.motionTime, 'pause must freeze wind time')
	assert.deepEqual(pausedA.selected.bones, pausedB.selected.bones, 'paused trees must hold their pose')
	assert.ok(resumed.tick > pausedB.tick && resumed.motionTime > pausedB.motionTime, 'resume must restart wind')
	const staticTrees = initial.trees.filter(tree => tree.palette === 0).length
	console.log(`${TOOL}: ${name}; real ticks ${baseline.tick}->${samples.at(-1).tick}, wind=${baseline.windStrength}; ` +
		`${initial.trees.length} visible trees, ${staticTrees} without animation palette, overflows=${initial.skinStats.paletteOverflows}; ` +
		`${target.type} ${leafVertices} leaf vertices, maximum movement ${maxDisplacementPixels.toFixed(3)}px/${maxDisplacementWorld.toFixed(4)}m at camera height ${baseline.camera.height.toFixed(2)}; pause/resume verified`)
	if (flags.has('require-readable')) {
		assert.equal(staticTrees, 0, 'visible trees must not lose animation to bone-palette exhaustion')
		assert.ok(maxDisplacementPixels >= 1, 'default wind must visibly move leaves by at least one CSS pixel')
	}
	console.log(`${TOOL}: PASS — live clock, actual uploaded skin matrices and leaf geometry; evidence ${out}`)
} finally {
	await browser?.close()
	if (server) await stopProcessGroup(server)
	rmSync(temp, { recursive: true, force: true })
}

function capture(selectedId) {
	const app = globalThis.steelseed, ctx = app.ctx
	const units = ctx.get('units'), renderer = ctx.get('render'), camera = ctx.get('camera'), sky = ctx.get('sky')
	const trees = []
	let selected = null
	for (const [type, bucket] of units.slotBuckets) {
		if (!bucket.rig?.windBones.length) continue
		for (let i = 0; i < bucket.count; i++) {
			const matrix = Array.from(bucket.instances.subarray(i * 16, i * 16 + 16))
			const palette = bucket.paletteBases[i]
			const tree = { id: bucket.motionIds[i], type, palette, boneCount: bucket.rig.skeleton.boneCount,
				windBones: bucket.rig.windBones.length, position: matrix.slice(12, 15) }
			trees.push(tree)
			if (tree.id === selectedId) selected = { ...tree, matrix,
				bones: Array.from(renderer.boneData.subarray(palette * 16, (palette + tree.boneCount) * 16)),
				amplitudes: Array.from(bucket.rig.windAmplitudes) }
		}
	}
	return { tick: ctx.snapshot.tick, frame: ctx.time.frame, alpha: ctx.time.alpha,
		bounds: [ctx.snapshot.world.boundsLeft, ctx.snapshot.world.boundsTop, ctx.snapshot.world.boundsRight, ctx.snapshot.world.boundsBottom],
		motionTime: sky.environment.motionTime, windStrength: sky.environment.windStrength,
		viewport: [ctx.canvas.clientWidth, ctx.canvas.clientHeight], viewProj: Array.from(renderer.camera.viewProj),
		camera: { height: camera.height, target: Array.from(camera.target), yaw: camera.yaw },
		skinStats: { ...units.skinStats }, trees, selected }
}

function skinVertex(mesh, vertex, bones) {
	const source = Array.from(mesh.positions.subarray(vertex * 3, vertex * 3 + 3)), result = [0, 0, 0]
	for (let i = 0; i < 4; i++) {
		const weight = mesh.skinWeights[vertex * 4 + i]
		if (!weight) continue
		const bone = mesh.skinIndices[vertex * 4 + i]
		const position = transformPoint(bones.slice(bone * 16, bone * 16 + 16), source)
		for (let axis = 0; axis < 3; axis++) result[axis] += position[axis] * weight
	}
	return result
}
function transformPoint(matrix, point) {
	return [0, 1, 2].map(row => matrix[row] * point[0] + matrix[row + 4] * point[1] + matrix[row + 8] * point[2] + matrix[row + 12])
}
function project(matrix, point, viewport) {
	const clip = transformPoint(matrix, point)
	const w = matrix[3] * point[0] + matrix[7] * point[1] + matrix[11] * point[2] + matrix[15]
	return [(clip[0] / w * .5 + .5) * viewport[0], (.5 - clip[1] / w * .5) * viewport[1]]
}
