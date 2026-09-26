// STEELSEED — render/targets
// The size-dependent GPU textures: depth, the HDR scene target, and the TAA history pair.
//
// Recreated on resize and never per frame. Pipelines are NOT recreated here — rule 10
// wants zero pipeline creations during play, and a pipeline depends on formats, which do
// not change, not on extents, which do.

export const COLOR_FORMAT: GPUTextureFormat = 'rgba16float'
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float'
/** Current screen UV minus previous screen UV, written by the depth prepass. */
export const VELOCITY_FORMAT: GPUTextureFormat = 'rg16float'
/** Octahedral normal RG, roughness B, visible/reflective surface code A. */
export const REFLECTION_FORMAT: GPUTextureFormat = 'rgba8unorm'

export class RenderTargets {
	private readonly device: GPUDevice
	width = 1
	height = 1

	depth!: GPUTexture
	depthView!: GPUTextureView
	velocity!: GPUTexture
	velocityView!: GPUTextureView
	reflection!: GPUTexture
	reflectionView!: GPUTextureView
	color!: GPUTexture
	colorView!: GPUTextureView
	/** Ping-pong TAA accumulation. `historyIndex` selects this frame's destination. */
	history: (GPUTexture | null)[] = [null, null]
	historyViews: (GPUTextureView | null)[] = [null, null]
	historyIndex = 0

	constructor(device: GPUDevice) {
		this.device = device
	}

	/** Returns true when the extent actually changed and dependent bind groups must be rebuilt. */
	allocate(width: number, height: number): boolean {
		const w = Math.max(1, Math.floor(width))
		const h = Math.max(1, Math.floor(height))
		if (this.depth && w === this.width && h === this.height) return false
		this.release()
		this.width = w
		this.height = h

		this.depth = this.device.createTexture({
			label: 'render.depth',
			size: { width: w, height: h },
			format: DEPTH_FORMAT,
			// TEXTURE_BINDING as well as RENDER_ATTACHMENT: TAA reads the same depth buffer
			// the forward pass wrote, to reproject world positions. COPY_SRC so dbgview can
			// read depth back directly (§5.6) — without it the copy is a validation error
			// that silently yields zeros, which is indistinguishable from an empty depth
			// buffer.
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
		})
		this.depthView = this.depth.createView()

		// Object and camera motion share one authoritative AOV. The depth prepass already
		// rasterises the exact geometry TAA needs, including the selected LOD and skin pose;
		// writing velocity there avoids reconstructing a camera-only approximation later.
		this.velocity = this.device.createTexture({
			label: 'render.velocity',
			size: { width: w, height: h },
			format: VELOCITY_FORMAT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
		})
		this.velocityView = this.velocity.createView()
		this.reflection = this.device.createTexture({
			label: 'render.reflection-metadata',
			size: { width: w, height: h },
			format: REFLECTION_FORMAT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
		})
		this.reflectionView = this.reflection.createView()

		// COPY_SRC on the HDR and history targets so the harness can read them back.
		// `dbgview.mjs` needs it to show intermediate stages (§8), and without it a
		// "which stage went black" question can only be answered by guesswork — a
		// copyTextureToBuffer against a texture lacking it is a validation error, the
		// submit is dropped, and the readback silently returns all zeros, which reads
		// exactly like a black render. It costs no memory; the flag only permits a copy.
		this.color = this.device.createTexture({
			label: 'render.hdr',
			size: { width: w, height: h },
			format: COLOR_FORMAT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
		})
		this.colorView = this.color.createView()

		for (let i = 0; i < 2; i++) {
			const t = this.device.createTexture({
				label: `render.history${i}`,
				size: { width: w, height: h },
				format: COLOR_FORMAT,
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
			})
			this.history[i] = t
			this.historyViews[i] = t.createView()
		}
		this.historyIndex = 0
		return true
	}

	/** This frame's TAA destination. */
	get currentHistoryView(): GPUTextureView {
		return this.historyViews[this.historyIndex]!
	}

	/** Last frame's accumulation, the one TAA reprojects into. */
	get previousHistoryView(): GPUTextureView {
		return this.historyViews[1 - this.historyIndex]!
	}

	flipHistory(): void {
		this.historyIndex = 1 - this.historyIndex
	}

	release(): void {
		if (this.depth) this.depth.destroy()
		if (this.velocity) this.velocity.destroy()
		if (this.reflection) this.reflection.destroy()
		if (this.color) this.color.destroy()
		for (let i = 0; i < 2; i++) {
			this.history[i]?.destroy()
			this.history[i] = null
			this.historyViews[i] = null
		}
		this.depth = undefined as unknown as GPUTexture
		this.velocity = undefined as unknown as GPUTexture
		this.reflection = undefined as unknown as GPUTexture
		this.color = undefined as unknown as GPUTexture
	}
}
