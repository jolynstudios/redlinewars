// Legacy exact allocation pin. This is not an allocation budget for the current RA host.
export const ALLOCATION_PIN = Object.freeze({
	version: 1, actors: 8, warmup: 16, samples: 64, floor: 248,
	transients: Object.freeze([[18, 664], [24, 376], [25, 320], [29, 392], [35, 592],
		[50, 304], [66, 304], [75, 360], [76, 360]].map(pair => Object.freeze(pair))),
})

export function assertAllocationResult(result, { falsifyBelow = false } = {}) {
	if (!result || result.actorCount !== ALLOCATION_PIN.actors ||
		!Array.isArray(result.ticks) || !Array.isArray(result.bytesPerEmit) ||
		result.ticks.length !== ALLOCATION_PIN.samples || result.bytesPerEmit.length !== ALLOCATION_PIN.samples)
		throw new Error('allocation sequence must contain exactly 64 paired samples from 8 actors')
	const transients = new Map(ALLOCATION_PIN.transients)
	for (let i = 0; i < ALLOCATION_PIN.samples; i++) {
		const tick = ALLOCATION_PIN.warmup + i
		const expected = (transients.get(tick) ?? ALLOCATION_PIN.floor) + (falsifyBelow && i === 0 ? 1 : 0)
		if (result.ticks[i] !== tick || result.bytesPerEmit[i] !== expected)
			throw new Error(`allocation sequence moved (tick ${result.ticks[i]}: measured ${result.bytesPerEmit[i]}, expected tick ${tick}/${expected})`)
	}
}

// Self-contained so Playwright can serialize this factory into the actual host page.
// No presentation ctx/cache is used. Allocation and bytes must come from one synchronous
// native emission; the worker's queued snapshot plus a later raw RPC is not that pair.
export function createAllocationProbe(runtime = globalThis) {
	const unsupported = reason => new Error(`unsupported legacy allocation diagnostic: ${reason}; no allocation acceptance`)
	const thenable = value => value != null && typeof value.then === 'function'
	function readSnapshot(bytes) {
		if (!(bytes instanceof Uint8Array) || bytes.byteLength < 32)
			throw new Error('snapshot header is truncated')
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		if (view.getUint32(0, true) !== 0x504e5353) throw new Error('bad snapshot magic')
		const version = view.getUint16(4, true)
		if (version !== 1 && version !== 2) throw new Error(`unsupported snapshot version ${version}`)
		const length = view.getUint32(8, true)
		const sectionCount = view.getUint16(6, true)
		const tableEnd = 32 + sectionCount * 12
		if (length < 32 || length > bytes.byteLength || tableEnd > length)
			throw new Error('snapshot payload/table length is invalid')
		let actorCount = null
		const ids = new Set()
		const ranges = []
		for (let i = 0; i < sectionCount; i++) {
			const entry = 32 + i * 12
			const id = view.getUint16(entry, true)
			const offset = view.getUint32(entry + 4, true)
			const size = view.getUint32(entry + 8, true)
			if (ids.has(id) || offset < tableEnd || offset + size > length)
				throw new Error('snapshot section is duplicated or outside payload')
			ids.add(id)
			ranges.push([offset, offset + size])
			if (id === 3) {
				if (size < 8) throw new Error('actors section is truncated')
				actorCount = view.getUint32(offset, true)
			}
		}
		ranges.sort((a, b) => a[0] - b[0])
		for (let i = 1; i < ranges.length; i++)
			if (ranges[i][0] < ranges[i - 1][1]) throw new Error('snapshot sections overlap')
		if (actorCount === null) throw new Error('snapshot has no actors section')
		return { version, tick: view.getUint32(12, true), actorCount }
	}
	async function collect({ deadlineMs, expectedActorCount = 8, sampleCount = 64, warmupCount = 16, allocationProbeBytes = 0 }) {
		if (expectedActorCount !== 8 || sampleCount !== 64 || warmupCount !== 16 ||
			!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || ![0, 64].includes(allocationProbeBytes))
			throw new Error('invalid exact allocation workload options')
		const P = runtime.ora
		const bridge = await runtime.steelseedBridgeReady
		if (!P || !bridge) throw unsupported('native bridge is unavailable')
		let initial
		let asyncAllocation = false
		try {
			// Calling and checking the actual result detects missing Proxy-forwarded exports.
			const value = P.SnapshotLastEmitAllocatedBytes()
			asyncAllocation = thenable(value)
			initial = await value
		} catch (error) {
			throw unsupported(`SnapshotLastEmitAllocatedBytes unavailable (${error.message})`)
		}
		if (typeof initial !== 'number' || !Number.isSafeInteger(initial) || initial < -1)
			throw unsupported('SnapshotLastEmitAllocatedBytes returned an invalid native delta')
		if (asyncAllocation) throw unsupported('async allocation RPC cannot be paired with a queued worker snapshot')
		try {
			const value = P.SnapshotSetAllocationProbeBytes(allocationProbeBytes)
			const asyncSet = thenable(value)
			const result = await value
			if (asyncSet || result !== undefined) throw new Error('requires synchronous native void export')
		} catch (error) {
			throw unsupported(`SnapshotSetAllocationProbeBytes unavailable (${error.message})`)
		}
		let started
		try {
			started = await P.StartGeneratedSkirmish('seedline', 'Preset', 'amber-crossing', 'STEELWORKS', 1, 'normal')
		} catch (error) {
			throw unsupported(`pinned amber-crossing workload unavailable (${error.message})`)
		}
		if (typeof started !== 'string' || !started.startsWith('ok:'))
			throw new Error(`skirmish start failed: ${String(started)}`)
		const bytesPerEmit = []
		const ticks = []
		for (let i = 0; i < warmupCount + sampleCount; i++) {
			const deadline = runtime.performance.now() + deadlineMs
			let paired = null
			while (runtime.performance.now() <= deadline) {
				const bytes = bridge.pollSnapshot()
				if (thenable(bytes)) {
					// Observe rejection before failing rather than leaking an unhandled RPC.
					await bytes
					throw unsupported('async snapshot polling lacks an atomic allocation/sample ABI')
				}
				if (bytes !== null) {
					// Read the delta in this same task, before parsing or yielding to another tick.
					const allocated = P.SnapshotLastEmitAllocatedBytes()
					if (thenable(allocated)) {
						await allocated
						throw unsupported('async delta lacks an atomic allocation/sample ABI')
					}
					if (typeof allocated !== 'number' || !Number.isSafeInteger(allocated) || allocated < 0)
						throw new Error(`invalid allocated-byte delta ${String(allocated)}`)
					paired = { allocated, meta: readSnapshot(bytes) }
					break
				}
				await new Promise(resolveFrame => runtime.requestAnimationFrame(resolveFrame))
			}
			if (!paired) throw new Error(`timed out after ${deadlineMs}ms waiting for a snapshot`)
			const { meta, allocated } = paired
			if (meta.version !== 1)
				throw unsupported(`snapshot v${meta.version} is not the measured v1 amber-crossing allocation pin`)
			if (meta.actorCount !== expectedActorCount)
				throw new Error(`workload actor count moved ${expectedActorCount} -> ${meta.actorCount} at tick ${meta.tick}`)
			if (meta.tick !== i) throw new Error(`pinned emission tick moved ${i} -> ${meta.tick}`)
			if (i >= warmupCount) { bytesPerEmit.push(allocated); ticks.push(meta.tick) }
		}
		return { bytesPerEmit, ticks, firstTick: ticks[0], lastTick: ticks.at(-1), actorCount: expectedActorCount }
	}
	return { readSnapshot, collect }
}
