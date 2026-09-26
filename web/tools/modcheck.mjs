#!/usr/bin/env node
// STEELSEED — tools/modcheck
// The `mod` node's §0.2 gate, made executable.
//
// §0.2 states the gate as "OpenRA.Utility steelseed --check-yaml clean", and until now no
// command in the graph could run it, so `mod` derived UNGATED and — having no deps — was
// the frontier the entire graph sat behind.
//
// Two things stood in the way, and neither was the check itself:
//
//  1. `dotnet` is not on PATH on this machine; it lives at ~/.dotnet/dotnet.
//     `engine/Makefile:44` hardcodes a bare `DOTNET = dotnet`, and that file is inherited
//     engine under rule 2, so it is not ours to patch. This tool resolves the muxer itself
//     instead, which also makes the gate portable rather than machine-specific.
//
//  2. Exit status alone is not sufficient evidence. OpenRA's utility commands print
//     diagnostics and can still exit 0, and §10.1 rule 2 is explicit that evidence is
//     measured output rather than recomputed intent. So this gate reads the output too,
//     and any error/exception line is red regardless of the exit code.
//
// Usage:
//   node tools/modcheck.mjs [--mod=steelseed] [--dotnet=/path/to/dotnet] [--verbose]

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = 'modcheck'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ENGINE_ROOT = resolve(WEB_ROOT, '..', 'engine')

const flags = new Map()
for (const arg of process.argv.slice(2)) {
	const m = /^--([^=]+)(?:=(.*))?$/.exec(arg)
	if (m) flags.set(m[1], m[2] ?? 'true')
}
const MOD = flags.get('mod') ?? 'steelseed'
const VERBOSE = flags.has('verbose')

/** Lines that mean failure even when the process exits 0. */
const RED_LINE = /\b(error|exception|unhandled|failed|missing|could not|unknown field|invalid)\b/i
/** Compiler noise that is not a mod problem. StyleCop SA0001 fires on every build here. */
const IGNORE_LINE = /^CSC : warning|warning SA\d+|^\s*$|^Testing /i

function resolveDotnet() {
	const explicit = flags.get('dotnet') ?? process.env.DOTNET
	const candidates = [explicit, 'dotnet', join(homedir(), '.dotnet', 'dotnet')].filter(Boolean)
	for (const c of candidates) {
		if (c === 'dotnet') continue // let spawn search PATH; verified below by ENOENT
		try {
			accessSync(c, constants.X_OK)
			return c
		} catch { /* try the next candidate */ }
	}
	return 'dotnet'
}

function run(bin, args, cwd) {
	return new Promise((done) => {
		let out = ''
		const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
		child.stdout.on('data', d => { out += d })
		child.stderr.on('data', d => { out += d })
		child.on('error', err => done({ exit: -1, out: `${out}\nspawn failed: ${err.message}`, spawnFailed: true }))
		child.on('close', exit => done({ exit, out, spawnFailed: false }))
	})
}

const dotnet = resolveDotnet()
console.log(`${TOOL}: mod=${MOD} dotnet=${dotnet}`)

let r = await run(dotnet, ['run', '--project', 'OpenRA.Utility', '--', MOD, '--check-yaml'], ENGINE_ROOT)

// A bare `dotnet` that is not on PATH fails to spawn; retry the known install location once
// so the gate does not go red for a reason that has nothing to do with the mod.
if (r.spawnFailed && dotnet === 'dotnet') {
	const fallback = join(homedir(), '.dotnet', 'dotnet')
	console.log(`${TOOL}: 'dotnet' is not on PATH, retrying ${fallback}`)
	r = await run(fallback, ['run', '--project', 'OpenRA.Utility', '--', MOD, '--check-yaml'], ENGINE_ROOT)
}

if (r.spawnFailed) {
	console.error(`${TOOL}: FAIL — could not run dotnet at all.\n${r.out.trim()}`)
	console.error(`${TOOL}: pass --dotnet=/path/to/dotnet or set DOTNET.`)
	process.exit(2)
}

const lines = r.out.split('\n')
const complaints = lines.filter(l => !IGNORE_LINE.test(l) && RED_LINE.test(l))

if (VERBOSE) console.log(r.out.trim())

if (r.exit !== 0 || complaints.length > 0) {
	console.error(`${TOOL}: FAIL — exit ${r.exit}, ${complaints.length} complaint line(s)`)
	for (const l of complaints.slice(0, 20)) console.error(`  ${l.trim()}`)
	// Exit status and output are reported separately on purpose: a run that exits 0 while
	// printing errors is the more dangerous of the two and must not read as a pass.
	process.exit(1)
}

const tested = lines.filter(l => /^Testing /.test(l)).map(l => l.trim())
console.log(`${TOOL}: PASS — exit 0, no error lines, ${tested.length} check section(s)`)
for (const t of tested) console.log(`  ${t}`)
