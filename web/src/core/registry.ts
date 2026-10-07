// STEELSEED — core/registry
// The node registry. This is the machinery that makes parallel subsystem work safe.
//
// Hard rule 3: never import another subsystem's module. Get it at runtime via
// ctx.get('fx'). A static import creates a load-order cycle and couples two nodes that
// are meant to be built by independent agents against nothing but ARCHITECTURE.md.

import type { Ctx } from './ctx'

export interface SystemClass {
	readonly id: string
	readonly deps?: readonly string[]
	new (): System
}

export interface System {
	init?(ctx: Ctx): Promise<void> | void
	onSnapshot?(snap: unknown, prev: unknown, ctx: Ctx): void
	update?(dt: number, ctx: Ctx): void
	lateUpdate?(dt: number, ctx: Ctx): void
	resize?(w: number, h: number, ctx: Ctx): void
	prewarm?(ctx: Ctx): void | Promise<void>
	dispose?(): void
}

export class Registry {
	private classes = new Map<string, SystemClass>()
	private instances = new Map<string, System>()
	/** init order, topologically sorted. Also the update order. */
	private order: string[] = []
	private initialised = false

	register(...classes: SystemClass[]): this {
		if (this.initialised) throw new Error('registry: cannot register after init()')
		for (const c of classes) {
			if (!c.id) throw new Error(`registry: ${c.name} has no static id`)
			if (this.classes.has(c.id)) throw new Error(`registry: duplicate id '${c.id}'`)
			this.classes.set(c.id, c)
		}
		return this
	}

	has(id: string): boolean {
		return this.instances.has(id)
	}

	/** Returns null rather than throwing — for genuinely optional collaborators. */
	peek<T = System>(id: string): T | null {
		return (this.instances.get(id) as T) ?? null
	}

	/**
	 * Throws if absent. If you call get(x) you must declare x in your static deps —
	 * otherwise you are relying on init order you do not control.
	 */
	get<T = System>(id: string): T {
		const s = this.instances.get(id)
		if (!s)
			throw new Error(
				`registry: no system '${id}'. Declare it in your static deps — get() outside deps relies on init order you do not control.`,
			)
		return s as T
	}

	/**
	 * Topological sort by declared deps. Throws on a cycle or a missing dep, naming the
	 * participants — a silent partial init is far worse to debug than a hard failure.
	 */
	private resolveOrder(): string[] {
		const order: string[] = []
		const state = new Map<string, 0 | 1 | 2>() // 0 unvisited, 1 visiting, 2 done
		const stack: string[] = []

		const visit = (id: string) => {
			const st = state.get(id) ?? 0
			if (st === 2) return
			if (st === 1) throw new Error(`registry: dependency cycle: ${[...stack, id].join(' -> ')}`)
			const cls = this.classes.get(id)
			if (!cls) throw new Error(`registry: '${stack[stack.length - 1] ?? '<root>'}' depends on unregistered '${id}'`)
			state.set(id, 1)
			stack.push(id)
			for (const d of cls.deps ?? []) visit(d)
			stack.pop()
			state.set(id, 2)
			order.push(id)
		}

		for (const id of this.classes.keys()) visit(id)
		return order
	}

	async init(ctx: Ctx, onSystem?: (done: number, total: number, id: string) => void): Promise<void> {
		if (this.initialised) throw new Error('registry: already initialised')
		this.order = this.resolveOrder()
		let done = 0
		for (const id of this.order) {
			const cls = this.classes.get(id)!
			const inst = new cls()
			// Publish before init so a dep's init() can be reached by a later node's
			// init(); deps are already fully initialised by topological order.
			this.instances.set(id, inst)
			// Reported BEFORE the await: the callback names the system that is ABOUT to
			// load, which is the honest signal — the heavy system's name is on the bar
			// while its work runs, not after it already finished.
			onSystem?.(done, this.order.length, id)
			await inst.init?.(ctx)
			done++
		}
		this.initialised = true
	}

	async prewarm(ctx: Ctx, onSystem?: () => void): Promise<void> {
		for (const id of this.order) {
			onSystem?.()
			await this.instances.get(id)!.prewarm?.(ctx)
		}
	}

	get systemCount(): number {
		return this.order.length
	}

	onSnapshot(snap: unknown, prev: unknown, ctx: Ctx): void {
		for (const id of this.order) this.instances.get(id)!.onSnapshot?.(snap, prev, ctx)
	}

	update(dt: number, ctx: Ctx): void {
		for (const id of this.order) this.instances.get(id)!.update?.(dt, ctx)
	}

	lateUpdate(dt: number, ctx: Ctx): void {
		for (const id of this.order) this.instances.get(id)!.lateUpdate?.(dt, ctx)
	}

	/**
	 * `?.` on the INSTANCE lookup, not just the method.
	 *
	 * `init()` fills `this.order` up front and then constructs instances one at a time, so
	 * there is a real window where an id is ordered but not yet instantiated. Resize is the
	 * one lifecycle call that can land inside it: App.attachResize() observes the canvas
	 * before awaiting registry.init(), and a ResizeObserver fires on observe. The `!` there
	 * asserted something false and threw `Cannot read properties of undefined (reading
	 * 'resize')` mid-boot — which killed the boot (rule 8) and left a black canvas.
	 *
	 * Observing before init is deliberate and stays: it means systems initialise at the
	 * real canvas size instead of the 300x150 default and immediately reallocating.
	 */
	resize(w: number, h: number, ctx: Ctx): void {
		for (const id of this.order) this.instances.get(id)?.resize?.(w, h, ctx)
	}

	/**
	 * Reverse init order, so a node still has its deps alive while tearing down.
	 * Instance-tolerant for the same reason: a boot that fails partway through init must
	 * still release what it did construct, rather than throwing on the first absent id
	 * and leaking every GPU resource behind it (rule 7).
	 */
	dispose(): void {
		const errors: unknown[] = []
		for (let i = this.order.length - 1; i >= 0; i--) {
			try { this.instances.get(this.order[i])?.dispose?.() }
			catch (error) { errors.push(error) }
		}
		this.instances.clear()
		this.order = []
		this.initialised = false
		if (errors.length) throw new AggregateError(errors, 'registry: disposal failed')
	}

	get systemIds(): readonly string[] {
		return this.order
	}
}
