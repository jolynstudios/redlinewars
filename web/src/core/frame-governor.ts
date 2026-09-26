// STEELSEED — core/frame-governor
// Pure pacing policy for Dynamic graphics. Kept separate from App so the cases that
// matter most (slow but perfectly regular frame streams) are unit-testable without a GPU.

/** Do not mistake a stable frame rate below 30 Hz for the display refresh rate. */
export const MAX_INFERRED_DISPLAY_MS = 1000 / 30
export const GOVERNOR_WINDOW_MS = 2000
export const MIN_GOVERNOR_SAMPLES = 8

export function isUsableFrameSample(frameMs: number): boolean {
	return Number.isFinite(frameMs) && frameMs > 0
}

export function shouldAssessFrameWindow(sampleCount: number, elapsedMs: number, capacity: number): boolean {
	return sampleCount >= MIN_GOVERNOR_SAMPLES
		&& (sampleCount >= capacity || elapsedMs >= GOVERNOR_WINDOW_MS)
}

export interface FrameGovernorAssessment {
	readonly ceilingMs: number
	readonly displayPaced: boolean
	readonly overBudget: boolean
	readonly severe: boolean
}

export function assessFramePacing(p10Ms: number, p50Ms: number, configuredCeilingMs: number): FrameGovernorAssessment {
	const inferredDisplayMs = Math.min(p10Ms, MAX_INFERRED_DISPLAY_MS)
	const ceilingMs = Math.max(configuredCeilingMs, inferredDisplayMs * 1.5)
	const overBudget = p50Ms > ceilingMs
	return {
		ceilingMs,
		// 24 Hz and slower streams are intentionally not called display-paced: Dynamic
		// must never restore quality while the game is visibly below its 30 fps floor.
		displayPaced: p10Ms <= MAX_INFERRED_DISPLAY_MS && p50Ms <= inferredDisplayMs * 1.25,
		overBudget,
		// A catastrophic miss should not wait for a second sampling window. This matters
		// at 10 fps, where a frame-count-only window used to take twelve seconds.
		severe: overBudget && p50Ms > ceilingMs * 1.75,
	}
}

/**
 * High and Dynamic lock. A 60 Hz cadence is ~16.7 ms. Anything slower is over budget,
 * including a perfectly flat 30 Hz stream — that used to be read as the display refresh
 * and the governor then refused to shed. p90 catches a minority of missed vblanks whose
 * median is still 16.7 ms.
 */
export const LOCK60_P50_MS = 18
export const LOCK60_P90_MS = 22
/** Restoration needs real headroom, not merely a barely held 60 Hz cadence. */
export const RESTORE_P50_MS = 11
export const RESTORE_P90_MS = 14
export const RESTORE_COOLDOWN_WINDOWS = 10
const MIN_DISPLAY_MS = 1000 / 240
const MAX_DISPLAY_MS = 1000 / 60

export function assessLocked60(p10Ms: number, p50Ms: number, p90Ms: number): FrameGovernorAssessment {
	const overBudget = p50Ms > LOCK60_P50_MS || p90Ms > LOCK60_P90_MS
	const holding = p50Ms <= LOCK60_P50_MS && p90Ms <= LOCK60_P90_MS && p10Ms <= LOCK60_P90_MS
	return {
		ceilingMs: LOCK60_P50_MS,
		displayPaced: holding,
		overBudget,
		severe: p50Ms > 28,
	}
}

export interface PacePreset {
	readonly scale: number
	readonly contact: boolean
	readonly cascades: number
	readonly wind: boolean
	readonly weather: boolean
	readonly near: boolean
	readonly scaleOnly: boolean
	readonly floor: number
}

export interface PaceLive {
	scale: number
	contact: boolean
	cascades: number
	sceneryStep: number
	wind: boolean
	weather: boolean
	near: boolean
}

export interface PaceMachine {
	live: PaceLive
	over: number
	headroom: number
	restoreCooldown: number
	/** Fastest observed rAF cadence; a 120 Hz display needs a light window to teach 8.3 ms. */
	displayMs: number
}

export type PaceAction =
	| { kind: 'scale'; scale: number }
	| { kind: 'contact'; on: boolean }
	| { kind: 'cascades'; cascades: number }
	| { kind: 'scenery'; step: number }
	| { kind: 'wind'; on: boolean }
	| { kind: 'weather'; on: boolean }
	| { kind: 'near'; on: boolean }

export function createPaceMachine(preset: PacePreset): PaceMachine {
	return {
		live: {
			scale: preset.scale,
			contact: preset.contact,
			cascades: preset.cascades,
			sceneryStep: 1,
			wind: preset.wind,
			weather: preset.weather,
			near: preset.near,
		},
		over: 0,
		headroom: 0,
		restoreCooldown: 0,
		displayMs: MAX_DISPLAY_MS,
	}
}

function shedOnce(live: PaceLive, preset: PacePreset): PaceAction | null {
	if (live.scale > preset.floor + 0.01) {
		live.scale = Math.max(preset.floor, live.scale * 0.85)
		return { kind: 'scale', scale: live.scale }
	}
	if (preset.scaleOnly) return null
	if (live.contact && preset.contact) {
		live.contact = false
		return { kind: 'contact', on: false }
	}
	if (live.cascades > 1) {
		live.cascades -= 1
		return { kind: 'cascades', cascades: live.cascades }
	}
	if (live.wind) {
		live.wind = false
		return { kind: 'wind', on: false }
	}
	if (live.weather) {
		live.weather = false
		return { kind: 'weather', on: false }
	}
	if (live.near) {
		live.near = false
		return { kind: 'near', on: false }
	}
	if (live.sceneryStep < 4) {
		live.sceneryStep = live.sceneryStep < 2 ? 2 : 4
		return { kind: 'scenery', step: live.sceneryStep }
	}
	return null
}

function canRestore(live: PaceLive, preset: PacePreset): boolean {
	return live.sceneryStep > 1
		|| (!live.near && preset.near)
		|| (!live.weather && preset.weather)
		|| (!live.wind && preset.wind)
		|| live.cascades < preset.cascades
		|| (!live.contact && preset.contact)
		|| live.scale < preset.scale - 0.001
}

function restoreOnce(live: PaceLive, preset: PacePreset): PaceAction | null {
	if (live.sceneryStep > 1) {
		live.sceneryStep = live.sceneryStep > 2 ? 2 : 1
		return { kind: 'scenery', step: live.sceneryStep }
	}
	if (!live.near && preset.near) {
		live.near = true
		return { kind: 'near', on: true }
	}
	if (!live.weather && preset.weather) {
		live.weather = true
		return { kind: 'weather', on: true }
	}
	if (!live.wind && preset.wind) {
		live.wind = true
		return { kind: 'wind', on: true }
	}
	if (live.cascades < preset.cascades) {
		live.cascades += 1
		return { kind: 'cascades', cascades: live.cascades }
	}
	if (!live.contact && preset.contact) {
		live.contact = true
		return { kind: 'contact', on: true }
	}
	if (live.scale < preset.scale) {
		live.scale = Math.min(preset.scale, live.scale / 0.85)
		return { kind: 'scale', scale: live.scale }
	}
	return null
}

/**
 * One sample window of the shipped 60 fps lock, starting from `machine` as the caller left it.
 * Two ordinary over-budget windows shed one step (a severe window sheds three at once).
 * Ten windows after a shed must pass before five consecutive windows with real
 * headroom can restore a step. Grass meshes absent from the preset stay absent.
 */
export function notePaceWindow(machine: PaceMachine, preset: PacePreset, p10Ms: number, p50Ms: number, p90Ms: number): PaceAction[] {
	if (Number.isFinite(p10Ms) && p10Ms > 0)
		machine.displayMs = Math.min(machine.displayMs, Math.max(MIN_DISPLAY_MS, Math.min(MAX_DISPLAY_MS, p10Ms)))
	const pacing = assessLocked60(p10Ms, p50Ms, p90Ms)
	const cooling = machine.restoreCooldown > 0
	if (cooling) machine.restoreCooldown--
	if (pacing.overBudget) {
		if (++machine.over < (pacing.severe ? 1 : 2)) {
			machine.headroom = 0
			return []
		}
		machine.over = 0
		machine.headroom = 0
		const actions: PaceAction[] = []
		const steps = pacing.severe ? 3 : 1
		for (let i = 0; i < steps; i++) {
			const step = shedOnce(machine.live, preset)
			if (!step) break
			actions.push(step)
		}
		if (actions.length > 0) machine.restoreCooldown = RESTORE_COOLDOWN_WINDOWS
		return actions
	}
	machine.over = 0
	// A 60 Hz rAF cannot reveal spare GPU/CPU time below its 16.7 ms vsync
	// interval. The cooldown limits possible oscillation until intrinsic work
	// timing is available; a learned 120/144 Hz cadence applies stricter limits.
	const restoreP50Ms = Math.max(RESTORE_P50_MS, machine.displayMs * 1.1)
	const restoreP90Ms = Math.max(RESTORE_P90_MS, machine.displayMs * 1.25)
	if (cooling || !pacing.displayPaced || p50Ms > restoreP50Ms || p90Ms > restoreP90Ms) {
		machine.headroom = 0
		return []
	}
	const restoring = canRestore(machine.live, preset)
	if (!restoring) {
		machine.headroom = 0
		return []
	}
	if (++machine.headroom < 5) return []
	machine.headroom = 0
	const step = restoreOnce(machine.live, preset)
	return step ? [step] : []
}
