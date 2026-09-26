// STEELSEED — a lost graphics device, in a real match (vfx.md Epic 8).
//
// The composed game in Chromium, a skirmish running. The WebGPU device is then destroyed from
// the page, which is how a driver reset or a removed GPU reaches the game. Every node built its
// pipelines, textures and bind groups on that device in init(), so the view cannot continue:
//   - the UI raises "Graphics device lost" with a Reload button, never silence;
//   - the simulation keeps advancing (the match is not the view);
//   - the renderer stops encoding against the dead device instead of adding a validation error
//     every frame.
//
// Usage (from web/, after `vite build` and compose): node tools/devicelostgate.mjs
import assert from 'node:assert/strict'
import { openLiveMatch } from './live-match.mjs'

const m = await openLiveMatch({ tool: 'devicelostgate', port: 8470, quality: 'ultra', mapTitle: 'Altercation' })
try {
	const consoleErrors = []
	m.page.on('console', msg => { if (msg.type() === 'error' || msg.type() === 'warning') consoleErrors.push(msg.text()) })
	await m.page.waitForTimeout(3000)
	const before = await m.gate(() => globalThis.steelseed.ctx.snapshot.tick)
	assert.equal(await m.gate(() => globalThis.steelseed.ctx.gpuLost), null, 'the device is not lost at start')
	await m.gate(() => globalThis.steelseed.ctx.get('render').device.destroy())
	const alarm = await m.waitFor(() => {
		const el = document.getElementById('sim-alarm')
		return el && !el.hidden && /Graphics device lost/.test(el.textContent ?? '') ? el.textContent : false
	}, undefined, 'the lost-device alarm', 10000)
	assert.match(alarm, /Reload/, 'the alarm offers a reload')
	const lost = await m.gate(() => globalThis.steelseed.ctx.gpuLost)
	assert.ok(lost?.reason, `ctx.gpuLost ${JSON.stringify(lost)}`)
	const errorsAtLoss = consoleErrors.length
	await m.page.waitForTimeout(4000)
	const after = await m.gate(() => globalThis.steelseed.ctx.snapshot.tick)
	assert.ok(after > before + 40, `the simulation must run on (tick ${before} -> ${after})`)
	const flood = consoleErrors.length - errorsAtLoss
	assert.ok(flood < 20, `the renderer must stop encoding against the dead device (${flood} errors in 4 s)`)
	await m.shot('device-lost')
	// The one error the loss itself must log; anything else is a fault.
	assert.deepEqual(m.errors.filter(e => !/\[render\] GPU device lost/.test(e)), [], 'page errors')
	console.log(`devicelostgate: PASS — alarm "${alarm.slice(0, 60)}…", reason ${lost.reason}, sim tick ${before} -> ${after}, ${flood} console errors after the loss`)
} finally {
	await m.close()
}
