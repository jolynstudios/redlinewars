#!/usr/bin/env node
// Exercise the actual camera update through complete keyboard and mouse orbits.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const web = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'steelseed-orbit-'))
const failures = []
let cases = 0, worstDrift = 0
try {
	const outfile = join(temp, 'camera.mjs')
	await build({ stdin: { contents: "export { CameraSystem } from './src/camera/index.ts'", resolveDir: web, loader: 'ts' },
		bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	const { CameraSystem } = await import(pathToFileURL(outfile).href)
	for (const [width, height] of [[640, 480], [1920, 1080]]) {
		for (const [x, z] of [[32, 32], [6, 6], [58, 6], [6, 58], [58, 58]]) {
			for (const mode of ['KeyQ', 'KeyE', 'middle']) for (const edge of [false, true]) {
				const { camera, ctx, keys, pointer } = await fixture(width, height, x, z)
				const anchor = Array.from(camera.listenerFocus), beforeYaw = camera.yaw
				pointer.x = edge ? 0 : width / 2; pointer.y = edge ? 0 : height / 2
				pointer.inside = true; pointer.edgeReady = edge
				if (mode === 'middle') { pointer.buttons = 2; pointer.dx = 4 }
				else keys.add(mode)
				let drift = 0
				for (let frame = 0; frame < 260; frame++) {
					camera.update(1 / 60, ctx)
					drift = Math.max(drift, Math.hypot(camera.listenerFocus[0]-anchor[0], camera.listenerFocus[2]-anchor[2]))
				}
				const signedAngle = (camera.yaw-beforeYaw) * (mode === 'KeyQ' ? -1 : 1)
				keys.clear(); pointer.buttons = 0; pointer.dx = 0
				// A stale cursor must not resume edge scrolling as the yaw settles.
				for (let frame = 0; frame < 120; frame++) {
					camera.update(1 / 60, ctx)
					drift = Math.max(drift, Math.hypot(camera.listenerFocus[0]-anchor[0], camera.listenerFocus[2]-anchor[2]))
				}
				worstDrift = Math.max(worstDrift, drift); cases++
				if (signedAngle < Math.PI * 2 || drift > 1e-4)
					failures.push(`${width}x${height} focus ${x},${z} ${mode} edge=${edge}: angle=${signedAngle.toFixed(3)}, drift=${drift.toFixed(4)}m`)
				// The focus remains the optical center of the view, independently of yaw.
				const view = camera.view
				const viewX = view[0]*anchor[0]+view[4]*anchor[1]+view[8]*anchor[2]+view[12]
				const viewY = view[1]*anchor[0]+view[5]*anchor[1]+view[9]*anchor[2]+view[13]
				if (Math.hypot(viewX, viewY) > 1e-4 && drift <= 1e-4) failures.push('orbit anchor is not centered in the view')
			}
		}
	}
	// Rotation takes over a pan in flight instead of orbiting a drifting target.
	{
		const { camera, ctx, keys } = await fixture(640, 480, 32, 32)
		keys.add('KeyD'); camera.update(1/60, ctx); keys.clear()
		const anchor = Array.from(camera.listenerFocus)
		keys.add('KeyE'); camera.update(1/60, ctx)
		if (Math.hypot(camera.listenerFocus[0]-anchor[0], camera.listenerFocus[2]-anchor[2]) > 1e-4)
			failures.push('pending pan drifts during rotation')
	}
	// Deliberate panning still works after turning, and the focus stays on the map.
	{
		const { camera, ctx, keys, pointer } = await fixture(640, 480, 32, 32)
		keys.add('KeyE'); for (let i=0;i<20;i++) camera.update(1/60,ctx); keys.clear()
		for (let i=0;i<120;i++) camera.update(1/60,ctx)
		let anchor = Array.from(camera.listenerFocus)
		keys.add('KeyD'); for (let i=0;i<12;i++) camera.update(1/60,ctx); keys.clear()
		assert.ok(Math.hypot(camera.listenerFocus[0]-anchor[0],camera.listenerFocus[2]-anchor[2])>.05, 'keyboard pan still responds')
		for (let i=0;i<120;i++) camera.update(1/60,ctx)
		anchor = Array.from(camera.listenerFocus)
		pointer.x=639; pointer.inside=true; pointer.edgeReady=true
		for (let i=0;i<12;i++) camera.update(1/60,ctx)
		assert.ok(Math.hypot(camera.listenerFocus[0]-anchor[0],camera.listenerFocus[2]-anchor[2])>.05, 'fresh pointer movement rearms edge scroll')
		keys.add('KeyD'); for (let i=0;i<600;i++) camera.update(1/60,ctx)
		assert.ok(camera.listenerFocus[0]>=0 && camera.listenerFocus[0]<=64 && camera.listenerFocus[2]>=0 && camera.listenerFocus[2]<=64, 'pan stays bounded')
	}
	// Regression: high zoom and yaw must not collapse pan bounds to the pivot.
	for (const yaw of [0,Math.PI/4,Math.PI/2,Math.PI,Math.PI*1.5]) {
		for (const key of ['KeyW','KeyA','KeyS','KeyD']) {
			const {camera,ctx,keys}=await fixture(1920,1080,3,3)
			camera.yaw=camera.yawGoal=yaw;camera.height=camera.heightGoal=65
			const anchor=Array.from(camera.listenerFocus)
			keys.add(key);camera.update(1/60,ctx)
			assert.ok(Math.hypot(camera.listenerFocus[0]-anchor[0],camera.listenerFocus[2]-anchor[2])>.01,`pan locked near corner yaw=${yaw} key=${key}`)
		}
	}
	{
		const {camera,ctx,keys,pointer}=await fixture(1920,1080,0,0)
		camera.height=camera.heightGoal=65
		const zoom=camera.heightGoal,initialPitch=camera.pitchForHeight(65)
		pointer.buttons=2;pointer.dy=3
		for(let i=0;i<30;i++)camera.update(1/60,ctx)
		assert.ok(camera.pitchForHeight(65)>initialPitch+.1,'vertical middle drag tilts camera')
		pointer.dy=0;pointer.dx=5
		for(let i=0;i<200;i++)camera.update(1/60,ctx)
		assert.equal(camera.heightGoal,zoom,'orbit must not force zoom near a corner')
		assert.equal(camera.listenerFocus[0],0);assert.equal(camera.listenerFocus[2],0)
		pointer.buttons=0;pointer.dx=0;keys.add('PageDown')
		const pitch=camera.pitchForHeight(65)
		for(let i=0;i<30;i++)camera.update(1/60,ctx)
		assert.ok(camera.pitchForHeight(65)<pitch,'PageDown tilts back')
		keys.clear();camera.focusWorld(64,64)
		assert.equal(camera.heightGoal,zoom,'minimap jump preserves zoom')
	}
	assert.equal(failures.length, 0, failures.slice(0,12).join('\n'))
	// ---- H returns home, T pairs zoom-out with tilt and returns what it took --------------
	// Both are single keypresses that move several pieces of camera state at once, so a
	// regression here is silent: the key still exists, it just stops doing part of its job.
	{
		const { camera, ctx, pressed } = await fixture(20, 20)
		const home = [camera.listenerFocus[0], camera.listenerFocus[2]]
		// Move away using the camera's own API. Keyboard panning cannot be used here: on this
		// 64x64 fixture map the focus is clamped to the frustum at the default height, so a
		// pan is a no-op and the test would pass without ever leaving home.
		camera.zoomByNotches(6)
		for (let i = 0; i < 120; i++) camera.update(1 / 60, ctx)
		camera.focusWorld(52, 52)
		for (let i = 0; i < 240; i++) camera.update(1 / 60, ctx)
		const away = Math.hypot(camera.listenerFocus[0] - home[0], camera.listenerFocus[2] - home[1])
		assert.ok(away > 4, `the fixture must actually leave home before H is tested, moved ${away.toFixed(2)}m`)
		pressed.add('KeyH')
		for (let i = 0; i < 240; i++) camera.update(1 / 60, ctx)
		const back = Math.hypot(camera.listenerFocus[0] - home[0], camera.listenerFocus[2] - home[1])
		assert.ok(back < 0.5, `H must return to the opening focus; ${back.toFixed(3)}m away after settling (was ${away.toFixed(2)}m)`)

		// T out: higher AND more top-down, both from the one press.
		const beforeEye = camera.listenerEye[1]
		const beforePitch = camera.listenerEye[1] - camera.listenerFocus[1]
		pressed.add('KeyT')
		for (let i = 0; i < 240; i++) camera.update(1 / 60, ctx)
		const outEye = camera.listenerEye[1]
		assert.ok(outEye > beforeEye + 1, `T must zoom out: eye ${beforeEye.toFixed(2)} -> ${outEye.toFixed(2)}m`)
		const outPitch = camera.listenerEye[1] - camera.listenerFocus[1]
		assert.ok(outPitch > beforePitch, `T must tilt toward top-down: rise ${beforePitch.toFixed(2)} -> ${outPitch.toFixed(2)}m`)

		// T again: back to what it took, not to a constant.
		pressed.add('KeyT')
		for (let i = 0; i < 240; i++) camera.update(1 / 60, ctx)
		const returned = camera.listenerEye[1]
		assert.ok(Math.abs(returned - beforeEye) < 0.5,
			`T must restore the height it took, not a constant; ${beforeEye.toFixed(2)} -> ${outEye.toFixed(2)} -> ${returned.toFixed(2)}m`)
	}

	console.log(`cameraorbitgate: PASS — ${cases} complete Q/E/middle-drag orbits at center/corners; worst focus drift ${worstDrift.toFixed(6)}m; release, pan handoff and edge rearming pass`)

	async function fixture(width,height,x,z) {
		const camera=new CameraSystem(), keys=new Set(), pressed=new Set()
		const pointer={ x:width/2,y:height/2,dx:0,dy:0,wheel:0,buttons:0,pressed:0,inside:false,edgeReady:false }
		const ctx={ canvas:{width,height,clientWidth:width,clientHeight:height},input:{pointer,isDown:key=>keys.has(key),wasPressed:key=>{const hit=pressed.has(key);pressed.delete(key);return hit},wasReleased:()=>false},issueOrder:()=>{},peek:()=>null }
		await camera.init(ctx)
		camera.onSnapshot({ world:{renderPlayer:0,boundsLeft:0,boundsTop:0,boundsRight:64,boundsBottom:64},
			actors:{count:1,owner:new Uint8Array([0]),posX:new Int32Array([x*1024]),posY:new Int32Array([z*1024])} },null,ctx)
		for (let i=0;i<30;i++) camera.update(1/60,ctx)
		return {camera,ctx,keys,pressed,pointer}
	}
} finally { rmSync(temp,{recursive:true,force:true}) }
