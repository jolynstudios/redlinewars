// Release performance load required by the owner. Four distinct armies must
// each reach fifty fighting units; a smaller natural bot peak is not equivalent.
export const BATTLE_PLAYERS = 4
export const UNITS_PER_PLAYER = 50
export function hasBattleLoad(counts, target = UNITS_PER_PLAYER) {
	return new Set(counts.filter(([, units]) => units >= target).map(([owner]) => owner)).size >= BATTLE_PLAYERS
}
