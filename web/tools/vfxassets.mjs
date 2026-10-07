// STEELSEED — VFX asset register (vfx.md Epic 1): for every reachable actor, the assets the
// presentation draws it with and what it lacks, joined from the manifests the game already ships.
// Nothing here is authored by hand, and no asset is added.
//
// Inputs:
//   docs/vfx/census.json                the reachable actors and weapon uses (web/tools/vfxcensus.mjs)
//   web/.forge/blender/manifest.json    the models: template, rig, geometry, source .blend and sha
//   web/.forge/damage-states/*/         the authored damage rungs and their health thresholds
//   web/.forge/{human,track,tree}-lods  the LOD packs
//   web/.forge/{sfx,voices,music}/      the sound banks
//   web/src/core/presentation-manifest.json   the model sockets per armament
//   web/src/weapon-visual-manifest.json the projectile bodies and trails per weapon
//   web/src/content-manifest.json       the particle presets
//   web/forge-baseline.json, art/sources.lock.json, art/supplied-inputs.lock.json   provenance
//
// Usage (from web/, with the forge packs restored): node tools/vfxassets.mjs
// Writes docs/vfx/assets.md.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '../..')
const web = join(repo, 'web')
const forge = join(web, '.forge')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const maybe = path => existsSync(path) ? read(path) : null
if (!existsSync(join(forge, 'blender/manifest.json'))) throw new Error('vfxassets: web/.forge is not restored (npm run forge:assets, or the pinned baseline)')

const census = read(join(repo, 'docs/vfx/census.json'))
const blender = read(join(forge, 'blender/manifest.json')).assets
const presentation = read(join(web, 'src/core/presentation-manifest.json')).actors
const visuals = read(join(web, 'src/weapon-visual-manifest.json')).profiles
const content = read(join(web, 'src/content-manifest.json'))
const baseline = read(join(web, 'forge-baseline.json'))
const sources = maybe(join(repo, 'art/sources.lock.json'))
const supplied = maybe(join(repo, 'art/supplied-inputs.lock.json'))

const damage = new Map()
for (const actor of readdirSync(join(forge, 'damage-states'))) {
	const m = maybe(join(forge, 'damage-states', actor, 'manifest.json'))
	if (m) damage.set(actor.toLowerCase(), m)
}
const lodPacks = ['human-lods', 'track-lods', 'tree-lods'].map(id => ({ id, manifest: maybe(join(forge, id, 'manifest.json')) }))
const bank = dir => existsSync(join(forge, dir)) ? readdirSync(join(forge, dir))
	.map(name => ({ name, manifest: maybe(join(forge, dir, name, 'manifest.json')) })).filter(b => b.manifest) : []
const sfx = bank('sfx'), voices = bank('voices')
const music = existsSync(join(forge, 'music')) ? readdirSync(join(forge, 'music')).filter(f => /\.(m4a|mp3)$/.test(f)) : []
const visualOf = weapon => visuals.find(p => p.weapon === weapon) ?? visuals.find(p => p.weapon.toLowerCase() === String(weapon).toLowerCase()) ?? null

const actorNames = new Set(census.actors.map(a => a.actor))
const huskOf = name => [...actorNames].filter(n => n.startsWith(`${name}.`) && /husk/.test(n))
const reportsOf = name => [...new Set(census.weaponUses.filter(u => u.actor === name && u.trait === 'Armament').map(u => u.report).filter(Boolean))]
const rigSummary = rig => {
	if (!rig) return '—'
	const kinds = rig.bones?.reduce((m, b) => (m[b.kind] = (m[b.kind] ?? 0) + 1, m), {}) ?? {}
	const parts = []
	if (rig.turretBones?.length) parts.push(`${rig.turretBones.length} turret`)
	if (rig.wheelBones?.length) parts.push(`${rig.wheelBones.length} wheel`)
	if (rig.rotors?.length) parts.push(`${rig.rotors.length} rotor`)
	if (rig.legBones?.length) parts.push(`${rig.legBones.length} leg`)
	if (kinds[17]) parts.push(`${kinds[17]} cloth`)
	if (rig.oscillators?.length) parts.push(`${rig.oscillators.length} oscillator`)
	return parts.join(', ') || `${rig.bones?.length ?? 0} bones`
}

const VEHICLE_TEMPLATES = new Set(['tank', 'truck'])
const RUNG_TEMPLATES = new Set(['tank', 'truck', 'helicopter', 'plane', 'ship', 'defense', 'power', 'tech', 'dock', 'radar', 'yard',
	'airfield', 'command', 'depot', 'missile_silo', 'experimental', 'house'])
const rows = [], missing = []
for (const a of census.actors.filter(a => a.active && a.state !== 'inactive')) {
	const model = blender[a.actor] ?? null
	const rungs = damage.get(a.actor)
	const sockets = presentation[a.actor]?.armaments?.map(arm => `${arm.weapon}:${arm.sockets?.length ?? 0}`) ?? []
	const lacks = []
	// Helpers the player never sees (upgrade markers, cameras) need no model.
	if (!model && (a.selectable || a.presentation)) lacks.push(a.presentation ? 'model (procedural or shared fallback)' : 'model')
	if (a.armaments.length && !sockets.length) lacks.push('sockets (rules muzzle used)')
	// Authored damage rungs exist for buildings, aircraft and ships; vehicles show damage as smoke
	// and fire (fx/damage-smoke, fx/vehicle-cookoff), soldiers and scenery have none to show.
	if (!rungs && model && RUNG_TEMPLATES.has(model.template) && !/husk/.test(a.actor)) lacks.push(VEHICLE_TEMPLATES.has(model.template) ? 'damage rungs (smoke and fire only)' : 'damage rungs')
	rows.push({
		actor: a.actor,
		model: model ? `${model.template}, ${model.triangles} tris${model.skinned ? ', skinned' : ''}` : '—',
		source: model?.sourcePath ? `${model.sourcePath.replace(/^art\/blender\/assets\//, '')} \`${model.sourceSha256.slice(0, 8)}\`` : '—',
		rig: rigSummary(model?.rig),
		rungs: rungs ? rungs.thresholds.map(t => t.state).join(', ') : '—',
		sockets: sockets.join(', ') || '—',
		sounds: reportsOf(a.actor).join(', ') || '—',
		wreck: huskOf(a.actor).join(', ') || '—',
		lacks,
	})
	if (lacks.length) missing.push(`${a.actor}: ${lacks.join('; ')}`)
}

const weaponRows = [...new Map(census.weaponUses.filter(u => u.trait === 'Armament').map(u => [u.weapon, u])).values()]
	.sort((x, y) => x.weapon < y.weapon ? -1 : 1)
	.map(u => {
		const v = visualOf(u.weapon)
		const body = v?.projectile ? `${v.projectile.body}, ${v.projectile.lengthM} m, ${v.projectile.material}${v.projectile.exhaust ? ', exhaust' : ''}` : '—'
		const trail = v?.projectile?.trail ? `${v.projectile.trail.widthM} m × ${v.projectile.trail.lifetimeS} s` : v?.tracer?.style ?? '—'
		return `| ${u.weapon} | ${u.family ?? '—'} | ${u.projectile} | ${body} | ${trail} | ${u.explosions.join(', ') || '—'} | ${u.report || '—'} |`
	})

const md = [
	'# VFX asset register (vfx.md Epic 1)', '',
	'Generated by `web/tools/vfxassets.mjs` from the manifests the game ships; do not edit by hand. No asset was added by the VFX work: every effect is particles, instanced meshes or lights on the existing passes.', '',
	'## Provenance', '',
	`- Built art: forge baseline \`${baseline.tag}\` (\`${baseline.asset}\`, ${Math.round(baseline.bytes / 1e6)} MB, sha256 \`${baseline.sha256.slice(0, 16)}…\`), Blender ${baseline.blender}, from the private repository's release. The models are exported from the tracked \`.blend\` sources named per row.`,
	`- External sources: ${sources ? Object.keys(sources.sources ?? sources).length : 0} entries in \`art/sources.lock.json\` (CC0 and CC-BY 4.0 only; licence, author, URL and sha256 per entry).`,
	`- Supplied inputs: ${supplied ? Object.keys(supplied.inputs ?? supplied).length : 0} entries in \`art/supplied-inputs.lock.json\` (origin and licence recorded per entry; some still being verified).`,
	'- Sound: Suno (music), Cartesia and ElevenLabs (voices, effects), per THIRD_PARTY_NOTICES.md.', '',
	'## Reachable actors', '',
	`${rows.length} reachable actors; ${missing.length} lack a component (listed after the table).`, '',
	'| Actor | Model | Source (.blend, sha) | Rig | Damage rungs | Sockets (weapon:count) | Weapon sounds | Wreck | Lacks |', '|---|---|---|---|---|---|---|---|---|',
	...rows.map(r => `| ${r.actor} | ${r.model} | ${r.source} | ${r.rig} | ${r.rungs} | ${r.sockets} | ${r.sounds} | ${r.wreck} | ${r.lacks.join('; ') || '—'} |`),
	'', '### Missing components', '', ...missing.map(m => `- ${m}`),
	'', '## Weapons: projectile bodies, trails, impacts, sounds', '',
	'| Weapon | Visual family | Projectile | Body | Trail / tracer | Impact explosions | Report sound |', '|---|---|---|---|---|---|---|',
	...weaponRows,
	'', '## LOD packs', '',
	...lodPacks.map(p => `- \`${p.id}\`: ${p.manifest ? `${p.manifest.file}, ${Math.round((p.manifest.bytes ?? 0) / 1e3)} kB${p.manifest.assets ? `, ${Object.keys(p.manifest.assets).length} assets` : ''}` : 'not restored'}`),
	'', '## Particles, decals and water', '',
	`- Particle presets: ${content.particles.length} (\`web/src/content-manifest.json\`, generated from \`web/tools/content-seed.sql\`): ${content.particles.map(p => p.id).join(', ')}.`,
	'- Decals: impact scorch is a procedural, bounded decal pool (fx/impact-scorch; 0 / 192 / 320 marks by tier); ground tracks (fx/ground-tracks); no decal texture.',
	'- Water: naval wakes (fx/naval-wakes, `naval-wake-manifest.json`), utility water (fx/utility-water), the water columns and mist of strikes (particles).',
	'- Meshes built at load: the curtain dome and the parachute canopy (fx/curtain-domes, fx/parachutes), projectile bodies (fx/projectiles), the MushroomCloud stages; all SDF-meshed once, none during play.',
	'', '## Sound banks', '',
	...sfx.map(b => `- sfx \`${b.name}\`: ${Object.keys(b.manifest.effects ?? {}).length} effects`),
	...voices.map(b => `- voices \`${b.name}\`: ${Object.keys(b.manifest.lines ?? {}).length} lines`),
	`- music: ${music.join(', ') || 'none restored'}`,
	'', '## Shaders and pipelines', '',
	'- Render pipelines are created by `web/src/render/renderer.ts` for each material and vertex stride, and prewarmed at load (ARCHITECTURE §7). The VFX work adds no pipeline: S14 measured none created on the first Tesla discharge or the first Atomic.',
	'',
].join('\n')
writeFileSync(join(repo, 'docs/vfx/assets.md'), md)
console.log(`vfxassets: ${rows.length} actors, ${missing.length} lacking a component, ${weaponRows.length} weapons -> docs/vfx/assets.md`)
