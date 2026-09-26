#!/usr/bin/env node
// STEELSEED — tools/roleportraits
//
// Ship each anatomical role pack's production portrait beside the pack. The modeling pass saves
// portraits under .artifacts/planx/ (riki/portrait.png, troops/<role>/portrait.png); the game
// reads web/.forge/<pack>/portrait.png plus a portrait.json sidecar naming the actors who wear
// that body (ui/production.ts). This tool is the only thing that writes the sidecar.
//
// A portrait ships only for a pack that passes the same metadata validators the game runs at
// boot (validateRolePackManifest / validateRoleSurfaceManifest, plus the live motion binding),
// so the palette cannot advertise a body the battlefield would refuse. The sidecar lists only the
// claims units would honour. A pack without a valid portrait keeps the roster portrait.
//
// Runs as the first step of `npm run build` and NEVER fails it: every problem is reported and the
// roster portrait stands in. Payload integrity -- hashes, decode, muzzle -- is rolepacksgate's job.
//
// Usage: node tools/roleportraits.mjs

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { decodePng } from './png.mjs'

const TOOL = 'roleportraits'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME = resolve(WEB, '..')
const FORGE = join(WEB, '.forge')
const ARTIFACTS = join(GAME, '.artifacts/planx')
const WIDTH = 256, HEIGHT = 192
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/** The game's own validators, bundled from source so this tool cannot drift from them. */
export async function loadRolePackApi() {
	const bundle = await build({
		stdin: { contents: `export { validateRolePackManifest } from './src/units/role-assets.ts'
export { validateRoleSurfaceManifest } from './src/materials/role-surfaces.ts'
export { BLENDER_HIDDEN_ACTORS } from './src/units/blender-assets.ts'
export { RIFLE_PACK, assignRoleSlots, canonicalRoleValue } from './src/core/role-pack.ts'`, resolveDir: WEB, loader: 'ts' },
		bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
		define: { 'import.meta.glob': '__emptyGlob' }, banner: { js: 'const __emptyGlob = () => ({});' },
	})
	return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
}

/** Every web/.forge/<dir>/manifest.json with the role-pack shape, in the registry's order. */
export function rolePackDirs(api) {
	// statSync follows a symlinked pack directory the way Vite's glob does; Dirent would not.
	const dirs = existsSync(FORGE) ? readdirSync(FORGE).filter(name => statSync(join(FORGE, name)).isDirectory()) : []
	const out = []
	for (const dir of dirs) {
		const path = join(FORGE, dir, 'manifest.json')
		if (!existsSync(path)) continue
		let manifest
		try { manifest = readJson(path) } catch { continue }
		if (manifest && typeof manifest === 'object' && 'role' in manifest && 'slots' in manifest && 'motionBinding' in manifest) out.push({ dir, manifest })
	}
	return out.sort((a, b) => a.dir === api.RIFLE_PACK.dir ? -1 : b.dir === api.RIFLE_PACK.dir ? 1 : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)
}

/** The live references a pack binds against, or a reason there are none. */
export function roleReferences() {
	const lods = join(FORGE, 'human-lods/manifest.json'), motion = join(FORGE, 'human-motion/manifest.json')
	if (!existsSync(lods) || !existsSync(motion)) return { error: 'the MakeHuman reference or its motion pack is absent' }
	const motionText = readFileSync(motion)
	return { reference: { manifest: readJson(lods), motion: { manifest: JSON.parse(motionText) } }, motionSha256: sha(motionText) }
}

/** Same predicate units applies before a pack may dress an actor. */
export function canWearFor(api) {
	const visuals = readJson(join(WEB, 'src/core/ra-visual-manifest.json')).actors
	const rosterPath = join(FORGE, 'blender/manifest.json')
	const roster = existsSync(rosterPath) ? readJson(rosterPath).assets : {}
	return actor => {
		const visual = visuals[actor], template = roster[actor]?.template
		return visual?.renderable === true && visual.visualFamily === 'infantry' && visual.slot?.family === 2 &&
			(template === undefined || template === 'infantry') && !api.BLENDER_HIDDEN_ACTORS.has(actor)
	}
}

/** Metadata validation exactly as boot runs it, minus the payload download. Throws the reason. */
export function validateRolePackMetadata(api, dir, manifest, refs) {
	const surfacesPath = join(FORGE, `${dir}-surfaces/manifest.json`)
	if (!existsSync(surfacesPath)) throw new Error(`${dir}-surfaces/manifest.json is absent`)
	if (!existsSync(join(FORGE, dir, 'lods.ssmesh.gz'))) throw new Error(`${dir}/lods.ssmesh.gz is absent`)
	const surfaces = readJson(surfacesPath)
	if (!existsSync(join(FORGE, `${dir}-surfaces/surfaces.sspbr.gz`))) throw new Error(`${dir}-surfaces/surfaces.sspbr.gz is absent`)
	api.validateRoleSurfaceManifest(surfaces, dir)
	if (surfaces.id !== manifest.id) throw new Error(`atlas id ${surfaces.id} is not pack id ${manifest.id}`)
	api.validateRolePackManifest(manifest, dir, surfaces.sourceSha256, refs.reference)
	if (manifest.motionBinding.manifestSha256 !== refs.motionSha256) throw new Error('bound to a different human-motion manifest than the one shipped')
	if (sha(api.canonicalRoleValue(manifest.levels[0].rig)) !== manifest.motionBinding.bindRigSha256) throw new Error('bind-rig checksum')
	return surfaces
}

/** Signature, IHDR and a full decode: 256x192, 8-bit RGBA, or the reason it is not. */
export function checkPortrait(bytes) {
	if (bytes.length < 33 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString('latin1', 12, 16) !== 'IHDR') return 'not a PNG'
	const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), depth = bytes[24], color = bytes[25]
	if (width !== WIDTH || height !== HEIGHT || depth !== 8 || color !== 6) return `${width}x${height} depth ${depth} colour type ${color}, want ${WIDTH}x${HEIGHT} 8-bit RGBA`
	try { decodePng(bytes) } catch (error) { return `does not decode: ${error.message}` }
	return null
}

/**
 * Where the modeling pass leaves this pack's portrait, most specific first. Pack directories come
 * with or without the rifle's `planx-` prefix (`planx-troop-e3`, `troop-e3`, `riki`).
 */
function artifactPortraits(dir, role) {
	const bare = dir.replace(/^planx-/, ''), troop = /^troop-(.+)$/.exec(bare)?.[1]
	const names = [
		...(troop ? [join(ARTIFACTS, 'troops', troop, 'portrait.png')] : []),
		join(ARTIFACTS, dir, 'portrait.png'), join(ARTIFACTS, bare, 'portrait.png'),
		join(ARTIFACTS, role, 'portrait.png'), join(ARTIFACTS, 'troops', role, 'portrait.png'),
	]
	return [...new Set(names)].filter(existsSync)
}

async function main() {
	const api = await loadRolePackApi()
	const refs = roleReferences(), canWear = canWearFor(api)
	const packs = rolePackDirs(api), loadable = [], valid = []
	for (const { dir, manifest } of packs) {
		const sidecar = join(FORGE, dir, 'portrait.json'), shipped = join(FORGE, dir, 'portrait.png')
		const refuse = reason => {
			if (existsSync(sidecar)) rmSync(sidecar)
			console.log(`${TOOL}: ${dir} keeps the roster portrait: ${reason}`)
		}
		try {
			if (refs.error) throw new Error(refs.error)
			validateRolePackMetadata(api, dir, manifest, refs)
		} catch (error) { refuse(`pack refused: ${error.message}`); continue }
		// Claims are contested among every pack units would load, portrait or not.
		loadable.push({ dir, manifest })
		const source = artifactPortraits(dir, manifest.role).find(path => !checkPortrait(readFileSync(path)))
		if (source) {
			const bytes = readFileSync(source)
			if (!existsSync(shipped) || sha(readFileSync(shipped)) !== sha(bytes)) copyFileSync(source, shipped)
		}
		if (!existsSync(shipped)) { refuse('no portrait.png from the modeling pass yet'); continue }
		const problem = checkPortrait(readFileSync(shipped))
		if (problem) { refuse(`portrait.png ${problem}`); continue }
		valid.push({ dir, manifest, source: source ? relative(GAME, source) : relative(GAME, shipped) })
	}
	// The sidecar carries only the claims units would honour, so the palette and the battlefield agree.
	const honoured = api.assignRoleSlots(loadable, canWear).actors
	for (const pack of valid) {
		const slots = pack.manifest.slots.filter(actor => honoured.get(actor)?.dir === pack.dir)
		const bytes = readFileSync(join(FORGE, pack.dir, 'portrait.png'))
		if (!slots.length) { rmSync(join(FORGE, pack.dir, 'portrait.json'), { force: true }); console.log(`${TOOL}: ${pack.dir} keeps the roster portrait: none of its claims is honoured`); continue }
		writeFileSync(join(FORGE, pack.dir, 'portrait.json'), JSON.stringify({ schema: 1, pack: pack.dir, id: pack.manifest.id, slots,
			sha256: sha(bytes), bytes: bytes.length, source: pack.source }, null, '\t') + '\n')
		console.log(`${TOOL}: ${pack.dir} -> ${slots.join(', ')} (${pack.source})`)
	}
	console.log(`${TOOL}: ${valid.length} of ${packs.length} role pack(s) ship a portrait`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// Never fail the build over a portrait: the roster portrait is always a correct fallback.
	try { await main() } catch (error) { console.warn(`${TOOL}: skipped, roster portraits stand: ${error?.stack ?? error}`) }
}
