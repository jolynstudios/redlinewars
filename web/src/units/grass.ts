// STEELSEED — units/grass
//
// Near-camera instanced grass tufts and understory shrubs: the density layer that stops
// the ground reading as a painted heightfield. The meshes ship in the living pack; this
// module only DECIDES WHERE they stand, and that decision must satisfy three rules:
//
// 1. Deterministic per world cell. A plant's position is hashed from the cell it grows
//    in, so the field does not swim or reshuffle as the camera moves — walking over the
//    map replays the same field, and two clients agree byte for byte.
// 2. Camera-local, world-anchored. Instances only exist within a ring around the
//    camera, but their placements are world cells, so the ring is a WINDOW over an
//    infinite implicit field rather than a cloud that follows the viewer.
// 3. Cheap to be wrong. A tuft costs one 60-byte instance and 64 triangles, casts no
//    shadow and owns no bones; the whole layer is two draw calls that rebuild a few
//    times a second at most.
//
// The understory (shrubs) rides the same implicit field at a tenth of the density with
// its own budget: same eligibility, bigger plants, one more draw call.
//
// WIND: two tuft assets ship. The default 'grass' is rig-less and static. The skinned
// 'grasswind' carries a wind bone and costs a bone palette per instance per frame plus
// a JS skin pass at full density. Ultra-max and Dynamic boot it; Detect and the named
// locked presets leave the field empty. `?grasswind=1` still forces the mesh to upload.
import { Surface, ShroudState, type Ctx } from '../core'
import { fetchAssetPack } from '../core/asset-pack'
import { computeSkinMatrices, computeWorldTransforms, setBoneAngle } from '../geo/rig'
import { decodeBlenderAsset, type BlenderAsset } from './blender-mesh'
import type { RenderApi, TerrainApi, ShroudApi, DrawItem } from './types'

interface Manifest { schema: number; bytes: number; storedBytes: number; sha256: string; assets: Record<string, BlenderAsset> }
const manifests = import.meta.glob<Manifest>('../../.forge/living/manifest.json', { eager: true, import: 'default' })
const packs = import.meta.glob<string>('../../.forge/living/living.ssasset.gz', { eager: true, query: '?url', import: 'default' })

const RING_M = 26
const REBUILD_M = 4
const ATTEMPTS_PER_CELL = 2
/** Chance one attempt places a tuft; 2 × 0.675 ≈ 1.35 tufts per eligible square metre. */
const PLACE_CHANCE = 0.675
/** The understory layer: same field, tenth the density, bigger plants. */
const SHRUB_CHANCE = 0.05
/** Props: rocks, logs and fence runs. Rare, so the map reads used, not cluttered. */
const PROP_CHANCE = 0.012
const GRASS_LIMIT = 3072
/** Sway angles a frame, and the gust's reach (sin + 0.24 sin stays within 1.24). */
const WIND_POSES = 48
const GUST_MAX = 1.24
const SHRUB_LIMIT = 512
const PROP_LIMIT = 384

function noise(n: number): number {
	let x = Math.imul(n ^ 0x574a, 0x45d9f3b)
	x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
	return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

type Rig = NonNullable<ReturnType<typeof decodeBlenderAsset>['rig']>

interface Pool {
	/** Mutable view of the DrawItem's mesh slot: upload happens after construction. */
	mesh: DrawItem['mesh'] | null
	item: DrawItem
	readonly transforms: Float32Array
	count: number
	readonly limit: number
	/** Present when the asset shipped skinned: the wind pass poses and reserves per instance. */
	rig: Rig | null
	pose: ReturnType<Rig['skeleton']['createPose']> | null
	world: Float32Array | null
}

function makePool(limit: number): Pool {
	const transforms = new Float32Array(limit * 16)
	const pool: Pool = {
		mesh: null,
		transforms,
		count: 0,
		limit,
		rig: null,
		pose: null,
		world: null,
		item: null as unknown as DrawItem,
	}
	pool.item = {
		get mesh() { return pool.mesh as DrawItem['mesh'] },
		surfaceSet: 'blender', instances: transforms,
		playerColors: new Uint8Array(limit), damages: new Float32Array(limit), paletteBases: new Uint16Array(limit),
		boneCount: 0, castsShadow: false,
		get instanceCount() { return pool.count },
	}
	return pool
}

export class GrassScatter {
	private readonly grass = makePool(GRASS_LIMIT)
	/** The skinned wind variant: same field, same placements, costs palettes. */
	private readonly wind = makePool(GRASS_LIMIT)
	private shrub: Pool | null = null
	private readonly props: Pool[] = []
	private anchorX = NaN
	private anchorZ = NaN
	private usedWind = false
	readonly stats = { instances: 0, shrubs: 0, rebuilds: 0, ringCells: 0, poses: 0, error: '' }
	/** This frame's palette base per quantised sway angle, -1 until the angle is first needed. */
	private readonly poseBases = new Int32Array(WIND_POSES)
	private ampScale: number | null = null

	async init(render: RenderApi, ctx: Ctx): Promise<boolean> {
		const q = ctx.config.q
		// Dynamic keeps the meshes resident so extras can return without a reload;
		// Turbo 60's scale-only governor must not switch the living system on.
		if (!q.nearField) return false
		const manifest = Object.values(manifests)[0], url = Object.values(packs)[0]
		if (!manifest || !url || manifest.schema !== 1) throw new Error('Incomplete living asset pack')
		const asset = manifest.assets['grass']
		if (!asset) return false
		const bytes = await fetchAssetPack(url, manifest)
		const decoded = decodeBlenderAsset(bytes, asset)
		this.grass.mesh = render.upload(decoded.mesh, 'living.grass')
		const windAsset = manifest.assets['grasswind']
		const forceWind = typeof location !== 'undefined' && new URLSearchParams(location.search).get('grasswind') === '1'
		if (windAsset && (q.windGrass || forceWind)) {
			const windDecoded = decodeBlenderAsset(bytes, windAsset)
			this.wind.mesh = render.upload(windDecoded.mesh, 'living.grasswind')
			this.wind.rig = windDecoded.rig
			this.wind.pose = windDecoded.rig?.skeleton.createPose() ?? null
			this.wind.world = windDecoded.rig?.skeleton.createMatrixBuffer() ?? null
			;(this.wind.item as { boneCount: number }).boneCount = windDecoded.rig?.skeleton.boneCount ?? 0
			// The wind pool replaces the static one for placement: same limit, same field.
			;(this.wind as { limit: number }).limit = this.grass.limit
		}
		const shrubAsset = manifest.assets['shrub']
		if (shrubAsset) {
			this.shrub = makePool(SHRUB_LIMIT)
			this.shrub.mesh = render.upload(decodeBlenderAsset(bytes, shrubAsset).mesh, 'living.shrub')
		}
		// Props: one pool per kind. The per-cell prop hash picks ONE of the three, so a
		// cell never grows a rock on top of a fence run.
		for (const [name, limit] of [['rocks', 96], ['logs', 96], ['fence', 96]] as const) {
			const asset = manifest.assets[name]
			if (!asset) continue
			const pool = makePool(limit)
			pool.mesh = render.upload(decodeBlenderAsset(bytes, asset).mesh, `living.${name}`)
			// Props DO cast shadows: a rock or a fence rail without one floats.
			const item = pool.item as { castsShadow: boolean }
			item.castsShadow = true
			this.props.push(pool)
		}
		return true
	}

	update(ctx: Ctx, render: RenderApi, terrain: TerrainApi, shroud: ShroudApi): void {
		if (!ctx.config.extras.nearField) return
		const wantWind = ctx.config.extras.windGrass && this.wind.mesh != null
		if (wantWind !== this.usedWind) {
			this.usedWind = wantWind
			this.anchorX = NaN
		}
		const active = wantWind ? this.wind : this.grass
		if (!active.mesh) return
		const focus = render.camera.focus
		const cx = focus[0], cz = focus[2]
		if (active.count === 0 || Math.hypot(cx - this.anchorX, cz - this.anchorZ) >= REBUILD_M) this.rebuild(cx, cz, terrain, shroud)
		if (active === this.wind) this.sway(ctx, render)
		if (active.count > 0) render.submit(active.item)
		if (this.shrub && this.shrub.count > 0) render.submit(this.shrub.item)
		for (const pool of this.props) if (pool.count > 0) render.submit(pool.item)
	}

	/**
	 * Wind pass: every placed tuft sways on the same gust field the trees ride - sin at the
	 * tuft's own phase from its world position, plus a slower second harmonic, scaled by the
	 * authored amplitude. The field is quantised to WIND_POSES angles a frame, each posed and
	 * given bone slots once, and every tuft takes the palette of its angle: 0.3 degrees apart,
	 * the eye cannot tell, while the CPU poses 48 skeletons instead of 3,000 and the bone upload
	 * shrinks from thousands of matrices to about a hundred. The palette is per frame and shared
	 * with every unit, tree and corpse; if it ever runs out the remaining tufts are DROPPED,
	 * never drawn at palette base 0 - that reads another actor's matrices, which is the bug a
	 * rig-less tuft existed to avoid.
	 */
	private sway(ctx: Ctx, render: RenderApi): void {
		const pool = this.wind
		const rig = pool?.rig
		if (!rig || !pool.pose || !pool.world) return
		const sk = rig.skeleton
		const windBone = rig.windBones?.[0]
		if (windBone === undefined) return
		// The test switch carries its own strength: ?grasswind=1&windamp=1.6. Clamped so
		// a typo cannot flatten the tufts or whip them through the ground. The default is
		// the authored amplitude; the review's verdict picks the number that ships.
		if (this.ampScale === null) {
			const ampParam = typeof location === 'undefined' ? NaN : Number(new URLSearchParams(location.search).get('windamp'))
			this.ampScale = Number.isFinite(ampParam) && ampParam > 0 ? Math.min(3, Math.max(0.2, ampParam)) : 1
		}
		const speed = rig.windSpeeds?.[0] ?? 1
		const amplitude = (rig.windAmplitudes?.[0] ?? 0.1) * this.ampScale
		const seconds = (ctx.time.tick + ctx.time.alpha) / 25
		const bases = pool.item.paletteBases
		this.poseBases.fill(-1)
		let poses = 0
		for (let i = 0; i < pool.count; i++) {
			const wx = pool.transforms[i * 16 + 12], wz = pool.transforms[i * 16 + 14]
			const phase = seconds * speed + wx * 0.43 + wz * 0.31
			const gust = Math.sin(phase) + Math.sin(phase * 2.17) * 0.24
			const b = Math.max(0, Math.min(WIND_POSES - 1, Math.round((gust + GUST_MAX) / (2 * GUST_MAX) * (WIND_POSES - 1))))
			let base = this.poseBases[b]
			if (base < 0) {
				const reserved = render.reserveBones(sk.boneCount)
				if (!reserved) {
					// Palette exhausted: keep what is placed, drop the tail. Never base 0.
					pool.count = i
					this.stats.instances = i
					break
				}
				pool.pose.resetToBind()
				setBoneAngle(pool.pose, windBone, (b / (WIND_POSES - 1) * 2 * GUST_MAX - GUST_MAX) * amplitude)
				computeWorldTransforms(pool.pose, pool.world)
				computeSkinMatrices(sk, pool.world, reserved.matrices)
				base = this.poseBases[b] = reserved.base
				poses++
			}
			if (bases) bases[i] = base
		}
		this.stats.poses = poses
	}

	/** Rebuild the ring: window the implicit world field around the camera. */
	private rebuild(cx: number, cz: number, terrain: TerrainApi, shroud: ShroudApi): void {
		const active = this.usedWind && this.wind.mesh ? this.wind : this.grass
		this.grass.count = 0
		if (this.wind.mesh) this.wind.count = 0
		if (this.shrub) this.shrub.count = 0
		for (const pool of this.props) pool.count = 0
		this.anchorX = cx
		this.anchorZ = cz
		this.stats.rebuilds++
		const x0 = Math.floor(cx - RING_M), x1 = Math.ceil(cx + RING_M)
		const z0 = Math.floor(cz - RING_M), z1 = Math.ceil(cz + RING_M)
		this.stats.ringCells = (x1 - x0) * (z1 - z0)
		const ringSq = RING_M * RING_M
		for (let cellZ = z0; cellZ < z1; cellZ++) {
			for (let cellX = x0; cellX < x1; cellX++) {
				for (let attempt = 0; attempt < ATTEMPTS_PER_CELL; attempt++) {
					const seed = cellZ * 73856093 ^ cellX * 19349663 ^ attempt * 0x9e3779b9
					const wx = cellX + 0.08 + noise(seed + 11) * 0.84
					const wz = cellZ + 0.08 + noise(seed + 23) * 0.84
					const dx = wx - cx, dz = wz - cz
					// Circular ring: a square window would push the far corners past the budget.
					if (dx * dx + dz * dz > ringSq) continue
					// Shared eligibility: natural ground, dry, inside the explored reveal.
					const surface = terrain.surfaceAt(wx, wz)
					const eligible = (surface === Surface.grass || surface === Surface.soil) &&
						terrain.waterHeightAt(wx, wz) === null &&
						shroud.stateAt(Math.floor(wx), Math.floor(wz)) !== ShroudState.unexplored
					if (!eligible) continue
					if (noise(seed) <= PLACE_CHANCE)
						this.place(active, wx, terrain.heightAt(wx, wz), wz, noise(seed + 31), 0.8 + noise(seed + 43) * 0.55)
					// The understory rides the same field at a tenth of the density: one
					// shrub attempt per cell, same eligibility, own budget.
					if (this.shrub && noise(seed + 77) <= SHRUB_CHANCE)
						this.place(this.shrub, wx, terrain.heightAt(wx, wz), wz, noise(seed + 91), 0.9 + noise(seed + 103) * 0.4)
					// One prop per cell at PROP_CHANCE: the kind is hashed, the yaw too.
					// Fence runs align their yaw to the hashed axis so runs read laid out.
					if (this.props.length > 0 && noise(seed + 55) <= PROP_CHANCE) {
						const pick = Math.min(this.props.length - 1, Math.floor(noise(seed + 61) * this.props.length))
						const pool = this.props[pick]
						const yaw = pool === this.props[2] ? (noise(seed + 67) < 0.5 ? 0 : Math.PI / 2) : noise(seed + 67) * Math.PI
						this.place(pool, wx, terrain.heightAt(wx, wz), wz, yaw / (Math.PI * 2), 0.9 + noise(seed + 71) * 0.5)
					}
					if (active.count >= active.limit && (!this.shrub || this.shrub.count >= this.shrub.limit)) return
				}
			}
		}
		this.stats.instances = active.count
		this.stats.shrubs = this.shrub?.count ?? 0
	}

	private place(pool: Pool, x: number, y: number, z: number, yawNoise: number, scale: number): void {
		if (pool.count >= pool.limit) return
		const i = pool.count++
		const o = i * 16, m = pool.transforms
		const c = Math.cos(yawNoise * Math.PI * 2) * scale, s = Math.sin(yawNoise * Math.PI * 2) * scale
		m[o] = c; m[o + 1] = 0; m[o + 2] = -s; m[o + 3] = 0
		m[o + 4] = 0; m[o + 5] = scale; m[o + 6] = 0; m[o + 7] = 0
		m[o + 8] = s; m[o + 9] = 0; m[o + 10] = c; m[o + 11] = 0
		m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1
	}

	dispose(): void {
		this.grass.count = 0
		if (this.shrub) this.shrub.count = 0
		for (const pool of this.props) pool.count = 0
	}

	/** Placement readback for gates and diagnostics: 16 floats per tuft, `instanceTotal` live. */
	get instances(): Float32Array { return (this.usedWind && this.wind.mesh ? this.wind : this.grass).transforms }
	get instanceTotal(): number { return (this.usedWind && this.wind.mesh ? this.wind : this.grass).count }
	get shrubTotal(): number { return this.shrub?.count ?? 0 }
}
