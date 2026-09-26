// STEELSEED — ui/build-order
// The beginner build order, derived from the RA manifest rather than written by hand (owner,
// 2026-09-25: "tell people what to build, according to the manifest"). Prerequisites, what
// provides them, cost, power, free units and terrain all come from the actors' own traits,
// so a rules change moves the tutorial with it.

export interface ManifestTrait {
	readonly Name: string
	readonly Instance?: string
	readonly Fields: Readonly<Record<string, string>>
}

export interface ManifestActor {
	readonly displayName?: string
	readonly terrainTypes?: readonly string[] | null
	readonly production?: { readonly types?: readonly string[] } | null
	readonly traits?: readonly ManifestTrait[]
}

export type ManifestActors = Readonly<Record<string, ManifestActor>>

export type BuildRole = 'power' | 'economy' | 'production' | 'tech'
export type Side = 'allies' | 'soviet'

export interface BuildStep {
	/** Actor type, lower case: 'powr'. */
	readonly type: string
	readonly name: string
	readonly cost: number
	/** Positive supplies power, negative draws it. */
	readonly power: number
	readonly role: BuildRole
	/** What its production queue builds ('Infantry', 'Vehicle', …); empty when it builds nothing. */
	readonly produces: readonly string[]
	/** A unit that arrives with it, by name ('Ore Truck'); null when none. */
	readonly freeUnit: string | null
	/** Names of the structures it needs. */
	readonly needs: readonly string[]
	/** Names of the order's structures that it unlocks. */
	readonly unlocks: readonly string[]
	/** Radar: the building lights up the minimap radar (ProvidesRadar). */
	readonly radar: boolean
	/** How far its main sight reaches, in cells, when powered (RevealsShroud Range). */
	readonly reveal: number
	/** How many of this type the player owns once this step is done (a second Power Plant is 2). */
	readonly count: number
}

export interface BuildOrder {
	readonly side: Side | null
	/** The opening, in order: Power Plant → Ore Refinery → Barracks → War Factory → Power Plant → Radar Dome. */
	readonly core: readonly BuildStep[]
	/** The next tier, for "what comes next". */
	readonly later: readonly BuildStep[]
}

const CORE_DEPTH = 3
const LATER_DEPTH = 4

const traitsOf = (actor: ManifestActor | undefined, name: string): readonly ManifestTrait[] =>
	(actor?.traits ?? []).filter(trait => trait.Name === name)
const fieldOf = (actor: ManifestActor | undefined, trait: string, field: string): string =>
	traitsOf(actor, trait)[0]?.Fields[field] ?? ''
const list = (csv: string): string[] => csv.split(',').map(value => value.trim()).filter(Boolean)
const lower = (value: string): string => value.toLowerCase()

/** The prerequisites an actor provides for this faction (an empty Prerequisite is its own name). */
export function providedBy(actors: ManifestActors, type: string, faction: string): Set<string> {
	const out = new Set<string>()
	for (const trait of traitsOf(actors[type], 'ProvidesPrerequisite')) {
		const factions = list(trait.Fields.Factions ?? '').map(lower)
		if (factions.length > 0 && !factions.includes(lower(faction))) continue
		out.add(lower(trait.Fields.Prerequisite || type))
	}
	return out
}

/** The side a faction plays, from what its Construction Yard provides. */
export function sideOf(actors: ManifestActors, faction: string): Side | null {
	const provided = providedBy(actors, 'fact', faction)
	return provided.has('structures.allies') ? 'allies' : provided.has('structures.soviet') ? 'soviet' : null
}

function prerequisites(actor: ManifestActor | undefined): string[] {
	return list(fieldOf(actor, 'Buildable', 'Prerequisites')).map(lower)
}

/** `~` only hides an item; `!` inverts; tech levels are the lobby's business, so they count as met. */
function met(prerequisite: string, have: ReadonlySet<string>): boolean {
	const bare = prerequisite.replace(/^~/, '')
	const negated = bare.startsWith('!')
	const name = negated ? bare.slice(1) : bare
	if (name.startsWith('techlevel.')) return true
	return negated ? !have.has(name) : have.has(name)
}

function powerOf(actor: ManifestActor | undefined): number {
	return traitsOf(actor, 'Power').reduce((sum, trait) => sum + (Number(trait.Fields.Amount) || 0), 0)
}

/** The main RevealsShroud reach in whole cells ("16c0" → 16). */
function revealOf(actor: ManifestActor | undefined): number {
	const main = traitsOf(actor, 'RevealsShroud').find(trait => !trait.Instance)
	const match = /^(\d+)c(\d+)$/.exec(main?.Fields.Range ?? '')
	return match ? Number(match[1]) + Number(match[2]) / 1024 : 0
}

function freeUnitOf(actors: ManifestActors, actor: ManifestActor | undefined): string | null {
	const free = traitsOf(actor, 'FreeActor')[0]?.Fields.Actor
	return free ? actors[lower(free)]?.displayName ?? null : null
}

function roleOf(actors: ManifestActors, type: string): BuildRole {
	const actor = actors[type]
	if (powerOf(actor) > 0) return 'power'
	if (traitsOf(actor, 'Refinery').length > 0 || freeUnitOf(actors, actor) !== null) return 'economy'
	if ((actor?.production?.types?.length ?? 0) > 0) return 'production'
	return 'tech'
}

const ROLE_RANK: Readonly<Record<BuildRole, number>> = { power: 0, economy: 1, production: 2, tech: 3 }

const waterOnly = (actor: ManifestActor | undefined): boolean => {
	const terrain = actor?.terrainTypes ?? []
	return terrain.length > 0 && terrain.every(type => type === 'Water')
}

/**
 * The opening for a faction. Structures of the Construction Yard's `Building` queue are laid out
 * in tiers of prerequisite depth; inside a tier power comes first, then the economy, then
 * production, then palette order. The opening keeps land structures up to depth three that
 * unlock something or add a new kind of production (so Naval Yard, Sub Pen and Kennel drop out),
 * and adds a Power Plant wherever the next building would push the draw above the supply.
 */
export function beginnerBuildOrder(actors: ManifestActors, faction: string): BuildOrder {
	const side = sideOf(actors, faction)
	const have = new Set<string>(['fact', ...providedBy(actors, 'fact', faction)])
	const candidates = Object.keys(actors).filter(type => {
		const queues = list(fieldOf(actors[type], 'Buildable', 'Queue'))
		return queues.includes('Building') && !prerequisites(actors[type]).includes('~disabled')
	})
	const depth = new Map<string, number>()
	for (let tier = 1; tier <= LATER_DEPTH; tier++) {
		const available = candidates.filter(type => !depth.has(type) && prerequisites(actors[type]).every(p => met(p, have)))
		if (available.length === 0) break
		for (const type of available) depth.set(type, tier)
		for (const type of available) {
			have.add(type)
			for (const provided of providedBy(actors, type, faction)) have.add(provided)
		}
	}
	const byTier = (a: string, b: string): number =>
		depth.get(a)! - depth.get(b)! ||
		ROLE_RANK[roleOf(actors, a)] - ROLE_RANK[roleOf(actors, b)] ||
		Number(fieldOf(actors[a], 'Buildable', 'BuildPaletteOrder')) - Number(fieldOf(actors[b], 'Buildable', 'BuildPaletteOrder'))
	const land = [...depth.keys()].filter(type => !waterOnly(actors[type])).sort(byTier)

	// Which structure satisfies each prerequisite, so "needs anypower" reads "needs Power Plant".
	const providerName = (prerequisite: string): string | null => {
		for (const type of land) if (type === prerequisite || providedBy(actors, type, faction).has(prerequisite)) return actors[type]?.displayName ?? type
		return null
	}
	const needsOf = (type: string): string[] => {
		const names: string[] = []
		for (const raw of prerequisites(actors[type])) {
			const name = raw.replace(/^~/, '')
			if (name.startsWith('!') || name.startsWith('techlevel.') || name.startsWith('structures.')) continue
			const provider = providerName(name)
			if (provider && !names.includes(provider)) names.push(provider)
		}
		return names
	}
	const unlocksOf = (type: string, among: readonly string[]): string[] => {
		const provided = new Set([type, ...providedBy(actors, type, faction)])
		return among
			.filter(other => other !== type && prerequisites(actors[other]).some(p => provided.has(p.replace(/^~/, ''))))
			.map(other => actors[other]?.displayName ?? other)
	}

	const coreTypes: string[] = []
	const kinds = new Set<string>()
	let economy = false
	for (const type of land) {
		if (depth.get(type)! > CORE_DEPTH) continue
		const role = roleOf(actors, type)
		const produces = actors[type]?.production?.types ?? []
		const unlocksDeeper = land.some(other => depth.get(other)! > depth.get(type)! && unlocksOf(type, [other]).length > 0)
		if (role === 'power') { if (!coreTypes.some(t => roleOf(actors, t) === 'power')) coreTypes.push(type); continue }
		if (role === 'economy') { if (!economy) { economy = true; coreTypes.push(type) } continue }
		if (role === 'production') {
			const kind = produces[0] ?? ''
			if (kind && !kinds.has(kind)) { kinds.add(kind); coreTypes.push(type) }
			continue
		}
		if (unlocksDeeper) coreTypes.push(type)
	}
	const laterTypes = land.filter(type => depth.get(type) === LATER_DEPTH)
	const everything = [...coreTypes, ...laterTypes]

	const step = (type: string, count: number): BuildStep => {
		const actor = actors[type]
		return {
			type,
			name: actor?.displayName ?? type,
			cost: Number(fieldOf(actor, 'Valued', 'Cost')) || 0,
			power: powerOf(actor),
			role: roleOf(actors, type),
			produces: actor?.production?.types ?? [],
			freeUnit: freeUnitOf(actors, actor),
			needs: needsOf(type),
			unlocks: unlocksOf(type, everything),
			radar: traitsOf(actor, 'ProvidesRadar').length > 0,
			reveal: revealOf(actor),
			count,
		}
	}

	// Walk the opening with the manifest's power numbers: a building that would draw more than
	// the plants supply gets another plant first.
	const core: BuildStep[] = []
	const owned = new Map<string, number>()
	const plant = coreTypes.find(type => roleOf(actors, type) === 'power')
	let supplied = 0
	let drawn = 0
	for (const type of coreTypes) {
		const power = powerOf(actors[type])
		if (power < 0 && plant && drawn - power > supplied) {
			const next = (owned.get(plant) ?? 0) + 1
			owned.set(plant, next)
			core.push(step(plant, next))
			supplied += powerOf(actors[plant])
		}
		const next = (owned.get(type) ?? 0) + 1
		owned.set(type, next)
		core.push(step(type, next))
		if (power > 0) supplied += power
		else drawn -= power
	}
	return { side, core, later: laterTypes.map(type => step(type, 1)) }
}
