// Optional boot-only authored tree chains. CPU validation only; no GPU or simplification.
import { fetchAssetPack } from '../core/asset-pack'
import PALETTE from '../core/blender-palette.json'
import { decodeBlenderAsset, type BlenderAsset } from './blender-mesh'

export interface TreeAssetLevel extends BlenderAsset {
	readonly level: number
	readonly offset: number
	readonly bytes: number
	readonly vertices: number
	readonly triangles: number
	readonly sha256: string
	readonly skinned: boolean
	readonly sourcePath: string
	readonly sourceSha256: string
	readonly rig: NonNullable<BlenderAsset['rig']>
	readonly bounds: readonly [readonly number[], readonly number[]]
	/** 'cards' = atlas card foliage validated as complete double-sided cards;
	 *  'cluster' = dense cluster foliage validated per triangle (owner/zone/tangent). */
	readonly foliage?: 'cards' | 'cluster'
	readonly clusters?: number
}
export interface TreeAssetEntry {
	readonly parentSourcePath: string
	readonly parentSourceSha256: string
	readonly levels: readonly TreeAssetLevel[]
}
export interface TreeAssetsManifest {
	readonly schema: number
	readonly id: string
	readonly file: string
	readonly compression: string
	readonly bytes: number
	readonly storedBytes: number
	readonly sha256: string
	readonly foliageSourceSha256: string
	readonly assets: Readonly<Record<string, TreeAssetEntry>>
}
export interface TreeAssets {
	readonly manifest: TreeAssetsManifest
	readonly assets: Readonly<Record<string, {
		readonly manifest: TreeAssetEntry
		readonly levels: readonly ReturnType<typeof decodeBlenderAsset>[]
	}>>
}
export interface TreeAssetVerificationOptions {
	/** CPU/private witness only. The production boot loader never enables this. */
	readonly allowPrivateSources?: boolean
}

const manifests = import.meta.glob<TreeAssetsManifest>('../../.forge/tree-lods/manifest.json', { eager: true, import: 'default' })
const packs = import.meta.glob<string>('../../.forge/tree-lods/trees.ssmesh.gz', { eager: true, query: '?url', import: 'default' })
const MAX_BYTES = 32 * 1024 * 1024
const EPS = 2e-6 // exported quant6 positions, then float32 storage
const bad = (reason: string): never => { throw new Error('Tree assets: ' + reason) }
const hashValid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const count = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
const vector = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 100)
const pathValid = (v: unknown, privateSources: boolean): v is string => typeof v === 'string' && (v.startsWith('art/blender/') || privateSources && v.startsWith('web/.artifacts/')) && v.endsWith('.blend') &&
	!/[\\%?#:\u0000-\u001f]/.test(v) && !v.split('/').some(p => !p || p === '.' || p === '..')
function canonical(v: unknown): string {
	if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
	if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}'
	return JSON.stringify(v) ?? 'null'
}
function validateRig(r: TreeAssetLevel['rig']): void {
	if (!r || !Array.isArray(r.bones) || !count(r.bones.length, 2, 256)) bad('invalid tree rig')
	const names = new Set<string>()
	for (const [i, b] of r.bones.entries()) {
		if (!b || typeof b.name !== 'string' || !b.name || names.has(b.name) || !vector(b.pos, 3) ||
			(i === 0 ? b.parent !== undefined : !count(b.parent!, 0, i - 1)) || !count(b.kind!, 0, 20) ||
			(b.axis !== undefined && !count(b.axis, 0, 2)) ||
			(b.rot !== undefined && (!vector(b.rot, 4) || Math.abs(Math.hypot(...b.rot) - 1) > 1e-6)) ||
			(b.scale !== undefined && (!vector(b.scale, 3) || b.scale.some(v => v < .0001)))) bad('invalid tree bone')
		names.add(b.name)
	}
	for (const a of [r.turretBones, r.wheelBones, r.wheelRadii, r.legBones, r.legPhase, r.rotors, r.oscillators])
		if (!Array.isArray(a) || a.length) bad('unsupported non-wind tree animation')
	if (!Number.isFinite(r.strideM) || r.strideM < 0 || r.strideM > 100 || !Array.isArray(r.winds) || !count(r.winds.length, 1, r.bones.length - 1)) bad('invalid wind rig')
	const seen = new Set<number>()
	for (const w of r.winds!) {
		if (!w || !count(w.bone, 1, r.bones.length - 1) || seen.has(w.bone) || !Number.isFinite(w.speed) || w.speed <= 0 || w.speed > 100 ||
			!Number.isFinite(w.phase) || Math.abs(w.phase) > 100 || !Number.isFinite(w.amplitude) || w.amplitude < 0 || w.amplitude > .2) bad('invalid wind parameters')
		seen.add(w.bone)
	}
}

/** Preflight all metadata before fetching. Ranges follow ascending offsets, not record order. */
export function validateTreeAssetsManifest(m: TreeAssetsManifest, expectedFoliageSourceSha256: string, options: TreeAssetVerificationOptions = {}): void {
	if (!m || m.schema !== 1 || m.id !== 'trees-v1' || m.file !== 'trees.ssmesh.gz' || m.compression !== 'gzip' ||
		!count(m.bytes, 96, MAX_BYTES) || !count(m.storedBytes, 1, MAX_BYTES + Math.ceil(MAX_BYTES / 16384) * 5 + 64) || !hashValid(m.sha256)) bad('invalid schema or pack budget/hash')
	if (!hashValid(expectedFoliageSourceSha256) || m.foliageSourceSha256 !== expectedFoliageSourceSha256) bad('foliage source binding mismatch')
	if (!m.assets || Array.isArray(m.assets) || typeof m.assets !== 'object' || !count(Object.keys(m.assets).length, 1, 32)) bad('invalid assets record')
	const ranges: TreeAssetLevel[] = []
	for (const [id, asset] of Object.entries(m.assets)) {
		if (!/^(?:tc|t)[0-9]{2}$/.test(id) || !asset || !pathValid(asset.parentSourcePath, options.allowPrivateSources === true) || !hashValid(asset.parentSourceSha256) ||
			!Array.isArray(asset.levels) || asset.levels.length !== 3) bad('invalid asset source or missing LOD')
		if (asset.parentSourcePath !== asset.levels[0]?.sourcePath || asset.parentSourceSha256 !== asset.levels[0]?.sourceSha256) bad('parent source differs from LOD0')
		let previous = Infinity
		for (const [i, l] of asset.levels.entries()) {
			if (!l || l.level !== i || l.template !== 'tree' || l.skinned !== true || l.hidden === true ||
				!count(l.triangles, 1, 100000) || l.triangles >= previous || !count(l.vertices, 3, l.triangles * 3)) bad('LOD count/order/budget mismatch')
			previous = l.triangles
			const exact = 32 + l.vertices * 76 + Math.ceil(l.vertices / 4) * 4 + l.triangles * 12
			if (!count(l.offset, 0, m.bytes) || l.offset % 4 || l.bytes !== exact || l.offset + l.bytes > m.bytes || !hashValid(l.sha256)) bad('invalid LOD range')
			if (!pathValid(l.sourcePath, options.allowPrivateSources === true) || !hashValid(l.sourceSha256)) bad('invalid LOD source')
			// foliage-v1 is the immutable 29-layer prefix, independent of later
			// aircraft paint additions to industrial-v1. Keep every row checked.
			if (l.materialSet !== 'foliage-v1' || l.alphaCutout !== true || !Array.isArray(l.materialTable) || l.materialTable.length !== 29) bad('invalid foliage material binding')
			for (const [zone, p] of PALETTE.slice(0, 29).entries()) {
				const row = l.materialTable![zone]
				if (!row || row.zone !== zone || row.layer !== zone || row.set !== 'foliage-v1' || row.name !== p.name) bad('invalid material table')
			}
			if (!Array.isArray(l.bounds) || l.bounds.length !== 2 || !vector(l.bounds[0], 3) || !vector(l.bounds[1], 3) || l.bounds[0].some((v, a) => v > l.bounds[1][a])) bad('invalid bounds')
			validateRig(l.rig)
			if (i) {
				const base = asset.levels[0]
				if (canonical(l.rig) !== canonical(base.rig) || canonical(l.materialTable) !== canonical(base.materialTable)) bad('LOD rig/material mismatch')
				if (l.bounds[0].some((v, a) => v < base.bounds[0][a] - EPS) || l.bounds[1].some((v, a) => v > base.bounds[1][a] + EPS)) bad('LOD bounds escape L0')
			}
			ranges.push(l)
		}
	}
	let end = 0
	for (const l of ranges.sort((a, b) => a.offset - b.offset)) { if (l.offset !== end) bad('noncontiguous/overlapping LOD ranges'); end += l.bytes }
	if (end !== m.bytes) bad('unclaimed pack bytes')
}

type V3 = number[]
const sub = (a: V3, b: V3) => a.map((v, i) => v - b[i])
const cross = (a: V3, b: V3) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a.reduce((s, v, i) => s + v * b[i], 0)
const unit = (v: V3) => { const n = Math.hypot(...v); if (n < 1e-12) bad('degenerate card geometry'); return v.map(x => x / n) }

/** Dense cluster foliage: every foliage triangle keeps one zone, one consistent
 *  tangent handedness and every vertex one rigid wind owner. Arbitrary leaf shapes
 *  are the point, so card pairing/UV-corner invariants do not apply. */
function validateClusterFoliage(mesh: ReturnType<typeof decodeBlenderAsset>['mesh']): Set<number> {
	const owners = new Set<number>()
	for (let i = 0; i < mesh.triangleCount * 3; i += 3) {
		const ids = Array.from(mesh.indices.subarray(i, i + 3)), zone = mesh.materialZone[ids[0]]
		if (ids.some(v => mesh.materialZone[v] !== zone)) bad('mixed triangle material')
		const ws = ids.map(v => mesh.tangents[v * 4 + 3])
		if (ws.some(w => w !== 1 && w !== -1) || ws.some(w => w !== ws[0])) bad('mixed/invalid triangle tangent handedness')
		if (zone !== 6 && zone !== 26) continue
		const p = ids.map(v => Array.from(mesh.positions.subarray(v * 3, v * 3 + 3)))
		unit(cross(sub(p[1], p[0]), sub(p[2], p[0])))
		for (const v of ids) {
			let bone = -1
			for (let j = 0; j < 4; j++) if (mesh.skinWeights![v * 4 + j] !== 0) {
				if (bone !== -1 || mesh.skinWeights![v * 4 + j] !== 1) bad('cluster foliage must have one rigid owner')
				bone = mesh.skinIndices![v * 4 + j]
			}
			if (bone < 0) bad('cluster foliage vertex without wind owner')
			owners.add(bone)
		}
	}
	if (!owners.size) bad('missing foliage clusters')
	return owners
}

/** Allocations here are boot-only. Pair triangle halves, then pair complete opposite sides.
 * Opposite sides may use different diagonals. No UV bounding-box-only acceptance. */
function validateCards(mesh: ReturnType<typeof decodeBlenderAsset>['mesh']): Set<number> {
	type Corner = { uv: number; key: string; p: V3 }
	type Half = { corners: Corner[]; normal: V3; sign: number }
	const halves = new Map<string, Half[]>(), owners = new Set<number>()
	for (let i = 0; i < mesh.triangleCount * 3; i += 3) {
		const ids = Array.from(mesh.indices.subarray(i, i + 3)), zone = mesh.materialZone[ids[0]]
		if (ids.some(v => mesh.materialZone[v] !== zone)) bad('mixed triangle material')
		const ws = ids.map(v => mesh.tangents[v * 4 + 3])
		if (ws.some(w => w !== 1 && w !== -1) || ws.some(w => w !== ws[0])) bad('mixed/invalid triangle tangent handedness')
		if (zone !== 6 && zone !== 26) continue
		let owner = -1
		const corners = ids.map(v => {
			let bone = -1
			for (let j = 0; j < 4; j++) if (mesh.skinWeights![v * 4 + j] !== 0) {
				if (bone !== -1 || mesh.skinWeights![v * 4 + j] !== 1) bad('card must have one rigid owner')
				bone = mesh.skinIndices![v * 4 + j]
			}
			if (bone < 0 || (owner !== -1 && bone !== owner)) bad('mixed card owners')
			owner = bone
			const u = mesh.uv0[v * 2], t = mesh.uv0[v * 2 + 1]
			if (Math.abs(u - Math.round(u)) > 1e-6 || Math.abs(t - Math.round(t)) > 1e-6 || u < -1e-6 || u > 1 + 1e-6 || t < -1e-6 || t > 1 + 1e-6) bad('card does not retain full UV corners')
			const uv = Math.round(u) + 2 * Math.round(t), p = Array.from(mesh.positions.subarray(v * 3, v * 3 + 3))
			return { uv, p, key: uv + ':' + p.join(',') }
		})
		if (new Set(corners.map(c => c.uv)).size !== 3) bad('degenerate card UV triangle')
		const e1 = sub(corners[1].p, corners[0].p), e2 = sub(corners[2].p, corners[0].p), normal = unit(cross(e1, e2))
		const uv = corners.map(c => [c.uv % 2, Math.floor(c.uv / 2)])
		const du1 = uv[1][0] - uv[0][0], du2 = uv[2][0] - uv[0][0], dv1 = uv[1][1] - uv[0][1], dv2 = uv[2][1] - uv[0][1], sign = du1 * dv2 - du2 * dv1
		const uvB = unit(e2.map((v, a) => (du1 * v - du2 * e1[a]) / sign))
		for (const v of ids) {
			const n = Array.from(mesh.normals.subarray(v * 3, v * 3 + 3)), t = Array.from(mesh.tangents.subarray(v * 4, v * 4 + 3))
			if (dot(n, normal) <= .05 || dot(cross(n, t).map(x => x * ws[0]), uvB) <= .0001) bad('card normal/UV tangent orientation mismatch')
		}
		const diagonal = corners.filter(c => corners.some(d => (c.uv ^ d.uv) === 3)).map(c => c.key).sort()
		const key = zone + '/' + owner + '/' + sign + '/' + diagonal.join('|')
		const group = halves.get(key) ?? []; group.push({ corners, normal, sign }); halves.set(key, group); owners.add(owner)
	}
	const cards = new Map<string, Half[]>()
	for (const [key, h] of halves) {
		if (h.length !== 2 || dot(h[0].normal, h[1].normal) < .9999) bad('incomplete or nonplanar card side')
		const corners = new Map(h.flatMap(t => t.corners).map(c => [c.uv, c]))
		if (corners.size !== 4 || new Set(h.flatMap(t => t.corners.map(c => c.key))).size !== 4) bad('overlapping card halves')
		const p = h[0].corners[0].p
		if ([...corners.values()].some(c => Math.abs(dot(sub(c.p, p), h[0].normal)) > EPS)) bad('nonplanar card')
		const pairKey = key.split('/').slice(0, 2).join('/') + '/' + [...corners.values()].map(c => c.key).sort().join('|')
		const group = cards.get(pairKey) ?? []; group.push(h[0]); cards.set(pairKey, group)
	}
	for (const pair of cards.values()) if (pair.length !== 2 || pair[0].sign === pair[1].sign || dot(pair[0].normal, pair[1].normal) > -.9999) bad('missing/opposed card backface')
	if (!cards.size) bad('missing leaf cards')
	return owners
}

/** Shared with the CPU gate. No GPU allocation, source fetch, motion fetch or fallback. */
export async function verifyTreeAssets(manifest: TreeAssetsManifest, url: string, expectedFoliageSourceSha256: string, options: TreeAssetVerificationOptions = {}): Promise<TreeAssets> {
	validateTreeAssetsManifest(manifest, expectedFoliageSourceSha256, options)
	const local = new URL(url, location.href)
	if (local.origin !== location.origin || !['http:', 'https:'].includes(local.protocol) || local.username || local.password) bad('pack must be same-origin')
	const bytes = await fetchAssetPack(url, manifest)
	for (const asset of Object.values(manifest.assets)) for (const l of asset.levels) {
		const slice = bytes.subarray(l.offset, l.offset + l.bytes)
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', slice as Uint8Array<ArrayBuffer>))
		if (Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') !== l.sha256) bad('LOD slice SHA-256 mismatch')
		const h = new DataView(slice.buffer, slice.byteOffset, 32)
		if (h.getUint32(0, true) !== 0x464d5353 || h.getUint16(4, true) !== 1 || h.getUint16(6, true) !== 1 || h.getUint32(8, true) !== l.vertices ||
			h.getUint32(12, true) !== l.triangles || h.getUint32(16, true) !== l.bytes - 32 || h.getUint32(28, true) !== 32) bad('LOD binary header mismatch')
	}
	const assets: Record<string, TreeAssets['assets'][string]> = Object.create(null)
	for (const [id, entry] of Object.entries(manifest.assets)) {
		let baseOwners: Set<number> | undefined
		const levels = entry.levels.map(l => {
			const decoded = decodeBlenderAsset(bytes, l), mesh = decoded.mesh
			if (!decoded.rig) bad('missing decoded tree rig')
			const problem = mesh.validate(); if (problem) bad(problem)
			for (let v = 0; v < mesh.vertexCount; v++) {
				const n = Array.from(mesh.normals.subarray(v * 3, v * 3 + 3)), t = Array.from(mesh.tangents.subarray(v * 4, v * 4 + 3))
				if (Math.abs(Math.hypot(...n) - 1) > 1e-4 || Math.abs(Math.hypot(...t) - 1) > 1e-4 || Math.abs(dot(n, t)) > 1e-4) bad('non-unit/nonorthogonal tangent frame')
			}
			mesh.invalidateBounds(); mesh.updateBounds()
			for (let a = 0; a < 3; a++) if (Math.abs(mesh.aabbMin[a] - l.bounds[0][a]) > EPS || Math.abs(mesh.aabbMax[a] - l.bounds[1][a]) > EPS) bad('decoded bounds differ from manifest')
			const owners = (l.foliage === 'cluster' ? validateClusterFoliage(mesh) : validateCards(mesh)), winds = new Set(l.rig.winds!.map(w => w.bone))
			if (owners.size !== winds.size || [...owners].some(o => !winds.has(o)) || [...winds].some(o => !owners.has(o))) bad('leaf owners must cover every wind bone')
			if (baseOwners && (owners.size !== baseOwners.size || [...baseOwners].some(o => !owners.has(o)))) bad('LOD lost or changed leaf owners')
			baseOwners ??= owners
			return decoded
		})
		assets[id] = { manifest: entry, levels }
	}
	return { manifest, assets }
}

/** Call only during boot. Both absent is optional; any declared incomplete chain throws. */
export async function loadTreeAssets(expectedFoliageSourceSha256: string): Promise<TreeAssets | null> {
	const ms = Object.values(manifests), ps = Object.values(packs)
	if (!ms.length && !ps.length) return null
	if (ms.length !== 1 || ps.length !== 1) bad('incomplete optional tree pack')
	return verifyTreeAssets(ms[0], ps[0], expectedFoliageSourceSha256)
}
