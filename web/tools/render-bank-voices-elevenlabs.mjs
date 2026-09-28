#!/usr/bin/env node
/** Re-renders the faction announcer banks with ElevenLabs (owner decision: the Cartesia
 * renders are replaced; no provider is called at runtime, and no new voice is created).
 * The bank's own per-country timbres are the same public v2 premades the death, shout and
 * JOA-line renders already use, so after this render every row of a bank speaks with one
 * voice: allied/england/germany/ukraine Adam, france Antoni, russia/soviet Arnold.
 *
 * Slugs stay the English concepts and filenames stay <slug>.m4a, so the game, the manifest
 * and the coverage gate keep their contract. Only the audio and the transcript language of
 * the soviet-family rows change: the phonetic Soviet spellings were a workaround for an
 * English-only Cartesia library, and eleven_multilingual_v2 speaks real Russian.
 *
 * joa_intro is NOT touched: it is the dedicated JOA voice rendered by
 * tools/render-joa-intro-elevenlabs.mjs. The legacy british fallback bank (an older local
 * render, not Cartesia) is not touched either.
 *
 * The existing files are backed up once to .artifacts/cartesia-voice-backup/<bank>/ before
 * the first overwrite; re-runs never overwrite the backup. Masters are cached by signature
 * in .artifacts/bank-voices-elevenlabs/generation.json with character-cost/request-id proof.
 *
 *   node tools/render-bank-voices-elevenlabs.mjs            # from web/
 *   node tools/render-bank-voices-elevenlabs.mjs --slug=building --only=france
 *   REDLINE_ENV_FILE=/path/.env node tools/render-bank-voices-elevenlabs.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.join(root, '.artifacts/bank-voices-elevenlabs')
const backupRoot = path.join(root, '.artifacts/cartesia-voice-backup')
fs.mkdirSync(out, { recursive: true })
const envPath = process.env.REDLINE_ENV_FILE || path.join(root, '.env')
const env = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {}
const key = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS || env.ELEVENLABS2 || env.ELEVENLABS3
const model = 'eleven_multilingual_v2'
const BANKS = [
	{ bank: 'allied', voiceId: 'pNInz6obpgDQGcFmaJgB', voiceName: 'Adam', table: 'EN' },
	{ bank: 'soviet', voiceId: 'VR6AewLTigWG4xSOukaG', voiceName: 'Arnold', table: 'RU' },
	{ bank: 'england', voiceId: 'pNInz6obpgDQGcFmaJgB', voiceName: 'Adam', table: 'EN' },
	{ bank: 'france', voiceId: 'ErXwobaYiN019PkySvjV', voiceName: 'Antoni', table: 'FR' },
	{ bank: 'germany', voiceId: 'pNInz6obpgDQGcFmaJgB', voiceName: 'Adam', table: 'DE' },
	{ bank: 'russia', voiceId: 'VR6AewLTigWG4xSOukaG', voiceName: 'Arnold', table: 'RU' },
	{ bank: 'ukraine', voiceId: 'pNInz6obpgDQGcFmaJgB', voiceName: 'Adam', table: 'UK' },
]
// The 34 announcer concepts, verbatim from the Cartesia tables (joa_intro excluded: it is
// the JOA voice, already ElevenLabs). Real Russian replaces the phonetic Soviet spellings.
const EN = {
	affirmative: 'Affirmative', all_controls_terminated: 'All controls terminated',
	all_systems_nominal: 'All systems nominal', at_your_service: 'At your service',
	attacking: 'Attacking', awaiting_orders: 'Awaiting orders', aye_captain: 'Aye captain',
	battle_concluded: 'Battle concluded', building: 'Building', coming_about: 'Coming about',
	construction_complete: 'Construction complete', crew_aboard_and_ready: 'Crew aboard and ready',
	engaging: 'Engaging', engaging_the_enemy: 'Engaging the enemy', firing_main_guns: 'Firing main guns',
	heavy_armor_reporting: 'Heavy armor reporting', low_power: 'Low power', mission_success: 'Mission success',
	nuclear_bomb_detected: 'Warning. Nuclear bomb detected.',
	movin_out: 'Movin out', moving_out: 'Moving out', moving_out_now: 'Moving out now',
	on_my_way: 'On my way', opening_fire: 'Opening fire', ready_and_waiting: 'Ready and waiting',
	ready_to_move_out: 'Ready to move out', reporting_for_duty: 'Reporting for duty',
	roger_that: 'Roger that', target_confirmed: 'Target confirmed', target_in_range: 'Target in range',
	target_locked: 'Target locked', treads_rolling: 'Treads rolling', unit_lost: 'Unit lost',
	unit_ready: 'Unit ready', welcome_commander: 'Welcome Commander', yes_sir: 'Yes sir',
}
const FR = {
	affirmative: 'Affirmatif', all_controls_terminated: 'Tous les contrôles sont terminés',
	all_systems_nominal: 'Tous les systèmes sont nominaux', at_your_service: 'À votre service',
	attacking: "J'attaque", awaiting_orders: "J'attends les ordres", aye_captain: 'Oui mon capitaine',
	battle_concluded: 'Bataille terminée', building: 'Construction en cours', coming_about: 'Je fais demi-tour',
	construction_complete: 'Construction terminée', crew_aboard_and_ready: 'Équipage à bord et prêt',
	engaging: "J'engage", engaging_the_enemy: "J'engage l'ennemi", firing_main_guns: 'Tir des canons principaux',
	heavy_armor_reporting: 'Blindé lourd en position', low_power: 'Énergie faible', mission_success: 'Mission réussie',
	nuclear_bomb_detected: 'Alerte. Bombe nucléaire détectée.',
	movin_out: 'On bouge', moving_out: 'En mouvement', moving_out_now: 'On bouge maintenant',
	on_my_way: "J'arrive", opening_fire: 'Ouverture du feu', ready_and_waiting: "Prêt et à l'écoute",
	ready_to_move_out: 'Prêt à partir', reporting_for_duty: 'Présent au rapport',
	roger_that: 'Bien reçu', target_confirmed: 'Cible confirmée', target_in_range: 'Cible à portée',
	target_locked: 'Cible verrouillée', treads_rolling: 'Chenilles en marche', unit_lost: 'Unité perdue',
	unit_ready: 'Unité prête', welcome_commander: 'Bienvenue, Commandant', yes_sir: 'Oui monsieur',
}
const DE = {
	affirmative: 'Verstanden', all_controls_terminated: 'Alle Kontrollen beendet',
	all_systems_nominal: 'Alle Systeme nominal', at_your_service: 'Zu Ihren Diensten',
	attacking: 'Angriff', awaiting_orders: 'Warte auf Befehle', aye_captain: 'Jawohl, Hauptmann',
	battle_concluded: 'Schlacht beendet', building: 'Baue', coming_about: 'Ich drehe bei',
	construction_complete: 'Bau abgeschlossen', crew_aboard_and_ready: 'Besatzung an Bord und bereit',
	engaging: 'Feindkontakt', engaging_the_enemy: 'Nehme den Feind auf', firing_main_guns: 'Hauptgeschütze feuern',
	heavy_armor_reporting: 'Schwerer Panzer meldet sich', low_power: 'Energie niedrig', mission_success: 'Mission erfolgreich',
	nuclear_bomb_detected: 'Warnung. Atombombe entdeckt.',
	movin_out: 'Ab durch', moving_out: 'In Bewegung', moving_out_now: 'Jetzt vorwärts',
	on_my_way: 'Bin unterwegs', opening_fire: 'Feuer frei', ready_and_waiting: 'Bereit und warte',
	ready_to_move_out: 'Bereit zum Ausrücken', reporting_for_duty: 'Melde mich zum Dienst',
	roger_that: 'Befehl erhalten', target_confirmed: 'Ziel bestätigt', target_in_range: 'Ziel in Reichweite',
	target_locked: 'Ziel erfasst', treads_rolling: 'Ketten rollen', unit_lost: 'Einheit verloren',
	unit_ready: 'Einheit bereit', welcome_commander: 'Willkommen, Kommandant', yes_sir: 'Jawohl',
}
const RU = {
	affirmative: 'Есть', all_controls_terminated: 'Все системы отключены',
	all_systems_nominal: 'Все системы в норме', at_your_service: 'К вашим услугам',
	attacking: 'Атакую', awaiting_orders: 'Жду приказа', aye_captain: 'Есть, капитан',
	battle_concluded: 'Бой завершён', building: 'Строим', coming_about: 'Разворачиваюсь',
	construction_complete: 'Строительство завершено', crew_aboard_and_ready: 'Экипаж на месте и готов',
	engaging: 'Вступаю в бой', engaging_the_enemy: 'Атакую противника', firing_main_guns: 'Главный калибр, огонь',
	heavy_armor_reporting: 'Тяжёлая броня прибыла', low_power: 'Мало энергии', mission_success: 'Миссия выполнена',
	nuclear_bomb_detected: 'Внимание. Обнаружена ядерная бомба.',
	movin_out: 'Выступаем', moving_out: 'Выдвигаюсь', moving_out_now: 'Выступаю сейчас',
	on_my_way: 'Иду', opening_fire: 'Открываю огонь', ready_and_waiting: 'Готов и жду',
	ready_to_move_out: 'Готов к выдвижению', reporting_for_duty: 'Прибыл на службу',
	roger_that: 'Принято', target_confirmed: 'Цель подтверждена', target_in_range: 'Цель в зоне поражения',
	target_locked: 'Цель захвачена', treads_rolling: 'Гусеницы вращаются', unit_lost: 'Юнит потерян',
	unit_ready: 'Юнит готов', welcome_commander: 'Добро пожаловать, командир', yes_sir: 'Так точно',
}
const UK = {
	affirmative: 'Так точно', all_controls_terminated: 'Управління відключено',
	all_systems_nominal: 'Усі системи в нормі', at_your_service: 'До ваших послуг',
	attacking: 'Атакую', awaiting_orders: 'Чекаю наказу', aye_captain: 'Є, капітане',
	battle_concluded: 'Бій завершено', building: 'Будую', coming_about: 'Розвертаюся',
	construction_complete: 'Будівництво завершено', crew_aboard_and_ready: 'Екіпаж на місці й готовий',
	engaging: 'Вступаю в бій', engaging_the_enemy: 'Атакую противника', firing_main_guns: 'Головний калібр, вогонь',
	heavy_armor_reporting: 'Важка броня прибула', low_power: 'Мало енергії', mission_success: 'Місію виконано',
	nuclear_bomb_detected: 'Увага. Виявлено ядерну бомбу.',
	movin_out: 'Висуваємося', moving_out: 'Висуваюся', moving_out_now: 'Висуваюся',
	on_my_way: 'Іду', opening_fire: 'Відкриваю вогонь', ready_and_waiting: 'Готовий і чекаю',
	ready_to_move_out: 'Готовий до висунення', reporting_for_duty: 'Прибув на службу',
	roger_that: 'Прийнято', target_confirmed: 'Ціль підтверджена', target_in_range: 'Ціль у зоні ураження',
	target_locked: 'Ціль захоплена', treads_rolling: 'Гусениці обертаються', unit_lost: 'Юніт втрачено',
	unit_ready: 'Юніт готовий', welcome_commander: 'Ласкаво просимо, Командире', yes_sir: 'Є, пане',
}
const TABLES = { EN, FR, DE, RU, UK }
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
		const body = { text: transcript, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }
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
if (!sources.length) { console.error(`bank voice render FAILED:\n${failures.map(f => `  ${f.slug}: ${f.error}`).join('\n')}`); process.exit(1) }
// Stage the whole set before installing, so a failed conversion leaves the live banks intact.
const stage = path.join(out, 'staged')
fs.mkdirSync(stage, { recursive: true })
for (const source of sources) {
	execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', source.file, '-af',
		'silenceremove=start_periods=1:start_duration=0.01:start_threshold=-48dB,highpass=f=75,loudnorm=I=-20:TP=-2:LRA=7,alimiter=limit=0.89:level=false',
		'-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
		path.join(stage, `${source.bank}.${source.slug}.m4a`)], { stdio: 'pipe' })
}
let installed = 0, backedUp = 0
for (const { bank, slug } of sources) {
	const bankDir = path.join(root, `web/.forge/voices/${bank}`)
	const manifestPath = path.join(bankDir, 'manifest.json')
	const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { schema: 1, bank }
	// Keep the bank's own filename for the row (the announcer rows are all <slug>.m4a).
	const target = manifest.lines[slug] ?? `${slug}.m4a`
	// One-time backup of the Cartesia master; re-runs must never overwrite the true original.
	const backup = path.join(backupRoot, bank, target)
	if (!fs.existsSync(backup) && fs.existsSync(path.join(bankDir, target))) {
		fs.mkdirSync(path.dirname(backup), { recursive: true })
		fs.copyFileSync(path.join(bankDir, target), backup)
		backedUp++
	}
	fs.mkdirSync(bankDir, { recursive: true })
	fs.copyFileSync(path.join(stage, `${bank}.${slug}.m4a`), path.join(bankDir, target))
	manifest.lines = { ...manifest.lines, [slug]: target }
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n')
	installed++
}
if (failures.length) { console.error(`bank voice render INCOMPLETE: ${failures.map(f => f.slug).join(', ')}`); process.exitCode = 1 }
console.log(`Installed ${installed} ElevenLabs bank rows across ${new Set(sources.map(s => s.bank)).size} banks (${backedUp} Cartesia masters backed up).`)
