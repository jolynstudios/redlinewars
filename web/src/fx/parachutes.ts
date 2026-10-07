// Parachute canopies over actors the snapshot flags as parachuting.
//
// WHY HERE AND NOT IN `units`: the canopy is a CLIENT overlay on top of the authoritative
// placement — `captureActorVisual` hands out the exact interpolated transform the hull
// already renders with, so the canopy rides the descent for free, and the bounded
// instanced draw keeps an eight-team drop inside one extra draw call.
//
// WHY THE LOOK IS ONE MESH: a hemisphere canopy plus four thin shroud capsules meshed in
// one SDF pass, on the pale snow surface set — the same white the original chute reads
// against sky and ground. Per-instance colour stays off: white chutes, full stop.

import { Mesh } from '../geo/mesh'
import * as sdf from '../geo/sdf'
import type { Ctx, Snapshot } from '../core'
import type { DrawItem, GpuMesh, RenderApi } from './types'

const MAX_PARACHUTES = 64
/** Canopy radius the mesh is authored at; CANOPY_SCALE sizes it to the world. */
const CANOPY_RADIUS_M = 0.85
/**
 * The canopy never ran live until the bridge set the parachuting flag, and then it drew a
 * two-metre white ball over a soldier a third of a metre tall: it took the soldier's own
 * instance scale and rode 1.55 m above him. Now it is its own size, about a soldier's height
 * across, with the shroud lines ending at his shoulders.
 */
const CANOPY_SCALE = 0.42
/** Canopy centre above the jumper's drawn origin, in world metres. */
const CANOPY_LIFT_M = 0.62
/**
 * A parabomb's chute: RA's ParaBomb falls at 50 WPos a tick under an opened parachute
 * (GravityBomb, OpenSequence open), a little smaller than a jumper's, riding just above the bomb.
 */
const BOMB_CANOPY_SCALE = 0.34
const BOMB_CANOPY_LIFT_M = 0.5
/** The dome is the cap of a sphere above this fraction of its radius. */
const DOME_CUT = 0.35
/** ActorFlag.parachuting — bit 2 of the actors-section flags byte. */
const FLAG_PARACHUTING = 4

export class ParachuteCanopies {
	private mesh: GpuMesh | null = null
	private item: DrawItem | null = null
	private readonly matrices = new Float32Array(MAX_PARACHUTES * 16)
	private readonly transform = new Float32Array(16)
	private readonly capture = { mesh: null as GpuMesh | null, surfaceSet: '', playerColor: 0 }
	private count = 0

	readonly stats = { drawn: 0, actors: 0, bombs: 0 }

	init(render: RenderApi): void {
		if (this.mesh) return
		// Dome: a sphere clipped just below its equator; the SDF surface-net seals the cut.
		// Four thin shroud capsules run from the canopy rim down to the jumper's shoulders.
		const rim = CANOPY_RADIUS_M * Math.sqrt(1 - DOME_CUT * DOME_CUT)
		const chute = (ax: number, az: number) => sdf.capsule(ax, CANOPY_RADIUS_M * DOME_CUT, az, 0, -0.9, 0, 0.045)
		const shape = sdf.union(
			// A cap, not a ball: the sphere above DOME_CUT of its radius (plane: inside is above).
			sdf.intersect(sdf.sphere(CANOPY_RADIUS_M), sdf.plane(0, -1, 0, -CANOPY_RADIUS_M * DOME_CUT)),
			chute(Math.cos(Math.PI / 4) * rim, Math.sin(Math.PI / 4) * rim),
			chute(Math.cos(3 * Math.PI / 4) * rim, Math.sin(3 * Math.PI / 4) * rim),
			chute(Math.cos(5 * Math.PI / 4) * rim, Math.sin(5 * Math.PI / 4) * rim),
			chute(Math.cos(7 * Math.PI / 4) * rim, Math.sin(7 * Math.PI / 4) * rim),
		)
		const mesh = new Mesh()
		sdf.surfaceNets(
			shape,
			sdf.setAabb(sdf.aabb(), -CANOPY_RADIUS_M - 0.1, -0.95, -CANOPY_RADIUS_M - 0.1, CANOPY_RADIUS_M + 0.1, CANOPY_RADIUS_M + 0.1, CANOPY_RADIUS_M + 0.1),
			26,
			mesh,
			{ creaseAngle: 40, seal: true },
		)
		if (mesh.vertexCount === 0) throw new Error('fx: the parachute canopy meshed to zero vertices')
		this.mesh = render.upload(mesh, 'fx:parachute')
		this.item = {
			mesh: this.mesh,
			surfaceSet: 'snow',
			instances: this.matrices,
			instanceCount: 0,
			playerColors: null,
			castsShadow: false,
		}
	}

	dispose(): void {
		this.mesh = null
		this.item = null
		this.count = 0
	}

	/**
	 * One instanced draw over every parachuting actor. The transform is the actor's own
	 * captured placement lifted by its selection height plus the ride height, so the canopy
	 * crowns the hull the way the health bars crown it. Allocation-free per frame: one
	 * transform scratch and one capture record, reused.
	 */
	update(
		ctx: Ctx,
		actors: NonNullable<Snapshot['actors']>,
		units: {
			selectionHeightM(typeId: number): number
			captureActorVisual(actorId: number, transform: Float32Array, offset: number,
				out: { mesh: unknown; surfaceSet: string; playerColor: number }): boolean
		},
		render: RenderApi,
		bombs?: { readonly count: number; readonly x: Float32Array; readonly y: Float32Array; readonly z: Float32Array },
	): void {
		if (!this.item || !this.mesh) this.init(render)
		const item = this.item as { -readonly [K in keyof DrawItem]: DrawItem[K] }
		let count = 0
		for (let i = 0; i < actors.count && count < MAX_PARACHUTES; i++) {
			if ((actors.flags[i] & FLAG_PARACHUTING) === 0) continue
			if (!units.captureActorVisual(actors.id[i], this.transform, 0, this.capture)) continue
			// The jumper's drawn position, with the canopy's own scale; a round canopy needs no yaw.
			const o = count * 16, m = this.matrices, t = this.transform
			m.fill(0, o, o + 16)
			m[o] = CANOPY_SCALE; m[o + 5] = CANOPY_SCALE; m[o + 10] = CANOPY_SCALE; m[o + 15] = 1
			m[o + 12] = t[12]; m[o + 13] = t[13] + CANOPY_LIFT_M; m[o + 14] = t[14]
			count++
		}
		// Parabombs in flight: already shroud-gated and placed by fx/projectiles.
		let bombCount = 0
		for (let k = 0; bombs && k < bombs.count && count < MAX_PARACHUTES; k++) {
			const o = count * 16, m = this.matrices
			m.fill(0, o, o + 16)
			m[o] = BOMB_CANOPY_SCALE; m[o + 5] = BOMB_CANOPY_SCALE; m[o + 10] = BOMB_CANOPY_SCALE; m[o + 15] = 1
			m[o + 12] = bombs.x[k]; m[o + 13] = bombs.y[k] + BOMB_CANOPY_LIFT_M; m[o + 14] = bombs.z[k]
			count++
			bombCount++
		}
		this.stats.bombs = bombCount
		item.instanceCount = count
		// Submit only real draws: render.submit counts an instanceCount<=0 item as a
		// dropped draw in stats.dropped (§12.2), so an unconditional submit made every
		// parachute-free world report 1 phantom dropped item per frame (depthgate
		// asserts dropped===0). Match the count>0 guard the other submit sites use.
		if (count > 0) render.submit(item)
		this.count = count
		this.stats.drawn = count
		this.stats.actors = actors.count
	}

	clear(): void {
		this.count = 0
		const item = this.item as { -readonly [K in keyof DrawItem]: DrawItem[K] } | null
		if (item) item.instanceCount = 0
	}
}
