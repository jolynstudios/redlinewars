#!/usr/bin/env node
// FULL SHIP PIPELINE — the only sanctioned way to put a build in front of a human.
// Runs everything, in dependency order, and fails LOUDLY on the first red step.
// A half-built AppBundle must never reach the server again (black-screen incident,
// 2026-09-17: a broken .forge symlink skipped compose and the server happily served
// an incomplete bundle).
//
// Usage:  node tools/ship.mjs [--fast]
//         --fast skips the browser perf gates (battle/bootcache/motion) for quick
//         iteration; NEVER ship to a human with --fast.
//
// Steps (each gates the next):
//   1. tsc --noEmit            — types
//   2. vite build              — web bundle
//   3. dotnet publish          — engine wasm (only when its C# sentinels are
//                                newer than the published AppBundle, or when
//                                the sim stamp embedded in the wasm drifted
//                                from the computed simBuild; else skipped)
//   4. support-file resync     — restamp the AppBundle vfs support files from
//                                the generated mod when the publish skipped
//                                the emcc packing (incremental link up-to-date
//                                but the mod stamp moved — see step 3)
//   5. compose                 — AppBundle presentation join
//   6. integration-gates       — rules/assets/deployment parity (static)
//   7. ruleparitygate          — rule graph vs canonical OpenRA (static)
//   8. composedgate            — one document boots, starts, presents (browser)
//   9. hudgate                 — economy/production/placement live (browser)
//  10. groundgate              — 3880 ground-contact cases exact (browser)
//  11. motiongate              — movement + orders (browser)
//  12. battleperfgate          — 4-player 60fps combat budget (browser)
//  13. bootcachegate           — LOD cache cold/warm + geometry identical
//  14. rsync to the main tree  — only after everything above is green

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSimBuild } from '../../engine/steelseed-host/tools/sim-build-id.mjs'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const gameRoot = resolve(webRoot, '..')
const hostRoot = join(gameRoot, 'engine/steelseed-host')
const fast = process.argv.includes('--fast')

const steps = []
const step = (name, fn) => steps.push({ name, fn })

const run = (cmd, args, opts = {}) => {
	const r = spawnSync(cmd, args, { cwd: webRoot, stdio: 'inherit', ...opts })
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`)
}

const gate = (script, args = []) => run('node', [script, ...args], { cwd: webRoot })

const dotnet = existsSync(`${process.env.HOME}/.dotnet/dotnet`) && !existsSync('/usr/local/bin/dotnet')
	? `${process.env.HOME}/.dotnet/dotnet` : 'dotnet'

const newer = (a, b) => !existsSync(b) || statSync(a).mtimeMs > statSync(b).mtimeMs
const sentinelDirty = ['SteelseedEventObserver.cs', 'SnapshotEmitter.cs', 'Program.Bridge.cs']
	.some(f => newer(join(hostRoot, f), join(gameRoot, 'engine/bin-browser/AppBundle/dotnet.native.wasm')))
// The multiplayer handshake hard-rejects any client/server pair whose mod
// Version stamps differ, and the wasm publish embeds the generated mod
// manifest's stamp at publish time. A change in only the standalone server's
// tree (top-level OpenRA.Game — sim tree D) moves the simBuild without
// touching the browser sentinels above, which once left the shipped wasm one
// stamp behind the servers (2026-09-29: every join answered "Not running the
// same version"). So the publish also re-runs whenever the stamp the wasm
// actually embeds drifted from the simBuild computed from the current tree.
const supportFilesDir = join(gameRoot, 'engine/bin-browser/AppBundle/_framework/supportFiles')
const embeddedModYaml = existsSync(supportFilesDir)
	? readdirSync(supportFilesDir).find(f => /^\d+_mod\.yaml$/.test(f)) ?? null
	: null
const embeddedSimBuild = embeddedModYaml
	? readFileSync(join(supportFilesDir, embeddedModYaml), 'utf8').match(/Version:\s*\S*-([0-9a-f]{12})\s*$/m)?.[1] ?? null
	: null
const currentSimBuild = computeSimBuild(join(gameRoot, 'engine'))
const engineDirty = sentinelDirty || embeddedSimBuild !== currentSimBuild

// The dotnet publish can also silently skip the repack: when the emcc link is
// incrementally up-to-date (no browser-tree .cs change — e.g. only the
// standalone server's tree moved the simBuild), the SDK leaves the AppBundle's
// vfs support files untouched, stale stamp and all. So after every publish the
// generated mod is synced into the AppBundle vfs by hand, hash-restamping
// blazor.boot.json to match — the same two artifacts the SDK packing would
// have written. (2026-09-29: run 6 proved a forced publish alone is not
// enough; the second ranked-E2E outage was exactly this gap.)
const syncSupportFiles = () => {
	const frameworkDir = join(gameRoot, 'engine/bin-browser/AppBundle/_framework')
	const bootPath = join(frameworkDir, 'blazor.boot.json')
	if (!existsSync(bootPath)) return console.log('  support-file resync skipped (no AppBundle boot manifest)')
	const boot = JSON.parse(readFileSync(bootPath, 'utf8'))
	const vfs = boot.resources?.vfs ?? {}
	const generatedRa = join(hostRoot, 'generated/mods/ra')
	let updated = 0
	for (const [vpath, entry] of Object.entries(vfs)) {
		if (!vpath.startsWith('/openra/engine/mods/ra/')) continue
		const src = join(generatedRa, vpath.slice('/openra/engine/mods/ra/'.length))
		if (!existsSync(src)) continue
		const bytes = readFileSync(src)
		const hash = 'sha256-' + createHash('sha256').update(bytes).digest('base64')
		for (const [supportRel, oldHash] of Object.entries(entry)) {
			const dest = join(frameworkDir, supportRel)
			const current = existsSync(dest) ? readFileSync(dest) : null
			if (current?.equals(bytes) && oldHash === hash) continue
			writeFileSync(dest, bytes)
			entry[supportRel] = hash
			updated++
			console.log(`  support-file resync: ${supportRel} <- ${vpath}`)
		}
	}
	if (updated > 0) writeFileSync(bootPath, JSON.stringify(boot, null, 2) + '\n')
	console.log(`  support-file resync: ${updated === 0 ? 'in sync' : `${updated} file(s) restamped`}`)
}

step('tsc --noEmit', () => run('./node_modules/.bin/tsc', ['--noEmit']))
step('vite build', () => run('./node_modules/.bin/vite', ['build']))
step('dotnet publish (engine)', () => {
	if (!engineDirty) return console.log('  engine unchanged, publish skipped')
	if (!sentinelDirty) console.log(`  wasm stamp drifted (embedded ${embeddedSimBuild} vs sim ${currentSimBuild}) — republishing`)
	run(dotnet, ['publish', '-c', 'Release'], { cwd: join(hostRoot, 'OpenRA.Browser') })
})
step('support-file resync', syncSupportFiles)
step('compose', () => gate('tools/compose.mjs'))
step('integration-gates', () => gate(join(hostRoot, 'tools/integration-gates.mjs')))
step('ruleparitygate', () => gate(join(hostRoot, 'tools/ruleparitygate.mjs')))
step('composedgate', () => gate('tools/composedgate.mjs'))
step('hudgate', () => gate('tools/hudgate.mjs'))
step('groundgate', () => gate('tools/groundgate.mjs'))
if (!fast) {
	step('motiongate', () => gate('tools/motiongate.mjs'))
	step('battleperfgate', () => gate('tools/battleperfgate.mjs'))
	step('bootcachegate', () => gate('tools/bootcachegate.mjs'))
}

const started = Date.now()
let done = 0
try {
	for (const s of steps) {
		done++
		console.log(`\n=== [${done}/${steps.length}] ${s.name} ===`)
		s.fn()
	}
} catch (error) {
	console.error(`\nSHIP: FAIL at step ${done}/${steps.length} — ${error.message}`)
	console.error('The AppBundle was NOT synced to the main tree. Fix the step above and re-run.')
	process.exit(1)
}

console.log(`\nSHIP: PASS — ${steps.length} steps in ${((Date.now() - started) / 1000).toFixed(0)}s`)
console.log('AppBundle is green. Sync to the main tree and restart the server:')
console.log('  rsync -a --delete engine/bin-browser/AppBundle/ <main>/engine/bin-browser/AppBundle/')
