import type { TacticalState } from './model'

export type VisionMode = 'day' | 'white' | 'green'
export type VisionChoice = 'auto' | VisionMode
export function resolveVision(state: Pick<TacticalState, 'lighting'>, choice: VisionChoice = 'auto', nightStyle: 'white' | 'green' = 'white'): VisionMode {
	return choice === 'auto' ? state.lighting?.night ? nightStyle : 'day' : choice
}
export const visionLabel = (mode: VisionMode): string => mode === 'white' ? 'White-hot' : mode === 'green' ? 'Night vision' : 'Satellite'
