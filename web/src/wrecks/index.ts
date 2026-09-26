// STEELSEED — wrecks
// Persistent, authoritative battlefield remains.
//
// A wreck is presentation-owned state: losing it cannot move, resurrect or otherwise change
// a simulation actor. `units` supplies the immutable mesh plus the
// last transform it really submitted. That preserves the actor's authored silhouette, its
// four-point terrain contact and its faction material instead of replacing every casualty
// with one generic scrap pile.
// Animated organic/vehicle deaths now belong to the bounded fall/breakup/fade path, not
// this persistent intact-mesh cache. See the September 2026 architecture amendment.

import { CoreEvent, SimEvent, type Ctx, type Snapshot, type SnapshotEvent } from '../core'
import type { ActorVisualCapture, DrawItem, GpuMesh, RenderApi, ShroudApi, UnitsApi } from './types'

const WPOS_TO_M = 1 / 1024
const DESTROYED_PAYLOAD_BYTES = 18
/** Global persistence cap. The oldest wreck is recoverably evicted when a match exceeds it. */
const MAX_WRECKS = 256
/** Per-archetype draw compaction cap; 32 identical visible casualties still share one draw. */
const MAX_VISIBLE_PER_VISUAL = 32

interface WreckBucket {
	readonly mesh: GpuMesh
	readonly surfaceSet: string
	readonly instances: Float32Array
	readonly colors: Uint8Array
	readonly motionIds: Uint32Array
	readonly damages: Float32Array
	readonly item: DrawItem
	count: number
}

export interface WreckStats {
	readonly retained: number
	readonly visible: number
	readonly drawSubmissions: number
	readonly acceptedEvents: number
	readonly missedVisuals: number
	readonly evicted: number
	readonly clippedVisible: number
	readonly malformedEvents: number
	/** Wrecks that bound an authored Dead rung instead of the last-drawn intact silhouette. */
	readonly deadRungBound: number
}

type MutableWreckStats = { -readonly [K in keyof WreckStats]: WreckStats[K] }

export interface WrecksApi {
	readonly stats: WreckStats
}

export class Wrecks implements WrecksApi {
	static id = 'wrecks'
	static deps = ['render', 'units', 'shroud']

	private render: RenderApi | null = null
	private units: UnitsApi | null = null
	private shroud: ShroudApi | null = null
	private ctx: Ctx | null = null
	private offDestroyed: (() => void) | null = null
	private offNewWorld: (() => void) | null = null

	private readonly bucketByMesh = new Map<GpuMesh, number>()
	private readonly buckets: WreckBucket[] = []
	private readonly actorId = new Uint32Array(MAX_WRECKS)
	private readonly bucketIndex = new Uint16Array(MAX_WRECKS)
	private readonly x = new Float32Array(MAX_WRECKS)
	private readonly z = new Float32Array(MAX_WRECKS)
	private readonly transforms = new Float32Array(MAX_WRECKS * 16)
	private readonly colors = new Uint8Array(MAX_WRECKS)
	private readonly capture: ActorVisualCapture = { mesh: null, surfaceSet: 'foundry', playerColor: 0, boneCount: 0, paletteBase: 0 }
	private readonly captureTransform = new Float32Array(16)
	private count = 0
	private nextEviction = 0

	readonly stats: MutableWreckStats = {
		retained: 0,
		visible: 0,
		drawSubmissions: 0,
		acceptedEvents: 0,
		missedVisuals: 0,
		evicted: 0,
		clippedVisible: 0,
		malformedEvents: 0,
		deadRungBound: 0,
	}

	init(ctx: Ctx): void {
		this.ctx = ctx
		this.render = ctx.get<RenderApi>('render')
		this.units = ctx.get<UnitsApi>('units')
		this.shroud = ctx.get<ShroudApi>('shroud')
		this.units.visitVisuals(this.addVisual)
		this.offDestroyed = ctx.events.on<SnapshotEvent>(SimEvent.actorDestroyed, this.onDestroyed)
		this.offNewWorld = ctx.events.on(CoreEvent.newWorld, this.clear)
	}

	/**
	 * Drop every retained wreck. A new match must not inherit the previous battlefield:
	 * these meshes are presentation-owned and survive until this is called.
	 */
	readonly clear = (): void => {
		this.count = 0
		this.nextEviction = 0
		this.stats.retained = 0
		this.stats.visible = 0
		this.stats.drawSubmissions = 0
		this.stats.clippedVisible = 0
	}

	onSnapshot(snap: Snapshot, prev: Snapshot | null, _ctx: Ctx): void {
		// Tick rewind is the same signal `units` uses for a new world, and catches a host
		// path that did not go through `session.startSkirmish`.
		if (prev && snap.tick < prev.tick) this.clear()
	}

	private readonly addVisual = (mesh: GpuMesh, surfaceSet: string): void => {
		if (this.bucketByMesh.has(mesh)) return
		const instances = new Float32Array(MAX_VISIBLE_PER_VISUAL * 16)
		const colors = new Uint8Array(MAX_VISIBLE_PER_VISUAL)
		const motionIds = new Uint32Array(MAX_VISIBLE_PER_VISUAL)
		const damages = new Float32Array(MAX_VISIBLE_PER_VISUAL)
		damages.fill(1)
		const item: DrawItem = {
			mesh,
			surfaceSet,
			instances,
			instanceCount: 0,
			playerColors: colors,
			paletteBases: null,
			motionIds,
			boneCount: 0,
			phases: null,
			damages,
			castsShadow: true,
		}
		this.bucketByMesh.set(mesh, this.buckets.length)
		this.buckets.push({ mesh, surfaceSet, instances, colors, motionIds, damages, item, count: 0 })
	}

	private readonly onDestroyed = (event: SnapshotEvent): void => {
		const view = this.ctx?.snapshot?.view
		const off = event?.offset
		if (
			event == null ||
			view === undefined ||
			!Number.isInteger(off) ||
			!Number.isInteger(event.byteLength) ||
			event.byteLength < DESTROYED_PAYLOAD_BYTES ||
			off < 0 ||
			off + DESTROYED_PAYLOAD_BYTES > view.byteLength
		) {
			this.stats.malformedEvents++
			return
		}

		const id = view.getUint32(off, true)
		const x = view.getInt32(off + 4, true) * WPOS_TO_M
		const z = view.getInt32(off + 8, true) * WPOS_TO_M
		const shroud = this.shroud
		// A hidden actor was never submitted by units and must not become remembered evidence.
		if (shroud !== null && !shroud.isVisible(Math.floor(x), Math.floor(z)))
			return

		const units = this.units
		if (units === null) return
		if (units.deathAltitudeOf?.(id) != null) return
		const deathKind = units.deathKindOf(id)
		// Structures already get a bounded collapse and fade from DeathVisuals. Keeping
		// their Dead rung here leaves an untargetable building on the map forever.
		if (deathKind === 5) return
		if (!units.captureActorVisual(id, this.captureTransform, 0, this.capture) || this.capture.mesh === null) {
			this.stats.missedVisuals++
			return
		}
		// THE DEAD RUNG IS THE REMAINS. This used to persist the mesh that was on screen a
		// frame ago and call that "preserving the authored silhouette" — which is precisely
		// why a destroyed building went on standing and could simply no longer be shot. When
		// the actor has an authored `.d5` that IS its authored silhouette, so bind it.
		//
		// The captured mesh is never the Dead rung itself: the destruction event is
		// republished before the snapshot that zeroes this actor's health, so what `units`
		// last drew is whichever rung its health had reached.
		const dead = units.deadRungOf(this.capture.mesh)
		if (dead !== null) {
			this.capture.mesh = dead.mesh
			this.capture.surfaceSet = dead.surfaceSet
			this.stats.deadRungBound++
		} else if (deathKind === 1 || deathKind === 2 || deathKind === 3) {
			// No authored remains. Animated organic deaths and detached vehicle parts have a
			// bounded fall/fade lifecycle of their own, and a second persistent copy would
			// leave a standing dead person behind or overlap OpenRA's own husk actor.
			return
		}
		const bucket = this.bucketByMesh.get(this.capture.mesh)
		if (bucket === undefined) {
			this.stats.missedVisuals++
			return
		}
		const slot = this.count < MAX_WRECKS ? this.count++ : this.nextEviction
		if (this.count === MAX_WRECKS && this.stats.retained === MAX_WRECKS) {
			this.nextEviction = (this.nextEviction + 1) % MAX_WRECKS
			this.stats.evicted++
		}
		this.actorId[slot] = id
		this.bucketIndex[slot] = bucket
		this.x[slot] = x
		this.z[slot] = z
		this.colors[slot] = this.capture.playerColor
		this.transforms.set(this.captureTransform, slot * 16)
		this.stats.acceptedEvents++
		this.stats.retained = this.count
	}

	update(_dt: number, _ctx: Ctx): void {
		const render = this.render
		const shroud = this.shroud
		if (render === null || shroud === null) return
		for (const bucket of this.buckets) bucket.count = 0
		this.stats.visible = 0
		this.stats.drawSubmissions = 0
		this.stats.clippedVisible = 0

		for (let i = 0; i < this.count; i++) {
			if (!shroud.isVisible(Math.floor(this.x[i]), Math.floor(this.z[i])))
				continue
			const bucket = this.buckets[this.bucketIndex[i]]
			if (bucket.count >= MAX_VISIBLE_PER_VISUAL) {
				this.stats.clippedVisible++
				continue
			}
			const n = bucket.count++
			const sourceOffset = i * 16
			const targetOffset = n * 16
			for (let j = 0; j < 16; j++) bucket.instances[targetOffset + j] = this.transforms[sourceOffset + j]
			bucket.colors[n] = this.colors[i]
			bucket.motionIds[n] = this.actorId[i]
			this.stats.visible++
		}

		for (const bucket of this.buckets) {
			if (bucket.count === 0) continue
			const mutable = bucket.item as { -readonly [K in keyof DrawItem]: DrawItem[K] }
			mutable.instanceCount = bucket.count
			render.submit(bucket.item)
			this.stats.drawSubmissions++
		}
	}

	dispose(): void {
		this.offDestroyed?.()
		this.offDestroyed = null
		this.offNewWorld?.()
		this.offNewWorld = null
		this.render = null
		this.units = null
		this.shroud = null
		this.ctx = null
		this.bucketByMesh.clear()
		this.buckets.length = 0
		this.count = 0
		this.nextEviction = 0
		for (const key of Object.keys(this.stats) as (keyof MutableWreckStats)[]) this.stats[key] = 0
	}
}

export default Wrecks
