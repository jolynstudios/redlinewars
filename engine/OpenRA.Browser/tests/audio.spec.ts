// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { test, expect } from '@playwright/test';
import { bootGame, canvasPoint } from './helpers';

function audioState(page: any): Promise<string | undefined> {
	return page.evaluate(() => (globalThis as any).openraAudioDebug?.state());
}

test('audio context unlocks from page controls and voices play', async ({ page }) => {
	const capture = await bootGame(page);

	// Autoplay policy: the context must exist and stay suspended before any
	// user gesture reaches the page.
	expect(await audioState(page)).toBe('suspended');

	// Agent mode starts from an HTML control without touching the canvas. A
	// trusted page-level gesture must unlock audio before the match begins.
	await page.click('#debug-toggle');
	await expect.poll(() => audioState(page)).toBe('running');

	// Selecting the MCV triggers a unit acknowledgement voice line.
	const raw = await page.evaluate(t => (globalThis as any).ora.GetOwnedActorScreenPos(t), 'mcv');
	const m = /^(-?\d+),(-?\d+)$/.exec(raw);
	if (!m)
		throw new Error(`no screen position for mcv: ${raw}`);

	const mcv = await canvasPoint(page, Number(m[1]), Number(m[2]));
	const voicesBeforeSelection = await page.evaluate(
		() => (globalThis as any).openraAudioDebug.voicesStarted);
	await page.mouse.click(mcv.x, mcv.y);

	await expect
		.poll(() => page.evaluate(() => (globalThis as any).openraAudioDebug.voicesStarted), { timeout: 30_000 })
		.toBeGreaterThan(voicesBeforeSelection);

	expect(capture.pageErrors).toEqual([]);
});
