// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

// Minimal static server for the published browser bundle and test fixtures.
// Replaces `python3 -m http.server`, which serves .wasm with the MIME type
// required for streaming compilation only on Python >= 3.11.
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function arg(name, fallback) {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '../..');
const rootArg = arg('--root', null);
const root = rootArg
	? path.resolve(process.cwd(), rootArg)
	: path.join(repoRoot, 'bin-browser/AppBundle');
const fixtures = path.join(testsDir, 'fixtures');
// Serve dev content straight from the Support dir rather than relying on a
// bin-browser/AppBundle/devcontent symlink that every wasm rebuild wipes.
const devContent = path.join(repoRoot, 'Support/Content/ra/v2');
const port = Number(arg('--port', '8321'));
// T3.8 (A12, X5): bind loopback by default — the static/game server must
// never listen on all interfaces; `--host` exists for the rare case a
// second machine on the LAN needs to reach a dev copy.
const host = arg('--host', '127.0.0.1');

const mime = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.m4a': 'audio/mp4',
	'.mp3': 'audio/mpeg',
	'.ogg': 'audio/ogg',
	'.wav': 'audio/wav',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.svg': 'image/svg+xml'
};

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);
		let pathname = decodeURIComponent(url.pathname);
		if (pathname.endsWith('/'))
			pathname += 'index.html';

		let base = root;
		if (pathname.startsWith('/fixtures/')) {
			base = fixtures;
			pathname = pathname.slice('/fixtures'.length);
		} else if (pathname.startsWith('/devcontent/')) {
			base = devContent;
			pathname = pathname.slice('/devcontent'.length);
		}

		const file = path.normalize(path.join(base, pathname));
		if (file !== base && !file.startsWith(base + path.sep)) {
			res.writeHead(403, { 'content-type': 'text/plain' });
			res.end('forbidden');
			return;
		}

		// readFile follows symlinks, so the devcontent link into Support/ works.
		const data = await fs.readFile(file);
		// Content-hashed build artifacts (vite chunks, forged packs, portraits) are
		// immutable by construction: caching them for a year removes ~200 MiB of
		// re-downloads from every reload of the browser variant. Everything else —
		// HTML, the host scripts, the wasm runtime, mod files — keeps no-store so a
		// rebuilt AppBundle is picked up on the next load.
		const immutable = /^\/steelseed\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/.test(pathname)
		res.writeHead(200, {
			'content-type': mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
			'content-length': data.length,
			'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store'
		});
		res.end(data);
	} catch (err) {
		const missing = err?.code === 'ENOENT' || err?.code === 'EISDIR';
		res.writeHead(missing ? 404 : 500, { 'content-type': 'text/plain' });
		res.end(String(err?.code ?? err));
	}
});

server.listen(port, host, () => {
	console.log(`[server] serving ${root} (+ /fixtures from ${fixtures}) at http://${host}:${port}/`);
});
