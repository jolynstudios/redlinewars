#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fail } from './gate-lib.mjs'

const TOOL = 'placementgate'
const hostRoot = resolve(import.meta.dirname, '..')
const gameRoot = resolve(hostRoot, '../..')
const placementSource = readFileSync(resolve(hostRoot, 'OpenRA.Browser/Program.Placement.cs'), 'utf8')
const uiSource = readFileSync(resolve(gameRoot, 'web/src/ui/index.ts'), 'utf8')
const bridgePath = resolve(hostRoot, 'OpenRA.Browser/wwwroot/openra-steelseed-bridge.js')
const manifest = JSON.parse(readFileSync(resolve(gameRoot, 'web/src/core/ra-visual-manifest.json'), 'utf8'))

for (const token of [
	'GCHandle.Alloc(PlacementBuffer, GCHandleType.Pinned)',
	'internal static int PlacementBufferPointer()',
	'internal static int PlacementBufferCapacity()',
	'internal static int QueryBuildingPlacement(',
	'internal static int PlaceBuildingValidated(',
	'QueryPlacement(queueId, actorType, cellX, cellY, variant, modifiers)',
	'queue.AllQueued().Any(item => item.Done && item.Item == baseActorInfo.Name)',
	'queue.CanBuild(baseActorInfo)',
	'world.CanPlaceBuilding(result.TopLeft, actorInfo, buildingInfo, null)',
	'buildingInfo.IsCloseEnoughToBase(world, player, actorInfo, result.TopLeft)',
	'world.IsCellBuildable',
	'BuildingUtils.GetLineBuildCells',
	'AcceptsPlug(world, result.TopLeft, plugInfo)',
	'TargetString = query.BaseActorInfo.Name',
	'ExtraData = query.Queue.Actor.ActorID',
	'ExtraLocation = new CPos(query.Variant, 0)',
]) if (!placementSource.includes(token)) fail(TOOL, `authoritative placement path lost '${token}'`)

const bridgeSource = readFileSync(bridgePath, 'utf8')
for (const token of [
	'const pointer = P.PlacementBufferPointer()',
	'const capacity = P.PlacementBufferCapacity()',
	'placementScratch = new Uint8Array(heap1.buffer, heap1.byteOffset + pointer, capacity)',
	'byteLength > placementScratch.byteLength',
	'const decoded = decodePlacement(placementScratch.subarray(0, byteLength), issued)',
	'PLACEMENT_HEADER_BYTES + decoded.cells.length * PLACEMENT_CELL_BYTES !== byteLength',
]) if (!bridgeSource.includes(token)) fail(TOOL, `stable Placement ABI view lost '${token}'`)

if ((placementSource.match(/QueryPlacement\(queueId, actorType, cellX, cellY, variant, modifiers\)/g) ?? []).length !== 2)
	fail(TOOL, 'query and click-time validation do not share exactly one decision path')
if (!uiSource.includes('if (key !== this.placementQueryKey)') || !uiSource.includes('this.placementResult = result'))
	fail(TOOL, 'UI does not cache input-stable queries or retain the click-time invalid response')
if (!uiSource.includes('opacity: 0.34') || !uiSource.includes("cell.valid ? 'rgba(35,220,95,0.34)'"))
	fail(TOOL, 'placement ghost or authoritative per-cell footprint lost its translucent presentation')
if (uiSource.includes("orderString: 'PlaceBuilding'"))
	fail(TOOL, 'UI still bypasses PlaceBuildingValidated with a blind placement order')

const { decodePlacement } = await import(`data:text/javascript;base64,${Buffer.from(bridgeSource).toString('base64')}`)
const bytes = new Uint8Array(64)
const view = new DataView(bytes.buffer)
view.setUint32(0, 0x4c505353, true)
view.setUint16(4, 1, true)
view.setUint8(6, 0)
view.setUint8(7, 2)
view.setUint32(8, 64, true)
view.setInt32(12, 417, true)
view.setUint32(16, 0xf1234567, true)
view.setUint16(20, 3, true)
view.setUint16(22, 2, true)
view.setInt32(24, 19, true)
view.setInt32(28, 27, true)
view.setUint16(32, 2, true)
view.setUint16(34, 3, true)
view.setUint16(36, 2, true)
view.setUint16(38, 1, true)
for (let index = 0; index < 2; index++) {
	const offset = 40 + index * 12
	view.setInt32(offset, 19 + index, true)
	view.setInt32(offset + 4, 27, true)
	view.setUint8(offset + 8, index === 0 ? 5 : 6)
}
const decoded = decodePlacement(bytes)
if (!decoded.valid || decoded.tick !== 417 || decoded.orderType !== 'LineBuild' || decoded.producerId !== 0xf1234567 ||
	decoded.queueId !== 3 || decoded.variant !== 2 || decoded.cells.length !== 2 || !decoded.cells[0].valid ||
	!decoded.cells[0].lineBuild || decoded.cells[1].valid)
	fail(TOOL, 'Placement ABI v1 JavaScript decoder does not preserve the binary contract')

const buildableBuildings = Object.entries(manifest.actors).filter(([, actor]) => actor.renderable &&
	actor.traits.some(trait => trait.Name === 'Buildable') && actor.traits.some(trait => trait.Name === 'Building'))
const water = buildableBuildings.filter(([, actor]) => actor.terrainTypes.includes('Water'))
const walls = buildableBuildings.filter(([, actor]) => actor.traits.some(trait => trait.Name === 'LineBuild'))
if (buildableBuildings.length !== 44 || water.length !== 4 || walls.length !== 3)
	fail(TOOL, `pinned placement corpus drifted: ${buildableBuildings.length} buildings, ${water.length} water, ${walls.length} walls`)
for (const [name, actor] of buildableBuildings)
	if (!Array.isArray(actor.dimensions) || !Array.isArray(actor.footprint))
		fail(TOOL, `${name} lacks resolved dimensions/footprint for per-cell preview`)

console.log(`${TOOL}: PASS — Placement ABI v1 round-trips header/cells; query and click share authoritative ` +
	`queue/readiness/variant/occupancy/base-radius logic; corpus covers ${buildableBuildings.length} buildings ` +
	`(${water.length} water, ${walls.length} line-build; plug path retained with no pinned RA plug actor)`)
