// Console controls for the pre-match screens.
//
// The native <select> elements stay the single source of truth: every gate, the start
// config and the lobby commands read them. These controls are PROXIES — they write the
// select and dispatch a bubbling `change`, and they re-sync whenever the select changes,
// whoever changed it. Nothing here touches the DOM at module scope (Node harnesses bundle
// the UI without a document).

/** A UI sound hook, installed by the UI node; controls stay silent until one is set. */
export type ControlCue = 'focus' | 'select' | 'toggleOn' | 'toggleOff' | 'step' | 'open' | 'close' | 'confirm' | 'error'
let cueHook: ((cue: ControlCue, variant?: number) => void) | null = null
export function setControlCues(hook: ((cue: ControlCue, variant?: number) => void) | null): void { cueHook = hook }
function cue(name: ControlCue, variant?: number): void { cueHook?.(name, variant) }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag)
	if (className) node.className = className
	if (text !== undefined) node.textContent = text
	return node
}

/** Set a select's value the way a player would, so every listener sees it. */
export function setSelect(select: HTMLSelectElement, value: string): void {
	if (select.value === value) return
	select.value = value
	select.dispatchEvent(new Event('change', { bubbles: true }))
}

function optionEntries(select: HTMLSelectElement): { value: string; label: string; disabled: boolean }[] {
	return [...select.options].map(o => ({ value: o.value, label: o.textContent ?? o.value, disabled: o.disabled }))
}

/**
 * A segmented radio group over a select (≤ 4 short values). Arrow keys move and select, like
 * native radios; Home/End jump; one tab stop.
 */
export function segmented(select: HTMLSelectElement, opts: { label: string; labels?: Readonly<Record<string, string>>; order?: readonly string[] }): HTMLElement {
	const group = el('div', 'seg')
	group.setAttribute('role', 'radiogroup')
	group.setAttribute('aria-label', opts.label)
	const entries = optionEntries(select)
	const ordered = opts.order ? opts.order.map(v => entries.find(e => e.value === v)).filter((e): e is typeof entries[number] => !!e) : entries
	const buttons = ordered.map(entry => {
		const b = el('button', 'seg__opt', opts.labels?.[entry.value] ?? entry.label)
		b.type = 'button'
		b.setAttribute('role', 'radio')
		b.dataset.value = entry.value
		b.disabled = entry.disabled
		if (entry.disabled) b.dataset.optionDisabled = '1'
		b.addEventListener('click', () => {
			if (select.disabled || b.disabled) return
			const was = select.value
			setSelect(select, entry.value)
			if (was !== entry.value) cue(entry.value === 'True' ? 'toggleOn' : entry.value === 'False' ? 'toggleOff' : 'select')
		})
		return b
	})
	group.append(...buttons)
	const sync = (): void => {
		for (const b of buttons) {
			const on = b.dataset.value === select.value
			b.setAttribute('aria-checked', String(on))
			b.tabIndex = on ? 0 : -1
		}
		if (!buttons.some(b => b.tabIndex === 0) && buttons[0]) buttons[0].tabIndex = 0
		group.toggleAttribute('data-disabled', select.disabled)
		for (const b of buttons) b.disabled = select.disabled || b.dataset.optionDisabled === '1'
	}
	group.addEventListener('keydown', event => {
		const i = buttons.findIndex(b => b === document.activeElement)
		if (i < 0) return
		const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
			: event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
		const jump = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
		if (step === 0 && jump < 0) return
		event.preventDefault()
		let next = jump >= 0 ? jump : i
		if (jump < 0) for (let n = 0; n < buttons.length; n++) {
			next = (next + step + buttons.length) % buttons.length
			if (!buttons[next].disabled) break
		}
		buttons[next].focus()
		buttons[next].click()
	})
	select.addEventListener('change', sync)
	sync()
	return group
}

/** OFF | ON over a `False`/`True` select. */
export function toggle(select: HTMLSelectElement, label: string): HTMLElement {
	return segmented(select, { label, labels: { False: 'Off', True: 'On' }, order: ['False', 'True'] })
}

/**
 * − value + over an ordered select (numeric options, game speed). The value reads in an
 * `<output>`; ←/→ and −/+ step it when the group has focus.
 */
export function stepper(select: HTMLSelectElement, opts: { label: string; format?: (value: string, label: string) => string }): HTMLElement {
	const group = el('div', 'stepper')
	group.setAttribute('role', 'group')
	group.setAttribute('aria-label', opts.label)
	const dec = el('button', 'stepper__btn', '−')
	const inc = el('button', 'stepper__btn', '+')
	dec.type = inc.type = 'button'
	dec.setAttribute('aria-label', `Decrease ${opts.label.toLowerCase()}`)
	inc.setAttribute('aria-label', `Increase ${opts.label.toLowerCase()}`)
	const out = el('output', 'stepper__value')
	out.setAttribute('aria-live', 'polite')
	group.append(dec, out, inc)
	const move = (delta: number): void => {
		if (select.disabled) return
		const i = select.selectedIndex + delta
		if (i < 0 || i >= select.options.length) return
		setSelect(select, select.options[i].value)
		// Eight pitches: map the position, not the raw index, so short and long lists both climb.
		cue('step', Math.round(7 * i / Math.max(1, select.options.length - 1)))
	}
	dec.addEventListener('click', () => move(-1))
	inc.addEventListener('click', () => move(1))
	group.addEventListener('keydown', event => {
		const delta = event.key === 'ArrowRight' || event.key === '+' || event.key === '=' ? 1
			: event.key === 'ArrowLeft' || event.key === '-' ? -1 : 0
		if (delta === 0) return
		event.preventDefault()
		move(delta)
	})
	const sync = (): void => {
		const opt = select.options[select.selectedIndex]
		const label = opt?.textContent ?? select.value
		out.textContent = opts.format ? opts.format(select.value, label) : label
		dec.disabled = select.disabled || select.selectedIndex <= 0
		inc.disabled = select.disabled || select.selectedIndex >= select.options.length - 1
		group.toggleAttribute('data-disabled', select.disabled)
	}
	select.addEventListener('change', sync)
	sync()
	return group
}

/** One setting as a row: label + description on the left, its control on the right. */
export function ruleRow(opts: { label: string; description?: string; control: HTMLElement; id?: string }): HTMLElement {
	const row = el('div', 'rule')
	if (opts.id) row.dataset.rule = opts.id
	const text = el('div', 'rule__text')
	const label = el('span', 'rule__label', opts.label)
	text.append(label)
	if (opts.description) text.append(el('span', 'rule__desc', opts.description))
	const control = el('div', 'rule__control')
	control.append(opts.control)
	row.append(text, control)
	return row
}

export interface Disclosure {
	readonly root: HTMLElement
	readonly button: HTMLButtonElement
	readonly body: HTMLElement
	readonly summary: HTMLElement
	setOpen(open: boolean): void
	isOpen(): boolean
}

let disclosureSeq = 0
/** A module that collapses: header button + body. A collapsed body is `inert`. */
export function disclosure(opts: { index: string; title: string; open?: boolean; className?: string }): Disclosure {
	const root = el('section', `module disclosure${opts.className ? ` ${opts.className}` : ''}`)
	const id = `disclosure-${++disclosureSeq}`
	const button = el('button', 'module__head disclosure__head')
	button.type = 'button'
	button.setAttribute('aria-controls', id)
	const index = el('span', 'module__index', opts.index)
	const title = el('span', 'module__title', opts.title)
	const summary = el('span', 'disclosure__summary')
	const chevron = el('span', 'disclosure__chevron')
	chevron.setAttribute('aria-hidden', 'true')
	button.append(index, title, summary, chevron)
	const body = el('div', 'disclosure__body')
	body.id = id
	const inner = el('div', 'disclosure__inner')
	body.append(inner)
	root.append(button, body)
	let open = false
	const apply = (): void => {
		button.setAttribute('aria-expanded', String(open))
		root.toggleAttribute('data-open', open)
		body.inert = !open
	}
	button.addEventListener('click', () => { open = !open; apply(); cue(open ? 'open' : 'close') })
	open = !!opts.open
	apply()
	return {
		root, button, body: inner, summary,
		setOpen(next) { open = next; apply() },
		isOpen: () => open,
	}
}

/** Roving tabindex over a group of buttons (one tab stop, arrows move). */
export function rovingGroup(container: HTMLElement, selector: string): void {
	const items = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(selector)].filter(i => !i.hidden && !(i as HTMLButtonElement).disabled)
	const settle = (active?: HTMLElement): void => {
		const list = items()
		const current = active ?? list.find(i => i.tabIndex === 0) ?? list[0]
		for (const i of list) i.tabIndex = i === current ? 0 : -1
	}
	container.addEventListener('focusin', event => { if (items().includes(event.target as HTMLElement)) settle(event.target as HTMLElement) })
	container.addEventListener('keydown', event => {
		const list = items()
		const i = list.indexOf(document.activeElement as HTMLElement)
		if (i < 0) return
		const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (i + 1) % list.length
			: event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (i - 1 + list.length) % list.length
			: event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : -1
		if (next < 0) return
		event.preventDefault()
		list[next].focus()
	})
	settle()
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface Overlay { close(): void }
/**
 * Open a sheet or dialog: the `hidden` attribute toggles, focus moves in (to `initial` or the
 * first focusable), Tab is trapped, Esc and a scrim click close, focus returns to the opener.
 */
export function openOverlay(root: HTMLElement, opts: { opener?: HTMLElement | null; initial?: HTMLElement | null; onClose?: () => void } = {}): Overlay {
	const opener = opts.opener ?? (document.activeElement as HTMLElement | null)
	root.hidden = false
	root.dataset.open = '1'
	cue('open')
	// getClientRects, not offsetParent: fixed-position dialogs have no offsetParent.
	const focusables = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(f => f.getClientRects().length > 0 && !f.closest('[inert]'))
	const first = opts.initial ?? focusables()[0]
	requestAnimationFrame(() => first?.focus())
	let closed = false
	const close = (): void => {
		if (closed) return
		closed = true
		root.hidden = true
		delete root.dataset.open
		root.removeEventListener('keydown', onKey)
		root.removeEventListener('pointerdown', onScrim)
		cue('close')
		opts.onClose?.()
		opener?.focus?.()
	}
	const onKey = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
		if (event.key !== 'Tab') return
		const list = focusables()
		if (list.length === 0) return
		const at = list.indexOf(document.activeElement as HTMLElement)
		if (event.shiftKey && (at <= 0)) { event.preventDefault(); list[list.length - 1].focus() }
		else if (!event.shiftKey && at === list.length - 1) { event.preventDefault(); list[0].focus() }
	}
	const onScrim = (event: PointerEvent): void => { if (event.target === root) close() }
	root.addEventListener('keydown', onKey)
	root.addEventListener('pointerdown', onScrim)
	return { close }
}
