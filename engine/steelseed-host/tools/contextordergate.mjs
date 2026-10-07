#!/usr/bin/env node
// STEELSEED — contextual order gate (vfx.md Epic 2): what a plain click means with fog ON.
//
// Real shipping host and stock OpenRA targeters, driven through the bridge the page uses
// (queryContextOrder for the cursor preview, issueContextOrder for the click). Only the
// in-memory fixture map changes. Fog is on and the map explored, so each actor sits in the
// real visibility state the player sees:
//   - an enemy power plant only partly in sight: one footprint cell is within the light tank's
//     5-cell vision, its centre cell is not. A plain click must attack it; no Ctrl needed;
//   - a tree on explored ground outside vision, which the snapshot publishes under fog. A
//     click the presentation sends with that tree as target is a click on its cell: the unit
//     must move there, not answer and stay put;
//   - a ground click for each other kind of mover: a rifleman walks, a helicopter flies and a
//     gunboat sails (on a pond painted into the fixture) to the clicked cell.
// Every mover really goes: its position is checked afterwards.
//
// Usage: node tools/contextordergate.mjs [--bundle=<AppBundle dir>]   (default: engine/bin-browser)
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../../../web/node_modules/esbuild/lib/main.js'
import { bootVfsRuntime } from './runtime-vfs-fixture.mjs'
import { configFor, waitForSnapshot } from './runtime-fixture.mjs'

const bundleArg = process.argv.find(v => v.startsWith('--bundle='))?.slice('--bundle='.length)
const root = resolve(import.meta.dirname, '../../..'), out = join(root, '.artifacts/context-orders')
mkdirSync(out, { recursive: true })
const bundled = await build({ stdin: { contents: "export {SnapshotDecoder} from './src/core/snapshot'", resolveDir: join(root, 'web') }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' })
const decoderModule = { exports: {} }; new Function('module', 'exports', bundled.outputFiles[0].text)(decoderModule, decoderModule.exports)
const decoder = new decoderModule.exports.SnapshotDecoder()

const POND = { x0: 40, x1: 60, y0: 36, y1: 48 }
const runtime = await bootVfsRuntime(fs => {
	const dir = '/openra/engine/mods/ra/maps/doubles', file = dir + '/map.yaml'
	const text = fs.readFile(file, { encoding: 'utf8' })
	const actors = [
		['Spawn0', 'mpspawn', 'Neutral', 80, 40], ['Spawn1', 'mpspawn', 'Neutral', 100, 40],
		['Spawn2', 'mpspawn', 'Neutral', 80, 46], ['Spawn3', 'mpspawn', 'Neutral', 100, 46],
		['Gunner', '1tnk', 'Multi0', 20, 20], ['Walker', '1tnk', 'Multi0', 20, 26],
		['HalfSeen', 'powr', 'Multi1', 25, 19], ['FoggedTree', 't01', 'Neutral', 30, 26],
		['EnemyBarracks', 'barr', 'Multi1', 94, 44],
		['Rifleman', 'e1', 'Multi0', 14, 34], ['Chopper', 'heli', 'Multi0', 14, 40], ['Boat', 'pt', 'Multi0', POND.x0 + 1, POND.y0 + 2],
	]
	fs.writeFile(file, text.split('\nActors:\n')[0] + '\nActors:\n'
		+ actors.map(([id, type, owner, x, y]) => `\t${id}: ${type}\n\t\tOwner: ${owner}\n\t\tLocation: ${x},${y}\n`).join(''))
	const width = 112, height = 54, n = width * height, terrain = new Uint8Array(5 + n * 5), view = new DataView(terrain.buffer)
	terrain[0] = 1; view.setUint16(1, width, true); view.setUint16(3, height, true)
	for (let i = 0; i < n; i++) view.setUint16(5 + i * 3, 255, true)
	// A pond (template 1, water) for the gunboat.
	// map.bin stores tiles column by column (OpenRA Map: x outer, y inner).
	for (let y = POND.y0; y <= POND.y1; y++) for (let x = POND.x0; x <= POND.x1; x++) view.setUint16(5 + (x * height + y) * 3, 1, true)
	fs.writeFile(dir + '/map.bin', terrain)
}, bundleArg ? resolve(bundleArg) : undefined)

const catalog = runtime.bridge.getSkirmishCatalog(), map = catalog.maps.find(m => m.title === 'Doubles')
assert.ok(map, 'Doubles map missing from the skirmish catalog')
const config = configFor(catalog, map, { withBot: true })
config.options.explored = 'True'; config.options.fog = 'True'
assert.equal(runtime.bridge.startSkirmish(config).status, 'loading')

let snap = null, names = null
let terrainStatic = null
const observe = (_header, bytes) => { snap = decoder.decode(bytes); if (snap.terrainStatic) terrainStatic = { ...snap.terrainStatic, passability: snap.terrainStatic.passability.slice(), type: snap.terrainStatic.type.slice(), surface: snap.terrainStatic.surface.slice() }; names ??= runtime.bridge.snapshotTypeTable().split('\n') }
await waitForSnapshot(runtime, { minimumTick: 20, onSnapshot: observe })
function actor(type, x, y) {
	const a = snap.actors
	for (let i = 0; i < a.count; i++)
		if (names[a.typeId[i]] === type && Math.abs(a.posX[i] / 1024 - x) < 2 && Math.abs(a.posY[i] / 1024 - y) < 2)
			return { id: a.id[i], x: a.posX[i] / 1024, y: a.posY[i] / 1024 }
	return null
}
const gunner = actor('1tnk', 20.5, 20.5), walker = actor('1tnk', 20.5, 26.5)
const plant = actor('powr', 26, 20), tree = actor('t01', 30.5, 26.5)
assert.ok(gunner && walker, 'fixture tanks missing from the snapshot')
assert.ok(plant, 'the half-seen enemy power plant must be published (part of its footprint is in sight)')
assert.ok(tree, 'the fogged tree must be published (trees stay visible under fog)')

// What the page sends: the clicked actor plus the cell under the cursor.
const intent = (subject, target, cellX, cellY) => ({ subjectIds: Uint32Array.of(subject.id), subjectCount: 1,
	targetActorId: target.id, targetCellX: cellX, targetCellY: cellY, targetFrozen: false, modifiers: 0 })
const report = { bundle: bundleArg ?? 'engine/bin-browser/AppBundle', plant, tree }
// The pointer rests on the plant's one visible cell, (25,20).
report.plantPreview = runtime.bridge.queryContextOrder(intent(gunner, plant, 25, 20))
report.plantOrder = runtime.bridge.issueContextOrder(intent(gunner, plant, 25, 20))
report.treePreview = runtime.bridge.queryContextOrder(intent(walker, tree, 30, 26))
report.treeOrder = runtime.bridge.issueContextOrder(intent(walker, tree, 30, 26))
// A ground click (no actor under the cursor) for a soldier, an aircraft and a ship.
const byId = id => { const a = snap.actors; for (let i = 0; i < a.count; i++) if (a.id[i] === id) return { id, x: a.posX[i] / 1024, y: a.posY[i] / 1024 }; return null }
const movers = [
	{ label: 'rifleman', unit: actor('e1', 14.5, 34.5), to: { x: 22, y: 34 } },
	{ label: 'helicopter', unit: actor('heli', 14.5, 40.5), to: { x: 30, y: 40 } },
	{ label: 'gunboat', unit: actor('pt', POND.x0 + 1.5, POND.y0 + 2.5), to: { x: POND.x1 - 3, y: POND.y1 - 3 } },
]
for (const mv of movers) {
	assert.ok(mv.unit, `fixture ${mv.label} missing from the snapshot`)
	const ground = { ...intent(mv.unit, { id: 0 }, mv.to.x, mv.to.y) }
	mv.preview = runtime.bridge.queryContextOrder(ground)
	mv.order = runtime.bridge.issueContextOrder(ground)
}
await waitForSnapshot(runtime, { minimumTick: snap.tick + 120, timeoutMs: 30_000, onSnapshot: observe })
for (const mv of movers) {
	let deadline = snap.tick + 600
	while (snap.tick < deadline) {
		const now = byId(mv.unit.id)
		if (now && Math.hypot(now.x - mv.to.x - 0.5, now.y - mv.to.y - 0.5) < 1.2) { mv.arrived = snap.tick; break }
		await waitForSnapshot(runtime, { minimumTick: snap.tick + 10, timeoutMs: 30_000, onSnapshot: observe })
	}
	mv.after = byId(mv.unit.id)
}
report.movers = movers.map(({ label, preview, order, arrived, after }) => ({ label, preview: preview?.order, order, arrived, after }))
report.walkerAfter = actor('1tnk', walker.x, walker.y) ?? (() => { const a = snap.actors; for (let i = 0; i < a.count; i++) if (a.id[i] === walker.id) return { id: a.id[i], x: a.posX[i] / 1024, y: a.posY[i] / 1024 }; return null })()
writeFileSync(join(out, 'engine-report.json'), JSON.stringify(report, null, 2) + '\n')
console.log('contextordergate', JSON.stringify(report))

assert.equal(report.plantPreview?.order, 'Attack', `a plain click on a half-seen enemy building must preview Attack, got ${JSON.stringify(report.plantPreview)}`)
assert.match(report.plantOrder, /^ok:.*\(Attack\)/, `a plain click on a half-seen enemy building must attack it: ${report.plantOrder}`)
assert.equal(report.treePreview?.order, 'Move', `a click on a fogged tree must preview a Move to its cell, got ${JSON.stringify(report.treePreview)}`)
assert.match(report.treeOrder, /^ok:.*\(Move\)/, `a click on a fogged tree must move the unit to its cell: ${report.treeOrder}`)
assert.ok(report.walkerAfter && report.walkerAfter.x - walker.x > 2, `the tank answered but did not drive: ${JSON.stringify(walker)} -> ${JSON.stringify(report.walkerAfter)}`)
{
	const t = terrainStatic, w = snap.world
	if (t && t.passability) {
		const at = (x, y) => { const i = (y - w.boundsTop) * t.w + (x - w.boundsLeft); return { type: t.type?.[i], pass: t.passability[i], surface: t.surface?.[i] } }
		report.pond = { boat: at(41, 38), dest: at(57, 45), land: at(30, 30), bounds: [w.boundsLeft, w.boundsTop, w.boundsRight, w.boundsBottom] }
		console.log('pond', JSON.stringify(report.pond))
	} else console.log('no static terrain in the decoded snapshot', Object.keys(snap).join(','))
}
for (const mv of movers) {
	assert.equal(mv.preview?.order, 'Move', `${mv.label}: a ground click must preview Move, got ${JSON.stringify(mv.preview)}`)
	assert.match(mv.order, /^ok:.*\(Move\)/, `${mv.label}: a ground click must move it: ${mv.order}`)
	assert.ok(mv.arrived !== undefined, `${mv.label}: never reached the clicked cell (${JSON.stringify(mv.after)} vs ${JSON.stringify(mv.to)})`)
}
console.log('CONTEXT_ORDER_GATE_PASS', JSON.stringify({ plant: report.plantOrder, tree: report.treeOrder, walker: [walker.x, report.walkerAfter.x], movers: report.movers.map(m => `${m.label} arrived at tick ${m.arrived}`) }))
process.exit(0)
