/** Player-safe tactical facts. No raw snapshot or undisguised enemy identity crosses this boundary. */
import type { Ctx } from '../ctx'
import { ActorFlag, HeaderFlag, PlayerFlag } from '../snapshot'
import { H_OFFSET, H_SCALE } from './terrain-art'

export type Relation = 'own' | 'ally' | 'enemy' | 'neutral'
export type Permission = 'information' | 'support' | 'command'
export interface Contact { id: number; x: number; y: number; role: string; label: string; relation: Relation; color: string; remembered: boolean; health?: number; facing?: number; footprint?: { w: number; h: number }; underAttack?: boolean }
export interface TacticalGroup { id: number; revision: string; members: number[]; x: number; y: number }
export interface Power { key: string; title: string; active: boolean; ready: boolean; remainingTicks: number; totalTicks: number; needsSource?: boolean; remainingSeconds?: number }
/** What the commander's queues are building right now: the label is a display name, the kind is
 * the queue domain (0 structures, 1 infantry, 2 vehicles, 3 aircraft, 4 naval) and progress runs
 * 0 to 100. Queued counts the items waiting behind the current one. */
export interface ProductionLine { kind: number; label: string; progress: number; queued: number }
/** A missile in flight, allied or incoming: the countdown the companion draws at its target
 * (allies see the target; an enemy's stays masked at 0) and the imminence the host computed. */
export interface LaunchLine { id: number; tick: number; allied: boolean; imminent: boolean; secondsLeft: number; targetX: number; targetY: number }
export interface TacticalState {
	schema: 1; session: string; sequence: number; tick: number; time: number; paused: boolean; ended: boolean
	/** The result, once `ended`. The match token changes when the primary's next world loads. */
	outcome?: 'victory' | 'defeat' | 'concluded'; match?: number
	/** Primary game's presentation clock; no phone-local clock or simulation changes. */
	lighting?: { timeOfDay: number; night: boolean }
	bounds: { x: number; y: number; w: number; h: number }
	terrain: number[]; heights: number[]; visibility: number[]; contacts: Contact[]
	heat: { x: number; y: number; value: number }[]; alerts: { id: number; x: number; y: number; time: number; label: string }[]
	groups: TacticalGroup[]; powers: Power[]; aircraft: number[]; counts: { infantry: number; vehicles: number; aircraft: number; harvesters: number }
	production: ProductionLine[]; launches: LaunchLine[]
	/** The commander's ledger and roster, for the statistics sheet. Names and network ping stay
	 * with the primary: the snapshot carries players as facts, not identities. */
	stats: { credits: number; ore: number; powerSupplied: number; powerDrawn: number; harvesters: number; score: number | null; roster: { label: string; count: number }[]; enemies: { ai: number; human: number; ally: number } }
	/** The announcer bank the primary's faction speaks; the phone plays its alerts in the same voice. */
	voiceBank: string
}
interface Units { tacticalDisplayType?(name:string,enemy:boolean,revealed:boolean): string; tacticalFootprint?(name: string): { w: number; h: number } | undefined; semanticRole(name: string): string; displayName(name: string): string; hasRaTrait(name: string, trait: string): boolean }
interface Shroud { stateAt(x: number, y: number): number }
interface Relief { heightAt(x: number, z: number): number }
const mobile = new Set(['soldier', 'tracked-vehicle', 'wheeled-vehicle', 'mcv', 'rotorcraft', 'fixed-wing', 'ship', 'submarine', 'transport', 'minelayer', 'harvester'])
export const isAircraft = (role: string): boolean => role === 'fixed-wing' || role === 'rotorcraft'
export const isStructure = (role: string): boolean => !mobile.has(role) && ['structure', 'powerplant', 'barracks', 'factory', 'airfield', 'refinery', 'silo', 'superweapon', 'naval-yard', 'repair'].includes(role)

export class TacticalModel {
	private lastTick = -1
	private lastTime = 0
	private positions = new Map<number, { x: number; y: number }>()
	private heat = new Map<string, { x: number; y: number; value: number }>()
	private alerted = new Map<number, number>()
	private inside = new Set<number>()
	private alerts: TacticalState['alerts'] = []
	/** Hull bytes of own structures last tick: a drop means the building is taking fire. */
	private hulls = new Map<number, number>()
	private attackedAt = new Map<number, number>()
	private attackAlerted = new Map<number, number>()
	/** The 3D world's relief per cell, quantised once: the ground does not move during a match. */
	private relief: Int16Array | null = null
	private reliefKey = ''
	reset(): void { this.lastTick = -1; this.lastTime = 0; this.positions.clear(); this.heat.clear(); this.alerted.clear(); this.inside.clear(); this.alerts = []; this.hulls.clear(); this.attackedAt.clear(); this.attackAlerted.clear(); this.relief = null; this.reliefKey = '' }
	project(ctx: Ctx, groups: ReadonlyMap<number, number[]>, session: string, sequence: number, match = 0): TacticalState | null {
		const snap = ctx.snapshot, world = snap?.world, actors = snap?.actors
		if (!snap || !world || !actors) return null
		const support=ctx.supportPowers?.()
		const units = ctx.get<Units>('units'), shroud = ctx.peek<Shroud>('shroud')
		const bounds = { x: world.boundsLeft, y: world.boundsTop, w: world.boundsRight - world.boundsLeft, h: world.boundsBottom - world.boundsTop }
		if (bounds.w < 1 || bounds.h < 1 || bounds.w * bounds.h > 512 * 512) return null
		const visibility = new Array<number>(bounds.w * bounds.h), terrain = new Array<number>(visibility.length).fill(0), heights = new Array<number>(visibility.length).fill(0)
		const relief = ctx.peek<Relief>('terrain'), key = `${bounds.x},${bounds.y},${bounds.w},${bounds.h}`
		if (!this.relief || this.reliefKey !== key) { this.relief = new Int16Array(bounds.w * bounds.h).fill(-1); this.reliefKey = key }
		for (let y = 0; y < bounds.h; y++) for (let x = 0; x < bounds.w; x++) {
			const i = y * bounds.w + x, v = shroud?.stateAt(x + bounds.x, y + bounds.y) ?? 0
			visibility[i] = v
			if (v > 0 && snap.terrainStatic) {
				terrain[i] = snap.terrainStatic.surface[i] ?? 0
				// The relief the 3D world draws (reconstructed for flat RA maps), only for explored cells.
				if (this.relief[i] < 0) this.relief[i] = relief?.heightAt ? Math.max(0, Math.min(255, Math.round((relief.heightAt(bounds.x + x + 0.5, bounds.y + y + 0.5) + H_OFFSET) * H_SCALE))) : snap.terrainStatic.height[i] ?? 0
				heights[i] = this.relief[i]
			}
		}
		const contacts: Contact[] = [], counts = { infantry: 0, vehicles: 0, aircraft: 0, harvesters: 0 }, aircraft: number[] = []
		for (let i = 0; i < actors.count; i++) {
			if ((actors.flags[i] & ActorFlag.husk) !== 0 || actors.health[i] === 0) continue
			const owner = snap.players[actors.owner[i]], own = actors.owner[i] === world.renderPlayer
			const relation: Relation = own ? 'own' : owner?.relation === 1 ? 'ally' : owner?.relation === 2 ? 'enemy' : 'neutral'
			// ActorVisible already applies the engine's footprint, cloak and disguise contracts.
			const rawName = ctx.actorTypeName(own ? actors.typeId[i] : actors.displayTypeId[i])
			const name = units.tacticalDisplayType?.(rawName, relation === 'enemy', support?.revealed?.includes(actors.id[i]) ?? false) ?? rawName, role = /^(t\d\d|tc\d\d)(\.|$)/i.test(name)?'tree':/^rock\d/i.test(name)?'rock':units.semanticRole(name)
			if (!mobile.has(role) && !isStructure(role) && role !== 'tree' && role !== 'rock') continue
			if (own) {
				if (role === 'soldier') counts.infantry++
				else if (role === 'harvester') counts.harvesters++
				else if (isAircraft(role)) { counts.aircraft++; aircraft.push(actors.id[i]) }
				else if (mobile.has(role)) counts.vehicles++
			}
			contacts.push({ id: actors.id[i], x: actors.posX[i] / 1024, y: actors.posY[i] / 1024, role, label: name === 'jackson' ? 'Jackson' : units.displayName(name), relation,
				footprint: isStructure(role) ? units.tacticalFootprint?.(name) : undefined, facing: actors.facing?.[i], color: owner ? `rgb(${owner.red},${owner.green},${owner.blue})` : '#A8B2BA', remembered: false, ...(own ? { health: actors.health[i] / 255 } : {}) })
		}
		const frozen = snap.frozenActors
		if (frozen) for (let i = 0; i < frozen.count; i++) {
			const x = frozen.posX[i] / 1024, y = frozen.posY[i] / 1024
			if (shroud?.stateAt(Math.floor(x), Math.floor(y)) !== 1 || contacts.some(c => c.id === frozen.id[i])) continue
			const owner = snap.players[frozen.owner[i]], rawName = ctx.actorTypeName(frozen.typeId[i])
			const name = units.tacticalDisplayType?.(rawName, owner?.relation === 2, false) ?? rawName, role = /^(t\d\d|tc\d\d)(\.|$)/i.test(name)?'tree':/^rock\d/i.test(name)?'rock':units.semanticRole(name)
			if (!isStructure(role)&&role!=='tree'&&role!=='rock') continue
			contacts.push({ id: frozen.id[i], x, y, role, label: units.displayName(name), relation: owner?.relation === 2 ? 'enemy' : owner?.relation === 1 ? 'ally' : 'neutral', color: '#A8B2BA', remembered: true, footprint: units.tacticalFootprint?.(name) })
		}
		if (snap.tick < this.lastTick) this.reset()
		if (snap.tick !== this.lastTick) {
			const decay = Math.exp(-Math.max(0, snap.gameTimeMs - this.lastTime) / 20000), positions = new Map<number, { x: number; y: number }>()
			for (const [key, heat] of this.heat) { heat.value *= decay; if (heat.value < 0.02) this.heat.delete(key) }
			const inside = new Set<number>()
			const structures = contacts.filter(c => c.relation === 'own' && isStructure(c.role))
			// A falling hull says a building is taking fire, whatever is shooting it and wherever
			// the shooter stands (the proximity alert below only sees visible approaches).
			const hulls = new Map<number, number>()
			for (const s of structures) {
				if (s.health === undefined) continue
				hulls.set(s.id, s.health)
				if (this.hulls.has(s.id) && s.health < this.hulls.get(s.id)! - 2 / 255) this.attackedAt.set(s.id, snap.gameTimeMs)
				if (snap.gameTimeMs - (this.attackedAt.get(s.id) ?? -Infinity) <= 12000) {
					s.underAttack = true
					if (snap.gameTimeMs - (this.attackAlerted.get(s.id) ?? -10000) >= 10000) {
						this.attackAlerted.set(s.id, snap.gameTimeMs)
						this.alerts.push({ id: s.id, x: Math.floor(s.x), y: Math.floor(s.y), time: snap.gameTimeMs, label: `${s.label} under attack` })
					}
				}
			}
			this.hulls = hulls
			for (const contact of contacts) {
				if (contact.relation !== 'enemy' || contact.remembered || !mobile.has(contact.role)) continue
				const x = Math.floor(contact.x), y = Math.floor(contact.y)
				if (shroud?.stateAt(x, y) !== 2) continue
				positions.set(contact.id, { x, y })
				const previous = this.positions.get(contact.id)
				if (previous && (x !== previous.x || y !== previous.y)) {
					const key = `${x},${y}`, old = this.heat.get(key)
					this.heat.set(key, { x, y, value: Math.min(1, (old?.value ?? 0) + 0.25) })
				}
				if (structures.some(s => Math.hypot(s.x - contact.x, s.y - contact.y) <= 8)) inside.add(contact.id)
				if (inside.has(contact.id) && !this.inside.has(contact.id) && snap.gameTimeMs - (this.alerted.get(contact.id) ?? -10000) >= 10000) {
					this.alerted.set(contact.id, snap.gameTimeMs); this.alerts.push({ id: contact.id, x, y, time: snap.gameTimeMs, label: 'Hostile contact near your base' })
				}
			}
			this.inside = inside; this.positions = positions; this.lastTick = snap.tick; this.lastTime = snap.gameTimeMs
			this.alerts = this.alerts.filter(a => snap.gameTimeMs - a.time < 30000).slice(-12)
			for (const [id, time] of this.alerted) if (snap.gameTimeMs - time > 30000) this.alerted.delete(id)
			for (const [id, time] of this.attackedAt) if (snap.gameTimeMs - time > 30000) this.attackedAt.delete(id)
			for (const [id, time] of this.attackAlerted) if (snap.gameTimeMs - time > 30000) this.attackAlerted.delete(id)
		}
		const own = new Map(contacts.filter(c => c.relation === 'own').map(c => [c.id, c]))
		const projectedGroups: TacticalGroup[] = []
		for (const [id, ids] of groups) {
			const members = ids.filter(id => own.has(id))
			if (id < 1 || id > 6 || members.length === 0) continue
			projectedGroups.push({ id, revision: members.join(','), members, x: members.reduce((sum, id) => sum + own.get(id)!.x, 0) / members.length, y: members.reduce((sum, id) => sum + own.get(id)!.y, 0) / members.length })
		}
		const sky = ctx.peek<{ timeOfDay: number }>('sky')
		const timeOfDay = Number.isFinite(sky?.timeOfDay) ? sky!.timeOfDay : 720
		const ended = (snap.flags & HeaderFlag.gameOver) !== 0
		const playerFlags = snap.players[world.renderPlayer]?.flags ?? 0
		// The statistics sheet: the local player's ledger, the own roster by display name, and the
		// opposition as counts (the snapshot deliberately carries no names or network facts).
		const localPlayer = snap.players[world.renderPlayer]
		const rosterOf = new Map<string, number>()
		for (const contact of contacts) if (contact.relation === 'own' && mobile.has(contact.role)) rosterOf.set(contact.label, (rosterOf.get(contact.label) ?? 0) + 1)
		const enemies = { ai: 0, human: 0, ally: 0 }
		for (const player of snap.players) {
			if (!player || (player.flags & PlayerFlag.alive) === 0) continue
			if (player.relation === 2) { if ((player.flags & PlayerFlag.isBot) !== 0) enemies.ai++; else enemies.human++ }
			else if (player.relation === 1) enemies.ally++
		}
		const stats = { credits: (localPlayer?.cash ?? 0) + (localPlayer?.resources ?? 0), ore: localPlayer?.resources ?? 0,
			powerSupplied: localPlayer?.powerSupplied ?? 0, powerDrawn: localPlayer?.powerDrawn ?? 0, harvesters: counts.harvesters,
			score: localPlayer?.score ?? null, roster: [...rosterOf].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 16), enemies }
		// Same bank choice the game's announcer makes (audio/eva.ts setFactionFamily): the
		// alliance ids that have no own render route to their side's bank, everything unknown
		// to the allied render.
		const factionName = (ctx.actorTypeName(localPlayer?.factionId ?? 0) || '').toLowerCase()
		const voiceBank = factionName === 'soviet' ? 'russia' : ['england', 'france', 'germany', 'russia', 'ukraine'].includes(factionName) ? factionName : 'allied'
		// The commander's own queues, in build order: what the base is raising right now.
		const production: ProductionLine[] = []
		for (const queue of snap.production ?? []) {
			if (queue.playerId !== world.renderPlayer || queue.items.length === 0) continue
			const typeId = queue.currentActorType || queue.items[0].actorType
			const name = ctx.actorTypeName(typeId)
			if (!name) continue
			production.push({ kind: queue.kind, label: units.displayName(name), progress: Math.min(100, queue.progressPermille / 10), queued: Math.max(0, queue.itemsQueued - 1) })
		}
		// Missiles in flight, with the seconds the phone draws at the target ring (allied) or the
		// incoming banner. The target of an enemy launch stays masked by the host projection.
		const stepMs = support?.timestepMs && support.timestepMs > 0 ? support.timestepMs : 40
		const launches: LaunchLine[] = (support?.launches ?? []).map(l => ({ id: l.id, tick: l.tick, allied: l.allied, imminent: !!l.imminent, secondsLeft: Math.max(0, Math.ceil((l.tick + (l.flightTicks ?? 0) - snap.tick) * stepMs / 1000)), targetX: l.targetX ?? 0, targetY: l.targetY ?? 0 }))
		return { schema: 1, session, sequence, tick: snap.tick, time: snap.gameTimeMs, lighting: { timeOfDay, night: timeOfDay < 360 || timeOfDay >= 1080 }, paused: (snap.flags & HeaderFlag.paused) !== 0, ended,
			...(ended ? { outcome: (playerFlags & PlayerFlag.won) !== 0 ? 'victory' as const : (playerFlags & PlayerFlag.lost) !== 0 ? 'defeat' as const : 'concluded' as const } : {}), match,
			bounds, terrain, heights, visibility, contacts, counts: support?.inventory ?? counts, aircraft, groups: projectedGroups, powers: (support?.powers ?? []).map(p=>({...p,remainingSeconds:p.remainingTicks*(support?.timestepMs ?? 40)/1000})), production, launches, stats, voiceBank,
			heat: [...this.heat.values()].filter(h => shroud?.stateAt(h.x, h.y) === 2), alerts: this.alerts.filter(a => shroud?.stateAt(a.x, a.y) === 2) }
	}
}
