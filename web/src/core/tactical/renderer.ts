// JOA tactical renderer, shared by the phone companion and the desktop tactical map (M).
//
// Layers, back to front: the "no data" ground, the reconnaissance terrain (terrain-art tiles),
// fog of the explored-but-unseen, movement heat clipped to visible cells, structures, units,
// groups and alerts, the target reticle, then the instrument frame. Symbols and labels keep
// their CSS-pixel size at every zoom; relationship reads from shape and outline, not colour
// alone. Everything drawn comes from the player-safe TacticalState.
import { isAircraft, isStructure, type Contact, type TacticalState } from './model'
import { LOD_PX, TerrainArt, TILE } from './terrain-art'
import { resolveVision, type VisionChoice, type VisionMode } from './vision'

export interface MapView {
	zoom: number
	/** Map centre as a fraction of the map's width and height. */
	x: number
	y: number
	heat: boolean
	selected: number | null
	target: { x: number; y: number } | null
	vision?: VisionChoice
	/** Fill the viewport (phone) rather than fit the whole map inside it (desktop overview). */
	cover?: boolean
	/** The instrument frame: rulers, scale, crosshair. Off for the desktop overview. */
	instruments?: boolean
	/** The first click of a two-click order (a Chronoshift's source). */
	source?: { x: number; y: number } | null
	/** Screen margins covered by interface (CSS px): labels stay out of them. */
	insets?: { top: number; right: number; bottom: number; left: number }
}
export const defaultView = (): MapView => ({ zoom: 1, x: 0.5, y: 0.5, heat: true, selected: null, target: null })

export function mapTransform(state: Pick<TacticalState, 'bounds'>, width: number, height: number, view: MapView): { scale: number; ox: number; oy: number } {
	const pad = view.cover ? 0 : 24
	const scale = (view.cover ? Math.max : Math.min)((width - pad) / state.bounds.w, (height - pad) / state.bounds.h) * view.zoom
	return { scale, ox: width / 2 - state.bounds.w * view.x * scale, oy: height / 2 - state.bounds.h * view.y * scale }
}
export function mapPoint(state: Pick<TacticalState, 'bounds'>, width: number, height: number, view: MapView, px: number, py: number): { x: number; y: number } {
	const { scale, ox, oy } = mapTransform(state, width, height, view)
	return { x: (px - ox) / scale + state.bounds.x, y: (py - oy) / scale + state.bounds.y }
}

/** Palette per vision mode: the instruments turn phosphor green at night, as a real sensor does. */
interface Palette { ground: string; dot: string; fog: [number, number, number, number]; ink: string; dim: string; line: string; hud: string; own: string; ally: string; enemy: string; neutral: string; heat: string; label: string; plate: string; accent: string }
const PALETTES: Record<VisionMode, Palette> = {
	day: { ground: '#070a0d', dot: 'rgba(125,185,200,.09)', fog: [9, 13, 17, 0.5], ink: '#E9E5DB', dim: '#A8B2BA', line: 'rgba(233,229,219,.14)', hud: '#E9E5DB', own: '#7DB9C8', ally: '#87BC91', enemy: '#FF6B63', neutral: '#A8B2BA', heat: '255,112,72', label: '#E9E5DB', plate: 'rgba(9,13,17,.78)', accent: '#C93630' },
	white: { ground: '#050606', dot: 'rgba(140,255,160,.07)', fog: [4, 5, 5, 0.58], ink: '#F2F5F2', dim: '#8FA897', line: 'rgba(140,255,160,.16)', hud: '#8CFF9E', own: '#F4F7F4', ally: '#D8E2DA', enemy: '#FFFFFF', neutral: '#9BA39D', heat: '255,255,255', label: '#8CFF9E', plate: 'rgba(0,0,0,.72)', accent: '#8CFF9E' },
	green: { ground: '#020703', dot: 'rgba(120,255,150,.08)', fog: [1, 7, 3, 0.6], ink: '#C9FFD4', dim: '#6FB883', line: 'rgba(120,255,150,.16)', hud: '#9CFFB0', own: '#D9FFE0', ally: '#A8F0B8', enemy: '#FFFFFF', neutral: '#5E9C6D', heat: '210,255,220', label: '#9CFFB0', plate: 'rgba(0,10,3,.72)', accent: '#9CFFB0' },
}

const MONO = "'Martian Mono', 'Martian Mono Variable', ui-monospace, monospace"

interface Cluster { contact: Contact; count: number; x: number; y: number }

/** Per-canvas renderer state: terrain tiles, the fog and heat masks, and what was drawn. */
export class TacticalRenderer {
	readonly terrain = new TerrainArt()
	private fog: HTMLCanvasElement | null = null
	private fogRef: unknown = null
	private fogMode: VisionMode | null = null
	private heatMask: HTMLCanvasElement | null = null
	private previousMode: VisionMode | null = null
	/** The vision mode the terrain shows, and a cross-fade to the wanted one when it is ready. */
	private shownMode: VisionMode | null = null
	private fade: { from: VisionMode; start: number } | null = null
	private modeChangedAt = 0
	stats = { frames: 0, lastMs: 0, lod: 0 }
	/** Screen rectangles already holding a label this frame: later labels that would overlap are dropped. */
	private placed: [number, number, number, number][] = []
	private insets: MapView['insets'] | null = null
	private viewport = { w: 0, h: 0 }

	/** Draws one frame; returns true while terrain is still being synthesised (draw again soon). */
	draw(canvas: HTMLCanvasElement, state: TacticalState, view: MapView, now = performance.now()): boolean {
		const t0 = performance.now()
		this.placed.length = 0
		this.insets = view.insets ?? null
		const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
		const width = canvas.clientWidth || canvas.width / dpr, height = canvas.clientHeight || canvas.height / dpr
		if (width <= 0 || height <= 0) return false
		if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr) }
		const g = canvas.getContext('2d')
		if (!g) return false
		const wanted = resolveVision(state, view.vision)
		this.terrain.update(state)
		this.viewport = { w: width, h: height }
		const { scale, ox, oy } = mapTransform(state, width, height, view), b = state.bounds
		// Visible tile range and level of detail.
		const cellPx0 = scale * dpr, lod0 = cellPx0 >= LOD_PX[1] * 0.85 ? 1 : 0
		const tx0 = Math.max(0, Math.floor(-ox / scale / TILE)), ty0 = Math.max(0, Math.floor(-oy / scale / TILE))
		const tx1 = Math.min(this.terrain.cols - 1, Math.floor((width - ox) / scale / TILE)), ty1 = Math.min(this.terrain.rows - 1, Math.floor((height - oy) / scale / TILE))
		// Vision changes cross-fade once the new mode's visible tiles exist, never tile by tile.
		if (!this.shownMode) this.shownMode = wanted
		if (wanted !== this.shownMode && !this.fade) {
			let ready = true
			for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
				this.terrain.tile(tx, ty, lod0, wanted)
				if (!this.terrain.has(tx, ty, lod0, wanted) && !this.terrain.has(tx, ty, 0, wanted)) ready = false
			}
			if (ready) this.fade = { from: this.shownMode, start: now }
			else this.terrain.work(8)
		}
		const fading = this.fade ? Math.min(1, (now - this.fade.start) / 450) : 1
		if (this.fade && fading >= 1) { this.shownMode = wanted; this.fade = null }
		const mode: VisionMode = this.fade ? wanted : this.shownMode!, pal = PALETTES[mode]
		if (this.previousMode !== mode) { this.modeChangedAt = now; this.previousMode = mode }
		const xy = (x: number, y: number): [number, number] => [ox + (x - b.x) * scale, oy + (y - b.y) * scale]

		g.setTransform(dpr, 0, 0, dpr, 0, 0)
		g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'
		// No data: the sensor's empty field, a faint dot lattice that pans with the map.
		g.fillStyle = pal.ground; g.fillRect(0, 0, width, height)
		const lattice = Math.max(12, scale * 4)
		g.fillStyle = pal.dot
		for (let y = ((oy % lattice) + lattice) % lattice; y < height; y += lattice) for (let x = ((ox % lattice) + lattice) % lattice; x < width; x += lattice) g.fillRect(x - 0.75, y - 0.75, 1.5, 1.5)

		// Terrain tiles at the level of detail the zoom needs; coarse tiles stand in while fine ones build.
		// The close-up level only once its pixels are at least as dense as the screen's: a large
		// downscale is costly (and pointless) on a software canvas. Upscaling stays bilinear.
		const cellPx = cellPx0, lod = lod0
		this.stats.lod = lod
		g.imageSmoothingEnabled = true; g.imageSmoothingQuality = cellPx / LOD_PX[lod] < 0.6 ? 'medium' : 'low'
		const layers: [VisionMode, number][] = this.fade ? [[this.fade.from, 1], [wanted, fading]] : [[mode, 1]]
		for (const [layerMode, alpha] of layers) {
			g.globalAlpha = alpha
			for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
				const tile = this.terrain.tile(tx, ty, lod, layerMode)
				if (!tile) continue
				// Tiles overlap by a hair so seams never show between neighbours.
				g.drawImage(tile, ox + tx * TILE * scale - 0.25, oy + ty * TILE * scale - 0.25, TILE * scale + 0.5, TILE * scale + 0.5)
			}
		}
		g.globalAlpha = 1
		// Whole-map level for every tile, in the background, so a fling never reaches an empty tile.
		if (lod === 1) for (let ty = 0; ty < this.terrain.rows; ty++) for (let tx = 0; tx < this.terrain.cols; tx++) this.terrain.tile(tx, ty, 0, mode)

		// Fog of the explored-but-unseen: one pixel per cell, smoothed by the scale-up.
		this.drawFog(g, state, mode, pal, ox, oy, scale)

		// Survey grid every 8 cells, subordinate to the ground.
		g.strokeStyle = pal.line; g.lineWidth = 0.6
		g.beginPath()
		const step = scale * 8 >= 36 ? 8 : 16
		for (let x = 0; x <= b.w; x += step) { g.moveTo(ox + x * scale, oy); g.lineTo(ox + x * scale, oy + b.h * scale) }
		for (let y = 0; y <= b.h; y += step) { g.moveTo(ox, oy + y * scale); g.lineTo(ox + b.w * scale, oy + y * scale) }
		g.stroke()
		g.strokeStyle = mode === 'day' ? 'rgba(233,229,219,.3)' : pal.line; g.lineWidth = 1
		g.strokeRect(ox, oy, b.w * scale, b.h * scale)

		if (view.heat) this.drawHeat(g, state, pal, ox, oy, scale)

		// Contacts: structures under units, remembered under live, selected group on top.
		const contacts = state.contacts.filter(c => c.role !== 'tree' && c.role !== 'rock')
		const structures = contacts.filter(c => isStructure(c.role))
		for (const c of structures) this.drawStructure(g, c, pal, mode, xy, scale, now)
		const clusters = this.cluster(contacts.filter(c => !isStructure(c.role)), xy, width, height, scale)
		const group = state.groups.find(gr => gr.id === view.selected)
		const members = new Set(group?.members ?? [])
		for (const cl of clusters) if (!members.has(cl.contact.id)) this.drawUnit(g, cl, pal, mode, scale)
		if (group) {
			const [gx, gy] = xy(group.x, group.y)
			const pulse = 0.5 + 0.5 * Math.sin(now / 320)
			g.strokeStyle = pal.hud; g.globalAlpha = 0.35 + pulse * 0.4; g.lineWidth = 1.2
			g.beginPath(); g.arc(gx, gy, 20 + pulse * 5, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1
			for (const cl of clusters) if (members.has(cl.contact.id)) this.drawUnit(g, cl, pal, mode, scale, true)
			this.tag(g, `G${group.id} · ${group.members.length}`, gx, gy - 30, pal, true)
		}
		// Building names once the zoom can hold them: own first, then hostile, never overlapping.
		// A building under fire names itself at any zoom.
		const attacked = structures.some(c => c.relation === 'own' && c.underAttack && !c.remembered)
		if (scale >= 7 || attacked) {
			const order = { own: 0, enemy: 1, ally: 2, neutral: 3 } as const
			for (const c of [...structures].sort((a, b) => order[a.relation] - order[b.relation])) {
				if (c.relation === 'neutral' && scale < 22) continue
				if (c.relation !== 'own' && scale < 10) continue
				if (c.relation === 'own' && scale < 7 && !(c.underAttack && !c.remembered)) continue
				const [x, y] = xy(c.x, c.y), h = Math.max(10, (c.footprint?.h ?? 2) * scale)
				this.label(g, c.remembered ? `${c.label} · last known` : c.label, x, y + h / 2 + 11, pal, c.remembered)
			}
		}
		for (const alert of state.alerts) {
			const [x, y] = xy(alert.x + 0.5, alert.y + 0.5), age = (state.time - alert.time) / 1000
			const ring = age < 4 ? (now / 900) % 1 : 0
			g.strokeStyle = mode === 'day' ? '#FF6B63' : pal.hud; g.lineWidth = 1.5
			g.beginPath(); g.arc(x, y, 16, 0, Math.PI * 2); g.stroke()
			if (ring) { g.globalAlpha = 1 - ring; g.beginPath(); g.arc(x, y, 16 + ring * 26, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1 }
		}
		if (view.source) this.reticle(g, xy(view.source.x + 0.5, view.source.y + 0.5), pal, now, 'SOURCE')
		if (view.target) this.reticle(g, xy(view.target.x + 0.5, view.target.y + 0.5), pal, now)

		if (view.instruments) this.instruments(g, state, view, pal, mode, width, height, scale, ox, oy)

		// Downlink progress while the first whole-map pass is still building.
		const pending = this.terrain.pending > 0
		if (pending) this.terrain.work(lod === 1 ? 10 : 7)
		this.stats.frames++; this.stats.lastMs = performance.now() - t0
		return this.terrain.pending > 0 || now - this.modeChangedAt < 600 || this.fade !== null || wanted !== this.shownMode
	}

	private fogged = false
	private drawFog(g: CanvasRenderingContext2D, state: TacticalState, mode: VisionMode, pal: Palette, ox: number, oy: number, scale: number): void {
		const { w, h } = state.bounds
		if (!this.fog) this.fog = document.createElement('canvas')
		if (this.fogRef !== state.visibility || this.fogMode !== mode || this.fog.width !== w || this.fog.height !== h) {
			this.fogged = state.visibility.includes(1)
			this.fog.width = w; this.fog.height = h
			const fg = this.fog.getContext('2d')!, image = fg.createImageData(w, h), data = image.data
			const [fr, fgc, fb, fa] = pal.fog
			for (let i = 0; i < w * h; i++) {
				const o = i * 4
				data[o] = fr; data[o + 1] = fgc; data[o + 2] = fb
				data[o + 3] = state.visibility[i] === 1 ? fa * 255 : 0
			}
			fg.putImageData(image, 0, 0)
			this.fogRef = state.visibility; this.fogMode = mode
		}
		if (!this.fogged) return
		g.imageSmoothingEnabled = true
		g.drawImage(this.fog, ox, oy, w * scale, h * scale)
	}

	private visMask: HTMLCanvasElement | null = null
	private visRef: unknown = null
	/** One pixel per cell, opaque where the cell is visible now. */
	private visibleMask(state: TacticalState): HTMLCanvasElement {
		const { w, h } = state.bounds
		if (!this.visMask) this.visMask = document.createElement('canvas')
		if (this.visRef !== state.visibility || this.visMask.width !== w || this.visMask.height !== h) {
			this.visMask.width = w; this.visMask.height = h
			const vg = this.visMask.getContext('2d')!, image = vg.createImageData(w, h)
			for (let i = 0; i < w * h; i++) if (state.visibility[i] === 2) { image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = 255; image.data[i * 4 + 3] = 255 }
			vg.putImageData(image, 0, 0)
			this.visRef = state.visibility
		}
		return this.visMask
	}

	/** Movement heat, painted at cell resolution and cut to the visible cells before it is scaled. */
	private drawHeat(g: CanvasRenderingContext2D, state: TacticalState, pal: Palette, ox: number, oy: number, scale: number): void {
		if (!state.heat.length) return
		const { w, h } = state.bounds, k = 4
		if (!this.heatMask) this.heatMask = document.createElement('canvas')
		const m = this.heatMask
		if (m.width !== w * k || m.height !== h * k) { m.width = w * k; m.height = h * k }
		const hg = m.getContext('2d')!
		hg.clearRect(0, 0, m.width, m.height)
		hg.globalCompositeOperation = 'lighter'
		for (const heat of state.heat) {
			const cx = (heat.x - state.bounds.x + 0.5) * k, cy = (heat.y - state.bounds.y + 0.5) * k
			const grad = hg.createRadialGradient(cx, cy, 0, cx, cy, k * 2.2)
			grad.addColorStop(0, `rgba(${pal.heat},${0.85 * heat.value})`); grad.addColorStop(1, `rgba(${pal.heat},0)`)
			hg.fillStyle = grad; hg.fillRect(cx - k * 2.2, cy - k * 2.2, k * 4.4, k * 4.4)
		}
		// Keep only what falls on currently visible cells: one mask draw, cell-sharp.
		hg.globalCompositeOperation = 'destination-in'
		hg.imageSmoothingEnabled = false
		hg.drawImage(this.visibleMask(state), 0, 0, m.width, m.height)
		hg.globalCompositeOperation = 'source-over'
		g.save(); g.globalCompositeOperation = 'lighter'; g.imageSmoothingEnabled = true
		g.drawImage(m, ox, oy, w * scale, h * scale)
		g.restore()
	}

	private cluster(units: Contact[], xy: (x: number, y: number) => [number, number], width: number, height: number, scale: number): Cluster[] {
		// Coarse zoom gathers nearby units of one relationship and category into a counted marker.
		const size = scale < 3 ? 34 : scale < 5 ? 26 : 0
		const out = new Map<string, Cluster>()
		for (const c of units) {
			const [x, y] = xy(c.x, c.y)
			if (x < -30 || y < -30 || x > width + 30 || y > height + 30) continue
			const category = c.role === 'soldier' ? 'inf' : isAircraft(c.role) ? 'air' : 'veh'
			const key = size ? `${c.relation}:${category}:${Math.floor(x / size)}:${Math.floor(y / size)}` : String(c.id)
			const cl = out.get(key)
			if (cl) { cl.x = (cl.x * cl.count + x) / (cl.count + 1); cl.y = (cl.y * cl.count + y) / (cl.count + 1); cl.count++ }
			else out.set(key, { contact: c, count: 1, x, y })
		}
		return [...out.values()]
	}

	private relationColor(c: Contact, pal: Palette, mode: VisionMode): string {
		if (mode !== 'day') return c.relation === 'neutral' ? pal.neutral : pal.own
		return c.relation === 'own' ? pal.own : c.relation === 'ally' ? pal.ally : c.relation === 'enemy' ? pal.enemy : pal.neutral
	}

	private drawStructure(g: CanvasRenderingContext2D, c: Contact, pal: Palette, mode: VisionMode, xy: (x: number, y: number) => [number, number], scale: number, now = 0): void {
		const [x, y] = xy(c.x, c.y)
		const w = Math.max(8, (c.footprint?.w ?? 1) * scale), h = Math.max(8, (c.footprint?.h ?? 1) * scale)
		g.save()
		g.globalAlpha = c.remembered ? 0.55 : 1
		// Taking fire: a breathing red ring and the hull bar, at any zoom — this building
		// is the one the commander needs to see, so it never waits for the label threshold.
		if (c.underAttack && !c.remembered) {
			const pulse = 0.5 + 0.5 * Math.sin(now / 300)
			g.strokeStyle = mode === 'day' ? '#FF6B63' : pal.hud; g.lineWidth = 2
			g.globalAlpha = 0.55 + pulse * 0.45
			g.strokeRect(x - w / 2 - 4 - pulse * 2, y - h / 2 - 4 - pulse * 2, w + 8 + pulse * 4, h + 8 + pulse * 4)
			g.globalAlpha = c.remembered ? 0.55 : 1
			if (c.health !== undefined) {
				const bar = Math.max(26, w + 8)
				g.globalAlpha = 1
				g.fillStyle = 'rgba(6,10,13,.8)'; g.fillRect(x - bar / 2, y - h / 2 - 12, bar, 5)
				g.fillStyle = c.health > 0.5 ? '#87BC91' : c.health > 0.25 ? '#E7B75F' : '#FF6B63'
				g.fillRect(x - bar / 2 + 1, y - h / 2 - 11, (bar - 2) * Math.max(0.02, c.health), 3)
			}
		}
		// Cast shadow, roof, ridge and the owner's colour on the roof edge.
		g.fillStyle = mode === 'day' ? 'rgba(4,8,10,.45)' : 'rgba(0,0,0,.5)'
		g.fillRect(x - w / 2 + Math.min(5, w * 0.12), y - h / 2 + Math.min(6, h * 0.16), w, h)
		const neutral = c.relation === 'neutral'
		const roof = mode === 'day' ? (neutral ? '#6E7470' : c.relation === 'enemy' ? '#B7A6A2' : c.relation === 'ally' ? '#A8B5A9' : '#A6B6BB') : mode === 'white' ? (neutral ? '#5E6560' : c.remembered ? '#8A918C' : '#E6EBE7') : (neutral ? '#2F5E3B' : c.remembered ? '#4F8C5E' : '#BFFFCB')
		if (neutral) g.globalAlpha *= 0.82
		g.fillStyle = roof; g.fillRect(x - w / 2, y - h / 2, w, h)
		if (mode === 'day') {
			const shade = g.createLinearGradient(x - w / 2, y - h / 2, x + w / 2, y + h / 2)
			shade.addColorStop(0, 'rgba(255,255,255,.18)'); shade.addColorStop(1, 'rgba(0,0,0,.22)')
			g.fillStyle = shade; g.fillRect(x - w / 2, y - h / 2, w, h)
		}
		g.strokeStyle = 'rgba(9,13,17,.7)'; g.lineWidth = 1
		g.strokeRect(x - w / 2 + 0.5, y - h / 2 + 0.5, w - 1, h - 1)
		if (w > 14 && h > 14) { g.strokeStyle = mode === 'day' ? 'rgba(9,13,17,.35)' : 'rgba(0,0,0,.25)'; g.beginPath(); g.moveTo(x - w / 2 + 3, y); g.lineTo(x + w / 2 - 3, y); g.stroke() }
		if (c.relation !== 'neutral') {
			const edge = this.relationColor(c, pal, mode)
			g.fillStyle = edge; g.fillRect(x - w / 2, y - h / 2, w, Math.max(2, Math.min(4, h * 0.14)))
			if (c.relation === 'enemy') this.brackets(g, x, y, w / 2 + 4, h / 2 + 4, mode === 'day' ? pal.enemy : pal.hud, 5)
		}
		// Role marks once the roof can hold them: a production building (the unfolded MCV is the
		// first one) wears a gantry corner, a superweapon a reactor core dot.
		if (w > 12 && h > 12) {
			if (c.role === 'factory' || c.role === 'barracks' || c.role === 'airfield') {
				g.strokeStyle = mode === 'day' ? 'rgba(9,13,17,.6)' : 'rgba(0,0,0,.45)'; g.lineWidth = 1.6
				g.beginPath(); g.moveTo(x - w / 2 + 3, y - h / 2 + 3); g.lineTo(x - w / 2 + 3, y - h / 2 + Math.min(10, h / 2 - 2)); g.moveTo(x - w / 2 + 3, y - h / 2 + 3); g.lineTo(x - w / 2 + Math.min(10, w / 2 - 2), y - h / 2 + 3); g.stroke()
			} else if (c.role === 'superweapon') {
				g.fillStyle = mode === 'day' ? 'rgba(9,13,17,.6)' : 'rgba(0,0,0,.45)'
				g.beginPath(); g.arc(x, y, 2.2, 0, Math.PI * 2); g.fill()
			}
		}
		if (c.remembered) { g.setLineDash([3, 3]); g.strokeStyle = pal.dim; g.strokeRect(x - w / 2 - 2, y - h / 2 - 2, w + 4, h + 4); g.setLineDash([]) }
		g.restore()
	}

	private drawUnit(g: CanvasRenderingContext2D, cl: Cluster, pal: Palette, mode: VisionMode, scale: number, selected = false): void {
		const c = cl.contact, color = this.relationColor(c, pal, mode), hot = mode !== 'day'
		const { x, y } = cl
		g.save(); g.translate(x, y)
		if (cl.count > 1 && cl.count < 4) {
			// A handful stays a tight knot of dots: numbers are for real concentrations.
			g.fillStyle = color; g.strokeStyle = 'rgba(9,13,17,.9)'; g.lineWidth = 1.2
			for (let i = 0; i < cl.count; i++) { const a = i * 2.4; g.beginPath(); g.arc(Math.cos(a) * 3.2, Math.sin(a) * 3.2, 2.8, 0, Math.PI * 2); g.fill(); g.stroke() }
			if (c.relation === 'enemy') this.brackets(g, 0, 0, 9, 9, hot ? pal.hud : pal.enemy, 3.5)
			g.restore(); return
		}
		if (cl.count > 1) {
			// A counted marker: the category glyph plus the number, enemy ones bracketed. The
			// glyph says what the blob is at any zoom: a dot walks, a wedge flies, a box drives.
			const text = String(cl.count)
			g.font = `600 10px ${MONO}`
			const w = 24 + g.measureText(text).width
			g.fillStyle = pal.plate; g.fillRect(-w / 2, -9, w, 18)
			g.fillStyle = color; g.fillRect(-w / 2, -9, 2.5, 18)
			g.fillStyle = pal.ink; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 7, 0.5)
			g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 1.4
			const category = c.role === 'soldier' ? 'inf' : isAircraft(c.role) ? 'air' : 'veh'
			if (category === 'inf') { g.beginPath(); g.arc(-w / 2 + 9, 0, 3, 0, Math.PI * 2); g.fill() }
			else if (category === 'air') { g.beginPath(); g.moveTo(-w / 2 + 9, -5); g.lineTo(-w / 2 + 14, 4); g.lineTo(-w / 2 + 9, 2); g.lineTo(-w / 2 + 4, 4); g.closePath(); g.fill() }
			else { g.beginPath(); g.rect(-w / 2 + 5, -4, 8, 8); g.fill() }
			if (c.relation === 'enemy') this.brackets(g, 0, 0, w / 2 + 3, 12, hot ? pal.hud : pal.enemy, 4)
			g.restore(); return
		}
		if (hot) { g.shadowColor = mode === 'white' ? 'rgba(255,255,255,.9)' : 'rgba(170,255,190,.9)'; g.shadowBlur = 8 }
		g.fillStyle = color; g.strokeStyle = mode === 'day' ? 'rgba(9,13,17,.9)' : 'rgba(0,0,0,.85)'; g.lineWidth = 1.5
		const zoomed = Math.min(1.35, Math.max(0.85, scale / 8))
		g.scale(zoomed, zoomed)
		if (!isStructure(c.role) && c.facing !== undefined && c.role !== 'soldier') g.rotate((c.facing * Math.PI * 2) / 1024)
		g.beginPath()
		if (c.role === 'soldier') { g.arc(0, 0, 3.6, 0, Math.PI * 2) }
		else if (c.role === 'rotorcraft') { g.arc(0, 0, 4.2, 0, Math.PI * 2) }
		else if (isAircraft(c.role)) { g.moveTo(0, -9); g.lineTo(7.5, 5); g.lineTo(0, 2.5); g.lineTo(-7.5, 5); g.closePath() }
		else if (c.role === 'ship' || c.role === 'submarine' || c.role === 'transport') { g.moveTo(0, -10); g.quadraticCurveTo(5, -4, 4, 8); g.lineTo(-4, 8); g.quadraticCurveTo(-5, -4, 0, -10) }
		// Wide, low and blunt: the harvester never reads as a fighting vehicle.
		else if (c.role === 'harvester') { g.roundRect(-7.5, -5, 15, 10, 1.5) }
		// A tall crate on wheels: the MCV reads as cargo until it unfolds.
		else if (c.role === 'mcv') { g.rect(-5.5, -7, 11, 13) }
		else { g.roundRect(-4.8, -6.5, 9.6, 13, 1.5) }
		g.fill(); g.shadowBlur = 0; g.stroke()
		if (c.role === 'tracked-vehicle' || c.role === 'wheeled-vehicle') {
			// Barrel and tracks: a tank is a gun with a hull under it.
			g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); g.moveTo(0, -1); g.lineTo(0, -11); g.stroke()
			g.strokeStyle = 'rgba(9,13,17,.85)'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(-5.6, -4); g.lineTo(-5.6, 4); g.moveTo(5.6, -4); g.lineTo(5.6, 4); g.stroke()
		}
		if (c.role === 'rotorcraft') { g.strokeStyle = 'rgba(9,13,17,.85)'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(-6.5, 0); g.lineTo(6.5, 0); g.moveTo(0, -6.5); g.lineTo(0, 6.5); g.stroke() }
		if (c.role === 'harvester') { g.fillStyle = 'rgba(9,13,17,.85)'; g.fillRect(-2.5, -2.5, 5, 5); g.fillRect(4.5, -3, 3.5, 6) }
		if (c.role === 'mcv') { g.strokeStyle = 'rgba(9,13,17,.85)'; g.lineWidth = 1.2; g.strokeRect(-3, -4.5, 6, 8); g.fillStyle = 'rgba(9,13,17,.85)'; g.beginPath(); g.arc(-2.5, 7, 1.5, 0, Math.PI * 2); g.arc(2.5, 7, 1.5, 0, Math.PI * 2); g.fill() }
		g.restore()
		if (c.relation === 'enemy' && scale >= 3) this.brackets(g, x, y, 10, 10, hot ? pal.hud : pal.enemy, 4)
		if (selected) { g.strokeStyle = pal.hud; g.lineWidth = 1; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.stroke() }
	}

	/** Track brackets: four corners, the surveillance "box" around a hostile. */
	private brackets(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string, arm: number): void {
		g.strokeStyle = color; g.lineWidth = 1.2
		g.beginPath()
		for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
			const cx = x + sx * rx, cy = y + sy * ry
			g.moveTo(cx, cy - sy * arm); g.lineTo(cx, cy); g.lineTo(cx - sx * arm, cy)
		}
		g.stroke()
	}

	private reticle(g: CanvasRenderingContext2D, [x, y]: [number, number], pal: Palette, now: number, text?: string): void {
		const spin = (now / 2400) % (Math.PI * 2)
		g.save(); g.strokeStyle = pal.hud; g.lineWidth = 1.4
		g.beginPath(); g.arc(x, y, 14, spin, spin + Math.PI * 0.6); g.moveTo(x + 14 * Math.cos(spin + Math.PI), y + 14 * Math.sin(spin + Math.PI)); g.arc(x, y, 14, spin + Math.PI, spin + Math.PI * 1.6); g.stroke()
		g.beginPath(); g.moveTo(x - 24, y); g.lineTo(x - 8, y); g.moveTo(x + 8, y); g.lineTo(x + 24, y); g.moveTo(x, y - 24); g.lineTo(x, y - 8); g.moveTo(x, y + 8); g.lineTo(x, y + 24); g.stroke()
		g.fillStyle = pal.accent; g.fillRect(x - 1.5, y - 1.5, 3, 3)
		g.restore()
		if (text) this.tag(g, text, x, y - 32, pal, false)
	}

	private tag(g: CanvasRenderingContext2D, text: string, x: number, y: number, pal: Palette, strong: boolean): void {
		g.font = `600 10px ${MONO}`
		const w = g.measureText(text).width + 12
		g.fillStyle = strong ? pal.hud : pal.plate
		g.beginPath(); g.moveTo(x - w / 2 + 4, y - 9); g.lineTo(x + w / 2, y - 9); g.lineTo(x + w / 2, y + 5); g.lineTo(x + w / 2 - 4, y + 9); g.lineTo(x - w / 2, y + 9); g.lineTo(x - w / 2, y - 5); g.closePath(); g.fill()
		g.fillStyle = strong ? '#090D11' : pal.label; g.textAlign = 'center'; g.textBaseline = 'middle'
		g.fillText(text, x, y + 0.5)
	}

	private label(g: CanvasRenderingContext2D, text: string, x: number, y: number, pal: Palette, muted: boolean): void {
		g.font = `500 9px ${MONO}`
		const t = text.toUpperCase(), w = g.measureText(t).width + 10
		const r: [number, number, number, number] = [x - w / 2 - 2, y - 9, w + 4, 18]
		const inset = this.insets
		if (inset && (r[0] < inset.left || r[1] < inset.top || r[0] + r[2] > this.viewport.w - inset.right || r[1] + r[3] > this.viewport.h - inset.bottom)) return
		if (this.placed.some(p => r[0] < p[0] + p[2] && r[0] + r[2] > p[0] && r[1] < p[1] + p[3] && r[1] + r[3] > p[1])) return
		this.placed.push(r)
		g.fillStyle = pal.plate; g.fillRect(x - w / 2, y - 7.5, w, 15)
		g.fillStyle = muted ? pal.dim : pal.label; g.textAlign = 'center'; g.textBaseline = 'middle'
		g.fillText(t, x, y + 0.5)
	}

	/** The instrument frame: scale ruler, grid readout, crosshair and corner marks. */
	private instruments(g: CanvasRenderingContext2D, state: TacticalState, view: MapView, pal: Palette, mode: VisionMode, width: number, height: number, scale: number, ox: number, oy: number): void {
		const hud = pal.hud
		g.save()
		// Vignette: a sensor's falloff, stronger for the image intensifier.
		const v = g.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.hypot(width, height) * 0.62)
		v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, mode === 'green' ? 'rgba(0,8,2,.62)' : mode === 'white' ? 'rgba(0,0,0,.5)' : 'rgba(4,7,10,.42)')
		g.fillStyle = v; g.fillRect(0, 0, width, height)
		// Crosshair at the viewport centre.
		const cx = width / 2, cy = height / 2
		g.strokeStyle = hud; g.globalAlpha = 0.55; g.lineWidth = 1
		g.beginPath(); g.moveTo(cx - 18, cy); g.lineTo(cx - 6, cy); g.moveTo(cx + 6, cy); g.lineTo(cx + 18, cy); g.moveTo(cx, cy - 18); g.lineTo(cx, cy - 6); g.moveTo(cx, cy + 6); g.lineTo(cx, cy + 18); g.stroke()
		g.globalAlpha = 1
		// Bottom ruler: a tick per column group, labelled with the grid column. It sits above
		// whatever interface floats over the map's foot (the tablet's dock).
		const foot = Math.max(0, (this.insets?.bottom ?? 24) - 24)
		const rulerY = height - 8 - foot
		g.font = `500 9px ${MONO}`; g.textAlign = 'center'; g.textBaseline = 'bottom'
		const every = scale * 8 >= 44 ? 8 : scale * 16 >= 44 ? 16 : 32
		const firstCol = Math.max(0, Math.ceil(-ox / scale / every) * every)
		g.strokeStyle = hud; g.fillStyle = hud; g.globalAlpha = 0.7
		for (let col = firstCol; col <= state.bounds.w; col += every) {
			const x = ox + col * scale
			if (x < 150 || x > width - 70) continue
			g.beginPath(); g.moveTo(x, rulerY); g.lineTo(x, rulerY + 7); g.stroke()
			g.fillText(String(col).padStart(3, '0'), x, rulerY - 2)
			for (let m = 1; m < 4; m++) { const mx = x + (m * every * scale) / 4; if (mx > 150 && mx < width - 70) { g.beginPath(); g.moveTo(mx, rulerY + 3.5); g.lineTo(mx, rulerY + 7); g.stroke() } }
		}
		// Left ruler: grid rows.
		g.textAlign = 'left'; g.textBaseline = 'middle'
		const firstRow = Math.max(0, Math.ceil(-oy / scale / every) * every)
		for (let row = firstRow; row <= state.bounds.h; row += every) {
			const y = oy + row * scale
			if (y < 130 || y > height - 60 - foot) continue
			g.beginPath(); g.moveTo(6, y); g.lineTo(13, y); g.stroke()
			g.fillText(String(row).padStart(3, '0'), 16, y)
		}
		g.globalAlpha = 1
		// Scale bar: ten cells.
		const bar = 10 * scale, bx = 16, by = height - 14 - foot
		if (bar < width * 0.4) {
			g.strokeStyle = hud; g.lineWidth = 1.2
			g.beginPath(); g.moveTo(bx, by - 4); g.lineTo(bx, by); g.lineTo(bx + bar, by); g.lineTo(bx + bar, by - 4); g.stroke()
			g.fillStyle = hud; g.font = `500 9px ${MONO}`; g.textAlign = 'left'; g.textBaseline = 'bottom'
			g.fillText('10 CELLS', bx, by - 6)
		}
		void view
		g.restore()
	}
}

const renderers = new WeakMap<HTMLCanvasElement, TacticalRenderer>()
export function tacticalRenderer(canvas: HTMLCanvasElement): TacticalRenderer {
	let r = renderers.get(canvas)
	if (!r) { r = new TacticalRenderer(); renderers.set(canvas, r) }
	return r
}

/** Draw one frame of the shared tactical map; true while terrain is still building. */
export function drawTactical(canvas: HTMLCanvasElement, state: TacticalState, view = defaultView()): boolean {
	return tacticalRenderer(canvas).draw(canvas, state, view)
}
