#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOOL = 'ra-catalog'
const hostRoot = resolve(import.meta.dirname, '..')
const engineRoot = resolve(hostRoot, '..')
const gameRoot = resolve(engineRoot, '..')
const sourcePath = resolve(hostRoot, 'generated/ra-visual-source.json')
const policyPath = resolve(hostRoot, 'trait-audit-policy.json')
const generatedManifestPath = resolve(hostRoot, 'generated/ra-visual-manifest.json')
const auditPath = resolve(hostRoot, 'generated/ra-trait-audit.json')
const webManifestPath = resolve(gameRoot, 'web/src/core/ra-visual-manifest.json')
const updatePolicy = process.argv.includes('--update-audit-policy')
const rosterArg = process.argv.find(arg => arg.startsWith('--roster='))

function fail(message) {
	throw new Error(`${TOOL}: ${message}`)
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex')
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, '\t')}\n`)
}

function exportResolvedRoster() {
	if (rosterArg) return JSON.parse(readFileSync(resolve(rosterArg.slice('--roster='.length)), 'utf8'))
	const localDotnet = resolve(homedir(), '.dotnet/dotnet')
	const dotnet = process.env.STEELSEED_DOTNET ?? (existsSync(localDotnet) ? localDotnet : 'dotnet')
	const utility = resolve(engineRoot, 'bin/OpenRA.Utility.dll')
	if (!existsSync(utility)) fail(`OpenRA.Utility.dll is missing at the canonical build path: ${utility}`)
	const mod = resolve(hostRoot, 'generated/mods/ra')
	const result = spawnSync(dotnet, [utility, mod, '--steelseed-roster'], {
		cwd: engineRoot,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, ENGINE_DIR: resolve(engineRoot, 'openra') },
	})
	if (result.error) throw result.error
	if (result.status !== 0) fail(`resolved ActorInfo export failed (${result.status}): ${result.stderr || result.stdout}`)
	try { return JSON.parse(result.stdout) }
	catch (error) { fail(`resolved ActorInfo export was not JSON: ${error.message}`) }
}

const PRESENTATION = /(?:Render|Sprite|Palette|Tooltip|Decoration|Overlay|Animation|Body$|Voice|Sound|Radar|Pips|Selection|Cursor|MapPreview|PostProcess)/
const SHAPE_TRAITS = new Set([
	'Aircraft', 'Armament', 'Armor', 'AutoTargetPriority', 'BaseBuilding', 'Building',
	'Buildable', 'Cargo', 'Cloak', 'Harvester', 'Health', 'HitShape', 'Hovers', 'Husk',
	'Immobile', 'LineBuild', 'MadTank', 'Minelayer', 'Mobile', 'Passenger', 'Plug', 'Power',
	'Production', 'Refinery', 'Repairable', 'RepairsUnits', 'RevealsShroud', 'Selectable',
	'StoresResources', 'StoresPlayerResources', 'Transforms', 'Turreted', 'Valued',
])

function categoryForTrait(name) {
	if (SHAPE_TRAITS.has(name)) return 'procedural-shape-animation'
	if (PRESENTATION.test(name)) return 'removed-presentation'
	return 'simulation-only'
}

function traitNames(actor) {
	return new Set((actor.Traits ?? []).map(trait => trait.Name))
}

function fieldList(value) {
	if (Array.isArray(value)) return value
	if (value == null || value === '') return []
	return String(value).replace(/^\[/, '').replace(/\]$/, '').split(',').map(item => item.trim()).filter(Boolean)
}

function semanticRole(actor, source) {
	const traits = traitNames(actor)
	if (!source.renderable) return 'system'
	if (traits.has('Crate')) return 'crate'
	if (traits.has('Husk')) return 'wreck'
	if (traits.has('Building')) {
		if (traits.has('Plug')) return 'plug'
		if (traits.has('LineBuild')) return 'wall'
		if (actor.Refinery) return 'refinery'
		if ((actor.StorageCapacity ?? 0) > 0) return 'silo'
		const produces = source.productionTypes ?? []
		if (produces.some(type => /Submarine|Ship|Naval/i.test(type))) return 'naval-yard'
		if (produces.some(type => /Aircraft/i.test(type))) return 'airfield'
		if (produces.some(type => /Infantry/i.test(type))) return 'barracks'
		if (produces.length > 0) return 'factory'
		if ((actor.Power?.Amount ?? 0) > 0) return 'powerplant'
		if (traits.has('RepairsUnits') || traits.has('RepairableBuilding')) return 'repair'
		if (traits.has('GpsPower') || traits.has('ProvidesRadar') || traits.has('RadarProvider')) return 'radar'
		if (traits.has('Armament')) return 'defense'
		if ([...traits].some(name => /Power$/.test(name))) return 'superweapon'
		return 'structure'
	}
	if (traits.has('Aircraft')) return actor.Aircraft?.VTOL ? 'rotorcraft' : 'fixed-wing'
	if (traits.has('WithInfantryBody') || traits.has('WithDisguisingInfantryBody')) return 'soldier'
	if (traits.has('Mobile')) {
		if (source.visualFamily === 'vessel') return traits.has('Cloak') ? 'submarine' : 'ship'
		if (traits.has('BaseBuilding') || traits.has('Transforms')) return 'mcv'
		if (traits.has('Harvester')) return 'harvester'
		if (traits.has('Minelayer')) return 'minelayer'
		if ((actor.Cargo ?? 0) > 0) return 'transport'
		return source.visualFamily === 'wheeled' ? 'wheeled-vehicle' : 'tracked-vehicle'
	}
	return traits.has('Immobile') ? 'terrain-object' : 'prop'
}

function familyFor(actor, source, semantic) {
	if (!source.renderable) return 'system'
	if (semantic === 'wreck') return 'wreck'
	if (source.visualFamily === 'generic') return 'terrain-prop'
	return source.visualFamily
}

function generatorFamily(family, actor) {
	if (family === 'tracked' || family === 'wreck') return 0
	if (family === 'wheeled') return 1
	if (family === 'infantry') return 2
	if (family === 'rotorcraft') return 3
	if (family === 'fixedwing') return 4
	if (family === 'vessel') return 5
	if (family === 'structure') return (actor.Armament?.length ?? 0) > 0 ? 7 : 6
	return 7
}

function armourIndex(type) {
	const value = String(type ?? '').toLowerCase()
	if (/concrete|structure/.test(value)) return 4
	if (/heavy|steel/.test(value)) return 3
	if (/medium/.test(value)) return 2
	if (/light|wood/.test(value)) return 1
	return 0
}

function boundsFor(actor) {
	if (actor.Building?.Dimensions?.length === 2)
		return [Math.max(.5, Number(actor.Building.Dimensions[0])), Math.max(.5, Number(actor.Building.Dimensions[1]))]
	const bounds = actor.Selectable?.Bounds
	if (Array.isArray(bounds) && bounds.length >= 2)
		return [Math.max(.5, Number(bounds[0]) / 1024), Math.max(.5, Number(bounds[1]) / 1024)]
	const hit = actor.HitShape
	if (hit?.Type === 'Circle') {
		const diameter = Math.max(.5, Number(hit.Radius) * 2 / 1024)
		return [diameter, diameter]
	}
	if (hit?.Type === 'Rectangle' && hit.TopLeft && hit.BottomRight)
		return [Math.max(.5, Math.abs(hit.BottomRight[0] - hit.TopLeft[0]) / 1024), Math.max(.5, Math.abs(hit.BottomRight[1] - hit.TopLeft[1]) / 1024)]
	if (hit?.Type === 'Polygon' && hit.Points?.length) {
		const xs = hit.Points.map(point => point[0])
		const ys = hit.Points.map(point => point[1])
		return [Math.max(.5, (Math.max(...xs) - Math.min(...xs)) / 1024), Math.max(.5, (Math.max(...ys) - Math.min(...ys)) / 1024)]
	}
	return [1, 1]
}

function factionRequirements(actor) {
	const exact = []
	if (actor.Buildable?.ForceFaction) exact.push(actor.Buildable.ForceFaction)
	for (const prerequisite of actor.Buildable?.Prerequisites ?? [])
		if (/allied|soviet/i.test(prerequisite)) exact.push(prerequisite)
	return [...new Set(exact)].sort()
}

function factionFor(requirements) {
	if (requirements.some(value => /soviet/i.test(value))) return 0
	if (requirements.some(value => /allied/i.test(value))) return 1
	return 2
}

function versusBias(versus) {
	if (!versus) return 0
	const heavy = Number(versus.Heavy ?? versus.HeavyFrame ?? 100)
	const light = Number(versus.Light ?? versus.LightFrame ?? 100)
	return heavy + light > 0 ? (heavy - light) / (heavy + light) : 0
}

function projectileRole(weapon) {
	const value = `${weapon?.Projectile ?? ''} ${weapon?.ResolvedProjectile ?? ''}`.toLowerCase()
	if (/missile|rocket/.test(value)) return 'rocket'
	if (/gravity|lob|bomb/.test(value)) return 'lobbed'
	if (/bullet/.test(value)) return 'ballistic'
	return 'directFire'
}

function vecToModel(value) {
	return Array.isArray(value) && value.length >= 3
		? [Number(value[0]) / 1024, Number(value[2]) / 1024, Number(value[1]) / 1024]
		: [0, 0, 0]
}

function slotFor(actor, family, semantic, weapons, requirements) {
	const [lengthM, widthM] = boundsFor(actor)
	const armaments = (actor.Armament ?? []).map(armament => {
		const weapon = weapons[armament.Weapon] ?? null
		const warhead = weapon?.Warheads?.find(entry => Number.isFinite(entry.Damage)) ?? null
		return {
			name: armament.Name ?? 'primary',
			turret: armament.Turret ?? 'primary',
			weapon: armament.Weapon,
			muzzleM: vecToModel(armament.LocalOffset?.[0]),
			recoilM: Number(armament.Recoil ?? 0) / 1024,
			rangeM: Number(weapon?.Range ?? 0) / 1024,
			reloadTicks: Number(weapon?.ReloadDelay ?? 0),
			damage: Number(warhead?.Damage ?? 0),
			armourBias: versusBias(warhead?.Versus),
			burst: Number(weapon?.Burst ?? armament.Burst ?? 1),
			projectile: projectileRole(weapon),
		}
	})
	const primaryTurret = actor.Turrets?.[0] ?? actor.Turreted ?? null
	const turrets = (actor.Turrets ?? (primaryTurret ? [primaryTurret] : [])).map(turret => ({
		name: turret.Name ?? 'primary',
		turnSpeed: Number(turret.TurnSpeed),
		realignDelay: Number(turret.RealignDelay ?? 0),
		offsetM: vecToModel(turret.Offset),
	}))
	return {
		name: actor.name,
		faction: factionFor(requirements),
		family: generatorFamily(family, actor),
		archetype: semantic,
		lengthM,
		widthM,
		hp: Number(actor.Health?.HP ?? 1),
		armourIndex: armourIndex(actor.Armor?.Type),
		cost: Number(actor.Valued?.Cost ?? 0),
		buildTicks: Number(actor.BuildDuration ?? 0),
		speed: actor.Mobile ? Number(actor.Mobile.Speed) : actor.Aircraft ? Number(actor.Traits?.find(t => t.Name === 'Aircraft')?.Fields?.Speed ?? 0) : null,
		locomotor: actor.Mobile?.Locomotor ?? null,
		visionM: actor.RevealsShroud ? Number(actor.RevealsShroud.Range) / 1024 : null,
		targetsAir: actor.TargetsAir === true,
		vtol: actor.Aircraft?.VTOL ?? null,
		turret: primaryTurret ? { turnSpeed: Number(primaryTurret.TurnSpeed), offsetM: vecToModel(primaryTurret.Offset) } : null,
		turrets,
		armaments,
		powerAmount: Number(actor.Power?.Amount ?? 0),
		produces: Number(actor.Produces ?? 0),
		storageCapacity: Number(actor.StorageCapacity ?? 0),
		refinery: actor.Refinery === true,
		cargo: Number(actor.Cargo ?? 0),
		footprint: actor.Building?.Footprint ?? null,
		plan: actor.HitShape?.Type === 'Polygon' ? actor.HitShape.Points.map(point => [Number(point[0]) / 1024, Number(point[1]) / 1024]) : null,
		techDepth: actor.Buildable?.Prerequisites?.length ?? 0,
	}
}

if (!existsSync(sourcePath)) fail(`missing ${sourcePath}; run build-ra-mod.mjs first`)
const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
const roster = exportResolvedRoster()
const referenceActors = JSON.parse(readFileSync(resolve(hostRoot, 'ra-reference-actor-ids.json'), 'utf8'))
const expectedActors = [...referenceActors.actors, 'ssherobridge'].sort()
const actualActors = (roster.actors ?? []).map(actor => actor.name).sort()
if (referenceActors.actors.length !== 309 || new Set(referenceActors.actors).size !== 309 ||
    referenceActors.sourceCommit !== source.sourceCommit || roster.schemaVersion !== 2 ||
    JSON.stringify(actualActors) !== JSON.stringify(expectedActors))
    fail(`resolved actor set must preserve all 309 reference actors plus exactly ssherobridge; schema ${roster.schemaVersion}, missing=[${expectedActors.filter(id => !actualActors.includes(id))}], extra=[${actualActors.filter(id => !expectedActors.includes(id))}]`)

const allTraitNames = [...new Set(roster.actors.flatMap(actor => actor.Traits.map(trait => trait.Name)))].sort()
if (updatePolicy) {
	writeJson(policyPath, {
		schemaVersion: 1,
		sourceCommit: source.sourceCommit,
		traits: Object.fromEntries(allTraitNames.map(name => [name, categoryForTrait(name)])),
	})
	console.log(`${TOOL}: updated ${policyPath} with ${allTraitNames.length} resolved trait classifications`)
}
if (!existsSync(policyPath)) fail(`missing ${policyPath}; run once with --update-audit-policy and review it`)
const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
const unknown = allTraitNames.filter(name => policy.traits?.[name] == null)
const stale = Object.keys(policy.traits ?? {}).filter(name => !allTraitNames.includes(name))
if (unknown.length || stale.length)
	fail(`trait audit policy drift; unknown=[${unknown.join(', ')}] stale=[${stale.join(', ')}]`)

const actors = {}
const auditActors = {}
for (const actor of roster.actors) {
	const discovered = source.actors[actor.name]
	if (!discovered) fail(`resolved ActorInfo '${actor.name}' is absent from stripped-rule discovery`)
	const traits = traitNames(actor)
	const renderable = traits.has('RenderSprites') || traits.has('RenderSpritesEditorOnly')
	const base = { ...discovered, renderable }
	const semantic = semanticRole(actor, base)
	const family = familyFor(actor, base, semantic)
	const requirements = factionRequirements(actor)
	const slot = renderable ? slotFor(actor, family, semantic, roster.weapons, requirements) : null
	const descriptor = {
        ...(actor.name === 'ssherobridge' ? { presentationOwner: 'terrain', landmark: 'hero-bridge' } : {}),
		displayName: actor.displayName,
		renderable,
		role: renderable ? (family === 'structure' || family === 'terrain-prop' ? 'structure' : family === 'wreck' ? 'wreck' : 'unit') : 'system',
		visualFamily: family,
		semanticRole: semantic,
		dimensions: actor.Building?.Dimensions ?? null,
		hitShape: actor.HitShape,
		footprint: actor.Building?.Footprint ?? null,
		terrainTypes: discovered.terrainTypes ?? [],
		locomotor: actor.Mobile?.Locomotor ?? null,
		speed: actor.Mobile?.Speed ?? null,
		factionRequirements: requirements,
		health: actor.Health,
		armor: actor.Armor,
		production: { count: actor.Produces ?? 0, types: discovered.productionTypes ?? [], prerequisites: actor.Buildable?.Prerequisites ?? [] },
		power: actor.Power,
		storageCapacity: actor.StorageCapacity ?? 0,
		refinery: actor.Refinery === true,
		cargo: actor.Cargo ?? 0,
		aircraft: actor.Aircraft ?? null,
		turrets: actor.Turrets ?? [],
		armaments: actor.Armament ?? [],
		traits: actor.Traits,
		meshSeed: sha256(`openra:${actor.name}`).slice(0, 16),
		slot,
	}
	descriptor.descriptorHash = sha256(JSON.stringify({ name: actor.name, ...descriptor }))
	actors[actor.name] = descriptor
	auditActors[actor.name] = actor.Traits.map(trait => ({
		trait: trait.Name,
		instance: trait.Instance,
		classification: policy.traits[trait.Name],
		fields: Object.keys(trait.Fields).sort(),
	}))
}

const manifest = {
	schemaVersion: 2,
	sourceCommit: source.sourceCommit,
	actorCount: Object.keys(actors).length,
	renderableCount: Object.values(actors).filter(actor => actor.renderable).length,
	actors,
	projectiles: source.projectiles,
	terrain: source.terrain,
	structures: Object.fromEntries(Object.entries(actors).filter(([, actor]) => actor.role === 'structure')),
}
const audit = {
	schemaVersion: 1,
	sourceCommit: source.sourceCommit,
	actorCount: roster.actors.length,
	traitCount: allTraitNames.length,
	classifications: policy.traits,
	removedPresentation: JSON.parse(readFileSync(resolve(hostRoot, 'generated/assetstrip-report.json'), 'utf8')).removedTraits,
	actors: auditActors,
}

writeJson(generatedManifestPath, manifest)
writeJson(webManifestPath, manifest)
writeJson(auditPath, audit)
console.log(`${TOOL}: PASS — ${manifest.actorCount} audited, ${manifest.renderableCount} renderable, ${allTraitNames.length} resolved trait types`)
