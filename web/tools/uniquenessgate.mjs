#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const TOOL = 'uniquenessgate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(WEB_ROOT, 'src/core/ra-visual-manifest.json'), 'utf8'))
const tmp = mkdtempSync(join(tmpdir(), 'steelseed-uniqueness-'))
const bundlePath = join(tmp, 'source.mjs')
let source
try {
	await build({
		stdin: {
			contents: [
				"export { buildUnitFromSlot } from './src/units/shapes.ts'",
				"export { Mesh } from './src/geo/mesh.ts'",
				"export { rootRng } from './src/core/rng.ts'",
			].join('\n'),
			resolveDir: WEB_ROOT,
			sourcefile: 'uniqueness-entry.ts',
			loader: 'ts',
		},
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node22',
		outfile: bundlePath,
		logLevel: 'silent',
	})
	source = await import(pathToFileURL(bundlePath).href)
} finally {
	rmSync(tmp, { recursive: true, force: true })
}

const { buildUnitFromSlot, Mesh, rootRng } = source
const meshes = new Map()
const silhouettes = new Map()
const failures = []
let vertices = 0
let renderable = 0
let buildable = 0
for (const [name, actor] of Object.entries(manifest.actors)) {
	if (!actor.renderable) continue
	renderable++
	const mesh = new Mesh()
	const metadata = { rig: null, rigSkipReason: null }
	try {
		buildUnitFromSlot(mesh, actor.slot, rootRng(`uniqueness/${name}`), metadata)
	} catch (error) {
		failures.push(`${name}: ${(error).message}`)
		continue
	}
	vertices += mesh.vertexCount
	const hash = meshHash(mesh)
	if (meshes.has(hash)) failures.push(`${name}: mesh hash collides with ${meshes.get(hash)} (${hash})`)
	else meshes.set(hash, name)
	const isBuildable = actor.traits.some(trait => trait.Name === 'Buildable')
	if (isBuildable) {
		buildable++
		const signature = referenceSilhouettes(mesh).join(':')
		if (silhouettes.has(signature))
			failures.push(`${name}: all eight quantised reference silhouettes collide with ${silhouettes.get(signature)}`)
		else silhouettes.set(signature, name)
	}
}

if (renderable !== manifest.renderableCount || meshes.size !== renderable)
	failures.push(`built ${meshes.size} unique meshes for ${renderable} renderable actors; catalog declares ${manifest.renderableCount}`)
if (failures.length) {
	for (const failure of failures.slice(0, 50)) console.error(`${TOOL}: FAIL — ${failure}`)
	if (failures.length > 50) console.error(`${TOOL}: ... ${failures.length - 50} further failures`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — ${renderable} actor meshes have unique geometry hashes (${vertices} vertices); ` +
	`${buildable} buildable actors differ in at least one of eight reference silhouettes`)

function meshHash(mesh) {
	const hash = createHash('sha256')
	hash.update(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.vertexCount * 3 * 4))
	hash.update(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indexCount * 4))
	return hash.digest('hex').slice(0, 20)
}

function referenceSilhouettes(mesh) {
	const signatures = []
	for (let direction = 0; direction < 8; direction++) {
		const angle = direction * Math.PI / 4
		const c = Math.cos(angle)
		const s = Math.sin(angle)
		const bins = new Set()
		for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
			const offset = vertex * 3
			const horizontal = mesh.positions[offset] * c - mesh.positions[offset + 2] * s
			const vertical = mesh.positions[offset + 1]
			bins.add(`${Math.round(horizontal * 16)},${Math.round(vertical * 16)}`)
		}
		const hash = createHash('sha256').update([...bins].sort().join(';')).digest('hex').slice(0, 12)
		signatures.push(hash)
	}
	return signatures
}
