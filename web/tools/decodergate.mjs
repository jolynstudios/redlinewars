#!/usr/bin/env node
// STEELSEED — tools/decodergate
//
// Live-host witness for SnapshotDecoder's steady-state object reuse and repin safety.
// It measures identities, never JS heap size: heap sampling cannot see Mono-managed
// allocations and is noisy enough to turn a zero-allocation claim into guesswork.
//
// Negative controls:
//   --falsify=churn        construct a decoder per tick; stable identities must fail
//   --falsify=stale-cache  reuse the pre-growth decode after a WASM heap epoch change;
//                          fresh-value parity must fail

import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { build as esbuild } from 'esbuild'
import { chromium } from 'playwright'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME_ROOT = resolve(WEB_ROOT, '..')
const ENGINE_ROOT = join(GAME_ROOT, 'engine')
const APP_BUNDLE = join(ENGINE_ROOT, 'bin-browser', 'AppBundle')
const SERVER_SCRIPT = join(ENGINE_ROOT, 'OpenRA.Browser', 'tests', 'server.mjs')

const args = new Map(process.argv.slice(2).map(arg => {
	const [name, ...value] = arg.replace(/^--/, '').split('=')
	return [name, value.length > 0 ? value.join('=') : '1']
}))
const falsify = args.get('falsify') ?? null
const port = Number(args.get('port') ?? 8392)
const timeoutMs = Number(args.get('timeout-ms') ?? 120000)
if (falsify !== null && !['churn', 'stale-cache'].includes(falsify)) {
	console.error(`decodergate: unknown falsifier '${falsify}'`)
	process.exit(2)
}
if (!Number.isSafeInteger(port) || port <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
	console.error('decodergate: --port and --timeout-ms must be positive integers')
	process.exit(2)
}

const bundle = await esbuild({
	entryPoints: [join(WEB_ROOT, 'src', 'core', 'snapshot.ts')],
	bundle: true,
	write: false,
	format: 'iife',
	globalName: 'SteelseedSnapshotGate',
	platform: 'browser',
	target: 'es2022',
	logLevel: 'silent',
})
const decoderSource = bundle.outputFiles[0].text

const baseUrl = `http://127.0.0.1:${port}/index.html`
const server = spawnProcessGroup(process.execPath, [
	SERVER_SCRIPT,
	'--root', APP_BUNDLE,
	'--port', String(port),
], {
	cwd: ENGINE_ROOT,
	stdio: ['ignore', 'pipe', 'pipe'],
})

let browser = null
let exitCode = 0
try {
	await waitForServer(baseUrl, 30000)
	browser = await chromium.launch({ headless: true })
	const page = await browser.newPage()
	const pageErrors = []
	page.on('pageerror', error => pageErrors.push(`pageerror: ${error.message}`))
	page.on('console', message => {
		if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text()))
			pageErrors.push(`console.error: ${message.text()}`)
	})

	const url = new URL(baseUrl)
	url.searchParams.set('mode', 'game')
	url.searchParams.set('platform', 'null')
	// The alias/heap-growth witnesses below read the pinned snapshot slots and the
	// live WASM heap on the page; only the inline boot (?worker=0) hosts those here.
	// The default worker host transfers fresh copies per snapshot, so slot identity
	// is unobservable from the page by design.
	url.searchParams.set('worker', '0')
	await page.goto(url.href, { waitUntil: 'load', timeout: 60000 })
	await page.waitForFunction(
		() => globalThis.steelseedBridgeReady !== undefined && globalThis.ora !== undefined,
		undefined,
		{ timeout: timeoutMs },
	)
	await page.addScriptTag({ content: decoderSource })

	const result = await page.evaluate(async ({ deadlineMs, falsifier }) => {
		const P = globalThis.ora
		const bridge = await globalThis.steelseedBridgeReady
		const Decoder = globalThis.SteelseedSnapshotGate.SnapshotDecoder
		if (typeof Decoder !== 'function') throw new Error('SnapshotDecoder bundle is unavailable')

		const catalog = await bridge.getSkirmishCatalog()
		const map = catalog.maps
			.filter(candidate => candidate.slots.length >= 2 && candidate.bots.length > 0 && candidate.slots.slice(1).some(slot => slot.allowBots))
			.sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height)[0]
		if (!map) throw new Error('catalog has no local bot-capable skirmish map')
		const faction = map.factions[0].id
		const botType = map.bots.find(bot => bot.id === 'normal')?.id ?? map.bots[0].id
		const botSlot = map.slots.slice(1).find(slot => slot.allowBots)
		const field = (slot, name, fallback) => slot.locks[name] ? slot.defaults[name] : fallback
		const started = await bridge.startSkirmish({
			schemaVersion: catalog.schemaVersion,
			transport: 'local',
			randomSeed: 104729,
			mapUid: map.uid,
			gameSpeed: catalog.defaultGameSpeed,
			local: {
				slot: map.slots[0].id,
				name: 'decoder-gate',
				faction: field(map.slots[0], 'faction', faction),
				color: field(map.slots[0], 'color', map.colors[0]),
				team: field(map.slots[0], 'team', 0),
				spawn: field(map.slots[0], 'spawn', 1),
			},
			slots: map.slots.map((slot, index) => ({
				slot: slot.id,
				kind: index === 0 ? 'human' : slot === botSlot || slot.required ? 'bot' : 'closed',
				botType,
				faction: field(slot, 'faction', faction),
				color: field(slot, 'color', map.colors[index % map.colors.length]),
				team: field(slot, 'team', 0),
				spawn: field(slot, 'spawn', index + 1),
			})),
			options: Object.fromEntries(map.options.map(option => [option.id, option.defaultValue])),
		})
		if (started.status !== 'loading' && started.status !== 'running')
			throw new Error(`skirmish start failed: ${started.code}: ${started.userMessage}`)

		const nextFrame = () => new Promise(resolveFrame => requestAnimationFrame(resolveFrame))
		const nextSnapshot = async () => {
			const deadline = performance.now() + deadlineMs
			while (performance.now() <= deadline) {
				const bytes = bridge.pollSnapshot()
				if (bytes !== null) return bytes
				await nextFrame()
			}
			throw new Error(`timed out after ${deadlineMs}ms waiting for a snapshot`)
		}
		const assert = (condition, detail) => {
			if (!condition) throw new Error(detail)
		}
		const actorFields = [
			'id', 'posX', 'posY', 'posZ', 'typeId', 'facing', 'animState',
			'prodProgress', 'turretOffset', 'speed', 'owner', 'health', 'cargo',
			'turretCount', 'flags', 'surface', 'ammo', 'cargoReserved', 'turretFacing',
		]
		const terrainFields = ['type', 'height', 'ramp', 'passability', 'resource', 'surface']
		const projectileFields = [
			'id', 'posX', 'posY', 'posZ', 'velX', 'velY', 'velZ', 'typeId', 'remainingTicks',
		]

		const equalArray = (a, b, path) => {
			assert(a != null && b != null, `${path}: one array is null`)
			assert(a.constructor === b.constructor, `${path}: ${a.constructor.name} != ${b.constructor.name}`)
			assert(a.length === b.length, `${path}: length ${a.length} != ${b.length}`)
			for (let i = 0; i < a.length; i++)
				assert(a[i] === b[i], `${path}[${i}]: ${a[i]} != ${b[i]}`)
		}
		const equalRecordArray = (a, b, fields, path) => {
			assert(a.length === b.length, `${path}: length ${a.length} != ${b.length}`)
			for (let i = 0; i < a.length; i++)
				for (const field of fields)
					assert(a[i][field] === b[i][field], `${path}[${i}].${field} drifted`)
		}
		const equalSnapshot = (cached, fresh, path) => {
			for (const field of ['tick', 'syncHash', 'gameTimeMs', 'flags', 'byteLength'])
				assert(cached[field] === fresh[field], `${path}.${field}: ${cached[field]} != ${fresh[field]}`)
			assert(cached.sections.size === fresh.sections.size, `${path}.sections size drifted`)
			for (const [id, section] of fresh.sections) {
				const actual = cached.sections.get(id)
				assert(actual !== undefined, `${path}.sections missing ${id}`)
				assert(actual[0] === section[0] && actual[1] === section[1], `${path}.sections[${id}] drifted`)
			}
			if (fresh.world !== null) {
				assert(cached.world !== null, `${path}.world is null`)
				for (const field of Object.keys(fresh.world))
					assert(cached.world[field] === fresh.world[field], `${path}.world.${field} drifted`)
			}
			if (fresh.terrainStatic !== null) {
				assert(cached.terrainStatic !== null, `${path}.terrainStatic is null`)
				assert(cached.terrainStatic.w === fresh.terrainStatic.w, `${path}.terrainStatic.w drifted`)
				assert(cached.terrainStatic.h === fresh.terrainStatic.h, `${path}.terrainStatic.h drifted`)
				for (const field of terrainFields)
					equalArray(cached.terrainStatic[field], fresh.terrainStatic[field], `${path}.terrainStatic.${field}`)
			}
			if (fresh.actors !== null) {
				assert(cached.actors !== null, `${path}.actors is null`)
				assert(cached.actors.count === fresh.actors.count, `${path}.actors.count drifted`)
				assert(cached.actors.turretTotal === fresh.actors.turretTotal, `${path}.actors.turretTotal drifted`)
				for (const field of actorFields)
					equalArray(cached.actors[field], fresh.actors[field], `${path}.actors.${field}`)
			}
			if (fresh.projectiles !== null) {
				assert(cached.projectiles !== null, `${path}.projectiles is null`)
				assert(cached.projectiles.count === fresh.projectiles.count, `${path}.projectiles.count drifted`)
				for (const field of projectileFields)
					equalArray(cached.projectiles[field], fresh.projectiles[field], `${path}.projectiles.${field}`)
			}
			equalRecordArray(cached.lifecycle, fresh.lifecycle, ['actorId', 'typeId', 'kind', 'owner'], `${path}.lifecycle`)
			equalRecordArray(cached.shroud, fresh.shroud, ['cellIndex', 'runLength', 'state'], `${path}.shroud`)
			equalRecordArray(cached.events, fresh.events, ['kind', 'offset', 'byteLength'], `${path}.events`)
		}

		const refsOf = snapshot => {
			const refs = new Map([
				['snapshot', snapshot], ['view', snapshot.view], ['sections', snapshot.sections],
				['world', snapshot.world], ['terrainStatic', snapshot.terrainStatic],
				['actors', snapshot.actors], ['projectiles', snapshot.projectiles],
				['lifecycle', snapshot.lifecycle], ['shroud', snapshot.shroud], ['events', snapshot.events],
			].filter(([, ref]) => ref !== null))
			for (const [id, tuple] of snapshot.sections) refs.set(`section:${id}`, tuple)
			if (snapshot.terrainStatic !== null)
				for (const field of terrainFields) refs.set(`terrain:${field}`, snapshot.terrainStatic[field])
			if (snapshot.actors !== null)
				for (const field of actorFields) refs.set(`actor:${field}`, snapshot.actors[field])
			if (snapshot.projectiles !== null)
				for (const field of projectileFields) refs.set(`projectile:${field}`, snapshot.projectiles[field])
			for (let i = 0; i < snapshot.lifecycle.length; i++) refs.set(`lifecycle:${i}`, snapshot.lifecycle[i])
			for (let i = 0; i < snapshot.shroud.length; i++) refs.set(`shroud:${i}`, snapshot.shroud[i])
			for (let i = 0; i < snapshot.events.length; i++) refs.set(`event:${i}`, snapshot.events[i])
			return refs
		}
		const layoutOf = snapshot => JSON.stringify({
			sections: [...snapshot.sections],
			terrain: snapshot.terrainStatic === null ? null : [snapshot.terrainStatic.w, snapshot.terrainStatic.h],
			actors: snapshot.actors === null ? null : [snapshot.actors.count, snapshot.actors.turretTotal],
			projectiles: snapshot.projectiles?.count ?? null,
			lifecycle: snapshot.lifecycle.length,
			shroud: snapshot.shroud.length,
			events: snapshot.events.length,
		})
		const changedRefs = (before, after) => {
			const changed = []
			for (const [name, ref] of before)
				if (after.get(name) !== ref) changed.push(name)
			for (const name of after.keys())
				if (!before.has(name)) changed.push(`added:${name}`)
			return changed
		}

		const decoder = new Decoder()
		const byAlias = new Map()
		let lastDecoded = null
		let stableComparisons = 0
		for (let sample = 0; sample < 40 && stableComparisons < 6; sample++) {
			const bytes = await nextSnapshot()
			const activeDecoder = falsifier === 'churn' ? new Decoder() : decoder
			const decoded = activeDecoder.decode(bytes)
			const fresh = new Decoder().decode(bytes)
			equalSnapshot(decoded, fresh, `steady[${sample}]`)
			const current = { layout: layoutOf(decoded), refs: refsOf(decoded), decoded }
			const previous = byAlias.get(bytes)
			if (previous !== undefined && previous.layout === current.layout) {
				const changed = changedRefs(previous.refs, current.refs)
				assert(changed.length === 0, `steady-state allocation witness red: ${changed.join(', ')}`)
				stableComparisons++
			}
			byAlias.set(bytes, current)
			lastDecoded = decoded
		}
		assert(byAlias.size === 2, `expected two persistent slot aliases, observed ${byAlias.size}`)
		assert(stableComparisons >= 6, `only ${stableComparisons} stable same-slot comparisons`)

		const aliasesBefore = [...byAlias.keys()]
		const refsBefore = aliasesBefore.map(alias => byAlias.get(alias).refs)
		const runtime = globalThis.getDotnetRuntime?.(0)
		assert(runtime?.Module != null, 'getDotnetRuntime(0).Module is unavailable')
		assert(typeof runtime.Module._malloc === 'function', 'runtime _malloc seam is unavailable')
		assert(typeof runtime.Module._free === 'function', 'runtime _free seam is unavailable')
		const heapBefore = runtime.localHeapViewU8()
		const heapBytesBefore = heapBefore.byteLength
		const generationBefore = P.SnapshotBufferGeneration()
		const allocation = runtime.Module._malloc(heapBytesBefore)
		assert(allocation !== 0, `could not allocate ${heapBytesBefore} bytes to force heap growth`)
		let heapAfter
		let generationAfter
		try {
			heapAfter = runtime.localHeapViewU8()
			generationAfter = P.SnapshotBufferGeneration()
		} finally {
			// Frees the forcing allocation. WebAssembly.Memory deliberately keeps its new
			// high-water size, but the disposable witness page retains no 100+ MB live block.
			runtime.Module._free(allocation)
		}
		assert(heapBefore.byteLength === 0, 'heap-growth witness did not detach the old WASM buffer')
		assert(heapAfter.buffer !== heapBefore.buffer, 'heap-growth witness retained the old ArrayBuffer')
		assert(heapAfter.byteLength > heapBytesBefore,
			`heap did not grow (${heapBytesBefore} -> ${heapAfter.byteLength})`)
		assert(generationAfter === generationBefore,
			`managed generation unexpectedly moved during heap-only repin (${generationBefore} -> ${generationAfter})`)
		assert(aliasesBefore.every(alias => alias.byteLength === 0), 'a pre-growth slot alias stayed attached')
		let detachedRejected = false
		try {
			decoder.decode(aliasesBefore[0])
		} catch (error) {
			detachedRejected = /detached/i.test(String(error))
		}
		assert(detachedRejected, 'decoder did not explicitly reject a detached pre-growth alias')

		const bytesAfter = await nextSnapshot()
		assert(!aliasesBefore.includes(bytesAfter), 'adapter reused a pre-growth slot alias')
		assert(bytesAfter.buffer === heapAfter.buffer, 'post-growth slot does not alias the current WASM heap')
		const decodedAfter = falsifier === 'stale-cache' ? lastDecoded : decoder.decode(bytesAfter)
		const freshAfter = new Decoder().decode(bytesAfter)
		const refsAfter = refsOf(decodedAfter)
		for (const oldRefs of refsBefore) {
			const shared = [...refsAfter].filter(([name, ref]) => oldRefs.get(name) === ref).map(([name]) => name)
			assert(shared.length === 0, `repin retained stale decoder objects: ${shared.join(', ')}`)
		}
		equalSnapshot(decodedAfter, freshAfter, 'post-growth')

		let postGrowthReuse = false
		let postLayout = layoutOf(decodedAfter)
		let postRefs = refsAfter
		for (let sample = 0; sample < 20 && !postGrowthReuse; sample++) {
			const bytes = await nextSnapshot()
			const decoded = decoder.decode(bytes)
			const fresh = new Decoder().decode(bytes)
			equalSnapshot(decoded, fresh, `post-growth-reuse[${sample}]`)
			if (bytes !== bytesAfter) continue
			const layout = layoutOf(decoded)
			const refs = refsOf(decoded)
			if (layout === postLayout) {
				const changed = changedRefs(postRefs, refs)
				assert(changed.length === 0, `post-growth reuse churned: ${changed.join(', ')}`)
				postGrowthReuse = true
			} else {
				postLayout = layout
				postRefs = refs
			}
		}
		assert(postGrowthReuse, 'did not observe stable reuse of the rebuilt post-growth cache')

		return {
			stableComparisons,
			actorFieldViews: actorFields.length,
			sectionTuples: freshAfter.sections.size,
			objectsPerTick: 0,
			heapBytesBefore,
			heapBytesAfter: heapAfter.byteLength,
			generationBefore,
			generationAfter,
			postGrowthTick: freshAfter.tick,
			actorCount: freshAfter.actors?.count ?? 0,
		}
	}, { deadlineMs: timeoutMs, falsifier: falsify })

	if (pageErrors.length > 0)
		throw new Error(pageErrors[0])
	console.log(
		`decodergate: PASS — steady=${result.stableComparisons} ` +
		`views=${result.actorFieldViews} tuples=${result.sectionTuples} ` +
		`objects/tick=${result.objectsPerTick} ` +
		`heap=${result.heapBytesBefore}->${result.heapBytesAfter} ` +
		`generation=${result.generationBefore}->${result.generationAfter} ` +
		`tick=${result.postGrowthTick} actors=${result.actorCount}`,
	)
} catch (error) {
	console.error(`decodergate: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null) await browser.close()
	await stopProcessGroup(server)
}

process.exit(exitCode)

async function waitForServer(url, deadlineMs) {
	const deadline = Date.now() + deadlineMs
	while (Date.now() <= deadline) {
		if (server.exitCode != null)
			throw new Error(`server exited ${server.exitCode} before becoming ready`)
		try {
			const response = await fetch(url)
			if (response.ok) return
		} catch {
			// Retry until the explicit deadline.
		}
		await new Promise(resolveWait => setTimeout(resolveWait, 100))
	}
	throw new Error(`server did not become ready within ${deadlineMs}ms`)
}
