// A compact PBR palette shared with the Blender authoring scenes. The mesh's
// material zone selects a real material; team paint occupies its own layer.
import PALETTE from '../core/blender-palette.json'
import { ForgedSurfaceSet } from './forge'

export function buildBlenderPalette(device: GPUDevice): ForgedSurfaceSet {
	const size = 64, layers = PALETTE.length, mips = 7
	// Texture bytes only — the info uniform is a buffer, not a claimable texture
	// (vramgate censuses textures; see actor-masks.ts).
	let bytes = 0
	const textures = (['rgba8unorm', 'rg8unorm', 'rgba8unorm', 'r8unorm'] as GPUTextureFormat[]).map((format, channel) => {
		const bpp = [4, 2, 4, 1][channel]
		const texture = device.createTexture({
			label: `steelseed/materials/blender-palette/${channel}`, size: [size, size, layers], format, mipLevelCount: mips,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
			viewFormats: channel === 0 ? ['rgba8unorm-srgb'] : [],
		})
		for (let mip = 0; mip < mips; mip++) {
			const side = size >> mip
			bytes += side * side * layers * bpp
			for (let layer = 0; layer < layers; layer++) {
				const material = PALETTE[layer]
				const data = new Uint8Array(side * side * bpp)
				for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
					const o = (y * side + x) * bpp
					// Small fixed machining/grain variation. Coarse mips converge to the mean.
					const grain = ((Math.imul(x + 17, 73856093) ^ Math.imul(y + layer * 11, 19349663)) >>> 0) % 23 / 22 - .5
					const noise = mip < 4 ? grain * (layer === 3 || layer === 5 ? .085 : .035) : 0
					if (channel === 0) {
						for (let c = 0; c < 3; c++) data[o + c] = Math.round(Math.max(0, Math.min(1, material.color[c] + noise)) * 255)
						data[o + 3] = 255
					} else if (channel === 1) {
						const bump = mip < 3 && material.roughness > .5 ? grain * 3 : 0
						data[o] = 128 + bump; data[o + 1] = 128 - bump
					}
					else if (channel === 2) {
						data[o] = Math.round(Math.max(.05, Math.min(1, material.roughness + noise * 2)) * 255); data[o + 1] = material.metalness * 255
						data[o + 2] = 255; data[o + 3] = 128
					} else data[o] = material.team * 255
				}
				device.queue.writeTexture({ texture, mipLevel: mip, origin: [0, 0, layer] }, data,
					{ bytesPerRow: side * bpp, rowsPerImage: side }, [side, side, 1])
			}
		}
		return texture
	})
	const info = device.createBuffer({ label: 'blender.palette.info', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
	const buffer = new ArrayBuffer(32), u = new Uint32Array(buffer), f = new Float32Array(buffer)
	u[0] = layers; u[1] = mips; f[4] = 2; f[5] = 0.01; f[6] = 2 / size
	device.queue.writeBuffer(info, 0, buffer)
	return new ForgedSurfaceSet({ id: 'blender', albedo: textures[0], normal: textures[1], orm: textures[2], mask: textures[3],
		layerCount: layers, vramBytes: bytes, info, size, mipCount: mips, tileMeters: 2, heightRange: 0.01 })
}
