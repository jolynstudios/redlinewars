// Dedicated-server runner resolution and the fully pinned Server.* argument
// list (T1.1, T1.2; §5.4). The node spawns the server binary DIRECTLY — no
// shell, no launcher script, no building, no mod generation. A missing
// artefact is a `RunnerMissing` error the callers map to `500 runner-missing`.
//
// Runner (first match wins):
//   1. bin-standalone/<rid>/OpenRA.Server[.exe]   self-contained apphost
//   2. <dotnet> bin/OpenRA.Server.dll             dotnet from PATH, else
//                                                 $HOME/.dotnet/dotnet
// <rid> comes from process.platform-process.arch, mapped to the server
// runtime id (§5.4): darwin-arm64→osx-arm64, darwin-x64→osx-x64,
// win32-x64→win-x64, win32-arm64→win-x64 (Windows on ARM emulates x64),
// linux-x64→linux-x64, linux-arm64→linux-arm64.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RID_MAP = {
	'darwin-arm64': 'osx-arm64',
	'darwin-x64': 'osx-x64',
	'win32-x64': 'win-x64',
	'win32-arm64': 'win-x64',
	'linux-x64': 'linux-x64',
	'linux-arm64': 'linux-arm64',
};

export class RunnerMissing extends Error {
	constructor(detail) {
		super(`runner-missing: ${detail}`);
		this.name = 'RunnerMissing';
		this.detail = detail;
	}
}

export function resolveRid(platform = process.platform, arch = process.arch) {
	const rid = RID_MAP[`${platform}-${arch}`];
	if (!rid) throw new RunnerMissing(`no server runtime id for ${platform}-${arch}`);
	return rid;
}

function findDotnet() {
	const candidates = [];
	if (process.env.PATH) {
		for (const dir of process.env.PATH.split(path.delimiter)) {
			if (!dir) continue;
			candidates.push(path.join(dir, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'));
		}
	}
	candidates.push(path.join(os.homedir(), '.dotnet', 'dotnet'));
	if (process.platform === 'win32') candidates.push(path.join(os.homedir(), '.dotnet', 'dotnet.exe'));
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch { /* try the next candidate */ }
	}
	return null;
}

export function resolveRunner(engineRoot) {
	// Integration fixtures use Node itself as the fake dedicated process.  A
	// shebang script can stand in for the apphost on POSIX, but Windows cannot
	// execute JavaScript renamed to OpenRA.Server.exe.  Keep this escape hatch
	// deliberately narrow: the marker and fixed file name are created only by
	// roomhost-fixture.mjs and are not present in a packaged node.
	if (process.env.REDLINE_NODE_FIXTURE_RUNNER === '1') {
		const fixture = path.join(engineRoot, 'fixture-server.cjs');
		if (fs.existsSync(fixture)) return { cmd: process.execPath, prefixArgs: [fixture] };
	}
	const rid = resolveRid();
	const exe = process.platform === 'win32' ? 'OpenRA.Server.exe' : 'OpenRA.Server';
	const standalone = path.join(engineRoot, 'bin-standalone', rid, exe);
	if (fs.existsSync(standalone)) return { cmd: standalone, prefixArgs: [] };
	const dll = path.join(engineRoot, 'bin', 'OpenRA.Server.dll');
	if (fs.existsSync(dll)) {
		const dotnet = findDotnet();
		if (dotnet) return { cmd: dotnet, prefixArgs: [dll] };
		throw new RunnerMissing('dotnet (PATH or $HOME/.dotnet) for bin/OpenRA.Server.dll');
	}
	throw new RunnerMissing(`bin-standalone/${rid}/OpenRA.Server`);
}

// The exact argument list of §5.4 — nothing more, nothing less. `room`:
// {name, port, map, password, solo, debugSync, ranked}; `paths`: {engineRoot,
// supportDir}. Server.MapPool is pinned to the room's own map: it is what
// stops a crafted client from switching maps in the lobby (T1.2).
export function buildArgs(room, paths) {
	return [
		`Engine.EngineDir=${paths.engineRoot}`,
		`Engine.SupportDir=${paths.supportDir}`,
		'Game.Mod=ra',
		`Server.Name=${room.name}`,
		`Server.ListenPort=${room.port}`,
		`Server.Map=${room.map}`,
		`Server.MapPool=${room.map}`,
		`Server.Password=${room.password ?? ''}`,
		`Server.EnableSingleplayer=${room.solo ? 'True' : 'False'}`,
		'Server.AdvertiseOnline=False',
		'Server.AdvertiseOnLocalNetwork=False',
		'Server.DiscoverNatDevices=False',
		'Server.QueryMapRepository=False',
		'Server.EnableGeoIP=False',
		'Server.ShareAnonymizedIPs=False',
		'Server.EnableLintChecks=False',
		'Server.EnableMapGeneration=False',
		`Server.RecordReplays=${room.ranked ? 'True' : 'False'}`,
		`Server.Ranked=${room.ranked ? 'True' : 'False'}`,
		'Server.EnableVoteKick=False',
		'Server.RequireAuthentication=False',
		`Server.EnableSyncReports=${room.debugSync ? 'True' : 'False'}`,
		'Server.FloodLimitJoinCooldown=5000',
		'Server.FloodLimitInterval=5000',
		'Server.FloodLimitMessageCount=5',
		'Server.FloodLimitCooldown=15000',
	];
}

// T1.6: a tree kill that works everywhere. win32: taskkill /T /F; elsewhere
// the child runs detached (own process group), so a negative pid reaches the
// whole group — SIGTERM first, SIGKILL after 3 s.
export function killTree(child) {
	if (!child || child.pid == null) return;
	if (child.exitCode !== null || child.signalCode !== null) return;
	const pid = child.pid;
	if (process.platform === 'win32') {
		spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
		return;
	}
	try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
	const escalate = setTimeout(() => {
		try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
		try { child.kill('SIGKILL'); } catch { /* already gone */ }
	}, 3000);
	escalate.unref();
}
