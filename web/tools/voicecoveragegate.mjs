#!/usr/bin/env node
// Every acknowledgement the audio layer can select must resolve to a bundled recording.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const web = resolve(import.meta.dirname, '..')
const root = resolve(web, '..')
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const eva = readFileSync(join(web, 'src/audio/eva.ts'), 'utf8')
const spy = JSON.parse(readFileSync(join(web, 'src/audio/spy-lines.json')))
const jackson = JSON.parse(readFileSync(join(web, 'src/audio/jackson-lines.json')))
const banksRoot = join(web, '.forge/voices')
const audioBundle = readdirSync(join(web, 'dist/assets'))
	.find(name => name.startsWith('steelseed-audio-') && name.endsWith('.js'))
assert.ok(audioBundle, 'clean web/dist is absent')
const audioBundleSource = readFileSync(join(web, 'dist/assets', audioBundle), 'utf8')
assert.ok(audioBundleSource.includes('.forge/voices/england/moving_out.m4a'),
	'moving_out was not admitted to the production voice URL table')
assert.doesNotMatch(eva, /SpeechSynthesis|speechSynthesis/,
	'runtime speech synthesis is forbidden: a failed recording must go silent, never robotic')
assert.doesNotMatch(audioBundleSource, /SpeechSynthesis|speechSynthesis/,
	'production audio bundle still contains the browser speech-synthesis fallback')

function table(name) {
	const match = new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\]`).exec(eva)
	assert.ok(match, `Eva table ${name} was not found`)
	return [...match[1].matchAll(/'([^']+)'/g)].map(match => match[1])
}

const generic = [...table('UNIT_SELECT'), ...table('UNIT_MOVE'), ...table('UNIT_ATTACK')].map(slug)
const tanya = {
	select: ['Locked and loaded', 'Give me a target', 'You called?', 'Ready to dance'],
	move: ['You got it', 'On my way', 'Making moves', 'Moving'],
	attack: ['Consider it done', 'Say goodnight', 'Nothing personal', 'Lights out', 'Too easy', "Got 'em"],
}
const persona = [...Object.values(tanya), ...Object.values(spy), ...Object.values(jackson)].flat().map(slug)
const ui = readFileSync(join(web, 'src/ui/index.ts'), 'utf8')
const uiEvents = [...ui.matchAll(/eva\.say\('([^']+)'/g)].map(match => slug(match[1]))
// The announcer lines the UI speaks through tables instead of literal eva.say calls: the
// per-domain production start words, and each support power's fire line.
const productionLines = [...ui.matchAll(/PRODUCTION_START_LINES[^=]*=\s*\[([^\]]*)\]/g)][0]?.[1] ?? ''
assert.ok(productionLines, 'PRODUCTION_START_LINES table was not found')
const supportFn = ui.slice(ui.indexOf('function supportPowerVoiceLine'), ui.indexOf('function supportPowerVoiceLine') + 1200)
assert.ok(supportFn.includes('return'), 'supportPowerVoiceLine was not found')
const tableLines = [
	...productionLines.matchAll(/'([^']+)'/g),
	...supportFn.matchAll(/return '([^']+)'/g),
].map(match => slug(match[1]))
// The companion's own bank slugs: order acknowledgements plus the alert shouts.
const companion = readFileSync(join(web, 'src/companion/main.ts'), 'utf8')
const acksHead = companion.indexOf('const ACKS')
const companionAcks = companion.slice(acksHead, acksHead + 600).replace(/^[^=]*=\s*/, '')
assert.ok(companionAcks.includes('attack:'), 'companion ACKS table was not found')
const companionSlugs = [
	...companionAcks.matchAll(/:\s*'([^']+)'/g),
	...companion.matchAll(/\bshout\('([^']+)'\)/g),
].map(match => slug(match[1]))
const required = [...new Set([...generic, ...persona, ...uiEvents])]
assert.ok(required.includes('moving_out'), 'heavy vehicle moving acknowledgement changed; update this gate')
const bankedLines = [...new Set([...tableLines, ...companionSlugs])]
assert.ok(bankedLines.includes('training') && bankedLines.includes('our_base_is_under_attack')
	&& bankedLines.includes('airborne_coming_in'), 'the JOA announcer line families changed; update this gate')

const genericBanks = readdirSync(banksRoot, { withFileTypes: true })
	.filter(entry => entry.isDirectory())
	.map(entry => entry.name)
	.filter(name => ['allied', 'british', 'england', 'france', 'germany', 'russia', 'soviet', 'ukraine'].includes(name))
assert.equal(genericBanks.length, 8, 'one or more faction voice banks is absent')
for (const bank of genericBanks) {
	const manifest = JSON.parse(readFileSync(join(banksRoot, bank, 'manifest.json')))
	assert.equal(manifest.bank, bank)
	for (const line of generic) {
		const file = manifest.lines[line]
		assert.ok(file, `${bank}: ${line} has no recorded audio mapping`)
		assert.ok(existsSync(join(banksRoot, bank, file)) && readFileSync(join(banksRoot, bank, file)).length > 1024,
			`${bank}: ${file} is absent or empty`)
	}
}
for (const [bank, lines] of [['tanya', Object.values(tanya).flat().map(slug)], ['spy', Object.values(spy).flat().map(slug)], ['jackson', Object.values(jackson).flat().map(slug)]]) {
	const manifest = JSON.parse(readFileSync(join(banksRoot, bank, 'manifest.json')))
	for (const line of lines) {
		const file = manifest.lines[line]
		assert.ok(file, `${bank}: ${line} has no recorded audio mapping`)
		assert.ok(existsSync(join(banksRoot, bank, file)) && readFileSync(join(banksRoot, bank, file)).length > 1024,
			`${bank}: ${file} is absent or empty`)
	}
}
// The modern bank set: the six runtime speakers plus the soviet family bank. The older
// macOS `say` british render stays a fallback of a fallback and keeps only the generic rows.
const joaBanks = ['allied', 'soviet', 'england', 'france', 'germany', 'russia', 'ukraine']
for (const bank of joaBanks) {
	const manifest = JSON.parse(readFileSync(join(banksRoot, bank, 'manifest.json')))
	for (const line of bankedLines) {
		const file = manifest.lines[line]
		assert.ok(file, `${bank}: ${line} has no recorded audio mapping`)
		assert.ok(existsSync(join(banksRoot, bank, file)) && readFileSync(join(banksRoot, bank, file)).length > 1024,
			`${bank}: ${file} is absent or empty`)
	}
}
assert.ok(audioBundleSource.includes('.forge/voices/germany/our_base_is_under_attack.m4a'),
	'the JOA announcer rows were not admitted to the production voice URL table; rebuild web/dist')
console.log(`voicecoveragegate: PASS ${required.length} recorded concepts, 8 full faction banks, Riki, spy and Jackson personas, ${bankedLines.length} JOA announcer lines across ${joaBanks.length} banks; browser TTS is absent from source and production`)
