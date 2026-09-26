#!/usr/bin/env node
// STEELSEED — tools/locomotion-audio
//
// Carries the mod's rules about HOW EACH ACTOR MOVES out of the yaml and into
// `web/src/audio/locomotion-audio.json`, which `audio/index.ts` reads to decide what a moving
// thing sounds like.
//
// WHY THIS EXISTS. The human's report was "the steps of the infantry sound like tank riding, it
// should sound like footsteps", and the cause is structural rather than a tuning miss.
// `movementParams(surface)` took ONE argument — the ground — and returned `pulseHz: 22,
// pulseF0: 96`, a cylinder firing rate and an engine body, for EVERY moving actor in the game.
// The comment beside it, "the engine is the MACHINE and does not change with the ground under
// it", is correct for a tank and has nothing to say about a rifleman. There was no axis on
// which a soldier could differ from a tank, so there was no bug to find in the numbers: the
// voice existed and the discriminator did not.
//
// That is the same shape as the weapon defect this repository fixed the day before — 47 of 50
// weapons keyed onto one buffer — one layer down. Both were found by asking what the game
// actually indexes into a bank, rather than by measuring the bank.
//
// It also silences a defect nobody had reported: an actor's contribution was keyed on
// `actors.surface[i]`, which every actor has, INCLUDING AIRCRAFT. A helicopter at 120 m was
// mixed into the engine loop for whatever ground happened to be underneath it, so it drove over
// the terrain it was flying above.
//
// WHAT THE AXIS IS, AND WHY IT IS NOT THE MESH TEMPLATE. `web/.forge/blender/manifest.json`
// carries a `template` per asset (`infantry`, `tank`, `truck`, `ship`, `helicopter`, …) and
// several fx modules already read it. It is the cheaper discriminator and it is the wrong one:
// it describes how the MESH was authored, not how the simulation moves the thing. The mod
// states that directly, per actor, in a field the pathfinder itself acts on:
//
//   `Mobile: Locomotor:`  — foot, wheeled, heavywheeled, lighttracked, tracked, heavytracked,
//                           naval, lcraft. Defined in `rules/world.yaml`, assigned per actor
//                           and inherited through `defaults.yaml`.
//   `Aircraft:`           — no Locomotor at all, because nothing about an aircraft touches the
//                           ground. `CanHover` separates a rotor from a wing.
//
// So the template is used here only as a CROSS-CHECK, the way `weapon-audio.mjs` uses the
// authored visual families: two independent routes to the same answer, with the disagreements
// enumerated and `--check` failing if the set moves.
//
// A SEPARATE TOOL FROM `weapon-audio.mjs`, DELIBERATELY. It reads a different rules tree
// (`rules/` rather than `weapons/`), resolves a different inheritance root, keys its output by
// ACTOR rather than by WEAPON, and is consumed by a different code path (`update()` rather than
// `handleFire()`). What the two share is the MiniYAML reader, which is imported from
// `weapon-rules.mjs` rather than copied — one parser, one mod, three projections. Folding them
// into one file would mean one `--check` going red for two unrelated reasons.
//
// Usage:
//   node tools/locomotion-audio.mjs            # write web/src/audio/locomotion-audio.json
//   node tools/locomotion-audio.mjs --check    # fail if the committed table is stale
//   node tools/locomotion-audio.mjs --report   # print the locomotion inventory

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nodesOf, resolveNode } from './weapon-rules.mjs'

const TOOL = 'locomotion-audio'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME = resolve(WEB, '..')
const RULES_DIR = resolve(GAME, 'engine/steelseed-host/generated/mods/ra/rules')
const OUT = resolve(WEB, 'src/audio/locomotion-audio.json')
const FORGE = resolve(WEB, '.forge/blender/manifest.json')

/**
 * The audio locomotion classes, in bank order.
 *
 * SIX, collapsed from the mod's eight locomotors plus two aircraft kinds, and the collapse is
 * by MECHANISM rather than by name. `tracked`, `lighttracked` and `heavytracked` differ in what
 * terrain they may cross, which is a pathfinding fact with no sound in it; a track is a track.
 * `wheeled` and `heavywheeled` likewise. `naval` and `lcraft` are both a hull and a screw.
 *
 * What does NOT collapse is `foot` against everything else, and a rotor against a wing: a
 * footstep is a discrete impulse pair at a cadence and every other class here is a continuous
 * machine, and a helicopter's blade-pass and a propeller's are an octave and a rhythm apart.
 */
export const LOCOMOTIONS = ['foot', 'tracked', 'wheeled', 'naval', 'rotor', 'wing']

/** Mod locomotor -> audio class. Everything the mod can say, mapped by mechanism. */
const LOCOMOTOR_CLASS = {
	foot: 'foot',
	wheeled: 'wheeled',
	heavywheeled: 'wheeled',
	tracked: 'tracked',
	lighttracked: 'tracked',
	heavytracked: 'tracked',
	naval: 'naval',
	lcraft: 'naval',
}

/**
 * Mesh template -> the class it implies, for the cross-check only.
 *
 * Templates that say nothing about locomotion (`crate`, `house`, `tree`) are absent and their
 * actors are skipped by the check rather than guessed at.
 */
const TEMPLATE_CLASS = {
	infantry: 'foot',
	dog: 'foot',
	tank: 'tracked',
	truck: 'wheeled',
	ship: 'naval',
	submarine: 'naval',
	helicopter: 'rotor',
	plane: 'wing',
}

function load() {
	const files = readdirSync(RULES_DIR).filter(f => f.endsWith('.yaml')).sort()
	const raw = new Map()
	for (const file of files)
		for (const node of nodesOf(readFileSync(join(RULES_DIR, file), 'utf8')))
			raw.set(node.key, node)
	return raw
}

function fieldsOf(node) {
	return node ? Object.fromEntries(node.children.map(c => [c.key, c.value])) : null
}

function bool(value) {
	const v = String(value ?? '').toLowerCase()
	return v === 'true' || v === 'yes'
}

export function buildTable() {
	const raw = load()
	const actors = {}
	for (const name of [...raw.keys()].sort()) {
		// `^Abstract` entries exist only to be inherited from; `-Trait` lines are removals.
		if (name.startsWith('^') || name.startsWith('-')) continue
		const fields = resolveNode(name, raw)
		const mobile = fieldsOf(fields.Mobile)
		const aircraft = fieldsOf(fields.Aircraft)
		// Not mobile, not an aircraft: a building, a crate, a tree. It cannot make a movement
		// sound because it does not move, and giving it a row would invite one.
		if (!mobile && !aircraft) continue

		let locomotion
		let locomotor = null
		if (aircraft) {
			// `CanHover` is the field the simulation itself uses to decide whether the thing can
			// stop in the air. That is exactly the rotor/wing distinction, and it is a better
			// discriminator than the mesh template because the husk of a shot-down helicopter
			// keeps it while its template does not.
			locomotion = bool(aircraft.CanHover) ? 'rotor' : 'wing'
		} else {
			locomotor = (mobile.Locomotor ?? 'foot').toLowerCase()
			locomotion = LOCOMOTOR_CLASS[locomotor]
			if (locomotion === undefined) {
				console.error(`${TOOL}: ${name} declares Locomotor: ${locomotor}, which is not in LOCOMOTOR_CLASS — a new locomotor has been added to the mod and nothing here knows what it sounds like.`)
				process.exit(1)
			}
		}

		// `Speed` is WDist per tick, the same unit the snapshot's `speed` field carries. Recorded
		// so the footstep cadence can be sanity-checked against the pace the simulation will
		// actually move the actor at, rather than against a number someone liked.
		const speed = Number(mobile?.Speed ?? aircraft?.Speed ?? 0)
		actors[name] = {
			locomotion: LOCOMOTIONS.indexOf(locomotion),
			locomotor,
			speed: Number.isFinite(speed) ? speed : 0,
		}
	}
	return {
		schemaVersion: 1,
		source: 'engine/steelseed-host/generated/mods/ra/rules',
		authoring: { source: 'web/tools/locomotion-audio.mjs', revision: 1 },
		semantics: {
			join: 'Keyed by the mod actor name. The snapshot carries a u16 typeId into the shared '
				+ 'string table; resolve it through ctx.actorTypeName() and match '
				+ 'CASE-INSENSITIVELY — the rules are read case-insensitively by the engine and '
				+ 'the emitter restores authored casing only where an armament named it.',
			locomotion: 'Index into `locomotions`. Derived from Mobile.Locomotor, or from '
				+ 'Aircraft.CanHover for anything that flies. Actors with neither trait are '
				+ 'absent: they do not move, so they make no movement sound.',
			speed: 'Mobile.Speed or Aircraft.Speed in WDist per tick — the same unit the '
				+ 'snapshot publishes, so a cadence derived from one can be checked against the '
				+ 'other without a conversion nobody verified.',
		},
		locomotions: LOCOMOTIONS,
		actors,
	}
}

/** Compare the derivation against the mesh templates in the forged pack. */
export function crossCheck(table) {
	let manifest
	try { manifest = JSON.parse(readFileSync(FORGE, 'utf8')) } catch { return null }
	const assets = manifest.assets ?? {}
	const byLower = new Map()
	for (const [name, row] of Object.entries(table.actors)) byLower.set(name.toLowerCase(), row)
	let agree = 0
	const disagree = []
	let skipped = 0
	for (const [id, asset] of Object.entries(assets)) {
		const want = TEMPLATE_CLASS[asset.template]
		if (want === undefined) { skipped++; continue }
		const row = byLower.get(id.toLowerCase())
		if (!row) { disagree.push({ actor: id, rules: '(not mobile)', template: want }); continue }
		const got = LOCOMOTIONS[row.locomotion]
		if (got === want) agree++
		else disagree.push({ actor: id, rules: got, template: want, locomotor: row.locomotor })
	}
	return { agree, disagree, skipped }
}

/**
 * Disagreements that are DELIBERATE, with the rule that justifies each.
 *
 * A ratchet, not a waiver: `--check` fails on any disagreement not listed here, and fails if a
 * listed one disappears without the list being edited.
 */
export const EXPECTED_DISAGREEMENTS = {
	// The four ants are `Locomotor: lighttracked` in the rules — a PATHFINDING class, chosen
	// because an ant crosses the same terrain a light tank does. Nothing about an ant is
	// tracked. This is the one place the mesh template knows something the simulation does not,
	// and it is recorded rather than fixed: giving chitin its own bank row costs thirteen more
	// loops for five actors that appear in one bonus mission, and voicing them as a light
	// tracked vehicle is what the rules literally say. See the report note.
	ant: { rules: 'tracked', template: undefined },
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()

function main() {
	const table = buildTable()
	const text = `${JSON.stringify(table, null, '\t')}\n`
	const check = crossCheck(table)

	if (process.argv.includes('--report')) {
		const byClass = new Map()
		for (const [name, row] of Object.entries(table.actors)) {
			const c = LOCOMOTIONS[row.locomotion]
			if (!byClass.has(c)) byClass.set(c, [])
			byClass.get(c).push({ name, ...row })
		}
		console.log(`${TOOL}: ${Object.keys(table.actors).length} mobile actors across ${LOCOMOTIONS.length} classes`)
		for (const c of LOCOMOTIONS) {
			const list = byClass.get(c) ?? []
			const speeds = list.map(r => r.speed).filter(s => s > 0)
			console.log(`\n  ${c}  (${list.length})  Speed ${Math.min(...speeds)}..${Math.max(...speeds)} WDist/tick` +
				` = ${(Math.min(...speeds) * 25 / 1024).toFixed(2)}..${(Math.max(...speeds) * 25 / 1024).toFixed(2)} m/s`)
			const locos = [...new Set(list.map(r => r.locomotor).filter(Boolean))]
			if (locos.length > 0) console.log(`    from Locomotor: ${locos.join(', ')}`)
			console.log(`    ${list.map(r => r.name).join(' ')}`)
		}
		if (check)
			console.log(`\n  cross-check against ${check.agree + check.disagree.length} forged mesh templates: ` +
				`${check.agree} agree, ${check.disagree.length} disagree (${check.skipped} templates say nothing about locomotion)`)
		for (const d of check?.disagree ?? [])
			console.log(`    ${d.actor}: rules=${d.rules}${d.locomotor ? ` (Locomotor: ${d.locomotor})` : ''} template=${d.template}`)
		return
	}

	if (check) {
		const unexpected = check.disagree.filter(d => {
			const e = EXPECTED_DISAGREEMENTS[d.actor.replace(/[0-9]+$/, '').toLowerCase()]
			return !e || e.rules !== d.rules
		})
		if (unexpected.length > 0) {
			for (const d of unexpected)
				console.error(`${TOOL}: ${d.actor} moves as '${d.rules}' by the rules but its mesh is authored as '${d.template}' — one of the two is wrong, and neither may be edited to match the other without saying which rule changed.`)
			process.exit(1)
		}
	}

	if (process.argv.includes('--check')) {
		let current = null
		try { current = readFileSync(OUT, 'utf8') } catch { current = null }
		if (current !== text) {
			console.error(`${TOOL}: ${OUT} is stale — run \`node tools/locomotion-audio.mjs\``)
			process.exit(1)
		}
		console.log(`${TOOL}: OK — ${Object.keys(table.actors).length} mobile actors across ${LOCOMOTIONS.length} classes, ` +
			`table matches the rules${check ? `, ${check.agree} agree with the forged mesh templates` : ''}`)
	} else {
		writeFileSync(OUT, text)
		console.log(`${TOOL}: wrote ${Object.keys(table.actors).length} mobile actors to ${OUT}` +
			`${check ? ` (${check.agree} agree with the forged mesh templates, ${check.disagree.length} disagree)` : ''}`)
	}
}
