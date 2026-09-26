#!/usr/bin/env node
// The hardware-picked default (Classic on a strong GPU, else Dynamic) is shared by Skirmish and Multiplayer. Explicit URL and stored
// choices must remain truthful, including browsers that block localStorage.
import assert from 'node:assert/strict'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'

let preview
let browser
try {
	preview = await startPrivateComposed(8496)
	;({ browser } = await launchGpuBrowser(await loadChromium('qualitydefaultgate'), 'qualitydefaultgate'))

	const boot = async (context, suffix = '') => {
		const page = await context.newPage()
		await page.goto(`${preview.baseUrl}&debug=on${suffix}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(() => {
			const select = document.getElementById('session-quality')
			return globalThis.steelseed && globalThis.steelseedQuality && select instanceof HTMLSelectElement && select.options.length > 0
		}, undefined, { timeout: 180000, polling: 250 })
		return page
	}

	const freshContext = await browser.newContext()
	const fresh = await boot(freshContext)
	const firstBoot = await fresh.evaluate(() => ({
		choice: globalThis.steelseedQuality.choice,
		reason: globalThis.steelseedQuality.reason,
		selector: document.getElementById('session-quality').value,
		mountains: document.getElementById('session-mountains').value,
		apron: globalThis.steelseed.config.distantMountains,
	}))
	assert.ok(['classic', 'dynamic'].includes(firstBoot.choice), `hardware-picked default, got ${firstBoot.choice}`)
	assert.equal(firstBoot.choice === 'classic', /^Classic: strong GPU/.test(firstBoot.reason), 'Classic only where the GPU rates high')
	assert.deepEqual({ selector: firstBoot.selector, mountains: firstBoot.mountains, apron: firstBoot.apron }, { selector: firstBoot.choice, mountains: 'off', apron: false })
	await fresh.click('#session-tab-mp')
	assert.equal(await fresh.locator('#session-quality').inputValue(), firstBoot.choice, 'Multiplayer shares the default')
	await freshContext.close()

	const urlContext = await browser.newContext()
	await urlContext.addInitScript(() => localStorage.setItem('steelseed.quality', 'high'))
	const urlPage = await boot(urlContext, '&quality=low')
	assert.deepEqual(await urlPage.evaluate(() => ({
		choice: globalThis.steelseedQuality.choice,
		selector: document.getElementById('session-quality').value,
	})), { choice: 'low', selector: 'low' }, 'URL override is reflected in the selector')
	await urlContext.close()

	const detectContext = await browser.newContext()
	await detectContext.addInitScript(() => localStorage.setItem('steelseed.quality', 'detect'))
	const detect = await boot(detectContext)
	assert.equal(await detect.locator('#session-quality').inputValue(), 'detect', 'explicit Detect persists')
	await detectContext.close()

	const mountainContext = await browser.newContext()
	const mountainPage = await boot(mountainContext, '&quality=ultra-max&mountains=on')
	assert.deepEqual(await mountainPage.evaluate(() => ({
		selector: document.getElementById('session-mountains').value,
		enabled: globalThis.steelseed.config.distantMountains,
	})), { selector: 'on', enabled: true }, 'explicit mountain switch reaches Ultra Max')
	await mountainContext.close()

	const blockedContext = await browser.newContext()
	await blockedContext.addInitScript(() => {
		Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError') }
	})
	const blocked = await boot(blockedContext)
	// Graphics lives in the Settings sheet of the pre-match console; open it like a player.
	await blocked.click('#session-settings-open')
	await blocked.locator('#session-quality').waitFor({ state: 'visible' })
	// The UI deliberately ignores synthetic changes until the player interacts.
	await blocked.locator('#session-quality').dispatchEvent('pointerdown')
	await blocked.selectOption('#session-quality', 'low')
	await blocked.waitForFunction(() => new URL(location.href).searchParams.get('quality') === 'low', undefined, { timeout: 60000 })
	await blocked.waitForFunction(() => document.getElementById('session-quality')?.value === 'low', undefined, { timeout: 180000 })
	assert.equal(new URL(blocked.url()).searchParams.get('quality'), 'low', 'URL retains choice when storage is blocked')
	await blockedContext.close()

	console.log(`qualitydefaultgate PASS — ${firstBoot.choice} by default here (Classic on a strong GPU, else Dynamic) in both modes; overrides and blocked-storage fallback are stable`)
} finally {
	await browser?.close()
	await preview?.close?.()
}
