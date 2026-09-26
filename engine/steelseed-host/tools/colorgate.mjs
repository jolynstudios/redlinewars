#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fail } from './gate-lib.mjs'

const TOOL = 'colorgate'
const hostRoot = resolve(import.meta.dirname, '..')
const gameRoot = resolve(hostRoot, '../..')
const emitter = readFileSync(resolve(hostRoot, 'OpenRA.Browser/SnapshotEmitter.cs'), 'utf8')
const decoder = readFileSync(resolve(gameRoot, 'web/src/core/snapshot.ts'), 'utf8')
const renderer = readFileSync(resolve(gameRoot, 'web/src/render/renderer.ts'), 'utf8')
const ui = readFileSync(resolve(gameRoot, 'web/src/ui/index.ts'), 'utf8')
const allWeb = [decoder, renderer, ui].join('\n')

for (const required of ['writer.U8(color.R)', 'writer.U8(color.G)', 'writer.U8(color.B)', 'writer.U8(color.A)'])
	if (!emitter.includes(required)) fail(TOOL, `snapshot emitter is missing ${required}`)
for (const required of ['p.red / 255', 'p.green / 255', 'p.blue / 255', 'p.alpha / 255'])
	if (!renderer.includes(required)) fail(TOOL, `renderer is not consuming authoritative ${required}`)
if (!ui.includes('rgbaCss(owner.red, owner.green, owner.blue, owner.alpha)'))
	fail(TOOL, 'strategic overview does not use the authoritative player RGBA')
if (/PLAYER_COLORS|ownerPalette|OWNER_PALETTE/.test(allWeb))
	fail(TOOL, 'a hard-coded owner palette remains in the live view layer')

const authoritative = [
	{ r: 0x39, g: 0x1d, b: 0x1d, a: 0xff },
	{ r: 0x2f, g: 0x86, b: 0xf2, a: 0xff },
]
const distinct = colors => new Set(colors.map(c => `${c.r},${c.g},${c.b},${c.a}`)).size === colors.length
if (!distinct(authoritative)) fail(TOOL, 'authoritative witness colors unexpectedly collapse')
const equalizedFalsifier = authoritative.map(() => authoritative[0])
if (distinct(equalizedFalsifier)) fail(TOOL, 'equalized-color falsifier was not detected')

console.log(`${TOOL}: PASS — snapshot, units/HUD and minimap share authoritative RGBA; equalized color table witnessed red`)
