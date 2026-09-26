#!/usr/bin/env node

// STEELSEED — tools/sim-build-id (MULTIPLAYER-SERVICE §5.8, T2.1)
//
// The sim build id is a content id over everything the simulation can observe —
// the generated mod tree, the pinned simulation sources and both server-side
// assembly trees — deliberately excluding web/, desktop/ and art/: a visual
// deploy must never strand installed apps behind a version refusal.
//
//   treeHash(X) = sha256(join("\n", sort(relPath + "\0" + sha256hex(file))))
//   simBuild    = first 12 hex of sha256("redline-sim-v1\n" + A + B + C + D)
//
// `modTreeHash` is tree A: the generated mod with its stamped "Version:" value
// blanked. The stamp carries the id itself, so hashing it verbatim would be
// circular — and blanking is what makes the id (and the recorded modHash)
// stable across rebuilds that only renew the stamp. The node start-up check
// (roomhost) recomputes exactly this function over the mod directory it
// launches and refuses to start on a difference from build.json's `modHash`.
//
// Raw bytes everywhere: no EOL normalisation, so two clean checkouts of one
// commit always agree. Run directly to print the current id.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MOD_VERSION_TAG = '7eabcfe-assetless'
const SIM_BUILD_SEED = 'redline-sim-v1'

function globToRegExp(glob) {
	// One pass with an ordered alternation: `**/` must win over `**`, and text
	// inserted for one token must never be rescanned as glob syntax by a later
	// step (a chained series of replaces would corrupt `(?:.*/)?` into `([^/]:…`).
	const pattern = glob.replace(
		/(\*\*\/)|(\*\*)|(\*)|(\?)|[.+^${}()|[\]\\]/g,
		(token, doubleDir, doubleStar, singleStar, questionMark) => {
			if (doubleDir) return '(?:.*/)?'
			if (doubleStar) return '.*'
			if (singleStar) return '[^/]*'
			if (questionMark) return '[^/]'
			return `\\${token}`
		})
	return new RegExp(`^${pattern}$`)
}

export function treeHash(root, globs, transform = null) {
	const matchers = globs.map(globToRegExp)
	const relPaths = []
	const pending = [root]
	while (pending.length > 0) {
		const current = pending.pop()
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			// obj/ and bin/ are build products: generated AssemblyAttributes and
			// friends appear/disappear with every dotnet invocation and would make
			// the id drift between publishes of one commit (T2.1 acceptance).
			if (entry.isDirectory()) {
				if (entry.name === 'obj' || entry.name === 'bin') continue
				pending.push(join(current, entry.name))
			} else if (entry.isFile()) {
				const relPath = relative(root, join(current, entry.name)).split(sep).join('/')
				if (matchers.some(matcher => matcher.test(relPath))) relPaths.push(relPath)
			}
		}
	}
	if (relPaths.length === 0)
		throw new Error(`sim-build-id: no files matched ${globs.join(', ')} under ${root}`)
	const rows = relPaths.map(relPath => {
		const bytes = readFileSync(join(root, ...relPath.split('/')))
		return `${relPath}\0${createHash('sha256').update(transform ? transform(relPath, bytes) : bytes).digest('hex')}`
	})
	return createHash('sha256').update(rows.join('\n')).digest('hex')
}

export function modTreeHash(modRoot) {
	return treeHash(modRoot, ['**'], (relPath, bytes) =>
		relPath === 'mod.yaml'
			? Buffer.from(bytes.toString('utf8').replace(/^(\t*)Version:.*$/m, '$1Version:'), 'utf8')
			: bytes)
}

export function computeSimBuild(engineRoot) {
	const a = modTreeHash(resolve(engineRoot, 'steelseed-host/generated/mods/ra'))
	const b = treeHash(engineRoot, ['openra/**/*.cs', 'openra/**/*.yaml'])
	const c = treeHash(engineRoot, ['steelseed-host/OpenRA.Mods.Steelseed/**/*.cs'])
	const d = treeHash(engineRoot, [
		'OpenRA.Game/**/*.cs',
		'OpenRA.Mods.Common/**/*.cs',
		'OpenRA.Mods.Cnc/**/*.cs',
		'OpenRA.Mods.Steelseed/**/*.cs',
		'OpenRA.Server/**/*.cs',
	])
	return createHash('sha256').update(`${SIM_BUILD_SEED}\n${a}${b}${c}${d}`).digest('hex').slice(0, 12)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const engineRoot = resolve(import.meta.dirname, '..', '..')
	const simBuild = computeSimBuild(engineRoot)
	const modHash = modTreeHash(resolve(engineRoot, 'steelseed-host/generated/mods/ra'))
	console.log(`${simBuild}\nmodHash ${modHash}\nversion ${MOD_VERSION_TAG}-${simBuild}`)
}
