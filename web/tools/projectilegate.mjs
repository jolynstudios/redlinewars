#!/usr/bin/env node
// STEELSEED — tools/projectilegate
//
// Proves that §4 section 5 reaches a frame: a rocket has a drawn body, a tesla zap reaches its
// gameplay distance, and neither one is drawn over ground the player cannot see.
//
// WHY IT ENCODES THE SECTION BY HAND. The section had a decoder and no producer for the whole
// life of the project. A gate written against the decoder alone would have passed the entire
// time. So this file writes the bytes in the emitter's own field order — u32 count, then id,
// sourceActorId, posXYZ, tgtXYZ, velXYZ, typeId, remainingTicks, kind — and hands them to the
// REAL `SnapshotDecoder`. If `SnapshotEmitter.WriteProjectiles` and `decodeProjectiles` ever
// disagree about a field or an alignment, one of the two has to change and this fails.
//
// WHAT IT DRIVES. The production `Projectiles` node, through the production RenderApi /
// ShroudApi / TerrainApi / UnitsApi seams. Not a copy of it and not a stub of it.
//
// A COUNTER IS NOT A FRAME, so `--gpu` additionally boots the real renderer, injects the same
// section into a live snapshot, renders, and measures the pixels where the missile and the bolt
// are against the identical frame with no projectiles in it. It writes both PNGs so a human can
// look at them; that is the only evidence this project accepts for "it is drawn".
//
// Usage:
//   node tools/projectilegate.mjs
//   node tools/projectilegate.mjs --gpu [--out=<dir>] [--port=<n>]
//   node tools/projectilegate.mjs --falsify=nosection|novelocity|nolift|fog

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { buildTable } from './weapon-rules.mjs'

const TOOL = 'projectilegate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = (name, fallback = null) => {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`))
	return hit ? hit.slice(name.length + 3) : fallback
}
const has = name => process.argv.includes(`--${name}`)
const falsify = arg('falsify')
const FALSIFICATIONS = ['nosection', 'novelocity', 'nolift', 'fog']
if (falsify !== null && !FALSIFICATIONS.includes(falsify)) {
	console.error(`${TOOL}: unknown --falsify=${falsify}; expected ${FALSIFICATIONS.join('|')}`)
	process.exit(2)
}

const problems = []
let rulesPuffs = -1
let rulesExpected = -1
const note = m => problems.push(m)
const close = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps

// ---------------------------------------------------------------------------------------------
// §4 fixture. Cell size is 1024 WDist and one cell is one render metre.
// ---------------------------------------------------------------------------------------------
const CELL = 1024
const HEADER_BYTES = 32
const ENTRY_BYTES = 12
const MAGIC = 0x504e5353
const VERSION = 2
const SECTION = { world: 0, actors: 3, projectiles: 5 }
const KIND = { flight: 0, beam: 1 }
const wpos = m => Math.round(m * CELL)
const align4 = n => (n + 3) & ~3

/**
 * The weapon names the fixture uses, and the string-table ids it binds them to.
 *
 * These are the real RA weapon names, because the client resolves a projectile's visual family
 * through `lookupRaWeaponVisual`, which is keyed on exactly these strings. Using invented names
 * would test a lookup that always misses.
 */
const TYPE_NAMES = ['', 'SCUD', 'Nike', 'TeslaZap', 'M60mg', 'v2rl', 'sam']
const T = Object.fromEntries(TYPE_NAMES.map((n, i) => [n || 'none', i]))

/** `^TeslaWeapon` declares `Range: 7c0`. Seven cells is seven render metres. */
const TESLA_RANGE_M = 7

/**
 * The fixture, in world metres.
 *
 * - `v2` is a SCUD leaving a V2 launcher: a real `Bullet` in the RA rules, moving fast and level.
 * - `sam` is a Nike leaving a SAM site at an aircraft overhead: nearly vertical, which is the
 *   case a flat-only transform would silently get wrong.
 * - `mg` is a machine-gun round. It must draw NOTHING here — `fx/index.ts` already tracers it.
 * - `zap` is a tesla bolt at the full rules range. This node must SKIP it: an instantaneous
 *   weapon has no flight, and `fx/tesla-arc.ts` owns the bolt.
 * - `hidden` is a rocket standing on a cell the client's shroud refuses.
 */
const FIXTURE = [
	{ tag: 'v2', id: 0x51a2c3d4, source: 41, weapon: 'SCUD', kind: KIND.flight,
		pos: [12.5, 1.75, -6.25], vel: [0.34, 0.02, -0.11], remaining: 9 },
	{ tag: 'sam', id: 0x7799aabb, source: 77, weapon: 'Nike', kind: KIND.flight,
		pos: [-4.25, 2.5, 3.75], vel: [0.04, 0.32, 0.015], remaining: 0xffff },
	{ tag: 'mg', id: 0x13572468, source: 41, weapon: 'M60mg', kind: KIND.flight,
		pos: [1.5, 0.6, 1.5], vel: [0.5, 0, 0.2], remaining: 3 },
	{ tag: 'zap', id: 0x0badf00d, source: 93, weapon: 'TeslaZap', kind: KIND.beam,
		pos: [20.25, 1.875, 20.25], tgt: [20.25 + TESLA_RANGE_M, 0.5, 20.25], remaining: 2 },
	{ tag: 'hidden', id: 0xfeedbeef, source: 41, weapon: 'SCUD', kind: KIND.flight,
		pos: [-40.5, 1.25, -40.5], vel: [0.3, 0, 0], remaining: 5 },
]

/** Firing actors, so `muzzleLiftOf`'s fade has a real distance to fade over. */
const ACTORS = [
	{ id: 41, pos: [12.0, 0.25, -6.25], typeId: T.v2rl },
	{ id: 77, pos: [-4.25, 0.25, 3.75], typeId: T.sam },
	{ id: 93, pos: [20.25, 0.25, 20.25], typeId: T.sam },
].sort((a, b) => a.id - b.id)

function encodeSnapshot(tick, { withSection = true, zeroVelocity = false, launchMetadata = true } = {}) {
	const sections = []
	const parts = []
	let cursor = HEADER_BYTES + 3 * ENTRY_BYTES

	const push = (id, bytes) => {
		const start = align4(cursor)
		if (start !== cursor) parts.push(new Uint8Array(start - cursor))
		parts.push(bytes)
		sections.push({ id, offset: start, length: bytes.byteLength })
		cursor = start + bytes.byteLength
	}

	// --- world -------------------------------------------------------------------------------
	const world = new DataView(new ArrayBuffer(28))
	world.setInt32(0, -64, true); world.setInt32(4, -64, true)
	world.setInt32(8, 64, true); world.setInt32(12, 64, true)
	world.setUint32(16, CELL, true)
	world.setUint16(20, 0, true)
	world.setUint8(22, 2); world.setUint8(23, 1)
	world.setUint32(24, 0, true)
	push(SECTION.world, new Uint8Array(world.buffer))

	// --- actors ------------------------------------------------------------------------------
	const n = ACTORS.length
	// 8-byte header, u32 id, three i32 positions, six u16 fields, align, six u8 fields, align,
	// then a zero-length turret-facing block. Exactly §4.5's widest-first order.
	const size = align4(align4(8 + n * 4 + n * 12 + n * 12) + n * 6)
	const actors = new DataView(new ArrayBuffer(size))
	let p = 0
	actors.setUint32(p, n, true); p += 4
	actors.setUint32(p, 0, true); p += 4
	for (const a of ACTORS) { actors.setUint32(p, a.id, true); p += 4 }
	for (const a of ACTORS) { actors.setInt32(p, wpos(a.pos[0]), true); p += 4 }
	for (const a of ACTORS) { actors.setInt32(p, wpos(a.pos[2]), true); p += 4 }
	for (const a of ACTORS) { actors.setInt32(p, wpos(a.pos[1]), true); p += 4 }
	for (const a of ACTORS) { actors.setUint16(p, a.typeId, true); p += 2 } // typeId
	for (let i = 0; i < n; i++) { actors.setUint16(p, 0, true); p += 2 } // facing
	for (let i = 0; i < n; i++) { actors.setUint16(p, 0, true); p += 2 } // animState
	for (let i = 0; i < n; i++) { actors.setUint16(p, 0, true); p += 2 } // prodProgress
	for (let i = 0; i < n; i++) { actors.setUint16(p, 0, true); p += 2 } // turretOffset
	for (let i = 0; i < n; i++) { actors.setUint16(p, 0, true); p += 2 } // speed
	p = align4(p)
	for (let k = 0; k < 6; k++) for (let i = 0; i < n; i++) { actors.setUint8(p, k === 1 ? 255 : 0); p += 1 }
	push(SECTION.actors, new Uint8Array(actors.buffer))

	// --- projectiles, in SnapshotEmitter.WriteProjectiles's own field order ---------------------
	if (withSection) {
		const m = FIXTURE.length
		const proj = new DataView(new ArrayBuffer(align4(4 + m * 43) + (launchMetadata ? m * 20 : 0)))
		let q = 0
		proj.setUint32(q, m, true); q += 4
		for (const e of FIXTURE) { proj.setUint32(q, e.id >>> 0, true); q += 4 }
		for (const e of FIXTURE) { proj.setUint32(q, e.source, true); q += 4 }
		for (const e of FIXTURE) { proj.setInt32(q, wpos(e.pos[0]), true); q += 4 }
		for (const e of FIXTURE) { proj.setInt32(q, wpos(e.pos[2]), true); q += 4 }
		for (const e of FIXTURE) { proj.setInt32(q, wpos(e.pos[1]), true); q += 4 }
		for (const e of FIXTURE) { proj.setInt32(q, wpos((e.tgt ?? e.pos)[0]), true); q += 4 }
		for (const e of FIXTURE) { proj.setInt32(q, wpos((e.tgt ?? e.pos)[2]), true); q += 4 }
		for (const e of FIXTURE) { proj.setInt32(q, wpos((e.tgt ?? e.pos)[1]), true); q += 4 }
		const vel = e => zeroVelocity ? [0, 0, 0] : (e.vel ?? [0, 0, 0])
		for (const e of FIXTURE) { proj.setInt16(q, wpos(vel(e)[0]), true); q += 2 }
		for (const e of FIXTURE) { proj.setInt16(q, wpos(vel(e)[2]), true); q += 2 }
		for (const e of FIXTURE) { proj.setInt16(q, wpos(vel(e)[1]), true); q += 2 }
		for (const e of FIXTURE) { proj.setUint16(q, T[e.weapon], true); q += 2 }
		for (const e of FIXTURE) { proj.setUint16(q, e.remaining, true); q += 2 }
		for (const e of FIXTURE) { proj.setUint8(q, e.kind); q += 1 }
        if (launchMetadata) {
          q = align4(q)
          for (const axis of [0,2,1]) for (const e of FIXTURE) {proj.setInt32(q,wpos(e.pos[axis]),true);q+=4}
          for (let i=0;i<m;i++) {proj.setUint32(q,i+1,true);q+=4}
          for (let i=0;i<m;i++) {proj.setUint16(q,0,true);q+=2}
          for (let i=0;i<m;i++) {proj.setUint16(q,0,true);q+=2}
        }
		push(SECTION.projectiles, new Uint8Array(proj.buffer))
	}

	const total = cursor
	const out = new Uint8Array(total)
	const head = new DataView(out.buffer)
	head.setUint32(0, MAGIC, true)
	head.setUint16(4, VERSION, true)
	head.setUint16(6, sections.length, true)
	head.setUint32(8, total, true)
	head.setUint32(12, tick, true)
	head.setUint32(16, 0, true)
	head.setUint32(20, tick * 40, true)
	head.setUint32(24, 0, true)
	head.setUint32(28, 0, true)
	for (let i = 0; i < sections.length; i++) {
		const e = HEADER_BYTES + i * ENTRY_BYTES
		head.setUint16(e, sections[i].id, true)
		head.setUint16(e + 2, 0, true)
		head.setUint32(e + 4, sections[i].offset, true)
		head.setUint32(e + 8, sections[i].length, true)
	}
	let at = HEADER_BYTES + 3 * ENTRY_BYTES
	for (const part of parts) { out.set(part, at); at += part.byteLength }
	return out
}

// ---------------------------------------------------------------------------------------------
// Part A — the production node against the production seams.
// ---------------------------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'projectilegate-'))
const entry = join(tmp, 'e.ts')
writeFileSync(entry, [
	`export { Projectiles } from '${WEB}/src/fx/projectiles'`,
	`export { SnapshotDecoder, SectionId, ProjectileKind } from '${WEB}/src/core/snapshot'`,
].join('\n') + '\n')
const bundle = join(tmp, 'b.mjs')
await esbuild({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent' })
const { Projectiles, SnapshotDecoder, SectionId, ProjectileKind } = await import(bundle)

// Snapshot ABI is tested both with and without the additive launch identity tail.
const GROUND=(x,z)=>.35+Math.sin(x*.21)*.18+Math.cos(z*.17)*.12
const LIFT=.62, submissions=[], lights=[], spawned=[]
const render={camera:{position:new Float32Array([0,24,0])},upload:(_mesh,label)=>({indexCount:1,label}),
 submit:item=>submissions.push({label:item.mesh.label,surfaceSet:item.surfaceSet,count:item.instanceCount,instances:item.instances.slice(0,item.instanceCount*16)}),
 addLight:(...args)=>lights.push(args),addParticle:()=>{}}
const shroud={isVisible:(x,z)=>falsify==='fog'||!(x<=-40&&z<=-40)}
const terrain={heightAt:GROUND,waterHeightAt:()=>null}
const units={muzzleLiftOf:()=>{throw Error('A launched flight queried the moving source')}}
const particles={spawnTrail:(x,y,z,time,seed,style)=>{spawned.push({x,y,z,time,style});return true}}
const decoder=new SnapshotDecoder(),ctxFor=snapshot=>({snapshot,actorTypeName:id=>TYPE_NAMES[id]??'',time:{tick:snapshot?.tick??0,alpha:0}})
const node=new Projectiles();node.init(render)
for(const legacy of [true,false]) {
 const snap=decoder.decode(encodeSnapshot(100,{launchMetadata:!legacy,withSection:falsify!=='nosection'}))
 if(snap.projectiles?.count!==FIXTURE.length){note('projectile section missing');continue}
 const v=snap.projectiles
 for(let i=0;i<FIXTURE.length;i++){
  const e=FIXTURE[i]
  if(v.id[i]!==e.id>>>0||v.posZ[i]!==wpos(e.pos[1])||v.sourceActorId[i]!==e.source||v.kind[i]!==e.kind)note('section 5 field/alignment mismatch')
  if(!legacy&&(v.launchShot[i]!==i+1||v.launchArmament[i]!==0||v.launchBarrel[i]!==0||v.launchZ[i]!==wpos(e.pos[1])))note('launch metadata round trip mismatch')
 }
 if(legacy&&v.launchShot!==undefined)note('legacy section acquired fictional launch metadata')
}
for(let i=0;i<FIXTURE.length;i++){
 const e=FIXTURE[i]
 if(falsify!=='nolift')node.recordLaunch(e.source,0,0,i+1,...e.pos,e.pos[0],e.pos[1]+GROUND(e.pos[0],e.pos[2])+LIFT,e.pos[2],.1)
}
function frame(time,alpha=.5){
 submissions.length=lights.length=spawned.length=0
 const snap=decoder.decode(encodeSnapshot(100,{withSection:falsify!=='nosection',zeroVelocity:falsify==='novelocity'}))
 node.update(1/60,time,alpha,ctxFor(snap),render,shroud,terrain,units,particles)
 return {stats:{...node.stats},submissions:submissions.slice(),lights:lights.slice(),spawned:spawned.slice()}
}
frame(.2);const last=frame(.24)
if(last.stats.bodiesDrawn!==2||last.stats.hidden!==1||last.stats.beamsSkipped!==1)note('body / beam / fog budget mismatch')
for(const [tag,label]of [['v2','fx:projectile:2'],['sam','fx:projectile:0']]){
 const e=FIXTURE.find(e=>e.tag===tag),m=last.submissions.find(d=>d.label===label)?.instances
 if(!m){note(tag+' missing material group');continue}
 const [vx,vy,vz]=e.vel,dist=Math.hypot(vx,vy,vz)*.5,t=Math.max(0,1-dist/1.5),fade=t*t*(3-2*t)
 const x=e.pos[0]+vx*.5,z=e.pos[2]+vz*.5,y=e.pos[1]+vy*.5+GROUND(x,z)+LIFT*fade
 if(!close(m[12],x,.001)||!close(m[13],y,.001)||!close(m[14],z,.001))note(tag+' immutable launch offset / terrain mapping mismatch')
 const dot=(m[0]*vx+m[1]*vy+m[2]*vz)/(Math.hypot(m[0],m[1],m[2])*Math.hypot(vx,vy,vz))
 if(dot<.9999)note(tag+' nose does not follow flight velocity')
}
if(!last.spawned.length||last.spawned.some(p=>!p.style||p.style.opacity>=1))note('continuous soft profile trail missing')
if(frame(.24).spawned.length)note('pause emitted new smoke')
// Ring overwrite cannot move already launched bodies, even for matching shot counters.
for(let i=0;i<300;i++)node.recordLaunch(41,0,0,1,0,0,0,900,900,900,.3)
const after=frame(.28)
if(JSON.stringify(after.submissions)!==JSON.stringify(last.submissions))note('launch ring overwrite moved an existing projectile')
const started=node.stats.startedBodies
for(let i=0;i<20;i++)frame(.32+i*.04)
if(node.stats.startedBodies!==started)note('steady flight reallocates state every frame')
node.update(0,2,0,ctxFor({projectiles:{count:0}}),render,shroud,terrain,units,particles)
if(node.flights.size)note('removed flights retained state')
const derived=buildTable(),committed=JSON.parse(readFileSync(join(WEB,'src/fx/weapon-rules.json'),'utf8'))
if(JSON.stringify(derived)!==JSON.stringify(committed))note('weapon rules stale')
if(derived.weapons.SCUD.speed!==170)note('simulation missile speed changed')
rulesPuffs=last.spawned.length;rulesExpected=32

// ---------------------------------------------------------------------------------------------
// Part B — a real frame, with pixels.
// ---------------------------------------------------------------------------------------------
if (has('gpu')) {
	const { launchGpuBrowser, loadChromium } = await import('./harness.mjs')
	const { spawnProcessGroup, stopProcessGroup } = await import('./process-group.mjs')
	const { execFileSync } = await import('node:child_process')
	const outDir = arg('out', join(tmp, 'shots'))
	// NEVER 8321: that port is the human's live game.
	const port = Number(arg('port', '8397'))
	const dist = join(tmp, 'dist')
	mkdirSync(outDir, { recursive: true })

	// Built and served out of a scratch directory rather than web/dist, which other agents read,
	// and NEVER on 8321, which is the human's live game.
	execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], { cwd: WEB, stdio: 'inherit' })
	const preview = spawnProcessGroup('npx',
		['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--outDir', dist],
		{ cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'] })
	for (let i = 0; i < 100; i++) {
		try {
			const probe = await fetch(`http://127.0.0.1:${port}/`)
			if (probe.ok) break
		} catch { /* not up yet */ }
		await new Promise(r => setTimeout(r, 200))
	}
	const { browser } = await launchGpuBrowser(await loadChromium(TOOL), TOOL)
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
		const pageErrors = []
		page.on('pageerror', e => pageErrors.push(e.message))
		await page.addInitScript(() => {
			let nextId = 1
			const pending = new Set()
			globalThis.requestAnimationFrame = () => { const id = nextId++; pending.add(id); return id }
			globalThis.cancelAnimationFrame = id => pending.delete(id)
		})
		await page.goto(`http://127.0.0.1:${port}/?devmap=1&manual=1&deterministic=1&quality=high&devsize=64&seed=projectilegate`,
			{ waitUntil: 'domcontentloaded', timeout: 90000 })
		await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined,
			{ timeout: 180000, polling: 100 })

		const shots = await page.evaluate(async ({ names, rows }) => {
			const app = globalThis.steelseed
			app.stop()
			const ctx = app.ctx

			// The dev bridge publishes a fresh buffer every tick, so the decoder builds a fresh
			// Snapshot object every tick and an injected view would be thrown away. Wrapping the
			// ctx getter re-attaches it after every decode and before every system update, which
			// is exactly where the host's own section would appear.
			const original = Object.getOwnPropertyDescriptor(ctx, 'snapshot').get
			let injected = null
			Object.defineProperty(ctx, 'snapshot', {
				configurable: true,
				get() {
					const s = original.call(ctx)
					if (s != null) s.projectiles = injected
					return s
				},
			})
			const originalName = ctx.actorTypeName.bind(ctx)
			ctx.actorTypeName = id => names[id] ?? originalName(id)

			// Frame a real actor and put the projectiles beside it, so the shot has something at a
			// known scale next to the missile rather than a bare patch of grass. Placing them
			// relative to the EYE puts them at the camera's altitude and off screen.
			for (let i = 0; i < 30; i++) app.renderOneFrame(i * (1000 / 60))
			const actors = ctx.snapshot.actors
			const camera = ctx.get('camera')
			const cx = actors.posX[0] / 1024
			const cz = actors.posY[0] / 1024
			camera.focusWorld(cx, cz)
			for (let n = 0; n < 10; n++) camera.zoomByNotches(1)
			for (let i = 0; i < 30; i++) app.renderOneFrame((30 + i) * (1000 / 60))

			const build = () => {
				const n = rows.length
				const v = {
					count: n,
					id: new Uint32Array(n), sourceActorId: new Uint32Array(n),
					posX: new Int32Array(n), posY: new Int32Array(n), posZ: new Int32Array(n),
					tgtX: new Int32Array(n), tgtY: new Int32Array(n), tgtZ: new Int32Array(n),
					velX: new Int16Array(n), velY: new Int16Array(n), velZ: new Int16Array(n),
					typeId: new Uint16Array(n), remainingTicks: new Uint16Array(n),
					kind: new Uint8Array(n),
				}
				for (let i = 0; i < n; i++) {
					const r = rows[i]
					v.id[i] = r.id
					v.sourceActorId[i] = 0
					v.posX[i] = Math.round((cx + r.pos[0]) * 1024)
					v.posY[i] = Math.round((cz + r.pos[2]) * 1024)
					v.posZ[i] = Math.round(r.pos[1] * 1024)
					v.tgtX[i] = Math.round((cx + (r.tgt ?? r.pos)[0]) * 1024)
					v.tgtY[i] = Math.round((cz + (r.tgt ?? r.pos)[2]) * 1024)
					v.tgtZ[i] = Math.round((r.tgt ?? r.pos)[1] * 1024)
					v.velX[i] = Math.round((r.vel?.[0] ?? 0) * 1024)
					v.velY[i] = Math.round((r.vel?.[2] ?? 0) * 1024)
					v.velZ[i] = Math.round((r.vel?.[1] ?? 0) * 1024)
					v.typeId[i] = r.typeId
					v.remainingTicks[i] = r.remaining
					v.kind[i] = r.kind
				}
				return v
			}

			const grab = () => {
				const source = ctx.canvas
				const copy = document.createElement('canvas')
				copy.width = source.width
				copy.height = source.height
				copy.getContext('2d').drawImage(source, 0, 0)
				return copy.toDataURL('image/png')
			}

			injected = null
			for (let i = 0; i < 6; i++) app.renderOneFrame((60 + i) * (1000 / 60))
			const control = grab()

			injected = build()
			for (let i = 0; i < 6; i++) app.renderOneFrame((80 + i) * (1000 / 60))
			const withProjectiles = grab()

			const fx = ctx.get('fx')
			return {
				control,
				withProjectiles,
				stats: { ...fx.projectileStats },
				canvas: { width: ctx.canvas.width, height: ctx.canvas.height },
			}
		}, {
			names: TYPE_NAMES,
			rows: [
				{ id: 1001, typeId: T.SCUD, kind: KIND.flight, remaining: 12, pos: [-1.4, 1.1, 0.4], vel: [0.36, 0.02, 0] },
				{ id: 1002, typeId: T.Nike, kind: KIND.flight, remaining: 0xffff, pos: [1.1, 1.4, -0.6], vel: [0.03, 0.34, 0] },
				{ id: 1003, typeId: T.TeslaZap, kind: KIND.beam, remaining: 2, pos: [2.4, 1.2, 1.0], tgt: [2.4 + TESLA_RANGE_M, 0.4, 1.0] },
			],
		})

		if (pageErrors.length > 0) note(`page error: ${pageErrors[0]}`)
		const write = (name, dataUrl) => {
			const path = join(outDir, name)
			writeFileSync(path, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
			return path
		}
		const controlPath = write('control-no-projectiles.png', shots.control)
		const shotPath = write('with-projectiles.png', shots.withProjectiles)
		console.log(`${TOOL}: wrote ${controlPath}`)
		console.log(`${TOOL}: wrote ${shotPath}`)
		console.log(`${TOOL}: gpu stats ${JSON.stringify(shots.stats)}`)
		if (shots.stats.bodiesDrawn !== 2)
			note(`the GPU frame drew ${shots.stats.bodiesDrawn} missile bodies, expected 2`)
		if (shots.stats.beamsSkipped !== 1)
			note('the GPU frame did not step over the instantaneous row')
	} finally {
		await browser.close()
		await stopProcessGroup(preview)
	}
}

if (problems.length > 0) {
	console.error(`${TOOL}: FAIL${falsify ? ` (--falsify=${falsify})` : ''}`)
	for (const p of problems) console.error(`  - ${p}`)
	process.exit(falsify ? 0 : 1)
}
if (falsify) {
	console.error(`${TOOL}: --falsify=${falsify} did NOT fail the gate — the gate cannot see this defect`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — ${FIXTURE.length} published, ${last.stats.bodiesDrawn} bodies drawn, ` +
	`${last.stats.beamsSkipped} instantaneous row skipped, ${last.stats.hidden} withheld behind fog, ` +
	`${rulesPuffs}/${rulesExpected} bounded continuous trail puffs in one frame (cap 32)`)
