#!/usr/bin/env node

import { bootRuntime, configFor, renderPlayerIndex, waitForSnapshot } from './runtime-fixture.mjs'
import { fail } from './gate-lib.mjs'

const TOOL = 'deploymentprovenancegate'
const runtime = await bootRuntime()
const catalog = runtime.bridge.getSkirmishCatalog()
const map = catalog.maps.find(candidate => candidate.title === 'Doubles') ?? catalog.maps[0]
const config = configFor(catalog, map, { randomSeed: 104729, withBot: false })
const started = runtime.bridge.startSkirmish(config)
if (started.status !== 'loading') fail(TOOL, `start returned ${started.status}/${started.code}`)

const initial = await waitForSnapshot(runtime, { minimumTick: 5 })
const before = parseActors(initial.header)
const typeNames = runtime.bridge.snapshotTypeTable().split('\n')
const local = renderPlayerIndex(initial.header)
const mcv = findOwnedType(before, typeNames, local, 'mcv')
if (mcv < 0) fail(TOOL, 'local OpenRA player has no visible MCV')
if ((before.flags[mcv] & 16) === 0) fail(TOOL, 'MCV does not publish the authoritative deployable actor flag')

const result = runtime.bridge.issueOrder({
	orderString: 'DeployTransform',
	subjectIds: Uint32Array.of(before.id[mcv]),
	targetActorId: 0,
	targetCellX: -1,
	targetCellY: -1,
	queued: false,
	targetString: '',
	extraData: 0,
})
if (!String(result).startsWith('ok: issued 1/1')) fail(TOOL, `bridge rejected local deploy order: ${result}`)

const records=[]
// Completion of the 96-frame make sequence lands around tick +17+96; the old
	// +90 window (32-frame era) closed before the completion record could publish.
	const afterResult = await waitForSnapshot(runtime, { minimumTick: initial.header.tick + 150, onSnapshot(header){
 const section=header.sections.get(12)
 if(!section) fail(TOOL,'producer omitted deployment extension')
 const v=header.view,count=v.getUint32(section.offset,true)
 if(section.byteLength!==4+count*32) fail(TOOL,'invalid deployment layout')
 for(let i=0;i<count;i++){
  const o=section.offset+4+i*32
  const id=v.getUint32(o,true),actors=parseActors(header),index=actors.id.indexOf(id)
  records.push({tick:header.tick,id,source:v.getUint32(o+4,true),x:v.getInt32(o+8,true),y:v.getInt32(o+12,true),z:v.getInt32(o+16,true),facing:v.getUint16(o+20,true),frame:v.getUint16(o+22,true),frames:v.getUint16(o+24,true),ms:v.getUint16(o+26,true),created:v.getInt32(o+28,true),targetPosition:index<0?null:actors.positions.map(a=>a[index])})
 }
}})
if(!records.length)fail(TOOL,'actual transform produced no provenance')
const own=records.filter(r=>r.source===before.id[mcv])
if(!own.length||own.some(r=>r.id===r.source))fail(TOOL,'new ID not explicitly linked to disposed MCV')
const playing=own.filter(r=>r.frames>0)
// The fact 'make' sequence is 96 frames (assetless sequence timing; ruleparity
	// expectedSequences pins fact=96 with Tick 40), matching the authored deployment
	// animation. The old 32-frame pin predated that lengthening.
	if(playing.length<3||playing.some(r=>r.frames!==96||r.ms!==40||r.frame>=r.frames||r.facing!==384))fail(TOOL,'incorrect authoritative make sequence/facing: '+JSON.stringify(playing.slice(0,4)))
if(!own.some(r=>r.frames===0&&r.ms===0))fail(TOOL,'completion did not publish')
for(let i=1;i<playing.length;i++)if(playing[i].frame<playing[i-1].frame)fail(TOOL,'forward make regressed')
const {writeFileSync,mkdirSync}=await import('node:fs'),{resolve}=await import('node:path')
const out=resolve(import.meta.dirname,'../../../.artifacts/planx/deployment-runtime');mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'provenance.json'),JSON.stringify(own,null,2))
const after = parseActors(afterResult.header)
const afterNames = runtime.bridge.snapshotTypeTable().split('\n')
if (findOwnedType(after, afterNames, local, 'mcv') >= 0) fail(TOOL, 'MCV remained after DeployTransform')
if (findOwnedType(after, afterNames, local, 'fact') < 0) fail(TOOL, 'DeployTransform did not create the construction yard')

const production = afterResult.header.sections.get(9)
if (!production || afterResult.header.view.getUint32(production.offset, true) === 0)
	fail(TOOL, 'construction yard did not expose OpenRA production queues')

console.log(`${TOOL}: PASS — actual new actor ID and value provenance,32x40ms make frames, completion and production queues`)
process.exit(0)

function parseActors(header) {
	const section = header.sections.get(3)
	if (!section) fail(TOOL, 'actors section absent')
	const count = header.view.getUint32(section.offset, true)
	let cursor = section.offset + 8
	const id = new Uint32Array(count)
	for (let index = 0; index < count; index++, cursor += 4) id[index] = header.view.getUint32(cursor, true)
	const positions=[]
	for(let axis=0;axis<3;axis++){
		const values=new Int32Array(count)
		for(let i=0;i<count;i++,cursor+=4)values[i]=header.view.getInt32(cursor,true)
		positions.push(values)
	}
	const type = new Uint16Array(count)
	for (let index = 0; index < count; index++, cursor += 2) type[index] = header.view.getUint16(cursor, true)
	cursor += count * 10
	cursor = (cursor + 3) & ~3
	const owner = new Uint8Array(count)
	for (let index = 0; index < count; index++) owner[index] = header.view.getUint8(cursor + index)
	const flagsOffset = cursor + count * 4
	const flags = new Uint8Array(count)
	for (let index = 0; index < count; index++) flags[index] = header.view.getUint8(flagsOffset + index)
	return { count, id, type, owner, flags, positions }
}

function findOwnedType(actors, names, owner, wanted) {
	for (let index = 0; index < actors.count; index++)
		if (actors.owner[index] === owner && names[actors.type[index]] === wanted) return index
	return -1
}
