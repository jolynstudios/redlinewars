// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { test, expect } from '@playwright/test';
import { bootGame } from './helpers';

// Desktop-vs-wasm determinism oracle. A fixed-seed replay recorded on desktop
// is played back in the browser: ReplayConnection feeds the recorded orders AND
// the recorded per-frame sync hashes into the local simulation, and IsOutOfSync
// latches if the browser's simulation ever diverges. Both runtimes therefore
// consume one identical order stream — the only variable is the runtime — so a
// clean playback proves per-frame simulation identity.
//
// Requires the host's StartReplay export (Phase 5 product code). Skips cleanly
// until that lands so the rest of the suite is unaffected.
const ORACLE_FRAMES = 200;

function replayProbe(page: any): Promise<string> {
	return page.evaluate(() => (globalThis as any).ora.GetReplayProbe());
}

function netFrame(probe: string): number {
	return Number(/netframe=(\d+)/.exec(probe)?.[1] ?? -1);
}

function outOfSync(probe: string): boolean {
	return /outofsync=[Tt]rue/.test(probe);
}

test('a desktop-recorded replay stays in sync when played back in the browser', async ({ page }, testInfo) => {
	// The oracle proves cross-runtime simulation identity; one runtime is enough
	// and interpreted wasm on firefox/webkit can't play the 200-frame replay
	// within the test budget (chromium ~37s vs firefox >5min). AOT would make it
	// viable cross-engine; until then this is a chromium gate.
	test.skip(testInfo.project.name !== 'chromium', 'determinism oracle is chromium-only on the interpreted dev build (perf)');

	// Boot into the normal launch map; StartReplay disposes it and takes over
	// the world. (Booting mapless would fall back to the Lua shellmap, which
	// has no wasm lua51.)
	const capture = await bootGame(page);

	const hasStartReplay = await page.evaluate(() => typeof (globalThis as any).ora.StartReplay === 'function');
	test.skip(!hasStartReplay, 'host StartReplay export (Phase 5) not present yet');

	const result = await page.evaluate(() => (globalThis as any).ora.StartReplay('/fixtures/determinism-ra.orarep'));
	expect(result).toMatch(/^replaying/);

	// Advance to the frame budget, failing fast the moment a desync latches.
	await expect
		.poll(async () => {
			const probe = await replayProbe(page);
			expect(outOfSync(probe), `desync at ${probe}`).toBe(false);
			return netFrame(probe);
		}, { timeout: 180_000, intervals: [500] })
		.toBeGreaterThanOrEqual(ORACLE_FRAMES);

	expect(outOfSync(await replayProbe(page))).toBe(false);
	expect(capture.pageErrors).toEqual([]);
});
