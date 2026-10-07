// STEELSEED — tools/png
// Minimal PNG decode/encode on node:zlib alone. No image library.
//
// The harness could pull in pngjs or sharp as a devDependency, but a per-pixel gate
// that silently changes behaviour on a dependency bump is worthless as a gate. This is
// ~200 lines, it is exact, and it will behave identically in five years.
//
// Supports what Playwright actually emits: 8-bit RGB/RGBA, non-interlaced.

import { deflateSync, inflateSync } from 'node:zlib'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** @returns {{width:number,height:number,channels:number,data:Buffer}} RGBA8 */
export function decodePng(buf) {
	if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG')

	let pos = 8
	let width = 0
	let height = 0
	let bitDepth = 0
	let colorType = 0
	let interlace = 0
	const idat = []
	let palette = null
	let trns = null

	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos)
		const type = buf.toString('ascii', pos + 4, pos + 8)
		const body = buf.subarray(pos + 8, pos + 8 + len)
		pos += 12 + len // length + type + data + crc

		if (type === 'IHDR') {
			width = body.readUInt32BE(0)
			height = body.readUInt32BE(4)
			bitDepth = body[8]
			colorType = body[9]
			interlace = body[12]
		} else if (type === 'PLTE') palette = body
		else if (type === 'tRNS') trns = body
		else if (type === 'IDAT') idat.push(body)
		else if (type === 'IEND') break
	}

	if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}; expected 8`)
	if (interlace !== 0) throw new Error('interlaced PNG unsupported')

	const srcChannels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
	if (!srcChannels) throw new Error(`unsupported colour type ${colorType}`)

	const raw = inflateSync(Buffer.concat(idat))
	const bpp = srcChannels
	const stride = width * bpp
	const out = Buffer.alloc(height * stride)

	// Undo the per-scanline filters. Each row is prefixed with a filter byte.
	let rp = 0
	for (let y = 0; y < height; y++) {
		const filter = raw[rp++]
		const row = raw.subarray(rp, rp + stride)
		rp += stride
		const o = y * stride
		const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null

		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? out[o + x - bpp] : 0
			const b = prev ? prev[x] : 0
			const c = prev && x >= bpp ? prev[x - bpp] : 0
			let v = row[x]
			switch (filter) {
				case 0: break
				case 1: v = (v + a) & 0xff; break
				case 2: v = (v + b) & 0xff; break
				case 3: v = (v + ((a + b) >> 1)) & 0xff; break
				case 4: {
					// Paeth
					const p = a + b - c
					const pa = Math.abs(p - a)
					const pb = Math.abs(p - b)
					const pc = Math.abs(p - c)
					const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
					v = (v + pred) & 0xff
					break
				}
				default: throw new Error(`unknown PNG filter ${filter} on row ${y}`)
			}
			out[o + x] = v
		}
	}

	// Normalise everything to RGBA8 so callers never branch on colour type.
	const rgba = Buffer.alloc(width * height * 4)
	for (let i = 0, n = width * height; i < n; i++) {
		const s = i * bpp
		const d = i * 4
		if (colorType === 6) {
			rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = out[s + 3]
		} else if (colorType === 2) {
			rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = 255
		} else if (colorType === 0) {
			rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = 255
		} else if (colorType === 4) {
			rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = out[s + 1]
		} else if (colorType === 3) {
			const pi = out[s] * 3
			rgba[d] = palette[pi]; rgba[d + 1] = palette[pi + 1]; rgba[d + 2] = palette[pi + 2]
			rgba[d + 3] = trns && out[s] < trns.length ? trns[out[s]] : 255
		}
	}

	return { width, height, channels: 4, data: rgba }
}

/** Encode RGBA8 to a PNG buffer. Used for diff images. */
export function encodePng(width, height, rgba) {
	const stride = width * 4
	const raw = Buffer.alloc(height * (stride + 1))
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0 // filter: none — these are diagnostic images, not shipped
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
	}

	const chunks = [SIG]
	const chunk = (type, body) => {
		const len = Buffer.alloc(4)
		len.writeUInt32BE(body.length)
		const t = Buffer.from(type, 'ascii')
		const crc = Buffer.alloc(4)
		crc.writeUInt32BE(crc32(Buffer.concat([t, body])) >>> 0)
		return Buffer.concat([len, t, body, crc])
	}

	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(width, 0)
	ihdr.writeUInt32BE(height, 4)
	ihdr[8] = 8
	ihdr[9] = 6 // RGBA
	chunks.push(chunk('IHDR', ihdr))
	chunks.push(chunk('IDAT', deflateSync(raw, { level: 6 })))
	chunks.push(chunk('IEND', Buffer.alloc(0)))
	return Buffer.concat(chunks)
}

let CRC_TABLE = null
function crc32(buf) {
	if (!CRC_TABLE) {
		CRC_TABLE = new Int32Array(256)
		for (let n = 0; n < 256; n++) {
			let c = n
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
			CRC_TABLE[n] = c
		}
	}
	let c = -1
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
	return c ^ -1
}
