#!/usr/bin/env node
// STEELSEED — boot LOD cache digest gate.
//
// The roster LOD cache is keyed by a digest over every decimator input. Slots
// with a forge asset feed their source hash; slots whose base mesh is generated
// procedurally must feed their GEOMETRY, or a generator change ships while
// browsers keep decimating the replaced mesh — the square wall plates reading
// as circles at distance is exactly that hole. This gate pins the contract:
// stable digest for a stable mesh, a real geometry edit rolls it, float wobble
// below the quantum does not, and asset identity still rolls it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

const temp = mkdtempSync(join(tmpdir(), 'steelseed-lodcache-'))
const outfile = join(temp, 'lodcache.mjs')
await build({
	stdin: {
		contents: "export { lodDigest, meshDigest } from './src/core/lod-cache.ts'; export { Mesh } from './src/geo/mesh.ts'",
		resolveDir: new URL('..', import.meta.url).pathname,
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile,
})
const { lodDigest, meshDigest, Mesh } = await import(pathToFileURL(outfile).href)

// A small stand-in for a procedurally generated wall: counts, all channels.
const makeMesh = () => {
	const mesh = new Mesh(4, 2)
	mesh.vertexCount = 4
	mesh.triangleCount = 2
	for (let i = 0; i < 4; i++) {
		mesh.positions[i * 3] = i * 0.25
		mesh.positions[i * 3 + 1] = 1.5
		mesh.positions[i * 3 + 2] = -0.5
		mesh.normals[i * 3 + 1] = 1
		mesh.uv0[i * 2] = i * 0.125
		mesh.uv0[i * 2 + 1] = 0.5
		mesh.uv1[i * 2] = 0.25
		mesh.materialZone[i] = i & 3
	}
	mesh.indices.set([0, 1, 2, 2, 1, 3])
	return mesh
}

test('meshDigest is stable across rebuilds of the same mesh', () => {
	assert.equal(meshDigest(makeMesh()), meshDigest(makeMesh()))
})

test('a real geometry edit rolls the mesh digest', () => {
	const moved = makeMesh()
	moved.positions[0] += 0.5 // half a metre: far outside the millimetre quantum
	assert.notEqual(meshDigest(moved), meshDigest(makeMesh()))
	const rewelded = makeMesh()
	rewelded.indices[2] = 3
	assert.notEqual(meshDigest(rewelded), meshDigest(makeMesh()))
})

test('float wobble below the quantum does not roll the digest', () => {
	const wobble = makeMesh()
	wobble.positions[7] += 1e-9
	wobble.normals[2] += 1e-9
	assert.equal(meshDigest(wobble), meshDigest(makeMesh()))
})

test('lodDigest covers procedural geometry, asset identity and roster order', () => {
	const assets = { '1tnk': { sourceSha256: 'a'.repeat(64), bytes: 1024 } }
	const procedural = new Map([['foundry_bulwark', makeMesh()]])
	const slots = ['1tnk', 'foundry_bulwark']
	assert.equal(lodDigest(assets, slots, procedural), lodDigest(assets, [...slots].reverse(), procedural))

	// The regression this gate exists for: same slot list, changed generator output.
	const edited = makeMesh()
	edited.positions[0] += 2 // a generator change: the wall corner moves two metres
	const faceted = new Map([['foundry_bulwark', edited]])
	assert.notEqual(lodDigest(assets, slots, faceted), lodDigest(assets, slots, procedural))

	// A procedural slot with no geometry at all must differ from one with it.
	assert.notEqual(lodDigest(assets, slots), lodDigest(assets, slots, procedural))

	// Asset identity still rolls the digest for forge-backed slots.
	const rehashed = { '1tnk': { sourceSha256: 'b'.repeat(64), bytes: 1024 } }
	assert.notEqual(lodDigest(rehashed, slots, procedural), lodDigest(assets, slots, procedural))
})

test('a re-bake of an unchanged source rolls the digest through the baked sha256', () => {
	// Same .blend, same byte count, different exporter output: new geometry to decimate.
	const slots = ['1tnk']
	const baked = sha256 => ({ '1tnk': { sourceSha256: 'a'.repeat(64), sha256, bytes: 1024 } })
	assert.equal(lodDigest(baked('c'.repeat(64)), slots), lodDigest(baked('c'.repeat(64)), slots))
	assert.notEqual(lodDigest(baked('d'.repeat(64)), slots), lodDigest(baked('c'.repeat(64)), slots))
	assert.notEqual(lodDigest(baked('c'.repeat(64)), slots), lodDigest({ '1tnk': { sourceSha256: 'a'.repeat(64), bytes: 1024 } }, slots))
})

test('the shading-repair format invalidates every chain cached before it', () => {
	// Format 1 keyed this exact input as c45c3251 (computed with the pre-repair lod-cache.ts). Every
	// bundle a pre-repair build wrote carries back-facing LOD normals and must miss once.
	const assets = { '1tnk': { sourceSha256: 'a'.repeat(64), bytes: 1024 } }
	const digest = lodDigest(assets, ['1tnk', 'foundry_bulwark'], new Map([['foundry_bulwark', makeMesh()]]))
	assert.match(digest, /^[0-9a-f]+$/)
	assert.notEqual(digest, 'c45c3251')
})

process.on('exit', () => { try { rmSync(temp, { recursive: true, force: true }) } catch {} })
