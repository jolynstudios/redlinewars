#!/usr/bin/env node
// STEELSEED — tools/gpu-footprint
// Offline GPU memory audit. Reads the forge pack manifests (never the GPUs:
// the numbers below model exactly what MeshStore + the surface atlases upload)
// and prints per-asset GPU bytes sorted descending, plus totals, so a change
// in vertex layout, LOD policy or texture format has a before/after number.
//
// Model (matches geo/mesh.toGPUBuffers + render/gpumesh):
//   vertex stride: read from geo/mesh.ts (currently 28 B static, 36 B skinned;
//                  f16 positions + packed normal/tangent/UV/zone/skin channels)
//   indices: 2 B when vertices <= 65536, else 4 B
//   LOD chain: 3 levels, each simplified from the original with falloff 0.5
//              (level 0 = full, level 1 = 50%, level 2 = 25%)
//   textures: decoded surface pack bytes (size^2 * 4 B * mip sum 1.333)
//
// Usage: node tools/gpu-footprint.mjs [--top N] [--json]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FORGE = join(WEB, '.forge')
const args = process.argv.slice(2)
const topN = args.includes('--top') ? Number(args[args.indexOf('--top') + 1] ?? 20) : 20
const asJson = args.includes('--json')

const meshSource = readFileSync(join(WEB, 'src/geo/mesh.ts'), 'utf8')
const sourceStride = name => {
	const value = meshSource.match(new RegExp(`export const ${name} = (\\d+)`))?.[1]
	if (!value) throw new Error(`gpu-footprint: could not read ${name} from src/geo/mesh.ts`)
	return Number(value)
}
// Read the canonical upload layout instead of copying constants that silently drifted
// twice while this report continued to print obsolete pre-quantization byte counts.
const STRIDE_STATIC = sourceStride('VERTEX_STRIDE')
const STRIDE_SKINNED = sourceStride('VERTEX_STRIDE_SKINNED')

function lodBytes(vertices, triangles, skinned) {
	const stride = skinned ? STRIDE_SKINNED : STRIDE_STATIC
	const indexBytes = v => (v <= 0x10000 ? 2 : 4)
	let total = 0
	for (const ratio of [1, 0.5, 0.25]) {
		const v = Math.max(3, Math.round(vertices * ratio))
		const t = Math.max(1, Math.round(triangles * ratio))
		total += v * stride + t * 3 * indexBytes(v)
	}
	return total
}

const rows = []
let packBytesTotal = 0
const manifestDirs = []
for (const dir of readdirSync(FORGE, { withFileTypes: true })) {
	if (!dir.isDirectory()) continue
	if (existsSync(join(FORGE, dir.name, 'manifest.json'))) manifestDirs.push(dir.name)
	// Nested per-actor manifests (damage-states/<actor>/manifest.json).
	for (const sub of readdirSync(join(FORGE, dir.name), { withFileTypes: true })) {
		if (sub.isDirectory() && existsSync(join(FORGE, dir.name, sub.name, 'manifest.json')))
			manifestDirs.push(`${dir.name}/${sub.name}`)
	}
}
for (const dir of manifestDirs) {
	const manifestPath = join(FORGE, dir, 'manifest.json')
	if (!existsSync(manifestPath)) continue
	let manifest
	try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }

	// Mesh packs: per-asset entries with vertices/triangles.
	if (manifest.assets) {
		const packRaw = manifest.bytes ?? 0
		packBytesTotal += manifest.storedBytes ?? packRaw
		for (const [id, entry] of Object.entries(manifest.assets)) {
			const v = Number(entry.vertices ?? 0), t = Number(entry.triangles ?? 0)
			rows.push({
				family: dir, id, kind: entry.skinned ? 'mesh-skinned' : 'mesh-static',
				vertices: v, triangles: t,
				gpuBytes: lodBytes(v, t, entry.skinned === true),
				sourceBytes: Number(entry.bytes ?? 0),
			})
		}
	}

	// Damage-state packs: one manifest per actor with a list of damage stages.
	if (manifest.states && !manifest.assets) {
		packBytesTotal += manifest.storedBytes ?? Number(manifest.bytes ?? 0)
		let stage = 0
		for (const s of manifest.states) {
			const v = Number(s.vertices ?? 0), t = Number(s.triangles ?? 0)
			if (!v || !t) continue
			rows.push({
				family: 'damage-states', id: `${manifest.actor ?? dir}-s${stage}`, kind: s.skinned ? 'mesh-skinned' : 'mesh-static',
				vertices: v, triangles: t,
				gpuBytes: lodBytes(v, t, s.skinned === true),
				sourceBytes: manifest.bytes ?? 0,
			})
			stage++
		}
	}

	// Surface packs: size^2 RGBA mips.
	const size = Number(manifest.size ?? 0)
	if (size) {
		const mips = Number(manifest.mipCount ?? Math.log2(size) + 1)
		const bytes = Math.round(size * size * 4 * (4 / 3) * (mips > 1 ? 1 : 0.75))
		packBytesTotal += manifest.storedBytes ?? 0
		rows.push({ family: dir, id: manifest.id ?? dir, kind: 'surface', vertices: 0, triangles: 0, gpuBytes: bytes, sourceBytes: manifest.storedBytes ?? 0 })
	}
}

rows.sort((a, b) => b.gpuBytes - a.gpuBytes)
const geo = rows.filter(r => r.kind !== 'surface')
const tex = rows.filter(r => r.kind === 'surface')
const sum = list => list.reduce((a, r) => a + r.gpuBytes, 0)
const geoBytes = sum(geo)
const texBytes = sum(tex)
const fmt = b => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GiB' : b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + ' MiB' : (b / 1024).toFixed(0) + ' KiB')

if (asJson) {
	console.log(JSON.stringify({ assets: rows, totals: { geometryBytes: geoBytes, textureBytes: texBytes, gpuBytes: geoBytes + texBytes, packStoredBytes: packBytesTotal } }, null, '\t'))
	process.exit(0)
}

console.log('STEELSEED GPU footprint audit (offline model of MeshStore uploads)')
console.log('='.repeat(78))
console.log(`assets: ${rows.length} (${geo.length} mesh, ${tex.length} surface)`)
console.log(`geometry GPU : ${fmt(geoBytes)}  (stride ${STRIDE_STATIC}/${STRIDE_SKINNED} B, 3 LOD levels, u16 indices where they fit)`)
console.log(`textures GPU : ${fmt(texBytes)}  (RGBA + full mip chain)`)
console.log(`total GPU    : ${fmt(geoBytes + texBytes)}`)
console.log(`pack on disk : ${fmt(packBytesTotal)} stored (compressed)`)
console.log('-'.repeat(78))
console.log(`top ${Math.min(topN, rows.length)} by GPU bytes`)
for (const r of rows.slice(0, topN))
	console.log(`${fmt(r.gpuBytes).padStart(10)}  ${r.kind.padEnd(13)} ${r.family.padEnd(14)} ${r.id}  (${r.vertices.toLocaleString()} verts, ${r.triangles.toLocaleString()} tris)`)
console.log('-'.repeat(78))
console.log('by family')
const families = new Map()
for (const r of rows) families.set(r.family, (families.get(r.family) ?? 0) + r.gpuBytes)
for (const [f, b] of [...families.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15))
	console.log(`${fmt(b).padStart(10)}  ${f}`)
