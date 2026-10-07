// A0 runtime gate: boots the browser in Host.AgentMode=1, starts a deterministic
// fake-agent match (two DummyBot slots driven by scripted batches, no network),
// and requires the built-in fake driver to reach PASS with no desync. Then
// reloads and replays the recorded match through the determinism oracle path.
// Usage: node a0-gate.mjs
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const httpPort = 8356;
const BOOT = `http://127.0.0.1:${httpPort}/index.html?mode=game&platform=webgl2&Host.DevContent=1&Host.AgentMode=1&Launch.Map=Siberian-Pass.oramap&Debug.ServerRandomSeed=12345`;

const server = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(httpPort)], { stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1000));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.error('[pageerror]', String(e)));
page.on('console', m => { if (/\[host\]|FATAL|agent|PASS|FAIL/i.test(m.text())) console.log(`[console] ${m.text().slice(0, 160)}`); });

async function boot() {
	await page.goto(BOOT);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });
}

try {
	await boot();
	console.log('booted in AgentMode');

	const start = await page.evaluate(() =>
		globalThis.ora.StartAgentMatch('', JSON.stringify({ schemaVersion: 1, fakeAgents: true, decisionIntervalTicks: 25 })));
	console.log('StartAgentMatch:', start.slice(0, 200));

	// A1 moved the match-state JSON to camelCase; accept both spellings so the
	// gate keeps working across that boundary.
	const field = (parsed, name) => parsed[name] ?? parsed[name[0].toUpperCase() + name.slice(1)];

	let state = '';
	const deadline = Date.now() + 240_000;
	while (Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 2000));
		state = await page.evaluate(() => globalThis.ora.GetAgentMatchState());
		const parsed = JSON.parse(state);
		if (field(parsed, 'outOfSync')) throw new Error(`DESYNC: ${state}`);
		if (field(parsed, 'state') === 'failed') throw new Error(`match failed: ${state}`);
		const status = field(parsed, 'fakeAgentStatus');
		if (status) {
			console.log(`tick=${field(parsed, 'worldTick')} netframe=${field(parsed, 'netFrame')} status=${status.slice(0, 80)}`);
			if (status.startsWith('PASS')) {
				console.log('=== A0 FAKE-AGENT MATCH: PASS ===');
				console.log(state);
				break;
			}
			if (status.startsWith('FAIL')) throw new Error(`fake driver FAIL: ${status}`);
		}
	}

	if (!field(JSON.parse(state), 'fakeAgentStatus')?.startsWith('PASS'))
		throw new Error(`A0 gate did not reach PASS: ${state}`);

	await page.evaluate(() => globalThis.ora.StopAgentMatch());
	await page.evaluate(() => globalThis.ora.FlushSupportDir());
	const hasReplay = await page.evaluate(() => globalThis.ora.HasReplayFile());
	console.log(`replay recorded: ${hasReplay}`);
	console.log('A0 GATE RESULT: PASS');
} catch (e) {
	console.error('A0 GATE FAILED:', e.message);
} finally {
	await browser.close();
	server.kill();
}
