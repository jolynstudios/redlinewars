#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fail } from './gate-lib.mjs'

const TOOL = 'simparitygate'
const seed = Number(process.argv.find(value => value.startsWith('--seed='))?.slice(7) ?? 104729)
const tick = Number(process.argv.find(value => value.startsWith('--tick='))?.slice(7) ?? 400)
// Validation-only mode: skip the forced `dotnet build -t:Rebuild` of the reference
// host and instead freshness-check the retained bundle. Inventing a second, cheaper
// simulation would be exactly the fork the hosting rules forbid, so the gate still
// runs the REAL simparity runs — it only skips the REBUILD. Env override for runners
// that cannot pass flags through.
const noBuild = process.argv.includes('--no-build') || process.env.STEELSEED_SKIP_REFERENCE_BUILD === '1'
const runner = resolve(import.meta.dirname, 'simrun.mjs')
const hostRoot = resolve(import.meta.dirname, '..')
const gameRoot = resolve(hostRoot, '../..')
const referenceBundle = resolve(gameRoot, 'engine/bin-browser-reference/AppBundle')
const referenceDll = resolve(gameRoot, 'engine/bin-browser-reference/OpenRA.Browser.dll')
const localDotnet = join(homedir(), '.dotnet', 'dotnet')
const dotnet = process.env.STEELSEED_DOTNET ?? (existsSync(localDotnet) ? localDotnet : 'dotnet')
const project = resolve(hostRoot, 'OpenRA.Browser/OpenRA.Browser.csproj')

function run(label, bundle = null) {
	const child = spawnSync(process.execPath, [runner, `--seed=${seed}`, `--tick=${tick}`,
		...(bundle ? [`--bundle=${bundle}`] : [])], {
		encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
	})
	if (child.status !== 0) fail(TOOL, `${label} exited ${child.status}:\n${child.stdout}\n${child.stderr}`)
	const line = child.stdout.split('\n').find(value => value.startsWith('SIMRESULT '))
	if (!line) fail(TOOL, `${label} returned no SIMRESULT:\n${child.stdout}`)
	return JSON.parse(line.slice('SIMRESULT '.length))
}

function mtimeOf(path) {
	return statSync(path).mtimeMs
}

function newestMtime(dir) {
	let newest = 0
	const stack = [dir]
	while (stack.length > 0) {
		const current = stack.pop()
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const child = join(current, entry.name)
			if (entry.isDirectory()) stack.push(child)
			else if (/\.(cs|csproj)$/.test(entry.name)) newest = Math.max(newest, mtimeOf(child))
		}
	}
	return newest
}

if (noBuild) {
	// Freshness, not faith: the bundle must EXIST and be NEWER than every source that
	// feeds it. A stale reference would validate against a host that no longer exists.
	if (!existsSync(referenceBundle) || !existsSync(referenceDll))
		fail(TOOL, 'no reference bundle; run once without --no-build to create engine/bin-browser-reference')
	if (newestMtime(resolve(hostRoot, 'OpenRA.Browser')) > mtimeOf(referenceDll))
		fail(TOOL, 'reference bundle stale; rebuild (run once without --no-build)')
} else {
	const referenceBuild = spawnSync(dotnet, [
		'build', project, '-t:Rebuild', '-c', 'Release', '-p:RunAOTCompilation=false',
		'-p:SteelseedParityReference=true', '-p:NoWarn=SA0001',
	], { cwd: gameRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
	if (referenceBuild.status !== 0)
		fail(TOOL, `reference host build failed (${referenceBuild.status}):\n${referenceBuild.stdout}\n${referenceBuild.stderr}`)
}

const first = run('assetless-a')
const second = run('assetless-b')
const reference = run('reference-ra', referenceBundle)
if (JSON.stringify(first.checkpoints) !== JSON.stringify(second.checkpoints) || first.syncHash !== second.syncHash)
	fail(TOOL, `fixed-seed runs diverged:\n${JSON.stringify(first)}\n${JSON.stringify(second)}`)
if (JSON.stringify(first.checkpoints) !== JSON.stringify(reference.checkpoints) || first.syncHash !== reference.syncHash)
	fail(TOOL, `reference RA and assetless RA diverged:\nassetless=${JSON.stringify(first)}\nreference=${JSON.stringify(reference)}`)
if (JSON.stringify(first.outcome) !== JSON.stringify(second.outcome) ||
	JSON.stringify(first.outcome) !== JSON.stringify(reference.outcome))
	fail(TOOL, `reference RA and assetless RA outcomes diverged:\n${JSON.stringify({ first: first.outcome, second: second.outcome, reference: reference.outcome })}`)
if (!first.orderIssued || first.host !== 'running') fail(TOOL, 'fixed player order was not issued or host stopped')
if (!reference.orderIssued || reference.host !== 'running') fail(TOOL, 'reference fixed player order was not issued or host stopped')
if (!first.shroud || first.shroud.runs <= 0 || first.shroud.visible <= 0 || first.shroud.unexplored <= 0)
	fail(TOOL, `real skirmish shroud witness is invalid: ${JSON.stringify(first.shroud)}`)

// Witnessed-red: one changed hash at an otherwise identical checkpoint must diverge.
const falsifier = structuredClone(second.checkpoints)
falsifier.at(-1)[1] ^= 1
if (JSON.stringify(first.checkpoints) === JSON.stringify(falsifier)) fail(TOOL, 'sync-hash falsifier was not detected')

console.log(`${TOOL}: PASS — pinned unstripped reference RA equals two assetless RA runs, seed ${seed}, fixed Move order, ${first.checkpoints.length} checkpoints through tick ${first.tick}, sync ${first.syncHash}, outcome ${first.outcome.gameOver ? 'game-over' : 'running'}; real shroud witnessed; hash falsifier witnessed red`)
