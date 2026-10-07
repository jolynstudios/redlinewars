#!/usr/bin/env node
// Publish the same-engine ranked verifier into the RID's standalone node
// runtime. This is a build step (never run by a packager): the node assembler
// copies the resulting directory alongside OpenRA.Server so a volunteer node
// does not need a framework-installed dotnet.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNativeLua } from './native-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, '../..');
const project = path.join(engineRoot, 'steelseed-host', 'RankedReplayVerifier', 'RankedReplayVerifier.csproj');
const allRids = ['osx-arm64', 'osx-x64', 'win-x64', 'linux-x64', 'linux-arm64'];

function dotnet() {
	const candidates = [process.env.DOTNET, path.join(os.homedir(), '.dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'), 'dotnet'];
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
		const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
		if (probe.status === 0) return candidate;
	}
	throw new Error('publish-ranked-verifier: dotnet not found');
}

const argv = process.argv.slice(2);
const requested = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--rid') {
		if (!allRids.includes(argv[++i])) throw new Error(`unknown --rid (expected ${allRids.join(', ')})`);
		requested.push(argv[i]);
	} else if (!argv[i].startsWith('--')) {
		if (!allRids.includes(argv[i])) throw new Error(`unknown rid ${argv[i]} (expected ${allRids.join(', ')})`);
		requested.push(argv[i]);
	}
}
if (requested.length === 0) requested.push(...allRids);

for (const rid of requested) {
	const out = path.join(engineRoot, 'bin-standalone', rid, 'ranked-replay-verifier');
	fs.rmSync(out, { recursive: true, force: true });
	fs.mkdirSync(out, { recursive: true });
	const result = spawnSync(dotnet(), ['publish', project, '-c', 'Release', '-r', rid, `-p:TargetPlatform=${rid}`, '--self-contained', 'true', '-o', out, '-nologo'], { cwd: engineRoot, stdio: 'inherit' });
	if (result.status !== 0) throw new Error(`publish-ranked-verifier: ${rid} failed (${result.status ?? result.error?.message})`);
	const binary = path.join(out, rid.startsWith('win') ? 'Steelseed.RankedReplayVerifier.exe' : 'Steelseed.RankedReplayVerifier');
	if (!fs.existsSync(binary)) throw new Error(`publish-ranked-verifier: missing ${binary}`);
	assertNativeLua(out, rid);
	console.log(`publish-ranked-verifier: ${rid} ready`);
}
