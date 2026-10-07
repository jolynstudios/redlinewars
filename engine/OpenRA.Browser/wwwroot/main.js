// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

import { dotnet } from './_framework/dotnet.js';
import * as openraAudio from './openra-audio.js';
import * as openraAgentMode from './openra-agent-mode.js';
import * as openraFs from './openra-fs.js';
import * as openraGl from './openra-gl.js';
import * as openraInput from './openra-input.js';
import { createSteelseedBridge, publishSteelseedBridgeReadiness } from './openra-steelseed-bridge.js';

const status = document.getElementById('status');
const log = document.getElementById('log');
const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'rules';
// Published before the first await below. A second module in this document will run
// while dotnet.create() is suspended, so publishing after runtime boot is a race that
// script order cannot win.
const bridgeReadiness = mode === 'game' ? publishSteelseedBridgeReadiness() : null;

function print(line) {
	console.log(line);
	if (log) {
		log.textContent += line + '\n';
	}
}

try {
	const platform = params.get('platform') ?? 'null';
	const argv = [`Host.Mode=${mode}`, `Host.Platform=${platform}`, `Host.BaseUrl=${location.origin}/`];
	for (const [k, v] of params.entries()) {
		if (k !== 'mode' && k !== 'platform' && k !== 'glprobe') {
			argv.push(`${k}=${v}`);
		}
	}

	const canvas = document.getElementById('openra-canvas');
	canvas.hidden = platform !== 'webgl2';

	status.textContent = `Loading .NET runtime (mode=${mode}, platform=${platform})…`;
	const t0 = performance.now();

	const { setModuleImports, getAssemblyExports, getConfig, runMain, localHeapViewU8 } = await dotnet
		.withDiagnosticTracing(false)
		.create();
	setModuleImports('openra-audio', openraAudio);
	setModuleImports('openra-fs', openraFs);
	setModuleImports('openra-gl', openraGl);
	setModuleImports('openra-input', openraInput);
	openraInput.onFirstGesture(openraAudio.unlock);
	// Agent mode is controlled from page-level HTML, so its Start button may be the
	// first trusted gesture without ever touching the canvas. Keep Web Audio resumable
	// from any later gesture too, because browsers may suspend a backgrounded tab.
	const unlockAudio = () => { void openraAudio.unlock(); };
	document.addEventListener('pointerdown', unlockAudio, { capture: true });
	document.addEventListener('keydown', unlockAudio, { capture: true });
	status.textContent = 'Restoring browser storage…';
	await openraFs.preload();

	const t1 = performance.now();
	print(`[js] runtime created in ${Math.round(t1 - t0)}ms`);
	status.textContent = 'Booting engine…';

	const exports = await getAssemblyExports(getConfig().mainAssemblyName);
	print(`[js] export roots: ${Object.keys(exports).join(', ')}`);
	globalThis.__exports = exports;
	const P = exports.OpenRA.Program;
	const exitCode = await runMain(getConfig().mainAssemblyName, argv);
	const t2 = performance.now();
	print(`[js] Main exited ${exitCode} after ${Math.round(t2 - t1)}ms (total ${Math.round(t2 - t0)}ms)`);

	if (mode !== 'game') {
		status.textContent = exitCode === 0 ? 'Rules spike complete ✓' : `Failed (exit ${exitCode})`;
	} else if (exitCode !== 0) {
		bridgeReadiness?.reject(new Error(`Game boot failed (exit ${exitCode})`));
		status.textContent = `Game boot failed (exit ${exitCode})`;
	} else {
		globalThis.ora = P;
		const steelseedBridge = createSteelseedBridge(P, localHeapViewU8);
		globalThis.steelseedBridge = steelseedBridge;
		bridgeReadiness.resolve(steelseedBridge);
		openraAgentMode.initialize(P);
		let frames = 0;
		const flushStorage = () => {
			try {
				// Storage persistence is optional for hosts that share this page pump.
				// A missing diagnostic/persistence export must never stop Frame().
				return typeof P.FlushSupportDir === 'function' ? P.FlushSupportDir() : 0;
			} catch (err) {
				console.error(`[storage] flush failed: ${err}`);
				return -1;
			}
		};
		const tickStats = () => {
			try {
				return typeof P.GetTickStats === 'function' ? P.GetTickStats() : 'tick stats unavailable';
			} catch (err) {
				return `tick stats failed: ${err}`;
			}
		};
		window.addEventListener('pagehide', flushStorage);
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') {
				flushStorage();
			}
		});

		const pump = (ts) => {
			if (!P.Frame(ts)) {
				openraAgentMode.shutdown();
				document.body.classList.remove('game-running');
				status.textContent = 'Frame crashed — see console';
				return;
			}

			frames++;
			openraAgentMode.tick();
			if (frames % 300 === 0) {
				flushStorage();
			}

			if (!P.IsRunning()) {
				openraAgentMode.shutdown();
				flushStorage();
				document.body.classList.remove('game-running');
				status.textContent = 'Game stopped';
				print(`[js] game stopped after ${frames} frames; ${tickStats()}`);
				return;
			}

			if (frames % 300 === 0) {
				const line = `netframe=${P.GetNetFrame()} ${tickStats()}`;
				status.textContent = line;
				print(`[js] ${line}`);
			}

			requestAnimationFrame(pump);
		};

		document.body.classList.add('game-running');
		status.textContent = 'Game running';
		print('[js] pump started; window.ora exposes the available browser-host exports');
		requestAnimationFrame(pump);
	}

	globalThis.__s1_done = { exitCode, runtimeMs: Math.round(t1 - t0), bootMs: Math.round(t2 - t1) };
} catch (err) {
	bridgeReadiness?.reject(err);
	console.error(err);
	document.body.classList.remove('game-running');
	status.textContent = 'Crashed — see console';
	globalThis.__s1_done = { exitCode: -1, error: String(err) };
}
