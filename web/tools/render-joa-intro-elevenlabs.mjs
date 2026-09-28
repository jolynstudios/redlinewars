#!/usr/bin/env node
/** The JOA introduction, spoken by JOA's own voice in the announcer's five languages: the
 * prepared seven-bank concept (the same transcripts render-voices-cartesia.mjs --slug=joa_intro
 * --dry-run lists), rendered with ElevenLabs instead. One voice for every bank, deliberately:
 * JOA is one assistant, and it greets the commander in the language the announcer already
 * speaks. Adam, the calm American premade, eleven_v3, one delivery direction for all seven.
 *
 * The key comes from the environment or a .env file (the repository root's, or
 * REDLINE_ENV_FILE), is never shipped and never printed; the owner named the account's base
 * ELEVENLABS key for this render, so it leads the chain. Cached masters are reused by
 * signature; --force regenerates. Existing manifest rows are preserved: this only adds the
 * joa_intro row eva.ts already prefers over welcome_commander.
 *
 *   node tools/render-joa-intro-elevenlabs.mjs            # from web/
 *   REDLINE_ENV_FILE=/path/.env node tools/render-joa-intro-elevenlabs.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.join(root, '.artifacts/joa-intro-audio')
fs.mkdirSync(out, { recursive: true })
const envPath = process.env.REDLINE_ENV_FILE || path.join(root, '.env')
const env = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {}
// The owner designated the base ELEVENLABS key for this render; the others stay as fallbacks.
const key = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS || env.ELEVENLABS2 || env.ELEVENLABS3
const voiceId = process.env.JOA_ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'
const voiceName = 'Adam'
const model = 'eleven_v3'
const delivery = '[calm] [professional]'
const jobs = [
	{ bank: 'allied', language: 'en', transcript: 'Welcome, Commander. I am JOA, your Joint Operations Assistant. At your service.' },
	{ bank: 'soviet', language: 'en', transcript: 'Welcome, Commander. I am JOA, your Joint Operations Assistant. At your service.' },
	{ bank: 'england', language: 'en', transcript: 'Welcome, Commander. I am JOA, your Joint Operations Assistant. At your service.' },
	{ bank: 'france', language: 'fr', transcript: 'Bienvenue, Commandant. Je suis JOA, votre assistant aux opérations conjointes. À votre service.' },
	{ bank: 'germany', language: 'de', transcript: 'Willkommen, Kommandant. Ich bin JOA, Ihr Assistent für gemeinsame Operationen. Zu Ihren Diensten.' },
	{ bank: 'russia', language: 'ru', transcript: 'Добро пожаловать, командир. Я JOA, ваш помощник по совместным операциям. К вашим услугам.' },
	{ bank: 'ukraine', language: 'uk', transcript: 'Ласкаво просимо, командире. Я JOA, ваш помічник зі спільних операцій. До ваших послуг.' },
]
const proofFile = path.join(out, 'generation.json')
const proof = fs.existsSync(proofFile) ? JSON.parse(fs.readFileSync(proofFile, 'utf8')) : { provider: 'ElevenLabs', calls: [] }
Object.assign(proof, { voiceId, voiceName, model, delivery })
const force = process.argv.includes('--force')
const sources = [], failures = []
for (const { bank, language, transcript } of jobs) {
	const slug = `${bank}.joa_intro`
	const file = path.join(out, `${slug}.mp3`)
	const body = { text: `${delivery} ${transcript}`, model_id: model, language_code: language === 'en' ? undefined : language, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }
	const signature = createHash('sha256').update(JSON.stringify({ voiceId, body })).digest('hex')
	const previous = proof.calls.findLast(call => call.slug === slug && call.signature === signature && call.status === 'ok')
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
				proof.calls.push({ slug, status: 'ok', signature, voiceId, body, attempt,
					characterCost: response.headers.get('character-cost'), requestId: response.headers.get('request-id') })
				error = ''
				break
			} catch (cause) {
				error = String(cause.message ?? cause)
				if (attempt === 1) await new Promise(resolve => setTimeout(resolve, 1500))
			}
		}
		if (error) { proof.calls.push({ slug, status: 'failed', signature, voiceId, body, error }); failures.push({ slug, error }) }
		fs.writeFileSync(proofFile, JSON.stringify(proof, null, 2) + '\n')
	}
	if (failures.some(f => f.slug === slug)) continue
	sources.push({ bank, language, file })
	console.log(`Ready: ${slug}`)
}
if (!sources.length) { console.error(`JOA intro render FAILED:\n${failures.map(f => `  ${f.slug}: ${f.error}`).join('\n')}`); process.exit(1) }
// Stage the whole set before installing, so a failed conversion leaves the live banks intact.
const stage = path.join(out, 'staged')
fs.mkdirSync(stage, { recursive: true })
for (const { bank, file } of sources) {
	execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', file, '-af',
		'silenceremove=start_periods=1:start_duration=0.01:start_threshold=-48dB,highpass=f=75,loudnorm=I=-20:TP=-2:LRA=7,alimiter=limit=0.89:level=false',
		'-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', path.join(stage, `${bank}.joa_intro.m4a`)], { stdio: 'pipe' })
}
for (const { bank } of sources) {
	const bankDir = path.join(root, `web/.forge/voices/${bank}`)
	const manifestPath = path.join(bankDir, 'manifest.json')
	const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { schema: 1, bank }
	// Only the one new row changes; every existing row and field stays as the bank's own
	// renderer wrote it, so this never rewrites another tool's history.
	manifest.lines = { ...manifest.lines, joa_intro: 'joa_intro.m4a' }
	fs.mkdirSync(bankDir, { recursive: true })
	fs.copyFileSync(path.join(stage, `${bank}.joa_intro.m4a`), path.join(bankDir, 'joa_intro.m4a'))
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n')
}
if (failures.length) { console.error(`JOA intro render INCOMPLETE: ${failures.map(f => f.slug).join(', ')}`); process.exitCode = 1 }
console.log(`Installed joa_intro into ${sources.length} banks.`)
