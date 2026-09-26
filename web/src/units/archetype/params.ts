// STEELSEED — units/archetype/params
//
// §14.13's ruling made concrete: a roster slot's semantic archetype plus the functional
// numbers §14.12 permits ARE the generator's input. Cell footprint drives hull length,
// weapon range drives barrel length, reload rate drives breech bulk, armour class drives
// plate thickness. Nobody decides "this one looks heavy" — an expensive, slow, heavily
// armoured slot *generates* as a slab of cast steel because its numbers say so.
//
// This module is the whole mapping and nothing else. It is pure, allocation-light and has
// no GPU, mesh or geo dependency, so it can be exercised without a browser — which matters,
// because the failure mode this design has is silent: if the numbers are absent or clustered
// then every derived parameter lands on the same value, the roster generates as N copies of
// one machine, and every gate in the project stays green while it happens. See
// `tools/rostergate.mjs` for the measurement that refuses that outcome, and note it must
// exist BEFORE the first family generator, not after.
//
// Rule 14 applies to every identifier here: archetype vocabulary only. "heavy tank",
// "refinery", "harvester" describe a FUNCTION and function is not protected expression. No
// EA coined name appears in this file, and none may be added.

/** Which generator family builds this slot. One function per family; §14.13. */
export const Family = {
	tracked: 0,
	wheeled: 1,
	infantry: 2,
	rotorcraft: 3,
	fixedwing: 4,
	vessel: 5,
	plant: 6,
	emplacement: 7,
} as const
export type Family = (typeof Family)[keyof typeof Family]
export const FAMILY_COUNT = 8

/**
 * Faction identity. **Never seeded** (§9.2) — this is what a player learns to read at a
 * glance, and a generator that could reroll it would make the five-frame-flash test
 * unpassable by construction.
 */
export const Faction = { foundry: 0, lattice: 1, drift: 2 } as const
export type Faction = (typeof Faction)[keyof typeof Faction]

/**
 * One armament mount, as resolved from our own MiniYAML.
 *
 * `muzzleM` comes from `Armament.LocalOffset` and it is AUTHORITATIVE, because the SIMULATION
 * spawns the projectile there and `fx` draws the flash there. The geometry must therefore be
 * SOLID at that point: one number, three consumers, and the shot must leave from the machine.
 *
 * IT IS NOT A BARREL TIP, and assuming it was is a trap this file already fell into. The old
 * text here asserted the barrel "is built so its tip lands exactly there" and that it was
 * "Gated in `rostergate`" — neither was true, no generator has ever read the field, and
 * rostergate contains no such check. Worse, acting on the tip reading would have made things
 * worse rather than better: FOURTEEN OF TWENTY-FOUR vehicle muzzles are authored BEHIND their
 * own hull nose (foundry_bollard's is 40 cm inside a 2 m hull), so solving for a tip there
 * would bury every gun in its own chassis. LocalOffset is the spawn point at the MOUNT.
 *
 * The requirement that survives is weaker and correct: the authored point must lie ON or
 * INSIDE the actor. Depth in is fine. Measured 2026-08-06, 48 of 71 armed actors fail it and
 * fire from open air — including all twelve wheeled vehicles and all sixteen infantry, worst
 * 61.6 cm.
 *
 * `tools/muzzlegate.mjs` measures exactly that, ratchets the debt so it cannot grow, and fails
 * under `--strict` until the generators consume the field.
 *
 * THE FRAME IS TURRET-RELATIVE, verified against `Armament.CalculateMuzzleOffset` rather than
 * assumed: "Weapon offset in turret coordinates", composed as
 * `LocalOffset.Rotate(turret) + turret.Offset`, with recoil subtracted along +X so it pulls
 * BACK. In model space at rest the muzzle is therefore `muzzleM + turret.offsetM`. A first
 * measurement pass that read it as actor-relative would have driven every generator to the
 * wrong point.
 */
export interface ArmamentSlot {
	readonly weapon: string
	/** Turreted instance this mount follows, when the actor has one. */
	readonly turret?: string
	/** Muzzle point in metres, MODEL space, from LocalOffset / 1024. */
	readonly muzzleM: readonly [number, number, number]
	readonly recoilM: number
	readonly rangeM: number
	readonly reloadTicks: number
	readonly damage: number
	/**
	 * Signed anti-armour bias from the warhead's Versus table: +1 anti-armour, -1 anti-light,
	 * 0 general purpose. See the note in rosteradapt — this is the mod stating a weapon's ROLE,
	 * and it reached nothing until 2026-08-06.
	 */
	readonly armourBias: number
	readonly burst: number
	/** Our vocabulary, not theirs. Chosen for what the geometry must express. */
	readonly projectile: 'ballistic' | 'rocket' | 'directFire' | 'lobbed'
}

/** A resolved roster slot. Every field is required; a missing trait arrives as `null`. */
export interface RosterSlot {
	/** Our actor name. The ONLY key, ever — never a typeId (assigned first-seen, C# side). */
	readonly name: string
	readonly faction: Faction
	readonly family: Family
	readonly archetype: string
	readonly lengthM: number
	readonly widthM: number
	readonly hp: number
	/** 0 none, 1 light, 2 medium, 3 heavy, 4 concrete. */
	readonly armourIndex: number
	readonly cost: number
	readonly buildTicks: number
	readonly speed: number | null
	readonly locomotor: string | null
	readonly visionM: number | null
	/** Functional targeting class from AutoTargetPriority, not inferred from weapon layout. */
	readonly targetsAir: boolean
	/**
	 * Holds station under its own lift — a rotorcraft. Null when the export predates the
	 * `Aircraft` block, which is why it is nullable rather than defaulting to false: "not
	 * stated" and "stated as a fixed wing" must not read the same.
	 *
	 * OPTIONAL on purpose: the committed `roster.json` predates this field, and a required
	 * property would make a stale export fail to typecheck rather than fall back.
	 */
	readonly vtol?: boolean | null
	readonly turret: { readonly turnSpeed: number; readonly offsetM: readonly [number, number, number] } | null
	/** Every resolved Turreted instance, in the same stable order used by the snapshot ABI. */
	readonly turrets?: readonly {
		readonly name: string
		readonly turnSpeed: number
		readonly realignDelay: number
		readonly offsetM: readonly [number, number, number]
	}[]
	readonly armaments: readonly ArmamentSlot[]
	readonly powerAmount: number
	/**
	 * How many production traits the actor carries — 0 for anything that is not a factory.
	 *
	 * Authored in the mod since the roster existed and unreachable until 2026-08-06: the
	 * exporter was reading `ProductionQueueInfo`, which in OpenRA lives on the PLAYER actor,
	 * so every structure in the game reported "does not produce".
	 */
	readonly produces?: number
	/** Resource units the actor can hold. 5000 for a silo, 20 for a harvester bay, 0 otherwise. */
	readonly storageCapacity?: number
	/** Converts harvested resource into credits. A different building from one that stores it. */
	readonly refinery?: boolean
	readonly cargo: number
	/**
	 * The MiniYAML occupancy mask, one string per row, 'x' occupied and '_' free.
	 *
	 * Not merely a size — a SHAPE, and it already carries §9.1's faction contrast in the mod
	 * data: every Foundry footprint is a solid rectangle, while the Lattice's are notched and
	 * open, including a full ring at ["xxx","x_x","xxx"]. Reading only Dimensions and
	 * discarding this threw away the one differentiator that separates two buildings of the
	 * same size, and the silhouette gate caught exactly that.
	 */
	readonly footprint: readonly string[] | null
	/**
	 * The authored PLAN, in metres, when the mod drew one — a HitShape polygon.
	 *
	 * The footprint above is a mask of CELLS: it says which squares a building occupies, on a
	 * one-metre grid, and that grid is the reason 26 plants only ever had 14 distinct plans.
	 * This is different in kind. Ten Lattice structures carry a hand-drawn six-point outline
	 * authored per actor, off the grid, by a person — and the generator has never read it.
	 *
	 * It is the third piece of authored truth found sitting in the export with no consumer,
	 * after TargetsAir and Warhead Versus, and the most valuable of the three: the other two
	 * are scalars, and this is per-actor SHAPE, which is what the silhouette gate measures.
	 */
	readonly plan: readonly (readonly [number, number])[] | null
	/** Prerequisite count. A proxy for tech depth, which buys structural complexity. */
	readonly techDepth: number
}

/**
 * Percentile breakpoints, COMMITTED rather than computed across the live roster.
 *
 * This is a deliberate design call and it has a real cost either way. Ranking against the
 * roster itself is more expressive — the visual language stays relative, so the heaviest
 * thing always reads heaviest. But it is NON-LOCAL: adding one actor changes every other
 * actor's geometry, therefore every bake hash, therefore every baseline shot. A balance
 * tweak to one unit would rewrite the whole roster and blow up `imagediff`.
 *
 * Committed breakpoints trade a little expressiveness for locality. Editing one number here
 * is an explicit, reviewable art-direction change; editing a unit's cost is not.
 *
 * They are not measured from our roster and must not be silently re-fitted to it — that
 * would reintroduce the non-locality through the back door.
 *
 * They must, however, be in the SAME UNITS as the data. The first set was authored against
 * RA-equivalent magnitudes and was simply wrong for this mod: damage here runs 65..620 where
 * those assumed 15..150, so every gun in the roster ranked at 1.0 and the whole barrel
 * derivation collapsed. Reload was wrong the same way (9..72 against an assumed 20..200).
 * Corrected to round numbers spanning the design range with headroom at both ends, so a
 * heavier weapon added later does not force a re-authoring. Using the right units is not
 * fitting to the roster; silently moving a breakpoint to make a unit look better would be.
 */
export const BREAKPOINTS = {
	/** HP per m² of plan area. The right normaliser: a big cheap truck and a small tough
	 *  tank must not read the same, and raw HP would make them identical. */
	specificToughness: [180, 900, 2600, 6000, 12000],
	/**
	 * The same quantity for STRUCTURES, which do not share a scale with vehicles — and which
	 * do not share a scale with EACH OTHER either.
	 *
	 * History, because the correction is the point. A single `structureToughness` array
	 * replaced the vehicle curve here, on the argument that a building is not tough per square
	 * metre the way a tank is. That argument was right and the fix was still half a fix: one
	 * array served both plants and emplacements, and measured on the live 102-slot roster they
	 * are not one population.
	 *
	 *   plants       n=26   350 / 517 / 622 / 733 / 1000   (min p25 p50 p75 max, HP per m²)
	 *   emplacements n=10   600 / 733 / 900 / 1200 / 1950
	 *
	 * Against [450, 700, 1000, 1450, 2000] the plants never reached halfway and the
	 * emplacements piled up at the top: plate ran 6.0-10.5 mm across all 26 plants while
	 * lattice_pylon sat at 40.0 mm, hard against the clamp. Since plant.ts derives its eaves
	 * multiplier by inverting that same mapping, the entire plant family's height varied by
	 * 3.6% TOTAL. A pillbox is enormously tough on a 1x2 footprint and a factory is moderate on
	 * 3x4; they are different kinds of object and one curve cannot describe both.
	 *
	 * The superseded comment also claimed plants run 467-1000 and emplacements 875-1950. Both
	 * halves were measured against the 44-slot roster and both are now wrong — the roster more
	 * than doubled and the floors moved to 350 (lattice_quay) and 600 (lattice_obelisk). A
	 * stale justification is worse than none, so the numbers above carry their own n.
	 *
	 * These are PINNED, not derived from the live distribution at runtime. Ranking against the
	 * current roster would never go stale, but it would make geometry non-local: adding one
	 * actor would silently change every existing actor's plate and eaves and invalidate every
	 * bake and image baseline, and a diff would become impossible to attribute. Committed
	 * anchors can go stale, but staleness is visible and repinning is deliberate.
	 *
	 * This is not fitting the curve to make a unit look better, which §14.13 forbids. It is
	 * using the right units for a different kind of object, and the ranges are the evidence.
	 */
	plantToughness: [350, 500, 620, 740, 1000],
	emplacementToughness: [600, 730, 900, 1200, 1950],
	damagePerShot: [50, 130, 250, 400, 700],
	rangeM: [2, 4, 6, 8, 12],
	/** Cells per tick, as `Mobile.Speed` reports it. */
	speed: [28, 45, 64, 85, 110],
	cost: [100, 400, 900, 1600, 3000],
	/** Metres of reveal radius. */
	visionM: [3, 5, 7, 9, 12],
	/** Ticks between shots. INVERTED on use — a long reload is a heavy manual breech. */
	reloadTicks: [8, 14, 24, 40, 80],
	/** Degrees per tick of turret traverse. Also inverted: slow traverse is heavy mass. */
	turretTurnSpeed: [4, 8, 12, 20, 32],
} as const

/**
 * Piecewise-linear rank of `value` against committed breakpoints, on [0,1].
 *
 * Piecewise rather than a plain lerp between min and max because the underlying
 * distributions are heavily skewed — costs run 100..3000 with most of the roster under 900,
 * and a linear map would push four fifths of the roster into the bottom fifth of the output
 * and generate them as visually identical. The breakpoints ARE the distribution.
 */
export function norm(value: number, breakpoints: readonly number[]): number {
	const n = breakpoints.length
	if (value <= breakpoints[0]) return 0
	if (value >= breakpoints[n - 1]) return 1
	for (let i = 1; i < n; i++) {
		if (value <= breakpoints[i]) {
			const lo = breakpoints[i - 1]
			const t = (value - lo) / (breakpoints[i] - lo)
			return (i - 1 + t) / (n - 1)
		}
	}
	return 1
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * STEELSEED's world is COMPRESSED relative to real machines, and anything derived from
 * real-world engineering has to be scaled by this before it becomes geometry.
 *
 * §12.4 pins one cell to one metre, and a main battle tank occupies two or three cells — so
 * it is 3.4 m long where a real one is about 7 m. Calibre ratio is a genuine engineering
 * relationship (a 120 mm L/48 gun really does have a 5.76 m barrel) and using it unscaled put
 * a 5.76 m barrel on a 3.4 m tank. The guns came out as needles, which is exactly what the
 * contact sheet showed the moment real weapon data reached the generators.
 *
 * The ratio is still the right relationship — it is what makes a long-range gun read longer
 * than a short-range one of the same bore. Only the absolute scale is wrong, and it is wrong
 * by one constant, so it is corrected in one place rather than tuned per call site.
 */
const WORLD_SCALE = 0.45

/**
 * The faction operator, applied uniformly to every family.
 *
 * This is what makes §9.1's "distinguishable by silhouette alone, in monochrome, at max
 * zoom-out" pass BY CONSTRUCTION rather than by an artist's taste on each unit. The same
 * archetype run through two operators yields two recognisably different machines, and the
 * difference survives desaturation because it is proportion and topology, not paint.
 *
 * `joinRadius` is the `sdf.smoothUnion` k. It carries most of the reading: the Foundry
 * unions smoothly so a hull is one casting with no daylight under it; the Lattice unions
 * hard so its silhouette stays mostly holes. Smoothing a Lattice join would fill exactly
 * the gaps that carry its identity.
 */
export interface FactionOperator {
	readonly widthScale: number
	readonly heightScale: number
	readonly joinRadius: number
	readonly locomotion: 'tracked' | 'wheeled'
	/**
	 * Ride height multiplier. §9.1 states this difference explicitly — the Foundry is
	 * "tracked, planted, low", the Lattice is "wheeled 6x6 / 8x8, **tall ground clearance**"
	 * — and the first version of `deriveChassis` simply did not express it, deriving
	 * clearance from armour alone. `rostergate` caught that on its first run at cv 0.1175.
	 *
	 * Worth being precise about why this changed: the formula was widened because it was
	 * under-expressing a documented faction difference, NOT to clear a threshold. Those look
	 * identical in a diff and are opposite in kind, and this project has already paid for
	 * the second one.
	 */
	readonly clearanceScale: number
	readonly greeblePlan: 'FOUNDRY_GREEBLE' | 'LATTICE_GREEBLE'
	/** §9.1 v2: warm indicators for the Foundry, cool for the Lattice. Reinforces identity
	 *  in colour, never establishes it — the monochrome test must pass without this. */
	readonly emissiveKelvin: number
}

export const FACTION_OPERATOR: Readonly<Record<Faction, FactionOperator>> = {
	[Faction.foundry]: {
		widthScale: 1.10, heightScale: 0.88, joinRadius: 3.0, clearanceScale: 0.72,
		locomotion: 'tracked', greeblePlan: 'FOUNDRY_GREEBLE', emissiveKelvin: 2400,
	},
	[Faction.lattice]: {
		widthScale: 0.86, heightScale: 1.24, joinRadius: 0.2, clearanceScale: 1.24,
		locomotion: 'wheeled', greeblePlan: 'LATTICE_GREEBLE', emissiveKelvin: 6500,
	},
	// Salvage. No faction reading by design, so the operator is neutral and the variation
	// comes from per-instance seed rather than from identity.
	[Faction.drift]: {
		widthScale: 1.0, heightScale: 1.0, joinRadius: 1.0, clearanceScale: 1.0,
		locomotion: 'wheeled', greeblePlan: 'FOUNDRY_GREEBLE', emissiveKelvin: 3000,
	},
}

/** Everything a family generator needs, derived. No generator re-derives any of this. */
export interface ChassisParams {
	readonly lengthM: number
	readonly widthM: number
	readonly heightM: number
	readonly plateMm: number
	readonly bevelM: number
	readonly ringDiaM: number
	readonly turretHeightM: number
	readonly breechLenM: number
	readonly barrelLenM: number
	readonly boreMm: number
	/**
	 * The primary armament's anti-armour bias, -1..+1, or 0 when unarmed.
	 *
	 * A ROLE, and the only one the roster states outright. Everything else a generator reads is
	 * a physical quantity it has to infer intent from; this says what the weapon is FOR. It is
	 * why foundry_clamp and foundry_ember sat 0.0269 apart in parameter space — below the 0.06
	 * floor — while the mod had them 1.8x apart on the axis nothing was reading.
	 */
	readonly armourBias: number
	readonly muzzleBrake: boolean
	/**
	 * Where the SIMULATION fires from, in model space at rest, metres. Zero when unarmed.
	 *
	 * Composed here rather than in a generator, because getting it wrong is silent. The engine's
	 * `Armament.CalculateMuzzleOffset` is explicit that `LocalOffset` is "in turret coordinates"
	 * and composes `LocalOffset.Rotate(turret) + turret.Offset`, subtracting Recoil along +X so
	 * recoil pulls BACK. At rest that reduces to the sum below, and every consumer — geometry,
	 * `fx`'s muzzle flash, a tracer origin — must use this same value or they drift apart.
	 *
	 * The geometry's obligation is NOT to end here. This point is the spawn position at the
	 * mount and for most of the roster it sits behind the hull nose; a barrel ending here would
	 * be buried in its own chassis. The obligation is that the actor be SOLID here, so the shot
	 * leaves the machine rather than the air beside it. `tools/muzzlegate.mjs` measures exactly
	 * that.
	 */
	readonly muzzleM: readonly [number, number, number]
	readonly tubes: number
	/** Functional targeting class. Tube count remains an independent physical mount property. */
	readonly targetsAir: boolean
	/** True rotorcraft, false fixed wing, null when the mod did not say and a guess is needed. */
	readonly vtol: boolean | null
	readonly roadWheels: number
	readonly trackWidthM: number
	readonly axles: number
	readonly clearanceM: number
	readonly suspTravelM: number
	readonly mastHeightM: number
	readonly greebleBudget: number
	readonly buildStages: number
	/** Forwarded verbatim. Structures read it as generation vs consumption, which decides
	 *  whether a building grows stacks and cooling or a service head and a cable trunk. */
	readonly powerAmount: number
	/** §14.13a function: 0 = not a factory. Drives whether the shell has a way OUT. */
	readonly produces: number
	/** Resource units held. Drives silo massing; a store is a vessel, not a shed. */
	readonly storageCapacity: number
	readonly refinery: boolean
	/** Forwarded verbatim. Non-zero means the actor carries something, which a generator may
	 *  express as a hopper, a bed or a bay. */
	readonly cargo: number
	readonly footprint: readonly string[] | null
	/** The authored plan polygon, forwarded verbatim in metres. See RosterSlot.plan. */
	readonly plan: readonly (readonly [number, number])[] | null
	/**
	 * Occupied cells in the footprint mask, as a NUMBER.
	 *
	 * `footprint` itself is a string array, so it could never enter the separation vector, and
	 * plant.ts builds its main mass from exactly that mask. A solid 3x3 and a ring 3x3 are
	 * visibly different buildings and scored as identical. This is the mask made measurable.
	 */
	readonly footprintCells: number
	readonly techDepth: number
	readonly op: FactionOperator
}

/**
 * Mast height for a machine that reveals shroud, as base + ranked span.
 *
 * The base is deliberately not zero. It is what makes "carries a sensor" readable on the
 * actor that ranks LOWEST in vision, and a cue that only the top of the roster can express is
 * not a cue — it is a decoration on the best unit. The span keeps the old ceiling of ~2.2 m,
 * so nothing that already looked right gets taller.
 */
const MAST_BASE_M = 0.18
const MAST_SPAN_M = 2.0

/**
 * Derive geometry parameters from functional data. §14.13's table, executed.
 *
 * Every branch here is a design decision expressed as arithmetic, and each one is written
 * so it can be argued with. Where a real machine's proportions have a physical reason, that
 * reason is the formula — a gun's calibre ratio, a turret ring clearing its breech, a track
 * widening to carry mass. That is what makes the output read as machinery rather than as
 * parameterised boxes.
 */
export function deriveChassis(slot: RosterSlot): ChassisParams {
	const op = FACTION_OPERATOR[slot.faction]

	const lengthM = slot.lengthM
	const widthM = slot.widthM * op.widthScale

	// Armour massing. HP per m² of plan area, NOT raw HP.
	//
	// Structures are normalised against their OWN scale — see BREAKPOINTS.plantToughness
	// for the measured ranges. Sharing the vehicle curve compressed all 20 of them into its
	// bottom decile and cost the plant family its variety entirely.
	const specificToughness = slot.hp / Math.max(lengthM * widthM, 0.25)
	const isStructure = slot.family === Family.plant || slot.family === Family.emplacement
	const tough = norm(
		specificToughness,
		slot.family === Family.plant
			? BREAKPOINTS.plantToughness
			: slot.family === Family.emplacement
				? BREAKPOINTS.emplacementToughness
				: BREAKPOINTS.specificToughness,
	)
	const plateMm = clamp(6 + 34 * tough, 6, 60)
	const bevelM = 0.35 * (plateMm / 1000)

	// Height follows width and armour: a heavily armoured hull is deeper, but never so deep
	// that it stops reading as a vehicle. Clamped against width so proportion survives.
	const heightM = clamp((0.42 * widthM + 0.22 * tough) * op.heightScale, 0.55 * widthM, 1.10 * widthM)

	// Primary armament. The first mount is the one that shapes the machine.
	const primary = slot.armaments[0] ?? null
	const damage = primary?.damage ?? 0
	const rangeM = primary?.rangeM ?? 0
	const boreMm = primary === null ? 0 : 24 + 96 * norm(damage, BREAKPOINTS.damagePerShot)
	// Forwarded verbatim: it is already a normalised ratio, and re-ranking it against the
	// roster would reintroduce exactly the non-locality the committed breakpoints exist to
	// avoid — adding one anti-tank weapon would reshape every other gun in the game.
	const armourBias = primary === null ? 0 : (primary.armourBias ?? 0)
	// Calibre ratio: long range means a long barrel for the same bore. L/48 against L/18 is
	// exactly how real guns read at a glance, and it separates an artillery piece from a
	// close-support howitzer without either being hand-authored.
	const calibreRatio = 18 + 30 * norm(rangeM, BREAKPOINTS.rangeM)
	// Scaled into the game's compressed world, then clamped against the hull. The clamp is a
	// readability floor, not a physical one: past about 85% of hull length a barrel stops
	// reading as a gun and starts reading as a mast, whatever the arithmetic says.
	const barrelRaw = primary === null ? 0 : (boreMm / 1000) * calibreRatio * WORLD_SCALE
	const barrelLenM = Math.min(barrelRaw, lengthM * 0.85)
	// A muzzle brake is a real device on a high-energy gun, and it is the single most legible
	// tell that a barrel is a BIG gun rather than merely a long one.
	//
	// Keyed on bore and range, NOT on the sim's projectile type. Every weapon in this mod
	// resolves to `InstantHit`, which is a hitscan implementation detail chosen for the
	// simulation — it says nothing about what the gun looks like, and keying off it would
	// give the entire roster no muzzle brakes at all. What makes a brake plausible is a large
	// bore firing a long way, and both of those are real numbers.
	const muzzleBrake = primary !== null &&
		norm(damage, BREAKPOINTS.damagePerShot) > 0.62 &&
		norm(rangeM, BREAKPOINTS.rangeM) > 0.45
	const tubes = primary === null ? 0 : Math.max(1, primary.burst)

	// Turret. The ring must physically clear the breech, so bore feeds diameter.
	const hasTurret = slot.turret !== null
	// The ring must clear the breech, but the breech term was DIMENSIONALLY WRONG: it read
	// 0.10 * (boreMm / 25.4), which multiplies an INCH COUNT by metres. A 114 mm bore added
	// 0.45 m to a 1.24 m hull, and the measured result was a turret ring at 98% of hull width
	// with a turret 97% of hull height — a turret the size of its own tank.
	//
	// Bore now contributes in metres and the whole ring is capped against hull width. Real
	// armour runs a ring at roughly 55-65% of hull width; the cap holds it there whatever the
	// gun, because a gun too big for its hull is a BALANCE statement and should not silently
	// become a geometry one.
	const ringDiaM = hasTurret
		? Math.min(0.52 * widthM + 0.95 * (boreMm / 1000), 0.66 * widthM)
		: 0
	// Slow traverse means heavy mass to move: a tall, deep turret. Inverted rank.
	const traverse = hasTurret ? norm(slot.turret.turnSpeed, BREAKPOINTS.turretTurnSpeed) : 0.5
	// Slow traverse still means a heavier turret, but the range is narrower: real turret
	// height runs about 55-70% of hull height, and the old expression reached 97%.
	const turretHeightM = hasTurret
		? Math.min(0.42 * ringDiaM * (1 + 0.55 * (1 - traverse)), heightM * 0.75)
		: 0
	// A slow reload is a manual breech and a long recoil stroke; a fast one is an autoloader
	// bustle. Either way the breech must be at least as long as the recoil it absorbs.
	const reloadRank = primary === null ? 0 : norm(primary.reloadTicks, BREAKPOINTS.reloadTicks)
	const breechLenM = primary === null
		? 0
		: Math.max(0.9 * barrelLenM * (0.55 + 0.75 * reloadRank), primary.recoilM * 1.15)

	// Locomotion. `locomotor` is the switch rather than faction, so a faction can field an
	// exception without the operator having to know about it.
	const speedRank = slot.speed === null ? 0.5 : norm(slot.speed, BREAKPOINTS.speed)
	const tracked = (slot.locomotor ?? op.locomotion).includes('track') || op.locomotion === 'tracked'
	// Faster tracked vehicles run larger, fewer road wheels — a real consequence of
	// suspension travel, and it reads instantly at zoom.
	// The spacing constant was authored for full-scale vehicles and this world is compressed:
	// hulls run 1.09-1.63 m, so lengthM / (0.42 + 0.30 * speedRank) yields 1.5 to 3.9 and the
	// clamp floor of 4 swallowed every one of them. All six tracked actors got exactly 4 road
	// wheels, which made the comment above — "faster tracked vehicles run larger, fewer road
	// wheels, and it reads instantly at zoom" — a statement about a number that could not vary.
	// Same failure as the structure toughness scale: a constant carried over from a different
	// size of world, clamping the whole family onto one value.
	//
	// 0.19-0.26 m of spacing puts the six across 4 to 8 wheels, which is the range the clamp
	// was always written for.
	const roadWheels = tracked ? clamp(Math.round(lengthM / (0.19 + 0.07 * speedRank)), 4, 8) : 0
	const trackWidthM = tracked
		? clamp(0.14 * widthM * (1 + 0.7 * tough), 0.16, 0.55)
		: 0
	const axles = tracked ? 0 : clamp(Math.round(lengthM / 1.35), 2, 4)
	// Light vehicles ride high; heavy ones sit down on their suspension — and the FACTION
	// scales the whole result, because §9.1 makes ride height part of the silhouette
	// contrast rather than only a consequence of mass.
	const clearanceM = (0.34 + 0.30 * (1 - tough)) * op.clearanceScale
	const suspTravelM = 0.10 + 0.14 * speedRank

	// Sensors. The cheapest per-type identity cue available at max zoom-out.
	//
	// THIS USED TO DESTROY THE FACT IT WAS DERIVED FROM. The expression was
	// `clamp(0.25 * ((slot.visionM ?? MEDIAN) - MEDIAN), 0, 2.2)` — a signed deviation from the
	// median, floored at zero, with a missing value substituted BY the median. Both halves of
	// that collapse: an actor that cannot see at all and an actor that sees slightly less than
	// average produce exactly the same 0, so a categorical fact (does this machine carry a
	// sensor?) and a continuous one (how far does it reach?) came out of the same number, and
	// the categorical half could only ever be expressed by actors above the median.
	//
	// Measured on the emplacements: seven of ten got mastHeightM 0.000 — foundry_bulwark and
	// lattice_pylon because they are genuinely blind, foundry_casemate, foundry_ravelin and
	// foundry_redoubt because they see 7, 5 and 6 m against a median of 7. Three structures
	// that reveal shroud were drawn with the same bare parapet as the ones that cannot.
	// foundry_bulwark against foundry_redoubt is the pair rostergate reports at IoU 0.9879, and
	// the single loudest difference in their functional data — one is a sighted position and
	// one is blind — was being erased here, three files before the generator ever saw it.
	//
	// So: EXISTENCE IS CATEGORICAL, HEIGHT IS RANKED. A machine that reveals shroud has an
	// observation position and it is always visible; how far it sees decides how high it is
	// carried. A machine that reveals nothing has none, which is now the only way to score 0.
	const mastHeightM = slot.visionM === null
		? 0
		: MAST_BASE_M + MAST_SPAN_M * norm(slot.visionM, BREAKPOINTS.visionM)

	// Cost buys visual complexity, straight into the greeble plan's triangle budget. This is
	// the purest expression of §14.13: an expensive machine GENERATES as a complicated one.
	const greebleBudget = Math.round(400 + 2600 * norm(slot.cost, BREAKPOINTS.cost))
	const buildStages = clamp(Math.round(slot.buildTicks / 45), 2, 6)

	return {
		lengthM, widthM, heightM, plateMm, bevelM,
		ringDiaM, turretHeightM, breechLenM, barrelLenM, boreMm, armourBias, muzzleBrake, tubes,
		muzzleM: primary === null
			? [0, 0, 0]
			: [
				primary.muzzleM[0] + (slot.turret?.offsetM[0] ?? 0),
				primary.muzzleM[1] + (slot.turret?.offsetM[1] ?? 0),
				primary.muzzleM[2] + (slot.turret?.offsetM[2] ?? 0),
			],
		targetsAir: slot.targetsAir,
		vtol: slot.vtol ?? null,
		roadWheels, trackWidthM, axles, clearanceM, suspTravelM,
		mastHeightM, greebleBudget, buildStages,
		powerAmount: slot.powerAmount, cargo: slot.cargo,
		// Optional on RosterSlot so a roster baked before 2026-08-06 still typechecks; a stale
		// table degrades to "not a factory, holds nothing" rather than failing to load.
		produces: slot.produces ?? 0,
		storageCapacity: slot.storageCapacity ?? 0,
		refinery: slot.refinery ?? false,
		footprint: slot.footprint ?? null, plan: slot.plan ?? null, techDepth: slot.techDepth ?? 0,
		footprintCells: slot.footprint === null || slot.footprint === undefined
			? 0
			: slot.footprint.reduce((n, row) => n + [...row].filter(c => c === 'x' || c === 'X').length, 0),
		op,
	}
}

/**
 * The parameters `rostergate` measures dispersion across.
 *
 * Exported as a named list rather than derived by `Object.keys` so that adding a field to
 * `ChassisParams` does not silently enter or leave the dispersion measurement. A gate whose
 * coverage changes when unrelated code changes is not a gate.
 */
export const DISPERSION_FIELDS = [
	'lengthM', 'widthM', 'heightM', 'plateMm',
	'ringDiaM', 'turretHeightM', 'breechLenM', 'barrelLenM', 'boreMm',
	'roadWheels', 'trackWidthM', 'axles', 'clearanceM', 'armourBias',
	'mastHeightM', 'greebleBudget',
	// The MASSING axes, added 2026-08-05, and their absence was a hole straight through the
	// middle of this gate.
	//
	// The fifteen fields above are vehicle-shaped. For a plant EIGHT of them are identically
	// zero — no ring, no turret, no breech, no barrel, no bore, no road wheels, no track, no
	// axles — so a structure's separation was computed largely from fields that do not apply to
	// it. Worse, the vector omitted every axis plant.ts selects its massing archetype from:
	// powerAmount picks STACK, buildStages picks HALL, the footprint mask builds the main mass,
	// and techDepth sets the roof.
	//
	// The consequence is not subtle. A round silo and a gabled hall are completely different
	// buildings and scored as near-identical, while changing an actor's build duration — which
	// moves it from HALL to SILO and rebuilds its entire shape — moved the separation number by
	// EXACTLY ZERO. Measured on foundry_skyhook at three different values.
	//
	// So the two plant pairs this gate reported under the 0.06 floor were never a statement
	// about how those buildings look, and the data change I nearly made to satisfy that number
	// would have been fitting content to a blind instrument.
	'footprintCells', 'powerAmount', 'buildStages', 'techDepth',
	// What the building DOES, added 2026-08-06. `lattice_extruder` produces LatticeInfantry and
	// `lattice_reservoir` holds 5000 resources — the single most consequential difference
	// between two buildings in any RTS — and neither fact could reach this vector or the
	// generator, so the two scored 0.0265 apart and I twice reported that as a content gap
	// needing the owner's decision. It was an export bug.
	'produces', 'storageCapacity',
	// `tubes`, added the same day for the same reason one family over. It is derived from the
	// mod, it now drives infantry receiver bulk and barrel count, and this vector could not see
	// it — so `foundry_bolt` (2 tubes) and `foundry_rivet` (1) scored 0.0396 apart while the
	// roster said one carries twice the barrels of the other. A field the generator READS and
	// this vector OMITS is a blind spot by construction, and it is the third time that exact
	// hole has been found here after the massing axes and the two building roles above.
	'tubes',
] as const satisfies readonly (keyof ChassisParams)[]
