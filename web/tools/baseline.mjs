#!/usr/bin/env node
// STEELSEED — tools/baseline
// End-to-end reproducibility gate: two isolated runs, same fixed input and asset seed,
// exact RGBA comparison for every named shot.
//
// Usage:
//   node tools/baseline.mjs [--shots all|a,b] [--seed s] [--frames n]
//                           [--out dir] [--url u] [--port n] [--keep-server]

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
	DEFAULT_FRAMES,
	WEB_ROOT,
	captureShot,
	launchGpuBrowser,
	loadChromium,
	selectShots,
	startPreview,
	stopChild,
	writeShot,
} from './harness.mjs'

const { flags } = parseArgs(process.argv.slice(2))
const value = (name, fallback) => flags.has(name) ? flags.get(name) : fallback
const port = positiveInteger(value('port', 8380), 'port')
const frames = positiveInteger(value('frames', DEFAULT_FRAMES), 'frames')
const width = positiveInteger(value('width', 1512), 'width')
const height = positiveInteger(value('height', 982), 'height')
const seed = String(value('seed', 'steelseed-baseline-v1'))
const shots = selectShots(value('shots', 'all'))
const outDir = resolve(value('out', join(WEB_ROOT, '.artifacts', 'baseline')))
const suppliedUrl = value('url', null)

let browser = null
let server = null
let exitCode = 0

try {
	const chromium = await loadChromium('baseline')
	const launched = await launchGpuBrowser(chromium, 'baseline')
	browser = launched.browser
	if (launched.warning)
		console.warn(launched.warning)

	const preview = await startPreview(port, suppliedUrl)
	server = preview.server
	const browserIdentity = {
		label: launched.label,
		version: await browser.version(),
	}
	console.log(
		`baseline: ${shots.length} shot(s), two isolated runs, seed='${seed}', ` +
			`${frames} fixed frames, ${launched.label}`,
	)

	let runUserAgent = null
	for (const shot of shots) {
		const a = await captureShot(browser, {
			baseUrl: preview.baseUrl,
			shot,
			seed,
			frames,
			width,
			height,
		})
		const b = await captureShot(browser, {
			baseUrl: preview.baseUrl,
			shot,
			seed,
			frames,
			width,
			height,
		})

		if (a.userAgent !== b.userAgent)
			throw new Error(
				`${shot.id}: browser identity changed between runs; ` +
					`A='${a.userAgent}' B='${b.userAgent}'`,
			)
		if (runUserAgent != null && a.userAgent !== runUserAgent)
			throw new Error(
				`${shot.id}: browser identity changed between shots; ` +
					`expected='${runUserAgent}' actual='${a.userAgent}'`,
			)
		runUserAgent = a.userAgent
		writeShot(join(outDir, 'run-a', `${shot.id}.png`), a)
		writeShot(join(outDir, 'run-b', `${shot.id}.png`), b)
		const diff = firstPixelDifference(a.image, b.image)
		if (diff != null) {
			console.error(
				`baseline: FAIL — ${shot.id} first differs at (${diff.x},${diff.y}) ` +
					`A=[${diff.a.join(',')}] B=[${diff.b.join(',')}]`,
			)
			exitCode = 1
			break
		}

		console.log(
			`baseline: ${shot.id} exact (${a.image.width}x${a.image.height}, ` +
				`max=${a.pixels.maxChannel}, buckets=${a.pixels.distinctBuckets}, ` +
				`draws=${a.stats.drawCalls}, tris=${a.stats.triangles}, lights=${a.stats.lights})`,
		)
	}

	if (exitCode === 0)
	{
		mkdirSync(outDir, { recursive: true })
		writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({
			schema: 1,
			capturedAt: new Date().toISOString(),
			browser: browserIdentity,
			userAgent: runUserAgent,
			input: {
				source: 'devmap',
				deterministic: true,
				devicePixelRatio: 1,
				seed,
				frames,
				width,
				height,
			},
			shots: shots.map(shot => shot.id),
		}, null, 2)}\n`)
		console.log(
			`baseline: PASS — ${shots.length}/${shots.length} shots bit-identical across ` +
				`two isolated runs; artifacts ${outDir}`,
		)
	}
} catch (error) {
	console.error(`baseline: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null)
		await browser.close()
	if (server != null && !flags.has('keep-server'))
		await stopChild(server)
}

process.exit(exitCode)

function firstPixelDifference(a, b) {
	if (a.width !== b.width || a.height !== b.height)
		return { x: 0, y: 0, a: [a.width, a.height], b: [b.width, b.height] }
	for (let i = 0; i < a.data.length; i += 4) {
		if (
			a.data[i] === b.data[i] &&
			a.data[i + 1] === b.data[i + 1] &&
			a.data[i + 2] === b.data[i + 2] &&
			a.data[i + 3] === b.data[i + 3]
		)
			continue
		const p = i / 4
		return {
			x: p % a.width,
			y: Math.floor(p / a.width),
			a: Array.from(a.data.subarray(i, i + 4)),
			b: Array.from(b.data.subarray(i, i + 4)),
		}
	}
	return null
}

function parseArgs(args) {
	const valueFlags = new Set(['shots', 'seed', 'frames', 'width', 'height', 'out', 'url', 'port'])
	const flags = new Map()
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (!arg.startsWith('--'))
			throw new Error(`baseline: unknown positional argument '${arg}'`)
		const body = arg.slice(2)
		const eq = body.indexOf('=')
		const name = eq < 0 ? body : body.slice(0, eq)
		if (valueFlags.has(name)) {
			const v = eq < 0 ? args[++i] : body.slice(eq + 1)
			if (v == null || v === '')
				throw new Error(`baseline: --${name} requires a value`)
			flags.set(name, v)
		} else if (name === 'keep-server')
			flags.set(name, true)
		else
			throw new Error(`baseline: unknown flag --${name}`)
	}
	return { flags }
}

function positiveInteger(value, name) {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error(`baseline: --${name} must be a positive integer`)
	return parsed
}
