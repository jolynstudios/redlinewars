// Throwaway: verify M tactical map, L troop flash and the select-all button in a live match.
import { loadChromium, launchGpuBrowser } from './harness.mjs'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'
const waitForServer = (url, timeoutMs) => new Promise((resolve, reject) => {
	const started = Date.now()
	const tick = async () => {
		try { const r = await fetch(url); if (r.ok) return resolve() } catch {}
		if (Date.now() - started > timeoutMs) return reject(new Error('preview never started'))
		setTimeout(tick, 200)
	}
	tick()
})
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = import.meta.url
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const port = 4193
const baseUrl = `http://127.0.0.1:${port}/steelseed/index.html`

const engineRoot = resolve(WEB, '../engine')
const server = spawnProcessGroup(process.execPath, [join(engineRoot, 'OpenRA.Browser/tests/server.mjs'),
	'--root', join(engineRoot, 'bin-browser/AppBundle'), '--port', String(port)],
	{ cwd: engineRoot, stdio: ['ignore', 'pipe', 'pipe'] })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
try {
	await waitForServer(baseUrl, 20000)
	const chromium = await loadChromium(TOOL)
	const launched = await launchGpuBrowser(chromium, TOOL)
	const browser = launched.browser
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
	page.on('pageerror', (e) => console.log('PAGE-ERROR:', String(e).slice(0, 200)))
	let lastLog = ''
	await page.goto(`${baseUrl}?mode=game&platform=null&quality=${process.env.QUALITY ?? 'low'}`, { waitUntil: 'load', timeout: 90000 })
	// session.available is the real readiness signal (the local engine host booted).
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 100 })
	await sleep(900)
	await page.evaluate(() => {
		const fog = [...document.querySelectorAll('select')].find(s => /fog/i.test(s.id) || /fog/i.test(s.closest('label')?.textContent ?? ''))
		// 'False' is the engine's option value; the game auto-pairs it with explored=True.
		if (fog) { fog.value = 'False'; fog.dispatchEvent(new Event('change', { bubbles: true })) }
	})
	const pre = await page.evaluate(() => ({
		available: globalThis.steelseed?.ctx?.session?.available ?? null,
		disabled: document.getElementById('session-start')?.disabled ?? null,
		hidden: document.getElementById('session-start')?.hidden ?? null,
		status: document.getElementById('session-status')?.textContent ?? ''
	}))
	console.log('PRE-CLICK', JSON.stringify(pre))
	await page.click('#session-start').catch((e) => console.log('CLICK-FAIL', String(e).slice(0, 80)))
	// A started match: authoritative actors exist and the lobby hid itself.
	await page.waitForFunction(() => {
		const s = globalThis.steelseed
		return s?.ctx?.snapshot?.actors?.count > 0 && document.getElementById('session-ui')?.hidden
	}, undefined, { timeout: 150000, polling: 500 }).catch(async () => {
		const diag = await page.evaluate(() => ({
			available: globalThis.steelseed?.ctx?.session?.available ?? null,
			actors: globalThis.steelseed?.ctx?.snapshot?.actors?.count ?? null,
			sessionHidden: document.getElementById('session-ui')?.hidden ?? null,
			startDisabled: document.getElementById('session-start')?.disabled ?? null,
			status: document.getElementById('session-status')?.textContent ?? '',
			gameUiHidden: document.getElementById('game-ui')?.hidden ?? null,
		})).catch(() => ({ diag: 'failed' }))
		console.log('MATCH-START-TIMEOUT', JSON.stringify(diag), 'lastConsoleError:', lastLog.slice(0, 160))
	})

	if (process.env.MARCH === '1') {
		// Real-1v1 bootstrap: deploy the MCV, run the economy up to a real army, then
		// measure HUD frame stats while the whole army marches. Production/placement
		// go through the same runtime entry points the HUD buttons use.
		await sleep(5000)
		const boot = await page.evaluate(() => {
			const app = globalThis.steelseed
			const ui = app.ctx.get('ui')
			const actors = app.ctx.snapshot.actors
			const rp = app.ctx.snapshot.world.renderPlayer
			let mcv = -1, bx = -1, bz = -1
			for (let i = 0; i < actors.count; i++) {
				if (actors.owner[i] !== rp) continue
				mcv = actors.id[i]; bx = Math.floor(actors.posX[i] / 1024); bz = Math.floor(actors.posY[i] / 1024)
				break
			}
			ui.selected.length = 0
			ui.selected.push(mcv)
			ui.deploySelection(new MouseEvent('click', { bubbles: true }))
			return { mcv, bx, bz }
		})
		const buildUntil = Date.now() + 6 * 60 * 1000
		let armyReady = false
		while (Date.now() < buildUntil && !armyReady) {
		// Build-up loop: structures first (power, then whatever the queue unlocks),
		// place every ready building near the base, keep infantry + vehicles queued.
		const ARMED = false, READY = 1 << 4, BUILDING = 1 << 5, BUILDABLE = 1 << 1
			const st = await page.evaluate(({ bx, bz }) => {
				const app = globalThis.steelseed
				const ctx = app.ctx
				const ui = ctx.get('ui')
				const actors = ctx.snapshot?.actors
				const rp = ctx.snapshot.world.renderPlayer
				let ownTroops = 0
				if (actors) for (let i = 0; i < actors.count; i++) {
					if (actors.owner[i] === rp && actors.id[i] !== undefined) ownTroops++
				}
				const queues = (ctx.snapshot?.production ?? []).filter(q => q.playerId === rp)
				const log = { ownTroops, queues: queues.map(q => ({ kind: q.kind, items: (q.items ?? []).map(i => ({ t: i?.actorType, f: i?.flags, q: i?.queued })) })) }
				const EMPTY = new Uint32Array(0)
				for (const queue of queues) {
					const qItems = queue.items ?? []
					const readyItem = qItems.find(i => (i?.flags & 16) !== 0 && (i?.flags & 32) !== 0)
					if (readyItem !== undefined && queue.kind === 0) {
						// Ready structure: place it near the base, spiral until one lands.
						const name = ctx.actorTypeName(readyItem.actorType)
						let placed = null
						outer: for (let r = 3; r <= 14 && !placed; r++) {
							for (let dx = -r; dx <= r && !placed; dx++) for (let dz = -r; dz <= r; dz++) {
								if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
								const res = ctx.placement.place({ queueId: queue.queueId, actorType: name, cellX: bx + dx, cellY: bz + dz, variant: 0, modifiers: 1 })
								if (res?.issued) { placed = { x: bx + dx, y: bz + dz, name }; break outer }
							}
						}
						log.placed = placed
						continue
					}
					const idle = queue.kind !== 0
					if (idle) {
						// Units: keep three in the pipe (queued counts in-progress + waiting).
						const inPipe = qItems.reduce((n, i) => n + (i?.queued ?? 0), 0)
						if (inPipe >= 3) continue
						const target = qItems.find(i => (i?.flags & 2) !== 0)
						if (target === undefined) continue
						ctx.issueOrder({ orderString: 'StartProduction', extraData: 1, queued: true, subjectIds: EMPTY, targetString: ctx.actorTypeName(target.actorType) })
						log.enqueued = ctx.actorTypeName(target.actorType)
					} else {
						const active = qItems.some(i => (i?.flags & 4) !== 0 || (i?.queued ?? 0) > 0)
						if (active) continue
						const target = qItems.find(i => (i?.flags & 2) !== 0)
						if (target === undefined) continue
						ctx.issueOrder({ orderString: 'StartProduction', extraData: 1, queued: true, subjectIds: EMPTY, targetString: ctx.actorTypeName(target.actorType) })
						log.enqueuedStructure = ctx.actorTypeName(target.actorType)
					}
				}
				return log
			}, { bx: boot.bx, bz: boot.bz })
			const troops = st.ownTroops
			armyReady = troops >= 16
			if (st.placed || st.enqueued || st.enqueuedStructure || (Date.now() % 30000) < 3000)
				console.log('BOOT', JSON.stringify(st))
			await sleep(armyReady ? 1000 : 4000)
		}
		console.log('BOOT-DONE', JSON.stringify({ armyReady }))
		// Measurement: 95 s of army marching, samples every 5 s.
		const samples = []
		const t0 = Date.now()
		let nextOrder = 0
		while (Date.now() - t0 < 65000) {
			const now = Date.now()
			if (now >= nextOrder) {
				nextOrder = now + 10000
				await page.evaluate(() => {
					const ui = globalThis.steelseed.ctx.get('ui')
					ui.selectAllTroops()
					ui.issueDirectOrder('Move', 0, 70, 48)
				})
			}
			const s = await page.evaluate(() => {
				const app = globalThis.steelseed
				const units = app.ctx.get('units')
				const fx = app.ctx.get('fx')
				const actors = app.ctx.snapshot?.actors
				let own = 0, ownMoving = 0
				if (actors) {
					const rp = app.ctx.snapshot.world.renderPlayer
					for (let i = 0; i < actors.count; i++) {
						if (actors.owner[i] !== rp) continue
						own++
						if ((actors.flags[i] & 64) !== 0) ownMoving++ // ActorFlag.moving
					}
				}
				return {
					ms: app.frameStats?.p50Ms ?? null,
					hud: document.getElementById('hud-quality')?.textContent ?? '',
					skin: { ...units.skinStats },
					shadowLod: Array.from(app.ctx.get('render').lodStats.shadowInstances),
					tracks: { ...fx.groundTracks.stats },
					own, ownMoving,
				}
			})
			samples.push({ t: Math.round((Date.now() - t0) / 1000), ...s })
			console.log('MARCH', JSON.stringify(samples[samples.length - 1]))
			await sleep(5000)
		}
		const ms = samples.map(s => s.ms).filter(v => typeof v === 'number' && v > 0).sort((a, b) => a - b)
		const pct = (q) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : null
		const p50 = pct(0.5), p95 = pct(0.95)
		console.log('MARCH-SUMMARY', JSON.stringify({
			p50Ms: p50, p95Ms: p95,
			fpsP50: p50 ? Math.round(1000 / p50) : null,
			fpsP95: p95 ? Math.round(1000 / p95) : null,
			posedMax: Math.max(...samples.map(s => s.skin.posedActors)),
			castersMax: Math.max(...samples.map(s => s.skin.casters ?? -1)),
			shroudCulledMax: Math.max(...samples.map(s => s.skin.shroudCulled ?? -1)),
			stampedMax: Math.max(...samples.map(s => s.tracks.stamped)),
			movingMax: Math.max(...samples.map(s => s.ownMoving)),
			ownMax: Math.max(...samples.map(s => s.own)),
		}))
		await page.screenshot({ path: '/tmp/march-end.webp' })
		await launched.browser.close().catch(() => {})
	} else {
	const key = (k) => page.evaluate((kk) => {
		window.dispatchEvent(new KeyboardEvent('keydown', { key: kk, bubbles: true }))
		window.dispatchEvent(new KeyboardEvent('keyup', { key: kk, bubbles: true }))
	}, k)

	// --- M: tactical map opens, canvas is 5x the minimap -------------------------
	await key('m')
	await sleep(1200)
	const open = await page.evaluate(() => {
		const t = document.getElementById('tactical-map')
		const c = document.getElementById('tactical-canvas')
		const m = document.getElementById('hud-minimap')
		return { hidden: t?.hidden ?? null, big: c ? [c.width, c.height] : null,
			small: m ? [m.width, m.height] : null, display: t ? getComputedStyle(t).display : null }
	})
	console.log('M-OPEN', JSON.stringify(open))
	await page.screenshot({ path: '/tmp/tactical-open.webp' })
	await key('m')
	await sleep(300)
	const closed = await page.evaluate(() => document.getElementById('tactical-map')?.hidden ?? null)
	console.log('M-CLOSED', JSON.stringify(closed))

	// --- N: music toggle (aria-pressed flips on the menu button) -----------------
	const before = await page.evaluate(() => document.getElementById('menu-music')?.getAttribute('aria-pressed'))
	await key('n')
	await sleep(400)
	const after = await page.evaluate(() => document.getElementById('menu-music')?.getAttribute('aria-pressed'))
	console.log('N-MUSIC', JSON.stringify({ before, after }))
	await key('n')

	// --- select-all: Ctrl+A selects troops ---------------------------------------
	const sel = await page.evaluate(async () => {
		const notice = document.getElementById('hud-notice')?.textContent ?? ''
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }))
		await new Promise((r) => setTimeout(r, 120))
		return { notice,
			after: document.getElementById('hud-notice')?.textContent ?? '',
			name: document.getElementById('hud-selection-name')?.textContent ?? '' }
	})
	console.log('SELECT-ALL', JSON.stringify(sel))

	// --- L: 3-second blink --------------------------------------------------------
	await key('l')
	await sleep(1500)
	const flashOn = await page.evaluate(() => ({
		notice: document.getElementById('hud-notice')?.textContent ?? '',
	}))
	await page.screenshot({ path: '/tmp/tactical-flash-mid.webp' })
	await sleep(2400)
	const flashOff = await page.evaluate(() => ({
		notice: document.getElementById('hud-notice')?.textContent ?? '',
	}))
	console.log('L-FLASH', JSON.stringify({ flashOn, flashOff }))

	// --- heat: fog off so everything is visible; open the map for the warm cells --
	await sleep(8000)
	const heat = await page.evaluate(() => {
		const app = globalThis.steelseed
		const ui = app?.ctx?.get('ui')
		const snap = app?.ctx?.snapshot
		const actors = snap?.actors
		const shroud = app?.ctx?.get('shroud')
		const render = snap?.world?.renderPlayer ?? 0
		let enemies = 0, visibleEnemies = 0
		if (actors) for (let i = 0; i < actors.count; i++) {
			if (actors.owner[i] === render) continue
			const cx = Math.floor(actors.posX[i] / 1024)
			enemies++
			const cz = Math.floor(actors.posY[i] / 1024)
			if (shroud?.stateAt(cx, cz) === 2) visibleEnemies++
		}
		return { heatCells: ui?.heatGrid?.size ?? null, enemies, visibleEnemies }
	})
	console.log('HEAT', JSON.stringify(heat))
	await key('m')
	await sleep(1200)
	await page.screenshot({ path: '/tmp/tactical-heat.webp' })
	// Selection persists after the flash expires: the ring left is the green one.
	await key('m')
	await sleep(1200)
	await page.screenshot({ path: '/tmp/tactical-green.webp' })

	}
	await launched.browser.close().catch(() => {})
} finally {
	await stopProcessGroup(server)
}
