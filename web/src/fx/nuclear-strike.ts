// STEELSEED — fx/nuclear-strike (vfx.md Epic 7 and §14; Ultra and Ultra+ only)
//
// What a nuclear detonation owes the eye beyond its mushroom. fx/mushroom-cloud draws the core
// flash, the fireball, the column and the cap on every preset; this adds, on Ultra and Ultra+,
// the stages §14 lists that a column cannot carry:
//
//   0.00-0.80 s  the scene flash: one pooled light, up in 50 ms and down over the weapon's own
//                FlashEffect duration (20 ticks). Overlapping strikes share one intensity cap,
//                so two detonations do not white out the screen.
//   0.00 s       the ground disturbance under ground zero.
//   0.00-0.80 s  the blast-dust front. It reaches each of the weapon's damage rings at the tick
//                that ring's warhead lands (Atomic: Spread 1c0..5c0 at Delay 0, 5, 10, 15, 20;
//                the MiniNuke stops at 4c0), so the front on screen is the damage timing. It is
//                jittered in radius and angle so it never reads as a crisp range circle.
//   0.80 s       the scorch over the burnt ground (the rules leave Scorch smudges out to the
//                last ring), overlapping soft marks that follow the terrain, kept for 45 s.
//   1-12 s       embers glowing in the scorch.
//   5.5-37 s     cooling smoke drifting off ground zero after the column has gone.
//   0.00-6.0 s   Ultra+ only: a restrained heat shimmer over the fireball that rises with the
//                column and fades out (render/heat bends the scene read in the post pass).
//
// Over water (the struck cell's surface byte): a spray dome and steam instead of dust, a foam
// ring instead of the dust front, steam instead of smoke, and no scorch or embers.
//
// Cosmetic only. Nothing here deals damage, marks a range, or lingers as radiation (§14: "a
// lingering cloud causes no new damage"; "do not invent persistent radiation").
//
// No Math.random and no per-frame allocation: every offset hashes the strike's event seed, so
// a replay draws the same strike, and strikes live in fixed parallel arrays with cursors.

import type { ShroudApi } from './types'

/** A nuclear weapon's own facts, from its warheads (mods/ra/weapons). */
export interface NuclearProfile {
	/** Damage rings the dust front walks, one per 1c0 of Spread (Atomic 5, MiniNuke 4). */
	readonly rings: number
	/** Ticks between two rings' warheads (their `Delay` steps). */
	readonly ringDelayTicks: number
	/** The FlashEffect warhead's `Duration`, in ticks. */
	readonly flashTicks: number
	/** Seconds the scorch and the cooling smoke outlast the detonation (cosmetic, 20-60 s). */
	readonly aftermathS: number
}

/** superweapons.yaml `Atomic`: SpreadDamage 1c0..5c0 at Delay 0..20, FlashEffect Duration 20. */
export const ATOMIC: NuclearProfile = Object.freeze({ rings: 5, ringDelayTicks: 5, flashTicks: 20, aftermathS: 45 })
/** explosions.yaml `MiniNuke` (the Demo Truck): the same steps, stopping at 4c0. */
export const MINI_NUKE: NuclearProfile = Object.freeze({ rings: 4, ringDelayTicks: 5, flashTicks: 20, aftermathS: 32 })

export function nuclearProfileFor(weapon: string): NuclearProfile | null {
	const name = weapon.toLowerCase()
	return name === 'atomic' ? ATOMIC : name === 'mininuke' ? MINI_NUKE : null
}

export interface NuclearParticleSink {
	spawn(name: string, x: number, y: number, z: number, time: number, seed: number, scale: number, shroud: ShroudApi,
		countScale?: number, dirX?: number, dirY?: number, dirZ?: number, spread?: number): void
}
export interface NuclearLightSink {
	addLight(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, radius: number): void
	addHeatSource?(x: number, y: number, z: number, radiusM: number, strengthPx: number): void
}
export interface NuclearScorchSink {
	stamp(x: number, z: number, sizeM: number, seed: number, time: number, shroud: ShroudApi, lifeS?: number, strong?: boolean): void
}

/** Concurrent strikes. A fourth is refused and counted; its mushroom still draws. */
export const MAX_STRIKES = 3
const TICK_S = 1 / 25
/**
 * The flash peak, shared by every strike alive: a building's death light peaks near 1.8 over
 * 7 m, so a detonation reads as the brightest thing in the game without flooding the frame.
 */
export const FLASH_PEAK = 5
const FLASH_RISE_S = 0.05
/** Metres of light radius per damage ring (Atomic 20 m). */
const FLASH_RADIUS_PER_RING = 4
const EMBERS = 16, EMBER_FROM_S = 1, EMBER_TO_S = 12
/** The heat shimmer: its life, its peak bend in pixels (restrained), and its rise with the column. */
export const HEAT_S = 6
const HEAT_PX = 3.5, HEAT_FADE_FROM_S = 2.5, HEAT_RISE_MPS = 1.1

/** The shimmer's envelope at `age` seconds: up over 0.3 s, held, then out by HEAT_S. */
export function heatAt(age: number): number {
	if (!(age >= 0) || age >= HEAT_S) return 0
	if (age < 0.3) return age / 0.3
	return age < HEAT_FADE_FROM_S ? 1 : 1 - (age - HEAT_FADE_FROM_S) / (HEAT_S - HEAT_FADE_FROM_S)
}
const COOLING = 22, COOLING_FROM_S = 5.5

function hash(value: number): number {
	let x = value | 0
	x ^= x << 13
	x ^= x >>> 17
	x ^= x << 5
	return ((x >>> 0) % 10007) / 10007
}

/** The flash envelope at `age` seconds: 0..1, up in 50 ms, then down over `durationS`. */
export function flashAt(age: number, durationS: number): number {
	if (!(age >= 0) || age >= durationS) return 0
	if (age < FLASH_RISE_S) return age / FLASH_RISE_S
	return Math.exp(-(age - FLASH_RISE_S) / (durationS * 0.25))
}

export class NuclearStrike {
	private readonly active = new Uint8Array(MAX_STRIKES)
	private readonly profile: (NuclearProfile | null)[] = new Array(MAX_STRIKES).fill(null)
	private readonly born = new Float64Array(MAX_STRIKES)
	private readonly x = new Float32Array(MAX_STRIKES)
	private readonly y = new Float32Array(MAX_STRIKES)
	private readonly z = new Float32Array(MAX_STRIKES)
	private readonly seed = new Int32Array(MAX_STRIKES)
	private readonly water = new Uint8Array(MAX_STRIKES)
	private readonly density = new Float32Array(MAX_STRIKES)
	private readonly ringCursor = new Uint8Array(MAX_STRIKES)
	private readonly emberCursor = new Uint8Array(MAX_STRIKES)
	private readonly coolCursor = new Uint8Array(MAX_STRIKES)
	private readonly ground = new Uint8Array(MAX_STRIKES)
	private readonly scorched = new Uint8Array(MAX_STRIKES)
	private readonly flash = new Float32Array(MAX_STRIKES)
	private readonly heat = new Uint8Array(MAX_STRIKES)
	readonly stats = { started: 0, refused: 0, active: 0, emissions: 0, lightPeak: 0, flashNow: 0, heatNow: 0 }

	clear(): void {
		this.active.fill(0)
		this.profile.fill(null)
		this.stats.active = this.stats.flashNow = this.stats.heatNow = 0
	}

	/**
	 * A detonation OpenRA reported. `y` already carries the drawn ground. Returns false when the
	 * strike was refused (behind the shroud, or every slot busy). `heat` adds the shimmer (Ultra+).
	 */
	strike(x: number, y: number, z: number, time: number, seed: number, profile: NuclearProfile, water: boolean,
		density: number, shroud: ShroudApi, heat = false): boolean {
		if (!Number.isFinite(time) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
		if (!shroud.isVisible(Math.floor(x), Math.floor(z))) return false
		let slot = -1
		for (let i = 0; i < MAX_STRIKES; i++) if (!this.active[i]) { slot = i; break }
		if (slot < 0) { this.stats.refused++; return false }
		this.active[slot] = 1
		this.profile[slot] = profile
		this.born[slot] = time
		this.x[slot] = x; this.y[slot] = y; this.z[slot] = z
		this.seed[slot] = seed | 0
		this.water[slot] = water ? 1 : 0
		this.density[slot] = density
		this.ringCursor[slot] = this.emberCursor[slot] = this.coolCursor[slot] = 0
		this.ground[slot] = this.scorched[slot] = 0
		this.heat[slot] = heat ? 1 : 0
		this.stats.started++
		return true
	}

	tick(time: number, particles: NuclearParticleSink, lights: NuclearLightSink, scorch: NuclearScorchSink | null, shroud: ShroudApi): void {
		let live = 0, total = 0
		for (let slot = 0; slot < MAX_STRIKES; slot++) {
			this.flash[slot] = 0
			if (!this.active[slot]) continue
			const profile = this.profile[slot]!
			const age = time - this.born[slot]
			// A rewound clock (seek, new match) is not a strike from the future.
			if (!(age >= 0) || age >= profile.aftermathS) { this.active[slot] = 0; this.profile[slot] = null; continue }
			live++
			if (!this.ground[slot]) { this.disturb(slot, time, particles, shroud); this.ground[slot] = 1 }
			const ringS = profile.ringDelayTicks * TICK_S
			while (this.ringCursor[slot] < profile.rings && age >= this.ringCursor[slot] * ringS) {
				this.ring(slot, this.ringCursor[slot], time, particles, shroud)
				this.ringCursor[slot]++
			}
			if (!this.scorched[slot] && age >= profile.rings * ringS) {
				if (!this.water[slot] && scorch !== null) this.burn(slot, time, scorch, shroud)
				this.scorched[slot] = 1
			}
			if (!this.water[slot]) {
				const due = age < EMBER_FROM_S ? 0 : Math.min(EMBERS, Math.floor((age - EMBER_FROM_S) / ((EMBER_TO_S - EMBER_FROM_S) / EMBERS)) + 1)
				while (this.emberCursor[slot] < due) this.ember(slot, this.emberCursor[slot]++, time, particles, shroud)
			}
			const coolTo = profile.aftermathS - 8
			const cooled = age < COOLING_FROM_S ? 0 : Math.min(COOLING, Math.floor((age - COOLING_FROM_S) / ((coolTo - COOLING_FROM_S) / COOLING)) + 1)
			while (this.coolCursor[slot] < cooled) this.cool(slot, this.coolCursor[slot]++, time, particles, shroud)
			this.flash[slot] = flashAt(age, profile.flashTicks * TICK_S)
			total += this.flash[slot]
		}
		// One cap for every strike alive: overlapping detonations share the peak.
		const share = total > 1 ? 1 / total : 1
		for (let slot = 0; slot < MAX_STRIKES; slot++) {
			const f = this.flash[slot] * share
			if (f < 0.002) continue
			const rings = this.profile[slot]!.rings
			lights.addLight(this.x[slot], this.y[slot] + rings * 0.6, this.z[slot], 1, 0.86, 0.62, FLASH_PEAK * f, FLASH_RADIUS_PER_RING * rings)
		}
		this.stats.flashNow = FLASH_PEAK * Math.min(1, total)
		if (this.stats.flashNow > this.stats.lightPeak) this.stats.lightPeak = this.stats.flashNow
		this.stats.active = live
		// The shimmer stands where the fireball is seen, rising with the column; never under fog.
		let shimmering = 0
		if (lights.addHeatSource) for (let slot = 0; slot < MAX_STRIKES; slot++) {
			if (!this.active[slot] || !this.heat[slot]) continue
			const age = time - this.born[slot], env = heatAt(age)
			if (env <= 0.01 || !shroud.isVisible(Math.floor(this.x[slot]), Math.floor(this.z[slot]))) continue
			const rings = this.profile[slot]!.rings
			lights.addHeatSource(this.x[slot], this.y[slot] + rings * 0.7 + age * HEAT_RISE_MPS, this.z[slot], rings * (1.5 + age * 0.35), HEAT_PX * env)
			shimmering++
		}
		this.stats.heatNow = shimmering
	}

	private seedOf(slot: number, stage: number, index: number): number {
		return (this.seed[slot] * 31 + stage * 7919 + index * 104729) | 0
	}

	/** Under ground zero at detonation: dust thrown outward, or over water a spray dome and steam. */
	private disturb(slot: number, time: number, particles: NuclearParticleSink, shroud: ShroudApi): void {
		const x = this.x[slot], y = this.y[slot], z = this.z[slot], d = this.density[slot]
		if (this.water[slot]) {
			particles.spawn('splashcolumn', x, y, z, time, this.seedOf(slot, 1, 0), 4, shroud, 2 * d, 0, 1, 0, 0.5)
			for (let i = 0; i < 4; i++) {
				const a = (i + hash(this.seedOf(slot, 1, i + 1))) * Math.PI / 2
				particles.spawn('steam', x + Math.cos(a) * 0.6, y + 0.3, z + Math.sin(a) * 0.6, time, this.seedOf(slot, 1, i + 9), 2.2, shroud, d)
			}
			this.stats.emissions += 5
			return
		}
		for (let i = 0; i < 12; i++) {
			const a = (i + hash(this.seedOf(slot, 1, i))) * Math.PI / 6
			const c = Math.cos(a), s = Math.sin(a)
			particles.spawn('dustfront', x + c * 0.4, y + 0.05, z + s * 0.4, time, this.seedOf(slot, 1, i + 20), 1.6, shroud, d, c, 0.2, s, 0.6)
		}
		this.stats.emissions += 12
	}

	/** Ring `k` of the front, at its warhead's damage radius (k+1)c0, jittered so it is no circle. */
	private ring(slot: number, k: number, time: number, particles: NuclearParticleSink, shroud: ShroudApi): void {
		const x = this.x[slot], y = this.y[slot], z = this.z[slot], d = this.density[slot]
		const count = 8 + 4 * k
		const radius = k + 1
		const preset = this.water[slot] ? 'foam' : 'dustfront'
		for (let i = 0; i < count; i++) {
			const h = this.seedOf(slot, 2 + k, i)
			const a = (i + 0.8 * hash(h)) * Math.PI * 2 / count
			const r = radius * (0.85 + 0.27 * hash(h + 1013904223))
			const c = Math.cos(a), s = Math.sin(a)
			particles.spawn(preset, x + c * r, y + 0.05, z + s * r, time, h, 1.8 + 0.3 * k, shroud, d, c, this.water[slot] ? 0 : 0.12, s, 0.7)
		}
		this.stats.emissions += count
	}

	/** Overlapping soft scorch marks out to the last ring; each one follows the terrain under it. */
	private burn(slot: number, time: number, scorch: NuclearScorchSink, shroud: ShroudApi): void {
		const profile = this.profile[slot]!
		const x = this.x[slot], z = this.z[slot], R = profile.rings, life = profile.aftermathS
		scorch.stamp(x, z, 0.5 * R, this.seedOf(slot, 9, 0), time, shroud, life, true)
		for (let i = 0; i < 6; i++) {
			const a = (i + 0.5 * hash(this.seedOf(slot, 9, i + 1))) * Math.PI / 3
			scorch.stamp(x + Math.cos(a) * 0.45 * R, z + Math.sin(a) * 0.45 * R, 0.4 * R, this.seedOf(slot, 9, i + 11), time, shroud, life, true)
		}
		for (let i = 0; i < 8; i++) {
			const a = (i + 0.5 * hash(this.seedOf(slot, 9, i + 21))) * Math.PI / 4
			scorch.stamp(x + Math.cos(a) * 0.8 * R, z + Math.sin(a) * 0.8 * R, 0.32 * R, this.seedOf(slot, 9, i + 31), time, shroud, life, true)
		}
		this.stats.emissions += 15
	}

	private ember(slot: number, index: number, time: number, particles: NuclearParticleSink, shroud: ShroudApi): void {
		const h = this.seedOf(slot, 10, index)
		const a = hash(h) * Math.PI * 2, r = 0.75 * this.profile[slot]!.rings * Math.sqrt(hash(h + 17))
		particles.spawn('nukeember', this.x[slot] + Math.cos(a) * r, this.y[slot] + 0.05, this.z[slot] + Math.sin(a) * r, time, h, 1, shroud, this.density[slot])
		this.stats.emissions++
	}

	private cool(slot: number, index: number, time: number, particles: NuclearParticleSink, shroud: ShroudApi): void {
		const h = this.seedOf(slot, 11, index)
		const a = hash(h) * Math.PI * 2, r = 0.35 * this.profile[slot]!.rings * Math.sqrt(hash(h + 17))
		particles.spawn(this.water[slot] ? 'steam' : 'coolsmoke', this.x[slot] + Math.cos(a) * r, this.y[slot] + 0.3, this.z[slot] + Math.sin(a) * r,
			time, h, 2.2, shroud, this.density[slot])
		this.stats.emissions++
	}
}
