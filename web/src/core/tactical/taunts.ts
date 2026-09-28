import LINES from '../../audio/taunt-lines.json'

/** The companion's taunts: one catalogue for the phone's buttons, the main game's voice bank
 * (`taunts`, rendered by tools/render-taunts-elevenlabs.mjs) and the relay's id check. */
export interface Taunt { id: string; text: string }
export const TAUNTS: readonly Taunt[] = LINES.map(({ id, text }) => ({ id, text }))
export const tauntById = (id: unknown): Taunt | undefined => TAUNTS.find(t => t.id === id)
