// Instanced Blender scenery. The engine owns resource amounts and terrain; this owns appearance.
import { fetchAssetPack } from '../core/asset-pack'
import { HeaderFlag, type Ctx, type Snapshot } from '../core'
import { decodeBlenderAsset, type BlenderAsset } from './blender-mesh'
import { hash, scanScenery, type ScanCounts, type ScanRequest } from './scenery-scan'
import type { DrawItem, RenderApi, TerrainApi, SkyApi, ShroudApi, MaterialsApi } from './types'
interface EnvironmentAsset extends BlenderAsset { readonly sourceSha256?: string; readonly meadowParentSha256?: string }
interface Manifest { readonly schema: number; readonly bytes: number; readonly storedBytes: number; readonly sha256: string; readonly assets: Readonly<Record<string, EnvironmentAsset>> }
interface Pool {
	readonly item: DrawItem; readonly transforms: Float32Array; count: number
	/** Candidates the previous frame's scan offered, whether or not they fitted. Sizes `reach`. */
	seen: number
	/** Squared distance from the camera inside which this pool spends its budget. */
	reach: number
}
const manifests = import.meta.glob<Manifest>('../../.forge/environment/props.json', { eager: true, import: 'default' })
const packs = import.meta.glob<string>('../../.forge/environment/props.ssasset.gz', { eager: true, query: '?url', import: 'default' })
const LIMIT = 640
/** Rain and snow slots: above the heaviest field (a storm's 1100 drops), so intensity scales it. */
const WEATHER_LIMIT = 1200
const GRASS_LIMIT = 1536
interface ScanReply extends ScanCounts {
	ticket: number
	grass: Float32Array
	ore: Float32Array
	gems: Float32Array
}
export class EnvironmentScenery {
	private readonly pools = new Map<string, Pool>()
	private ground: { w: number; h: number; surface: Uint8Array; resource: Uint8Array } | null = null
	private originX = 0
	private originZ = 0
	private grassLimit = GRASS_LIMIT
	private grassPerCell = 1
	private grassRadius = 20
	private cardGrass = false
	private cameraX = 0
	private cameraZ = 0
	/** Last scan's camera cell, snapshot tick and wall time: the scan-cadence gate. */
	private lastScanX = NaN
	private lastScanZ = NaN
	private lastScanTick = -1
	private lastScanAtMs = 0
	private placed = false
	private worker: Worker | null = null
	private workerBroken = false
	private workerBusy = false
	private scanTicket = 0
	private incoming: ScanReply | null = null
	/** Terrain grids already live in the worker. A new world clears this. */
	private terrainSent = false
	private readonly occluders = new Float32Array(2048 * 4)
	/** Linear radiance the falling flakes are drawn with; follows the sky every frame. */
	private readonly flakeColor = new Float32Array(3)
	private occluderCount = 0
	/** Scorch marks near the camera, refreshed for each scan (fx `burnMarks`). */
	private readonly burns = new Float32Array(128 * 4)
	beginOccluders(): void { this.occluderCount = 0 }
	addOccluder(minX:number,minZ:number,maxX:number,maxZ:number): void {
		if(this.occluderCount>=2048)return
		const o=this.occluderCount++*4
		this.occluders[o]=minX-.3;this.occluders[o+1]=minZ-.3;this.occluders[o+2]=maxX+.3;this.occluders[o+3]=maxZ+.3
	}
	private occluded(x:number,z:number): boolean {
		for(let i=0;i<this.occluderCount*4;i+=4)
			if(x>=this.occluders[i]&&z>=this.occluders[i+1]&&x<=this.occluders[i+2]&&z<=this.occluders[i+3])return true
		return false
	}
	readonly stats = { loaded: 0, grass: 0, ore: 0, gems: 0, rain: 0, snow: 0, error: '' }
	async init(render: RenderApi, ctx: Ctx): Promise<void> {
		if (new URLSearchParams(location.search).get('noenvironment') === '1') return
		const manifest = Object.values(manifests)[0], url = Object.values(packs)[0]
		if (!manifest && !url) return
		try {
			if (!manifest || !url || manifest.schema !== 1 || ['ore', 'gems', 'grass', 'rain', 'snow'].some(id => !manifest.assets[id])) throw new Error('Incomplete Blender scenery pack')
			const bytes = await fetchAssetPack(url, manifest)
			const materials = ctx.get<MaterialsApi>('materials')
			this.cardGrass = manifest.assets.grass.alphaCutout === true && materials.has('meadow-v1')
			if (this.cardGrass) {
				const tier = ctx.config.q.name
				this.grassLimit = tier === 'low' ? 8000 : tier === 'medium' ? 24000 : tier === 'high' ? 64000 : 120000
				// Half-sized authored clumps allow more fine-scale variation within the
				// same fixed tier allocation, instead of person-height isolated blade fans.
				this.grassPerCell = tier === 'low' ? 4 : tier === 'medium' ? 8 : tier === 'high' ? 16 : 24
				this.grassRadius = tier === 'low' ? 20 : tier === 'medium' ? 25 : tier === 'high' ? 28 : 32
			}
			let grassLevels: ReturnType<typeof decodeBlenderAsset>['mesh'][] | null = null
			// Decode the complete dependent chain before allocating any prop GPU resources.
			if (this.cardGrass) {
					const parent = manifest.assets.grass
					if (!parent.sourceSha256 || !/^[a-f0-9]{64}$/.test(parent.sourceSha256)) throw new Error('Missing meadow source binding')
					const decoded = decodeBlenderAsset(bytes, parent)
					if (decoded.rig) throw new Error('Meadow must use rooted instance motion')
					grassLevels = [decoded.mesh]
					for (const name of ['grass-lod1', 'grass-lod2']) {
						const asset = manifest.assets[name]
						if (!asset || asset.meadowParentSha256 !== parent.sourceSha256 || asset.materialSet !== parent.materialSet ||
							asset.alphaCutout !== true || JSON.stringify(asset.materialTable) !== JSON.stringify(parent.materialTable))
							throw new Error('Missing or mismatched whole-card meadow LOD: ' + name)
						const level = decodeBlenderAsset(bytes, asset)
						if (level.rig) throw new Error('Meadow LOD must use the same rooted instance motion')
						grassLevels.push(level.mesh)
					}
			}
			// Precipitation first: items pack into the renderer's shared instance buffer in
			// submission order, and Ultra's meadow alone can ask for more than it holds.
			for (const id of ['rain', 'snow', 'ore', 'gems', 'grass']) {
				const source = id === 'grass' && grassLevels ? grassLevels[0] : decodeBlenderAsset(bytes, manifest.assets[id]).mesh
				const authored = manifest.assets[id].materialSet
				const surfaceSet = authored && materials.has(authored) ? authored : 'blender'
				if (authored && surfaceSet === 'blender') console.warn(`[scenery] ${id}: missing ${authored}; palette fallback`)
				const mesh = id === 'grass' && grassLevels ? render.uploadLods(grassLevels, 'blender.environment.grass')
					: render.upload(source, `blender.environment.${id}`)
				const transforms = new Float32Array((id === 'grass' ? this.grassLimit
					: id === 'rain' || id === 'snow' ? WEATHER_LIMIT : LIMIT) * 16)
				const pool: Pool = { transforms, count: 0, seen: 0, reach: Infinity, item: { mesh, surfaceSet, instances: transforms,
					alphaCutout: surfaceSet === authored && manifest.assets[id].alphaCutout === true,
					get instanceCount() { return pool.count }, playerColors: null, castsShadow: id === 'ore' || id === 'gems',
					opacity: id === 'rain' ? .7 : id === 'snow' ? .88 : 1, reactive: id === 'rain' || id === 'snow',
					unlitColor: id === 'snow' ? this.flakeColor : null } }
				this.pools.set(id, pool)
			}
			this.stats.loaded = this.pools.size
		} catch (error) { this.stats.error = String(error); console.warn('[scenery] Blender props unavailable:', error) }
	}
	onSnapshot(snapshot: Snapshot): void {
		if ((snapshot.flags & HeaderFlag.terrainStaticPresent) !== 0 && snapshot.terrainStatic) {
			// Snapshot planes are borrowed and the bridge reuses their backing buffer.
			const view = snapshot.terrainStatic
			this.ground = { w: view.w, h: view.h, surface: view.surface.slice(), resource: view.resource.slice() }
			this.originX = snapshot.world?.boundsLeft ?? 0; this.originZ = snapshot.world?.boundsTop ?? 0
			this.terrainSent = false
		}
	}
	update(ctx: Ctx, render: RenderApi, terrain: TerrainApi, sky: SkyApi, shroud: ShroudApi, defer = false): void {
		const ground = this.ground
		if (!ground || !this.pools.size) return
		const env = sky.environment, time = env.motionTime ?? 0, wind = env.windStrength ?? 0
		const camera = render.camera, m = camera.view, height = camera.position[1]
		const cx = camera.position[0] - height * m[2] / Math.max(.15, m[6])
		const cz = camera.position[2] - height * m[10] / Math.max(.15, m[6])
		const radius = Math.min(38, Math.max(12, height * 1.3))
		// SCAN CADENCE: the placement scan is the single most expensive per-frame pass
		// in the presentation - under a live four-player war the CDP profile attributes
		// nearly half of ALL main-thread JS to scan()+occluded(). Its OUTPUT only changes
		// when the camera window moved a cell, an actor changed what it occludes, or the
		// ground's ore/shroud did. Ticks alone change none of those every 100 ms, so the
		// live-world rescan now waits for BOTH ~250 ms of wall time AND ~6 ticks of
		// simulation progress: ore and building occupancy surface within half a second,
		// at a quarter of the previous cost. Camera motion still requests a rescan
		// immediately. A live match runs that scan on a worker and keeps the previous
		// field on screen until the worker returns, so the frame does not stop for it.
		this.cameraX = cx
		this.cameraZ = cz
		const tick = ctx.snapshot?.tick ?? -1
		const now = performance.now()
		const scanDue = !Number.isFinite(this.lastScanX)
			|| Math.abs(cx - this.lastScanX) >= 1 || Math.abs(cz - this.lastScanZ) >= 1
			|| (tick - this.lastScanTick >= 6 && now - this.lastScanAtMs >= 250)
		this.applyIncoming()
		if (scanDue) {
			const posted = defer && this.placed && this.postScan(ctx, terrain, shroud, ground, env, time, wind, cx, cz, radius)
			if (posted) {
				this.lastScanX = cx
				this.lastScanZ = cz
				this.lastScanTick = tick
				this.lastScanAtMs = now
			} else if (!this.workerBusy) {
				this.lastScanX = cx
				this.lastScanZ = cz
				this.lastScanTick = tick
				this.lastScanAtMs = now
				this.scan(ctx, terrain, shroud, ground, env, time, wind, cx, cz, radius)
				this.placed = true
			}
		}
		// Weather is placed every frame, so its budget is sized every frame from the
		// previous frame's candidates. Retargeting on the scan cadence let `seen` sum
		// 15-60+ frames, which shrank the field to a few metres around the screen centre.
		this.retargetWeather(radius)
		const rain = env.rainIntensity ?? 0, snow = env.snowIntensity ?? 0
		if (ctx.config.extras.weatherFx && (rain > .02 || snow > .02)) {
			// Fall animation is baked from time, so weather keeps its per-frame cadence
			// and resets its own pool outside the scan gate.
			const pool = this.pools.get(snow > rain ? 'snow' : 'rain')!, severity = Math.max(rain, snow)
			// Switching precipitation types must stop the previous one on the same
			// frame, or the last rainy frame freezes on screen under the snow.
			this.pools.get(snow > rain ? 'rain' : 'snow')!.count = 0
			const speed = snow > rain ? .16 : .92
			const count = Math.floor((snow > rain ? 700 : 1100) * severity)
			// The authored flake is ~2.6 cm across: at a fixed 2.8 it was 1-2 px from the RTS
			// camera. Sized with the camera instead, a flake reads at a few pixels at every zoom,
			// and snow never falls between a low camera and the ground it looks at.
			const flake = snow > rain ? Math.min(8, Math.max(1.5, height * .2)) : 2.2
			const fall = snow > rain ? Math.min(9, height * .6) : 9
			if (snow > rain) {
				// A flake is lit from every side at once, so shading it like a solid prop left it
				// grey against the snow it falls onto. Draw it as a white surface under the whole
				// sky plus part of the sun, a little brighter than settled snow; it dims with the
				// light at night like everything else.
				const sun = env.sunColor, sky = env.skyColor, sunI = env.sunIntensity * .16, amb = env.ambientScale
				for (let c = 0; c < 3; c++) this.flakeColor[c] = 1.6 * .9 * (sun[c] * sunI + sky[c] * amb)
			}
			pool.count = 0
			for (let i = 0; i < count; i++) {
				const gx = Math.floor(cx / 4) * 4, gz = Math.floor(cz / 4) * 4
				const sx = hash(i + 147, 28), sz = hash(723, i + 35)
				const x = gx + (sx - .5) * radius * 1.5, z = gz + (sz - .5) * radius * 1.5
				if (!shroud.isVisible(Math.floor(x), Math.floor(z))) continue
				const phase = ((hash(i, 135) - time * speed) % 1 + 1) % 1
				const y = (terrain.waterHeightAt(x, z) ?? terrain.heightAt(x, z)) + phase * fall + .03
				this.place(pool, x + Math.sin(time + i) * .06 * snow, y, z, flake, 0,
					(env.windX ?? 0) * wind * (snow > rain ? .4 : .7), (env.windZ ?? 1) * wind * (snow > rain ? .4 : .7))
			}
		} else if (ctx.config.extras.weatherFx) {
			// Weather ended: both precipitation pools must empty on the same per-frame
			// cadence that fills them, or the last rainy frame freezes on screen.
			this.pools.get('rain')!.count = 0
			this.pools.get('snow')!.count = 0
		}
		for (const [id, pool] of this.pools) {
			this.stats[id as 'grass' | 'ore' | 'gems' | 'rain' | 'snow'] = pool.count
			if (pool.count) render.submit(pool.item)
		}
	}

	private retargetWeather(radius: number): void {
		for (const id of ['rain', 'snow'] as const) {
			const pool = this.pools.get(id)
			if (!pool) continue
			const budget = pool.transforms.length / 16
			const fits = pool.seen <= budget ? 1 : budget / pool.seen
			pool.reach = fits >= 1 ? Infinity : radius * radius * fits
			pool.count = 0
			pool.seen = 0
		}
	}

	private applyCounts(kind: 'grass' | 'ore' | 'gems', src: Float32Array, count: number, seen: number): void {
		const pool = this.pools.get(kind)
		if (!pool) return
		const n = Math.min(count, pool.transforms.length / 16)
		pool.transforms.set(src.subarray(0, n * 16))
		pool.count = n
		pool.seen = seen
	}

	private applyIncoming(): void {
		const reply = this.incoming
		if (!reply) return
		this.incoming = null
		if (reply.ticket !== this.scanTicket) return
		this.applyCounts('grass', reply.grass, reply.grassCount, reply.grassSeen)
		this.applyCounts('ore', reply.ore, reply.oreCount, reply.oreSeen)
		this.applyCounts('gems', reply.gems, reply.gemsCount, reply.gemsSeen)
		this.placed = true
		this.workerBusy = false
	}

	private ensureWorker(): Worker | null {
		if (this.worker || this.workerBroken) return this.worker
		if (typeof Worker === 'undefined') return null
		try {
			const worker = new Worker(new URL('./scenery-scan.worker.ts', import.meta.url), { type: 'module' })
			worker.onmessage = (event: MessageEvent<ScanReply>) => {
				this.incoming = event.data
				this.workerBusy = false
			}
			worker.onerror = () => {
				this.workerBroken = true
				this.workerBusy = false
				this.terrainSent = false
				this.lastScanX = NaN
				worker.terminate()
				this.worker = null
			}
			this.worker = worker
			return worker
		} catch {
			this.workerBroken = true
			return null
		}
	}

	private postScan(ctx: Ctx, terrain: TerrainApi, shroud: ShroudApi, ground: NonNullable<EnvironmentScenery['ground']>,
		env: SkyApi['environment'], time: number, wind: number, cx: number, cz: number, radius: number): boolean {
		if (this.workerBusy) return false
		const worker = this.ensureWorker()
		const req = this.scanRequest(ctx, terrain, shroud, ground, env, time, wind, cx, cz, radius)
		const grass = this.pools.get('grass'), ore = this.pools.get('ore'), gems = this.pools.get('gems')
		if (!worker || !req || !grass || !ore || !gems) return false
		this.scanTicket++
		this.workerBusy = true
		const payload: ScanRequest & { ticket: number; grassCap: number; oreCap: number; gemsCap: number } = {
			...req,
			ticket: this.scanTicket,
			grassCap: grass.transforms.length / 16,
			oreCap: ore.transforms.length / 16,
			gemsCap: gems.transforms.length / 16,
		}
		if (this.terrainSent) {
			// Keep the shroud, the live ore and the bridge list. Drop the static grids.
			payload.height = new Uint8Array(0)
			payload.ramp = new Uint8Array(0)
			payload.metres = new Float32Array(0)
			payload.cornerY = new Float32Array(0)
			payload.waterLevel = new Float32Array(0)
			payload.surface = new Uint8Array(0)
			payload.resource = new Uint8Array(0)
		}
		worker.postMessage(payload)
		this.terrainSent = true
		return true
	}

	private scanRequest(ctx: Ctx, terrain: TerrainApi, shroud: ShroudApi, ground: NonNullable<EnvironmentScenery['ground']>,
		env: SkyApi['environment'], time: number, wind: number, cx: number, cz: number, radius: number): ScanRequest | null {
		const pack = terrain.reliefPack?.()
		const grid = shroud.grid?.()
		const grass = this.pools.get('grass'), ore = this.pools.get('ore'), gems = this.pools.get('gems')
		if (!pack || !grid || !grass || !ore || !gems) return null
		const resource = ctx.snapshot?.resources
		const live = resource && resource.w === ground.w && resource.h === ground.h ? resource : null
		// peek, not get: fx depends on units, and a gate may run the scan with no fx at all.
		const fx = ctx.peek?.<{ burnMarks?(cx: number, cz: number, reach: number, out: Float32Array): number }>('fx')
		const burnCount = fx?.burnMarks?.(cx, cz, radius, this.burns) ?? 0
		return {
			w: ground.w, h: ground.h, originX: this.originX, originZ: this.originZ,
			surface: ground.surface, resource: ground.resource,
			liveType: live ? live.type : null,
			liveDensity: live ? live.density : null,
			liveMax: live ? live.maxDensity : null,
			fieldW: pack.w, fieldH: pack.h, fieldOriginX: pack.originX, fieldOriginY: pack.originY,
			presentationRelief: pack.presentationRelief,
			height: pack.height, ramp: pack.ramp, metres: pack.metres,
			cornerY: pack.cornerY, waterLevel: pack.waterLevel, bridges: pack.bridges,
			shroud: grid.cells, shroudW: grid.width, shroudH: grid.height,
			shroudOriginX: grid.originX, shroudOriginY: grid.originY, shroudSeen: grid.seen,
			occluders: this.occluders, occluderCount: this.occluderCount,
			cx, cz, radius, wind, windX: env.windX ?? .8, windZ: env.windZ ?? .5, time, snowCover: env.snowCoverage ?? 0,
			burns: this.burns, burnCount,
			cardGrass: this.cardGrass, grassPerCell: this.grassPerCell, grassRadius: this.grassRadius,
			grassSeen: grass.seen, oreSeen: ore.seen, gemsSeen: gems.seen,
		}
	}

	private scan(ctx: Ctx, terrain: TerrainApi, shroud: ShroudApi, ground: NonNullable<EnvironmentScenery['ground']>,
		env: SkyApi['environment'], time: number, wind: number, cx: number, cz: number, radius: number): void {
		const req = this.scanRequest(ctx, terrain, shroud, ground, env, time, wind, cx, cz, radius)
		const grass = this.pools.get('grass'), ore = this.pools.get('ore'), gems = this.pools.get('gems')
		if (!req || !grass || !ore || !gems) return
		const counts = scanScenery(req, { grass: grass.transforms, ore: ore.transforms, gems: gems.transforms })
		grass.count = counts.grassCount; grass.seen = counts.grassSeen
		ore.count = counts.oreCount; ore.seen = counts.oreSeen
		gems.count = counts.gemsCount; gems.seen = counts.gemsSeen
	}
	private place(pool: Pool, x: number, y: number, z: number, scale: number, yaw: number, swayX: number, swayZ: number, slopeX=0, slopeZ=0, heightScale=1): void {
		// Counted whether or not it is drawn: `seen` is what sizes next frame's reach, so a
		// candidate rejected for being too far still has to tell the pool it existed. Without
		// that the reach would shrink to fit the survivors and never grow back.
		pool.seen++
		const dx = x - this.cameraX, dz = z - this.cameraZ
		if (dx * dx + dz * dz > pool.reach) return
		if (pool.count >= pool.transforms.length / 16) return
		const o = pool.count++ * 16, m = pool.transforms, c = Math.cos(yaw) * scale, s = Math.sin(yaw) * scale
		m[o] = c; m[o + 1] = c*slopeX-s*slopeZ; m[o + 2] = -s; m[o + 3] = 0
		m[o + 4] = swayX * heightScale; m[o + 5] = scale * heightScale; m[o + 6] = swayZ * heightScale; m[o + 7] = 0
		m[o + 8] = s; m[o + 9] = s*slopeX+c*slopeZ; m[o + 10] = c; m[o + 11] = 0
		m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1
	}
	/**
	 * Mean drawn position of one pool, minus the camera, in metres — the measurement that tells
	 * the two spending policies apart.
	 *
	 * Under raster-order eviction the survivors clustered at the LOW CORNER of the scan window,
	 * so this offset was large and jumped as the window's origin moved with the camera; that jump
	 * is what the eye reads as flicker. Spending by distance puts the drawn set around the
	 * viewer, so it sits near zero and moves smoothly. Computed on demand for a gate, never per
	 * frame.
	 */
	drawnOffsetOf(id: string): { count: number; offsetX: number; offsetZ: number; offset: number } | null {
		const pool = this.pools.get(id)
		if (!pool || pool.count === 0) return null
		let sx = 0, sz = 0
		for (let i = 0; i < pool.count; i++) { sx += pool.transforms[i * 16 + 12]; sz += pool.transforms[i * 16 + 14] }
		const offsetX = sx / pool.count - this.cameraX, offsetZ = sz / pool.count - this.cameraZ
		return { count: pool.count, offsetX, offsetZ, offset: Math.hypot(offsetX, offsetZ) }
	}
	/** Instances of one pool drawn within `r` metres of (x, z): the witness that scorched ground burnt its grass. */
	countNear(id: string, x: number, z: number, r: number): number {
		const pool = this.pools.get(id)
		if (!pool) return 0
		let n = 0
		for (let i = 0; i < pool.count; i++) {
			const dx = pool.transforms[i * 16 + 12] - x, dz = pool.transforms[i * 16 + 14] - z
			if (dx * dx + dz * dz < r * r) n++
		}
		return n
	}
	dispose(): void {
		this.worker?.terminate()
		this.worker = null
		this.pools.clear()
		this.ground = null
	}
}
