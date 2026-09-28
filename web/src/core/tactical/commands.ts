import type { Ctx } from '../ctx'
import { isStructure, type Permission, type TacticalState } from './model'

export interface CompanionIntent { id: string; session: string; sequence: number; action: 'support' | 'repair' | 'move' | 'attack' | 'attack-move' | 'stop' | 'scout'; group?: number; revision?: string; aircraft?: number; power?: string; x?: number; y?: number; target?: number; source?: { x: number; y: number } }
export function validateIntent(value: unknown, state: TacticalState, tier: Permission): string | null {
	if (!value || typeof value !== 'object') return 'Invalid request'
	const v = value as CompanionIntent
	if (typeof v.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(v.id) || v.session !== state.session || !Number.isInteger(v.sequence) || v.sequence < 1 || v.sequence > state.sequence || state.sequence - v.sequence > 25) return 'Request expired'
	if (state.paused || state.ended || tier === 'information') return 'Commands unavailable'
	if (!['support', 'repair', 'move', 'attack', 'attack-move', 'stop', 'scout'].includes(v.action) || (tier === 'support' && v.action !== 'support' && v.action !== 'repair')) return 'Permission denied'
	if (v.action !== 'stop' && v.action !== 'repair' && (!Number.isInteger(v.x) || !Number.isInteger(v.y) || v.x! < state.bounds.x || v.y! < state.bounds.y || v.x! >= state.bounds.x + state.bounds.w || v.y! >= state.bounds.y + state.bounds.h)) return 'Target outside the map'
	if (v.action === 'support') { const power = state.powers.find(p => p.key === v.power); if (!power?.active || !power.ready) return 'Support weapon is not ready'
		const explored = (x: number, y: number) => state.visibility[(y-state.bounds.y)*state.bounds.w+x-state.bounds.x] > 0
		const under = (x: number, y: number, allies: boolean) => state.contacts.some(c => !c.remembered && !isStructure(c.role) && (c.relation === 'own' || allies && c.relation === 'ally') && Math.abs(Math.floor(c.x)-x)+Math.abs(Math.floor(c.y)-y)<=1)
		if (/GrantExternalCondition|IronCurtain/i.test(power.key) && !under(v.x!,v.y!,true)) return 'Choose an owned or allied unit'
		if (power.needsSource) { const s = v.source; if (!s || !Number.isInteger(s.x) || !Number.isInteger(s.y) || s.x < state.bounds.x || s.y < state.bounds.y || s.x >= state.bounds.x+state.bounds.w || s.y >= state.bounds.y+state.bounds.h || !under(s.x,s.y,false) || !explored(v.x!,v.y!)) return 'Choose an owned source unit and an explored destination' }
		if (/Sonar/i.test(power.key)) { const i=(v.y!-state.bounds.y)*state.bounds.w+v.x!-state.bounds.x; if (!explored(v.x!,v.y!) || ![8,9].includes(state.terrain[i])) return 'Choose explored open water' } }
	else if ((v.action === 'scout' || v.action === 'attack' || v.action === 'stop') && v.aircraft !== undefined) { if (!state.aircraft.includes(v.aircraft!)) return 'Aircraft unavailable' }
	else if (v.action === 'repair') {
		const building = state.contacts.find(c => c.id === v.target && c.relation === 'own' && !c.remembered && isStructure(c.role))
		if (!building) return 'Building is no longer standing'
		if (building.health === undefined || building.health >= 1) return 'Building is undamaged'
	}
	else { const group = state.groups.find(g => g.id === v.group); if (!group || group.revision !== v.revision) return 'Group changed. Select it again.' }
	if (v.action === 'attack' && !state.contacts.some(c => c.id === v.target && c.relation === 'enemy' && !c.remembered)) return 'Target is no longer visible'
	return null
}
export async function executeIntent(ctx: Ctx, intent: CompanionIntent, state: TacticalState, tier: Permission): Promise<string> {
	const error = validateIntent(intent, state, tier); if (error) return `error: ${error}`
	// A stop order carries either a group or a single aircraft: never both, and never neither.
	const subjects = intent.action === 'support' || intent.action === 'repair' ? []
		: (intent.action === 'scout' || intent.action === 'attack' || intent.action === 'stop') && intent.aircraft !== undefined ? [intent.aircraft!]
		: state.groups.find(g => g.id === intent.group)!.members
	if (subjects.length === 0 && intent.action !== 'support' && intent.action !== 'repair') return 'error: No owned actor is available'
	const ids = Uint32Array.from(subjects), targetCell = { x: intent.x ?? -1, y: intent.y ?? -1 }
	// Repair is the primary game's own RepairBuilding toggle on that one structure: the
	// simulation still refuses it for a building its rules do not consider repairable.
	if (intent.action === 'repair') return ctx.issueOrder({ origin: 'companion', orderString: 'RepairBuilding', subjectIds: ids, targetActorId: intent.target! })
	if (intent.action === 'move' || intent.action === 'attack' || intent.action === 'scout') {
		return ctx.issueOrder({ origin: 'companion', orderString: 'Contextual', contextual: true, subjectIds: ids, subjectCount: ids.length, targetCell, targetActorId: intent.action === 'attack' ? intent.target! : 0, targetFrozen: false, modifiers: 0 })
	}
	return ctx.issueOrder({ origin: 'companion', orderString: intent.action === 'support' ? intent.power! : intent.action === 'stop' ? 'Stop' : 'AttackMove', subjectIds: ids, subjectCount: ids.length, targetCell, targetActorId: 0, queued: false, extraData: intent.action === 'support' ? 0xFFFFFFFF : 0, extraCell: intent.source })
}
