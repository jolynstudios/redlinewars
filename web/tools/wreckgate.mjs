#!/usr/bin/env node
// STEELSEED — tools/wreckgate
//
// Proves that a kind-5 destruction preserves the exact mesh, placed transform, faction colour
// and motion identity that production units submitted, then persists as fully damaged world
// geometry under shroud. The production witness injects the same event into the live app so a
// missing pipeline or unregistered node cannot hide behind the structural assertions.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'

const TOOL = 'wreckgate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const falsify = process.argv.includes('--falsify=zero') ? 'zero' : null
if (process.argv.some(a => a.startsWith('--falsify=') && a !== '--falsify=zero')) {
	console.error(`${TOOL}: only --falsify=zero is supported`)
	process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'wreckgate-'))
const entry = join(tmp, 'e.ts')
writeFileSync(entry, [
	`export { Wrecks } from '${WEB}/src/wrecks/index'`,
	`export { CoreEvent, EventBus, SimEvent } from '${WEB}/src/core/events'`,
].join('\n') + '\n')
const bundle = join(tmp, 'b.mjs')
await esbuild({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent' })
const { Wrecks, CoreEvent, EventBus, SimEvent } = await import(bundle)

const problems = []
const note = message => problems.push(message)
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps
const bytes = new ArrayBuffer(96)
const view = new DataView(bytes)
const OFFSET = 17
const event = { kind: 5, offset: OFFSET, byteLength: 18 }
const DESTROYED = { id: 0x12345, x: 7.25, y: 1.875, z: -3.5, kind: 0, violence: 207 }

function writeDestroyed(e) {
	view.setUint32(OFFSET, e.id, true)
	view.setInt32(OFFSET + 4, Math.round(e.x * 1024), true)
	view.setInt32(OFFSET + 8, Math.round(e.z * 1024), true)
	view.setInt32(OFFSET + 12, Math.round(e.y * 1024), true)
	view.setUint8(OFFSET + 16, e.kind)
	view.setUint8(OFFSET + 17, e.violence)
}

const meshA = { indexCount: 912, label: 'production:actor-a' }
const meshB = { indexCount: 408, label: 'production:actor-b' }
const REJECTED_ID = 0xfffffff0
const REPLACEMENT_ID = 0xfffffff1
const placed = new Float32Array([
	0.6, 0.2, -0.1, 0,
	-0.1, 0.97, 0.21, 0,
	0.2, -0.18, 0.95, 0,
	DESTROYED.x, DESTROYED.y, DESTROYED.z, 1,
])
const events = new EventBus()
const submitted = []
let shroudUnmodelled = true
let visible = true
let allowAnyVisual = false
let animatedDeathKind = 0
const units = {
	deathKindOf() { return animatedDeathKind },
	// These actors have no authored condition ladder, which is the case for 279 of the 281.
	// `damagestategate` covers the branch where a Dead rung exists.
	deadRungOf() { return null },
	visitVisuals(visit) {
		visit(meshA, 'lattice')
		visit(meshB, 'foundry')
	},
	captureActorVisual(id, out, offset, record) {
		if (id === REJECTED_ID || (!allowAnyVisual && id !== DESTROYED.id)) return false
		out.set(placed, offset)
		record.mesh = meshA
		record.surfaceSet = 'lattice'
		record.playerColor = 2
		return true
	},
}
const render = {
	submit(item) {
		submitted.push({
			mesh: item.mesh,
			surfaceSet: item.surfaceSet,
			instanceCount: item.instanceCount,
			instances: item.instances.slice(0, item.instanceCount * 16),
			colors: item.playerColors?.slice(0, item.instanceCount) ?? null,
			motionIds: item.motionIds?.slice(0, item.instanceCount) ?? null,
			damages: item.damages?.slice(0, item.instanceCount) ?? null,
			castsShadow: item.castsShadow,
		})
	},
}
const shroud = {
	get unmodelled() { return shroudUnmodelled },
	isVisible() { return visible },
}
const ctx = {
	snapshot: { view },
	events,
	get(id) {
		if (id === 'render') return render
		if (id === 'units') return units
		if (id === 'shroud') return shroud
		throw new Error(`${TOOL}: unexpected dependency ${id}`)
	},
}
const node = new Wrecks()
node.init(ctx)
const frame = () => { submitted.length = 0; node.update(1 / 60, ctx) }
const emit = e => {
	if (falsify === 'zero') return
	writeDestroyed(e)
	events.emit(SimEvent.actorDestroyed, event)
}

frame()
if (submitted.length !== 0) note('empty battlefield submitted a wreck draw')
emit(DESTROYED)
frame()
const draw = submitted[0]
if (draw === undefined) note('one visible authoritative death produced no persistent wreck')
else {
	if (draw.mesh !== meshA) note('wreck replaced the actor-specific production mesh')
	if (draw.surfaceSet !== 'lattice') note(`wreck changed faction material to ${draw.surfaceSet}`)
	if (draw.instanceCount !== 1) note(`one death produced ${draw.instanceCount} wreck instances`)
	if (draw.colors?.[0] !== 2) note(`wreck changed player colour to ${draw.colors?.[0]}`)
	if (draw.motionIds?.[0] !== DESTROYED.id) note('wreck lost the actor motion identity at the death transition')
	if (draw.damages?.[0] !== 1) note(`wreck damage is ${draw.damages?.[0]}, expected destroyed=1`)
	if (draw.castsShadow !== true) note('solid wreck does not cast a shadow')
	for (let i = 0; i < 16; i++)
		if (!close(draw.instances[i], placed[i])) note(`placed transform changed at float ${i}: ${draw.instances[i]} != ${placed[i]}`)
}

// Persistence is state owned by wrecks, not a one-frame replay of the event.
for (const kind of [1, 2, 3]) {
	animatedDeathKind = kind
	const before = node.stats.retained
	emit(DESTROYED)
	if (node.stats.retained !== before) note(`animated death kind ${kind} left a second persistent intact body`)
}
animatedDeathKind = 0
for (let i = 0; i < 180; i++) frame()
if (falsify !== 'zero' && submitted[0]?.instanceCount !== 1)
	note('wreck did not persist after 180 presentation frames')

if (falsify !== 'zero') {
	node.onSnapshot({ tick: 0 }, { tick: 1800 }, ctx)
	frame()
	if (submitted.length !== 0 || node.stats.retained !== 0)
		note('tick rewind kept the previous match\'s wrecks on the new battlefield')
	emit(DESTROYED)
	frame()
	if (submitted[0]?.instanceCount !== 1) note('wreck after a new match did not persist')
	events.emit(CoreEvent.newWorld)
	frame()
	if (submitted.length !== 0 || node.stats.retained !== 0)
		note('Play again kept the previous match\'s wrecks on the new battlefield')
	emit(DESTROYED)
	frame()
}

// Shroud affects current submission, not retention. Returning to the cell restores the same
// wreck; no enemy casualty is leaked while hidden.
shroudUnmodelled = false
visible = false
frame()
if (submitted.length !== 0) note('hidden wreck leaked geometry through shroud')
visible = true
frame()
if (falsify !== 'zero' && submitted[0]?.instanceCount !== 1) note('visible retained wreck did not return')

const malformedBefore = node.stats.malformedEvents
if (falsify !== 'zero') events.emit(SimEvent.actorDestroyed, { kind: 5, offset: OFFSET, byteLength: 8 })
frame()
if (falsify !== 'zero' && node.stats.malformedEvents !== malformedBefore + 1)
	note('truncated destruction record was not diagnosed')

// Fill the global ring with one visual. The 256th accepted event reaches capacity but does
// not evict; a failed capture at capacity must not advance or overwrite the oldest slot.
if (falsify !== 'zero') {
	allowAnyVisual = true
	for (let i = 1; i < 256; i++) emit({ ...DESTROYED, id: DESTROYED.id + i })
	if (node.stats.retained !== 256 || node.stats.evicted !== 0)
		note(`capacity fill retained/evicted ${node.stats.retained}/${node.stats.evicted}, expected 256/0`)
	frame()
	if (submitted[0]?.motionIds?.[0] !== DESTROYED.id)
		note('capacity fill did not preserve the oldest wreck before overflow')

	emit({ ...DESTROYED, id: REJECTED_ID })
	frame()
	if (node.stats.retained !== 256 || node.stats.evicted !== 0 || submitted[0]?.motionIds?.[0] !== DESTROYED.id)
		note('failed capture at capacity overwrote or evicted a retained wreck')

	emit({ ...DESTROYED, id: REPLACEMENT_ID })
	frame()
	if (node.stats.retained !== 256 || node.stats.evicted !== 1)
		note(`first overflow retained/evicted ${node.stats.retained}/${node.stats.evicted}, expected 256/1`)
	if (submitted[0]?.motionIds?.[0] !== REPLACEMENT_ID)
		note('first overflow did not replace exactly the oldest wreck')
}

// --- production presented-pixel witness --------------------------------------
let visual = null
if (falsify === null && problems.length === 0) {
	let browser = null
	let server = null
	try {
		const chromium = await loadChromium(TOOL)
		const launched = await launchGpuBrowser(chromium, TOOL)
		browser = launched.browser
		if (launched.warning) console.warn(launched.warning)
		const preview = await startPreview(8393)
		server = preview.server
		const context = await browser.newContext({
			viewport: { width: 960, height: 540 },
			deviceScaleFactor: 1,
			locale: 'en-US',
			timezoneId: 'UTC',
		})
		const page = await context.newPage()
		const pageErrors = []
		page.on('pageerror', error => pageErrors.push(`pageerror: ${error.message}`))
		page.on('console', message => {
			if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text()))
				pageErrors.push(`console.error: ${message.text()}`)
		})
		const url = new URL(preview.baseUrl)
		url.searchParams.set('devmap', '1')
		url.searchParams.set('deterministic', '1')
		url.searchParams.set('manual', '1')
		url.searchParams.set('seed', 'steelseed-wreck-visual-v1')
		// The witness needs an actor of the persistent static-wreck family, i.e. a building.
		// The devmap's implicit spawn table filled up with living scenery as the world pass
		// grew, so the fixture spawns its own factory explicitly instead of assuming one.
		url.searchParams.set('devtypes', 't01,t02,t03')
		url.searchParams.set('devactors', '6')
		url.searchParams.set('devsize', '96')
		url.searchParams.set('quality', 'high')
		await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined, { timeout: 120000, polling: 100 })
		visual = await page.evaluate(async () => {
			const app = globalThis.steelseed
			app.stop()
			const render = app.registry.peek('render')
			const camera = app.registry.peek('camera')
			const units = app.registry.peek('units')
			const wrecks = app.registry.peek('wrecks')
			if (render == null || camera == null || units == null || wrecks == null)
				throw new Error('production app is missing render, camera, units or wrecks')
			let frame = 0
			// Snapshot intake awaits the actor table; synchronous frames cannot settle it.
			for (let i = 0; i < 120 && app.ctx.snapshot === null; i++) {
				await new Promise(resolve => setTimeout(resolve, 16))
				app.renderOneFrame(frame++ * (1000 / 60))
			}
			for (let i = 0; i < 8; i++) app.renderOneFrame(frame++ * (1000 / 60))
			app.bridge.pollSnapshot = () => null
			const actors = app.ctx.snapshot?.actors
			if (actors == null || actors.count === 0) throw new Error('production fixture has no actor')
			// Select something the production units node really submitted. Actor 0 is not a
			// stable fixture contract and may be outside the local player's shroud; forcing a
			// wreck for it would turn the witness into an information-leak falsifier.
			const actorTransform = new Float32Array(16)
			const actorVisual = { mesh: null, surfaceSet: '', playerColor: 0 }
			let actorIndex = -1
			for (let i = 0; i < actors.count; i++) {
				// This gate covers persistent static wrecks. Animated casualties have their
				// own fall/breakup/fade gate and must not leave a second intact corpse.
				if (units.deathKindOf(actors.id[i]) !== 4) continue
				if (!units.captureActorVisual(actors.id[i], actorTransform, 0, actorVisual)) continue
				actorIndex = i
				break
			}
			if (actorIndex < 0) {
				const kinds = {}
				for (let i = 0; i < actors.count; i++) {
					const k = units.deathKindOf(actors.id[i])
					kinds[k] = (kinds[k] ?? 0) + 1
				}
				throw new Error(`production fixture has no submitted visible actor: count ${actors.count}, deathKinds ${JSON.stringify(kinds)}`)
			}
			const id = actors.id[actorIndex]
			const x = actors.posX[actorIndex] / 1024
			const z = actors.posY[actorIndex] / 1024
			const y = actors.posZ[actorIndex] / 1024
			camera.target.set([x, y, z])
			camera.targetGoal.set([x, y, z])
			camera.height = 20
			camera.heightGoal = 20
			camera.yaw = 0.71
			camera.yawGoal = 0.71
			document.getElementById('boot')?.setAttribute('hidden', '')
			render.probes.updatesPerFrame = 0

			const capture = () => {
				app.ctx.time.elapsed = 1
				app.ctx.time.frame = 60
				app.ctx.time.alpha = 0.5
				render.frameIndex = 0
				render.historyValid = false
				app.renderOneFrame(1000)
				const source = app.ctx.canvas
				const copy = document.createElement('canvas')
				copy.width = source.width
				copy.height = source.height
				const g = copy.getContext('2d')
				if (g == null) throw new Error('cannot create capture canvas')
				g.drawImage(source, 0, 0)
				return new Uint8ClampedArray(g.getImageData(0, 0, copy.width, copy.height).data)
			}
			const compare = (a, b) => {
				let changed = 0, max = 0
				for (let i = 0; i < a.length; i += 4) {
					const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
					if (d > 1) changed++
					max = Math.max(max, d)
				}
				return { changed, max }
			}
			// The selected actor may be far from the boot camera. Let production exposure and
			// camera history settle at the pinned view before measuring the two-frame noise
			// floor; otherwise the camera cut is falsely attributed to a wreck.
			for (let i = 0; i < 8; i++) capture()
			const baselineA = capture()
			const baseline = capture()
			const v = app.ctx.snapshot.view
			const o = v.byteLength - 108
			v.setUint32(o, id, true)
			v.setInt32(o + 4, Math.round(x * 1024), true)
			v.setInt32(o + 8, Math.round(z * 1024), true)
			v.setInt32(o + 12, Math.round(y * 1024), true)
			v.setUint8(o + 16, 0)
			v.setUint8(o + 17, 220)
			app.events.emit('sim:actor:destroyed', { kind: 5, offset: o, byteLength: 18 })
			const withWreck = capture()
			return {
				noise: compare(baselineA, baseline),
				wreck: compare(baseline, withWreck),
				retained: wrecks.stats.retained,
				visible: wrecks.stats.visible,
				nonBlack: withWreck.reduce((n, value, i) => i % 4 !== 3 && value > 0 ? n + 1 : n, 0),
			}
		})
		if (pageErrors.length > 0) problems.push(...pageErrors)
		if (visual.retained !== 1 || visual.visible !== 1)
			problems.push(`production wreck stats retained/visible ${visual.retained}/${visual.visible}, expected 1/1`)
		if (visual.wreck.changed < visual.noise.changed + 20)
			problems.push(`production wreck changed ${visual.wreck.changed} pixels against ${visual.noise.changed} noise`)
		if (visual.nonBlack === 0) problems.push('production wreck frame is black')
	} catch (error) {
		problems.push(`production visual witness failed: ${error.message}`)
	} finally {
		if (browser != null) await browser.close().catch(() => {})
		if (server != null) await stopChild(server).catch(() => {})
	}
}

console.log(`${TOOL}: retained ${node.stats.retained}, accepted ${node.stats.acceptedEvents}, missed ${node.stats.missedVisuals}, malformed ${node.stats.malformedEvents}${falsify ? ' (--falsify=zero)' : ''}`)
if (visual !== null)
	console.log(`${TOOL}: production pixels noise ${visual.noise.changed}, wreck ${visual.wreck.changed}, max channel ${visual.wreck.max}, retained/visible ${visual.retained}/${visual.visible}`)
if (problems.length > 0) {
	for (const problem of problems) console.error(`  ${problem}`)
	console.error(`${TOOL}: FAIL — persistent wrecks do not preserve the production actor visual or shroud contract`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — the exact production mesh and placed transform persist fully damaged under shroud`)
