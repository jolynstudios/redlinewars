// STEELSEED — fx/curtain-domes (vfx.md Epic 7 and §14)
//
// The Iron Curtain's visible state, on every preset: a translucent crimson field over each
// unit OpenRA holds invulnerable (actors.status kind 1), for exactly as long as it holds it.
// Crimson and steady, never fire-orange and never a flicker, so it reads as protection rather
// than damage (§14: "Iron Curtain should not look like fire damage"). The power had no
// visible state at all: the renderer has no per-instance tint, and the pale point light fx
// adds under the unit does not read in daylight. The remaining time is the UI's crimson bar.
//
// One instanced, unlit, translucent draw, like the selection rings; bounded, no allocation.
import { Mesh } from '../geo/mesh'
import * as sdf from '../geo/sdf'
import { ActorStatusKind, findActorIndex, type Ctx } from '../core'
import type { DrawItem, GpuMesh, RenderApi, ShroudApi, TerrainApi, UnitsApi } from './types'

const MAX_DOMES = 32
const WPOS_TO_M = 1 / 1024
/** The field clears the unit it covers: its footprint radius and height, with room around. */
const RADIUS_MARGIN = 1.3
const HEIGHT_MARGIN = 1.35
const FALLBACK_RADIUS_M = 0.7

export class CurtainDomes {
	private mesh: GpuMesh | null = null
	private item: DrawItem | null = null
	private readonly matrices = new Float32Array(MAX_DOMES * 16)
	/** Linear crimson. */
	private readonly color = Float32Array.of(0.8, 0.04, 0.1)
	readonly stats = { drawn: 0 }

	init(render: RenderApi): void {
		if (this.mesh) return
		// A unit sphere cut just below its equator by the meshing bounds: a sealed dome.
		const mesh = new Mesh()
		sdf.surfaceNets(sdf.sphere(1), sdf.setAabb(sdf.aabb(), -1.1, -0.02, -1.1, 1.1, 1.1, 1.1), 22, mesh, { creaseAngle: 40, seal: true })
		if (mesh.vertexCount === 0) throw new Error('fx: the curtain dome meshed to zero vertices')
		this.mesh = render.upload(mesh, 'fx:curtain-dome')
		this.item = { mesh: this.mesh, surfaceSet: 'snow', instances: this.matrices, instanceCount: 0, playerColors: null,
			castsShadow: false, opacity: 0.3, unlitColor: this.color }
	}

	update(ctx: Ctx, units: UnitsApi | null, render: RenderApi, terrain: TerrainApi, shroud: ShroudApi, time: number): void {
		if (!this.item) this.init(render)
		const item = this.item as { -readonly [K in keyof DrawItem]: DrawItem[K] }
		const status = ctx.snapshot?.actorStatus, actors = ctx.snapshot?.actors
		let n = 0
		if (status && actors) {
			for (let r = 0; r < status.count && n < MAX_DOMES; r++) {
				const o = status.byteOffset + r * 12
				if (status.view.getUint8(o + 4) !== ActorStatusKind.invulnerable) continue
				const i = findActorIndex(actors, status.view.getUint32(o, true))
				if (i < 0) continue
				const x = actors.posX[i] * WPOS_TO_M, z = actors.posY[i] * WPOS_TO_M
				if (!shroud.isVisible(Math.floor(x), Math.floor(z))) continue
				const radius = (units?.selectionRadiusM?.(actors.typeId[i]) ?? FALLBACK_RADIUS_M) * RADIUS_MARGIN
				const height = Math.max(radius * 0.7, (units?.selectionHeightM(actors.typeId[i]) ?? radius) * HEIGHT_MARGIN)
				const m = this.matrices, b = n * 16
				m.fill(0, b, b + 16)
				m[b] = radius; m[b + 5] = height; m[b + 10] = radius
				m[b + 12] = x; m[b + 13] = terrain.heightAt(x, z); m[b + 14] = z; m[b + 15] = 1
				n++
			}
		}
		// A slow breath of the whole field, never a flicker.
		item.opacity = 0.26 + 0.05 * Math.sin(time * Math.PI * 1.6)
		item.instanceCount = n
		if (n > 0) render.submit(item)
		this.stats.drawn = n
	}

	dispose(): void {
		this.mesh = null
		this.item = null
	}
}
