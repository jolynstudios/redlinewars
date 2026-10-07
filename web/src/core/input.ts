// STEELSEED — core/input
// Raw input capture. `core` captures; `camera` interprets. This split matters: the
// camera owns view movement; UI owns selection and contextual game orders.
//
// §0.3 known inherited boundary: there is no touch input in the WASM host. Pointer
// events are captured here so a future touch path has somewhere to land, but the
// `ui`/`camera` nodes must either fix or explicitly accept the gap.

export interface PointerState {
	/** CSS pixels, relative to the canvas. */
	x: number
	y: number
	/** Movement since the previous frame, CSS pixels. */
	dx: number
	dy: number
	/** Accumulated wheel delta since the previous frame. */
	wheel: number
	/** Bit per button: 1<<0 left, 1<<1 middle, 1<<2 right. */
	buttons: number
	/** Buttons that went down this frame. */
	pressed: number
	/** Buttons that came up this frame. */
	released: number
	/** True while the pointer is over the canvas. */
	inside: boolean
	/** Rearmed by real pointer movement; cleared on entry, blur or a camera-orbit gesture. */
	edgeReady: boolean
	/** Last event's pointer type: 'mouse' | 'touch' | 'pen'. New tablet behavior gates on this. */
	pointerType: string
	/** Two-finger pinch (log scale) and midpoint pan for this frame. 0 while not gesturing. */
	pinch: number
	panX: number
	panY: number
	/** A touch or pen pointer is currently down. */
	touch: boolean
}

export class Input {
	readonly pointer: PointerState = {
		x: 0, y: 0, dx: 0, dy: 0, wheel: 0,
		buttons: 0, pressed: 0, released: 0, inside: false, edgeReady: false,
		pointerType: 'mouse', pinch: 0, panX: 0, panY: 0, touch: false,
	}

	private keysDown = new Set<string>()
	private keysPressed = new Set<string>()
	private keysReleased = new Set<string>()
	private prevX = 0
	private prevY = 0
	private wheelAccum = 0
	private pendingPressed = 0
	private pendingReleased = 0
	private detach: (() => void)[] = []
	// Active touch/pen pointers. Mouse never enters: the pre-existing single-pointer
	// mouse path must stay byte-identical (owner hard constraint).
	private pointers = new Map<number, { x: number; y: number }>()
	/** Alt (Option) + left-drag orbits like the middle button: a trackpad has no wheel to press. */
	private altOrbit = false
	private primaryTouchId: number | null = null
	private gestureDist = 0
	private gestureMidX = 0
	private gestureMidY = 0
	private nextFramePress = 0
	private canvas: HTMLCanvasElement | null = null

	attach(canvas: HTMLCanvasElement): void {
		this.canvas = canvas
		const on = <K extends keyof HTMLElementEventMap>(
			target: HTMLElement | Window,
			type: K | string,
			fn: (e: never) => void,
			opts?: AddEventListenerOptions,
		) => {
			target.addEventListener(type, fn as EventListener, opts)
			this.detach.push(() => target.removeEventListener(type, fn as EventListener, opts))
		}

	on(canvas, 'pointermove', (e: PointerEvent) => {
		const r = canvas.getBoundingClientRect()
		const x = e.clientX - r.left
		const y = e.clientY - r.top
		this.pointer.pointerType = e.pointerType
		if (e.pointerType === 'mouse') {
			this.pointer.x = x
			this.pointer.y = y
			this.pointer.edgeReady = true
			return
		}
		// Touch/pen: every active pointer lands in the map; the first one down drives
		// the shared PointerState so single-finger semantics equal mouse-left.
		this.pointers.set(e.pointerId, { x, y })
		this.pointer.touch = true
		this.pointer.inside = true
		if (this.primaryTouchId === null || this.primaryTouchId === e.pointerId) {
			this.primaryTouchId = e.pointerId
			this.pointer.x = x
			this.pointer.y = y
		}
	})
	on(canvas, 'pointerdown', (e: PointerEvent) => {
		const r = canvas.getBoundingClientRect()
		const x = e.clientX - r.left
		const y = e.clientY - r.top
		this.pointer.pointerType = e.pointerType
		if (e.pointerType !== 'mouse') {
			this.pointers.set(e.pointerId, { x, y })
			this.pointer.touch = true
			this.pointer.inside = true
			if (this.pointers.size === 1) {
				this.primaryTouchId = e.pointerId
				this.pointer.x = x
				this.pointer.y = y
				this.pointer.buttons |= 1
				this.pendingPressed |= 1
			}
			// A second finger starts the pinch/pan gesture: the first finger's press
			// is dropped so no selection or order can fire mid-gesture.
			if (this.pointers.size === 2) {
				this.pendingPressed &= ~1
				this.pointer.buttons &= ~1
				this.gestureDist = 0
			}
			canvas.setPointerCapture(e.pointerId)
			return
		}
		this.pointer.x = x
		this.pointer.y = y
		this.pointer.inside = true
		// Alt/Option + left button is an orbit, reported as the middle button for the whole drag.
		this.altOrbit = e.button === 0 && e.altKey
		// Starting an orbit must not consume movement that preceded the press.
		if (e.button === 1 || this.altOrbit) {
			this.prevX = this.pointer.x
			this.prevY = this.pointer.y
		}
		const bit = this.altOrbit ? 2 : 1 << e.button
		this.pointer.buttons |= bit
		this.pendingPressed |= bit
		// Capture so a drag that leaves the canvas still delivers its pointerup —
		// otherwise a box-select started near the edge sticks down forever.
		canvas.setPointerCapture(e.pointerId)
	})
	on(canvas, 'pointerup', (e: PointerEvent) => {
		const r = canvas.getBoundingClientRect()
		const x = e.clientX - r.left
		const y = e.clientY - r.top
		this.pointer.x = x
		this.pointer.y = y
		if (e.pointerType !== 'mouse') {
			const wasGesture = this.pointers.size >= 2
			this.pointers.delete(e.pointerId)
			if (this.primaryTouchId === e.pointerId) this.primaryTouchId = this.pointers.keys().next().value ?? null
			if (this.pointers.size === 0) {
				// A quick tap can go down/up/leave between two rAFs. Keep its release
				// inside for the frame that consumes it, then clear hover in endFrame.
				this.pointer.inside = x >= 0 && x < r.width && y >= 0 && y < r.height
				this.pointer.edgeReady = false
				this.pointer.touch = false
				// A plain tap settles its selection; a finger leaving a pinch does not.
				if (!wasGesture) this.pendingReleased |= 1
				this.pointer.buttons &= ~1
				this.gestureDist = 0
			}
			if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
			return
		}
		// The orbit ends with the left button, even when Alt was let go first.
		const bit = e.button === 0 && this.altOrbit ? 2 : 1 << e.button
		if (e.button === 0) this.altOrbit = false
		this.pointer.buttons &= ~bit
		this.pendingReleased |= bit
		if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
	})
	// Safari steals the touch for system gestures; today buttons would stick down.
	on(canvas, 'pointercancel', (e: PointerEvent) => {
		if (e.pointerType === 'mouse') return
		this.pointers.delete(e.pointerId)
		if (this.primaryTouchId === e.pointerId) this.primaryTouchId = this.pointers.keys().next().value ?? null
		if (this.pointers.size === 0) {
			this.pointer.touch = false
			this.pointer.buttons &= ~1
			this.gestureDist = 0
			this.pointer.inside = false
			this.pointer.edgeReady = false
		}
	})
		on(canvas, 'pointerenter', () => {
			this.pointer.inside = true
			// Hiding the setup overlay can expose the canvas under a stationary cursor and
			// synthesise pointerenter. Do not let that stale position scroll away from spawn.
			this.pointer.edgeReady = false
		})
	on(canvas, 'pointerleave', (e: PointerEvent) => {
		// Touch leave follows every finger lift, even when the lift happened on
		// the canvas. The queued release still needs its position next frame.
		if (e.pointerType !== 'mouse') return
		this.pointer.inside = false
		this.pointer.edgeReady = false
	})
		on(canvas, 'wheel', (e: WheelEvent) => {
			e.preventDefault()
			// deltaMode 1 is lines, 2 is pages. Normalising to pixels keeps zoom speed
			// consistent across Firefox (which reports lines) and Chromium.
			const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1
			this.wheelAccum += e.deltaY * k
		}, { passive: false })
		// Right-click issues an RTS order; the browser menu is never wanted.
		on(canvas, 'contextmenu', (e: Event) => e.preventDefault())

		on(window, 'keydown', (e: KeyboardEvent) => {
			if (e.repeat) return
			this.keysDown.add(e.code)
			this.keysPressed.add(e.code)
		})
		on(window, 'keyup', (e: KeyboardEvent) => {
			this.keysDown.delete(e.code)
			this.keysReleased.add(e.code)
		})
		// A tab switch mid-drag would otherwise leave keys and buttons stuck down.
		on(window, 'blur', () => this.clearAll())
	}

	/** Call once per frame, before systems update. */
	beginFrame(): void {
		const p = this.pointer
		p.dx = p.x - this.prevX
		p.dy = p.y - this.prevY
		this.prevX = p.x
		this.prevY = p.y
		p.wheel = this.wheelAccum
		this.wheelAccum = 0
		p.pressed = this.pendingPressed
		p.released = this.pendingReleased
		this.pendingPressed = 0
		this.pendingReleased = 0
		this.pendingPressed |= this.nextFramePress
		this.nextFramePress = 0
		// Two-finger gesture: pinch and midpoint pan for this frame, with the finger
		// press/release bits suppressed so a pinch can never select or order.
		if (this.pointers.size === 2) {
			const [a, b] = [...this.pointers.values()]
			const dist = Math.hypot(a.x - b.x, a.y - b.y)
			const midX = (a.x + b.x) / 2
			const midY = (a.y + b.y) / 2
			if (this.gestureDist > 0) {
				p.pinch = Math.log(dist / this.gestureDist)
				p.panX = midX - this.gestureMidX
				p.panY = midY - this.gestureMidY
			}
			this.gestureDist = dist
			this.gestureMidX = midX
			this.gestureMidY = midY
			p.pressed = 0
			p.released = 0
			p.buttons = 0
		} else {
			p.pinch = 0
			p.panX = 0
			p.panY = 0
			this.gestureDist = 0
		}
	}

	/** Call once per frame, after systems update. */
	endFrame(): void {
		this.keysPressed.clear()
		this.keysReleased.clear()
		// Touch has no hover. Clear it after UI consumed the release, without a
		// cross-frame flag that could race a second finger or a new press.
		if (this.pointer.pointerType !== 'mouse' && this.pointers.size === 0) {
			this.pointer.inside = false
			this.pointer.edgeReady = false
		}
	}

	isDown(code: string): boolean {
		return this.keysDown.has(code)
	}
	wasPressed(code: string): boolean {
		return this.keysPressed.has(code)
	}
	wasReleased(code: string): boolean {
		return this.keysReleased.has(code)
	}
	get shift(): boolean {
		return this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight')
	}
	get ctrl(): boolean {
		return this.keysDown.has('ControlLeft') || this.keysDown.has('ControlRight')
	}
	get alt(): boolean {
		return this.keysDown.has('AltLeft') || this.keysDown.has('AltRight')
	}

	private clearAll(): void {
		this.keysDown.clear()
		this.keysPressed.clear()
		this.pendingReleased |= this.pointer.buttons
		this.pointer.buttons = 0
		this.pointer.edgeReady = false
		this.pointers.clear()
		this.primaryTouchId = null
		this.pointer.touch = false
		this.gestureDist = 0
		this.nextFramePress = 0
	}


	dispose(): void {
		for (const d of this.detach) d()
		this.detach = []
		this.clearAll()
		this.canvas = null
	}
}
