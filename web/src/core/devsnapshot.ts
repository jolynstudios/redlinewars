// STEELSEED — core/devsnapshot
//
// Builds a VALID §4 snapshot buffer entirely in JS, from a seed. Not a mock in the
// loose sense: it emits the same binary layout the C# bridge emits, so the decoder,
// terrain, render and every downstream node exercise their real code paths.
//
// Why this exists:
//   1. The web layer is otherwise undevelopable without a running WASM host. The host
//      lives in a separate AppBundle, so `vite preview` has no simulation at all.
//   2. capture.mjs and baseline.mjs need a data source that is fixed and reproducible.
//      A live sim is neither — §10's reproducibility gate cannot be built on one.
//   3. It round-trips the contract: this encoder and core/snapshot.ts's decoder were
//      written from §4 independently, so agreement between them is evidence the spec is
//      unambiguous. Disagreement means §4 is underspecified, which is worth knowing.
//
// It is NEVER used in a real match. main.ts wires it only behind ?devmap=1.

import { ActorFlag, HeaderFlag, SectionId, ShroudState, SNAPSHOT_MAGIC, SNAPSHOT_VERSION } from './snapshot'
import type { SessionStatus, SkirmishCatalog, StartSkirmishConfig } from './ctx'
import { Rng, rootRng } from './rng'
import { Surface } from './surface'

const HEADER_BYTES = 32
const ENTRY_BYTES = 12

/**
 * One height step is 512 WDist = 0.5 m of rise (ARCHITECTURE.md §12.5).
 *
 * 16 steps = 8 m of relief across the map. The first revision used 12 steps AND squared
 * the noise, which biased almost every cell low: measured 0-5 m of range over 96 m with a
 * height stdev of 0.82 m. That is a 3% grade — near-billiard-table — and it made the whole
 * battlefield look unlit, because there were barely any slopes for the sun to act on
 * (`nDotL` mean 0.84, stdev 0.16; `geoNormal` stdev 7.1 against albedo's 15.9). It read as
 * a lighting bug and was diagnosed as one twice. A test fixture with no relief cannot
 * exercise a renderer's shading, so this is a fixture defect, not a tuning preference.
 */
const MAX_HEIGHT_STEPS = 16

export interface DevMapOptions {
	/** Playable bounds in cells. The real bridge derives these from Map.Bounds. */
	width?: number
	height?: number
	/** Cell offset of the grid origin — the real bridge starts at (Bounds.Left, Bounds.Top). */
	originX?: number
	originY?: number
	seed?: string
	actorCount?: number
	/**
	 * Deterministic render-poll rate used by motion capture. When set above the 25 Hz sim
	 * rate, the bridge emits only when the corresponding sim tick advances, leaving honest
	 * null polls between ticks for interpolation. Undefined preserves one tick per pump.
	 */
	renderFps?: number
	/**
	 * Confine actors to a radius in cells around the map centre, instead of scattering
	 * them over the whole playfield.
	 *
	 * This is the difference between the workload §7.1's budget is DEFINED on and the one
	 * every published figure was MEASURED on. Scattered across 96x96, most actors fall
	 * outside the frustum and are culled before they cost anything, so raising
	 * `actorCount` alone measures the sim and the culler rather than the renderer. §10's
	 * workload is a 200-unit *engagement* — concentrated, all of it on screen at once.
	 *
	 * Undefined keeps the historical scatter, so existing captures and baselines are
	 * unaffected.
	 */
	clusterRadius?: number
	/** Fraction of non-water cells carrying resource. Coverage is held whichever mode is used. */
	resourceDensity?: number
	/**
	 * Scatter resource as independent per-cell noise instead of coherent bodies.
	 *
	 * Default false, because independent scatter is not what an ore field looks like and it
	 * is the worst possible input to §12.3b's blend — measured at `seed=demo`, 3% Bernoulli
	 * put 238 of 282 interior resource cells (84.4%) in complete isolation and produced 354
	 * three-way corners, which is the flicker in `t1-terrain-5` and the hexagonal patches a
	 * human reported on sight.
	 *
	 * Kept as an opt-in because that pathological case is genuinely useful for STRESSING the
	 * blend path. Removing it would hide the renderer defect rather than fix it, and
	 * `t1-terrain-5` stays open either way.
	 */
	resourceScatter?: boolean

	// -- §4.2 world, so a fixture can pin the atmosphere ---------------------
	//
	// These were hardcoded here (09:00, clear, wind 256/120) and there was no way to
	// capture a dawn or a night frame without either mutating the live clock or reaching
	// into the sky node's internals. Both would have proved something about a test harness
	// rather than about the game: `sky` reads §4.2 and only §4.2, so the honest fixture
	// is to vary §4.2 and let the real onSnapshot path run untouched.

	/** Minutes past midnight, 0..1439. 06:00 is sunrise, 12:00 noon, 18:00 sunset. */
	timeOfDay?: number
	/** 0 clear, 1 overcast, 2 rain, 3 snow, 4 dust. */
	weatherKind?: number
	/** 0..1000. Severity within the kind; 0 is indistinguishable from clear. */
	weatherIntensity?: number
	/** WAngle, 0..1023 counterclockwise from north, matching OpenRA WVec.Yaw. */
	windDirection?: number
	/** 0..1000. Drives cloud drift. */
	windSpeed?: number
	/**
	 * Dev map only. Marks every cell visible, which is what the lobby does when Fog of War
	 * is turned off (it also uncovers the map). Default keeps the tight reveal disc.
	 */
	revealMap?: boolean
}

/** Clamp to an integer range, tolerating NaN from a malformed URL parameter. */
function clampInt(value: number | undefined, lo: number, hi: number, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback
	return Math.min(hi, Math.max(lo, Math.round(value)))
}

class Writer {
	buf: ArrayBuffer
	view: DataView
	u8: Uint8Array
	pos = 0

	constructor(bytes: number) {
		this.buf = new ArrayBuffer(bytes)
		this.view = new DataView(this.buf)
		this.u8 = new Uint8Array(this.buf)
	}

	align4(): void {
		while (this.pos & 3) this.u8[this.pos++] = 0
	}
	u8w(v: number): void {
		this.u8[this.pos++] = v & 0xff
	}
	u16w(v: number): void {
		this.view.setUint16(this.pos, v & 0xffff, true)
		this.pos += 2
	}
	i16w(v: number): void {
		this.view.setInt16(this.pos, v, true)
		this.pos += 2
	}
	u32w(v: number): void {
		this.view.setUint32(this.pos, v >>> 0, true)
		this.pos += 4
	}
	i32w(v: number): void {
		this.view.setInt32(this.pos, v | 0, true)
		this.pos += 4
	}
}

/**
 * A smooth, seeded scalar field in roughly [-1, 1]. Two octaves is enough: this exists to
 * displace a boundary organically, not to be looked at directly.
 *
 * Deliberately smooth. Anywhere a per-cell random value would straddle a threshold, it
 * produces isolated one-cell islands and the longest possible boundary; a coherent field
 * moves the boundary as a curve instead. Every extra boundary cell is a hard material
 * edge that flickers under TAA jitter, so boundary LENGTH is a cost, not just a look.
 */
function smoothField(w: number, h: number, rng: Rng, freq: number): Float32Array {
	const lw = w + 2
	const lattice = new Float32Array(lw * (h + 2))
	for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next() * 2 - 1

	const at = (cx: number, cy: number): number =>
		lattice[Math.min(h + 1, Math.max(0, cy)) * lw + Math.min(w + 1, Math.max(0, cx))]

	const out = new Float32Array(w * h)
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let sum = 0
			let amp = 1
			let f = freq
			let norm = 0
			for (let o = 0; o < 2; o++) {
				const fx = x * f
				const fy = y * f
				const xi = Math.floor(fx)
				const yi = Math.floor(fy)
				const tx = fx - xi
				const ty = fy - yi
				const sx = tx * tx * (3 - 2 * tx)
				const sy = ty * ty * (3 - 2 * ty)
				const a = at(xi, yi)
				const b = at(xi + 1, yi)
				const c = at(xi, yi + 1)
				const d = at(xi + 1, yi + 1)
				sum += ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy) * amp
				norm += amp
				amp *= 0.45
				f *= 2.3
			}
			out[y * w + x] = sum / norm
		}
	}
	return out
}

/** fbm over a seeded value-noise lattice. Deterministic; no Math.random anywhere. */
function makeHeightField(w: number, h: number, rng: Rng): Uint8Array {
	const lattice = new Float32Array((w + 2) * (h + 2))
	for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next()

	const sample = (x: number, y: number): number => {
		const xi = Math.floor(x)
		const yi = Math.floor(y)
		const tx = x - xi
		const ty = y - yi
		// Smoothstep interpolation — linear interpolation of a value lattice produces
		// visible grid creases along the cell boundaries, which read as terracing.
		const sx = tx * tx * (3 - 2 * tx)
		const sy = ty * ty * (3 - 2 * ty)
		const idx = (cx: number, cy: number) =>
			lattice[Math.min(h + 1, Math.max(0, cy)) * (w + 2) + Math.min(w + 1, Math.max(0, cx))]
		const a = idx(xi, yi)
		const b = idx(xi + 1, yi)
		const c = idx(xi, yi + 1)
		const d = idx(xi + 1, yi + 1)
		return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy
	}

	const out = new Uint8Array(w * h)
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let amp = 1
			// Low base frequency, and the octaves fall off fast. One cell is one metre, so
			// the amplitude-to-wavelength ratio decides directly how many height STEPS
			// separate two neighbouring cells — and any pair differing by 2+ steps is a
			// cliff, not a slope. At 1/12 with 4 equal-ish octaves, most neighbours differed
			// by 2 or more and the whole map rendered as a staircase. At 1/34 an 8 m range
			// spreads over ~17 cells, so neighbours differ by 0 or 1 step almost everywhere
			// and the ground rolls.
			let freq = 1 / 34
			let sum = 0
			let norm = 0
			for (let o = 0; o < 4; o++) {
				sum += sample(x * freq, y * freq) * amp
				norm += amp
				// 0.34, not 0.5: the fine octaves carry the per-cell jitter that turns
				// slopes into steps, so they are damped harder than a standard fbm.
				amp *= 0.34
				freq *= 2.1
			}
			const n = sum / norm
			// Ridged rather than squared. `n * n` pulled everything toward the floor and
			// produced a plain; folding the noise around its midpoint gives ridgelines and
			// valleys — the landform an RTS map actually needs for cover and read.
			// `1 - |2n - 1|` peaks where the raw noise crosses 0.5, and the mild ease
			// keeps valley floors broad enough to build and manoeuvre on.
			const ridged = 1 - Math.abs(2 * n - 1)
			// Biased DOWN, not smoothstepped. Smoothstep flattened the tops into broad
			// plateaus that all landed in the same elevation band, so the highest surface
			// covered most of the map. `^1.6` keeps the valleys broad and buildable while
			// leaving only the true peaks in the top band.
			const shaped = Math.pow(ridged, 1.6)
			out[y * w + x] = Math.round(shaped * MAX_HEIGHT_STEPS)
		}
	}
	return out
}

const MOTION_BASE_HEIGHT_STEPS = 4
const MOTION_COLUMN_COUNT = 5
const MOTION_RAMP_ACTOR = 5
const MOTION_AIRCRAFT_ACTOR = 6
const MOTION_INFANTRY_ACTOR = 7

interface MotionCourse {
	cx: number
	cy: number
	circleRadius: number
	rampHalfLength: number
	rampY: number
}

interface MotionPosition {
	x: number
	y: number
	z: number
	typeName: string
	turret: boolean
}

interface MotionActor extends MotionPosition {
	facing: number
	speed: number
	turretFacing: number | null
}

function motionCourse(w: number, h: number): MotionCourse {
	const circleRadius = Math.max(3, Math.min(10, Math.min(w, h) * 0.12))
	const rampHalfLength = Math.max(3, Math.min(8, Math.floor(w * 0.1)))
	const cx = w * 0.5
	const cy = h * 0.5
	return {
		cx,
		cy,
		circleRadius,
		rampHalfLength,
		rampY: Math.min(h - 3, cy + circleRadius + 7),
	}
}

/**
 * Put the motion probes on known geometry instead of asking random terrain to supply a
 * useful derivative. The circular pad is level. The separate ramp rises four metres over
 * eight metres and its south edge is one height step higher than its north edge, so wheel
 * contacts see both pitch and roll. Everything is integer height-step terrain, exactly as a
 * real §4.3 map is; no presentation-only test hook is involved.
 */
function carveMotionCourse(heights: Uint8Array, w: number, h: number): void {
	const course = motionCourse(w, h)
	const padR = course.circleRadius + 3
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const dx = x + 0.5 - course.cx
			const dy = y + 0.5 - course.cy
			if (dx * dx + dy * dy <= padR * padR)
				heights[y * w + x] = MOTION_BASE_HEIGHT_STEPS
		}
	}

	const x0 = Math.max(1, Math.floor(course.cx - course.rampHalfLength))
	const x1 = Math.min(w - 2, Math.ceil(course.cx + course.rampHalfLength))
	const centreY = Math.round(course.rampY - 0.5)
	for (let y = Math.max(1, centreY - 1); y <= Math.min(h - 2, centreY + 1); y++) {
		for (let x = x0; x <= x1; x++) {
			const along = 1 - Math.min(1, Math.abs(x + 0.5 - course.cx) / course.rampHalfLength)
			const rise = Math.round(along * 8) // eight half-metre steps = four metres
			const crossSlope = y > centreY ? 1 : 0
			heights[y * w + x] = MOTION_BASE_HEIGHT_STEPS + rise + crossSlope
		}
	}
}

function mod(value: number, period: number): number {
	return ((value % period) + period) % period
}

function wangleFromDelta(dx: number, dy: number): number {
	// §4.5: zero is north (-sim Y), increasing counterclockwise towards west (-sim X).
	return mod(Math.round(Math.atan2(-dx, -dy) * 1024 / (Math.PI * 2)), 1024)
}

function paintShroudDisc(
	cells: Uint8Array,
	w: number,
	h: number,
	cx: number,
	cy: number,
	radius: number,
	state: number,
): void {
	const x0 = Math.max(0, Math.floor(cx - radius))
	const x1 = Math.min(w - 1, Math.ceil(cx + radius))
	const y0 = Math.max(0, Math.floor(cy - radius))
	const y1 = Math.min(h - 1, Math.ceil(cy + radius))
	const r2 = radius * radius
	for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
		const dx = x + 0.5 - cx
		const dy = y + 0.5 - cy
		if (dx * dx + dy * dy <= r2) cells[y * w + x] = state
	}
}

function typeIdFor(name: string): number {
	const id = DEV_TYPE_TABLE.indexOf(name)
	return id >= 0 ? id : 0
}

/** Integer WPos for one actor at one tick. No state is read or advanced. */
function motionPositionAt(
	actor: number,
	tick: number,
	w: number,
	h: number,
	originX: number,
	originY: number,
): MotionPosition | null {
	const course = motionCourse(w, h)
	let localX: number
	let localY: number
	let z: number
	let typeName: string
	let turret = false

	if (actor < MOTION_COLUMN_COUNT) {
		// Five tracked vehicles follow the same circle with 1.1 m spacing. The angular
		// increment is constant, so the chord travelled per tick is constant as well.
		const angle = tick * (Math.PI * 2 / 512) - actor * 0.11
		localX = course.cx + Math.cos(angle) * course.circleRadius
		localY = course.cy + Math.sin(angle) * course.circleRadius
		z = MOTION_BASE_HEIGHT_STEPS * 512
		typeName = 'foundry_tread'
		turret = true
	} else if (actor === MOTION_RAMP_ACTOR) {
		// Ping-pong over the full ramp: 80 ticks out, 80 back. The analytic height is
		// continuous between the integer terrain samples, which is the signal suspension
		// and pitch must eventually follow rather than a staircase of actor positions.
		const phase = mod(tick, 160)
		const u = phase <= 80 ? phase / 80 : (160 - phase) / 80
		localX = course.cx - course.rampHalfLength + u * course.rampHalfLength * 2
		localY = course.rampY
		const along = 1 - Math.min(1, Math.abs(localX - course.cx) / course.rampHalfLength)
		z = MOTION_BASE_HEIGHT_STEPS * 512 + Math.round(along * 4096)
		typeName = 'foundry_tread'
		turret = true
	} else if (actor === MOTION_AIRCRAFT_ACTOR) {
		// A genuine three-dimensional orbit: six metres of vertical travel, never touching
		// the ground. One revolution takes 400 sim ticks.
		const angle = tick * (Math.PI * 2 / 400) - Math.PI * 0.35
		const radius = Math.max(7, Math.min(18, Math.min(w, h) * 0.2))
		localX = course.cx + Math.cos(angle) * radius
		localY = course.cy + Math.sin(angle) * radius
		z = Math.round((12 + Math.sin(angle) * 3) * 1024)
		typeName = 'lattice_cirrus'
	} else if (actor === MOTION_INFANTRY_ACTOR) {
		// A separate small loop gives infantry a non-zero locomotion driver without
		// phase-locking its gait to the vehicle column.
		const angle = tick * (Math.PI * 2 / 300) + Math.PI * 0.6
		localX = course.cx + Math.cos(angle) * 4
		localY = course.cy + Math.sin(angle) * 4
		z = MOTION_BASE_HEIGHT_STEPS * 512
		typeName = 'foundry_rivet'
	} else {
		return null
	}

	return {
		x: Math.round((originX + localX) * 1024),
		y: Math.round((originY + localY) * 1024),
		z,
		typeName,
		turret,
	}
}

function motionActorAt(
	actor: number,
	tick: number,
	w: number,
	h: number,
	originX: number,
	originY: number,
): MotionActor | null {
	const current = motionPositionAt(actor, tick, w, h, originX, originY)
	if (current === null) return null
	const previous = motionPositionAt(actor, tick - 1, w, h, originX, originY)!
	const dx = current.x - previous.x
	const dy = current.y - previous.y
	const dz = current.z - previous.z
	const speed = Math.min(0xffff, Math.round(Math.hypot(dx, dy, dz)))
	const facing = wangleFromDelta(dx, dy)
	let turretFacing: number | null = null
	if (current.turret) {
		// Independent of hull tangent: a steady 7 WAngle/tick sweep with actor-specific
		// phase. Offset an accidental equality so every sampled tick proves divergence.
		turretFacing = mod(tick * 7 + actor * 137 + 192, 1024)
		if (turretFacing === facing) turretFacing = mod(turretFacing + 1, 1024)
	}
	return { ...current, facing, speed, turretFacing }
}

/**
 * Encode a complete, valid §4 snapshot. Section order and layout mirror
 * SnapshotEmitter.cs exactly; if the two drift, the decoder will say so loudly.
 */
export function buildDevSnapshot(opts: DevMapOptions = {}): ArrayBuffer {
	return encodeDevSnapshot(1, opts, false)
}

/**
 * Encode tick `tick` of the deterministic moving development fixture.
 *
 * This is deliberately a pure function of `(tick, opts)`: a gate may request ticks in
 * any order and get byte-identical buffers. In particular, motion never advances an RNG
 * or reads wall time. `buildDevSnapshot` above preserves the historical static fixture
 * for callers that need one fixed map; the bridge below uses this moving form.
 */
export function buildDevSnapshotAt(tick: number, opts: DevMapOptions = {}): ArrayBuffer {
	if (!Number.isSafeInteger(tick) || tick < 0 || tick > 0xffffffff)
		throw new Error(`devsnapshot: tick must be a u32 integer (received ${tick})`)
	return encodeDevSnapshot(tick, opts, true)
}

/**
 * The generated map, produced ONCE per (size, seed, course) and reused for every tick.
 *
 * The moving fixture calls encodeDevSnapshot once per render pump, and it was regenerating the
 * entire map each time: a 96x96 height field plus two more fbm fields plus a full sort of the
 * resource field, roughly 28,000 cells of noise, every frame. A dev map is static terrain by
 * definition — §4.3 has terrain.static as its own section for exactly that reason — so none of
 * it can change between ticks and all of it was being thrown away and rebuilt.
 *
 * This mattered beyond the fixture being slow. `profile.mjs` measures cpuMs as the whole
 * frame's JS, pump included, so the regeneration landed inside the number the project quotes
 * as "CPU submit" and made a fixture cost look like a renderer cost. The first honest
 * full-roster measurement read 12.65 ms of CPU and I published the conclusion that draw
 * submission had become the frame's largest cost. It had not; this had.
 */
interface DevMapFields {
	key: string
	heights: Uint8Array
	surfaceNoise: Float32Array
	resourceNoise: Float32Array | null
}

let mapCache: DevMapFields | null = null

function devMapFields(w: number, h: number, opts: DevMapOptions, moving: boolean): DevMapFields {
	const scatter = opts.resourceScatter === true
	const density = Math.max(0, Math.min(1, opts.resourceDensity ?? 0.03))
	const key = `${w}x${h}|${opts.seed ?? 'devmap'}|${moving ? 1 : 0}|${scatter ? 1 : 0}|${density}`
	const hit = mapCache
	if (hit !== null && hit.key === key) return hit
	const rng = rootRng(opts.seed ?? 'devmap')
	const heights = makeHeightField(w, h, rng.forkNamed('height'))
	if (moving) carveMotionCourse(heights, w, h)
	const built = {
		key,
		heights,
		surfaceNoise: smoothField(w, h, rng.forkNamed('surface-bands'), 1 / 19),
		resourceNoise: scatter ? null : smoothField(w, h, rng.forkNamed('resource-bodies'), 1 / 11),
	}
	mapCache = built
	return built
}

function encodeDevSnapshot(
	tick: number,
	opts: DevMapOptions,
	moving: boolean,
	includeTerrainStatic = true,
): ArrayBuffer {
	const w = opts.width ?? 96
	const h = opts.height ?? 96
	const originX = opts.originX ?? 8
	const originY = opts.originY ?? 8
	const actorCount = opts.actorCount ?? 24
	const rng = rootRng(opts.seed ?? 'devmap')

	const cells = w * h
	const { heights, surfaceNoise, resourceNoise } = devMapFields(w, h, opts, moving)

	// Six terrain u8 planes plus the worst-case eight-byte shroud run per cell. The actual
	// disc fixture compresses to a tiny fraction of that; capacity is sized for correctness
	// under adversarial dimensions rather than for the expected RLE ratio.
	const wr = new Writer(HEADER_BYTES + 9 * ENTRY_BYTES + 64 + cells * 14 + 24 + actorCount * 48 + 8192)

	const sections: { id: number; off: number; len: number }[] = []
	// world, actors, frozen actors, lifecycle, shroud, player, events, production, plus terrain.static on
	// the bridge's first publication. Direct fixture builders keep the complete form.
	const sectionCount = 8 + (includeTerrainStatic ? 1 : 0)
	wr.pos = HEADER_BYTES + (sectionCount + 1) * ENTRY_BYTES

	const begin = (): number => {
		wr.align4()
		return wr.pos
	}
	const end = (id: number, start: number): void => {
		wr.align4()
		sections.push({ id, off: start, len: wr.pos - start })
	}

	// --- §4.2 world -------------------------------------------------------
	let s = begin()
	wr.i32w(originX) // boundsLeft
	wr.i32w(originY) // boundsTop
	wr.i32w(originX + w) // boundsRight
	wr.i32w(originY + h) // boundsBottom
	wr.u32w(1024) // WDist per cell
	wr.u16w(0) // render player table index
	wr.u8w(2) // map running
	wr.u8w(1) // session running
	wr.u32w(1) // deterministic fixture environment is present
	wr.u16w(clampInt(opts.timeOfDay, 0, 1439, 9 * 60)) // default 09:00
	wr.u16w(clampInt(opts.weatherKind, 0, 4, 0)) // default clear
	wr.u16w(clampInt(opts.weatherIntensity, 0, 1000, 0))
	wr.u16w(clampInt(opts.windDirection, 0, 1023, 256))
	wr.u16w(clampInt(opts.windSpeed, 0, 1000, 120))
	wr.u16w(0) // pad
	end(SectionId.world, s)

	// --- §4.3 terrain.static ---------------------------------------------
	const terrainStart = includeTerrainStatic ? begin() : 0
	if (includeTerrainStatic) {
		wr.u32w(w)
		wr.u32w(h)
	}
	const srng = rng.forkNamed('surface')
	const planes: Uint8Array[] = []
	// 0 type, 1 height, 2 ramp, 3 passability, 4 resource, 5 surface
	const type = new Uint8Array(cells)
	const ramp = new Uint8Array(cells)
	const pass = new Uint8Array(cells)
	const res = new Uint8Array(cells)
	const surf = new Uint8Array(cells)
	// --- ramps ---------------------------------------------------------------
	//
	// This is the difference between rolling terrain and a voxel staircase, and omitting
	// it produced exactly that staircase. `grid.connected()` slopes the mesh between two
	// cells ONLY when their heights are equal or one of them is marked a ramp — anything
	// else is a cliff, deliberately, because deriving slopes from a height threshold would
	// be terrain inventing its own passability (§4.3 forbids it). An earlier revision of
	// this generator left `ramp` all zeros while emitting a varied height field, so every
	// single height change became a vertical wall and the battlefield rendered as blocks.
	//
	// A real map generator declares its slopes. So: a one-step difference to a neighbour
	// is a ramp — gentle ground the mesh should slope across — while a difference of two
	// steps or more (>= 1 m) stays a genuine cliff. That yields smooth rolling ground with
	// occasional real escarpments, which is both what an RTS map looks like and what
	// exercises the cliff geometry path rather than bypassing it.
	const stepTo = (x: number, y: number, i: number): number => {
		if (x < 0 || y < 0 || x >= w || y >= h) return 0
		return Math.abs(heights[y * w + x] - heights[i])
	}
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x
			const d = Math.max(stepTo(x - 1, y, i), stepTo(x + 1, y, i), stepTo(x, y - 1, i), stepTo(x, y + 1, i))
			ramp[i] = d === 1 ? 1 : 0
		}
	}

	// A second, independent smooth field that displaces the elevation bands. Forked by
	// name so adding a generator call elsewhere cannot shift it (§5.2).
	// surfaceNoise, resourceNoise and heights all come from devMapFields — see the note there
	// on why they are generated once rather than per tick.

	// Ore bodies. A separate fork so resource placement is not correlated with the surface
	// bands, and a higher frequency than 1/19 so bodies are smaller than a band but still
	// contiguous. The threshold is taken as a QUANTILE of the field rather than a fixed
	// value, so the requested coverage holds regardless of how the field happens to be
	// distributed for a given seed — a fixed threshold would make density a function of the
	// seed, and then two runs would not be comparing the same amount of resource.
	const resourceDensity = Math.max(0, Math.min(1, opts.resourceDensity ?? 0.03))
	const resourceScatter = opts.resourceScatter === true
	// resourceNoise likewise.
	let resourceCut = Infinity
	if (resourceNoise && resourceDensity > 0) {
		const sorted = Float32Array.from(resourceNoise).sort()
		resourceCut = sorted[Math.min(sorted.length - 1, Math.floor((1 - resourceDensity) * sorted.length))]
	}
	const resourceAt = (i: number, water: boolean): boolean => {
		if (water || resourceDensity <= 0) return false
		return resourceNoise ? resourceNoise[i] >= resourceCut : srng.next() < resourceDensity
	}

	for (let i = 0; i < cells; i++) {
		const ht = heights[i]
		const water = ht === 0
		type[i] = water ? 1 : 0
		pass[i] = water ? 1 << 3 : (1 << 0) | (1 << 1) | (1 << 2)
		// Surface banding by elevation, broken up by a COHERENT noise field rather than
		// per-cell randomness. Thresholds are fractions of MAX_HEIGHT_STEPS rather than
		// absolutes — they were previously tuned to a 0..12 range and every one of them
		// was exceeded when the range changed, collapsing the whole map to rock.
		//
		// The jitter used to be `srng.next() * 1.1`, independent per cell. That is the
		// worst possible choice for this: uncorrelated noise straddling a threshold
		// produces isolated single-cell islands and a maximally long, ragged boundary —
		// and every one of those boundary cells is a hard material edge that flickers as
		// TAA's subpixel jitter crosses it (t1-terrain-5). A smooth field displaces the
		// band boundary as a continuous curve instead, so the same visual variety costs a
		// fraction of the boundary length.
		const t = (ht + surfaceNoise[i] * 2.2) / MAX_HEIGHT_STEPS
		surf[i] = water
			? Surface.water
			: t < 0.12
				? Surface.sand // shoreline
				: t < 0.5
					? Surface.grass // the broad, buildable middle of the map
					: t < 0.66
						? Surface.soil
						: t < 0.8
							? Surface.gravel
							: t < 0.92
								? Surface.rock
								: Surface.snow // caps on the high ground
		// Resource placement, and the reason it is not `srng.next() < density`.
		//
		// It used to be exactly that, on the line below the comment above explaining why
		// uncorrelated per-cell noise is the worst possible choice here. The band jitter had
		// already been fixed for that reason; this line was left. Measured at `seed=demo`:
		// 299 resource cells, of which 238 of 282 interior ones were in COMPLETE isolation
		// (84.4%), producing 354 three-way corners — the dominant trigger for t1-terrain-5's
		// flicker, and the hexagonal patches a human spotted on sight before any gate did.
		//
		// A coherent field puts the same coverage into contiguous bodies, which is both what
		// an ore field looks like and a fraction of the boundary length. Coverage is held
		// equal on purpose so the before/after is a fair comparison of boundary cost rather
		// than of how much resource is on the map.
		res[i] = resourceAt(i, water) ? 1 : 0
		if (res[i]) surf[i] = Surface.resource
	}
	planes.push(type, heights, ramp, pass, res, surf)
	if (includeTerrainStatic) {
		for (const p of planes) {
			wr.u8.set(p, wr.pos)
			wr.pos += p.length
			wr.align4()
		}
		end(SectionId.terrainStatic, terrainStart)
	}

	// --- §4.5 actors (structure-of-arrays) --------------------------------
	s = begin()
	const arng = rng.forkNamed('actors')
	const n = actorCount
	const ids = new Uint32Array(n)
	for (let i = 0; i < n; i++) ids[i] = i + 1 // ascending, as §4.5 requires
	// Static placement is still generated for every index, even when a moving role later
	// overrides it. That keeps the static build byte-for-byte independent of this branch and
	// gives actors beyond the eight motion probes a stable backdrop.
	const ax: number[] = []
	const ay: number[] = []
	// A cluster radius draws from a disc around the map centre — where the camera looks —
	// so every actor is genuinely on screen. sqrt() on the radial draw keeps the density
	// uniform over the disc; sampling radius linearly would pile them at the centre and
	// quietly measure overdraw instead of instance count.
	const clusterR = opts.clusterRadius
	const midX = w / 2
	const midY = h / 2
	for (let i = 0; i < n; i++) {
		let cx: number
		let cy: number
		if (clusterR !== undefined && clusterR > 0) {
			const theta = (arng.int(0, 65535) / 65536) * Math.PI * 2
			const r = clusterR * Math.sqrt(arng.int(0, 65535) / 65536)
			cx = Math.min(w - 2, Math.max(2, Math.round(midX + Math.cos(theta) * r)))
			cy = Math.min(h - 2, Math.max(2, Math.round(midY + Math.sin(theta) * r)))
		} else {
			cx = arng.int(2, w - 2)
			cy = arng.int(2, h - 2)
		}
		ax.push(cx)
		ay.push(cy)
	}
	const staticFacing = new Uint16Array(n)
	for (let i = 0; i < n; i++) staticFacing[i] = arng.int(0, 1024)

	const posX = new Int32Array(n)
	const posY = new Int32Array(n)
	const posZ = new Int32Array(n)
	const typeId = new Uint16Array(n)
	const facing = new Uint16Array(n)
	const animState = new Uint16Array(n)
	const turretOffset = new Uint16Array(n)
	const speed = new Uint16Array(n)
	const turretCount = new Uint8Array(n)
	const actorFlags = new Uint8Array(n)
	const actorSurface = new Uint8Array(n)
	const turretFacings: number[] = []

	for (let i = 0; i < n; i++) {
		const motion = moving ? motionActorAt(i, tick, w, h, originX, originY) : null
		if (motion !== null) {
			posX[i] = motion.x
			posY[i] = motion.y
			posZ[i] = motion.z
			typeId[i] = typeIdFor(motion.typeName)
			facing[i] = motion.facing
			animState[i] = 1 // locomotion; a state id, never a frame counter
			speed[i] = motion.speed
			actorFlags[i] = motion.speed > 0 ? ActorFlag.moving : 0
			if (motion.turretFacing !== null) {
				turretOffset[i] = turretFacings.length
				turretCount[i] = 1
				turretFacings.push(motion.turretFacing)
			}
		} else {
			posX[i] = (originX + ax[i]) * 1024 + 512
			posY[i] = (originY + ay[i]) * 1024 + 512
			posZ[i] = heights[ay[i] * w + ax[i]] * 512
			// Every actor type the table holds, not the first five. See setDevTypeNames.
			typeId[i] = i % DEV_TYPE_TABLE.length
			facing[i] = staticFacing[i]
		}

		const cellX = Math.min(w - 1, Math.max(0, Math.floor(posX[i] / 1024) - originX))
		const cellY = Math.min(h - 1, Math.max(0, Math.floor(posY[i] / 1024) - originY))
		actorSurface[i] = surf[cellY * w + cellX]
		// Deployable: whichever table entry is the mobile construction vehicle, not a
		// fixed index — the table's head changed and a hardwired `i === 0` left the
		// deploy button unobtainable in every fixture game.
		if (DEV_TYPE_TABLE[typeId[i]] === 'mcv') actorFlags[i] |= ActorFlag.deployable
	}

	wr.u32w(n)
	wr.u32w(turretFacings.length)
	for (let i = 0; i < n; i++) wr.u32w(ids[i])
	for (let i = 0; i < n; i++) wr.i32w(posX[i])
	for (let i = 0; i < n; i++) wr.i32w(posY[i])
	for (let i = 0; i < n; i++) wr.i32w(posZ[i])
	for (let i = 0; i < n; i++) wr.u16w(typeId[i])
	for (let i = 0; i < n; i++) wr.u16w(facing[i])
	for (let i = 0; i < n; i++) wr.u16w(animState[i])
	for (let i = 0; i < n; i++) wr.u16w(0) // prodProgress
	for (let i = 0; i < n; i++) wr.u16w(turretOffset[i])
	for (let i = 0; i < n; i++) wr.u16w(speed[i])
	wr.align4()
	for (let i = 0; i < n; i++) wr.u8w(i % 2) // player-table owner
	for (let i = 0; i < n; i++) wr.u8w(255) // health
	for (let i = 0; i < n; i++) wr.u8w(0) // cargo
	for (let i = 0; i < n; i++) wr.u8w(turretCount[i])
	for (let i = 0; i < n; i++) wr.u8w(actorFlags[i])
	for (let i = 0; i < n; i++) wr.u8w(actorSurface[i])
	for (let i = 0; i < n; i++) wr.u8w(255) // ammo: none
	for (let i = 0; i < n; i++) wr.u8w(0) // cargoReserved
	for (let i = 0; i < n; i++) wr.u8w(0) // veterancy: none
	wr.align4()
	for (let i = 0; i < n; i++) wr.u16w(typeId[i]) // presentation type: no disguise fixture
	wr.align4()
	for (const turretFacing of turretFacings) wr.u16w(turretFacing)
	wr.align4()
	end(SectionId.actors, s)

	// --- §4.7 shroud -------------------------------------------------------
	// Friendly actors reveal a tight disc. A wider remembered disc and the old location of
	// a moving probe stay EXPLORED behind it, so all three visual states are present without
	// consulting wall time or state from a prior encoder call.
	const shroud = new Uint8Array(cells)
	if (opts.revealMap) shroud.fill(ShroudState.visible)
	else for (let i = 0; i < n; i += 2) {
		const cx = posX[i] / 1024 - originX
		const cy = posY[i] / 1024 - originY
		paintShroudDisc(shroud, w, h, cx, cy, 12, ShroudState.explored)
		if (moving) {
			const old = motionPositionAt(i, Math.max(0, tick - 18), w, h, originX, originY)
			if (old !== null)
				paintShroudDisc(
					shroud,
					w,
					h,
					old.x / 1024 - originX,
					old.y / 1024 - originY,
					8,
					ShroudState.explored,
				)
		}
	}
	for (let i = 0; i < n; i += 2)
		paintShroudDisc(
			shroud,
			w,
			h,
			posX[i] / 1024 - originX,
			posY[i] / 1024 - originY,
			7,
			ShroudState.visible,
		)

	let shroudRuns = 0
	for (let start = 0; start < cells;) {
		let finish = start + 1
		while (finish < cells && finish - start < 0xffff && shroud[finish] === shroud[start]) finish++
		shroudRuns++
		start = finish
	}
	s = begin()
	wr.u32w(shroudRuns)
	for (let start = 0; start < cells;) {
		let finish = start + 1
		while (finish < cells && finish - start < 0xffff && shroud[finish] === shroud[start]) finish++
		wr.u32w(start)
		wr.u16w(finish - start)
		wr.u8w(shroud[start])
		wr.u8w(0)
		start = finish
	}
	end(SectionId.shroud, s)

	// --- §4.6 lifecycle ----------------------------------------------------
	s = begin()
	wr.u32w(0)
	end(SectionId.lifecycle, s)

	// --- §4.10 player ------------------------------------------------------
	s = begin()
	wr.u32w(2)
	for (let p = 0; p < 2; p++) {
		wr.u32w(5000) // cash
		wr.u32w(0) // resources
		wr.i16w(100) // powerSupplied
		wr.i16w(40) // powerDrained
		wr.i32w(p) // authoritative OpenRA client index
		wr.u16w(p) // faction type id
		wr.i16w(p) // team id
		wr.u8w(p === 0 ? 0 : 2) // self | enemy
		wr.u8w((1 << 0) | (p === 0 ? 1 << 1 : 0)) // alive | isRenderPlayer
		if (p === 0) {
			wr.u8w(189); wr.u8w(71); wr.u8w(61); wr.u8w(255)
		} else {
			wr.u8w(66); wr.u8w(117); wr.u8w(194); wr.u8w(255)
		}
		wr.u32w(0xffffffff) // score absent: no canonical synchronized OpenRA RA score
		const queueCount = p === 0 ? 3 : 0
		wr.u16w(queueCount)
		wr.u16w(0)
		wr.u16w(0)
		if (p === 0) {
			const infantry = devTypeId('foundry_rivet', 0)
			const structure = devTypeId('foundry_boiler', infantry)
			const progress = Math.min(1000, (tick % 75) * 20)
			wr.u16w(stableQueueId('FoundryBuilding'))
			wr.u16w(structure)
			wr.u16w(1000)
			wr.u16w(1)
			wr.u16w(stableQueueId('FoundryInfantry'))
			wr.u16w(infantry)
			wr.u16w(progress)
			wr.u16w(2)
			wr.u16w(stableQueueId('FoundryVehicle'))
			wr.u16w(0xffff)
			wr.u16w(0)
			wr.u16w(0)
		}
	}
	end(SectionId.player, s)

	// --- §4.9 events -------------------------------------------------------
	s = begin()
	wr.u32w(0)
	end(SectionId.events, s)

	// --- §4.10a production catalogue --------------------------------------
	// Fixture-owned values, deliberately independent of the roster generator. The fixture
	// stands in for the simulation; deriving this catalogue from units/archetype would make
	// the producer and consumer agree by construction and hide a broken bridge.
	s = begin()
	wr.u32w(3)
	const infantry = devTypeId('foundry_rivet', 0)
	const support = devTypeId('lattice_shard', 1)
	const vehicle = devTypeId('foundry_tread', 2)
	const scout = devTypeId('lattice_skimmer', 3)
	const structure = devTypeId('foundry_boiler', infantry)
	const progress = Math.min(1000, (tick % 75) * 20)
	const ready = progress === 1000
	writeDevQueue(
		wr,
		0,
		stableQueueId('FoundryBuilding'),
		(1 << 0) | (1 << 2),
		0,
		structure,
		1000,
		0,
		[
			[structure, (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5), 700, 130, 1],
		],
	)
	writeDevQueue(
		wr,
		0,
		stableQueueId('FoundryInfantry'),
		(1 << 0) | (ready ? 1 << 2 : 0),
		1,
		infantry,
		progress,
		2,
		[
			[infantry, (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (ready ? 1 << 4 : 0), 120, 60, 2],
			[support, (1 << 0) | (1 << 1), 180, 80, 0],
		],
	)
	writeDevQueue(
		wr,
		0,
		stableQueueId('FoundryVehicle'),
		1 << 0,
		2,
		0xffff,
		0,
		0,
		[
			[vehicle, (1 << 0) | (1 << 1), 900, 180, 0],
			[scout, 1 << 0, 650, 140, 0],
		],
	)
	end(SectionId.production, s)

	// No remembered structure is needed in the general renderer fixture, but the optional
	// section is always present so decoder/layout drift is caught before a live scout sees one.
	s = begin()
	wr.u32w(0)
	end(SectionId.frozenActors, s)

	// --- header + section table -------------------------------------------
	const byteLength = wr.pos
	wr.pos = 0
	wr.u32w(SNAPSHOT_MAGIC)
	wr.u16w(SNAPSHOT_VERSION)
	wr.u16w(sections.length)
	wr.u32w(byteLength)
	wr.u32w(tick) // tick
	wr.u32w(0) // syncHash — a dev snapshot has no simulation to hash
	wr.u32w(Math.imul(tick, 40) >>> 0) // gameTimeMs
	wr.u32w(includeTerrainStatic ? HeaderFlag.terrainStaticPresent : 0)
	wr.u32w(0) // reserved
	for (const sec of sections) {
		wr.u16w(sec.id)
		wr.u16w(0)
		wr.u32w(sec.off)
		wr.u32w(sec.len)
	}

	return wr.buf.slice(0, byteLength)
}

function writeDevQueue(
	wr: Writer,
	playerId: number,
	queueId: number,
	flags: number,
	kind: number,
	currentActorType: number,
	progressPermille: number,
	itemsQueued: number,
	items: readonly (readonly [number, number, number, number, number])[],
): void {
	wr.u8w(playerId)
	wr.u8w(queueId)
	wr.u8w(flags)
	wr.u8w(kind)
	wr.u16w(currentActorType)
	wr.u16w(progressPermille)
	wr.u16w(itemsQueued)
	wr.u16w(items.length)
	for (const [actorType, itemFlags, cost, buildTicks, queued] of items) {
		wr.u16w(actorType)
		wr.u16w(itemFlags)
		wr.u32w(cost)
		wr.u16w(buildTicks)
		wr.u16w(queued)
	}
}

function devTypeId(name: string, fallback: number): number {
	const id = DEV_TYPE_TABLE.indexOf(name)
	return id >= 0 ? id : fallback
}

/** Same FNV-1a reduction as Production.StableQueueId on the simulation side. */
function stableQueueId(value: string): number {
	let hash = 2166136261
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i)
		hash = Math.imul(hash, 16777619) >>> 0
	}
	return (hash % 0xff) + 1
}

/**
 * Actor types the dev fixture claims to contain, index == the `typeId` it writes.
 *
 * This small compatibility table remains until Phase 0.2 replaces the static modulo-five
 * coverage with the complete roster. Motion roles resolve by NAME, not a magic numeric id,
 * so that change cannot silently turn the aircraft probe back into a ground unit.
 */
const DEV_TYPE_PROBES: readonly string[] = [
	'foundry_rivet', // infantry locomotion probe
	'lattice_shard', // opposing infantry silhouette
	'foundry_tread', // tracked medium
	'lattice_skimmer', // wheeled medium
	'drift_wreck', // neutral salvage
	'lattice_cirrus', // rotorcraft altitude/orbit probe
]

/**
 * The table the fixture actually serves. Probes first, so a motion role's index is stable,
 * then every remaining roster actor.
 *
 * It is EMPTY of roster actors until `setDevTypeNames` is called, and that call comes from
 * main.ts — the composition root, which is the only place allowed to know both `core` and the
 * roster. Rule 3 forbids `core` importing from `units`, and a fixture is not a reason to
 * bend it.
 */
let DEV_TYPE_TABLE: readonly string[] = DEV_TYPE_PROBES

/**
 * Point the fixture at the whole roster.
 *
 * Until this existed the fixture wrote `typeId = i % 5` against a five-name table, so the
 * §7.1 reference workload — "200 clustered units", the number every performance figure in
 * §11.4 is quoted against — exercised FOUR archetype hulls and one fallback out of 97. Every
 * cost in this project was measured against 5% of the roster, and every headroom argument
 * built on those costs inherited it.
 *
 * Expect the honest baseline to be worse. That is the measurement becoming true, not a
 * regression, and it must be recorded as a re-baseline rather than charged to whatever
 * feature happens to land next.
 */
export function setDevTypeNames(names: readonly string[]): void {
	const seen = new Set(DEV_TYPE_PROBES)
	DEV_TYPE_TABLE = [...DEV_TYPE_PROBES, ...names.filter(n => !seen.has(n))]
}

/** Replace the fixture table exactly. Used by the tank-realism showcase (`?tanks=1`). */
export function setDevTypeNamesExact(names: readonly string[]): void {
	if (names.length === 0) throw new Error('devsnapshot: exact type table cannot be empty')
	DEV_TYPE_TABLE = [...names]
}

/**
 * A BridgeApi that emits one new deterministic sim tick per render pump.
 *
 * PollSnapshot's null is part of the contract: App drains until it sees null. Returning a
 * snapshot forever would hang that loop, so every served tick is followed by one null
 * sentinel. The next call is necessarily from the next pump and receives the next tick.
 * Each tick has a distinct backing buffer; retaining frame N-1 for interpolation therefore
 * cannot observe frame N overwriting it.
 */
export function createDevBridge(opts: DevMapOptions = {}): {
	pollSnapshot(): Uint8Array | null
	issueOrder(): Promise<string>
	snapshotTypeTable(): Promise<string>
	getSkirmishCatalog(): Promise<SkirmishCatalog>
	startSkirmish(config: StartSkirmishConfig): Promise<SessionStatus>
	getSessionStatus(): SessionStatus | null
	setPaused(paused: boolean): Promise<string>
} {
	const renderFps = opts.renderFps === undefined
		? null
		: clampInt(opts.renderFps, 25, 1000, 60)
	let pollFrame = 0
	let lastTick = -1
	let closeDrain = false
	let terrainStaticPending = true
	const status: SessionStatus = {
		schemaVersion: 1,
		status: 'running',
		code: 'dev-fixture',
		userMessage: 'Deterministic development battlefield is running.',
	}
	const catalog: SkirmishCatalog = {
		schemaVersion: 1,
		engine: { mod: 'fixture', upstreamCommit: 'development-only' },
		sessionTransports: {
			local: { supported: true },
			network: { supported: false, status: 'future' },
		},
		defaultGameSpeed: 'normal',
		gameSpeeds: [{ id: 'normal', name: 'Normal', timestep: 40, orderLatency: 1 }],
		maps: [{
			uid: 'devmap',
			title: 'Deterministic development battlefield',
			author: 'STEELSEED fixture',
			tileSet: 'PROCEDURAL',
			bounds: { x: 0, y: 0, width: opts.width ?? 96, height: opts.height ?? 96 },
			spawnPoints: [{ id: 1, x: 20, y: 48 }, { id: 2, x: 76, y: 48 }],
			slots: [
				{ id: 'A', required: true, allowBots: true, locks: { faction: false, color: false, team: false, spawn: false }, defaults: { faction: 'foundry', color: '#BD473DFF', team: 1, spawn: 1 } },
				{ id: 'B', required: true, allowBots: true, locks: { faction: false, color: false, team: false, spawn: false }, defaults: { faction: 'lattice', color: '#4275C2FF', team: 2, spawn: 2 } },
			],
			factions: [{ id: 'foundry', name: 'Foundry' }, { id: 'lattice', name: 'Lattice' }],
			bots: [{ id: 'normal', name: 'Normal bot' }],
			colors: ['#BD473DFF', '#4275C2FF'],
			options: [],
		}],
	}
	return {
		pollSnapshot: () => {
			if (closeDrain) {
				closeDrain = false
				return null
			}
			const tick = renderFps === null
				? pollFrame
				: Math.floor((pollFrame + 1) * 25 / renderFps)
			pollFrame++
			if (tick === lastTick) return null
			const buffer = new Uint8Array(encodeDevSnapshot(
				tick >>> 0,
				opts,
				true,
				terrainStaticPending,
			))
			terrainStaticPending = false
			lastTick = tick
			closeDrain = true
			return buffer
		},
		issueOrder: async () => {
			// A dev snapshot has no simulation to accept orders. Silently ignored rather
			// than thrown: `ui` and `camera` should be exercisable against it.
			return 'ignored: dev snapshot'
		},
		// Mirrors [JSExport] SnapshotTypeTable: newline-separated, index == typeId.
		snapshotTypeTable: async () => DEV_TYPE_TABLE.join('\n'),
		getSkirmishCatalog: async () => catalog,
		startSkirmish: async () => status,
		getSessionStatus: () => status,
		setPaused: async () => 'ignored: dev snapshot',
	}
}
