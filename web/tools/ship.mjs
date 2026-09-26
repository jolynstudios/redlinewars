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
//   3. dotnet publish          — engine wasm (only when C# sources are newer
//                                than the published AppBundle; skipped otherwise)
//   4. compose                 — AppBundle presentation join
//   5. integration-gates       — rules/assets/deployment parity (static)
//   6. ruleparitygate          — rule graph vs canonical OpenRA (static)
//   7. composedgate            — one document boots, starts, presents (browser)
//   8. hudgate                 — economy/production/placement live (browser)
//   9. groundgate              — 3880 ground-contact cases exact (browser)
//  10. motiongate              — movement + orders (browser)
//  11. battleperfgate          — 4-player 60fps combat budget (browser)
//  12. bootcachegate           — LOD cache cold/warm + geometry identical
//  13. rsync to the main tree  — only after everything above is green

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const engineDirty = ['SteelseedEventObserver.cs', 'SnapshotEmitter.cs', 'Program.Bridge.cs']
	.some(f => newer(join(hostRoot, f), join(gameRoot, 'engine/bin-browser/AppBundle/dotnet.native.wasm')))

step('tsc --noEmit', () => run('./node_modules/.bin/tsc', ['--noEmit']))
step('vite build', () => run('./node_modules/.bin/vite', ['build']))
step('dotnet publish (engine)', () => {
	if (!engineDirty) return console.log('  engine unchanged, publish skipped')
	run(dotnet, ['publish', '-c', 'Release'], { cwd: join(hostRoot, 'OpenRA.Browser') })
})
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
