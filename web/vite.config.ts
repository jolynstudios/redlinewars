import { defineConfig, type Connect } from 'vite'

// No account service runs beside `vite dev` or `vite preview`, and the game asks /api/me at
// boot now that accounts are public. Answer the way the production account service answers
// a visitor who is not signed in, so local runs and the browser gates see the same signed-out
// game instead of a 404 in the console (gates that fail on any console error included).
const signedOutAccount: Connect.NextHandleFunction = (req, res, next) => {
	if (req.url !== '/' && !req.url?.startsWith('/?')) return next()
	res.setHeader('content-type', 'application/json')
	res.end('{"user":null}')
}

// web/public/net-config.json is the production switch (public multiplayer, the account origin);
// tools/compose.mjs writes it into the AppBundle. vite dev and preview are local: pointed at the
// production relay and account origin they would only collect CORS errors, so they answer with a
// local config instead: multiplayer off and no account origin (so /api/me stays same-origin).
const localNetConfig: Connect.NextHandleFunction = (req, res, next) => {
	if (req.url !== '/' && !req.url?.startsWith('/?')) return next()
	res.setHeader('content-type', 'application/json')
	res.end('{"schema":1,"browserMultiplayer":"off"}')
}

// STEELSEED — web build.
//
// Hard rule 4: zero runtime dependencies. Nothing from node_modules may end up in the
// bundle; vite/typescript/playwright are dev-only. Rule 13: no binary asset may be
// imported, ever. Both are enforced below rather than trusted, because a stray import
// is the easiest way for either rule to be broken silently.

export default defineConfig({
	root: '.',
	// Relative base: the bundle is served from the same origin as the WASM AppBundle
	// and must work from a subdirectory without rewriting.
	base: './',

	build: {
		target: 'esnext', // WebGPU + top-level await; the WASM host already requires a modern engine
		outDir: 'dist',
		emptyOutDir: true,
		sourcemap: true,
		assetsInlineLimit: 0,
		// Disabled rather than allowlisted. Vite injects `vite/modulepreload-polyfill` into
		// the entry HTML by default, which would put bundler-authored code in the shipped
		// output and trip the rule 4 guard below. Carving an exception into that guard would
		// blunt it; the polyfill is simply unnecessary here, because STEELSEED already
		// requires WebGPU or WebGL2 and every browser meeting that bar supports modulepreload.
		modulePreload: { polyfill: false },
		rollupOptions: {
			output: {
				// One chunk per subsystem keeps a node's cost attributable in the bundle
				// report — a node that suddenly adds 400 KB should be obvious.
				manualChunks(id, { getModuleInfo }) {
					const m = /\/src\/([^/]+)\//.exec(id)
					if (!m) return undefined
					// A module imported from MORE THAN ONE subsystem directory cannot ride a
					// named subsystem chunk: forcing it creates a chunk cycle, and whichever
					// chunk executes second reads the other's bindings before their module
					// record initialises — a top-level TDZ that froze the boot splash in the
					// production bundle only. Shared leaves stay in Rollup's own chunk graph,
					// whose hoisting is cycle-safe; the bundle report keeps every
					// single-subsystem module attributable.
					const info = getModuleInfo(id)
					if (info) {
						const dirs = new Set()
						for (const importer of info.importers) {
							const im = /\/src\/([^/]+)\//.exec(importer)
							if (im) dirs.add(im[1])
						}
						if (dirs.size > 1) return undefined
					}
					return `steelseed-${m[1]}`
				},
			},
		},
	},

	worker: {
		// Procedural generation runs in Web Workers (ARCHITECTURE.md §6) — the WASM sim
		// owns the main thread and must never block on a mesh.
		format: 'es',
	},

	server: {
		headers: {
			// The .NET WASM host is built with WasmEnableThreads=false so these are not
			// strictly required today, but keeping the isolated context matches how the
			// AppBundle is served in production and avoids a class of surprise later.
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
	},

	plugins: [
		{
			name: 'steelseed-hard-rules',
			enforce: 'pre',
			resolveId(source, importer) {
				if (!importer) return null
				// Rule 4 — a bare specifier means an npm package would ship in the bundle.
				const isBare = !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('\0')
				if (isBare && !source.startsWith('virtual:')) {
					throw new Error(
						`STEELSEED rule 4 (zero runtime dependencies): '${importer}' imports the package '${source}'. ` +
							`No npm package ships in the bundle — not three, not gl-matrix. Write it in web/src/core/.`,
					)
				}
				// Rule 13 — zero binary assets, forever.
				if (/\.(png|jpe?g|gif|webp|avif|hdr|exr|ktx2?|basis|mp3|ogg|wav|flac|ttf|otf|woff2?|glb|gltf|bin|dat)$/i.test(source)) {
					throw new Error(
						`STEELSEED rule 13 (zero binary assets): '${importer}' imports '${source}'. ` +
							`Every mesh, texture and sound is generated procedurally from a seed. The repo contains only code.`,
					)
				}
				return null
			},
		},
		{
			name: 'steelseed-signed-out-account',
			configureServer(server) {
				server.middlewares.use('/api/me', signedOutAccount)
				server.middlewares.use('/net-config.json', localNetConfig)
			},
			configurePreviewServer(server) {
				server.middlewares.use('/api/me', signedOutAccount)
				server.middlewares.use('/net-config.json', localNetConfig)
			},
		},
	],
})
