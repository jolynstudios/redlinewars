import { scanScenery, type ScanRequest } from './scenery-scan'

type ScanMessage = ScanRequest & { ticket: number; grassCap: number; oreCap: number; gemsCap: number }

// Terrain grids are static for a match and are several hundred kilobytes on a large map.
// Cloning them into the worker on every camera step was a main-thread hitch. The first
// message installs them; later messages carry the camera, the shroud and the occluders.
let terrain: ScanRequest | null = null
let scratch: { grass: Float32Array; ore: Float32Array; gems: Float32Array } | null = null

self.onmessage = (event: MessageEvent<ScanMessage>) => {
	const req = event.data
	if (req.height && req.height.length > 0) terrain = req
	if (!terrain) return
	const full: ScanRequest = terrain === req ? req : {
		...terrain,
		liveType: req.liveType,
		liveDensity: req.liveDensity,
		liveMax: req.liveMax,
		bridges: req.bridges,
		shroud: req.shroud,
		shroudW: req.shroudW,
		shroudH: req.shroudH,
		shroudOriginX: req.shroudOriginX,
		shroudOriginY: req.shroudOriginY,
		shroudSeen: req.shroudSeen,
		occluders: req.occluders,
		occluderCount: req.occluderCount,
		cx: req.cx,
		cz: req.cz,
		radius: req.radius,
		wind: req.wind,
		windX: req.windX,
		windZ: req.windZ,
		time: req.time,
		// Per-scan facts. Missing here, they froze at the first message: settled snow never
		// buried the live meadow, and scorched ground never burnt its grass.
		snowCover: req.snowCover,
		burns: req.burns,
		burnCount: req.burnCount,
		cardGrass: req.cardGrass,
		grassPerCell: req.grassPerCell,
		grassRadius: req.grassRadius,
		grassSeen: req.grassSeen,
		oreSeen: req.oreSeen,
		gemsSeen: req.gemsSeen,
	}
	if (!scratch || scratch.grass.length < req.grassCap * 16 || scratch.ore.length < req.oreCap * 16 || scratch.gems.length < req.gemsCap * 16) {
		scratch = {
			grass: new Float32Array(req.grassCap * 16),
			ore: new Float32Array(req.oreCap * 16),
			gems: new Float32Array(req.gemsCap * 16),
		}
	}
	const counts = scanScenery(full, scratch)
	const grass = scratch.grass.slice(0, counts.grassCount * 16)
	const ore = scratch.ore.slice(0, counts.oreCount * 16)
	const gems = scratch.gems.slice(0, counts.gemsCount * 16)
	self.postMessage(
		{ ticket: req.ticket, ...counts, grass, ore, gems },
		{ transfer: [grass.buffer, ore.buffer, gems.buffer] },
	)
}
