// STEELSEED — core/quality
// Which preset to boot with. Three sources, in priority order: the URL (`?quality=`), the
// player's stored choice (the shared Skirmish/Multiplayer lobby switch), and a hardware-picked
// default when nobody chose (owner, 2026-09-25): Classic, the full look, where the GPU rates
// high; Dynamic everywhere else (Classic froze the menu on CI's weak GPU). Detect and Dynamic
// make the same hardware guess; Detect then stays locked. Dynamic and High scale and strip
// cost in play until the frame holds 60 fps.

import { GRAPHICS_CHOICES, QUALITY_NAMES, type GraphicsChoice, type QualityName } from './config'

export const QUALITY_STORAGE_KEY = 'steelseed.quality'
export const MOUNTAINS_STORAGE_KEY = 'steelseed.distantMountains'

export interface QualityDetection {
	readonly tier: QualityName
	/** Lobby/URL choice. Detect and Dynamic resolve `tier` from hardware. */
	readonly choice: GraphicsChoice
	/** Where the choice came from: url, stored, auto, or default when nothing could be read. */
	readonly source: 'url' | 'stored' | 'auto' | 'default'
	/** One line for the console and the lobby: what was seen and why it decided. */
	readonly reason: string
}

export function isQualityName(value: string | null | undefined): value is QualityName {
	return value != null && (QUALITY_NAMES as readonly string[]).includes(value)
}

export function isGraphicsChoice(value: string | null | undefined): value is GraphicsChoice {
	if (value === 'auto') return false
	return value != null && (GRAPHICS_CHOICES as readonly string[]).includes(value)
}

/** The player's explicit stored preference, or null when the hardware-picked default applies. */
export function readStoredQuality(): GraphicsChoice | null {
	try {
		const raw = globalThis.localStorage?.getItem(QUALITY_STORAGE_KEY)
		if (raw === 'auto' || raw === 'detect') return 'detect'
		return isGraphicsChoice(raw) ? raw : null
	} catch {
		return null
	}
}

export function storeQuality(value: GraphicsChoice | 'auto'): boolean {
	try {
		// Detect is no longer represented by a missing key: missing now means the hardware-picked
		// default. Keep an explicit Auto/Detect selection stable across future boots.
		const storage = globalThis.localStorage
		if (!storage) return false
		const stored = value === 'auto' ? 'detect' : value
		storage.setItem(QUALITY_STORAGE_KEY, stored)
		return storage.getItem(QUALITY_STORAGE_KEY) === stored
	} catch {
		return false
	}
}

/**
 * The distant scenery ring is opt-in. It is presentation-only, but its terrain parts
 * participate in every sun-shadow cascade, so an unseen ring must not consume the frame.
 * The URL remains the fallback for browsers or embedded shells that deny localStorage.
 */
export function resolveDistantMountains(params: URLSearchParams): boolean {
	const requested = params.get('mountains')?.toLowerCase()
	if (requested === '1' || requested === 'on' || requested === 'true') return true
	if (requested === '0' || requested === 'off' || requested === 'false') return false
	try { return globalThis.localStorage?.getItem(MOUNTAINS_STORAGE_KEY) === 'on' } catch { return false }
}

export function storeDistantMountains(enabled: boolean): boolean {
	try {
		const storage = globalThis.localStorage
		if (!storage) return false
		const value = enabled ? 'on' : 'off'
		storage.setItem(MOUNTAINS_STORAGE_KEY, value)
		return storage.getItem(MOUNTAINS_STORAGE_KEY) === value
	} catch {
		return false
	}
}

interface AdapterFacts {
	vendor: string
	architecture: string
	device: string
	description: string
	maxBufferMb: number
	maxTextureSize: number
	fallback: boolean
}

async function readAdapter(): Promise<AdapterFacts | null> {
	const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
	if (!gpu) return null
	try {
		const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
		if (!adapter) return null
		// `info` is the current spec; `requestAdapterInfo()` was the earlier form. Both are
		// optional in practice and blank strings are the common case.
		const legacy = adapter as GPUAdapter & { requestAdapterInfo?: () => Promise<GPUAdapterInfo> }
		const info: Partial<GPUAdapterInfo> = adapter.info ?? (legacy.requestAdapterInfo ? await legacy.requestAdapterInfo() : {})
		return {
			vendor: (info.vendor ?? '').toLowerCase(),
			architecture: (info.architecture ?? '').toLowerCase(),
			device: (info.device ?? '').toLowerCase(),
			description: (info.description ?? '').toLowerCase(),
			maxBufferMb: adapter.limits.maxBufferSize / 1048576,
			maxTextureSize: adapter.limits.maxTextureDimension2D,
			fallback: (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter === true,
		}
	} catch {
		return null
	}
}

/**
 * Guess a tier from the hardware. Scores rather than branches, so a machine that is strong
 * on one axis and weak on another lands in the middle instead of at whichever rule ran first.
 */
export async function detectQualityTier(): Promise<QualityDetection> {
	const nav = navigator as Navigator & { deviceMemory?: number }
	const cores = nav.hardwareConcurrency || 4
	const memoryGb = nav.deviceMemory ?? 8
	const dpr = globalThis.devicePixelRatio || 1
	const pixels = (screen?.width ?? 1920) * (screen?.height ?? 1080) * dpr * dpr
	const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent)
	const adapter = await readAdapter()

	let score = 0
	const notes: string[] = []
	if (!adapter) {
		notes.push('no WebGPU adapter')
		score -= 3
	} else {
		const text = `${adapter.vendor} ${adapter.architecture} ${adapter.device} ${adapter.description}`
		notes.push(text.trim() || 'unnamed adapter')
		if (adapter.fallback) { score -= 4; notes.push('software fallback') }
		if (/nvidia|amd|radeon|geforce|rtx/.test(text)) score += 2
		if (/apple|metal-3|m1|m2|m3|m4/.test(text)) score += 2
		if (/intel|uhd|iris|hd graphics/.test(text)) score -= 1
		if (/adreno|mali|powervr/.test(text)) score -= 2
		if (adapter.maxBufferMb >= 2048) score += 1
		if (adapter.maxTextureSize >= 16384) score += 1
	}
	if (cores >= 8) score += 1
	if (cores <= 4) score -= 1
	if (memoryGb >= 16) score += 1
	if (memoryGb <= 4) score -= 2
	// A 4K or DPR-2 display is four times the pixels of 1080p: the same GPU lands a tier lower.
	if (pixels > 3840 * 2160 * 0.9) score -= 1
	if (mobile) score -= 2
	notes.push(`${cores} cores`, `${memoryGb} GB`, `${Math.round(pixels / 1e6)} Mpx`)

	const tier: QualityName = score >= 4 ? 'high' : score >= 1 ? 'medium' : 'low'
	return { tier, choice: 'detect', source: 'auto', reason: `${notes.join(', ')} → score ${score}` }
}

async function fromHardware(choice: 'detect' | 'dynamic', source: QualityDetection['source'], why: string): Promise<QualityDetection> {
	const detected = await detectQualityTier()
	return { ...detected, choice, source, reason: `${why}; ${detected.reason}` }
}

/** Nobody chose: Classic where the GPU carries it, Dynamic everywhere else. */
export function defaultChoiceFor(tier: QualityName): 'classic' | 'dynamic' {
	return tier === 'high' ? 'classic' : 'dynamic'
}

/** Resolve the boot tier from URL, stored choice and hardware, in that order. */
export async function resolveQuality(params: URLSearchParams): Promise<QualityDetection> {
	const fromUrl = params.get('quality')
	if (fromUrl === 'auto' || fromUrl === 'detect')
		return fromHardware('detect', 'url', '?quality=detect')
	if (fromUrl === 'dynamic')
		return fromHardware('dynamic', 'url', '?quality=dynamic')
	if (isQualityName(fromUrl))
		return { tier: fromUrl, choice: fromUrl, source: 'url', reason: '?quality= on the URL' }
	const stored = readStoredQuality()
	if (stored === 'detect')
		return fromHardware('detect', 'stored', 'chosen Auto in the game lobby')
	if (stored === 'dynamic')
		return fromHardware('dynamic', 'stored', 'chosen Dynamic in the game lobby')
	if (stored && isQualityName(stored))
		return { tier: stored, choice: stored, source: 'stored', reason: 'chosen in the game lobby' }
	try {
		const detected = await detectQualityTier()
		if (defaultChoiceFor(detected.tier) === 'classic')
			return { tier: 'classic', choice: 'classic', source: 'default', reason: `Classic: strong GPU; ${detected.reason}` }
		return { ...detected, choice: 'dynamic', source: 'default', reason: `Dynamic: Classic needs a strong GPU; ${detected.reason}` }
	} catch (error) {
		return { tier: 'medium', choice: 'dynamic', source: 'default', reason: `Dynamic detection failed: ${String(error)}` }
	}
}
