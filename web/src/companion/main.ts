// JOA Tactical Companion: the phone and tablet surface.
//
// It receives the primary player's player-safe TacticalState and sends typed intents back;
// it runs neither the engine nor the 3D game. Layout: the reconnaissance map fills the screen,
// the instruments float over it, and groups, support and alerts open in a sheet that leaves the
// map visible. The main game stays in command: every order is validated there.
import { loadBrandFonts } from '../brand-fonts'
import { decodeFrame } from '../core/tactical/transport'
import { loadCompanionConfig } from '../core/net-config'
import { defaultView, mapPoint, mapTransform, tacticalRenderer, type MapView } from '../core/tactical/renderer'
import { resolveVision, visionLabel, type VisionChoice } from '../core/tactical/vision'
import { icon, supportIconFor, type HudIcon } from '../core/tactical/icons'
import { TAUNTS, tauntById } from '../core/tactical/taunts'
import { REQUESTS } from '../core/tactical/requests'
import { joaMark } from '../core/tactical/logo'
import { isStructure, type Permission, type TacticalState, type Power } from '../core/tactical/model'
import type { CompanionIntent } from '../core/tactical/commands'
import '../core/tactical/style.css'
import './companion.css'

loadBrandFonts()

// --- Markup -------------------------------------------------------------------------------------
document.body.innerHTML = `
<main class="joa-live" aria-label="JOA tactical companion">
	<section class="joa-map" aria-label="Tactical battlefield">
		<canvas aria-label="Battlefield map. Drag to pan, pinch or scroll to zoom, double-tap to zoom in, tap to set a target."></canvas>
		<header class="joa-top">
			<div class="joa-brand">${joaMark(26)}<span class="joa-brand__word">JOA</span></div>
			<div class="joa-top__right">
				<div class="joa-link" role="status"><span class="joa-link__dot" aria-hidden="true"></span><span data-link>Awaiting link</span></div>
				<button class="joa-sound" data-sound type="button" aria-pressed="true" aria-label="Companion sounds">${icon('sound')}</button>
			</div>
		</header>
		<div class="joa-readout" aria-hidden="true"><span data-rec class="joa-rec">REC</span><span data-mode>SAT · AUTO</span><span data-clock>T+00:00</span><span data-zoom>1.0×</span></div>
		<div class="joa-forces" aria-label="Your forces"></div>
		<div class="joa-legend" aria-hidden="true"><i>${icon('troops')}<span>infantry</span></i><i>${icon('tank')}<span>vehicles</span></i><i>${icon('aircraft')}<span>aircraft</span></i><i>${icon('harvester')}<span>harvester</span></i><i>${icon('base')}<span>MCV / yard</span></i></div>
		<div class="joa-rail" role="toolbar" aria-label="Map controls">
			<button data-tab="taunts" aria-label="Taunts">${icon('taunt')}</button>
			<button data-zoom="1" aria-label="Zoom in">${icon('plus')}</button>
			<button data-zoom="-1" aria-label="Zoom out">${icon('minus')}</button>
			<button data-fit aria-label="Fit battlefield">${icon('fit')}</button>
			<button data-base aria-label="Centre on your base">${icon('base')}</button>
			<span class="joa-rail__gap" aria-hidden="true"></span>
			<button data-heat aria-label="Movement heat" aria-pressed="true">${icon('heat')}</button>
			<button data-vision aria-label="Vision mode: Auto">${icon('vision')}<span data-vision-badge>A</span></button>
		</div>
		<div class="joa-toast" role="status" hidden></div>
		<div class="joa-nuke" role="alert" hidden><span>INCOMING NUKE</span><strong data-nuke-clock>00:00</strong></div>
		<div class="joa-downlink" aria-hidden="true" hidden><span>Downlink</span><i><b></b></i><em data-downlink>0%</em></div>
		<div class="joa-verdict" data-verdict role="status" hidden><p class="joa-kicker" data-verdict-kicker>Uplink</p><h2 data-verdict-title></h2><small data-verdict-note></small></div>
	</section>
	<section class="joa-sheet" aria-live="polite" hidden></section>
	<div class="joa-aim" hidden><span class="joa-aim__icon" aria-hidden="true"></span><span class="joa-aim__text" role="status"><strong data-aim-title></strong><small data-aim-hint></small></span><button type="button" class="joa-aim__cancel" data-aim-cancel aria-label="Cancel aiming">${icon('plus')}</button><div class="joa-aim__modes" role="group" aria-label="Group order"></div></div>
	<nav class="joa-dock" aria-label="Companion tools">
		<button data-tab="map" aria-selected="true">${icon('map')}<span>Map</span></button>
		<button data-tab="groups">${icon('groups')}<span>Groups</span></button>
		<button data-tab="support">${icon('support')}<span>Support</span></button>
		<button data-tab="ask">${icon('ask')}<span>Ask</span></button>
		<button data-tab="alerts">${icon('alerts')}<span>Alerts</span><i data-alert-count hidden></i></button>
		<button data-tab="stats">${icon('stats')}<span>Stats</span></button>
	</nav>
</main>
<section class="joa-connect" aria-labelledby="joa-connect-title">
	<div class="joa-connect__sky" aria-hidden="true">
		<svg class="joa-orbit" viewBox="0 0 400 400">
			<defs><radialGradient id="joa-globe" cx="45%" cy="40%" r="60%"><stop offset="0" stop-color="#1d2a31"/><stop offset=".72" stop-color="#0d1419"/><stop offset="1" stop-color="#090d11"/></radialGradient>
			<clipPath id="joa-globe-clip"><circle cx="200" cy="210" r="118"/></clipPath></defs>
			<circle cx="200" cy="210" r="118" fill="url(#joa-globe)" stroke="rgba(125,185,200,.35)"/>
			<g clip-path="url(#joa-globe-clip)" stroke="rgba(125,185,200,.16)" fill="none">
				<ellipse cx="200" cy="210" rx="118" ry="40"/><ellipse cx="200" cy="210" rx="118" ry="84"/><line x1="82" y1="210" x2="318" y2="210"/>
				<ellipse cx="200" cy="210" rx="40" ry="118"/><ellipse cx="200" cy="210" rx="84" ry="118"/><line x1="200" y1="92" x2="200" y2="328"/>
			</g>
			<path class="joa-orbit__beam" d="M200 210 L150 120 L250 120 Z" fill="url(#joa-beam)"/>
			<defs><linearGradient id="joa-beam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="rgba(201,54,48,.0)"/><stop offset="1" stop-color="rgba(201,54,48,.28)"/></linearGradient></defs>
			<g class="joa-orbit__ring"><ellipse cx="200" cy="200" rx="176" ry="62" fill="none" stroke="rgba(233,229,219,.22)" stroke-dasharray="2 6" transform="rotate(-18 200 200)"/></g>
			<g class="joa-orbit__sat"><rect x="-7" y="-4" width="14" height="8" fill="#E9E5DB"/><rect x="-22" y="-2.5" width="12" height="5" fill="#C93630"/><rect x="10" y="-2.5" width="12" height="5" fill="#C93630"/></g>
			<circle class="joa-orbit__ping" cx="226" cy="236" r="4" fill="#C93630"/>
		</svg>
	</div>
	<div class="joa-connect__body">
		<p class="joa-kicker">Redline Wars · Tactical companion</p>
		<h1 id="joa-connect-title"><span class="joa-connect__mark">${joaMark(56)}</span>JOA</h1>
		<p class="joa-connect__sub">Joint Operations Assistant</p>
		<p class="joa-connect__lede">Your battlefield from orbit. Follow revealed movement, command your groups and call in support. The main game stays in command.</p>
		<form class="joa-code">
			<label class="joa-code__label" for="joa-code">Pairing code</label>
			<div class="joa-code__field"><input id="joa-code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="8" placeholder="········" aria-label="Eight character pairing code" required><span class="joa-code__cells" aria-hidden="true">${'<i></i>'.repeat(8)}</span></div>
			<button class="joa-btn joa-btn--primary" type="submit"><span>Connect</span><span class="joa-btn__arrow" aria-hidden="true">→</span></button>
		</form>
		<p class="joa-connect__status" data-pair-status role="status">Open Companion in the main game to get your code.</p>
	</div>
	<p class="joa-connect__foot">A Jolyn Studios production</p>
</section>`

const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const canvas = $<HTMLCanvasElement>('canvas'), mapBox = $<HTMLElement>('.joa-map')
const linkText = $<HTMLElement>('[data-link]'), connectScreen = $<HTMLElement>('.joa-connect'), sheet = $<HTMLElement>('.joa-sheet')
const toast = $<HTMLElement>('.joa-toast'), pairStatus = $<HTMLElement>('[data-pair-status]'), forces = $<HTMLElement>('.joa-forces')
const renderer = tacticalRenderer(canvas)

// --- State --------------------------------------------------------------------------------------
let ws: WebSocket | null = null
let state: TacticalState | null = null
let tier: Permission = 'information'
let paused = false
let lastState = 0
let latestSequence = 0
let tab: 'map' | 'groups' | 'support' | 'ask' | 'alerts' | 'stats' | 'taunts' = 'map'
let selectedGroup: number | undefined
/** A tapped own structure: the sheet shows its hull and the repair order. */
let selectedBuilding: number | undefined
let power: string | undefined
let aircraft: number | undefined
let action: CompanionIntent['action'] = 'move'
let source: { x: number; y: number } | undefined
let resume: { id: string; token: string } | null = null
/** The link survives a reload, or a phone discarding the tab: the resume token lives with this tab only. */
const RESUME_KEY = 'joa-resume'
function keepResume(value: typeof resume): void {
	resume = value
	try { if (value) sessionStorage.setItem(RESUME_KEY, JSON.stringify(value)); else sessionStorage.removeItem(RESUME_KEY) } catch { /* storage off: the link lasts as long as the page */ }
}
function storedResume(): typeof resume {
	try { const v = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? 'null'); return typeof v?.id === 'string' && typeof v?.token === 'string' ? { id: v.id, token: v.token } : null } catch { return null }
}
let retry: number | undefined
let previousContacts: TacticalState['contacts'] = []
let receivedAt = 0
let framedSession = ''
let vision: VisionChoice = 'auto'
let seenAlerts = 0
/** Taunts: the relay allows one every few seconds; the buttons rest for the same time. */
const TAUNT_REST_MS = 4000
let tauntAt = 0
/** Each ask carries its own glyph on the phone; the words live in the shared module. */
const REQUEST_MARKS: Record<string, HudIcon> = {
	'new-attack-group': 'groups', 'attack-now': 'attack', 'tank-battalion': 'tank', 'rifle-battalion': 'troops',
	'fill-groups': 'troops', aircraft: 'aircraft', paratroopers: 'para', nuke: 'nuke', harvesters: 'harvester', defenses: 'repair',
}
const REQUEST_REST_MS = 6000
let requestAt = 0
/** Aiming: an order waits for its map target, so the sheet steps aside for the map. */
let aiming = false
const view: MapView = { ...defaultView(), cover: true, instruments: true, insets: { top: 104, right: 64, bottom: 24, left: 40 } }

// --- Messages -----------------------------------------------------------------------------------
let toastTimer: number | undefined
function message(text: string, kind: 'info' | 'ok' | 'warn' = 'info'): void {
	clearTimeout(toastTimer)
	toast.textContent = text
	toast.dataset.kind = kind
	toast.hidden = false
	toastTimer = window.setTimeout(() => { toast.hidden = true }, 5200)
}
const send = (value: unknown): void => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)) }
const live = (): boolean => !!state && ws?.readyState === WebSocket.OPEN && Date.now() - lastState < 2500 && !paused && !state.paused && !state.ended
const available = (): boolean => live() && tier !== 'information'

// --- Rendering loop: frames only while something moves ------------------------------------------
let frame = 0
function requestFrame(): void { if (!frame) frame = requestAnimationFrame(drawFrame) }
function drawFrame(now: number): void {
	frame = 0
	if (!state || document.hidden) return
	let busy = stepAnimation(now)
	const alpha = Math.min(1, Math.max(0, (now - receivedAt) / 200))
	let shown = state
	if (alpha < 1) {
		busy = true
		const prior = new Map(previousContacts.map(c => [c.id, c]))
		const b = state.bounds
		shown = { ...state, contacts: state.contacts.map(c => {
			const p = prior.get(c.id)
			if (!p || c.remembered) return c
			const x = p.x + (c.x - p.x) * alpha, y = p.y + (c.y - p.y) * alpha
			const index = (Math.floor(y) - b.y) * b.w + Math.floor(x) - b.x
			// A contact never glides through a cell the player cannot see.
			return c.relation !== 'own' && state!.visibility[index] !== 2 ? c : { ...c, x, y }
		}) }
	}
	view.vision = vision
	busy = renderer.draw(canvas, shown, view, now) || busy
	drawOverlays(shown, now)
	if (selectedGroup !== undefined || view.target || view.source || state.alerts.some(a => state!.time - a.time < 4000) || state.contacts.some(c => c.underAttack) || (state.launches?.some(l => l.allied && l.secondsLeft > 0) ?? false)) busy = true
	updateReadout()
	if (busy) requestFrame()
}

/** The frame's own marks, above the renderer's ground: a ring around the selected group, and
 * tracer streaks standing in for the fire a snapshot only reports (a contact under attack is
 * true, its bullets are not drawn — the nearest hostile stands in for the shooter). */
function drawOverlays(shown: TacticalState, now: number): void {
	const g = canvas.getContext('2d')
	if (!g) return
	const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
	g.setTransform(dpr, 0, 0, dpr, 0, 0)
	const { scale, ox, oy } = mapTransform(shown, canvas.clientWidth, canvas.clientHeight, view), b = shown.bounds
	const sx = (x: number): number => ox + (x - b.x) * scale, sy = (y: number): number => oy + (y - b.y) * scale
	// A ring around the whole group: the members' spread sets its radius, so it reads as one
	// formation whatever the phone's zoom. Its dashes crawl slowly, a radar's track.
	if (selectedGroup !== undefined) {
		const group = shown.groups.find(gr => gr.id === selectedGroup)
		const members = group ? group.members.map(id => shown.contacts.find(c => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c) : []
		if (group && members.length > 0) {
			const cx = members.reduce((sum, c) => sum + c.x, 0) / members.length, cy = members.reduce((sum, c) => sum + c.y, 0) / members.length
			const cells = Math.max(1.6, Math.max(...members.map(c => Math.hypot(c.x - cx, c.y - cy))) + 1.1)
			const px = Math.max(20, cells * scale)
			g.save()
			g.strokeStyle = 'rgba(201, 54, 48, .92)'
			g.lineWidth = 2
			g.setLineDash([10, 7])
			g.lineDashOffset = -(now / 40) % 17
			g.shadowColor = 'rgba(201, 54, 48, .8)'
			g.shadowBlur = 10
			g.beginPath()
			g.arc(sx(cx), sy(cy), px, 0, Math.PI * 2)
			g.stroke()
			g.restore()
			g.font = '600 10px "Martian Mono", ui-monospace, monospace'
			g.fillStyle = 'rgba(233, 229, 219, .92)'
			g.textAlign = 'center'
			g.fillText(`GROUP ${selectedGroup}`, sx(cx), sy(cy) - px - 8)
		}
	}
	// Tracers: two streaks per attacker of an own contact that is under attack, travelling the
	// shooter's line. The phase is seeded from the ids (§5: no Math.random), so a streak keeps
	// its own rhythm without any state carried between frames.
	let tracers = 0
	for (const target of shown.contacts) {
		if (tracers >= 12 || !target.underAttack || target.remembered) continue
		const shooters = shown.contacts
			.filter(c => c.relation === 'enemy' && !c.remembered && c.role !== 'tree' && c.role !== 'rock')
			.map(c => ({ c, d: Math.hypot(c.x - target.x, c.y - target.y) }))
			.filter(e => e.d > 0.5 && e.d < 14).sort((a, b2) => a.d - b2.d).slice(0, 2)
		for (const { c: shooter } of shooters) {
			for (let k = 0; k < 2; k++) {
				const seed = (((target.id * 2654435761) ^ (shooter.id * 40503) ^ (k * 97)) >>> 0) % 1000 / 1000
				const p = ((now / 900 + seed) % 1)
				const dx = target.x - shooter.x, dy = target.y - shooter.y, len = Math.hypot(dx, dy) || 1
				const ux = dx / len, uy = dy / len
				const hx = shooter.x + dx * p, hy = shooter.y + dy * p
				const tail = Math.min(1.4, 9 / scale + 0.4)
				g.strokeStyle = p < 0.85 ? 'rgba(255, 215, 94, .85)' : 'rgba(255, 107, 99, .55)'
				g.lineWidth = 1.5
				g.beginPath()
				g.moveTo(sx(hx - ux * tail), sy(hy - uy * tail))
				g.lineTo(sx(hx), sy(hy))
				g.stroke()
				tracers++
				if (tracers >= 12) break
			}
			if (tracers >= 12) break
		}
	}
	// An own missile in flight: its target wears a closing ring with the countdown beside it —
	// light, and the map's own answer to the launch the whole match can see coming.
	for (const launch of shown.launches ?? []) {
		if (!launch.allied || launch.secondsLeft <= 0 || (!launch.targetX && !launch.targetY)) continue
		const x = sx(launch.targetX), y = sy(launch.targetY)
		const fraction = Math.min(1, launch.secondsLeft / 30)
		g.save()
		g.strokeStyle = 'rgba(255, 107, 99, .9)'
		g.lineWidth = 1.6
		g.setLineDash([6, 5])
		g.lineDashOffset = (now / 30) % 11
		g.beginPath(); g.arc(x, y, 14 + fraction * 26, 0, Math.PI * 2); g.stroke()
		g.setLineDash([])
		g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fillStyle = 'rgba(255, 107, 99, .95)'; g.fill()
		g.font = '600 11px "Martian Mono", ui-monospace, monospace'
		g.fillStyle = 'rgba(233, 229, 219, .95)'
		g.textAlign = 'center'
		const seconds = launch.secondsLeft
		g.fillText(`IMPACT ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`, x, y - 24 - fraction * 8)
		g.restore()
	}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) requestFrame() })
// iOS Safari zooms the page on a pinch it sees outside the canvas; the map owns that gesture.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, event => { if (document.body.dataset.screen !== 'connect') event.preventDefault() }, { passive: false })

function updateReadout(): void {
	if (!state) return
	const mode = resolveVision(state, vision)
	document.body.dataset.vision = mode
	$<HTMLElement>('[data-mode]').textContent = `${mode === 'day' ? 'SAT' : mode === 'white' ? 'IR WHT' : 'NV'} · ${vision === 'auto' ? 'AUTO' : 'MAN'}`
	const seconds = Math.floor(state.time / 1000)
	$<HTMLElement>('[data-clock]').textContent = `T+${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
	$<HTMLElement>('[data-zoom]').textContent = `${view.zoom.toFixed(1)}×`
	const badge = $<HTMLElement>('[data-vision-badge]')
	badge.textContent = vision === 'auto' ? 'A' : vision === 'white' ? 'W' : vision === 'green' ? 'G' : 'D'
	$<HTMLButtonElement>('button[data-vision]').setAttribute('aria-label', `Vision mode: ${vision === 'auto' ? 'Auto' : visionLabel(mode)}`)
	const pending = renderer.terrain.pending, downlink = $<HTMLElement>('.joa-downlink')
	if (!renderer.terrain.ready(mode) && pending > 0) {
		const total = renderer.terrain.cols * renderer.terrain.rows
		const done = Math.max(0, Math.min(100, Math.round((1 - pending / Math.max(1, total)) * 100)))
		downlink.hidden = false
		$<HTMLElement>('[data-downlink]').textContent = `${done}%`
		downlink.style.setProperty('--done', `${done}%`)
	} else downlink.hidden = true
}

// --- View animation and gestures ----------------------------------------------------------------
const MAX_CELL_PX = 72
let animation: { from: MapView; to: Pick<MapView, 'x' | 'y' | 'zoom'>; start: number; duration: number } | null = null
let fling: { vx: number; vy: number; last: number } | null = null
const ease = (t: number): number => 1 - Math.pow(1 - t, 3)

function maxZoom(): number {
	if (!state) return 8
	const base = mapTransform(state, canvas.clientWidth, canvas.clientHeight, { ...view, zoom: 1 }).scale
	return Math.max(2, MAX_CELL_PX / base)
}
function clampView(): void {
	if (!state) return
	view.zoom = Math.max(view.cover ? 1 : 0.6, Math.min(maxZoom(), view.zoom))
	const { scale } = mapTransform(state, canvas.clientWidth, canvas.clientHeight, view)
	// The map always fills the screen: its edges stop at the screen's edges, never inside them.
	const halfW = canvas.clientWidth / 2 / (scale * state.bounds.w), halfH = canvas.clientHeight / 2 / (scale * state.bounds.h)
	view.x = halfW >= 0.5 ? 0.5 : Math.max(halfW, Math.min(1 - halfW, view.x))
	view.y = halfH >= 0.5 ? 0.5 : Math.max(halfH, Math.min(1 - halfH, view.y))
}
/** The chrome over the map, measured because each layout moves the readout, rail and dock: labels
 * and the rulers stay clear of it. */
function measureInsets(): void {
	const map = canvas.getBoundingClientRect()
	if (!map.width) return
	const forces = $<HTMLElement>('.joa-forces').getBoundingClientRect(), rail = $<HTMLElement>('.joa-rail').getBoundingClientRect()
	const dock = $<HTMLElement>('.joa-dock').getBoundingClientRect()
	// The docked legend owns the strip between the map's foot and the menu bar; the bottom ruler
	// and scale bar render above it, clear of its glyphs.
	const legend = $<HTMLElement>('.joa-legend'), legendTop = legend.offsetParent ? legend.getBoundingClientRect().top : dock.top
	view.insets = {
		top: Math.max(0, forces.bottom - map.top) + 8,
		right: Math.max(0, map.right - rail.left) + 8,
		// The tablet's dock floats over the map; elsewhere only the column ruler sits at the foot.
		// +26 keeps ruler ticks and the scale bar wholly above the legend strip, not inside it.
		bottom: Math.max(24, Math.ceil(map.bottom - Math.min(dock.top, legendTop)) + 26),
		left: 40,
	}
}
function animateTo(to: Partial<Pick<MapView, 'x' | 'y' | 'zoom'>>, duration = 420): void {
	fling = null
	animation = { from: { ...view }, to: { x: to.x ?? view.x, y: to.y ?? view.y, zoom: to.zoom ?? view.zoom }, start: performance.now(), duration }
	requestFrame()
}
function stepAnimation(now: number): boolean {
	if (animation) {
		const t = Math.min(1, (now - animation.start) / animation.duration), k = ease(t), a = animation
		// Zoom interpolates geometrically, so it feels even at every scale.
		view.zoom = a.from.zoom * Math.pow(a.to.zoom / a.from.zoom, k)
		view.x = a.from.x + (a.to.x - a.from.x) * k
		view.y = a.from.y + (a.to.y - a.from.y) * k
		clampView()
		if (t >= 1) animation = null
		return true
	}
	if (fling && state) {
		const dt = Math.min(48, now - fling.last); fling.last = now
		const { scale } = mapTransform(state, canvas.clientWidth, canvas.clientHeight, view)
		view.x -= (fling.vx * dt) / scale / state.bounds.w
		view.y -= (fling.vy * dt) / scale / state.bounds.h
		const decay = Math.pow(0.9, dt / 16)
		fling.vx *= decay; fling.vy *= decay
		clampView()
		if (Math.hypot(fling.vx, fling.vy) < 0.02) fling = null
		return true
	}
	return false
}
/** Zoom by `factor` keeping the map point under (px, py) fixed on screen. */
function zoomAt(factor: number, px: number, py: number, animate = false): void {
	if (!state) return
	const w = canvas.clientWidth, h = canvas.clientHeight
	const before = mapPoint(state, w, h, view, px, py)
	const zoom = Math.max(view.cover ? 1 : 0.6, Math.min(maxZoom(), view.zoom * factor))
	const probe = { ...view, zoom }
	const after = mapPoint(state, w, h, probe, px, py)
	const x = view.x + (before.x - after.x) / state.bounds.w, y = view.y + (before.y - after.y) / state.bounds.h
	if (animate) animateTo({ zoom, x, y }, 360)
	else { view.zoom = zoom; view.x = x; view.y = y; clampView(); requestFrame() }
}
function centreOn(x: number, y: number, zoom = Math.max(view.zoom, 3)): void {
	if (!state) return
	animateTo({ x: (x - state.bounds.x) / state.bounds.w, y: (y - state.bounds.y) / state.bounds.h, zoom: Math.min(maxZoom(), zoom) })
}

const pointers = new Map<number, { x: number; y: number; t: number }>()
let pinchDistance = 0, pinchMid = { x: 0, y: 0 }, travel = 0, downAt = 0, lastTap = { t: 0, x: 0, y: 0 }
canvas.addEventListener('pointerdown', event => {
	canvas.setPointerCapture(event.pointerId)
	animation = null; fling = null
	if (!pointers.size) { travel = 0; downAt = performance.now() }
	pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, t: performance.now() })
	if (pointers.size === 2) {
		const [a, b] = [...pointers.values()]
		pinchDistance = Math.hypot(a.x - b.x, a.y - b.y); pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
		travel = 99
	}
})
canvas.addEventListener('pointermove', event => {
	const old = pointers.get(event.pointerId)
	if (!old || !state) return
	const now = performance.now(), dx = event.clientX - old.x, dy = event.clientY - old.y
	travel += Math.hypot(dx, dy)
	pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, t: now })
	const rect = canvas.getBoundingClientRect()
	if (pointers.size >= 2) {
		const [a, b] = [...pointers.values()]
		const distance = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
		if (pinchDistance > 0) zoomAt(distance / pinchDistance, mid.x - rect.left, mid.y - rect.top)
		// Two-finger drag pans as well.
		const { scale } = mapTransform(state, canvas.clientWidth, canvas.clientHeight, view)
		view.x -= (mid.x - pinchMid.x) / scale / state.bounds.w; view.y -= (mid.y - pinchMid.y) / scale / state.bounds.h
		pinchDistance = distance; pinchMid = mid
		clampView(); requestFrame()
		return
	}
	if (travel < 6) return
	const { scale } = mapTransform(state, canvas.clientWidth, canvas.clientHeight, view)
	view.x -= dx / scale / state.bounds.w; view.y -= dy / scale / state.bounds.h
	const dt = Math.max(1, now - old.t)
	fling = { vx: dx / dt, vy: dy / dt, last: now }
	clampView(); requestFrame()
})
function release(event: PointerEvent, cancelled: boolean): void {
	pointers.delete(event.pointerId)
	if (pointers.size) { const [p] = [...pointers.values()]; pinchDistance = 0; pinchMid = { x: p.x, y: p.y }; return }
	if (fling) { const since = performance.now() - fling.last; if (since > 80) fling = null; else { fling.last = performance.now(); requestFrame() } }
	if (cancelled || travel >= 6 || !state) return
	const now = performance.now(), rect = canvas.getBoundingClientRect(), px = event.clientX - rect.left, py = event.clientY - rect.top
	if (now - downAt > 450) return
	// Double tap zooms in around the tap, and never issues an order.
	if (now - lastTap.t < 300 && Math.hypot(px - lastTap.x, py - lastTap.y) < 30) { lastTap.t = 0; zoomAt(2, px, py, true); return }
	// A tap that gave an order is not the first half of a double tap.
	lastTap = tap(px, py) ? { t: 0, x: 0, y: 0 } : { t: now, x: px, y: py }
}
canvas.addEventListener('pointerup', event => release(event, false))
canvas.addEventListener('pointercancel', event => release(event, true))
canvas.addEventListener('wheel', event => {
	event.preventDefault()
	const rect = canvas.getBoundingClientRect()
	zoomAt(Math.pow(1.0018, -event.deltaY * (event.deltaMode === 1 ? 16 : 1)), event.clientX - rect.left, event.clientY - rect.top)
}, { passive: false })
canvas.addEventListener('dblclick', event => event.preventDefault())

function tap(px: number, py: number): boolean {
	if (!state) return false
	const point = mapPoint(state, canvas.clientWidth, canvas.clientHeight, view, px, py)
	const cell = { x: Math.floor(point.x), y: Math.floor(point.y) }
	if (cell.x < state.bounds.x || cell.y < state.bounds.y || cell.x >= state.bounds.x + state.bounds.w || cell.y >= state.bounds.y + state.bounds.h) return false
	const { scale } = mapTransform(state, canvas.clientWidth, canvas.clientHeight, view)
	// A hostile under the finger (within 20 CSS px) is the target; otherwise the ground cell.
	const reach = Math.max(1.2, 20 / scale)
	const target = state.contacts.filter(c => c.relation === 'enemy' && !c.remembered && c.role !== 'tree' && c.role !== 'rock')
		.map(c => ({ c, d: Math.hypot(c.x - point.x, c.y - point.y) })).filter(e => e.d < reach).sort((a, b) => a.d - b.d)[0]?.c
	// One of the commander's own buildings wins over any armed order: a damaged base must stay
	// repairable while groups are being commanded (the owner's report). Aiming stays armed
	// behind the sheet, so closing it returns to the order.
	const building = state.contacts
		.map(c => ({ c, d: Math.hypot(c.x - point.x, c.y - point.y) - Math.max((c.footprint?.w ?? 1), (c.footprint?.h ?? 1)) / 2 }))
		.filter(e => e.c.relation === 'own' && !e.c.remembered && isStructure(e.c.role) && e.d < reach).sort((a, b) => a.d - b.d)[0]?.c
	if (building) { selectedBuilding = building.id; render(); return true }
	// A selection only arms orders for a tier that may command: a spectator's tapped group
	// stays a focus (its ring on the map), and the tap reads the ground instead.
	if ((selectedGroup !== undefined || aircraft !== undefined || power) && available()) {
		if (action === 'attack' && aircraft !== undefined && target === undefined) { message('Tap a hostile to engage it.'); return true }
		void command(cell, target?.id); return true
	}
	if (selectedBuilding !== undefined) { selectedBuilding = undefined; render() }
	if (target) message(`${target.label} · hostile at grid ${cell.x}, ${cell.y}. Choose a group to engage.`)
	else message(`Grid ${cell.x}, ${cell.y}. Choose a group or a support weapon to give an order.`)
	return false
}

// --- Orders -------------------------------------------------------------------------------------
async function confirm(title: string, hint: string, accept: string): Promise<boolean> {
	if (document.querySelector('dialog[open]')) return false
	const dialog = document.createElement('dialog')
	dialog.className = 'joa-pair joa-confirm'
	dialog.setAttribute('aria-label', title)
	dialog.innerHTML = `<p class="joa-kicker">Confirm order</p><h2></h2><p class="joa-confirm__hint"></p><div class="joa-pair-actions"></div>`
	dialog.querySelector('h2')!.textContent = title
	dialog.querySelector('.joa-confirm__hint')!.textContent = hint
	document.body.append(dialog)
	return new Promise(resolve => {
		const finish = (value: boolean): void => { dialog.close(); dialog.remove(); resolve(value) }
		const actions = dialog.querySelector('.joa-pair-actions')!
		actions.append(button('Cancel', () => finish(false), false, 'joa-btn joa-btn--ghost'), button(accept, () => finish(true), false, 'joa-btn joa-btn--primary'))
		dialog.oncancel = event => { event.preventDefault(); finish(false) }
		dialog.showModal()
	})
}

/** The last order's kind, so the acknowledgement that follows a result matches it. */
let lastIntentAction: CompanionIntent['action'] | undefined
const ACKS: Record<CompanionIntent['action'], string> = {
	attack: 'attacking', 'attack-move': 'moving_out', move: 'on_my_way', scout: 'roger_that',
	stop: 'awaiting_orders', repair: 'roger_that', support: 'affirmative',
}

async function command(point?: { x: number; y: number }, target?: number): Promise<void> {
	if (!available() || !state) { message('Orders are unavailable: check the link and your permission.', 'warn'); return }
	const current = state.powers.find(p => p.key === power)
	if (action === 'support' && current?.needsSource && !source && point) {
		source = point; view.source = point; requestFrame()
		message(`${current.title}: source set. Tap the destination.`)
		return
	}
	const group = state.groups.find(g => g.id === selectedGroup)
	const intent: CompanionIntent = {
		id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${performance.now().toString(36).replace('.', '')}`,
		session: state.session, sequence: state.sequence,
		action: target && (action === 'move' || action === 'attack-move') ? 'attack' : action,
		group: selectedGroup, revision: group?.revision, aircraft, power, x: point?.x, y: point?.y, target, source,
	}
	if (action === 'support') {
		view.target = point ?? null; requestFrame()
		const ok = await confirm(`${current?.title ?? 'Support'} at grid ${point?.x}, ${point?.y}?`, 'The main game checks the target before it fires. A fired weapon cannot be recalled.', 'Use support')
		if (!ok) { view.target = null; requestFrame(); return }
	}
	if (!available() || !state || state.session !== intent.session) { message('The link or the match changed. Choose the target again.', 'warn'); return }
	intent.sequence = state.sequence
	send({ type: 'intent', intent })
	lastIntentAction = intent.action
	source = undefined; view.source = null
	view.target = point ?? null
	if (action === 'support') { aiming = false; power = undefined }
	message('Order sent to the commander’s game.')
	render()
}

/** Repair one of the commander's buildings: the primary's own RepairBuilding order, aimed
 * from the phone. Support and command tiers may use it; the simulation still decides. */
async function repair(target: number): Promise<void> {
	if (!available() || !state) { message('Orders are unavailable: check the link and your permission.', 'warn'); return }
	const building = state.contacts.find(c => c.id === target && c.relation === 'own')
	if (!building || building.health === undefined || building.health >= 1) { message('That building needs no repair.', 'warn'); return }
	const ok = await confirm(`Repair ${building.label}?`, 'The main game applies its own repair order; funds deduct as the hull is restored.', 'Repair')
	if (!ok) return
	if (!available() || !state) { message('The link or the match changed. Try again.', 'warn'); return }
	const intent: CompanionIntent = {
		id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${performance.now().toString(36).replace('.', '')}`,
		session: state.session, sequence: state.sequence, action: 'repair', target,
	}
	send({ type: 'intent', intent })
	lastIntentAction = intent.action
	message('Repair order sent to the commander’s game.')
	render()
}

// --- Panels -------------------------------------------------------------------------------------
function button(label: string, fn: () => void, disabled = false, className = ''): HTMLButtonElement {
	const el = document.createElement('button')
	el.type = 'button'
	if (className) el.className = className
	el.textContent = label
	el.disabled = disabled
	el.onclick = fn
	return el
}
const tierLabel = (): string => tier === 'information' ? 'Spectator' : tier === 'support' ? 'Technician' : 'Commander'

const FORCES = [['infantry', 'Troops', 'troops'], ['vehicles', 'Vehicles', 'tank'], ['aircraft', 'Aircraft', 'aircraft'], ['harvesters', 'Ore trucks', 'harvester']] as const
const formatCredits = (value: number): string => `¤ ${Math.round(value).toLocaleString('en-US')}`

// --- Companion voice -----------------------------------------------------------------------------
// The phone speaks with the same pre-rendered bank the commander's faction already uses
// (audio/eva.ts): order acknowledgements, the base-under-attack alert and unit losses, in the
// faction's own language. The sounds are the commander's to switch off, and stay off across
// reloads. A missing bank line stays silent, exactly like the game.
const SOUND_KEY = 'joa-sound'
let voiceFiles: Record<string, string> = {}
try {
	voiceFiles = import.meta.glob<string>(['../../.forge/voices/*/*.m4a', '!../../.forge/voices/_*/*', '!../../.forge/voices/british/*'], { eager: true, query: '?url', import: 'default' })
} catch { /* Node harness: Vite glob unavailable */ }
const soundOn = (): boolean => { try { return localStorage.getItem(SOUND_KEY) !== '0' } catch { return true } }
// A small pool of persistent elements rather than a fresh Audio per line: iOS keeps media
// locked per element until a real gesture plays it, so elements armed once keep every later
// shout audible. The pool only exists so a long line is never cut off by the next alert.
const voicePool: HTMLAudioElement[] = [new Audio(), new Audio(), new Audio()]
let blockedNotified = false
function speak(slug: string, volume = 0.9): void {
	if (!soundOn()) return
	const url = voiceFiles[`../../.forge/voices/${state?.voiceBank ?? 'allied'}/${slug}.m4a`]
	if (!url) return
	const audio = voicePool.find(a => a.paused || a.ended)
	if (!audio) return
	audio.volume = volume
	audio.src = url
	void audio.play().then(() => {
		soundArmed = true
		blockedNotified = false
	}).catch(err => {
		if ((err as DOMException)?.name !== 'NotAllowedError') return /* clip missing: silence */
		soundArmed = false // still locked: the next tap retries the unlock instead of staying mute forever
		if (blockedNotified) return
		blockedNotified = true
		message('Companion audio is blocked — tap the map once to let it through.', 'warn')
	})
}
/** iOS keeps media locked until the first play rides a real gesture: a tap anywhere arms it. */
let soundArmed = false
document.addEventListener('pointerdown', () => {
	if (soundArmed || !soundOn()) return
	const url = voiceFiles[`../../.forge/voices/${state?.voiceBank ?? 'allied'}/unit_ready.m4a`]
	if (!url) { soundArmed = true; return }
	const audio = voicePool[0]!
	audio.volume = 0.2
	audio.src = url
	void audio.play().then(() => { soundArmed = true }).catch(() => { /* still locked: the next tap retries */ })
}, { capture: true })
/** One alert kind at a time: the bank rows are short, but a firefight is not a chorus. */
let lastShoutAt = 0
function shout(slug: string): void {
	const now = Date.now()
	if (now - lastShoutAt < 2500) return
	lastShoutAt = now
	speak(slug)
}
function syncSoundButton(): void {
	const on = soundOn()
	const el = $<HTMLButtonElement>('[data-sound]')
	el.setAttribute('aria-pressed', String(on))
	el.title = on ? 'Companion sounds on' : 'Companion sounds off'
	el.dataset.on = String(on)
}
$<HTMLButtonElement>('[data-sound]').onclick = () => {
	try { localStorage.setItem(SOUND_KEY, soundOn() ? '0' : '1') } catch { /* storage off: lasts this page */ }
	syncSoundButton()
	if (soundOn()) speak('affirmative')
}
syncSoundButton()

/** Spoken edges, from the published state only: a structure shouting, a group losing a unit,
 * the grid browning out. */
const shoutedAlerts = new Set<string>()
const groupSizes = new Map<number, number>()
let wasLowPower = false, lowPowerShoutedAt = 0
function soundEdges(): void {
	if (!state) return
	// Low power: the rising edge shouts at once, a persistent brownout repeats every 45 s.
	const lowPower = !!state.stats && state.stats.powerDrawn > state.stats.powerSupplied
	if (lowPower && Date.now() - lowPowerShoutedAt >= (wasLowPower ? 45000 : 0)) {
		lowPowerShoutedAt = Date.now()
		shout('low_power')
		if (!wasLowPower) message('Low power · production and support slowed', 'warn')
	}
	wasLowPower = lowPower
	for (const alert of state.alerts) {
		const key = `${alert.id}:${alert.time}`
		if (shoutedAlerts.has(key)) continue
		shoutedAlerts.add(key)
		if (/under attack$/i.test(alert.label)) shout('our_base_is_under_attack')
	}
	if (shoutedAlerts.size > 48) for (const key of shoutedAlerts) { shoutedAlerts.delete(key); if (shoutedAlerts.size <= 48) break }
	const present = new Set<number>()
	for (const group of state.groups) {
		present.add(group.id)
		const previous = groupSizes.get(group.id)
		if (previous !== undefined && group.members.length < previous) shout('unit_lost')
		groupSizes.set(group.id, group.members.length)
	}
	for (const [id, size] of groupSizes) if (!present.has(id)) { if (size > 0) shout('unit_lost'); groupSizes.delete(id) }
}
/** A support power the commander fired in the main game: its charge restart is the proof. The
 * phone names the loud ones so the co-commander knows the sky is already busy. */
function announceFiredPowers(before: Power[] | undefined): void {
	if (!before || !state) return
	const was = new Map(before.map(p => [p.key, p.ready]))
	for (const p of state.powers) {
		if (was.get(p.key) !== true || p.ready) continue
		if (/nuke|atom|missile/i.test(p.key)) message('Nuke away · impact inbound', 'warn')
		else if (/para/i.test(p.key)) message('Paratroopers away · they join a group on landing')
		else if (/chrono/i.test(p.key)) message('Chronoshift fired')
		else if (/strike/i.test(p.key)) message('Air strike away')
	}
}
/** The incoming-missile banner: the earliest enemy launch in flight owns the clock. The host's
 * imminence flag turns it hot and speaks the same alarm the main game plays. */
const nukeShouted = new Set<number>()
let nukeBannerTimer = 0
function updateNukeBanner(): void {
	const banner = $<HTMLElement>('.joa-nuke')
	const incoming = (state?.launches ?? []).filter(l => !l.allied && l.secondsLeft > 0).sort((a, b) => a.secondsLeft - b.secondsLeft)[0] ?? null
	if (!incoming) {
		banner.hidden = true
		if (nukeBannerTimer) { window.clearInterval(nukeBannerTimer); nukeBannerTimer = 0 }
		return
	}
	if (incoming.imminent) banner.setAttribute('data-imminent', ''); else banner.removeAttribute('data-imminent')
	const seconds = incoming.secondsLeft
	$<HTMLElement>('[data-nuke-clock]').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
	banner.hidden = false
	if (incoming.imminent && !nukeShouted.has(incoming.id)) { nukeShouted.add(incoming.id); shout('nuclear_bomb_detected') }
	if (!nukeBannerTimer) nukeBannerTimer = window.setInterval(() => { if (state) updateNukeBanner(); else if (nukeBannerTimer) { window.clearInterval(nukeBannerTimer); nukeBannerTimer = 0 } }, 500)
}
/** The chips are built once; each state only changes the numbers that moved. */
function renderForces(): void {
	if (!state) return
	if (!forces.childElementCount) for (const [, label, glyph] of FORCES) {
		const item = document.createElement('div')
		item.className = 'joa-force'
		item.innerHTML = `${icon(glyph)}<strong></strong><span></span>`
		item.querySelector('span')!.textContent = label
		forces.append(item)
	}
	FORCES.forEach(([key, label], i) => {
		const item = forces.children[i] as HTMLElement, value = String(state!.counts[key]), strong = item.querySelector('strong')!
		if (strong.textContent === value) return
		strong.textContent = value
		item.setAttribute('aria-label', `${value} ${label}`)
	})
}

function powerIcon(p: Power): HudIcon {
	return supportIconFor(p.key)
}

const verdict = $<HTMLElement>('[data-verdict]')
/** The link outlives a battle: between matches the phone stands by, and the result of the
 * last one stays up until the commander's next world loads. */
function showVerdict(mode: 'waiting' | 'victory' | 'defeat' | 'concluded' | null): void {
	verdict.hidden = mode === null
	if (!mode) return
	verdict.dataset.verdictMode = mode
	$<HTMLElement>('[data-verdict-kicker]').textContent = mode === 'waiting' ? 'Uplink' : 'Battle over'
	$<HTMLElement>('[data-verdict-title]').textContent = mode === 'waiting' ? 'Standing by' : mode === 'victory' ? 'Victory' : mode === 'defeat' ? 'Defeat' : 'Concluded'
	$<HTMLElement>('[data-verdict-note]').textContent = mode === 'waiting' ? 'No battle is running. The next one appears here automatically.' : 'The next battle appears here automatically.'
}

function render(): void {
	if (document.body.dataset.screen === 'connect') { showVerdict(null); return }
	if (!state) {
		linkText.textContent = 'Awaiting battle'
		document.body.dataset.link = 'live'
		showVerdict('waiting')
		sheet.hidden = true; sheet.replaceChildren(); sheetKey = ''
		return
	}
	const lost = Date.now() - lastState > 2500
	linkText.textContent = lost ? 'Signal lost' : paused || state.paused ? 'Paused' : state.ended ? 'Match ended' : `Live · ${tierLabel()}`
	document.body.dataset.link = lost ? 'lost' : paused || state.paused ? 'paused' : 'live'
	showVerdict(state.ended ? state.outcome ?? 'concluded' : null)
	renderForces()
	const unseen = state.alerts.length - seenAlerts, badge = $<HTMLElement>('[data-alert-count]')
	badge.hidden = unseen <= 0 || tab === 'alerts'
	badge.textContent = String(Math.max(0, unseen))
	if (tab === 'alerts') seenAlerts = state.alerts.length
	renderSheet()
	requestFrame()
}

function sheetHead(index: string, title: string): HTMLElement {
	const head = document.createElement('header')
	head.className = 'joa-sheet__head'
	head.innerHTML = `<span class="joa-sheet__grab" aria-hidden="true"></span><p class="joa-kicker"><b></b></p><h2></h2><span class="joa-chip"></span>`
	head.querySelector('b')!.textContent = index
	head.querySelector('.joa-kicker')!.append(` · ${tierLabel()}`)
	head.querySelector('h2')!.textContent = title
	head.querySelector('.joa-chip')!.textContent = tier === 'information' ? 'View only' : live() ? 'Ready' : 'Unavailable'
	return head
}

function renderAim(): void {
	const bar = $<HTMLElement>('.joa-aim')
	bar.hidden = !aiming
	document.body.dataset.aiming = String(aiming)
	if (!aiming || !state) return
	const p = state.powers.find(x => x.key === power)
	const title = action === 'support' ? (p?.title ?? 'Support') : action === 'scout' ? 'Scout' : action === 'attack' ? 'Attack' : action === 'attack-move' ? 'Attack move' : 'Move'
	const who = action === 'support' ? (p?.needsSource && !source ? 'Tap the source' : 'Tap the target, then confirm') : action === 'scout' ? 'Tap where the aircraft should look' : action === 'attack' ? 'Tap a hostile to engage it' : action === 'attack-move' ? 'Tap where to advance, engaging on the way; a hostile under the finger is engaged directly' : 'Tap a destination, or a hostile to attack'
	const aircraftLabel = aircraft !== undefined ? state.contacts.find(c => c.id === aircraft)?.label ?? 'Aircraft' : ''
	$<HTMLElement>('[data-aim-title]').textContent = selectedGroup !== undefined && action !== 'support' && action !== 'scout' && action !== 'attack' ? `Group ${selectedGroup} · ${title}`
		: aircraft !== undefined && action !== 'support' ? `${aircraftLabel} · ${title}` : title
	$<HTMLElement>('[data-aim-hint]').textContent = who
	const modes = $<HTMLElement>('.joa-aim__modes')
	modes.replaceChildren()
	modes.hidden = selectedGroup === undefined && aircraft === undefined || action === 'support'
	if (!modes.hidden) {
		// Groups advance (move, engaging on the way); aircraft either look or fight. Stop ends
		// the order for both: it is sent, then the selection clears so the map is free again.
		const rows = aircraft !== undefined
			? [['Scout', 'scout', 'aircraft'], ['Attack', 'attack', 'attack'], ['Stop', 'stop', 'stop']] as const
			: [['Move', 'move', 'move'], ['Attack move', 'attack-move', 'attack'], ['Stop', 'stop', 'stop']] as const
		for (const [name, kind, glyph] of rows) {
			const b = button('', () => {
				action = kind
				if (kind === 'stop') { void command(); endSelection() }
				render()
			}, !available(), 'joa-aim__mode')
			b.innerHTML = `${icon(glyph)}<span>${name === 'Attack move' ? 'Attack' : name}</span>`
			b.setAttribute('aria-label', name)
			b.setAttribute('aria-pressed', String(action === kind))
			modes.append(b)
		}
	}
	$<HTMLElement>('.joa-aim__icon').innerHTML = icon(action === 'support' ? (p ? powerIcon(p) : 'strike') : action === 'scout' ? 'aircraft' : action === 'attack' || action === 'attack-move' ? 'attack' : 'move')
}

/** Stop is a real end to companion control: the order goes out, then the selection disarms. */
function endSelection(): void {
	selectedGroup = undefined; aircraft = undefined; aiming = false; action = 'move'
	view.source = null; view.target = null
}

/** Everything the open sheet shows. The sheet is rebuilt only when this changes, so its buttons
 * stay the same elements between states (a tap never lands on a button that was replaced). */
function sheetSignature(): string {
	if (!state) return ''
	const shared = [tab, tier, live(), available(), selectedGroup, power, aircraft, action]
	if (selectedBuilding !== undefined) {
		const c = state.contacts.find(c => c.id === selectedBuilding && c.relation === 'own' && !c.remembered && isStructure(c.role))
		return JSON.stringify([shared, 'building', c?.id, c?.label, c ? Math.round((c.health ?? 1) * 100) : 0, c?.underAttack])
	}
	if (tab === 'groups') return JSON.stringify([shared, state.groups.map(g => [g.id, g.members.length]), state.aircraft.map(id => [id, state!.contacts.find(c => c.id === id)?.label])])
	if (tab === 'support') return JSON.stringify([shared, state.powers.map(p => [p.key, p.title, p.active, p.ready, p.totalTicks > 0 ? Math.round((1 - p.remainingTicks / p.totalTicks) * 100) : 0, Math.ceil(p.remainingSeconds ?? p.remainingTicks / 25)])])
	if (tab === 'alerts') return JSON.stringify([shared, state.alerts.map(a => [a.id, a.label, a.time])])
	if (tab === 'stats') return JSON.stringify([shared, state.stats, state.counts, (state.production ?? []).map(p => [p.label, Math.round(p.progress), p.queued])])
	if (tab === 'ask') return JSON.stringify([shared, Date.now() - requestAt < REQUEST_REST_MS])
	return JSON.stringify([shared, Date.now() - tauntAt < TAUNT_REST_MS])
}
let sheetKey = '', sheetPressed = false, layoutKey = ''
/** One tab for the dock and the rail's taunts button: switching disarms aiming and closes a
 * tapped building, and a repeated tab lands back on the map. */
function selectTab(next: typeof tab): void {
	aiming = false
	selectedBuilding = undefined
	tab = tab === next && next !== 'map' ? 'map' : next
	document.querySelectorAll('[data-tab]').forEach(t => t.setAttribute('aria-selected', String((t as HTMLElement).dataset.tab === tab)))
	render()
}
// The sheet's head is its handle: dragging it down closes the sheet, exactly as the grab bar
// says. A small drag springs back; the sheet's own scrolling starts below the head.
let sheetDrag: { y0: number; dy: number; moved: boolean } | null = null
sheet.addEventListener('pointerdown', event => {
	sheetPressed = true
	if (!(event.target as Element).closest('.joa-sheet__head')) return
	sheetDrag = { y0: event.clientY, dy: 0, moved: false }
	try { sheet.setPointerCapture(event.pointerId) } catch { /* the pointer left already */ }
})
sheet.addEventListener('pointermove', event => {
	if (!sheetDrag) return
	sheetDrag.dy = Math.max(0, event.clientY - sheetDrag.y0)
	if (sheetDrag.dy > 6) sheetDrag.moved = true
	sheet.style.transition = 'none'
	sheet.style.transform = `translateY(${Math.min(sheetDrag.dy, 240)}px)`
})
const endSheetDrag = (cancelled: boolean): void => {
	if (!sheetDrag) return
	const { dy, moved } = sheetDrag
	sheetDrag = null
	sheet.style.transition = ''
	sheet.style.transform = ''
	if (!cancelled && moved && dy > 90) selectTab('map')
}
sheet.addEventListener('pointerup', () => endSheetDrag(false))
sheet.addEventListener('pointercancel', () => endSheetDrag(true))
// The click fires after pointerup: rebuild only once it has run.
const releaseSheet = (): void => { if (!sheetPressed) return; sheetPressed = false; renderSheet() }
sheet.addEventListener('pointerup', () => { window.setTimeout(releaseSheet, 0) })
sheet.addEventListener('pointercancel', releaseSheet)

function renderSheet(): void {
	if (!state) return
	renderAim()
	const building = selectedBuilding !== undefined ? state.contacts.find(c => c.id === selectedBuilding && c.relation === 'own' && !c.remembered && isStructure(c.role)) : undefined
	if (selectedBuilding !== undefined && !building) selectedBuilding = undefined
	sheet.hidden = aiming || (tab === 'map' && selectedBuilding === undefined)
	// The structure sheet is chrome like any other: borrow a non-map value so the rail steps aside.
	document.body.dataset.sheet = building ? 'alerts' : tab
	// A sheet moves the rail: labels and rulers follow the chrome.
	if (layoutKey !== `${tab}:${aiming}:${selectedBuilding !== undefined}`) { layoutKey = `${tab}:${aiming}:${selectedBuilding !== undefined}`; measureInsets(); requestFrame() }
	if (sheet.hidden) { sheet.replaceChildren(); sheetKey = ''; return }
	const key = sheetSignature()
	if (key === sheetKey || sheetPressed) return
	const scroll = sheet.scrollTop, same = sheetKey.startsWith(`[["${tab}"`)
	sheetKey = key
	const body = document.createElement('div')
	body.className = 'joa-sheet__body'
	if (building) {
		sheet.replaceChildren(sheetHead('01', 'Structure'), body)
		const hull = Math.max(0, Math.min(1, building.health ?? 1))
		const panel = document.createElement('div'); panel.className = 'joa-building'
		panel.innerHTML = `<div class="joa-building__row"><strong></strong><em data-state></em></div><div class="joa-building__hull" role="img" aria-label="Hull integrity"><i></i></div><div class="joa-building__actions"></div>`
		panel.querySelector('strong')!.textContent = building.label
		const stateEl = panel.querySelector<HTMLElement>('[data-state]')!
		stateEl.textContent = building.underAttack ? 'Under attack' : hull >= 1 ? 'Hull intact' : `Hull ${Math.round(hull * 100)}%`
		stateEl.dataset.attack = String(!!building.underAttack)
		const bar = panel.querySelector<HTMLElement>('.joa-building__hull i')!
		bar.style.width = `${Math.max(2, hull * 100)}%`
		bar.style.background = hull > 0.5 ? '#87BC91' : hull > 0.25 ? '#E7B75F' : '#FF6B63'
		const actions = panel.querySelector('.joa-building__actions')!
		actions.append(
			button('Centre', () => centreOn(building.x, building.y, Math.max(view.zoom, 4)), false, 'joa-btn joa-btn--ghost'),
			button('Repair', () => { void repair(building.id) }, !available() || hull >= 1, 'joa-btn joa-btn--primary'),
			button('Close', () => { selectedBuilding = undefined; render() }, false, 'joa-btn joa-btn--ghost'),
		)
		body.append(panel)
		if (tier === 'information') body.append(note('Spectator permission: repair stays with the commander.'))
		else if (hull >= 1) body.append(note('Hull intact: the repair order unlocks when this building is damaged.'))
		else body.append(note('Repair is the main game’s own order: funds deduct as the hull is restored, and its rules still decide.'))
	} else if (tab === 'groups') {
		sheet.replaceChildren(sheetHead('02', 'Command groups'), body)
		const grid = document.createElement('div'); grid.className = 'joa-groups'
		for (let id = 1; id <= 6; id++) {
			const group = state.groups.find(g => g.id === id), count = group?.members.length ?? 0
			const card = button('', () => {
				selectedGroup = id; aircraft = undefined; power = undefined; source = undefined; action = 'move'
				view.source = null
				if (group) centreOn(group.x, group.y, Math.max(view.zoom, 3))
				// The map is always the next step: the commander aims from it, a spectator
				// watches the group's ring follow the battle.
				if (available() && tier === 'command') { selectTab('map'); aiming = true; render() }
				else { selectTab('map'); message(`Group ${id} · ${tier === 'command' ? 'orders resume when the link is live.' : 'view only with your permission.'}`) }
				render()
			}, !group, 'joa-group')
			card.setAttribute('aria-label', `${id} · ${count}`)
			card.setAttribute('aria-pressed', String(id === selectedGroup))
			card.innerHTML = `<span class="joa-group__id">${id}</span><span class="joa-group__count">${count ? `${count} unit${count === 1 ? '' : 's'}` : 'Empty'}</span>`
			grid.append(card)
		}
		body.append(grid)
		const actions = document.createElement('div'); actions.className = 'joa-actions'
		for (const [name, kind, glyph] of [['Move', 'move', 'move'], ['Attack move', 'attack-move', 'attack'], ['Stop', 'stop', 'stop']] as const) {
			const b = button('', () => {
				action = kind
				if (kind === 'stop') { void command(); endSelection() }
				else aiming = true
				render()
			}, !available() || tier !== 'command' || selectedGroup === undefined, 'joa-btn joa-btn--ghost')
			b.innerHTML = `${icon(glyph)}<span>${name}</span>`
			b.setAttribute('aria-label', name)
			b.setAttribute('aria-pressed', String(action === kind && selectedGroup !== undefined))
			actions.append(b)
		}
		body.append(actions)
		if (tier !== 'command') body.append(note(tier === 'information' ? 'Spectator permission: the commander can raise it in the main game.' : 'Technician permission: groups are the commander’s.'))
		const scouts = document.createElement('div'); scouts.className = 'joa-list'
		const heading = document.createElement('h3'); heading.textContent = 'Aircraft'
		body.append(heading, scouts)
		if (!state.aircraft.length) scouts.append(note('No aircraft yet. They appear here once built.'))
		for (const id of state.aircraft) {
			const label = state.contacts.find(c => c.id === id)?.label ?? 'Aircraft'
			const b = button('', () => {
				aircraft = id; selectedGroup = undefined; power = undefined; action = 'scout'; aiming = true
				render()
			}, !available() || tier !== 'command', 'joa-row')
			b.setAttribute('aria-label', `Select · ${label}`)
			b.setAttribute('aria-pressed', String(aircraft === id))
			b.innerHTML = `${icon('aircraft')}<span></span><em>Scout · Attack</em>`
			b.querySelector('span')!.textContent = label
			scouts.append(b)
		}
	} else if (tab === 'support') {
		sheet.replaceChildren(sheetHead('03', 'Support weapons'), body)
		const list = document.createElement('div'); list.className = 'joa-powers'
		if (!state.powers.length) list.append(note('No support weapons yet. They appear here when your buildings provide them.'))
		for (const p of state.powers) {
			const seconds = Math.ceil(p.remainingSeconds ?? p.remainingTicks / 25)
			const charge = p.totalTicks > 0 ? Math.round((1 - p.remainingTicks / p.totalTicks) * 100) : p.ready ? 100 : 0
			const b = button('', () => {
				source = undefined; power = p.key; aircraft = undefined; selectedGroup = undefined; action = 'support'; aiming = true
				view.source = null
				render()
			}, !available() || !p.active || !p.ready, 'joa-power')
			b.setAttribute('aria-label', `${p.title} · ${p.ready ? 'Ready' : `${seconds}s`}`)
			b.setAttribute('aria-pressed', String(power === p.key))
			b.dataset.ready = String(p.ready)
			b.style.setProperty('--charge', `${charge}%`)
			b.innerHTML = `<span class="joa-power__ring">${icon(powerIcon(p))}</span><span class="joa-power__text"><strong></strong><small></small></span><em></em>`
			b.querySelector('strong')!.textContent = p.title
			b.querySelector('small')!.textContent = !p.active ? 'Offline · low power' : p.ready ? 'Ready to fire' : `Charging · ${charge}%`
			b.querySelector('em')!.textContent = p.ready ? 'Ready' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
			list.append(b)
		}
		body.append(list)
		if (tier === 'information') body.append(note('Spectator permission: support weapons stay with the commander.'))
	} else if (tab === 'alerts') {
		sheet.replaceChildren(sheetHead('04', 'Battlefield alerts'), body)
		const list = document.createElement('div'); list.className = 'joa-alerts'
		if (!state.alerts.length) list.append(note('No recent alerts in your visible territory.'))
		for (const alert of [...state.alerts].reverse()) {
			const seconds = Math.floor(alert.time / 1000)
			const b = button('', () => centreOn(alert.x + 0.5, alert.y + 0.5, 4), false, 'joa-row joa-row--alert')
			b.setAttribute('aria-label', alert.label)
			b.innerHTML = `${icon('alerts')}<span></span><em>T+${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}</em>`
			b.querySelector('span')!.textContent = alert.label
			list.append(b)
		}
		body.append(list)
	} else if (tab === 'stats') {
		sheet.replaceChildren(sheetHead('05', 'Battle statistics'), body)
		const s = state.stats
		// What the base is raising right now: buildings and units, with their charge.
		if (state.production?.length) {
			const heading = document.createElement('h3'); heading.textContent = 'In production'
			const runs = document.createElement('div'); runs.className = 'joa-prod'
			for (const line of state.production) {
				const row = document.createElement('div'); row.className = 'joa-prod__row'
				row.innerHTML = `<span class="joa-prod__kind"></span><span class="joa-prod__label"></span><i><b></b></i><em></em>`
				row.querySelector('.joa-prod__kind')!.textContent = ['Building', 'Infantry', 'Vehicle', 'Aircraft', 'Naval'][line.kind] ?? 'Queue'
				row.querySelector('.joa-prod__label')!.textContent = line.label
				const bar = row.querySelector('b')!
				bar.style.width = `${Math.max(2, Math.min(100, line.progress))}%`
				row.querySelector('em')!.textContent = `${Math.round(line.progress)}%${line.queued ? ` · ${line.queued} waiting` : ''}`
				runs.append(row)
			}
			body.append(heading, runs)
		} else body.append(note('Nothing in production. The queues appear here the moment work starts.'))
		const grid = document.createElement('div'); grid.className = 'joa-stats'
		const cards: [string, string, string][] = [
			['Credits', formatCredits(s.credits), 'Credits in hand and stored ore combined'],
			['Ore stored', formatCredits(s.ore), 'Refined ore waiting in silos, valued in credits'],
			['Power', `${Math.round(s.powerDrawn)} / ${Math.round(s.powerSupplied)}`, 'Drawn on the supplied line; the game warns when it tips over'],
			['Ore trucks', String(s.harvesters), 'Harvesters working the fields'],
			['Opposition', `${s.enemies.ai} AI${s.enemies.human ? ` · ${s.enemies.human} human` : ''}${s.enemies.ally ? ` · ${s.enemies.ally} allied` : ''}`, 'Enemies standing, and allies on your side'],
			['Score', s.score === null ? '—' : String(Math.round(s.score)), 'The simulation’s own score for your command'],
		]
		for (const [label, value, hint] of cards) {
			const card = document.createElement('div'); card.className = 'joa-stat'
			card.innerHTML = `<strong></strong><span></span><small></small>`
			card.querySelector('strong')!.textContent = value
			card.querySelector('span')!.textContent = label
			card.querySelector('small')!.textContent = hint
			grid.append(card)
		}
		body.append(grid)
		const roster = document.createElement('div'); roster.className = 'joa-list'
		const heading = document.createElement('h3'); heading.textContent = 'Your forces'
		body.append(heading, roster)
		if (!s.roster.length) roster.append(note('No forces yet. Build units and they are counted here.'))
		for (const unit of s.roster) {
			const row = document.createElement('div'); row.className = 'joa-row joa-row--stat'
			row.innerHTML = `<span></span><em></em>`
			row.querySelector('span')!.textContent = unit.label
			row.querySelector('em')!.textContent = String(unit.count)
			roster.append(row)
		}
		body.append(note('Names and network ping stay with the commander’s game.'))
	} else if (tab === 'ask') {
		sheet.replaceChildren(sheetHead('06', 'Ask the commander'), body)
		const resting = Date.now() - requestAt < REQUEST_REST_MS
		const grid = document.createElement('div'); grid.className = 'joa-asks'
		for (const request of REQUESTS) {
			const b = button('', () => sendRequest(request.id), !live() || resting, 'joa-ask')
			b.innerHTML = `${icon(REQUEST_MARKS[request.id] ?? 'ask')}<q></q>`
			b.querySelector('q')!.textContent = request.text
			b.setAttribute('aria-label', `Ask: ${request.text}`)
			grid.append(b)
		}
		body.append(grid, note('You ask, the commander decides. Questions appear in the main game with a cue.'))
		if (resting) window.setTimeout(render, REQUEST_REST_MS - (Date.now() - requestAt) + 20)
	} else {
		sheet.replaceChildren(sheetHead('07', 'Taunts'), body)
		const resting = Date.now() - tauntAt < TAUNT_REST_MS
		const grid = document.createElement('div'); grid.className = 'joa-taunts'
		for (const taunt of TAUNTS) {
			const b = button('', () => sendTaunt(taunt.id), !live() || resting, 'joa-taunt')
			b.innerHTML = `${icon('taunt')}<q></q>`
			b.querySelector('q')!.textContent = taunt.text
			b.setAttribute('aria-label', `Taunt: ${taunt.text}`)
			grid.append(b)
		}
		body.append(grid, note('Heard over the main game’s speakers, and by everyone in the match.'))
		if (resting) window.setTimeout(render, TAUNT_REST_MS - (Date.now() - tauntAt) + 20)
	}
	// A rebuilt sheet keeps its place, so a list never jumps back to the top.
	if (same) sheet.scrollTop = scroll
}
function sendTaunt(id: string): void {
	if (!live() || Date.now() - tauntAt < TAUNT_REST_MS) return
	tauntAt = Date.now()
	send({ type: 'taunt', taunt: id })
	render()
}
function sendRequest(id: string): void {
	if (!live() || Date.now() - requestAt < REQUEST_REST_MS) return
	requestAt = Date.now()
	send({ type: 'request', request: id })
	render()
}
function note(text: string): HTMLElement { const p = document.createElement('p'); p.className = 'joa-note'; p.textContent = text; return p }

// --- Link ---------------------------------------------------------------------------------------
/** The first view of a match: zoomed to what has been explored, centred on the player's own base. */
function frameExplored(): void {
	if (!state) return
	const b = state.bounds
	let minX = b.w, minY = b.h, maxX = 0, maxY = 0, known = false
	for (let i = 0; i < state.visibility.length; i++) if (state.visibility[i]) {
		known = true
		const x = i % b.w, y = Math.floor(i / b.w)
		minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
	}
	if (!known) return
	framedSession = `${state.session}:${state.match ?? 0}`
	const own = state.contacts.filter(c => c.relation === 'own'), structures = own.filter(c => c.footprint)
	const anchor = structures.length ? structures : own
	view.x = anchor.length ? (anchor.reduce((sum, c) => sum + c.x, 0) / anchor.length - b.x) / b.w : (minX + maxX + 1) / (2 * b.w)
	view.y = anchor.length ? (anchor.reduce((sum, c) => sum + c.y, 0) / anchor.length - b.y) / b.h : (minY + maxY + 1) / (2 * b.h)
	view.zoom = Math.max(1, Math.min(4, b.w / (maxX - minX + 17), b.h / (maxY - minY + 17)))
	measureInsets()
	clampView()
}

function setPairStatus(text: string, kind: 'idle' | 'busy' | 'error' = 'idle'): void {
	pairStatus.textContent = text
	connectScreen.dataset.state = kind
}

async function connect(credentials: { code?: string; secret?: string }, reconnect = false): Promise<void> {
	clearTimeout(retry)
	const config = await loadCompanionConfig()
	if (!config.companionEnabled || !config.companionOrigin) { setPairStatus('JOA is unavailable right now. Ask the commander to try again later.', 'error'); return }
	const endpoint = new URL('/v2/companion/ws', config.companionOrigin)
	endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
	const socket = new WebSocket(endpoint)
	ws = socket
	setPairStatus('Establishing uplink…', 'busy')
	socket.onopen = () => send(reconnect && resume ? { type: 'resume', ...resume } : { type: 'attach', ...credentials, label: /iPad|Tablet/i.test(navigator.userAgent) ? 'Tablet companion' : 'Mobile companion' })
	socket.onmessage = event => {
		let m
		try { m = JSON.parse(event.data) } catch { return }
		if (m.type === 'pending') setPairStatus('Awaiting the commander’s approval in the main game.', 'busy')
		else if (m.type === 'approved') {
			latestSequence = m.latestSequence ?? 0; lastState = 0
			keepResume({ id: m.id, token: m.token })
			if (reconnect) state = null
			tier = m.tier; paused = !!m.paused
			connectScreen.hidden = true
			document.body.dataset.screen = 'live'
			render()
		} else if (m.type === 'sync-begin') { state = null; lastState = 0; latestSequence = m.latestSequence ?? 0 }
		else if (m.type === 'state' && m.state?.schema === 1 && (!state || m.state.session !== state.session || m.state.sequence > state.sequence)) {
			const decoded: TacticalState | null = m.state.grid !== undefined || m.state.cells !== undefined ? decodeFrame(m.state, state) : m.state
			if (!decoded) { state = null; lastState = 0; send({ type: 'sync' }); return }
			previousContacts = state?.contacts ?? []
			receivedAt = performance.now()
			// A new match token re-frames the map exactly like a fresh pairing.
			const first = !state || state.session !== decoded.session || state.match !== decoded.match
			const powersBefore = state?.powers
			state = decoded
			if (first) { framedSession = ''; shoutedAlerts.clear(); groupSizes.clear(); nukeShouted.clear() }
			if (framedSession !== `${state.session}:${state.match ?? 0}`) frameExplored()
			lastState = state.sequence >= latestSequence ? Date.now() : 0
			soundEdges()
			announceFiredPowers(powersBefore)
			updateNukeBanner()
			render()
		} else if (m.type === 'heartbeat') {
			// The primary is alive: a current state stays fresh between publications.
			if (state && state.sequence >= latestSequence) { lastState = Date.now(); if (document.body.dataset.link === 'lost') render() }
		} else if (m.type === 'permission') { tier = m.tier; power = undefined; selectedGroup = undefined; aircraft = undefined; aiming = false; render() }
		else if (m.type === 'pause') { paused = m.paused; render() }
		else if (m.type === 'taunt-sent') { const taunt = tauntById(m.taunt); if (taunt) message(`Taunt sent · “${taunt.text}”`, 'ok') }
		else if (m.type === 'taunt-refused') { tauntAt = 0; message(m.reason, 'warn'); render() }
		else if (m.type === 'request-sent') { const ask = REQUESTS.find(r => r.id === m.request); if (ask) message(`Asked · “${ask.text}”`, 'ok') }
		else if (m.type === 'request-refused') { requestAt = 0; message(m.reason, 'warn'); render() }
		else if (m.type === 'result') {
				if (m.status === 'submitted' && lastIntentAction) speak(ACKS[lastIntentAction])
				message(m.status === 'submitted' ? 'Order accepted for engine processing.' : `Order refused: ${m.reason}`, m.status === 'submitted' ? 'ok' : 'warn')
			}
		else if (m.type === 'error') {
			if (reconnect) { keepResume(null); state = null; showConnect(); socket.close() }
			setPairStatus(m.reason, 'error'); message(m.reason, 'warn')
		} else if (m.type === 'ended') {
			keepResume(null); state = null; showConnect()
			setPairStatus(m.reason, 'error'); socket.close()
			canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
		}
	}
	socket.onclose = () => {
		if (ws !== socket) return
		lastState = 0
		render()
		if (resume) retry = window.setTimeout(() => { void connect({}, true) }, 1500)
		else { showConnect(); setPairStatus('The link closed. Get a new code from the main game.', 'error') }
	}
	socket.onerror = () => setPairStatus('Could not reach JOA. Check your internet connection.', 'error')
}
function showConnect(): void { connectScreen.hidden = false; document.body.dataset.screen = 'connect' }

// --- Wiring -------------------------------------------------------------------------------------
const codeInput = $<HTMLInputElement>('#joa-code')
function paintCode(): void {
	codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
	document.querySelectorAll<HTMLElement>('.joa-code__cells i').forEach((cell, i) => {
		cell.textContent = codeInput.value[i] ?? ''
		if (i === Math.min(7, codeInput.value.length) && codeInput.value.length < 8) cell.dataset.next = ''
		else delete cell.dataset.next
	})
}
codeInput.addEventListener('input', paintCode)
paintCode()
$<HTMLFormElement>('.joa-code').onsubmit = event => {
	event.preventDefault()
	keepResume(null)
	ws?.close()
	void connect({ code: codeInput.value.trim().toUpperCase() })
}
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.onclick = () => selectTab(b.dataset.tab as typeof tab))
document.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach(b => b.onclick = () => zoomAt(Number(b.dataset.zoom) > 0 ? 1.8 : 1 / 1.8, canvas.clientWidth / 2, canvas.clientHeight / 2, true))
$<HTMLButtonElement>('[data-fit]').onclick = () => animateTo({ x: 0.5, y: 0.5, zoom: 1 })
$<HTMLButtonElement>('[data-base]').onclick = () => {
	if (!state) return
	const own = state.contacts.filter(c => c.relation === 'own')
	const anchor = own.filter(c => c.footprint)[0] ?? own[0]
	if (anchor) centreOn(anchor.x, anchor.y, Math.max(view.zoom, 3))
	else message('No base to centre on yet.')
}
$<HTMLButtonElement>('[data-heat]').onclick = event => {
	view.heat = !view.heat
	;(event.currentTarget as HTMLElement).setAttribute('aria-pressed', String(view.heat))
	message(view.heat ? 'Heat on: revealed enemy movement.' : 'Heat off.')
	requestFrame()
}
$<HTMLButtonElement>('[data-vision]').onclick = () => {
	const modes: VisionChoice[] = ['auto', 'white', 'green', 'day']
	vision = modes[(modes.indexOf(vision) + 1) % modes.length]
	if (state) message(vision === 'auto' ? 'Auto vision: follows the battlefield’s day and night.' : `${visionLabel(resolveVision(state, vision))} · manual`)
	render()
}
$<HTMLButtonElement>('[data-aim-cancel]').onclick = () => {
	aiming = false; source = undefined; view.source = null; view.target = null
	power = undefined; aircraft = undefined; selectedGroup = undefined
	action = 'move'
	render()
}
new ResizeObserver(() => { measureInsets(); clampView(); requestFrame() }).observe(mapBox)
window.setInterval(() => { if (state) render() }, 1000)
document.body.dataset.screen = 'connect'
document.body.classList.add('joa-app')
// The pairing link carries the secret as ?p= (query survives QR-camera apps that
// strip fragments; #p= is still accepted for links made before the switch).
const secret = new URLSearchParams(location.search).get('p') ?? new URLSearchParams(location.hash.slice(1)).get('p')
history.replaceState(null, '', location.pathname)
if (secret) void connect({ secret })
else if ((resume = storedResume())) void connect({}, true)
