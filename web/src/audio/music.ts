/**
 * Soundtrack: "Cold Start" plays on the boot screen and loops through the menus and the
 * lobby. A match opens on one of the other tracks, never on Cold Start, which the loading bar
 * and the lobby have just played; from then on the end of each track moves on to a random one
 * of all five — 1 Theme, 2 Mechanical Groove, 3 Still Standing, 4 Reverse Order, 5 Cold Start —
 * every track once per round, never the same one twice in a row; after the match the menu track
 * returns.
 * (The desktop start menu and the website play song 1, the Theme.) Build-time assets, zero
 * runtime calls.
 *
 * Autoplay: browsers refuse audio before the first user gesture, so unlock()
 * retries from every gesture point the game already has (the loader, the lobby, the
 * Start button, the canvas) until playback really starts. One player serves the whole
 * page (sharedMusic): the loader starts it and the audio node adopts it, so the menu
 * song never restarts between the loading bar and the menus. The user can mute at any
 * time — game menu or M — and volume and mute choice persist across reloads.
 */
// `new URL(asset, import.meta.url)` is Vite's asset form AND a plain file URL under
// the Node harnesses, so the theme resolves without a bundler-specific `?url` import.
const themeUrl = new URL('../../.forge/music/theme.m4a', import.meta.url).href
const grooveUrl = new URL('../../.forge/music/mechanical-groove.m4a', import.meta.url).href
const standingUrl = new URL('../../.forge/music/still-standing.m4a', import.meta.url).href
const reverseUrl = new URL('../../.forge/music/reverse-order.m4a', import.meta.url).href
const coldUrl = new URL('../../.forge/music/cold-start.m4a', import.meta.url).href
/** The soundtrack, numbered as the owner numbers it (1 Theme … 5 Cold Start); shuffled in battle. */
const PLAYLIST = [themeUrl, grooveUrl, standingUrl, reverseUrl, coldUrl] as const
/** The boot screen, menu and lobby track: Cold Start. */
const MENU_TRACK = 4
/** What a track that fails to load falls back to: the theme. */
const FALLBACK_TRACK = 0
import type { MusicApi } from './types'

const MUTE_KEY = 'steelthorn-music'
const VOL_KEY = 'steelthorn-music-vol'
const DEFAULT_VOLUME = 32

export class Music implements MusicApi {
	private audio: HTMLAudioElement | null = null
	private track: number = MENU_TRACK
	/** The battle shuffle: what is left of this round, in play order. */
	private bag: number[] = []
	/** Tracks that failed to load (a forge baseline without them): skipped from then on. */
	private readonly broken = new Set<number>()
	private inMatch = false
	/** True once playback has really started; a refused attempt leaves it false so the next gesture retries. */
	private unlocked = false
	private unlocking: Promise<boolean> | null = null
	private enabled: boolean
	private volume: number

	private static pref(key: string): string | null {
		return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
	}

	private static setPref(key: string, value: string): void {
		if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
	}

	/** Math.random in the game; tests pass their own to pin the shuffle. */
	private readonly random: () => number

	constructor(random: () => number = Math.random) {
		this.random = random
		this.enabled = Music.pref(MUTE_KEY) !== 'off'
		const stored = Number(Music.pref(VOL_KEY))
		this.volume = Number.isFinite(stored) && stored > 0 ? Math.min(100, Math.round(stored)) : DEFAULT_VOLUME
	}

	isEnabled(): boolean {
		return this.enabled
	}

	getVolume(): number {
		return this.volume
	}

	setVolume(volume: number): void {
		this.volume = Math.max(0, Math.min(100, Math.round(volume)))
		Music.setPref(VOL_KEY, String(this.volume))
		this.ensureAudio().volume = this.volume / 100
	}

	setEnabled(on: boolean): void {
		this.enabled = on
		Music.setPref(MUTE_KEY, on ? 'on' : 'off')
		if (on) {
			// The menu buttons must work before the first canvas gesture too: create
			// the element here and let the browser's own gesture grant playback.
			void this.ensureAudio().play().catch(() => { /* stays silent, state is on */ })
			return
		}
		this.audio?.pause()
	}

	/** The UI reports whether a match world is live. Cheap enough to call per snapshot. */
	setInMatch(on: boolean): void {
		if (this.inMatch === on) return
		this.inMatch = on
		// The battle opens on a battle track: the shuffle never repeats the track just played,
		// so the menu's Cold Start cannot be the first one.
		if (on && this.track === this.menuTrack()) this.switchTo(this.nextTrack(this.track))
		this.syncLoop()
	}

	/** Play `track` now; before the player exists it simply opens on it. */
	private switchTo(track: number): void {
		this.track = track
		const audio = this.audio
		if (!audio) return
		audio.src = PLAYLIST[track]
		this.syncLoop()
		if (this.enabled && this.unlocked) void audio.play().catch(() => { /* the next gesture retries via toggle */ })
	}

	private ensureAudio(): HTMLAudioElement {
		if (!this.audio) {
			this.audio = new Audio(PLAYLIST[this.track])
			this.audio.addEventListener('ended', this.onEnded)
			this.audio.addEventListener('error', this.onError)
			this.audio.volume = this.volume / 100
			this.syncLoop()
		}
		return this.audio
	}

	/** The menu track, or the theme when the menu track cannot load. */
	private menuTrack(): number {
		return this.broken.has(MENU_TRACK) ? FALLBACK_TRACK : MENU_TRACK
	}

	/**
	 * The next battle track: a shuffled round of every playable track, refilled when it runs out,
	 * never the one that just played.
	 */
	private nextTrack(from: number): number {
		const playable = PLAYLIST.map((_, i) => i).filter(i => !this.broken.has(i))
		if (playable.length === 0) return FALLBACK_TRACK
		if (playable.length === 1) return playable[0]
		this.bag = this.bag.filter(i => !this.broken.has(i))
		if (this.bag.length === 0) {
			this.bag = playable
			for (let i = this.bag.length - 1; i > 0; i--) {
				const j = Math.floor(this.random() * (i + 1))
				;[this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]]
			}
		}
		if (this.bag[0] === from) this.bag.push(this.bag.shift()!)
		return this.bag.shift()!
	}

	/**
	 * Outside a match the menu track loops natively, which is gapless. In a match the
	 * element must not loop, or `ended` never fires and the playlist never moves on.
	 */
	private syncLoop(): void {
		if (this.audio) this.audio.loop = !this.inMatch && this.track === this.menuTrack()
	}

	private readonly onEnded = (): void => {
		const audio = this.audio
		if (!audio) return
		// A match that ended mid-track returns to the menu track when that track finishes.
		this.track = this.inMatch ? this.nextTrack(this.track) : this.menuTrack()
		audio.src = PLAYLIST[this.track]
		this.syncLoop()
		if (this.enabled) void audio.play().catch(() => { /* the next gesture retries via toggle */ })
	}

	/** A track that fails to load (missing asset, codec) is skipped: the menu falls back to the theme. */
	private readonly onError = (): void => {
		const audio = this.audio
		if (!audio || this.track === FALLBACK_TRACK) return
		this.broken.add(this.track)
		this.track = this.inMatch ? this.nextTrack(this.track) : this.menuTrack()
		audio.src = PLAYLIST[this.track]
		this.syncLoop()
		if (this.enabled) void audio.play().catch(() => { /* the next gesture retries via toggle */ })
	}

	/**
	 * Try to start playback: at boot (autoplay may be allowed) and again from every user
	 * gesture until the browser lets it through. Resolves true once the soundtrack plays.
	 */
	unlock(): Promise<boolean> {
		if (this.unlocked) return Promise.resolve(true)
		if (!this.enabled) return Promise.resolve(false)
		this.unlocking ??= this.ensureAudio().play().then(
			() => { this.unlocked = true; return true },
			() => false, // refused until a gesture: the next call tries again
		).finally(() => { this.unlocking = null })
		return this.unlocking
	}
}

let shared: Music | null = null

/** The page's one soundtrack player: the boot loader starts it, the audio node adopts it. */
export function sharedMusic(): Music {
	shared ??= new Music()
	return shared
}
