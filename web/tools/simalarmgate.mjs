#!/usr/bin/env node
// Sim-alarm contract: when the watchdog halts the simulation, the player gets a
// clean panel — human copy only (no tick, no hash, no engine names), one
// in-app exit to the main menu (never a page reload) — while the full probe
// evidence goes to the [openra] console channel for debugging.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, join, extname, sep } from 'node:path'
import { launchGpuBrowser, loadChromium, WEB_ROOT } from './harness.mjs'

const dist = resolve(arg('dist', join(WEB_ROOT, 'dist')))
function arg(name, fallback) { return fallback }

const server = createServer(async (req, res) => {
	try {
		let path = new URL(req.url, 'http://localhost').pathname
		if (path.endsWith('/')) path += 'index.html'
		const file = resolve(dist, '.' + path)
		if (!file.startsWith(dist + sep)) throw Error('path')
		const data = await readFile(file)
		res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' })[extname(file)] ?? 'application/octet-stream' })
		res.end(data)
	} catch { res.writeHead(404); res.end() }
})
let browser
try {
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	;({ browser } = await launchGpuBrowser(await loadChromium('simalarmgate'), 'simalarmgate'))
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
	const consoleLines = []
	page.on('console', m => consoleLines.push(m.text()))
	const errors = []
	page.on('pageerror', e => errors.push(e.message))
	await page.addInitScript(() => {
		window.requestAnimationFrame = () => 1
		window.cancelAnimationFrame = () => {}
		// The desktop preload exposes backToMain; the stub records the call so the
		// gate can prove the exit goes in-app (the shell shows its own main menu).
		window.__backToMainCalls = 0
		window.backToMain = () => { window.__backToMainCalls++ }
	})
	await page.goto(`http://127.0.0.1:${server.address().port}/?devmap=1&manual=1&devsize=32&devactors=40&quality=low&seed=simalarm-gate`, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction(() => window.steelseed, undefined, { timeout: 180000, polling: 100 })
	await page.evaluate(() => { for (const id of ['session-ui', 'hud', 'outcome-ui']) { const el = document.getElementById(id); if (el) el.hidden = true } })

	// Stage the stall the way the watchdog would report it, then drive one frame
	// through the systems so the alarm renders.
	const staged = await page.evaluate(() => {
		const app = window.steelseed
		const snap = app.ctx.snapshot
		const draw = t => {
			if (snap) snap.tick = Math.floor(t * 25)
			app.ctx.time.tick = Math.floor(t * 25)
			app.ctx.time.alpha = (t * 25) % 25
			app.ctx.time.elapsed = t
			app.ctx.time.dt = .04
			app.registry.update(.04, app.ctx)
			app.registry.lateUpdate(.04, app.ctx)
		}
		draw(30)
		app.ctx.simHealth.stalled = true
		app.ctx.simHealth.reason = 'The simulation stopped responding at tick 12345 — no update for 4s.'
		app.ctx.simHealth.hostStatus = ''
		app.ctx.simHealth.diagnostics = ['sync: tick=12345 hash=4161111961', 'conn: state=NotConnected clientid=2 clients=2 netframe=4115 started=True outofsync=False clientstate=Ready', 'server: none']
		draw(30.04)
		return {
			visible: !document.getElementById('sim-alarm').hidden,
			title: document.querySelector('#sim-alarm b')?.textContent ?? '',
			body: document.querySelector('#sim-alarm span:not(.sim-alarm-diag)')?.textContent ?? '',
			button: document.querySelector('#sim-alarm button')?.textContent ?? '',
			hasDiagNode: !!document.querySelector('#sim-alarm .sim-alarm-diag'),
			hasDigits: /\d/.test(document.querySelector('#sim-alarm span')?.textContent ?? ''),
		}
	})
	assert.equal(staged.visible, true, 'the halted simulation raises the alarm panel')
	assert.equal(staged.title, 'Simulation halted')
	assert.equal(staged.body, 'The match simulation stopped. Return to the main menu to start a new match.', 'player copy stays clean')
	assert.equal(staged.hasDigits, false, 'no tick or duration digits in the player copy')
	assert.equal(staged.button, 'Back to main menu', 'the exit reads as an in-app return, not a reload')
	assert.equal(staged.hasDiagNode, false, 'probe evidence never renders into the panel')
	assert.ok(consoleLines.some(line => line.includes('[openra] sync: tick=12345')), 'probe evidence is captured on the [openra] console channel')

	// The exit is in-app: on the desktop surface the shell's backToMain owns the
	// return (no page reload), the panel stays dismissed over whatever comes next,
	// and a stalled sim must not re-raise it.
	await page.evaluate(() => { window.__simalarmNoReload = true })
	await page.click('#sim-alarm button')
	await page.waitForFunction(() => window.__backToMainCalls === 1, undefined, { timeout: 10000 })
	await page.evaluate(() => { const app = window.steelseed; app.registry.update(.04, app.ctx); app.registry.lateUpdate(.04, app.ctx) })
	const after = await page.evaluate(() => ({
		alarmHidden: document.getElementById('sim-alarm').hidden,
		backToMain: window.__backToMainCalls === 1,
		noReload: window.__simalarmNoReload === true,
	}))
	assert.equal(after.alarmHidden, true, 'the dismissed alarm stays down over the menu')
	assert.equal(after.backToMain, true, 'the exit hands back to the shell main menu in-app')
	assert.equal(after.noReload, true, 'the exit never reloads the page')
	assert.equal(errors.length, 0, errors.join('\n'))
	console.log('simalarmgate PASS — clean halt copy, [openra] diagnostics on console, in-app main-menu exit, dismissed alarm stays down')
} finally {
	await browser?.close().catch(() => {})
	await new Promise(resolve => server.close(resolve))
}
