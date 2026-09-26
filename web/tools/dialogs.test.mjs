// In-match dialogs in the console language (owner, 2026-09-25): the game menu with Restart
// match between Resume and Return to main, the match result with its facts, players and a
// Main menu button, the copyright sheet without the CC0 base-mesh line, and the rifle shot
// on Start skirmish and Join.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = new URL('..', import.meta.url).pathname
const html = readFileSync(join(root, 'index.html'), 'utf8')
const ui = readFileSync(join(root, 'src/ui/index.ts'), 'utf8')
const block = id => html.slice(html.indexOf(`<style id="${id}">`), html.indexOf('</style>', html.indexOf(`<style id="${id}">`)))
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)))

test('the game menu: Resume, then Restart match, then Return to main menu', () => {
	const menu = between('<div id="game-menu"', '<div id="copyright-modal"')
	const order = ['menu-resume', 'menu-restart', 'menu-main', 'menu-exit', 'menu-music', 'music-vol-down', 'music-vol-up', 'menu-tutorial', 'menu-copyright']
		.map(id => menu.indexOf(`id="${id}"`))
	assert.ok(order.every(at => at > 0), 'every control is in the menu')
	assert.deepEqual([...order].sort((a, b) => a - b), order, 'in reading order')
	assert.match(menu, /class="rw-console"/)
	// Restart is a skirmish thing, confirmed by a second click; a network match hides it.
	assert.match(ui, /if \(this\.menuRestart\) this\.menuRestart\.hidden = this\.mpMatch/)
	assert.match(ui, /row\.dataset\.armed === undefined/)
})

test('the match result: verdict, facts, players, and a way back to the main menu', () => {
	const result = between('<section id="outcome-ui"', '</section>')
	for (const id of ['outcome-mode', 'outcome-title', 'outcome-copy', 'outcome-map', 'outcome-duration', 'outcome-faction', 'outcome-forces', 'outcome-players', 'outcome-settlement', 'outcome-main', 'outcome-restart'])
		assert.match(result, new RegExp(`id="${id}"`), `#${id}`)
	assert.match(ui, /getElementById\('outcome-main'\)\?\.addEventListener\('click', \(\) => this\.returnToMainMenu\(\)\)/)
	// A network match goes back to the rooms, never into a surprise skirmish.
	assert.match(ui, /if \(this\.mpMatch\) void this\.mpLeaveToSession\(\)\n\t\telse this\.startConfiguredSkirmish\(\)/)
	// No invented numbers: the RA player model has no synchronized score.
	assert.doesNotMatch(result, /Score/)
})

test('the copyright sheet drops the base-mesh line; the rest stays', () => {
	const sheet = between('<div class="copyright-body">', '</div>')
	assert.doesNotMatch(sheet, /MakeHuman|Quaternius|ambientCG|Base meshes/)
	assert.match(sheet, /The OpenRA Developers and Contributors/)
	assert.match(sheet, /EA has not endorsed and does not support this product/)
})

test('the dialogs stay calm: no blur over the live canvas, reduced motion honoured', () => {
	const css = block('rw-dialogs')
	assert.ok(css.length > 1000)
	assert.doesNotMatch(css, /backdrop-filter/)
	assert.match(css, /prefers-reduced-motion: reduce/)
	assert.match(css, /:root\[data-motion="reduced"\] \.console-dialog/)
})

test('Start skirmish and Join fire the faction rifle', () => {
	assert.match(ui, /private readonly onSessionStart = \(\): void => \{\n\t\tthis\.fireLaunchShot\(\)/)
	assert.match(ui, /this\.fireLaunchShot\(\)\n\t\t\tvoid this\.joinMpRoom\(current, lanRoom\?\.lanDir\)/)
	assert.match(ui, /const url = bank\?\.fire_rifle/)
	assert.match(ui, /if \(!ui \|\| !ui\.isEnabled\(\)\) return/, 'the interface sound switch still rules')
})
