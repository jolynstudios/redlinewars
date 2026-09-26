#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const TOOL = 'watergate'
const webRoot = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'steelseed-watergate-'))
const entry = join(temporary, 'entry.ts')
const bundle = join(temporary, 'bundle.mjs')
writeFileSync(entry, [
	`export { TerrainGrid } from ${JSON.stringify(resolve(webRoot, 'src/terrain/grid.ts'))}`,
	`export { placeActorAtLevel, submergedWaterOffset, waterSupportMinY } from ${JSON.stringify(resolve(webRoot, 'src/core/place.ts'))}`,
	`export { FORWARD_WGSL } from ${JSON.stringify(resolve(webRoot, 'src/render/shaders.ts'))}`,
].join('\n'))
let api
try {
	await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent' })
	api = await import(pathToFileURL(bundle).href)
} finally { rmSync(temporary, { recursive: true, force: true }) }

const n = 9
const view = {
	w: 3, h: 3,
	type: new Uint8Array(n),
	height: Uint8Array.of(2, 2, 2, 2, 0, 2, 2, 2, 2),
	ramp: new Uint8Array(n),
	passability: new Uint8Array(n),
	resource: new Uint8Array(n),
	surface: Uint8Array.of(0, 0, 0, 0, 8, 0, 0, 0, 0),
}
const grid = new api.TerrainGrid()
grid.build(view, 10, 20)
const level = grid.waterHeightAt(11.5, 21.5)
if (level == null || level <= grid.heightAt(11.5, 21.5)) throw new Error(`${TOOL}: water surface is absent or below its bed`)
if (grid.waterHeightAt(10.5, 20.5) !== null) throw new Error(`${TOOL}: dry land reports a water surface`)
const vessel = new Float32Array(16)
api.placeActorAtLevel(vessel, 0, 11.5, 21.5, Math.PI / 3, level, api.waterSupportMinY(true, -0.4))
if (Math.abs(vessel[13] - level) > 1e-6) throw new Error(`${TOOL}: vessel waterline does not meet water surface`)
const dock = new Float32Array(16)
api.placeActorAtLevel(dock, 0, 11.5, 21.5, 0, level, api.waterSupportMinY(false, -0.4))
if (Math.abs(dock[13] - 0.4 - level) > 1e-6) throw new Error(`${TOOL}: dock support does not meet water surface`)
if (api.submergedWaterOffset(true, true) <= 0 || api.submergedWaterOffset(true, false) !== 0 ||
	api.submergedWaterOffset(false, true) !== 0) throw new Error(`${TOOL}: submarine depth is not gated by role and Cloak state`)
if (!/frame\.surfaceWeather\.z/.test(api.FORWARD_WGSL) || !/waterWaveSlope\(/.test(api.FORWARD_WGSL) ||
	!/Beer-Lambert/.test(api.FORWARD_WGSL) || !/shoreDistance = max\(vin\.uv1\.x/.test(api.FORWARD_WGSL) ||
	!/bedDetail/.test(api.FORWARD_WGSL) || !/sunGlint/.test(api.FORWARD_WGSL))
	throw new Error(`${TOOL}: live renderer lost water motion, authored bed detail, shore wash or depth lighting`)

// A one-metre-deep, flat-bottomed coast still has a shore. Distance drives foam;
// it must never flatten the true bathymetry or modify authoritative water levels.
const coast = new api.TerrainGrid()
coast.build({ w: 5, h: 3, type: new Uint8Array(15), height: Uint8Array.of(2,2,0,0,0, 2,2,0,0,0, 2,2,0,0,0),
	ramp: new Uint8Array(15), passability: new Uint8Array(15), resource: new Uint8Array(15),
	surface: Uint8Array.of(4,2,9,8,8, 4,2,9,8,8, 4,2,9,8,8) }, 0, 0)
const shore = coast.waterShoreDistanceAtCornerM(2, 1, 0, 0)
const interior = coast.waterShoreDistanceAtCornerM(3, 1, 0, 0)
if (shore !== 0 || interior < .9 || coast.waterDepthAtCornerM(2, 1, 0, 0) !== 1 ||
	coast.waterDepthAtCornerM(3, 1, 0, 0) !== 1)
	throw new Error(`${TOOL}: shore-distance presentation changed physical depth or lost the coast (${shore}/${interior})`)
coast.dispose()

// RA tilesets emit height=0. Reconstruct terraces so water sits below land,
// cliffs separate levels, and a mountain interior rises above a one-terrace cliff.
const ra = new api.TerrainGrid()
const rw = 16, rh = 9, rn = rw * rh
const raSurface = new Uint8Array(rn)
const paint = (x0, y0, x1, y1, surface) => {
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) raSurface[y * rw + x] = surface
}
paint(0, 0, rw, rh, 4)
paint(0, 0, 4, rh, 8)
paint(4, 0, 5, rh, 2)
paint(8, 0, 9, rh, 1)
paint(10, 1, 16, 8, 1)
ra.build({
	w: rw, h: rh, type: new Uint8Array(rn), height: new Uint8Array(rn),
	ramp: new Uint8Array(rn), passability: new Uint8Array(rn), resource: new Uint8Array(rn),
	surface: raSurface,
}, 0, 0)
const waterBed = ra.heightAt(1.5, 4.5)
const beach = ra.heightAt(4.5, 4.5)
const lowLand = ra.heightAt(6.5, 4.5)
const plateau = ra.heightAt(9.5, 4.5)
const mountain = ra.heightAt(13.5, 4.5)
const cliff = ra.heightAt(8.5, 4.5)
const waterSurf = ra.waterHeightAt(1.5, 4.5)
if (!(waterBed < beach && beach < lowLand && lowLand < plateau))
	throw new Error(`${TOOL}: RA height reconstruction lost water < beach < land < plateau (${waterBed}/${beach}/${lowLand}/${plateau})`)
// Presentation scale: cliffs are about a tank's length, mountains a few times that.
if (!(mountain > cliff && mountain > plateau + 3))
	throw new Error(`${TOOL}: mountain is not higher than the cliff/plateau (${mountain}/${cliff}/${plateau})`)
if (waterSurf == null || waterSurf <= waterBed || waterSurf > lowLand + 0.01)
	throw new Error(`${TOOL}: reconstructed water does not sit between bed and land (${waterSurf})`)
// Continuous relief: the rock band is joined to the land beside it (no vertical face) and
// still stands above it, so it reads as a rocky ridge rather than a wall or a flat stripe.
if (!ra.connected(ra.index(7, 4), ra.index(8, 4)))
	throw new Error(`${TOOL}: reconstructed relief opened a vertical face at the rock band`)
if (!(cliff > lowLand + 0.5))
	throw new Error(`${TOOL}: rock band (${cliff}) does not stand above the land beside it (${lowLand})`)
if (!ra.connected(ra.index(3, 4), ra.index(4, 4)))
	throw new Error(`${TOOL}: water/beach shore is a square wall instead of a ramp`)
ra.dispose()

const manifest = JSON.parse(readFileSync(resolve(webRoot, 'src/core/ra-visual-manifest.json'), 'utf8')).actors
if (!manifest.ss?.traits.some(trait => trait.Name === 'Cloak') || manifest.ss?.locomotor !== 'naval')
	throw new Error(`${TOOL}: submarine presentation is detached from OpenRA Cloak/naval traits`)
if (!manifest.spen?.terrainTypes.includes('Water') || !manifest.spen?.production.types.includes('Submarine'))
	throw new Error(`${TOOL}: naval yard presentation is detached from OpenRA water/production traits`)

console.log(`${TOOL}: PASS — connected water level ${level.toFixed(2)} m; vessel waterline and dock support grounded; ` +
	`OpenRA Cloak lowers submarines; live water shader motion/lighting and independent shore-distance foam retained`)
