#!/usr/bin/env node
// STEELSEED — tools/rolepacksgate
//
// Every anatomical role pack that is present in web/.forge, through the REAL loaders: the same
// role-assets / role-surfaces / human-assets modules the game runs, bundled from source, with
// import.meta.glob answered from disk and fetch served from disk. Nothing here re-implements a
// validator, so a gate pass means the boot path accepts the pack for the same reasons.
//
// Per pack it checks what the renderer depends on: the shared twenty-bone bind rig, the LOD
// budgets (6000/2000/600), the atlas binding (id and saved-source hash), the motion binding
// against the LIVE human-motion manifest, the resolved muzzle, the saved-study provenance and
// its forge:index entry, the actor claims, and the shipped portrait. Then it proves the loader
// refuses a set of forged manifests without fetching a byte, and that each flag selects what it
// says. A pack that fails is reported by name; the game would draw its actors from the roster.
//
// --gpu adds a real boot of a built bundle (no engine, dev map) per flag set and compares what
// units actually built -- surface set, LOD triangles, muzzle bind and lift -- against the CPU
// resolution. It measures what ships: web/dist unless --dist=<dir> names a private build.
//
// Usage: node tools/rolepacksgate.mjs [--gpu] [--dist=<dir>] [--port=8493]

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { canWearFor, checkPortrait, loadRolePackApi } from './roleportraits.mjs'

const TOOL = 'rolepacksgate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME = resolve(WEB, '..')
const FORGE = join(WEB, '.forge')
const OUT = join(GAME, '.artifacts/planx/role-packs')
const ORIGIN = 'http://rolepacks.gate'
const CAPS = [6000, 2000, 600]
const SURFACE_ONLY_DIRS = new Set(['riki-meshy', 'troop-e2.soviet'])
const args = process.argv.slice(2)
const arg = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const gpu = args.includes('--gpu')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const failures = [], notes = []
const fail = message => { failures.push(message); console.log(`${TOOL}: FAIL ${message}`) }

// --- import.meta.glob from disk ------------------------------------------------------------
// Every pattern the bundled modules use is `../../.forge/<glob>`, relative to web/src/<node>/.
function expand(pattern) {
	const parts = pattern.replace(/^\.\.\/\.\.\/\.forge\//, '').split('/'), out = []
	const visit = (index, prefix) => {
		if (index === parts.length) { out.push(prefix); return }
		const re = new RegExp('^' + parts[index].replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*') + '$')
		let names = []
		try { names = readdirSync(join(FORGE, prefix)) } catch { return }
		// statSync, not Dirent: a symlinked pack directory is still a pack directory, as it is to Vite.
		for (const name of names) if (re.test(name) && (index === parts.length - 1 ? statSync(join(FORGE, prefix, name)).isFile() : statSync(join(FORGE, prefix, name)).isDirectory()))
			visit(index + 1, prefix ? `${prefix}/${name}` : name)
	}
	visit(0, '')
	return out.sort()
}
globalThis.__rolePacksGlob = (pattern, options = {}) => {
	const record = {}
	if (!pattern.startsWith('../../.forge/')) return record
	for (const rel of expand(pattern)) {
		const key = `../../.forge/${rel}`
		if (options.query === '?url') record[key] = `${ORIGIN}/forge/${rel}`
		else if (options.query === '?raw') record[key] = readFileSync(join(FORGE, rel), 'utf8')
		else if (rel.endsWith('.json')) record[key] = readJson(join(FORGE, rel))
	}
	return record
}
const fetched = [], networkFetch = globalThis.fetch
globalThis.fetch = async url => {
	const text = String(url), prefix = `${ORIGIN}/forge/`
	assert.ok(text.startsWith(prefix), `${TOOL}: unexpected fetch ${text}`)
	fetched.push(text)
	return new Response(readFileSync(join(FORGE, text.slice(prefix.length))))
}
globalThis.location = { href: `${ORIGIN}/steelseed/index.html`, origin: ORIGIN, search: '' }

async function bundle(contents) {
	const out = await build({
		stdin: { contents, resolveDir: WEB, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
		define: { 'import.meta.glob': '__gateGlob' }, banner: { js: 'const __gateGlob = (pattern, options) => globalThis.__rolePacksGlob(pattern, options);' },
	})
	return out.outputFiles[0].text
}
const importText = (text, tag = '') => import(`data:text/javascript;base64,${Buffer.from(text + `\n// ${tag}`).toString('base64')}`)

const api = await importText(await bundle(`
export { rolePackCandidates, validateRolePackManifest, verifyRolePack, loadRolePacks } from './src/units/role-assets.ts'
export { roleSurfaceCandidates, validateRoleSurfaceManifest, verifyRoleSurfacePack, planRoleSurfaces } from './src/materials/role-surfaces.ts'
export { loadHumanAssets } from './src/units/human-assets.ts'
export { RIFLE_PACK, RIFLE_FAMILY_ACTORS, assignRoleSlots, canonicalRoleValue, rolePackFlagState } from './src/core/role-pack.ts'
`))
const productionText = await bundle(`export { productionPortrait } from './src/ui/production.ts'`)
const portraitApi = await loadRolePackApi()
const canWear = canWearFor(portraitApi)
const visuals = readJson(join(WEB, 'src/core/ra-visual-manifest.json')).actors
const index = existsSync(join(GAME, 'art/blender/assets/index.json')) ? readJson(join(GAME, 'art/blender/assets/index.json')) : { assets: [] }
const indexed = new Set(index.assets.map(a => a.id))

// --- the reference every pack binds against --------------------------------------------------
const humanSurface = readJson(join(FORGE, 'human-surfaces/manifest.json'))
const reference = await api.loadHumanAssets(humanSurface.sourceSha256)
assert.ok(reference, 'The MakeHuman reference pack is absent; no role pack can bind without it')
const motionText = readFileSync(join(FORGE, 'human-motion/manifest.json'), 'utf8')
const motionSha256 = sha(motionText)
const referenceRig = api.canonicalRoleValue(reference.manifest.levels[0].rig)

// --- atlases, then meshes, then claims: the boot order ----------------------------------------
const atlases = new Map(), atlasFailures = []
const surfaceCandidates = api.roleSurfaceCandidates()
for (const { dir, manifest, url } of surfaceCandidates) {
	try {
		assert.ok(manifest && url, 'incomplete optional pack')
		await api.verifyRoleSurfacePack(manifest, dir, url)
		atlases.set(manifest.id, { dir, manifest })
	} catch (error) { atlasFailures.push({ dir, reason: error.message }) }
}
const meshCandidates = api.rolePackCandidates()
const meshDirs = new Set(meshCandidates.map(c => c.dir))
for (const { dir } of surfaceCandidates)
	if (!meshDirs.has(dir) && !SURFACE_ONLY_DIRS.has(dir)) fail(`${dir}-surfaces: an atlas with no role mesh pack beside it would allocate VRAM for nothing`)
const loaded = await api.loadRolePacks(reference, id => atlases.get(id)?.manifest.sourceSha256)
const assigned = api.assignRoleSlots(loaded.packs, canWear)
// The Soviet veteran rocket soldier must not silently fall back to the legacy
// box-built roster actor when the standard rocket pack is present.
assert.equal(assigned.actors.get('e3r1')?.dir, 'troop-e3', 'Soviet rocket soldier needs the authored rocket pack')
assert.equal(assigned.actors.get('e3r1'), assigned.actors.get('e3'), 'Rocket variants share the reviewed body, atlas and rig')
for (const { dir, reason } of [...atlasFailures, ...loaded.failures]) fail(`${dir}: refused at boot, its actors keep the roster model: ${reason}`)
for (const refusal of assigned.refused) fail(`claim refused: ${refusal}`)

const packReports = []
for (const pack of loaded.packs) {
	const m = pack.manifest, dir = pack.dir, atlas = atlases.get(m.id)
	const check = (ok, message) => { if (!ok) fail(`${dir}: ${message}`); return ok }
	const actors = m.slots.filter(actor => assigned.actors.get(actor) === pack)
	check(pack.levels.length === 3 && pack.levels.every(l => l.rig?.skeleton.boneCount === 20), 'every LOD decodes to the twenty-bone rig')
	check(pack.levels.every(l => l.rig.skeleton.names.join() === reference.levels[0].rig.skeleton.names.join()), 'bone names match the MakeHuman reference')
	check(m.levels.every(e => api.canonicalRoleValue(e.rig) === referenceRig), 'bind rig is canonical-equal to the reference')
	const triangles = pack.levels.map(l => l.mesh.triangleCount)
	check(triangles.every((n, i) => n <= CAPS[i] && n === m.levels[i].triangles) && triangles[0] > triangles[1] && triangles[1] > triangles[2],
		`LOD triangles ${triangles} within ${CAPS} and decreasing`)
	check(atlas?.manifest.sourceSha256 === m.parentSourceSha256 && atlas.dir === dir, 'atlas binds the pack parent source')
	check(m.motionBinding.manifestSha256 === motionSha256, 'motion binding is the live human-motion manifest')
	check(sha(api.canonicalRoleValue(m.levels[0].rig)) === m.motionBinding.bindRigSha256, 'bind-rig checksum')
	check(m.motionBinding.referenceModelSourceSha256 === reference.manifest.parentSourceSha256, 'reference model binding')
	for (const e of m.levels) {
		const path = join(GAME, e.sourcePath)
		if (check(existsSync(path), `saved study ${e.sourcePath} exists`)) check(sha(readFileSync(path)) === e.sourceSha256, `saved study ${e.sourcePath} matches its hash`)
		check(indexed.has(`studies/${e.sourcePath.split('/').pop().replace(/\.blend$/, '')}`), `${e.sourcePath} is catalogued (run npm run forge:index)`)
	}
	const armed = actors.filter(actor => (visuals[actor]?.slot?.armaments?.length ?? 0) > 0)
	const muzzle = pack.muzzle, b = m.levels[0].bounds
	if (armed.length) {
		check(muzzle !== null, `armed actors ${armed} need a muzzle (manifest or derived)`)
		if (muzzle) {
			check(muzzle.pos.every((v, i) => v >= b[0][i] - .02 && v <= b[1][i] + .02), 'muzzle bind point sits on the body')
			check(muzzle.anchor.every((v, i) => v >= b[0][i] - .1 && v <= b[1][i] + .1), 'held-aim muzzle stays within 0.1 m of the body')
			check(muzzle.source === 'manifest' || pack.levels[0].rig.skeleton.names[muzzle.bone] === 'hand_r', 'derived muzzle rides hand_r')
		}
	}
	const sidecarPath = join(FORGE, dir, 'portrait.json'), pngPath = join(FORGE, dir, 'portrait.png')
	let portrait = 'none'
	if (existsSync(sidecarPath)) {
		const sidecar = readJson(sidecarPath), png = existsSync(pngPath) ? readFileSync(pngPath) : null
		check(sidecar.schema === 1 && sidecar.pack === dir && sidecar.id === m.id, 'portrait.json names this pack')
		check(JSON.stringify(sidecar.slots) === JSON.stringify(actors), `portrait.json slots ${sidecar.slots} are the honoured claims ${actors}`)
		check(png && sidecar.sha256 === sha(png) && !checkPortrait(png), `portrait.png is the recorded 256x192 RGBA image${png ? ': ' + (checkPortrait(png) ?? 'hash drift') : ''}`)
		portrait = sidecar.source
	} else if (existsSync(pngPath)) notes.push(`${dir}: portrait.png present but not shipped; npm run roleportraits (every build runs it)`)
	packReports.push({ dir, id: m.id, role: m.role, actors, refusedClaims: m.slots.filter(a => !actors.includes(a)), triangles,
		atlas: atlas?.manifest.id, suppliedInput: m.suppliedInput.id, study: m.parentSourcePath, portrait,
		muzzle: muzzle && { source: muzzle.source, bone: pack.levels[0].rig.skeleton.names[muzzle.bone], pos: muzzle.pos.map(v => +v.toFixed(5)), anchor: muzzle.anchor.map(v => +v.toFixed(5)) } })
}
for (const dir of readdirSync(FORGE).filter(d => existsSync(join(FORGE, d, 'portrait.json'))))
	if (!loaded.packs.some(p => p.dir === dir) && !SURFACE_ONLY_DIRS.has(dir)) fail(`${dir}: portrait.json ships for a pack the loader refuses (stale; npm run roleportraits)`)

// --- forged manifests are refused before a byte is fetched ------------------------------------
const negatives = []
for (const pack of loaded.packs) {
	const m = pack.manifest, dir = pack.dir, url = meshCandidates.find(c => c.dir === dir).url, atlasSource = atlases.get(m.id).manifest.sourceSha256
	const rifle = dir === api.RIFLE_PACK.dir, inBody = m.levels[0].bounds[1].slice()
	const cases = [
		['bone position drift', x => { x.levels[1].rig.bones[3].pos[1] += .001 }], ['bone count', x => { x.levels[0].rig.bones.pop() }],
		['secondary rig animation', x => { x.levels[0].rig.rotors.push({ bone: 1, speed: 1 }) }],
		['forged motion manifest binding', x => { x.motionBinding.manifestSha256 = '0'.repeat(64) }],
		['forged bind-rig hash', x => { x.motionBinding.bindRigSha256 = '0'.repeat(64) }],
		['foreign reference model', x => { x.motionBinding.referenceModelSourceSha256 = '0'.repeat(64) }],
		['wrong parent atlas', x => { x.parentSourceSha256 = '0'.repeat(64) }],
		['LOD0 budget', x => { x.levels[0].triangles = 6001 }], ['LOD2 budget', x => { x.levels[2].triangles = 601 }],
		['non-decreasing LODs', x => { x.levels[1].triangles = x.levels[0].triangles }],
		['private source path', x => { x.levels[0].sourcePath = '/Users/private/test.blend' }],
		['mixed studies', x => { x.levels[2].sourcePath = 'art/blender/assets/studies/other-study-lod2-v1.blend' }],
		['unapproved source bytes', x => { x.suppliedInput.bytes++ }], ['false CC0 label', x => { x.suppliedInput.licenseStatus = 'CC0-1.0' }],
		['unlocked supplied input', x => { x.suppliedInput.id = 'not-in-the-lock' }],
		['material set', x => { x.levels[1].materialSet = 'infantry-v1' }], ['MakeHuman identity', x => { x.id = 'infantry-v1' }],
		['muzzle on a missing bone', x => { x.muzzle = { pos: inBody, bone: 'barrel_tip' } }],
		['muzzle outside the body', x => { x.muzzle = { pos: [2, .2, 0], bone: 'hand_r' } }],
		['muzzle extra field', x => { x.muzzle = { pos: inBody, bone: 'hand_r', lift: 1 } }],
		...(rifle ? [['rifle claims e1', x => { x.slots.push('e1') }], ['rifle renamed', x => { x.id = 'planx-rifle-v2' }]]
			: [['borrows the rifle identity', x => { x.id = api.RIFLE_PACK.id }]]),
	]
	for (const [name, mutate] of cases) {
		const edited = structuredClone(m); mutate(edited)
		const before = fetched.length
		try { await api.verifyRolePack(edited, dir, url, atlasSource, reference, motionText); fail(`${dir}: accepted a forged manifest (${name})`) }
		catch { if (fetched.length !== before) fail(`${dir}: fetched bytes before refusing ${name}`) }
		negatives.push(`${dir}: ${name}`)
	}
	const before = fetched.length
	await assert.rejects(api.verifyRolePack(m, dir, 'https://foreign.invalid/lods.ssmesh.gz', atlasSource, reference, motionText), /same-origin/)
	if (fetched.length !== before) fail(`${dir}: fetched a cross-origin pack`)
	const atlas = structuredClone(atlases.get(m.id).manifest); atlas.layers[0].mips[0][0].bytes--
	await assert.rejects(api.verifyRoleSurfacePack(atlas, dir, `${ORIGIN}/forge/${dir}-surfaces/surfaces.sspbr.gz`))
	if (fetched.length !== before) fail(`${dir}: fetched a malformed atlas`)
	negatives.push(`${dir}: cross-origin pack`, `${dir}: malformed atlas range`)
}
// A declared muzzle and the derived one must agree when they name the same point.
const probe = loaded.packs.find(p => p.muzzle?.source === 'derived')
if (probe) {
	const declared = structuredClone(probe.manifest)
	declared.muzzle = { pos: [...probe.muzzle.pos], bone: probe.levels[0].rig.skeleton.names[probe.muzzle.bone] }
	const url = meshCandidates.find(c => c.dir === probe.dir).url
	const again = await api.verifyRolePack(declared, probe.dir, url, atlases.get(declared.id).manifest.sourceSha256, reference, motionText)
	if (again.muzzle?.source !== 'manifest' || again.muzzle.anchor.some((v, i) => Math.abs(v - probe.muzzle.anchor[i]) > 1e-9))
		fail(`${probe.dir}: a declared muzzle at the derived point resolves to a different anchor`)
}

// --- claims: the rifle's actors, duplicates and non-humans ------------------------------------
const fake = (dir, slots) => ({ dir, manifest: { slots } })
// The remodelled rifleman pack owns e1, the shipped rifle keeps e1r1, and nobody else may
// claim either; any other pack reaching for a rifle slot is refused for that actor alone.
const reserved = api.assignRoleSlots([fake('e1', ['e1']), fake(api.RIFLE_PACK.dir, ['e1r1']), fake('troop-x', ['e1r1', 'e2'])], canWear)
assert.equal(reserved.actors.get('e1').dir, 'e1'); assert.equal(reserved.actors.get('e1r1').dir, api.RIFLE_PACK.dir); assert.equal(reserved.actors.get('e2').dir, 'troop-x')
assert.ok(reserved.refused.some(r => r.startsWith('troop-x: e1r1')))
const duplicate = api.assignRoleSlots([fake('troop-a', ['e3']), fake('troop-b', ['e3', 'e4'])], canWear)
assert.ok(!duplicate.actors.has('e3') && duplicate.actors.get('e4').dir === 'troop-b' && duplicate.refused.length === 1)
const nonHuman = api.assignRoleSlots([fake('troop-a', ['dog', '1tnk', 'e3'])], canWear)
assert.deepEqual([...nonHuman.actors.keys()], ['e3']); assert.equal(nonHuman.refused.length, 2)

// --- flags --------------------------------------------------------------------------------------
const rifleOnly = await api.loadRolePacks(reference, id => atlases.get(id)?.manifest.sourceSha256, dir => dir === api.RIFLE_PACK.dir)
assert.ok(rifleOnly.packs.every(p => p.dir === api.RIFLE_PACK.dir), 'roleunits=0 must load the rifle alone')
const fetchedBefore = fetched.length
const none = await api.loadRolePacks(reference, id => atlases.get(id)?.manifest.sourceSha256, () => false)
assert.equal(none.packs.length + none.failures.length, 0); assert.equal(fetched.length, fetchedBefore, 'a pack switched off must fetch nothing')
const portraitFlags = {}
for (const search of ['', '?roleunits=0', '?rifleunits=0', '?humanunits=0']) {
	globalThis.location.search = search
	const { productionPortrait } = await importText(productionText, search || 'default')
	const query = new URLSearchParams(search), table = {}
	for (const report of packReports) for (const actor of report.actors) {
		const shipped = report.portrait !== 'none', off = query.get('humanunits') === '0' ||
			api.rolePackFlagState(report.actors, query.get('rifleunits'), query.get('roleunits')) === 'off'
		const got = productionPortrait(actor), expectRole = shipped && !off
		table[actor] = got?.includes(`/forge/${report.dir}/portrait.png`) ? report.dir : got ? 'roster' : null
		if (expectRole !== (table[actor] === report.dir)) fail(`portrait for ${actor} under '${search}': got ${table[actor]}, want ${expectRole ? report.dir : 'roster'}`)
	}
	portraitFlags[search || 'default'] = table
}
globalThis.location.search = ''

const cpu = {
	schema: 1, pass: failures.length === 0, motionSha256, reference: reference.manifest.id,
	candidates: { meshes: meshCandidates.map(c => c.dir), atlases: surfaceCandidates.map(c => c.dir) },
	packs: packReports, actors: Object.fromEntries([...assigned.actors].map(([actor, pack]) => [actor, pack.manifest.id])),
	refused: { packs: [...atlasFailures, ...loaded.failures], claims: assigned.refused },
	vramPlan: { low: api.planRoleSurfaces(true).vramBytes * atlases.size, other: api.planRoleSurfaces(false).vramBytes * atlases.size },
	negativesRejectedBeforeFetch: negatives.length, portraitFlags, notes,
	scope: 'Real loaders on the present packs with disk-backed globs and fetch; CPU only (no GPU upload, no skinning on screen).',
}
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'rolepacksgate.json'), JSON.stringify(cpu, null, 2) + '\n')
console.log(`${TOOL}: ${loaded.packs.length} pack(s) verified [${loaded.packs.map(p => p.dir).join(', ')}], ${Object.keys(cpu.actors).length} actor(s) dressed, ` +
	`${negatives.length} forged manifests refused before fetch, ${failures.length} failure(s)`)
for (const report of packReports) console.log(`  ${report.dir} (${report.id}) -> ${report.actors.join(', ') || 'no actors'}; triangles ${report.triangles}; ` +
	`muzzle ${report.muzzle ? `${report.muzzle.source} ${report.muzzle.bone} aimed [${report.muzzle.anchor}]` : 'none'}; portrait ${report.portrait}`)
for (const note of notes) console.log(`  note: ${note}`)

// --- GPU: what units actually built, per flag set ---------------------------------------------
if (gpu) {
	const { launchGpuBrowser, loadChromium } = await import('./harness.mjs')
	const { spawnProcessGroup, stopProcessGroup } = await import('./process-group.mjs')
	const dist = resolve(arg('dist') ?? join(WEB, 'dist')), port = Number(arg('port') ?? 8493)
	const maps = readdirSync(join(dist, 'assets')).filter(name => name.endsWith('.js.map'))
	const sources = new Map()
	for (const map of maps) {
		const parsed = readJson(join(dist, 'assets', map))
		parsed.sources.forEach((source, i) => sources.set(source.replace(/^(\.\.\/)+/, '').replace(/^.*?\/web\//, ''), parsed.sourcesContent?.[i]))
	}
	for (const file of ['src/units/index.ts', 'src/units/role-assets.ts', 'src/materials/index.ts', 'src/materials/role-surfaces.ts', 'src/core/role-pack.ts', 'src/ui/production.ts']) {
		const key = [...sources.keys()].find(k => k.endsWith(file))
		assert.ok(key, `${file} missing from ${dist}: build before running --gpu`)
		assert.equal(sources.get(key), readFileSync(join(WEB, file), 'utf8'), `${file} is stale in ${dist}: rebuild before running --gpu`)
	}
	const builtName = path => readdirSync(join(dist, 'assets')).find(name => sha(readFileSync(join(dist, 'assets', name))) === sha(readFileSync(path)))
	const roleAssets = loaded.packs.flatMap(p => [builtName(join(FORGE, p.dir, 'lods.ssmesh.gz')), builtName(join(FORGE, `${p.dir}-surfaces/surfaces.sspbr.gz`))]).filter(Boolean)
	const rifleActors = new Set(api.RIFLE_FAMILY_ACTORS)
	const watched = [...new Set([...assigned.actors.keys(), 'e1', 'e1r1', 'e3'])]
	const cases = [
		// e7 never wears the old .forge/riki pack on the default path: the dedicated
		// riki slot (units/index.ts rikiSlot priority) dresses it from RIKI_MATERIAL
		// ('riki-meshy-v1'), which outranks any roleBodies claim in every case that
		// loads riki at all; the CPU baseline predates that priority.
		{ name: 'default', query: '', expect: actor => actor === 'e7' ? 'riki-meshy-v1' : cpu.actors[actor] ?? null },
		{ name: 'roleunits=0', query: '&roleunits=0', expect: actor => rifleActors.has(actor) ? cpu.actors[actor] ?? null : null },
		{ name: 'rifleunits=0&roleunits=0', query: '&rifleunits=0&roleunits=0', expect: () => null, e1: 'infantry-v1' },
		{ name: 'humanunits=0', query: '&humanunits=0', expect: () => null, noRoleFetches: true },
	]
	// Direct vite binary: npx resolves through the ancestor games/ workspaces and
	// aborts on their duplicate-name conflict (repo rule 6), so the preview never starts.
	const server = spawnProcessGroup(process.execPath, [join(WEB, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--outDir', dist],
		{ cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'] })
	let browser
	const gpuReport = { dist, cases: [] }
	try {
		const base = `http://127.0.0.1:${port}/`
		for (let i = 0; ; i++) {
			try { if ((await networkFetch(base)).ok) break } catch {}
			if (i > 200) throw new Error(`${TOOL}: preview server did not start on ${port}`)
			await new Promise(r => setTimeout(r, 100))
		}
		;({ browser } = await launchGpuBrowser(await loadChromium(TOOL), TOOL))
		for (const c of cases) {
			const page = await browser.newPage({ viewport: { width: 960, height: 640 } }), errors = [], requests = []
			page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url()))
			await page.goto(`${base}?devmap=1&manual=1&deterministic=1&devsize=48&quality=low&weather=clear${c.query}`)
			// Boot-order race: ctx can exist before the units plugin registers its
			// buckets; the evaluate below reads slotBuckets, so wait for it directly.
			await page.waitForFunction(() => {
				const u = globalThis.steelseed?.ctx?.get?.('units')
				return !!u && u.slotBuckets instanceof Map && u.slotBuckets.size > 0
			}, undefined, { timeout: 120000, polling: 200 })
			const seen = await page.evaluate(({ watched, ids }) => {
				const ctx = steelseed.ctx, u = ctx.get('units'), materials = ctx.get('materials')
				return {
					backend: ctx.backend, roleActors: Object.fromEntries(u.roleActors), errors: u.forgeStats.errors.filter(e => e.startsWith('role ')),
					atlases: Object.fromEntries(ids.map(id => [id, materials.has(id) ? materials.get(id).sourceSha256 : null])),
					// The per-mesh muzzleBind/muzzleLift maps moved into Attachments.resolve
					// (runtime actor pose) — no static slot-level readback exists anymore;
					// muzzle validity stays pinned node-side from the pack manifests.
					buckets: Object.fromEntries(watched.map(actor => {
						const b = u.slotBuckets.get(actor)
						return [actor, b ? { surface: b.surfaceSet, triangles: b.mesh.lods?.map(l => l.indexCount / 3) ?? null, fit: u.slotGround?.get?.(actor)?.fitScale ?? 1 } : null]
					})),
				}
			}, { watched, ids: [...atlases.keys()] })
			await page.close()
			const where = `gpu ${c.name}`
			if (seen.backend !== 'webgpu') fail(`${where}: backend ${seen.backend}, the role atlases need WebGPU`)
			if (errors.length) fail(`${where}: page errors ${errors.join(' | ')}`)
			for (const actor of watched) {
				const want = c.expect(actor), got = seen.roleActors[actor] ?? null, bucket = seen.buckets[actor]
				if (got !== want) fail(`${where}: ${actor} wears ${got ?? 'its roster model'}, want ${want ?? 'its roster model'}`)
				if (!bucket) continue
				if (want && bucket.surface !== want) fail(`${where}: ${actor} samples ${bucket.surface}, want ${want}`)
				if (!want && got === null && bucket.surface === cpu.actors[actor]) fail(`${where}: ${actor} still samples its role atlas with the pack off`)
				const pack = want && loaded.packs.find(p => p.manifest.id === want)
				if (pack) {
					if (JSON.stringify(bucket.triangles) !== JSON.stringify(pack.levels.map(l => l.mesh.triangleCount))) fail(`${where}: ${actor} LODs ${bucket.triangles}`)
					// Runtime muzzle binding moved to Attachments.resolve (per-actor pose);
					// its correctness is exercised by the live-fire bridge/actorgate muzzle
					// witnesses, while this gate pins the pack muzzle data node-side.
				}
			}
			if (c.e1 && seen.buckets.e1?.surface !== c.e1) fail(`${where}: e1 samples ${seen.buckets.e1?.surface}, want ${c.e1}`)
			if (c.name === 'default') for (const { dir } of [...atlasFailures, ...loaded.failures])
				if (!seen.errors.some(e => e.includes(dir))) fail(`${where}: boot did not report the refused pack ${dir}`)
			if (c.noRoleFetches) {
				if (Object.values(seen.atlases).some(Boolean)) fail(`${where}: a role atlas was uploaded`)
				const leaked = requests.filter(url => roleAssets.some(name => url.endsWith('/' + name)))
				if (leaked.length) fail(`${where}: fetched ${leaked.join(', ')}`)
			}
			gpuReport.cases.push({ name: c.name, roleActors: seen.roleActors, errors: seen.errors, buckets: seen.buckets, requests: requests.length })
			console.log(`${TOOL}: gpu ${c.name}: ${Object.keys(seen.roleActors).length} actor(s) in role packs, ${seen.errors.length} boot refusal(s)`)
		}
	} finally {
		await browser?.close()
		await stopProcessGroup(server)
	}
	writeFileSync(join(OUT, 'rolepacksgate-gpu.json'), JSON.stringify({ schema: 1, pass: failures.length === 0, ...gpuReport }, null, 2) + '\n')
}

console.log(failures.length ? `${TOOL}: FAIL — ${failures.length} problem(s)` : `${TOOL}: PASS`)
process.exit(failures.length ? 1 : 0)
