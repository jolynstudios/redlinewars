import test from 'node:test'
import assert from 'node:assert/strict'
import { ALLOCATION_PIN, assertAllocationResult, createAllocationProbe } from './allocprobe-contract.mjs'

function snapshot(tick = 0, actors = 8, version = 1, capacity = 52) {
	const bytes = new Uint8Array(capacity)
	const v = new DataView(bytes.buffer)
	v.setUint32(0, 0x504e5353, true)
	v.setUint16(4, version, true)
	v.setUint16(6, 1, true)
	v.setUint32(8, 52, true)
	v.setUint32(12, tick, true)
	v.setUint16(32, 3, true)
	v.setUint32(36, 44, true)
	v.setUint32(40, 8, true)
	v.setUint32(44, actors, true)
	return bytes
}

function fixture({ version = 1, actors = 8, firstTick = 0 } = {}) {
	let tick = firstTick - 1
	let now = 0
	let allocated = -1
	let injection = 0
	const calls = []
	const native = {
		SnapshotLastEmitAllocatedBytes: () => allocated,
		SnapshotSetAllocationProbeBytes: value => { injection = value; calls.push(['set', value]) },
		StartGeneratedSkirmish: (...args) => { calls.push(['start', ...args]); return 'ok: started' },
	}
	const bridge = { pollSnapshot: () => {
		tick++
		allocated = (new Map(ALLOCATION_PIN.transients).get(tick) ?? ALLOCATION_PIN.floor) + injection
		return snapshot(tick, actors, version)
	} }
	const runtime = { ora: native, steelseedBridgeReady: Promise.resolve(bridge),
		performance: { now: () => now }, requestAnimationFrame: callback => { now += 16; callback(now) } }
	return { native, bridge, runtime, calls }
}
const options = { deadlineMs: 100 }

test('80 synchronous native emissions preserve exact 16 warmup and 64 paired pins', async () => {
	const f = fixture()
	const result = await createAllocationProbe(f.runtime).collect(options)
	assertAllocationResult(result)
	assert.equal(result.firstTick, 16)
	assert.equal(result.lastTick, 79)
	assert.deepEqual(f.calls, [['set', 0], ['start', 'seedline', 'Preset', 'amber-crossing', 'STEELWORKS', 1, 'normal']])
})

test('factory is self-contained and browser serializable', async () => {
	const factory = Function(`return (${createAllocationProbe.toString()})`)()
	assertAllocationResult(await factory(fixture().runtime).collect(options))
})

test('above and below falsifiers remain red', async () => {
	const base = await createAllocationProbe(fixture().runtime).collect(options)
	assert.throws(() => assertAllocationResult(base, { falsifyBelow: true }), /sequence moved/)
	const above = await createAllocationProbe(fixture().runtime).collect({ ...options, allocationProbeBytes: 64 })
	assert.throws(() => assertAllocationResult(above), /sequence moved/)
})

test('current canonical native export absence fails before workload or polling', async () => {
	const f = fixture()
	delete f.native.SnapshotLastEmitAllocatedBytes
	f.bridge.pollSnapshot = () => assert.fail('must not emit')
	await assert.rejects(createAllocationProbe(f.runtime).collect(options), /unsupported legacy.*SnapshotLastEmitAllocatedBytes.*no allocation acceptance/)
	assert.deepEqual(f.calls, [])
})

test('Proxy typeof cannot turn missing native RPC into capability evidence', async () => {
	const f = fixture()
	f.runtime.ora = new Proxy({}, { get: (_, name) => () => Promise.reject(new Error(`unknown raw program method ${name}`)) })
	assert.equal(typeof f.runtime.ora.SnapshotLastEmitAllocatedBytes, 'function')
	await assert.rejects(createAllocationProbe(f.runtime).collect(options), /unsupported legacy.*unknown raw program method/)
	assert.deepEqual(f.calls, [])
})

test('valid async allocation RPC still cannot pair with queued snapshots', async () => {
	const f = fixture()
	f.native.SnapshotLastEmitAllocatedBytes = async () => -1
	await assert.rejects(createAllocationProbe(f.runtime).collect(options), /async allocation RPC cannot be paired/)
	assert.deepEqual(f.calls, [])
})

test('missing setter and invalid setter acknowledgement cannot start workload', async () => {
	for (const setter of [undefined, () => 'ok', async () => undefined]) {
		const f = fixture()
		f.native.SnapshotSetAllocationProbeBytes = setter
		await assert.rejects(createAllocationProbe(f.runtime).collect(options), /SnapshotSetAllocationProbeBytes unavailable/)
		assert.deepEqual(f.calls, [])
	}
})

test('async skirmish result is awaited without Promise stringification', async () => {
	const f = fixture()
	f.native.StartGeneratedSkirmish = async () => 'ok: started'
	assertAllocationResult(await createAllocationProbe(f.runtime).collect(options))
})

test('missing pinned workload and rejected start remain failures', async () => {
	for (const start of [undefined, () => 'error: unavailable', async () => 'error: unavailable']) {
		const f = fixture()
		f.native.StartGeneratedSkirmish = start
		await assert.rejects(createAllocationProbe(f.runtime).collect(options), /workload unavailable|skirmish start failed: error: unavailable/)
	}
})

test('current v2 frame parses truthfully but cannot inherit legacy v1 allocation pins', async () => {
	const f = fixture({ version: 2 })
	const probe = createAllocationProbe(f.runtime)
	assert.deepEqual(probe.readSnapshot(snapshot(42, 8, 2)), { version: 2, tick: 42, actorCount: 8 })
	await assert.rejects(probe.collect(options), /v2 is not the measured v1/)
})

test('actor count and skipped initial ticks cannot change pinned workload', async () => {
	await assert.rejects(createAllocationProbe(fixture({ actors: 9 }).runtime).collect(options), /actor count moved/)
	await assert.rejects(createAllocationProbe(fixture({ firstTick: 1 }).runtime).collect(options), /emission tick moved 0 -> 1/)
})

test('async snapshot or mid-run async delta lacks atomic pairing', async () => {
	const f = fixture()
	f.bridge.pollSnapshot = async () => snapshot()
	await assert.rejects(createAllocationProbe(f.runtime).collect(options), /async snapshot polling/)
	const g = fixture()
	let calls = 0
	g.native.SnapshotLastEmitAllocatedBytes = () => ++calls === 1 ? -1 : Promise.resolve(248)
	await assert.rejects(createAllocationProbe(g.runtime).collect(options), /async delta/)
})

test('native delta must be an integer number, not coercible strings or nonfinite values', async () => {
	for (const value of ['248', NaN, Infinity, -2, .5]) {
		const f = fixture()
		f.native.SnapshotLastEmitAllocatedBytes = () => value
		await assert.rejects(createAllocationProbe(f.runtime).collect(options), /invalid native delta/)
	}
})

test('per-emission negative allocation delta fails', async () => {
	const f = fixture()
	let calls = 0
	f.native.SnapshotLastEmitAllocatedBytes = () => ++calls === 1 ? -1 : -1
	await assert.rejects(createAllocationProbe(f.runtime).collect(options), /invalid allocated-byte delta/)
})

test('no snapshot retains bounded deadline', async () => {
	const f = fixture()
	f.bridge.pollSnapshot = () => null
	await assert.rejects(createAllocationProbe(f.runtime).collect(options), /timed out after 100ms/)
})

test('changed exact workload options reject before native calls', async () => {
	for (const change of [{ warmupCount: 15 }, { sampleCount: 63 }, { expectedActorCount: 7 },
		{ allocationProbeBytes: 1 }, { deadlineMs: 0 }]) {
		const f = fixture()
		await assert.rejects(createAllocationProbe(f.runtime).collect({ ...options, ...change }), /invalid exact allocation/)
		assert.deepEqual(f.calls, [])
	}
})

test('snapshot reader bounds to payload rather than pinned slot capacity and handles subviews', () => {
	const probe = createAllocationProbe()
	assert.equal(probe.readSnapshot(snapshot(7, 8, 2, 1024)).tick, 7)
	const backing = new Uint8Array(100)
	backing.set(snapshot(), 8)
	assert.equal(probe.readSnapshot(backing.subarray(8, 60)).actorCount, 8)
})

test('malformed native header/table/actor section cannot grade allocations', () => {
	const probe = createAllocationProbe()
	const mutations = [
		v => v.setUint32(0, 0, true), v => v.setUint16(4, 3, true),
		v => v.setUint32(8, 53, true), v => v.setUint16(6, 2, true),
		v => v.setUint32(36, 0, true), v => v.setUint32(40, 9, true),
		v => v.setUint32(40, 4, true), v => v.setUint16(32, 4, true),
	]
	for (const mutate of mutations) {
		const bytes = snapshot()
		mutate(new DataView(bytes.buffer))
		assert.throws(() => probe.readSnapshot(bytes))
	}
	assert.throws(() => probe.readSnapshot(new Uint8Array(20)), /truncated/)
})

test('missing, sparse, duplicated or shorter measured sequence cannot pass', async () => {
	const original = await createAllocationProbe(fixture().runtime).collect(options)
	for (const mutate of [r => r.ticks.pop(), r => delete r.bytesPerEmit[1],
		r => { r.ticks[1] = r.ticks[0] }, r => { r.bytesPerEmit[2]-- }, r => { r.actorCount = 7 }]) {
		const result = structuredClone(original)
		mutate(result)
		assert.throws(() => assertAllocationResult(result))
	}
})
