// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { test, expect, Page } from '@playwright/test';
import { bootGame, waitForWorldTick, canvasPoint, canvasSize } from './helpers';

// One shared game instance: booting the interpreted wasm build is expensive,
// and these interactions build on each other anyway.
test.describe.configure({ mode: 'serial' });

let page: Page;

function selectionProbe(): Promise<string> {
	return page.evaluate(() => (globalThis as any).ora.GetSelectionProbe());
}

function viewportProbe(): Promise<string> {
	return page.evaluate(() => (globalThis as any).ora.GetViewportProbe());
}

function viewportCenter(probe: string): { x: number, y: number } {
	const m = /center=(-?\d+),(-?\d+)/.exec(probe);
	if (!m)
		throw new Error(`bad viewport probe: ${probe}`);
	return { x: Number(m[1]), y: Number(m[2]) };
}

function viewportZoom(probe: string): number {
	const m = /zoom=([\d.]+)/.exec(probe);
	if (!m)
		throw new Error(`bad viewport probe: ${probe}`);
	return Number(m[1]);
}

async function actorCanvasPos(type: string): Promise<{ x: number, y: number }> {
	const raw = await page.evaluate(t => (globalThis as any).ora.GetOwnedActorScreenPos(t), type);
	const m = /^(-?\d+),(-?\d+)$/.exec(raw);
	if (!m)
		throw new Error(`no screen position for ${type}: ${raw}`);
	return { x: Number(m[1]), y: Number(m[2]) };
}

async function clickCanvas(x: number, y: number): Promise<void> {
	const pt = await canvasPoint(page, x, y);
	await page.mouse.click(pt.x, pt.y);
}

test.beforeAll(async ({ browser }) => {
	// The direct-launched solo world keeps the MCV parked and unthreatened,
	// which makes the click/drag coordinates stable.
	page = await browser.newPage();
	await bootGame(page);
	await waitForWorldTick(page, 10);
});

test.afterAll(async () => {
	await page?.close();
});

test('click selects the MCV', async () => {
	const pos = await actorCanvasPos('mcv');
	const size = await canvasSize(page);
	expect(pos.x).toBeGreaterThanOrEqual(0);
	expect(pos.x).toBeLessThan(size.width);
	expect(pos.y).toBeGreaterThanOrEqual(0);
	expect(pos.y).toBeLessThan(size.height);

	await clickCanvas(pos.x, pos.y);
	await expect.poll(selectionProbe).toMatch(/count=[1-9]\d* types=\[.*mcv.*\]/);
});

test('clicking empty ground clears the selection', async () => {
	// A spot near the viewport corner is reliably terrain at game start.
	const size = await canvasSize(page);
	await clickCanvas(40, size.height - 100);
	await expect.poll(selectionProbe).toMatch(/count=0/);
});

test('drag-box selects the MCV', async () => {
	const pos = await actorCanvasPos('mcv');
	const from = await canvasPoint(page, pos.x - 80, pos.y - 80);
	const to = await canvasPoint(page, pos.x + 80, pos.y + 80);

	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();

	await expect.poll(selectionProbe).toMatch(/count=[1-9]\d* types=\[.*mcv.*\]/);
});

test('control groups assign and recall via the keyboard', async () => {
	// Assign the current selection (the MCV) to group 1.
	await page.keyboard.down('Control');
	await page.keyboard.press('Digit1');
	await page.keyboard.up('Control');

	const size = await canvasSize(page);
	await clickCanvas(40, size.height - 100);
	await expect.poll(selectionProbe).toMatch(/count=0/);

	await page.keyboard.press('Digit1');
	await expect.poll(selectionProbe).toMatch(/count=[1-9]\d* types=\[.*mcv.*\]/);
});

test('mouse wheel zooms the viewport', async () => {
	const before = viewportZoom(await viewportProbe());

	const size = await canvasSize(page);
	const center = await canvasPoint(page, size.width / 2, size.height / 2);
	await page.mouse.move(center.x, center.y);
	await page.mouse.wheel(0, -240);

	await expect
		.poll(async () => Math.abs(viewportZoom(await viewportProbe()) - before))
		.toBeGreaterThan(0.001);
});

test('holding the pointer at the canvas edge scrolls the camera', async () => {
	const before = viewportCenter(await viewportProbe());

	const size = await canvasSize(page);
	const edge = await canvasPoint(page, size.width - 3, size.height / 2);
	await page.mouse.move(edge.x, edge.y);

	await expect
		.poll(async () => viewportCenter(await viewportProbe()).x, { timeout: 15_000 })
		.toBeGreaterThan(before.x);
});
