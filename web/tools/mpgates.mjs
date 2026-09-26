// T1.26 — the multiplayer gate aggregate.
//
//   node tools/mpgates.mjs          the browser set: six gates, sequential,
//                                   15 min per gate, one PASS/FAIL line each,
//                                   exit code = number of failures.
//   node tools/mpgates.mjs --node   the node set: `node --test` over
//                                   steelseed-host/tools, then nodegate, then
//                                   discoverygate. Every configured gate must
//                                   exist; a missing script fails the aggregate.
//
// No browser, no GPU: this script only sequences children. Gate output
// streams straight through; this runner adds exactly one line per gate.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webDir, '../..');
const engineTests = path.join(repoRoot, 'engine/OpenRA.Browser/tests');
const engineTools = path.join(repoRoot, 'engine/steelseed-host/tools');

const GATE_TIMEOUT_MS = 15 * 60_000;

// The browser set (MULTIPLAYER-SERVICE.md §Gates). All configured scripts have
// landed; a missing one indicates an incomplete release checkout.
const BROWSER_GATES = [
	['mpgate:twoclient', path.join(engineTests, 'mp-twoclient.mjs'), []],
	['mpgate:lan', path.join(engineTests, 'mp-lan-ui.mjs'), []],
	['mpgate:shroud', path.join(engineTests, 'mp-shroudgate.mjs'), []],
	['mpgate:relay', path.join(engineTests, 'mp-relaygate.mjs'), []],
	['mpgate:lifecycle', path.join(engineTests, 'mp-lifecyclegate.mjs'), []],
	['mpgate:desync', path.join(webDir, 'multiplayer-desyncgate.mjs'), []],
];

// Node 24 runs a directory argument as a single module test, so the runner
// expands the tools-dir glob itself (the documented `node --test tools dir`).
const NODE_TEST_GLOB = fs.readdirSync(engineTools)
	.filter(f => f.endsWith('.test.mjs'))
	.sort()
	.map(f => path.join(engineTools, f));

const NODE_GATES = [
	['node:test tools', null, ['--test', ...NODE_TEST_GLOB]], // bare `node --test` over the tools dir
	['mpgate:node', path.join(engineTools, 'nodegate.mjs'), []],
	['mpgate:discovery', path.join(engineTools, 'discoverygate.mjs'), ['--loopback']],
];

function runGate(name, script, args) {
	return new Promise(resolve => {
		const startedAt = Date.now();
		const argv = script === null ? args : [script, ...args];
		// Own process group so a timed-out gate loses its whole subtree
		// (browser + dedicated + roomhost), not just the entry node.
		const child = spawn(process.execPath, argv, { stdio: 'inherit', detached: process.platform !== 'win32' });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			console.log(`\n[mpgates] ${name} exceeded ${GATE_TIMEOUT_MS / 60_000} min — killing process group`);
			try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
			setTimeout(() => {
				try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
			}, 5000).unref();
		}, GATE_TIMEOUT_MS);

		child.on('exit', (code, signal) => {
			clearTimeout(timer);
			const seconds = Math.round((Date.now() - startedAt) / 1000);
			const failed = timedOut || (code ?? 1) !== 0;
			const why = timedOut ? `timeout ${GATE_TIMEOUT_MS / 60_000} min`
				: code === null ? `signal ${signal}` : `exit ${code}`;
			console.log(`${failed ? 'FAIL' : 'PASS'} ${name} (${seconds}s${failed ? `, ${why}` : ''})`);
			resolve(failed ? 1 : 0);
		});
		child.on('error', err => {
			clearTimeout(timer);
			console.log(`FAIL ${name} (spawn error: ${err.message})`);
			resolve(1);
		});
	});

}
async function runSet(label, gates) {
	console.log(`=== mpgates ${label}: ${gates.length} entries, ${GATE_TIMEOUT_MS / 60_000} min cap each ===`);
	let failures = 0;
	for (const [name, script, args] of gates) {
		if (script === null && args.length <= 1) {
			console.log(`FAIL ${name} (no test scripts found: ${path.relative(repoRoot, engineTools)}/*.test.mjs)`);
			failures += 1;
			continue;
		}
		if (script !== null && !fs.existsSync(script)) {
			console.log(`FAIL ${name} (script missing: ${path.relative(repoRoot, script)})`);
			failures += 1;
			continue;
		}
		failures += await runGate(name, script, args);
	}
	console.log(`=== mpgates ${label}: ${gates.length - failures}/${gates.length} passed, exit ${failures} ===`);
	return failures;
}

const nodeSet = process.argv.includes('--node');
const failures = await runSet(nodeSet ? 'node set' : 'browser set', nodeSet ? NODE_GATES : BROWSER_GATES);
process.exitCode = failures;
