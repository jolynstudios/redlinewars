// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { test, expect } from '@playwright/test';
import { bootGame, worldProbe } from './helpers';

test('engine boots into a running, ticking direct-launched game', async ({ page }) => {
	const capture = await bootGame(page);

	expect(await page.evaluate(() => (globalThis as any).ora.IsRunning())).toBe(true);

	const first = await worldProbe(page);
	expect(first).toMatch(/type=Regular/);
	const firstTick = Number(/tick=(\d+)/.exec(first)![1]);

	await expect
		.poll(async () => Number(/tick=(\d+)/.exec(await worldProbe(page))?.[1] ?? -1), { timeout: 60_000 })
		.toBeGreaterThan(firstTick);

	expect(capture.pageErrors).toEqual([]);
});
