// The boot screen: the loader every player sees first, and for half a minute on a first visit.
//
// It has to be honest about that wait. The red line moves only on real progress and never
// goes back, a phase that runs long says so with a live timer, and a failure says in one
// sentence what went wrong and what to do next.
//
// App.boot reports free-text stages (core/app.ts: 'selecting backend', 'loading <system>',
// 'prewarming pipelines', 'ready'); main.ts adds 'booting the simulation engine'. This module
// maps them onto five named steps and draws everything on #boot except the contract main.ts
// keeps writing itself (#boot-status, #boot[data-fraction], #boot-bar.indeterminate and
// #boot-percent), because the desktop shell and the gates read exactly those.
//
// Rule 8 applies in full: this is decoration on the boot path, so it must never break the
// boot. Every element is optional, storage and the clipboard are guarded, and each public
// call falls back to a plain answer if its drawing code throws.

export type BootStepId = 'engine' | 'graphics' | 'battlefield' | 'arsenal' | 'shaders'

/** How one reported stage reads to a player. */
export interface BootStage {
	/** The step this stage belongs to; null for stages outside the sequence. */
	readonly step: BootStepId | null
	/** Plain-language caption for #boot-status, which the desktop shell mirrors. */
	readonly caption: string
	/** What the active step is working on right now; null keeps the step's own summary. */
	readonly detail: string | null
}

/** What main.ts writes into the contract elements after a progress call. */
export interface BootView {
	readonly caption: string
	/** The fraction the line shows: it never goes back, and 0 means still indeterminate. */
	readonly shown: number
}

export interface BootScreen {
	progress(stage: string, fraction: number): BootView
	fail(error: unknown): void
	done(): void
}

const STEPS: readonly { readonly id: BootStepId, readonly name: string }[] = [
	{ id: 'engine', name: 'Engine' },
	{ id: 'graphics', name: 'Graphics' },
	{ id: 'battlefield', name: 'Battlefield' },
	{ id: 'arsenal', name: 'Arsenal' },
	{ id: 'shaders', name: 'Shaders' },
]

// App.boot names each system as it loads ('loading <id>'), grouped here the way a player
// thinks of them: the ground first, then everything that moves on it. An id missing from
// this table goes by its place on the line.
const SYSTEMS = new Map<string, readonly [BootStepId, string]>([
	['anim', ['battlefield', 'animation']],
	['materials', ['battlefield', 'materials']],
	['render', ['battlefield', 'renderer']],
	['terrain', ['battlefield', 'terrain']],
	['sky', ['battlefield', 'sky and weather']],
	['shroud', ['battlefield', 'fog of war']],
	['units', ['arsenal', 'units and structures']],
	['camera', ['arsenal', 'camera']],
	['audio', ['arsenal', 'audio']],
	['fx', ['arsenal', 'effects']],
	['ui', ['arsenal', 'interface']],
	['wrecks', ['arsenal', 'wreckage']],
])

/** One step running longer than this shows the first-visit note. */
const SLOW_MS = 12_000
/** The compositor clock counts to 99 s; the text clock takes over after that. */
const CLOCK_MS = 99_500
/** Tips turn over this often, unless the card is hovered or focused. */
const TIP_MS = 9_000
/** Each visit starts on the next tip, so a returning player sees new ones. */
const TIP_KEY = 'redline-boot-tip'
/** Settings may store 'reduced' here; the OS setting counts either way. */
const MOTION_KEY = 'redline-motion'

const STATUS_WORDS = { pending: 'waiting', active: 'in progress', done: 'done', failed: 'failed' } as const
type StepStatus = keyof typeof STATUS_WORDS

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** Map a reported stage onto a step and a plain-language caption. */
export function describeBootStage(stage: string, fraction: number): BootStage {
	const s = stage.trim()
	switch (s) {
		case 'initialising': return { step: null, caption: 'Initialising', detail: null }
		case 'booting the simulation engine': return { step: 'engine', caption: 'Starting the simulation engine', detail: null }
		case 'selecting backend': return { step: 'graphics', caption: 'Choosing the graphics backend', detail: null }
		case 'prewarming pipelines': return { step: 'shaders', caption: 'Compiling shaders', detail: null }
		case 'ready': return { step: null, caption: 'Ready', detail: null }
	}
	const loading = /^loading (.+)$/.exec(s)
	if (loading) {
		const known = SYSTEMS.get(loading[1])
		const label = known?.[1] ?? loading[1]
		return { step: known?.[0] ?? (fraction < 0.45 ? 'battlefield' : 'arsenal'), caption: `Loading ${label}`, detail: sentence(label) }
	}
	return { step: null, caption: sentence(s), detail: null }
}

/** One sentence a player can act on, chosen from the error text. */
export function bootFailureReason(message: string): string {
	if (/WebGPU|adapter|WebGL/i.test(message))
		return 'This browser could not start 3D graphics. Update it or turn on hardware acceleration, then retry.'
	if (/fetch|network|Failed to load|404|dynamically imported module|Importing a module/i.test(message))
		return 'Part of the game could not be downloaded. Check your connection, then retry.'
	return 'Something stopped the game from starting. Retry, and send the diagnostics if it happens again.'
}

/** A finished step's time: tenths under ten seconds, whole seconds under a minute, then m:ss. */
export function formatStepTime(ms: number): string {
	if (ms < 100) return '<0.1 s'
	const seconds = ms / 1000
	return seconds < 9.95 ? `${seconds.toFixed(1)} s` : formatSeconds(Math.round(seconds))
}

function formatSeconds(seconds: number): string {
	return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function rawError(error: unknown): string {
	return error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}`.trim() : String(error)
}

/** The drawn half of the screen; the public wrapper below guards every call into it. */
interface Drawing {
	progress(stage: string, info: BootStage, shown: number): void
	fail(error: unknown, shown: number): void
	done(): void
}

/**
 * Bind the loader markup in index.html. The returned calls never throw: if the drawing
 * fails, progress still answers with a caption and a monotonic fraction, and fail() still
 * shows #boot-fail with the raw error the way the gates expect.
 */
export function createBootScreen(): BootScreen {
	let shown = 0
	let drawing: Drawing | null = null
	try {
		drawing = draw()
	} catch (error) {
		console.warn('[boot] the loader screen could not start; plain boot continues', error)
	}
	const guarded = (what: string, call: (d: Drawing) => void): boolean => {
		if (drawing === null) return false
		try {
			call(drawing)
			return true
		} catch (error) {
			console.warn(`[boot] loader ${what} failed`, error)
			return false
		}
	}
	return {
		progress(stage, fraction) {
			const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
			if (f > shown) shown = f
			const info = describeBootStage(stage, f)
			guarded('progress', d => d.progress(stage, info, shown))
			return { caption: info.caption, shown }
		},
		fail(error) {
			if (guarded('failure card', d => d.fail(error, shown))) return
			const card = document.getElementById('boot-fail')
			if (card === null) return
			card.hidden = false
			card.textContent = rawError(error)
		},
		done() {
			guarded('exit', d => d.done())
		},
	}
}

function draw(): Drawing {
	const root = document.getElementById('boot')
	if (root === null) throw new Error('#boot is missing')
	const find = <T extends HTMLElement = HTMLElement>(selector: string): T | null => root.querySelector<T>(selector)

	const line = find('#boot-line')
	const stepList = find('#boot-steps')
	const announcer = find('#boot-announce')
	const announce = (text: string): void => {
		if (announcer) announcer.textContent = text
	}

	// Reduced motion: the OS setting or a stored Settings choice. The loader's CSS also reads
	// the media query directly, so this only has to be right, not early.
	let reduced = false
	try { reduced = matchMedia('(prefers-reduced-motion: reduce)').matches } catch { /* no matchMedia */ }
	try { reduced ||= localStorage.getItem(MOTION_KEY) === 'reduced' } catch { /* storage blocked */ }
	document.documentElement.dataset.motion = reduced ? 'reduced' : 'full'

	// The active step's seconds, drawn by the compositor (digit strips stepped by transform),
	// because the boot runs main-thread tasks of ten seconds and more: a text clock would stall
	// exactly when the wait is longest. Under reduced motion the text clock alone is shown.
	const digitStrip = (first: string, className: string): HTMLElement => {
		const view = document.createElement('span')
		view.className = 'boot-clock__w'
		const strip = document.createElement('span')
		if (className) strip.className = className
		for (const digit of [first, ...'123456789']) {
			const cell = document.createElement('i')
			cell.textContent = digit
			strip.append(cell)
		}
		view.append(strip)
		return view
	}

	const steps = STEPS.map(def => {
		const el = find(`.boot-step[data-step="${def.id}"]`)
		const detail = el?.querySelector<HTMLElement>('.boot-step__detail') ?? null
		return {
			name: def.name,
			el,
			detail,
			summary: detail?.textContent ?? '',
			time: el?.querySelector<HTMLElement>('.boot-step__time') ?? null,
			state: el?.querySelector<HTMLElement>('.boot-sr') ?? null,
			status: 'pending' as StepStatus,
			start: 0,
			seconds: -1,
			clock: null as HTMLElement | null,
		}
	})
	type Step = (typeof steps)[number]

	const startClock = (step: Step): void => {
		if (step.el === null || document.documentElement.dataset.motion === 'reduced') return
		const clock = document.createElement('span')
		if (typeof clock.animate !== 'function') return
		clock.className = 'boot-clock'
		clock.setAttribute('aria-hidden', 'true')
		const tens = digitStrip('', 'boot-clock__tens')
		const ones = digitStrip('0', '')
		const unit = document.createElement('span')
		unit.textContent = '\u00a0s'
		clock.append(tens, ones, unit)
		step.el.append(clock)
		step.el.setAttribute('data-clock', '')
		step.clock = clock
		// Pinned to the step's start on the document timeline (performance.now()'s clock), so a
		// long task between here and the first composited frame cannot put the count behind.
		const roll = [{ transform: 'translateY(0)' }, { transform: 'translateY(-10em)' }]
		const pinned = [
			(tens.firstElementChild as HTMLElement).animate(roll, { duration: 100_000, iterations: Infinity, easing: 'steps(10, end)' }),
			(ones.firstElementChild as HTMLElement).animate(roll, { duration: 10_000, iterations: Infinity, easing: 'steps(10, end)' }),
			// Nothing to count in the first second: the clock appears showing "1 s".
			clock.animate([{ opacity: 0 }, { opacity: 0, offset: 0.999 }, { opacity: 1 }], { duration: 1000, fill: 'forwards' }),
		]
		for (const animation of pinned) animation.startTime = step.start
	}
	const stopClock = (step: Step): void => {
		step.clock?.remove()
		step.clock = null
		step.el?.removeAttribute('data-clock')
	}

	let active = -1 // the running step; steps.length once every step is settled
	let finished = false // failed or done: the clocks are stopped for good
	let slow = false
	let lastStage = 'initialising'
	let failure = { where: '', raw: '' }

	const setStatus = (step: Step, status: StepStatus): void => {
		step.status = status
		if (step.el) step.el.dataset.status = status
		if (step.state) step.state.textContent = STATUS_WORDS[status]
	}
	// Close a step: its time if it ran, a plain tick if the boot never stopped there.
	const settle = (step: Step, at: number): void => {
		if (step.status === 'active' && step.time) step.time.textContent = formatStepTime(at - step.start)
		stopClock(step)
		setStatus(step, 'done')
		if (step.detail) step.detail.textContent = step.summary
	}
	const activate = (index: number, detail: string | null, at: number): void => {
		if (index < active) return // the line never goes back
		const step = steps[index]
		if (index > active) {
			for (let i = Math.max(active, 0); i < index; i++) if (steps[i].status !== 'done') settle(steps[i], at)
			active = index
			step.start = at
			step.seconds = -1
			if (step.time) step.time.textContent = ''
			setStatus(step, 'active')
			startClock(step)
			announce(`Step ${index + 1} of ${steps.length}: ${step.name}.`)
		}
		if (step.detail) step.detail.textContent = detail ?? step.summary
	}

	// One clock for every live readout: the active step's seconds and the first-visit note.
	const tick = (): void => {
		const step = steps[active]
		if (step === undefined || step.status !== 'active') return
		const elapsed = performance.now() - step.start
		const seconds = Math.floor(elapsed / 1000)
		if (seconds !== step.seconds) {
			step.seconds = seconds
			if (step.time) step.time.textContent = seconds > 0 ? formatSeconds(seconds) : ''
		}
		if (step.clock !== null && elapsed >= CLOCK_MS) stopClock(step)
		if (!slow && elapsed > SLOW_MS) {
			slow = true
			root.setAttribute('data-slow', '')
		}
	}
	const ticker = setInterval(tick, 250)

	const settleAll = (at: number): void => {
		for (let i = Math.max(active, 0); i < steps.length; i++) if (steps[i].status !== 'done') settle(steps[i], at)
		active = steps.length
		clearInterval(ticker)
		stepList?.setAttribute('aria-busy', 'false')
	}

	// Tips. The card's bottom edge is the clock: one Web Animation per tip, so hovering or
	// focusing the card pauses the bar and the turn together.
	const listening = new AbortController()
	const bound = { signal: listening.signal }
	const tipCard = find('#boot-tip')
	const tipList = find('#boot-tip-list')
	const tipCount = find('#boot-tip-count')
	const tipTimer = find('#boot-tip-timer')
	const tips = Array.from(root.querySelectorAll<HTMLElement>('.boot-tip__item'))
	let tip = 0
	let tipClock: Animation | null = null
	let hovering = false
	let focusInside = false

	const runTipClock = (): void => {
		tipClock?.cancel()
		tipClock = null
		if (finished || tips.length < 2 || tipTimer === null || typeof tipTimer.animate !== 'function') return
		const clock = tipTimer.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: TIP_MS, easing: 'linear', fill: 'forwards' })
		clock.onfinish = () => {
			if (tipClock === clock) showTip(tip + 1)
		}
		if (hovering || focusInside) clock.pause()
		tipClock = clock
	}
	const showTip = (index: number, instant = false): void => {
		if (tips.length === 0) return
		tip = ((index % tips.length) + tips.length) % tips.length
		if (instant) tipCard?.setAttribute('data-instant', '')
		tips.forEach((item, i) => item.toggleAttribute('data-active', i === tip))
		if (tipCount) tipCount.textContent = `${tip + 1}/${tips.length}`
		if (instant && tipCard) {
			void tipCard.offsetWidth // commit the switch without its cross-fade
			tipCard.removeAttribute('data-instant')
		}
		runTipClock()
	}
	const holdTips = (): void => {
		const hold = hovering || focusInside
		tipCard?.toggleAttribute('data-paused', hold)
		// Someone inside the card with a keyboard or a screen reader hears the tip they turn to.
		tipList?.setAttribute('aria-live', focusInside ? 'polite' : 'off')
		if (tipClock === null) return
		if (hold) tipClock.pause()
		else if (tipClock.playState === 'paused') tipClock.play()
	}
	if (tipCard) {
		tipCard.addEventListener('pointerenter', () => { hovering = true; holdTips() }, bound)
		tipCard.addEventListener('pointerleave', () => { hovering = false; holdTips() }, bound)
		tipCard.addEventListener('focusin', () => { focusInside = true; holdTips() }, bound)
		tipCard.addEventListener('focusout', event => {
			if (tipCard.contains(event.relatedTarget as Node | null)) return
			focusInside = false
			holdTips()
		}, bound)
	}
	find('#boot-tip-prev')?.addEventListener('click', () => showTip(tip - 1), bound)
	find('#boot-tip-next')?.addEventListener('click', () => showTip(tip + 1), bound)
	window.addEventListener('keydown', event => {
		if (finished || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
		// Only while nothing else holds the keyboard: the page itself, or the loader.
		const focus = document.activeElement
		if (focus !== null && focus !== document.body && !root.contains(focus)) return
		showTip(tip + (event.key === 'ArrowLeft' ? -1 : 1))
	}, bound)

	let firstTip = 0
	try {
		const last = localStorage.getItem(TIP_KEY)
		if (last !== null && tips.length > 0) firstTip = (Number.parseInt(last, 10) + 1) % tips.length || 0
		localStorage.setItem(TIP_KEY, String(firstTip))
	} catch { /* storage blocked: every visit opens on the first tip */ }
	showTip(firstTip, true)

	// Stops every clock and removes every loading-time listener (the failure card's own
	// buttons are bound separately and keep working).
	const stop = (): void => {
		clearInterval(ticker)
		tipClock?.cancel()
		tipClock = null
		listening.abort()
	}

	// Failure card actions.
	find('#boot-retry')?.addEventListener('click', () => location.reload())
	const copyButton = find<HTMLButtonElement>('#boot-copy')
	const copyLabel = copyButton?.textContent ?? 'Copy diagnostics'
	let copyReset = 0
	const confirmCopy = (label: string, spoken: string): void => {
		if (copyButton === null) return
		copyButton.textContent = label
		announce(spoken)
		clearTimeout(copyReset)
		copyReset = window.setTimeout(() => { copyButton.textContent = copyLabel }, 2400)
	}
	const selectRaw = (): void => {
		const details = find<HTMLDetailsElement>('#boot-fail-details')
		const raw = find('#boot-fail-raw')
		if (details) details.open = true
		if (raw) {
			const range = document.createRange()
			range.selectNodeContents(raw)
			const selection = getSelection()
			selection?.removeAllRanges()
			selection?.addRange(range)
		}
		confirmCopy('Selected below', 'The diagnostics are selected below. Copy them with the keyboard.')
	}
	copyButton?.addEventListener('click', () => {
		const text = [
			'Redline Wars: boot failed',
			failure.where,
			`Last stage: ${lastStage}`,
			'',
			failure.raw,
			'',
			`Browser: ${navigator.userAgent}`,
			`Page: ${location.href}`,
			`Time: ${new Date().toISOString()}`,
		].join('\n')
		const clipboard: Clipboard | undefined = navigator.clipboard
		try {
			if (clipboard === undefined || typeof clipboard.writeText !== 'function') throw new Error('no clipboard')
			clipboard.writeText(text).then(() => confirmCopy('Copied', 'Diagnostics copied.'), selectRaw)
		} catch {
			selectRaw()
		}
	})

	return {
		progress(stage, info, shownNow) {
			lastStage = stage
			if (finished) return
			const at = performance.now()
			if (stage.trim() === 'ready') {
				settleAll(at)
				root.dataset.state = 'ready'
				announce('Ready.')
			} else if (info.step !== null) {
				activate(STEPS.findIndex(s => s.id === info.step), info.detail, at)
			}
			if (shownNow > 0) {
				root.dataset.meter = 'determinate'
				root.style.setProperty('--boot-p', shownNow.toFixed(4))
				line?.setAttribute('aria-valuenow', String(Math.round(shownNow * 100)))
			}
		},

		fail(error, shownNow) {
			const leaving = finished // after done() the loader is already on its way out
			stop()
			finished = true
			const at = performance.now()
			const index = active < 0 ? 0 : Math.min(active, steps.length - 1)
			const step = steps[index]
			if (step.status === 'active' && step.time) step.time.textContent = formatStepTime(at - step.start)
			stopClock(step)
			setStatus(step, 'failed')
			root.dataset.state = 'failed'
			stepList?.setAttribute('aria-busy', 'false')

			const message = error instanceof Error ? error.message : String(error)
			failure = {
				where: `Stopped at ${String(index + 1).padStart(2, '0')} ${step.name}${shownNow > 0 ? ` · ${Math.round(shownNow * 100)}%` : ''}`,
				raw: rawError(error),
			}
			const where = find('#boot-fail-where')
			const reason = find('#boot-fail-reason')
			const raw = find('#boot-fail-raw')
			if (where) where.textContent = failure.where
			if (reason) reason.textContent = bootFailureReason(message)
			if (raw) raw.textContent = failure.raw
			const card = find('#boot-fail')
			if (card) card.hidden = false
			announce('Boot failed.')
			if (!leaving) find('#boot-retry')?.focus()
		},

		done() {
			stop()
			finished = true
			if (root.dataset.state !== 'ready' && root.dataset.state !== 'failed') {
				settleAll(performance.now())
				root.dataset.state = 'ready'
			}
			stepList?.setAttribute('aria-busy', 'false')
			root.inert = true
		},
	}
}
