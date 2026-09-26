// Supply crates as a visible client overlay.
//
// WHY: the CRATE actor is a sprite actor (RenderSprites: Image: scrate) — it has no
// authored mesh slot, so the unit buckets never drew it and players walked rewards
// without ever seeing the box. This overlay draws a small supply crate over every
// visible crate actor, riding `captureActorVisual` like the parachute canopies do.
//
// The REWARD stays engine-side (GiveCash 50%, LevelUp 40%, explode 10%, hide-map 5%,
// heal 2%, reveal 1%, duplicate unit) — this overlay only makes the box findable.

import { Mesh } from '../geo/mesh'
import * as sdf from '../geo/sdf'
import type { Ctx, Snapshot } from '../core'
import type { DrawItem, GpuMesh, RenderApi } from './types'

const MAX_CRATES = 32
const CRATE_HALF_M = 0.45

export class CrateMarkers {
	private mesh: GpuMesh | null = null
	private item: DrawItem | null = null
	private readonly matrices = new Float32Array(MAX_CRATES * 16)
	private readonly transform = new Float32Array(16)
	private readonly capture = { mesh: null as GpuMesh | null, surfaceSet: '', playerColor: 0 }

	readonly stats = { drawn: 0 }

	init(render: RenderApi): void {
		if (this.mesh) return
		// A wooden supply box: body, lid slab proud of the top, and a golden band that
		// reads as "pickup" at RTS zoom even in the dark.
		const body = sdf.translate(
			sdf.box(CRATE_HALF_M, CRATE_HALF_M, CRATE_HALF_M * 0.7), 0, 0, -CRATE_HALF_M * 0.1)
		const lid = sdf.translate(
			sdf.box(CRATE_HALF_M * 1.05, CRATE_HALF_M * 1.05, CRATE_HALF_M * 0.12), 0, 0, CRATE_HALF_M * 0.8)
		const band = sdf.translate(
			sdf.box(CRATE_HALF_M * 1.06, CRATE_HALF_M * 0.06, CRATE_HALF_M * 0.8), 0, 0, -CRATE_HALF_M * 0.05)
		const shape = sdf.union(body, lid, band)
		const mesh = new Mesh()
		sdf.surfaceNets(
			shape,
			sdf.setAabb(sdf.aabb(), -CRATE_HALF_M * 1.2, -CRATE_HALF_M * 1.2, -CRATE_HALF_M * 1.2, CRATE_HALF_M * 1.2, CRATE_HALF_M * 1.2, CRATE_HALF_M * 1.2),
			24,
			mesh,
			{ creaseAngle: 38, seal: true },
		)
		this.mesh = render.upload(mesh, 'fx:crate')
		this.item = {
			mesh: this.mesh,
			surfaceSet: 'foundry',
			instances: this.matrices,
			instanceCount: 0,
			playerColors: null,
			castsShadow: false,
		}
	}

	dispose(): void {
		this.mesh = null
		this.item = null
	}

	/**
	 * One instanced draw over every visible crate actor. The typeName filter runs off the
	 * authoritative type table, so no manifest lookup happens on this hot path.
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
	): void {
		if (!this.item || !this.mesh) this.init(render)
		const item = this.item as { -readonly [K in keyof DrawItem]: DrawItem[K] }
		let count = 0
		for (let i = 0; i < actors.count && count < MAX_CRATES; i++) {
			if (ctx.actorTypeName(actors.typeId[i]).toLowerCase() !== 'crate') continue
			if (!units.captureActorVisual(actors.id[i], this.transform, 0, this.capture)) continue
			const o = count * 16
			this.matrices.set(this.transform, o)
			this.matrices[o + 13] += 0.05
			count++
		}
		item.instanceCount = count
		// Submit only real draws: render.submit counts an instanceCount<=0 item as a
		// dropped draw in stats.dropped (§12.2), so an unconditional submit made every
		// crate-free world report 1 phantom dropped item per frame (depthgate asserts
		// dropped===0). Match the count>0 guard the other submit sites use.
		if (count > 0) render.submit(item)
		this.stats.drawn = count
	}

	clear(): void {
		const item = this.item as { -readonly [K in keyof DrawItem]: DrawItem[K] } | null
		if (item) item.instanceCount = 0
	}
}
