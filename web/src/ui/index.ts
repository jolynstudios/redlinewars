// STEELSEED — ui (public stand-in presentation node).
//
// The production interface — setup screens, lobby, in-battle HUD, companion hooks — is
// Jolyn Studios' own work and is NOT part of the open-source client: it lives in the
// private web/src/hud/ and is withheld from the source export. This node is what the
// public repository builds instead. It registers under the same 'ui' id and offers the
// smallest honest interface: choose a map, start a local skirmish, select units, give
// contextual orders, and read the local player's basics. The renderer, simulation and
// everything the engine owns are unchanged — the game starts and the battlefield shows.
//
// Rules this file keeps with the rest of the tree: selection is a client concern and
// never touches the simulation; no Math.random (§5); no imports beyond core and types
// declared here (rule 3 — the camera surface is structural, the private build's richer
// CameraApi stays private).

import { HeaderFlag, PlayerFlag, type Ctx, type SkirmishCatalog, type SkirmishMapCatalog, type Snapshot } from '../core'

/** The camera surface this node uses. Structural: the real camera satisfies it. */
interface CameraLike {
	pickGroundPoint(screenX: number, screenY: number, ctx: Ctx): { x: number; y: number; z: number; cellX: number; cellY: number } | null
	/** Snap the strategic camera focus to a world-space ground point (metres; 1024 world units per cell). */
	focusWorld(worldX: number, worldZ: number): void
	/** Show the renderer's selection rings for exactly these actors; an empty list clears them. */
	selectActors(actorIds: readonly number[]): void
}

interface OwnActorHit {
	id: number
	typeId: number
	distanceSq: number
}

/** A click claims the nearest actor within this many cells of the picked cell. The strategic
 *  camera's tilt offsets the screen centre from the focus target by ~1.6 cells at the default
 *  height, so 1.5 made centre-of-screen clicks on the (focused) own unit miss; 3 covers the
 *  offset plus hand imprecision without swallowing a neighbour's unit. */
const HIT_RADIUS_CELLS = 3

const STYLE = `
.rwp-root { position: fixed; inset: 0; pointer-events: none; font: 13px/1.45 system-ui, sans-serif; color: #e8e6e1; }
.rwp-card {
	pointer-events: auto; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
	background: rgba(9, 13, 17, .94); border: 1px solid rgba(255, 255, 255, .14); border-radius: 10px;
	padding: 22px 26px; min-width: 300px; box-shadow: 0 18px 60px rgba(0, 0, 0, .5);
}
.rwp-card h1 { margin: 0 0 2px; font-size: 15px; letter-spacing: .14em; text-transform: uppercase; }
.rwp-card p { margin: 6px 0 14px; color: #9aa3ad; font-size: 12px; }
.rwp-card select { width: 100%; padding: 7px 9px; margin-bottom: 12px; background: #10161c; color: #e8e6e1;
	border: 1px solid rgba(255, 255, 255, .18); border-radius: 6px; }
.rwp-start { width: 100%; padding: 10px 12px; background: #fff; color: #090d11; font-weight: 700; letter-spacing: .08em;
	text-transform: uppercase; border: 0; border-radius: 6px; cursor: pointer; }
.rwp-start:disabled { opacity: .45; cursor: wait; }
.rwp-status { margin: 10px 0 0; min-height: 16px; color: #9aa3ad; font-size: 12px; }
.rwp-strip {
	pointer-events: auto; position: absolute; left: 12px; bottom: 12px; display: flex; gap: 18px; align-items: center;
	background: rgba(9, 13, 17, .82); border: 1px solid rgba(255, 255, 255, .12); border-radius: 8px; padding: 8px 14px;
	font-variant-numeric: tabular-nums; font-size: 12px;
}
.rwp-strip b { color: #fff; }
.rwp-strip .rwp-dim { color: #9aa3ad; }
`

export class Ui {
	static id = 'ui'
	static deps = ['camera']

	private ctx: Ctx | null = null
	private root: HTMLDivElement | null = null
	private card: HTMLDivElement | null = null
	private strip: HTMLDivElement | null = null
	private statusEl: HTMLElement | null = null
	private mapSelect: HTMLSelectElement | null = null
	private startButton: HTMLButtonElement | null = null
	private catalog: SkirmishCatalog | null = null
	private readonly selection: number[] = []
	private hint = ''
	private hintAt = 0
	private renderPlayerId = 0
	private running = false
	// Set on start; consumed on the first frame that shows one of the local player's actors,
	// so the camera lands on the base the way the production interface lands on it.
	private pendingBaseFocus = false
	private stripRefreshAt = 0
	private pointerDownAt = 0
	private pointerDownX = 0
	private pointerDownY = 0
	private detach: (() => void)[] = []

	async init(ctx: Ctx): Promise<void> {
		this.ctx = ctx
		this.buildDom()
		this.wireCanvas()
		void this.loadCatalog()
	}

	dispose(): void {
		for (const off of this.detach) off()
		this.detach = []
		this.root?.remove()
		this.root = null
	}

	// ------------------------------------------------------------------ setup

	private buildDom(): void {
		const style = document.createElement('style')
		style.textContent = STYLE
		document.head.append(style)

		this.root = document.createElement('div')
		this.root.className = 'rwp-root'

		this.card = document.createElement('div')
		this.card.className = 'rwp-card'
		const title = document.createElement('h1')
		title.textContent = 'Redline Wars — public build'
		const note = document.createElement('p')
		note.textContent = 'The Jolyn Studios game interface is not part of the open-source client. This stand-in starts a local skirmish.'
		this.mapSelect = document.createElement('select')
		this.mapSelect.setAttribute('aria-label', 'Map')
		this.startButton = document.createElement('button')
		this.startButton.className = 'rwp-start'
		this.startButton.type = 'button'
		this.startButton.textContent = 'Start skirmish'
		this.startButton.disabled = true
		this.startButton.addEventListener('click', () => void this.startSkirmish())
		this.statusEl = document.createElement('p')
		this.statusEl.className = 'rwp-status'
		this.card.append(title, note, this.mapSelect, this.startButton, this.statusEl)
		this.root.append(this.card)

		this.strip = document.createElement('div')
		this.strip.className = 'rwp-strip'
		this.strip.hidden = true
		this.root.append(this.strip)

		document.body.append(this.root)
	}

	private async loadCatalog(): Promise<void> {
		const ctx = this.ctx
		if (!ctx) return
		if (!ctx.session.available) {
			this.setStatus('No local engine session — serve the composed AppBundle to play.')
			return
		}
		try {
			const catalog = await ctx.session.getCatalog()
			if (!catalog || !catalog.maps.length) {
				this.setStatus(catalog?.userMessage || 'The engine published no skirmish maps.')
				return
			}
			this.catalog = catalog
			for (const map of catalog.maps) {
				const option = document.createElement('option')
				option.value = map.uid
				option.textContent = `${map.title} — ${map.author}`
				this.mapSelect?.append(option)
			}
			if (this.startButton) this.startButton.disabled = false
		} catch (err) {
			this.setStatus(`Catalog unavailable: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	private selectedMap(): SkirmishMapCatalog | null {
		const uid = this.mapSelect?.value
		return this.catalog?.maps.find(map => map.uid === uid) ?? this.catalog?.maps[0] ?? null
	}

	private setStatus(text: string): void {
		if (this.statusEl) this.statusEl.textContent = text
	}

	private async startSkirmish(): Promise<void> {
		const ctx = this.ctx
		const map = this.selectedMap()
		if (!ctx || !map || !this.catalog) return
		if (this.startButton) this.startButton.disabled = true
		this.setStatus('Starting the local game server…')
		// Slot 0 is the local human on the map's defaults; slot 1 hosts a bot when the
		// map allows one; every further slot is declared exactly once, closed.
		const slots = map.slots.map((slot, index) => index === 0
			? { slot: slot.id, kind: 'human' as const, faction: slot.defaults.faction, color: slot.defaults.color, team: slot.defaults.team, spawn: slot.defaults.spawn }
			: index === 1 && slot.allowBots && map.bots.length
				? { slot: slot.id, kind: 'bot' as const, botType: map.bots[0].id, faction: slot.defaults.faction, color: slot.defaults.color, team: slot.defaults.team, spawn: slot.defaults.spawn }
				: { slot: slot.id, kind: 'closed' as const, faction: slot.defaults.faction, color: slot.defaults.color, team: slot.defaults.team, spawn: slot.defaults.spawn })
		const local = slots[0]
		const options: Record<string, string> = {}
		for (const option of map.options) {
			if (option.isVisible && !option.isLocked) options[option.id] = option.defaultValue
		}
		try {
			const result = await ctx.session.startSkirmish({
				schemaVersion: this.catalog.schemaVersion,
				transport: 'local',
				mapUid: map.uid,
				gameSpeed: this.catalog.defaultGameSpeed,
				local: { slot: local.slot, name: 'Commander', faction: local.faction, color: local.color, team: local.team, spawn: local.spawn },
				slots,
				options,
			})
			if (result.status === 'error') throw new Error(result.userMessage || result.code)
			this.running = true
			this.pendingBaseFocus = true
			if (this.card) this.card.hidden = true
			if (this.strip) this.strip.hidden = false
		} catch (err) {
			this.setStatus(`Start refused: ${err instanceof Error ? err.message : String(err)}`)
			if (this.startButton) this.startButton.disabled = false
		}
	}

	// ------------------------------------------------------------------ input

	private wireCanvas(): void {
		const canvas = document.getElementById('viewport')
		if (!(canvas instanceof HTMLCanvasElement)) return
		const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (event: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
			canvas.addEventListener(type, fn as EventListener, opts)
			this.detach.push(() => canvas.removeEventListener(type, fn as EventListener, opts))
		}
		on('pointerdown', (event: PointerEvent) => {
			this.pointerDownAt = performance.now()
			this.pointerDownX = event.clientX
			this.pointerDownY = event.clientY
		})
		on('pointerup', (event: PointerEvent) => {
			// A click, not the end of a camera drag: under 300 ms and 5 px of travel.
			const moved = Math.hypot(event.clientX - this.pointerDownX, event.clientY - this.pointerDownY)
			if (event.button !== 0 || moved > 5 || performance.now() - this.pointerDownAt > 300) return
			this.selectAt(event.clientX, event.clientY, event.shiftKey)
		})
		on('contextmenu', (event: MouseEvent) => {
			event.preventDefault()
			this.orderAt(event.clientX, event.clientY)
		})
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || !this.running) return
			if (event.key === 'Escape') this.clearSelection()
			else if (event.key === 'A' || event.key === 'a') this.selectAllOwn()
		}
		window.addEventListener('keydown', onKey)
		this.detach.push(() => window.removeEventListener('keydown', onKey))
	}

	private groundPoint(screenX: number, screenY: number): { x: number; y: number; z: number; cellX: number; cellY: number } | null {
		const camera = this.ctx?.get<CameraLike>('camera')
		if (!camera) return null
		return camera.pickGroundPoint(screenX, screenY, this.ctx!)
	}

	private nearestActor(screenX: number, screenY: number, own: boolean): OwnActorHit | null {
		const snap = this.ctx?.snapshot
		const actors = snap?.actors
		if (!snap || !actors) return null
		const ground = this.groundPoint(screenX, screenY)
		if (!ground) return null
		// Cell space, both sides of the comparison: the pick's own cell and the actor's cell
		// (OpenRA world X/Y are the ground plane, 1024 units per cell). A screen pick cannot be
		// sharper than its cell anyway.
		let best: OwnActorHit | null = null
		for (let i = 0; i < actors.count; i++) {
			const isOwn = actors.owner[i] === this.renderPlayerId
			if (isOwn !== own) continue
			const dx = actors.posX[i] / 1024 - ground.cellX
			const dy = actors.posY[i] / 1024 - ground.cellY
			const distanceSq = dx * dx + dy * dy
			if (distanceSq > HIT_RADIUS_CELLS * HIT_RADIUS_CELLS) continue
			if (!best || distanceSq < best.distanceSq) best = { id: actors.id[i], typeId: actors.typeId[i], distanceSq }
		}
		return best
	}

	private selectAt(screenX: number, screenY: number, additive: boolean): void {
		const hit = this.nearestActor(screenX, screenY, true)
		if (!additive) this.selection.length = 0
		if (hit && !this.selection.includes(hit.id)) this.selection.push(hit.id)
		this.syncSelection()
		this.refreshStrip(true)
	}

	private selectAllOwn(): void {
		const actors = this.ctx?.snapshot?.actors
		if (!actors) return
		this.selection.length = 0
		for (let i = 0; i < actors.count && this.selection.length < 200; i++) {
			const id = actors.id[i]
			if (actors.owner[i] === this.renderPlayerId && !this.selection.includes(id)) this.selection.push(id)
		}
		this.syncSelection()
		this.refreshStrip(true)
	}

	private clearSelection(): void {
		this.selection.length = 0
		this.syncSelection()
		this.refreshStrip(true)
	}

	/** The camera owns the rings the renderer draws around the selected actors; keep them exact. */
	private syncSelection(): void {
		this.ctx?.get<CameraLike>('camera')?.selectActors(this.selection)
	}

	private flash(text: string): void {
		this.hint = text
		this.hintAt = performance.now()
		this.refreshStrip(true)
	}

	private orderAt(screenX: number, screenY: number): void {
		const ctx = this.ctx
		if (!ctx || !this.selection.length) return
		// One contextual order for everything: OpenRA's own targeters choose move,
		// attack or enter from the target under the pointer.
		const enemy = this.nearestActor(screenX, screenY, false)
		const ground = this.groundPoint(screenX, screenY)
		if (!enemy && !ground) return
		void ctx.issueOrder({
			orderString: 'Contextual',
			contextual: true,
			subjectIds: new Uint32Array(this.selection),
			...(enemy ? { targetActorId: enemy.id } : { targetCell: { x: ground!.cellX, y: ground!.cellY } }),
		}).then(() => this.flash('Order issued')).catch(reply => {
			console.warn('[ui] order refused:', reply)
			this.flash('Order refused')
		})
	}

	// ------------------------------------------------------------------ battle readout

	update(_dt: number, ctx: Ctx): void {
		if (!this.running) return
		const snap = ctx.snapshot
		if (!this.validSnap(snap)) return
		const me = snap.players.find(player => (player.flags & PlayerFlag.isRenderPlayer) !== 0)
		if (me) this.renderPlayerId = me.id
		if (this.pendingBaseFocus) {
			const actors = snap.actors
			if (!actors) return
			for (let i = 0; i < actors.count; i++) {
				if (actors.owner[i] !== this.renderPlayerId) continue
				// OpenRA's ground plane is X/Y (world units; 1024 per cell) and Z is height — the
				// same mapping the production interface uses when it lands on the base.
				ctx.get<CameraLike>('camera')?.focusWorld(actors.posX[i] / 1024, actors.posY[i] / 1024)
				this.pendingBaseFocus = false
				break
			}
		}
		const now = performance.now()
		if (now - this.stripRefreshAt < 250) return
		this.stripRefreshAt = now
		this.refreshStrip(false)
	}

	private validSnap(snap: Snapshot | null): snap is Snapshot {
		return snap !== null && snap.valid
	}

	private refreshStrip(force: boolean): void {
		const ctx = this.ctx
		const strip = this.strip
		if (!ctx || !strip) return
		if (!force && !this.running) return
		const snap = ctx.snapshot
		const me = snap?.players.find(player => (player.flags & PlayerFlag.isRenderPlayer) !== 0) ?? null
		if (me) this.renderPlayerId = me.id
		const actors = snap?.actors
		let typeName = '—'
		if (actors && this.selection.length) {
			const index = actors.id.indexOf(this.selection[0])
			if (index >= 0) typeName = ctx.actorTypeName(actors.displayTypeId[index] || actors.typeId[index])
		}
		const over = snap && (snap.flags & HeaderFlag.gameOver) !== 0
		strip.textContent = ''
		const cell = (label: string, value: string) => {
			const span = document.createElement('span')
			const dim = document.createElement('span')
			dim.className = 'rwp-dim'
			dim.textContent = `${label} `
			const bold = document.createElement('b')
			bold.textContent = value
			span.append(dim, bold)
			strip.append(span)
		}
		cell('Units', String(this.selection.length))
		cell('Lead', typeName)
		if (me) {
			cell('Credits', String(Math.floor(me.cash + me.resources)))
			cell('Power', `${me.powerSupplied - me.powerDrawn}`)
		}
		if (over) {
			const note = document.createElement('span')
			note.className = 'rwp-dim'
			note.textContent = 'Match over — reload the page to play again.'
			strip.append(note)
		} else if (this.hint && performance.now() - this.hintAt < 2500) {
			const note = document.createElement('span')
			note.className = 'rwp-dim'
			note.textContent = ` · ${this.hint}`
			strip.append(note)
		}
	}
}

export default Ui
