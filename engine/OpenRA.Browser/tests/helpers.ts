// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { Page } from '@playwright/test';

export const BOOT_TIMEOUT = 240_000;

// The RA shellmap is Lua-scripted and lua51 has no wasm build, so booting
// without a direct-launch map crashes the host. Every boot therefore lands
// straight in a real (non-Lua) bundled map via Launch.Map.
export const DEFAULT_MAP = 'Siberian-Pass.oramap';

export interface ConsoleCapture {
	pageErrors: string[];
	consoleErrors: string[];
}

export function captureConsole(page: Page): ConsoleCapture {
	const capture: ConsoleCapture = { pageErrors: [], consoleErrors: [] };
	page.on('pageerror', e => capture.pageErrors.push(String(e)));
	page.on('console', msg => {
		if (msg.type() === 'error')
			capture.consoleErrors.push(msg.text());
	});
	return capture;
}

// The host prints "[host] FATAL" and Main exits non-zero on a boot failure
// (e.g. missing dev content). Surface it immediately instead of waiting out
// the long ora-ready timeout, which otherwise masks the real error.
function watchForFatalBoot(page: Page): { check: () => void } {
	let fatal: string | null = null;
	page.on('console', msg => {
		const text = msg.text();
		if (/\[host\] FATAL|Main exited [1-9]/.test(text))
			fatal ??= text;
	});
	return {
		check: () => {
			if (fatal)
				throw new Error(`host boot failed: ${fatal}`);
		}
	};
}

// Boots the full game (mode=game) on the WebGL2 platform, direct-launching
// DEFAULT_MAP as a solo local game, and waits until that world is ticking.
// Query params beyond mode/platform pass through to the engine as launch
// arguments (see main.js).
export async function bootGame(page: Page, extraParams: Record<string, string> = {}): Promise<ConsoleCapture> {
	const capture = captureConsole(page);
	const params = new URLSearchParams({
		mode: 'game',
		platform: 'webgl2',
		'Host.DevContent': '1',
		'Host.Explored': '1',
		'Launch.Map': DEFAULT_MAP,
		...extraParams
	});

	const fatalWatch = watchForFatalBoot(page);
	await page.goto(`/index.html?${params.toString()}`);
	try {
		await page.waitForFunction(
			() => typeof (globalThis as any).ora !== 'undefined',
			undefined,
			{ timeout: BOOT_TIMEOUT });
	} catch (e) {
		fatalWatch.check();
		throw e;
	}
	await page.waitForFunction(
		() => { try { return (globalThis as any).ora.IsRunning(); } catch { return false; } },
		undefined,
		{ timeout: 60_000 });
	await page.waitForFunction(
		() => { try { return /type=Regular/.test((globalThis as any).ora.GetWorldProbe()); } catch { return false; } },
		undefined,
		{ timeout: 120_000 });
	return capture;
}

export function worldProbe(page: Page): Promise<string> {
	return page.evaluate(() => (globalThis as any).ora.GetWorldProbe());
}

// Starts a fresh skirmish with bots through the in-process server, replacing
// the direct-launched world, and waits for the bot players to exist.
export async function startSkirmish(page: Page, bots = 1): Promise<void> {
	const result = await page.evaluate(b => (globalThis as any).ora.StartSkirmish('', b), bots);
	if (!/^starting /.test(result))
		throw new Error(`StartSkirmish failed: ${result}`);

	await page.waitForFunction(
		() => {
			try {
				const probe = (globalThis as any).ora.GetWorldProbe();
				return /type=Regular/.test(probe) && /\(bot\)/.test(probe);
			} catch { return false; }
		},
		undefined,
		{ timeout: 180_000 });
}

export async function waitForWorldTick(page: Page, minTick: number, timeout = 120_000): Promise<void> {
	await page.waitForFunction(
		t => {
			try {
				const m = /tick=(\d+)/.exec((globalThis as any).ora.GetWorldProbe());
				return m !== null && Number(m[1]) >= t;
			} catch { return false; }
		},
		minTick,
		{ timeout });
}

export async function canvasSize(page: Page): Promise<{ width: number, height: number }> {
	return page.locator('#openra-canvas').evaluate((canvas: HTMLCanvasElement) => ({
		width: canvas.width,
		height: canvas.height
	}));
}

// Maps a point in canvas pixels to page CSS pixels, accounting for the
// CSS-scaled canvas element. The fullscreen port sizes the backbuffer from the
// viewport at boot, so this must not assume the old fixed 1280x720 buffer.
export async function canvasPoint(page: Page, x: number, y: number): Promise<{ x: number, y: number }> {
	const box = await page.locator('#openra-canvas').boundingBox();
	if (!box)
		throw new Error('canvas is not visible');

	const size = await canvasSize(page);
	return { x: box.x + (x / size.width) * box.width, y: box.y + (y / size.height) * box.height };
}
