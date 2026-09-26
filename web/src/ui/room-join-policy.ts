export type MpPhase = 'idle' | 'connecting' | 'lobby' | 'starting' | 'playing' | 'ended'

/**
 * A room-list Join must never tear down a seat the player still holds: it is refused while a
 * join is under way and while the player sits in a lobby. `playing` and `ended` stay open: a
 * finished network match can leave the phase there (the outcome sheet's Play again starts a
 * local skirmish without passing through idle), and a stale phase must not lock the browser.
 */
export function canJoinFromRoomList(phase: MpPhase, busy: boolean): boolean {
	return !busy && phase !== 'connecting' && phase !== 'lobby' && phase !== 'starting'
}
