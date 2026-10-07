// STEELSEED — materials/api
// The pinned tier-1 interface, transcribed from ARCHITECTURE.md §12.1 without deviation.
//
// It lives in its own module so `forge.ts` and `index.ts` can both name these types
// without an import cycle. §3.1 records what happens when a shape more than one node
// consumes is left to be guessed at, so this file is deliberately nothing but the pin.

export interface SurfaceSet {
	readonly id: string
	/**
	 * **Sample albedo through this view, never through `albedo` directly.**
	 *
	 * The texture stores **sRGB-ENCODED** bytes and this view is `rgba8unorm-srgb`, so the
	 * hardware performs the transfer-function decode on read. That encoding is deliberate
	 * and worth keeping: STEELSEED clamps albedo to 0.02..0.90 (§7), and 0.02 stored
	 * linearly in 8 bits is 5 raw levels, versus ~40 through sRGB — an 8x precision gain
	 * exactly where dark materials live.
	 *
	 * Exposing the view is what makes that safe. §12.1 previously pinned only the raw
	 * `GPUTexture`, so a consumer sampling it got no decode and the same set rendered at
	 * two different brightnesses depending on which node drew it — a measured 5.97x error
	 * that collapsed road and snow to the same value. The fix is structural: hand out a
	 * handle that cannot be sampled wrongly, rather than a rule saying "remember to decode".
	 */
	readonly albedoView: GPUTextureView
	/**
	 * Raw texture. **sRGB-encoded — not for direct sampling** (use `albedoView`). Here for
	 * copies, size queries and VRAM accounting only.
	 */
	readonly albedo: GPUTexture
	/** rg8unorm octahedral-encoded normals. Two channels, not three — bandwidth. */
	readonly normal: GPUTexture
	/** r=roughness g=metalness b=ao a=height, packed into one rgba8unorm. */
	readonly orm: GPUTexture
	/** r8unorm player-colour mask. A REAL repaint of panels, never a hue shift (§9). */
	readonly mask: GPUTexture
	readonly layerCount: number
	/** Bytes of VRAM this set occupies. Must be measured, not estimated (§7). */
	readonly vramBytes: number
	/** Authored physical repeat; absent legacy surfaces retain the4m terrain default. */
	readonly tileMeters?: number
	/** Saved source that fixes the unique-UV contract, when supplied by an asset atlas. */
	readonly sourceSha256?: string
}

export interface MaterialsApi {
	/** Built at boot, in a worker, from (assetSeed, id). Never during play. */
	get(id: string): SurfaceSet
	has(id: string): boolean
	/** Bind group layout every material-sampling pipeline must use. */
	readonly bindGroupLayout: GPUBindGroupLayout
	bindGroupFor(set: SurfaceSet): GPUBindGroup
	readonly totalVramBytes: number

	/**
	 * The §12.3b TerrainAtlas: every §8 surface in ONE array texture, so a single draw can
	 * sample two surfaces and blend between them. Physical layer is
	 * `surface * variantsPerSurface + variant`.
	 *
	 * A DISTINCT contract from `SurfaceSet`, deliberately. `SurfaceSet.layerCount` means
	 * *variants of one material* and `planForge` degrades resolution before variants on
	 * that basis; overloading it to mean "surface type" would make those semantics false.
	 *
	 * Null until built, and null forever on a backend where materials degraded — consumers
	 * peek rather than assume (rule 8).
	 */
	readonly terrainAtlas: TerrainAtlasView | null
}

/** Read-only face of the atlas. See `materials/atlas.ts` for construction. */
export interface TerrainAtlasView {
	/** Sample albedo through THIS — the texture holds sRGB-encoded bytes (§12.5). */
	readonly albedoView: GPUTextureView
	readonly normalView: GPUTextureView
	readonly ormView: GPUTextureView
	readonly maskView: GPUTextureView
	readonly surfaceCount: number
	readonly variantsPerSurface: number
	readonly layerCount: number
	readonly vramBytes: number
	/**
	 * Bind group, built against `MaterialsApi.bindGroupLayout` itself — so it can be bound
	 * anywhere a surface set would go, and a consumer needs no second pipeline layout.
	 */
	readonly bindGroup: GPUBindGroup
}
