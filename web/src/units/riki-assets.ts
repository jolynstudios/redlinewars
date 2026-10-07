// Riki's repaired Meshy skeleton has its own saved motion, independent of the legacy
// twenty-bone infantry rig. All conversion, decimation and texture work is offline.
import { fetchAssetPack } from '../core/asset-pack'
import { canonicalRoleValue, roleDigest, roleHashValid, validateRoleInput, type RolePackInput } from '../core/role-pack'
import { computeSkinMatrices, computeWorldTransforms, type Pose } from '../geo/rig'
import { decodeBlenderAsset } from './blender-mesh'
import type { HumanAssetLevel } from './human-assets'

export const RIKI_MATERIAL = 'riki-meshy-v1'
// At compressed RTS scale, the measured crawl stride would cycle 8.42 times/s.
// This presentation distance gives 1.48 cycles/s at stock prone speed (.83m/s).
// Source stride stays measured in the pack; some ground sliding is unavoidable
// while preserving the engine's movement speed and a readable crawling motion.
export const RIKI_PRONE_CYCLE_DISTANCE = .56
const IDS = ['run', 'aim', 'fire', 'runfire', 'crawl', 'pronefire'] as const
type ClipId = typeof IDS[number]
export interface RikiMotionEntry {
	readonly id: ClipId
	readonly file: string
	readonly frames: number
	readonly boneCount: number
	readonly channels: string
	readonly durationS: number
	readonly strideM: number
	readonly loop: boolean
	readonly bytes: number
	readonly storedBytes: number
	readonly sha256: string
	readonly rigSha256: string
	readonly modelSourceSha256: string
}
export interface RikiClip {
	readonly entry: RikiMotionEntry
	readonly data: Float32Array
}
export interface RikiManifest {
	readonly schema: number
	readonly id: string
	readonly compression: string
	readonly file: string
	readonly bytes: number
	readonly storedBytes: number
	readonly sha256: string
	readonly parentSourcePath: string
	readonly parentSourceSha256: string
	readonly rigSha256: string
	readonly suppliedInput: RolePackInput
	readonly levels: readonly Omit<HumanAssetLevel, 'externalSources'>[]
	readonly motions: readonly RikiMotionEntry[]
	readonly muzzle: { readonly bone: string; readonly pos: readonly number[]; readonly direction: readonly number[] }
}
export interface RikiAssets {
	readonly manifest: RikiManifest
	readonly levels: readonly ReturnType<typeof decodeBlenderAsset>[]
	readonly clips: ReadonlyMap<ClipId, RikiClip>
	readonly upperBones: Int32Array
	readonly muzzleBone: number
	readonly muzzleAnchor: readonly number[]
}
const manifests = import.meta.glob<RikiManifest>('../../.forge/riki-meshy/manifest.json', { eager: true, import: 'default' })
const files = import.meta.glob<string>('../../.forge/riki-meshy/*.*.gz', { eager: true, query: '?url', import: 'default' })
const fail = (reason: string): never => { throw new Error('Riki assets: ' + reason) }
const sourcePath = (p: string, level: number) => p === `art/blender/assets/studies/riki-meshy-lod${level}-v1.blend`
const unitQuaternion = (q: ArrayLike<number>) => q.length === 4 && Array.from(q).every(Number.isFinite) && Math.abs(Math.hypot(...Array.from(q)) - 1) < .001

export function validateRikiManifest(m: RikiManifest, atlasSource: string): void {
	if (!m || m.schema !== 1 || m.id !== RIKI_MATERIAL || m.compression !== 'gzip' || m.file !== 'lods.ssmesh.gz' ||
		!Array.isArray(m.levels) || m.levels.length !== 3 || !Array.isArray(m.motions) || m.motions.length !== IDS.length)
		fail('unsupported bundle')
	validateRoleInput(m.suppliedInput)
	if (!roleHashValid(m.sha256) || !roleHashValid(atlasSource) || m.parentSourceSha256 !== atlasSource ||
		!Number.isSafeInteger(m.bytes) || m.bytes < 96 || m.bytes > 12 * 1048576 ||
		!Number.isSafeInteger(m.storedBytes) || m.storedBytes < 1 || m.storedBytes > 12.1 * 1048576 ||
		!sourcePath(m.parentSourcePath, 0)) fail('budget or material source binding')
	const rig = m.levels[0].rig
	if (!rig || !Array.isArray(rig.bones) || rig.bones.length !== 26) fail('missing native skeleton')
	const names = new Set<string>()
	for (let i = 0; i < rig.bones.length; i++) {
		const b = rig.bones[i]
		if (!b || !b.name || names.has(b.name) || (i === 0 ? b.parent !== undefined : typeof b.parent !== 'number' || !Number.isInteger(b.parent) || b.parent < 0 || b.parent >= i) ||
			b.pos?.length !== 3 || Array.from(b.pos).some(n => !Number.isFinite(n) || Math.abs(n) > 1) ||
			(b.rot !== undefined && !unitQuaternion(b.rot)) || (b.scale !== undefined && Array.from(b.scale).some(n => Math.abs(n - 1) > 1e-5))) fail('invalid native bone')
		names.add(b.name)
	}
	for (const name of ['rifle', 'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'foot.L', 'foot.R']) if (!names.has(name)) fail('missing limb')
	if (rig.turretBones.length || rig.wheelBones.length || rig.legBones.length || rig.rotors.length || rig.winds?.length || rig.oscillators?.length)
		fail('secondary animation would overwrite authored motion')
	let end = 0, previous = Infinity
	for (let i = 0; i < 3; i++) {
		const e = m.levels[i]
		if (!e || e.level !== i || !e.skinned || !sourcePath(e.sourcePath, i) || !roleHashValid(e.sourceSha256) || !roleHashValid(e.sha256) ||
			!Number.isSafeInteger(e.triangles) || e.triangles < 1 || e.triangles > [24000, 12000, 6000][i] || e.triangles >= previous ||
			!Number.isSafeInteger(e.vertices) || e.vertices < 3 || e.vertices > e.triangles * 3 || canonicalRoleValue(e.rig) !== canonicalRoleValue(rig)) fail('LOD identity or budget')
		const size = 32 + e.vertices * 76 + Math.ceil(e.vertices / 4) * 4 + e.triangles * 12
		if (e.offset !== end || e.bytes !== size || end + size > m.bytes || e.materialSet !== m.id ||
			e.materialTable?.length !== 1 || e.materialTable[0].zone !== 0 || e.materialTable[0].layer !== 0 || e.materialTable[0].set !== m.id ||
			e.uvMapping?.origin !== 'bottom-left' || e.uvMapping.projectedObjects !== 0 || e.uvMapping.authoredObjects < 1) fail('LOD range or UV material mapping')
		if (!Array.isArray(e.bounds) || e.bounds.length !== 2 || e.bounds.some(v => v.length !== 3 || v.some(n => !Number.isFinite(n) || Math.abs(n) > 1)) ||
			e.bounds[0].some((n, a) => n > e.bounds[1][a])) fail('LOD bounds')
		end += size; previous = e.triangles
	}
	if (end !== m.bytes || m.levels[0].sourceSha256 !== m.parentSourceSha256) fail('payload coverage or model source')
	const ids = new Set<string>()
	if (!roleHashValid(m.rigSha256)) fail('rig hash')
	for (const e of m.motions) {
		if (!e || !IDS.includes(e.id) || ids.has(e.id) || e.file !== `${e.id}.ssanim.gz` || e.boneCount !== rig.bones.length ||
			e.channels !== 'local-translation.xyz,local-rotation.xyzw' || !Number.isSafeInteger(e.frames) || e.frames < 2 || e.frames > 257 ||
			!Number.isFinite(e.durationS) || e.durationS <= 0 || e.durationS > 10 || typeof e.loop !== 'boolean' ||
			!Number.isFinite(e.strideM) || e.strideM < 0 || e.strideM > 2 || (['run', 'runfire', 'crawl'].includes(e.id) && (e.strideM <= 0 || !e.loop)) ||
			e.bytes !== e.frames * e.boneCount * 7 * 4 || !Number.isSafeInteger(e.storedBytes) || e.storedBytes < 1 || e.storedBytes > e.bytes + 1024 ||
			!roleHashValid(e.sha256) || e.rigSha256 !== m.rigSha256 || e.modelSourceSha256 !== m.parentSourceSha256) fail('motion metadata or binding')
		ids.add(e.id)
	}
	if (!m.muzzle || !names.has(m.muzzle.bone) || m.muzzle.pos?.length !== 3 || m.muzzle.pos.some(n => !Number.isFinite(n) || Math.abs(n) > 1) ||
		m.muzzle.direction?.length !== 3 || m.muzzle.direction.some(n => !Number.isFinite(n)) || Math.abs(Math.hypot(...m.muzzle.direction) - 1) > .001) fail('muzzle binding')
}

export function validateRikiMotion(e: RikiMotionEntry, data: Float32Array, boneCount: number): void {
	if (e.boneCount !== boneCount || data.length !== e.frames * boneCount * 7) fail('motion sample count')
	for (let i = 0; i < data.length; i += 7) {
		if (Math.abs(data[i]) > 1 || Math.abs(data[i + 1]) > 1 || Math.abs(data[i + 2]) > 1 ||
			!Array.from(data.subarray(i, i + 7)).every(Number.isFinite) || !unitQuaternion(data.subarray(i + 3, i + 7))) fail('motion TR sample')
	}
	if (e.loop) {
		const end = (e.frames - 1) * boneCount * 7
		for (let b = 0; b < boneCount; b++) {
			const o = b * 7
			for (let c = 0; c < 3; c++) if (Math.abs(data[o + c] - data[end + o + c]) > 1e-5) fail('motion loop translation seam')
			let dot = 0
			for (let c = 3; c < 7; c++) dot += data[o + c] * data[end + o + c]
			if (Math.abs(dot) < .9999) fail('motion loop rotation seam')
		}
	}
}

export async function loadRikiAssets(atlasSource: string): Promise<RikiAssets | null> {
	const m = Object.values(manifests)[0]
	if (!m) return null
	validateRikiManifest(m, atlasSource)
	if (await roleDigest(new TextEncoder().encode(canonicalRoleValue(m.levels[0].rig))) !== m.rigSha256) fail('rig digest mismatch')
	const url = (file: string) => Object.entries(files).find(([key]) => key.endsWith('/' + file))?.[1] ?? fail('missing bundled ' + file)
	const bytes = await fetchAssetPack(url(m.file), m)
	const levels = []
	for (const entry of m.levels) {
		if (await roleDigest(bytes.subarray(entry.offset, entry.offset + entry.bytes)) !== entry.sha256) fail('LOD hash')
		levels.push(decodeBlenderAsset(bytes, entry, true))
	}
	const clips = new Map<ClipId, RikiClip>()
	for (const entry of m.motions) {
		const bytes = await fetchAssetPack(url(entry.file), entry)
		const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
		validateRikiMotion(entry, data, m.levels[0].rig.bones.length)
		clips.set(entry.id, { entry, data })
	}
	const bones = m.levels[0].rig.bones
	const muzzleBone = bones.findIndex(b => b.name === m.muzzle.bone)
	const skeleton = levels[0].rig!.skeleton, pose = skeleton.createPose(), world = skeleton.createMatrixBuffer(), skin = skeleton.createMatrixBuffer()
	sampleRikiClip(clips.get('aim')!, pose, 1)
	computeWorldTransforms(pose, world); computeSkinMatrices(skeleton, world, skin)
	const k = muzzleBone * 16, p = m.muzzle.pos
	const muzzleAnchor = [0, 1, 2].map(a => skin[k + a] * p[0] + skin[k + 4 + a] * p[1] + skin[k + 8 + a] * p[2] + skin[k + 12 + a])
	return { manifest: m, levels, clips, muzzleBone, muzzleAnchor,
		upperBones: Int32Array.from(bones.map((_, i) => i).filter(i => i > 0 && !/^(thigh|shin|foot|toe)\./.test(bones[i].name))) }
}

/** Phase is normalized 0..1. Full local transforms, shortest-arc normalized quaternion interpolation. */
export function sampleRikiClip(clip: RikiClip, pose: Pose, phase: number, weight = 1, bones?: Int32Array): void {
	if (weight <= 0) return
	weight = Math.min(1, weight)
	const { data, entry } = clip
	const f = Math.max(0, Math.min(1, phase)) * (entry.frames - 1)
	const lo = Math.floor(f), hi = Math.min(lo + 1, entry.frames - 1), t = f - lo
	for (let n = 0; n < (bones?.length ?? entry.boneCount); n++) {
		const b = bones ? bones[n] : n, a = (lo * entry.boneCount + b) * 7, z = (hi * entry.boneCount + b) * 7
		const p = b * 3, q = b * 4
		for (let c = 0; c < 3; c++) pose.t[p + c] += (data[a + c] + (data[z + c] - data[a + c]) * t - pose.t[p + c]) * weight
		let dot = 0
		for (let c = 3; c < 7; c++) dot += data[a + c] * data[z + c]
		const sign = dot < 0 ? -1 : 1
		let x = data[a + 3] * (1 - t) + data[z + 3] * t * sign
		let y = data[a + 4] * (1 - t) + data[z + 4] * t * sign
		let zz = data[a + 5] * (1 - t) + data[z + 5] * t * sign
		let w = data[a + 6] * (1 - t) + data[z + 6] * t * sign
		let inv = 1 / Math.hypot(x, y, zz, w); x *= inv; y *= inv; zz *= inv; w *= inv
		const blend = (pose.r[q] * x + pose.r[q + 1] * y + pose.r[q + 2] * zz + pose.r[q + 3] * w < 0 ? -1 : 1) * weight
		x = pose.r[q] * (1 - weight) + x * blend; y = pose.r[q + 1] * (1 - weight) + y * blend
		zz = pose.r[q + 2] * (1 - weight) + zz * blend; w = pose.r[q + 3] * (1 - weight) + w * blend
		inv = 1 / Math.hypot(x, y, zz, w)
		pose.r[q] = x * inv; pose.r[q + 1] = y * inv; pose.r[q + 2] = zz * inv; pose.r[q + 3] = w * inv
	}
}

/** Presentation follows actual travel, actual fire events and the engine's TakeCover state. */
export function poseRiki(assets: RikiAssets, pose: Pose, distance: number, moving: boolean, aimWeight: number, sinceFire: number, prone: boolean): void {
	pose.resetToBind()
	const clips = assets.clips, run = clips.get('run')!, aim = clips.get('aim')!, fire = clips.get(prone ? 'pronefire' : 'fire')!
	const gait = prone ? clips.get('crawl')! : run
	const cycleDistance = prone ? Math.max(gait.entry.strideM, RIKI_PRONE_CYCLE_DISTANCE) : gait.entry.strideM
	const phase = moving ? ((distance / cycleDistance) % 1 + 1) % 1 : 0
	const firing = sinceFire >= 0 && sinceFire < fire.entry.durationS
	if (prone) {
		sampleRikiClip(gait, pose, phase)
		if (firing) sampleRikiClip(fire, pose, sinceFire / fire.entry.durationS, 1, moving ? assets.upperBones : undefined)
	} else if (moving) {
		sampleRikiClip(run, pose, phase)
		if (firing) sampleRikiClip(clips.get('runfire')!, pose, phase)
		else if (aimWeight > 0) sampleRikiClip(aim, pose, 1, aimWeight, assets.upperBones)
	} else {
		sampleRikiClip(aim, pose, Math.max(0, Math.min(1, aimWeight)))
		if (firing) sampleRikiClip(fire, pose, sinceFire / fire.entry.durationS)
	}
}
