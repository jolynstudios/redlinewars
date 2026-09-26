#!/usr/bin/env node
// STEELSEED — the missile submarine's anti-air missile (vfx.md Epic 6, MSUB: "distinct AA/ground
// paths").
//
// Real shipping host and stock OpenRA rules. The MSUB fires SubMissileAA only at an enemy aircraft
// in the air: its AttackFrontal has ForceFireIgnoresActors, so a forced attack on any actor is an
// attack on the ground under it, which an anti-air weapon cannot take; and a player's sub holds
// fire until told. So the fixture puts an enemy helicopter at its cruising altitude over a pond
// (the map's CenterPosition init) and our sub in the water below; the order is the plain click the
// page sends (queryContextOrder, issueContextOrder). PASS requires the cursor to offer Attack, the
// click to order it, and our sub to fire SubMissileAA (weapon fire events naming it), whose flight
// the presentation draws by that weapon's anti-air profile.
//
//   node tools/subaagate.mjs [--bundle=<AppBundle>]
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../../../web/node_modules/esbuild/lib/main.js'
import { bootVfsRuntime } from './runtime-vfs-fixture.mjs'
import { configFor, waitForSnapshot } from './runtime-fixture.mjs'

const root = resolve(import.meta.dirname, '../../..')
const bundleArg = process.argv.find(a => a.startsWith('--bundle='))?.slice('--bundle='.length)
const bundled = await build({ stdin: { contents: "export {SnapshotDecoder} from './src/core/snapshot'", resolveDir: join(root, 'web') }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' })
const decoderModule = { exports: {} }; new Function('module', 'exports', bundled.outputFiles[0].text)(decoderModule, decoderModule.exports)
const decoder = new decoderModule.exports.SnapshotDecoder()

const POND = { x0: 30, x1: 60, y0: 16, y1: 40 }
const runtime = await bootVfsRuntime(fs => {
	const dir = '/openra/engine/mods/ra/maps/doubles', file = dir + '/map.yaml'
	const text = fs.readFile(file, { encoding: 'utf8' })
	// A helicopter over the pond's far side at CruiseAltitude (1280): cells are 1024 WPos.
	const heli = `\tEnemyHeli: heli\n\t\tOwner: Multi1\n\t\tLocation: 52,28\n\t\tCenterPosition: ${52 * 1024 + 512},${28 * 1024 + 512},1280\n`
	const actors = [
		['Spawn0', 'mpspawn', 'Neutral', 6, 6], ['Spawn1', 'mpspawn', 'Neutral', 106, 48],
		['Spawn2', 'mpspawn', 'Neutral', 6, 48], ['Spawn3', 'mpspawn', 'Neutral', 106, 6],
		['OwnYard', 'fact', 'Multi0', 6, 10], ['OwnSub', 'msub', 'Multi0', 44, 28],
		['EnemyYard', 'fact', 'Multi1', 100, 44],
	]
	fs.writeFile(file, text.split('\nActors:\n')[0] + '\nActors:\n'
		+ actors.map(([id, type, owner, x, y]) => `\t${id}: ${type}\n\t\tOwner: ${owner}\n\t\tLocation: ${x},${y}\n`).join('') + heli)
	const width = 112, height = 54, n = width * height, terrain = new Uint8Array(5 + n * 5), view = new DataView(terrain.buffer)
	terrain[0] = 1; view.setUint16(1, width, true); view.setUint16(3, height, true)
	for (let i = 0; i < n; i++) view.setUint16(5 + i * 3, 255, true)
	// map.bin stores tiles column by column (OpenRA Map: x outer, y inner); template 1 is water.
	for (let y = POND.y0; y <= POND.y1; y++) for (let x = POND.x0; x <= POND.x1; x++) view.setUint16(5 + (x * height + y) * 3, 1, true)
	fs.writeFile(dir + '/map.bin', terrain)
}, ...(bundleArg ? [resolve(bundleArg)] : []))

const catalog = runtime.bridge.getSkirmishCatalog(), map = catalog.maps.find(m => m.title === 'Doubles')
assert.ok(map, 'Doubles map missing from the skirmish catalog')
const config = configFor(catalog, map, { withBot: true })
config.options.explored = 'True'; config.options.fog = 'False'
assert.equal(runtime.bridge.startSkirmish(config).status, 'loading')

let snap = null, names = null
const fires = {}
const observe = (latest, bytes) => {
	snap = decoder.decode(bytes); names ??= runtime.bridge.snapshotTypeTable().split('\n')
	const events = latest.sections.get(7)
	if (!events) return
	const view = latest.view, end = events.offset + events.byteLength
	let at = events.offset + 4
	for (let i = view.getUint32(events.offset, true); i > 0 && at + 4 <= end; i--) {
		const kind = view.getUint16(at, true), length = view.getUint16(at + 2, true)
		if (kind === 1 && length >= 22) {
			const actor = view.getUint32(at + 4, true), weapon = names[view.getUint16(at + 4 + 20, true)] ?? '?'
			fires[actor] ??= {}; fires[actor][weapon] = (fires[actor][weapon] ?? 0) + 1
		}
		at = (at + 4 + length + 3) & ~3
	}
}
await waitForSnapshot(runtime, { minimumTick: 10, onSnapshot: observe })
const find = type => { const a = snap.actors; for (let i = 0; i < a.count; i++) if (names[a.typeId[i]] === type) return { id: a.id[i], owner: a.owner[i], x: a.posX[i] / 1024, y: a.posY[i] / 1024, z: a.posZ[i] / 1024, flags: a.flags[i] }; return null }
const sub = find('msub'), heli = find('heli')
assert.ok(sub && heli, `fixture: sub ${JSON.stringify(sub)} heli ${JSON.stringify(heli)}`)
assert.ok(heli.z > 0.5, `the helicopter must start in the air (altitude ${heli.z} cells)`)
const intent = { subjectIds: Uint32Array.of(sub.id), subjectCount: 1, targetActorId: heli.id, targetCellX: Math.floor(heli.x), targetCellY: Math.floor(heli.y), targetFrozen: false, modifiers: 0 }
const preview = runtime.bridge.queryContextOrder(intent), order = runtime.bridge.issueContextOrder(intent)
const deadline = snap.tick + 400
while (snap.tick < deadline && !(fires[sub.id]?.SubMissileAA > 0 || fires[sub.id]?.submissileaa > 0))
	await waitForSnapshot(runtime, { minimumTick: snap.tick + 2, timeoutMs: 30_000, onSnapshot: observe })
console.log(JSON.stringify({ heli, preview, order, fires: fires[sub.id] ?? {} }))
assert.equal(preview?.order, 'Attack', `the cursor on the enemy helicopter must offer Attack: ${JSON.stringify(preview)}`)
assert.match(order, /^ok:.*\(Attack\)/, `the click must order the attack: ${order}`)
const aa = Object.entries(fires[sub.id] ?? {}).find(([w]) => /^submissileaa$/i.test(w))?.[1] ?? 0
assert.ok(aa > 0, `the sub never fired SubMissileAA at the helicopter (${JSON.stringify(fires[sub.id] ?? {})})`)

const date = new Date().toISOString().slice(0, 10)
const EVIDENCE = join(root, 'docs/vfx/scenario-evidence.json'), lock = `${EVIDENCE}.lock`
for (let tries = 0; ; tries++) { try { mkdirSync(lock); break } catch (e) { if (e.code !== 'EEXIST') throw e; if (tries > 400) rmSync(lock, { recursive: true, force: true }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25) } }
try {
	const file = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) : { schemaVersion: 1, weapons: {}, actions: {} }
	file.weapons['msub:Armament.Weapon:submissileaa'] = `S05 subaagate ${date}: a plain click on an enemy helicopter in the air: Attack, and the sub fired SubMissileAA ${aa}x (the anti-air profile draws it)`
	file.weapons = Object.fromEntries(Object.entries(file.weapons).sort(([a], [b]) => a < b ? -1 : 1))
	writeFileSync(EVIDENCE, JSON.stringify(file, null, '\t') + '\n')
} finally { rmSync(lock, { recursive: true, force: true }) }
console.log(`subaagate: PASS — the enemy helicopter at ${heli.z.toFixed(2)} cells up; Attack ordered by the click; SubMissileAA fired ${aa}x`)
process.exit(0)
