/** Ephemeral engine lobby data. Never written to storage, reports or replays. */
export interface LobbySnapshot {
	started: boolean
	localClientIndex: number
	adminClientIndex: number
	ranked: boolean
	capacity: number
	requestedCapacity: number
	map: string
	tod?: string
	weather?: string
	startAllowed?: boolean
	startReason?: string
	options: { id: string; name: string; value: string; locked: boolean; values: { id: string; label: string }[] }[]
	clients: { index: number; name: string; bot: boolean; admin: boolean; slot: string | null; state: string; faction: string; team: number; spawn: number; color: string }[]
	slots: { id: string; closed: boolean; required: boolean; lockFaction: boolean; lockTeam: boolean; lockSpawn: boolean }[]
	chat: { sequence: number; clientIndex: number; name: string; text: string }[]
}

export function readLobbySnapshot(raw: string): LobbySnapshot | null {
	try {
		const data = JSON.parse(raw) as LobbySnapshot
		return data && Array.isArray(data.clients) && Array.isArray(data.options) && Array.isArray(data.chat) && Array.isArray(data.slots) ? data : null
	} catch { return null }
}
