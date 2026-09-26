// Optional, boot-only anatomical LOD bundle. No GPU ownership or runtime decimation.
import SOURCE_LOCK from '../../../art/sources.lock.json'
import { fetchAssetPack } from '../core/asset-pack'
import { decodeBlenderAsset, type BlenderAsset } from './blender-mesh'
import { loadHumanMotion, loadHumanMotionTimedClips, validateHumanMotionPose, type HumanMotionClip, type HumanMotionManifest, type HumanTimedClip } from './human-motion'

export interface HumanAssetLevel extends BlenderAsset {
	readonly level: number
	readonly offset: number
	readonly bytes: number
	readonly vertices: number
	readonly triangles: number
	readonly sha256: string
	readonly skinned: boolean
	readonly rig: NonNullable<BlenderAsset['rig']>
	readonly sourcePath: string
	readonly sourceSha256: string
	readonly externalSources: HumanMotionManifest['externalSources']
	readonly bounds: readonly [readonly number[], readonly number[]]
	readonly uvMapping: { readonly authoredObjects: number; readonly projectedObjects: number; readonly origin: string }
}
export interface HumanAssetManifest {
	readonly schema: number
	readonly id: string
	readonly compression: string
	readonly file: string
	readonly bytes: number
	readonly storedBytes: number
	readonly sha256: string
	readonly parentSourcePath: string
	readonly parentSourceSha256: string
	readonly levels: readonly HumanAssetLevel[]
}
export interface HumanAssets {
	readonly manifest: HumanAssetManifest
	readonly levels: readonly ReturnType<typeof decodeBlenderAsset>[]
	readonly motion: HumanMotionClip
	/** Time-driven actions saved beside the walk, keyed by clip id. Empty is legal. */
	readonly timed: ReadonlyMap<string, HumanTimedClip>
}

const manifests = import.meta.glob<HumanAssetManifest>('../../.forge/human-lods/manifest.json', { eager: true, import: 'default' })
const packs = import.meta.glob<string>('../../.forge/human-lods/lods.ssmesh.gz', { eager: true, query: '?url', import: 'default' })
const MAX_BYTES = 6 * 1024 * 1024
const MAX_STORED = MAX_BYTES + Math.ceil(MAX_BYTES / 16384) * 5 + 64
const TRIANGLE_CAPS = [10000, 5500, 2800] as const
const SOURCE_IDS = ['makehuman-base', 'makehuman-rig', 'makehuman-weights'] as const
const hashValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const align4 = (n: number) => Math.ceil(n / 4) * 4
const bad = (reason: string): never => { throw new Error('Human assets: ' + reason) }

function sourcePathValid(path: unknown): boolean {
	return typeof path === 'string' && path.startsWith('art/blender/') && path.endsWith('.blend') &&
		!/[\\\u0000-\u001f]/.test(path) && !path.split('/').some(p => p === '' || p === '.' || p === '..')
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
	if (value !== null && typeof value === 'object') {
		const object = value as Record<string, unknown>
		return '{' + Object.keys(object).sort().map(k => JSON.stringify(k) + ':' + canonical(object[k])).join(',') + '}'
	}
	return JSON.stringify(value) ?? 'null'
}
function validateProvenance(refs: HumanMotionManifest['externalSources']): void {
	if (!Array.isArray(refs) || refs.length !== SOURCE_IDS.length) bad('missing anatomical provenance')
	const seen = new Set<string>()
	for (const ref of refs) {
		if (!ref || !SOURCE_IDS.some(id => id === ref.id) || seen.has(ref.id)) bad('unknown/duplicate source reference')
		const pinned = SOURCE_LOCK.sources.find(s => s.id === ref.id)
		if (!pinned || !hashValid(ref.sha256) || ref.sha256 !== pinned.sha256 || ref.url !== pinned.url ||
			ref.license !== pinned.license || ref.license !== 'CC0-1.0') bad('source reference differs from pinned lock')
		seen.add(ref.id)
	}
}
function vectorValid(value: unknown, length: number): value is number[] {
	return Array.isArray(value) && value.length === length && value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 10)
}
function validateRig(rig: HumanAssetLevel['rig']): void {
	if (!rig || !Array.isArray(rig.bones) || rig.bones.length !== 20) bad('expected twenty bones')
	const names = new Set<string>()
	for (let i = 0; i < 20; i++) {
		const bone: HumanAssetLevel['rig']['bones'][number] = rig.bones[i]
		if (!bone || typeof bone.name !== 'string' || !bone.name || names.has(bone.name) ||
			(i === 0 ? bone.parent !== undefined : !Number.isInteger(bone.parent) || (bone.parent as number) < 0 || (bone.parent as number) >= i) ||
			!Number.isInteger(bone.kind) || bone.kind! < 0 || bone.kind! > 20 || !vectorValid(bone.pos, 3)) bad('invalid bone binding')
		if (Object.keys(bone).some(k => !['name', 'parent', 'kind', 'pos', 'rot', 'scale'].includes(k))) bad('unsupported bone metadata')
		if (bone.rot !== undefined && (!vectorValid(bone.rot, 4) || Math.abs(Math.hypot(...bone.rot) - 1) > 1e-6)) bad('invalid bind rotation')
		if (bone.scale !== undefined && (!vectorValid(bone.scale, 3) || bone.scale.some(v => v < .0001))) bad('invalid bind scale')
		names.add(bone.name)
	}
	for (const list of [rig.turretBones, rig.wheelBones, rig.legBones]) {
		if (!Array.isArray(list) || list.length > 20 || new Set(list).size !== list.length ||
			list.some(i => !Number.isInteger(i) || i < 0 || i >= 20)) bad('invalid animation bone list')
	}
	if (!Array.isArray(rig.wheelRadii) || rig.wheelRadii.length !== rig.wheelBones.length || rig.wheelRadii.some(v => !Number.isFinite(v) || v <= 0 || v > 10) ||
		!Array.isArray(rig.legPhase) || rig.legPhase.length !== rig.legBones.length || rig.legPhase.some(v => !Number.isFinite(v)) ||
		!Number.isFinite(rig.strideM) || rig.strideM < .0001 || rig.strideM > 10) bad('invalid animation parameters')
	// This saved walk package has no secondary mechanism animation. Do not admit a
	// competing oscillator/wind/turret driver under the same infantry-v1 identity.
	if (rig.turretBones.length || rig.wheelBones.length || !Array.isArray(rig.rotors) || rig.rotors.length ||
		(rig.winds !== undefined && (!Array.isArray(rig.winds) || rig.winds.length)) ||
		(rig.oscillators !== undefined && (!Array.isArray(rig.oscillators) || rig.oscillators.length))) bad('unsupported secondary rig animation')
}

/** Complete metadata preflight before download or decoder allocation. */
export function validateHumanAssetsManifest(m: HumanAssetManifest, expectedMaterialSourceSha256: string): void {
	if (!m || m.schema !== 1 || m.id !== 'infantry-v1' || m.compression !== 'gzip' || m.file !== 'lods.ssmesh.gz' ||
		!Array.isArray(m.levels) || m.levels.length !== 3) bad('unsupported manifest or level count')
	if (!Number.isSafeInteger(m.bytes) || m.bytes < 96 || m.bytes > MAX_BYTES ||
		!Number.isSafeInteger(m.storedBytes) || m.storedBytes < 1 || m.storedBytes > MAX_STORED || !hashValid(m.sha256)) bad('invalid pack budget/hash')
	if (!hashValid(expectedMaterialSourceSha256) || !hashValid(m.parentSourceSha256) ||
		m.parentSourceSha256 !== expectedMaterialSourceSha256 || !sourcePathValid(m.parentSourcePath)) bad('atlas/parent source binding mismatch')
	let end = 0, previousTriangles = Infinity, sharedRig = '', sharedMaterial = ''
	for (let i = 0; i < 3; i++) {
		const level: HumanAssetLevel = m.levels[i]
		if (!level || level.level !== i || level.skinned !== true || level.hidden === true ||
			!Number.isSafeInteger(level.triangles) || level.triangles < 1 || level.triangles > TRIANGLE_CAPS[i] || level.triangles >= previousTriangles ||
			!Number.isSafeInteger(level.vertices) || level.vertices < 3 || level.vertices > level.triangles * 3) bad('LOD count/order/budget mismatch')
		previousTriangles = level.triangles
		const exactBytes = 32 + level.vertices * 76 + align4(level.vertices) + level.triangles * 12
		if (level.offset !== end || level.offset % 4 !== 0 || level.bytes !== exactBytes || level.bytes % 4 !== 0 ||
			!Number.isSafeInteger(level.offset + level.bytes) || level.offset + level.bytes > m.bytes || !hashValid(level.sha256)) bad('noncontiguous/invalid LOD range')
		end += level.bytes
		if (!sourcePathValid(level.sourcePath) || !hashValid(level.sourceSha256)) bad('invalid LOD saved source metadata')
		validateProvenance(level.externalSources)
		if (level.materialSet !== 'infantry-v1' || level.alphaCutout === true || !Array.isArray(level.materialTable) || level.materialTable.length !== 1 ||
			level.materialTable[0]?.zone !== 0 || level.materialTable[0]?.layer !== 0 || level.materialTable[0]?.set !== 'infantry-v1' ||
			typeof level.materialTable[0]?.name !== 'string' || !level.materialTable[0].name.trim()) bad('invalid single-layer human material binding')
		const uv = level.uvMapping
		if (!uv || uv.origin !== 'bottom-left' || uv.projectedObjects !== 0 || !Number.isSafeInteger(uv.authoredObjects) || uv.authoredObjects < 1 || uv.authoredObjects > 4096)
			bad('missing authored UV provenance')
		if (!Array.isArray(level.bounds) || level.bounds.length !== 2 || !vectorValid(level.bounds[0], 3) || !vectorValid(level.bounds[1], 3) ||
			level.bounds[0].some((v, axis) => v > level.bounds[1][axis])) bad('invalid declared bounds')
		validateRig(level.rig)
		const rig = canonical(level.rig), material = canonical(level.materialTable)
		if (i && (rig !== sharedRig || material !== sharedMaterial)) bad('LOD rig/material mismatch')
		sharedRig = rig; sharedMaterial = material
	}
	if (end !== m.bytes) bad('unclaimed pack bytes')
}

/** Same return shape as load; gate callers supply manifests and mock the two bundled URLs. */
export async function verifyHumanAssets(manifest: HumanAssetManifest, url: string, expectedMaterialSourceSha256: string): Promise<HumanAssets> {
	validateHumanAssetsManifest(manifest, expectedMaterialSourceSha256)
	const local = new URL(url, location.href)
	if (local.origin !== location.origin || !['http:', 'https:'].includes(local.protocol)) bad('pack must be same-origin')
	const bytes = await fetchAssetPack(url, manifest)
	// Verify every slice and header before allowing the decoder to construct typed views.
	for (const level of manifest.levels) {
		const slice = bytes.subarray(level.offset, level.offset + level.bytes)
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', slice as Uint8Array<ArrayBuffer>))
		if (Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') !== level.sha256) bad('LOD slice SHA-256 mismatch')
		const header = new DataView(slice.buffer, slice.byteOffset, 32)
		if (header.getUint32(0, true) !== 0x464d5353 || header.getUint16(4, true) !== 1 || header.getUint16(6, true) !== 1 ||
			header.getUint32(8, true) !== level.vertices || header.getUint32(12, true) !== level.triangles ||
			header.getUint32(16, true) !== level.bytes - 32 || header.getUint32(28, true) !== 32) bad('LOD binary header mismatch')
	}
	const levels = manifest.levels.map(level => {
		const decoded = decodeBlenderAsset(bytes, level), mesh = decoded.mesh
		if (!decoded.rig || decoded.rig.skeleton.boneCount !== 20) bad('decoded rig mismatch')
		const problem = mesh.validate()
		if (problem) bad(problem)
		for (const v of mesh.uv0) if (v < -1e-6 || v > 1 + 1e-6) bad('atlas UV outside unit square')
		mesh.updateBounds()
		for (let axis = 0; axis < 3; axis++)
			if (Math.abs(mesh.aabbMin[axis] - level.bounds[0][axis]) > 1e-6 || Math.abs(mesh.aabbMax[axis] - level.bounds[1][axis]) > 1e-6)
				bad('decoded bounds differ from manifest')
		return decoded
	})
	const motion = await loadHumanMotion(manifest)
	if (!motion) return bad('missing saved human motion pack')
	validateProvenance(motion.manifest.externalSources)
	for (const level of levels) validateHumanMotionPose(motion, level.rig!.skeleton.createPose())
	// The timed clips share the walk's rig and bind pose, so the pose validation above covers
	// them too; what is theirs alone -- the bone mask and the loop/one-shot shape -- is
	// enforced inside the loader.
	const timed = new Map<string, HumanTimedClip>()
	for (const one of await loadHumanMotionTimedClips(motion)) timed.set(one.entry.id, one)
	return { manifest, levels, motion, timed }
}

/** Absent optional LOD bundle is null; any present-but-incomplete dependency is an error. */
export async function loadHumanAssets(expectedMaterialSourceSha256: string): Promise<HumanAssets | null> {
	const manifest = Object.values(manifests)[0], url = Object.values(packs)[0]
	if (!manifest && !url) return null
	if (!manifest || !url) bad('incomplete optional LOD pack')
	return verifyHumanAssets(manifest, url, expectedMaterialSourceSha256)
}
