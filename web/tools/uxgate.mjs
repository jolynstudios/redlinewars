#!/usr/bin/env node
// STEELSEED — tools/uxgate
// Production-build witness for first-playable session and lifecycle UI.
//
// Numeric witnesses: strategic actor counts, pause order count, responsive containment,
// and screenshot pixels changed by an authoritative production-complete notice.
// `--falsify=zero` removes the outcome/event facts and must make the gate red.

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'
import { decodePng } from './png.mjs'

const TOOL = 'uxgate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHOTS = resolve(WEB_ROOT, 'shots')
const flags = parseFlags(process.argv.slice(2))
const falsify = flags.get('falsify') ?? 'none'
if (falsify !== 'none' && falsify !== 'zero') {
	console.error(`${TOOL}: unknown --falsify=${falsify}`)
	process.exit(2)
}

const port = positiveInteger(flags.get('port') ?? 8397, 'port')
const suppliedUrl = flags.get('url') ?? null
let browser = null
let server = null
let exitCode = 0

try {
	const chromium = await loadChromium(TOOL)
	const launched = await launchGpuBrowser(chromium, TOOL)
	browser = launched.browser
	if (launched.warning) console.warn(launched.warning)
	const preview = await startPreview(port, suppliedUrl)
	server = preview.server
	const context = await browser.newContext({
		viewport: { width: 1512, height: 982 },
		deviceScaleFactor: 1,
		locale: 'en-US',
		timezoneId: 'UTC',
	})
	const page = await context.newPage()
	// Static Vite preview has no account API. Landing server tests cover ranking;
	// keep the presentation outcome witness local and deterministic.
	await page.route('**/api/matches', route => route.fulfill({
		status: 200, contentType: 'application/json', body: '{}',
	}))
	const errors = []
	page.on('pageerror', error => errors.push(error.message))
	page.on('console', message => {
		if (message.type() === 'error') errors.push(message.text())
	})
	await page.addInitScript(() => {
		let id = 0
		globalThis.requestAnimationFrame = () => ++id
		globalThis.cancelAnimationFrame = () => {}
	})

	const url = new URL(preview.baseUrl)
	url.searchParams.set('mode', 'fixture') // preserve devmap through the served host-shell redirect
	url.searchParams.set('devmap', '1')
	url.searchParams.set('deterministic', '1')
	url.searchParams.set('manual', '1')
	url.searchParams.set('seed', 'first-playable-ux-v1')
	// This gate intentionally uses the deterministic dev fixture. When inspecting a
	// composed server, omit its host entry only in this test document: otherwise the
	// real host correctly supersedes devmap and no fixture snapshot can be produced.
	if (suppliedUrl) await page.route('**/steelseed/index.html*', async route => {
		const response = await route.fetch()
		const body = (await response.text()).replace('<script type="module" src="../main.js"></script>', '')
		await route.fulfill({ response, body, headers: { ...response.headers(), 'content-type': 'text/html; charset=utf-8' } })
	})
	await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined, {
		timeout: 120000,
		polling: 100,
	})

	mkdirSync(SHOTS, { recursive: true })
	const setupPng = await page.screenshot({ type: 'png', animations: 'disabled' })
	writeFileSync(resolve(SHOTS, 'ux-start.png'), setupPng)

	const setup = await page.evaluate(async () => {
		const app = globalThis.steelseed
		app.stop()
		const root = document.getElementById('session-ui')
		const states = [root.dataset.state]
		new MutationObserver(() => states.push(root.dataset.state)).observe(root, {
			attributes: true,
			attributeFilter: ['data-state'],
		})
		const session = app.ctx.session
		const start = session.startSkirmish
		session.startSkirmish = () => ({
			schemaVersion: 1,
			status: 'error',
			code: 'witnessed-error',
			userMessage: 'witnessed session error',
		})
		document.getElementById('session-start').click()
		await new Promise(resolveWait => setTimeout(resolveWait, 20))
		const errorState = root.dataset.state
		const errorText = document.getElementById('session-status').textContent
		session.startSkirmish = start
		document.getElementById('session-start').click()
		await new Promise(resolveWait => setTimeout(resolveWait, 20))
		const loadingText = document.getElementById('session-status').textContent
		return { states, errorState, errorText, loadingText }
	})

	const result = await page.evaluate((defeat) => {
		const app = globalThis.steelseed
		for (let i = 0; i < 8; i++) app.renderOneFrame(i * (1000 / 60))
		const snap = app.ctx.snapshot
		const ui = app.ctx.get('ui')
		const pauseStates = []
		const setPaused = app.ctx.session.setPaused
		app.ctx.session.setPaused = paused => {
			pauseStates.push(paused)
			return 'ok: witnessed OpenRA PauseGame order'
		}

		document.getElementById('hud-pause').click()
		const originalFlags = snap.flags
		const player = snap.players.find(p => (p.flags & (1 << 1)) !== 0) ?? snap.players[0]
		const originalPlayerFlags = player.flags
		snap.flags = originalFlags | (1 << 1)
		ui.onSnapshot(snap, null, app.ctx)
		document.getElementById('hud-pause').click()
		app.ctx.session.setPaused = setPaused

		const minimap = document.getElementById('hud-minimap')
		const rect = minimap.getBoundingClientRect()
		minimap.dispatchEvent(new PointerEvent('pointerdown', {
			bubbles: true,
			pointerId: 1,
			button: 0,
			clientX: rect.left + rect.width * .72,
			clientY: rect.top + rect.height * .34,
		}))

		snap.flags = originalFlags | (1 << 3)
		player.flags = defeat ? originalPlayerFlags : (originalPlayerFlags | (1 << 3))
		ui.onSnapshot(snap, null, app.ctx)
		const outcome = document.getElementById('outcome-ui').dataset.outcome
		const outcomeTitle = document.getElementById('outcome-title').textContent

		snap.flags = originalFlags
		player.flags = originalPlayerFlags
		ui.onSnapshot(snap, null, app.ctx)
		return {
			players: snap.players.length,
			hudVisible: document.getElementById('game-ui').hidden === false,
			sessionHidden: document.getElementById('session-ui').hidden,
			pauseLabel: document.getElementById('hud-pause').textContent,
			pauseStates,
			strategic: { ...ui.strategicStats },
			outcome,
			outcomeTitle,
			minimapInside: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
		}
	}, falsify === 'zero')

	const beforeNotice = await page.screenshot({ type: 'png', animations: 'disabled' })
	const notice = await page.evaluate((defeat) => {
		const app = globalThis.steelseed
		const snap = app.ctx.snapshot
		const player = snap.players.find(p => (p.flags & (1 << 1)) !== 0) ?? snap.players[0]
		const actorType = snap.production[0]?.items[0]?.actorType ?? snap.actors.typeId[0]
		const offset = 28
		const saved = snap.view.getUint32(offset, true)
		snap.view.setUint8(offset, player.id)
		snap.view.setUint8(offset + 1, snap.production[0]?.queueId ?? 0)
		snap.view.setUint16(offset + 2, actorType, true)
		if (!defeat) app.events.emit('sim:production:complete', { kind: 8, offset, byteLength: 4 })
		const el = document.getElementById('hud-notice')
		const result = { hidden: el.hidden, text: el.textContent, actorType }
		snap.view.setUint32(offset, saved, true)
		return result
	}, falsify === 'zero')
	const afterNotice = await page.screenshot({ type: 'png', animations: 'disabled' })
	writeFileSync(resolve(SHOTS, 'ux-production.png'), afterNotice)
	const changedPixels = countChangedPixels(beforeNotice, afterNotice)

	const problems = [...errors]
	if (!setup.states.includes('loading')) problems.push(`loading state was never entered: ${setup.states.join(',')}`)
	if (!setup.states.includes('error') || setup.errorState !== 'error') problems.push('injected start failure did not reach explicit error state')
	if (!setup.errorText.includes('witnessed session error')) problems.push(`session error text was '${setup.errorText}'`)
	if (!setup.loadingText.includes('authoritative snapshot')) problems.push(`post-start loading text was '${setup.loadingText}'`)
	if (result.players !== 2 || !result.hudVisible || !result.sessionHidden)
		problems.push(`match shell did not transition to HUD: players=${result.players} hud=${result.hudVisible} setupHidden=${result.sessionHidden}`)
	if (result.pauseStates.length !== 2 || result.pauseStates[0] !== true || result.pauseStates[1] !== false)
		problems.push(`pause/resume states were ${result.pauseStates.join(',')}, expected true,false`)
	if (result.pauseLabel !== 'Pause') problems.push(`pause label restored as '${result.pauseLabel}'`)
	if (result.strategic.visibleActors <= 0 || result.strategic.drawnActors <= 0)
		problems.push(`strategic overview drew ${result.strategic.drawnActors}/${result.strategic.visibleActors} visible actors`)
	if (result.strategic.focusCommands !== 1) problems.push(`strategic overview emitted ${result.strategic.focusCommands} focus commands`)
	if (!result.minimapInside) problems.push('strategic overview overflows the production viewport')
	if (result.outcome !== 'victory' || result.outcomeTitle !== 'Victory')
		problems.push(`authoritative won flag rendered ${result.outcome}/${result.outcomeTitle}`)
	if (notice.hidden || !/ ready$/i.test(notice.text)) problems.push(`production notice was hidden or malformed: '${notice.text}'`)
	if (changedPixels < 120) problems.push(`production notice changed only ${changedPixels} screenshot pixels`)

	console.log(
		`${TOOL}: players=${result.players} strategic=${result.strategic.drawnActors}/${result.strategic.visibleActors} ` +
		`focus=${result.strategic.focusCommands} pauseOrders=${result.pauseStates.length} outcome=${result.outcome} ` +
		`productionDelta=${changedPixels}px`,
	)
	console.log(`${TOOL}: captures ${resolve(SHOTS, 'ux-start.png')} and ${resolve(SHOTS, 'ux-production.png')}`)
	if (problems.length > 0) {
		for (const problem of problems) console.error(`  ${problem}`)
		console.error(`${TOOL}: FAIL — first-playable UX witness is incomplete`)
		exitCode = 1
	} else console.log(`${TOOL}: PASS — start/error/loading, pause, overview, outcome and production lifecycle are live`)

	await context.close()
} catch (error) {
	console.error(`${TOOL}: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser) await browser.close()
	if (server) await stopChild(server)
}

process.exit(exitCode)

function countChangedPixels(aPng, bPng) {
	const a = decodePng(aPng)
	const b = decodePng(bPng)
	if (a.width !== b.width || a.height !== b.height) throw new Error('UX screenshots have different dimensions')
	let changed = 0
	for (let i = 0; i < a.data.length; i += 4) {
		if (Math.max(
			Math.abs(a.data[i] - b.data[i]),
			Math.abs(a.data[i + 1] - b.data[i + 1]),
			Math.abs(a.data[i + 2] - b.data[i + 2]),
		) >= 8) changed++
	}
	return changed
}

function parseFlags(argv) {
	const out = new Map()
	for (const arg of argv) {
		const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
		if (!match) throw new Error(`${TOOL}: invalid argument '${arg}'`)
		out.set(match[1], match[2] ?? '1')
	}
	return out
}

function positiveInteger(value, label) {
	const n = Number(value)
	if (!Number.isInteger(n) || n <= 0) throw new Error(`${TOOL}: --${label} must be a positive integer`)
	return n
}
