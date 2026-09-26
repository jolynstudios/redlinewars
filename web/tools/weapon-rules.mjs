#!/usr/bin/env node
// STEELSEED — tools/weapon-rules
//
// Carries the RA weapon rules that decide how a PROJECTILE LOOKS out of the mod yaml and into a
// table `web/src/fx/weapon-rules.json` that `fx/projectiles.ts` reads.
//
// WHY A TABLE AND NOT A GUESS. The human's instruction is "follow the weapon rules of the game".
// Most of that is already structural rather than authored here: the host publishes each
// projectile's real position and its real per-tick velocity, so `Speed`, `Range`, `RangeLimit`,
// `Inaccuracy`, the launch angles, `ReloadDelay` and `Burst` all reach the screen because the
// SIMULATION applied them — a live `Dragon` measured 212 WDist/tick against its rules `Speed: 213`
// without this file existing. What the simulation does NOT hand the browser is the presentation
// half of the same rules: whether a weapon lays a smoke trail at all (`TrailImage`), how often
// (`TrailInterval`), how long a contrail it drags (`ContrailLength`) and how wide
// (`ContrailStartWidth`). Those were being replaced by one constant for every weapon in the game,
// which is exactly the thing the instruction forbids.
//
// WHICH YAML. `engine/steelseed-host/generated/mods/ra/weapons` — the mod the game actually
// loads, written by `build-ra-mod.mjs`, not the upstream tree beside it. They are byte-identical
// today; reading the generated one means they cannot silently stop being.
//
// The parser is a small MiniYAML reader: tab indents, `key: value`, `Inherits` (and `Inherits@n`)
// resolved depth-first with the child overriding the parent, and `Projectile`'s children merged
// as a block so `Dragon: Inherits ^AntiGroundMissile / Projectile: Missile / TrailImage: smokey`
// keeps the parent's Speed, Image, Shadow and ContrailLength and adds its own trail.
//
// Usage:
//   node tools/weapon-rules.mjs            # write web/src/fx/weapon-rules.json
//   node tools/weapon-rules.mjs --check    # fail if the committed table is stale

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TOOL = 'weapon-rules'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GAME = resolve(WEB, '..')
const RULES_DIR = resolve(GAME, 'engine/steelseed-host/generated/mods/ra/weapons')
const OUT = resolve(WEB, 'src/fx/weapon-rules.json')

/** `7c512` is 7 cells and 512 WDist; a bare number is WDist. Both land in WDist. */
export function wdist(value) {
	if (value == null || value === '') return null
	const cell = String(value).indexOf('c')
	if (cell < 0) {
		const n = Number(value)
		return Number.isFinite(n) ? n : null
	}
	const cells = Number(String(value).slice(0, cell))
	const rest = Number(String(value).slice(cell + 1))
	return Number.isFinite(cells) && Number.isFinite(rest) ? cells * 1024 + rest : null
}

// EXPORTED, additively, so `tools/weapon-audio.mjs` can derive the AUDIO projection of the same
// rules without a second MiniYAML reader in the repository. Nothing about `buildTable()` changes;
// `weapon-rules.mjs --check` and `projectilegate` still assert the same bytes. One parser, one
// mod, two projections — the alternative was a copy of this reader that could silently disagree
// with it about inheritance, which is the "third source of truth" failure this avoids.
export function nodesOf(text) {
	const lines = text.split('\n')
	const root = []
	const stack = [{ indent: -1, children: root }]
	for (const line of lines) {
		let indent = 0
		while (indent < line.length && line.charCodeAt(indent) === 9) indent++
		const content = line.slice(indent).trim()
		if (!content || content.startsWith('#')) continue
		const colon = content.indexOf(':')
		if (colon < 0) continue
		const node = {
			key: content.slice(0, colon).trim(),
			value: content.slice(colon + 1).trim(),
			children: [],
		}
		while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
		stack[stack.length - 1].children.push(node)
		stack.push({ indent, children: node.children })
	}
	return root
}

export function load() {
	const files = readdirSync(RULES_DIR).filter(f => f.endsWith('.yaml')).sort()
	const raw = new Map()
	for (const file of files)
		for (const node of nodesOf(readFileSync(join(RULES_DIR, file), 'utf8')))
			raw.set(node.key, node)
	return raw
}

/** Flatten a node's children into { key -> { value, children } }, child overriding parent. */
export function resolveNode(name, raw, seen = new Set()) {
	if (seen.has(name)) return {}
	seen.add(name)
	const node = raw.get(name)
	if (!node) return {}
	const out = {}
	// Parents first, in declaration order, so a later Inherits wins over an earlier one and the
	// weapon's own fields win over both.
	for (const child of node.children) {
		if (!child.key.startsWith('Inherits')) continue
		const parent = resolveNode(child.value, raw, seen)
		for (const [k, v] of Object.entries(parent)) out[k] = { ...v }
	}
	for (const child of node.children) {
		if (child.key.startsWith('Inherits')) continue
		const existing = out[child.key]
		const merged = {}
		if (existing) for (const c of existing.children) merged[c.key] = c.value
		for (const c of child.children) merged[c.key] = c.value
		out[child.key] = {
			value: child.value === '' && existing ? existing.value : child.value,
			children: Object.entries(merged).map(([key, value]) => ({ key, value })),
		}
	}
	return out
}

export function bool(value, fallback) {
	if (value == null) return fallback
	const v = String(value).toLowerCase()
	return v === 'true' || v === 'yes'
}

export function int(value, fallback) {
	if (value == null || value === '') return fallback
	const n = Number(value)
	return Number.isFinite(n) ? n : fallback
}

export function buildTable() {
	const raw = load()
	const weapons = {}
	for (const name of [...raw.keys()].sort()) {
		// `^Abstract` entries exist only to be inherited from; a weapon a unit can carry never
		// starts with a caret.
		if (name.startsWith('^')) continue
		const fields = resolveNode(name, raw)
		const projectile = fields.Projectile
		if (!projectile || !projectile.value) continue
		const p = Object.fromEntries(projectile.children.map(c => [c.key, c.value]))
		weapons[name] = {
			projectile: projectile.value,
			// Simulation-owned. Recorded so a gate can check the drawn flight against the number
			// the rules actually declare, rather than trusting that it must be right.
			reloadDelay: int(fields.ReloadDelay?.value, null),
			burst: int(fields.Burst?.value, 1),
			range: wdist(fields.Range?.value),
			speed: wdist(p.Speed),
			rangeLimit: wdist(p.RangeLimit),
			inaccuracy: wdist(p.Inaccuracy) ?? 0,
			// Presentation-owned. These are the values that had no consumer.
			image: p.Image ?? null,
			shadow: bool(p.Shadow, false),
			trailImage: p.TrailImage ?? null,
			// OpenRA's own defaults: BulletInfo/MissileInfo TrailInterval = 2, TrailDelay = 1.
			trailInterval: int(p.TrailInterval, 2),
			trailDelay: int(p.TrailDelay, 1),
			contrailLength: int(p.ContrailLength, 0),
			contrailStartWidth: wdist(p.ContrailStartWidth) ?? 64,
			contrailEndWidth: wdist(p.ContrailEndWidth),
			blockable: bool(p.Blockable, true),
		}
	}
	return { schemaVersion: 1, source: 'engine/steelseed-host/generated/mods/ra/weapons', weapons }
}

// Importable as a library — `projectilegate` re-derives the table and diffs it — so the CLI half
// runs only when this file IS the entry point. Importing it must never write to the tree.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()

function main() {
const table = buildTable()
const text = `${JSON.stringify(table, null, '\t')}\n`
if (process.argv.includes('--check')) {
	let current = null
	try { current = readFileSync(OUT, 'utf8') } catch { current = null }
	if (current !== text) {
		console.error(`${TOOL}: ${OUT} is stale — run \`node tools/weapon-rules.mjs\``)
		process.exit(1)
	}
	console.log(`${TOOL}: OK — ${Object.keys(table.weapons).length} weapons, table matches the rules`)
} else if (process.argv.includes('--print')) {
	console.log(text)
} else {
	writeFileSync(OUT, text)
	console.log(`${TOOL}: wrote ${Object.keys(table.weapons).length} weapons to ${OUT}`)
}
}
