import AUTHORED from './running-gear.json'

/** Fitted render metres and explicitly authored relative contact load; never simulation mass. */
export interface RunningGearProfile {
	readonly kind: 'tracked' | 'wheeled'
	readonly contactMinX: number
	readonly contactMaxX: number
	readonly contactLength: number
	readonly leftZ: number
	readonly rightZ: number
	readonly width: number
	readonly pitch: number
	readonly uvRepeatM: number
	readonly visualLoad: number
	readonly fitScale: number
}

export function runningGearProfile(name: string, fitScale: number): RunningGearProfile | null {
	const row = (AUTHORED.actors as Record<string, Omit<RunningGearProfile, 'fitScale'>>)[name]
	if (!row) return null
	return { kind: row.kind, contactMinX: row.contactMinX * fitScale, contactMaxX: row.contactMaxX * fitScale, contactLength: row.contactLength * fitScale, leftZ: row.leftZ * fitScale, rightZ: row.rightZ * fitScale,
		width: row.width * fitScale, pitch: row.pitch * fitScale,
		uvRepeatM: row.uvRepeatM * fitScale, visualLoad: row.visualLoad, fitScale }
}

/** Two 12-bit fractions fit exactly in one float32; no instance-stride/buffer growth. */
export function packRunningPhases(left: number, right: number): number {
	const l = Math.floor((left - Math.floor(left)) * 4096)
	const r = Math.floor((right - Math.floor(right)) * 4096)
	return l + r * 4096
}
