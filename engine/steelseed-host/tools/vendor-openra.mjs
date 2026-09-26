#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const TOOL = 'vendorgate'
const hostRoot = resolve(import.meta.dirname, '..')
const engineRoot = resolve(hostRoot, '..')
const vendorRoot = resolve(engineRoot, 'openra')
const policyPath = resolve(vendorRoot, 'vendor-policy.json')
const lockPath = resolve(vendorRoot, 'provenance.lock.json')
const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
const expectedCommit = policy.commit
const sourceArg = process.argv.find(arg => arg.startsWith('--source='))
const sourceRoot = sourceArg ? resolve(sourceArg.slice('--source='.length)) : null
const writeVendor = process.argv.includes('--vendor')
const writeLock = process.argv.includes('--write-lock')
const rejectedAuthors = new Set(policy.mapExtraction.rejectAuthors)

function fail(message) {
	throw new Error(`${TOOL}: ${message}`)
}

/** The map's credited author that the policy rejects, or null. */
function rejectedAuthor(mapYaml) {
	const credit = /^Author:[ \t]*(.*)$/m.exec(mapYaml)?.[1] ?? ''
	return credit.split(/[,/]/).map(part => part.trim()).find(part => rejectedAuthors.has(part)) ?? null
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex')
}

function git(args, options = {}) {
	if (!sourceRoot) fail('--source=<OpenRA-Web worktree> is required for this operation')
	return execFileSync('git', ['-C', sourceRoot, ...args], {
		encoding: options.binary ? null : 'utf8',
		maxBuffer: 256 * 1024 * 1024,
	})
}

function upstreamBytes(path) {
	return git(['show', `${expectedCommit}:${path}`], { binary: true })
}

function upstreamFiles(prefix) {
	const output = git(['ls-tree', '-r', '--name-only', '-z', expectedCommit, prefix])
	return output.split('\0').filter(Boolean).sort()
}

function ensureTargetCommit() {
	git(['cat-file', '-e', `${expectedCommit}^{commit}`])
	const commit = git(['rev-parse', expectedCommit]).trim()
	if (commit !== expectedCommit) fail(`resolved commit ${commit}, expected ${expectedCommit}`)
}

function statusFingerprint() {
	const status = git(['status', '--porcelain=v1', '-z'], { binary: true })
	return { bytes: status, sha256: sha256(status) }
}

function parseZip(bytes, label) {
	let eocd = -1
	const floor = Math.max(0, bytes.length - 65557)
	for (let i = bytes.length - 22; i >= floor; i--) {
		if (bytes.readUInt32LE(i) === 0x06054b50) {
			eocd = i
			break
		}
	}
	if (eocd < 0) fail(`${label} has no ZIP end-of-central-directory record`)
	const entryCount = bytes.readUInt16LE(eocd + 10)
	let cursor = bytes.readUInt32LE(eocd + 16)
	const entries = new Map()
	for (let index = 0; index < entryCount; index++) {
		if (bytes.readUInt32LE(cursor) !== 0x02014b50)
			fail(`${label} has an invalid central directory at entry ${index}`)
		const method = bytes.readUInt16LE(cursor + 10)
		const compressedSize = bytes.readUInt32LE(cursor + 20)
		const uncompressedSize = bytes.readUInt32LE(cursor + 24)
		const nameLength = bytes.readUInt16LE(cursor + 28)
		const extraLength = bytes.readUInt16LE(cursor + 30)
		const commentLength = bytes.readUInt16LE(cursor + 32)
		const localOffset = bytes.readUInt32LE(cursor + 42)
		const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
		if (name.includes('..') || name.startsWith('/') || name.includes('\\'))
			fail(`${label} contains unsafe ZIP entry '${name}'`)
		if (bytes.readUInt32LE(localOffset) !== 0x04034b50)
			fail(`${label}:${name} has an invalid local header`)
		const localNameLength = bytes.readUInt16LE(localOffset + 26)
		const localExtraLength = bytes.readUInt16LE(localOffset + 28)
		const dataOffset = localOffset + 30 + localNameLength + localExtraLength
		const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize)
		const data = method === 0 ? Buffer.from(compressed)
			: method === 8 ? inflateRawSync(compressed)
				: fail(`${label}:${name} uses unsupported ZIP method ${method}`)
		if (data.length !== uncompressedSize)
			fail(`${label}:${name} expanded to ${data.length}, expected ${uncompressedSize}`)
		entries.set(name, data)
		cursor += 46 + nameLength + extraLength + commentLength
	}
	return entries
}

function writeExact(path, bytes) {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, bytes)
}

function vendorGameplayText() {
	const files = []
	for (const source of policy.sourceLayout.redAlertGameplayText) {
		if (extname(source)) files.push(source)
		else files.push(...upstreamFiles(source))
	}
	for (const source of [...new Set(files)].sort())
		writeExact(resolve(vendorRoot, source), upstreamBytes(source))
	return files.length
}

function vendorCore() {
	const files = [...new Set(policy.sourceLayout.core.flatMap(source => upstreamFiles(source)))].sort()
	for (const source of files)
		writeExact(resolve(vendorRoot, source), upstreamBytes(source))
	return files.length
}

function vendorMaps() {
	const mapSources = upstreamFiles('mods/ra/maps').filter(path => path.endsWith('.oramap'))
	const mapsRoot = resolve(vendorRoot, 'mods/ra/maps')
	if (existsSync(mapsRoot)) rmSync(mapsRoot, { recursive: true, force: true })
	mkdirSync(mapsRoot, { recursive: true })
	const records = []
	const accepted = [...policy.mapExtraction.acceptedEntries].sort().join('\n')
	for (const source of mapSources) {
		const packageBytes = upstreamBytes(source)
		const entries = parseZip(packageBytes, source)
		const actual = [...entries.keys()].sort().join('\n')
		if (actual !== accepted)
			fail(`${source} is not a script-free stock skirmish package; entries were [${[...entries.keys()].sort().join(', ')}]`)
		if (rejectedAuthor(entries.get('map.yaml').toString('utf8'))) continue
		const slug = basename(source, '.oramap').toLowerCase()
		const outputHashes = {}
		for (const name of policy.mapExtraction.retainedEntries) {
			const data = entries.get(name)
			if (!data) fail(`${source} is missing required ${name}`)
			writeExact(resolve(mapsRoot, slug, name), data)
			outputHashes[name] = sha256(data)
		}
		records.push({
			id: slug,
			upstreamPath: source,
			upstreamSha256: sha256(packageBytes),
			files: outputHashes,
		})
	}
	return records
}

function walk(root) {
	const output = []
	function visit(current) {
		for (const name of readdirSync(current).sort()) {
			const full = join(current, name)
			const entry = statSync(full)
			if (entry.isDirectory() && (name === 'bin' || name === 'obj')) continue
			if (entry.isDirectory()) visit(full)
			else if (entry.isFile()) output.push(full)
			else fail(`unsupported vendor entry ${full}`)
		}
	}
	visit(root)
	return output
}

function expectedUpstreamFiles() {
	return [...new Set([
		...policy.sourceLayout.core.flatMap(source => upstreamFiles(source)),
		...policy.sourceLayout.redAlertGameplayText.flatMap(source => upstreamFiles(source)),
	])].sort()
}

function verifyAgainstUpstream() {
	if (!sourceRoot) return
	const expected = expectedUpstreamFiles()
	for (const source of expected) {
		const target = resolve(vendorRoot, source)
		if (!existsSync(target)) fail(`missing pinned upstream file ${source}`)
		const actualHash = sha256(readFileSync(target))
		const upstreamHash = sha256(upstreamBytes(source))
		if (actualHash !== upstreamHash)
			fail(`${source} differs from ${expectedCommit} (${actualHash} != ${upstreamHash})`)
	}
}

function relativePath(path) {
	return relative(vendorRoot, path).split(sep).join('/')
}

function assertAssetBoundary(paths) {
	const forbidden = new Set(policy.excluded.extensions.map(value => value.toLowerCase()))
	const violations = paths
		.map(relativePath)
		.filter(path => forbidden.has(extname(path).toLowerCase()))
	if (violations.length) fail(`forbidden vendored assets: ${violations.join(', ')}`)
	for (const path of paths.map(relativePath)) {
		if (path.startsWith('OpenRA.Browser/')) fail(`browser view code crossed vendor boundary: ${path}`)
		if (path.includes('/AgentMode/') || path.includes('/agent-sidecar/') || path.includes('/tests/'))
			fail(`excluded agent/benchmark source crossed vendor boundary: ${path}`)
	}
}

function createLock(mapRecords = null) {
	const paths = walk(vendorRoot).filter(path => path !== lockPath)
	assertAssetBoundary(paths)
	const files = {}
	for (const path of paths) {
		const rel = relativePath(path)
		files[rel] = sha256(readFileSync(path))
	}
	const lock = {
		schemaVersion: 1,
		upstream: policy.upstream,
		commit: expectedCommit,
		policySha256: files['vendor-policy.json'],
		files,
		maps: (mapRecords ?? (existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')).maps : []))
			.filter(map => existsSync(resolve(vendorRoot, 'mods/ra/maps', map.id))),
	}
	writeFileSync(lockPath, `${JSON.stringify(lock, null, '\t')}\n`)
	return lock
}

function verifyLock() {
	if (!existsSync(lockPath)) fail('provenance.lock.json is missing')
	const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
	if (lock.commit !== expectedCommit) fail(`lock commit ${lock.commit} does not match policy ${expectedCommit}`)
	const paths = walk(vendorRoot).filter(path => path !== lockPath)
	assertAssetBoundary(paths)
	const actualNames = paths.map(relativePath).sort()
	const expectedNames = Object.keys(lock.files).sort()
	if (actualNames.join('\n') !== expectedNames.join('\n'))
		fail('vendor file set differs from provenance.lock.json')
	for (const path of paths) {
		const rel = relativePath(path)
		const actual = sha256(readFileSync(path))
		if (actual !== lock.files[rel]) fail(`${rel} hash ${actual} != ${lock.files[rel]}`)
	}
	const mapIds = [...new Set(actualNames.map(name => /^mods\/ra\/maps\/([^/]+)\//.exec(name)?.[1]).filter(Boolean))].sort()
	if (mapIds.join('\n') !== lock.maps.map(map => map.id).sort().join('\n'))
		fail('vendored maps differ from the map records in provenance.lock.json')
	for (const id of mapIds) {
		const author = rejectedAuthor(readFileSync(resolve(vendorRoot, 'mods/ra/maps', id, 'map.yaml'), 'utf8'))
		if (author) fail(`mods/ra/maps/${id} is credited to ${author}, which vendor-policy.json rejects`)
	}
	return { fileCount: paths.length, mapCount: lock.maps.length }
}

let before = null
if (sourceRoot) {
	ensureTargetCommit()
	before = statusFingerprint()
}

let mapRecords = null
if (writeVendor) {
	if (!sourceRoot) fail('--vendor requires --source')
	const coreCount = vendorCore()
	const textCount = vendorGameplayText()
	mapRecords = vendorMaps()
	console.log(`${TOOL}: vendored ${coreCount} core files, ${textCount} gameplay text files and ${mapRecords.length} script-free maps`)
}

if (writeLock) createLock(mapRecords)
const result = verifyLock()
verifyAgainstUpstream()

if (sourceRoot) {
	const after = statusFingerprint()
	if (!before.bytes.equals(after.bytes)) fail('external OpenRA-Web worktree changed during vendoring')
	console.log(`${TOOL}: external worktree unchanged (status sha256 ${after.sha256})`)
}

console.log(`${TOOL}: PASS commit=${expectedCommit} files=${result.fileCount} maps=${result.mapCount}`)
