// STEELSEED — shroud
// What the local player is allowed to see.
//
// §4.7 already crosses the bridge: the snapshot carries a run-length-encoded shroud section
// and `core/snapshot.ts` has decoded it since the bridge landed. Nothing has ever consumed it,
// so every actor in the world has been drawn to every player — which is not a cosmetic gap.
// An RTS in which you can see the enemy's whole base is a different game.
//
// Two separable things are called "shroud":
//
//   1. VISIBILITY — which actors may be drawn at all. A rule, and the one that changes play.
//   2. The DARKENING of unexplored ground. A picture, and it needs a texture, a bind group
//      and a shader change across three pipelines.
//
// This node owns the CPU truth and the rule. It forwards a changed complete grid through the
// RenderApi seam, while `render` alone owns the GPU texture and the colour treatment. Keeping
// the handle out of this node preserves rule 7's one-owner contract.
//
// FAIL CLOSED. The OpenRA host always emits authoritative shroud. Missing or zero-shroud is a
// contract failure and must never reveal units, audio, markers or unexplored terrain.

import type { Ctx, Snapshot } from '../core'
import { ShroudState } from '../core'

export interface ShroudApi {
	/**
	 * Whether the local player may currently SEE this cell — `visible`, not merely explored.
	 *
	 * Explored-but-not-visible is remembered terrain. Live actors still require current visibility;
	 * OpenRA FrozenUnderFog structures cross ABI v2 separately and are drawn only while this method
	 * reports explored through `stateAt`. Moving units never become client-invented last-known actors.
	 */
	isVisible(cellX: number, cellY: number): boolean
	/** Raw §4.7 state: 0 unexplored, 1 explored, 2 visible. Unknown reads as unexplored. */
	stateAt(cellX: number, cellY: number): number
	/** True when no producer has ever sent a valid shroud section. */
	readonly unmodelled: boolean
	/** Cells currently at `visible`. Diagnostic; a gate asserts it tracks the runs. */
	readonly visibleCells: number
	/** Bumps when the grid bytes change, so a minimap can reuse its terrain shade. */
	readonly revision: number
}

interface RenderApi {
	setShroud(cells: Uint8Array, w: number, h: number, originX: number, originY: number): void
}

export class Shroud implements ShroudApi {
	static id = 'shroud'
	static deps = ['render']

	private cells = new Uint8Array(0)
	private width = 0
	private height = 0
	private originX = 0
	private originY = 0
	private seen = false
	revision = 0
	private fingerprint = 0
	private visible = 0
	private render: RenderApi | null = null

	async init(ctx: Ctx): Promise<void> {
		this.render = ctx.get<RenderApi>('render')
	}

	get unmodelled(): boolean {
		return !this.seen
	}

	get visibleCells(): number {
		return this.visible
	}

	grid(): { cells: Uint8Array; width: number; height: number; originX: number; originY: number; seen: boolean } {
		return { cells: this.cells, width: this.width, height: this.height, originX: this.originX, originY: this.originY, seen: this.seen }
	}

	stateAt(cellX: number, cellY: number): number {
		if (!this.seen) return ShroudState.unexplored
		const localX = Math.floor(cellX) - this.originX
		const localY = Math.floor(cellY) - this.originY
		if (localX < 0 || localY < 0 || localX >= this.width || localY >= this.height) return ShroudState.unexplored
		return this.cells[localY * this.width + localX]
	}

	isVisible(cellX: number, cellY: number): boolean {
		return this.stateAt(cellX, cellY) === ShroudState.visible
	}

	onSnapshot(snap: Snapshot, _prev: Snapshot | null, _ctx: Ctx): void {
		const runs = snap.shroud ?? []
		// terrain.static is published ONCE per bridge now, so this must remember the dimensions
		// rather than expect them every tick — before 3c2a3d4 the fixture resent the whole
		// section 60 times a second and reading it per tick would have looked fine.
		const w = snap.terrainStatic?.w ?? this.width
		const h = snap.terrainStatic?.h ?? this.height
		if (w <= 0 || h <= 0) {
			this.seen = false
			this.visible = 0
			return
		}
		let changed = false
		if (w !== this.width || h !== this.height || this.cells.length !== w * h) {
			this.width = w
			this.height = h
			// Allocated on a MAP-SIZE change, not per frame — once per session in practice. The
			// alternative is preallocating for the largest map any producer might ever send,
			// which wastes the memory on every smaller one.
			this.cells = new Uint8Array(w * h) // rulecheck-allow rule 6: map resize, not a frame
			changed = true
			// A resized grid starts UNEXPLORED. Unknown visibility is never allowed to reveal
			// gameplay state.
		}

		// OpenRA emits a complete RLE grid every tick. Gaps are unexplored, and therefore clear
		// stale state. Apply in address order so the final grid can be compared in place without
		// allocating a second map-sized buffer every frame.
		const cells = this.cells
		const missing = runs.length === 0
		if (missing && this.seen) changed = true
		let fingerprint = runs.length + 1
		for (let i = 0; i < runs.length; i++) {
			const run = runs[i]
			fingerprint = (Math.imul(fingerprint ^ run.cellIndex, 0x9e3779b1) ^ run.runLength ^ (run.state << 16)) >>> 0
		}
		const ox = snap.world?.boundsLeft ?? this.originX
		const oy = snap.world?.boundsTop ?? this.originY
		if (ox !== this.originX || oy !== this.originY) changed = true
		// An unchanged grid is the common tick. Walking every cell of Europe here was
		// enough to miss a 120 Hz refresh on the snapshot frame.
		if (!changed && fingerprint === this.fingerprint) return
		this.fingerprint = fingerprint
		this.seen = !missing
		let cursor = 0
		for (let r = 0; r < runs.length; r++) {
			const run = runs[r]
			const addressedStart = Math.min(cells.length, run.cellIndex)
			const start = Math.max(cursor, addressedStart)
			for (; cursor < start; cursor++) {
				if (cells[cursor] !== ShroudState.unexplored) changed = true
				cells[cursor] = ShroudState.unexplored
			}
			const end = Math.min(cells.length, addressedStart + run.runLength)
			for (; cursor < end; cursor++) {
				if (cells[cursor] === run.state) continue
				cells[cursor] = run.state
				changed = true
			}
		}
		for (; cursor < cells.length; cursor++) {
			if (cells[cursor] !== ShroudState.unexplored) changed = true
			cells[cursor] = ShroudState.unexplored
		}

		// §4.2 bounds define the same cell origin terrain uses. Keep the previous origin on
		// delta ticks where world is omitted, just as dimensions survive terrain.static being
		// published once. An origin change is a map change even if its dimensions and cell
		// bytes happen to match.
		this.originX = ox
		this.originY = oy
		if (changed) {
			let visible = 0
			for (let i = 0; i < cells.length; i++) if (cells[i] === ShroudState.visible) visible++
			this.visible = visible
			this.revision++
			this.render?.setShroud(cells, w, h, ox, oy)
		}
	}

	dispose(): void {
		this.cells = new Uint8Array(0)
		this.width = 0
		this.height = 0
		this.originX = 0
		this.originY = 0
		this.seen = false
		this.visible = 0
		this.render = null
	}
}

export default Shroud
