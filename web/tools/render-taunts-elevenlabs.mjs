#!/usr/bin/env node
/** The companion's taunts (src/audio/taunt-lines.json), one voice for every side. Same local
 * ElevenLabs flow as the Jackson bank: the key comes from the environment or a .env file
 * (the repository root's, or REDLINE_ENV_FILE), is never shipped and never printed. Cached
 * masters are reused; --force regenerates. Adam, the commanding American premade, with v3
 * delivery tags per line: a directed stock voice, not an impersonation.
 *
 *   node tools/render-taunts-elevenlabs.mjs            # from web/
 *   REDLINE_ENV_FILE=/path/.env node tools/render-taunts-elevenlabs.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.join(root, '.artifacts/taunt-audio')
fs.mkdirSync(out, { recursive: true })
const envPath = process.env.REDLINE_ENV_FILE || path.join(root, '.env')
const env = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {}
// Jackson's order: ELEVENLABS2 is the proven key on this account.
const key = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS2 || env.ELEVENLABS_API_KEY || env.ELEVENLABS || env.ELEVENLABS3
const voiceId = process.env.TAUNT_ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'
const voiceName = 'Adam'
const model = 'eleven_v3'
const lines = JSON.parse(fs.readFileSync(path.join(root, 'web/src/audio/taunt-lines.json'), 'utf8'))
const slugify = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const proofFile = path.join(out, 'generation.json')
const proof = fs.existsSync(proofFile) ? JSON.parse(fs.readFileSync(proofFile, 'utf8')) : { provider: 'ElevenLabs', calls: [] }
Object.assign(proof, { voiceId, voiceName, model })
const force = process.argv.includes('--force')
const sources = [], failures = []
for (const { text, delivery } of lines) {
	const slug = slugify(text)
	const file = path.join(out, `${slug}.mp3`)
	const body = { text: `${delivery} ${text}`, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.8 } }
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
	sources.push({ slug, file })
	console.log(`Ready: ${slug}`)
}
if (!sources.length) { console.error(`Taunt render FAILED:\n${failures.map(f => `  ${f.slug}: ${f.error}`).join('\n')}`); process.exit(1) }
// Stage the whole bank before installing, so a failed conversion leaves the live bank intact.
const stage = path.join(out, 'staged')
fs.mkdirSync(stage, { recursive: true })
for (const { slug, file } of sources) {
	execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', file, '-af',
		'silenceremove=start_periods=1:start_duration=0.01:start_threshold=-48dB,highpass=f=75,loudnorm=I=-20:TP=-2:LRA=7,alimiter=limit=0.89:level=false',
		'-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', path.join(stage, `${slug}.m4a`)], { stdio: 'pipe' })
}
const bankDir = path.join(root, 'web/.forge/voices/taunts')
fs.mkdirSync(bankDir, { recursive: true })
for (const { slug } of sources) fs.copyFileSync(path.join(stage, `${slug}.m4a`), path.join(bankDir, `${slug}.m4a`))
fs.writeFileSync(path.join(bankDir, 'manifest.json'), JSON.stringify({
	schema: 1, bank: 'taunts', generator: 'render-taunts-elevenlabs.mjs',
	lines: Object.fromEntries(sources.map(({ slug }) => [slug, `${slug}.m4a`])),
}, null, '\t') + '\n')
if (failures.length) { console.error(`Taunt render INCOMPLETE: ${failures.map(f => f.slug).join(', ')}`); process.exitCode = 1 }
console.log(`Installed ${sources.length} taunt lines.`)
