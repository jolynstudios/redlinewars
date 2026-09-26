// Offline unique-UV human atlas. Four ordinary PBR channels, one array layer only.
import { fetchAssetPack } from '../core/asset-pack'
import { uploadSourceSurfaces, type SourceSurfaces, type SurfaceManifest } from './source-surfaces'

export type HumanSurfaceManifest = SurfaceManifest & {
	readonly sourcePath: string
	readonly sourceSha256: string
}
export const HUMAN_SURFACE_ID = 'infantry-v1'
export const HUMAN_SURFACE_SIZE = 1024
const BPP = [4, 2, 4, 1] as const
const SHA256 = /^[a-f0-9]{64}$/
const manifests = import.meta.glob<HumanSurfaceManifest>('../../.forge/human-surfaces/manifest.json', { eager: true, import: 'default' })
const packs = import.meta.glob<string>('../../.forge/human-surfaces/surfaces.sspbr.gz', { eager: true, query: '?url', import: 'default' })

/** Exact full-mip texture payload; texture bytes only — the uploader's info uniform is a
 * buffer, which vramgate's census cannot enumerate, so it is not claimed (actor-masks.ts). */
export function planHumanSurfaces(low: boolean) {
	const size = low ? 512 : HUMAN_SURFACE_SIZE
	const mipCount = Math.log2(size) + 1
	const textureBytes = 11 * (4 * size * size - 1) / 3
	return { size, mipCount, layerCount: 1, textureBytes, vramBytes: textureBytes } as const
}

const MAX_PACK_BYTES = planHumanSurfaces(false).textureBytes
// Accommodate an incompressible gzip stream without allowing a 29-layer allocation.
const MAX_STORED_BYTES = MAX_PACK_BYTES + Math.ceil(MAX_PACK_BYTES / 16384) * 5 + 64

/** Validate shape/ranges BEFORE downloading, decompressing, hashing or GPU allocation. */
function validateManifest(manifest: HumanSurfaceManifest): void {
	if (!manifest || manifest.schema !== 1 || manifest.id !== HUMAN_SURFACE_ID ||
		manifest.size !== HUMAN_SURFACE_SIZE || manifest.mipCount !== 11 || manifest.origin !== 'bottom-left' ||
		manifest.compression !== 'gzip' || !Array.isArray(manifest.layers) || manifest.layers.length !== 1 ||
		!Number.isFinite(manifest.tileMeters) || !Number.isFinite(Math.fround(manifest.tileMeters)) || Math.fround(manifest.tileMeters) <= 0 ||
		!Number.isFinite(manifest.heightRange) || !Number.isFinite(Math.fround(manifest.heightRange)) || manifest.heightRange < 0)
		throw new Error('Unsupported human surface manifest')
	if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_PACK_BYTES ||
		!Number.isSafeInteger(manifest.storedBytes) || manifest.storedBytes < 1 || manifest.storedBytes > MAX_STORED_BYTES ||
		typeof manifest.sha256 !== 'string' || !SHA256.test(manifest.sha256))
		throw new Error('Invalid human surface byte budget or checksum')
	// Provenance is metadata only: the loader never fetches sourcePath. The offline gate
	// additionally hashes that saved .blend file when checking actual artifacts.
	if (typeof manifest.sourcePath !== 'string' || !manifest.sourcePath.startsWith('art/blender/') ||
		!manifest.sourcePath.endsWith('.blend') || /[\\\u0000-\u001f]/.test(manifest.sourcePath) ||
		manifest.sourcePath.split('/').some(part => part === '..' || part === '.' || part === '') ||
		typeof manifest.sourceSha256 !== 'string' || !SHA256.test(manifest.sourceSha256))
		throw new Error('Invalid human surface source provenance')
	const layer = manifest.layers[0]
	if (!layer || layer.zone !== 0 || typeof layer.name !== 'string' || !layer.name.trim() ||
		!Array.isArray(layer.mips) || layer.mips.length !== 11)
		throw new Error('Invalid human surface layer or mip chain')
	const intervals: { offset: number; bytes: number; sha256: string }[] = []
	for (let mip = 0; mip < 11; mip++) {
		const ranges = layer.mips[mip], side = HUMAN_SURFACE_SIZE >> mip
		if (!Array.isArray(ranges) || ranges.length !== 4) throw new Error('Invalid human surface channels')
		for (let channel = 0; channel < 4; channel++) {
			const r = ranges[channel]
			if (!r || !Number.isSafeInteger(r.offset) || r.offset < 0 || r.bytes !== side * side * BPP[channel] ||
				!Number.isSafeInteger(r.offset + r.bytes) || r.offset + r.bytes > manifest.bytes ||
				typeof r.sha256 !== 'string' || !SHA256.test(r.sha256))
				throw new Error('Invalid human surface channel range')
			intervals.push(r)
		}
	}
	// Exact deduplicated ranges remain legal in the existing SurfaceManifest schema.
	// Partial overlaps or aliases with conflicting hashes indicate a broken exporter.
	intervals.sort((a, b) => a.offset - b.offset || a.bytes - b.bytes)
	for (let i = 1; i < intervals.length; i++) {
		const a = intervals[i - 1], b = intervals[i]
		if (b.offset < a.offset + a.bytes &&
			!(a.offset === b.offset && a.bytes === b.bytes && a.sha256 === b.sha256))
			throw new Error('Overlapping human surface channel ranges')
	}
}

/** Same SourceSurfaces consumer schema; intentionally does not use the 29-layer validator. */
export async function verifyHumanSurfacePack(manifest: HumanSurfaceManifest, url: string): Promise<SourceSurfaces> {
	validateManifest(manifest)
	const bytes = await fetchAssetPack(url, manifest)
	const checked = new Set<string>()
	for (const mip of manifest.layers[0].mips) for (const range of mip) {
		const key = `${range.offset}:${range.bytes}:${range.sha256}`
		if (checked.has(key)) continue
		const data = bytes.subarray(range.offset, range.offset + range.bytes)
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))
		const hash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
		if (hash !== range.sha256) throw new Error('Human surface channel checksum mismatch')
		checked.add(key)
	}
	return { manifest, bytes }
}

/** Boot-only allocation: low=512, all other tiers=1024, layer zero only, full mip chain. */
export async function loadHumanSurfaces(device: GPUDevice, low: boolean) {
	const manifest = Object.values(manifests)[0], url = Object.values(packs)[0]
	if (!manifest && !url) return null
	if (!manifest || !url) throw new Error('Incomplete human surface pack')
	const plan = planHumanSurfaces(low)
	if (device.limits.maxTextureDimension2D < plan.size || device.limits.maxTextureArrayLayers < 1)
		throw new Error('Human surface plan exceeds device limits')
	const pack = await verifyHumanSurfacePack(manifest, url)
	const set = uploadSourceSurfaces(device, pack, plan.size, HUMAN_SURFACE_ID, [0])
	if (set.size !== plan.size || set.mipCount !== plan.mipCount || set.layerCount !== 1 || set.vramBytes !== plan.vramBytes) {
		set.dispose()
		throw new Error('Human surface upload exceeded deterministic plan')
	}
	return Object.assign(set, { sourceSha256: manifest.sourceSha256 })
}
