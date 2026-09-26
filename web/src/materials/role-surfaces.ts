// Role-pack unique-UV atlases. Four ordinary PBR channels, one array layer each, one set per
// pack. Discovered at build time from web/.forge/*-surfaces/ by schema; the rifle's is one of them.
import { fetchAssetPack } from '../core/asset-pack'
import { RIFLE_PACK, ROLE_PACK_DIR, ROLE_PACK_ID, ROLE_SURFACE_SIZE, roleHashValid, roleStudyFamily, validateRoleInput, type RolePackInput } from '../core/role-pack'
import type { ForgedSurfaceSet } from './forge'
import { uploadSourceSurfaces, type SourceSurfaces, type SurfaceManifest } from './source-surfaces'

export type RoleSurfaceManifest = SurfaceManifest & {
	readonly suppliedInput: RolePackInput
	readonly sourcePath: string
	readonly sourceSha256: string
	readonly slots?: readonly string[]
}
export interface RoleSurfaceCandidate {
	/** The mesh pack's directory; the atlas itself lives in `<dir>-surfaces/`. */
	readonly dir: string
	/** The slots the mesh pack claims, from its portrait sidecar; the experiment flags govern packs through these. */
	readonly slots: readonly string[]
	readonly manifest: RoleSurfaceManifest | undefined
	readonly url: string | undefined
}
const BPP = [4, 2, 4, 1] as const
// Surfaces only. The mesh packs are units' data; globbing them here too would put the same
// modules in two subsystem chunks. An atlas whose mesh never shipped is the gate's to report.
const manifests = import.meta.glob<RoleSurfaceManifest>('../../.forge/*-surfaces/manifest.json', { eager: true, import: 'default' })
const packs = import.meta.glob<string>('../../.forge/*-surfaces/surfaces.sspbr.gz', { eager: true, query: '?url', import: 'default' })
// Portrait sidecars are shipped for every admitted pack (roleportraits runs every build) and
// name its slots — the same claim metadata the ui portrait table reads.
const portraitSlots = import.meta.glob<{ readonly schema: number; readonly slots: readonly string[] }>(
	'../../.forge/*/portrait.json', { eager: true, import: 'default' })
const SURFACE_DIR = /\/\.forge\/([^/]+)-surfaces\/(?:manifest\.json|surfaces\.sspbr\.gz)$/
const PORTRAIT_DIR = /\/\.forge\/([^/]+)\/portrait\.json$/

/** Exact full-mip texture payload; texture bytes only — the uploader's info uniform is a
 * buffer, which vramgate's census cannot enumerate, so it is not claimed (actor-masks.ts). */
export function planRoleSurfaces(low: boolean) {
	const size = low ? ROLE_SURFACE_SIZE / 2 : ROLE_SURFACE_SIZE
	const mipCount = Math.log2(size) + 1
	const textureBytes = 11 * (4 * size * size - 1) / 3
	return { size, mipCount, layerCount: 1, textureBytes, vramBytes: textureBytes } as const
}

const MAX_PACK_BYTES = planRoleSurfaces(false).textureBytes
// Accommodate an incompressible gzip stream without allowing a 29-layer allocation.
const MAX_STORED_BYTES = MAX_PACK_BYTES + Math.ceil(MAX_PACK_BYTES / 16384) * 5 + 64

/** Every bundled role atlas, the rifle's first. `infantry-v1` has its own loader and no supplied input. */
export function roleSurfaceCandidates(manifestRecord: Record<string, unknown> = manifests, packRecord: Record<string, string> = packs,
	portraits: Record<string, { readonly schema: number; readonly slots: readonly string[] }> = portraitSlots): RoleSurfaceCandidate[] {
	const slotsByDir = new Map<string, readonly string[]>()
	for (const [key, sidecar] of Object.entries(portraits)) {
		const dir = PORTRAIT_DIR.exec(key)?.[1]
		if (dir && sidecar !== null && typeof sidecar === 'object' && sidecar.schema === 1 && Array.isArray(sidecar.slots)) slotsByDir.set(dir, sidecar.slots)
	}
	const byDir = new Map<string, { slots?: readonly string[]; manifest?: RoleSurfaceManifest; url?: string }>()
	for (const [key, manifest] of Object.entries(manifestRecord)) {
		const dir = SURFACE_DIR.exec(key)?.[1]
		if (dir && manifest !== null && typeof manifest === 'object' && 'suppliedInput' in manifest)
			byDir.set(dir, { slots: slotsByDir.get(dir), manifest: manifest as RoleSurfaceManifest })
	}
	for (const [key, url] of Object.entries(packRecord)) {
		const entry = byDir.get(SURFACE_DIR.exec(key)?.[1] ?? '')
		if (entry) entry.url = url
	}
	return [...byDir].sort(([a], [b]) => a === RIFLE_PACK.dir ? -1 : b === RIFLE_PACK.dir ? 1 : a < b ? -1 : a > b ? 1 : 0)
		.map(([dir, entry]) => ({
			dir,
			slots: entry.slots ?? (Array.isArray(entry.manifest?.slots) ? entry.manifest.slots as readonly string[] : []),
			manifest: entry.manifest,
			url: entry.url,
		}))
}

/** Validate shape/ranges BEFORE downloading, decompressing, hashing or GPU allocation. */
export function validateRoleSurfaceManifest(manifest: RoleSurfaceManifest, dir: string): void {
	const fail = (message: string): never => { throw new Error(`Role atlas ${dir}: ${message}`) }
	const rifle = dir === RIFLE_PACK.dir
	validateRoleInput(manifest?.suppliedInput, rifle ? RIFLE_PACK.input : undefined)
	if (!ROLE_PACK_DIR.test(dir) || !manifest || manifest.schema !== 1 || typeof manifest.id !== 'string' || !ROLE_PACK_ID.test(manifest.id) ||
		manifest.id === 'infantry-v1' || (rifle ? manifest.id !== RIFLE_PACK.id : manifest.id === RIFLE_PACK.id) ||
		manifest.size !== ROLE_SURFACE_SIZE || manifest.mipCount !== 11 || manifest.origin !== 'bottom-left' ||
		manifest.compression !== 'gzip' || !Array.isArray(manifest.layers) || manifest.layers.length !== 1 ||
		!Number.isFinite(manifest.tileMeters) || !Number.isFinite(Math.fround(manifest.tileMeters)) || Math.fround(manifest.tileMeters) <= 0 ||
		!Number.isFinite(manifest.heightRange) || !Number.isFinite(Math.fround(manifest.heightRange)) || manifest.heightRange < 0)
		fail('unsupported surface manifest')
	if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_PACK_BYTES ||
		!Number.isSafeInteger(manifest.storedBytes) || manifest.storedBytes < 1 || manifest.storedBytes > MAX_STORED_BYTES ||
		!roleHashValid(manifest.sha256)) fail('invalid byte budget or checksum')
	// Provenance is metadata only: the loader never fetches sourcePath. The offline gate
	// additionally hashes that saved .blend file when checking actual artifacts.
	const study = roleStudyFamily(manifest.sourcePath, 0)
	if (!study || (rifle && study !== RIFLE_PACK.study) || !roleHashValid(manifest.sourceSha256)) fail('invalid source provenance')
	const layer = manifest.layers[0]
	if (!layer || layer.zone !== 0 || typeof layer.name !== 'string' || !layer.name.trim() ||
		!Array.isArray(layer.mips) || layer.mips.length !== 11) fail('invalid layer or mip chain')
	const intervals: { offset: number; bytes: number; sha256: string }[] = []
	for (let mip = 0; mip < 11; mip++) {
		const ranges = layer.mips[mip], side = ROLE_SURFACE_SIZE >> mip
		if (!Array.isArray(ranges) || ranges.length !== 4) fail('invalid channels')
		for (let channel = 0; channel < 4; channel++) {
			const r = ranges[channel]
			if (!r || !Number.isSafeInteger(r.offset) || r.offset < 0 || r.bytes !== side * side * BPP[channel] ||
				!Number.isSafeInteger(r.offset + r.bytes) || r.offset + r.bytes > manifest.bytes || !roleHashValid(r.sha256))
				fail('invalid channel range')
			intervals.push(r)
		}
	}
	// Exact deduplicated ranges remain legal in the existing SurfaceManifest schema.
	// Partial overlaps or aliases with conflicting hashes indicate a broken exporter.
	intervals.sort((a, b) => a.offset - b.offset || a.bytes - b.bytes)
	for (let i = 1; i < intervals.length; i++) {
		const a = intervals[i - 1], b = intervals[i]
		if (b.offset < a.offset + a.bytes && !(a.offset === b.offset && a.bytes === b.bytes && a.sha256 === b.sha256))
			fail('overlapping channel ranges')
	}
}

/** Same SourceSurfaces consumer schema; intentionally does not use the 29-layer validator. */
export async function verifyRoleSurfacePack(manifest: RoleSurfaceManifest, dir: string, url: string): Promise<SourceSurfaces> {
	validateRoleSurfaceManifest(manifest, dir)
	const local = new URL(url, location.href)
	if (local.origin !== location.origin || !['http:', 'https:'].includes(local.protocol)) throw new Error(`Role atlas ${dir}: pack must be same-origin`)
	const bytes = await fetchAssetPack(url, manifest)
	const checked = new Set<string>()
	for (const mip of manifest.layers[0].mips) for (const range of mip) {
		const key = `${range.offset}:${range.bytes}:${range.sha256}`
		if (checked.has(key)) continue
		const data = bytes.subarray(range.offset, range.offset + range.bytes)
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))
		if (Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') !== range.sha256) throw new Error(`Role atlas ${dir}: channel checksum mismatch`)
		checked.add(key)
	}
	return { manifest, bytes }
}

export type RoleSurfaceSet = ForgedSurfaceSet & { readonly sourceSha256: string; readonly roleDir: string }
export interface RoleSurfaceLoad {
	readonly sets: RoleSurfaceSet[]
	/** One entry per refused atlas, with the slots it claimed so flag callers can judge demand. Never thrown here: whether a refusal is fatal is the caller's flag. */
	readonly failures: { readonly dir: string; readonly slots: readonly string[]; readonly reason: string }[]
}

/**
 * Boot-only allocation: low=512, all other tiers=1024, layer zero only, full mip chain. Each
 * atlas is independent; `taken` answers ids already owned by another set, which a role atlas
 * must never replace. Measured budget: the rifle plus eleven roles is 44 MiB at low and 176 MiB
 * elsewhere, against 256 MiB and 640+ MiB §7 ceilings that the Sep-6 census left 80% free.
 */
export async function loadRoleSurfaces(device: GPUDevice, low: boolean, include: (dir: string, slots: readonly string[]) => boolean,
	taken: (id: string) => boolean, candidates: readonly RoleSurfaceCandidate[] = roleSurfaceCandidates()): Promise<RoleSurfaceLoad> {
	const sets: RoleSurfaceSet[] = [], failures: RoleSurfaceLoad['failures'] = []
	const plan = planRoleSurfaces(low)
	for (const { dir, slots, manifest, url } of candidates) {
		if (!include(dir, slots)) continue
		try {
			if (!manifest || !url) throw new Error(`Role atlas ${dir}: incomplete optional pack`)
			if (taken(manifest.id) || sets.some(set => set.id === manifest.id)) throw new Error(`Role atlas ${dir}: set id ${manifest.id} is already taken`)
			if (device.limits.maxTextureDimension2D < plan.size || device.limits.maxTextureArrayLayers < 1)
				throw new Error(`Role atlas ${dir}: plan exceeds device limits`)
			const pack = await verifyRoleSurfacePack(manifest, dir, url)
			const set = uploadSourceSurfaces(device, pack, plan.size, manifest.id, [0])
			if (set.size !== plan.size || set.mipCount !== plan.mipCount || set.layerCount !== 1 || set.vramBytes !== plan.vramBytes) {
				set.dispose()
				throw new Error(`Role atlas ${dir}: upload exceeded deterministic plan`)
			}
			sets.push(Object.assign(set, { sourceSha256: manifest.sourceSha256, roleDir: dir }))
		} catch (error) {
			failures.push({ dir, slots, reason: error instanceof Error ? error.message : String(error) })
		}
	}
	return { sets, failures }
}
