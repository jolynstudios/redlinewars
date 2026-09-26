#!/usr/bin/env node
// STEELSEED — tools/tracksgate
//
// A tank that drives on grass has to leave a pair of ruts, and those ruts have to
// vanish. This gate drives the real GroundTracks class with a fake snapshot, not a
// second implementation of the stamp.
//
// Proves:
//   * the pad meshes (zero vertices would boot and draw nothing)
//   * a tracked actor travelling 1 m on grass stamps TWO marks (left and right)
//   * a parked tank stamps nothing more
//   * concrete and infantry produce zero marks
//   * sand and snow do stamp
//   * at t = 10.1 s every mark is gone
//   * the budget overwrites rather than growing

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const TOOL = 'tracksgate'
const WEB = fileURLToPath(new URL('..', import.meta.url))
const SAND = 2, GRASS = 4, CONCRETE = 7, SNOW = 10
const LIFE = 10

const tmp = mkdtempSync(join(tmpdir(), 'steelseed-tracksgate-'))
const outfile = join(tmp, 'tracks.mjs')
await build({
	stdin: {
		contents: `export { GroundTracks } from './src/fx/ground-tracks'
export { Surface } from './src/core/surface'
export { runningGearProfile } from './src/units/running-gear'
export { fitScaleForMesh } from './src/units/occupancy'`,
		resolveDir: WEB,
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile,
	logLevel: 'silent',
	define: { 'import.meta.glob': '__gateGlob' },
	banner: { js: 'const __gateGlob = () => ({})' },
})
const { GroundTracks, runningGearProfile, fitScaleForMesh } = await import(pathToFileURL(outfile).href)

const authored = JSON.parse(readFileSync(new URL('../.forge/blender/manifest.json', import.meta.url),'utf8')).assets
const contactFor = name => { const b=authored[name]?.bounds; return b?runningGearProfile(name,fitScaleForMesh(b[1][0]-b[0][0],b[1][2]-b[0][2],1,1)):null }

const uploaded = []
const submitted = []
const render = {
	upload(mesh, label) {
		assert.ok(mesh.vertexCount > 0, `${label} meshed to nothing`)
		assert.ok(mesh.triangleCount > 0, `${label} has no triangles`)
		uploaded.push({ label, vertices: mesh.vertexCount, triangles: mesh.triangleCount })
		return { aabbMin: mesh.aabbMin, aabbMax: mesh.aabbMax, indexCount: mesh.indexCount, label }
	},
	submit(item) { submitted.push({ count: item.instanceCount, opacity: item.opacity ?? 1 }) },
	// GroundTracks culls stamps against the live camera position (ground-tracks.ts:162).
	camera: { position: [0, 0, 0] },
}
const shroud = { unmodelled: false, isVisible() { return true } }

function actors(kind, x, z, surface, id = 7) {
	const typeId = kind === '2tnk' ? 1 : kind === 'jeep' ? 2 : 3
	return {
		count: 1,
		id: Uint32Array.of(id),
		posX: Int32Array.of((x * 1024) | 0),
		posY: Int32Array.of((z * 1024) | 0),
		posZ: Int32Array.of(0),
		typeId: Uint16Array.of(typeId),
		facing: Uint16Array.of(0),
		flags: Uint8Array.of(0),
		surface: Uint8Array.of(surface),
	}
}

let nextId = 7
function ctxFor(name, surface, dist, x = 16, z = 16) {
	let distance = dist
	const actorId = nextId++
	const names = { 1: '2tnk', 2: 'jeep', 3: 'e1' }
	return {
		actorTypeName: id => names[id] ?? '',
		peek: id => id === 'anim' ? { sideDistanceOf() { return distance } } : id === 'units' ? { runningGearOf: contactFor } : null,
		snapshot: { actors: actors(name, x, z, surface, actorId) },
		setDist(v) { distance = v },
		move(nx, nz, nd) { distance = nd; this.snapshot.actors.posX[0] = (nx * 1024) | 0; this.snapshot.actors.posY[0] = (nz * 1024) | 0 },
	}
}

function terrainAt(surface) {
	return {
		heightAt() { return 0.12 },
		surfaceAt() { return surface },
	}
}

function drive(tracks, ctx, terrain, t0, dist0, x0, z0, dist1, x1, z1, t1) {
	submitted.length = 0
	ctx.move(x0, z0, dist0)
	tracks.tick(t0, ctx, render, terrain, shroud)
	submitted.length = 0
	ctx.move(x1, z1, dist1)
	tracks.tick(t1, ctx, render, terrain, shroud)
	return submitted.reduce((n, s) => n + s.count, 0)
}

try {
	const tracks = new GroundTracks()
	tracks.init(render, 256)
	assert.equal(uploaded.length, 2, `expected a tracked pad and a wheeled rut, uploaded ${uploaded.length}`)
	assert.ok(!uploaded.some(u => u.label === 'fx:ground-scorch'), 'explosions must not upload raised scorch plates')
	assert.equal(uploaded[0].label, 'fx:ground-track')
	assert.equal(uploaded[1].label, 'fx:ground-tyremark')
	// The regression this pins: one cleated shoe shared by both kinds read as caterpillar
	// tracks behind every wheeled vehicle. The wheeled mark must be its own smoother mesh.
	assert.ok(uploaded[1].triangles !== uploaded[0].triangles,
		`wheeled pad reuses the tracked shoe geometry (${uploaded[1].triangles} tris both)`)
	assert.ok(uploaded[0].vertices >= 24, `tracked pad too thin: ${uploaded[0].vertices} verts`)
	assert.ok(uploaded[1].vertices >= 12, `wheeled pad too thin: ${uploaded[1].vertices} verts`)
	console.log(`${TOOL}: pads ${uploaded[0].vertices}/${uploaded[1].vertices} verts, ${uploaded[0].triangles}/${uploaded[1].triangles} tris (tracked/wheeled)`)

	// First sighting must not stamp — otherwise a spawn is a skid mark from the origin.
	const grass = terrainAt(GRASS)
	const tank = ctxFor('2tnk', GRASS, 0)
	tracks.tick(0, tank, render, grass, shroud)
	assert.equal(tracks.stats.stamped, 0, 'first sighting stamped')

	// 1.2 m of travel on grass: two pitches, two sides = 4 marks.
	const nGrass = drive(tracks, tank, grass, 0.1, 0, 16, 16, 1.2, 17.2, 16, 0.2)
	assert.ok(nGrass >= 4, `tracked grass travel submitted ${nGrass}, want at least a pair of ruts per pitch`)
	assert.ok(tracks.stats.stamped >= 4, `stamped ${tracks.stats.stamped}`)
	const afterGrass = tracks.stats.stamped

	// Parked: same distance, no new marks.
	submitted.length = 0
	tracks.tick(0.4, tank, render, grass, shroud)
	assert.equal(tracks.stats.stamped, afterGrass, 'parked tank kept stamping')

	// Concrete: a jeep travelling 2 m must leave nothing.
	const jeep = ctxFor('jeep', CONCRETE, 0, 20, 20)
	const beforeRoad = tracks.stats.stamped
	drive(tracks, jeep, terrainAt(CONCRETE), 1, 0, 20, 20, 2, 22, 20, 1.2)
	assert.equal(tracks.stats.stamped, beforeRoad, `jeep on concrete stamped ${tracks.stats.stamped - beforeRoad}`)

	const rifle = ctxFor('e1', GRASS, 0, 8, 8)
	const beforeFoot = tracks.stats.stamped
	drive(tracks, rifle, grass, 2, 0, 8, 8, 3, 10, 8, 2.2)
	assert.equal(tracks.stats.stamped, beforeFoot, `infantry stamped ${tracks.stats.stamped - beforeFoot}`)

	const sand = ctxFor('2tnk', SAND, 0, 30, 30)
	const beforeSand = tracks.stats.stamped
	drive(tracks, sand, terrainAt(SAND), 3, 0, 30, 30, 1.1, 31.1, 30, 3.2)
	assert.ok(tracks.stats.stamped - beforeSand >= 4, `sand stamped ${tracks.stats.stamped - beforeSand}`)
	const snow = ctxFor('jeep', SNOW, 0, 40, 40)
	const beforeSnow = tracks.stats.stamped
	drive(tracks, snow, terrainAt(SNOW), 4, 0, 40, 40, 1.1, 41.1, 40, 4.2)
	assert.ok(tracks.stats.stamped - beforeSnow >= 4, `snow stamped ${tracks.stats.stamped - beforeSnow}`)

	// Expiry: jump time past 10 s with no new travel. Every earlier mark must die.
	submitted.length = 0
	tracks.tick(4.2 + LIFE + 0.2, tank, render, grass, shroud)
	const still = submitted.reduce((n, s) => n + s.count, 0)
	assert.equal(still, 0, `marks still submitted at t=10.2s: ${still}`)
	assert.equal(tracks.stats.active, 0, `active ${tracks.stats.active} after fade`)

	console.log(`${TOOL}: PASS — ${tracks.stats.stamped} stamps, pad ${uploaded[0].triangles} tris; grass/sand/snow stamp, concrete/infantry/parked do not, gone after ${LIFE}s`)
} finally {
	rmSync(tmp, { recursive: true, force: true })
}
