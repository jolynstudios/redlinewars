// MULTIPLAYER-SERVICE.md §5.1 — the browser multiplayer switch.
// Static file next to the bundle: /steelseed/net-config.json, served with
// cache-control: no-store. Fail closed: missing file, fetch error, 3 s
// timeout, invalid JSON, wrong schema or an unknown switch value all yield
// `off` with a null relay — no request is ever sent to the relay in that
// state (T5.2). The desktop shell never reads this file: inside it
// multiplayer is always on and the relay URL comes from the shell (§5.9),
// so the loader answers `full` there without fetching.

export interface NetConfig {
	relay: string | null
	browserMultiplayer: 'off' | 'join' | 'full'
	/** Absolute account/API origin. Optional for old static configs. */
	accountOrigin?: string
}

const OFF: NetConfig = { relay: null, browserMultiplayer: 'off' }
const TIMEOUT_MS = 3000

// §5.1: `http:` relays are accepted only when the page itself is loopback.
// `location.host` carries the port (`127.0.0.1:5173`), so it is stripped.
function isLoopbackPageHost(host: string): boolean {
	const name = host.split(':')[0] ?? host
	return name === '127.0.0.1' || name === 'localhost'
}

function validRelay(value: unknown, pageHost: string): string | null {
	if (typeof value !== 'string' || value === '') return null
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return null
	}
	if (url.protocol === 'https:') return value
	if (url.protocol === 'http:' && isLoopbackPageHost(pageHost)) return value
	return null
}

function validAccountOrigin(value: unknown, pageHost: string): string | undefined {
	if (typeof value !== 'string' || value === '') return undefined
	try {
		const url = new URL(value)
		if (url.protocol === 'https:') return url.origin
		if (url.protocol === 'http:' && isLoopbackPageHost(pageHost)) return url.origin
	} catch { /* malformed config is ignored */ }
	return undefined
}

// Pure part of the contract: malformed or disallowed input is `off`. A valid
// relay is still surfaced in `off` — §5.1's "no request is ever sent" is a
// UI-behaviour rule (gated on the mode), not a data-hiding rule.
export function parseNetConfig(payload: unknown, pageHost: string): NetConfig {
	if (typeof payload !== 'object' || payload === null) return OFF
	const raw = payload as Record<string, unknown>
	if (raw['schema'] !== 1) return OFF
	const mode = raw['browserMultiplayer']
	if (mode !== 'off' && mode !== 'join' && mode !== 'full') return OFF
	const accountOrigin = validAccountOrigin(raw['accountOrigin'], pageHost)
	const account = accountOrigin ? { accountOrigin } : {}
	if (mode === 'off') return { relay: validRelay(raw['relay'], pageHost), browserMultiplayer: 'off', ...account }
	const relay = validRelay(raw['relay'], pageHost)
	if (relay === null) return OFF
	return { relay, browserMultiplayer: mode, ...account }
}

async function defaultFetchJson(url: string): Promise<unknown> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
	try {
		// no-store mirrors the serving side's cache-control contract (§5.1).
		const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
		if (!res.ok) throw new Error(`net-config ${res.status}`)
		return await res.json()
	} finally {
		clearTimeout(timer)
	}
}

export function loadNetConfig(overrides?: {
	fetchJson?: (url: string) => Promise<unknown>
	shellPresent?: boolean
	pageHost?: string
}): Promise<NetConfig> {
	const shell = overrides?.shellPresent ?? (typeof window !== 'undefined' && 'redline' in window)
	if (shell) return Promise.resolve({ relay: null, browserMultiplayer: 'full' })
	const pageHost = overrides?.pageHost ?? (typeof location !== 'undefined' ? location.host : '')
	const fetchJson = overrides?.fetchJson ?? defaultFetchJson
	return fetchJson('net-config.json').then(
		(payload) => parseNetConfig(payload, pageHost),
		() => OFF,
	)
}
