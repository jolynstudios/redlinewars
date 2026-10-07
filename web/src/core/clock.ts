// STEELSEED — core/clock
// Frame clock with sim-tick interpolation.
//
// The simulation ticks at 25 Hz (40 ms) and is authoritative. We render at display
// rate. `alpha` is the interpolant between snapshot N-1 and N, and every world
// transform drawn must use it. A unit that pops, stutters or teleports between ticks
// is a gate failure and it is the single most common way an RTS looks cheap.

export const SIM_TICK_HZ = 25
export const SIM_TICK_MS = 1000 / SIM_TICK_HZ // 40

export interface TimeState {
	/** Seconds since boot. */
	elapsed: number
	/** Seconds since previous rendered frame, clamped. */
	dt: number
	/** Latest simulation tick number. */
	tick: number
	/** Interpolant in [0,1) between snapshot N-1 and N. */
	alpha: number
	/** Rendered frame counter. */
	frame: number
}

/**
 * A frame that took longer than this is treated as a stall — a tab restore, a GC
 * pause, a pipeline compile. Advancing animation by the true delta after one of those
 * teleports everything; clamping makes the world stutter instead, which is recoverable.
 */
const MAX_FRAME_DT = 0.1

export class Clock {
	readonly time: TimeState = { elapsed: 0, dt: 0, tick: 0, alpha: 0, frame: 0 }

	private lastFrameMs = 0
	private lastTickMs = 0
	private started = false
	private readonly deterministic: boolean
	private readonly fixedDt: number

	/**
	 * @param deterministic Fixed-step mode for baseline.mjs and imagediff.mjs. Wall
	 * clock is never read, so two runs produce bit-identical frames — which is the
	 * entire reason the capture harness can be a gate.
	 */
	constructor(opts: { deterministic?: boolean; fixedFps?: number } = {}) {
		this.deterministic = opts.deterministic ?? false
		this.fixedDt = 1 / (opts.fixedFps ?? 60)
	}

	/** Call when a snapshot for `tick` arrives. Resets the interpolation window. */
	onTick(tick: number, nowMs: number): void {
		this.time.tick = tick
		this.lastTickMs = nowMs
	}

	/** Advance one rendered frame. Returns the frame delta in seconds. */
	frame(nowMs: number, paused=false): number {
		const t = this.time
        if(paused){this.lastFrameMs=nowMs;t.dt=0;t.frame++;return 0}
		if (this.deterministic) {
			t.dt = this.fixedDt
			t.elapsed += this.fixedDt
			t.frame++
			// Alpha walks the tick window at a fixed rate so a deterministic capture
			// lands on the same interpolation phase every run.
			t.alpha = (t.frame * this.fixedDt * 1000) % SIM_TICK_MS / SIM_TICK_MS
			return t.dt
		}

		if (!this.started) {
			this.started = true
			this.lastFrameMs = nowMs
			this.lastTickMs = nowMs
		}

		let dt = (nowMs - this.lastFrameMs) / 1000
		if (dt < 0) dt = 0
		if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT
		this.lastFrameMs = nowMs
		t.dt = dt
		t.elapsed += dt
		t.frame++

		// Clamped to 1: if the next snapshot is late we hold the latest pose rather
		// than extrapolating. Extrapolating past a tick guesses at simulation state,
		// and when the guess is wrong the correction is a visible snap.
		const since = nowMs - this.lastTickMs
		t.alpha = since <= 0 ? 0 : since >= SIM_TICK_MS ? 1 : since / SIM_TICK_MS

		return dt
	}

	reset(): void {
		const t = this.time
		t.elapsed = 0
		t.dt = 0
		t.tick = 0
		t.alpha = 0
		t.frame = 0
		this.started = false
		this.lastFrameMs = 0
		this.lastTickMs = 0
	}
}
