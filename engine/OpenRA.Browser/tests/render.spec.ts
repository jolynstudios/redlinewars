// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { bootGame, startSkirmish, waitForWorldTick } from './helpers';

test('skirmish renders a live, colorful frame', async ({ page }) => {
	const capture = await bootGame(page);
	await startSkirmish(page, 1);
	await waitForWorldTick(page, 50);

	// The canvas uses preserveDrawingBuffer: false, so the pixels must come
	// from the compositor via an element screenshot (not readPixels).
	const shot = await page.locator('#openra-canvas').screenshot();
	const png = PNG.sync.read(shot);

	const colors = new Set<number>();
	let nonBlack = 0;
	const total = png.width * png.height;
	for (let i = 0; i < png.data.length; i += 4) {
		const r = png.data[i];
		const g = png.data[i + 1];
		const b = png.data[i + 2];
		colors.add((r << 16) | (g << 8) | b);
		if (r + g + b > 24)
			nonBlack++;
	}

	expect(colors.size).toBeGreaterThanOrEqual(64);
	expect(nonBlack / total).toBeGreaterThan(0.5);
	expect(capture.pageErrors).toEqual([]);
});
