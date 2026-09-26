// STEELSEED — fx/vfx-governor (vfx.md Epic 8 and §4; Ultra only)
//
// The Ultra budget governor. When frames run over the 60 Hz budget, it thins the DECORATIVE
// density quickly (muzzle gas, ground dust, strike haze and debris, the Tesla crawl, the
// nuclear dust and smoke puffs) and gives it back slowly once frames have room again. The two
// thresholds and the frame counts are the hysteresis that keeps it from hunting.
//
// It never touches the renderer's quality (the owner's rule: Ultra and Ultra+ never shed
// quality), and never removes a core cue: a flash, a path, an impact, a death, a nuke's stages
// and a Tesla bolt are not decorative, and none of them reads this scale. Ultra+ is not
// governed at all (vfx.md: "Ultra+ keeps all layers active with fixed density").

const BUDGET_MS = 1000 / 60
/** Smoothing per frame: about half a second of history before the governor reacts. */
const SMOOTH = 0.06
/** Over budget: the smoothed interval exceeds a 60 Hz frame by 8%. */
export const OVER_MS = BUDGET_MS * 1.08
/** Room again: the smoothed interval is 18% under a 60 Hz frame. */
export const UNDER_MS = BUDGET_MS * 0.82
/** Fast reduction: a third of a second over budget takes a quarter off. */
const REDUCE_AFTER_FRAMES = 20
const REDUCE_FACTOR = 0.75
/** Slow recovery: three seconds with room give back a twentieth. */
const RECOVER_AFTER_FRAMES = 180
const RECOVER_STEP = 0.05
/** The floor: the governor never takes more than 60% of the decorative density. */
export const MIN_SCALE = 0.4
/** A frame this long is a stall or a hidden tab, not evidence about the load. */
const IGNORE_OVER_MS = 250

export class VfxGovernor {
	/** Multiplier on decorative density, MIN_SCALE..1. */
	scale = 1
	private ema = BUDGET_MS
	private over = 0
	private under = 0
	readonly stats = { reductions: 0, recoveries: 0, minScale: 1, frameEmaMs: BUDGET_MS }

	reset(): void {
		this.scale = 1
		this.ema = BUDGET_MS
		this.over = this.under = 0
		this.stats.frameEmaMs = BUDGET_MS
	}

	/** One rendered frame's interval. `governed` is false on every tier but Ultra. */
	update(frameMs: number, governed: boolean): number {
		if (!governed) {
			if (this.scale !== 1 || this.over !== 0 || this.under !== 0) this.reset()
			return 1
		}
		if (!(frameMs > 0) || frameMs > IGNORE_OVER_MS) return this.scale
		this.ema += (frameMs - this.ema) * SMOOTH
		this.stats.frameEmaMs = this.ema
		if (this.ema > OVER_MS) {
			this.under = 0
			if (++this.over >= REDUCE_AFTER_FRAMES && this.scale > MIN_SCALE) {
				this.scale = Math.max(MIN_SCALE, this.scale * REDUCE_FACTOR)
				this.over = 0
				this.stats.reductions++
				if (this.scale < this.stats.minScale) this.stats.minScale = this.scale
			}
		} else if (this.ema < UNDER_MS) {
			this.over = 0
			if (++this.under >= RECOVER_AFTER_FRAMES && this.scale < 1) {
				this.scale = Math.min(1, this.scale + RECOVER_STEP)
				this.under = 0
				this.stats.recoveries++
			}
		} else this.over = this.under = 0
		return this.scale
	}
}
