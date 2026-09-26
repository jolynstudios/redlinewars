#!/usr/bin/env node
// Redline Wars — public stand-in art.
//
// The official builds carry art that is licensed separately from this source: the Blender-built
// model, texture and landmark packs, the music, voices and sound effects (web/.forge/), the brand
// icons and the desktop landing backgrounds. They are not in this repository. This tool writes
// plain stand-ins so a fresh checkout builds and runs:
//
//   - web/.forge/landmarks/: the hero bridge's three states (intact, partial, dead) as simple
//     procedural decks, built and encoded by the client's own Mesh and encodeMeshBake, with the
//     manifest the client verifies (sizes and SHA-256). The bridge is the only pack the client
//     imports unconditionally; every other pack is optional and falls back to the client's
//     procedural geometry and materials.
//   - web/.forge/music/ and one sound bank in web/.forge/sfx/: short silence under the names the
//     client loads, in both formats the desktop packager checks for (AAC .m4a and .mp3). Voices
//     and the other effects are optional and stay silent.
//   - desktop/build/icon.png, icon.icns, icon.ico: a neutral mark for the desktop package.
//   - desktop/shell/*.webp: neutral backgrounds for the desktop landing page.
//
// Usage, from the repository root, after `cd web && npm ci`:   node tools/fallback-art.mjs
// Existing files are never overwritten, so official art placed there first wins.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, deflateSync, gzipSync } from 'node:zlib'

const ROOT = resolve(import.meta.dirname, '..')
const WEB = join(ROOT, 'web')
const written = []
function write(path, bytes) {
	const file = join(ROOT, path)
	if (existsSync(file)) { written.push(`kept   ${path}`); return false }
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, bytes)
	written.push(`wrote  ${path} (${bytes.length} bytes)`)
	return true
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// ---------------------------------------------------------------------------------------------
// The bridge: the client's own mesh code, bundled from web/src.
// ---------------------------------------------------------------------------------------------

const { build } = await import(pathToFileURL(join(WEB, 'node_modules/esbuild/lib/main.js')).href)
const temp = mkdtempSync(join(tmpdir(), 'redline-fallback-'))
const bundle = join(temp, 'mesh.mjs')
await build({
	stdin: { contents: "export { Mesh } from './src/geo/mesh.ts'; export { encodeMeshBake, decodeMeshBake } from './src/geo/mesh-bake.ts'", resolveDir: WEB, loader: 'ts' },
	bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent',
})
const { Mesh, encodeMeshBake, decodeMeshBake } = await import(pathToFileURL(bundle).href)
rmSync(temp, { recursive: true, force: true })

/** An axis-aligned box from (x0, y0, z0) to (x1, y1, z1): six quads with outward normals. */
function box(mesh, x0, y0, z0, x1, y1, z1) {
	const quad = (n, corners) => {
		const [a, b, c, d] = corners.map(([x, y, z], i) => mesh.addVertex(x, y, z, n[0], n[1], n[2], i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0))
		mesh.addQuad(a, b, c, d)
	}
	quad([0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]])
	quad([0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]])
	quad([1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]])
	quad([-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]])
	quad([0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]])
	quad([0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]])
}

// The official bridge spans x ±4.48, z ±2.24 and stands 1.58 m high; the stand-ins keep that
// footprint so they sit where the bridge's gameplay cells are.
const BRIDGE = {
	intact: mesh => {
		box(mesh, -4.48, 1.2, -1.8, 4.48, 1.45, 1.8)
		for (const z of [-1.8, 1.7]) box(mesh, -4.48, 1.45, z, 4.48, 1.58, z + 0.1)
		for (const x of [-3, 0, 3]) box(mesh, x - 0.3, 0, -1.2, x + 0.3, 1.2, 1.2)
	},
	partial: mesh => {
		box(mesh, -4.48, 1.2, -1.8, -1.2, 1.45, 1.8)
		box(mesh, 1.4, 1.2, -1.8, 4.48, 1.45, 1.8)
		for (const x of [-3, 3]) box(mesh, x - 0.3, 0, -1.2, x + 0.3, 1.2, 1.2)
		box(mesh, -0.9, 0, -1.2, 0.9, 0.35, 1.0)
	},
	dead: mesh => {
		box(mesh, -4.2, 0, -1.6, -1.8, 0.4, 1.4)
		box(mesh, -1.4, 0, -1.8, 1.2, 0.3, 1.6)
		box(mesh, 1.6, 0, -1.5, 4.2, 0.45, 1.7)
	},
}

const assets = {}
for (const [state, shape] of Object.entries(BRIDGE)) {
	const id = `planx.bridge.${state}`
	const mesh = new Mesh()
	shape(mesh)
	mesh.computeTangents()
	const problem = mesh.validate()
	if (problem) throw new Error(`fallback ${id}: ${problem}`)
	const raw = encodeMeshBake(mesh)
	const { info } = decodeMeshBake(raw)
	const packed = gzipSync(raw, { level: 9 })
	const maskRaw = new Uint8Array(4 * 4 * 4).fill(128), maskPacked = gzipSync(maskRaw, { level: 9 })
	write(`web/.forge/landmarks/${id}.ssmesh.gz`, packed)
	write(`web/.forge/landmarks/masks/${id}.mask.rgba.gz`, maskPacked)
	const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
	for (let v = 0; v < info.vertices; v++) for (let k = 0; k < 3; k++) {
		const value = mesh.positions[v * 3 + k]
		if (value < min[k]) min[k] = value
		if (value > max[k]) max[k] = value
	}
	// The same fields as the official manifest, so the client's types and checks read it unchanged.
	assets[id] = {
		vertices: info.vertices, triangles: info.triangles, skinned: false, bounds: [min, max],
		uvMapping: { authoredObjects: 0, projectedObjects: 0, origin: 'bottom-left' },
		materialSet: 'industrial-v1',
		materialTable: [{ zone: 0, name: 'stand-in', set: 'industrial-v1', layer: 0 }],
		detailMask: {
			file: `masks/${id}.mask.rgba.gz`, compression: 'gzip', bytes: maskRaw.length, storedBytes: maskPacked.length,
			sha256: sha256(maskRaw), size: 4, channels: 'ao,cavity,dirt,wear', uv: 1, origin: 'bottom-left',
		},
		description: 'Public stand-in (tools/fallback-art.mjs); the official bridge is separately licensed art',
		sourcePath: 'tools/fallback-art.mjs', sourceSha256: sha256(raw),
		file: `${id}.ssmesh.gz`, compression: 'gzip', bytes: raw.length, storedBytes: packed.length, sha256: sha256(raw),
	}
}
write('web/.forge/landmarks/manifest.json', Buffer.from(JSON.stringify({ schema: 1, assets }, null, 2) + '\n'))

// ---------------------------------------------------------------------------------------------
// Audio stand-ins: silence under the names the client loads.
// ---------------------------------------------------------------------------------------------

// 0.2 s of silence as AAC in MP4 and as MPEG-1 Layer III, made once with ffmpeg's anullsrc.
const SILENT_M4A = Buffer.from('AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAtZtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAyAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACJXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAyAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAMgAAAQAAAEAAAAAAZ1tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAFYiAAAVOlXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAFIbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEMc3RibAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAAFYiAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAD6AAAADCwWAgIAFE4hW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAAAABQAABAAAAAABAAABOgAAABxzdHNjAAAAAAAAAAEAAAABAAAABgAAAAEAAAAUc3RzegAAAAAAAAAEAAAABgAAABRzdGNvAAAAAAAAAAEAAAMCAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAAByb2xsAAAAAQAAAAYAAAABAAAAPXVkdGEAAAA1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAIaWxzdAAAAAhmcmVlAAAAIG1kYXQBGCAHARggBwEYIAcBGCAHARggBwEYIAc=', 'base64')
const SILENT_MP3 = Buffer.from('//MgxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVf/zIsQnAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVV//MgxE8AAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVf/zIMR2AAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yDEnQAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MixMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yDE2AAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MgxNgAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zIMTYAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yLE1wAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==', 'base64')
for (const track of ['theme', 'mechanical-groove', 'still-standing', 'reverse-order', 'cold-start'])
	write(`web/.forge/music/${track}.m4a`, SILENT_M4A)
write('web/.forge/sfx/england/build_placed.m4a', SILENT_M4A)
write('web/.forge/sfx/england/death_heavy_b.mp3', SILENT_MP3)
write('web/.forge/sfx/england/manifest.json', Buffer.from(`${JSON.stringify({ schema: 1, faction: 'england',
	effects: { build_placed: 'build_placed.m4a', death_heavy_b: 'death_heavy_b.mp3' } }, null, 2)}\n`))

// ---------------------------------------------------------------------------------------------
// Desktop stand-ins.
// ---------------------------------------------------------------------------------------------

/** A PNG of `size`² pixels from an rgba(x, y) function. */
function png(size, rgba) {
	const rows = Buffer.alloc(size * (size * 4 + 1))
	for (let y = 0; y < size; y++) {
		rows[y * (size * 4 + 1)] = 0
		for (let x = 0; x < size; x++) rows.set(rgba(x, y), y * (size * 4 + 1) + 1 + x * 4)
	}
	const chunk = (type, data) => {
		const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii')
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
		return Buffer.concat([head, data, crc])
	}
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
/** A neutral mark: a dark rounded square with a light ring. No brand shape. */
const mark = size => png(size, (x, y) => {
	const c = (size - 1) / 2, dx = (x - c) / size, dy = (y - c) / size, r = Math.hypot(dx, dy)
	const inside = Math.max(Math.abs(dx), Math.abs(dy)) < 0.46
	if (!inside) return [0, 0, 0, 0]
	return r > 0.26 && r < 0.33 ? [214, 220, 226, 255] : [38, 42, 48, 255]
})
write('desktop/build/icon.png', mark(512))
{
	// icns: one 512 px PNG entry ('ic09'); macOS reads PNG entries directly.
	const image = mark(512), entry = Buffer.alloc(8)
	entry.write('ic09', 0, 'ascii'); entry.writeUInt32BE(8 + image.length, 4)
	const head = Buffer.alloc(8); head.write('icns', 0, 'ascii'); head.writeUInt32BE(8 + entry.length + image.length, 4)
	write('desktop/build/icon.icns', Buffer.concat([head, entry, image]))
}
{
	// ico: one 256 px PNG entry (the largest size a PNG-in-ICO entry may declare).
	const image = mark(256), head = Buffer.alloc(6 + 16)
	head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4)
	head[6] = 0; head[7] = 0; head[8] = 0; head[9] = 0
	head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(image.length, 14); head.writeUInt32LE(22, 18)
	write('desktop/build/icon.ico', Buffer.concat([head, image]))
}
// A 1×1 lossless WebP; the landing page stretches it into a flat backdrop.
const WEBP_1X1 = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64')
for (const name of ['bg-day-grass', 'bg-night-1', 'bg-night-2', 'hero-night']) write(`desktop/shell/${name}.webp`, WEBP_1X1)

for (const line of written) console.log(`fallback-art: ${line}`)
