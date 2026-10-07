// Anatomical role packs: one saved body per infantry role, all sharing the MakeHuman bind rig and
// the one walk/aim/fire motion set by exact identity, never by relabeling. Discovered at BUILD
// time from web/.forge/*/manifest.json by schema, verified at boot, never decimated at runtime.
//
// A pack that is absent costs nothing. A pack that is present but invalid costs its actors their
// new body and nothing else: the caller draws them from the roster and reports the reason.
import { fetchAssetPack } from '../core/asset-pack'
import {
	RIFLE_PACK, ROLE_PACK_DIR, ROLE_PACK_ID, ROLE_SLOT, canonicalRoleValue, roleDigest, roleHashValid, roleStudyFamily,
	validateRoleInput, type RolePackInput,
} from '../core/role-pack'
import { computeSkinMatrices, computeWorldTransforms } from '../geo/rig'
import { decodeBlenderAsset } from './blender-mesh'
import type { HumanAssetLevel, HumanAssetManifest, HumanAssets } from './human-assets'
import { overlayHumanMotionClip, sampleHumanMotion, validateHumanMotionPose } from './human-motion'

/** Authored barrel tip: a bind-pose model-space point, carried by `bone` (usually `hand_r`). */
export interface RoleMuzzle {
	readonly pos: readonly number[]
	readonly bone: string
}
export interface RolePackManifest extends Omit<HumanAssetManifest, 'levels'> {
	readonly role: string
	readonly slots: readonly string[]
	readonly suppliedInput: RolePackInput
	readonly motionBinding: { readonly manifestSha256: string; readonly bindRigSha256: string; readonly referenceModelSourceSha256: string }
	readonly referenceSources: HumanAssetLevel['externalSources']
	readonly levels: readonly Omit<HumanAssetLevel, 'externalSources'>[]
	/** Optional. Absent, the muzzle is derived from LOD0; see `resolveRoleMuzzle`. */
	readonly muzzle?: RoleMuzzle
}
export interface ResolvedRoleMuzzle {
	/** Bind-pose point and the index of the bone that carries it. */
	readonly pos: readonly [number, number, number]
	readonly bone: number
	/** The same point in the held aim pose, model space: where the barrel is when he fires. */
	readonly anchor: readonly [number, number, number]
	readonly source: 'manifest' | 'derived'
	readonly direction: readonly [number, number, number]
}
export interface RolePack extends Omit<HumanAssets, 'manifest'> {
	readonly manifest: RolePackManifest
	/** `web/.forge/<dir>/`; the atlas lives in `<dir>-surfaces/`. */
	readonly dir: string
	readonly muzzle: ResolvedRoleMuzzle | null
}
export interface RolePackCandidate {
	readonly dir: string
	readonly manifest: RolePackManifest | undefined
	readonly url: string | undefined
}

const manifests = import.meta.glob<RolePackManifest>('../../.forge/*/manifest.json', { eager: true, import: 'default' })
const packs = import.meta.glob<string>('../../.forge/*/lods.ssmesh.gz', { eager: true, query: '?url', import: 'default' })
const motionFiles = import.meta.glob<string>('../../.forge/human-motion/manifest.json', { eager: true, query: '?raw', import: 'default' })
const DIR_OF = /\/\.forge\/([^/]+)\/(?:manifest\.json|lods\.ssmesh\.gz)$/
const CAPS = [6000, 2000, 600]
const MAX_BYTES = 6 * 1024 * 1024
/** A declared muzzle may sit just past the mesh it belongs to (a flash leaves the tip), no further. */
const MUZZLE_SLACK = 0.02
const MUZZLE_BONE = 'hand_r'
const FULL_WEIGHT = 0.999
const AIM_CLIP = 'infantry-aim-v1'
const bad = (dir: string, message: string): never => { throw new Error(`Role pack ${dir}: ${message}`) }

/** The schema, not the directory name, decides what a role pack is. */
function isRolePackShape(m: unknown): boolean {
	return m !== null && typeof m === 'object' && 'role' in m && 'slots' in m && 'motionBinding' in m
}

/** Every bundled role pack, the rifle first and the rest in directory order. Build-time data only. */
export function rolePackCandidates(manifestRecord: Record<string, unknown> = manifests,
	packRecord: Record<string, string> = packs): RolePackCandidate[] {
	const byDir = new Map<string, { manifest?: RolePackManifest; url?: string }>()
	for (const [key, manifest] of Object.entries(manifestRecord)) {
		const dir = DIR_OF.exec(key)?.[1]
		if (dir && isRolePackShape(manifest)) byDir.set(dir, { manifest: manifest as RolePackManifest })
	}
	for (const [key, url] of Object.entries(packRecord)) {
		const entry = byDir.get(DIR_OF.exec(key)?.[1] ?? '')
		if (entry) entry.url = url
	}
	return [...byDir].sort(([a], [b]) => a === RIFLE_PACK.dir ? -1 : b === RIFLE_PACK.dir ? 1 : a < b ? -1 : a > b ? 1 : 0)
		.map(([dir, entry]) => ({ dir, manifest: entry.manifest, url: entry.url }))
}

/** Complete metadata preflight before any byte is fetched or decoded. */
export function validateRolePackManifest(m: RolePackManifest, dir: string, atlasSource: string, reference: HumanAssets): void {
	const fail = (message: string): never => bad(dir, message)
	const rifle = dir === RIFLE_PACK.dir
	if (!ROLE_PACK_DIR.test(dir) || !m || typeof m !== 'object' || m.schema !== 1 || typeof m.id !== 'string' || !ROLE_PACK_ID.test(m.id) ||
		m.id === 'infantry-v1' || typeof m.role !== 'string' || !/^[a-z][a-z0-9.-]{0,23}$/.test(m.role) ||
		!Array.isArray(m.slots) || m.slots.length < 1 || m.slots.length > 8 || new Set(m.slots).size !== m.slots.length ||
		m.slots.some(s => typeof s !== 'string' || !ROLE_SLOT.test(s)) ||
		m.compression !== 'gzip' || m.file !== 'lods.ssmesh.gz' || !Array.isArray(m.levels) || m.levels.length !== 3) fail('unsupported role or pack')
	// The rifle keeps exactly the identity it shipped with; nothing else may borrow it.
	if (rifle ? m.id !== RIFLE_PACK.id || m.role !== RIFLE_PACK.role || canonicalRoleValue(m.slots) !== canonicalRoleValue(RIFLE_PACK.slots)
		: m.id === RIFLE_PACK.id) fail('pinned rifle identity')
	validateRoleInput(m.suppliedInput, rifle ? RIFLE_PACK.input : undefined)
	if (!Number.isSafeInteger(m.bytes) || m.bytes < 96 || m.bytes > MAX_BYTES ||
		!Number.isSafeInteger(m.storedBytes) || m.storedBytes < 1 || m.storedBytes > 6.1 * 1024 * 1024 || !roleHashValid(m.sha256) ||
		!roleHashValid(atlasSource) || m.parentSourceSha256 !== atlasSource) fail('pack budget or atlas binding')
	const study = roleStudyFamily(m.parentSourcePath, 0)
	if (!study || (rifle && study !== RIFLE_PACK.study)) fail('saved study provenance')
	const binding = m.motionBinding
	if (!binding || !roleHashValid(binding.manifestSha256) || !roleHashValid(binding.bindRigSha256) ||
		binding.referenceModelSourceSha256 !== reference.manifest.parentSourceSha256 ||
		canonicalRoleValue(m.referenceSources) !== canonicalRoleValue(reference.motion.manifest.externalSources)) fail('reference motion provenance')
	const expectedRig = canonicalRoleValue(reference.manifest.levels[0].rig)
	let end = 0, previous = Infinity
	for (let i = 0; i < 3; i++) {
		const e = m.levels[i]
		if (!e || e.level !== i || e.skinned !== true || e.hidden === true || roleStudyFamily(e.sourcePath, i) !== study || !roleHashValid(e.sourceSha256) ||
			!Number.isSafeInteger(e.triangles) || e.triangles < 1 || e.triangles > CAPS[i] || e.triangles >= previous ||
			!Number.isSafeInteger(e.vertices) || e.vertices < 3 || e.vertices > e.triangles * 3) fail('LOD source or budget')
		const size = 32 + e.vertices * 76 + Math.ceil(e.vertices / 4) * 4 + e.triangles * 12
		if (e.offset !== end || e.bytes !== size || e.offset % 4 || e.bytes % 4 || end + e.bytes > m.bytes || !roleHashValid(e.sha256)) fail('LOD range')
		if (canonicalRoleValue(e.rig) !== expectedRig || e.rig.bones.length !== 20) fail('incompatible bind rig')
		if (e.materialSet !== m.id || e.alphaCutout === true || !Array.isArray(e.materialTable) || e.materialTable.length !== 1 ||
			e.materialTable[0].set !== m.id || e.materialTable[0].zone !== 0 || e.materialTable[0].layer !== 0) fail('material mapping')
		if (!e.uvMapping || e.uvMapping.origin !== 'bottom-left' || e.uvMapping.projectedObjects !== 0 ||
			!Number.isSafeInteger(e.uvMapping.authoredObjects) || e.uvMapping.authoredObjects < 1 || e.uvMapping.authoredObjects > 4096) fail('authored atlas UVs')
		if (!Array.isArray(e.bounds) || e.bounds.length !== 2 || e.bounds.some(v => !Array.isArray(v) || v.length !== 3 || v.some(n => !Number.isFinite(n) || Math.abs(n) > 1)) ||
			e.bounds[0].some((n, axis) => n > e.bounds[1][axis])) fail('bounds')
		end += e.bytes; previous = e.triangles
	}
	if (end !== m.bytes || m.levels[0].sourceSha256 !== m.parentSourceSha256 || m.levels[0].sourcePath !== m.parentSourcePath) fail('parent or payload coverage')
	const muzzle = m.muzzle
	if (muzzle !== undefined) {
		const b = m.levels[0].bounds
		if (!muzzle || typeof muzzle !== 'object' || Object.keys(muzzle).some(k => k !== 'pos' && k !== 'bone') ||
			!Array.isArray(muzzle.pos) || muzzle.pos.length !== 3 || typeof muzzle.bone !== 'string' ||
			muzzle.pos.some((v, axis) => typeof v !== 'number' || !Number.isFinite(v) || v < b[0][axis] - MUZZLE_SLACK || v > b[1][axis] + MUZZLE_SLACK) ||
			!m.levels[0].rig.bones.some(bone => bone.name === muzzle.bone)) fail('muzzle anchor')
	}
}

type DecodedLevel = ReturnType<typeof decodeBlenderAsset>

/**
 * Where this body's shot leaves, or null when the manifest names no muzzle and nothing in LOD0
 * rides the right hand.
 *
 * Derived, it is the most-forward LOD0 vertex weighted entirely to `hand_r` in bind pose: the
 * tip of whatever the hand carries. Either way the bind point is then carried through the held
 * aim, because a soldier fires aimed -- measured on the rifle, the aimed tip sits 6 cm higher
 * than the bind one, 16% of his height. The roster barrel it replaces was another body's gun.
 */
export function resolveRoleMuzzle(m: RolePackManifest, level0: DecodedLevel, reference: Pick<HumanAssets, 'motion' | 'timed'>): ResolvedRoleMuzzle | null {
	const skeleton = level0.rig!.skeleton, mesh = level0.mesh
	let pos: [number, number, number] | null = null, bone: number, source: ResolvedRoleMuzzle['source']
	if (m.muzzle) {
		bone = skeleton.names.indexOf(m.muzzle.bone)
		pos = [m.muzzle.pos[0], m.muzzle.pos[1], m.muzzle.pos[2]]
		source = 'manifest'
	} else {
		bone = skeleton.names.indexOf(MUZZLE_BONE)
		const joints = mesh.skinIndices, weights = mesh.skinWeights
		if (bone < 0 || !joints || !weights) return null
		for (let v = 0; v < mesh.vertexCount; v++) {
			let w = 0
			for (let k = 0; k < 4; k++) if (joints[v * 4 + k] === bone) w += weights[v * 4 + k]
			if (w >= FULL_WEIGHT && (pos === null || mesh.positions[v * 3] > pos[0]))
				pos = [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]
		}
		if (pos === null) return null
		source = 'derived'
	}
	if (bone < 0) return null
	const pose = skeleton.createPose(), world = skeleton.createMatrixBuffer(), skin = skeleton.createMatrixBuffer()
	sampleHumanMotion(reference.motion, pose, 0)
	const aim = reference.timed.get(AIM_CLIP)
	if (aim) overlayHumanMotionClip(aim, pose, aim.durationS, 1)
	computeWorldTransforms(pose, world)
	computeSkinMatrices(skeleton, world, skin)
	const o = bone * 16, [x, y, z] = pos
	const anchor: [number, number, number] = [
		skin[o] * x + skin[o + 4] * y + skin[o + 8] * z + skin[o + 12],
		skin[o + 1] * x + skin[o + 5] * y + skin[o + 9] * z + skin[o + 13],
		skin[o + 2] * x + skin[o + 6] * y + skin[o + 10] * z + skin[o + 14],
	]
	if (!anchor.every(Number.isFinite)) return null
	// Inverse held-aim rotation maps the authored forward axis back to bind space.
	const direction: [number,number,number] = [skin[o],skin[o+4],skin[o+8]]
	return { pos, bone, anchor, source, direction }
}

/** Same return shape as load; gate callers supply manifests and mock the bundled URL. */
export async function verifyRolePack(m: RolePackManifest, dir: string, url: string, atlasSource: string, reference: HumanAssets,
	motionFile: string): Promise<RolePack> {
	validateRolePackManifest(m, dir, atlasSource, reference)
	if (await roleDigest(new TextEncoder().encode(motionFile)) !== m.motionBinding.manifestSha256 ||
		canonicalRoleValue(JSON.parse(motionFile)) !== canonicalRoleValue(reference.motion.manifest) ||
		await roleDigest(new TextEncoder().encode(canonicalRoleValue(m.levels[0].rig))) !== m.motionBinding.bindRigSha256) bad(dir, 'motion file or bind-rig checksum')
	const local = new URL(url, location.href)
	if (local.origin !== location.origin || !['http:', 'https:'].includes(local.protocol)) bad(dir, 'pack must be same-origin')
	const bytes = await fetchAssetPack(url, m)
	for (const e of m.levels) if (await roleDigest(bytes.subarray(e.offset, e.offset + e.bytes)) !== e.sha256) bad(dir, 'LOD checksum')
	const levels = m.levels.map(e => {
		const decoded = decodeBlenderAsset(bytes, e, e.level > 0), mesh = decoded.mesh
		if (!decoded.rig || decoded.rig.skeleton.boneCount !== 20) bad(dir, 'decoded rig')
		const problem = mesh.validate(); if (problem) bad(dir, problem)
		for (const uv of mesh.uv0) if (uv < -1e-6 || uv > 1 + 1e-6) bad(dir, 'UV outside atlas')
		mesh.updateBounds()
		for (let i = 0; i < 3; i++) if (Math.abs(mesh.aabbMin[i] - e.bounds[0][i]) > 1e-6 || Math.abs(mesh.aabbMax[i] - e.bounds[1][i]) > 1e-6) bad(dir, 'decoded bounds')
		validateHumanMotionPose(reference.motion, decoded.rig!.skeleton.createPose())
		return decoded
	})
	return { manifest: m, dir, levels, motion: reference.motion, timed: reference.timed, muzzle: resolveRoleMuzzle(m, levels[0], reference) }
}

export interface RolePackFailure {
	readonly dir: string
	/** The slots the pack claimed, so flag callers can judge demand/fatality after a refusal. */
	readonly slots: readonly string[]
	readonly reason: string
}
export interface RolePackLoad {
	readonly packs: RolePack[]
	/** One entry per refused pack. Never thrown here: whether a refusal is fatal is the caller's flag. */
	readonly failures: RolePackFailure[]
}

/**
 * Verify every bundled role pack independently. `include` filters by directory and claimed
 * slots (the flags live with the caller); `atlasSourceOf` answers the uploaded atlas's source
 * binding for a pack id, undefined when materials has no such atlas. One pack's failure never
 * touches another.
 */
export async function loadRolePacks(reference: HumanAssets, atlasSourceOf: (id: string) => string | undefined,
	include: (dir: string, slots: readonly string[]) => boolean = () => true, candidates: readonly RolePackCandidate[] = rolePackCandidates()): Promise<RolePackLoad> {
	const loaded: RolePack[] = [], failures: RolePackFailure[] = []
	const motionFile = Object.values(motionFiles)[0]
	for (const { dir, manifest, url } of candidates) {
		if (!include(dir, manifest?.slots ?? [])) continue
		try {
			if (!manifest || !url) bad(dir, 'incomplete optional pack')
			if (!motionFile) bad(dir, 'no bundled motion manifest to bind against')
			const atlasSource = atlasSourceOf(manifest!.id)
			if (!atlasSource) bad(dir, `atlas ${manifest!.id} is not loaded`)
			loaded.push(await verifyRolePack(manifest!, dir, url!, atlasSource!, reference, motionFile!))
		} catch (error) {
			failures.push({ dir, slots: manifest?.slots ?? [], reason: error instanceof Error ? error.message : String(error) })
		}
	}
	return { packs: loaded, failures }
}
