#!/usr/bin/env node
// STEELSEED — tools/bridgegate
//
// Live C# <-> JS bridge witness. This deliberately serves the AppBundle, never the
// dev snapshot: the defects it guards are interop defects and do not exist in a JS
// fixture.
//
// Usage:
//   node tools/bridgegate.mjs [--only=readiness|session|null|order|runtime]
//                             [--falsify=readiness|session|null|order|runtime]

// The four falsifiers are independent. A passing gate that has not been made red by
// each one has not proved that it observes the corresponding failure.

import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
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
const only = args.get('only') ?? null
const falsify = args.get('falsify') ?? null
const port = Number(args.get('port') ?? 8391)
const timeoutMs = Number(args.get('timeout-ms') ?? 120000)
const known = new Set(['readiness', 'session', 'null', 'order', 'runtime'])

if ((only !== null && !known.has(only)) || (falsify !== null && !known.has(falsify))) {
	console.error(`bridgegate: unknown witness: ${only ?? falsify}`)
	process.exit(2)
}
if (!Number.isSafeInteger(port) || port <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
	console.error('bridgegate: --port and --timeout-ms must be positive integers')
	process.exit(2)
}

let chromium
try {
	;({ chromium } = await import('playwright'))
} catch {
	console.error('bridgegate: playwright is unavailable; run `cd web && npm install`')
	process.exit(2)
}

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

	// A second module after the host is the exact race. Module evaluation continues when
	// the host reaches its first top-level await; the readiness handle must already exist.
	await page.route('**/index.html*', async route => {
		const response = await route.fetch()
		let body = await response.text()
		const host = '<script type="module" src="./main.js"></script>'
		if (!body.includes(host))
			throw new Error('AppBundle index has no host module marker')
		body = body.replace(host, `${host}\n\t<script type="module" src="./bridge-consumer-probe.js"></script>`)
		await route.fulfill({ response, body, headers: { ...response.headers(), 'content-type': 'text/html; charset=utf-8' } })
	})
	await page.route('**/bridge-consumer-probe.js', route => route.fulfill({
		contentType: 'text/javascript; charset=utf-8',
		body: `
			if (${JSON.stringify(falsify)} === 'readiness') delete globalThis.steelseedBridgeReady;
			const ready = globalThis.steelseedBridgeReady;
			globalThis.__bridgeReadinessProbe = {
				presentBeforeHostAwait: ready instanceof Promise,
				settled: false,
				resolved: false,
			};
			if (ready instanceof Promise) {
				try {
					globalThis.__bridgeConsumer = await ready;
					globalThis.__bridgeReadinessProbe.resolved = true;
				} catch (error) {
					globalThis.__bridgeReadinessProbe.error = String(error);
				} finally {
					globalThis.__bridgeReadinessProbe.settled = true;
				}
			}
		`,
	}))

	const url = new URL(baseUrl)
	url.searchParams.set('mode', 'game')
	url.searchParams.set('platform', 'null')
	url.searchParams.set('Debug.ServerRandomSeed', '104729')
	await page.goto(url.href, { waitUntil: 'load', timeout: 60000 })
	await page.waitForFunction(
		() => globalThis.steelseedBridgeReady instanceof Promise && globalThis.ora !== undefined,
		undefined,
		{ timeout: timeoutMs },
	)

	const readiness = await page.evaluate(() => globalThis.__bridgeReadinessProbe)
	if ((only === null || only === 'readiness') && !readiness?.presentBeforeHostAwait)
		throw new Error('readiness witness red: consumer module did not see a Promise before the host first await')
	if ((only === null || only === 'readiness') && (!readiness.settled || !readiness.resolved))
		throw new Error(`readiness witness red: handle did not resolve (${readiness?.error ?? 'unsettled'})`)
	if (only === 'readiness') {
		console.log('bridgegate: readiness PASS — Promise observed synchronously and resolved to BridgeApi')
		process.exitCode = 0
	} else {
		const result = await page.evaluate(async ({ selected, falsifier, deadlineMs }) => {
			const bridge = globalThis.__bridgeConsumer ?? await globalThis.steelseedBridgeReady
			const wants = name => selected === null || selected === name
			const nextFrame = () => new Promise(resolveFrame => requestAnimationFrame(resolveFrame))
			const hasSessionSurface = falsifier !== 'session' &&
				typeof bridge.getSkirmishCatalog === 'function' &&
				typeof bridge.startSkirmish === 'function' &&
				typeof bridge.getSessionStatus === 'function'
			const catalog = hasSessionSurface ? await bridge.getSkirmishCatalog() : null
			const map = catalog?.maps.find(candidate =>
				candidate.slots.length >= 2 && candidate.bots.length > 0 &&
				candidate.slots.slice(1).some(slot => slot.allowBots))
			if (hasSessionSurface && map == null)
				throw new Error('catalog has no two-player bot-capable map')
			const faction = map?.factions[0]?.id ?? 'Random'
			const botType = map?.bots.find(bot => bot.id === 'normal')?.id ?? map?.bots[0]?.id
			const botSlot = map?.slots.slice(1).find(slot => slot.allowBots)
			const slots = map?.slots.map((slot, index) => {
				const kind = index === 0 ? 'human' : slot === botSlot || slot.required ? 'bot' : 'closed'
				return {
					slot: slot.id,
					kind,
					botType: kind === 'bot' ? botType : null,
					faction,
					color: map.colors[index % map.colors.length] ?? slot.defaults.color,
					team: 0,
					spawn: index + 1,
				}
			}) ?? []
			const config = map == null ? null : {
				schemaVersion: catalog.schemaVersion,
				transport: 'local',
				randomSeed: 104729,
				mapUid: map.uid,
				gameSpeed: catalog.defaultGameSpeed,
				local: {
					slot: map.slots[0].id,
					name: 'Bridge Gate',
					faction,
					color: map.colors[0] ?? map.slots[0].defaults.color,
					team: 0,
					spawn: 1,
				},
				slots,
				options: Object.fromEntries(map.options.map(option => [option.id, option.defaultValue])),
			}
			const started = falsifier === 'session'
				? { status: 'error', code: 'falsified' }
				: await bridge.startSkirmish(config)
			if (wants('session') && !hasSessionSurface)
				throw new Error('session witness red: host lifecycle adapter is incomplete')
			if (started.status !== 'loading' && started.status !== 'running')
				throw new Error(`skirmish start failed: ${JSON.stringify(started)}`)

			const poll = () => {
				const value = bridge?.pollSnapshot != null ? bridge.pollSnapshot() : P.PollSnapshot()
				if (value === null) return null
				if (value instanceof Uint8Array) return value
				// Pre-amendment compatibility exists only so this same witness can be seen red.
				return value.slice(0, value.byteLength)
			}
			const waitSnapshot = async () => {
				const deadline = performance.now() + deadlineMs
				while (performance.now() <= deadline) {
					const bytes = poll()
					if (bytes !== null && bytes.byteLength >= 32) return bytes
					await nextFrame()
				}
				throw new Error('timed out waiting for snapshot')
			}
			const decodeActors = bytes => {
				const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
				const payloadLength = view.getUint32(8, true)
				if (payloadLength < 32 || payloadLength > bytes.byteLength)
					throw new Error(`bad payload length ${payloadLength}/${bytes.byteLength}`)
				const sectionCount = view.getUint16(6, true)
				let actorOffset = -1
				let worldOffset = -1
				for (let i = 0; i < sectionCount; i++) {
					const entry = 32 + i * 12
					const id = view.getUint16(entry, true)
					if (id === 0) worldOffset = view.getUint32(entry + 4, true)
					if (id === 3) actorOffset = view.getUint32(entry + 4, true)
				}
				if (actorOffset < 0 || worldOffset < 0) throw new Error('snapshot lacks world/actors')
				const bounds = [
					view.getInt32(worldOffset, true), view.getInt32(worldOffset + 4, true),
					view.getInt32(worldOffset + 8, true), view.getInt32(worldOffset + 12, true),
				]
				const renderPlayer = view.getUint16(worldOffset + 20, true)
				const count = view.getUint32(actorOffset, true)
				let p = actorOffset + 8
				const ids = new Array(count)
				const x = new Array(count)
				const y = new Array(count)
				const type = new Array(count)
				for (let i = 0; i < count; i++, p += 4) ids[i] = view.getUint32(p, true)
				for (let i = 0; i < count; i++, p += 4) x[i] = view.getInt32(p, true)
				for (let i = 0; i < count; i++, p += 4) y[i] = view.getInt32(p, true)
				p += count * 4 // z
				for (let i = 0; i < count; i++, p += 2) type[i] = view.getUint16(p, true)
				p += count * 2 * 4 // facing, animState, prodProgress, turretOffset
				p += count * 2 // speed
				p = (p + 3) & ~3
				const owner = new Array(count)
				for (let i = 0; i < count; i++) owner[i] = view.getUint8(p + i)
				return { tick: view.getUint32(12, true), renderPlayer, bounds, ids, x, y, type, owner }
			}

			const first = await waitSnapshot()
			const noNew = poll()
			const observedNull = falsifier === 'null' ? new Uint8Array(0) : noNew
			if (wants('null') && observedNull !== null)
				throw new Error(`null witness red: second same-tick poll was truthy length=${observedNull.byteLength}`)
			if (selected === 'session') return { session: true, mapLines: catalog.maps.length, started }
			if (selected === 'null') return { nullExact: true }

			const before = decodeActors(first)
			const names = String(await bridge.snapshotTypeTable()).split('\n')
			const human = []
			for (let i = 0; i < before.ids.length; i++) {
				const name = names[before.type[i]] ?? ''
				if (before.owner[i] === before.renderPlayer)
					human.push({ i, name, id: before.ids[i], x: before.x[i], y: before.y[i] })
			}
			const movableNames = new Set(['mcv', '1tnk', '2tnk', '3tnk', '4tnk', 'jeep', 'e1'])
			const commanded = human.find(actor => movableNames.has(actor.name))
			if (commanded == null)
				throw new Error(`need a movable local RA actor; got ${human.map(a => a.name).join(',')}`)
			const actorCellX = Math.floor(commanded.x / 1024)
			const actorCellY = Math.floor(commanded.y / 1024)
			const targetX = actorCellX < (before.bounds[0] + before.bounds[2]) / 2 ? before.bounds[2] - 3 : before.bounds[0] + 3
			const targetY = actorCellY < (before.bounds[1] + before.bounds[3]) / 2 ? before.bounds[3] - 3 : before.bounds[1] + 3
			const intent = {
				orderString: 'Move',
				subjectIds: new Uint32Array([commanded.id]),
				targetActorId: 0,
				targetCellX: targetX,
				targetCellY: targetY,
				queued: false,
				targetString: '',
				extraData: 0,
			}
			const tickBefore = before.tick
			let issueResult = 'falsified: dispatch suppressed'
			if (falsifier !== 'order') {
				issueResult = String(await bridge.issueOrder(intent))
			}
			if (falsifier === 'runtime') {
				throw new Error('falsified runtime error after order')
			}
			if (wants('order') && !/^ok: issued 1\/1\b/.test(issueResult))
				throw new Error(`order witness red: ${issueResult}`)

			let latest = before
			const deadline = performance.now() + deadlineMs
			while (performance.now() <= deadline && latest.tick < tickBefore + 75) {
				const bytes = poll()
				if (bytes !== null) latest = decodeActors(bytes)
				await nextFrame()
			}
			const tickAfter = latest.tick
			if (wants('runtime') && tickAfter <= tickBefore)
				throw new Error(`runtime witness red: tick did not advance (${tickBefore}->${tickAfter})`)
			const position = id => {
				const i = latest.ids.indexOf(id)
				return i < 0 ? null : [latest.x[i], latest.y[i]]
			}
			const commandedAfter = position(commanded.id)
			if (commandedAfter == null)
				throw new Error('commanded actor disappeared during witness')
			const moved = Math.hypot(commandedAfter[0] - commanded.x, commandedAfter[1] - commanded.y)
			if (wants('order') && moved < 256)
				throw new Error(`order witness red: commanded actor moved only ${moved.toFixed(1)}`)
			return { session: true, mapLines: catalog.maps.length, started, nullExact: true, issueResult, tickBefore, tickAfter, moved }
		}, { selected: only, falsifier: falsify, deadlineMs: timeoutMs })

	if (pageErrors.length > 0)
		throw new Error(`runtime witness red: ${pageErrors[0]}`)
	console.log(
		`bridgegate: PASS — readiness=yes session=${result.session ? `${result.mapLines} map(s)` : 'skipped'} ` +
		`exactNull=${result.nullExact ?? 'skipped'} ` +
		`issue=${result.issueResult ?? 'skipped'} tick=${result.tickBefore ?? '-'}->${result.tickAfter ?? '-'} ` +
		`commanded=${result.moved?.toFixed(1) ?? '-'}`,
	)
	}
} catch (error) {
	console.error(`bridgegate: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null) await browser.close()
	await stopProcessGroup(server)
}

process.exit(exitCode || process.exitCode || 0)

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
