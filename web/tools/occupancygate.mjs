#!/usr/bin/env node
// STEELSEED — tools/occupancygate
// Occupancy fit is the presentation shrink that stops tanks sitting inside houses.

import assert from 'node:assert/strict'
import { occupancyMeters, fitScaleForMesh, FIT_INSET } from '../src/units/occupancy.ts'

const cell = occupancyMeters(null, null)
assert.equal(cell.x, 1)
assert.equal(cell.z, 1)

const plant = occupancyMeters(['xxx', 'xxx', 'xxx'], null)
assert.equal(plant.x, 3)
assert.equal(plant.z, 3)

const dims = occupancyMeters(null, '3,2')
assert.equal(dims.x, 3)
assert.equal(dims.z, 2)

const alreadyFits = fitScaleForMesh(0.4, 0.3, 1, 1)
assert.equal(alreadyFits, 1)

const tank = fitScaleForMesh(3.28, 1.8, 1, 1)
assert.ok(tank < 1, 'an oversized tank must shrink')
assert.ok(tank * 3.28 <= 1 * FIT_INSET + 1e-6, 'length must land inside the cell inset')
assert.ok(tank * 1.8 <= 1 * FIT_INSET + 1e-6, 'width must land inside the cell inset')

const house = fitScaleForMesh(4.2, 4.2, 2, 2)
assert.ok(house < 1)
assert.ok(house * 4.2 <= 2 * FIT_INSET + 1e-6)

// units/index.ts must measure vertex positions before this call. A decoded mesh
// keeps a zero AABB until then, and clamping that span to 1e-4 returns scale 1,
// so the 2.2× house is drawn through its neighbour.
const stale = fitScaleForMesh(1e-4, 1e-4, 2, 2)
assert.equal(stale, 1, 'an unread AABB must not be treated as a house that already fits')
const spanX = 2.3385 - -2.3385
const spanZ = 2.3385 - -2.3385
const measured = fitScaleForMesh(spanX, spanZ, 2, 2)
assert.ok(measured < 1, 'a measured 4.7 m house must shrink into a 2×2 lot')
assert.ok(measured * spanX <= 2 * FIT_INSET + 1e-6)
assert.ok(measured * spanZ <= 2 * FIT_INSET + 1e-6)
// Adjacent 2×2 footprints are 2 m between centres. The fitted block stays inside that gap.
assert.ok(measured * Math.max(spanX, spanZ) < 2)

console.log(`occupancygate: PASS — 1-cell tank scale ${tank.toFixed(3)}, 2x2 house ${house.toFixed(3)}, measured ${measured.toFixed(3)}`)
