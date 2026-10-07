#!/usr/bin/env node
// STEELSEED — tools/vramgate
// Makes two `materials` gates executable: `materials.vram` and
// `materials.budget-not-tautology`. Before this, `materials` blocked 9 nodes with ZERO
// runnable gates — see issues/plan-1.md.
//
// §0.2 asks for "total material VRAM within §7 budget and MEASURED, not claimed". The number
// was claimed, and it was wrong.
//
// WHAT THIS FOUND (2026-07-30, now fixed): `Materials.totalVramBytes` accumulated only the
// forge's per-surface sets. The §12.3b terrain atlas was built with no accounting at all, and
// `TerrainAtlas.vramBytes` was computed and read by nobody — verified by grep. At `high` that
// omitted 190.66 MiB of 425.31 MiB, the largest single allocation in the module. The boot log
// and profile.mjs both consumed the short figure, so every VRAM decision made before this was
// made on a number 45% light. Materials now tracks the forge and the atlas separately and sums
// them; see issues/materials-1.md.
//
// The tool MEASURES rather than reading that field, from a source that cannot inherit an
// arithmetic error made there: every GPUDevice.createTexture descriptor at the WebGPU
// boundary, keyed by the
// `steelseed/materials/` label prefix, with bytes recomputed here from the descriptor's own
// size/format/mip/layer fields. §10.1 rule 2 calls the forge's arithmetic recomputed intent
// rather than measurement; two independent numbers that disagree localise the defect, and a
// gate that reads only `totalVramBytes` would inherit whatever that field gets wrong.
//
// RESIDENT, not cumulative. `destroy()` is wrapped too, because the forge allocates a
// scratch field texture that `TextureForge.dispose` frees once every set exists. Summing creations
// alone would over-count by that scratch and produce a DIFFERENT wrong total — worse than the
// undercount it replaces, because it looks rigorous. Peak is reported alongside resident so
// the transient is visible rather than silently dropped.
//
// The budget question is a real contract ambiguity and this tool refuses to hide it. The
// atlas is built OUTSIDE the forge, so it is unclear whether it should count against the
// forge's 25% share (FORGE_VRAM_SHARE) or against the whole §7 `textureVram`
// ceiling. Both comparisons are printed. The gate asserts on the ceiling, because §0.2 says
// "total material VRAM" and the ceiling is what the hardware actually has; the share is
// reported as the forge's self-imposed sub-budget. See the LEAD note in the output.
//
// MEASURES THE BUILT BUNDLE. startPreview runs `vite preview`, which serves web/dist — so a
// source edit is invisible here until `npm run build`. The first run after the accounting fix
// reported the old 234.65 MiB for exactly that reason. That is the right default (the gate
// should measure what ships), but it must be stated.
//
// Usage:
//   node tools/vramgate.mjs [--quality=high|medium|low] [--port=n] [--url=u]
//                           [--allow-claim-gap] [--json=path]
//                           [--probe-ceiling-mib=n]   # §10.1 rule 1 falsification only

import { writeFileSync } from 'node:fs'
import {
	DEFAULT_HEIGHT,
	DEFAULT_WIDTH,
	launchGpuBrowser,
	loadChromium,
	startPreview,
	stopChild,
} from './harness.mjs'

const TOOL = 'vramgate'
const SEED = 'steelseed-default'
const DEV_SIZE = 96
const LABEL_PREFIX = 'steelseed/materials/'
const MIB = 1048576

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
	const hit = argv.find(a => a.startsWith(`--${name}=`))
	return hit == null ? fallback : hit.slice(name.length + 3)
}
const has = name => argv.includes(`--${name}`)

const quality = arg('quality', 'high')
const port = Number(arg('port', '5199'))
const suppliedUrl = arg('url', null)
const jsonOut = arg('json', null)

if (!['low', 'medium', 'high'].includes(quality)) {
	console.error(`${TOOL}: --quality must be low, medium or high`)
	process.exit(2)
}

const chromium = await loadChromium(TOOL)

// Refuse to measure against a server this tool did not start. `vite preview --strictPort`
// exits when the port is taken, but waitForServer polls the URL and an EARLIER server
// answers it — so the run silently succeeds against whatever build that server is serving.
// This actually happened: a crash in this tool's own finally (below) orphaned a vite on 5199,
// and the next run reported plausible numbers from a stale dist in 1.4s.
if (suppliedUrl == null) {
	const occupied = await fetch(`http://127.0.0.1:${port}/`, {
		method: 'GET',
		signal: AbortSignal.timeout(600),
	}).then(r => { r.body?.cancel(); return true }).catch(() => false)
	if (occupied) {
		console.error(`${TOOL}: FAIL — something is already serving 127.0.0.1:${port}.`)
		console.error('  A VRAM census is only meaningful against a known build. Either stop that server')
		console.error(`  (lsof -ti:${port}) or pass --url to measure it deliberately.`)
		process.exit(1)
	}
}

const { baseUrl, server } = await startPreview(port, suppliedUrl)

let browser = null
let exitCode = 0
try {
	// launchGpuBrowser returns { browser, label, warning } — the label identifies which
	// Chromium ran, and a VRAM figure is only comparable against one taken on the same build.
	const launched = await launchGpuBrowser(chromium, TOOL)
	browser = launched.browser
	if (launched.warning != null) console.warn(launched.warning)
	console.log(`${TOOL}: browser = ${launched.label}`)
	const page = await browser.newPage({
		viewport: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
		deviceScaleFactor: 1,
		locale: 'en-US',
		timezoneId: 'UTC',
	})

	// Patch the PROTOTYPE before any page script runs, so no device can be created that
	// escapes the census. GPUDevice exists as a class long before an adapter is requested.
	await page.addInitScript(() => {
		const log = []
		const live = new Map()
		let nextId = 1
		globalThis.__vramCensus = { log, live: () => [...live.values()] }

		const proto = globalThis.GPUDevice?.prototype
		if (proto == null) return
		const realCreate = proto.createTexture
		proto.createTexture = function patchedCreateTexture(desc) {
			const tex = realCreate.call(this, desc)
			const size = desc?.size ?? {}
			const entry = {
				id: nextId++,
				label: String(desc?.label ?? ''),
				// Descriptors accept an array or a dict; normalise both, defaulting the way
				// WebGPU does, so a shorthand call is not silently counted as 0 bytes.
				width: Array.isArray(size) ? (size[0] ?? 0) : (size.width ?? 0),
				height: Array.isArray(size) ? (size[1] ?? 1) : (size.height ?? 1),
				layers: Array.isArray(size) ? (size[2] ?? 1) : (size.depthOrArrayLayers ?? 1),
				format: String(desc?.format ?? ''),
				mips: desc?.mipLevelCount ?? 1,
				sampleCount: desc?.sampleCount ?? 1,
			}
			log.push(entry)
			live.set(entry.id, entry)
			const realDestroy = tex.destroy?.bind(tex)
			if (realDestroy != null)
				tex.destroy = () => { live.delete(entry.id); return realDestroy() }
			return tex
		}
	})

	const url = new URL(baseUrl)
	url.searchParams.set('devmap', '1')
	url.searchParams.set('seed', SEED)
	url.searchParams.set('devsize', String(DEV_SIZE))
	url.searchParams.set('quality', quality)
	await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 })

	// main.ts:123 publishes the app only AFTER `await App.boot()` resolves, and boot forges
	// every material. Waiting on the load event returns long before that, which is how the
	// first version of this tool reported `steelseed is absent` against a perfectly good page.
	// `polling: 100` rather than Playwright's rAF default, matching harness.mjs:174.
	await page.waitForFunction(
		() => {
			const failure = document.getElementById('boot-fail')
			if (failure && !failure.hidden && failure.textContent)
				throw new Error(`boot failed: ${failure.textContent}`)
			return globalThis.steelseed !== undefined
		},
		undefined,
		{ timeout: 120000, polling: 100 },
	)

	const result = await page.evaluate(async ({ prefix }) => {
		const app = globalThis.steelseed
		if (app == null) return { error: 'globalThis.steelseed is absent — main.ts:123 did not run' }

		const census = globalThis.__vramCensus
		if (census == null) return { error: 'census hook missing — GPUDevice.prototype was not patched' }

		// Systems live in the ctx registry under their static id (index.ts:87), not as app
		// properties. profile.mjs:171 reaches materials the same way.
		const mats = app.ctx?.get?.('materials')
		if (mats == null) return { error: "app.ctx.get('materials') returned nothing — the materials system did not register" }
		return {
			claimedTotal: mats?.totalVramBytes ?? null,
			hasAtlas: mats?.atlas != null,
			atlasSelfReported: mats?.atlas?.vramBytes ?? null,
			textureVram: app.config?.q?.textureVram ?? null,
			quality: app.config?.quality ?? null,
			all: census.log.filter(e => e.label.startsWith(prefix)),
			resident: census.live().filter(e => e.label.startsWith(prefix)),
			foreignCount: census.log.filter(e => !e.label.startsWith(prefix)).length,
		}
	}, { prefix: LABEL_PREFIX })

	if (result.error != null) {
		console.error(`${TOOL}: FAIL — ${result.error}`)
		process.exit(1)
	}

	// Bytes per texel, recomputed here rather than imported from forge.ts. Sharing that
	// table would make this measurement a second reading of the same arithmetic, which is
	// exactly what the gate is supposed to cross-check.
	const BPT = {
		r8unorm: 1, r8uint: 1, r8sint: 1,
		rg8unorm: 2, r16float: 2, r16uint: 2, depth16unorm: 2,
		rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4,
		rg16float: 4, r32float: 4, rgb10a2unorm: 4, depth32float: 4, depth24plus: 4,
		'depth24plus-stencil8': 4, rg32float: 8, rgba16float: 8, rgba32float: 16,
	}

	const unknown = new Set()
	/** Full mip chain, level by level — a flat w*h*layers undercounts by ~33%. */
	const bytesOf = e => {
		const bpt = BPT[e.format]
		if (bpt == null) { unknown.add(e.format); return 0 }
		let total = 0
		for (let m = 0; m < e.mips; m++) {
			const w = Math.max(1, e.width >> m)
			const h = Math.max(1, e.height >> m)
			total += w * h * e.layers * bpt * e.sampleCount
		}
		return total
	}

	const sum = list => list.reduce((n, e) => n + bytesOf(e), 0)
	const residentBytes = sum(result.resident)
	const peakBytes = sum(result.all)
	const claimed = result.claimedTotal
	// --probe-ceiling-mib exists for §10.1 rule 1 and nothing else. The budget arm has no
	// naturally reachable red: at `high` the measured 425 MiB sits under a 1024 MiB ceiling
	// and at `low` everything scales down with it, so without a lever the assertion could
	// stay decorative forever and no one would know it was never wired to the measurement.
	// Deliberately named `probe`, and it announces itself in the output so a probe run can
	// never be mistaken for a normal one.
	const probeCeilingMib = arg('probe-ceiling-mib', null)
	const ceiling = probeCeilingMib != null ? Number(probeCeilingMib) * MIB : result.textureVram
	if (probeCeilingMib != null)
		console.log(`${TOOL}: PROBE — §7 ceiling overridden to ${probeCeilingMib} MiB (real ceiling ${((result.textureVram ?? 0) / MIB).toFixed(0)} MiB). Falsification only; not a valid pass.`)
	const share = ceiling == null ? null : Math.floor(ceiling * 0.25)

	const mib = b => `${(b / MIB).toFixed(2)} MiB`
	console.log(`${TOOL}: quality=${result.quality ?? quality}  textureVram ceiling=${mib(ceiling ?? 0)}`)
	console.log(`  material textures: ${result.resident.length} resident of ${result.all.length} created (${result.foreignCount} non-material ignored)`)
	console.log(`  MEASURED resident   ${mib(residentBytes)}   (from ${result.resident.length} descriptors at the WebGPU boundary)`)
	console.log(`  MEASURED peak       ${mib(peakBytes)}   (includes forge scratch, freed by TextureForge.dispose)`)
	console.log(`  CLAIMED  totalVram  ${claimed == null ? 'null' : mib(claimed)}   (Materials.totalVramBytes)`)
	if (result.atlasSelfReported != null)
		console.log(`  atlas self-reports  ${mib(result.atlasSelfReported)}   (TerrainAtlas.vramBytes, now read by Materials.atlasVramBytes)`)

	// Biggest allocations, so a red points at something actionable instead of a total.
	const ranked = [...result.resident].sort((a, b) => bytesOf(b) - bytesOf(a)).slice(0, 5)
	console.log('  largest resident:')
	for (const e of ranked)
		console.log(`    ${mib(bytesOf(e)).padStart(10)}  ${e.label}  ${e.width}x${e.height}x${e.layers} ${e.format} ${e.mips}mip`)

	const problems = []

	if (unknown.size > 0)
		problems.push(`unknown texture format(s) ${[...unknown].join(', ')} — bytes undercounted; add them to BPT`)

	if (result.resident.length === 0)
		problems.push(`no texture carried the '${LABEL_PREFIX}' label. Either materials did not build, or a label was renamed and this gate silently measured nothing — the failure mode it must never have.`)

	// 1. Accounting. The claim must equal the measurement. This is the load-bearing
	//    assertion: it goes red on the atlas gap and stays red until index.ts counts it.
	if (claimed != null && !has('allow-claim-gap')) {
		const gap = residentBytes - claimed
		if (Math.abs(gap) > 1024)
			problems.push(
				`ACCOUNTING: totalVramBytes claims ${mib(claimed)} but ${mib(residentBytes)} is resident — ` +
				`short by ${mib(gap)}. Materials.totalVramBytes must sum BOTH the forge sets and the ` +
				`§12.3b atlas. It counted only the forge until 2026-07-30, which omitted the largest ` +
				`allocation in the module and fed a short figure to profile.mjs and the boot log. ` +
				`If this is red again, something new allocates under the '${LABEL_PREFIX}' prefix ` +
				`without being accounted for.`,
			)
	}

	// 2. Budget, against the §7 ceiling. Reported against the forge's 25% share too, but
	//    NOT asserted on it: the atlas is built outside the forge, so charging it to the
	//    forge's sub-budget is a contract choice a tool may not make silently.
	if (ceiling != null) {
		const pct = (residentBytes / ceiling * 100).toFixed(1)
		console.log(`  vs §7 ceiling       ${pct}% of ${mib(ceiling)}`)
		if (share != null)
			console.log(`  vs forge share      ${(residentBytes / share * 100).toFixed(1)}% of ${mib(share)}  (FORGE_VRAM_SHARE)`)
		if (residentBytes > ceiling)
			problems.push(`BUDGET: resident material VRAM ${mib(residentBytes)} exceeds the §7 textureVram ceiling ${mib(ceiling)} at quality '${result.quality ?? quality}'`)
		if (share != null && residentBytes > share)
			console.log(
				`  LEAD NOTE: resident exceeds the forge's own 25% share by ${mib(residentBytes - share)}. ` +
				'Not asserted — the atlas is built outside the forge, so whether it belongs ' +
				'to that share is a contract question for §7, not a decision this tool may make. It is ' +
				'printed every run so it cannot be forgotten.',
			)
	}

	if (jsonOut != null) {
		writeFileSync(jsonOut, `${JSON.stringify({
			quality: result.quality ?? quality,
			residentBytes, peakBytes, claimedBytes: claimed,
			ceilingBytes: ceiling, forgeShareBytes: share,
			atlasSelfReported: result.atlasSelfReported,
			resident: result.resident.map(e => ({ ...e, bytes: bytesOf(e) })),
		}, null, '\t')}\n`)
		console.log(`  wrote ${jsonOut}`)
	}

	// `materials.budget-not-tautology` is a gate ABOUT a gate: it must prove the budget
	// comparison is still connected to the measurement. Under --assert-budget-can-fail the
	// exit code inverts, so passing means the budget assertion DID fire against a ceiling
	// below the measured figure.
	//
	// Without this inversion the gate could only ever be wired to a command that always
	// exits non-zero, i.e. a gate that can never be green — the exact mirror of the
	// can-never-be-red tautology it was written to kill. The first version of this wiring
	// made precisely that mistake.
	if (has('assert-budget-can-fail')) {
		const fired = problems.some(p => p.startsWith('BUDGET:'))
		for (const p of problems) console.error(`  ${p}`)
		if (fired) {
			console.log(`${TOOL}: PASS — the budget assertion fired against a ${probeCeilingMib} MiB ceiling, so it is wired to the measurement and can go red.`)
			exitCode = 0
		} else {
			console.error(
				`${TOOL}: FAIL — measured ${mib(residentBytes)} against a ${probeCeilingMib} MiB ceiling and the ` +
				'budget assertion did NOT fire. planForge cannot emit an over-budget plan, so an assertion that ' +
				'never fires here is a tautology: it would report green no matter how much VRAM was allocated.',
			)
			exitCode = 1
		}
	} else if (problems.length > 0) {
		for (const p of problems) console.error(`  ${p}`)
		console.error(`${TOOL}: FAIL — ${problems.length} problem(s)`)
		exitCode = 1
	} else {
		console.log(`${TOOL}: PASS — measured resident material VRAM agrees with the claim and fits the §7 ceiling.`)
	}
} catch (err) {
	console.error(`${TOOL}: FAIL — ${err.message}`)
	exitCode = 1
} finally {
	// Each cleanup is isolated. The first version of this block did `browser.close()` on the
	// { browser, label } WRAPPER, so `.close` was undefined, the TypeError propagated out of
	// the finally, and stopChild(server) never ran — orphaning a vite preview that then made
	// the NEXT run measure a stale dist. A cleanup step that can skip the following cleanup
	// step is the same defect process-group.mjs was written to end.
	if (browser != null) {
		try {
			await browser.close()
		} catch (error) {
			console.error(`${TOOL}: browser close failed — ${error.message}`)
			exitCode = exitCode === 0 ? 1 : exitCode
		}
	}
	if (server != null) await stopChild(server)
}

process.exit(exitCode)
