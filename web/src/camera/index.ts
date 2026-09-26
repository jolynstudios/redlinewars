// STEELSEED — camera
//
// The RTS camera. Pan, edge scroll, zoom, follow, and the projection every other node
// renders through. It is the node that turns "terrain exists in GPU memory" into
// "you can see the battlefield", so it is deliberately small and deliberately owned by
// the lead rather than fanned out.
//
// Coordinate convention is ARCHITECTURE.md §12.4 and is not re-derived here: render
// space is right-handed, Y up, metres, one cell = one metre. Picking and order UX land
// with the `ui` node; this node owns view/projection and nothing else.

import {
	type ActorsView,
	canvasCssHeight,
	canvasCssWidth,
	clamp,
	damp,
	type Ctx,
	findActorIndex,
	m4,
	mat4,
	type SystemClass,
	v3,
	vec3,
	WDIST_CELL,
} from '../core'
import { clampCell, Picker } from './pick'

/** Degrees of pitch at maximum zoom-out — a near-top-down read of the whole battle. */
const PITCH_FAR = 62
/** Degrees of pitch at maximum zoom-in — low enough to read one tank's tracks (§ brief). */
const PITCH_NEAR = 48
// Close inspection of articulated assets, with continuous strategic zoom above it.
// Bounds apply to the pivot, never to the rotated perspective footprint.
const HEIGHT_MIN = 3.5
/** Tilt offsets added to the zoom-derived pitch. TILT_MAX with PITCH_FAR reads as top-down. */
const TILT_MIN = -20 * Math.PI / 180
const TILT_MAX = 24 * Math.PI / 180
const HEIGHT_MAX = 140

const FOV_Y = (48 * Math.PI) / 180
const NEAR_PLANE = 0.35

/** Fraction of the viewport that triggers edge scrolling. */
const EDGE_BAND = 0.015
const EDGE_SPEED = 34
const KEY_SPEED = 42
/** Pan and zoom are damped rather than snapped; an RTS camera that stops dead feels cheap. */
const PAN_DAMP = 14
const ZOOM_DAMP = 11
/** One on-screen zoom press, as a proportion of the current height. Matches a wheel notch. */
const ZOOM_NOTCH = 0.16
/** Radians per second on Q/E. ~100 deg/s — a half turn in under two seconds. */
const ROTATE_SPEED = 1.75
/** Radians per CSS pixel of middle-drag. A ~200 px drag is roughly a quarter turn. */
const ROTATE_DRAG = 0.008
/** Rotation is damped harder than pan; a loose camera spin reads as drift. */
const ROTATE_DAMP = 16
/** Shared upper bound for UI-owned selection. The camera never issues game orders. */
const MAX_SELECTION = 512

export class CameraSystem {
	static id = 'camera'
	/**
	 * Empty, deliberately. `core` is the ctx provider, not a registered system — declaring
	 * it here would make Registry.resolveOrder throw "depends on unregistered 'core'".
	 * `render` and `terrain` are reached with peek() rather than declared, because the
	 * camera must still boot before either exists (rule 8: never break the boot).
	 */
	static deps: readonly string[] = []

	/** Focus point on the ground plane, render-space metres. */
	private readonly target = vec3(0, 0, 0)
	private readonly targetGoal = vec3(0, 0, 0)
	private readonly eye = vec3(0, 60, 60)

	private readonly view = mat4()
	private readonly proj = mat4()
	private readonly up = vec3(0, 1, 0)

	private height = 70
	private heightGoal = 70

	/**
	 * Yaw in radians, 0 = looking north (camera due south of its focus). Unbounded and
	 * free to wrap — a full 360 is the point, so this is deliberately NOT clamped.
	 *
	 * `yawRaw` and `yawGoal` are kept as raw accumulating angles rather than being wrapped
	 * into [0, 2pi). Wrapping them would make the damped follow take the long way round
	 * every time the value crossed the seam, which reads as the camera suddenly spinning
	 * a full turn to arrive at an angle it was already next to.
	 */
	private yawRaw = 0
	private yawGoal = 0

	/**
	 * Read-only yaw readback for navigation aids (the HUD compass tape). This is the RAW
	 * accumulating angle, not normalised — display layers wrap it for presentation only,
	 * because wrapping here would fight the damped follow the same way storing a wrapped
	 * value would.
	 */
	get yaw(): number {
		return this.yawRaw
	}

	// Untyped test rigs across tools/*.mjs stage camera angles by writing `.yaw` directly.
	// The typed CameraApi surface stays read-only; this accepts the rigs without a second
	// way into the class's rotation state.
	set yaw(radians: number) {
		this.yawRaw = radians
	}

	private tilt = 0
	private tiltGoal = 0

	/** Map extent in metres, from terrain once it exists. Keeps the camera over the map. */
	private boundsMinX = -1e4
	private boundsMaxX = 1e4
	private boundsMinZ = -1e4
	private boundsMaxZ = 1e4
	private boundsKnown = false
	/** True while the T tactical view is engaged, so the same key returns from it. */
	private tacticalView = false
	/** Height and tilt to restore when T is pressed a second time. */
	private tacticalReturnHeight = 70
	private tacticalReturnTilt = 0
	private initialFocusApplied = false
	private initialFocusX = Number.NaN
	private initialFocusZ = Number.NaN

	private aspect = 16 / 9

	private readonly picker = new Picker()
	/**
	 * Which screen edges are driving an edge scroll right now: 1 left, 2 right, 4 top,
	 * 8 bottom. `ui` paints the matching edge so the player can see why the map started
	 * moving, and reads it rather than recomputing the band, because a highlight that
	 * disagrees with the camera is worse than no highlight.
	 */
	private edgeMask = 0
	/** Latest decoded actors, for picking. Reference, not a copy — the decoder reuses it. */
	private actors: ActorsView | null = null
	/** Selected actor ids. Plain array: it is small and `ui` reads it as a list. */
	private readonly selection: number[] = []

	async init(ctx: Ctx): Promise<void> {
		this.aspect = Math.max(1e-3, ctx.canvas.width / Math.max(1, ctx.canvas.height))
		this.rebuildProjection()
		this.rebuildView()
		this.pushToRenderer(ctx)
	}

	resize(w: number, h: number, ctx: Ctx): void {
		this.aspect = Math.max(1e-3, w / Math.max(1, h))
		this.rebuildProjection()
		this.pushToRenderer(ctx)
	}

	/**
	 * Centre on the map the first time terrain reports its extent, and clamp panning to
	 * it thereafter.
	 *
	 * Retried every FRAME rather than only on snapshot arrival, and that is not belt-and-
	 * braces. Registry order is topological, and `camera` declares no deps while `terrain`
	 * depends on render+materials — so camera's onSnapshot runs BEFORE terrain has
	 * rebuilt from that same snapshot, reads cellsWide 0, and bails. With a bridge that
	 * emits every tick it would self-correct next tick; with a fixed dev snapshot served
	 * once it never would, and the camera sat off the edge of the map staring at nothing.
	 * Polling here is independent of snapshot cadence and of node ordering.
	 *
	 * peek() rather than get(): the camera must still boot with no terrain node at all
	 * (rule 8 — never break the boot).
	 */
	private tryAdoptTerrainBounds(ctx: Ctx): void {
		if (this.boundsKnown) return

		const terrain = ctx.peek<{ cellsWide: number; cellsHigh: number; originX: number; originY: number }>('terrain')
		if (!terrain || terrain.cellsWide <= 0) return

		// One cell is one metre (§12.4), so cell counts are metres directly — but
		// cellsWide/cellsHigh are an EXTENT, not a position. The grid starts at the §4.2
		// playable bounds, which terrain now offsets by (§12.5), so centring on half the
		// extent alone would aim the camera at empty space (boundsLeft, boundsTop) metres
		// away from the battlefield. Origin first, then half the extent.
		const ox = terrain.originX ?? 0
		const oy = terrain.originY ?? 0
		this.adoptBounds(ox, oy, terrain.cellsWide, terrain.cellsHigh)
	}

	private adoptBounds(ox: number, oy: number, width: number, height: number): void {
		this.boundsMinX = ox
		this.boundsMaxX = ox + width
		this.boundsMinZ = oy
		this.boundsMaxZ = oy + height
		this.boundsKnown = true

		const focusX = Number.isFinite(this.initialFocusX) ? this.initialFocusX : ox + width * 0.5
		const focusZ = Number.isFinite(this.initialFocusZ) ? this.initialFocusZ : oy + height * 0.5
		// Edge spawns are normal in RA. Start with the camera on the outside of the base,
		// looking into the map, so the long half of the perspective footprint lies over
		// playable ground instead of forcing the focus back to the map centre.
		this.orientTowardMapCentre(focusX, focusZ)
		v3.set(this.targetGoal, focusX, 0, focusZ)
		v3.copy(this.target, this.targetGoal)
		this.initialFocusApplied = true
		// A readable base-scale opening view derived from the horizontal field of view, then
		// capped by both the map and the actual spawn. A map-wide cap alone can legally put
		// an edge-spawned MCV at the last screen pixel, which looks like a black empty world.
		const halfHorizontalFov = Math.atan(Math.tan(FOV_Y * 0.5) * this.aspect)
		const desiredWidth = Math.min(28, width * 0.3)
		this.heightGoal = Math.max(HEIGHT_MIN, desiredWidth / Math.max(0.01, 2 * Math.tan(halfHorizontalFov)))
		this.heightGoal = Math.min(this.heightGoal, this.maxHeightInsideMap())
		this.height = this.heightGoal
		this.clampFocusToFrustum(this.height)
	}

	onSnapshot(snap: unknown, _prev: unknown, ctx: Ctx): void {
		// Latched for picking. Held by reference, not copied: the decoder reuses its typed
		// arrays and picking runs against whatever the newest tick decoded, which is what
		// we want — a click resolves against the state the player is looking at.
		const decoded = snap as {
			actors?: ActorsView
			world?: {
				renderPlayer: number
				boundsLeft: number
				boundsTop: number
				boundsRight: number
				boundsBottom: number
			}
		}
		this.actors = decoded.actors ?? null
		const world = decoded.world
		const mapChanged = world !== undefined && (!this.boundsKnown ||
			world.boundsLeft !== this.boundsMinX || world.boundsRight !== this.boundsMaxX ||
			world.boundsTop !== this.boundsMinZ || world.boundsBottom !== this.boundsMaxZ)
		if (mapChanged) {
			this.initialFocusApplied = false
			this.initialFocusX = Number.NaN
			this.initialFocusZ = Number.NaN
		}
		let foundLocalFocus = false
		if (!this.initialFocusApplied && this.actors && world) {
			let x = 0
			let z = 0
			let count = 0
			for (let i = 0; i < this.actors.count; i++) {
				if (this.actors.owner[i] !== world.renderPlayer) continue
				x += this.actors.posX[i] / WDIST_CELL
				z += this.actors.posY[i] / WDIST_CELL
				count++
			}
			if (count > 0) {
				this.initialFocusX = x / count
				this.initialFocusZ = z / count
				foundLocalFocus = true
			}
		}
		if ((mapChanged || foundLocalFocus) && world) {
			this.adoptBounds(
				world.boundsLeft,
				world.boundsTop,
				world.boundsRight - world.boundsLeft,
				world.boundsBottom - world.boundsTop,
			)
			// OpenRA may publish the world/player table one tick before the local MCV.
			// A map-centre fallback is allowed for that transient snapshot, but it must not
			// consume the one-shot focus. The next snapshot with a local actor re-adopts the
			// same bounds around the real base and snaps there before rendering.
			if (!foundLocalFocus) this.initialFocusApplied = false
		} else this.tryAdoptTerrainBounds(ctx)
		// Selection outlives the actors that made it. Anything destroyed since the previous
		// tick is dropped here rather than being carried as a dead id that later aliases a
		// NEW actor once the sim reuses the number.
		this.pruneSelection()
	}

	/**
	 * Resolve a CSS-pixel pointer to the authoritative terrain cell under the current
	 * camera. UI uses this for building placement instead of reimplementing the camera's
	 * ray convention — two pickers that merely look equivalent diverge as soon as yaw,
	 * reverse-Z or terrain relief changes.
	 */
	pickGroundCell(screenX: number, screenY: number, ctx: Ctx): { x: number; y: number } | null {
		const w = canvasCssWidth(ctx) || 1
		const h = canvasCssHeight(ctx) || 1
		if (!this.picker.setRay(this.view, this.proj, this.eye, screenX, screenY, w, h)) return null
		const terrain = ctx.peek<{ heightAt(x: number, z: number): number }>('terrain')
		const g = this.picker.pickGround(terrain ? (x, z) => terrain.heightAt(x, z) : null)
		if (!g.hit) return null
		// Every caller turns this cell into an order. A click on the scenery ring beyond the
		// playable edge means the nearest edge cell: OpenRA's map does not contain the other.
		const world = ctx.snapshot?.world
		if (!world || world.boundsRight <= world.boundsLeft || world.boundsBottom <= world.boundsTop)
			return { x: g.cellX, y: g.cellY }
		return {
			x: clampCell(g.cellX, world.boundsLeft, world.boundsRight - 1),
			y: clampCell(g.cellY, world.boundsTop, world.boundsBottom - 1),
		}
	}

	/**
	 * Exact ray-terrain hit under the cursor, not snapped to the cell. Order markers draw
	 * at this point so the visual lands under the pointer instead of the cell centre.
	 */
	pickGroundPoint(screenX: number, screenY: number, ctx: Ctx): { x: number; y: number; z: number; cellX: number; cellY: number } | null {
		const w = canvasCssWidth(ctx) || 1
		const h = canvasCssHeight(ctx) || 1
		if (!this.picker.setRay(this.view, this.proj, this.eye, screenX, screenY, w, h)) return null
		const terrain = ctx.peek<{ heightAt(x: number, z: number): number }>('terrain')
		const g = this.picker.pickGround(terrain ? (x, z) => terrain.heightAt(x, z) : null)
		return g.hit ? { x: g.x, y: g.y, z: g.z, cellX: g.cellX, cellY: g.cellY } : null
	}

	/**
	 * Ground footprint of the current view, for the minimap camera rectangle.
	 * Intersects each screen-corner ray with the focus height so a sky pixel still
	 * yields a far point instead of dropping the quad.
	 */
	viewGroundQuad(out: Float32Array, screenW: number, screenH: number): boolean {
		if (out.length < 8) return false
		const w = Math.max(1, screenW)
		const h = Math.max(1, screenH)
		const y = this.target[1]
		return this.writeViewCorner(out, 0, 0, 0, w, h, y)
			&& this.writeViewCorner(out, 2, w, 0, w, h, y)
			&& this.writeViewCorner(out, 4, w, h, w, h, y)
			&& this.writeViewCorner(out, 6, 0, h, w, h, y)
	}

	private writeViewCorner(
		out: Float32Array, offset: number,
		screenX: number, screenY: number, width: number, height: number, groundY: number,
	): boolean {
		if (!this.picker.setRay(this.view, this.proj, this.eye, screenX, screenY, width, height)) return false
		const o = this.picker.origin
		const d = this.picker.direction
		let t = Math.abs(d[1]) > 1e-5 ? (groundY - o[1]) / d[1] : -1
		if (!(t > 0.25)) {
			const horiz = Math.hypot(d[0], d[2])
			t = horiz > 1e-5 ? 160 / horiz : 160
		}
		if (t > 280) t = 280
		out[offset] = o[0] + d[0] * t
		out[offset + 1] = o[2] + d[2] * t
		return true
	}

	/** UI-owned strategic overview focus command; changes presentation only. */
	focusWorld(worldX: number, worldZ: number): void {
		if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) return
		const x = clamp(worldX, this.boundsMinX, this.boundsMaxX)
		const z = clamp(worldZ, this.boundsMinZ, this.boundsMaxZ)
		// A minimap jump preserves zoom, yaw and tilt, even at an edge or corner.
		this.targetGoal[0] = x
		this.targetGoal[2] = z
		this.clampFocusToFrustum(this.heightGoal)
		// A strategic-overview click is a discrete focus command, not continuous panning.
		// Snap both states so the actor drawn at the destination is immediately clickable;
		// keyboard and edge-scroll still update only targetGoal and retain their damping.
		v3.copy(this.target, this.targetGoal)
	}

	/** UI-owned selection entry point for local-base and overview-marker interactions. */
	selectActor(actorId: number): void {
		const actors = this.actors
		if (!actors || !Number.isInteger(actorId) || findActorIndex(actors, actorId) < 0) return
		this.selection.length = 1
		this.selection[0] = actorId
	}

	/** Keep contextual orders in lockstep with the UI's click or drag-selected group. */
	selectActors(actorIds: readonly number[]): void {
		const actors = this.actors
		this.selection.length = 0
		if (!actors) return
		for (let i = 0; i < actorIds.length && this.selection.length < MAX_SELECTION; i++) {
			const actorId = actorIds[i]
			if (!Number.isInteger(actorId) || findActorIndex(actors, actorId) < 0 || this.selection.includes(actorId)) continue
			this.selection.push(actorId)
		}
	}

	/** Drop selected ids that no longer exist, so a reused id cannot alias a dead one. */
	private pruneSelection(): void {
		const a = this.actors
		if (!a || this.selection.length === 0) return
		let w = 0
		for (let i = 0; i < this.selection.length; i++) {
			const id = this.selection[i]
			if (findActorIndex(a, id) >= 0) this.selection[w++] = id
		}
		this.selection.length = w
	}

	/** Currently selected actor ids. Read by `ui` for the selection panel. */
	get edgeScrollMask(): number {
		return this.edgeMask
	}

	/** Width of the edge-scroll band in CSS pixels, for a viewport of this size. */
	edgeBandPx(width: number, height: number): number {
		return Math.max(4, Math.min(Math.max(1, width), Math.max(1, height)) * EDGE_BAND)
	}

	/**
	 * Pan from an on-screen control, in view space: +right is screen-right, +forward is
	 * away from the viewer. One unit is one screen height of ground, so a press covers the
	 * same proportion of the view at every zoom.
	 */
	panByView(right: number, forward: number): void {
		if (right === 0 && forward === 0) return
		const scale = this.height
		const sin = Math.sin(this.yawRaw)
		const cos = Math.cos(this.yawRaw)
		this.targetGoal[0] += (right * cos + forward * sin) * scale
		this.targetGoal[2] += (-right * sin + forward * cos) * scale
		if (this.boundsKnown) this.clampFocusToFrustum(this.heightGoal, true)
	}

	/** Zoom from an on-screen control. Positive moves the camera closer, one notch per unit. */
	zoomByNotches(notches: number): void {
		if (notches === 0) return
		this.heightGoal = clamp(this.heightGoal * Math.exp(-notches * ZOOM_NOTCH),
			HEIGHT_MIN, this.maxHeightInsideMap())
		if (this.boundsKnown) this.clampFocusToFrustum(this.heightGoal, true)
	}

	/** Turn from an on-screen control, in radians, damped by update() like every other turn. */
	rotateBy(radians: number): void {
		this.yawGoal += radians
	}

	/** Pitch from an on-screen control, clamped to the same range the keyboard allows. */
	tiltBy(radians: number): void {
		this.tiltGoal = clamp(this.tiltGoal + radians, TILT_MIN, TILT_MAX)
	}

	/** Level the pitch and square the heading, the way the Home key does. */
	resetOrientation(): void {
		this.tiltGoal = 0
		this.yawGoal = Math.round(this.yawRaw / (Math.PI * 2)) * Math.PI * 2
	}

	get selected(): readonly number[] {
		return this.selection
	}

	update(dt: number, ctx: Ctx): void {
		this.tryAdoptTerrainBounds(ctx)
		this.readInput(dt, ctx)

		// Exponential approach rather than a raw lerp: a framerate-dependent pan feels
		// different on a 144 Hz display than on 60 Hz, and this camera is the most
		// motion-sensitive surface in the game.
		this.target[0] = damp(this.target[0], this.targetGoal[0], PAN_DAMP, dt)
		this.target[2] = damp(this.target[2], this.targetGoal[2], PAN_DAMP, dt)
		this.height = damp(this.height, this.heightGoal, ZOOM_DAMP, dt)
		this.yawRaw = damp(this.yawRaw, this.yawGoal, ROTATE_DAMP, dt)
		this.tilt = damp(this.tilt, this.tiltGoal, ROTATE_DAMP, dt)
		if (this.boundsKnown) {
			const maxHeight = this.maxHeightInsideMap()
			this.heightGoal = Math.min(this.heightGoal, maxHeight)
			this.height = Math.min(this.height, maxHeight)
			this.clampFocusToFrustum(this.height, true)
		}

		this.rebuildView()
		this.pushToRenderer(ctx)

		// UI resolves picking after this update, with the current camera matrix. It owns
		// selection and the sole contextual-order path into authoritative OpenRA targeters.
	}

	private readInput(dt: number, ctx: Ctx): void {
		const input = ctx.input
		const p = input.pointer

		let dx = 0
		let dz = 0

		if (input.isDown('KeyW') || input.isDown('ArrowUp')) dz -= 1
		if (input.isDown('KeyS') || input.isDown('ArrowDown')) dz += 1
		if (input.isDown('KeyA') || input.isDown('ArrowLeft')) dx -= 1
		if (input.isDown('KeyD') || input.isDown('ArrowRight')) dx += 1
		const rotating = input.isDown('KeyQ') || input.isDown('KeyE') || (p.buttons & 2) !== 0
		if (rotating) {
			// Orbit owns this gesture. A cursor parked at the edge must not add a pan,
			// including after release; a fresh pointer move will rearm edge scrolling.
			p.edgeReady = false
			if (dx === 0 && dz === 0) {
				this.targetGoal[0] = this.target[0]
				this.targetGoal[2] = this.target[2]
			}
		}

		let speed = KEY_SPEED
		let mask = 0
		if (dx === 0 && dz === 0 && !rotating && Math.abs(this.yawGoal - this.yawRaw) < 0.001 && p.inside && p.edgeReady && p.pointerType === 'mouse') {
			// Edge scroll. Uses the canvas' CSS size, not its backing size, so the band is
			// the same physical width regardless of device pixel ratio.
			const w = canvasCssWidth(ctx) || 1
			const h = canvasCssHeight(ctx) || 1
			const band = this.edgeBandPx(w, h)
			if (p.x < band) { dx -= 1; mask |= 1 }
			else if (p.x > w - band) { dx += 1; mask |= 2 }
			if (p.y < band) { dz -= 1; mask |= 4 }
			else if (p.y > h - band) { dz += 1; mask |= 8 }
			speed = EDGE_SPEED
		}
		this.edgeMask = mask

		if (dx !== 0 || dz !== 0) {
			// Pan speed scales with height: at max zoom-out a fixed metres-per-second crawl
			// would take an age to cross the map, and at max zoom-in it would overshoot.
			const scale = (speed * dt * this.height) / 60
			const inv = dx !== 0 && dz !== 0 ? Math.SQRT1_2 : 1

			// Pan is rotated INTO view space. "Forward" has to mean forward on screen, not
			// north — once the camera can turn, a world-locked pan sends W sideways or
			// backwards depending on where you are facing, which feels broken rather than
			// merely unusual.
			const s = Math.sin(this.yawRaw)
			const c = Math.cos(this.yawRaw)
			// Screen-right is (cos(yaw), -sin(yaw)); screen-down is the opposite
			// of camera-forward, (sin(yaw), cos(yaw)). The former signs applied the
			// inverse rotation, making edge scroll drift diagonally at non-zero yaw.
			this.targetGoal[0] += (dx * c + dz * s) * scale * inv
			this.targetGoal[2] += (-dx * s + dz * c) * scale * inv
		}
		if (p.panX !== 0 || p.panY !== 0) {
			// Two-finger pan: drag the map under the fingers. Same rotated-into-view
			// convention as the keyboard pan; metres-per-pixel tracks camera height so
			// the gesture moves the map exactly with the fingers at any zoom.
			const metresPerPx = this.height / (canvasCssHeight(ctx) || 720)
			const s = Math.sin(this.yawRaw)
			const c = Math.cos(this.yawRaw)
			this.targetGoal[0] += (p.panX * c + p.panY * s) * metresPerPx
			this.targetGoal[2] += (-p.panX * s + p.panY * c) * metresPerPx
		}

		// --- rotation ---
		// Q/E for keyboard, middle-drag for mouse. Both write `yawGoal`; the damped follow
		// in update() is what makes a turn read as a turn rather than a snap.
		let turn = 0
		if (input.isDown('KeyQ')) turn -= 1
		if (input.isDown('KeyE')) turn += 1
		if (turn !== 0) this.yawGoal += turn * ROTATE_SPEED * dt

		// Middle button held: drag horizontally to orbit. Uses raw pointer delta rather
		// than absolute position so it keeps working past the window edge.
		if ((p.buttons & 2) !== 0 && p.dx !== 0) this.yawGoal += p.dx * ROTATE_DRAG
		if ((p.buttons & 2) !== 0 && p.dy !== 0) this.tiltGoal += p.dy * .006
		// Z/X mirror PageUp/PageDown for tilt: Z pitches toward top-down, X back toward
		// the horizon. Same held-key semantics and rate as the Page pair.
		if (input.isDown('PageUp') || input.isDown('KeyZ')) this.tiltGoal += dt * .65
		if (input.isDown('PageDown') || input.isDown('KeyX')) this.tiltGoal -= dt * .65
		this.tiltGoal = clamp(this.tiltGoal, TILT_MIN, TILT_MAX)
		if (input.isDown('Home')) { this.tiltGoal = 0; this.yawGoal = Math.round(this.yawRaw / (Math.PI * 2)) * Math.PI * 2 }

		// H — back to base. `initialFocusX/Z` is the spawn this camera opened on, which is what
		// a player means by home; it survives the whole match and needs no search through the
		// actor list. Written to the GOAL, so the existing damping flies there rather than
		// teleporting: a cut would lose the player's sense of where the base is relative to
		// where they were looking.
		if (input.wasPressed('KeyH')) {
			if (Number.isFinite(this.initialFocusX) && Number.isFinite(this.initialFocusZ)) {
				this.targetGoal[0] = this.initialFocusX
				this.targetGoal[2] = this.initialFocusZ
			}
			this.tiltGoal = 0
			this.yawGoal = Math.round(this.yawRaw / (Math.PI * 2)) * Math.PI * 2
		}

		// T — the tactical view, as one gesture. Zooming out and tilting toward top-down are
		// the same intent (see the whole battle) and doing them separately is four keypresses,
		// so this pairs them and toggles: out goes to the map-limited ceiling at full tilt, and
		// pressing again returns to the height and tilt the player was at, not to a constant.
		// Restoring what they had is the difference between a shortcut and a reset.
		if (input.wasPressed('KeyT')) {
			if (this.tacticalView) {
				this.heightGoal = clamp(this.tacticalReturnHeight, HEIGHT_MIN, this.maxHeightInsideMap())
				this.tiltGoal = this.tacticalReturnTilt
				this.tacticalView = false
			} else {
				this.tacticalReturnHeight = this.heightGoal
				this.tacticalReturnTilt = this.tiltGoal
				this.heightGoal = this.maxHeightInsideMap()
				this.tiltGoal = TILT_MAX
				this.tacticalView = true
			}
		}

		// Y — snap to the closest inspection height. Written to the goal like every other
		// zoom, so the dive stays readable instead of teleporting the camera.
		if (input.wasPressed('KeyY')) this.heightGoal = HEIGHT_MIN

		if (p.wheel !== 0) {
			// Multiplicative zoom so each notch covers a constant proportion — linear zoom
			// feels fast when close and glacial when far.
			this.heightGoal = clamp(this.heightGoal * Math.exp(clamp(p.wheel,-300,300) * 0.0012), HEIGHT_MIN, this.maxHeightInsideMap())
		}
		if (p.pinch !== 0) {
			// Two-finger pinch shares the wheel's multiplicative zoom: the same
			// constant-proportion rule, driven by the log-scale gesture delta.
			this.heightGoal = clamp(this.heightGoal * Math.exp(clamp(p.pinch, -0.6, 0.6) * -2.2), HEIGHT_MIN, this.maxHeightInsideMap())
		}

		if (this.boundsKnown) this.clampFocusToFrustum(this.heightGoal, true)
	}

	private basePitch(height: number): number {
		const t = clamp((height - HEIGHT_MIN) / (HEIGHT_MAX - HEIGHT_MIN), 0, 1)
		return ((PITCH_NEAR + (PITCH_FAR - PITCH_NEAR) * t) * Math.PI) / 180
	}

	private pitchForHeight(height: number): number {
		return clamp(this.basePitch(height) + this.tilt, 28 * Math.PI / 180, 82 * Math.PI / 180)
	}

	private maxHeightInsideMap(): number {
		if (!this.boundsKnown) return HEIGHT_MAX
		return clamp(Math.max(this.boundsMaxX-this.boundsMinX,this.boundsMaxZ-this.boundsMinZ)*1.1,HEIGHT_MIN,HEIGHT_MAX)
	}

	private orientTowardMapCentre(focusX: number, focusZ: number): void {
		const dx = (this.boundsMinX + this.boundsMaxX) * 0.5 - focusX
		const dz = (this.boundsMinZ + this.boundsMaxZ) * 0.5 - focusZ
		if (Math.abs(dx) + Math.abs(dz) < 1e-4) return
		// Camera forward is (-sin(yaw), -cos(yaw)). Solve that convention once here.
		const inwardYaw = Math.atan2(-dx, -dz)
		this.yawRaw = inwardYaw
		this.yawGoal = inwardYaw
	}

	private clampFocusToFrustum(height: number, preserveCurrentFocus = false): void {
		// Clamp only the ground pivot. Frustum containment made allowable pan intervals
		// shrink with yaw/zoom until movement locked at the map edge. The camera eye and
		// part of the view may extend into the scenery apron throughout a full orbit.
		this.targetGoal[0] = clamp(this.targetGoal[0],this.boundsMinX,this.boundsMaxX)
		this.targetGoal[2] = clamp(this.targetGoal[2],this.boundsMinZ,this.boundsMaxZ)
		this.target[0] = clamp(this.target[0],this.boundsMinX,this.boundsMaxX)
		this.target[2] = clamp(this.target[2],this.boundsMinZ,this.boundsMaxZ)
	}

	private rebuildProjection(): void {
		m4.perspectiveReverseZ(this.proj, FOV_Y, this.aspect, NEAR_PLANE)
	}

	private rebuildView(): void {
		// Pitch interpolates with zoom: overhead when reading the whole battle, lower and
		// more dimensional when close. t=0 at HEIGHT_MIN, t=1 at HEIGHT_MAX.
		const pitch = this.pitchForHeight(this.height)

		// The camera orbits its focus at `yaw`, at `back` metres out and `height` up.
		// yaw = 0 puts it due south looking north, which is where it starts; a full turn is
		// reachable in either direction. Ground height under the focus is added so the view
		// stays consistent over hills rather than clipping into them.
		const back = this.height / Math.tan(pitch)
		const s = Math.sin(this.yawRaw)
		const c = Math.cos(this.yawRaw)
		this.eye[0] = this.target[0] + s * back
		this.eye[1] = this.target[1] + this.height
		this.eye[2] = this.target[2] + c * back

		m4.lookAt(this.view, this.eye, this.target, this.up)
	}

	private pushToRenderer(ctx: Ctx): void {
		// peek(), not get(): the camera must not hard-fail when `render` has not landed
		// yet. Rule 8 — never break the boot.
		const render = ctx.peek<{ setCamera(v: Float32Array, p: Float32Array, pos: Float32Array, focus?: Float32Array): void }>('render')
		render?.setCamera(this.view, this.proj, this.eye, this.target)
	}

	/**
	 * §14.8's LISTENER POSE, and the entire surface `audio` is permitted to see of the view.
	 *
	 * §14.8 ruled audio a sibling engine rather than a room inside the renderer, and named
	 * the seam it needs precisely: "a listener pose, a clock, and an occlusion query". The
	 * clock is `ctx.time`; the occlusion query is not built yet and is not needed by any voice
	 * that exists. This is the first member, and it is published HERE rather than read from
	 * `render.camera` on purpose — routing audio through the renderer to find out where the
	 * ear is would make audio depend on the renderer, which is the exact coupling §14.8
	 * forbids ("the renderer never imports audio; audio never imports the renderer").
	 *
	 * Two vectors, not a matrix: a listener has a position and something it faces, and handing
	 * out a view matrix would invite audio to start projecting things, which is renderer work.
	 * Both are live references to preallocated storage — reading them costs nothing per frame
	 * (rule 6), and they must be treated as READ-ONLY by every caller.
	 *
	 * If this seam ever needs a fourth member, §14.8 says to treat that as evidence the split
	 * is eroding and to raise it rather than widen it quietly.
	 */
	get listenerEye(): Readonly<Float32Array> {
		return this.eye
	}

	get listenerFocus(): Readonly<Float32Array> {
		return this.target
	}

	get focus(): Readonly<Float32Array> {
		return this.target
	}

	/** Ground height under the focus, so `terrain` can keep the camera above hills. */
	syncGroundHeight(ctx: Ctx): void {
		const terrain = ctx.peek<{ heightAt(x: number, z: number): number }>('terrain')
		if (!terrain) return

		const h = terrain.heightAt(this.target[0], this.target[2])
		if (!Number.isFinite(h)) return
		// Damped like pan and zoom: the focus crossing a terrace edge is a two-metre step in
		// the ground, and an eye that snaps by that much reads as a jolt. Snapped when the
		// gap is large (a minimap jump, a new map) so the camera never eases through a hill.
		if (this.groundDt <= 0 || Math.abs(h - this.target[1]) > 6) this.target[1] = h
		else this.target[1] = damp(this.target[1], h, PAN_DAMP, this.groundDt)
	}

	private groundDt = 0

	lateUpdate(dt: number, ctx: Ctx): void {
		this.groundDt = dt
		this.syncGroundHeight(ctx)
	}

	dispose(): void {
		// Holds no GPU resources — view and projection are plain matrices owned by this
		// node and released with it. Reset so a re-registered camera starts centred rather
		// than wherever the previous session left it.
		v3.set(this.target, 0, 0, 0)
		v3.set(this.targetGoal, 0, 0, 0)
		this.boundsKnown = false
		this.initialFocusApplied = false
		this.initialFocusX = Number.NaN
		this.initialFocusZ = Number.NaN
	}
}

// Exactly ONE system class is exported from a node's index.ts. main.ts discovers systems
// by scanning module exports for a static `id`, so an alias export of the same class
// registers it twice and the boot dies on "duplicate id". Type-only re-exports are fine;
// value aliases are not.
export type { SystemClass }
