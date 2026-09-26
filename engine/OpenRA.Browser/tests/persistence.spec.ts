// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { test, expect } from '@playwright/test';
import { bootGame, startSkirmish } from './helpers';

// IndexedDB persists across reloads within a single browser context, which is
// exactly the lifetime Playwright gives one test.
test.describe.configure({ mode: 'serial' });

function devcontentRequestCount(page: any): { count: () => number } {
	let count = 0;
	page.on('request', (req: any) => {
		if (req.url().includes('/devcontent/'))
			count++;
	});
	return { count: () => count };
}

test('settings and dev content survive a reload', async ({ page }) => {
	// First load: dev content is fetched over the network and cached to IDB.
	const firstLoad = devcontentRequestCount(page);
	await bootGame(page);
	expect(firstLoad.count()).toBeGreaterThan(0);

	// Change a persisted setting and flush the support dir to IndexedDB.
	const name = 'IDB-Round-Trip';
	const applied = await page.evaluate(n => (globalThis as any).ora.SetPlayerNameProbe(n), name);
	expect(applied).toBe(name);
	await page.evaluate(() => (globalThis as any).ora.FlushSupportDir());

	// Second load in the same context: content is restored from IDB, so the
	// network is not touched, and the setting is intact.
	const secondLoad = devcontentRequestCount(page);
	await bootGame(page);

	expect(await page.evaluate(() => (globalThis as any).ora.GetPlayerNameProbe())).toBe(name);
	expect(secondLoad.count()).toBe(0);

	// IndexedDB actually holds the settings file.
	const keys = await page.evaluate(async () => {
		const db: IDBDatabase = await new Promise((resolve, reject) => {
			const req = indexedDB.open('openra');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		return await new Promise<string[]>((resolve, reject) => {
			const req = db.transaction('files', 'readonly').objectStore('files').getAllKeys();
			req.onsuccess = () => resolve((req.result as string[]).map(String));
			req.onerror = () => reject(req.error);
		});
	});
	expect(keys).toContain('settings.yaml');
});

test('a recorded replay persists to IndexedDB', async ({ page }) => {
	await bootGame(page);
	await startSkirmish(page, 1);

	// Let the recorder write some frames, then flush.
	await page.waitForTimeout(3000);
	await page.evaluate(() => (globalThis as any).ora.FlushSupportDir());

	await expect
		.poll(() => page.evaluate(async () => {
			const db: IDBDatabase = await new Promise((resolve, reject) => {
				const req = indexedDB.open('openra');
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
			const keys: string[] = await new Promise((resolve, reject) => {
				const req = db.transaction('files', 'readonly').objectStore('files').getAllKeys();
				req.onsuccess = () => resolve((req.result as string[]).map(String));
				req.onerror = () => reject(req.error);
			});
			return keys.some(k => k.startsWith('Replays/') && k.endsWith('.orarep'));
		}))
		.toBe(true);
});
