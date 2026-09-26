// STEELSEED service worker: cache-first for content-addressed game assets, network-first
// for everything else. Hand-rolled on purpose (rule 4/13: no external code): the whole
// payload is immutable by construction, so returning players pay ~0 bytes for the
// small hashed files. Packs bigger than 8 MB stay on the network: caching them
// fills a phone and the tab dies. Installs with no precache list — the first visit
// warms the cache through normal fetches, so a partial install can never serve a stale shell.
const CACHE = 'steelseed-v2'
/** Phones die when the worker tries to keep the 50 MB art pack in Cache Storage. */
const MAX_CACHED_BYTES = 8 * 1024 * 1024
const IMMUTABLE = /-[A-Za-z0-9_-]{8}\.(gz|wasm|mjs|js|css|json|ssasset|ssmesh|sspbr|bin|data|ktx2|woff2)$/i
const SHELL = /\.(html?|ico|svg|png|webp|avif|m4a|ogg|mp3|wa|ttf)$/i

function remember(cache, request, response) {
	const length = Number(response.headers.get('content-length') || 0)
	if (!response.ok || length <= 0 || length > MAX_CACHED_BYTES) return
	cache.put(request, response.clone()).catch(() => {})
}

self.addEventListener('install', () => {
	// Activate immediately: there is no precache to wait for.
	self.skipWaiting()
})

self.addEventListener('activate', event => {
	event.waitUntil((async () => {
		// Drop caches from other build versions, keep this one warm across deploys.
		// Do not clients.claim(). Claiming the page that just registered this worker
		// makes phones reload, and a quota failure on the next install reloads again.
		const names = await caches.keys()
		await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)))
	})())
})

self.addEventListener('fetch', event => {
	const request = event.request
	if (request.method !== 'GET') return
	const url = new URL(request.url)
	if (url.origin !== self.location.origin) return
	// Range requests (audio/video) and engine streaming must pass through untouched.
	if (request.headers.has('range')) return

	const immutable = IMMUTABLE.test(url.pathname)
	event.respondWith((async () => {
		const cache = await caches.open(CACHE)
		if (immutable) {
			const hit = await cache.match(request)
			if (hit) return hit
			const response = await fetch(request)
			remember(cache, request, response)
			return response
		}
		// Shell and unhashed files: network first, cache as offline fallback.
		try {
			const response = await fetch(request)
			if (SHELL.test(url.pathname)) remember(cache, request, response)
			return response
		} catch {
			const hit = await cache.match(request, { ignoreSearch: true })
			if (hit) return hit
			throw new Error('offline and not cached: ' + url.pathname)
		}
	})())
})
