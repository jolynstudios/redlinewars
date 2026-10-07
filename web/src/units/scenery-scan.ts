// Pure meadow / ore placement. The main thread and a worker both run this, so a camera
// pan does not have to finish the scan inside the frame that noticed the pan.
import { bridgeSupportHeight, type BridgeLandmark } from '../terrain/bridge-contract'
import { Surface } from '../core/surface'
import { meadowSample } from './meadow-distribution'

const GRASS_LIMIT = 1536

export function hash(x: number, z: number): number {
	let h = Math.imul(x ^ 0x5bd1e995, 0x27d4eb2d) ^ Math.imul(z, 0x85ebca6b)
	h ^= h >>> 15
	return (h >>> 0) / 4294967296
}

export interface ScanRequest {
	w: number
	h: number
	originX: number
	originZ: number
	surface: Uint8Array
	resource: Uint8Array
	liveType: Uint8Array | null
	liveDensity: Uint8Array | null
	liveMax: Uint8Array | null
	fieldW: number
	fieldH: number
	fieldOriginX: number
	fieldOriginY: number
	presentationRelief: boolean
	height: Uint8Array
	ramp: Uint8Array
	metres: Float32Array
	cornerY: Float32Array
	waterLevel: Float32Array
	bridges: readonly BridgeLandmark[]
	shroud: Uint8Array
	shroudW: number
	shroudH: number
	shroudOriginX: number
	shroudOriginY: number
	shroudSeen: boolean
	occluders: Float32Array
	occluderCount: number
	cx: number
	cz: number
	radius: number
	wind: number
	windX: number
	windZ: number
	time: number
	/** Settled snow cover, 0..1: snow buries the meadow, so grass shortens and then goes. */
	snowCover: number
	/**
	 * Scorched ground (fx/impact-scorch), as (x, z, radius, strength) quads: grass under a fresh
	 * mark burns away and grows back as the mark fades. Empty on every tier without scorch.
	 */
	burns?: Float32Array
	burnCount?: number
	cardGrass: boolean
	grassPerCell: number
	grassRadius: number
	grassSeen: number
	oreSeen: number
	gemsSeen: number
}

export interface ScanCounts {
	grassCount: number
	grassSeen: number
	oreCount: number
	oreSeen: number
	gemsCount: number
	gemsSeen: number
}

export interface ScanBuffers {
	grass: Float32Array
	ore: Float32Array
	gems: Float32Array
}

function clamp(v: number, n: number): number {
	return v < 0 ? 0 : v >= n ? n - 1 : v
}

function metresAt(req: ScanRequest, cell: number): number {
	return req.metres.length === req.height.length ? req.metres[cell] : 0
}

function connected(req: ScanRequest, a: number, b: number): boolean {
	if (req.presentationRelief) return true
	if (req.height[a] === req.height[b]) return true
	return req.ramp[a] !== 0 || req.ramp[b] !== 0
}

function heightAt(req: ScanRequest, x: number, z: number): number {
	for (let i = 0; i < req.bridges.length; i++) {
		const support = bridgeSupportHeight(req.bridges[i], x, z)
		if (support !== null) return support
	}
	const worldX = x - req.fieldOriginX
	const worldY = z - req.fieldOriginY
	const bx = clamp(Math.floor(worldX), req.fieldW)
	const by = clamp(Math.floor(worldY), req.fieldH)
	if (req.cornerY.length > 0) {
		const u = Math.min(1, Math.max(0, worldX - bx))
		const v = Math.min(1, Math.max(0, worldY - by))
		const stride = req.fieldW + 1
		const o = by * stride + bx
		const h00 = req.cornerY[o]
		const h10 = req.cornerY[o + 1]
		const h01 = req.cornerY[o + stride]
		const h11 = req.cornerY[o + stride + 1]
		return v >= u
			? h00 * (1 - v) + h01 * (v - u) + h11 * u
			: h00 * (1 - u) + h11 * v + h10 * (u - v)
	}
	const base = by * req.fieldW + bx
	const fx = worldX - 0.5
	const fy = worldY - 0.5
	const x0 = Math.floor(fx)
	const y0 = Math.floor(fy)
	const tx = fx - x0
	const ty = fy - y0
	const sample = (cx: number, cy: number) => {
		const j = clamp(cy, req.fieldH) * req.fieldW + clamp(cx, req.fieldW)
		return connected(req, base, j) ? metresAt(req, j) : metresAt(req, base)
	}
	const h00 = sample(x0, y0)
	const h10 = sample(x0 + 1, y0)
	const h01 = sample(x0, y0 + 1)
	const h11 = sample(x0 + 1, y0 + 1)
	return h00 + (h10 - h00) * tx + (h01 + (h11 - h01) * tx - (h00 + (h10 - h00) * tx)) * ty
}

function waterAt(req: ScanRequest, x: number, z: number): number | null {
	if (req.waterLevel.length === 0) return null
	const cx = clamp(Math.floor(x - req.fieldOriginX), req.fieldW)
	const cy = clamp(Math.floor(z - req.fieldOriginY), req.fieldH)
	const level = req.waterLevel[cy * req.fieldW + cx]
	return Number.isFinite(level) ? level : null
}

function shroudAt(req: ScanRequest, wx: number, wz: number): number {
	if (!req.shroudSeen) return 0
	const x = Math.floor(wx) - req.shroudOriginX
	const y = Math.floor(wz) - req.shroudOriginY
	if (x < 0 || y < 0 || x >= req.shroudW || y >= req.shroudH) return 0
	return req.shroud[y * req.shroudW + x]
}

export function scanScenery(req: ScanRequest, into: ScanBuffers): ScanCounts {
	const x0 = Math.max(0, Math.floor(req.cx - req.radius - req.originX))
	const x1 = Math.min(req.w - 1, Math.ceil(req.cx + req.radius - req.originX))
	const z0 = Math.max(0, Math.floor(req.cz - req.radius - req.originZ))
	const z1 = Math.min(req.h - 1, Math.ceil(req.cz + req.radius - req.originZ))
	const reachOf = (seen: number, cap: number) => {
		const fits = seen <= cap ? 1 : cap / seen
		return fits >= 1 ? Infinity : req.radius * req.radius * fits
	}
	const grassCap = into.grass.length / 16
	const oreCap = into.ore.length / 16
	const gemsCap = into.gems.length / 16
	const grassReach = reachOf(req.grassSeen, grassCap)
	const oreReach = reachOf(req.oreSeen, oreCap)
	const gemsReach = reachOf(req.gemsSeen, gemsCap)
	let grassCount = 0, grassSeen = 0, oreCount = 0, oreSeen = 0, gemsCount = 0, gemsSeen = 0
	const occluded = (x: number, z: number) => {
		const n = req.occluderCount * 4
		const o = req.occluders
		for (let i = 0; i < n; i += 4)
			if (x >= o[i] && z >= o[i + 1] && x <= o[i + 2] && z <= o[i + 3]) return true
		return false
	}
	const place = (dest: Float32Array, count: number, cap: number, reach: number, x: number, y: number, z: number, scale: number, yaw: number, swayX = 0, swayZ = 0, slopeX = 0, slopeZ = 0, heightScale = 1) => {
		const dx = x - req.cx, dz = z - req.cz
		if (dx * dx + dz * dz > reach || count >= cap) return count
		const o = count * 16
		const c = Math.cos(yaw) * scale, s = Math.sin(yaw) * scale
		dest[o] = c; dest[o + 1] = c * slopeX - s * slopeZ; dest[o + 2] = -s; dest[o + 3] = 0
		dest[o + 4] = swayX * heightScale; dest[o + 5] = scale * heightScale; dest[o + 6] = swayZ * heightScale; dest[o + 7] = 0
		dest[o + 8] = s; dest[o + 9] = s * slopeX + c * slopeZ; dest[o + 10] = c; dest[o + 11] = 0
		dest[o + 12] = x; dest[o + 13] = y; dest[o + 14] = z; dest[o + 15] = 1
		return count + 1
	}
	const grassDensity = Math.min(.92, GRASS_LIMIT / Math.max(1, (x1 - x0 + 1) * (z1 - z0 + 1) * 1.25))
	const burns = req.burns, burnEnd = burns ? Math.min(req.burnCount ?? 0, burns.length >> 2) * 4 : 0
	/** Does any mark reach this cell? Only those cells pay for the per-blade test. */
	const scorched = (x: number, z: number): boolean => {
		for (let i = 0; i < burnEnd; i += 4) {
			const dx = x - burns![i], dz = z - burns![i + 1], r = burns![i + 2] + .75
			if (dx * dx + dz * dz < r * r) return true
		}
		return false
	}
	/** 0 untouched .. 1 burnt to nothing: full inside 55% of a mark's radius, soft to its rim. */
	const burntAt = (x: number, z: number): number => {
		let burnt = 0
		for (let i = 0; i < burnEnd; i += 4) {
			const dx = x - burns![i], dz = z - burns![i + 1], r = burns![i + 2]
			const d2 = dx * dx + dz * dz
			if (d2 >= r * r) continue
			const t = Math.sqrt(d2) / r, edge = t < .55 ? 1 : 1 - (t - .55) / .45
			const b = burns![i + 3] * edge * edge * (3 - 2 * edge)
			if (b > burnt) burnt = b
		}
		return burnt
	}
	const cardGrass = req.cardGrass
	const grassPerCell = req.grassPerCell
	// Snow buries the meadow. Knee-high cards stood in front of every soldier's legs, and
	// under snow cover they turned white — the legs read as holes onto the snowy ground.
	// Shallow snow shortens the grass to tips; settled snow (~0.55) leaves none standing.
	const buried = Math.min(1, Math.max(0, ((req.snowCover ?? 0) - .15) / .4))
	const standing = 1 - buried * buried * (3 - 2 * buried)
	for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
		const index = z * req.w + x
		const wx = x + req.originX, wz = z + req.originZ
		if (shroudAt(req, wx, wz) === 0) continue
		const seed = hash(wx, wz)
		const type = req.liveType ? req.liveType[index] : req.resource[index]
		const density = req.liveDensity && req.liveMax ? req.liveDensity[index] / Math.max(1, req.liveMax[index]) : 1
		if (type > 0 && density > 0) {
			if (type === 2) {
				gemsSeen++
				gemsCount = place(into.gems, gemsCount, gemsCap, gemsReach, wx + .5, heightAt(req, wx + .5, wz + .5), wz + .5, .45 + Math.sqrt(density) * .55, seed * Math.PI * 2)
			} else {
				oreSeen++
				oreCount = place(into.ore, oreCount, oreCap, oreReach, wx + .5, heightAt(req, wx + .5, wz + .5), wz + .5, .45 + Math.sqrt(density) * .55, seed * Math.PI * 2)
			}
		} else if (req.surface[index] === Surface.grass && (cardGrass || seed > 1 - grassDensity)) {
			if (cardGrass) {
				const ccx = wx + .5, ccz = wz + .5
				const gx = (heightAt(req, ccx + .12, ccz) - heightAt(req, ccx - .12, ccz)) / .24
				const gz = (heightAt(req, ccx, ccz + .12) - heightAt(req, ccx, ccz - .12)) / .24
				const cellScorched = burnEnd > 0 && scorched(ccx, ccz)
				if (standing > .02 && gx * gx + gz * gz <= .5625) {
					const grassPool = into.grass
					const reach = Math.min(req.radius, req.grassRadius)
					const fadeSpan = reach * .3
					const windBX = req.windX
					const windBZ = req.windZ
					const wind = req.wind
					for (let blade = 0; blade < grassPerCell; blade++) {
						const px = wx + meadowSample(wx, wz, blade, 0), pz = wz + meadowSample(wx, wz, blade, 1)
						const ddx = px - req.cx, ddz = pz - req.cz
						const distance = Math.sqrt(ddx * ddx + ddz * ddz)
						if (occluded(px, pz)) continue
						const fade = Math.max(0, Math.min(1, (reach - distance) / fadeSpan))
						if (fade < .015) continue
						if (waterAt(req, px, pz) !== null) continue
						const keep = cellScorched ? 1 - burntAt(px, pz) : 1
						// Stubble under a fifth of its height reads as bare, burnt ground.
						if (keep < .2) continue
						const sway = wind > 0 ? Math.sin(req.time * 1.8 + px * .56 + pz * .77) * .18 * wind : 0
						grassSeen++
						grassCount = place(grassPool, grassCount, grassCap, grassReach, px, heightAt(req, px, pz) - .008, pz,
							.7 + meadowSample(wx, wz, blade, 3) * .5, meadowSample(wx, wz, blade, 2) * Math.PI * 2,
							sway * windBX, sway * windBZ, gx, gz, fade * fade * (3 - 2 * fade) * standing * keep)
					}
				}
				continue
			}
			const px = wx + .2 + seed * .6, pz = wz + .18 + hash(wz, wx) * .64
			const sway = Math.sin(req.time * 1.8 + wx * .56 + wz * .77) * .15 * req.wind
			const slopeX = (heightAt(req, px + .25, pz) - heightAt(req, px - .25, pz)) * 2
			const slopeZ = (heightAt(req, px, pz + .25) - heightAt(req, px, pz - .25)) * 2
			const keep = burnEnd > 0 ? 1 - burntAt(px, pz) : 1
			if (standing * keep > .02 && Math.hypot(slopeX, slopeZ) < .75) {
				grassSeen++
				grassCount = place(into.grass, grassCount, grassCap, grassReach, px, heightAt(req, px, pz) - .008, pz, .8 + seed * .4, seed * Math.PI * 2, sway, sway * .35, slopeX, slopeZ, standing * keep)
			}
		}
	}
	return { grassCount, grassSeen, oreCount, oreSeen, gemsCount, gemsSeen }
}
