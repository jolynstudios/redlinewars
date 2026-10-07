// Throwaway: boot the dev world in the GPU browser and screenshot the page.
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
const port = Number(process.argv[2] ?? 4187)
const quality = process.argv[3] ?? 'classic'

	// The AppBundle engine server, not vite preview: a match needs the WASM host, and
	// session.available only ever fires against it (vite preview has no engine host).
	const engineRoot = resolve(WEB, '../engine')
	const server = spawnProcessGroup(process.execPath, [join(engineRoot, 'OpenRA.Browser/tests/server.mjs'),
		'--root', join(engineRoot, 'bin-browser/AppBundle'), '--port', String(port)],
		{ cwd: engineRoot, stdio: ['ignore', 'pipe', 'pipe'] })
	try {
		const baseUrl = `http://127.0.0.1:${port}/steelseed/index.html`
		await waitForServer(baseUrl, 20000, server)
	const chromium = await loadChromium(TOOL)
	const launched = await launchGpuBrowser(chromium, TOOL)
	const browser = launched.browser
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
	await page.goto(`${baseUrl}?mode=game&platform=null&quality=${quality}`, { waitUntil: 'load', timeout: 90000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 200 })
	if (process.env.WITH_MATCH) {
		// The proven match boot (mirrors .tactical-probe.mjs): a real skirmish, not the
		// dev fixture - the dev URL keeps the lobby attached and the canvas at 300x150.
		await new Promise(r => setTimeout(r, 900))
		await page.evaluate(() => {
			// 'False' is the engine's option value; 'off' silently matches nothing.
			const fog = [...document.querySelectorAll('select')].find(s => /fog/i.test(s.id) || /fog/i.test(s.closest('label')?.textContent ?? ''))
			if (fog) { fog.value = 'False'; fog.dispatchEvent(new Event('change', { bubbles: true })) }
			const b = document.getElementById('session-start')
			if (b && !b.disabled) b.click()
			else console.log('START-STILL-DISABLED')
		})
		await page.waitForFunction(() => {
			const s = globalThis.steelseed
			return s?.ctx?.snapshot?.actors?.count > 0 && document.getElementById('session-ui')?.hidden
		}, undefined, { timeout: 180000, polling: 500 }).catch(e => console.log('match-wait:', String(e).slice(0, 80)))
		await new Promise(r => setTimeout(r, 30000))
	}
	await new Promise(r => setTimeout(r, 6000))
	const state = await page.evaluate(() => {
		const canvas = document.querySelector('canvas')
		return { canvas: canvas ? [canvas.width, canvas.height] : null }
	})
	const out = process.argv[4] ?? `/tmp/worldshot-${quality}.webp`
	await page.screenshot({ path: out })
	console.log('SHOT', JSON.stringify({ state, out }))
	await launched.browser.close().catch(() => {})
} finally {
	await stopProcessGroup(server)
}
