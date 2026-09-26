// Cycles-baked, original terrain PBR. Uploads happen once, before atlas assembly.
import { fetchAssetPack } from '../core/asset-pack'
import { Surface } from '../core'
import { ForgedSurfaceSet } from './forge'
interface Range { readonly offset: number; readonly bytes: number }
interface BakedSurface { readonly id: string; readonly tileMeters: number; readonly heightRange: number; readonly mips: readonly (readonly Range[])[] }
interface Manifest { readonly schema: number; readonly size: number; readonly bytes: number; readonly storedBytes: number; readonly sha256: string; readonly surfaces: readonly BakedSurface[] }
const manifests = import.meta.glob<Manifest>('../../.forge/environment/materials.json', { eager: true, import: 'default' })
const packs = import.meta.glob<string>('../../.forge/environment/terrain.sspbr.gz', { eager: true, query: '?url', import: 'default' })
export interface BakedEnvironment { readonly manifest: Manifest; readonly bytes: Uint8Array }

export async function loadEnvironmentMaterials(): Promise<BakedEnvironment | null> {
	if (new URLSearchParams(location.search).get('noenvironment') === '1') return null
	const manifest = Object.values(manifests)[0], url = Object.values(packs)[0]
	if (!manifest && !url) return null
	if (!manifest || !url || manifest.schema !== 1 || manifest.size !== 256) throw new Error('Unsupported Blender terrain pack')
	const ids = new Set(manifest.surfaces.map(s => s.id))
	if (ids.size !== Object.keys(Surface).length || Object.keys(Surface).some(s => !ids.has(s))) throw new Error('Incomplete Blender terrain library')
	const bytes = await fetchAssetPack(url, manifest)
	for (const surface of manifest.surfaces) {
		if (!(surface.tileMeters > 0 && surface.heightRange > 0) || surface.mips.length !== 6) throw new Error('Invalid terrain dimensions')
		for (let mip = 0; mip < surface.mips.length; mip++) {
			const side = manifest.size >> mip, ranges = surface.mips[mip]
			if (ranges.length !== 4) throw new Error('Invalid terrain channels')
			for (let c = 0; c < 4; c++) {
				const r = ranges[c]
				if (!Number.isSafeInteger(r.offset) || r.offset < 0 || r.bytes !== side * side * [4, 2, 4, 1][c] || r.offset + r.bytes > bytes.length)
					throw new Error('Invalid terrain pack range')
			}
		}
	}
	return { manifest, bytes }
}

export function uploadEnvironmentMaterials(device: GPUDevice, pack: BakedEnvironment, size: number, layers: number, mips: number): ForgedSurfaceSet[] {
	const firstMip = Math.log2(pack.manifest.size / size)
	if (!Number.isInteger(firstMip) || firstMip < 0) throw new Error('Terrain bake resolution incompatible with GPU plan')
	return pack.manifest.surfaces.map(surface => {
		// Texture bytes only — the info uniform is a buffer, not a claimable texture
		// (vramgate censuses textures; see actor-masks.ts).
		let vram = 0
		const textures = (['rgba8unorm', 'rg8unorm', 'rgba8unorm', 'r8unorm'] as const).map((format, c) => {
			const bpp = [4, 2, 4, 1][c]
			const texture = device.createTexture({ label: `steelseed/materials/blender-terrain/${surface.id}/${c}`, size: [size, size, layers], format, mipLevelCount: mips,
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC, viewFormats: c === 0 ? ['rgba8unorm-srgb'] : [] })
			for (let mip = 0; mip < mips; mip++) {
				const side = size >> mip, range = surface.mips[firstMip + mip][c]
				const data = pack.bytes.subarray(range.offset, range.offset + range.bytes)
				for (let layer = 0; layer < layers; layer++) device.queue.writeTexture({ texture, mipLevel: mip, origin: [0, 0, layer] },
					data as Uint8Array<ArrayBuffer>, { bytesPerRow: side * bpp, rowsPerImage: side }, [side, side, 1])
				vram += side * side * layers * bpp
			}
			return texture
		})
		const info = device.createBuffer({ label: `blender.terrain.${surface.id}.info`, size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
		const buffer = new ArrayBuffer(32), u = new Uint32Array(buffer), f = new Float32Array(buffer)
		u[0] = layers; u[1] = mips; f[4] = surface.tileMeters; f[5] = surface.heightRange; f[6] = surface.tileMeters / size
		device.queue.writeBuffer(info, 0, buffer)
		return new ForgedSurfaceSet({ id: surface.id, albedo: textures[0], normal: textures[1], orm: textures[2], mask: textures[3], info,
			layerCount: layers, vramBytes: vram, size, mipCount: mips, tileMeters: surface.tileMeters, heightRange: surface.heightRange })
	})
}
