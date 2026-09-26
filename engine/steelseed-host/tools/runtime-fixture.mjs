import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const hostRoot = resolve(import.meta.dirname, '..')

function memoryIndexedDb() {
	const db = {
		objectStoreNames: { contains: () => true }, createObjectStore: () => {},
		addEventListener: () => {}, close: () => {},
		transaction: () => {
			const transactionListeners = new Map()
			const transaction = {
				error: null,
				addEventListener: (name, callback) => transactionListeners.set(name, callback),
				objectStore: () => ({
					getAllKeys: () => ({ result: [] }), getAll: () => ({ result: [] }),
					put: () => {}, delete: () => {},
				}),
			}
			queueMicrotask(() => transactionListeners.get('complete')?.())
			return transaction
		},
	}
	return { open: () => {
		const listeners = new Map()
		const request = { result: db, addEventListener: (name, callback) => listeners.set(name, callback) }
		queueMicrotask(() => {
			listeners.get('upgradeneeded')?.()
			listeners.get('success')?.()
		})
		return request
	} }
}

export async function bootRuntime({ bundleRoot = resolve(hostRoot, '../bin-browser/AppBundle') } = {}) {
	// Keep the headless fixture aligned with the browser globals read by the host
	// adapters.  These are deliberately minimal: gates exercise the real WASM host,
	// while rendering and focus policy remain browser concerns.
	const elements = new Map()
	const element = id => {
		if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '' })
		return elements.get(id)
	}
	const classList = { add: () => {}, remove: () => {} }
	globalThis.location = { search: '?mode=game&platform=null', origin: 'http://127.0.0.1' }
	globalThis.indexedDB ??= memoryIndexedDb()
	globalThis.window ??= globalThis
	globalThis.window.addEventListener ??= () => {}
	globalThis.document = {
		body: { classList }, visibilityState: 'visible',
		getElementById: element, hasFocus: () => true, addEventListener: () => {},
	}
	globalThis.requestAnimationFrame = callback => { globalThis.__steelseedPump = callback }
	const main = resolve(bundleRoot, 'main.js')
	await import(`${pathToFileURL(main).href}?gate=${Date.now()}`)
	if (!globalThis.steelseedBridge) throw new Error('runtime-fixture: bridge did not publish')
	return {
		bridge: globalThis.steelseedBridge,
		program: globalThis.ora,
		pump: () => globalThis.__steelseedPump?.(performance.now()),
	}
}

export function configFor(catalog, map, { randomSeed = 104729, humanSlot = 0, variant = null, withBot = true } = {}) {
	if (map.slots.length === 0) throw new Error(`${map.title}: no playable slots`)
	const humanIndex = humanSlot % map.slots.length
	let botAssigned = false
	let nextSpawn = 1
	const slots = map.slots.map((descriptor, index) => {
		let kind = index === humanIndex ? 'human' : 'open'
		if (withBot && index !== humanIndex && descriptor.allowBots && (!botAssigned || descriptor.required)) {
			kind = 'bot'
			botAssigned = true
		} else if (index !== humanIndex && descriptor.required) {
			throw new Error(`${map.title}:${descriptor.id} is required but cannot host a bot`)
		}
		const spawn = descriptor.locks.spawn ? descriptor.defaults.spawn
			: nextSpawn <= map.spawnPoints.length ? nextSpawn++ : 0
		return {
			slot: descriptor.id,
			kind,
			botType: kind === 'bot' ? (map.bots.find(bot => bot.id === 'normal')?.id ?? map.bots[0]?.id ?? '') : '',
			faction: descriptor.locks.faction ? descriptor.defaults.faction : 'Random',
			color: descriptor.locks.color ? descriptor.defaults.color : map.colors[index % map.colors.length],
			team: descriptor.locks.team ? descriptor.defaults.team : 0,
			spawn,
		}
	})
	const human = slots[humanIndex]
	const options = {}
	for (const descriptor of map.options) {
		if (descriptor.id === 'gamespeed') continue
		const values = descriptor.values ?? []
		options[descriptor.id] = descriptor.isLocked || values.length === 0 || variant === null
			? descriptor.defaultValue
			: values[variant % values.length].id
	}
	return {
		schemaVersion: catalog.schemaVersion,
		transport: 'local',
		mapUid: map.uid,
		gameSpeed: catalog.defaultGameSpeed,
		randomSeed,
		local: {
			slot: human.slot,
			name: 'Gate Commander',
			faction: human.faction,
			color: human.color,
			team: human.team,
			spawn: human.spawn,
		},
		slots,
		options,
	}
}

export function snapshotHeader(bytes) {
	if (bytes == null) return null
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const length = view.getUint32(8, true)
	if (length < 32 || length > bytes.byteLength) throw new Error(`bad snapshot length ${length}/${bytes.byteLength}`)
	const sections = new Map()
	const sectionCount = view.getUint16(6, true)
	for (let index = 0; index < sectionCount; index++) {
		const entry = 32 + index * 12
		const id = view.getUint16(entry, true)
		const offset = view.getUint32(entry + 4, true)
		const byteLength = view.getUint32(entry + 8, true)
		if (offset < 32 + sectionCount * 12 || offset + byteLength > length)
			throw new Error(`section ${id} lies outside snapshot (${offset}+${byteLength}>${length})`)
		sections.set(id, { offset, byteLength })
	}
	return {
		view,
		length,
		magic: view.getUint32(0, true),
		version: view.getUint16(4, true),
		tick: view.getUint32(12, true),
		syncHash: view.getUint32(16, true),
		flags: view.getUint32(24, true),
		sections,
	}
}

export async function waitForSnapshot(runtime, { minimumTick = 1, timeoutMs = 15000, onSnapshot = null } = {}) {
	const deadline = performance.now() + timeoutMs
	let latest = null
	while (performance.now() < deadline) {
		runtime.pump()
		const bytes = runtime.bridge.pollSnapshot()
		if (bytes) {
			latest = snapshotHeader(bytes)
			onSnapshot?.(latest, bytes)
			if (latest.tick >= minimumTick) return { header: latest, bytes }
		}
		if (runtime.program.HostStatus() !== 'running')
			throw new Error(`host stopped: ${runtime.program.HostStatus()}`)
		await new Promise(resolveDelay => setTimeout(resolveDelay, 2))
	}
	throw new Error(`timed out waiting for world tick ${minimumTick}; latest ${latest?.tick ?? 'none'}; status ${JSON.stringify(runtime.bridge.getSessionStatus())}`)
}

export function actorIdsOwnedBy(header, playerIndex) {
	const section = header.sections.get(3)
	if (!section) return []
	const { view } = header
	const count = view.getUint32(section.offset, true)
	let ownerOffset = section.offset + 8 + count * 28
	ownerOffset = (ownerOffset + 3) & ~3
	const ids = []
	for (let index = 0; index < count; index++)
		if (view.getUint8(ownerOffset + index) === playerIndex)
			ids.push(view.getUint32(section.offset + 8 + index * 4, true))
	return ids
}

export function renderPlayerIndex(header) {
	const world = header.sections.get(0)
	if (!world) return -1
	return header.view.getUint16(world.offset + 20, true)
}

export function shroudStats(header) {
	const section = header.sections.get(6)
	if (!section) return null
	const states = [0, 0, 0]
	const count = header.view.getUint32(section.offset, true)
	for (let index = 0; index < count; index++) {
		const offset = section.offset + 4 + index * 8
		const length = header.view.getUint16(offset + 4, true)
		const state = header.view.getUint8(offset + 6)
		if (state <= 2) states[state] += length
	}
	return { runs: count, unexplored: states[0], explored: states[1], visible: states[2] }
}

export function playerColors(header) {
	const section = header.sections.get(8)
	if (!section) return []
	const count = header.view.getUint32(section.offset, true)
	const colors = []
	for (let index = 0; index < count; index++) {
		const offset = section.offset + 4 + index * 36
		colors.push([
			header.view.getUint8(offset + 22), header.view.getUint8(offset + 23),
			header.view.getUint8(offset + 24), header.view.getUint8(offset + 25),
		])
	}
	return colors
}
