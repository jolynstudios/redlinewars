// STEELSEED — audio/types
// Structural mirrors of the one interface this node consumes, narrowed to what it calls.
//
// Rule 3: a node may not import another subsystem's module. `camera` is reached through
// `ctx.peek()`, and TypeScript still needs a shape for what that returns — this declaration
// is it. Narrowed rather than copied whole, for the same reason `units/types.ts` and
// `ui/types.ts` are: a member declared here that nothing calls can drift from the real
// contract without anything failing.
//
// NOTE WHAT IS ABSENT: there is no `RenderApi` here, and there must never be one. §14.8 ruled
// that the renderer never imports audio and audio never imports the renderer, and the listener
// pose is published by `camera` precisely so this node never has to ask the renderer where the
// ear is. A `render` entry appearing in this file is the split eroding.

/**
 * §14.8's listener seam: a pose. The clock is `ctx.time`; the occlusion query is the third
 * member and is not built yet, because no voice in the bank needs it.
 */
export interface ListenerApi {
	/** Camera position in render-space metres. Live reference to preallocated storage. */
	readonly listenerEye: Readonly<Float32Array>
	/** The point the camera is looking at. Together with the eye this gives a facing. */
	readonly listenerFocus: Readonly<Float32Array>
}

/**
 * §14.8's third seam member — the occlusion query — arriving in the only form this game needs
 * it: can the local player see the cell a sound is coming from.
 *
 * §14.8 specified it as "a callback the SDK supplies, so audio can ask 'is this source
 * occluded' without being given scene knowledge — which is exactly the coupling that would
 * otherwise pull geometry into the audio package". A cell visibility test is that: a yes/no
 * about one point, carrying no geometry and no scene.
 *
 * §4.7 makes it necessary rather than decorative. An unfiltered battle is AUDIBLE THROUGH THE
 * FOG, and hearing an enemy column you cannot see is a bigger intelligence leak than seeing
 * it would be, because there is no counterplay to it. Missing visibility fails CLOSED;
 * `unmodelled` remains available only as a contract diagnostic.
 */
export interface ShroudApi {
	readonly unmodelled: boolean
	isVisible(cellX: number, cellY: number): boolean
}

/** Runtime-only sky seam. No rendering state or weather implementation is imported. */
export interface WeatherApi {
	readonly rainIntensity: number
	readonly snowIntensity: number
	readonly motionTime: number
	readonly lightningStrike: {
		readonly id: number
		readonly time: number
		readonly thunderTime: number
		readonly strength: number
		readonly pan: number
	} | null
}

/**
 * The announcer seam the UI speaks through. Rule 3: the UI may not import the
 * Eva class — the audio node owns the instance and the UI reaches it through
 * `ctx.get('audio')`, typed by these structural mirrors.
 */
export interface EvaApi {
	/** Arm speaking; must run inside a user-gesture call stack. */
	unlock(): void
	/** One announcer line; `tick` dedupes to one line per tick. */
	say(text: string, tick?: number, bankOverride?: string): void
	/** Unit acknowledgement: kind selects the table, `persona` a character voice. */
	sayUnit(kind: 'select' | 'move' | 'attack' | 'underAttack', cls: number, persona?: string): void
	/** Persona for an actor type name; undefined keeps the generic pool. */
	personaOf(actorName: string): 'tanya' | 'spy' | 'jackson' | undefined
	/** Announcer and unit acks follow the player's own faction. */
	setFactionFamily(factionId: string): void
	/** Match boundary: per-match edge triggers reset. */
	reset(): void
}

/** Soundtrack seam: enable/volume state the UI's menu buttons drive. */
export interface MusicApi {
	unlock(): void
	isEnabled(): boolean
	getVolume(): number
	setVolume(volume: number): void
	setEnabled(on: boolean): void
	/** True while a match world is live; the soundtrack only rotates tracks in a match. */
	setInMatch?(on: boolean): void
}

/**
 * The fixed interface cue set (`ui-sound.ts`). The more often a cue plays, the quieter it is:
 * `focus` is the quietest, and `launch` (START) is the only loud one.
 */
export type UiCue =
	| 'focus' | 'select' | 'toggleOn' | 'toggleOff' | 'step'
	| 'open' | 'close' | 'confirm' | 'error' | 'launch'

/**
 * Interface-sound seam: its own bus beside the world mix, with its own on/off and volume.
 * Every call is safe without Web Audio, before a gesture, and after the node is disposed.
 */
export interface UiSoundApi {
	/** Arm the bus: renders the cues once and resumes the shared context. Call it inside a user gesture. */
	unlock(): void
	/**
	 * Play one cue. It is dropped while disabled, and repeats of the same cue within 65 ms are dropped.
	 * `focus` is for keyboard or gamepad focus moves only, never pointer hover.
	 * `variant` for `step` is the pitch index, 0 (lowest) to 7 (highest), so map the stepper's value onto it.
	 * For `focus` it is 0 to 3. Omit it and the bus rotates the variants, so no two in a row match.
	 */
	cue(name: UiCue, variant?: number): void
	isEnabled(): boolean
	setEnabled(on: boolean): void
	/** Linear gain on the UI bus, 0..1. */
	getVolume(): number
	setVolume(volume: number): void
}
