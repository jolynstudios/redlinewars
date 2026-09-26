#!/usr/bin/env node
// Run the production UI methods against visible snapshot fixtures. No WebGPU/browser needed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/ui/index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('ui.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const uiClass = ast.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'Ui')
const names = ['update', 'onSnapshot', 'markCombat', 'onWeaponFire', 'combatSide', 'enemyUnitMarked', 'appendGroundRing', 'submitGroundRings']
const members = names.map(name => {
 const member = uiClass.members.find(n => n.name?.getText(ast) === name)
 assert.ok(member, `missing production method ${name}`)
 return member.getText(ast)
})
// Module-level helpers the methods call, taken from their production source (never re-implemented here).
const coreSource = readFileSync(new URL('../src/core/snapshot.ts', import.meta.url), 'utf8')
const coreAst = ts.createSourceFile('snapshot.ts', coreSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const helpers = ['findActorIndex'].map(name => {
 const fn = coreAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)
 assert.ok(fn, `missing production helper ${name}`)
 return fn.getText(coreAst).replace(/^export\s+/, '')
})
const compiled = ts.transpileModule(`${helpers.join('\n')}\nclass TestedUi { ${members.join('\n')} }`, {
 compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const TestedUi = new Function(`const MAX_SELECTION=256, RING_RADIUS_M=.9, WPOS_TO_M=1/1024, COMBAT_RING_MS=5000, ActorFlag={husk:8}; ${compiled}; return TestedUi`)()
const ui = new TestedUi()
// Stub only unrelated HUD/interaction surfaces; ring, event and snapshot methods above are real.
for (const text of members) for (const [, name] of text.matchAll(/this\.(\w+)\(/g))
 if (!ui[name]) ui[name] = () => {}
const mesh = { indexCount: 240 }
Object.assign(ui, {
 selected: [101], instances: new Float32Array(4096), friendlyRingInstances: new Float32Array(4096),
 hostileRingInstances: new Float32Array(4096), ringCounts: new Uint16Array(3), combatMarks: new Map(),
 rallyPoints: new Map(), renderPlayerId: 1, catalog: { maps: [{}] }, pendingPlacement: null,
 supportPowerArmed: null, attackMoveArmed: false,
})
ui.item = { mesh, instances: ui.instances, instanceCount: 0, opacity: .5, playerColors: null }
ui.friendlyRingItem = { ...ui.item, instances: ui.friendlyRingInstances, unlitColor: new Float32Array([.2,.5,.3]) }
ui.hostileRingItem = { ...ui.item, instances: ui.hostileRingInstances, unlitColor: new Float32Array([.8,.1,.1]) }
const actors = {
 count: 4, id: Uint32Array.of(101, 102, 103, 104), owner: Uint8Array.of(1, 2, 3, 4),
 typeId: Uint16Array.of(5, 5, 5, 5), displayTypeId: Uint16Array.of(5, 5, 5, 5), flags: Uint8Array.of(0, 0, 0, 0),
 health: Uint8Array.of(255, 255, 255, 255),
 posX: Int32Array.of(1024,2048,3072,4096), posY: Int32Array.of(5120,6144,7168,8192),
}
const players = [{ id: 1, relation: 0 }, { id: 2, relation: 2 }, { id: 3, relation: 1 }, { id: 4, relation: 3 }]
const view = new DataView(new ArrayBuffer(128))
const snapshot = { actors, players, view }
// Type 5 is a tank; type 9 is a building (Construction Yard).
const units = { selectionRadiusM: () => .75, isRenderableType: () => true, healthBarEligible: () => true,
 hasRaTrait: (name, trait) => name === 'fact' && trait === 'Building' }
const submitted = []
ui.render = { submit: item => submitted.push({ item, count: item.instanceCount, matrix: Array.from(item.instances.slice(0,item.instanceCount*16)) }) }
ui.terrain = { heightAt: () => 2 }
// The marks block reads ctx.get('camera').focus/yaw per frame; provide the
// camera stub the production contract now exposes.
ui.ctx = { snapshot, input: { pointer: { pressed: 0 } }, actorTypeName: id => id === 9 ? 'fact' : 'mtnk', get: id => id === 'camera'
	? { focus: new Float32Array(3), yaw: 0, view: new Float32Array(16), position: new Float32Array(3) }
	: units }
const frame = () => { submitted.length = 0; ui.update(1/60, ui.ctx); return submitted }
assert.equal(frame().length, 2)
assert.equal(submitted[0].item, ui.item, 'idle selected actor retains original neutral indicator')
const baseline = submitted[0].matrix
// Owner 2026-09-25: every visible enemy unit keeps a red ring, idle too, at the full footprint (tanks too).
const idleEnemy = submitted.find(d => d.item === ui.hostileRingItem)
assert.equal(idleEnemy?.count, 1, 'the idle enemy tank carries a red ring')
assert.ok(Math.abs(idleEnemy.matrix[0] - baseline[0]) < 1e-6, 'the enemy ring traces the whole footprint, visible around a hull')
// Real ABI: fire is actor u32 followed by remaining 20 bytes; offset excludes event header.
view.setUint32(8, 101, true)
ui.onWeaponFire({ offset: 8, byteLength: 24 })
view.setUint32(32, 102, true)
ui.onWeaponFire({ offset: 32, byteLength: 24 })
ui.markCombat(103) // teammate
ui.markCombat(104) // neutral actor must not acquire hostile marking
ui.markCombat(999) // not in authoritative visible set: never draw
frame()
assert.equal(submitted.reduce((sum, d) => sum + d.count, 0), 3, 'one ring per local/enemy/teammate, no duplicate selection or invisible/neutral rings')
assert.equal(submitted.find(d => d.item === ui.friendlyRingItem).count, 2)
assert.equal(submitted.find(d => d.item === ui.hostileRingItem).count, 1)
assert.deepEqual(submitted[0].matrix.slice(12,16), baseline.slice(12,16), 'combat preserves original ground position')
for(const draw of submitted.filter(d => d.item === ui.friendlyRingItem))for(let i=0;i<draw.count;i++)assert.ok(Math.abs(draw.matrix[i*16]-baseline[0]*.4)<1e-6,'green combat circles are 60% smaller')
for(const draw of submitted.filter(d => d.item === ui.hostileRingItem))for(let i=0;i<draw.count;i++)assert.ok(Math.abs(draw.matrix[i*16]-baseline[0])<1e-6,'red enemy circles keep the full footprint')
for (const draw of submitted) {
 assert.equal(draw.item.mesh, mesh, 'combat uses the existing selection mesh')
 assert.equal(draw.item.playerColors, null, 'identification does not use/modify player colours')
 for (let i=0; i<draw.count; i++) assert.ok(Math.abs(draw.matrix[i*16+13]-2.03)<1e-6, 'ring remains on ground')
}
// An expired selected actor returns to neutral; expired non-selected friendly marks disappear;
// the enemy keeps its red ring.
for (const id of ui.combatMarks.keys()) ui.combatMarks.set(id, performance.now()-1)
assert.equal(frame().length, 2)
assert.equal(submitted[0].item, ui.item)
assert.equal(submitted.find(d => d.item === ui.hostileRingItem)?.count, 1, 'expiry never drops the enemy ring')
// Enemy buildings, wrecks and disguised spies stay unmarked (a ring would unmask the spy).
for (const [field, value, why] of [['typeId', 9, 'enemy building'], ['flags', 8, 'enemy wreck'], ['displayTypeId', 6, 'disguised enemy spy']]) {
 const before = actors[field][1]
 actors[field][1] = value
 assert.equal(frame().find(d => d.item === ui.hostileRingItem), undefined, `${why} has no red ring`)
 actors[field][1] = before
}
// Damage uses health deltas, never interprets impact coordinates as actor IDs.
ui.combatMarks.clear()
const prev = { actors: { ...actors, health: Uint8Array.of(255,255,255,255) } }
actors.health[1] = 180
ui.onSnapshot(snapshot, prev, ui.ctx)
assert.deepEqual([...ui.combatMarks.keys()], [102])
ui.markCombat(999)
ui.onSnapshot(snapshot, snapshot, ui.ctx)
assert.equal(ui.combatMarks.has(999), false, 'left/dead/fogged actors are forgotten')
ui.combatMarks.clear()
ui.onWeaponFire({offset:127,byteLength:24})
ui.onWeaponFire({offset:8,byteLength:4})
assert.equal(ui.combatMarks.size,0, 'malformed events cannot create marks')
assert.ok(!source.includes('combatRingGroup') && !source.includes('this.combatRings'), 'screen-space combat disks removed')
console.log('combatgroundgate: PASS — shared ground mesh/footprint, friend/ally/enemy/neutral, no duplicate or fogged rings, expiry, real fire ABI, health-delta damage')
