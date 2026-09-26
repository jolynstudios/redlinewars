// STEELSEED — units/deploy
//
// The presentation half of an MCV deploying into a construction yard.
//
// OpenRA's Transform trait keeps the actor id and swaps the type; the snapshot
// simply stops saying `mcv` and starts saying `fact`. Without this class the yard
// would pop in where the hull was. What plays instead is an UNFOLD: the placed
// matrix is scaled about its own ground point, width recovering first (the hull
// opens out sideways) and height on an ease-out-back curve that overshoots ~9%
// near t≈0.8 and settles — the construction read is the building INFLATING, not
// fading in.
// Fixed table, no allocation: a match has a handful of deploys, and the per-frame
// probe is a linear scan over 64 slots for the few ids currently animating.

/** Seconds the unfold plays for. */
export const DEPLOY_SECONDS = 1.5

/** MCV→construction-yard is the only transform presentation answers today. */
export const DEPLOY_FROM = 'mcv'
export const DEPLOY_TO = 'fact'

/** Ids with a live animation, -1 when the slot is free. */
const EMPTY = -1
const CAPACITY = 64

export class DeployAnims {
	private readonly ids = new Int32Array(CAPACITY).fill(EMPTY)
	private readonly t0 = new Float32Array(CAPACITY)
	/** Next slot a NEW id takes; cycles, so a full table evicts the oldest. */
	private cursor = 0

	mark(id: number, t0: number): void {
		for (let i = 0; i < CAPACITY; i++) {
			if (this.ids[i] === id) { this.t0[i] = t0; return }
		}
		// New id: take the cursor slot. The cursor cycles, so a full table evicts the
		// OLDEST deploy — the same contract as damage-states' crossing ring. A deploy
		// evicted this way is already indistinguishable from a full-scale yard.
		this.ids[this.cursor] = id
		this.t0[this.cursor] = t0
		this.cursor = (this.cursor + 1) % CAPACITY
	}
	/**
	 * The (width, height) scale for `id` at presentation seconds `now`, or null when
	 * it is not animating. The entry expires itself at the end of the window.
	 */
	scaleFor(id: number, now: number): [number, number] | null {
		for (let i = 0; i < this.ids.length; i++) {
			if (this.ids[i] !== id) continue
			const t = (now - this.t0[i]) / DEPLOY_SECONDS
			if (t >= 1) { this.ids[i] = EMPTY; return null }
			if (t < 0) return null
			const back = 1.70158
			const eased = 1 + (back + 1) * (t - 1) ** 3 + back * (t - 1) ** 2
			const scaleY = 0.06 + 0.94 * eased
			return [0.55 + 0.45 * scaleY, scaleY]
		}
		return null
	}

	clear(): void {
		this.ids.fill(EMPTY)
	}
}
