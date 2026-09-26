#!/usr/bin/env node
// STEELSEED — tools/imagediff
// Per-pixel gate. Non-zero exit on any change.
//
// This is what makes the optimization gate honest (§10.7): every performance change
// must keep imagediff at ZERO across all baseline shots. Performance claims are
// accepted from measurements, never from prose, and "it looks the same to me" is prose.
//
// Default tolerance is exact — 0 differing pixels. A tolerance mode exists for the
// generation-cache check (warm boot from IndexedDB vs cold generation), where the
// question is "did the cache serve the same asset", not "is the frame bit-identical".
//
// Usage:
//   node tools/imagediff.mjs <a.png> <b.png> [--out diff.png] [--tolerance N] [--max-pixels N]

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { decodePng, encodePng } from './png.mjs'

const argv = process.argv.slice(2)

// Flags that consume the following argument. Without this list a value like
// `--out /tmp/diff.png` leaks into the positional file list and the usage check fires.
const VALUE_FLAGS = new Set(['out', 'tolerance', 'max-pixels'])

const flags = new Map()
const files = []
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]
	if (a.startsWith('--')) {
		const name = a.slice(2)
		if (VALUE_FLAGS.has(name)) flags.set(name, argv[++i])
		else flags.set(name, true)
	} else files.push(a)
}
const flag = (name, def) => (flags.has(name) ? flags.get(name) : def)

if (files.length !== 2) {
	console.error('usage: imagediff.mjs <a.png> <b.png> [--out diff.png] [--tolerance N] [--max-pixels N]')
	process.exit(2)
}

const [pathA, pathB] = files
/** Per-channel 0..255 delta below which two pixels count as equal. 0 = exact. */
const tolerance = Number(flag('tolerance', 0))
/** How many differing pixels are permitted before failing. 0 = none. */
const maxPixels = Number(flag('max-pixels', 0))
const outPath = flag('out', null)

let a, b
try {
	a = decodePng(readFileSync(pathA))
	b = decodePng(readFileSync(pathB))
} catch (err) {
	console.error(`imagediff: ${err.message}`)
	process.exit(2)
}

if (a.width !== b.width || a.height !== b.height) {
	console.error(
		`imagediff: FAIL — dimensions differ. ${basename(pathA)} is ${a.width}x${a.height}, ` +
			`${basename(pathB)} is ${b.width}x${b.height}`,
	)
	process.exit(1)
}

const n = a.width * a.height
let differing = 0
let maxDelta = 0
let sumDelta = 0
// Bounding box of the change — far more useful than a count when triaging which
// subsystem moved: a band at the horizon is sky, a blob following a unit is anim.
let minX = a.width, minY = a.height, maxX = -1, maxY = -1

const diff = outPath ? Buffer.alloc(n * 4) : null

for (let i = 0; i < n; i++) {
	const o = i * 4
	const dr = Math.abs(a.data[o] - b.data[o])
	const dg = Math.abs(a.data[o + 1] - b.data[o + 1])
	const db = Math.abs(a.data[o + 2] - b.data[o + 2])
	const da = Math.abs(a.data[o + 3] - b.data[o + 3])
	const d = Math.max(dr, dg, db, da)

	if (d > maxDelta) maxDelta = d
	sumDelta += d

	if (d > tolerance) {
		differing++
		const x = i % a.width
		const y = (i / a.width) | 0
		if (x < minX) minX = x
		if (x > maxX) maxX = x
		if (y < minY) minY = y
		if (y > maxY) maxY = y
		if (diff) {
			// Magenta on the changed pixels, the original desaturated underneath, so the
			// diff image is readable rather than a field of noise.
			diff[o] = 255
			diff[o + 1] = 0
			diff[o + 2] = 255
			diff[o + 3] = 255
		}
	} else if (diff) {
		const grey = ((a.data[o] * 0.299 + a.data[o + 1] * 0.587 + a.data[o + 2] * 0.114) * 0.35) | 0
		diff[o] = diff[o + 1] = diff[o + 2] = grey
		diff[o + 3] = 255
	}
}

if (diff) writeFileSync(outPath, encodePng(a.width, a.height, diff))

const pct = ((differing / n) * 100).toFixed(4)
const meanDelta = (sumDelta / n).toFixed(4)

if (differing > maxPixels) {
	console.error(
		`imagediff: FAIL\n` +
			`  ${basename(pathA)} vs ${basename(pathB)}  (${a.width}x${a.height})\n` +
			`  differing pixels : ${differing} of ${n}  (${pct}%)   [allowed ${maxPixels}]\n` +
			`  max channel delta: ${maxDelta}   mean: ${meanDelta}   [tolerance ${tolerance}]\n` +
			`  change bbox      : x ${minX}..${maxX}, y ${minY}..${maxY}` +
			(outPath ? `\n  diff written     : ${outPath}` : ''),
	)
	process.exit(1)
}

console.log(
	`imagediff: PASS — ${basename(pathA)} vs ${basename(pathB)}  ` +
		`${differing} differing pixel(s), max delta ${maxDelta}` +
		(tolerance ? ` (tolerance ${tolerance})` : ''),
)
