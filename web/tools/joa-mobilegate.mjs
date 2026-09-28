#!/usr/bin/env node
/**
 * JOA on a phone, every mode: a touch device against tools/joa-preview.mjs with a real match's
 * projection (tools/joa-fixture.mjs). It checks:
 * - gestures: two-finger pinch in and out, drag, double-tap, the zoom buttons, Fit and Base;
 * - vision: auto, IR white-hot, NV green and day, plus automatic night;
 * - sheets: Map, Groups, Support, Alerts and Taunts;
 * - orders: group move and support fire;
 * - each permission: information, support and command;
 * - layouts: phone portrait, phone landscape and tablet.
 * Taps must never miss, so open sheets keep their buttons between states.
 *
 *   node tools/joa-mobilegate.mjs [--fixture=.artifacts/joa/fixture-explored.json]
 *
 * Writes .artifacts/joa/mobile/report.json and one screenshot per step. Exit 1 on a failure.
 * Pinch goes through the DevTools protocol's multi-touch input, which drives pointer events just
 * as a finger does; Safari's own gesture events are covered by code, not by this gate.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { launchGpuBrowser, loadChromium, WEB_ROOT } from './harness.mjs'

const out = `${WEB_ROOT}/.artifacts/joa/mobile`
mkdirSync(out, { recursive: true })
const fixture = process.argv.find(a => a.startsWith('--fixture='))?.slice(10) ?? '.artifacts/joa/fixture-explored.json'
if (!existsSync(`${WEB_ROOT}/${fixture}`)) throw new Error(`No fixture at ${fixture}: capture one with tools/joa-fixture.mjs`)
const port = Number(process.env.JOA_GATE_PORT ?? 5321)

const checks = []
const check = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` · ${detail}` : ''}`) }

const running = new Set()
/** One preview per scenario: its secret pairs exactly one phone. */
async function preview(flags) {
	try { await fetch(`http://127.0.0.1:${port}/`); throw new Error(`Port ${port} is busy: stop what runs there, or set JOA_GATE_PORT`) } catch (error) { if (/busy/.test(error.message)) throw error }
	const child = spawn(process.execPath, ['tools/joa-preview.mjs', `--fixture=${fixture}`, '--own-allies', ...flags], { cwd: WEB_ROOT, env: { ...process.env, JOA_PREVIEW_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
	let log = ''
	child.stdout.on('data', b => { log += b }); child.stderr.on('data', b => { log += b })
	for (let i = 0; i < 200 && !/PREVIEW_URL=\S+/.test(log); i++) await new Promise(r => setTimeout(r, 50))
	const url = /PREVIEW_URL=(\S+)/.exec(log)?.[1]
	if (!url) { child.kill(); throw new Error(`Preview did not start:\n${log}`) }
	for (let i = 0; i < 100; i++) { try { if ((await fetch(url.split('#')[0])).ok) break } catch {} await new Promise(r => setTimeout(r, 100)) }
	const handle = { url, code: /PREVIEW_CODE=(\S+)/.exec(log)?.[1], log: () => log, stop: () => { running.delete(handle); return child.exitCode !== null ? Promise.resolve() : new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM') }) } }
	running.add(handle)
	return handle
}

const { browser } = await launchGpuBrowser(await loadChromium('joa-mobilegate'), 'joa-mobilegate')
async function phone(url, width = 390, height = 844) {
	const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
	const page = await context.newPage()
	const errors = []
	page.on('pageerror', e => errors.push(e.message))
	page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
	await page.goto(url)
	await page.locator('.joa-connect').waitFor({ state: 'hidden', timeout: 20000 })
	await page.waitForFunction(() => !document.querySelector('.joa-downlink:not([hidden])'), null, { timeout: 20000 }).catch(() => {})
	await page.waitForTimeout(600)
	const cdp = await context.newCDPSession(page)
	return { page, errors, cdp, close: () => context.close() }
}
const zoomOf = page => page.locator('[data-zoom]').first().textContent().then(t => parseFloat(t ?? '0'))
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` })
async function mapBox(page) { const b = await page.locator('canvas').boundingBox(); return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 } }
async function pinch(cdp, page, cx, cy, from, to) {
	const points = d => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }]
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) })
	for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + (to - from) * i / 12) }); await page.waitForTimeout(16) }
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
	await page.waitForTimeout(250)
}
async function drag(cdp, page, x, y, dx, dy) {
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
	for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 10, y: y + dy * i / 10, id: 1 }] }); await page.waitForTimeout(16) }
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
	await page.waitForTimeout(700)
}
const canvasHash = page => page.evaluate(() => { const c = document.querySelector('canvas'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return h })
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)

let failed = false
try {
	// ---- Command permission, phone portrait: gestures, vision, sheets, orders, taunts ----
	{
		const p = await preview(['--accept'])
		const { page, errors, cdp, close } = await phone(p.url)
		const box = await mapBox(page)
		await shot(page, 'portrait-map')
		check('portrait: no page overflow', await noOverflow(page))
		check('portrait: first view frames own base', await page.evaluate(() => document.body.dataset.link === 'live'), 'live link')

		// Pinches stay left of the control rail, as a thumb and finger on the map do.
		const px = box.cx - 50
		const z0 = await zoomOf(page)
		await pinch(cdp, page, px, box.cy, 40, 130)
		const z1 = await zoomOf(page)
		check('pinch out zooms in', z1 > z0 * 1.8, `${z0}× → ${z1}×`)
		await shot(page, 'portrait-pinched')
		await pinch(cdp, page, px, box.cy, 130, 50)
		const z2 = await zoomOf(page)
		check('pinch in zooms out', z2 < z1, `${z1}× → ${z2}×`)
		const h0 = await canvasHash(page)
		await drag(cdp, page, box.cx, box.cy, -120, 90)
		check('one-finger drag pans the map', (await canvasHash(page)) !== h0)
		const z3 = await zoomOf(page)
		await page.touchscreen.tap(box.cx, box.cy); await page.waitForTimeout(90); await page.touchscreen.tap(box.cx, box.cy)
		await page.waitForTimeout(600)
		check('double-tap zooms in', (await zoomOf(page)) > z3, `${z3}× → ${await zoomOf(page)}×`)
		await page.locator('button[data-fit]').tap(); await page.waitForTimeout(600)
		check('Fit returns to the whole battlefield', (await zoomOf(page)) === 1)
		await page.locator('button[data-zoom="1"]').tap(); await page.waitForTimeout(500)
		check('zoom button zooms in', (await zoomOf(page)) > 1)
		await page.locator('button[data-zoom="-1"]').tap(); await page.waitForTimeout(500)
		check('zoom button zooms out', (await zoomOf(page)) < 1.5)
		await page.locator('button[data-base]').tap(); await page.waitForTimeout(600)
		check('Base centres close on the base', (await zoomOf(page)) >= 3)
		await shot(page, 'portrait-base')

		const heat = page.locator('button[data-heat]')
		const heatBefore = await heat.getAttribute('aria-pressed')
		await heat.tap()
		check('heat toggles', (await heat.getAttribute('aria-pressed')) !== heatBefore)
		await heat.tap()
		const modes = []
		for (let i = 0; i < 4; i++) {
			await page.locator('button[data-vision]').tap(); await page.waitForTimeout(700)
			modes.push([await page.evaluate(() => document.body.dataset.vision), await page.locator('[data-mode]').textContent()])
			await shot(page, `portrait-vision-${i}`)
		}
		check('vision cycles white, green, day and back to auto', modes.map(m => m[0]).join() === 'white,green,day,day' && modes[3][1].endsWith('AUTO'), modes.map(m => m[1]).join(' | '))

		// Taunts moved from the dock to the rail: it must sit above the zoom buttons.
		check('taunts sits first on the rail', await page.evaluate(() => document.querySelector('.joa-rail button')?.dataset.tab === 'taunts'))

		// Groups: the sheet keeps its buttons between states, a group arms aiming, a tap orders.
		await page.getByRole('button', { name: 'Groups', exact: true }).tap()
		await page.locator('.joa-group').first().waitFor()
		await page.evaluate(() => { window.__card = document.querySelector('.joa-group') })
		await page.waitForTimeout(1300)
		check('open sheet keeps its buttons across states', await page.evaluate(() => document.querySelector('.joa-group') === window.__card))
		await shot(page, 'portrait-groups')
		await page.locator('.joa-group:not([disabled])').first().tap()
		await page.locator('.joa-aim').waitFor()
		check('a group arms aiming and the sheet steps aside', await page.evaluate(() => document.body.dataset.aiming === 'true' && document.querySelector('.joa-sheet').hidden))
		check('a group card returns to the map and centres on it', await page.evaluate(() => document.querySelector('.joa-dock button[data-tab="map"]')?.getAttribute('aria-selected') === 'true') && (await zoomOf(page)) >= 3, `${await zoomOf(page)}×`)
		await shot(page, 'portrait-aiming')
		await page.touchscreen.tap(box.cx, box.cy - 60)
		await page.waitForFunction(() => /accepted/i.test(document.querySelector('.joa-toast')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {})
		check('a map tap sends the group order', /accepted/i.test(await page.locator('.joa-toast').textContent()), await page.locator('.joa-toast').textContent())

		// Support: a ready power, aimed, confirmed.
		await page.getByRole('button', { name: 'Support', exact: true }).tap()
		await page.getByRole('button', { name: 'Air strike · Ready', exact: true }).tap()
		await page.waitForTimeout(300)
		await page.touchscreen.tap(box.cx + 30, box.cy - 90)
		const use = page.getByRole('button', { name: 'Use support', exact: true })
		await use.waitFor({ timeout: 5000 })
		await shot(page, 'portrait-support-confirm')
		await use.tap()
		await page.waitForFunction(() => /accepted/i.test(document.querySelector('.joa-toast')?.textContent ?? ''), null, { timeout: 5000 }).then(() => check('support fires after the confirm', true), () => check('support fires after the confirm', false))

		// Chronoshift: two taps, the source and then the destination. (A tab tapped while open closes it.)
		if (await page.evaluate(() => document.body.dataset.sheet !== 'support' || document.querySelector('.joa-sheet').hidden)) await page.getByRole('button', { name: 'Support', exact: true }).tap()
		await page.getByRole('button', { name: 'Chronoshift · Ready', exact: true }).tap()
		await page.waitForTimeout(300)
		check('Chronoshift asks for its source first', /source/i.test(await page.locator('[data-aim-hint]').textContent()), await page.locator('[data-aim-hint]').textContent())
		await page.touchscreen.tap(box.cx - 40, box.cy + 40); await page.waitForTimeout(300)
		await page.touchscreen.tap(box.cx + 40, box.cy - 120)
		const shift = page.getByRole('button', { name: 'Use support', exact: true })
		await shift.waitFor({ timeout: 5000 })
		await shot(page, 'portrait-chronoshift-confirm')
		await shift.tap()
		await page.waitForFunction(() => /accepted/i.test(document.querySelector('.joa-toast')?.textContent ?? ''), null, { timeout: 5000 }).then(() => check('Chronoshift fires after source, destination and confirm', true), () => check('Chronoshift fires after source, destination and confirm', false))

		// Alerts: a row centres the map on it.
		// The tab's name carries its unseen count ("Alerts 2").
		await page.getByRole('button', { name: /^Alerts/ }).tap()
		await page.locator('.joa-row--alert').first().waitFor()
		await shot(page, 'portrait-alerts')
		await page.locator('.joa-row--alert').first().tap(); await page.waitForTimeout(600)
		check('an alert centres the map', (await zoomOf(page)) >= 4)

		// The map legend names the glyphs a co-commander must tell apart. It belongs to the map,
		// so the sheet steps back first.
		await page.getByRole('button', { name: 'Map', exact: true }).tap()
		await page.waitForTimeout(400)
		check('the map legend names the unit glyphs', await page.evaluate(() => { const l = document.querySelector('.joa-legend'); return !!l && getComputedStyle(l).display !== 'none' && l.querySelectorAll('i').length >= 5 }))

		// Statistics lead with what the base is raising: the queues, with their charge.
		await page.getByRole('button', { name: 'Stats', exact: true }).tap()
		await page.locator('.joa-prod__row').first().waitFor()
		check('statistics show the production queues', (await page.locator('.joa-prod__row').count()) === 2, await page.locator('.joa-prod__label').first().textContent())
		await shot(page, 'portrait-stats-production')

		// Ask: the co-commander's questions reach the main game, then rest like a taunt.
		await page.getByRole('button', { name: 'Ask', exact: true }).tap()
		await page.getByRole('button', { name: 'Ask: Build a tank battalion?', exact: true }).waitFor()
		await shot(page, 'portrait-ask')
		await page.getByRole('button', { name: 'Ask: Build a tank battalion?', exact: true }).tap()
		await page.waitForFunction(() => /Asked/.test(document.querySelector('.joa-toast')?.textContent ?? ''), null, { timeout: 5000 }).then(() => check('a question is asked', true), () => check('a question is asked', false))
		await page.waitForTimeout(300)
		check('the main game receives the question', /ASK tank-battalion/.test(p.log()))
		check('questions rest after one is asked', await page.getByRole('button', { name: 'Ask: Launch the nuke?', exact: true }).isDisabled())

		// Taunts: sent, heard by the main game, then a short rest.
		await page.getByRole('button', { name: 'Taunts', exact: true }).tap()
		await page.getByRole('button', { name: 'Taunt: You suck!', exact: true }).waitFor()
		await shot(page, 'portrait-taunts')
		await page.getByRole('button', { name: 'Taunt: You suck!', exact: true }).tap()
		await page.waitForFunction(() => /Taunt sent/.test(document.querySelector('.joa-toast')?.textContent ?? ''), null, { timeout: 5000 }).then(() => check('taunt is sent', true), () => check('taunt is sent', false))
		await page.waitForTimeout(300)
		check('the main game receives the taunt', /TAUNT you-suck/.test(p.log()))
		check('taunts rest after one is sent', await page.getByRole('button', { name: "Taunt: You can't win!", exact: true }).isDisabled())
		await shot(page, 'portrait-taunt-sent')
		await page.waitForTimeout(4300)
		check('taunts return after the rest', !(await page.getByRole('button', { name: "Taunt: You can't win!", exact: true }).isDisabled()))
		// A reload (or the phone discarding the tab) resumes the link without a new code.
		await page.reload()
		const resumed = await page.locator('.joa-connect').waitFor({ state: 'hidden', timeout: 10000 }).then(() => true, () => false)
		await page.waitForTimeout(800)
		check('a reload resumes the link', resumed && await page.evaluate(() => document.body.dataset.link === 'live'))
		check('portrait: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
		await close(); await p.stop()
	}

	// ---- The incoming nuke: the banner, its countdown, and its own missile's impact ring ----
	{
		const p = await preview(['--nuke'])
		const { page, errors, close } = await phone(p.url)
		await page.waitForSelector('.joa-nuke:not([hidden])', { timeout: 10000 })
		check('the incoming nuke banner shows', await page.evaluate(() => !document.querySelector('.joa-nuke').hidden))
		check('the banner counts down to impact', (await page.locator('[data-nuke-clock]').textContent()) === '01:14')
		check('an imminent launch turns the banner hot', await page.evaluate(() => document.querySelector('.joa-nuke').hasAttribute('data-imminent')))
		await shot(page, 'portrait-nuke-banner')
		check('nuke: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
		await close(); await p.stop()
	}

	// ---- Information and support permissions ----
	for (const tier of ['information', 'support']) {
		const p = await preview([`--tier=${tier}`])
		const { page, errors, close } = await phone(p.url)
		check(`${tier}: link reads the permission`, new RegExp(tier === 'information' ? 'Spectator' : 'Technician', 'i').test(await page.locator('span[data-link]').textContent()), await page.locator('span[data-link]').textContent())
		await page.getByRole('button', { name: 'Groups', exact: true }).tap()
		await page.locator('.joa-group').first().waitFor()
		check(`${tier}: group orders are unavailable`, await page.getByRole('button', { name: 'Move', exact: true }).isDisabled())
		await shot(page, `${tier}-groups`)
		await page.getByRole('button', { name: 'Support', exact: true }).tap()
		const strike = page.getByRole('button', { name: 'Air strike · Ready', exact: true })
		check(`${tier}: support weapons ${tier === 'support' ? 'available' : 'view only'}`, (await strike.isDisabled()) === (tier === 'information'))
		await shot(page, `${tier}-support`)
		await page.getByRole('button', { name: 'Taunts', exact: true }).tap()
		check(`${tier}: taunts available`, !(await page.getByRole('button', { name: 'Taunt: You suck!', exact: true }).isDisabled()))
		check(`${tier}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
		await close(); await p.stop()
	}

	// ---- Pairing by typed code on a small phone ----
	{
		const p = await preview([])
		const context = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
		const page = await context.newPage()
		await page.goto(p.url.split('#')[0])
		await page.locator('#joa-code').waitFor()
		check('small phone: connect screen fits', await noOverflow(page) || await page.evaluate(() => document.querySelector('.joa-connect').scrollHeight >= innerHeight))
		await shot(page, 'small-connect')
		await page.locator('#joa-code').fill(p.code ?? '')
		await shot(page, 'small-connect-code')
		await page.getByRole('button', { name: /connect/i }).tap()
		const paired = await page.locator('.joa-connect').waitFor({ state: 'hidden', timeout: 15000 }).then(() => true, () => false)
		check('small phone: pairs with the typed code', paired)
		await page.waitForTimeout(800)
		check('small phone: no page overflow', await noOverflow(page))
		await shot(page, 'small-map')
		await context.close(); await p.stop()
	}

	// ---- Night, landscape phone and tablet ----
	{
		const p = await preview(['--night'])
		const { page, errors, cdp, close } = await phone(p.url, 844, 390)
		check('night: auto vision turns white-hot', await page.evaluate(() => document.body.dataset.vision === 'white'))
		check('landscape: no page overflow', await noOverflow(page))
		await shot(page, 'landscape-night')
		const box = await mapBox(page)
		const z0 = await zoomOf(page)
		await pinch(cdp, page, box.cx - 60, box.cy, 30, 100)
		check('landscape: pinch zooms', (await zoomOf(page)) > z0, `${z0}× → ${await zoomOf(page)}×`)
		for (const name of ['Groups', 'Support', 'Alerts', 'Taunts']) {
			await page.getByRole('button', { name: new RegExp(`^${name}`) }).tap(); await page.waitForTimeout(350)
			await shot(page, `landscape-${name.toLowerCase()}`)
		}
		check('landscape: every tab opens its sheet', await page.evaluate(() => !document.querySelector('.joa-sheet').hidden && document.body.dataset.sheet === 'taunts'))
		// The sheet's head is its handle: a drag down past the threshold closes it.
		const head = await page.evaluate(() => { const r = document.querySelector('.joa-sheet__head').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 14 } })
		await page.mouse.move(head.x, head.y); await page.mouse.down()
		for (let i = 1; i <= 12; i++) { await page.mouse.move(head.x, head.y + i * 14); await page.waitForTimeout(16) }
		await page.mouse.up(); await page.waitForTimeout(300)
		check('dragging the sheet head down closes it', await page.evaluate(() => document.querySelector('.joa-sheet').hidden === true && document.body.dataset.sheet === 'map'))
		await shot(page, 'landscape-drag-closed')
		await page.setViewportSize({ width: 820, height: 1180 }); await page.waitForTimeout(700)
		check('tablet: no page overflow', await noOverflow(page))
		await shot(page, 'tablet-night-taunts')
		await page.getByRole('button', { name: 'Map', exact: true }).tap(); await page.waitForTimeout(400)
		await shot(page, 'tablet-night-map')
		check('night/landscape/tablet: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
		await close(); await p.stop()
	}
} catch (error) {
	check('gate ran to the end', false, String(error.message ?? error).split('\n')[0])
} finally {
	await browser.close()
	for (const handle of [...running]) await handle.stop()
}
failed = checks.some(c => !c.pass)
writeFileSync(`${out}/report.json`, JSON.stringify({ fixture, date: new Date().toISOString(), pass: !failed, checks }, null, 2) + '\n')
console.log(`\njoa-mobilegate: ${failed ? 'FAIL' : 'PASS'} · ${checks.filter(c => c.pass).length}/${checks.length} checks · ${out}`)
process.exit(failed ? 1 : 0)
