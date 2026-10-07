// STEELSEED — render/gpu-timer
//
// Opt-in GPU pass timing (`?gputime=1`; vfx.md Epics 0, 8 and 10). Every render and compute
// pass the frame encoder begins gets a begin/end timestamp pair, labelled with the pass's own
// label. The resolved values travel through a small ring of readback buffers that are mapped
// asynchronously, so no frame ever waits on the GPU: a frame whose ring slot is still in
// flight is simply not timed and counts as `skipped`. Without the flag the device is requested
// exactly as before and this module is never constructed.
//
// Read the numbers with care. Browsers may quantise timestamps (Chrome rounds to 100 µs unless
// WebGPU developer features are enabled). A frame's total runs from its first pass's begin to
// its last pass's end, so idle gaps between passes count; per-pass values exclude them. CPU
// submission time is a different number and is never reported here.

export interface GpuPassTiming {
	readonly label: string
	/** The pass's own begin-to-end duration. Tile-based GPUs overlap consecutive passes
	 *  (Apple silicon starts the next pass's vertex work while the previous one shades),
	 *  so these overlap and do not add up to the frame. */
	readonly ms: number
	/** How far this pass pushed the frame's timeline past the previous pass's end: the
	 *  additive share. Exclusive times sum to the frame total minus idle gaps. */
	readonly exclusiveMs: number
}

export interface GpuFrameTiming {
	/** Frame counter at encode time; skipped frames leave gaps. */
	readonly frame: number
	readonly totalMs: number
	readonly passes: readonly GpuPassTiming[]
}

/** Passes stamped per frame. The frame encodes about ten; the rest pass through untimed. */
const MAX_PASSES = 32
/** Readback slots in flight. Four frames of latency before a frame goes untimed. */
const RING = 4
/** Completed frames kept for harness reads: ten seconds at 60 Hz. */
const HISTORY = 600
/** Two u64 timestamps per pass. */
const BYTES_PER_PASS = 16

interface Slot {
	readonly buffer: GPUBuffer
	busy: boolean
	count: number
	frame: number
	readonly labels: string[]
}

export class GpuTimer {
	/** Completed frames, oldest first, bounded to HISTORY. */
	readonly history: GpuFrameTiming[] = []
	latest: GpuFrameTiming | null = null
	/** Frames encoded while every readback slot was still in flight. */
	skipped = 0
	/** Readbacks that failed (device loss, destroyed buffer). */
	failed = 0

	private readonly querySet: GPUQuerySet
	private readonly resolveBuffer: GPUBuffer
	private readonly slots: Slot[] = []
	private active: Slot | null = null
	private frame = 0

	constructor(device: GPUDevice) {
		this.querySet = device.createQuerySet({ label: 'gpu-timer.queries', type: 'timestamp', count: MAX_PASSES * 2 })
		this.resolveBuffer = device.createBuffer({
			label: 'gpu-timer.resolve',
			size: MAX_PASSES * BYTES_PER_PASS,
			usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
		})
		for (let i = 0; i < RING; i++) {
			this.slots.push({
				buffer: device.createBuffer({
					label: `gpu-timer.readback.${i}`,
					size: MAX_PASSES * BYTES_PER_PASS,
					usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
				}),
				busy: false, count: 0, frame: 0, labels: [],
			})
		}
	}

	/** Start timing one frame: every pass begun on `encoder` from now on is stamped. */
	wrap(encoder: GPUCommandEncoder): void {
		this.frame++
		const slot = this.slots.find(candidate => !candidate.busy) ?? null
		this.active = slot
		if (!slot) {
			this.skipped++
			return
		}
		slot.count = 0
		slot.frame = this.frame
		slot.labels.length = 0
		const beginRender = encoder.beginRenderPass.bind(encoder)
		const beginCompute = encoder.beginComputePass.bind(encoder)
		encoder.beginRenderPass = desc => beginRender(this.stamp(desc))
		encoder.beginComputePass = desc => beginCompute(this.stamp(desc ?? {}))
	}

	/** Before `encoder.finish()`: resolve this frame's stamps into its readback slot. */
	resolve(encoder: GPUCommandEncoder): void {
		const slot = this.active
		if (!slot || slot.count === 0) return
		encoder.resolveQuerySet(this.querySet, 0, slot.count * 2, this.resolveBuffer, 0)
		encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot.buffer, 0, slot.count * BYTES_PER_PASS)
	}

	/** After `queue.submit()`: read the slot back without blocking the frame. */
	afterSubmit(): void {
		const slot = this.active
		this.active = null
		if (!slot || slot.count === 0) return
		slot.busy = true
		const count = slot.count, frame = slot.frame, labels = slot.labels.slice()
		const bytes = count * BYTES_PER_PASS
		slot.buffer.mapAsync(GPUMapMode.READ, 0, bytes).then(() => {
			const stamps = new BigUint64Array(slot.buffer.getMappedRange(0, bytes))
			const passes: GpuPassTiming[] = []
			let first = stamps[0]!, last = stamps[1]!, previousEnd = stamps[0]!
			for (let i = 0; i < count; i++) {
				const begin = stamps[i * 2]!, end = stamps[i * 2 + 1]!
				if (begin < first) first = begin
				if (end > last) last = end
				const from = begin > previousEnd ? begin : previousEnd
				passes.push({
					label: labels[i]!,
					ms: end > begin ? Number(end - begin) / 1e6 : 0,
					exclusiveMs: end > from ? Number(end - from) / 1e6 : 0,
				})
				if (end > previousEnd) previousEnd = end
			}
			slot.buffer.unmap()
			const timing: GpuFrameTiming = { frame, totalMs: last > first ? Number(last - first) / 1e6 : 0, passes }
			this.latest = timing
			this.history.push(timing)
			if (this.history.length > HISTORY) this.history.shift()
		}).catch(() => {
			this.failed++
		}).finally(() => {
			slot.busy = false
		})
	}

	destroy(): void {
		this.querySet.destroy()
		this.resolveBuffer.destroy()
		for (const slot of this.slots) slot.buffer.destroy()
	}

	private stamp<T extends GPURenderPassDescriptor | GPUComputePassDescriptor>(desc: T): T {
		const slot = this.active
		if (!slot || slot.count >= MAX_PASSES || desc.timestampWrites) return desc
		const index = slot.count++
		slot.labels.push(desc.label || `pass.${index}`)
		return {
			...desc,
			timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1 },
		}
	}
}
