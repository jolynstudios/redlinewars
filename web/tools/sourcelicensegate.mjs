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
import { join, relative, resolve } from 'node:path'
import { crc32 } from 'node:zlib'
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
export const SUPPLIED_BASES = ['own-work', 'CC0-1.0', 'CC-BY-4.0', 'CGTrader-Royalty-Free']

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
// The art packs that ship: the forge baseline unpacked in web/.forge (absent from a public checkout).
const forge = join(web, '.forge'), packs = []
if (existsSync(forge)) for (const dir of readdirSync(forge)) {
	const file = join(forge, dir, 'manifest.json')
	if (!existsSync(file)) continue
	const manifest = JSON.parse(readFileSync(file, 'utf8'))
	if (manifest.suppliedInput) packs.push({ dir, suppliedInput: manifest.suppliedInput })
}
const supplied = JSON.parse(readFileSync(join(game, 'art/supplied-inputs.lock.json'), 'utf8'))
problems.push(...auditSupplied({ supplied, notices: readFileSync(join(game, 'THIRD_PARTY_NOTICES.md'), 'utf8'), packs }))
if (problems.length) {
	console.error(`${TOOL}: FAIL — ${problems.length} problem(s)\n  ${problems.join('\n  ')}`)
	process.exit(1)
}
const attributed = lock.sources.filter(e => ATTRIBUTION_LICENSES.includes(e.license)).length
console.log(`${TOOL}: PASS — licence, archive, extracted-file/symlink and redirect rejection fixtures proven; ${lock.sources.length} recorded source(s), ${attributed} needing attribution, all pinned and ${ALLOWED_LICENSES.join('/')}; ` +
	`${Object.keys(scripts).length} forge scripts name only recorded sources; art/.sources/ ignored and uncommitted; ` +
	`${supplied.inputs.length} supplied inputs verified and credited, ${packs.length} shipped packs on recorded inputs`)
