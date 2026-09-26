#!/usr/bin/env node
// STEELSEED — tools/sourcelicensegate
// The licence policy of VISUAL-QUALITY-PLAN.md, enforced: every external art source the forge
// can read is recorded in art/sources.lock.json with an allowed licence (CC0-1.0 or CC-BY-4.0),
// a pinned sha256 and https provenance; every source is listed in THIRD_PARTY_NOTICES.md and
// CC-BY authors are marked as requiring attribution; nothing under art/.sources/ is committed,
// unrecorded or different from its pinned bytes; every forge script that names a source
// directory names a recorded one. The gate first proves it can fail, on nine broken fixtures,
// then audits the repository.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { crc32, gunzipSync } from 'node:zlib'
import {
	ALLOWED_LICENSES, ATTRIBUTION_LICENSES, NOTICES_BEGIN, NOTICES_END, ensureUnpacked, entryProblems, fetchApproved, noticesSection, readLock, renderNotices, sha256Of, unpackMarker, verifyUnpacked,
} from './art-fetch.mjs'

const TOOL = 'sourcelicensegate'
const web = resolve(import.meta.dirname, '..'), game = resolve(web, '..')
const SOURCE_REF = /art\/\.sources\/([A-Za-z0-9._-]+)/g

/**
 * Audits one lock against a sources directory, the notices text, the git index, the ignore
 * file and the scripts that may read sources. Returns problem strings; empty means clean.
 */
export async function audit({ lock, sourcesDir, notices, gitFiles, gitignore, scripts }) {
	const problems = []
	if (lock?.schema !== 1) problems.push('lock: schema must be 1')
	if (!Array.isArray(lock?.sources)) return [...problems, 'lock: sources must be an array']
	if (JSON.stringify(lock.policy?.allowedLicenses) !== JSON.stringify(ALLOWED_LICENSES))
		problems.push(`lock: policy.allowedLicenses must be exactly ${JSON.stringify(ALLOWED_LICENSES)}; the policy is changed in the tools and the plan, not in the lock`)
	if (JSON.stringify(lock.policy?.attributionRequired) !== JSON.stringify(ATTRIBUTION_LICENSES))
		problems.push(`lock: policy.attributionRequired must be exactly ${JSON.stringify(ATTRIBUTION_LICENSES)}`)
	const ids = new Map()
	for (const entry of lock.sources) {
		problems.push(...entryProblems(entry, { allowedLicenses: ALLOWED_LICENSES }))
		if (entry?.id) {
			if (ids.has(entry.id)) problems.push(`${entry.id}: duplicate id`)
			ids.set(entry.id, entry)
			if (entry.sha256 == null) problems.push(`${entry.id}: unpinned source; run art-fetch --pin so the bake is tied to exact bytes`)
		}
	}
	// Notices: the generated list must be exactly what the lock renders.
	try {
		const { body } = noticesSection(notices)
		if (body !== renderNotices(lock)) problems.push('THIRD_PARTY_NOTICES.md is stale: run art-fetch --notices')
		for (const entry of lock.sources)
			if (ATTRIBUTION_LICENSES.includes(entry.license) && !(body.includes(entry.author) && body.includes('attribution required')))
				problems.push(`${entry.id}: CC-BY source without attribution in THIRD_PARTY_NOTICES.md`)
	} catch (error) { problems.push(String(error.message ?? error)) }
	// Files on disk: only recorded ids, only pinned bytes.
	if (existsSync(sourcesDir)) {
		for (const name of readdirSync(sourcesDir)) {
			if (name === '.DS_Store') continue
			const entry = ids.get(name)
			if (!entry) { problems.push(`art/.sources/${name}: unrecorded source directory; add it to the lock or delete it`); continue }
			const dir = join(sourcesDir, name)
			if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) { problems.push(`${name}: source directory must not be a symlink or file`); continue }
			const files = readdirSync(dir).filter(f => f !== '.DS_Store')
			const marker = relative(dir, unpackMarker(entry, sourcesDir))
			for (const file of files) {
				if (file === entry.file || file === marker) continue
				if (entry.unpack) continue // Recursive archive-derived check below, not marker trust.
				problems.push(`art/.sources/${name}/${file}: unrecorded file next to ${entry.file}`)
			}
			if (files.includes(entry.file) && entry.sha256 != null) {
				if (lstatSync(join(dir, entry.file)).isSymbolicLink()) { problems.push(`${name}: archive must not be a symlink`); continue }
				const sha = await sha256Of(join(dir, entry.file))
				if (sha !== entry.sha256) problems.push(`${name}: on-disk sha256 ${sha} differs from the pinned ${entry.sha256}; the bake would use unreviewed bytes`)
				if (entry.unpack) try { verifyUnpacked(entry, sourcesDir) } catch (error) { problems.push(`${name}: ${error.message}`) }
			}
			else if (entry.unpack && files.length) problems.push(`${name}: extracted source without pinned archive`)
		}
	}
	if (gitFiles.length) problems.push(`committed source files: ${gitFiles.join(', ')}; art/.sources/ is never committed`)
	if (!gitignore.split('\n').some(line => line.trim() === 'art/.sources/')) problems.push('.gitignore must ignore art/.sources/')
	for (const [file, text] of Object.entries(scripts))
		for (const match of text.matchAll(SOURCE_REF))
			if (!ids.has(match[1])) problems.push(`${file}: names unknown source art/.sources/${match[1]}`)
	return problems
}

/** The rights a supplied input may rest on (art/supplied-inputs.lock.json `rights.basis`). */
export const SUPPLIED_BASES = ['own-work', 'mixed', 'generated-with-service', 'CC0-1.0', 'CC-BY-4.0', 'CGTrader-Royalty-Free']

/**
 * Audits the supplied inputs the shipped art packs rest on: each input carries verified rights
 * with its basis, creator and evidence; a third-party input names its https source and terms and
 * is credited, with every credited part, in THIRD_PARTY_NOTICES.md; and every shipped pack rests on
 * a recorded input with the same bytes. Returns problem strings; empty means clean.
 */
export function auditSupplied({ supplied, notices, packs }) {
	const problems = []
	if (supplied?.schema !== 1 || !Array.isArray(supplied?.inputs)) return ['supplied-inputs: schema 1 with an inputs array']
	const byId = new Map(supplied.inputs.map(e => [e.id, e]))
	for (const e of supplied.inputs) {
		const r = e.rights
		if (e.licenseStatus !== 'verified') problems.push(`${e.id}: rights ${e.licenseStatus ?? 'missing'}; a shipped pack may rest only on a verified input`)
		if (!r || typeof r !== 'object') { problems.push(`${e.id}: no rights record`); continue }
		if (!SUPPLIED_BASES.includes(r.basis)) problems.push(`${e.id}: unknown rights basis ${r.basis}`)
		if (!r.creator) problems.push(`${e.id}: no creator`)
		if (!r.evidence) problems.push(`${e.id}: no evidence for its rights`)
		// A mixed input keeps every part's own origin; a part taken from another input names it.
		if (r.basis === 'mixed') {
			if (!Array.isArray(r.components) || r.components.length === 0) problems.push(`${e.id}: a mixed input lists its components`)
			for (const c of r.components ?? []) {
				if (!c.part || !c.basis) problems.push(`${e.id}: every component names its part and basis`)
				else if (c.input && !byId.has(c.input)) problems.push(`${e.id}: component ${c.part} names unrecorded input ${c.input}`)
				else if (!c.input && !c.creator) problems.push(`${e.id}: component ${c.part} names no creator`)
			}
			continue
		}
		if (r.basis === 'generated-with-service') { if (!r.service) problems.push(`${e.id}: a generated input names its service`); continue }
		if (r.basis === 'own-work') continue
		if (!/^https:\/\//.test(r.source ?? '')) problems.push(`${e.id}: third-party input without an https source`)
		if (!r.terms) problems.push(`${e.id}: third-party input without its terms`)
		if (r.creator && !notices.includes(r.creator)) problems.push(`${e.id}: ${r.creator} is not credited in THIRD_PARTY_NOTICES.md`)
		for (const part of r.parts ?? []) if (!notices.includes(part.creator)) problems.push(`${e.id}: the ${part.part} by ${part.creator} is not credited in THIRD_PARTY_NOTICES.md`)
	}
	for (const pack of packs) {
		const id = pack.suppliedInput?.id
		if (!id) continue
		const e = byId.get(id)
		if (!e) problems.push(`${pack.dir}: rests on unrecorded input ${id}`)
		else if (pack.suppliedInput.sha256 !== e.sha256 || pack.suppliedInput.bytes !== e.bytes) problems.push(`${pack.dir}: its input ${id} differs from the record`)
	}
	return problems
}

// --- Shipped content (REL-002): every file a build ships, traced to its provenance. -------------

/** Program and notice files: their correspondence to source is tools/verify-release.mjs's job. */
export function isProgramFile(path) {
	return /\.(m?js|cjs|map|html|json|txt|css|webmanifest)$/.test(path) || path.startsWith('licenses/')
}
export const CONTENT_CLASSES = ['original', 'third-party', 'mixed', 'generated-with-service']
export const REVIEW_STATUSES = ['NOT_REQUIRED', 'NEEDS_EVIDENCE', 'NEEDS_REVIEW', 'REVIEWED']
/** Licences under which a third-party file needs no review beyond its shipped text and credit. */
export const OPEN_LICENCES = ['CC0-1.0', 'CC-BY-4.0', 'OFL-1.1']

/** `**`, `*`, `?` and `{a,b}` over `/`-separated labels. */
export function globRegExp(glob) {
	let out = ''
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]
		if (c === '*' && glob[i + 1] === '*') { out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1 }
		else if (c === '*') out += '[^/]*'
		else if (c === '?') out += '[^/]'
		else if (c === '{') { const end = glob.indexOf('}', i); out += `(?:${glob.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`; i = end }
		else out += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
	}
	return new RegExp(`^${out}$`)
}

/**
 * Indexes the files a shipped asset can come from by their sha256: the forge tree the build read
 * (`forge:<path>`, each with the nearest manifest.json above it), the npm packages that carry
 * fonts (`npm:<package>/<path>`) and the files web/public copies as they are (`web/public/<path>`).
 */
export function indexInputs({ forgeRoot, npmRoots = [], publicRoot = null }) {
	const index = new Map()
	const add = (sha, entry) => { if (!index.has(sha)) index.set(sha, []); index.get(sha).push(entry) }
	const manifests = new Map()
	const nearestManifest = dir => {
		for (let d = dir; d.length >= forgeRoot.length; d = resolve(d, '..')) {
			if (!manifests.has(d)) {
				const file = join(d, 'manifest.json')
				manifests.set(d, existsSync(file) ? { path: relative(forgeRoot, file).split('\\').join('/'), json: JSON.parse(readFileSync(file, 'utf8')) } : null)
			}
			if (manifests.get(d)) return manifests.get(d)
			if (d === forgeRoot) break
		}
		return null
	}
	const walk = (root, label, withManifest) => {
		if (!root || !existsSync(root)) return
		for (const name of readdirSync(root, { recursive: true })) {
			const file = join(root, name)
			if (!lstatSync(file).isFile() || name.endsWith('manifest.json')) continue
			const bytes = readFileSync(file)
			const rel = name.split('\\').join('/')
			add(hash(bytes), { label: `${label}${rel}`, file, manifest: withManifest ? nearestManifest(resolve(file, '..')) : null })
		}
	}
	walk(forgeRoot, 'forge:', true)
	for (const [pkg, root] of npmRoots) walk(root, `npm:${pkg}/`, false)
	walk(publicRoot, 'web/public/', false)
	return index
}

/** The ids a pack manifest says it was built from (external sources) and its supplied input. */
function manifestDependencies(manifest) {
	const deps = []
	for (const key of ['referenceSources', 'externalSources', 'sources'])
		for (const ref of Array.isArray(manifest?.[key]) ? manifest[key] : []) if (ref?.id) deps.push({ id: ref.id, sha256: ref.sha256 ?? null, via: key })
	return deps
}

/**
 * Audits the files one candidate ships (its composition.json) against their provenance: every
 * creative file must come from a build input with the same bytes, resolve to a record (a supplied
 * input named by its pack manifest, or a rule of art/content-provenance.json), and that record and
 * everything it rests on must exist, be well formed, acyclic, credited where the licence asks, and
 * name the bytes that ship. Returns `problems` (the audit fails), `blocked` (an official release
 * waits for a person: evidence or review still open), coverage counts and the unresolved paths.
 */
export function auditInventory({ inventory, inputs, registry, supplied, sourcesLock, notices, bundleText = '', target = 'official', fallback = null }) {
	const problems = [], unresolved = [], blocked = new Map()
	const counts = { files: 0, program: 0, content: 0, byClass: Object.fromEntries(CONTENT_CLASSES.map(c => [c, 0])) }
	const block = (key, reason, file) => {
		if (!blocked.has(key)) blocked.set(key, { reason, files: 0, examples: [] })
		const b = blocked.get(key); b.files++; if (b.examples.length < 3) b.examples.push(file)
	}
	if (!inventory || !Array.isArray(inventory.files)) return { problems: ['missing production inventory: no composition.json with a files list'], blocked: [], counts, unresolved, notShipped: [] }
	if (registry?.schema !== 1 || typeof registry.records !== 'object' || !Array.isArray(registry.rules)) problems.push('art/content-provenance.json: schema 1 with records and rules')
	const records = registry?.records ?? {}, services = registry?.services ?? {}
	// Ids: unique inside each catalogue and never the same name in two of them.
	const catalogues = [['supplied input', (supplied?.inputs ?? []).map(e => e.id)], ['source', (sourcesLock?.sources ?? []).map(e => e.id)], ['record', Object.keys(records)], ['service', Object.keys(services)]]
	const seen = new Map()
	for (const [kind, ids] of catalogues) for (const id of ids) {
		if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) { problems.push(`${kind} id ${JSON.stringify(id)} is malformed`); continue }
		if (seen.has(id)) problems.push(`duplicate id ${id}: ${seen.get(id)} and ${kind}`)
		else seen.set(id, kind)
	}
	const suppliedById = new Map((supplied?.inputs ?? []).map(e => [e.id, e]))
	const sourceById = new Map((sourcesLock?.sources ?? []).map(e => [e.id, e]))
	const reviewOf = (what, review, { needsEvidence = true } = {}) => {
		const status = review?.status
		if (!REVIEW_STATUSES.includes(status)) { problems.push(`${what}: review.status must be one of ${REVIEW_STATUSES.join(', ')}`); return 'NEEDS_REVIEW' }
		if (status === 'REVIEWED' && !(review.by && review.date)) problems.push(`${what}: REVIEWED needs the reviewer (by) and date`)
		if (status === 'NOT_REQUIRED' && needsEvidence) {
			problems.push(`${what}: NOT_REQUIRED is only for original work with its evidence, or third-party work under ${OPEN_LICENCES.join('/')}`)
			return 'NEEDS_REVIEW'
		}
		return status
	}
	// Records: class, service, parents (acyclic), attribution, and whether a person still has to act.
	const recordState = new Map()
	const checkRecord = (id, trail = []) => {
		if (recordState.has(id)) return recordState.get(id)
		if (trail.includes(id)) { problems.push(`record ${id}: dependency cycle ${[...trail, id].join(' → ')}`); return { cls: null, open: [] } }
		const r = records[id]
		if (!r) { problems.push(`record ${id} is named but not recorded (missing dependency)`); return { cls: null, open: [] } }
		const open = []
		if (!CONTENT_CLASSES.includes(r.class)) problems.push(`record ${id}: class ${r.class} is not one of ${CONTENT_CLASSES.join(', ')}`)
		if (r.class === 'original' && !(r.author && r.evidence)) problems.push(`record ${id}: original work needs its author and evidence`)
		if (r.class === 'generated-with-service') {
			const s = services[r.service]
			if (!s) problems.push(`record ${id}: unknown service ${r.service}`)
			else if (!s.terms) problems.push(`service ${r.service}: no terms reference`)
			else if (reviewOf(`service ${r.service}`, s.review, { needsEvidence: true }) !== 'REVIEWED') open.push([`service:${r.service}`, `${s.name}: plan, generation dates, inputs and terms not yet evidenced and reviewed`])
		}
		if (r.class === 'third-party' && !(r.licence && r.source)) problems.push(`record ${id}: third-party work needs its licence and source`)
		if (r.attribution && !notices.includes(r.attribution)) problems.push(`record ${id}: attribution "${r.attribution}" is missing from THIRD_PARTY_NOTICES.md (stale notices)`)
		let cls = r.class, parentsFree = true
		for (const parent of r.parents ?? []) {
			const p = checkRef(parent, [...trail, id])
			open.push(...p.open)
			parentsFree &&= p.free === true
			if (p.cls && p.cls !== 'original' && cls === 'original') cls = 'mixed'
		}
		// No review is needed for the studio's own work with its evidence, for open-licence work, and for
		// a mix of only those; anything resting on other terms waits for a person.
		const free = ((r.class === 'original' || r.class === 'mixed') && r.author && r.evidence && parentsFree) || (r.class === 'third-party' && OPEN_LICENCES.includes(r.licence))
		const status = reviewOf(`record ${id}`, r.review, { needsEvidence: !free })
		if (status !== 'REVIEWED' && status !== 'NOT_REQUIRED') open.push([`record:${id}`, `${id}: ${status}`])
		const state = { cls, open, free: Boolean(free) && (status === 'NOT_REQUIRED' || status === 'REVIEWED') }
		recordState.set(id, state)
		return state
	}
	const checkSupplied = (id, trail = []) => {
		const key = `supplied:${id}`
		if (recordState.has(key)) return recordState.get(key)
		if (trail.includes(key)) { problems.push(`supplied input ${id}: dependency cycle ${[...trail, key].join(' → ')}`); return { cls: null, open: [] } }
		const e = suppliedById.get(id), open = []
		let cls = null
		if (!e) problems.push(`supplied input ${id} is named but not recorded`)
		else {
			const r = e.rights ?? {}
			const components = Array.isArray(r.components) ? r.components : []
			const thirdParty = r.basis !== 'own-work' || components.some(c => c.basis && c.basis !== 'own-work')
			cls = r.class && CONTENT_CLASSES.includes(r.class) ? r.class : thirdParty ? 'mixed' : 'original'
			for (const c of components) {
				if (c.source && c.source.startsWith('source:') && !sourceById.has(c.source.slice(7))) problems.push(`supplied input ${id}: component ${c.part ?? '?'} names unknown source ${c.source}`)
				// A part taken from another input carries that input's origin and open items along.
				if (c.input) open.push(...checkSupplied(c.input, [...trail, key]).open)
			}
			const status = reviewOf(`supplied input ${id}`, r.review, { needsEvidence: cls !== 'original' })
			if (status !== 'REVIEWED' && status !== 'NOT_REQUIRED') open.push([key, `${id}: ${status}${r.review?.note ? ` (${r.review.note})` : ''}`])
			if (r.service) {
				const s = services[r.service]
				if (!s) problems.push(`supplied input ${id}: unknown service ${r.service}`)
				else if (reviewOf(`service ${r.service}`, s.review, { needsEvidence: true }) !== 'REVIEWED') open.push([`service:${r.service}`, `${s.name}: plan, generation dates, inputs and terms not yet evidenced and reviewed`])
			}
		}
		const state = { cls, open }
		recordState.set(key, state)
		return state
	}
	const checkRef = (ref, trail = []) => {
		if (typeof ref !== 'string') { problems.push(`malformed reference ${JSON.stringify(ref)}`); return { cls: null, open: [] } }
		if (ref.startsWith('supplied:')) return checkSupplied(ref.slice(9))
		if (ref.startsWith('source:')) {
			const s = sourceById.get(ref.slice(7))
			if (!s) { problems.push(`${ref} is named but not in art/sources.lock.json (unknown parent)`); return { cls: null, open: [] } }
			return { cls: 'third-party', open: [], free: OPEN_LICENCES.includes(s.license) }
		}
		return checkRecord(ref.startsWith('record:') ? ref.slice(7) : ref, trail)
	}
	const rules = []
	for (const rule of registry?.rules ?? []) {
		if (!records[rule.record]) problems.push(`rule ${rule.match} names unknown record ${rule.record}`)
		rules.push({ re: globRegExp(rule.match), record: rule.record })
	}
	// Everything a reference rests on, transitively: record parents and the inputs and sources a
	// supplied input's components name.
	const closure = (ref, seenRefs = new Set()) => {
		if (seenRefs.has(ref)) return seenRefs
		seenRefs.add(ref)
		if (ref.startsWith('supplied:')) {
			for (const c of suppliedById.get(ref.slice(9))?.rights?.components ?? []) {
				if (c.input) closure(`supplied:${c.input}`, seenRefs)
				if (typeof c.source === 'string' && c.source.startsWith('source:')) closure(c.source, seenRefs)
			}
		} else if (!ref.startsWith('source:')) for (const parent of records[ref.replace(/^record:/, '')]?.parents ?? []) closure(parent, seenRefs)
		return seenRefs
	}
	const shippedRefs = new Set()
	for (const file of inventory.files) {
		counts.files++
		if (isProgramFile(file.path)) { counts.program++; continue }
		counts.content++
		// A public sample build: stand-ins that tools/fallback-art.mjs wrote in this checkout.
		if (target === 'public-sample' && fallback?.has(file.sha256)) { counts.byClass.original++; counts.sample = (counts.sample ?? 0) + 1; continue }
		const sources = inputs.get(file.sha256) ?? []
		if (sources.length === 0) { unresolved.push(file.path); problems.push(`${file.path}: shipped, but no build input has its bytes`); continue }
		let found = null
		for (const src of sources) {
			const input = src.manifest?.json?.suppliedInput
			if (input?.id) { found = { ref: `supplied:${input.id}`, src, input }; break }
			const rule = rules.find(r => r.re.test(src.label))
			if (rule) { found = { ref: `record:${rule.record}`, src }; break }
		}
		if (!found) { unresolved.push(file.path); problems.push(`${file.path} (${sources[0].label}): no provenance record`); continue }
		for (const ref of closure(found.ref)) shippedRefs.add(ref)
		let { cls, open } = checkRef(found.ref)
		// A pack keeps the origin of everything its manifest says it was built from.
		const manifest = found.src.manifest?.json
		for (const dep of manifestDependencies(manifest)) {
			const s = sourceById.get(dep.id)
			if (!s) { problems.push(`${file.path}: its pack names source ${dep.id} (${dep.via}), which art/sources.lock.json does not record (unknown parent)`); continue }
			if (dep.sha256 && s.sha256 && dep.sha256 !== s.sha256) problems.push(`${file.path}: its pack was built from ${dep.id} bytes ${dep.sha256.slice(0, 12)}, the lock pins ${s.sha256.slice(0, 12)} (changed input)`)
			shippedRefs.add(`source:${dep.id}`)
			if (cls === 'original') cls = 'mixed'
		}
		if (found.input) {
			const e = suppliedById.get(found.input.id)
			if (e && (found.input.sha256 !== e.sha256 || found.input.bytes !== e.bytes)) problems.push(`${file.path}: its pack rests on ${found.input.id} with other bytes than the record (changed input)`)
		}
		// The manifest must describe the bytes that ship (its sha256 covers the unpacked file).
		if (manifest?.file && manifest.sha256 && basename(found.src.label) === manifest.file) {
			const stored = readFileSync(found.src.file)
			const unpacked = manifest.compression === 'gzip' ? gunzipSync(stored) : stored
			if (hash(unpacked) !== manifest.sha256 || (manifest.storedBytes != null && stored.length !== manifest.storedBytes))
				problems.push(`${file.path}: ${found.src.manifest.path} does not describe the shipped bytes (identity)`)
		}
		if (cls) counts.byClass[cls]++
		for (const [key, reason] of open) block(key, reason, file.path)
	}
	// Runtime channels: shipped code must not fetch creative files from outside this inventory.
	for (const [url] of bundleText.matchAll(/https?:\/\/[^\s"'`)]+?\.(?:m4a|mp3|ogg|wav|png|jpe?g|webp|glb|gltf|ssmesh|sspbr|ssanim|ssasset|woff2?|mp4|webm)\b/g))
		if (!(registry?.runtimeChannels ?? []).some(allowed => url.startsWith(allowed))) problems.push(`undeclared runtime asset channel: ${url}`)
	if (target !== 'asset-free' && counts.content === 0) problems.push(`${target} target: the inventory ships no creative file; an asset-free build must say --target=asset-free`)
	if (target === 'public-sample' && !fallback) problems.push('public-sample target: no web/.forge/fallback-art.json; run tools/fallback-art.mjs so its stand-ins are known')
	if (target === 'asset-free' && counts.content > 0) problems.push(`asset-free target: the inventory ships ${counts.content} creative file(s)`)
	const notShipped = [...(supplied?.inputs ?? []).map(e => `supplied:${e.id}`), ...(sourcesLock?.sources ?? []).map(e => `source:${e.id}`)].filter(ref => !shippedRefs.has(ref))
	return { problems, blocked: [...blocked].map(([key, b]) => ({ key, ...b })), counts, unresolved, notShipped }
}

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }

function fixtureZip(name, data) {
	const filename=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22)
	local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc32(data),14)
	local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26)
	central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,6);central.writeUInt32LE(crc32(data),16)
	central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(filename.length,28)
	end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10)
	end.writeUInt32LE(central.length+filename.length,12);end.writeUInt32LE(local.length+filename.length+data.length,16)
	return Buffer.concat([local,filename,data,central,filename,end])
}
function noticesFor(lock) { return `# notices\n\n${NOTICES_BEGIN}\n${renderNotices(lock)}\n${NOTICES_END}\n` }
function entry(overrides = {}) {
	return {
		id: 'ambientcg-concrete034', title: 'Concrete 034', author: 'ambientCG', url: 'https://ambientcg.com/get?file=Concrete034_1K-JPG.zip',
		licenseUrl: 'https://docs.ambientcg.com/license/', license: 'CC0-1.0', use: 'test fixture', file: 'Concrete034_1K-JPG.zip', unpack: true,
		sha256: null, bytes: null, ...overrides,
	}
}
function lockFor(entries) { return { schema: 1, policy: { allowedLicenses: [...ALLOWED_LICENSES], attributionRequired: [...ATTRIBUTION_LICENSES] }, sources: entries } }

// --- 1. The gate can fail: each fixture must be rejected for the stated reason. --------------
const temp = mkdtempSync(join(tmpdir(), 'steelseed-sourcelicense-'))
try {
	const bytes = Buffer.from('fixture archive bytes')
	const pinned = entry({ sha256: hash(bytes), bytes: bytes.length, unpack: false })
	const base = () => ({ sourcesDir: join(temp, 'none'), gitFiles: [], gitignore: 'art/.sources/\n', scripts: {} })
	const cases = [
		['clean lock', lockFor([pinned]), {}, null],
		['non-commercial licence', lockFor([{ ...pinned, license: 'CC-BY-NC-4.0' }]), {}, /licence "CC-BY-NC-4.0" is not allowed/],
		['share-alike licence', lockFor([{ ...pinned, license: 'CC-BY-SA-4.0' }]), {}, /not allowed/],
		['denied host', lockFor([{ ...pinned, url: 'https://quixel.com/megascans/home' }]), {}, /denied host \(quixel\.com\)/],
		['denied subdomain', lockFor([{ ...pinned, url: 'https://www.fab.com/listings/x' }]), {}, /denied host/],
		['unpinned', lockFor([entry()]), {}, /unpinned source/],
		['loosened policy', { ...lockFor([pinned]), policy: { allowedLicenses: ['CC0-1.0', 'CC-BY-4.0', 'Proprietary'], attributionRequired: ['CC-BY-4.0'] } }, {}, /policy\.allowedLicenses must be exactly/],
		['stale notices', lockFor([{ ...pinned, license: 'CC-BY-4.0', author: 'Some Artist' }]), { notices: noticesFor(lockFor([pinned])) }, /stale|without attribution/],
		['committed file', lockFor([pinned]), { gitFiles: ['art/.sources/ambientcg-concrete034/Concrete034_1K-JPG.zip'] }, /never committed/],
		['unknown script reference', lockFor([pinned]), { scripts: { 'art/blender/x.py': 'open("art/.sources/polyhaven-nothing/a.png")' } }, /names unknown source art\/\.sources\/polyhaven-nothing/],
		['missing ignore rule', lockFor([pinned]), { gitignore: 'web/.forge/\n' }, /\.gitignore must ignore/],
	]
	for (const [name, lock, overrides, expected] of cases) {
		const problems = await audit({ lock, notices: noticesFor(lock), ...base(), ...overrides })
		if (expected === null) assert.deepEqual(problems, [], `${name}: expected no problems`)
		else assert.ok(problems.some(p => expected.test(p)), `${name}: expected ${expected}, got ${JSON.stringify(problems)}`)
	}
	// On-disk fixtures: unrecorded directory, tampered bytes, unrecorded neighbour, valid unpack marker.
	const disk = join(temp, 'sources')
	mkdirSync(join(disk, 'stray'), { recursive: true }); writeFileSync(join(disk, 'stray', 'x.bin'), 'x')
	mkdirSync(join(disk, pinned.id)); writeFileSync(join(disk, pinned.id, pinned.file), Buffer.from('tampered'))
	let problems = await audit({ lock: lockFor([pinned]), notices: noticesFor(lockFor([pinned])), ...base(), sourcesDir: disk })
	assert.ok(problems.some(p => /stray: unrecorded source directory/.test(p)), `stray dir: ${JSON.stringify(problems)}`)
	assert.ok(problems.some(p => /on-disk sha256 .* differs from the pinned/.test(p)), `tampered: ${JSON.stringify(problems)}`)
	rmSync(join(disk, 'stray'), { recursive: true }); writeFileSync(join(disk, pinned.id, pinned.file), bytes); writeFileSync(join(disk, pinned.id, 'extra.png'), 'p')
	problems = await audit({ lock: lockFor([pinned]), notices: noticesFor(lockFor([pinned])), ...base(), sourcesDir: disk })
	assert.deepEqual(problems, [`art/.sources/${pinned.id}/extra.png: unrecorded file next to ${pinned.file}`])
	const archived = { ...pinned, unpack: true }
	writeFileSync(join(disk, pinned.id, '.unpacked'), JSON.stringify({ sha256: pinned.sha256, files: ['extra.png'] }))
	problems = await audit({ lock: lockFor([archived]), notices: noticesFor(lockFor([archived])), ...base(), sourcesDir: disk })
	assert.ok(problems.some(p => /not a zip/.test(p)), `forged marker must not authorize arbitrary files: ${JSON.stringify(problems)}`)
	const zip=fixtureZip('nested/texture.jpg',Buffer.from('verified texture')),zipRoot=join(temp,'zip-sources')
	const zipped={...archived,sha256:hash(zip),bytes:zip.length},zippedDir=join(zipRoot,zipped.id)
	mkdirSync(zippedDir,{recursive:true});writeFileSync(join(zippedDir,zipped.file),zip)
	assert.equal(ensureUnpacked(zipped,zipRoot),true);assert.equal(ensureUnpacked(zipped,zipRoot),false)
	const checkZip=()=>audit({lock:lockFor([zipped]),notices:noticesFor(lockFor([zipped])),...base(),sourcesDir:zipRoot})
	assert.deepEqual(await checkZip(),[])
	writeFileSync(join(zippedDir,'nested/texture.jpg'),'modified pixels')
	assert.ok((await checkZip()).some(p=>/differs from pinned archive/.test(p)))
	assert.throws(()=>ensureUnpacked(zipped,zipRoot),/differs from pinned archive/)
	writeFileSync(join(zippedDir,'nested/texture.jpg'),'verified texture')
	writeFileSync(join(zippedDir,'nested/unreviewed.jpg'),'extra')
	assert.ok((await checkZip()).some(p=>/unrecorded extracted file/.test(p)))
	rmSync(join(zippedDir,'nested/unreviewed.jpg'))
	rmSync(join(zippedDir,'nested/texture.jpg'))
	assert.ok((await checkZip()).some(p=>/missing extracted source/.test(p)))
	symlinkSync(join(zippedDir,zipped.file),join(zippedDir,'nested/texture.jpg'))
	assert.ok((await checkZip()).some(p=>/symlink rejected/.test(p)))
	// Reject redirect targets BEFORE sending them any request. All network is mocked.
	for(const target of ['https://www.fab.com/x','http://ambientcg.com/x','https://u:p@ambientcg.com/x']){
		const calls=[]
		await assert.rejects(()=>fetchApproved('https://ambientcg.com/source',async(url,options)=>{
			calls.push(url);assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:target}})
		}),/refused source URL/)
		assert.equal(calls.length,1,'denied destination must never be fetched')
	}
	let redirects=0
	const response=await fetchApproved('https://ambientcg.com/source',async()=>++redirects===1
		?new Response(null,{status:302,headers:{location:'/download'}}):new Response('allowed bytes'))
	assert.equal(await response.text(),'allowed bytes');assert.equal(redirects,2)
	await assert.rejects(()=>fetchApproved('https://ambientcg.com/loop',async()=>new Response(null,{status:302,headers:{location:'/loop'}})),/redirect limit/)
} finally { rmSync(temp, { recursive: true, force: true }) }

// --- 1b. Supplied inputs: the gate refuses unverified rights, missing credits and unknown inputs.
{
	const input = (overrides = {}) => ({ id: 'base', origin: 'user-supplied', sha256: 'a'.repeat(64), bytes: 10, licenseStatus: 'verified', authorization: 'x',
		rights: { basis: 'CGTrader-Royalty-Free', creator: 'someone', source: 'https://example.com/model', terms: 'use allowed', evidence: 'the listing', parts: [] }, ...overrides })
	const pack = { dir: 'troop-x', suppliedInput: { id: 'base', sha256: 'a'.repeat(64), bytes: 10 } }
	const clean = { supplied: { schema: 1, inputs: [input()] }, notices: 'Model by someone.', packs: [pack] }
	assert.deepEqual(auditSupplied(clean), [], 'a verified, credited input with a matching pack passes')
	for (const [what, change, pattern] of [
		['unverified rights', c => { c.supplied.inputs[0].licenseStatus = 'unverified' }, /rights unverified/],
		['an uncredited creator', c => { c.notices = 'Model by nobody.' }, /is not credited/],
		['an uncredited part', c => { c.supplied.inputs[0].rights.parts = [{ part: 'helmet', creator: 'another' }] }, /helmet by another is not credited/],
		['a pack on an unknown input', c => { c.packs = [{ dir: 'troop-y', suppliedInput: { id: 'ghost' } }] }, /unrecorded input ghost/],
	]) {
		const fixture = structuredClone(clean)
		change(fixture)
		assert.ok(auditSupplied(fixture).some(p => pattern.test(p)), `supplied fixture must fail: ${what}`)
	}
}

// --- 1c. Shipped content: every creative file traced, or the audit fails. -----------------------
{
	const temp = mkdtempSync(join(tmpdir(), 'sourcelicensegate-inventory-'))
	try {
		// A forge tree: a studio mesh, a pack on a third-party input (with a CC0 reference), a pack
		// nobody recorded, and a font from npm.
		const forgeRoot = join(temp, 'forge'), npmRoot = join(temp, 'npm-font')
		const put = (file, text) => { mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, text) }
		put(join(forgeRoot, 'blender/masks/tank.mask.rgba.gz'), 'studio tank')
		const pack = { schema: 1, file: 'lods.ssmesh.gz', compression: null, sha256: hash(Buffer.from('soldier mesh')), bytes: 12,
			suppliedInput: { id: 'base-soldier', sha256: 'b'.repeat(64), bytes: 20 }, referenceSources: [{ id: 'cc0-rig', sha256: 'c'.repeat(64), license: 'CC0-1.0' }] }
		put(join(forgeRoot, 'troop-x/lods.ssmesh.gz'), 'soldier mesh')
		put(join(forgeRoot, 'troop-x/manifest.json'), JSON.stringify(pack))
		put(join(forgeRoot, 'mystery/thing.gz'), 'nobody made this')
		put(join(npmRoot, 'files/font.woff2'), 'font bytes')
		const inputs = indexInputs({ forgeRoot, npmRoots: [['@x/font', npmRoot]] })
		const shipped = text => ({ path: `assets/${text.replace(/\W/g, '')}`, sha256: hash(Buffer.from(text)), bytes: text.length })
		const review = status => ({ status, owner: 'studio', by: null, date: null })
		const base = () => ({
			inventory: { files: [{ path: 'assets/index.js', sha256: 'd'.repeat(64) }, shipped('studio tank'), shipped('soldier mesh'), shipped('font bytes')] },
			inputs,
			registry: {
				schema: 1, services: {}, runtimeChannels: [],
				records: {
					'studio': { class: 'original', author: 'the studio', evidence: 'EV-1', review: review('NOT_REQUIRED') },
					'font': { class: 'third-party', licence: 'OFL-1.1', source: 'https://example.com/font', attribution: 'Font X', evidence: 'ofl text', review: review('NOT_REQUIRED') },
				},
				rules: [{ match: 'forge:blender/**', record: 'studio' }, { match: 'npm:@x/font/**', record: 'font' }],
			},
			supplied: { schema: 1, inputs: [
				{ id: 'base-soldier', sha256: 'b'.repeat(64), bytes: 20, rights: { basis: 'CGTrader-Royalty-Free', components: [{ part: 'heads', basis: 'mixed', input: 'kit-donor' }], review: review('NEEDS_REVIEW') } },
				{ id: 'kit-donor', sha256: '1'.repeat(64), bytes: 30, rights: { basis: 'mixed', components: [{ part: 'base parts', basis: 'vendor licence', creator: 'a vendor' }], review: review('NEEDS_EVIDENCE') } },
			] },
			sourcesLock: { sources: [{ id: 'cc0-rig', sha256: 'c'.repeat(64), license: 'CC0-1.0' }] },
			notices: 'Font X — OFL.',
			bundleText: 'fetch("assets/x.m4a")',
		})
		const clean = auditInventory(base())
		assert.deepEqual(clean.problems, [], 'an original, a mixed and a third-party file, all traced, pass')
		assert.equal(clean.counts.content, 3)
		assert.equal(clean.counts.byClass.original, 1, 'the studio mesh is original')
		assert.equal(clean.counts.byClass.mixed, 1, 'the soldier pack is mixed: a third-party base and a CC0 reference')
		assert.equal(clean.counts.byClass['third-party'], 1, 'the font is third-party')
		assert.deepEqual(clean.blocked.map(b => b.key).sort(), ['supplied:base-soldier', 'supplied:kit-donor'], 'the base waits for its review, and the input its heads came from for its evidence')
		for (const [what, change, pattern] of [
			['a pack without provenance', f => { f.inventory.files.push(shipped('nobody made this')) }, /mystery\/thing\.gz\): no provenance record/],
			['a shipped file no input has', f => { f.inventory.files.push(shipped('from nowhere')) }, /no build input has its bytes/],
			['an unknown parent', f => { f.sourcesLock.sources = [] }, /cc0-rig .*unknown parent/],
			['a duplicate id', f => { f.supplied.inputs.push({ ...f.supplied.inputs[0] }) }, /duplicate id base-soldier/],
			['a missing transitive dependency', f => { f.registry.records.studio.parents = ['record:ghost'] }, /record ghost is named but not recorded/],
			['a dependency cycle', f => { f.registry.records.studio.parents = ['record:font']; f.registry.records.font.parents = ['record:studio'] }, /dependency cycle/],
			['a stale attribution', f => { f.notices = 'nothing here' }, /attribution "Font X" is missing/],
			['changed input bytes', f => { f.supplied.inputs[0].sha256 = 'e'.repeat(64) }, /other bytes than the record \(changed input\)/],
			['a changed reference source', f => { f.sourcesLock.sources[0].sha256 = 'f'.repeat(64) }, /cc0-rig bytes .* \(changed input\)/],
			['a manifest that does not describe the shipped bytes', f => { f.inputs = new Map(f.inputs); for (const [k, v] of f.inputs) f.inputs.set(k, v.map(e => e.manifest ? { ...e, manifest: { ...e.manifest, json: { ...e.manifest.json, sha256: 'a'.repeat(64) } } } : e)) }, /does not describe the shipped bytes/],
			['a missing production inventory', f => { f.inventory = null }, /missing production inventory/],
			['an official build without creative files', f => { f.inventory.files = f.inventory.files.slice(0, 1) }, /ships no creative file/],
			['an undeclared runtime channel', f => { f.bundleText = 'load("https://cdn.example.com/voice/line.m4a")' }, /undeclared runtime asset channel/],
			['a review claimed where one is needed', f => { f.supplied.inputs[0].rights.review = review('NOT_REQUIRED') }, /NOT_REQUIRED is only for/],
			['a review without reviewer and date', f => { f.supplied.inputs[0].rights.review = review('REVIEWED') }, /REVIEWED needs the reviewer/],
			['a component from an unrecorded input', f => { f.supplied.inputs[0].rights.components = [{ part: 'heads', basis: 'mixed', input: 'ghost-input' }] }, /supplied input ghost-input is named but not recorded/],
			['a cycle between inputs', f => { f.supplied.inputs[1].rights.components = [{ part: 'body', basis: 'mixed', input: 'base-soldier' }] }, /dependency cycle/],
		]) {
			const fixture = base()
			change(fixture)
			const result = auditInventory(fixture)
			assert.ok(result.problems.some(p => pattern.test(p)), `inventory fixture must fail: ${what}\n  got: ${result.problems.join('\n  ')}`)
		}
		const reviewed = base()
		for (const input of reviewed.supplied.inputs) input.rights.review = { status: 'REVIEWED', owner: 'studio', by: 'a reviewer', date: '2026-09-26' }
		assert.deepEqual(auditInventory(reviewed).blocked, [], 'a genuine review closes the block')
		assert.deepEqual(auditInventory({ ...base(), inventory: { files: [{ path: 'assets/index.js', sha256: 'd'.repeat(64) }] }, target: 'asset-free' }).problems, [], 'an asset-free target may ship no creative file')
		const sample = base()
		sample.inventory.files.push(shipped('silent stand-in'))
		const known = auditInventory({ ...sample, target: 'public-sample', fallback: new Map([[hash(Buffer.from('silent stand-in')), 'web/.forge/music/theme.m4a']]) })
		assert.deepEqual(known.problems, [], 'a public sample build accepts the stand-ins its checkout generated')
		assert.equal(known.counts.sample, 1)
		assert.ok(auditInventory({ ...sample, target: 'public-sample' }).problems.some(p => /no web\/\.forge\/fallback-art\.json/.test(p)), 'without the stand-in list a sample build fails')
	} finally { rmSync(temp, { recursive: true, force: true }) }
}

// --- 2. The repository. ----------------------------------------------------------------------
const lock = readLock()
const scripts = {}
for (const dir of ['art/blender', 'web/tools']) {
	const root = join(game, dir)
	if (!existsSync(root)) continue
	for (const name of readdirSync(root)) {
		if (!/\.(py|mjs|js|ts)$/.test(name) || name === 'art-fetch.mjs' || name === 'sourcelicensegate.mjs') continue
		scripts[`${dir}/${name}`] = readFileSync(join(root, name), 'utf8')
	}
}
const gitFiles = execFileSync('git', ['ls-files', '--', 'art/.sources'], { cwd: game, encoding: 'utf8' }).split('\n').filter(Boolean)
const problems = await audit({
	lock, sourcesDir: join(game, 'art/.sources'), notices: readFileSync(join(game, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
	gitFiles, gitignore: readFileSync(join(game, '.gitignore'), 'utf8'), scripts,
})
// The art packs in the local forge tree (web/.forge, absent from a public checkout).
const notices = readFileSync(join(game, 'THIRD_PARTY_NOTICES.md'), 'utf8')
const forge = join(web, '.forge'), packs = []
if (existsSync(forge)) for (const dir of readdirSync(forge)) {
	const file = join(forge, dir, 'manifest.json')
	if (!existsSync(file)) continue
	const manifest = JSON.parse(readFileSync(file, 'utf8'))
	if (manifest.suppliedInput) packs.push({ dir, suppliedInput: manifest.suppliedInput })
}
const supplied = JSON.parse(readFileSync(join(game, 'art/supplied-inputs.lock.json'), 'utf8'))
problems.push(...auditSupplied({ supplied, notices, packs }))

// --- 3. Shipped content of one candidate (REL-002). ---------------------------------------------
//   --inventory=<composition.json>   the candidate's own file list (required; nothing is assumed)
//   --forge=<dir>                    the forge tree that candidate was built from (default: web/.forge)
//   --target=official|public-sample|asset-free   official (default) must ship traced creative files;
//                                    public-sample accepts the stand-ins of tools/fallback-art.mjs
//                                    (its web/.forge/fallback-art.json) and says it certifies only that build
//   --release                        an official release decision: open evidence or review is BLOCKED
//   --json=<file>                    the machine-readable result
// Exit: 0 PASS, 1 FAIL (a problem, or a required input missing), 2 BLOCKED (--release only).
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const RELEASE = process.argv.includes('--release')
const target = option('target') ?? 'official'
if (!['official', 'public-sample', 'asset-free'].includes(target)) problems.push(`--target must be official, public-sample or asset-free, not ${target}`)
// Only an explicit inventory is audited: a composed AppBundle left from an earlier build (CI restores
// one from its cache before this gate runs) is not the candidate being checked.
const inventoryPath = option('inventory') ? resolve(option('inventory')) : null
const forgeRoot = resolve(option('forge') ?? forge)
let shipped = null
if (inventoryPath || RELEASE || option('target')) {
	const inventory = inventoryPath && existsSync(inventoryPath) ? JSON.parse(readFileSync(inventoryPath, 'utf8')) : null
	if (target === 'official' && !existsSync(forgeRoot)) problems.push(`missing production inputs: no forge tree at ${forgeRoot}`)
	const bundleDir = inventoryPath ? resolve(inventoryPath, '..') : null
	const bundleText = (inventory?.files ?? []).filter(f => /\.m?js$/.test(f.path)).map(f => existsSync(join(bundleDir, f.path)) ? readFileSync(join(bundleDir, f.path), 'utf8') : '').join('\n')
	const npmRoots = ['@fontsource-variable', '@fontsource'].flatMap(scope => {
		const dir = join(web, 'node_modules', scope)
		return existsSync(dir) ? readdirSync(dir).map(name => [`${scope}/${name}`, join(dir, name)]) : []
	})
	const registry = JSON.parse(readFileSync(join(game, 'art/content-provenance.json'), 'utf8'))
	const marker = join(forgeRoot, 'fallback-art.json')
	const fallback = existsSync(marker) ? new Map(JSON.parse(readFileSync(marker, 'utf8')).files.map(f => [f.sha256, f.path])) : null
	shipped = auditInventory({ inventory, inputs: existsSync(forgeRoot) ? indexInputs({ forgeRoot, npmRoots, publicRoot: join(web, 'public') }) : new Map(), registry, supplied, sourcesLock: lock, notices, bundleText, target, fallback })
	problems.push(...shipped.problems)
}
const verdict = problems.length ? 'FAIL' : RELEASE && shipped?.blocked.length ? 'BLOCKED' : 'PASS'
if (option('json')) writeFileSync(resolve(option('json')), JSON.stringify({
	tool: TOOL, verdict, target, release: RELEASE, inventory: inventoryPath, forge: shipped ? forgeRoot : null,
	counts: shipped?.counts ?? null, unresolved: shipped?.unresolved ?? null, blocked: shipped?.blocked ?? null, notShipped: shipped?.notShipped ?? null, problems,
}, null, '\t') + '\n')
if (problems.length) {
	console.error(`${TOOL}: FAIL — ${problems.length} problem(s)\n  ${problems.slice(0, 60).join('\n  ')}${problems.length > 60 ? `\n  … and ${problems.length - 60} more` : ''}`)
	process.exit(1)
}
const scope = target === 'public-sample' ? ` [public-sample scope: ${shipped?.counts.sample ?? 0} stand-ins by tools/fallback-art.mjs; this certifies this sample build only, not the official art]` : ''
const coverage = shipped
	? `shipped content${scope}: ${shipped.counts.files} files, ${shipped.counts.program} program/notice, ${shipped.counts.content} creative traced (${Object.entries(shipped.counts.byClass).map(([c, n]) => `${n} ${c}`).join(', ')}); ${shipped.blocked.length} record(s) await evidence or review; recorded but not shipped: ${shipped.notShipped.join(', ') || 'none'}`
	: 'shipped content: NOT_RUN (no candidate inventory; pass --inventory=<composition.json> and --forge=<dir>)'
if (verdict === 'BLOCKED') {
	console.error(`${TOOL}: BLOCKED — ${coverage}\n  ${shipped.blocked.map(b => `${b.key}: ${b.reason} — ${b.files} shipped file(s), e.g. ${b.examples.join(', ')}`).join('\n  ')}`)
	process.exit(2)
}
const attributed = lock.sources.filter(e => ATTRIBUTION_LICENSES.includes(e.license)).length
console.log(`${TOOL}: PASS — licence, archive, extracted-file/symlink and redirect rejection fixtures proven; ${lock.sources.length} recorded source(s), ${attributed} needing attribution, all pinned and ${ALLOWED_LICENSES.join('/')}; ` +
	`${Object.keys(scripts).length} forge scripts name only recorded sources; art/.sources/ ignored and uncommitted; ` +
	`${supplied.inputs.length} supplied inputs recorded and credited; local forge tree: ${existsSync(forge) ? `${packs.length} packs on recorded inputs` : 'absent, its packs not audited'}; ${coverage}`)
