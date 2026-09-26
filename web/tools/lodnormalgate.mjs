#!/usr/bin/env node
// STEELSEED — LOD shading-normal gate.
//
// The Construction Yard's side panels went "round/oval" one zoom step out, and the silhouette
// never changed. MeshStore.upload builds every forge mesh's LOD1/LOD2 with the in-house QEM
// simplifier, and the yard's 32 side panels are 0.6 x 0.5 m plates only 3-4 mm thick. Their
// rim collapses are nearly free, and afterwards the front face has nothing but back-face and
// rim wedges left to fold into: positions stay square, the SHADING normals point backwards,
// two corners of every plate render black and what is left lit is a lozenge. Measured on the
// shipped pack before the fix: 78% (LOD1) / 93% (LOD2) of the yard's side-panel area shaded
// from behind — and the same fault roster-wide (tank traps 100% at LOD2, the mcv 61%).
//
// Mesh.generateLodChain now runs repairShadingNormals() on every decimated level. This gate
// runs the production path in memory: the shipped roster pack through loadBlenderAssets and
// decodeBlenderAsset, every mesh through MeshStore.upload (which builds the chain with the
// renderer's own LOD_LEVELS/LOD_FALLOFF) against a recording GPU, every damage ladder through
// loadDamageStates and the rung table buildDamageLadders uses, plus the living and environment
// packs that take the same chain. Per asset and level it asserts:
//   a. LOD1/LOD2 area with any corner shaded from behind (dot(normal, face) < 0) is exactly 0,
//      on the CPU channels AND on the octahedral normals actually written to the GPU buffer;
//   b. LOD1/LOD2 area with any corner below the repair threshold (dot < 0.3) is exactly 0;
//   c. the repair changed nothing but normals and tangents — same triangles, every original
//      vertex byte-identical, every re-pointed corner was a failing one and now uses a new
//      vertex copying its old one's position, UVs, zone and skin — so silhouettes are exactly
//      the decimator's, and the yard's and mcv's side/gable panels keep a mean projected
//      overlap with LOD0 of >= 0.99 at LOD1 and >= 0.95 at LOD2 (per bone, on the plate plane);
//   d. determinism: simplify() + repairShadingNormals() reproduces the chain byte for byte;
// and it reports triangle/vertex counts and simplify time before and after. "Before" is the
// unrepaired decimator — Mesh.simplify, which the fix leaves untouched — i.e. exactly what
// generateLodChain returned before. LOD0 is authored and never altered: a few assets carry
// back-facing corners in the source itself; those are reported, not asserted.
//
// Usage: node tools/lodnormalgate.mjs [--forge=<dir>] [--only=fact,mcv]
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const TOOL = 'lodnormalgate'
const web = resolve(import.meta.dirname, '..')
const arg = (name, fallback) => {
	const found = process.argv.find(a => a.startsWith(`--${name}=`))
	return found ? found.slice(name.length + 3) : fallback
}
const FORGE = resolve(web, arg('forge', '.forge'))
const ONLY = arg('only', '') ? new Set(arg('only', '').split(',')) : null
const wanted = (...names) => ONLY === null || names.some(name => ONLY.has(name))
/** Assets whose panel silhouettes are asserted; their damage rungs are reported beside them. */
const PANEL_ASSETS = ['fact', 'mcv']
const PANEL_FLOOR = [0.99, 0.95]

// The renderer's chain constants and buildDamageLadders' rung table, read rather than restated.
const gpumesh = readFileSync(resolve(web, 'src/render/gpumesh.ts'), 'utf8')
const LOD_LEVELS = Number(/^const LOD_LEVELS = (\d+)$/m.exec(gpumesh)?.[1])
const LOD_FALLOFF = Number(/^const LOD_FALLOFF = ([\d.]+)$/m.exec(gpumesh)?.[1])
assert.ok(LOD_LEVELS === 3 && LOD_FALLOFF > 0 && LOD_FALLOFF < 1, `${TOOL}: could not read LOD_LEVELS/LOD_FALLOFF from gpumesh.ts`)
assert.match(gpumesh, /generateLodChain\(LOD_LEVELS, LOD_FALLOFF\)/, `${TOOL}: MeshStore.upload no longer builds the QEM chain`)
const rungTable = /const DAMAGE_RUNG_OF_STATE[^=]*=\s*\{([^}]*)\}/.exec(readFileSync(resolve(web, 'src/units/index.ts'), 'utf8'))
assert.ok(rungTable, `${TOOL}: DAMAGE_RUNG_OF_STATE not found in src/units/index.ts`)
const DAMAGE_RUNG_OF_STATE = Object.fromEntries([...rungTable[1].matchAll(/(\w+):\s*(\d+)/g)].map(m => [m[1], Number(m[2])]))

// The production loaders find their packs through import.meta.glob and fetch them; serve both
// from FORGE. Globs expand one `*` directory level, exactly the patterns the loaders declare.
function expand(pattern) {
	const rel = pattern.replace(/^\.\.\/\.\.\/\.forge\//, '')
	if (rel === pattern) return []
	const star = rel.indexOf('*')
	if (star < 0) return existsSync(resolve(FORGE, rel)) ? [rel] : []
	const dir = rel.slice(0, star), rest = rel.slice(star + 1)
	if (!existsSync(resolve(FORGE, dir))) return []
	return readdirSync(resolve(FORGE, dir)).sort().map(name => dir + name + rest).filter(path => existsSync(resolve(FORGE, path)))
}
globalThis.__lodNormalGateGlob = (pattern, options) => Object.fromEntries(expand(pattern).map(rel => [`../../.forge/${rel}`,
	options?.query === '?url' ? `/lodnormalgate/${rel}` : JSON.parse(readFileSync(resolve(FORGE, rel), 'utf8'))]))
const fetched = []
globalThis.fetch = async url => {
	assert.ok(typeof url === 'string' && url.startsWith('/lodnormalgate/'), `${TOOL}: unexpected fetch ${url}`)
	fetched.push(url)
	return new Response(readFileSync(resolve(FORGE, url.slice('/lodnormalgate/'.length))))
}
globalThis.location = { href: 'http://localhost/steelseed/index.html', origin: 'http://localhost', search: '' }
globalThis.GPUBufferUsage = { COPY_DST: 8, INDEX: 16, VERTEX: 32 }

const bundle = await build({ stdin: { contents: `
	export { Mesh, SHADING_REPAIR_COS, NORMAL_OFFSET } from './src/geo/mesh.ts'
	export { MeshStore } from './src/render/gpumesh.ts'
	export { decodeBlenderAsset } from './src/units/blender-mesh.ts'
	export { loadBlenderAssets, BLENDER_HIDDEN_ACTORS } from './src/units/blender-assets.ts'
	export { loadDamageStates, RUNG_COUNT } from './src/units/damage-states.ts'
	export { fetchAssetPack } from './src/core/asset-pack.ts'
`, resolveDir: web }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
	define: { 'import.meta.glob': '__gateGlob' },
	banner: { js: 'const __gateGlob = (pattern, options) => globalThis.__lodNormalGateGlob(pattern, options);' } })
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const { Mesh, MeshStore, SHADING_REPAIR_COS: REPAIR_COS, NORMAL_OFFSET } = api

/** Recording GPU: keeps the bytes MeshStore writes so the uploaded normals can be read back. */
function device() {
	return {
		limits: { maxBufferSize: 256 * 1024 * 1024 },
		createBuffer: desc => ({ ...desc, data: new Uint8Array(desc.size), destroy() {} }),
		queue: { writeBuffer(buffer, offset, input, from = 0, size = input.byteLength - from) {
			const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input)
			buffer.data.set(bytes.subarray(from, from + size), offset)
		} },
	}
}

// Wall time of the production call, measured inside MeshStore.upload.
const productionChain = Mesh.prototype.generateLodChain
let chainMs = 0
Mesh.prototype.generateLodChain = function (...args) {
	const start = performance.now()
	try { return productionChain.apply(this, args) } finally { chainMs += performance.now() - start }
}

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

/**
 * Area-weighted agreement between shading and face normals. A triangle counts once, by area,
 * when ANY corner fails. Zero-area triangles are skipped — the same rule the repair applies:
 * they have no face to agree with and cover no pixels.
 */
function shading(mesh, normalOf) {
	const pos = mesh.positions, idx = mesh.indices, n = [0, 0, 0]
	let total = 0, away = 0, low = 0, awayCorners = 0, lowCorners = 0, worstCos = 1
	for (let t = 0; t < mesh.triangleCount; t++) {
		const o = t * 3, a = idx[o] * 3, b = idx[o + 1] * 3, c = idx[o + 2] * 3
		const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2]
		const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2]
		const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x
		const l = Math.sqrt(fx * fx + fy * fy + fz * fz)
		if (!(l > 1e-20)) continue
		total += l / 2
		let worst = Infinity
		for (let k = 0; k < 3; k++) {
			normalOf(idx[o + k], n)
			const nl = Math.hypot(n[0], n[1], n[2])
			const d = nl > 1e-20 ? (n[0] * fx + n[1] * fy + n[2] * fz) / (nl * l) : -1
			if (d < 0) awayCorners++
			if (d < REPAIR_COS) lowCorners++
			worst = Math.min(worst, d)
		}
		if (worst < 0) away += l / 2
		if (worst < REPAIR_COS) low += l / 2
		worstCos = Math.min(worstCos, worst)
	}
	return { away: total > 0 ? away / total : 0, low: total > 0 ? low / total : 0, awayCorners, lowCorners, worstCos }
}
const cpuNormal = mesh => (v, out) => { out[0] = mesh.normals[v * 3]; out[1] = mesh.normals[v * 3 + 1]; out[2] = mesh.normals[v * 3 + 2] }
/** The normal the vertex stage decodes: snorm8x2 octahedral at NORMAL_OFFSET (core/oct-decode). */
function gpuNormal(level) {
	const bytes = level.vertexBuffer.data, q = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	return (v, out) => {
		const o = v * level.stride + NORMAL_OFFSET
		let x = Math.max(q[o] / 127, -1), y = Math.max(q[o + 1] / 127, -1)
		const z = 1 - Math.abs(x) - Math.abs(y)
		if (z < 0) { x += x >= 0 ? z : -z; y += y >= 0 ? z : -z }
		out[0] = x; out[1] = y; out[2] = z
	}
}

const CHANNELS = [['positions', 3], ['normals', 3], ['tangents', 4], ['uv0', 2], ['uv1', 2], ['materialZone', 1], ['skinIndices', 4], ['skinWeights', 4]]
function digest(mesh) {
	const hash = createHash('sha256').update(`${mesh.vertexCount}:${mesh.triangleCount}`)
	for (const [key, width] of CHANNELS) {
		const array = mesh[key]
		hash.update(array ? new Uint8Array(array.buffer, array.byteOffset, mesh.vertexCount * width * array.BYTES_PER_ELEMENT) : 'null')
	}
	return hash.update(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.triangleCount * 12)).digest('hex')
}

/** Assertion c: the repaired level differs from the unrepaired one in normals/tangents only. */
function assertOnlyShadingChanged(before, after, label) {
	assert.equal(after.triangleCount, before.triangleCount, `${label}: triangle count changed`)
	const n = before.vertexCount
	assert.ok(after.vertexCount >= n, `${label}: vertices were removed`)
	for (const [key, width] of CHANNELS) {
		assert.equal(before[key] === null, after[key] === null, `${label}: ${key} presence changed`)
		if (before[key] === null) continue
		for (let i = 0; i < n * width; i++)
			if (before[key][i] !== after[key][i]) assert.fail(`${label}: original vertex ${Math.floor(i / width)} ${key} changed`)
	}
	const referenced = new Uint8Array(after.vertexCount - n), pos = before.positions, nrm = before.normals
	for (let c = 0; c < before.triangleCount * 3; c++) {
		const was = before.indices[c], now = after.indices[c]
		if (now === was) continue
		assert.ok(now >= n, `${label}: corner ${c} moved to a different original vertex`)
		referenced[now - n] = 1
		for (const [key, width] of CHANNELS) {
			if (key === 'normals' || key === 'tangents' || before[key] === null) continue
			for (let k = 0; k < width; k++)
				assert.equal(after[key][now * width + k], before[key][was * width + k], `${label}: split vertex ${now} ${key} differs from its source`)
		}
		// Only a failing corner may be touched: this is what keeps smooth shading intact.
		const o = c - c % 3, a = before.indices[o] * 3, b = before.indices[o + 1] * 3, d = before.indices[o + 2] * 3
		const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], e2 = [pos[d] - pos[a], pos[d + 1] - pos[a + 1], pos[d + 2] - pos[a + 2]]
		const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
		const nl = Math.hypot(nrm[was * 3], nrm[was * 3 + 1], nrm[was * 3 + 2])
		const cos = nl > 1e-20 ? (nrm[was * 3] * f[0] + nrm[was * 3 + 1] * f[1] + nrm[was * 3 + 2] * f[2]) / (nl * Math.hypot(...f)) : -1
		assert.ok(cos < REPAIR_COS, `${label}: corner ${c} was re-pointed although its normal agreed with its face (cos ${cos})`)
	}
	assert.ok(referenced.every(Boolean), `${label}: an added vertex is used by no corner`)
	return after.vertexCount - n
}

// Panel silhouettes: per bone, LOD0 vs LODn coverage projected on the plate's own plane.
function trianglesByBone(mesh) {
	const bones = new Map()
	if (!mesh.skinIndices) return bones
	const dominant = v => {
		let best = -1, weight = -1
		for (let j = 0; j < 4; j++) if (mesh.skinWeights[v * 4 + j] > weight) { weight = mesh.skinWeights[v * 4 + j]; best = mesh.skinIndices[v * 4 + j] }
		return best
	}
	for (let t = 0; t < mesh.triangleCount; t++) {
		const b = dominant(mesh.indices[t * 3])
		if (b !== dominant(mesh.indices[t * 3 + 1]) || b !== dominant(mesh.indices[t * 3 + 2])) continue
		if (!bones.has(b)) bones.set(b, [])
		bones.get(b).push(t)
	}
	return bones
}
function corners(mesh, t) {
	return [0, 1, 2].map(k => { const o = mesh.indices[t * 3 + k] * 3; return [mesh.positions[o], mesh.positions[o + 1], mesh.positions[o + 2]] })
}
/** The plate normal is the principal axis of sum(area n n^T); front and back agree on it. */
function plateAxes(mesh, tris) {
	const m = new Float64Array(9)
	for (const t of tris) {
		const [a, b, c] = corners(mesh, t)
		const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
		const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
		const l = Math.hypot(...f)
		if (!(l > 1e-20)) continue
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += f[i] * f[j] / (2 * l)
	}
	let n = [0.577, 0.577, 0.577]
	for (let i = 0; i < 64; i++) {
		const w = [0, 1, 2].map(r => m[r * 3] * n[0] + m[r * 3 + 1] * n[1] + m[r * 3 + 2] * n[2])
		const l = Math.hypot(...w) || 1
		n = w.map(x => x / l)
	}
	const h = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
	let u = [n[1] * h[2] - n[2] * h[1], n[2] * h[0] - n[0] * h[2], n[0] * h[1] - n[1] * h[0]]
	const ul = Math.hypot(...u)
	u = u.map(x => x / ul)
	return [u, [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]]
}
const GRID = 256
function coverage(mesh, tris, [u, w], box) {
	const mask = new Uint8Array(GRID * GRID), [u0, w0, u1, w1] = box, su = GRID / (u1 - u0), sw = GRID / (w1 - w0)
	const project = p => [(p[0] * u[0] + p[1] * u[1] + p[2] * u[2] - u0) * su, (p[0] * w[0] + p[1] * w[1] + p[2] * w[2] - w0) * sw]
	for (const t of tris) {
		const [A, B, C] = corners(mesh, t).map(project)
		const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])
		if (Math.abs(area) < 1e-12) continue
		const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(GRID - 1, Math.ceil(Math.max(A[0], B[0], C[0])))
		const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(GRID - 1, Math.ceil(Math.max(A[1], B[1], C[1])))
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			const px = x + 0.5, py = y + 0.5
			const e0 = (B[0] - A[0]) * (py - A[1]) - (B[1] - A[1]) * (px - A[0])
			const e1 = (C[0] - B[0]) * (py - B[1]) - (C[1] - B[1]) * (px - B[0])
			const e2 = (A[0] - C[0]) * (py - C[1]) - (A[1] - C[1]) * (px - C[0])
			if (area > 0 ? e0 >= 0 && e1 >= 0 && e2 >= 0 : e0 <= 0 && e1 <= 0 && e2 <= 0) mask[y * GRID + x] = 1
		}
	}
	return mask
}
function panelOverlap(entry, chain) {
	const kinds = { side: /^complete\.side\./, gable: /^complete\.gable\./ }, out = { side: [[], []], gable: [[], []] }
	const bones = entry.rig?.bones ?? []
	if (!bones.some(bone => kinds.side.test(bone.name) || kinds.gable.test(bone.name))) return null
	const byBone = chain.map(trianglesByBone)
	bones.forEach((bone, b) => {
		const kind = Object.keys(kinds).find(k => kinds[k].test(bone.name))
		const base = byBone[0].get(b)
		if (!kind || !base?.length) return
		const axes = plateAxes(chain[0], base)
		let u0 = Infinity, w0 = Infinity, u1 = -Infinity, w1 = -Infinity
		for (const t of base) for (const p of corners(chain[0], t)) {
			const pu = p[0] * axes[0][0] + p[1] * axes[0][1] + p[2] * axes[0][2], pw = p[0] * axes[1][0] + p[1] * axes[1][1] + p[2] * axes[1][2]
			u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); w0 = Math.min(w0, pw); w1 = Math.max(w1, pw)
		}
		const box = [u0 - (u1 - u0) * 0.05, w0 - (w1 - w0) * 0.05, u1 + (u1 - u0) * 0.05, w1 + (w1 - w0) * 0.05]
		const reference = coverage(chain[0], base, axes, box)
		for (let level = 1; level < chain.length; level++) {
			const mask = coverage(chain[level], byBone[level].get(b) ?? [], axes, box)
			let both = 0, either = 0
			for (let i = 0; i < mask.length; i++) { both += reference[i] & mask[i]; either += reference[i] | mask[i] }
			out[kind][level - 1].push(either ? both / either : 1)
		}
	})
	const mean = values => values.reduce((sum, v) => sum + v, 0) / values.length
	return { side: out.side.map(mean), gable: out.gable.map(mean), bones: out.side[0].length + out.gable[0].length }
}

// ---------------------------------------------------------------------------------------------
// Fixtures: the repair in isolation, decimator-independent
// ---------------------------------------------------------------------------------------------

const checks = []
const check = (name, run) => { run(); checks.push(name) }
let smoothControlWorstDeg = 0

check('thin-plate fixture: the flipped corner gets one shared vertex, everything else is kept', () => {
	// A plate corner after a rim collapse: two front triangles (+Z) reuse back-face vertex 0 (-Z).
	const mesh = new Mesh()
	const vertex = (x, y, nz, u, v) => {
		const i = mesh.addVertex(x, y, 0, 0, 0, nz, u, v, 2)
		mesh.setTangent(i, 1, 0, 0, 1)
		mesh.setUv1(i, u * 0.5, v * 0.5)
		mesh.setSkin(i, 7, 3, 0, 0, 0.75, 0.25, 0, 0)
		return i
	}
	vertex(0, 0, -1, 0.9, 0.1)
	const [f1, f2, f3] = [vertex(1, 0, 1, 0.5, 0), vertex(1, 1, 1, 0.5, 0.5), vertex(0, 1, 1, 0, 0.5)]
	const [b1, b2, b3] = [vertex(1, 0, -1, 1, 0), vertex(1, 1, -1, 1, 1), vertex(0, 1, -1, 0.8, 1)]
	mesh.addTriangle(0, f1, f2); mesh.addTriangle(0, f2, f3)
	mesh.addTriangle(0, b3, b2); mesh.addTriangle(0, b2, b1)
	// Collinear with f1-f2: zero area, so its back-facing corner is no one's business.
	const sliver = vertex(1, 0.5, -1, 0, 0)
	mesh.addTriangle(sliver, f1, f2)
	const before = shading(mesh, cpuNormal(mesh))
	assert.equal(before.away, 0.5, 'metric sees half the plate shaded from behind')
	assert.equal(mesh.repairShadingNormals(), 1, 'both front corners share one new vertex')
	assert.deepEqual([...mesh.indices.subarray(0, 15)], [8, f1, f2, 8, f2, f3, 0, b3, b2, 0, b2, b1, sliver, f1, f2])
	assert.deepEqual([...mesh.normals.subarray(24, 27)], [0, 0, 1])
	assert.deepEqual([...mesh.normals.subarray(0, 3)], [0, 0, -1], 'the back face keeps its vertex')
	for (const [key, width] of [['positions', 3], ['uv0', 2], ['uv1', 2], ['materialZone', 1], ['skinIndices', 4], ['skinWeights', 4]])
		assert.deepEqual([...mesh[key].subarray(8 * width, 9 * width)], [...mesh[key].subarray(0, width)], `${key} copied`)
	// Tangent stays in the plate; handedness flips with the normal so the bitangent keeps pointing -Y.
	assert.deepEqual([...mesh.tangents.subarray(32, 36)], [1, 0, 0, -1])
	const after = shading(mesh, cpuNormal(mesh))
	assert.equal(after.away + after.low + after.lowCorners, 0)
	assert.equal(mesh.validate(), null)
	assert.equal(mesh.repairShadingNormals(), 0, 'idempotent')
})

check('smooth-shading controls: legitimate smoothing is never re-split', () => {
	// A smooth triangular prism: every corner 60 degrees off its face (cos 0.5).
	const prism = new Mesh()
	for (let s = 0; s < 3; s++) for (const y of [0, 1]) {
		const a = 2 * Math.PI * s / 3
		prism.addVertex(Math.cos(a), y, Math.sin(a), Math.cos(a), 0, Math.sin(a), s / 3, y)
	}
	for (let s = 0; s < 3; s++) {
		const a = s * 2, b = ((s + 1) % 3) * 2
		prism.addTriangle(a, a + 1, b); prism.addTriangle(b, a + 1, b + 1)
	}
	assert.equal(shading(prism, cpuNormal(prism)).lowCorners, 0)
	assert.equal(prism.repairShadingNormals(), 0)
	// A torus decimated through the production chain keeps corners far off their faces at LOD2
	// (reported below) — coarse but legitimate smoothing — and must reach the renderer untouched.
	const torus = new Mesh()
	for (let i = 0; i <= 32; i++) for (let j = 0; j <= 12; j++) {
		const a = 2 * Math.PI * i / 32, b = 2 * Math.PI * j / 12, nx = Math.cos(b) * Math.cos(a), ny = Math.sin(b), nz = Math.cos(b) * Math.sin(a)
		torus.addVertex(Math.cos(a) + nx * 0.3, ny * 0.3, Math.sin(a) + nz * 0.3, nx, ny, nz, i / 32, j / 12)
	}
	for (let i = 0; i < 32; i++) for (let j = 0; j < 12; j++) {
		const a = i * 13 + j, b = a + 13
		torus.addTriangle(a, a + 1, b); torus.addTriangle(a + 1, b + 1, b)
	}
	torus.compact().computeTangents()
	const chain = torus.generateLodChain(LOD_LEVELS, LOD_FALLOFF)
	let ratio = 1
	for (let level = 1; level < LOD_LEVELS; level++) {
		const plain = torus.simplify(ratio *= LOD_FALLOFF)
		assert.equal(digest(chain[level]), digest(plain), `torus LOD${level} was changed by the repair`)
		smoothControlWorstDeg = Math.max(smoothControlWorstDeg, Math.acos(shading(plain, cpuNormal(plain)).worstCos) * 180 / Math.PI)
	}
})

// ---------------------------------------------------------------------------------------------
// The shipped packs through the production path
// ---------------------------------------------------------------------------------------------

let simplifyMs = 0, repairMs = 0
const rows = []
function measure(group, label, source, entry) {
	// Before: generateLodChain as it was — the decimator alone, which the fix does not touch.
	const unrepaired = () => {
		const start = performance.now(), levels = [source.clone()]
		for (let level = 1, ratio = 1; level < LOD_LEVELS; level++) levels.push(source.simplify(ratio *= LOD_FALLOFF))
		simplifyMs += performance.now() - start
		return levels
	}
	// After: MeshStore.upload exactly as units does it; the chain comes back through onFreshChain.
	// The two run in alternating order so JIT warm-up does not flatter either side of the timing.
	let chain = null, before = rows.length % 2 === 0 ? unrepaired() : null
	const handle = new MeshStore(device()).upload(source, `units:slot:${label}`, undefined, undefined, fresh => { chain = fresh })
	before ??= unrepaired()
	assert.ok(chain?.length === LOD_LEVELS && handle.lods.length === LOD_LEVELS, `${label}: upload did not build a ${LOD_LEVELS}-level chain`)
	assert.equal(digest(chain[0]), digest(before[0]), `${label}: LOD0 must stay a byte-identical copy of the source`)
	const row = { group, label, levels: [], panels: entry ? panelOverlap(entry, chain) : null }
	for (let level = 0; level < LOD_LEVELS; level++) {
		const b = before[level], a = chain[level]
		const split = level === 0 ? 0 : assertOnlyShadingChanged(b, a, `${label} LOD${level}`)
		const cpu = shading(a, cpuNormal(a)), gpu = shading(a, gpuNormal(handle.lods[level]))
		row.levels.push({ tris: a.triangleCount, vertsBefore: b.vertexCount, vertsAfter: a.vertexCount, split, before: shading(b, cpuNormal(b)), after: cpu })
		if (level === 0) continue
		// a + b, on the CPU channels and on the bytes the vertex stage will decode.
		assert.equal(cpu.awayCorners, 0, `${label} LOD${level}: ${cpu.awayCorners} corners shaded from behind (${(cpu.away * 100).toFixed(2)}% of area)`)
		assert.equal(gpu.awayCorners, 0, `${label} LOD${level}: ${gpu.awayCorners} uploaded normals face away`)
		assert.equal(cpu.lowCorners, 0, `${label} LOD${level}: ${cpu.lowCorners} corners below cos ${REPAIR_COS} (${(cpu.low * 100).toFixed(2)}% of area)`)
	}
	// d: the decimator plus the repair, run again, reproduces the shipped chain byte for byte.
	const start = performance.now()
	for (let level = 1; level < LOD_LEVELS; level++) if (before[level].triangleCount < source.triangleCount) before[level].repairShadingNormals()
	repairMs += performance.now() - start
	for (let level = 1; level < LOD_LEVELS; level++) assert.equal(digest(before[level]), digest(chain[level]), `${label} LOD${level}: repair is not deterministic`)
	rows.push(row)
}

const chainStart = chainMs
const rosterSources = new Map()
{
	// Block-scoped so the 250 MB roster is collectable before the ladders load.
	const blender = await api.loadBlenderAssets()
	assert.ok(blender, `${TOOL}: no roster pack under ${FORGE}/blender (pass --forge=<dir>)`)
	for (const [id, entry] of Object.entries(blender.manifest.assets).sort(([a], [b]) => a < b ? -1 : 1)) {
		rosterSources.set(id, entry.sourceSha256)
		if (entry.hidden || api.BLENDER_HIDDEN_ACTORS.has(id) || !wanted(id)) continue
		measure('roster', id, api.decodeBlenderAsset(blender.bytes, entry).mesh, entry)
	}
}
const rosterTime = { simplify: simplifyMs, chain: chainMs - chainStart, repair: repairMs }

// Damage rungs: loadDamageStates exactly as buildDamageLadders calls it; decoys share a pack.
const ladders = await api.loadDamageStates(actor => rosterSources.get(actor))
const ladderPacks = new Set(), decoys = []
for (const [actor, pack] of ladders) {
	if (ladderPacks.has(pack)) { decoys.push(actor); continue }
	ladderPacks.add(pack)
	if (!wanted(actor)) continue
	for (const entry of pack.manifest.states) {
		const rung = DAMAGE_RUNG_OF_STATE[entry.state] ?? -1
		if (rung < 1 || rung >= api.RUNG_COUNT) continue
		measure('damage', `${actor}.d${rung}`, api.decodeBlenderAsset(pack.bytes, entry).mesh, entry)
	}
}

// Living and environment props take the same MeshStore.upload chain (units/living, grass, environment).
const extraPacks = []
for (const [dir, manifestFile, packFile] of [['living', 'manifest.json', 'living.ssasset.gz'], ['environment', 'props.json', 'props.ssasset.gz']]) {
	if (!existsSync(resolve(FORGE, dir, manifestFile)) || !existsSync(resolve(FORGE, dir, packFile))) continue
	const manifest = JSON.parse(readFileSync(resolve(FORGE, dir, manifestFile), 'utf8'))
	const bytes = await api.fetchAssetPack(`/lodnormalgate/${dir}/${packFile}`, manifest)
	extraPacks.push(dir)
	for (const [id, entry] of Object.entries(manifest.assets).sort(([a], [b]) => a < b ? -1 : 1))
		if (!entry.hidden && wanted(dir, `${dir}:${id}`)) measure(dir, `${dir}:${id}`, api.decodeBlenderAsset(bytes, entry).mesh, null)
}

// c: the panels whose "oval" report started this. Geometry is the unrepaired decimator's (asserted above).
for (const row of rows) {
	if (!PANEL_ASSETS.includes(row.label) || !row.panels) continue
	for (const kind of ['side', 'gable']) for (let level = 0; level < 2; level++)
		assert.ok(row.panels[kind][level] >= PANEL_FLOOR[level], `${row.label} ${kind} panels LOD${level + 1}: mean overlap ${row.panels[kind][level].toFixed(4)} < ${PANEL_FLOOR[level]}`)
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const pct = x => `${(x * 100).toFixed(2)}%`
const grow = (b, a) => a === b ? String(a) : `${b}->${a} (+${((a / b - 1) * 100).toFixed(1)}%)`
const focus = rows.filter(row => PANEL_ASSETS.includes(row.label) || /^(fact|mcv)\.d\d$/.test(row.label))
if (focus.length) {
	console.log(`${TOOL}: area with a corner shaded from behind (dot<0) and below cos ${REPAIR_COS}, before -> after repair`)
	console.log(`${'asset'.padEnd(9)} LOD ${'tris'.padStart(6)}  ${'vertices'.padEnd(24)} ${'dot<0'.padEnd(17)} ${'dot<0.3'.padEnd(17)} panel overlap side/gable`)
	for (const row of focus) row.levels.forEach((l, level) => console.log(
		`${row.label.padEnd(9)} L${level}  ${String(l.tris).padStart(6)}  ${grow(l.vertsBefore, l.vertsAfter).padEnd(24)} ` +
		`${(level ? `${pct(l.before.away)} -> ${pct(l.after.away)}` : pct(l.after.away)).padEnd(17)} ` +
		`${(level ? `${pct(l.before.low)} -> ${pct(l.after.low)}` : pct(l.after.low)).padEnd(17)} ` +
		(level && row.panels ? `${row.panels.side[level - 1].toFixed(4)}/${row.panels.gable[level - 1].toFixed(4)}` : '')))
}
for (const group of ['roster', 'damage', ...extraPacks]) {
	const members = rows.filter(row => row.group === group)
	if (!members.length) continue
	for (let level = 0; level < LOD_LEVELS; level++) {
		const worst = pick => {
			const row = members.reduce((best, r) => pick(r.levels[level]) > pick(best.levels[level]) ? r : best, members[0])
			const value = pick(row.levels[level])
			return value > 0 ? `${pct(value)} (${row.label})` : pct(0)
		}
		const sum = key => members.reduce((total, row) => total + row.levels[level][key], 0)
		const affected = members.filter(row => row.levels[level].before.away > 0).length
		console.log(`${TOOL}: ${group.padEnd(11)} ${String(members.length).padStart(3)} assets L${level} max dot<0 ` +
			(level ? `${worst(l => l.before.away)} -> ${worst(l => l.after.away)}, ${affected} affected before` : `${worst(l => l.after.away)} authored`) +
			`; ${sum('tris')} tris; vertices ${grow(sum('vertsBefore'), sum('vertsAfter'))}`)
	}
}
const seconds = ms => `${(ms / 1000).toFixed(2)} s`
console.log(`${TOOL}: time roster simplify-only ${seconds(rosterTime.simplify)}, production generateLodChain ${seconds(rosterTime.chain)}, ` +
	`repair alone ${seconds(rosterTime.repair)} (+${(rosterTime.repair / rosterTime.simplify * 100).toFixed(1)}%); all packs ` +
	`${seconds(simplifyMs)}, ${seconds(chainMs - chainStart)}, ${seconds(repairMs)} (+${(repairMs / simplifyMs * 100).toFixed(1)}%)`)
const lod0 = rows.filter(row => row.levels[0].after.awayCorners > 0).sort((a, b) => b.levels[0].after.away - a.levels[0].after.away)
console.log(`${TOOL}: PASS`, JSON.stringify({ checks: checks.length, assets: rows.length, forge: FORGE, fetched: fetched.length,
	decoysSharingALadder: decoys.length, smoothControlWorstDeg: Number(smoothControlWorstDeg.toFixed(1)),
	authoredLod0BackFacing: { assets: lod0.length, worst: lod0.slice(0, 6).map(row => `${row.label} ${pct(row.levels[0].after.away)}`) },
	limitation: 'CPU decimation and a recording GPU in bind pose: not skinned poses, raster output or IndexedDB cache hits.' }))
