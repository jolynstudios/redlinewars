#!/usr/bin/env node
// STEELSEED — tools/art-fetch
// Downloads the external art sources recorded in art/sources.lock.json into the ignored
// art/.sources/<id>/ directory and checks every byte against the pinned sha256. Build input
// only: nothing here is committed and nothing is fetched at runtime; the forge bakes these
// files into STEELSEED's own packs. The lock is the provenance record (VISUAL-QUALITY-PLAN.md,
// "Policy"): url, author, licence, hash. A file whose licence is not allowed is never
// downloaded, and a file whose bytes differ from the lock fails the build instead of being
// baked, because a silently changed upstream file is a silently changed licence.
//
//   node tools/art-fetch.mjs              fetch what is missing, verify what is present
//   node tools/art-fetch.mjs --verify     no network: verify present files, list missing ones
//   node tools/art-fetch.mjs --pin        download entries whose sha256 is null, write the hash
//   node tools/art-fetch.mjs --notices    regenerate the generated list in THIRD_PARTY_NOTICES.md
//   --only <id>      limit any mode to one entry
//   --lock <path>    use another lock file (tests)
//   --dir <path>     use another sources directory (tests)
//   --notices-file <path>

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { crc32, inflateRawSync } from 'node:zlib'

export const TOOL = 'art-fetch'
export const GAME_ROOT = resolve(import.meta.dirname, '../..')
export const LOCK_PATH = join(GAME_ROOT, 'art/sources.lock.json')
export const SOURCES_DIR = join(GAME_ROOT, 'art/.sources')
export const NOTICES_PATH = join(GAME_ROOT, 'THIRD_PARTY_NOTICES.md')
export const NOTICES_BEGIN = '<!-- sources:begin -->'
export const NOTICES_END = '<!-- sources:end -->'
export const ALLOWED_LICENSES = ['CC0-1.0', 'CC-BY-4.0']
export const ATTRIBUTION_LICENSES = ['CC-BY-4.0']
/** Project-denied hosts; this is a project policy, not a claim about every vendor licence. */
export const DENIED_HOSTS = [
	'quixel.com', 'megascans.se', 'fab.com', 'unrealengine.com', 'epicgames.com', 'turbosquid.com',
	'cgtrader.com', 'assetstore.unity.com', 'poliigon.com', 'textures.com', 'artstation.com',
	'gumroad.com', 'blendermarket.com', 'superhivemarket.com', 'ea.com',
]
export const ENTRY_KEYS = ['id', 'title', 'author', 'url', 'licenseUrl', 'license', 'use', 'file', 'unpack', 'sha256', 'bytes']
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/
const UNPACK_MARKER = '.unpacked'

export function readLock(path = LOCK_PATH) {
	return JSON.parse(readFileSync(path, 'utf8'))
}

/** Writes the lock with a fixed key order per entry so diffs stay readable. */
export function writeLock(lock, path = LOCK_PATH) {
	const sources = lock.sources.map(entry => Object.fromEntries(ENTRY_KEYS.filter(key => key in entry).map(key => [key, entry[key]])))
	writeFileSync(path, JSON.stringify({ ...lock, sources }, null, 2) + '\n')
}

export function entryDir(entry, root = SOURCES_DIR) { return join(root, entry.id) }
export function entryPath(entry, root = SOURCES_DIR) { return join(entryDir(entry, root), entry.file) }

function hostDenied(url) {
	const host = url.hostname.toLowerCase()
	return DENIED_HOSTS.some(denied => host === denied || host.endsWith(`.${denied}`))
}

/** Field-level problems of one lock entry. Shared with sourcelicensegate so both agree. */
export function entryProblems(entry, policy = { allowedLicenses: ALLOWED_LICENSES }) {
	const problems = []
	const at = entry && typeof entry.id === 'string' ? entry.id : '<entry>'
	if (!entry || typeof entry !== 'object') return [`${at}: entry is not an object`]
	for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) problems.push(`${at}: unknown field "${key}"`)
	if (!ID_PATTERN.test(entry.id ?? '')) problems.push(`${at}: id must match ${ID_PATTERN}`)
	for (const key of ['title', 'author', 'use']) if (typeof entry[key] !== 'string' || !entry[key].trim()) problems.push(`${at}: ${key} is required`)
	if (typeof entry.file !== 'string' || !entry.file || entry.file.includes('/') || entry.file.includes('\\') || entry.file === '..' || entry.file.startsWith('.'))
		problems.push(`${at}: file must be a plain file name`)
	for (const key of ['url', 'licenseUrl']) {
		let url = null
		try { url = new URL(entry[key]) } catch { problems.push(`${at}: ${key} is not a URL`); continue }
		if (url.protocol !== 'https:') problems.push(`${at}: ${key} must be https`)
		if (hostDenied(url)) problems.push(`${at}: ${key} is on a denied host (${url.hostname}): paid, marketplace or single-engine licences are not allowed`)
	}
	const license = typeof entry.license === 'string' ? entry.license : ''
	if (!policy.allowedLicenses.includes(license) || !ALLOWED_LICENSES.includes(license) || /-(NC|ND|SA)\b/i.test(license))
		problems.push(`${at}: licence "${license}" is not allowed; accepted: ${ALLOWED_LICENSES.join(', ')}`)
	if (entry.sha256 != null && !/^[0-9a-f]{64}$/.test(entry.sha256)) problems.push(`${at}: sha256 must be 64 hex characters or null`)
	if (entry.bytes != null && !(Number.isInteger(entry.bytes) && entry.bytes > 0)) problems.push(`${at}: bytes must be a positive integer or null`)
	if ((entry.sha256 == null) !== (entry.bytes == null)) problems.push(`${at}: sha256 and bytes are pinned together`)
	if ('unpack' in entry && typeof entry.unpack !== 'boolean') problems.push(`${at}: unpack must be a boolean`)
	return problems
}

export async function sha256Of(path) {
	const hash = createHash('sha256')
	hash.setEncoding('hex')
	await pipeline(createReadStream(path), hash)
	return hash.read()
}

/** The generated body of THIRD_PARTY_NOTICES.md: one line per source, sorted by id. */
export function renderNotices(lock) {
	const entries = [...lock.sources].sort((a, b) => a.id.localeCompare(b.id))
	if (entries.length === 0) return 'No external art sources are recorded yet.'
	return entries.map(entry => {
		const credit = ATTRIBUTION_LICENSES.includes(entry.license) ? ' (attribution required)' : ''
		return `- ${entry.title} by ${entry.author}, ${entry.license}${credit}, ${entry.url}, licence ${entry.licenseUrl}, used for ${entry.use}.`
	}).join('\n')
}

export function noticesSection(text) {
	const begin = text.indexOf(NOTICES_BEGIN), end = text.indexOf(NOTICES_END)
	if (begin < 0 || end < 0 || end < begin) throw new Error(`${TOOL}: THIRD_PARTY_NOTICES.md lacks the ${NOTICES_BEGIN} / ${NOTICES_END} markers`)
	return { begin: begin + NOTICES_BEGIN.length, end, body: text.slice(begin + NOTICES_BEGIN.length, end).trim() }
}

export function writeNotices(lock, path = NOTICES_PATH) {
	const text = readFileSync(path, 'utf8')
	const { begin, end } = noticesSection(text)
	const next = text.slice(0, begin) + '\n' + renderNotices(lock) + '\n' + text.slice(end)
	if (next !== text) writeFileSync(path, next)
	return next !== text
}

export async function fetchApproved(url, fetcher = fetch) {
	let current = new URL(url)
	const signal = AbortSignal.timeout(120000)
	for (let redirects = 0; redirects <= 5; redirects++) {
		if (current.protocol !== 'https:' || current.username || current.password || hostDenied(current))
			throw new Error(`${TOOL}: refused source URL ${current.origin}: https and project-approved hosts required`)
		const response = await fetcher(current.href, { headers: { 'user-agent': 'steelseed-art-fetch/1 (build-time asset fetch)' }, redirect: 'manual', signal })
		if (![301, 302, 303, 307, 308].includes(response.status)) return response
		const location = response.headers.get('location')
		await response.body?.cancel()
		if (!location) throw new Error(`${TOOL}: redirect lacks Location`)
		current = new URL(location, current)
	}
	throw new Error(`${TOOL}: source redirect limit exceeded`)
}

async function download(url, dest) {
	const response = await fetchApproved(url)
	if (!response.ok || !response.body) throw new Error(`${TOOL}: ${url}: HTTP ${response.status}`)
	mkdirSync(dirname(dest), { recursive: true })
	const part = `${dest}.part`
	await pipeline(Readable.fromWeb(response.body), createWriteStream(part))
	renameSync(part, dest)
}

/**
 * Extracts a zip archive without a CLI dependency: stored and deflate entries, crc checked,
 * no zip64, no path traversal. Returns the written relative paths.
 */
export function zipEntries(archive) {
	const b = readFileSync(archive)
	let eocd = -1
	for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
	if (eocd < 0) throw new Error(`${TOOL}: ${basename(archive)} is not a zip archive`)
	const count = b.readUInt16LE(eocd + 10), directory = b.readUInt32LE(eocd + 16)
	if (count === 0xffff || directory === 0xffffffff) throw new Error(`${TOOL}: ${basename(archive)}: zip64 archives are not supported`)
	const entries = new Map()
	let total = 0
	let p = directory
	for (let n = 0; n < count; n++) {
		if (b.readUInt32LE(p) !== 0x02014b50) throw new Error(`${TOOL}: ${basename(archive)}: damaged central directory`)
		const method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16)
		const compressed = b.readUInt32LE(p + 20), size = b.readUInt32LE(p + 24)
		const nameLength = b.readUInt16LE(p + 28), extraLength = b.readUInt16LE(p + 30), commentLength = b.readUInt16LE(p + 32)
		const local = b.readUInt32LE(p + 42)
		const name = b.toString('utf8', p + 46, p + 46 + nameLength)
		const unixMode = b.readUInt32LE(p + 38) >>> 16
		if ((unixMode & 0xf000) === 0xa000) throw new Error(`${TOOL}: zip symlink rejected: ${name}`)
		p += 46 + nameLength + extraLength + commentLength
		if (name.endsWith('/')) continue
		const segments = name.split('/')
		if (name.startsWith('/') || segments.some(s => s === '' || s === '.' || s === '..' || s.includes('\\') || /^[A-Za-z]:/.test(s)))
			throw new Error(`${TOOL}: ${basename(archive)}: unsafe entry path ${name}`)
		if (name.includes('\0') || name === UNPACK_MARKER || name === basename(archive) || entries.has(name))
			throw new Error(`${TOOL}: reserved or duplicate zip entry ${name}`)
		total += size
		if (total > 512 * 1024 * 1024 || count > 20000) throw new Error(`${TOOL}: zip expansion exceeds build input limit`)
		if (b.readUInt32LE(local) !== 0x04034b50) throw new Error(`${TOOL}: ${basename(archive)}: damaged local header for ${name}`)
		const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28)
		if (start + compressed > directory) throw new Error(`${TOOL}: zip entry outside data region`)
		const raw = b.subarray(start, start + compressed)
		let data
		if (method === 0) data = raw
		else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) })
		else throw new Error(`${TOOL}: ${basename(archive)}: unsupported compression ${method} for ${name}`)
		if (data.length !== size || crc32(data) !== crc) throw new Error(`${TOOL}: ${basename(archive)}: ${name} failed its size or crc check`)
		entries.set(name, data)
	}
	return entries
}

export function unpackZip(archive, outDir) {
	const entries = zipEntries(archive)
	// Validate every path before writing anything; never follow a pre-existing symlink.
	for (const name of entries.keys()) {
		let path = outDir
		for (const segment of ['', ...name.split('/')]) {
			path = join(path, segment)
			if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`${TOOL}: extraction symlink rejected: ${path}`)
		}
		if (existsSync(join(outDir, name))) throw new Error(`${TOOL}: refusing to overwrite extracted source ${name}`)
	}
	for (const [name, data] of entries) {
		const out = join(outDir, name)
		mkdirSync(dirname(out), { recursive: true })
		writeFileSync(out, data)
	}
	return [...entries.keys()]
}

export function unpackMarker(entry, root = SOURCES_DIR) { return join(entryDir(entry, root), UNPACK_MARKER) }

/** Verify against the pinned ZIP itself, never trust an editable extraction marker as proof. */
export function verifyUnpacked(entry, root = SOURCES_DIR) {
	const dir = entryDir(entry, root), archive = entryPath(entry, root)
	if (lstatSync(dir).isSymbolicLink() || lstatSync(archive).isSymbolicLink()) throw new Error(`${TOOL}: source symlink rejected`)
	const bytes = readFileSync(archive)
	if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
		throw new Error(`${TOOL}: archive does not match pinned bytes`)
	const expected = zipEntries(archive), found = new Set()
	const visit = (path, prefix = '') => {
		for (const name of readdirSync(path)) {
			if (!prefix && (name === entry.file || name === UNPACK_MARKER)) continue
			const relative = prefix + name, full = join(path, name), stat = lstatSync(full)
			if (stat.isSymbolicLink()) throw new Error(`${TOOL}: extracted source symlink rejected: ${relative}`)
			if (stat.isDirectory()) { visit(full, `${relative}/`); continue }
			const original = expected.get(relative)
			if (!original) throw new Error(`${TOOL}: unrecorded extracted file ${relative}`)
			if (!readFileSync(full).equals(original)) throw new Error(`${TOOL}: extracted source differs from pinned archive: ${relative}`)
			found.add(relative)
		}
	}
	visit(dir)
	for (const name of expected.keys()) if (!found.has(name)) throw new Error(`${TOOL}: missing extracted source ${name}`)
	return [...expected.keys()]
}

/** Unpacks once; on subsequent builds every extracted byte is checked, with no silent repair. */
export function ensureUnpacked(entry, root = SOURCES_DIR) {
	const marker = unpackMarker(entry, root)
	if (existsSync(marker)) {
		verifyUnpacked(entry, root)
		return false
	}
	const dir = entryDir(entry, root)
	const files = unpackZip(entryPath(entry, root), dir)
	writeFileSync(marker, JSON.stringify({ sha256: entry.sha256, files }, null, 2) + '\n')
	return true
}

function argValue(args, name) {
	const i = args.indexOf(name)
	return i >= 0 ? args[i + 1] : undefined
}

export async function main(argv = process.argv.slice(2)) {
	const mode = argv.includes('--verify') ? 'verify' : argv.includes('--pin') ? 'pin' : argv.includes('--notices') ? 'notices' : 'fetch'
	const only = argValue(argv, '--only')
	const lockPath = argValue(argv, '--lock') ?? LOCK_PATH
	const root = argValue(argv, '--dir') ?? SOURCES_DIR
	const noticesPath = argValue(argv, '--notices-file') ?? NOTICES_PATH
	const lock = readLock(lockPath)
	if (mode === 'notices') {
		const changed = writeNotices(lock, noticesPath)
		console.log(`${TOOL}: notices ${changed ? 'updated' : 'already current'} for ${lock.sources.length} source(s)`)
		return
	}
	const entries = lock.sources.filter(entry => !only || entry.id === only)
	if (only && entries.length === 0) throw new Error(`${TOOL}: no lock entry with id ${only}`)
	let fetched = 0, verified = 0, missing = 0, pinned = 0, unpacked = 0
	for (const entry of entries) {
		const problems = entryProblems(entry, lock.policy)
		if (problems.length) throw new Error(`${TOOL}: refusing ${entry.id ?? '<entry>'}:\n  ${problems.join('\n  ')}`)
		const path = entryPath(entry, root)
		const shown = `${entry.id}/${entry.file}`
		if (entry.sha256 == null) {
			if (mode !== 'pin') { console.log(`${TOOL}: ${shown} is unpinned; run --pin to download and record its hash`); missing++; continue }
			console.log(`${TOOL}: pinning ${shown} from ${entry.url}`)
			await download(entry.url, path)
			entry.sha256 = await sha256Of(path)
			entry.bytes = statSync(path).size
			writeLock(lock, lockPath)
			pinned++
		} else if (!existsSync(path)) {
			if (mode === 'verify') { console.log(`${TOOL}: ${shown} is missing; run art-fetch to download it`); missing++; continue }
			console.log(`${TOOL}: fetching ${shown} from ${entry.url}`)
			await download(entry.url, path)
			fetched++
		}
		const sha = await sha256Of(path)
		if (sha !== entry.sha256 || statSync(path).size !== entry.bytes) {
			const quarantine = `${path}.mismatch`
			renameSync(path, quarantine)
			throw new Error(`${TOOL}: ${shown}: sha256 ${sha} (${statSync(quarantine).size} bytes) does not match the lock (${entry.sha256}, ${entry.bytes} bytes). ` +
				`The upstream file changed or the download is corrupt. Moved to ${basename(quarantine)}; review the new file and its licence before re-pinning.`)
		}
		if (entry.unpack && ensureUnpacked(entry, root)) unpacked++
		verified++
	}
	if (pinned > 0) writeNotices(lock, noticesPath)
	console.log(`${TOOL}: ${mode} — ${verified} verified, ${fetched} fetched, ${pinned} pinned, ${unpacked} unpacked, ${missing} missing of ${entries.length} recorded source(s)`)
	if (missing > 0 && mode !== 'verify') process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	await main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	})
}
