// P10/P11 gate: boots the game with NO Launch.Map (the "original game start"),
// which loads the main menu on the browser-only Lua-free shellmap. The upstream
// desert-shellmap attaches LuaScript and would crash with DllNotFoundException:
// lua51 (the same path quit-to-menu takes), so a successful menu boot proves the
// swap. Also asserts the P11 fullscreen canvas sizing and the Debug toggle.
// Usage: node p10-menu-boot.mjs
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const httpPort = 8377;
const BOOT = `http://127.0.0.1:${httpPort}/index.html?mode=game&platform=webgl2&Host.DevContent=1`;

const server = spawn('node', [path.join(testsDir, 'server.mjs'), '--port', String(httpPort)], { stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1000));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fatals = [];
page.on('pageerror', e => fatals.push(String(e)));
page.on('console', m => {
	const text = m.text();
	if (/FATAL|Frame crashed|lua51/i.test(text)) fatals.push(text);
	if (/\[host\]|FATAL/.test(text)) console.log(`[console] ${text}`);
});

try {
	await page.goto(BOOT);
	await page.waitForFunction(() => typeof globalThis.ora !== 'undefined', undefined, { timeout: 240_000 });
	await page.waitForFunction(() => { try { return globalThis.ora.IsRunning(); } catch { return false; } }, undefined, { timeout: 60_000 });

	// Let the shellmap/menu settle; the boot-time LoadShellMap is the code path
	// that previously crashed.
	await new Promise(r => setTimeout(r, 8000));
	if (fatals.length > 0) throw new Error(`fatal output during menu boot: ${fatals.join(' | ')}`);

	const layout = await page.evaluate(() => {
		const canvas = document.getElementById('openra-canvas');
		return {
			buffer: [canvas.width, canvas.height],
			css: [canvas.clientWidth, canvas.clientHeight],
			running: document.body.classList.contains('game-running'),
			statusVisible: document.getElementById('status').offsetParent !== null
		};
	});
	console.log(`layout: ${JSON.stringify(layout)}`);
	if (layout.buffer[0] !== 1440 || layout.buffer[1] !== 900)
		throw new Error(`canvas buffer is not viewport-sized: ${layout.buffer}`);
	if (!layout.running || layout.statusVisible)
		throw new Error('game-running banner state is wrong');

	const hiddenBefore = await page.evaluate(() => document.getElementById('debug-panel').hidden);
	await page.click('#debug-toggle');
	const hiddenOpen = await page.evaluate(() => document.getElementById('debug-panel').hidden);
	await page.click('#debug-toggle');
	const hiddenAfter = await page.evaluate(() => document.getElementById('debug-panel').hidden);
	if (!(hiddenBefore === true && hiddenOpen === false && hiddenAfter === true))
		throw new Error(`debug toggle sequence wrong: ${hiddenBefore},${hiddenOpen},${hiddenAfter}`);
	console.log('debug toggle OK');

	// The menu world (shellmap) must actually simulate.
	const netFrame1 = await page.evaluate(() => globalThis.ora.GetNetFrame());
	await new Promise(r => setTimeout(r, 3000));
	const netFrame2 = await page.evaluate(() => globalThis.ora.GetNetFrame());
	console.log(`netframe ${netFrame1} -> ${netFrame2}`);
	if (netFrame2 <= netFrame1) throw new Error('menu world is not ticking');

	// A fresh browser profile opens the first-run profile dialog over the menu.
	// Accept its defaults so the clicks below reach the actual main-menu widgets.
	await page.mouse.click(970, 688);
	await new Promise(r => setTimeout(r, 500));
	await page.mouse.click(920, 633);
	await new Promise(r => setTimeout(r, 500));

	// Exercise the human-facing path, not the host-only StartSkirmish probe:
	// Main menu -> Singleplayer -> Skirmish lobby -> Back. These coordinates
	// are derived from mods/common/chrome/mainmenu.yaml and lobby.yaml for the
	// fixed 1440x900 gate viewport.
	await page.mouse.click(242, 365);
	await new Promise(r => setTimeout(r, 250));
	await page.mouse.click(242, 365);
	await new Promise(r => setTimeout(r, 3000));
	if (fatals.length > 0) throw new Error(`fatal output opening Skirmish lobby: ${fatals.join(' | ')}`);
	const lobbyProbe = await page.evaluate(() => globalThis.ora.GetConnectionProbe());
	if (!/clients=[2-9]\d*.*started=False/.test(lobbyProbe))
		throw new Error(`graphical Skirmish lobby did not connect: ${lobbyProbe}`);
	console.log(`graphical Skirmish lobby opened: ${lobbyProbe}`);

	await page.mouse.click(1090, 718);
	await new Promise(r => setTimeout(r, 3000));
	if (fatals.length > 0) throw new Error(`fatal output leaving Skirmish lobby: ${fatals.join(' | ')}`);
	const menuProbe = await page.evaluate(() => globalThis.ora.GetConnectionProbe());
	if (!/state=local.*started=False/.test(menuProbe))
		throw new Error(`leaving Skirmish lobby did not return to the local menu connection: ${menuProbe}`);
	console.log('graphical Skirmish lobby back path OK');

	await page.screenshot({ path: path.join(testsDir, 'p10-menu-boot.png') });
	console.log('=== P10/P11 MENU BOOT: PASS ===');
} finally {
	await browser.close();
	server.kill();
}
