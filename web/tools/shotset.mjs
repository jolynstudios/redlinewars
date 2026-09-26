#!/usr/bin/env node
// STEELSEED — tools/shotset
// Capture the complete named review set in one browser session.
//
// Usage:
//   node tools/shotset.mjs [--shots all|a,b] [--seed s] [--frames n]
//                          [--out dir] [--url u] [--port n] [--keep-server]

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

const flags = parseFlags(process.argv.slice(2))
const value = (name, fallback) => flags.has(name) ? flags.get(name) : fallback
const port = positiveInteger(value('port', 8381), 'port')
const frames = positiveInteger(value('frames', DEFAULT_FRAMES), 'frames')
const width = positiveInteger(value('width', 1512), 'width')
const height = positiveInteger(value('height', 982), 'height')
const seed = String(value('seed', 'steelseed-review-v1'))
const shots = selectShots(value('shots', 'all'))
const outDir = resolve(value('out', join(WEB_ROOT, '.artifacts', 'shotset')))
const suppliedUrl = value('url', null)

let browser = null
let server = null
let exitCode = 0

try {
	const chromium = await loadChromium('shotset')
	const launched = await launchGpuBrowser(chromium, 'shotset')
	browser = launched.browser
	if (launched.warning)
		console.warn(launched.warning)
	const preview = await startPreview(port, suppliedUrl)
	server = preview.server

	for (const shot of shots) {
		const capture = await captureShot(browser, {
			baseUrl: preview.baseUrl,
			shot,
			seed,
			frames,
			width,
			height,
			includeComposite: true,
		})
		const path = join(outDir, `${shot.id}.png`)
		writeShot(path, {
			canonicalPng: capture.compositePng ?? capture.canonicalPng,
		})
		console.log(
			`shotset: ${shot.id} -> ${path} (${capture.image.width}x${capture.image.height}, ` +
				`max=${capture.pixels.maxChannel}, buckets=${capture.pixels.distinctBuckets}, ` +
				`dropped=${capture.stats.dropped}/${capture.stats.lightsDropped})`,
		)
	}
	console.log(`shotset: PASS — ${shots.length}/${shots.length} named shots captured in one ${launched.label} session`)
} catch (error) {
	console.error(`shotset: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null)
		await browser.close()
	if (server != null && !flags.has('keep-server'))
		await stopChild(server)
}

process.exit(exitCode)

function parseFlags(args) {
	const valueFlags = new Set(['shots', 'seed', 'frames', 'width', 'height', 'out', 'url', 'port'])
	const flags = new Map()
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (!arg.startsWith('--'))
			throw new Error(`shotset: unknown positional argument '${arg}'`)
		const body = arg.slice(2)
		const eq = body.indexOf('=')
		const name = eq < 0 ? body : body.slice(0, eq)
		if (valueFlags.has(name)) {
			const v = eq < 0 ? args[++i] : body.slice(eq + 1)
			if (v == null || v === '')
				throw new Error(`shotset: --${name} requires a value`)
			flags.set(name, v)
		} else if (name === 'keep-server')
			flags.set(name, true)
		else
			throw new Error(`shotset: unknown flag --${name}`)
	}
	return flags
}

function positiveInteger(value, name) {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error(`shotset: --${name} must be a positive integer`)
	return parsed
}
