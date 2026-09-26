#!/usr/bin/env node
// STEELSEED — VFX census (vfx.md Epic 1): every actor, weapon use and special action the game
// can reach, resolved by the engine players run, joined with what the presentation draws.
//
// Source of truth. The rules come from `Program.GetRulesCensus()` in the shipping AppBundle,
// booted in Node (runtime-vfs-fixture): OpenRA's own loader after inheritance, removals and
// map overrides, written through FieldSaver. No YAML is parsed here.
//
// Reachability is a fixed point per selectable faction:
//   - start from the lobby's StartingUnits and the player actor's tech prerequisites;
//   - owned actors provide prerequisites (ProvidesPrerequisite, honouring Factions and
//     RequiresPrerequisites) and production queues (Production.Produces);
//   - a Buildable joins when a producer for its queue is owned and its prerequisites are
//     provided (a negated "!x" never blocks: it is satisfiable by not building x);
//   - owned actors also bring what they spawn: SpawnActorOnDeath, Transforms, FreeActor,
//     Cargo.InitialUnits, support-power aircraft and drops, mines, pilots, sell spawns, drivers.
// Map-placed actors (and their spawns) join per map. Everything else is inactive.
//
// Every trait field ending in "Weapon" or "Weapons" (and FallsToEarth's Explosion) that names a
// weapon is a weapon use, so a death, detonation or support-power weapon can't be missed.
//
// Row states follow vfx.md: working-and-represented, simulated-but-invisible,
// visible-without-authority, order-unavailable, unarmed/support-only, inactive, unresolved.
// An unresolved active row is a defect; `--check` fails on one, and on a committed census
// that no longer matches the runtime.
//
// Usage (from web/, with the composed AppBundle in engine/bin-browser/AppBundle):
//   node tools/vfxcensus.mjs            write docs/vfx/census.json and docs/vfx/census.md
//   node tools/vfxcensus.mjs --check    regenerate in memory, compare, assert coverage
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { bootVfsRuntime } from '../../engine/steelseed-host/tools/runtime-vfs-fixture.mjs'

const CHECK = process.argv.includes('--check')
const repo = resolve(import.meta.dirname, '../..')
const OUT = join(repo, 'docs/vfx')
const readJson = path => JSON.parse(readFileSync(join(repo, path), 'utf8'))

// --- runtime rules -------------------------------------------------------------------------
const { program } = await bootVfsRuntime()
const raw = program.GetRulesCensus()
const rules = JSON.parse(raw)
if (rules.status === 'error') throw new Error(`census export failed: ${rules.code}: ${rules.userMessage ?? rules.message}`)
assert.equal(rules.schemaVersion, 1, 'unknown census schema')
const build = readJson('engine/steelseed-host/generated/build.json')

// --- presentation inputs -------------------------------------------------------------------
const visualManifest = readJson('web/src/weapon-visual-manifest.json')
const presentation = readJson('web/src/core/presentation-manifest.json')
const roster = readJson('web/src/core/ra-visual-manifest.json')
const displayRoster = { ...roster.actors, ...(roster.structures ?? {}) }
// Runtime proof per weapon use and action comes from the scenario runner (Epic 9); until a
// scenario has shown a row in the real game, its state is data-level and `verified` is null.
const EVIDENCE = 'docs/vfx/scenario-evidence.json'
const evidence = existsSync(join(repo, EVIDENCE)) ? readJson(EVIDENCE) : { weapons: {}, actions: {} }
const visualByName = new Map(), visualByLower = new Map()
for (const profile of visualManifest.profiles) {
	if (!visualByName.has(profile.weapon)) visualByName.set(profile.weapon, profile)
	if (!visualByLower.has(profile.weapon.toLowerCase())) visualByLower.set(profile.weapon.toLowerCase(), profile)
}
// The same lookup fx/weapon-visuals.ts `lookupRaWeaponVisual` performs: exact, then lowercase.
const visualOf = name => visualByName.get(name) ?? visualByLower.get(String(name).toLowerCase()) ?? null

// Provenance, from the files that define each actor. Every actor comes from OpenRA's RA mod
// (engine/openra/mods/ra/rules); the Steelseed mod adds none and overrides gameplay only where
// deployment-rules.yaml says so (assetless-presentation.yaml strips presentation, not rules).
// Within the RA mod, the Aftermath expansion's units are named; RA95 and OpenRA's own additions
// are not told apart here.
const LOCAL_RULES = new Set(readFileSync(join(repo, 'engine/steelseed-host/mod/deployment-rules.yaml'), 'utf8')
	.split('\n').map(l => /^([A-Za-z0-9._-]+):/.exec(l)?.[1]).filter(Boolean).map(n => n.toLowerCase()))
const AFTERMATH = new Set(['ctnk', 'ttnk', 'qtnk', 'dtrk', 'mech', 'shok', 'msub', 'stnk'])

// --- helpers ---------------------------------------------------------------------------------
const list = value => String(value ?? '').split(',').map(s => s.trim()).filter(Boolean)
const lower = s => String(s).toLowerCase()
const SYSTEM = new Set(['world', 'player', 'editorworld', 'editorplayer'])
function traitsOf(actors, name) { return actors[name] ?? actors[lower(name)] ?? null }
function traits(actors, name, type) { return (traitsOf(actors, name) ?? []).filter(t => t.type === type) }
function allTraits(actors, name) { return traitsOf(actors, name) ?? [] }
const actorKey = (actors, name) => (actors[name] ? name : actors[lower(name)] ? lower(name) : null)

// --- reachability ----------------------------------------------------------------------------
const SPAWNS = [
	['SpawnActorOnDeath', ['Actor']], ['Transforms', ['IntoActor']], ['FreeActor', ['Actor']],
	['Cargo', ['InitialUnits']], ['ParatroopersPower', ['UnitType', 'DropItems']], ['AirstrikePower', ['UnitType']],
	['ProduceActorPower', ['Actors']], ['Minelayer', ['Mine']], ['EjectOnDeath', ['PilotActor']],
	['SpawnActorsOnSell', ['ActorTypes', 'GuaranteedActorTypes']], ['MadTank', ['DriverActor']],
	['ProductionAirdrop', ['ActorType']], ['CrateSpawner', ['CrateActors', 'DeliveryAircraft']],
	['AirstrikePower', ['CameraActor']], ['ParatroopersPower', ['CameraActor']], ['SpawnActorPower', ['Actor']],
	['InfiltrateForSupportPower', ['Proxy']], ['HarvesterHuskModifier', ['FullHuskActor']],
]
function spawnsOf(actors, name) {
	const out = []
	for (const trait of allTraits(actors, name))
		for (const [type, fields] of SPAWNS)
			if (trait.type === type) for (const field of fields) for (const target of list(trait.fields[field])) out.push({ target, via: `${type}.${field}` })
	return out
}

function reachable(actors, faction) {
	const owned = new Map() // actor -> reason
	const provided = new Set(), queues = new Set()
	const add = (name, reason) => {
		const key = actorKey(actors, name)
		if (!key || owned.has(key)) return false
		owned.set(key, reason); return true
	}
	for (const trait of traits(actors, 'world', 'StartingUnits')) {
		const factions = list(trait.fields.Factions)
		if (factions.length && !factions.includes(faction)) continue
		for (const actor of [trait.fields.BaseActor, ...list(trait.fields.SupportActors)]) if (actor) add(actor, `starting units (${trait.fields.Class})`)
	}
	for (const trait of traits(actors, 'player', 'ProvidesTechPrerequisite')) for (const p of list(trait.fields.Prerequisites)) provided.add(p)
	// The crate spawner is a lobby checkbox; its crates and delivery aircraft are reachable.
	for (const { target, via } of spawnsOf(actors, 'world')) add(target, via)
	// "~" hides a prerequisite from the tooltip and "!" negates it; RA writes both as "~!x".
	const satisfied = prerequisites => list(prerequisites).every(p => { const t = p.replace(/^~/, ''); return t.startsWith('!') || provided.has(t) })
	for (let changed = true; changed;) {
		changed = false
		for (const [name] of owned) {
			for (const trait of allTraits(actors, name)) {
				if (trait.type === 'ProvidesPrerequisite') {
					const factions = list(trait.fields.Factions)
					if (factions.length && !factions.includes(faction)) continue
					if (!satisfied(trait.fields.RequiresPrerequisites)) continue
					const token = trait.fields.Prerequisite || name
					if (!provided.has(token)) { provided.add(token); changed = true }
				}
				if (trait.type === 'Production') for (const q of list(trait.fields.Produces)) if (!queues.has(q)) { queues.add(q); changed = true }
			}
			for (const { target, via } of spawnsOf(actors, name)) if (add(target, `${via} of ${name}`)) changed = true
		}
		for (const name of Object.keys(actors)) {
			if (owned.has(name) || SYSTEM.has(name)) continue
			for (const trait of traits(actors, name, 'Buildable')) {
				if (!list(trait.fields.Queue).some(q => queues.has(q))) continue
				if (!satisfied(trait.fields.Prerequisites)) continue
				if (add(name, `built (${list(trait.fields.Queue).join('/')})`)) changed = true
			}
		}
	}
	return owned
}

const factions = traits(rules.actors, 'world', 'Faction').filter(t => t.fields.Selectable === 'True').map(t => t.fields.InternalName)
const active = new Map() // actor -> { factions:Set, reasons:Set, maps:Set, owners:Set }
const mark = (name, how) => {
	if (!active.has(name)) active.set(name, { factions: new Set(), reasons: new Set(), maps: new Set(), owners: new Set() })
	const row = active.get(name)
	if (how.faction) row.factions.add(how.faction)
	if (how.reason) row.reasons.add(how.reason)
	if (how.map) row.maps.add(how.map)
	for (const owner of how.owners ?? []) row.owners.add(owner)
}
/** Actions that need a particular target actor: without one reachable, the order cannot be given. */
const ACTION_TARGETS = { RepairsBridges: ['bridgehut', 'bridgehut.small'] }
/** The cargo types some active transport accepts (Cargo Types); filled once reachability is known. */
const CARGO_TYPES = new Set()
/** Map owners that are never a player: an actor placed only for them is never the player's to order. */
const NON_PLAYER_OWNERS = new Set(['Neutral', 'Creeps'])
for (const faction of factions) for (const [name, reason] of reachable(rules.actors, faction)) mark(name, { faction, reason })
for (const map of rules.maps) {
	const actors = map.customRules ? { ...rules.actors, ...map.actorOverrides } : rules.actors
	if (map.customRules) for (const faction of factions) for (const [name, reason] of reachable(actors, faction)) if (!active.has(name) || !active.get(name).factions.has(faction)) mark(name, { faction, reason: `${reason} on ${map.title}`, map: map.title })
	const queue = Object.keys(map.placed).map(type => ({ type, reason: `placed on map` }))
	const seen = new Set()
	while (queue.length) {
		const { type, reason } = queue.shift()
		const key = actorKey(actors, type)
		if (!key || seen.has(key)) continue
		seen.add(key); mark(key, { reason, map: map.title, owners: reason === 'placed on map' ? Object.keys(map.placed[type] ?? {}) : [] })
		for (const { target, via } of spawnsOf(actors, key)) queue.push({ type: target, reason: `${via} of ${key}` })
	}
}

for (const name of active.keys())
	for (const t of traits(rules.actors, name, 'Cargo')) for (const type of list(t.fields.Types ?? '')) CARGO_TYPES.add(type)

// --- weapon uses -------------------------------------------------------------------------------
const weaponField = name => /Weapons?$/.test(name) || name === 'Explosion'
function weaponUses(actors, name) {
	const uses = []
	for (const trait of allTraits(actors, name))
		for (const [field, value] of Object.entries(trait.fields))
			if (weaponField(field)) for (const weapon of list(value)) if (rules.weapons[lower(weapon)]) uses.push({ trait: trait.type, instance: trait.instance ?? '', field, weapon, fields: trait.fields })
	return uses
}
const offsetsOf = value => { const n = list(value).map(Number); const out = []; for (let i = 0; i + 2 < n.length; i += 3) out.push(n.slice(i, i + 3)); return out }
function warheadSummary(weapon) {
	const effects = new Set(), damage = [], clusters = []
	for (const w of weapon.warheads) {
		if (w.type === 'CreateEffectWarhead') for (const e of list(w.fields.Explosions)) effects.add(e)
		if (/DamageWarhead$/.test(w.type)) damage.push(Number(w.fields.Damage) || 0)
		if (w.type === 'FireClusterWarhead' && w.fields.Weapon) clusters.push(w.fields.Weapon)
	}
	return { explosions: [...effects].sort(), damage: damage.reduce((a, b) => a + b, 0), clusters, types: [...new Set(weapon.warheads.map(w => w.type))].sort() }
}
const SUPPORT_FAMILIES = new Set(['heal', 'utility', 'melee'])

// --- actions ---------------------------------------------------------------------------------
// Trait → the action it gives, and the gate that proves it end to end (null: unverified).
const ACTIONS = [
	[/^Captures$/, 'capture a building', 'specialactiongate (captured)'],
	[/^InfiltrateForCash$/, 'infiltrate: steal cash', 'specialactiongate (cash)'],
	[/^InfiltrateForPowerOutage$/, 'infiltrate: power outage', 'spyoutagegate (POWR, APWR)'],
	[/^Infiltrate(For|To)/, 'infiltrate consequence', null],
	[/^Infiltrates$/, 'infiltrate (actor side)', 'spyoutagegate, specialactiongate'],
	[/^C4Demolition$|^Demolition$/, 'demolition charge', 'specialactiongate (c4)'],
	[/^RepairsBridges$/, 'repair a bridge', null], [/^EngineerRepair$|^RepairsUnits$/, 'repair', null],
	[/^Guard$/, 'guard (G)', 'guardgate'], [/^Harvester$/, 'harvest', null],
	[/^Transforms$/, 'deploy / transform', null], [/^Minelayer$/, 'lay mines', null],
	[/^Cloak$/, 'cloak', null], [/^Disguise$/, 'disguise', null], [/^PortableChrono$/, 'chrono jump', null],
	[/^MadTank$/, 'MAD detonation', null], [/^JamsMissiles$/, 'missile jamming', null],
	[/^CreatesShroud$/, 'gap generator shroud', null], [/^AttackLeap$/, 'leap attack', null],
	[/^Cargo$/, 'load / unload', null], [/^Passenger$/, 'enter transport', null],
	[/^NukePower$/, 'support power: nuke', 'supportpowergate (bot nuke, Atomic impact)'],
	[/^GrantExternalConditionPower$/, 'support power: iron curtain', 'supportpowergate (Iron Curtain)'],
	[/^ChronoshiftPower$/, 'support power: chronoshift', 'supportpowergate (two-click Chronoshift)'],
	// A support power's trait ends in Power; the bare `Power` trait is a building's power draw.
	[/^\w+Power$/, 'support power', null], [/^Sellable$/, 'sell', null], [/^RepairableBuilding$/, 'repair building', null],
	[/^GrantConditionOnDeploy$/, 'deploy', null], [/^Capturable$/, 'can be captured', 'specialactiongate (captured)'],
]

// The Ultra and Ultra+ layers fx adds per visual family (fx/index.ts, fx/vfx-budget.ts); the
// legacy presets draw the family's base shot and strike only.
const ULTRA_LAYERS = {
	cannon: 'directed muzzle gas and hot core, ground dust from 90mm up, turret kick from Recoil; strike haze, surface debris, scorch that burns the grass',
	artillery: 'as cannon, plus the trajectory ribbon',
	bullet: 'spent case from the side of the gun; strike puff by surface, splinters off wood',
	mg: 'spent case from the side of the gun; strike puff by surface, splinters off wood',
	rocket: 'strike haze, surface debris, scorch; water column and mist',
	torpedo: 'water column and mist',
	electric: 'Tesla: white-hot core, violet fringe, seeded branches (3 Ultra, 5 Ultra+), pooled lights, contact crawl, coil flare',
	flame: 'strike burn: scorch and ground fire',
	heal: 'mend cue where OpenRA lands the heal or repair',
	utility: 'mend cue where OpenRA lands the heal or repair',
}
// Per action: how the player orders it, what the presentation shows, how long it lasts, and who
// may see it (OpenRA's own rules on relationships and fog).
const ACTION_DETAILS = {
	'capture a building': { ui: 'select the engineer, right-click the building', animation: 'the engineer enters', duration: 'on entry', entitlement: 'everyone who sees the building sees its new owner' },
	'infiltrate: steal cash': { ui: 'select the thief or spy, right-click the refinery or silo', animation: 'the infiltrator enters', duration: 'on entry', entitlement: 'the infiltrator\'s side sees its cash rise; the victim\'s cash is withheld from others' },
	'infiltrate: power outage': { ui: 'select the spy, right-click the power plant', animation: 'the spy enters', duration: 'InfiltrateForPowerOutage Duration (500 ticks)', entitlement: 'the victim\'s HUD counts the outage down' },
	'infiltrate consequence': { ui: 'select the infiltrator, right-click the building', animation: 'the infiltrator enters', duration: 'per trait', entitlement: 'per trait' },
	'infiltrate (actor side)': { ui: 'select the infiltrator, right-click an enemy building', animation: 'the infiltrator enters', duration: 'on entry', entitlement: 'as the consequence' },
	'demolition charge': { ui: 'select the commando, right-click the building', animation: 'the charge is set, then the building blows', duration: 'C4 delay', entitlement: 'everyone who sees the building' },
	'repair a bridge': { ui: 'select the engineer, right-click the bridge hut', animation: 'the engineer enters', duration: 'on entry', entitlement: 'everyone who sees the bridge' },
	'repair': { ui: 'a unit right-clicked onto the service depot (RepairsUnits), or an engineer onto a damaged building (EngineerRepair)', animation: 'the repair marker', duration: 'until full health', entitlement: 'owner' },
	'guard (G)': { ui: 'G, then click an own unit (Guard) or ground (Defend and move)', animation: 'Guard cursor preview', duration: 'until another order', entitlement: 'owner' },
	'harvest': { ui: 'automatic; right-click ore', animation: 'the harvester drives to ore and back', duration: 'continuous', entitlement: 'everyone who sees the harvester' },
	'deploy / transform': { ui: 'the Deploy button or the deploy key', animation: 'the actor becomes its deployed type', duration: 'the transform time', entitlement: 'everyone who sees it' },
	'lay mines': { ui: 'select the minelayer, click the Deploy button or order a minefield', animation: 'mines appear under it', duration: 'per mine', entitlement: 'mines are hidden from enemies (Cloak: Mine) unless detected' },
	'cloak': { ui: 'automatic when idle', animation: 'the actor fades from enemy view; owner and allies keep seeing it', duration: 'until it fires or is detected', entitlement: 'owner and allies; withheld from enemies' },
	'disguise': { ui: 'select the spy, right-click a soldier', animation: 'the spy wears the disguise (disguise ring for its owner)', duration: 'until it attacks or is revealed', entitlement: 'enemies see the disguise' },
	'chrono jump': { ui: 'select the Chrono Tank, use its deploy order and click a cell', animation: 'a jump, flashing at both ends (Ultra)', duration: 'instant; recharge per rules', entitlement: 'everyone who sees either end' },
	'MAD detonation': { ui: 'select the MAD tank, press Detonate', animation: 'seismic rings on each thump, a cratered detonation (Ultra)', duration: 'the MadTank charge time', entitlement: 'everyone who sees it' },
	'missile jamming': { ui: 'passive', animation: 'the jammer and missile ranges while selected', duration: 'continuous while not disabled', entitlement: 'owner and allies see the ranges' },
	'gap generator shroud': { ui: 'passive', animation: 'the shroud range while selected; enemies see black shroud', duration: 'continuous while powered', entitlement: 'owner and allies see the range' },
	'leap attack': { ui: 'automatic against infantry', animation: 'the dog leaps', duration: 'one leap', entitlement: 'everyone who sees it' },
	'load / unload': { ui: 'right-click the transport; the Deploy button unloads', animation: 'passengers enter or leave', duration: 'per passenger', entitlement: 'everyone who sees the transport' },
	'enter transport': { ui: 'select infantry, right-click the transport', animation: 'the passenger enters', duration: 'on entry', entitlement: 'everyone who sees the transport' },
	'support power: nuke': { ui: 'the SUPPORT button, then a click on the target', animation: 'the missile climbs and falls; beacon for allies, launch warning for everyone else; the staged strike', duration: 'FlightDelay (400 ticks); the public timer while it charges', entitlement: 'beacon: launcher\'s allies; timer and warning: everyone' },
	'support power: iron curtain': { ui: 'the SUPPORT button, the footprint preview, a click', animation: 'crimson field and timer bar on each curtained unit', duration: 'Duration (400 ticks)', entitlement: 'everyone who sees the unit' },
	'support power: chronoshift': { ui: 'the SUPPORT button, source click, destination click (footprint previews)', animation: 'the units jump, flashing at both ends (Ultra); allies see the return timer', duration: 'Duration (400 ticks) until the return', entitlement: 'return timer: owner and allies' },
	'support power': { ui: 'the SUPPORT button and a click where it takes a target', animation: 'per power: beacon for airstrikes, chutes for drops, the satellite rising, the sonar rings', duration: 'per power', entitlement: 'per power, as OpenRA shows it' },
	'sell': { ui: 'the Sell button, then a click on the building', animation: 'the building is dismantled; a crew may walk out', duration: 'the sell time', entitlement: 'everyone who sees it' },
	'repair building': { ui: 'select the building, the Repair button', animation: 'repair marker over the building', duration: 'until full health or stopped', entitlement: 'owner' },
	'deploy': { ui: 'the Deploy button', animation: 'the deployed state', duration: 'per rules', entitlement: 'everyone who sees it' },
	'can be captured': { ui: '—', animation: 'the new owner\'s colours', duration: 'on capture', entitlement: 'everyone who sees it' },
}

// --- rows ------------------------------------------------------------------------------------
const actorRows = [], weaponRows = [], actionRows = []
for (const name of Object.keys(rules.actors).sort()) {
	if (SYSTEM.has(name) || name.startsWith('^')) continue
	const reach = active.get(name)
	const display = displayRoster[name]?.displayName ?? ''
	const uses = weaponUses(rules.actors, name)
	const armaments = uses.filter(u => u.trait === 'Armament')
	const has = type => allTraits(rules.actors, name).some(t => t.type === type)
	const state = !reach ? 'inactive' : armaments.length === 0 ? 'unarmed/support-only' : 'armed'
	actorRows.push({
		actor: name, display, state, active: Boolean(reach),
		factions: reach ? [...reach.factions].sort() : [], reasons: reach ? [...reach.reasons].sort().slice(0, 4) : [],
		maps: reach ? reach.maps.size : 0, placedFor: reach ? [...reach.owners].sort() : [],
		selectable: has('Selectable'), mobile: has('Mobile') ? 'ground' : has('Aircraft') ? 'air' : '',
		armaments: armaments.map(a => a.weapon), otherWeapons: uses.filter(u => u.trait !== 'Armament').map(u => `${u.trait}.${u.field}=${u.weapon}`),
		presentation: Boolean(presentation.actors[name]),
		provenance: LOCAL_RULES.has(name) ? 'OpenRA RA mod, local override' : AFTERMATH.has(name) ? 'OpenRA RA mod, Aftermath expansion'
			: has('Selectable') ? 'OpenRA RA mod' : 'OpenRA RA mod, helper',
		ammo: traits(rules.actors, name, 'AmmoPool').reduce((sum, t) => sum + (Number(t.fields.Ammo) || 0), 0),
		conditions: [...new Set(allTraits(rules.actors, name).flatMap(t => ['Condition', 'DeployedCondition', 'DisguisedCondition', 'CloakedCondition', 'InvulnerabilityCondition']
			.map(f => t.fields[f]).filter(c => c && !/^[!~]/.test(c))))].sort(),
		death: evidence.actions[`${name}:death`] ?? null,
	})
	if (!reach) continue
	for (const use of uses) {
		const weapon = rules.weapons[lower(use.weapon)]
		const profile = visualOf(use.weapon)
		const family = profile?.style?.family ?? null
		const warheads = warheadSummary(weapon)
		const row = {
			actor: name, trait: use.trait, instance: use.instance, field: use.field, weapon: use.weapon,
			projectile: weapon.projectile?.type ?? 'none', burst: Number(weapon.fields.Burst), burstDelays: weapon.fields.BurstDelays,
			reload: Number(weapon.fields.ReloadDelay), explosions: warheads.explosions, damage: warheads.damage,
			clusters: warheads.clusters, report: weapon.fields.Report ?? '', family, profile: profile?.weapon ?? null,
			ultra: ULTRA_LAYERS[family] ?? '—',
			verified: evidence.weapons[`${name}:${use.trait}.${use.field}:${lower(use.weapon)}`] ?? null,
		}
		if (use.trait === 'Armament') {
			const barrels = offsetsOf(use.fields.LocalOffset)
			const sockets = presentation.actors[name]?.armaments?.find(a => lower(a.weapon) === lower(use.weapon))
			Object.assign(row, { barrels: barrels.length, sockets: sockets?.sockets?.length ?? 0, recoil: use.fields.Recoil })
			row.state = !profile ? 'unresolved' : family === 'unknown' ? 'unresolved' : 'working-and-represented'
			const shared = sockets && barrels.length > 1 && new Set(sockets.barrels.map(c => c.join(','))).size < barrels.length
			row.note = !profile ? 'no visual profile for this weapon'
				: !sockets && presentation.actors[name] === undefined ? 'no authored model sockets: the rules muzzle offset is used'
				: !sockets ? 'model has no socket for this weapon: the rules muzzle offset is used'
				: shared ? `model authors ${sockets.sockets.length} socket(s) for ${barrels.length} barrels: split per barrel at the rules LocalOffset (units/attachments withRulesBarrels), except where a role rig supplies the hand socket (Riki)`
				: ''
		} else {
			// Death, detonation and support-power weapons draw through the impact and destroyed
			// consumers, keyed by weapon identity since M1; they carry no armament profile.
			row.state = warheads.explosions.length > 0 || warheads.damage > 0 ? 'working-and-represented' : 'simulated-but-invisible'
			row.note = `${use.trait} weapon: drawn by the impact/destroyed consumers (${warheads.explosions.join(', ') || 'no CreateEffect'})`
		}
		weaponRows.push(row)
	}
	for (const trait of allTraits(rules.actors, name)) {
		const match = ACTIONS.find(([pattern]) => pattern.test(trait.type))
		if (!match) continue
		const proof = match[2] ?? evidence.actions[`${name}:${trait.type}`] ?? null
		const detail = ACTION_DETAILS[match[1]] ?? {}
		// Placed on the maps for Neutral or Creeps only, and reached no other way: no player ever
		// owns it, so no player can give it this order.
		const reach = active.get(name)
		const unowned = !proof && reach && [...reach.reasons].every(r => r === 'placed on map') && reach.owners.size > 0 && [...reach.owners].every(o => NON_PLAYER_OWNERS.has(o))
		// An action whose only targets no shipped map ever places cannot be given; nor can a
		// passenger's, when no active transport's Cargo accepts its CargoType.
		const targets = ACTION_TARGETS[trait.type]
		const noCargo = trait.type === 'Passenger' && !CARGO_TYPES.has(trait.fields.CargoType ?? '')
		const targetless = !proof && !unowned && ((targets && !targets.some(t => active.has(t))) || noCargo)
		actionRows.push({ actor: name, trait: trait.type, instance: trait.instance ?? '', action: match[1],
			gate: proof ?? (unowned ? `placed for ${[...reach.owners].join('/')} only: never a player's actor`
				: targetless ? (noCargo ? `no transport takes its CargoType (${trait.fields.CargoType || 'none'}; active Cargo types: ${[...CARGO_TYPES].join(', ')})`
				: `no shipped map places its target (${targets.join(', ')} inactive)`) : null),
			state: proof ? 'working-and-represented' : unowned || targetless ? 'order-unavailable' : 'unverified',
			ui: detail.ui ?? '', animation: detail.animation ?? '', duration: detail.duration ?? '', entitlement: detail.entitlement ?? '' })
	}
}

// --- output ----------------------------------------------------------------------------------
const count = (rows, key) => rows.reduce((m, r) => (m[r[key]] = (m[r[key]] ?? 0) + 1, m), {})
const census = {
	schemaVersion: 1,
	source: { engine: rules.engine, simBuild: build.simBuild, export: 'OpenRA.Browser Program.GetRulesCensus', tool: 'web/tools/vfxcensus.mjs' },
	factions,
	summary: {
		actors: Object.keys(rules.actors).length - SYSTEM.size, active: actorRows.filter(r => r.active).length,
		actorStates: count(actorRows, 'state'), weaponUseStates: count(weaponRows, 'state'), actionStates: count(actionRows, 'state'),
		maps: rules.maps.length, mapsWithCustomRules: rules.maps.filter(m => m.customRules).map(m => m.title),
		weaponUsesVerifiedInGame: weaponRows.filter(r => r.verified).length,
	},
	actors: actorRows, weaponUses: weaponRows, actions: actionRows,
}
const md = [
	'# VFX census (vfx.md Epic 1)', '',
	`Generated by \`web/tools/vfxcensus.mjs\` from the rules the engine resolves (\`Program.GetRulesCensus\`, OpenRA \`${rules.engine.slice(0, 7)}\`, simBuild \`${build.simBuild}\`). Do not edit by hand.`, '',
	`- Actors: ${census.summary.actors}, of which ${census.summary.active} are reachable (selectable factions: ${factions.join(', ')}; ${rules.maps.length} maps, custom rules on ${census.summary.mapsWithCustomRules.length}).`,
	`- Actor states: ${JSON.stringify(census.summary.actorStates)}`,
	`- Weapon-use states: ${JSON.stringify(census.summary.weaponUseStates)}; shown in the real game by a scenario: ${census.summary.weaponUsesVerifiedInGame} of ${weaponRows.length} (\`${EVIDENCE}\`). A row without that proof is represented in data (visual profile, model socket, fire and impact events) but not yet witnessed.`,
	`- Action states: ${JSON.stringify(census.summary.actionStates)}`, '',
	'## Weapon uses on reachable actors', '',
	'Per preset: the legacy presets draw each family\'s base shot and strike; Ultra and Ultra+ add the layers in the "Ultra layers" column (fx/vfx-budget: particles 2048 / 3072 / 4096, scorch 0 / 192 / 320, VFX lights unlimited / 32 / 48; Ultra\'s governor thins decorative density only, down to 40%; Ultra+ is fixed).', '',
	'| Actor | Use | Weapon | Projectile | Burst / reload | Barrels / sockets | Visual family | Ultra layers | Explosions | State | Shown in game by | Note |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
	...weaponRows.map(r => `| ${r.actor} | ${r.trait}${r.instance ? '@' + r.instance : ''}.${r.field} | ${r.weapon} | ${r.projectile} | ${r.burst} / ${r.reload} | ${r.barrels ?? '–'} / ${r.sockets ?? '–'} | ${r.family ?? '—'} | ${r.ultra} | ${r.explosions.join(', ') || '—'} | ${r.state} | ${r.verified ?? '—'} | ${r.note ?? ''} |`),
	'', '## Special actions on reachable actors', '',
	'| Actor | Trait | Action | UI path | Presentation | Duration | Who sees it | Proven by | State |', '|---|---|---|---|---|---|---|---|---|',
	...actionRows.map(r => `| ${r.actor} | ${r.trait}${r.instance ? '@' + r.instance : ''} | ${r.action} | ${r.ui} | ${r.animation} | ${r.duration} | ${r.entitlement} | ${r.gate ?? '—'} | ${r.state} |`),
	'', '## Actors', '',
	'| Actor | Name | Provenance | State | Factions | Reached by | Movement | Armaments | Ammo | Conditions | Other weapons | Model sockets | Death shown in game |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
	...actorRows.map(r => `| ${r.actor} | ${r.display} | ${r.provenance} | ${r.state} | ${r.factions.join(', ')} | ${r.reasons.join('; ')}${r.maps ? ` (+${r.maps} maps)` : ''} | ${r.mobile} | ${r.armaments.join(', ')} | ${r.ammo || '—'} | ${r.conditions.join(', ') || '—'} | ${r.otherWeapons.join(', ')} | ${r.presentation ? 'yes' : 'no'} | ${r.death ?? '—'} |`),
	'',
].join('\n')

const unresolved = weaponRows.filter(r => r.state === 'unresolved')
if (CHECK) {
	const committed = existsSync(join(OUT, 'census.json')) ? JSON.parse(readFileSync(join(OUT, 'census.json'), 'utf8')) : null
	assert.ok(committed, 'docs/vfx/census.json is missing: run node tools/vfxcensus.mjs')
	assert.deepEqual(committed, JSON.parse(JSON.stringify(census)), 'docs/vfx/census.json is stale: rerun node tools/vfxcensus.mjs')
} else {
	mkdirSync(OUT, { recursive: true })
	writeFileSync(join(OUT, 'census.json'), JSON.stringify(census, null, '\t') + '\n')
	writeFileSync(join(OUT, 'census.md'), md)
}
console.log(`vfxcensus: ${census.summary.active}/${census.summary.actors} actors reachable; weapon uses ${JSON.stringify(census.summary.weaponUseStates)}; actions ${JSON.stringify(census.summary.actionStates)}`)
assert.deepEqual(unresolved.map(r => `${r.actor}: ${r.weapon}`), [], 'active weapon uses without a visual profile')
console.log(`vfxcensus: PASS${CHECK ? ' (committed census current)' : ' — wrote docs/vfx/census.json and census.md'}`)
process.exit(0)
