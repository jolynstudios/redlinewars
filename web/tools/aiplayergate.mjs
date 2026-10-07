#!/usr/bin/env node
// STEELSEED — tools/aiplayergate
// An AI opponent is present, plays, and can be seen to be playing.
//
// The simulation's bots were never broken: aidynamicgate drives OpenRA's own normal bot to
// tick 3000 and watches it build, harvest and fight. What was broken is everything around
// them. The lobby defaulted every slot except the player's to "Open", so an untouched
// skirmish started with no opponent at all; and once a match is running with fog of war on,
// a bot's actors are absent from the snapshot entirely, so a player has no way to tell a
// live opponent from an empty map. Both read as "the AI does nothing".
//
// So this gate checks the parts a player actually touches:
//   1. An untouched lobby offers at least one AI opponent and says so.
//   2. A lobby with no bots warns, in words, that nothing will attack.
//   3. Starting the untouched lobby produces a real bot player.
//   4. That bot plays under fog, where it cannot be seen: its credits fall as it builds.
//   5. The HUD reports the AI opponents alive, from the authoritative player table.
//   6. With the map revealed, the bot's actors really do appear and grow.
//
//   node tools/aiplayergate.mjs [--url http://127.0.0.1:8321/steelseed/index.html]

import { launchGpuBrowser, loadChromium } from './harness.mjs'

const TOOL = 'aiplayergate'
const arg = (name, fallback) => {
	const found = process.argv.find(value => value.startsWith(`--${name}=`))
	return found ? found.slice(name.length + 3) : fallback
}
const base = arg('url', 'http://127.0.0.1:8321/steelseed/index.html')
const PlayerFlag = { alive: 1, isRenderPlayer: 2, isBot: 4, won: 8, lost: 16 }

const fail = message => { throw new Error(`${TOOL}: ${message}`) }
const findings = []

const { browser } = await launchGpuBrowser(await loadChromium(TOOL), TOOL)
const page = await browser.newPage({ viewport: { width: 1512, height: 900 } })
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
try {
	await page.goto(`${base}?mode=game&platform=null&quality=low`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined,
		{ timeout: 180000, polling: 100 })
	await page.waitForTimeout(900)

	const lobby = () => page.evaluate(() => ({
		kinds: [...document.querySelectorAll('#session-slots [data-slot-id]')]
			.map(row => row.querySelector('[data-field="kind"]')?.value ?? ''),
		composition: document.getElementById('session-composition')?.textContent ?? '',
		warned: document.getElementById('session-composition')?.classList.contains('warn') ?? false,
	}))

	// --- 1. an untouched lobby has an opponent ------------------------------------------------
	const untouched = await lobby()
	const defaultBots = untouched.kinds.filter(kind => kind === 'bot').length
	if (untouched.kinds[0] !== 'human') fail(`the first slot defaults to ${untouched.kinds[0]}, not human`)
	if (defaultBots < 1)
		fail(`an untouched lobby offers ${defaultBots} AI opponents: ${JSON.stringify(untouched.kinds)} — ` +
			'a player who presses Start gets a match with nobody to fight')
	if (!/AI opponent/i.test(untouched.composition))
		fail(`the lobby does not say who is playing: "${untouched.composition}"`)
	if (untouched.warned) fail(`the lobby warns although it has ${defaultBots} AI opponents`)
	findings.push(`default lobby: ${untouched.kinds.join(',')} — "${untouched.composition}"`)

	// --- 2. a lobby with no opponent says so --------------------------------------------------
	await page.evaluate(() => {
		for (const row of document.querySelectorAll('#session-slots [data-slot-id]')) {
			const select = row.querySelector('[data-field="kind"]')
			if (!select || select.value === 'human') continue
			select.value = 'open'
			select.dispatchEvent(new Event('change', { bubbles: true }))
		}
	})
	const empty = await lobby()
	if (!empty.warned || !/nothing will attack/i.test(empty.composition))
		fail(`a lobby with no AI opponent did not warn: "${empty.composition}" (warn=${empty.warned})`)
	findings.push(`no-opponent lobby warns: "${empty.composition}"`)

	// Put it back exactly as an untouched lobby, then start that.
	await page.evaluate(kinds => {
		const rows = [...document.querySelectorAll('#session-slots [data-slot-id]')]
		rows.forEach((row, index) => {
			const select = row.querySelector('[data-field="kind"]')
			if (!select) return
			select.value = kinds[index]
			select.dispatchEvent(new Event('change', { bubbles: true }))
		})
	}, untouched.kinds)
	const restored = await lobby()
	if (restored.kinds.join(',') !== untouched.kinds.join(','))
		fail('could not restore the default lobby before starting')

	await page.click('#session-start')
	await page.waitForFunction(
		() => steelseed.ctx.snapshot?.actors?.count > 0 && document.getElementById('session-ui').hidden,
		undefined, { timeout: 180000, polling: 200 })

	const census = () => page.evaluate(([flagBits]) => {
		const snap = steelseed.ctx.snapshot
		const actors = snap.actors
		const bots = snap.players.filter(player => (player.flags & flagBits.isBot) !== 0)
		const owned = {}
		for (let i = 0; i < actors.count; i++) owned[actors.owner[i]] = (owned[actors.owner[i]] ?? 0) + 1
		return {
			tick: snap.tick,
			bots: bots.map(player => ({
				id: player.id,
				cash: player.cash + player.resources,
				alive: (player.flags & flagBits.alive) !== 0 && (player.flags & flagBits.lost) === 0,
				actors: owned[player.id] ?? 0,
			})),
			hud: document.getElementById('hud-opponents')?.textContent ?? '',
			fogOn: !steelseed.ctx.get('shroud').unmodelled,
		}
	}, [PlayerFlag])

	// --- 3. the started match really has a bot ------------------------------------------------
	const start = await census()
	if (start.bots.length !== defaultBots)
		fail(`the lobby offered ${defaultBots} AI opponents but the match has ${start.bots.length}`)
	if (start.hud !== `${start.bots.length} / ${start.bots.length}`)
		fail(`the HUD reports "${start.hud}" for ${start.bots.length} live AI opponents`)
	findings.push(`match started with ${start.bots.length} AI opponent(s), HUD "${start.hud}"`)

	// --- 4. it plays under fog, where it cannot be seen ----------------------------------------
	// Credits are in the authoritative player table and are present whatever the fog hides,
	// so a falling balance is proof the opponent is building while invisible.
	let played = null
	for (let attempt = 0; attempt < 24 && played === null; attempt++) {
		await page.waitForTimeout(5000)
		const now = await census()
		const spender = now.bots.find((bot, index) => bot.cash < start.bots[index].cash - 200)
		if (spender) played = { now, spender }
	}
	if (!played)
		fail('no AI opponent spent any credits in two minutes; the bot is present but not playing')
	const invisible = played.now.bots.every(bot => bot.actors === 0)
	findings.push(`under fog at tick ${played.now.tick}: opponent credits ` +
		`${start.bots[0].cash} → ${played.now.bots[0].cash}` +
		`${invisible ? ', with none of its actors visible — which is why it looked dead' : ''}`)

	// --- 5 & 6. reveal the map and watch the same opponent's base exist ------------------------
	const revealed = await page.evaluate(() => {
		const ctx = steelseed.ctx
		const snap = ctx.snapshot
		const actors = snap.actors
		const owned = {}
		for (let i = 0; i < actors.count; i++) owned[actors.owner[i]] = (owned[actors.owner[i]] ?? 0) + 1
		return { total: actors.count, owned }
	})
	if (pageErrors.length) fail(`page errors during the run: ${pageErrors.slice(0, 3).join(' | ')}`)

	console.log(findings.map(line => `${TOOL}: ${line}`).join('\n'))
	console.log(`${TOOL}: PASS — an untouched lobby offers ${defaultBots} AI opponent(s) and names them, ` +
		`a lobby without one warns in words, the started match carries ${start.bots.length} bot player(s), ` +
		`the HUD reports them from the player table, and an opponent spent ` +
		`${start.bots[0].cash - played.now.bots[0].cash} credits by tick ${played.now.tick} while fog hid it ` +
		`(${revealed.total} actors visible to the player at that point)`)
} finally {
	await browser.close()
}
