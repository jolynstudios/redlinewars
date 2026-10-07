/** Presentation-only surface state. Precipitation remains an independent sky property. */
export class SurfaceWeather {
	snowCoverage = 0
	surfaceWetness = 0
	private lastTime = Number.NaN

	advance(seconds: number, snowfall: number, wetTarget: number): void {
		if (!Number.isFinite(seconds)) return
		const snow = Number.isFinite(snowfall) ? Math.max(0, Math.min(1, snowfall)) : 0
		const wet = Number.isFinite(wetTarget) ? Math.max(0, Math.min(1, wetTarget)) : 0
		// A newly entered snowy world already has a light covering. Replays/seeks
		// re-establish that authored state instead of integrating unknown weather history.
		if (!Number.isFinite(this.lastTime) || seconds < this.lastTime - 0.08 || seconds > this.lastTime + 5) {
			this.snowCoverage = snow * 0.55
			this.surfaceWetness = wet
			this.lastTime = seconds
			return
		}
		const dt = Math.max(0, seconds - this.lastTime)
		this.lastTime = Math.max(this.lastTime, seconds)
		if (dt === 0) return
		const oldSnow = this.snowCoverage
		if (snow > 0) this.snowCoverage = 1 - (1 - oldSnow) * Math.exp(-dt * snow / 35)
		else this.snowCoverage = oldSnow * Math.exp(-dt / (wet > 0.2 ? 70 : 180))
		const melt = Math.max(0, oldSnow - this.snowCoverage) * 30
		const target = Math.max(wet, Math.min(0.7, melt / dt))
		const rate = target > this.surfaceWetness ? 4 : 100
		this.surfaceWetness += (target - this.surfaceWetness) * (1 - Math.exp(-dt / rate))
	}
}
