#!/usr/bin/env node
/** The announcer's new battle lines, rendered with ElevenLabs into the existing bank voices
 * (owner decision): the per-country timbres the bank's own recent rows already use — the same
 * public v2 premades as tools/gen-shout-voices.mjs and tools/gen-death-voices.mjs. No new voice,
 * no runtime TTS; the original Cartesia announcer rows are left untouched. Two families, one
 * render:
 *
 *   production    training / manufacturing_vehicles / assembling_aircraft / shipbuilding —
 *                 the per-domain word the build pane speaks when its queue starts (ui/index.ts
 *                 PRODUCTION_START_LINES; 'building' already exists in every bank).
 *   battle        our_base_is_under_attack (the phone companion's base shout), and the support
 *                 power fire lines: airborne_coming_in, nuclear_missile_launched,
 *                 chronoshift_engaged, iron_curtain_activated, sonar_pulse_active,
 *                 satellite_launched, recon_plane_inbound, airstrike_inbound.
 *
 * Seven banks, mirroring render-joa-intro-elevenlabs.mjs: allied, soviet, england, france,
 * germany, russia, ukraine. Slugs stay the English concepts; only the spoken language changes.
 * The key comes from the environment or a .env file (the repository root's, or
 * REDLINE_ENV_FILE), is never shipped and never printed. Cached masters are reused by
 * signature; --force regenerates. Existing manifest rows are preserved: this only adds rows.
 *
 *   node tools/render-joa-lines-elevenlabs.mjs            # from web/
 *   node tools/render-joa-lines-elevenlabs.mjs --slug=training
 *   REDLINE_ENV_FILE=/path/.env node tools/render-joa-lines-elevenlabs.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.join(root, '.artifacts/joa-lines-audio')
fs.mkdirSync(out, { recursive: true })
const envPath = process.env.REDLINE_ENV_FILE || path.join(root, '.env')
const env = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {}
// The owner designated the base ELEVENLABS key for bank renders; the others stay as fallbacks.
const key = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS || env.ELEVENLABS2 || env.ELEVENLABS3
const model = 'eleven_multilingual_v2'
// The bank's own per-country timbre, exactly as the bank's recent rows were cast
// (tools/gen-shout-voices.mjs; the soviet bank follows its runtime family, russia).
const BANKS = [
	{ bank: 'allied', voiceId: 'pNInz6obpgDQGcFmaJgB', voiceName: 'Adam', table: 'EN' },
	{ bank: 'soviet', voiceId: 'VR6AewLTigWG4xSOukaG', voiceName: 'Arnold', table: 'RU' },
	{ bank: 'england', voiceId: 'pNInz6obpgDQGcFmaJgB', voiceName: 'Adam', table: 'EN' },
	{ bank: 'france', voiceId: 'ErXwobaYiN019PkySvjV', voiceName: 'Antoni', table: 'FR' },
	{ bank: 'germany', voiceId: 'pNInz6obpgDQGcFmaJgB', voiceName: 'Adam', table: 'DE' },
	{ bank: 'russia', voiceId: 'VR6AewLTigWG4xSOukaG', voiceName: 'Arnold', table: 'RU' },
	{ bank: 'ukraine', voiceId: 'pNInz6obpgDQGcFmaJgB', voiceName: 'Adam', table: 'UK' },
]
// Short, punchy military equivalents — announcer cadence, not literal prose (the bank style).
const EN = {
	training: 'Training',
	manufacturing_vehicles: 'Manufacturing vehicles',
	assembling_aircraft: 'Assembling aircraft',
	shipbuilding: 'Shipbuilding',
	our_base_is_under_attack: 'Our base is under attack',
	airborne_coming_in: 'Airborne, coming in',
	nuclear_missile_launched: 'Nuclear missile launched',
	chronoshift_engaged: 'Chronoshift engaged',
	iron_curtain_activated: 'Iron curtain activated',
	sonar_pulse_active: 'Sonar pulse active',
	satellite_launched: 'Satellite launched',
	recon_plane_inbound: 'Recon plane inbound',
	airstrike_inbound: 'Airstrike inbound',
}
const FR = {
	training: 'Entraînement',
	manufacturing_vehicles: 'Fabrication des véhicules',
	assembling_aircraft: 'Assemblage des aéronefs',
	shipbuilding: 'Construction navale',
	our_base_is_under_attack: 'Notre base est attaquée',
	airborne_coming_in: 'Parachutistes en approche',
	nuclear_missile_launched: 'Missile nucléaire lancé',
	chronoshift_engaged: 'Chronobascule engagée',
	iron_curtain_activated: 'Rideau de fer activé',
	sonar_pulse_active: 'Impulsion sonar active',
	satellite_launched: 'Satellite lancé',
	recon_plane_inbound: 'Avion de reconnaissance en approche',
	airstrike_inbound: 'Frappe aérienne en approche',
}
const DE = {
	training: 'Ausbildung',
	manufacturing_vehicles: 'Fahrzeugproduktion',
	assembling_aircraft: 'Flugzeugmontage',
	shipbuilding: 'Schiffbau',
	our_base_is_under_attack: 'Unsere Basis wird angegriffen',
	airborne_coming_in: 'Fallschirmjäger im Anflug',
	nuclear_missile_launched: 'Atomrakete gestartet',
	chronoshift_engaged: 'Chronoshift aktiv',
	iron_curtain_activated: 'Eiserner Vorhang aktiv',
	sonar_pulse_active: 'Sonarimpuls aktiv',
	satellite_launched: 'Satellit gestartet',
	recon_plane_inbound: 'Aufklärungsflugzeug im Anflug',
	airstrike_inbound: 'Luftschlag im Anflug',
}
const RU = {
	training: 'Подготовка',
	manufacturing_vehicles: 'Производство техники',
	assembling_aircraft: 'Сборка самолётов',
	shipbuilding: 'Судостроение',
	our_base_is_under_attack: 'Наша база под атакой',
	airborne_coming_in: 'Десант на подходе',
	nuclear_missile_launched: 'Ядерная ракета запущена',
	chronoshift_engaged: 'Хроносдвиг активирован',
	iron_curtain_activated: 'Железный занавес активирован',
	sonar_pulse_active: 'Сонарный импульс активен',
	satellite_launched: 'Спутник запущен',
	recon_plane_inbound: 'Самолёт-разведчик на подходе',
	airstrike_inbound: 'Авиаудар на подходе',
}
const UK = {
	training: 'Підготовка',
	manufacturing_vehicles: 'Виробництво техніки',
	assembling_aircraft: 'Збірка літаків',
	shipbuilding: 'Суднобудування',
	our_base_is_under_attack: 'Наша база під атакою',
	airborne_coming_in: 'Десант на підході',
	nuclear_missile_launched: 'Ядерну ракету запущено',
	chronoshift_engaged: 'Хроно зсув активовано',
	iron_curtain_activated: 'Залізна завіса активована',
	sonar_pulse_active: 'Сонарний імпульс активний',
	satellite_launched: 'Супутник запущено',
	recon_plane_inbound: 'Літак-розвідник на підході',
	airstrike_inbound: 'Авіаудар на підході',
}
const TABLES = { EN, FR, DE, RU, UK }
// The base-under-attack shout is the one line that may not sound relaxed.
const URGENT_SLUGS = new Set(['our_base_is_under_attack'])
const slugs = Object.keys(EN)
const force = process.argv.includes('--force')
const onlySlug = (process.argv.find(a => a.startsWith('--slug=')) ?? '').slice(7) || null
const onlyBank = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7) || null
const proofFile = path.join(out, 'generation.json')
const proof = fs.existsSync(proofFile) ? JSON.parse(fs.readFileSync(proofFile, 'utf8')) : { provider: 'ElevenLabs', calls: [] }
Object.assign(proof, { model, slugs, banks: BANKS.map(b => b.bank) })
const sources = [], failures = []
for (const { bank, voiceId, voiceName, table } of BANKS) {
	if (onlyBank && bank !== onlyBank) continue
	for (const slug of slugs) {
		if (onlySlug && slug !== onlySlug) continue
		const transcript = TABLES[table][slug]
		if (!transcript) throw new Error(`no ${table} transcript for ${slug}`)
		const file = path.join(out, `${bank}.${slug}.mp3`)
		const body = { text: transcript, model_id: model, voice_settings: { stability: URGENT_SLUGS.has(slug) ? 0.3 : 0.5, similarity_boost: 0.75 } }
		const signature = createHash('sha256').update(JSON.stringify({ voiceId, body })).digest('hex')
		const previous = proof.calls.findLast(call => call.slug === `${bank}.${slug}` && call.signature === signature && call.status === 'ok')
		if (force || !previous || !fs.existsSync(file)) {
			if (!key) throw new Error('Missing ElevenLabs API key')
			let error = ''
			for (let attempt = 1; attempt <= 2; attempt++) {
				try {
					const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
						method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
					})
					if (!response.ok) throw new Error(`${response.status} ${(await response.text()).replaceAll(key, '[REDACTED]').slice(0, 300)}`)
					fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
					proof.calls.push({ slug: `${bank}.${slug}`, status: 'ok', signature, voiceId, body, attempt,
						characterCost: response.headers.get('character-cost'), requestId: response.headers.get('request-id') })
					error = ''
					break
				} catch (cause) {
					error = String(cause.message ?? cause)
					if (attempt === 1) await new Promise(resolve => setTimeout(resolve, 1500))
				}
			}
			if (error) { proof.calls.push({ slug: `${bank}.${slug}`, status: 'failed', signature, voiceId, body, error }); failures.push({ slug: `${bank}.${slug}`, error }) }
			fs.writeFileSync(proofFile, JSON.stringify(proof, null, 2) + '\n')
		}
		if (failures.some(f => f.slug === `${bank}.${slug}`)) continue
		sources.push({ bank, voiceId, voiceName, slug, file })
	}
	console.log(`Prepared: ${bank}`)
}
if (!sources.length) { console.error(`JOA lines render FAILED:\n${failures.map(f => `  ${f.slug}: ${f.error}`).join('\n')}`); process.exit(1) }
// Stage the whole set before installing, so a failed conversion leaves the live banks intact.
const stage = path.join(out, 'staged')
fs.mkdirSync(stage, { recursive: true })
for (const source of sources) {
	execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', source.file, '-af',
		'silenceremove=start_periods=1:start_duration=0.01:start_threshold=-48dB,highpass=f=75,loudnorm=I=-20:TP=-2:LRA=7,alimiter=limit=0.89:level=false',
		'-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
		path.join(stage, `${source.bank}.${source.slug}.m4a`)], { stdio: 'pipe' })
}
let installed = 0
for (const { bank, slug } of sources) {
	const bankDir = path.join(root, `web/.forge/voices/${bank}`)
	const manifestPath = path.join(bankDir, 'manifest.json')
	const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { schema: 1, bank }
	// Only the new rows change; every existing row and field stays as the bank's own
	// renderer wrote it, so this never rewrites another tool's history.
	manifest.lines = { ...manifest.lines, [slug]: `${slug}.m4a` }
	fs.mkdirSync(bankDir, { recursive: true })
	fs.copyFileSync(path.join(stage, `${bank}.${slug}.m4a`), path.join(bankDir, `${slug}.m4a`))
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n')
	installed++
}
if (failures.length) { console.error(`JOA lines render INCOMPLETE: ${failures.map(f => f.slug).join(', ')}`); process.exitCode = 1 }
console.log(`Installed ${installed} new bank rows across ${new Set(sources.map(s => s.bank)).size} banks.`)
