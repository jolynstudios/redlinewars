import type { Pose, Skeleton } from '../geo/rig'
import type { DeploymentsView } from '../core/snapshot'

export interface DeploymentChannel {
	readonly index: number
	readonly boneName: string
	readonly parent: number
	readonly bindTranslationM: readonly number[]
	readonly bindRotationQuat: readonly number[]
	readonly foldedTranslationM: readonly number[]
	readonly foldedRotationQuat: readonly number[]
	readonly phaseStart: number
	readonly phaseEnd: number
	readonly translationPhaseStart?: number
	readonly translationPhaseEnd?: number
	readonly signedHinge?: {
		readonly axisLocal: readonly number[]
		readonly foldedAngleRad: number
		readonly bindAngleRad: number
	}
}
export interface DeploymentRigContract {
	/** End of the preserved vehicle-unfolding phase; appended construction follows. */
	readonly prefixEnd?: number
	readonly boneCount: number
	readonly scaleChannels: boolean
	readonly deployedIsBindPose: boolean
	readonly channels: readonly DeploymentChannel[]
}

/** Local rigid joint channels. Skeleton evaluation, skinning and all render passes remain shared. */
export class DeploymentRig {
	private readonly channels: readonly DeploymentChannel[]
	readonly prefixEnd: number
	constructor(readonly skeleton: Skeleton, contract: DeploymentRigContract) {
		if (contract.scaleChannels || !contract.deployedIsBindPose || contract.boneCount !== skeleton.boneCount)
			throw new Error('deployment rig: incompatible bind contract')
		this.prefixEnd = contract.prefixEnd ?? 1
		if (!Number.isFinite(this.prefixEnd) || this.prefixEnd <= 0 || this.prefixEnd > 1)
			throw new Error('deployment rig: invalid preserved prefix interval')
		const seen = new Set<number>()
		for (const c of contract.channels) {
			if (!Number.isInteger(c.index) || c.index < 0 || c.index >= skeleton.boneCount || seen.has(c.index) ||
				skeleton.names[c.index] !== c.boneName || skeleton.parent[c.index] !== c.parent ||
				![c.phaseStart, c.phaseEnd].every(Number.isFinite) || c.phaseStart < 0 || c.phaseEnd > 1 || c.phaseEnd <= c.phaseStart)
				throw new Error('deployment rig: invalid joint identity or phase')
			seen.add(c.index)
			if ((c.translationPhaseStart === undefined) !== (c.translationPhaseEnd === undefined) ||
				(c.translationPhaseStart !== undefined &&
					(!Number.isFinite(c.translationPhaseStart) || !Number.isFinite(c.translationPhaseEnd) ||
						c.translationPhaseStart < 0 || c.translationPhaseEnd! > 1 || c.translationPhaseEnd! <= c.translationPhaseStart)))
				throw new Error('deployment rig: invalid translation phase')
			for (const [a, width] of [[c.bindTranslationM, 3], [c.foldedTranslationM, 3], [c.bindRotationQuat, 4], [c.foldedRotationQuat, 4]] as const)
				if (a.length !== width || !a.every(Number.isFinite)) throw new Error('deployment rig: invalid rigid channel')
			for (let a = 0; a < 3; a++) if (Math.abs(skeleton.bindT[c.index * 3 + a] - c.bindTranslationM[a]) > .0001)
				throw new Error('deployment rig: source bind translation changed')
			let alignment = 0
			for (let a = 0; a < 4; a++) alignment += skeleton.bindR[c.index * 4 + a] * c.bindRotationQuat[a]
			if (Math.abs(Math.abs(alignment) - 1) > .0001 || Math.abs(Math.hypot(...c.foldedRotationQuat) - 1) > .0001 ||
				Math.abs(Math.hypot(...c.bindRotationQuat) - 1) > .0001)
				throw new Error('deployment rig: invalid rotation bind')
			const hinge = c.signedHinge
			if (hinge) {
				if (hinge.axisLocal.length !== 3 || !hinge.axisLocal.every(Number.isFinite) ||
					Math.abs(Math.hypot(...hinge.axisLocal) - 1) > .0001 ||
					![hinge.foldedAngleRad, hinge.bindAngleRad].every(Number.isFinite))
					throw new Error('deployment rig: invalid signed hinge')
				for (const [angle, rotation] of [[hinge.foldedAngleRad, c.foldedRotationQuat], [hinge.bindAngleRad, c.bindRotationQuat]] as const) {
					const sin = Math.sin(angle / 2), cos = Math.cos(angle / 2)
					let dot = cos * rotation[3]
					for (let a = 0; a < 3; a++) dot += hinge.axisLocal[a] * sin * rotation[a]
					if (Math.abs(Math.abs(dot) - 1) > .0001) throw new Error('deployment rig: signed hinge endpoint differs from source')
				}
			}
		}
		this.channels = contract.channels
	}

	/** A caller resets the pose to bind once before layering this joint animation. No scale writes. */
	sample(pose: Pose, progress: number): void {
		if (pose.skeleton !== this.skeleton || !Number.isFinite(progress)) throw new Error('deployment rig: invalid pose/progress')
		for (const c of this.channels) {
			let t = Math.max(0, Math.min(1, (progress - c.phaseStart) / (c.phaseEnd - c.phaseStart)))
			t = t * t * (3 - 2 * t)
			let translationT = t
			if (c.translationPhaseStart !== undefined) {
				translationT = Math.max(0, Math.min(1, (progress - c.translationPhaseStart) / (c.translationPhaseEnd! - c.translationPhaseStart)))
				translationT = translationT * translationT * (3 - 2 * translationT)
			}
			const o = c.index * 3
			for (let a = 0; a < 3; a++) pose.t[o + a] = c.foldedTranslationM[a] + (c.bindTranslationM[a] - c.foldedTranslationM[a]) * translationT
			if (c.signedHinge) {
				// A roof can take a deliberately longer upward arc. Quaternion slerp
				// chooses the shorter path and would swing it through the machinery.
				const hinge = c.signedHinge, angle = hinge.foldedAngleRad + (hinge.bindAngleRad - hinge.foldedAngleRad) * t
				const sin = Math.sin(angle / 2)
				for (let a = 0; a < 3; a++) pose.r[c.index * 4 + a] = hinge.axisLocal[a] * sin
				pose.r[c.index * 4 + 3] = Math.cos(angle / 2)
				continue
			}
			const a = c.foldedRotationQuat, b = c.bindRotationQuat
			let dot = 0
			for (let axis = 0; axis < 4; axis++) dot += a[axis] * b[axis]
			const sign = dot < 0 ? -1 : 1; dot = Math.abs(dot)
			let wa = 1 - t, wb = t
			if (dot < .9995) {
				const theta = Math.acos(Math.min(1, dot)), invSin = 1 / Math.sin(theta)
				wa = Math.sin((1 - t) * theta) * invSin; wb = Math.sin(t * theta) * invSin
			}
			let length = 0
			for (let axis = 0; axis < 4; axis++) { const value = a[axis] * wa + b[axis] * sign * wb; pose.r[c.index * 4 + axis] = value; length += value * value }
			const invLength = 1 / Math.sqrt(length)
			for (let axis = 0; axis < 4; axis++) pose.r[c.index * 4 + axis] *= invLength
		}
	}
}


/** Settle the old vehicle support plane into the wider yard plane during the
 * initial jack phase. Normalize the basis so this never becomes a scale morph.
 * `source` is the actually placed native MCV; the yard's folded rig contains its
 * 135-degree donor rotation. Source/target translations are engine-derived. */
export function settleDeploymentBasis(out: Float32Array, o: number, source: Float32Array, progress: number): void {
	if (progress >= .12) return
	let t=Math.max(0,progress/.12);t=t*t*(3-2*t)
	const c=-Math.SQRT1_2,s=-Math.SQRT1_2
	let fx=(source[0]*c-source[8]*s)*(1-t)+out[o]*t
	let fy=(source[1]*c-source[9]*s)*(1-t)+out[o+1]*t
	let fz=(source[2]*c-source[10]*s)*(1-t)+out[o+2]*t
	const fn=Math.hypot(fx,fy,fz);fx/=fn;fy/=fn;fz/=fn
	const ux=source[4]*(1-t)+out[o+4]*t,uy=source[5]*(1-t)+out[o+5]*t,uz=source[6]*(1-t)+out[o+6]*t
	let lx=fy*uz-fz*uy,ly=fz*ux-fx*uz,lz=fx*uy-fy*ux
	const ln=Math.hypot(lx,ly,lz);lx/=ln;ly/=ln;lz/=ln
	out[o]=fx;out[o+1]=fy;out[o+2]=fz
	out[o+4]=ly*fz-lz*fy;out[o+5]=lz*fx-lx*fz;out[o+6]=lx*fy-ly*fx
	out[o+8]=lx;out[o+9]=ly;out[o+10]=lz
	for(let a=12;a<15;a++)out[o+a]=source[a]*(1-t)+out[o+a]*t
}
/** Copied snapshot values. A late observer starts at the actual make frame, never at invented zero. */
export class DeploymentStates {
	private readonly states = new Map<number, { source: number; position: number[]; facing: number; previous: number; current: number; seen: number }>()
	private readonly retained = new Set<number>()
	private tick = -1

	clear(): void { this.states.clear(); this.retained.clear(); this.tick = -1 }

	/** Bound memory to actors the observer still knows, including frozen actors.
	 * Never evict a partially deployed yard to make room for a completed one. */
	retainActors(live: { count: number; id: Uint32Array } | null, frozen: { count: number; id: Uint32Array } | null): void {
		this.retained.clear()
		for (const actors of [live, frozen]) if (actors)
			for (let i = 0; i < actors.count; i++) this.retained.add(actors.id[i])
		for (const id of this.states.keys()) if (!this.retained.has(id)) this.states.delete(id)
	}

	ingest(records: DeploymentsView | null | undefined, tick: number): void {
		if (tick < this.tick) this.clear()
		if (tick === this.tick) return
		const previousTick = this.tick; this.tick = tick
		if (!records) return
		const v = records.view
		for (let i = 0; i < records.count; i++) {
			const o = records.byteOffset + i * 32, id = v.getUint32(o, true), source = v.getUint32(o + 4, true)
			const frames = v.getUint16(o + 24, true), frame = v.getUint16(o + 22, true)
			const progress = frames <= 1 ? 1 : frame / (frames - 1)
			let state = this.states.get(id)
			if (!state) {
				state = { source, position: [0, 0, 0], facing: 0, previous: progress, current: progress, seen: -1 }
				this.states.set(id, state)
			}
			state.previous = state.seen === previousTick && state.source === source ? state.current : progress
			state.current = progress; state.seen = tick; state.source = source
			state.facing = v.getUint16(o + 20, true)
			for (let axis = 0; axis < 3; axis++) state.position[axis] = v.getInt32(o + 8 + axis * 4, true)
		}
	}

	progressOf(id: number, alpha: number): number {
		const state = this.states.get(id)
		if (!state || state.seen !== this.tick) return 1
		return state.previous + (state.current - state.previous) * Math.max(0, Math.min(1, alpha))
	}

	rememberedProgressOf(id: number): number { return this.states.get(id)?.current ?? 1 }

	/** Source ID, WPos xyz and WAngle. Values only; no source actor dereference. */
	sourceOf(id: number, out: Float64Array, remembered = false): boolean {
		const state = this.states.get(id)
		if (!state || (!remembered && state.seen !== this.tick)) return false
		out[0] = state.source
		for (let a = 0; a < 3; a++) out[1 + a] = state.position[a]
		out[4] = state.facing; return true
	}
}
