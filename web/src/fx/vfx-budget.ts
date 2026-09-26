// STEELSEED — fx/vfx-budget
//
// The two combat-VFX tiers of vfx.md (Ultra and Ultra+), and what each may spend. This is
// vfx.md's `VfxBudgetConfig`.
//
// Only the `ultra` and `ultra-max` qualities get the layers this program adds: muzzle gas,
// ground dust, surface-aware impact haze and debris, scorch marks, the artillery ribbon. Every
// other quality keeps the look it shipped with. Correctness fixes to effects that already
// existed apply to every quality: a shell drawn on its real flight instead of after it
// landed, and impacts sized by the weapon instead of by raw damage. Those are not new layers.
//
// Ultra+ is Ultra with fuller composition inside the same frame budget, never a separate
// look. It only adds density to the decorative layers; the flash, the path, the impact and the
// death read the same on both.
//
// The numbers are ceilings, not spawn targets, and they are provisional until vfx.md Epic 10
// measures them on the qualification machine. Nothing here sheds quality at runtime: the
// owner's rule is that Ultra and Ultra+ never degrade themselves. The one runtime lever is the
// Ultra governor (fx/vfx-governor), which thins decorative density only, never a core cue.

export type VfxTier = 'legacy' | 'ultra' | 'ultra-plus'

export interface VfxBudgetConfig {
	readonly tier: VfxTier
	/** The Ultra combat layers exist at all. False keeps the shipped look exactly. */
	readonly combatLayers: boolean
	/**
	 * Slots in the CPU particle pool (fx/particles.ts). The renderer draws at most 4096
	 * particles a frame (render/renderer.ts `particleLimit`), so no tier asks for more.
	 */
	readonly particleCapacity: number
	/** Multiplier on the COUNT of decorative particles (gas, dust, haze, debris). */
	readonly decorativeDensity: number
	/** Scorch marks alive at once (fx/impact-scorch.ts), taken out of the decal budget. */
	readonly scorchCapacity: number
	/**
	 * Transient lights fx may add in one frame (vfx.md: 32 Ultra / 48 Ultra+). A nuclear flash
	 * is exempt. The renderer still ranks everything it is given against its own capacity.
	 */
	readonly lightCapacity: number
	/**
	 * The budget governor (fx/vfx-governor) may thin decorative density under load. Ultra only:
	 * Ultra+ keeps fixed density, and the legacy look is never touched.
	 */
	readonly governed: boolean
	/**
	 * Particle screen coverage a frame may draw (fx/particles: the sum of (radius / distance)^2,
	 * about screen-fulls of overdraw). Above it the next frame draws a stable share of the smoke
	 * and dust only. A fixed cap on both tiers, like the light cap; the legacy look is untouched.
	 * Lights are also bounded per tile by the renderer (render/clusters: 8 to 64 per cluster).
	 *
	 * Measured (web/tools/coveragegate.mjs, docs/vfx/baseline/coverage-*.json; 1920x1080, DPR 1,
	 * M3 Pro): each unit of drawn coverage costs 0.54-0.57 ms of GPU frame at either tier,
	 * linearly, the Ultra puff (render/atmosphere) no more than the round one; a full pool of smoke
	 * (coverage 19.6) takes the GPU frame p95 to 17.4 ms. The battle baseline leaves 6.5 ms under
	 * the qualification gate (GPU frame p95 <= 14 ms; battle p95 7.3 ms Ultra, 7.55 ms Ultra+):
	 * smoke and dust may spend 3 ms of it at Ultra and 4.5 ms at Ultra+. The cap applies from the
	 * previous frame's coverage, so what is drawn runs about 6% over it: 3 / (0.57 x 1.06) gives
	 * 5.0 at Ultra, 4.5 / (0.55 x 1.06) gives 7.5 at Ultra+. A battle's own smoke stays far below
	 * either; the cap bites only when smoke fills the screen, and then it hides the same particles
	 * every frame, never flickering.
	 */
	readonly coverageBudget: number
}

const LEGACY: VfxBudgetConfig = { tier: 'legacy', combatLayers: false, particleCapacity: 2048, decorativeDensity: 1, scorchCapacity: 0, lightCapacity: Infinity, governed: false, coverageBudget: Infinity }
const ULTRA: VfxBudgetConfig = { tier: 'ultra', combatLayers: true, particleCapacity: 3072, decorativeDensity: 1, scorchCapacity: 192, lightCapacity: 32, governed: true, coverageBudget: 5 }
const ULTRA_PLUS: VfxBudgetConfig = { tier: 'ultra-plus', combatLayers: true, particleCapacity: 4096, decorativeDensity: 1.5, scorchCapacity: 320, lightCapacity: 48, governed: false, coverageBudget: 7.5 }

/** The budget for a quality name (`ctx.config.q.name`). */
export function vfxBudgetFor(quality: string): VfxBudgetConfig {
	return quality === 'ultra-max' ? ULTRA_PLUS : quality === 'ultra' ? ULTRA : LEGACY
}
