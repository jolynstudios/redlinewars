#!/usr/bin/env node
// STEELSEED — cloak gate (vfx.md Epic 6, STNK: "no silhouette or trail leak while undetected";
// S07 fairness: cloak).
//
// The real shipping host and stock OpenRA Cloak, viewed from the other side. Fog is off and the
// map explored, so every enemy actor is in plain sight — which is what makes a cloak the only
// thing that can hide one. An enemy stealth tank stands far from anything of ours; so does one
// of our own. PASS requires:
//   - before its cloak delay runs out, the enemy tank is in our snapshot (it can be seen);
//   - once cloaked, it is gone from our snapshot: no actor row, no frozen record, no projectile,
//     and no event record naming it (fire, movement, accepted order). Tracks, trails, wakes,
//     audio and lights are all driven by those, so none of them can draw it;
//   - our own stealth tank stays in our snapshot throughout, carrying the cloaked flag once its
//     delay runs out: the owner sees it, marked.
//
//   node tools/cloakgate.mjs
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { build } from '../../../web/node_modules/esbuild/lib/main.js'
import { bootVfsRuntime } from './runtime-vfs-fixture.mjs'
import { configFor, waitForSnapshot } from './runtime-fixture.mjs'

const root = resolve(import.meta.dirname, '../../..')
const runtime = await bootVfsRuntime(fs => {
	const dir = '/openra/engine/mods/ra/maps/doubles', file = dir + '/map.yaml'
	const text = fs.readFile(file, { encoding: 'utf8' })
	const actors = [
		['Spawn0', 'mpspawn', 'Neutral', 10, 10], ['Spawn1', 'mpspawn', 'Neutral', 100, 44],
		['Spawn2', 'mpspawn', 'Neutral', 10, 44], ['Spawn3', 'mpspawn', 'Neutral', 100, 10],
		['HomeA', 'powr', 'Multi0', 8, 8], ['HomeB', 'fact', 'Multi0', 12, 8],
		['OwnStealth', 'stnk', 'Multi0', 20, 40],
		['AwayA', 'powr', 'Multi1', 100, 8], ['AwayB', 'fact', 'Multi1', 96, 8],
		['EnemyStealth', 'stnk', 'Multi1', 60, 27],
	]
	fs.writeFile(file, text.split('\nActors:\n')[0] + '\nActors:\n'
		+ actors.map(([id, type, owner, x, y]) => `\t${id}: ${type}\n\t\tOwner: ${owner}\n\t\tLocation: ${x},${y}\n`).join(''))
	const width = 112, height = 54, n = width * height, terrain = new Uint8Array(5 + n * 5), view = new DataView(terrain.buffer)
	terrain[0] = 1; view.setUint16(1, width, true); view.setUint16(3, height, true)
	for (let i = 0; i < n; i++) view.setUint16(5 + i * 3, 255, true)
	fs.writeFile(dir + '/map.bin', terrain)
})

const catalog = runtime.bridge.getSkirmishCatalog(), map = catalog.maps.find(m => m.title === 'Doubles')
assert.ok(map, 'Doubles map missing from the skirmish catalog')
const config = configFor(catalog, map, { withBot: true })
config.options.explored = 'True'; config.options.fog = 'False'
assert.equal(runtime.bridge.startSkirmish(config).status, 'loading')

const bundled = await build({ stdin: { contents: "export {SnapshotDecoder} from './src/core/snapshot'", resolveDir: join(root, 'web') }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' })
const decoderModule = { exports: {} }; new Function('module', 'exports', bundled.outputFiles[0].text)(decoderModule, decoderModule.exports)
const decoder = new decoderModule.exports.SnapshotDecoder()
const names = () => runtime.bridge.snapshotTypeTable().split('\n')

// Event kinds whose payload starts with the actor id: fire, destroyed, moving, built, harvested,
// order accepted (ARCHITECTURE §4.9).
const NAMES_ACTOR = new Set([1, 5, 6, 7, 9, 11])
function eventsNaming(latest, id) {
	const events = latest.sections.get(7)
	if (!events) return 0
	const view = latest.view, end = events.offset + events.byteLength
	let at = events.offset + 4, found = 0
	for (let i = view.getUint32(events.offset, true); i > 0 && at + 4 <= end; i--) {
		const kind = view.getUint16(at, true), length = view.getUint16(at + 2, true)
		if (NAMES_ACTOR.has(kind) && length >= 4 && view.getUint32(at + 4, true) === id) found++
		at = (at + 4 + length + 3) & ~3
	}
	return found
}

let enemyId = null, ownId = null, tick = 0
const report = { seenBefore: 0, firstHidden: null, hiddenFrames: 0, leaks: [], ownFrames: 0, ownCloakedFrames: 0, frames: 0 }
const observe = (latest, bytes) => {
	tick = latest.tick
	const snap = decoder.decode(bytes), types = names(), a = snap.actors, me = snap.world.renderPlayer
	report.frames++
	let enemyRow = -1, ownRow = -1
	for (let i = 0; i < a.count; i++) {
		const type = types[a.typeId[i]]
		if (type !== 'stnk') continue
		if (a.owner[i] === me) { ownId ??= a.id[i]; if (a.id[i] === ownId) ownRow = i }
		else { enemyId ??= a.id[i]; if (a.id[i] === enemyId) enemyRow = i }
	}
	if (ownRow >= 0) { report.ownFrames++; if ((a.flags[ownRow] & 2) !== 0) report.ownCloakedFrames++ }
	if (enemyId === null) return
	if (enemyRow >= 0) {
		if (report.firstHidden === null) report.seenBefore++
		else report.leaks.push(`tick ${tick}: the cloaked enemy tank is back in the actor rows`)
		return
	}
	report.firstHidden ??= tick
	report.hiddenFrames++
	const frozen = snap.frozenActors
	if (frozen) for (let i = 0; i < frozen.count; i++) if (frozen.actorId?.[i] === enemyId || frozen.id?.[i] === enemyId) report.leaks.push(`tick ${tick}: a frozen record of the cloaked tank`)
	const p = snap.projectiles
	if (p) for (let i = 0; i < p.count; i++) if (p.sourceActorId[i] === enemyId) report.leaks.push(`tick ${tick}: a projectile from the cloaked tank`)
	const named = eventsNaming(latest, enemyId)
	if (named) report.leaks.push(`tick ${tick}: ${named} event record(s) naming the cloaked tank`)
}

await waitForSnapshot(runtime, { minimumTick: 3, onSnapshot: observe })
while (tick < 600) await waitForSnapshot(runtime, { minimumTick: tick + 1, timeoutMs: 30_000, onSnapshot: observe })

console.log(JSON.stringify({ ...report, leaks: report.leaks.slice(0, 5), leakCount: report.leaks.length }))
assert.ok(enemyId !== null && report.seenBefore > 0, 'the enemy stealth tank was never seen before it cloaked (fog off, explored)')
assert.ok(report.firstHidden !== null && report.hiddenFrames > 100, `the enemy tank never cloaked out of our view (${report.hiddenFrames} hidden frames)`)
assert.deepEqual(report.leaks, [], 'the cloaked tank leaked into our snapshot')
assert.ok(report.ownFrames === report.frames, `our own stealth tank must stay in our snapshot (${report.ownFrames}/${report.frames})`)
assert.ok(report.ownCloakedFrames > 100, `our own stealth tank must carry the cloaked flag once its delay runs out (${report.ownCloakedFrames})`)
console.log(`cloakgate: PASS — the enemy stealth tank was visible for ${report.seenBefore} frames, then cloaked at tick ${report.firstHidden} and stayed out of our snapshot for ${report.hiddenFrames} frames (no row, frozen record, projectile or event naming it); ours stayed visible, flagged cloaked in ${report.ownCloakedFrames} frames`)
