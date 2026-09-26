import { accountJson } from './account'

export type RankedQueueState = 'idle' | 'queued' | 'matched' | 'cancelled' | 'expired'

export interface RankedQueueStatus {
	state: RankedQueueState
	queuedAt?: number
	expiresAt?: number
	matchId?: string
	roomId?: string
	wsUrl?: string
	claim?: string | null
	simBuild?: string
	mapUid?: string
	rulesHash?: string
}

export interface RankedSettlement {
	state: 'pending' | 'settled' | 'void'
	reason?: string | null
	terminationReason?: string | null
	outcome?: 'won' | 'lost' | 'draw' | 'void'
	delta?: number
	rating?: number
}

const queuePath = '/api/ranked/queue'

export async function rankedQueueStart(): Promise<RankedQueueStatus> {
	const result = await accountJson<{ queue: RankedQueueStatus }>(queuePath, { method: 'POST', body: {} })
	return result.queue
}

export async function rankedQueueStatus(): Promise<RankedQueueStatus> {
	const result = await accountJson<{ queue: RankedQueueStatus }>(queuePath)
	return result.queue
}

export async function rankedQueueCancel(): Promise<RankedQueueStatus> {
	const result = await accountJson<{ queue: RankedQueueStatus }>(queuePath, { method: 'DELETE' })
	return result.queue
}

/** Participant read only. Clients never post receipts or choose a settlement. */
export async function rankedSettlement(matchId: string): Promise<RankedSettlement | null> {
	if (!/^[A-Za-z0-9_.:-]{6,128}$/.test(matchId)) throw new Error('Ranked match id is invalid.')
	const result = await accountJson<{ settlement?: RankedSettlement | null }>(`/api/ranked/settlement?matchId=${encodeURIComponent(matchId)}`)
	return result.settlement ?? null
}
