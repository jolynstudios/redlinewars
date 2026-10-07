// View-only phase, never a second simulation of a facility's production state.
// Holding phase on disabled/paused actors prevents a visible snap to the bind pose.
export class MechanicalClock {
	private readonly phases = new Map<number, { tick: number; previous: number; current: number }>()
	observe(id: number, tick: number, disabled: boolean): void {
		let state = this.phases.get(id)
		if (!state || tick < state.tick) {
			state = { tick, previous: 0, current: 0 }
			this.phases.set(id, state)
			return
		}
		if (tick === state.tick) return
		state.previous = state.current
		if (!disabled) state.current += (tick - state.tick) / 25
		state.tick = tick
	}
	seconds(id: number, alpha: number): number {
		const state = this.phases.get(id)
		return state ? state.previous + (state.current - state.previous) * alpha : 0
	}
	/** Whether this actor is tracked at all, so a probe can tell a still rotor from an absent one. */
	has(id: number): boolean { return this.phases.has(id) }
	prune(tick: number): void { for (const [id, state] of this.phases) if (state.tick !== tick) this.phases.delete(id) }
	clear(): void { this.phases.clear() }
}
