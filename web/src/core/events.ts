// STEELSEED — core/events
// The JS-side event bus. Consumers: fx, audio, ui.
//
// Two distinct sources feed this, and conflating them is a bug:
//   1. Simulation events, decoded from snapshot section 7 (ARCHITECTURE.md §4.9) and
//      republished here. These are authoritative history — they already happened.
//   2. Presentation-local events (`weather:change` from sky, `resize` from core) which
//      never cross the WASM boundary.
//
// Hard rule 6: allocate nothing per frame. Handlers receive a payload object that is
// REUSED between dispatches — copy anything you intend to retain.

export type EventHandler<T = unknown> = (payload: T) => void

export class EventBus {
	private handlers = new Map<string, EventHandler[]>()
	/** Depth guard: an emit inside a handler for the same key would recurse. */
	private emitting = new Set<string>()

	on<T = unknown>(key: string, fn: EventHandler<T>): () => void {
		let list = this.handlers.get(key)
		if (!list) {
			list = []
			this.handlers.set(key, list)
		}
		list.push(fn as EventHandler)
		return () => this.off(key, fn)
	}

	once<T = unknown>(key: string, fn: EventHandler<T>): () => void {
		const off = this.on<T>(key, (p) => {
			off()
			fn(p)
		})
		return off
	}

	off<T = unknown>(key: string, fn: EventHandler<T>): void {
		const list = this.handlers.get(key)
		if (!list) return
		const i = list.indexOf(fn as EventHandler)
		if (i >= 0) list.splice(i, 1)
	}

	emit<T = unknown>(key: string, payload?: T): void {
		const list = this.handlers.get(key)
		if (!list || list.length === 0) return
		if (this.emitting.has(key))
			throw new Error(`events: re-entrant emit of '${key}' — a handler emitted the event it handles`)
		this.emitting.add(key)
		try {
			// Index loop, not for-of: a handler that calls off() during dispatch would
			// otherwise skip its neighbour. Length is re-read each step deliberately.
			for (let i = 0; i < list.length; i++) list[i](payload)
		} finally {
			this.emitting.delete(key)
		}
	}

	clear(): void {
		this.handlers.clear()
		this.emitting.clear()
	}
}

/** Presentation-local event keys. Simulation events use `sim:<name>` — see §4.9. */
export const CoreEvent = {
	resize: 'resize',
	aircraftTrail: 'presentation:aircraft:trail',
	aircraftImpact: 'presentation:aircraft:impact',
	weatherChange: 'weather:change',
	qualityChange: 'quality:change',
	backendLost: 'backend:lost',
	generationProgress: 'generation:progress',
	/**
	 * The simulation stopped advancing, or started again. Payload is `SimHealth`.
	 *
	 * This exists because the render loop and the simulation are independent: the WASM
	 * host ticks on its own rAF chain, so a host that dies leaves a fully interactive
	 * camera over a frozen world. Nothing in the frame path notices that on its own, and
	 * a player reads it as "the game crashed" with no message anywhere.
	 */
	simHealth: 'sim:health',
	/**
	 * A new skirmish world is being created. Presentation-owned match state (wrecks, scorches,
	 * lingering FX) must drop immediately — the last snapshot of the old world stays current
	 * until the new one publishes, and that is long enough to paint the previous battlefield
	 * onto the next match.
	 */
	newWorld: 'session:new-world',
} as const

/** Simulation event keys, republished from snapshot section 7. */
export const SimEvent = {
	weaponFire: 'sim:weapon:fire',
	projectileImpact: 'sim:projectile:impact',
	explosion: 'sim:explosion',
	actorDamaged: 'sim:actor:damaged',
	actorDestroyed: 'sim:actor:destroyed',
	unitMoving: 'sim:unit:moving',
	structureBuilt: 'sim:structure:built',
	productionComplete: 'sim:production:complete',
	resourceHarvested: 'sim:resource:harvested',
	powerState: 'sim:power:state',
	orderAccepted: 'sim:order:accepted',
	notify: 'sim:notify',
	eventsDropped: 'sim:events:dropped',
} as const

/** Snapshot event kind (§4.9) -> bus key. Index is the numeric kind. */
export const SIM_EVENT_BY_KIND: readonly (string | undefined)[] = [
	undefined,
	SimEvent.weaponFire,
	SimEvent.projectileImpact,
	SimEvent.explosion,
	SimEvent.actorDamaged,
	SimEvent.actorDestroyed,
	SimEvent.unitMoving,
	SimEvent.structureBuilt,
	SimEvent.productionComplete,
	SimEvent.resourceHarvested,
	SimEvent.powerState,
	SimEvent.orderAccepted,
	SimEvent.notify,
	SimEvent.eventsDropped,
]

/** Reused, presentation-only payload; never changes simulation damage. */
export interface AircraftVisualEvent { id:number; x:number; y:number; z:number; time:number; water:boolean; linked:boolean }
