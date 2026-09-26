// STEELSEED — core/snapshot
// Decoder for the packed binary frame contract. Mirrors ARCHITECTURE.md §4 exactly.
//
// This is the ONLY channel between simulation and presentation. If this file and §4
// disagree, the bug is here and it is the worst class available to this project: a
// silently misread binary layout produces plausible-looking garbage, not a crash.
// Hence the magic/version assertions on every single snapshot.
//
// Hard rule 6: allocate nothing per frame. Typed-array views are cached and only
// re-pointed when a section's offset or length actually changes, which — because the
// bridge double-buffers into two fixed allocations — means twice at map load and
// then only when an array grows.

export const SNAPSHOT_MAGIC = 0x504e5353 // 'SSNP' little-endian
export const SNAPSHOT_VERSION = 2
/** ABI v2 sentinel for an unavailable unsigned 16-bit simulation fact. */
export const SNAPSHOT_U16_ABSENT = 0xffff

export const HEADER_BYTES = 32
export const SECTION_ENTRY_BYTES = 12

export const SectionId = {
	world: 0,
	terrainStatic: 1,
	terrainDelta: 2,
	actors: 3,
	lifecycle: 4,
	projectiles: 5,
	shroud: 6,
	events: 7,
	player: 8,
	production: 9,
	frozenActors: 10,
	resources: 11,
	deployments: 12,
	actorStatus: 13,
} as const

/** `actors.status` record kinds (ARCHITECTURE §4.10c). */
export const ActorStatusKind = {
	/** The Iron Curtain (or the crate): shown to every viewer. */
	invulnerable: 1,
	/** Chronoshifted and due to return to its origin: sent for the render player's allies only. */
	chronoReturn: 2,
} as const

export const HeaderFlag = {
	terrainStaticPresent: 1 << 0,
	paused: 1 << 1,
	replay: 1 << 2,
	gameOver: 1 << 3,
} as const

/** Semantic engine posture in the existing u16 animState slot, never a render clip index.
 * Other/unknown animation state remains SNAPSHOT_U16_ABSENT. Legacy dev locomotion is 1.
 */
export const ActorAnimationState = {
	prone: 2,
} as const

export const ActorFlag = {
	disabled: 1 << 0,
	cloaked: 1 << 1,
	parachuting: 1 << 2,
	husk: 1 << 3,
	deployable: 1 << 4,
	firing: 1 << 5,
	moving: 1 << 6,
	submerged: 1 << 7,
} as const

export const LifecycleKind = {
	created: 0,
	destroyed: 1,
	captured: 2,
	sold: 3,
	huskSpawned: 4,
} as const

export const ShroudState = {
	unexplored: 0,
	explored: 1,
	visible: 2,
} as const

export const EventKind = {
	weaponFire: 1,
	projectileImpact: 2,
	explosion: 3,
	actorDamaged: 4,
	actorDestroyed: 5,
	unitMoving: 6,
	structureBuilt: 7,
	productionComplete: 8,
	resourceHarvested: 9,
	powerState: 10,
	orderAccepted: 11,
	notify: 12,
	/** `u32 count`: records the engine's event sink refused this frame (4096 cap). */
	eventsDropped: 13,
} as const

export const PlayerFlag = {
	alive: 1 << 0,
	isRenderPlayer: 1 << 1,
	isBot: 1 << 2,
	won: 1 << 3,
	lost: 1 << 4,
} as const

export const ProductionQueueFlag = {
	enabled: 1 << 0,
	paused: 1 << 1,
	ready: 1 << 2,
} as const

export const ProductionItemFlag = {
	visible: 1 << 0,
	buildable: 1 << 1,
	queued: 1 << 2,
	current: 1 << 3,
	ready: 1 << 4,
	building: 1 << 5,
} as const

/** WAngle: OpenRA's 0..1023 facing space. One full turn is 1024, not 360 or 2pi. */
export const WANGLE_TURN = 1024
/** WDist: OpenRA's sub-cell distance unit. One cell is 1024. */
export const WDIST_CELL = 1024

// ---------------------------------------------------------------------------
// Structure-of-arrays views. Kept as raw typed arrays deliberately: `render` and
// `units` feed these straight into GPU instance buffers with no per-actor JS object.
// ---------------------------------------------------------------------------

export interface ActorsView {
	count: number
	turretTotal: number
	id: Uint32Array
	posX: Int32Array
	posY: Int32Array
	posZ: Int32Array
	typeId: Uint16Array
	/** Presentation-only actor type. Equal to typeId unless an effective-owner trait disguises the actor. */
	displayTypeId: Uint16Array
	facing: Uint16Array
	/** ActorAnimationState semantic posture or SNAPSHOT_U16_ABSENT; not a clip index. */
	animState: Uint16Array
	prodProgress: Uint16Array
	turretOffset: Uint16Array
	/** Average WDist/tick since the previous emitted sample; 0xffff means absent. */
	speed: Uint16Array
	owner: Uint8Array
	health: Uint8Array
	cargo: Uint8Array
	turretCount: Uint8Array
	flags: Uint8Array
	surface: Uint8Array
	/** Current ammo across AmmoPool traits. 255 means the actor has no limited pool. */
	ammo: Uint8Array
	/** Seats reserved by passengers walking in, or 1 while unloading. Drives cargo doors. */
	cargoReserved: Uint8Array
	/** GainsExperience level, 0 when the actor has no experience track. */
	veterancy: Uint8Array
	turretFacing: Uint16Array
	/** Immutable source aircraft of a falling husk; absent on legacy snapshots. */
	crashParentId?: Uint32Array | null
}

/** Last authoritative state cached by OpenRA FrozenUnderFog for explored structures. */
export interface FrozenActorsView {
	count: number
	id: Uint32Array
	posX: Int32Array
	posY: Int32Array
	posZ: Int32Array
	typeId: Uint16Array
	owner: Uint8Array
	health: Uint8Array
}

export interface WorldView {
	boundsLeft: number
	boundsTop: number
	boundsRight: number
	boundsBottom: number
	cellSize: number
	renderPlayer: number
	mapState: number
	sessionState: number
	environmentPresent: boolean
	environment: {
		timeOfDay: number
		weatherKind: number
		weatherIntensity: number
		windDirection: number
		windSpeed: number
	} | null
}

export interface TerrainStaticView {
	w: number
	h: number
	type: Uint8Array
	height: Uint8Array
	ramp: Uint8Array
	passability: Uint8Array
	resource: Uint8Array
	surface: Uint8Array
}

/** Live resource content known to the render player, including remembered ore under fog. */
export interface ResourcesView {
	w: number
	h: number
	/** Changes only when a published type/density/maximum or player perspective changes. */
	revision: number
	/** OpenRA ResourceIndex: RA ore=1, gems=2; zero means no known resource. */
	type: Uint8Array
	density: Uint8Array
	maxDensity: Uint8Array
}

/**
 * What kind of thing a §4 section-5 row is.
 *
 * `flight` is a body travelling through the air — a V2's SCUD, a SAM's Nike, a rocket
 * soldier's Dragon — whose target field carries no information (the host writes the flight's
 * own position there rather than leaking where it is aimed). `beam` is instantaneous and
 * exists only between its two ends for a few ticks: a tesla zap. For a beam the target is real,
 * and the host publishes it only when BOTH ends stand on ground this player can see.
 */
export const ProjectileKind = {
	flight: 0,
	beam: 1,
} as const

/**
 * Live projectiles, structure of arrays, 43 bytes each.
 *
 * This section had a decoder and no producer for the whole life of the project: nothing outside
 * this file read `snapshot.projectiles`, and `SnapshotEmitter.cs` never wrote section 5 at all.
 * That is why no rocket was ever drawn. Both ends now exist; `fx/projectiles.ts` is the consumer.
 */
export interface ProjectilesView {
	count: number
	/**
	 * Stable for one flight's lifetime, opaque otherwise. The host uses the runtime object hash
	 * of the projectile, because OpenRA projectiles carry no simulation identity. Use it to keep
	 * a trail or a deterministic jitter attached to the same flight; never as a world key.
	 */
	id: Uint32Array
	/** The firing actor, or 0. Lets a client raise a launch onto the barrel it actually drew. */
	sourceActorId: Uint32Array
	posX: Int32Array
	posY: Int32Array
	posZ: Int32Array
	/** Far end of a beam. Equal to the position for a flight, by design — see ProjectileKind. */
	tgtX: Int32Array
	tgtY: Int32Array
	tgtZ: Int32Array
	/** WDist per SIMULATION TICK, unscaled: the same 1024-per-cell unit as the positions. */
	velX: Int16Array
	velY: Int16Array
	velZ: Int16Array
	/** Shared string-table id of the WEAPON name, resolved through `ctx.actorTypeName`. */
	typeId: Uint16Array
	/** Ticks until removal; 65535 when the projectile homes and cannot know its own arrival. */
	remainingTicks: Uint16Array
	/** `ProjectileKind`. */
	kind: Uint8Array
	/** Optional, aligned presentation extension; absent on older producers. */
	launchX?: Int32Array
	launchY?: Int32Array
	launchZ?: Int32Array
	launchShot?: Uint32Array
	launchArmament?: Uint16Array
	launchBarrel?: Uint16Array
}

export interface LifecycleEntry {
	actorId: number
	typeId: number
	kind: number
	owner: number
}

export interface ShroudRun {
	cellIndex: number
	runLength: number
	state: number
}

export interface SnapshotEvent {
	kind: number
	/** Byte offset of the payload within the snapshot buffer. */
	offset: number
	byteLength: number
}

export interface PlayerQueueView {
	queueId: number
	actorType: number
	progressPermille: number
	itemsQueued: number
}

export interface PlayerView {
	/** Liquid cash only. Total spendable credits are cash + resources (OpenRA semantics). */
	cash: number
	/** Stored ore's credit value, immediately spendable; consumed before liquid cash. */
	resources: number
	powerSupplied: number
	powerDrawn: number
	id: number
	clientIndex: number
	factionId: number
	teamId: number
	relation: number
	flags: number
	red: number
	green: number
	blue: number
	alpha: number
	score: number | null
	queues: PlayerQueueView[]
}

export interface ProductionItemView {
	actorType: number
	flags: number
	cost: number
	buildTicks: number
	queued: number
}

export interface ProductionQueueView {
	playerId: number
	queueId: number
	flags: number
	kind: number
	currentActorType: number
	progressPermille: number
	itemsQueued: number
	items: ProductionItemView[]
}

export interface Snapshot {
	valid: boolean
	tick: number
	syncHash: number
	gameTimeMs: number
	flags: number
	byteLength: number
	buffer: ArrayBufferLike
	/** Byte offset of this persistent slot alias inside `buffer`. */
	byteOffset: number
	view: DataView
	world: WorldView | null
	terrainStatic: TerrainStaticView | null
	/** Optional section 11, row-major at world.boundsLeft/Top; absent in legacy/dev hosts. */
	resources: ResourcesView | null
	actors: ActorsView | null
	frozenActors: FrozenActorsView | null
	projectiles: ProjectilesView | null
	/** Optional authoritative make-frame and copied transform provenance. */
	deployments?: DeploymentsView | null
	/** Timed states visible units carry (§4.10c); null when none this tick. */
	actorStatus?: ActorStatusView | null
	lifecycle: LifecycleEntry[]
	shroud: ShroudRun[]
	events: SnapshotEvent[]
	players: PlayerView[]
	/** Optional §4.10a dynamic production catalogue. Empty means unsupported or no queues. */
	production: ProductionQueueView[]
	/** Section id -> [offset, length], for consumers decoding a section themselves. */
	sections: Map<number, [number, number]>
}

/**32-byte records alias the current snapshot; copy facts before the backing slot is reused. */
export interface DeploymentsView {
	count: number
	byteOffset: number
	view: DataView
}

/**
 * Section 13 records, read in place: record `i` is at `byteOffset + i * 12` — u32 actor id,
 * u8 kind (ActorStatusKind), u8 0, u16 remaining ticks (0 = unknown), u16 total ticks, u16 0.
 */
export interface ActorStatusView {
	count: number
	byteOffset: number
	view: DataView
}

export class SnapshotDecodeError extends Error {}

/** Round up to the next 4-byte boundary. Every section and array is 4-byte aligned. */
function align4(n: number): number {
	return (n + 3) & ~3
}

/**
 * Decodes snapshots in place. One instance per double buffer; reuse it across ticks so
 * the view cache actually pays for itself.
 */
export class SnapshotDecoder {
	private worldStatic: TerrainStaticView | null = null
	// both aliases after either a managed generation bump or a WASM heap-buffer change.
	// Alias identity is therefore the combined generation key: a stale/detached buffer can
	// never inherit the views cached for its replacement.
	private cache = new WeakMap<Uint8Array, Snapshot>()
	private arrayBufferViews = new WeakMap<ArrayBuffer, Uint8Array>()
	private layouts = new WeakMap<Snapshot, SnapshotLayoutCache>()

	/**
	 * Decode a snapshot buffer. The returned Snapshot aliases `buffer` — it does not
	 * copy. Do not retain it past the next swap; copy out what you need in onSnapshot.
	 */
	decode(input: ArrayBuffer | Uint8Array): Snapshot {
		if (input.byteLength === 0)
			throw new SnapshotDecodeError('snapshot buffer is empty or detached')

		let bytes: Uint8Array
		if (input instanceof Uint8Array)
			bytes = input
		else {
			bytes = this.arrayBufferViews.get(input) ?? new Uint8Array(input)
			this.arrayBufferViews.set(input, bytes)
		}

		let snap = this.cache.get(bytes)
		if (!snap) {
			snap = emptySnapshot(bytes)
			this.cache.set(bytes, snap)
			this.layouts.set(snap, emptyLayoutCache(bytes.buffer))
		}
		const layout = this.layouts.get(snap)!
		if (bytes.buffer.byteLength === 0)
			throw new SnapshotDecodeError('snapshot backing buffer is detached')
		if (bytes.buffer !== layout.buffer || snap.view.buffer !== layout.buffer)
			throw new SnapshotDecodeError('snapshot alias changed backing buffer without a cache rebuild')

		const view = snap.view
		if (bytes.byteLength < HEADER_BYTES)
			throw new SnapshotDecodeError(`snapshot has ${bytes.byteLength} bytes; header needs ${HEADER_BYTES}`)
		const magic = view.getUint32(0, true)
		if (magic !== SNAPSHOT_MAGIC)
			throw new SnapshotDecodeError(
				`bad magic 0x${magic.toString(16)}, expected 0x${SNAPSHOT_MAGIC.toString(16)} — the bridge and web layer disagree about the frame contract`,
			)

		const version = view.getUint16(4, true)
		if (version !== SNAPSHOT_VERSION)
			throw new SnapshotDecodeError(
				`snapshot version ${version}, this build decodes ${SNAPSHOT_VERSION} — rebuild the bridge and the web layer together`,
			)

		const sectionCount = view.getUint16(6, true)
		snap.byteLength = view.getUint32(8, true)
		if (snap.byteLength < HEADER_BYTES || snap.byteLength > bytes.byteLength)
			throw new SnapshotDecodeError(
				`header byteLength ${snap.byteLength} is outside slot capacity ${bytes.byteLength}`,
			)
		if (HEADER_BYTES + sectionCount * SECTION_ENTRY_BYTES > snap.byteLength)
			throw new SnapshotDecodeError(
				`section table overruns payload (${sectionCount} entries in ${snap.byteLength} bytes)`,
			)
		snap.tick = view.getUint32(12, true)
		snap.syncHash = view.getUint32(16, true)
		snap.gameTimeMs = view.getUint32(20, true)
		snap.flags = view.getUint32(24, true)

		let sectionsChanged = snap.sections.size !== sectionCount || layout.sectionOrder.length !== sectionCount
		for (let i = 0; i < sectionCount; i++) {
			const e = HEADER_BYTES + i * SECTION_ENTRY_BYTES
			const id = view.getUint16(e, true)
			const off = view.getUint32(e + 4, true)
			const len = view.getUint32(e + 8, true)
			if (off + len > snap.byteLength)
				throw new SnapshotDecodeError(`section ${id} overruns buffer (${off}+${len} > ${snap.byteLength})`)
			let section = layout.sections.get(id)
			if (section === undefined) {
				section = [off, len]
				layout.sections.set(id, section)
			} else {
				section[0] = off
				section[1] = len
			}
			if (!sectionsChanged && snap.sections.get(id) !== section)
				sectionsChanged = true
			if (!sectionsChanged && layout.sectionOrder[i] !== id)
				sectionsChanged = true
		}
		// Map.clear() may replace the engine's internal hash table. Do not pay that hidden
		// allocation every tick just to reinsert the same five entries; rebuild only when
		// the set of present sections actually changes (terrain.static at map load, etc.).
		if (sectionsChanged) {
			snap.sections.clear()
			layout.sectionOrder.length = sectionCount
			for (let i = 0; i < sectionCount; i++) {
				const e = HEADER_BYTES + i * SECTION_ENTRY_BYTES
				const id = view.getUint16(e, true)
				layout.sectionOrder[i] = id
				snap.sections.set(id, layout.sections.get(id)!)
			}
		}

		snap.world = this.decodeWorld(snap)
		// terrain.static arrives once at map load; keep the previous decode otherwise.
		// "Previous" must survive the double-buffer swap: every dev-bridge tick is a
		// fresh buffer, so a fresh snap object would otherwise lose the world's
		// static until the next map load even though §4 defines it as per-world.
		if (snap.sections.has(SectionId.terrainStatic)) {
			snap.terrainStatic = this.decodeTerrainStatic(snap, layout)
			this.worldStatic = snap.terrainStatic
		} else if (this.worldStatic !== null && this.worldStatic.type.buffer.byteLength > 0) {
			snap.terrainStatic = this.worldStatic
		} else {
			// The carried view's heap was replaced (WASM growth): a detached buffer can
			// never inherit the views cached for its replacement. Report no static until
			// the host stages terrain.static again; readers already handle the null.
			this.worldStatic = null
			snap.terrainStatic = null
		}
		snap.resources = this.decodeResources(snap, layout)
		snap.actors = this.decodeActors(snap, layout)
		snap.frozenActors = this.decodeFrozenActors(snap, layout)
		snap.projectiles = this.decodeProjectiles(snap, layout)
		snap.deployments = this.decodeDeployments(snap)
		snap.actorStatus = this.decodeActorStatus(snap)
		this.decodeLifecycle(snap, layout)
		this.decodeShroud(snap, layout)
		this.decodeEvents(snap, layout)
		this.decodePlayers(snap, layout)
		this.decodeProduction(snap, layout)

		snap.valid = true
		return snap
	}

	private decodeActorStatus(s: Snapshot): ActorStatusView | null {
		const section = s.sections.get(SectionId.actorStatus)
		if (!section) return null
		const [offset, length] = section, v = s.view
		if (length < 4) throw new SnapshotDecodeError('actors.status: truncated count')
		const count = v.getUint32(offset, true)
		if (count > 8192 || length !== 4 + count * 12) throw new SnapshotDecodeError('actors.status: invalid record length')
		for (let i = 0; i < count; i++) {
			const kind = v.getUint8(offset + 4 + i * 12 + 4)
			if (kind !== ActorStatusKind.invulnerable && kind !== ActorStatusKind.chronoReturn)
				throw new SnapshotDecodeError(`actors.status: unknown kind ${kind}`)
		}
		if (count === 0) return null
		const result = s.actorStatus ?? { count: 0, byteOffset: 0, view: v }
		result.count = count; result.byteOffset = offset + 4; result.view = v
		return result
	}

	private decodeDeployments(s: Snapshot): DeploymentsView | null {
		const section = s.sections.get(SectionId.deployments)
		if (!section) return null
		const [offset, length] = section, v = s.view
		if (length < 4) throw new SnapshotDecodeError('deployments: truncated count')
		const count = v.getUint32(offset, true)
		if (count > 4096 || length !== 4 + count * 32) throw new SnapshotDecodeError('deployments: invalid record length')
		for (let i = 0; i < count; i++) {
			const o = offset + 4 + i * 32
			const frame = v.getUint16(o + 22, true), frames = v.getUint16(o + 24, true), milliseconds = v.getUint16(o + 26, true)
			if (v.getUint32(o, true) === v.getUint32(o + 4, true) || v.getUint32(o + 4, true) === 0 ||
				v.getUint16(o + 20, true) >= 1024 || (frames === 0 ? frame !== 0 || milliseconds !== 0 : frame >= frames || milliseconds === 0))
				throw new SnapshotDecodeError('deployments: invalid source or make-frame fact')
		}
		if (count === 0) return null
		const result = s.deployments ?? { count: 0, byteOffset: 0, view: v }
		result.count = count; result.byteOffset = offset + 4; result.view = v
		return result
	}

	private decodeWorld(s: Snapshot): WorldView | null {
		const sec = s.sections.get(SectionId.world)
		if (!sec) return s.world
		const [o] = sec
		const v = s.view
		const w = s.world ?? ({} as WorldView)
		w.boundsLeft = v.getInt32(o, true)
		w.boundsTop = v.getInt32(o + 4, true)
		w.boundsRight = v.getInt32(o + 8, true)
		w.boundsBottom = v.getInt32(o + 12, true)
		w.cellSize = v.getUint32(o + 16, true)
		w.renderPlayer = v.getUint16(o + 20, true)
		w.mapState = v.getUint8(o + 22)
		w.sessionState = v.getUint8(o + 23)
		w.environmentPresent = v.getUint32(o + 24, true) !== 0
		if (w.environmentPresent) {
			const environment = w.environment ?? {
				timeOfDay: 0,
				weatherKind: 0,
				weatherIntensity: 0,
				windDirection: 0,
				windSpeed: 0,
			}
			environment.timeOfDay = v.getUint16(o + 28, true)
			environment.weatherKind = v.getUint16(o + 30, true)
			environment.weatherIntensity = v.getUint16(o + 32, true)
			environment.windDirection = v.getUint16(o + 34, true)
			environment.windSpeed = v.getUint16(o + 36, true)
			w.environment = environment
		} else w.environment = null
		return w
	}

	private decodeTerrainStatic(s: Snapshot, layout: SnapshotLayoutCache): TerrainStaticView {
		const [o] = s.sections.get(SectionId.terrainStatic)!
		const v = s.view
		const w = v.getUint32(o, true)
		const h = v.getUint32(o + 4, true)
		const n = w * h
		if (s.terrainStatic !== null && layout.terrainOffset === o &&
			layout.terrainWidth === w && layout.terrainHeight === h)
			return s.terrainStatic

		let p = o + 8
		const take = (): Uint8Array => {
			const a = new Uint8Array(s.buffer, s.byteOffset + p, n)
			p = align4(p + n)
			return a
		}
		const terrain = s.terrainStatic ?? ({} as TerrainStaticView)
		terrain.w = w
		terrain.h = h
		terrain.type = take()
		terrain.height = take()
		terrain.ramp = take()
		terrain.passability = take()
		terrain.resource = take()
		terrain.surface = take()
		layout.terrainOffset = o
		layout.terrainWidth = w
		layout.terrainHeight = h
		return terrain
	}

	private decodeResources(s: Snapshot, layout: SnapshotLayoutCache): ResourcesView | null {
		const section = s.sections.get(SectionId.resources)
		if (!section) return null
		const [offset, length] = section
		if ((offset & 3) !== 0 || offset < HEADER_BYTES + s.sections.size * SECTION_ENTRY_BYTES)
			throw new SnapshotDecodeError('resource section is unaligned or overlaps the header')
		if (length < 8) throw new SnapshotDecodeError('resource section header is truncated')
		const w = s.view.getUint16(offset, true)
		const h = s.view.getUint16(offset + 2, true)
		const count = w * h
		const world = s.world
		if (w === 0 || h === 0 || !world ||
			w !== world.boundsRight - world.boundsLeft || h !== world.boundsBottom - world.boundsTop)
			throw new SnapshotDecodeError('resource dimensions do not match world bounds')
		if (length !== align4(8 + count * 3))
			throw new SnapshotDecodeError(`resource section length ${length} does not fit ${w}x${h} grid`)
		const resources = s.resources ?? ({} as ResourcesView)
		if (!s.resources || layout.resourcesOffset !== offset || layout.resourcesWidth !== w || layout.resourcesHeight !== h) {
			resources.w = w
			resources.h = h
			resources.type = new Uint8Array(s.buffer, s.byteOffset + offset + 8, count)
			resources.density = new Uint8Array(s.buffer, s.byteOffset + offset + 8 + count, count)
			resources.maxDensity = new Uint8Array(s.buffer, s.byteOffset + offset + 8 + count * 2, count)
			layout.resourcesOffset = offset
			layout.resourcesWidth = w
			layout.resourcesHeight = h
		}
		resources.revision = s.view.getUint32(offset + 4, true)
		return resources
	}

	private decodeActors(s: Snapshot, layout: SnapshotLayoutCache): ActorsView | null {
		const sec = s.sections.get(SectionId.actors)
		if (!sec) return s.actors
		const [o, bytes] = sec
		const v = s.view
		const n = v.getUint32(o, true)
		const turretTotal = v.getUint32(o + 4, true)
		const a = s.actors ?? ({} as ActorsView)
		a.count = n
		a.turretTotal = turretTotal

		// A count or offset change changes every following byte range, so rebuild the
		// complete view set atomically. In steady state this branch is never entered.
		if (s.actors !== null && layout.actorsOffset === o &&
			layout.actorCount === n && layout.turretTotal === turretTotal && layout.actorBytes === bytes)
			return a

		// Arrays are emitted widest-first so each stays naturally aligned without
		// interior padding — see ARCHITECTURE.md §4.5 for the canonical order.
		let p = o + 8
		const u32 = (): Uint32Array => {
			const a = new Uint32Array(s.buffer, s.byteOffset + p, n)
			p += n * 4
			return a
		}
		const i32 = (): Int32Array => {
			const a = new Int32Array(s.buffer, s.byteOffset + p, n)
			p += n * 4
			return a
		}
		const u16 = (): Uint16Array => {
			const a = new Uint16Array(s.buffer, s.byteOffset + p, n)
			p += n * 2
			return a
		}
		const u8 = (): Uint8Array => {
			const a = new Uint8Array(s.buffer, s.byteOffset + p, n)
			p += n
			return a
		}

		const id = u32()
		const posX = i32()
		const posY = i32()
		const posZ = i32()
		const typeId = u16()
		const facing = u16()
		const animState = u16()
		const prodProgress = u16()
		const turretOffset = u16()
		const speed = u16()
		p = align4(p)
		const owner = u8()
		const health = u8()
		const cargo = u8()
		const turretCount = u8()
		const flags = u8()
		const surface = u8()
		const ammo = u8()
		const cargoReserved = u8()
		const veterancy = u8()
		p = align4(p)
		const displayTypeId = u16()
		p = align4(p)
		const turretFacing = new Uint16Array(s.buffer, s.byteOffset + p, turretTotal)

		a.id = id
		a.posX = posX
		a.posY = posY
		a.posZ = posZ
		a.typeId = typeId
		a.displayTypeId = displayTypeId
		a.facing = facing
		a.animState = animState
		a.prodProgress = prodProgress
		a.turretOffset = turretOffset
		a.speed = speed
		a.owner = owner
		a.health = health
		a.cargo = cargo
		a.turretCount = turretCount
		a.flags = flags
		a.surface = surface
		a.ammo = ammo
		a.cargoReserved = cargoReserved
		a.veterancy = veterancy
		a.turretFacing = turretFacing
		p = align4(p + turretTotal * 2)
		a.crashParentId = bytes >= p - o + n * 4 ? new Uint32Array(s.buffer,s.byteOffset+p,n) : null
		layout.actorBytes = bytes
		layout.actorsOffset = o
		layout.actorCount = n
		layout.turretTotal = turretTotal
		return a
	}

	private decodeProjectiles(s: Snapshot, layout: SnapshotLayoutCache): ProjectilesView | null {
		const sec = s.sections.get(SectionId.projectiles)
		if (!sec) return s.projectiles
		const [o] = sec
		const n = s.view.getUint32(o, true)
		const pr = s.projectiles ?? ({} as ProjectilesView)
		pr.count = n
		if (s.projectiles !== null && layout.projectilesOffset === o && layout.projectileCount === n && layout.projectileBytes === sec[1])
			return pr

		let p = o + 4
		const u32 = (): Uint32Array => {
			const a = new Uint32Array(s.buffer, s.byteOffset + p, n)
			p += n * 4
			return a
		}
		const i32 = (): Int32Array => {
			const a = new Int32Array(s.buffer, s.byteOffset + p, n)
			p += n * 4
			return a
		}
		const i16 = (): Int16Array => {
			const a = new Int16Array(s.buffer, s.byteOffset + p, n)
			p += n * 2
			return a
		}
		const u16 = (): Uint16Array => {
			const a = new Uint16Array(s.buffer, s.byteOffset + p, n)
			p += n * 2
			return a
		}
		const u8 = (): Uint8Array => {
			const a = new Uint8Array(s.buffer, s.byteOffset + p, n)
			p += n
			return a
		}
		// Order is the emitter's write order and the alignment is load-bearing: the four u32/i32
		// blocks are 32n bytes, so the i16 block starts 4-aligned and the u16 block starts on an
		// even byte for every n. Inserting a field anywhere but at a 4-byte boundary would make
		// `new Int32Array(buffer, offset, n)` throw on the first odd count.
		pr.id = u32()
		pr.sourceActorId = u32()
		pr.posX = i32()
		pr.posY = i32()
		pr.posZ = i32()
		pr.tgtX = i32()
		pr.tgtY = i32()
		pr.tgtZ = i32()
		pr.velX = i16()
		pr.velY = i16()
		pr.velZ = i16()
		pr.typeId = u16()
		pr.remainingTicks = u16()
		pr.kind = u8()
		p = (p + 3) & ~3
		if (p + n * 20 <= o + sec[1]) {
			pr.launchX=i32();pr.launchY=i32();pr.launchZ=i32();pr.launchShot=u32()
			pr.launchArmament=u16();pr.launchBarrel=u16()
		} else {
			pr.launchX=pr.launchY=pr.launchZ=undefined
			pr.launchShot=undefined;pr.launchArmament=pr.launchBarrel=undefined
		}
		layout.projectileBytes=sec[1]
		layout.projectilesOffset = o
		layout.projectileCount = n
		return pr
	}

	private decodeFrozenActors(s: Snapshot, layout: SnapshotLayoutCache): FrozenActorsView | null {
		const sec = s.sections.get(SectionId.frozenActors)
		if (!sec) return s.frozenActors
		const [o] = sec
		const n = s.view.getUint32(o, true)
		const frozen = s.frozenActors ?? ({} as FrozenActorsView)
		frozen.count = n
		if (s.frozenActors !== null && layout.frozenActorsOffset === o && layout.frozenActorCount === n)
			return frozen

		let p = o + 4
		frozen.id = new Uint32Array(s.buffer, s.byteOffset + p, n); p += n * 4
		frozen.posX = new Int32Array(s.buffer, s.byteOffset + p, n); p += n * 4
		frozen.posY = new Int32Array(s.buffer, s.byteOffset + p, n); p += n * 4
		frozen.posZ = new Int32Array(s.buffer, s.byteOffset + p, n); p += n * 4
		frozen.typeId = new Uint16Array(s.buffer, s.byteOffset + p, n); p += n * 2
		p = align4(p)
		frozen.owner = new Uint8Array(s.buffer, s.byteOffset + p, n); p += n
		frozen.health = new Uint8Array(s.buffer, s.byteOffset + p, n)
		layout.frozenActorsOffset = o
		layout.frozenActorCount = n
		return frozen
	}

	private decodeLifecycle(s: Snapshot, layout: SnapshotLayoutCache): void {
		const sec = s.sections.get(SectionId.lifecycle)
		if (!sec) {
			s.lifecycle.length = 0
			return
		}
		const [o] = sec
		const v = s.view
		const n = v.getUint32(o, true)
		for (let i = 0; i < n; i++) {
			const e = o + 4 + i * 8
			const entry = layout.lifecycle[i] ?? (layout.lifecycle[i] = {} as LifecycleEntry)
			entry.actorId = v.getUint32(e, true)
			entry.typeId = v.getUint16(e + 4, true)
			entry.kind = v.getUint8(e + 6)
			entry.owner = v.getUint8(e + 7)
			s.lifecycle[i] = entry
		}
		s.lifecycle.length = n
	}

	private decodeShroud(s: Snapshot, layout: SnapshotLayoutCache): void {
		const sec = s.sections.get(SectionId.shroud)
		if (!sec) {
			s.shroud.length = 0
			return
		}
		const [o] = sec
		const v = s.view
		const n = v.getUint32(o, true)
		for (let i = 0; i < n; i++) {
			const e = o + 4 + i * 8
			const run = layout.shroud[i] ?? (layout.shroud[i] = {} as ShroudRun)
			run.cellIndex = v.getUint32(e, true)
			run.runLength = v.getUint16(e + 4, true)
			run.state = v.getUint8(e + 6)
			s.shroud[i] = run
		}
		s.shroud.length = n
	}

	private decodeEvents(s: Snapshot, layout: SnapshotLayoutCache): void {
		const sec = s.sections.get(SectionId.events)
		if (!sec) {
			s.events.length = 0
			return
		}
		const [o, len] = sec
		const v = s.view
		const n = v.getUint32(o, true)
		let p = o + 4
		const end = o + len
		let decoded = 0
		for (let i = 0; i < n && p + 4 <= end; i++) {
			const kind = v.getUint16(p, true)
			const byteLength = v.getUint16(p + 2, true)
			// Records are self-describing so an unknown kind is skippable — this is what
			// lets `bridge` add an event without breaking a consumer built against an
			// older table. Never switch on kind without a default that skips.
			const event = layout.events[i] ?? (layout.events[i] = {} as SnapshotEvent)
			event.kind = kind
			event.offset = p + 4
			event.byteLength = byteLength
			s.events[i] = event
			decoded++
			p = align4(p + 4 + byteLength)
		}
		s.events.length = decoded
	}

	private decodePlayers(s: Snapshot, layout: SnapshotLayoutCache): void {
		const sec = s.sections.get(SectionId.player)
		if (!sec) {
			s.players.length = 0
			return
		}
		const [o, len] = sec
		const v = s.view
		const n = v.getUint32(o, true)
		const end = o + len
		let p = o + 4
		for (let i = 0; i < n; i++) {
			if (p + 36 > end)
				throw new SnapshotDecodeError(`player ${i} fixed record overruns section`)
			const player = layout.players[i] ?? (layout.players[i] = { queues: [] } as unknown as PlayerView)
			player.cash = v.getUint32(p, true)
			player.resources = v.getUint32(p + 4, true)
			player.powerSupplied = v.getInt16(p + 8, true)
			player.powerDrawn = v.getInt16(p + 10, true)
			player.id = i
			player.clientIndex = v.getInt32(p + 12, true)
			player.factionId = v.getUint16(p + 16, true)
			player.teamId = v.getInt16(p + 18, true)
			player.relation = v.getUint8(p + 20)
			player.flags = v.getUint8(p + 21)
			player.red = v.getUint8(p + 22)
			player.green = v.getUint8(p + 23)
			player.blue = v.getUint8(p + 24)
			player.alpha = v.getUint8(p + 25)
			const rawScore = v.getUint32(p + 26, true)
			player.score = rawScore === 0xffffffff ? null : rawScore
			const queueCount = v.getUint16(p + 30, true)
			p += 36
			if (p + queueCount * 8 > end)
				throw new SnapshotDecodeError(`player ${i} queue records overrun section`)
			for (let q = 0; q < queueCount; q++) {
				const queue = player.queues[q] ?? (player.queues[q] = {} as PlayerQueueView)
				queue.queueId = v.getUint16(p, true)
				queue.actorType = v.getUint16(p + 2, true)
				queue.progressPermille = v.getUint16(p + 4, true)
				queue.itemsQueued = v.getUint16(p + 6, true)
				p += 8
			}
			player.queues.length = queueCount
			s.players[i] = player
		}
		s.players.length = n
	}

	private decodeProduction(s: Snapshot, layout: SnapshotLayoutCache): void {
		const sec = s.sections.get(SectionId.production)
		if (!sec) {
			s.production.length = 0
			return
		}
		const [o, len] = sec
		const v = s.view
		const n = v.getUint32(o, true)
		const end = o + len
		let p = o + 4
		for (let i = 0; i < n; i++) {
			if (p + 12 > end)
				throw new SnapshotDecodeError(`production queue ${i} header overruns section`)
			const queue = layout.production[i] ?? (layout.production[i] = { items: [] } as unknown as ProductionQueueView)
			queue.playerId = v.getUint8(p)
			queue.queueId = v.getUint8(p + 1)
			queue.flags = v.getUint8(p + 2)
			queue.kind = v.getUint8(p + 3)
			queue.currentActorType = v.getUint16(p + 4, true)
			queue.progressPermille = v.getUint16(p + 6, true)
			queue.itemsQueued = v.getUint16(p + 8, true)
			const itemCount = v.getUint16(p + 10, true)
			p += 12
			if (p + itemCount * 12 > end)
				throw new SnapshotDecodeError(`production queue ${i} items overrun section`)
			for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
				const item = queue.items[itemIndex] ?? (queue.items[itemIndex] = {} as ProductionItemView)
				item.actorType = v.getUint16(p, true)
				item.flags = v.getUint16(p + 2, true)
				item.cost = v.getUint32(p + 4, true)
				item.buildTicks = v.getUint16(p + 8, true)
				item.queued = v.getUint16(p + 10, true)
				p += 12
			}
			queue.items.length = itemCount
			s.production[i] = queue
		}
		s.production.length = n
	}
}

interface SnapshotLayoutCache {
	buffer: ArrayBufferLike
	sections: Map<number, [number, number]>
	sectionOrder: number[]
	terrainOffset: number
	terrainWidth: number
	terrainHeight: number
	resourcesOffset: number
	resourcesWidth: number
	resourcesHeight: number
	actorsOffset: number
	actorBytes: number
	actorCount: number
	turretTotal: number
	projectilesOffset: number
	projectileBytes: number
	projectileCount: number
	frozenActorsOffset: number
	frozenActorCount: number
	lifecycle: LifecycleEntry[]
	shroud: ShroudRun[]
	events: SnapshotEvent[]
	players: PlayerView[]
	production: ProductionQueueView[]
}

function emptyLayoutCache(buffer: ArrayBufferLike): SnapshotLayoutCache {
	return {
		buffer,
		sections: new Map(),
		sectionOrder: [],
		terrainOffset: -1,
		terrainWidth: -1,
		terrainHeight: -1,
		resourcesOffset: -1,
		resourcesWidth: -1,
		resourcesHeight: -1,
		actorsOffset: -1,
		actorBytes: -1,
		actorCount: -1,
		turretTotal: -1,
		projectilesOffset: -1,
		projectileBytes: -1,
		projectileCount: -1,
		frozenActorsOffset: -1,
		frozenActorCount: -1,
		lifecycle: [],
		shroud: [],
		events: [],
		players: [],
		production: [],
	}
}

function emptySnapshot(bytes: Uint8Array): Snapshot {
	return {
		valid: false,
		tick: 0,
		syncHash: 0,
		gameTimeMs: 0,
		flags: 0,
		byteLength: 0,
		buffer: bytes.buffer,
		byteOffset: bytes.byteOffset,
		view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
		world: null,
		terrainStatic: null,
		resources: null,
		actors: null,
		frozenActors: null,
		projectiles: null,
		deployments: null,
		actorStatus: null,
		lifecycle: [],
		shroud: [],
		events: [],
		players: [],
		production: [],
		sections: new Map(),
	}
}

// ---------------------------------------------------------------------------
// Interpolation helpers. Interpolation is not optional (ARCHITECTURE.md §3) — the
// sim ticks at 25 Hz and we render at display rate.
// ---------------------------------------------------------------------------

/**
 * Interpolate a WAngle on the SHORTEST arc. A unit rotating through 1023 -> 0 must not
 * spin the long way round; that reads as a glitch and it is the single most common way
 * an interpolated RTS looks broken.
 */
export function lerpFacing(a: number, b: number, t: number): number {
	let d = b - a
	if (d > WANGLE_TURN / 2) d -= WANGLE_TURN
	else if (d < -WANGLE_TURN / 2) d += WANGLE_TURN
	const r = a + d * t
	return ((r % WANGLE_TURN) + WANGLE_TURN) % WANGLE_TURN
}

/**
 * OpenRA WAngle is counterclockwise from north: 0=N, 256=W, 512=S, 768=E.
 * This matches WVec.Yaw (ArcTan(-Y, X) - 256), not sprite-sheet frame ordering.
 * STEELSEED meshes point along local +X and map simulation Y to render +Z.
 * This is the single conversion used by hulls, turrets, muzzle FX and projectiles.
 */
export function wangleToRadians(w: number): number {
	return Math.PI * 0.5 + (w / WANGLE_TURN) * Math.PI * 2
}

/**
 * Binary search for an actor id in a snapshot's `id` array. Actors are ordered by
 * ascending id every tick (§4.5), so prev-to-curr matching is a merge or a bsearch,
 * never a per-tick hash map — building one of those every tick would violate rule 6.
 */
export function findActorIndex(view: ActorsView, id: number): number {
	let lo = 0
	let hi = view.count - 1
	const ids = view.id
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const v = ids[mid]
		if (v === id) return mid
		if (v < id) lo = mid + 1
		else hi = mid - 1
	}
	return -1
}
