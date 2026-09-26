#!/usr/bin/env node
// STEELSEED — tools/weapon-audio
//
// Carries the mod's weapon rules that decide what a WEAPON SOUNDS LIKE out of the yaml and into
// `web/src/audio/weapon-audio.json`, which `audio/index.ts` reads to pick a voice.
//
// WHY THIS EXISTS. `audio/synth.ts` shipped with one rule — "damage designs the sound, weapon
// class only varies it" — and eight report voices banded by damage. That rule is correct for a
// mod whose damage number is a physical quantity. It is NOT correct for the mod this game
// loads, and the measurement is unambiguous:
//
//   * `heaviness()` clamps damage to 50..1000. The fire event's magnitude is the SUM of positive
//     DamageWarhead damages (`SteelseedEventObserver.cs:86`), which in this mod runs 100..100000.
//     47 of the 50 authored weapons therefore land in band 7. THE GAME HAS ONE GUN SOUND.
//   * Even with the range fixed, damage cannot separate the families. `SilencedPPK` — a silenced
//     pistol — deals 15000. A `120mm` tank cannon deals 6000. `Colt45` deals 10000, more than
//     two of the three tank guns. This mod's damage is a BALANCE number, not a bore
//     measurement, so a synth keyed on it alone always makes the pistol the biggest gun on
//     the field.
//
// WHAT REPLACES IT, AND WHY IT IS NOT A PER-NAME TABLE. §14.13 forbids keying a generator off a
// NAME. It does not forbid reading the mod's own authored FIELDS, which is what `weapon-rules.mjs`
// already does for flight and `rosteradapt.mjs` does for hulls. The strongest such field here is
// one nobody had read yet:
//
//   `Report:` IS THE MOD'S OWN SOUND DESIGN DOCUMENT.
//
// `^TeslaWeapon` declares `Report: tesla1.aud`; `^AntiGroundMissile` declares `missile6.aud`;
// `^105mm` declares `cannon1.aud`. 47 of the 53 weapons name the sound they want. We can neither
// ship nor decode those files — they belong to the original rights-holder and this project's
// licence rules forbid them exactly as they forbid the sprites — but the DECLARATION is a rule
// like any other, and reading it is the same act as reading `TrailImage: smokey`, which
// `weapon-rules.json` has shipped since it was written. Only the stem is recorded, and nothing
// here ever opens the file.
//
// The derivation below therefore reads, in order: the death type the warhead applies
// (`ElectricityDeath`, `FireDeath`), the projectile class, the report stem, the launch angle, the
// rate of fire implied by `ReloadDelay`/`Burst`, and the number of simultaneous damage warheads.
// Every one of those is a functional field of the simulation. The weapon's NAME is used for
// exactly one thing — as the join key, the way `fx/index.ts:716` already resolves a fire event's
// string-table id through `ctx.actorTypeName` before asking `lookupRaWeaponVisual` about it.
//
// CROSS-CHECKED, NOT INVENTED. `src/weapon-visual-manifest.json` carries a hand-authored `family`
// for 50 of these weapons. This tool derives its family from the rules and then DIFFS against
// that authored one; `--check` fails if the disagreement count moves. 49 of 50 agree today, and
// the single disagreement is recorded below with its reason. Two independent routes to the same
// answer is what makes this a derivation rather than a second opinion.
//
// ONE PARSER. The MiniYAML reader, the `Inherits` resolution and the WDist parser are imported
// from `weapon-rules.mjs` rather than copied. A second reader that disagreed with the first about
// inheritance is precisely the "third source of truth" this is meant to avoid.
//
// Usage:
//   node tools/weapon-audio.mjs            # write web/src/audio/weapon-audio.json
//   node tools/weapon-audio.mjs --check    # fail if the committed table is stale
//   node tools/weapon-audio.mjs --report   # print the mod's full sound-declaration inventory

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { int, load, resolveNode, wdist } from './weapon-rules.mjs'

const TOOL = 'weapon-audio'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT = resolve(WEB, 'src/audio/weapon-audio.json')
const VISUAL = resolve(WEB, 'src/weapon-visual-manifest.json')

/** The simulation ticks at 25 Hz (§4.1). Every interval below is derived through this. */
const TICK_S = 1 / 25

/**
 * The audio families, in bank order. Twelve, because twelve is how many distinct EXCITATIONS the
 * mod actually declares — not how many words sound nice.
 *
 * A family earns a row here only if its physics differ, which is a much stronger test than
 * whether its damage differs. `cannon` and `artillery` share an excitation (a propellant charge
 * in a tube) and are separated by launch angle, because a howitzer's report is the same event
 * heard through a longer barrel at a higher elevation. `rocket` and `torpedo` share a motor and
 * are separated by the medium. `electric` has no combustion at all and cannot be a variation of
 * anything else in this list, which is why the old bank could not produce it at any damage.
 */
export const FAMILIES = [
	'cannon', 'artillery', 'mg', 'rifle', 'rocket', 'torpedo',
	'electric', 'flame', 'bomb', 'melee', 'heal', 'utility',
]

/**
 * Report stem -> EXCITATION CLASS. Not a per-weapon table: 53 weapons map through 16 stems, and
 * the stems come from the mod, not from us.
 *
 * The class is deliberately coarser than the family. It answers only "what kind of thing made
 * this noise" — a charge in a tube, a rocket motor, an electrical discharge, a small arm, a set
 * of jaws — and the launch angle and rate of fire below decide the rest. Keeping it coarse is
 * what stops it becoming a lookup table with the evidence filed off.
 */
const STEM_CLASS = [
	[/^tesla/, 'discharge'],
	[/^missile/, 'motor'],
	[/^torpedo/, 'torpedo'],
	[/^cannon|^turret|^tank|^grenade/, 'charge'],
	[/^aacanon/, 'autocannon'],
	[/^gun|^pillbox|^silppk/, 'smallarm'],
	[/^chute/, 'chute'],
	[/^antbite|^dogg/, 'organic'],
	[/^heal|^fixit/, 'restorative'],
]

/**
 * Rounds per second at which the ear stops hearing individual shots and starts hearing a BURST.
 *
 * Four is the classical flutter/fusion boundary for discrete transients, and it is the number
 * that decides whether a weapon is voiced as one dry crack repeated or as a single continuous
 * event. It separates `ZSU-23` (8.3 rps) from `FLAK-23-AG` (2.5 rps) — two autocannons the
 * authored visual table also splits, and it reaches the same answer from the rules alone.
 */
const BURST_FUSION_RPS = 4

/** Melee reach. The mod gives jaws and mandibles `Range: 1c512`; nothing that fires has less. */
const MELEE_RANGE_WDIST = 1536

function stemClass(stem) {
	for (const [re, cls] of STEM_CLASS) if (re.test(stem)) return cls
	return null
}

/**
 * The derivation. Reads only fields the simulation itself acts on.
 *
 * Order matters and is stated worst-consequence-first: a weapon that heals must never be voiced
 * as a gun, and a tesla coil must never be voiced as combustion, so those tests come before the
 * ones that could otherwise claim them.
 */
function familyOf(w) {
	if (w.healing) return 'heal'
	if (w.electric) return 'electric'
	if (w.incendiary) return 'flame'
	if (w.stem === 'motor' || (w.projectile === 'Missile' && w.stem !== 'torpedo')) return 'rocket'
	if (w.stem === 'torpedo') return 'torpedo'
	if (w.stem === 'chute' || w.projectile === 'GravityBomb') return 'bomb'
	if (w.stem === 'organic' || w.range <= MELEE_RANGE_WDIST) return 'melee'
	if (w.damage === 0) return 'utility'
	// Everything left is a charge in a tube. Three questions decide which one, in this order:
	// is it lobbed, is it fast enough to fuse into a burst, and is it a small arm.
	if (w.launchAngle > 0) return 'artillery'
	if (w.rps >= BURST_FUSION_RPS || w.damageWarheads > 2) return 'mg'
	if (w.stem === 'smallarm') return 'rifle'
	return 'cannon'
}

export function buildTable() {
	const raw = load()
	const weapons = {}
	const inventory = []
	for (const name of [...raw.keys()].sort()) {
		if (name.startsWith('^')) continue
		const fields = resolveNode(name, raw)
		const projectile = fields.Projectile
		// Same admission test as `weapon-rules.mjs`, so the two tables cover the same 53 rows and
		// a weapon cannot appear in one and be missing from the other.
		if (!projectile || !projectile.value) continue
		const p = Object.fromEntries(projectile.children.map(c => [c.key, c.value]))

		// The fire event's magnitude, computed the way the host computes it
		// (`SteelseedEventObserver.cs:86`): the SUM of positive DamageWarhead damages, clamped to
		// u16. Recomputing it here rather than assuming it lets `audiogate` assert that the bank
		// covers the range the game will actually send, instead of the range someone remembered.
		let damage = 0
		let damageWarheads = 0
		let healing = false
		let damageTypes = ''
		for (const [key, node] of Object.entries(fields)) {
			if (!key.startsWith('Warhead')) continue
			const kids = Object.fromEntries(node.children.map(c => [c.key, c.value]))
			const d = Number(kids.Damage)
			if (Number.isFinite(d) && d > 0) { damage += d; damageWarheads++ }
			if (Number.isFinite(d) && d < 0) healing = true
			if (kids.DamageTypes) damageTypes += `,${kids.DamageTypes}`
		}
		damage = Math.min(damage, 65535)

		const reloadDelay = int(fields.ReloadDelay?.value, 25)
		const burst = Math.max(1, int(fields.Burst?.value, 1))
		// `BurstDelays` may be one value for every gap or a comma list, one per gap. The MINIMUM
		// is what matters to a synth: it is the shortest interval between two rounds of this
		// weapon, and a voice longer than it will smear the burst into a drone.
		const burstDelays = String(fields.BurstDelays?.value ?? '5')
			.split(',').map(s => Number(s.trim())).filter(Number.isFinite)
		const burstDelay = burstDelays.length > 0 ? Math.min(...burstDelays) : 5
		const report = String(fields.Report?.value ?? fields.StartBurstReport?.value ?? '')
			.split(',')[0].trim()
		// The STEM only. Nothing here opens, ships, decodes or converts the file it names; it is
		// read exactly as `weapon-rules.json` reads `TrailImage`, as a rule reference.
		const reportRef = report.replace(/\.aud$/i, '') || null

		const row = {
			projectile: projectile.value,
			damage,
			damageWarheads,
			healing,
			electric: projectile.value === 'TeslaZap' || /ElectricityDeath/.test(damageTypes),
			// `FireDeath`, not `Incendiary`. SCUD and V2Explode are incendiary AND explosive; a
			// flamethrower is only ever the former. Keying on `Incendiary` put the V2 in the
			// flame family, which is both wrong and the exact shape of error this file exists
			// to stop.
			incendiary: /FireDeath/.test(damageTypes),
			range: wdist(fields.Range?.value) ?? 0,
			launchAngle: int(p.LaunchAngle, 0),
			reloadDelay,
			burst,
			burstDelay,
			rps: 25 / Math.max(reloadDelay / burst, 1e-6),
			stem: stemClass(reportRef ?? ''),
			reportRef,
		}
		const family = familyOf(row)

		// The shortest gap between two AUDIBLE ONSETS of this weapon, in seconds. Inside a burst
		// that is `BurstDelays`; between bursts it is `ReloadDelay`; the tighter of the two wins.
		//
		// `BurstDelays: 0` is NOT a zero-length gap — it means the burst's rounds are fired on
		// the same tick and arrive as ONE onset, so the real constraint falls back to the reload.
		// Treating a declared 0 as "the voice must be shorter than nothing" would make the
		// assertion below unsatisfiable for `ChainGun`, `Stinger` and `APTusk`, and an
		// unsatisfiable assertion gets its threshold relaxed rather than its bug fixed.
		//
		// This is the whole of "follow the weapon rules of the game" expressed as a quantity a
		// gate can measure a waveform against.
		const gaps = [reloadDelay]
		if (burst > 1 && burstDelay > 0) gaps.push(burstDelay)
		const roundIntervalS = Math.min(...gaps) * TICK_S

		weapons[name] = {
			family: FAMILIES.indexOf(family),
			damage: row.damage,
			projectile: row.projectile,
			reloadDelay,
			burst,
			burstDelay,
			roundIntervalS: Math.round(roundIntervalS * 1e4) / 1e4,
			launchAngle: row.launchAngle,
			reportRef,
		}
		inventory.push({ name, family, ...row, roundIntervalS })
	}
	return {
		schemaVersion: 1,
		source: 'engine/steelseed-host/generated/mods/ra/weapons',
		authoring: { source: 'web/tools/weapon-audio.mjs', revision: 1 },
		semantics: {
			join: 'Keyed by the mod weapon name. The fire event carries a shared string-table id; '
				+ 'resolve it through ctx.actorTypeName() and match CASE-INSENSITIVELY — '
				+ 'Ruleset.Weapons lowercases its keys, so a live match can publish "dragon" '
				+ 'against a table holding "Dragon".',
			damage: 'Sum of positive DamageWarhead damages, clamped to u16 — identical to the '
				+ 'formula in SteelseedEventObserver.cs:86, not the visual manifest caliber '
				+ '(which takes only the FIRST warhead).',
			roundIntervalS: 'Shortest gap between two rounds of this weapon at 25 Hz: BurstDelays '
				+ 'inside a burst, ReloadDelay for a single-shot weapon. A voice longer than this '
				+ 'smears its own cadence.',
			reportRef: 'The stem of the mod\'s own Report:/StartBurstReport: declaration, read as '
				+ 'a rule the way TrailImage is. The file it names belongs to the original '
				+ 'rights-holder and is never shipped, opened, decoded or converted; only this '
				+ 'six-character string is read, and only to derive the family below.',
		},
		families: FAMILIES,
		weapons,
	}
}

/** Compare the derivation against the hand-authored visual families. */
export function crossCheck(table) {
	let visual
	try { visual = JSON.parse(readFileSync(VISUAL, 'utf8')) } catch { return null }
	// `bullet` is the visual vocabulary's name for what the audio bank calls `rifle`: the visual
	// axis is the tracer primitive, the audio axis is the excitation. Same set, different noun.
	const alias = { bullet: 'rifle' }
	const byLower = new Map()
	for (const [name, row] of Object.entries(table.weapons)) byLower.set(name.toLowerCase(), row)
	const agree = []
	const disagree = []
	for (const profile of visual.profiles) {
		const row = byLower.get(profile.weapon.toLowerCase())
		if (!row) { disagree.push({ weapon: profile.weapon, audio: '(absent)', visual: profile.style.family }); continue }
		const audio = FAMILIES[row.family]
		const want = alias[profile.style.family] ?? profile.style.family
		if (audio === want) agree.push(profile.weapon)
		else disagree.push({ weapon: profile.weapon, audio, visual: profile.style.family })
	}
	return { agree: agree.length, disagree, total: visual.profiles.length }
}

/**
 * Disagreements that are DELIBERATE, with the rule that justifies each.
 *
 * A ratchet, not a waiver: `--check` fails if any disagreement appears that is not on this list,
 * and fails if one on this list disappears without the list being edited. That makes the
 * cross-check able to catch both a regression in the derivation and a silent edit to the
 * authored visual table.
 */
export const EXPECTED_DISAGREEMENTS = {
	// The visual table calls a parachute bomb "artillery" because it draws like one falling. The
	// mod says `Report: chute1.aud` where every artillery piece says cannon/turret/tank/grenade,
	// and `Projectile: GravityBomb` where they all say Bullet. A bomb released from a plane has
	// no propellant charge and therefore no report at all — what you hear is the release and the
	// chute. Voicing it as a howitzer would put a muzzle blast on a silent event.
	ParaBomb: { audio: 'bomb', visual: 'artillery' },
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()

function main() {
	const table = buildTable()
	const text = `${JSON.stringify(table, null, '\t')}\n`
	const check = crossCheck(table)

	if (process.argv.includes('--report')) {
		const rows = Object.entries(table.weapons)
		console.log(`${TOOL}: ${rows.length} weapons, ${FAMILIES.length} families`)
		const byFamily = new Map()
		for (const [name, row] of rows) {
			const f = FAMILIES[row.family]
			if (!byFamily.has(f)) byFamily.set(f, [])
			byFamily.get(f).push({ name, ...row })
		}
		for (const family of FAMILIES) {
			const list = byFamily.get(family) ?? []
			console.log(`\n  ${family}  (${list.length})`)
			for (const r of list) {
				console.log(
					`    ${r.name.padEnd(20)} dmg ${String(r.damage).padStart(6)}` +
					`  reload ${String(r.reloadDelay).padStart(3)}  burst ${String(r.burst).padStart(2)}` +
					`  round-gap ${r.roundIntervalS.toFixed(3)}s  ${r.projectile.padEnd(11)}` +
					`  Report ${r.reportRef ?? '(none declared)'}`)
			}
		}
		const declared = rows.filter(([, r]) => r.reportRef !== null).length
		console.log(`\n  ${declared}/${rows.length} weapons declare a sound in the rules; ` +
			`${rows.length - declared} are derived from projectile and warhead alone.`)
		if (check) {
			console.log(`  cross-check against the authored visual families: ` +
				`${check.agree}/${check.total} agree, ${check.disagree.length} disagree`)
			for (const d of check.disagree) console.log(`    ${d.weapon}: audio=${d.audio} visual=${d.visual}`)
		}
		return
	}

	// The cross-check runs on every mode, because a derivation that silently stopped agreeing
	// with the authored table is exactly the failure a stale-bytes diff cannot see.
	if (check) {
		const unexpected = check.disagree.filter(d => {
			const e = EXPECTED_DISAGREEMENTS[d.weapon]
			return !e || e.audio !== d.audio || e.visual !== d.visual
		})
		const missing = Object.keys(EXPECTED_DISAGREEMENTS)
			.filter(w => !check.disagree.some(d => d.weapon === w))
		if (unexpected.length > 0) {
			for (const d of unexpected)
				console.error(`${TOOL}: ${d.weapon} derives as '${d.audio}' but the authored visual family is '${d.visual}' — one of the two is wrong, and neither may be edited to match the other without saying which rule changed.`)
			process.exit(1)
		}
		if (missing.length > 0) {
			console.error(`${TOOL}: ${missing.join(', ')} no longer disagree — EXPECTED_DISAGREEMENTS is stale and is now hiding nothing. Remove the entry.`)
			process.exit(1)
		}
	}

	if (process.argv.includes('--check')) {
		let current = null
		try { current = readFileSync(OUT, 'utf8') } catch { current = null }
		if (current !== text) {
			console.error(`${TOOL}: ${OUT} is stale — run \`node tools/weapon-audio.mjs\``)
			process.exit(1)
		}
		console.log(`${TOOL}: OK — ${Object.keys(table.weapons).length} weapons across ${FAMILIES.length} families, ` +
			`table matches the rules${check ? `, ${check.agree}/${check.total} agree with the authored visual families` : ''}`)
	} else {
		writeFileSync(OUT, text)
		console.log(`${TOOL}: wrote ${Object.keys(table.weapons).length} weapons to ${OUT}` +
			`${check ? ` (${check.agree}/${check.total} agree with the authored visual families)` : ''}`)
	}
}
