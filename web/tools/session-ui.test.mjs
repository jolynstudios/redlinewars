// Pre-match UI contracts that no GPU gate sees: markup and source properties of the setup,
// account and multiplayer surfaces, plus the plain-language copy module.
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

const temp = mkdtempSync(join(tmpdir(), 'steelseed-session-ui-'))
const outfile = join(temp, 'copy.mjs')
await build({
	stdin: { contents: "export * from './src/ui/setup-copy.ts'", resolveDir: root, loader: 'ts' },
	bundle: true, platform: 'node', format: 'esm', outfile,
})
const copy = await import(pathToFileURL(outfile).href)
rmSync(temp, { recursive: true, force: true })

test('[hidden] wins over every component display rule', () => {
	// .account-form{display:grid} kept the register form (and, on desktop, the password forms) visible.
	assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/)
})

test('desktop sign-in lives outside the login form it has to hide', () => {
	const form = html.slice(html.indexOf('id="account-login-form"'), html.indexOf('</form>', html.indexOf('id="account-login-form"')))
	assert.ok(form.length > 0, 'login form present')
	assert.doesNotMatch(form, /account-device-login/)
	assert.match(html, /id="account-device-row"[^>]*hidden/)
	assert.match(ui, /accountDeviceRow\.hidden = !this\.desktopAccountAvailable\(\)/)
})

test('multiplayer copy and links are real', () => {
	assert.doesNotMatch(html, /href="\/network"/, '/network answers 404')
	assert.match(ui, /\tS23: '/, 'the no-capacity string exists')
	assert.match(ui, /querySelectorAll\('tr:not\(\[data-room-id\]\)'\)/, 'placeholder rows leave once rooms arrive')
	assert.match(ui, /mpRoomMapTitle\(room\)/, 'the room list shows map titles, not uids')
})

test('engine refusals read as one sentence a player can act on', () => {
	const map = { slots: [{ id: 'Multi0' }, { id: 'Multi1' }] }
	assert.equal(copy.humanizeStartError('duplicate-spawn', "Spawn 1 is selected by more than one player (including 'Multi1').", map),
		'Two players picked spawn 1. Give one of them another spawn, or set it to Random.')
	assert.equal(copy.humanizeStartError('invalid-team', "Slot 'Multi1' has an invalid team.", map),
		'Player 2 has a team this map does not allow. Pick another team.')
	assert.equal(copy.humanizeStartError('locked-option', "Lobby option 'crates' is locked.", map),
		'A match rule is not valid for this map (crates). Reset the match rules and try again.')
	// Unknown codes keep the engine's words (uxgate injects one and looks for it).
	assert.equal(copy.humanizeStartError('witnessed-error', 'witnessed session error', map), 'witnessed session error')
	const refused = new copy.StartRefused('missing-map', 'Choose a skirmish map.')
	assert.equal(refused.code, 'missing-map')
	assert.equal(refused.message, 'missing-map: Choose a skirmish map.')
})

test('near-black presets never become a default colour', () => {
	assert.ok(copy.relativeLuminance('#391D1DFF') < .05)
	assert.ok(copy.relativeLuminance('#200738FF') < .05)
	assert.ok(copy.relativeLuminance('#34BA93FF') > .05)
	assert.ok(Number.isNaN(copy.relativeLuminance('teal')))
	// The catalog carries #RRGGBBAA: the green must be matched on its first six digits.
	assert.match(ui, /c\.slice\(1, 7\)\.toUpperCase\(\) === '34BA93'/)
})

// ---- The war-room console (pre-match redesign) ------------------------------------------
const styleBlock = id => {
	const start = html.indexOf(`<style id="${id}">`)
	return start < 0 ? '' : html.slice(start, html.indexOf('</style>', start))
}

test('the loader keeps every id the shell and the harness gates read', () => {
	for (const id of ['boot', 'boot-bar', 'boot-percent', 'boot-status', 'boot-fail'])
		assert.match(html, new RegExp(`id="${id}"`), `#${id}`)
	assert.match(html, /class="boot-percent-sign"/)
	// The setup is clickable the instant the loader is done (gates click Start during the fade).
	assert.match(styleBlock('rw-boot'), /#boot\.done[^{]*\{[^}]*pointer-events:\s*none/)
})

test('native controls stay the source of truth behind the console', () => {
	assert.match(html, /<select id="session-map"/)
	assert.match(html, /<select id="session-quality"/)
	assert.match(html, /<select id="session-mountains"/)
	assert.match(html, /<select id="session-speed"/)
	assert.match(html, /id="session-tab-skirmish" role="tab"/)
	assert.match(html, /id="session-tab-mp" role="tab"/)
	// Slot rows are the only [data-slot-id] carriers (composedgate queries them globally).
	assert.equal((ui.match(/row\.dataset\.slotId = slot\.id/g) ?? []).length, 1)
	assert.doesNotMatch(html, /data-slot-id=/)
	// Rule selects live in #session-options, where the start config reads them.
	assert.match(ui, /this\.sessionOptions\?\.querySelectorAll<HTMLSelectElement>\('select\[data-field\]'\)/)
})

test('the console keeps the texts and the legal line', () => {
	assert.match(html, /Skirmish · rating eligible/)
	assert.match(html, /EA has not endorsed and does not support this product\./)
	assert.doesNotMatch(html.slice(html.indexOf('<section id="session-ui"'), html.indexOf('</section>', html.indexOf('<section id="session-ui"'))), /Red Alert/)
})

test('the console is light on the GPU and respects reduced motion', () => {
	for (const id of ['rw-boot', 'rw-setup']) {
		const css = styleBlock(id)
		assert.ok(css.length > 0, `${id} exists`)
		assert.doesNotMatch(css, /backdrop-filter/, `${id} sits over a live WebGPU canvas`)
		assert.match(css, /prefers-reduced-motion/, `${id} honours reduced motion`)
	}
})

// ---- Multiplayer as its own destination -------------------------------------------------
test('multiplayer is a destination only while it is switched on', () => {
	// Off, without a developer flag: no tab, no mode nav, and a stale request lands on skirmish.
	assert.match(ui, /private mpEntryVisible\(\): boolean/)
	assert.match(ui, /this\.sessionTabMp\?\.toggleAttribute\('hidden', !mpOn\)/)
	assert.match(ui, /requested === 'mp' && !this\.mpEntryVisible\(\) \? 'skirmish' : requested/)
})

test('the host form keeps what the gates drive in view and collapses the rules', () => {
	const start = html.indexOf('<section id="mp-host-rules"')
	const rules = html.slice(start, html.indexOf('</section>', start))
	assert.match(rules, /id="mp-host-options"/)
	for (const id of ['session-mp-slots', 'session-mp-roomname', 'session-mp-host', 'session-mp-map'])
		assert.doesNotMatch(rules, new RegExp(`id="${id}"`), `#${id} stays outside the collapsed rules`)
	assert.match(ui, /\['session-rules', 'mp-host-rules'\]/)
})

test('no menu offers the debug menu: it stays at the map default, off', () => {
	assert.doesNotMatch(html, /session-developer|>Developer</)
	assert.ok(copy.HIDDEN_OPTIONS.has('cheats'))
	assert.equal(copy.RULE_LABEL.cheats, undefined)
	// Skirmish match rules and the multiplayer host's room rules both skip it, so no start
	// config or room carries a cheats value and the engine keeps its default.
	assert.equal(ui.match(/HIDDEN_OPTIONS\.has\(descriptor\.id\)/g)?.length, 2)
	assert.doesNotMatch(ui, /'cheats'|Debug on|Debug menu on/)
})

test('room rows hold one button and locked rooms ask in a dialog', () => {
	// The relay gates click the first button in the room list: a row's cells are text only.
	assert.match(ui, /cells\[0\]!\.replaceChildren\(span\('room__name'/)
	assert.doesNotMatch(ui, /window\.prompt\(/)
	assert.match(html, /id="mp-password-dialog"/)
	// The lobby keeps the words the gates click.
	for (const text of ['Ready', 'Start match', 'Leave game']) assert.match(ui, new RegExp(`flatButton\\('${text}'`))
	assert.doesNotMatch(styleBlock('rw-online'), /backdrop-filter/)
})

// ---- Desktop affordances, the logo and the map picker --------------------------------------
test('the desktop app leads back to its landing; the browser wordmark goes home', () => {
	assert.match(html, /<button id="session-main-menu" class="cmdbar__back" type="button" hidden>/)
	assert.match(html, /<a id="session-home" class="cmdbar__home" href="https:\/\/www\.redlinewars\.online\/"/)
	assert.match(ui, /typeof \(globalThis as \{ backToMain\?: unknown \}\)\.backToMain === 'function'/)
	assert.match(ui, /private returnToShell\(\): void/)
})

test('the desktop switch and host entry reach the page, and the host dialog is a console dialog', () => {
	assert.match(ui, /shell\.__steelseedSetMultiplayer = \(on: boolean\)/)
	assert.match(ui, /shell\.__steelseedFocusHost = \(\) =>/)
	assert.match(ui, /if \('redline' in window\) return this\.desktopMultiplayerOn\(\) \? 'full' : 'off'/)
	assert.match(ui, /openOverlay\(this\.mpHostDialog,/)
	for (const id of ['mp-host-dialog', 'mp-host-title', 'mp-host-visibility', 'mp-host-vis-lan', 'mp-host-vis-public', 'mp-host-online-note', 'mp-host-players', 'mp-host-password', 'mp-host-create', 'mp-host-cancel'])
		assert.match(html, new RegExp(`id="${id}"`), `#${id} stays`)
})

test('the map name reads as a picker and the native select still takes the click', () => {
	const start = html.indexOf('<div class="map-picker">')
	const picker = html.slice(start, html.indexOf('</div>', start))
	assert.match(picker, /class="map-picker__change"[^>]*>Change map/)
	assert.match(picker, /<select id="session-map"/)
	assert.match(html, /class="map-picker__eyebrow"/)
})

test('browsers join and never host; the multiplayer name follows the account', () => {
	const net = JSON.parse(readFileSync(join(root, 'public/net-config.json'), 'utf8'))
	assert.equal(net.browserMultiplayer, 'join', 'browsers join rooms; only the desktop app hosts')
	assert.match(html, /<div id="session-mp-host-note" class="mp-host-note" hidden>/)
	assert.match(ui, /if \(hostCol\) hostCol\.toggleAttribute\('hidden', mode !== 'full'\)/)
	assert.match(ui, /this\.prefillMpNickname\(user\)/)
	assert.match(ui, /addEventListener\('input', \(\) => \{ this\.mpNameTouched = true \}\)/)
})
