#!/usr/bin/env node
// Compatibility entry point for the authoritative OpenRA RA determinism gate.
// The old implementation depended on the removed generated-map host and a scalar
// GetSyncProbe bridge. Realtime state now crosses only the binary snapshot ABI, so the
// canonical gate lives beside the host and compares two isolated assetless runtimes.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GATE = resolve(WEB_ROOT, '..', 'engine', 'steelseed-host', 'tools', 'simparitygate.mjs')
let tick = '400'
let seed = '104729'

const passthrough = []

for (let index = 0; index < process.argv.length - 2; index++) {
	const value = process.argv[index + 2]
	if (value.startsWith('--ticks=')) tick = value.slice(8)
	else if (value === '--ticks') tick = process.argv[++index + 2]
	else if (value.startsWith('--seed=')) seed = value.slice(7)
	else if (value === '--seed') seed = process.argv[++index + 2]
	// Validation-only invocation: forward so the authoritative gate skips its rebuild.
	else if (value === '--no-build') passthrough.push(value)
	else throw new Error(`synccheck: unsupported argument '${value}'; use --ticks, --seed, --no-build`)
}

const child = spawnSync(process.execPath, [GATE, `--tick=${tick}`, `--seed=${seed}`, ...passthrough], {
	encoding: 'utf8',
	stdio: 'inherit',
})

if (child.error) throw child.error
if (child.status !== 0) process.exit(child.status ?? 1)
console.log('synccheck: PASS — binary ABI determinism delegated to the authoritative host gate')
