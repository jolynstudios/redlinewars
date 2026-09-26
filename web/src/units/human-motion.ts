// Saved Blender action samples. Loading/verification allocates at boot; sampling does not.
import { fetchAssetPack } from '../core/asset-pack'
import type { Pose } from '../geo/rig'
import type { BlenderAsset } from './blender-mesh'

type Rig = NonNullable<BlenderAsset['rig']>
export interface HumanMotionBinding {
	readonly parentSourceSha256: string
	readonly levels: readonly { readonly sourceSha256: string; readonly rig?: Rig }[]
}
export interface HumanMotionManifest {
	readonly schema: number
	readonly id: string
	readonly frames: number
	readonly samples: number
	readonly boneCount: number
	readonly strideM: number
	readonly channels: string
	readonly compression: string
	readonly file: string
	readonly bytes: number
	readonly storedBytes: number
	readonly sha256: string
	readonly rig: Rig
	readonly sourcePath: string
	readonly sourceSha256: string
	readonly parentSourceSha256: string
	readonly modelSourceSha256: string
	readonly externalSources: readonly { readonly id: string; readonly sha256: string; readonly url: string; readonly license: string }[]
	readonly stanceFraction: number
	/** Bones the timed clips are allowed to key. Everything else stays on the walk. */
	readonly upperBodyBones: readonly number[]
	readonly clips: readonly HumanMotionClipEntry[]
}
/** One time-driven action saved beside the walk: the aim transition and the recoil pulse. */
export interface HumanMotionClipEntry {
	readonly id: string
	readonly file: string
	readonly frames: number
	readonly samples: number
	readonly durationS: number
	readonly loop: boolean
	readonly bytes: number
	readonly storedBytes: number
	readonly sha256: string
	readonly description: string
}
export interface HumanTimedClip {
	readonly entry: HumanMotionClipEntry
	readonly frames: number
	readonly samples: number
	readonly durationS: number
	readonly loop: boolean
	readonly boneCount: number
	/** Bone indices this clip owns, ascending. Sampling touches no other bone. */
	readonly bones: Int32Array
	/** Same layout as the walk: frame-major, bone-major, translation delta then quaternion. */
	readonly data: Float32Array
}
export interface HumanMotionClip {
	readonly manifest: HumanMotionManifest
	readonly frames: number
	readonly samples: number
	readonly boneCount: number
	readonly strideM: number
	/** Frame-major, bone-major: translation delta xyz then absolute local quaternion xyzw. */
	readonly data: Float32Array
}

const SHA = /^[a-f0-9]{64}$/
const MAX_BYTES = 257 * 20 * 7 * 4
const MAX_STORED = MAX_BYTES + Math.ceil(MAX_BYTES / 16384) * 5 + 64
const manifests = import.meta.glob<HumanMotionManifest>('../../.forge/human-motion/manifest.json', { eager: true, import: 'default' })
const packs = import.meta.glob<string>('../../.forge/human-motion/walk.ssanim.gz', { eager: true, query: '?url', import: 'default' })
const clipPacks = import.meta.glob<string>('../../.forge/human-motion/*.ssanim.gz', { eager: true, query: '?url', import: 'default' })
const CLIP_FILE = /^[a-z][a-z0-9]{1,15}\.ssanim\.gz$/
const CLIP_ID = /^infantry-[a-z][a-z0-9-]{1,23}$/
const MAX_CLIPS = 4

/** Resolve one clip's bundled URL by file name, never by position in the glob record. */
export function humanMotionClipUrl(file: string): string | undefined {
	for (const key in clipPacks) if (key.endsWith('/' + file)) return clipPacks[key]
	return undefined
}

// Structural comparison, independent of JSON property insertion order. Boot only.
function canonical(value: unknown): string {
	if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
	if (value !== null && typeof value === 'object') {
		const object = value as Record<string, unknown>
		return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}'
	}
	return JSON.stringify(value) ?? 'null'
}

/** Binding is mandatory: animation from another saved body/rig must never be substituted. */
export function validateHumanMotionManifest(m: HumanMotionManifest, expected: HumanMotionBinding): void {
	if (!m || m.schema !== 1 || m.id !== 'infantry-walk-v1' || m.compression !== 'gzip' || m.file !== 'walk.ssanim.gz' ||
		m.channels !== 'local-translation-delta.xyz,local-rotation.xyzw' || m.boneCount !== 20 ||
		!Number.isSafeInteger(m.samples) || m.samples < 8 || m.samples > 256 || m.frames !== m.samples + 1 ||
		!Number.isFinite(m.strideM) || m.strideM < .0001 || m.strideM > 10 ||
		!Number.isFinite(m.stanceFraction) || m.stanceFraction <= 0 || m.stanceFraction >= 1)
		throw new Error('Invalid human motion dimensions/channels')
	if (m.bytes !== m.frames * m.boneCount * 7 * 4 || m.bytes > MAX_BYTES ||
		!Number.isSafeInteger(m.storedBytes) || m.storedBytes < 1 || m.storedBytes > MAX_STORED ||
		![m.sha256, m.sourceSha256, m.parentSourceSha256, m.modelSourceSha256].every(s => typeof s === 'string' && SHA.test(s)))
		throw new Error('Invalid human motion byte budget/hash')
	if (typeof m.sourcePath !== 'string' || !m.sourcePath.startsWith('art/blender/') || !m.sourcePath.endsWith('.blend') ||
		/[\\\u0000-\u001f]/.test(m.sourcePath) || m.sourcePath.split('/').some(p => p === '.' || p === '..' || p === ''))
		throw new Error('Invalid human motion source path')
	if (!Array.isArray(m.externalSources) || !m.externalSources.length || m.externalSources.length > 16)
		throw new Error('Missing human motion external provenance')
	const ids = new Set<string>()
	for (const ref of m.externalSources) {
		if (!ref || typeof ref.id !== 'string' || !ref.id || ids.has(ref.id) || !SHA.test(ref.sha256) ||
			typeof ref.url !== 'string' || !ref.url.startsWith('https://') || !['CC0-1.0', 'CC-BY-4.0'].includes(ref.license))
			throw new Error('Invalid human motion external provenance')
		ids.add(ref.id)
	}
	if (!m.rig || !Array.isArray(m.rig.bones) || m.rig.bones.length !== m.boneCount || m.rig.strideM !== m.strideM)
		throw new Error('Invalid human motion rig')
	const names = new Set<string>()
	for (let i = 0; i < m.boneCount; i++) {
		const b: Rig['bones'][number] = m.rig.bones[i]
		if (!b || typeof b.name !== 'string' || !b.name || names.has(b.name) ||
			(i === 0 ? b.parent !== undefined : !Number.isInteger(b.parent) || (b.parent as number) < 0 || (b.parent as number) >= i) ||
			!b.pos || b.pos.length !== 3 || Array.from(b.pos).some(v => !Number.isFinite(v) || Math.abs(v) > 10))
			throw new Error('Invalid human motion bone binding')
		if (b.rot && (b.rot.length !== 4 || Array.from(b.rot).some(v => !Number.isFinite(v)) ||
			Math.abs(Math.hypot(...Array.from(b.rot)) - 1) > .001)) throw new Error('Invalid human motion bind rotation')
		if (b.scale && (b.scale.length !== 3 || Array.from(b.scale).some(v => !Number.isFinite(v) || v <= 0 || v > 10)))
			throw new Error('Invalid human motion bind scale')
		names.add(b.name)
	}
	if (!expected || expected.parentSourceSha256 !== m.parentSourceSha256 || !Array.isArray(expected.levels) ||
		expected.levels.length !== 3 || expected.levels[0]?.sourceSha256 !== m.modelSourceSha256)
		throw new Error('Human motion source/model binding mismatch')
	if (!Array.isArray(m.upperBodyBones) || !m.upperBodyBones.length || m.upperBodyBones.length >= m.boneCount)
		throw new Error('Invalid human motion clip bone mask')
	let previousBone = -1
	for (const bone of m.upperBodyBones) {
		// Ascending and unique, and never the root: a clip that could move the pelvis could
		// fight the walk that is still placing the feet.
		if (!Number.isSafeInteger(bone) || bone <= previousBone || bone < 1 || bone >= m.boneCount)
			throw new Error('Invalid human motion clip bone mask')
		previousBone = bone
	}
	if (!Array.isArray(m.clips) || m.clips.length > MAX_CLIPS) throw new Error('Invalid human motion clip list')
	const clipIds = new Set<string>(), clipFiles = new Set<string>([m.file])
	for (const clip of m.clips) {
		if (!clip || typeof clip.id !== 'string' || !CLIP_ID.test(clip.id) || clipIds.has(clip.id) ||
			typeof clip.file !== 'string' || !CLIP_FILE.test(clip.file) || clipFiles.has(clip.file) ||
			!Number.isSafeInteger(clip.samples) || clip.samples < 8 || clip.samples > 256 || clip.frames !== clip.samples + 1 ||
			!Number.isFinite(clip.durationS) || clip.durationS < .05 || clip.durationS > 4 || typeof clip.loop !== 'boolean' ||
			clip.bytes !== clip.frames * m.boneCount * 7 * 4 || clip.bytes > MAX_BYTES ||
			!Number.isSafeInteger(clip.storedBytes) || clip.storedBytes < 1 || clip.storedBytes > MAX_STORED ||
			typeof clip.sha256 !== 'string' || !SHA.test(clip.sha256) || typeof clip.description !== 'string' || !clip.description)
			throw new Error('Invalid human motion clip entry')
		clipIds.add(clip.id); clipFiles.add(clip.file)
	}
	const rig = canonical(m.rig)
	for (const level of expected.levels)
		if (!level || !SHA.test(level.sourceSha256) || !level.rig || canonical(level.rig) !== rig)
			throw new Error('Human motion LOD rig mismatch')
}

/** Fetches only a bundled same-origin pack; provenance URLs/paths are never fetched. */
export async function verifyHumanMotionPack(manifest: HumanMotionManifest, url: string, expected: HumanMotionBinding): Promise<HumanMotionClip> {
	validateHumanMotionManifest(manifest, expected)
	const local = new URL(url, location.href)
	if (local.origin !== location.origin || !['http:', 'https:'].includes(local.protocol))
		throw new Error('Human motion pack must be same-origin')
	const bytes = await fetchAssetPack(url, manifest)
	const data = new Float32Array(manifest.bytes / 4), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	for (let i = 0; i < data.length; i++) {
		const value = view.getFloat32(i * 4, true)
		if (!Number.isFinite(value)) throw new Error('Non-finite human motion sample')
		data[i] = value
	}
	for (let at = 0; at < data.length; at += 7) {
		if (Math.abs(data[at]) > 10 || Math.abs(data[at + 1]) > 10 || Math.abs(data[at + 2]) > 10)
			throw new Error('Human motion translation out of bounds')
		const norm = Math.hypot(data[at + 3], data[at + 4], data[at + 5], data[at + 6])
		if (Math.abs(norm - 1) > .001) throw new Error('Human motion quaternion is not unit length')
	}
	const last = manifest.samples * manifest.boneCount * 7
	for (let bone = 0; bone < manifest.boneCount; bone++) {
		const first = bone * 7, end = last + first
		for (let c = 0; c < 3; c++)
			if (Math.abs(data[first + c] - data[end + c]) > 1e-6) throw new Error('Human motion translation loop mismatch')
		const dot = data[first + 3] * data[end + 3] + data[first + 4] * data[end + 4] + data[first + 5] * data[end + 5] + data[first + 6] * data[end + 6]
		const sign = dot < 0 ? -1 : 1
		for (let c = 3; c < 7; c++)
			if (Math.abs(data[first + c] - sign * data[end + c]) > 1e-6) throw new Error('Human motion rotation loop mismatch')
	}
	return { manifest, data, frames: manifest.frames, samples: manifest.samples, boneCount: manifest.boneCount, strideM: manifest.strideM }
}

export async function loadHumanMotion(expected: HumanMotionBinding): Promise<HumanMotionClip | null> {
	const manifest = Object.values(manifests)[0], url = Object.values(packs)[0]
	if (!manifest && !url) return null
	if (!manifest || !url) throw new Error('Incomplete human motion pack')
	return verifyHumanMotionPack(manifest, url, expected)
}

/** Call once at boot for each pose/skeleton that will consume this clip. */
export function validateHumanMotionPose(clip: HumanMotionClip, pose: Pose): void {
	if (pose.skeleton.boneCount !== clip.boneCount || pose.t.length !== clip.boneCount * 3 ||
		pose.r.length !== clip.boneCount * 4 || pose.s.length !== clip.boneCount * 3)
		throw new Error('Human motion pose dimensions mismatch')
	for (let i = 0; i < clip.boneCount; i++) {
		const bone = clip.manifest.rig.bones[i]
		if (pose.skeleton.names[i] !== bone.name || pose.skeleton.parent[i] !== (bone.parent ?? -1))
			throw new Error('Human motion pose rig mismatch')
		for (let c = 0; c < 3; c++)
			if (pose.skeleton.bindT[i * 3 + c] !== Math.fround(bone.pos![c])) throw new Error('Human motion pose bind mismatch')
		const rotation = bone.rot, norm = rotation ? Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]) : 1
		for (let c = 0; c < 4; c++)
			if (Math.abs(pose.skeleton.bindR[i * 4 + c] - (rotation ? rotation[c] / norm : c === 3 ? 1 : 0)) > 1e-6)
				throw new Error('Human motion pose bind rotation mismatch')
		for (let c = 0; c < 3; c++)
			if (pose.skeleton.bindS[i * 3 + c] !== Math.fround(bone.scale?.[c] ?? 1)) throw new Error('Human motion pose bind scale mismatch')
	}
}

/** Model-space travelled distance, already interpolated and instance-scale corrected by
	* the caller. No clock, phase accumulator, scale writes or per-call allocation.
	* Clip and pose must have passed the boot verifiers; channels are read-only after load.
	*/
export function sampleHumanMotion(clip: HumanMotionClip, pose: Pose, distance: number): void {
	if (!Number.isFinite(distance)) throw new Error('Human motion distance must be finite')
	let phase = distance % clip.strideM
	if (phase < 0) phase += clip.strideM
	const frame = phase / clip.strideM * clip.samples
	const first = Math.min(clip.samples - 1, Math.floor(frame)), fraction = frame - first
	const data = clip.data, frameStride = clip.boneCount * 7
	for (let bone = 0; bone < clip.boneCount; bone++) {
		const a = first * frameStride + bone * 7, b = a + frameStride, t = bone * 3, r = bone * 4
		pose.t[t] = pose.skeleton.bindT[t] + data[a] + (data[b] - data[a]) * fraction
		pose.t[t + 1] = pose.skeleton.bindT[t + 1] + data[a + 1] + (data[b + 1] - data[a + 1]) * fraction
		pose.t[t + 2] = pose.skeleton.bindT[t + 2] + data[a + 2] + (data[b + 2] - data[a + 2]) * fraction
		const sign = data[a + 3] * data[b + 3] + data[a + 4] * data[b + 4] + data[a + 5] * data[b + 5] + data[a + 6] * data[b + 6] < 0 ? -1 : 1
		let x = data[a + 3] + (sign * data[b + 3] - data[a + 3]) * fraction
		let y = data[a + 4] + (sign * data[b + 4] - data[a + 4]) * fraction
		let z = data[a + 5] + (sign * data[b + 5] - data[a + 5]) * fraction
		let w = data[a + 6] + (sign * data[b + 6] - data[a + 6]) * fraction
		// Quaternion components are <= 1 here by construction, so the plain sqrt cannot
		// overflow and saves the 4-argument hypot V8 does not inline — this normaliser
		// runs per bone per infantry actor per frame.
		const inverse = 1 / Math.sqrt(x * x + y * y + z * z + w * w)
		x *= inverse; y *= inverse; z *= inverse; w *= inverse
		pose.r[r] = x; pose.r[r + 1] = y; pose.r[r + 2] = z; pose.r[r + 3] = w
	}
}

/**
 * Fetch and verify one timed clip against its manifest entry and the walk's bone mask.
 *
 * The mask is enforced here rather than trusted: every bone the clip does not own must be
 * exactly its bind pose in every frame. That is what makes an aim or a recoil safe to lay
 * over a walking actor, and it is the reason a recoil cannot become a whole-body jolt
 * without this check failing first.
 */
export async function verifyHumanMotionTimedClip(manifest: HumanMotionManifest, entry: HumanMotionClipEntry,
	url: string): Promise<HumanTimedClip> {
	if (!manifest.clips.includes(entry)) throw new Error('Human motion clip is not part of this manifest')
	const local = new URL(url, location.href)
	if (local.origin !== location.origin || !['http:', 'https:'].includes(local.protocol))
		throw new Error('Human motion pack must be same-origin')
	const bytes = await fetchAssetPack(url, entry)
	const boneCount = manifest.boneCount
	const data = new Float32Array(entry.bytes / 4), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	for (let i = 0; i < data.length; i++) {
		const value = view.getFloat32(i * 4, true)
		if (!Number.isFinite(value)) throw new Error('Non-finite human motion sample')
		data[i] = value
	}
	for (let at = 0; at < data.length; at += 7) {
		if (Math.abs(data[at]) > 10 || Math.abs(data[at + 1]) > 10 || Math.abs(data[at + 2]) > 10)
			throw new Error('Human motion translation out of bounds')
		const norm = Math.hypot(data[at + 3], data[at + 4], data[at + 5], data[at + 6])
		if (Math.abs(norm - 1) > .001) throw new Error('Human motion quaternion is not unit length')
	}
	const owned = new Uint8Array(boneCount)
	for (const bone of manifest.upperBodyBones) owned[bone] = 1
	for (let frame = 0; frame < entry.frames; frame++)
		for (let bone = 0; bone < boneCount; bone++) {
			if (owned[bone]) continue
			const at = (frame * boneCount + bone) * 7
			if (Math.abs(data[at]) > 1e-6 || Math.abs(data[at + 1]) > 1e-6 || Math.abs(data[at + 2]) > 1e-6 ||
				Math.abs(data[at + 3]) > 1e-6 || Math.abs(data[at + 4]) > 1e-6 || Math.abs(data[at + 5]) > 1e-6 ||
				Math.abs(Math.abs(data[at + 6]) - 1) > 1e-6)
				throw new Error('Human motion clip moves a bone outside its declared mask')
		}
	const last = entry.samples * boneCount * 7
	for (const bone of manifest.upperBodyBones) {
		const first = bone * 7, end = last + first
		let matches = true
		for (let c = 0; c < 3; c++) if (Math.abs(data[first + c] - data[end + c]) > 1e-6) matches = false
		const dot = data[first + 3] * data[end + 3] + data[first + 4] * data[end + 4] +
			data[first + 5] * data[end + 5] + data[first + 6] * data[end + 6]
		const sign = dot < 0 ? -1 : 1
		for (let c = 3; c < 7; c++) if (Math.abs(data[first + c] - sign * data[end + c]) > 1e-6) matches = false
		// A looping clip is a pulse that must return to where it started; a one-shot
		// transition must NOT, or it is not a transition.
		if (entry.loop && !matches) throw new Error('Looping human motion clip does not close: ' + entry.id)
	}
	if (!entry.loop) {
		let moved = false
		for (const bone of manifest.upperBodyBones) {
			const first = bone * 7, end = last + first
			for (let c = 0; c < 7; c++) if (Math.abs(data[first + c] - data[end + c]) > 1e-4) moved = true
		}
		if (!moved) throw new Error('One-shot human motion clip ends where it started: ' + entry.id)
	}
	return { entry, data, frames: entry.frames, samples: entry.samples, durationS: entry.durationS,
		loop: entry.loop, boneCount, bones: Int32Array.from(manifest.upperBodyBones) }
}

/** Load every timed clip the manifest declares. Boot only; allocates. */
export async function loadHumanMotionTimedClips(clip: HumanMotionClip): Promise<HumanTimedClip[]> {
	const loaded: HumanTimedClip[] = []
	for (const entry of clip.manifest.clips) {
		const url = humanMotionClipUrl(entry.file)
		if (url === undefined) throw new Error('Missing bundled human motion clip: ' + entry.file)
		loaded.push(await verifyHumanMotionTimedClip(clip.manifest, entry, url))
	}
	return loaded
}

/**
 * Lay a timed clip over an already-sampled pose, for the bones it owns, at `weight`.
 *
 * Seconds, not distance: an aim transition and a recoil pulse are events in time, and the
 * caller owns the clock. A non-looping clip clamps at both ends so an actor that finished
 * aiming holds the aimed pose instead of snapping back to the ready. No clock is read, no
 * phase is accumulated, and nothing is allocated.
 */
export function overlayHumanMotionClip(clip: HumanTimedClip, pose: Pose, seconds: number, weight: number): void {
	if (!Number.isFinite(seconds) || !Number.isFinite(weight)) throw new Error('Human motion clip time must be finite')
	const blend = weight < 0 ? 0 : weight > 1 ? 1 : weight
	if (blend === 0) return
	const duration = clip.durationS
	let time = seconds
	if (clip.loop) {
		time = time % duration
		if (time < 0) time += duration
	} else time = time < 0 ? 0 : time > duration ? duration : time
	const frame = time / duration * clip.samples
	const first = Math.min(clip.samples - 1, Math.floor(frame)), fraction = frame - first
	const data = clip.data, frameStride = clip.boneCount * 7, bones = clip.bones
	for (let index = 0; index < bones.length; index++) {
		const bone = bones[index]
		const a = first * frameStride + bone * 7, b = a + frameStride, t = bone * 3, r = bone * 4
		const sign = data[a + 3] * data[b + 3] + data[a + 4] * data[b + 4] +
			data[a + 5] * data[b + 5] + data[a + 6] * data[b + 6] < 0 ? -1 : 1
		let x = data[a + 3] + (sign * data[b + 3] - data[a + 3]) * fraction
		let y = data[a + 4] + (sign * data[b + 4] - data[a + 4]) * fraction
		let z = data[a + 5] + (sign * data[b + 5] - data[a + 5]) * fraction
		let w = data[a + 6] + (sign * data[b + 6] - data[a + 6]) * fraction
		let inverse = 1 / Math.sqrt(x * x + y * y + z * z + w * w)
		x *= inverse; y *= inverse; z *= inverse; w *= inverse
		// Blend against whatever the walk left here, so a firing actor that is still moving
		// keeps its gait underneath and only its upper body is overwritten.
		const cx = pose.r[r], cy = pose.r[r + 1], cz = pose.r[r + 2], cw = pose.r[r + 3]
		const toward = cx * x + cy * y + cz * z + cw * w < 0 ? -1 : 1
		let bx = cx + (toward * x - cx) * blend
		let by = cy + (toward * y - cy) * blend
		let bz = cz + (toward * z - cz) * blend
		let bw = cw + (toward * w - cw) * blend
		inverse = 1 / Math.sqrt(bx * bx + by * by + bz * bz + bw * bw)
		pose.r[r] = bx * inverse; pose.r[r + 1] = by * inverse
		pose.r[r + 2] = bz * inverse; pose.r[r + 3] = bw * inverse
		for (let c = 0; c < 3; c++) {
			const target = pose.skeleton.bindT[t + c] + data[a + c] + (data[b + c] - data[a + c]) * fraction
			pose.t[t + c] += (target - pose.t[t + c]) * blend
		}
	}
}
