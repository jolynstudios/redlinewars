// STEELSEED — entry point.
//
// Boots core, connects the WASM bridge, registers whichever subsystems exist, and
// starts the frame loop. Nodes are registered by presence: the graph is built
// bottom-up (ARCHITECTURE.md §2) and this file must keep working at every stage of
// that build, so a subsystem that has not landed yet is simply absent rather than a
// hard boot failure. Hard rule 8: never break the boot.

import { App, type BridgeApi, createDevBridge, type QualityDetection, resolveDistantMountains, resolveQuality, setDevTypeNames, setDevTypeNamesExact, type SystemClass } from './core'
import DEV_ROSTER from './units/archetype/roster.json'
import { loadBrandFonts } from './brand-fonts'
import { createBootScreen } from './boot-screen'
import { startBootSoundtrack } from './boot-sound'
import { sharedMusic } from './audio/music'

// First, so the loader's type is already on its way while the engine boots.
loadBrandFonts()

const canvas = document.getElementById('viewport') as HTMLCanvasElement
const bootEl = document.getElementById('boot')!
const barEl = document.getElementById('boot-bar')!
const percentEl = document.getElementById('boot-percent')!
const statusEl = document.getElementById('boot-status')!
// Steps, live timers, tips and the failure card. It never throws; this file keeps writing
// the contract the desktop shell and the gates read.
const bootScreen = createBootScreen()
// The menu song plays from the loading bar on (boot-sound.ts). The desktop shell boots this
// page hidden while its own landing plays the Theme, so there the soundtrack waits for the menu.
if (typeof (globalThis as { redline?: unknown }).redline !== 'object')
	startBootSoundtrack(sharedMusic(), document.getElementById('boot-sound'))

// Navigation-relative stages make a slow boot diagnosable from one console capture.
console.info(`[boot] stage=dom ms=${Math.round(performance.now())}`)

function progress(stage: string, fraction: number): void {
	const view = bootScreen.progress(stage, fraction)
	// The shell mirrors #boot-status as its own loader label, so it gets the plain-language
	// caption, and it polls dataset.fraction raw for its own meter.
	statusEl.textContent = view.caption
	bootEl.dataset.fraction = String(fraction)
	// Zero-fraction stages keep the indeterminate sweep. The line and the percent follow the
	// shown fraction, which never goes back.
	if (view.shown > 0) {
		barEl.classList.remove('indeterminate')
		percentEl.textContent = String(Math.round(view.shown * 100))
	}
}

function bootFailed(err: unknown): void {
	statusEl.textContent = 'Boot failed'
	// Shows #boot-fail (visible, with the raw message and stack) and stops every loader clock.
	bootScreen.fail(err)
	// Log it so it lands in the console and in capture.mjs's page-error check — a boot
	// failure that only shows in the DOM would pass a headless "did it render" gate.
	console.error('[steelseed] boot failed', err)
}

/**
 * Subsystems land over the course of the build graph, so this must work at every stage
 * of that build.
 *
 * `import.meta.glob` resolves at BUILD time and only ever matches files that exist. An
 * earlier revision looped over the node names and blind-imported each one inside a
 * try/catch — which worked, but every unbuilt node still issued a real HTTP request and
 * logged a 404. `capture.mjs` counts any console error as a gate failure (rule 8), so
 * the boot gate would have failed on its own scaffolding, and a genuine error would
 * have been buried among a dozen expected ones.
 */
const NODE_MODULES = import.meta.glob<Record<string, unknown>>('./{materials,render,sky,terrain,structures,units,anim,shroud,camera,fx,wrecks,ui,audio}/index.ts')

async function collectSystems(): Promise<SystemClass[]> {
	const out: SystemClass[] = []
	// Deduped by id. A node that exports both its class and a value alias to the same
	// class would otherwise register twice and kill the boot with "duplicate id" — which
	// is exactly what happened once. Nodes should export one system class, but a
	// packaging slip in someone else's directory must not break everyone's boot (rule 8).
	const seen = new Set<string>()
	for (const load of Object.values(NODE_MODULES)) {
		const mod = await load()
		for (const v of Object.values(mod)) {
			if (typeof v !== 'function') continue
			const id = (v as SystemClass).id
			if (typeof id !== 'string' || seen.has(id)) continue
			seen.add(id)
			out.push(v as SystemClass)
		}
	}
	return out
}

/**
 * The C# bridge is published onto globalThis by the WASM host's main.js once interop
 * is up. Null when the web layer is running standalone (vite dev, tool harnesses),
 * in which case core runs with no simulation and every node renders an empty world.
 */
async function getBridge(params: URLSearchParams): Promise<BridgeApi | null> {
	const g = globalThis as {
		steelseedBridge?: BridgeApi
		steelseedBridgeReady?: Promise<BridgeApi>
	}
	// The host publishes this Promise synchronously before its first await. Module script
	// order cannot make the bridge itself synchronous: this module runs while dotnet.create
	// is still pending. A rejected host boot remains a boot failure here, never a dev fallback.
	if (g.steelseedBridgeReady !== undefined) return await g.steelseedBridgeReady
	if (g.steelseedBridge) return g.steelseedBridge

	// ?devmap=1 serves a generated snapshot in the real §4 binary layout, so the whole
	// web layer is developable and gateable without the WASM host — which lives in a
	// separate AppBundle and is not present under `vite preview` at all. It also gives
	// baseline.mjs a FIXED input; a live simulation is not reproducible and §10's
	// reproducibility gate cannot be built on one.
	if (params.get('devmap') === '1') {
		// The composition root is the only place allowed to know both `core` and the roster, so
		// this is where the fixture learns what the game actually contains. Before it, the
		// fixture wrote `typeId = i % 5` against a five-name table and every performance number
		// in §11.4 — including the 200-unit reference the whole headroom argument rests on —
		// exercised four archetype hulls out of ninety-seven.
		if (params.get('tanks') === '1') {
			setDevTypeNamesExact(['1tnk', '2tnk', '3tnk', '4tnk'])
		} else if (params.get('devtypes') !== null) {
			// A named fixture table for gates and authoring: ?devtypes=mcv,fact spawns
			// exactly those actors, so a gate can rely on one being present.
			const devtypes = params.get('devtypes') ?? ''
			setDevTypeNamesExact(devtypes.split(',').map(s => s.trim()).filter(Boolean))
		} else {
			setDevTypeNames((DEV_ROSTER as { slots: { name: string }[] }).slots.map(s => s.name))
		}
		const size = Number(params.get('devsize') ?? (params.get('tanks') === '1' ? 48 : 96))
		// Optional §4.2 overrides. A missing parameter stays undefined so buildDevSnapshot
		// applies its own default — `Number(null)` is 0, which would silently pin every
		// capture to midnight in clear weather.
		const num = (key: string): number | undefined => {
			const raw = params.get(key)
			return raw === null ? undefined : Number(raw)
		}
		return createDevBridge({
			width: size,
			height: size,
			seed: params.get('seed') ?? 'devmap',
			// §7.1's budget is defined on a 200-unit engagement, and §11.3 records that
			// workload as UNMEASURED — every published figure came from the 24-actor
			// devmap. Exposing the knob is what makes the ladder's cost evaluable at all
			// (`quality-1` rung 0.1a); without it the "~5 ms spare" figure stays an
			// inference drawn across two different workloads.
			actorCount: num('devactors') ?? (params.get('tanks') === '1' ? 8 : undefined),
			clusterRadius: num('devcluster') ?? (params.get('tanks') === '1' ? 6 : undefined),
			renderFps: num('devfps'),
			// Pins the atmosphere for a capture without touching the sky node: it reads
			// §4.2 and nothing else, so this drives the real onSnapshot path.
			timeOfDay: num('devtod'),
			weatherKind: num('devweather'),
			weatherIntensity: num('devweatherintensity'),
			windDirection: num('devwinddir'),
			windSpeed: num('devwindspeed'),
			revealMap: params.get('fog') === '0',
		}) as BridgeApi
	}

	return null
}

async function main(): Promise<void> {
	const params = new URLSearchParams(location.search)
	const systems = await collectSystems()

	// URL, then the lobby's stored choice, then a hardware guess. Published before boot so
	// the lobby can show what was decided and why.
	const quality: QualityDetection = await resolveQuality(params)
	;(globalThis as { steelseedQuality?: QualityDetection }).steelseedQuality = quality
	console.info(`[quality] ${quality.choice} → ${quality.tier} (${quality.source}): ${quality.reason}`)

	// The dotnet engine boots BEFORE App.boot can name a stage — the bridge await below
	// is the longest opaque wait. An honest indeterminate stripe plus a real stage name
	// beats a bar frozen at someone's guess. The first App.boot progress call retires it.
	barEl.classList.add('indeterminate')
	progress('booting the simulation engine', 0)
	const bridge = await getBridge(params)
	console.info(`[boot] stage=session-available ms=${Math.round(performance.now())} available=${bridge !== null}`)

	const app = await App.boot({
		canvas,
		systems,
		bridge,
		quality: quality.tier,
		graphicsChoice: quality.choice,
		distantMountains: resolveDistantMountains(params),
		assetSeed: params.get('seed') ?? undefined,
		// Set by baseline.mjs and imagediff.mjs: fixed timestep, DPR pinned to 1, no
		// wall-clock reads, so two runs produce bit-identical frames.
		deterministic: params.get('deterministic') === '1',
		// Measurement only (vfx.md Epic 0): time every GPU pass through timestamp queries.
		gpuTiming: params.get('gputime') === '1',
		onProgress: progress,
	})

	// Exposed for the harness (capture/profile/dbgview/playtest drive the app directly
	// rather than through rAF, which cannot be made reproducible).
	;(globalThis as { steelseed?: App }).steelseed = app

	// The loader stops its clocks and goes inert; .done drops every pointer event at once
	// (gates click START during the fade) and hidden follows once the fade is over.
	bootScreen.done()
	bootEl.classList.add('done')
	setTimeout(() => { bootEl.hidden = true }, 450)
	// The setup underneath plays its one-time reveal as the loader fades.
	const sessionUi = document.getElementById('session-ui')
	if (sessionUi) sessionUi.dataset.intro = '1'

	// Deterministic tools drive renderOneFrame() themselves. Starting rAF as well would
	// inject an uncounted number of snapshots before a clip can pin its first frame.
	// A manual boot must still hand over a decoded world: gates read ctx.snapshot
	// right after the global exists, and pumpSnapshots holds first-world intake
	// until the actor-type table lands, so wait for that handshake here.
	if (params.get('manual') !== '1') app.start()
	else await app.ensureFirstSnapshot()

	console.info(
		`[steelseed] booted — backend=${app.ctx.backend} graphics=${app.config.graphicsChoice} quality=${app.config.q.name} ` +
			`systems=[${app.registry.systemIds.join(', ') || 'none'}] seed=${app.config.assetSeed}`,
	)
}

main().catch(bootFailed)
