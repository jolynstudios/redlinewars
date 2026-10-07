// Camera-independent root placement. Each channel gets a separate integer seed;
// position must not dictate a clump's orientation or size.
export function meadowSample(cellX: number, cellZ: number, clump: number, channel: number): number {
	let h = Math.imul(cellX, 0x9e3779b1) ^ Math.imul(cellZ, 0x85ebca77) ^
		Math.imul(clump + 1, 0xc2b2ae3d) ^ Math.imul(channel + 1, 0x27d4eb2f)
	h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
	h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
