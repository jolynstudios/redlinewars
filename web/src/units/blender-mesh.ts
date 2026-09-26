// Validated offline Blender output. No authoring dependency runs in the browser.
import { Skeleton, type BoneDesc } from '../geo/rig'
import { decodeMeshBake } from './mesh-bake'
import type { UnitRig } from './shapes'
import PALETTE from '../core/blender-palette.json'
import type { DeploymentRigContract } from './deployment-rig'

export interface BlenderAsset {
	readonly deployment?: DeploymentRigContract
	readonly deploymentNativeScale?: 1
	readonly trackLoop?: { readonly length: number; readonly linkCount: number; readonly samples: readonly number[] }
	readonly sourcePath?: string
	readonly sourceSha256?: string
	readonly template?: string
	readonly alphaCutout?: boolean
	readonly materialSet?: string
	readonly materialTable?: readonly { readonly zone: number; readonly name: string; readonly set: string; readonly layer: number }[]
	readonly hidden?: boolean
	readonly offset?: number
	readonly bytes?: number
	readonly vertices?: number
	readonly triangles?: number
	readonly rig?: {
		readonly bones: readonly BoneDesc[]
		readonly turretBones: readonly number[]
		readonly wheelBones: readonly number[]
		readonly wheelRadii: readonly number[]
		readonly legBones: readonly number[]
		readonly legPhase: readonly number[]
		readonly strideM: number
		readonly rotors: readonly { bone: number; speed: number }[]
		readonly winds?: readonly { bone: number; speed: number; phase: number; amplitude: number }[]
		readonly oscillators?: readonly { bone: number; speed: number; phase: number; amplitude: number }[]
	}
}

export function decodeBlenderAsset(pack: Uint8Array, entry: BlenderAsset, allowUnusedLodBones = false): { mesh: ReturnType<typeof decodeMeshBake>['mesh']; rig: UnitRig | null } {
	const offset = entry.offset!, length = entry.bytes!
	if (!Number.isInteger(offset) || offset < 0 || offset % 4 !== 0 || !Number.isInteger(length) || length < 32 || offset + length > pack.byteLength)
		throw new Error('Blender mesh has an invalid pack range')
	const { mesh, info } = decodeMeshBake(pack.subarray(offset, offset + length))
	if (info.vertices !== entry.vertices || info.triangles !== entry.triangles || info.vertices < 3 || info.triangles < 1)
		throw new Error('Blender mesh count mismatch')
	for (const array of [mesh.positions, mesh.normals, mesh.tangents, mesh.uv0, mesh.uv1])
		for (const value of array) if (!Number.isFinite(value)) throw new Error('Non-finite Blender mesh channel')
	for (const index of mesh.indices) if (index >= mesh.vertexCount) throw new Error('Blender triangle index out of range')
	for (const zone of mesh.materialZone) if (zone >= PALETTE.length) throw new Error('Unknown Blender material zone')
	if (entry.materialSet) {
		if (entry.alphaCutout !== undefined && typeof entry.alphaCutout !== 'boolean') throw new Error('Invalid Blender alpha mode')
		const table = entry.materialTable, seen = new Set<number>()
		if (!table?.length) throw new Error('Missing Blender material table')
		for (const row of table) {
			if (!Number.isInteger(row.zone) || row.zone < 0 || row.zone >= PALETTE.length || seen.has(row.zone) ||
				row.layer !== row.zone || row.set !== entry.materialSet || !row.name)
				throw new Error('Unsupported Blender material mapping')
			seen.add(row.zone)
		}
		for (const zone of mesh.materialZone) if (!seen.has(zone)) throw new Error('Unmapped Blender material zone')
	}
	const r = entry.rig
	if (!r) {
		if (mesh.skinned) throw new Error('Blender mesh is skinned without a rig')
		return { mesh, rig: null }
	}
	if (!mesh.skinned || !r.bones.length || r.bones.length > 256) throw new Error('Invalid Blender skeleton')
	for (let i = 0; i < r.bones.length; i++) {
		const b = r.bones[i]
		if (i && (!Number.isInteger(b.parent) || (b.parent as number) < 0 || (b.parent as number) >= i)) throw new Error('Blender rig parent order invalid')
		if (!b.pos || b.pos.length !== 3 || Array.from(b.pos).some(v => !Number.isFinite(v))) throw new Error('Invalid Blender joint position')
	}
	for (const bone of [...r.turretBones, ...r.wheelBones, ...r.legBones, ...r.rotors.map(v => v.bone), ...(r.winds ?? []).map(v => v.bone), ...(r.oscillators ?? []).map(v => v.bone)])
		if (!Number.isInteger(bone) || bone < 0 || bone >= r.bones.length) throw new Error('Blender animation joint out of range')
	if (r.wheelBones.length !== r.wheelRadii.length || r.legBones.length !== r.legPhase.length ||
		r.wheelRadii.some(v => !Number.isFinite(v) || v <= 0) || r.legPhase.some(v => !Number.isFinite(v)) ||
		!Number.isFinite(r.strideM) || r.strideM < 0 || r.rotors.some(v => !Number.isFinite(v.speed)))
		throw new Error('Invalid Blender animation parameters')
	if (r.winds?.some(w => !Number.isFinite(w.speed) || w.speed <= 0 || !Number.isFinite(w.phase) || !Number.isFinite(w.amplitude) || w.amplitude < 0 || w.amplitude > .2)) throw new Error('Invalid Blender wind rig')
	if (r.oscillators?.some(w => !Number.isFinite(w.speed) || w.speed <= 0 || !Number.isFinite(w.phase) || !Number.isFinite(w.amplitude) || w.amplitude < 0 || w.amplitude > Math.PI)) throw new Error('Invalid Blender mechanism rig')
	const capturedVertices = new Uint32Array(r.bones.length), maxWeights = new Float32Array(r.bones.length)
	for (let v = 0; v < mesh.vertexCount; v++) {
		let sum = 0
		for (let j = 0; j < 4; j++) {
			const at = v * 4 + j, bone = mesh.skinIndices![at], weight = mesh.skinWeights![at]
			if (bone >= r.bones.length || !Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('Invalid Blender skin influence')
			sum += weight
			if (weight > 0) { capturedVertices[bone]++; maxWeights[bone] = Math.max(maxWeights[bone], weight) }
		}
		if (Math.abs(sum - 1) > 0.001) throw new Error('Blender skin weights do not sum to one')
	}
	for (const count of capturedVertices) if (count === 0 && !allowUnusedLodBones) throw new Error('Blender joint owns no geometry')
	return { mesh, rig: {
		skeleton: new Skeleton(r.bones), turretBones: Int32Array.from(r.turretBones),
		wheelBones: Int32Array.from(r.wheelBones), wheelRadii: Float32Array.from(r.wheelRadii),
		legBones: Int32Array.from(r.legBones), legPhase: Float32Array.from(r.legPhase), strideM: r.strideM,
		rotorBones: Int32Array.from(r.rotors.map(v => v.bone)), rotorSpeeds: Float32Array.from(r.rotors.map(v => v.speed)),
		windBones: Int32Array.from((r.winds ?? []).map(v => v.bone)), windSpeeds: Float32Array.from((r.winds ?? []).map(v => v.speed)),
		windPhases: Float32Array.from((r.winds ?? []).map(v => v.phase)), windAmplitudes: Float32Array.from((r.winds ?? []).map(v => v.amplitude)),
		oscillatorBones: Int32Array.from((r.oscillators ?? []).map(v => v.bone)), oscillatorSpeeds: Float32Array.from((r.oscillators ?? []).map(v => v.speed)),
		oscillatorPhases: Float32Array.from((r.oscillators ?? []).map(v => v.phase)), oscillatorAmplitudes: Float32Array.from((r.oscillators ?? []).map(v => v.amplitude)),
		capturedVertices, maxWeights,
	} }
}
