// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { defineConfig } from '@playwright/test';

// The wasm build runs interpreted (no AOT), so boot takes tens of seconds
// and a single worker keeps the heavyweight game instances sequential.
export default defineConfig({
	testDir: '.',
	timeout: 300_000,
	expect: { timeout: 30_000 },
	workers: 1,
	fullyParallel: false,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: 'http://127.0.0.1:8321',
		trace: 'retain-on-failure',
		viewport: { width: 1500, height: 900 }
	},
	webServer: {
		command: 'node server.mjs',
		url: 'http://127.0.0.1:8321/index.html',
		reuseExistingServer: true,
		timeout: 30_000
	},
	projects: [
		{
			name: 'chromium',
			use: {
				browserName: 'chromium',
				// The game loop is driven by requestAnimationFrame, which Chromium
				// throttles in backgrounded pages. Multi-client tests keep several
				// pages alive at once, so disable the throttling that would otherwise
				// starve a non-focused client's tick loop (and its handshake pump).
				launchOptions: {
					args: [
						'--disable-background-timer-throttling',
						'--disable-backgrounding-occluded-windows',
						'--disable-renderer-backgrounding'
					]
				}
			}
		},
		{ name: 'firefox', use: { browserName: 'firefox' } },
		{ name: 'webkit', use: { browserName: 'webkit' } }
	]
});
