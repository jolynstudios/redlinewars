#!/usr/bin/env node
// Close-up of a unit, so turret and barrel orientation are actually visible.
import { chromium } from 'playwright'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const WEB = new URL('..', import.meta.url).pathname
const PORT = 8733
const server = spawnProcessGroup('npm', ['exec', 'vite', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
	{ cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'] })
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) break } catch {} await sleep(250) }

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=metal'] })
const ctx = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
page.on('pageerror', e => console.error('PAGEERROR', e.message))
page.on('console', m => { const t = m.text(); if (/units|archetype|roster|slot|fail|BUCKETS/i.test(t)) console.log('PAGE:', t) })
await page.goto(`http://127.0.0.1:${PORT}/index.html?devmap=1&seed=demo&devsize=48&devactors=5&devcluster=4&quality=high&devtod=600${process.env.VIEW ? '&view=' + process.env.VIEW : ''}`, { waitUntil: 'load', timeout: 60000 })
await page.waitForFunction(() => globalThis.steelseed !== undefined, { timeout: 120000 })
await sleep(1200)

const b64 = await page.evaluate(async () => {
	const app = globalThis.steelseed
	app.stop()
	const cam = app.ctx.get('camera')
	const view = new URLSearchParams(location.search).get('view')
	if (view) app.ctx.get('render').setDebugView(view)
	// Drop the camera right on top of the cluster at the map centre.
	cam.height = 11
	cam.zoom = 1
	if (cam.heightGoal !== undefined) cam.heightGoal = 11
	if (cam.distance !== undefined) cam.distance = 15
	if (cam.distanceGoal !== undefined) cam.distanceGoal = 15
	for (let i = 0; i < 150; i++) app.renderOneFrame(i * (1000 / 60))
	const u = app.ctx.get('units')
	const slotCounts = []
	for (const [k, b] of u.slotBuckets) if (b.count > 0) slotCounts.push(`${k}=${b.count}`)
	const classCounts = []
	u.buckets.forEach((b, i) => { if (b && b.count > 0) classCounts.push(`class${i}=${b.count}`) })
	console.log('BUCKETS archetype:', slotCounts.join(' ') || '(none)', '| class:', classCounts.join(' ') || '(none)')
	const cv = app.ctx.canvas
	const c = document.createElement('canvas')
	c.width = cv.width; c.height = cv.height
	c.getContext('2d').drawImage(cv, 0, 0)
	return c.toDataURL('image/png').slice('data:image/png;base64,'.length)
})
const { writeFileSync } = await import('node:fs')
writeFileSync(new URL(`../shots/unit-${process.env.VIEW || 'final'}.png`, import.meta.url), Buffer.from(b64, 'base64'))
console.log('wrote shots/unit-closeup.png')
await browser.close(); stopProcessGroup(server)
