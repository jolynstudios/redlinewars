// STEELSEED — ui/tutorial
// The first-match tutorial on screen: one coach card beside the HUD element it explains and an
// ice ring around that element. It never pauses the match and never takes the battlefield: only
// the card receives pointer events. Content and rules live in ui/tutorial-steps.

import {
	buildStatus, facts, lowPower, stepComplete, stepUnavailable,
	type TutorialStep, type TutorialWorld,
} from './tutorial-steps'

export interface TutorialElements {
	readonly root: HTMLElement
	readonly ring: HTMLElement
	readonly count: HTMLElement
	readonly title: HTMLElement
	readonly body: HTMLElement
	readonly facts: HTMLElement
	readonly status: HTMLElement
	readonly order: HTMLOListElement
	readonly back: HTMLButtonElement
	readonly next: HTMLButtonElement
	readonly skip: HTMLButtonElement
	readonly close: HTMLButtonElement
}

export interface TutorialOptions {
	/** Skipped (true) or finished (false): either way it is over for good. */
	readonly onEnd: (skipped: boolean) => void
	readonly cue?: (name: 'open' | 'confirm' | 'close') => void
}

/** HUD panels the card should not cover when it has a choice. */
const AVOID = ['#hud-economy', '#hud-controls', '#hud-production', '#hud-selection', '#hud-left-col', '#hud-compass', '#hud-ready', '#hud-minimise']
const MARGIN = 12
const GAP = 14
/** A step that just completed shows its ✓ this long before the next one takes over. */
const DONE_HOLD_MS = 1200

type Rect = { left: number; top: number; right: number; bottom: number }

function visibleRect(element: Element | null): DOMRect | null {
	if (!element) return null
	const rect = element.getBoundingClientRect()
	return rect.width > 0 && rect.height > 0 ? rect : null
}

function overlap(a: Rect, b: Rect): number {
	const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
	const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
	return w > 0 && h > 0 ? w * h : 0
}

export class Tutorial {
	private readonly el: TutorialElements
	private readonly options: TutorialOptions
	private steps: TutorialStep[]
	private index = 0
	/** Completed build/deploy steps stay complete, even if the building is lost later. */
	private readonly completed = new Set<string>()
	private doneAt = 0
	private world: TutorialWorld | null = null
	private placedFor = ''
	private active = false
	/** The build item scrolls into view once per step, never against the player's own scrolling. */
	private scrolledFor = ''

	private readonly onNext = (): void => this.advance(1)
	private readonly onBack = (): void => this.advance(-1)
	private readonly onSkip = (): void => this.end(true)
	/** A new window size reflows the HUD: bring the build tile back into view and re-place the card. */
	private readonly onResize = (): void => { this.placedFor = ''; this.scrolledFor = ''; this.layout() }

	constructor(elements: TutorialElements, steps: TutorialStep[], options: TutorialOptions) {
		this.el = elements
		this.steps = steps
		this.options = options
		elements.next.addEventListener('click', this.onNext)
		elements.back.addEventListener('click', this.onBack)
		elements.skip.addEventListener('click', this.onSkip)
		elements.close.addEventListener('click', this.onSkip)
		window.addEventListener('resize', this.onResize)
	}

	get running(): boolean { return this.active }
	get stepId(): string { return this.steps[this.index]?.id ?? '' }

	start(): void {
		this.active = true
		this.index = 0
		this.completed.clear()
		this.el.root.hidden = false
		this.render()
		this.options.cue?.('open')
	}

	/** New steps (the faction resolved late): keep the player on the same step where possible. */
	setSteps(steps: TutorialStep[]): void {
		const id = this.stepId
		this.steps = steps
		const at = steps.findIndex(step => step.id === id)
		this.index = at >= 0 ? at : Math.min(this.index, steps.length - 1)
		if (this.active) this.render()
	}

	/** Once per HUD tick: completion, auto-advance, the live status line, the ring. */
	update(world: TutorialWorld): void {
		if (!this.active) return
		this.world = world
		const step = this.steps[this.index]
		if (!step) return
		const now = performance.now()
		const before = this.completed.size
		for (const candidate of this.steps)
			if (!this.completed.has(candidate.id) && stepComplete(candidate, world)) this.completed.add(candidate.id)
		if (this.completed.size !== before) this.renderOrder(step)
		if (this.completed.has(step.id) && (step.kind === 'build' || step.kind === 'deploy')) {
			if (this.doneAt === 0) {
				this.doneAt = now
				this.options.cue?.('confirm')
			} else if (now - this.doneAt >= DONE_HOLD_MS) {
				this.advance(1)
				return
			}
		} else if (stepUnavailable(step, world)) {
			this.advance(1)
			return
		}
		this.refreshLive(step, world)
		this.layout()
	}

	/** Hide and unbind. The caller drops its reference. */
	destroy(): void {
		this.active = false
		this.el.root.hidden = true
		this.el.ring.hidden = true
		this.el.next.removeEventListener('click', this.onNext)
		this.el.back.removeEventListener('click', this.onBack)
		this.el.skip.removeEventListener('click', this.onSkip)
		this.el.close.removeEventListener('click', this.onSkip)
		window.removeEventListener('resize', this.onResize)
	}

	private end(skipped: boolean): void {
		if (!this.active) return
		this.options.cue?.('close')
		this.destroy()
		this.options.onEnd(skipped)
	}

	/** Next/Back. Moving forward passes build steps that are already done or not on offer. */
	private advance(direction: 1 | -1): void {
		let index = this.index + direction
		while (index >= 0 && index < this.steps.length) {
			const step = this.steps[index]
			const passed = direction === 1 && this.world !== null &&
				(this.completed.has(step.id) || stepUnavailable(step, this.world) || (step.kind === 'minimap' && !this.targetVisible(step)))
			if (!passed) break
			index += direction
		}
		if (index >= this.steps.length) {
			this.end(false)
			return
		}
		this.index = Math.max(0, index)
		this.doneAt = 0
		this.render()
		if (direction === 1) this.options.cue?.('confirm')
	}

	private render(): void {
		const step = this.steps[this.index]
		if (!step) return
		const { el } = this
		const last = this.index === this.steps.length - 1
		el.count.textContent = step.build
			? `Build order · ${step.build.index + 1} of ${step.build.total}`
			: `Tutorial · ${this.index + 1} of ${this.steps.length}`
		el.title.textContent = step.title
		el.body.textContent = step.body
		el.facts.hidden = !step.build
		el.facts.textContent = step.build ? facts(step.build) : ''
		el.back.hidden = this.index === 0
		el.next.textContent = step.kind === 'welcome' ? 'Start' : last ? 'Finish' : step.kind === 'build' || step.kind === 'deploy' ? 'Skip step' : 'Next'
		el.root.dataset.kind = step.kind
		this.renderOrder(step)
		this.placedFor = ''
		this.scrolledFor = ''
		if (this.world) this.refreshLive(step, this.world)
		else el.status.hidden = true
		this.layout()
	}

	/** The whole opening at a glance, checked off as the player builds. */
	private renderOrder(step: TutorialStep): void {
		const list = this.el.order
		const builds = this.steps.filter(candidate => candidate.kind === 'build')
		list.hidden = step.kind !== 'build' && step.kind !== 'production'
		if (list.hidden) return
		list.replaceChildren(...builds.map(candidate => {
			const item = document.createElement('li')
			item.textContent = candidate.build ? candidate.build.name.replace(/^(Allied|Soviet) /, '') : candidate.title
			item.dataset.state = this.completed.has(candidate.id) ? 'done' : candidate.id === step.id ? 'current' : 'todo'
			return item
		}))
	}

	private refreshLive(step: TutorialStep, world: TutorialWorld): void {
		const status = this.el.status
		let text = ''
		let state = ''
		if (step.kind === 'build') {
			const live = buildStatus(step, world)
			text = live.text
			state = live.state
			if (lowPower(world) && live.state !== 'done') {
				text = `${text} Low power: production is slowed. Build another Power Plant.`.trim()
				state = 'warn'
			}
		} else if (step.kind === 'deploy') {
			const done = this.completed.has(step.id)
			text = done ? '✓ Construction Yard deployed' : 'Waiting for your Construction Yard…'
			state = done ? 'done' : 'idle'
		}
		if (status.textContent !== text) status.textContent = text
		status.hidden = text === ''
		status.dataset.state = state
	}

	private targetVisible(step: TutorialStep): boolean {
		return this.targetElement(step) !== null
	}

	/** The element the ring shows: a ready card in the tray beats the build tile; missing falls back. */
	private targetElement(step: TutorialStep): Element | null {
		if (!step.target) return null
		if (step.build) {
			const tray = document.querySelector(`#hud-ready-list [data-actor-name="${step.build.type}"]`)
			if (visibleRect(tray)) return tray
			const tile = document.querySelector(step.target)
			const pane = document.getElementById('hud-queues')
			const tileRect = visibleRect(tile)
			const paneRect = visibleRect(pane)
			if (tile && tileRect && paneRect) {
				if (this.scrolledFor !== step.id) {
					this.scrolledFor = step.id
					tile.scrollIntoView({ block: 'nearest', inline: 'nearest' })
					return tile
				}
				// Scrolled out of the pane by the player: point at the pane instead.
				if (tileRect.bottom > paneRect.top && tileRect.top < paneRect.bottom) return tile
			}
			return visibleRect(document.getElementById('hud-production')) ? document.getElementById('hud-production') : null
		}
		if (step.kind === 'deploy') {
			const deploy = document.getElementById('hud-deploy')
			if (visibleRect(deploy)) return deploy
			return visibleRect(document.getElementById('hud-selection')) ? document.getElementById('hud-selection') : null
		}
		const element = document.querySelector(step.target)
		return visibleRect(element) ? element : null
	}

	/** Ring on the target; the card on the side that covers the least of the rest of the HUD. */
	private layout(): void {
		const step = this.steps[this.index]
		if (!step || !this.active) return
		const { root, ring } = this.el
		const target = this.targetElement(step)
		const targetRect = visibleRect(target)
		if (targetRect) {
			ring.hidden = false
			ring.style.transform = `translate(${Math.round(targetRect.left - 6)}px, ${Math.round(targetRect.top - 6)}px)`
			ring.style.width = `${Math.round(targetRect.width + 12)}px`
			ring.style.height = `${Math.round(targetRect.height + 12)}px`
		} else {
			ring.hidden = true
		}
		const key = `${step.id}:${targetRect ? `${Math.round(targetRect.left)},${Math.round(targetRect.top)},${Math.round(targetRect.width)},${Math.round(targetRect.height)}` : '-'}:${root.offsetHeight}`
		if (key === this.placedFor) return
		this.placedFor = key
		const vw = window.innerWidth
		const vh = window.innerHeight
		const cw = root.offsetWidth
		const ch = root.offsetHeight
		const clampX = (x: number): number => Math.max(MARGIN, Math.min(vw - cw - MARGIN, x))
		const clampY = (y: number): number => Math.max(MARGIN, Math.min(vh - ch - MARGIN, y))
		let best = { x: clampX((vw - cw) / 2), y: clampY(Math.min(110, vh * 0.14)) }
		if (targetRect) {
			const t = targetRect
			const avoid: Rect[] = []
			// Candidate spots hug the target and every avoided panel that holds it: beside the tile
			// is inside the build pane, beside the pane is not.
			const anchors: Rect[] = [t]
			for (const selector of AVOID) {
				const element = document.querySelector(selector)
				// The panel holding the target stays clear too: covering the rest of it hides the context.
				if (!element || element === target || target?.contains(element)) continue
				const rect = visibleRect(element)
				if (!rect) continue
				avoid.push(rect)
				if (target && element.contains(target)) anchors.push(rect)
			}
			const centreX = t.left + t.width / 2 - cw / 2
			const centreY = t.top + t.height / 2 - ch / 2
			let bestScore = Number.POSITIVE_INFINITY
			for (const a of anchors) {
				const candidates = [
					{ x: a.left - GAP - cw, y: centreY }, { x: a.right + GAP, y: centreY },
					{ x: centreX, y: a.top - GAP - ch }, { x: centreX, y: a.bottom + GAP },
					{ x: a.left - GAP - cw, y: a.top }, { x: a.right + GAP, y: a.top },
					{ x: a.left - GAP - cw, y: a.bottom - ch }, { x: a.right + GAP, y: a.bottom - ch },
					{ x: a.left, y: a.bottom + GAP }, { x: a.right - cw, y: a.bottom + GAP },
					{ x: a.left, y: a.top - GAP - ch }, { x: a.right - cw, y: a.top - GAP - ch },
				]
				for (const candidate of candidates) {
					const x = clampX(candidate.x)
					const y = clampY(candidate.y)
					const box = { left: x, top: y, right: x + cw, bottom: y + ch }
					// Covering the target defeats the point; other panels cost what they lose; among
					// clear spots, the nearest to the target wins.
					let score = overlap(box, t) * 50 + Math.abs(x - candidate.x) + Math.abs(y - candidate.y)
					for (const rect of avoid) score += overlap(box, rect)
					score += 0.2 * Math.hypot(x + cw / 2 - (t.left + t.width / 2), y + ch / 2 - (t.top + t.height / 2))
					if (score < bestScore) { bestScore = score; best = { x, y } }
				}
			}
		}
		root.style.transform = `translate(${Math.round(best.x)}px, ${Math.round(best.y)}px)`
	}
}
