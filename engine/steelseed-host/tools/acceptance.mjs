#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const TOOL = 'ra-acceptance'
const gameRoot = resolve(import.meta.dirname, '../../..')
const hostRoot = resolve(import.meta.dirname, '..')
const full = process.argv.includes('--full')
const aot = full || process.argv.includes('--aot')
const allMaps = full || process.argv.includes('--all-maps')
// Validation-only mode: run every CHECK, skip every heavy PRODUCER (vendor fetch, mod
// generation, host build, web build, AOT compose) in favour of a freshness check of
// its output against the inputs each producer depends on, and hand --no-build to the
// simparitygate step. A missing or stale output fails the mode rather than being
// quietly regenerated — validate refuses to validate a half-built tree.
const validate = process.argv.includes('--validate')
const sourceArg = process.argv.find(value => value.startsWith('--source='))
const localDotnet = join(homedir(), '.dotnet', 'dotnet')
const dotnet = process.env.STEELSEED_DOTNET ?? (existsSync(localDotnet) ? localDotnet : 'dotnet')
const project = resolve(hostRoot, 'OpenRA.Browser/OpenRA.Browser.csproj')

const steps = [
	['vendorgate', process.execPath, [resolve(import.meta.dirname, 'vendor-openra.mjs'), ...(sourceArg ? [sourceArg] : [])]],
	['assetless-mod', process.execPath, [resolve(import.meta.dirname, 'build-ra-mod.mjs')]],
	['host-build', dotnet, ['build', project, '-c', 'Release', '-p:RunAOTCompilation=false', '-p:NoWarn=SA0001']],
	['ruleparitygate', process.execPath, [resolve(import.meta.dirname, 'ruleparitygate.mjs')]],
	['assetgate', process.execPath, [resolve(import.meta.dirname, 'assetgate.mjs')]],
	['colorgate', process.execPath, [resolve(import.meta.dirname, 'colorgate.mjs')]],
	['facinggate', process.execPath, [resolve(import.meta.dirname, 'facinggate.mjs')]],
	['mapfillgate', process.execPath, [resolve(import.meta.dirname, 'mapfillgate.mjs')]],
	['aigate', process.execPath, [resolve(import.meta.dirname, 'aigate.mjs')]],
	['snapshotabigate', process.execPath, [resolve(import.meta.dirname, 'snapshotabigate.mjs')]],
	['visualcataloggate', process.execPath, [resolve(import.meta.dirname, 'visualcataloggate.mjs')]],
	['placementgate', process.execPath, [resolve(import.meta.dirname, 'placementgate.mjs')]],
	['productionuxgate', process.execPath, [resolve(gameRoot, 'web/tools/productionuxgate.mjs')]],
	['selectiongate', process.execPath, [resolve(gameRoot, 'web/tools/selectiongate.mjs')]],
	['actorgate', process.execPath, [resolve(import.meta.dirname, 'actorgate.mjs')]],
	['contextcollisiongate', process.execPath, [resolve(import.meta.dirname, 'contextcollisiongate.mjs')]],
	['deploygate', process.execPath, [resolve(import.meta.dirname, 'deploygate.mjs')]],
	['resourcegate', process.execPath, [resolve(gameRoot, 'web/tools/resourcegate.mjs')]],
	['economygate', process.execPath, [resolve(gameRoot, 'web/tools/economygate.mjs')]],
	['frozengate', process.execPath, [resolve(import.meta.dirname, 'frozengate.mjs')]],
	['setupgate', process.execPath, [resolve(import.meta.dirname, 'setupgate.mjs'), ...(allMaps ? ['--all-maps'] : [])]],
	['simparitygate', process.execPath, [resolve(import.meta.dirname, 'simparitygate.mjs')]],
	['aidynamicgate', process.execPath, [resolve(import.meta.dirname, 'aidynamicgate.mjs')]],
	['web-typecheck', 'npm', ['--prefix', resolve(gameRoot, 'web'), 'run', 'typecheck']],
	['web-rulecheck', 'npm', ['--prefix', resolve(gameRoot, 'web'), 'run', 'lint:rules']],
	['sourcelicensegate', process.execPath, [resolve(gameRoot, 'web/tools/sourcelicensegate.mjs')]],
	['web-build', 'npm', ['--prefix', resolve(gameRoot, 'web'), 'run', 'build']],
	['shroudgate', process.execPath, [resolve(gameRoot, 'web/tools/shroudgate.mjs')]],
	['groundgate', process.execPath, [resolve(gameRoot, 'web/tools/groundgate.mjs')]],
	['watergate', process.execPath, [resolve(gameRoot, 'web/tools/watergate.mjs')]],
	['muzzlegate', process.execPath, [resolve(gameRoot, 'web/tools/muzzlegate.mjs')]],
	['zonegate', process.execPath, [resolve(gameRoot, 'web/tools/zonegate.mjs')]],
	['skingate', process.execPath, [resolve(gameRoot, 'web/tools/skingate.mjs')]],
	['uniquenessgate', process.execPath, [resolve(gameRoot, 'web/tools/uniquenessgate.mjs')]],
	['render-facinggate', process.execPath, [resolve(gameRoot, 'web/tools/facinggate.mjs')]],
	['runninggeargate', process.execPath, [resolve(gameRoot, 'web/tools/runninggeargate.mjs')]],
	['deathvisualgate', process.execPath, [resolve(gameRoot, 'web/tools/deathvisualgate.mjs')]],
	['aircraftclearancegate', process.execPath, [resolve(gameRoot, 'web/tools/aircraftclearancegate.mjs')]],
	['weaponvisualgate', process.execPath, [resolve(gameRoot, 'web/tools/weaponvisualgate.mjs')]],
	['weaponbindinggate', process.execPath, [resolve(gameRoot, 'web/tools/weaponbindinggate.mjs')]],
	['humansurfacegate', process.execPath, [resolve(gameRoot, 'web/tools/humansurfacegate.mjs')]],
	['authoredlodgate', process.execPath, [resolve(gameRoot, 'web/tools/authoredlodgate.mjs')]],
	['animinterpolationgate', process.execPath, [resolve(gameRoot, 'web/tools/animinterpolationgate.mjs')]],
	['meadowdistributiongate', process.execPath, [resolve(gameRoot, 'web/tools/meadowdistributiongate.mjs')]],
	['ragate', process.execPath, [resolve(gameRoot, 'web/tools/ragate.mjs')]],
]

if (aot) {
	steps.push(
		['release-aot', dotnet, ['publish', project, '-c', 'Release', '-p:NoWarn=SA0001']],
		['compose', 'npm', ['--prefix', resolve(gameRoot, 'web'), 'run', 'compose']],
		['final-assetgate', process.execPath, [resolve(import.meta.dirname, 'assetgate.mjs')]],
	)
}

/** Newest mtime under a path: a file is its own; a directory is the newest matching file inside (recursive). */
function newestUnder(path, filter = null) {
	const stat = statSync(path)
	if (!stat.isDirectory()) return stat.mtimeMs
	let newest = 0
	const stack = [path]
	while (stack.length > 0) {
		const current = stack.pop()
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const child = join(current, entry.name)
			if (entry.isDirectory()) stack.push(child)
			else if (!filter || filter.test(entry.name)) newest = Math.max(newest, statSync(child).mtimeMs)
		}
	}
	return newest
}

/** Producer -> the output whose existence --validate requires, plus the inputs that date it. */
const composeInputs = [resolve(gameRoot, 'engine/bin-browser/OpenRA.Browser.dll'), resolve(gameRoot, 'web/dist/index.html')]
const validateOutputs = {
	vendorgate: {
		output: resolve(gameRoot, 'engine/openra/mods/ra'),
		sources: [resolve(import.meta.dirname, 'vendor-openra.mjs'), resolve(gameRoot, 'engine/openra/vendor-policy.json')],
	},
	'assetless-mod': {
		output: resolve(hostRoot, 'generated/mods/ra'),
		sources: [
			resolve(import.meta.dirname, 'build-ra-mod.mjs'),
			resolve(import.meta.dirname, 'deployment-timing.mjs'),
			resolve(import.meta.dirname, 'hero-bridge-mod.mjs'),
			resolve(hostRoot, 'assetless-policy.json'),
			resolve(hostRoot, 'sequence-timing.json'),
			resolve(hostRoot, 'deployment-timing.json'),
			resolve(gameRoot, 'engine/openra/mods/ra'),
		],
	},
	'host-build': {
		output: resolve(gameRoot, 'engine/bin-browser/OpenRA.Browser.dll'),
		sources: [resolve(hostRoot, 'OpenRA.Browser')],
		filter: /\.(cs|csproj)$/,
	},
	'web-build': {
		output: resolve(gameRoot, 'web/dist/index.html'),
		sources: [resolve(gameRoot, 'web/src'), resolve(gameRoot, 'web/index.html'), resolve(gameRoot, 'web/vite.config.ts'), resolve(gameRoot, 'web/package.json')],
	},
	'release-aot': { output: resolve(gameRoot, 'engine/bin-browser/AppBundle'), sources: composeInputs },
	'compose': { output: resolve(gameRoot, 'engine/bin-browser/AppBundle'), sources: composeInputs },
	'final-assetgate': { output: resolve(gameRoot, 'engine/bin-browser/AppBundle'), sources: composeInputs },
}

for (const [name, command, args] of steps) {
	if (validate && validateOutputs[name]) {
		const producer = validateOutputs[name]
		if (!existsSync(producer.output)) {
			console.error(`${TOOL}: FAIL ${name} (validate: required build output missing — run the full pipeline once)`)
			process.exit(1)
		}
		try {
			const builtAt = newestUnder(producer.output, producer.filter)
			const stale = producer.sources.filter(source => newestUnder(source, producer.filter) > builtAt)
			if (stale.length > 0) {
				const newer = stale.map(source => relative(gameRoot, source)).join(', ')
				console.error(`${TOOL}: FAIL ${name} (validate: stale: run full acceptance — inputs newer than ${relative(gameRoot, producer.output)}: ${newer})`)
				process.exit(1)
			}
		} catch (error) {
			console.error(`${TOOL}: FAIL ${name} (validate: cannot freshness-check output — run the full pipeline once: ${error.message})`)
			process.exit(1)
		}
		console.log(`${TOOL}: SKIP ${name} (validate: output present and fresh)`)
		continue
	}
	console.log(`${TOOL}: START ${name}`)
	// simparitygate runs its real reference comparison in validate mode; only its
	// forced reference-host REBUILD is skipped from inside.
	const runArgs = validate && name === 'simparitygate' ? [...args, '--no-build'] : args
	const result = spawnSync(command, runArgs, { cwd: gameRoot, stdio: 'inherit' })
	if (result.error) throw result.error
	if (result.status !== 0) {
		console.error(`${TOOL}: FAIL ${name} (exit ${result.status})`)
		process.exit(result.status ?? 1)
	}
	console.log(`${TOOL}: PASS ${name}`)
}

console.log(`${TOOL}: PASS — ${steps.length} executable gates${validate ? ', validate mode (producers skipped, outputs checked)' : ''}${allMaps ? ', all 67 map starts' : ''}${aot ? ', Release AOT composed' : ''}`)
