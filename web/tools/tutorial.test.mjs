// First-match tutorial, ready tray, alpha notice and the Classic default: the build order is
// derived from the real RA manifest, the step rules run without a DOM, and the markup keeps the
// contracts the gates rely on (inside #game-ui, no new .hud-item, automation never sees it).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
const html = readFileSync(join(root, 'index.html'), 'utf8')
const ui = readFileSync(join(root, 'src/ui/index.ts'), 'utf8')
const tutorialSource = readFileSync(join(root, 'src/ui/tutorial.ts'), 'utf8') + readFileSync(join(root, 'src/ui/tutorial-steps.ts'), 'utf8')
const actors = JSON.parse(readFileSync(join(root, 'src/core/ra-visual-manifest.json'), 'utf8')).actors

const temp = mkdtempSync(join(tmpdir(), 'steelseed-tutorial-'))
const outfile = join(temp, 'tutorial.mjs')
await build({
	stdin: {
		contents: "export * from './src/ui/build-order.ts'; export * from './src/ui/tutorial-steps.ts'; export { defaultChoiceFor } from './src/core/quality.ts'; export { GRAPHICS_COPY } from './src/ui/setup-copy.ts'",
		resolveDir: root, loader: 'ts',
	},
	bundle: true, platform: 'node', format: 'esm', outfile,
})
const t = await import(pathToFileURL(outfile).href)
rmSync(temp, { recursive: true, force: true })

const types = order => order.core.map(step => step.type)

test('the build order comes from the manifest, per side', () => {
	for (const faction of ['england', 'france', 'germany']) {
		const order = t.beginnerBuildOrder(actors, faction)
		assert.equal(order.side, 'allies', faction)
		assert.deepEqual(types(order), ['powr', 'proc', 'tent', 'weap', 'powr', 'dome'], faction)
	}
	for (const faction of ['russia', 'ukraine']) {
		const order = t.beginnerBuildOrder(actors, faction)
		assert.equal(order.side, 'soviet', faction)
		assert.deepEqual(types(order), ['powr', 'proc', 'barr', 'weap', 'powr', 'dome'], faction)
	}
	const order = t.beginnerBuildOrder(actors, 'england')
	const [plant, refinery, , factory, second] = order.core
	assert.deepEqual([plant.name, plant.cost, plant.power, plant.count], ['Power Plant', 300, 100, 1])
	assert.deepEqual([refinery.name, refinery.cost, refinery.power, refinery.freeUnit], ['Ore Refinery', 1400, -30, 'Ore Truck'])
	assert.deepEqual(refinery.needs, ['Power Plant'])
	assert.deepEqual(factory.needs, ['Ore Refinery'])
	assert.equal(second.count, 2, 'the second Power Plant completes at two plants')
	// The Radar Dome's card tells what its radar reaches, from the rules (16 cells since 2026-09-25).
	const dome = order.core.find(step => step.type === 'dome')
	assert.deepEqual([dome.radar, dome.reveal], [true, 16])
	assert.match(t.purpose(dome), /^Radar: uncovers the ground 16 cells around it, and unlocks /)
	// Water-only yards and the Kennel (a second infantry producer) stay out of the opening.
	for (const faction of ['england', 'russia']) for (const type of ['syrd', 'spen', 'kenn'])
		assert.ok(!types(t.beginnerBuildOrder(actors, faction)).includes(type), `${faction} opening skips ${type}`)
	const later = order.later.map(step => step.type)
	for (const type of ['apwr', 'fix', 'hpad', 'atek']) assert.ok(later.includes(type), `later tier has ${type}`)
	assert.ok(t.beginnerBuildOrder(actors, 'russia').later.some(step => step.type.startsWith('afld')), 'Soviets get the Airfield')
})

test('the opening never runs the power into the red', () => {
	for (const faction of ['england', 'russia']) {
		let supplied = 0
		let drawn = 0
		for (const step of t.beginnerBuildOrder(actors, faction).core) {
			if (step.power > 0) supplied += step.power
			else drawn -= step.power
			assert.ok(drawn <= supplied, `${faction}: ${step.name} leaves ${drawn} drawn of ${supplied}`)
		}
	}
})

test('steps, completion and the live status line', () => {
	const order = t.beginnerBuildOrder(actors, 'england')
	const steps = t.tutorialSteps(order, { multiplayer: false })
	assert.deepEqual(steps.map(step => step.id), ['welcome', 'deploy', 'economy', 'production',
		'build-0', 'build-1', 'build-2', 'build-3', 'build-4', 'build-5', 'power', 'later', 'army', 'minimap', 'controls'])
	assert.equal(steps.find(step => step.id === 'build-0').target, '#hud-queues .hud-item[data-actor-name="powr"]')
	assert.match(t.tutorialSteps(order, { multiplayer: true }).find(step => step.id === 'deploy').body, /Click your Mobile Construction Vehicle/)

	const world = (owned = {}, queue = {}, power = [0, 0]) => ({
		owned: new Map(Object.entries(owned)), queue: new Map(Object.entries(queue)), powerDrawn: power[0], powerSupplied: power[1],
	})
	const item = (fields = {}) => ({ buildable: true, current: false, ready: false, queued: 0, progress: 0, ...fields })
	const deploy = steps.find(step => step.kind === 'deploy')
	assert.equal(t.stepComplete(deploy, world({ fact: 1 })), false, 'an unpacking yard does not count yet')
	assert.equal(t.stepComplete(deploy, world({ fact: 1 }, { powr: item() })), true)

	const plant = steps.find(step => step.id === 'build-0')
	const second = steps.find(step => step.id === 'build-4')
	assert.equal(t.buildStatus(plant, world()).text, 'Deploy your MCV first.')
	assert.equal(t.buildStatus(plant, world({ fact: 1 }, { powr: item() })).state, 'idle')
	assert.equal(t.buildStatus(plant, world({ fact: 1 }, { powr: item({ current: true, progress: 45 }) })).text, 'Building… 45%')
	assert.equal(t.buildStatus(plant, world({ fact: 1 }, { powr: item({ ready: true }) })).state, 'ready')
	assert.equal(t.buildStatus(plant, world({ fact: 1, powr: 1 }, { powr: item() })).state, 'done')
	assert.equal(t.stepComplete(second, world({ powr: 1 }, { powr: item() })), false)
	assert.equal(t.stepComplete(second, world({ powr: 2 }, { powr: item() })), true)
	// Built out of order: the Barracks step is already done when its turn comes.
	assert.equal(t.stepComplete(steps.find(step => step.id === 'build-2'), world({ tent: 1 }, { powr: item() })), true)
	// A structure the queue never offers (tech level) is skipped, but only once the queue exists.
	assert.equal(t.stepUnavailable(steps.find(step => step.id === 'build-5'), world({}, { powr: item() })), true)
	assert.equal(t.stepUnavailable(steps.find(step => step.id === 'build-5'), world()), false)
	assert.equal(t.lowPower(world({}, {}, [120, 100])), true)
})

test('it shows once, can always be skipped, and automation never sees it by itself', () => {
	const store = new Map()
	const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
	assert.equal(t.shouldAutoStart('', false, storage), true)
	t.markTutorialDone(storage)
	assert.equal(store.get('redline-tutorial'), 'done')
	assert.equal(t.shouldAutoStart('', false, storage), false, 'skipped or finished: never again')
	assert.equal(t.shouldAutoStart('?tutorial=on', true, storage), true, '?tutorial=on forces it')
	assert.equal(t.shouldAutoStart('', true, null), false, 'navigator.webdriver: the gates never see it')
	assert.equal(t.shouldAutoStart('?tutorial=off', false, null), false)
	const broken = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
	assert.equal(t.tutorialDone(broken), false)
	assert.doesNotThrow(() => t.markTutorialDone(broken))
	// Every card can end it, and the replay lives in the game menu.
	for (const id of ['tutorial-skip', 'tutorial-close']) assert.match(html, new RegExp(`id="${id}"`))
	assert.match(html, /<button id="menu-tutorial"[^>]*>[\s\S]*?Replay tutorial/)
})

test('the overlay keeps the HUD contracts', () => {
	const gameUi = html.indexOf('<div id="game-ui"')
	const boot = html.indexOf('<div id="boot"')
	for (const id of ['tutorial', 'tutorial-ring', 'hud-ready']) {
		const at = html.indexOf(`id="${id}"`)
		assert.ok(at > gameUi && at < boot, `#${id} lives inside #game-ui (Hide hides it; the gates hide it)`)
	}
	assert.match(html, /#tutorial-ring \{[^}]*pointer-events: none/)
	assert.match(html, /:root\[data-motion="reduced"\] #tutorial, :root\[data-motion="reduced"\] #tutorial-ring/)
	assert.doesNotMatch(tutorialSource, /eva\?\.say|eva\.say/, 'no new announcer lines (voicecoveragegate)')
	// The ready tray never adds .hud-item or data-actor-type buttons: hudgate counts exactly five.
	const tray = ui.slice(ui.indexOf('private syncReadyTray'), ui.indexOf('\n\t}\n', ui.indexOf('private syncReadyTray')))
	assert.doesNotMatch(tray, /hud-item['"\s]|dataset\.actorType/)
	assert.match(ui, /this\.syncProductionDom\(snap\.production, ctx\)\n\t\tthis\.syncReadyTray\(snap\.production, ctx\)\n\t\tthis\.updateTutorial\(snap, ctx, player\)/)
	assert.match(ui, /if \(matchStarting\) this\.maybeStartTutorial\(snap\)/)
})

test('the loader says alpha and points at the public issue tracker', () => {
	assert.match(html, /<p class="boot-alpha"[^>]*><span class="boot-alpha__tag">Alpha<\/span>[\s\S]*?<a href="https:\/\/github\.com\/jolynstudios\/redlinewars\/issues" target="_blank" rel="noopener">/)
})

test('Classic by default on a strong GPU, Dynamic elsewhere; the settings say what Dynamic does', () => {
	assert.equal(t.defaultChoiceFor('high'), 'classic')
	assert.equal(t.defaultChoiceFor('medium'), 'dynamic', 'Classic froze the menu on a weak GPU')
	assert.equal(t.defaultChoiceFor('low'), 'dynamic')
	assert.match(t.GRAPHICS_COPY.classic, /default on a strong graphics card/)
	assert.match(t.GRAPHICS_COPY.classic, /Dynamic/)
	assert.match(t.GRAPHICS_COPY.dynamic, /automatically/)
	assert.match(t.GRAPHICS_COPY.dynamic, /perform/)
})
