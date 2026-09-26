// Account/API transport for the shared AppBundle.
//
// The game is served from play.redlinewars.online while account sessions live on
// the configured account origin (normally www.redlinewars.online). Keep this
// seam small: it carries the HttpOnly browser cookie with `include`, and never
// exposes a token to the simulation or lockstep bridge.

let accountOrigin: string | null = null

export interface AccountUser {
	id?: string
	callsign?: string
	kind?: 'guest' | 'account'
	avatarUrl?: string | null
	email?: string | null
	emailVerified?: boolean
	rating?: number
	wins?: number
	losses?: number
	lastPlayedAt?: string | number | null
}

export interface AccountStatus {
	authenticated: boolean
	online: boolean
	user?: AccountUser | null
	profile?: { username?: string | null; email?: string | null; emailVerified?: boolean } | null
}

/** The code the player types on the browser approval page, shown in the app meanwhile. */
export interface DeviceChallenge {
	userCode: string
	expiresAt: number
}

interface DesktopAccountBridge {
	accountOrigin?: string
	accountStatus?(): Promise<Omit<AccountStatus, 'online'>>
	accountDeviceLogin?(): Promise<AccountStatus>
	onAccountDeviceChallenge?(callback: (challenge: DeviceChallenge) => void): () => void
	accountAvatarUpload?(request: { bytes: Uint8Array; mime: string; name: string }): Promise<{ user?: AccountUser }>
	accountLogout?(): Promise<{ ok: true }>
	accountRequest?(request: { path: string; method?: string; body?: unknown }): Promise<unknown>
}

function desktopAccountBridge(): DesktopAccountBridge | null {
	const bridge = (globalThis as Record<string, unknown>).redline
	return typeof bridge === 'object' && bridge !== null ? bridge as DesktopAccountBridge : null
}

export function configureAccountOrigin(origin: string | null | undefined): void {
	if (!origin) return
	try { accountOrigin = new URL(origin).origin } catch { /* fail closed to same origin */ }
}

export function accountUrl(path: string): string {
	if (!accountOrigin) return path
	return new URL(path, accountOrigin).toString()
}

/** Resolve server-provided avatar paths without allowing an insecure image URL. */
export function accountAvatarUrl(value: string | null | undefined): string | null {
	if (!value) return null
	try {
		const base = accountOrigin ?? (typeof location !== 'undefined' ? location.origin : '')
		const resolved = new URL(value, base)
		return resolved.protocol === 'https:' ? resolved.toString() : null
	} catch { return null }
}

export async function accountFetch(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(accountUrl(path), {
		...init,
		credentials: 'include',
		headers: {
			accept: 'application/json',
			...init.headers,
		},
	})
}

/**
 * POST that reports the HTTP status instead of throwing, for callers that must tell "saved",
 * "duplicate", "signed out" and "offline" apart. The desktop app goes through its device-token
 * broker, which surfaces failures only as messages; those map back to the status the server
 * sent where the message says so, and to 0 (unknown, retryable) where it does not.
 */
export async function accountSubmit(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
	const bridge = desktopAccountBridge()
	if (bridge?.accountRequest) {
		try {
			return { status: 201, data: await bridge.accountRequest({ path, method: 'POST', body }) }
		} catch (error) {
			const message = String((error as Error)?.message ?? error)
			const coded = /\((\d{3})\)/.exec(message)
			const status = /not signed in/i.test(message) ? 401
				: /already reported/i.test(message) ? 409
				: /outside the desktop allowlist/i.test(message) ? 403
				: coded ? Number(coded[1])
				: 0
			return { status, data: { error: message } }
		}
	}
	try {
		const response = await accountFetch(path, {
			method: 'POST',
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' },
		})
		return { status: response.status, data: await response.json().catch(() => ({})) }
	} catch {
		return { status: 0, data: null }
	}
}

export async function accountJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
	const bridge = desktopAccountBridge()
	if (bridge) {
		if (bridge.accountRequest && path !== '/api/auth/login' && path !== '/api/auth/register' && path !== '/api/auth/guest')
			return await bridge.accountRequest({ path, method: init.method, body: init.body }) as T
		// Passwords and browser-session cookies never cross the packaged app's
		// renderer boundary. Desktop accounts always use the device-code broker.
		throw new Error('Use secure browser sign-in in the desktop app.')
	}
	const response = await accountFetch(path, {
		method: init.method,
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }),
	})
	const data = await response.json().catch(() => ({}))
	if (!response.ok) throw new Error(typeof data?.error === 'string' ? `${data.error} (${response.status})` : `Account request failed (${response.status}).`)
	return data as T
}

export async function accountStatus(): Promise<AccountStatus> {
	const bridge = desktopAccountBridge()
	if (bridge?.accountStatus) {
		try { return { online: true, ...(await bridge.accountStatus()) } }
		catch { return { authenticated: false, online: false } }
	}
	try {
		const session = await accountJson<{ user?: AccountUser | null }>('/api/me')
		if (!session.user) return { authenticated: false, online: true, user: null }
		const result = await accountJson<{ user?: AccountUser | null; profile?: AccountStatus['profile'] }>('/api/me/profile')
		return { authenticated: true, online: true, user: result.user ?? session.user, profile: result.profile ?? null }
	} catch {
		return { authenticated: false, online: false }
	}
}

export async function accountGuest(callsign?: string): Promise<{ user: AccountUser }> {
	return accountJson('/api/auth/guest', { method: 'POST', body: callsign ? { callsign } : {} })
}

export async function accountDeviceLogin(onChallenge?: (challenge: DeviceChallenge) => void): Promise<AccountStatus> {
	const bridge = desktopAccountBridge()
	if (!bridge?.accountDeviceLogin) throw new Error('Use the callsign and password fields to sign in.')
	// Subscribe first: the challenge arrives before the browser page opens.
	const unsubscribe = onChallenge && bridge.onAccountDeviceChallenge ? bridge.onAccountDeviceChallenge(onChallenge) : null
	try { return await bridge.accountDeviceLogin() }
	finally { unsubscribe?.() }
}

export async function accountAvatarUpload(request: { bytes: Uint8Array; mime: string; name: string }): Promise<{ user?: AccountUser }> {
	const bridge = desktopAccountBridge()
	if (!bridge?.accountAvatarUpload) throw new Error('Avatar upload is unavailable in this client.')
	return bridge.accountAvatarUpload(request)
}

export async function accountLogout(): Promise<void> {
	const bridge = desktopAccountBridge()
	if (bridge?.accountLogout) {
		await bridge.accountLogout()
		return
	}
	await accountJson('/api/auth/logout', { method: 'POST', body: {} })
}
