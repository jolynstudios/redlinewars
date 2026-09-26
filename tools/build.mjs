#!/usr/bin/env node
// Redline Wars — build a fresh public checkout.
//
//   node tools/build.mjs [--standalone <rid>[,<rid>…]]
//
// Runs the same steps as the official CI, with the public stand-in art in place of the separately
// licensed art packs:
//
//   1. web/     npm ci
//   2.          node tools/fallback-art.mjs             stand-ins for the art that is not in this repo
//   3. engine/  npm ci
//   4. engine/  dotnet build -c Release                 server, utility, mods, ranked replay verifier
//   5. engine/  node steelseed-host/tools/build-ra-mod.mjs     the generated mod and its simBuild
//   6. engine/  dotnet publish OpenRA.Browser           the WebAssembly engine: engine/bin-browser/AppBundle
//   7. web/     npm run build                           the WebGPU client: web/dist
//   8. web/     node tools/compose.mjs                  the client composed into the AppBundle
//   9. engine/  node tools/publish-standalone.mjs <rid> (with --standalone) the self-contained server
//               that the desktop package and the node zip carry
//
// Needs Node.js 22 or newer and the .NET 8 SDK pinned in global.json with the WebAssembly workload
// (`dotnet workload install wasm-tools`). Set DOTNET to use a dotnet that is not on PATH.
// Packaging never rebuilds game code: desktop/package.mjs and the node packers consume these outputs.

import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DOTNET = process.env.DOTNET || 'dotnet'
const args = process.argv.slice(2)
const standalone = args.includes('--standalone') ? (args[args.indexOf('--standalone') + 1] ?? '').split(',').filter(Boolean) : []

function run(cwd, command, argv) {
	console.log(`\n==> ${cwd}: ${command} ${argv.join(' ')}`)
	const result = spawnSync(command, argv, { cwd: join(ROOT, cwd), stdio: 'inherit', shell: process.platform === 'win32' })
	if (result.status !== 0) {
		console.error(`build: "${command} ${argv.join(' ')}" failed in ${cwd} (${result.status ?? result.error?.code})`)
		process.exit(1)
	}
}

const workloads = spawnSync(DOTNET, ['workload', 'list'], { cwd: ROOT, encoding: 'utf8' })
if (workloads.status !== 0) {
	console.error(`build: cannot run "${DOTNET}" — install the .NET 8 SDK named in global.json, or set DOTNET`)
	process.exit(1)
}
if (!/\bwasm-tools\b/.test(workloads.stdout)) {
	console.error('build: the .NET WebAssembly workload is missing — run: dotnet workload install wasm-tools')
	process.exit(1)
}

run('web', 'npm', ['ci', '--no-audit', '--no-fund'])
run('.', process.execPath, ['tools/fallback-art.mjs'])
run('engine', 'npm', ['ci', '--no-audit', '--no-fund'])
for (const project of ['OpenRA.Server/OpenRA.Server.csproj', 'OpenRA.Utility/OpenRA.Utility.csproj', 'OpenRA.Mods.Cnc/OpenRA.Mods.Cnc.csproj',
	'OpenRA.Mods.Steelseed/OpenRA.Mods.Steelseed.csproj', 'steelseed-host/RankedReplayVerifier/RankedReplayVerifier.csproj'])
	run('engine', DOTNET, ['build', project, '-c', 'Release', '--nologo'])
run('engine', process.execPath, ['steelseed-host/tools/build-ra-mod.mjs'])
run('engine', DOTNET, ['publish', 'steelseed-host/OpenRA.Browser/OpenRA.Browser.csproj', '-c', 'Release', '--nologo'])
run('web', 'npm', ['run', 'build'])
run('web', process.execPath, ['tools/compose.mjs'])
for (const rid of standalone) run('engine', process.execPath, ['tools/publish-standalone.mjs', rid])

console.log(`\nbuild: done. The game: engine/bin-browser/AppBundle (serve it with "node engine/OpenRA.Browser/tests/server.mjs"${standalone.length ? `; standalone servers: ${standalone.join(', ')}` : ''}).`)
